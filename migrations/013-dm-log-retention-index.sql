-- Supports pruneExpiredDmLog's `DELETE FROM dm_log WHERE created_at < ...`
-- (src/nostr/dm-store.mjs), the one-year retention sweep decided in PR #219
-- (Trust & Safety, 2026-09-14). Without this index the sweep is a full
-- table scan on every run.
CREATE INDEX IF NOT EXISTS idx_dm_log_created_at ON dm_log(created_at);
