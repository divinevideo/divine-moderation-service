-- Composite index satisfying the dashboard's primary list query:
-- WHERE action = ? ORDER BY moderated_at DESC LIMIT N.
-- Without this, SQLite picks idx_moderation_action and adds a
-- TEMP B-TREE FOR ORDER BY on every page nav (verified via EXPLAIN).
CREATE INDEX IF NOT EXISTS idx_moderation_action_date
  ON moderation_results(action, moderated_at DESC);

-- Supports buildUploaderHistory's per-uploader recent-flagged scan.
CREATE INDEX IF NOT EXISTS idx_moderation_uploaded_by_date
  ON moderation_results(uploaded_by, moderated_at DESC);

-- Supports the latest-event-per-sha lookup that
-- src/admin/bunny-events.mjs (window-function CTE) consumes.
CREATE INDEX IF NOT EXISTS idx_bunny_events_sha256_received
  ON bunny_webhook_events(sha256, received_at DESC);

-- Partial index for the dashboard's FLAGGED filter
-- (action IN (...) AND reviewed_by IS NULL). Small (only unreviewed
-- rows), tight, lets the count avoid a full scan.
CREATE INDEX IF NOT EXISTS idx_moderation_unreviewed
  ON moderation_results(action, moderated_at DESC)
  WHERE reviewed_by IS NULL;

-- Tracks the last time the backfill cron tried to populate this
-- row's lookup metadata. Lets us skip rows we already tried for 7
-- days (avoids hammering funnelcake on permanent 404s).
ALTER TABLE moderation_results ADD COLUMN lookup_attempted_at TEXT;
