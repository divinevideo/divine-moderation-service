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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      unverified_excerpt TEXT
    )
  `).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_log(conversation_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_log(recipient_pubkey)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_sha256 ON dm_log(sha256)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_dm_log_created_at ON dm_log(created_at)').run();
  await ensureDmLogExcerptColumn(db);
  await initDmReadStateTable(db);
  await initDmReplyStateTable(db);
}

/**
 * Add dm_log.unverified_excerpt where it is missing: the message a reporter
 * chose to include in a moderation DM (see dm-evidence.mjs), kept apart from
 * their own note so the admin Messages UI can label it unverified.
 *
 * In code rather than in migrations/ for the reason initReportsTable gives: CI
 * deploys the worker on merge but never runs `wrangler d1 migrations apply`.
 * The DM reader calls this before it writes, and only the reader writes the
 * column -- logDm leaves it out of every insert that has no excerpt -- so the
 * other dm_log writers keep working against a table that has not been altered.
 * @param {D1Database} db
 */
export async function ensureDmLogExcerptColumn(db) {
  const columns = await db.prepare('PRAGMA table_info(dm_log)').all();
  const hasColumn = (columns?.results || []).some((column) => column.name === 'unverified_excerpt');
  if (hasColumn) return;
  try {
    await db.prepare('ALTER TABLE dm_log ADD COLUMN unverified_excerpt TEXT').run();
  } catch (err) {
    // The cron sync and a moderator's Refresh can both run the first sync
    // after a deploy. If the other one added the column after our check, the
    // column is there, which is all this needed.
    if (!/duplicate column name/i.test(err?.message || '')) throw err;
  }
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

/**
 * Create the per-conversation "No reply needed" table if it doesn't exist.
 * Callable on its own for the same reason as initDmReadStateTable: CI deploys
 * on every push to main without applying migrations, so the code that reads
 * or writes this table has to be able to create it.
 * @param {D1Database} db
 */
export async function initDmReplyStateTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dm_conversation_reply_state (
      conversation_id TEXT PRIMARY KEY,
      no_reply_needed_at TEXT NOT NULL
    )
  `).run();
}

export async function findDmByNostrEventId(db, nostrEventId) {
  if (!nostrEventId) return null;
  return db.prepare('SELECT id FROM dm_log WHERE nostr_event_id = ?').bind(nostrEventId).first();
}

/**
 * Build the dm_log INSERT for one message without running it, so a caller can
 * put it in a D1 batch with a write that must land together with it (the DM
 * reader does, for a private report's intake row). logDm runs it on its own.
 * @param {D1Database} db
 * @returns {D1PreparedStatement}
 */
export function prepareDmLogInsert(db, { conversationId, sha256, direction, senderPubkey, recipientPubkey, messageType, content, nostrEventId, unverifiedExcerpt = null }) {
  const columns = ['conversation_id', 'sha256', 'direction', 'sender_pubkey', 'recipient_pubkey', 'message_type', 'content', 'nostr_event_id'];
  const values = [conversationId, sha256 || null, direction, senderPubkey, recipientPubkey, messageType || null, content, nostrEventId || null];
  // Named only when there is an excerpt: the writers that never have one run
  // on paths that never ensure the column (see ensureDmLogExcerptColumn).
  if (unverifiedExcerpt != null) {
    columns.push('unverified_excerpt');
    values.push(unverifiedExcerpt);
  }

  return db.prepare(`
    INSERT INTO dm_log (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).bind(...values);
}

export async function logDm(db, entry) {
  // Dedup by nostr_event_id if provided
  if (entry.nostrEventId) {
    const existing = await findDmByNostrEventId(db, entry.nostrEventId);
    if (existing) return existing;
  }

  const result = await prepareDmLogInsert(db, entry).run();

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

/**
 * Mark a conversation "No reply needed". One shared mark per conversation,
 * not per moderator. Monotonic like markConversationRead: a second call never
 * moves the mark backwards.
 *
 * With `seenThroughId` (the newest dm_log id the moderator's open thread
 * showed), the mark covers only what they saw: if a typed message was logged
 * after that row, the mark lands one second before it, so that message keeps
 * the conversation waiting. The inbox sync logs new messages every five
 * minutes (and on Refresh) and the open thread does not refresh itself, so
 * marking "now" could cover a message nobody read. Without it, the mark is as
 * of now.
 * @param {D1Database} db
 * @param {string} conversationId
 * @param {{ seenThroughId?: number }} [options]
 */
export async function markNoReplyNeeded(db, conversationId, { seenThroughId } = {}) {
  // A NULL ?2 matches no row, so the subquery is NULL and the mark is now.
  await db.prepare(`
    INSERT INTO dm_conversation_reply_state (conversation_id, no_reply_needed_at)
    VALUES (?1, COALESCE(
      (SELECT datetime(MIN(created_at), '-1 second') FROM dm_log
        WHERE conversation_id = ?1 AND id > ?2
          AND direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= ?3),
      CURRENT_TIMESTAMP
    ))
    ON CONFLICT(conversation_id) DO UPDATE SET no_reply_needed_at = excluded.no_reply_needed_at
    WHERE excluded.no_reply_needed_at > dm_conversation_reply_state.no_reply_needed_at
  `).bind(conversationId, seenThroughId ?? null, TYPED_MESSAGE_CUTOFF).run();
}

/**
 * Remove a conversation's "No reply needed" mark. A no-op when it has none.
 * @param {D1Database} db
 * @param {string} conversationId
 */
export async function clearNoReplyNeeded(db, conversationId) {
  await db.prepare('DELETE FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(conversationId).run();
}

/**
 * Delete dm_log rows older than the Trust & Safety-decided one-year
 * retention period, and any dm_conversation_read_state or
 * dm_conversation_reply_state row left orphaned once every message in its
 * conversation has expired. All three deletes run as one D1 batch (atomic)
 * because the state tables have no foreign key to dm_log -- see PR #219 for the retention decision (Trust & Safety,
 * 2026-09-14: Charlie, Mike, Aleysha) and the sizing/key-rotation notes.
 *
 * A row is kept until strictly one year old, comparing created_at as text
 * against `datetime('now', '-1 years')` -- both are SQLite's
 * CURRENT_TIMESTAMP-format text ("YYYY-MM-DD HH:MM:SS"), the same
 * comparability markConversationRead already relies on. A state row is
 * deleted only when NO dm_log row remains for its conversation_id; a
 * conversation with any surviving message keeps its markers.
 *
 * The state tables are ensured first: this sweep is gated by a flag and can
 * run before anything else has created them (CI skips migrations), and a
 * missing table would fail the whole batch, including the dm_log delete.
 * @param {D1Database} db
 * @returns {Promise<{deletedMessages: number, deletedReadStates: number, deletedReplyStates: number}>}
 */
export async function pruneExpiredDmLog(db) {
  await initDmReadStateTable(db);
  await initDmReplyStateTable(db);
  const [messagesResult, readStateResult, replyStateResult] = await db.batch([
    db.prepare(`DELETE FROM dm_log WHERE created_at < datetime('now', '-1 years')`),
    db.prepare(`
      DELETE FROM dm_conversation_read_state
      WHERE conversation_id NOT IN (SELECT DISTINCT conversation_id FROM dm_log)
    `),
    db.prepare(`
      DELETE FROM dm_conversation_reply_state
      WHERE conversation_id NOT IN (SELECT DISTINCT conversation_id FROM dm_log)
    `),
  ]);

  return {
    deletedMessages: messagesResult.meta.changes,
    deletedReadStates: readStateResult.meta.changes,
    deletedReplyStates: replyStateResult.meta.changes,
  };
}

/**
 * Only an incoming creator_reply logged on or after this time counts as a
 * message a person typed. Before #194, every report DM was stored as
 * creator_reply too, and those rows were never relabelled, so an older
 * creator_reply can't be told apart from a report. #194 merged at 06:32 UTC
 * on 2026-08-12 and CI deployed it minutes later; the cutoff is the start of
 * the 13th rather than the 12th so that no report logged earlier on the 12th
 * counts as typed. Losing about 18 hours of typed messages is the safer side.
 * Permanent: the mislabelled rows stay until retention removes them.
 * CURRENT_TIMESTAMP format (UTC), so it compares as text against created_at.
 */
export const TYPED_MESSAGE_CUTOFF = '2026-08-13 00:00:00';

/**
 * How far back "Waiting on us" looks for an unanswered typed message. 30 days
 * is the Trust & Safety team's choice (2026-11-16 filter design): older
 * unanswered messages stay findable under "A person wrote" but stop inflating
 * the waiting count. A constant rather than a setting by design.
 */
export const WAITING_WINDOW_DAYS = 30;

/**
 * The filter keys getConversations accepts. No filter means All.
 */
export const CONVERSATION_FILTERS = ['waiting', 'person', 'reports', 'notices', 'outcomes', 'warnings'];

// The condition over the `flags` CTE that each filter key selects. Fixed SQL
// fragments chosen by key, never built from input. getFilterCounts sums these
// same expressions, so a chip's count and its list can't disagree.
const FILTER_CONDITIONS = {
  waiting: 'flags.waiting = 1',
  person: 'flags.last_typed_at IS NOT NULL',
  reports: 'flags.report_count > 0',
  notices: 'flags.notice_count > 0',
  outcomes: 'flags.outcome_count > 0',
  warnings: 'flags.warning_count > 0',
};

/**
 * The per-conversation flags behind the Messages filters, counts and state,
 * as two CTEs (`latest`, then `flags`) for a caller to put after WITH. One
 * builder for all three readers keeps their definitions identical.
 *
 * `latest` is one grouped pass over dm_log: the latest row id and message
 * count (as getConversations always had), the latest typed row and the latest
 * moderator_reply, and how many rows of each automated type the conversation
 * ever had. Only moderator_reply counts as our reply: moderation_notice,
 * report_outcome and community_warning are sent automatically and must not
 * clear "Waiting on us".
 *
 * `flags` adds the "No reply needed" mark and computes `waiting`: the latest
 * typed row is within the window and strictly later than both our latest
 * reply and the mark. Strictly, because created_at has one-second resolution
 * and a reply logged in the same second as the message answered it.
 *
 * @param {{ conversationId?: string }} [options] restrict to one conversation
 * @returns {{ sql: string, params: unknown[] }}
 */
function conversationFlagsCte({ conversationId } = {}) {
  const params = [TYPED_MESSAGE_CUTOFF, TYPED_MESSAGE_CUTOFF];
  let where = '';
  if (conversationId !== undefined) {
    where = 'WHERE conversation_id = ?';
    params.push(conversationId);
  }
  params.push(`-${WAITING_WINDOW_DAYS} days`);

  const sql = `
    latest AS (
      SELECT
        conversation_id,
        MAX(id) AS max_id,
        COUNT(*) AS message_count,
        MAX(CASE WHEN direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= ? THEN created_at END) AS last_typed_at,
        -- Same typed-row definition as above (so it binds the cutoff too); the
        -- row's content is joined in getConversations for the people-chip preview.
        MAX(CASE WHEN direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= ? THEN id END) AS last_typed_id,
        MAX(CASE WHEN message_type = 'moderator_reply' THEN created_at END) AS last_reply_at,
        SUM(CASE WHEN message_type = 'conversation_report' THEN 1 ELSE 0 END) AS report_count,
        SUM(CASE WHEN message_type = 'moderation_notice' THEN 1 ELSE 0 END) AS notice_count,
        SUM(CASE WHEN message_type = 'report_outcome' THEN 1 ELSE 0 END) AS outcome_count,
        SUM(CASE WHEN message_type = 'community_warning' THEN 1 ELSE 0 END) AS warning_count
      FROM dm_log
      ${where}
      GROUP BY conversation_id
    ),
    flags AS (
      SELECT
        latest.*,
        rps.no_reply_needed_at,
        CASE
          WHEN latest.last_typed_at IS NOT NULL
            AND latest.last_typed_at >= datetime('now', ?)
            AND (latest.last_reply_at IS NULL OR latest.last_typed_at > latest.last_reply_at)
            AND (rps.no_reply_needed_at IS NULL OR latest.last_typed_at > rps.no_reply_needed_at)
          THEN 1 ELSE 0
        END AS waiting
      FROM latest
      LEFT JOIN dm_conversation_reply_state rps ON rps.conversation_id = latest.conversation_id
    )`;
  return { sql, params };
}

/**
 * List conversations, newest first, optionally narrowed to one filter.
 * @param {D1Database} db
 * @param {{ limit?: number, offset?: number, moderatorPubkey?: string, filter?: string }} [options]
 *   filter is one of CONVERSATION_FILTERS, or undefined for All
 */
export async function getConversations(db, { limit = 20, offset = 0, moderatorPubkey, filter } = {}) {
  if (filter !== undefined && !CONVERSATION_FILTERS.includes(filter)) {
    throw new Error(`Unknown conversation filter: ${filter}`);
  }

  // One grouped pass (the `latest` CTE inside conversationFlagsCte) computes
  // the latest row id, the per-conversation message_count and the filter
  // flags in the same scan, then we join back for the latest row's columns.
  // This replaces the earlier shape (a per-returned-row correlated
  // `(SELECT COUNT(*) ...)` subquery on top of a separate MAX(id) GROUP BY),
  // which did the grouped scan AND an extra index lookup per row.
  //
  // No extra index is needed. The flags read direction, message_type and
  // created_at, so this pass reads full rows rather than just
  // idx_dm_conversation; but latest_incoming below already reads full rows
  // for its direction filter and MAX(created_at). The `latest` CTE was a
  // covering-index scan before and now reads full rows, so the access pattern
  // is heavier; that is acceptable because the scan is bounded by the
  // moderation account's message volume and retention. The filter
  // WHERE and the ORDER BY run over the reduced one-row-per-conversation set
  // (bounded by the moderation account's conversation count), so neither
  // warrants its own index. id DESC is a deterministic tiebreaker for rows
  // that share a (1-second-resolution) created_at, so pagination is stable.
  const flags = conversationFlagsCte();
  const filterWhere = filter ? `WHERE ${FILTER_CONDITIONS[filter]}` : '';
  const rows = await db.prepare(`
    WITH ${flags.sql},
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
      flags.message_count,
      flags.waiting,
      lt.created_at AS last_typed_at,
      lt.content AS last_typed_message,
      CASE
        WHEN li.latest_incoming_at IS NULL THEN 0
        WHEN rs.read_at IS NULL THEN 1
        -- Both timestamps use SQLite/D1 CURRENT_TIMESTAMP, which has
        -- one-second resolution. A message logged in the same second as
        -- mark-read is treated as read until a later incoming message arrives.
        WHEN li.latest_incoming_at > rs.read_at THEN 1
        ELSE 0
      END AS unread
    FROM flags
    JOIN dm_log dl ON dl.id = flags.max_id
    LEFT JOIN dm_log lt ON lt.id = flags.last_typed_id
    LEFT JOIN latest_incoming li ON li.conversation_id = flags.conversation_id
    LEFT JOIN dm_conversation_read_state rs ON rs.conversation_id = flags.conversation_id
    ${filterWhere}
    ORDER BY last_message_at DESC, dl.id DESC
    LIMIT ? OFFSET ?
  `).bind(...flags.params, limit, offset).all();
  // D1 returns the 0/1 CASE as a number; callers get a boolean.
  const results = (rows.results || []).map((row) => ({ ...row, waiting: row.waiting === 1 }));

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

/**
 * How many conversations each filter would list, plus the total for All.
 * Sums the same FILTER_CONDITIONS getConversations filters by.
 * @param {D1Database} db
 * @returns {Promise<{ all: number, waiting: number, person: number, reports: number, notices: number, outcomes: number, warnings: number }>}
 */
export async function getFilterCounts(db) {
  const flags = conversationFlagsCte();
  // SUM over zero rows is NULL, hence the COALESCE for an empty dm_log.
  const sums = CONVERSATION_FILTERS
    .map((key) => `COALESCE(SUM(${FILTER_CONDITIONS[key]}), 0) AS ${key}`)
    .join(',\n      ');
  const row = await db.prepare(`
    WITH ${flags.sql}
    SELECT
      COUNT(*) AS all_count,
      ${sums}
    FROM flags
  `).bind(...flags.params).first();

  const counts = { all: row.all_count };
  for (const key of CONVERSATION_FILTERS) counts[key] = row[key];
  return counts;
}

/**
 * One conversation's "Waiting on us" flag and "No reply needed" mark, from
 * the same flags the list uses. A conversation with no messages is not
 * waiting; its mark is still read from the table, so a mark is never hidden.
 * @param {D1Database} db
 * @param {string} conversationId
 * @returns {Promise<{ waiting: boolean, no_reply_needed_at: string | null }>}
 */
export async function getConversationState(db, conversationId) {
  const flags = conversationFlagsCte({ conversationId });
  const row = await db.prepare(`
    WITH ${flags.sql}
    SELECT flags.waiting, rps.no_reply_needed_at
    FROM (SELECT ? AS conversation_id) target
    LEFT JOIN flags ON flags.conversation_id = target.conversation_id
    LEFT JOIN dm_conversation_reply_state rps ON rps.conversation_id = target.conversation_id
  `).bind(...flags.params, conversationId).first();

  return {
    waiting: row.waiting === 1,
    no_reply_needed_at: row.no_reply_needed_at ?? null,
  };
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
