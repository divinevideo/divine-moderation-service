// ABOUTME: DM conversation storage and retrieval for admin dashboard
// ABOUTME: Provides D1-backed message log with conversation grouping

import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

export function computeConversationId(pubkeyA, pubkeyB) {
  const sorted = [pubkeyA, pubkeyB].sort().join('');
  return bytesToHex(sha256(sorted));
}

export async function initDmLogTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dm_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      sha256 TEXT,
      direction TEXT NOT NULL,
      sender_pubkey TEXT NOT NULL,
      recipient_pubkey TEXT NOT NULL,
      message_type TEXT,
      content TEXT NOT NULL,
      nostr_event_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_log(conversation_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_log(recipient_pubkey)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_sha256 ON dm_log(sha256)').run();
}

export async function logDm(db, { conversationId, sha256, direction, senderPubkey, recipientPubkey, messageType, content, nostrEventId }) {
  // Dedup by nostr_event_id if provided
  if (nostrEventId) {
    const existing = await db.prepare('SELECT id FROM dm_log WHERE nostr_event_id = ?').bind(nostrEventId).first();
    if (existing) return existing;
  }

  const result = await db.prepare(`
    INSERT INTO dm_log (conversation_id, sha256, direction, sender_pubkey, recipient_pubkey, message_type, content, nostr_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(conversationId, sha256 || null, direction, senderPubkey, recipientPubkey, messageType || null, content, nostrEventId || null).run();

  return { id: result.meta.last_row_id };
}

export async function getConversations(db, { limit = 20, offset = 0, moderatorPubkey } = {}) {
  // One grouped pass computes both the latest row id AND the per-conversation
  // message_count in the same scan, then we join back for the latest row's
  // columns. This replaces the earlier shape (a per-returned-row correlated
  // `(SELECT COUNT(*) ...)` subquery on top of a separate MAX(id) GROUP BY),
  // which did the grouped scan AND an extra index lookup per row.
  //
  // No extra index is needed: `id` is INTEGER PRIMARY KEY (the rowid), so the
  // existing idx_dm_conversation on (conversation_id) is physically
  // (conversation_id, id) and already covers MAX(id)/COUNT(*) GROUP BY. The
  // final ORDER BY runs over the reduced one-row-per-conversation set (bounded
  // by the moderation account's conversation count), so it doesn't warrant its
  // own created_at index. id DESC is a deterministic tiebreaker for rows that
  // share a (1-second-resolution) created_at, so pagination is stable.
  const rows = await db.prepare(`
    WITH latest AS (
      SELECT conversation_id, MAX(id) AS max_id, COUNT(*) AS message_count
      FROM dm_log
      GROUP BY conversation_id
    )
    SELECT
      dl.conversation_id,
      dl.created_at as last_message_at,
      dl.sender_pubkey,
      dl.recipient_pubkey,
      dl.direction as last_direction,
      dl.content as last_message,
      dl.sha256 as last_sha256,
      dl.message_type as last_message_type,
      latest.message_count
    FROM latest
    JOIN dm_log dl ON dl.id = latest.max_id
    ORDER BY last_message_at DESC, dl.id DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  const results = rows.results || [];

  // The admin messages UI expects participant_pubkey (the other side of the
  // conversation, not the moderator) plus latest_message / message_type
  // aliases. We add those without removing the original columns so existing
  // callers keep working.
  if (!moderatorPubkey) return results;

  return results.map((row) => ({
    ...row,
    participant_pubkey:
      row.sender_pubkey === moderatorPubkey ? row.recipient_pubkey : row.sender_pubkey,
    latest_message: row.last_message,
    message_type: row.last_message_type,
  }));
}

export async function getConversation(db, conversationId) {
  // id ASC is a load-bearing tiebreaker: created_at is CURRENT_TIMESTAMP at
  // 1-second resolution, so messages sent in the same second tie on created_at
  // alone and would render in an undefined order. id is the AUTOINCREMENT rowid
  // (insertion order), so it gives a stable chronological thread.
  const rows = await db.prepare(`
    SELECT * FROM dm_log
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `).bind(conversationId).all();
  return rows.results || [];
}

export async function getConversationByPubkey(db, pubkey, moderatorPubkey) {
  // Fast path: the conversation id is deterministic, so when we know the
  // moderator pubkey we derive it directly and hit the indexed conversation_id
  // column — no scan. (The old `sender_pubkey = ? OR recipient_pubkey = ?` form
  // can't use an index on both sides: sender_pubkey is unindexed.)
  if (moderatorPubkey) {
    const conversationId = computeConversationId(moderatorPubkey, pubkey);
    const messages = await getConversation(db, conversationId);
    return messages.length ? messages : null;
  }

  // Fallback (no moderator pubkey available, e.g. no signing key configured):
  // find any conversation this pubkey participates in via the OR query.
  const rows = await db.prepare(`
    SELECT DISTINCT conversation_id FROM dm_log
    WHERE sender_pubkey = ? OR recipient_pubkey = ?
  `).bind(pubkey, pubkey).all();

  if (!rows.results || rows.results.length === 0) return null;

  // Return the first conversation's messages
  return getConversation(db, rows.results[0].conversation_id);
}
