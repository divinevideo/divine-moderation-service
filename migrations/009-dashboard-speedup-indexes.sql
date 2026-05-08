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
--
-- NOTE: SQLite does NOT support ADD COLUMN IF NOT EXISTS (D1 inherits
-- this). Wrangler's migrations table prevents reruns under normal
-- deploys, but if an operator ever has to manually re-apply this file
-- (e.g. via `wrangler d1 execute --file=...`), the ALTER TABLE will
-- error with "duplicate column name". That's the safe failure: nothing
-- was already corrupted. Either drop the ALTER line for the manual
-- replay, or split this concern into a separate migration file in a
-- future change.
ALTER TABLE moderation_results ADD COLUMN lookup_attempted_at TEXT;
