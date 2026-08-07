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
  await initDmReadStateTable(db);
}

/**
 * Create the per-conversation read-state table if it doesn't exist.
 *
 * Callable on its own, not just via initDmLogTable, because CI deploys the
 * worker on every push to main but never runs `wrangler d1 migrations apply`.
 * Without an ensure on the DM read paths, merging the migration that adds
 * this table would still ship a getConversations() that LEFT JOINs a table
 * production does not have yet, and the admin Messages UI would 500 until
 * someone applied migration 012 by hand.
 * @param {D1Database} db
 */
export async function initDmReadStateTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dm_conversation_read_state (
      conversation_id TEXT PRIMARY KEY,
      read_at TEXT NOT NULL
    )
  `).run();
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

/**
 * Mark a conversation as read as of now. Monotonic: a concurrent call that
 * resolves its own CURRENT_TIMESTAMP earlier than the row's current value
 * (per SQLite/D1's write serialization this shouldn't happen in practice,
 * but the guard is free) is a no-op rather than moving read_at backwards.
 * @param {D1Database} db
 * @param {string} conversationId
 */
export async function markConversationRead(db, conversationId) {
  await db.prepare(`
    INSERT INTO dm_conversation_read_state (conversation_id, read_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
    WHERE CURRENT_TIMESTAMP > dm_conversation_read_state.read_at
  `).bind(conversationId).run();
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
    ),
    latest_incoming AS (
      -- The most recent INCOMING message per conversation, used for the
      -- unread computation below. Deliberately separate from the "latest"
      -- CTE above (which is the most recent message in either direction,
      -- used for the row's display columns): a moderator's own outgoing
      -- reply must not mark their own inbox as unread to themselves.
      SELECT conversation_id, MAX(created_at) AS latest_incoming_at
      FROM dm_log
      WHERE direction = 'incoming'
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
      latest.message_count,
      CASE
        WHEN li.latest_incoming_at IS NULL THEN 0
        WHEN rs.read_at IS NULL THEN 1
        -- Both timestamps use SQLite/D1 CURRENT_TIMESTAMP, which has
        -- one-second resolution. A message logged in the same second as
        -- mark-read is treated as read until a later incoming message arrives.
        WHEN li.latest_incoming_at > rs.read_at THEN 1
        ELSE 0
      END AS unread
    FROM latest
    JOIN dm_log dl ON dl.id = latest.max_id
    LEFT JOIN latest_incoming li ON li.conversation_id = latest.conversation_id
    LEFT JOIN dm_conversation_read_state rs ON rs.conversation_id = latest.conversation_id
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
  // find the most recently updated conversation this pubkey participates in
  // via the OR query. This keeps the legacy behavior available while making
  // the "first conversation" choice deterministic.
  const rows = await db.prepare(`
    SELECT conversation_id
    FROM dm_log
    WHERE sender_pubkey = ? OR recipient_pubkey = ?
    GROUP BY conversation_id
    ORDER BY MAX(id) DESC
    LIMIT 1
  `).bind(pubkey, pubkey).all();

  if (!rows.results || rows.results.length === 0) return null;

  // Return the first conversation's messages
  return getConversation(db, rows.results[0].conversation_id);
}
