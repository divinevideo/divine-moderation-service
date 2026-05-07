// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron worker that fills event_id/title/author/content_url/published_at
// ABOUTME: on legacy moderation_results rows by calling fetchFunnelcakeLookupVideo.
// ABOUTME: Idempotent (UPDATE WHERE event_id IS NULL); rate-limited; KV-mutex
// ABOUTME: protected against overlap with manual triggers.

const LOCK_KEY = 'backfill:lock';
const LOCK_TTL_S = 300; // 5 minutes — also a deadlock fuse if the worker dies mid-batch.
const RETRY_AFTER_DAYS = 7;

/**
 * Run a single backfill batch.
 *
 * Required: `fetchLookup` (DI) — typically `fetchFunnelcakeLookupVideo`
 * from src/index.mjs. Returns either null (404) or a parsed lookup
 * object with shape `{ eventId, videoUrl, uploadedBy, createdAt,
 * nostrContext: { title, author, publishedAt, url, ... }, ... }`
 * (see buildFunnelcakeVideoLookup in src/index.mjs:212).
 *
 * Returns `{ skipped }` when disabled or another run holds the lock,
 * otherwise `{ picked, updated, missing, errored }`.
 */
export async function runBackfill(env, options = {}) {
  const {
    limit,
    concurrency = 10,
    fetchLookup,
    now = () => new Date().toISOString(),
  } = options;

  if (typeof fetchLookup !== 'function') {
    throw new Error('runBackfill: fetchLookup is required');
  }
  if (env.BACKFILL_ENABLED !== 'true') {
    return { skipped: 'disabled' };
  }

  // Best-effort mutex: prevents the every-minute cron and a manual
  // trigger from double-fetching the same shas. Intentionally NOT
  // strict — KV doesn't expose CAS, and read-then-write is racy under
  // exactly-simultaneous calls. Two callers could both observe no
  // lock and both proceed; the worst case is one duplicate batch of
  // funnelcake calls (the UPDATE WHERE event_id IS NULL keeps the DB
  // writes idempotent, so no data corruption). The 5-minute TTL
  // doubles as a deadlock fuse if the worker dies mid-batch.
  const existingLock = await env.MODERATION_KV.get(LOCK_KEY);
  if (existingLock) {
    return { skipped: 'locked' };
  }
  await env.MODERATION_KV.put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_S });

  try {
    const rowsLimit = Math.max(1, Math.min(
      limit ?? Number(env.BACKFILL_ROWS_PER_TICK ?? '200'),
      500,
    ));
    const retryAfter = new Date(Date.now() - RETRY_AFTER_DAYS * 24 * 3600 * 1000).toISOString();

    const rows = (await env.BLOSSOM_DB.prepare(`
      SELECT sha256
      FROM moderation_results
      WHERE event_id IS NULL
        AND (lookup_attempted_at IS NULL OR lookup_attempted_at < ?)
      ORDER BY moderated_at DESC
      LIMIT ?
    `).bind(retryAfter, rowsLimit).all()).results || [];

    let updated = 0;
    let missing = 0;
    let errored = 0;

    const queue = [...rows];

    async function worker() {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) continue;
        const attemptedAt = now();
        let lookup;
        try {
          lookup = await fetchLookup(row.sha256);
        } catch {
          errored++;
          continue;
        }
        if (!lookup) {
          // 404 from funnelcake. Record the attempt so we don't
          // re-poll for RETRY_AFTER_DAYS days.
          await env.BLOSSOM_DB.prepare(
            `UPDATE moderation_results
             SET lookup_attempted_at = ?
             WHERE sha256 = ? AND event_id IS NULL`,
          ).bind(attemptedAt, row.sha256).run();
          missing++;
          continue;
        }
        const ctx = lookup.nostrContext || {};
        await env.BLOSSOM_DB.prepare(
          `UPDATE moderation_results SET
             event_id = COALESCE(?, event_id),
             title = COALESCE(?, title),
             author = COALESCE(?, author),
             content_url = COALESCE(?, content_url),
             published_at = COALESCE(?, published_at),
             lookup_attempted_at = ?
           WHERE sha256 = ? AND event_id IS NULL`,
        ).bind(
          lookup.eventId || null,
          ctx.title || null,
          ctx.author || null,
          lookup.videoUrl || ctx.url || null,
          ctx.publishedAt != null ? String(ctx.publishedAt) : null,
          attemptedAt,
          row.sha256,
        ).run();
        updated++;
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));

    return { picked: rows.length, updated, missing, errored };
  } finally {
    await env.MODERATION_KV.delete(LOCK_KEY);
  }
}
