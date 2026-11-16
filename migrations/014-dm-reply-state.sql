-- Per-conversation "No reply needed" mark for the admin Messages UI.
--
-- A separate one-row-per-conversation table (rather than a column on
-- `dm_log`) for the same reason as dm_conversation_read_state (migration
-- 012): the mark belongs to the conversation as a whole, not to any one
-- message. The mark is shared across moderators, so there is one row per
-- conversation, not one per moderator. A missing row means no mark.
--
-- `no_reply_needed_at` is always written via SQL `CURRENT_TIMESTAMP` (see
-- markNoReplyNeeded in dm-store.mjs), so it shares `dm_log.created_at`'s
-- "YYYY-MM-DD HH:MM:SS" UTC text format and stays safely comparable with a
-- plain `>`. A client-generated ISO-8601 string would sort differently under
-- a lexicographic TEXT comparison ('T'/'Z' characters) and silently break
-- "a newer incoming message after the mark".
CREATE TABLE IF NOT EXISTS dm_conversation_reply_state (
  conversation_id TEXT PRIMARY KEY,
  no_reply_needed_at TEXT NOT NULL
);
