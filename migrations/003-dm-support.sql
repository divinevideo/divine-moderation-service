-- Add creator pubkey to moderation results
ALTER TABLE moderation_results ADD COLUMN uploaded_by TEXT;

-- DM conversation log
CREATE TABLE IF NOT EXISTS dm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,       -- SHA-256(sorted(pubkeyA + pubkeyB))
  sha256 TEXT,                         -- related video hash (nullable)
  direction TEXT NOT NULL,             -- 'outgoing' | 'incoming'
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  message_type TEXT,                   -- 'moderation_notice' | 'report_outcome' | 'conversation_report' | 'moderator_reply' | 'creator_reply'
  content TEXT NOT NULL,
  nostr_event_id TEXT,                 -- gift-wrap event ID on relay
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- dm_log.unverified_excerpt TEXT is added in code, not by a migration: see
-- ensureDmLogExcerptColumn in src/nostr/dm-store.mjs (CI never applies migrations).
CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_log(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_dm_sha256 ON dm_log(sha256);
