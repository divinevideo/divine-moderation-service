-- Per-conversation read marker for the admin Messages UI's unread badge.
--
-- A separate one-row-per-conversation table (rather than a `read_at` column
-- on `dm_log` itself) because "read" is a conversation-level concept, not a
-- per-message one -- there is nothing sensible for an individual message row
-- to mean by "this one message is read" independent of the rest of its
-- thread. `getConversations` (dm-store.mjs) LEFT JOINs this table by
-- conversation_id; a missing row means "never marked read", which combined
-- with any existing incoming message correctly reads as unread.
--
-- `read_at` is always written via SQL `CURRENT_TIMESTAMP` (see
-- markConversationRead in dm-store.mjs), matching `dm_log.created_at`'s own
-- generation mechanism exactly. Both columns therefore share the same
-- SQLite CURRENT_TIMESTAMP text format ("YYYY-MM-DD HH:MM:SS", UTC, no
-- timezone marker) and remain safely comparable with a plain `>` -- mixing
-- that format with a client-generated ISO-8601 string (which sorts
-- differently under a lexicographic TEXT comparison because of the 'T'/'Z'
-- characters) would silently make "unread" permanently stick at whatever it
-- was the first time a conversation was marked read.
CREATE TABLE IF NOT EXISTS dm_conversation_read_state (
  conversation_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);
