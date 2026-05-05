# Moderation Dashboard Speedup — Design

Status: Draft
Author: rabble (with Claude)
Date: 2026-05-05

## Problem

The moderation dashboard at `moderation.admin.divine.video` is slow enough
that paid moderators wait on page loads. Concrete causes, all confirmed by
reading the code and running queries against production D1:

1. **Per-row external fan-out.** `/admin/api/videos` calls
   `getAdminLookupVideo(sha256)` for every row already returned by its main
   list query (`src/index.mjs:1539-1558`). Inside that helper,
   `enrichAdminLookupVideo` (`src/index.mjs:852-898`) fires
   `fetchFunnelcakeLookupVideo`, an HTTP call to `relay.divine.video`,
   whenever `eventId || divineUrl || nostrContext` is null. The list-query
   `SELECT` and `getAdminLookupVideo`'s own `SELECT` (`src/index.mjs:992-996`,
   `1511`) **omit** the columns (`event_id`, `title`, `author`,
   `content_url`, `published_at`) that would populate those fields, even
   though the columns exist on `moderation_results` (added by
   `migrations/004-content-metadata.sql`). `buildStoredLookupMetadata`
   reads those keys off the row, but they are `undefined` because they
   were never selected, so `eventId`/`nostrContext` are always falsy and
   the funnelcake branch always wins. Result: the funnelcake fetch fires
   for every card, every page, even for rows whose data is already in
   D1. A single funnelcake request was timed at ~1.6s today.
2. **Wrong-shape indexes.** `moderation_results` (322,917 rows) has
   single-column indexes on `action` and `moderated_at`. The dashboard's
   primary list query (`WHERE action=? ORDER BY moderated_at DESC LIMIT
   50`) cannot use them together; SQLite picks `idx_moderation_action` and
   builds a `TEMP B-TREE FOR ORDER BY` on every page nav (verified with
   `EXPLAIN QUERY PLAN`).
3. **Correlated-subquery scan in `/admin/api/untriaged`.** The "latest
   event per sha" lookup is hand-rolled as
   `WHERE received_at = (SELECT MAX(received_at) FROM bunny_webhook_events
   e2 WHERE e2.sha256 = e1.sha256)` and is copy-pasted four times in
   `src/index.mjs` (subquery line numbers: 1036, 1149, 1707, 1779 — in
   `getAdminLookupVideo`, `getStoredAdminPlaybackCandidates`,
   `/admin/api/untriaged` list, and `/admin/api/untriaged` count).
   `EXPLAIN QUERY PLAN` shows a full-table scan of `e1` with a correlated
   scalar subquery per row.
4. **Sequential KV reads** inside `for...of await` loops
   (`src/index.mjs:1736-1741`).
5. **Uncached full-table aggregations.** `/admin/api/stats` runs
   `COUNT(DISTINCT sha256)` plus two `GROUP BY action` aggregations on
   every dashboard mount and every `visibilitychange`. None of it cached.
6. **(Note: not actually a problem.)** `dashboard.html` is already served
   with `Cache-Control: no-cache` and a deterministic content-hash ETag
   (`src/index.mjs:69-95`). Browsers revalidate but get a 304 when the
   file hasn't changed. **L6 in earlier drafts of this spec proposed
   re-doing this; that work is unnecessary and is dropped from scope.**

Population data confirms the SELECT-widening fix is high-leverage:
- Rows since 2026-04-01: **5,994/6,044 (99%) already have `event_id`**.
- Rows total: 6,905/322,917 (~2%) — but the dashboard sorts
  `moderated_at DESC LIMIT 50`, so the moderator's working window is
  already mostly populated. Backfill addresses the rest.

## Goals

- Sub-second `/admin/api/videos`, `/admin/api/untriaged`, and
  `/admin/api/stats` (p95).
- Dashboard mount < 1.5s end-to-end on a warm cache.
- All current functionality preserved. Every field rendered today must
  keep rendering. Every action must keep working. Response shapes
  unchanged.
- Backfill all 316k legacy rows so legacy navigation is fast too.

## Non-Goals

- Redesigning the dashboard UI.
- Changing the moderation pipeline, scoring, or category logic.
- Changing what data we store in `moderation_results`.
- Changing public API response shapes consumed by other services.
- Switching off Cloudflare Workers / D1.

## Constraints

- Cloudflare Workers: 50 concurrent subrequests, 30s CPU, KV eventual
  consistency.
- D1 / SQLite: limited window-function support compared to PG; verify
  with `EXPLAIN QUERY PLAN` before relying on `ROW_NUMBER()`.
- Production: 322,917 rows in `moderation_results`. Auto-deploys on
  merge to `main` via `cloudflare/wrangler-action`.

## Architecture — five layers, ordered by impact

(L6 in an earlier draft was a no-op; dropped.)

### L1. Composite indexes (D1 migration)

New file `migrations/009-dashboard-speedup-indexes.sql` (numeric
sequence follows the existing convention; latest is `008-`):

```sql
CREATE INDEX IF NOT EXISTS idx_moderation_action_date
  ON moderation_results(action, moderated_at DESC);

CREATE INDEX IF NOT EXISTS idx_moderation_uploaded_by_date
  ON moderation_results(uploaded_by, moderated_at DESC);

CREATE INDEX IF NOT EXISTS idx_bunny_events_sha256_received
  ON bunny_webhook_events(sha256, received_at DESC);

-- Partial index for the FLAGGED filter (action IN (...) AND
-- reviewed_by IS NULL). The dashboard's "Flagged" stat-card uses this
-- predicate; without the partial index the count requires fetching
-- every row to check reviewed_by.
CREATE INDEX IF NOT EXISTS idx_moderation_unreviewed
  ON moderation_results(action, moderated_at DESC)
  WHERE reviewed_by IS NULL;

-- Tracks when we last asked funnelcake about a sha that has no
-- event_id, so the backfill cron doesn't loop forever on permanent
-- 404s. Migration also adds the column.
ALTER TABLE moderation_results ADD COLUMN lookup_attempted_at TEXT;
```

`IF NOT EXISTS` makes it safe to re-run. D1 builds these inline; on
322k rows the build takes seconds. No down time.

**Verification:** after applying, run
`EXPLAIN QUERY PLAN SELECT … WHERE action='REVIEW' ORDER BY
moderated_at DESC LIMIT 50` and confirm the plan no longer contains
`USE TEMP B-TREE FOR ORDER BY`.

### L2. Widen SELECTs and remove the per-row fan-out

**Code touch points (single file, `src/index.mjs`):**

- `getAdminLookupVideo` (line 992): add `event_id, title, author,
  content_url, published_at` to the SELECT.
- `/admin/api/videos` (line 1511): same widening.
- `/api/v1/decisions` (line 3951): same widening — preserves response
  shape, just fills more fields.

**Then in `/admin/api/videos` (lines 1539-1558)** replace:

```js
const videos = await Promise.all(videoRows.map(async (video) => {
  const enriched = await getAdminLookupVideo(video.sha256, env);
  // ...
}));
```

with a synchronous mapper that builds the response from the row using
`buildStoredLookupMetadata(row)`. No second D1 read, no funnelcake fetch.

**Funnelcake fallback path** is preserved: when `event_id IS NULL`
(legacy rows pre-backfill), fall through to the slow path. After
backfill completes, this becomes ≈ 0% of rows.

**Field-level shape change to acknowledge.**
`buildStoredLookupMetadata` hard-codes `nostrContext.client = null`
and `nostrContext.content = null` (`src/index.mjs:272-273`); these
two fields are not stored in `moderation_results` today. The
funnelcake fetch currently fills them. After this change, on the
**list endpoint** those two fields will be `null` for every row.
The dashboard's list cards do not display `client` or `content`
prominently (verified by reading `createCard`/`createTriageCard` in
`dashboard.html`), so this is acceptable. The **single-video lookup
endpoint** `/admin/api/video/:id` keeps the on-demand funnelcake
fetch so the detail view continues to show those fields. We are
explicitly trading one network call per **page** of cards for one
network call per **opened detail view** — net win because moderators
look at far fewer detail views than they scroll past cards.

**Batch uploader_enforcement.** Collect the unique non-null
`uploaded_by` values from the page, do one
`SELECT … FROM uploader_enforcement WHERE pubkey IN (?,?,…)` query,
attach by pubkey lookup. Replaces N parallel D1 round-trips with 1.

**Result per page render**: 1 list query + 1 IN query + KV cached
stats. ~3 round-trips, down from ~150-250.

### L3. KV cache for stats

Wrap `/admin/api/stats`, `/admin/api/ai-detection/stats`, the COUNT
in `/api/v1/decisions`, and the COUNT in `/admin/api/untriaged` with
a small helper. The handler signature in `src/index.mjs` is
`async fetch(request, env, ctx)` (`src/index.mjs:1341`), so `ctx`
must be threaded through:

```js
async function cachedStat(env, ctx, key, ttlSeconds, compute) {
  const cached = await env.MODERATION_KV.get(`stats:v1:${key}`);
  if (cached) return JSON.parse(cached);
  const fresh = await compute();
  // best-effort write, do not block response
  ctx.waitUntil(env.MODERATION_KV.put(
    `stats:v1:${key}`,
    JSON.stringify(fresh),
    { expirationTtl: ttlSeconds }
  ));
  return fresh;
}
```

- TTL: 60s.
- `?fresh=1` bypasses the cache **read but still writes** the fresh
  value back. (Otherwise 50 moderators each hitting Refresh would
  cause a cache stampede; with bypass-read-only-then-write, the
  first one populates the cache for the rest.)
- Cron prewarms every 60s so the first request after a TTL window is
  still served from cache.
- Cache key encodes filter params: `stats:v1:videos:action=REVIEW`.

Stats endpoint goes from ~200-500ms to ~5-10ms.

### L4. Untriaged cleanup

Replace the correlated subquery with one of:

1. `ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC) = 1`
2. `GROUP BY sha256 HAVING received_at = MAX(received_at)`

We will write both, run `EXPLAIN QUERY PLAN`, pick the one that uses
`idx_bunny_events_sha256_received` cleanly with no temp B-tree.

The four hand-rolled copies of this logic (subquery line numbers:
`src/index.mjs:1036, 1149, 1707, 1779`) get extracted into a single
helper `latestBunnyEventBySha(env, { sha256?, limit?, offset? })`.

Parallelize the KV reads at line 1737 with `Promise.all`. Cache the
COUNT in KV with 60s TTL.

**Cache the per-row Nostr fetch.** Even after L1+L2, the untriaged
endpoint still fires one `fetchNostrEventBySha256` WebSocket call per
sha (`src/index.mjs:1745-1763`). Add a KV cache:
`nostr:event:${sha256}` with 1-hour TTL. The Triage list rarely
changes its top entries within an hour, and a cache miss falls
through to the existing live fetch. This brings untriaged from ~50
parallel WS calls to typically 0-3.

### L5. Legacy backfill cron

New file `src/admin/backfill-lookup-columns.mjs`. Wired into
`scheduled` in `src/index.mjs` and into `wrangler.toml` cron.

Behavior, every 60s:
1. `SELECT sha256 FROM moderation_results WHERE event_id IS NULL AND
   (lookup_attempted_at IS NULL OR lookup_attempted_at < ?)
   ORDER BY moderated_at DESC LIMIT 200`
   — newest legacy first, since those are more likely to be reviewed.
2. For each, call `fetchFunnelcakeLookupVideo(sha256)`, capped at 10
   concurrent.
3. On hit: `UPDATE moderation_results SET event_id = ?, title = ?,
   author = ?, content_url = ?, published_at = ?,
   lookup_attempted_at = ? WHERE sha256 = ? AND event_id IS NULL`
   (the trailing condition keeps it idempotent).
4. On 404: `UPDATE … SET lookup_attempted_at = ? WHERE sha256 = ?`
   so we don't loop forever on permanent misses. Retry after 7 days.
5. On HTTP error: log, no DB write, retry next tick.

**New column.** `ALTER TABLE moderation_results ADD COLUMN
lookup_attempted_at TEXT` — included in the L1 migration.

**Rate.** 200 rows/min × 60 min = 12k/hr → 316k rows ≈ **26 hours**.
Configurable via env var `BACKFILL_ROWS_PER_TICK`.

**Manual trigger.** `POST /admin/api/backfill/run?count=N` (auth
required) lets ops kick a one-off batch.

**Feature flag.** `BACKFILL_ENABLED=true` env var. Off by default in
the first deploy; flipped on after L1-L4 verify clean in production.

**Idempotency.** The `WHERE event_id IS NULL` predicate on the UPDATE
guarantees no overwrite of already-populated rows.

**Mutex / overlap protection.** The cron tick + the manual trigger
could race and both call funnelcake for the same 200 shas, doubling
load on `relay.divine.video`. Before each batch, take a KV lock:
```
const lock = await env.MODERATION_KV.get('backfill:lock');
if (lock) return { skipped: 'locked' };
await env.MODERATION_KV.put('backfill:lock', String(Date.now()),
  { expirationTtl: 300 });
try { … run batch … }
finally { await env.MODERATION_KV.delete('backfill:lock'); }
```
TTL of 300s means a crashed worker auto-releases. The
`expirationTtl` doubles as a deadlock fuse.

### L6. Static-asset caching — DROPPED

Earlier draft proposed switching `dashboard.html` from `no-store` to
`max-age=300`. Reading the actual code (`src/index.mjs:69-95`)
showed the page is already served with `Cache-Control: no-cache`
and a deterministic content-hash ETag, so browsers already
revalidate-and-304 on every nav. No change needed.

## Components / file map

| Layer | File | Change |
|-------|------|--------|
| L1 | `migrations/009-dashboard-speedup-indexes.sql` | new |
| L2 | `src/index.mjs` | widen SELECTs, kill fan-out, batch enforcement |
| L2 | `src/admin/lookup-helpers.mjs` (new) | extract row→admin-shape mapper for testing |
| L3 | `src/index.mjs` | wrap three stat endpoints in `cachedStat` |
| L3 | `src/admin/cache.mjs` (new) | `cachedStat` helper |
| L4 | `src/index.mjs` | replace correlated subquery, parallelize KV |
| L4 | `src/admin/bunny-events.mjs` (new) | `latestBunnyEventBySha` helper |
| L5 | `src/admin/backfill-lookup-columns.mjs` (new) | cron worker |
| L5 | `src/index.mjs` | scheduled handler dispatch + manual trigger |
| L5 | `wrangler.toml` | cron trigger entry |
| L6 | — | dropped, already implemented |

## Testing

**Discipline**: TDD per layer. For each behavior change:
1. Write a test that fails on `main`.
2. Write the fix.
3. Confirm the test passes and the existing 303-test suite still does.

**New test files:**

- `src/admin/dashboard-fanout.test.mjs` —
  - Stubs `fetch` and `enrichAdminLookupVideo` with counters.
  - Seeds D1 fixture with rows that have `event_id` populated.
  - Calls `/admin/api/videos`.
  - Asserts `fetch.callCount === 0` (no funnelcake).
  - Asserts `enrichAdminLookupVideo.callCount === 0` (no per-row helper).
  - **Golden snapshot test**: pin the exact JSON shape of
    `videos[0]` for a fully-populated row. Compare byte-for-byte
    before/after the change to catch any field reordering, missing
    key, or unexpected `undefined`. Separate snapshot for a
    partially-populated row (post-backfill 404 sentinel).
  - **Legacy fallthrough test**: row with `event_id IS NULL` —
    asserts funnelcake IS called exactly once and the response
    includes the funnelcake-derived fields.

- `src/admin/stats-cache.test.mjs` —
  - First call: D1 hit, KV write.
  - Second call within TTL: KV hit, no D1 read.
  - `?fresh=1`: D1 hit, KV write.

- `src/admin/untriaged-query.test.mjs` —
  - Seeds `bunny_webhook_events` with multiple events per sha256.
  - Asserts new helper returns the same rows as the old correlated
    subquery (golden test).
  - `EXPLAIN QUERY PLAN` does not contain `TEMP B-TREE` or
    `CORRELATED`.

- `src/admin/backfill-lookup-columns.test.mjs` —
  - Idempotent: second run on same row is a no-op.
  - 404 path sets `lookup_attempted_at`.
  - HTTP error path leaves row unchanged.
  - Honors `BACKFILL_ROWS_PER_TICK`.
  - Concurrency cap respected.
  - **Mutex test:** start two concurrent runs — assert one returns
    `{ skipped: 'locked' }` and the other does the work. Each row
    is processed at most once across both calls.

- `src/admin/lookup-helpers.test.mjs` —
  - `buildStoredLookupMetadata` returns expected shape for all column
    populations (none, partial, full).

**Existing tests** must still pass without modification — that is the
guarantee that response shapes are unchanged.

**EXPLAIN QUERY PLAN tests** are not run in vitest (D1 binding does
not expose `EXPLAIN`). They live in
`scripts/verify-query-plans.mjs`, run via `wrangler d1 execute`,
included in the release checklist. Each PR touching SQL must show
the plan output in its description.

## Rollout

Split into five small PRs so each can bake independently and any
regression is easy to bisect.

1. **PR 1 — L1 only (migration).** Adds composite indexes,
   partial index, and `lookup_attempted_at` column. No code change.
   Apply via `wrangler d1 migrations apply` then verify
   `EXPLAIN QUERY PLAN` for the three target queries. Trivial
   revert: `DROP INDEX`.
2. **PR 2 — L2 (widen SELECTs + kill fan-out).** This is the
   biggest perceived speedup for moderators. Includes the field-level
   shape change call-out from the L2 section. Lands after L1 is in
   prod for at least a few hours.
3. **PR 3 — L3 (KV cache for stats).**
4. **PR 4 — L4 (untriaged: helper extraction, window query, KV
   parallelization, Nostr cache).**
5. **PR 5 — L5 (backfill cron + manual trigger).** Ships with
   `BACKFILL_ENABLED=false`. After verifying the manual trigger on
   a 100-row batch, flip to `true`. Monitor progress via
   `SELECT COUNT(*) FROM moderation_results WHERE event_id IS NULL`.

Each PR is independently revertable. Dropping the indexes is a
single statement; reverting the cache wrapper is a code revert; the
backfill is gated behind a flag.

## Performance targets

| Endpoint | Today (observed) | Target (p95) |
|----------|------------------|--------------|
| `/admin/api/videos?limit=50` | 3-10s | < 200ms |
| `/admin/api/stats` | 200-500ms | < 50ms (cached) |
| `/admin/api/untriaged?limit=50` | 1-3s | < 300ms |
| Dashboard mount | 5-15s | < 1.5s |

Measured via `time_starttransfer` from a curl harness before and
after each PR.

## Risks and mitigations

- **D1 query planner picks wrong index after we add composites.**
  Mitigation: run `EXPLAIN QUERY PLAN` post-migration; add
  `INDEXED BY` hint if needed; one of the new indexes is a strict
  superset of an existing one and the planner generally picks the
  more specific one.
- **KV-cached stats become stale during a moderator's session.**
  Mitigation: 60s TTL is short. Refresh button passes `?fresh=1`.
  Visibilitychange already debounces to 30s.
- **Funnelcake API rate-limits the backfill.** Mitigation: 10 concurrent
  cap, 200/min default rate; can dial down via env var without redeploy.
- **A row's writer changes the schema again.** Mitigation: backfill is
  idempotent and only touches rows where `event_id IS NULL`.

## Initial-mount fetch audit

The dashboard fires the following endpoints on initial mount
(grepped from `src/admin/dashboard.html`). Spec coverage noted:

| Endpoint | Hit on mount? | Covered by spec? |
|----------|--------------|------------------|
| `/admin/api/stats` | yes (`loadRealStats`) | L3 |
| `/admin/api/ai-detection/stats` | yes (`loadAIDetectionStats`) | L3 |
| `/admin/api/untriaged` or `/admin/api/videos` | yes (one or the other depending on filter) | L2/L4 |
| `/admin/api/messages` | yes (unread badge) | not addressed; small payload, low priority |
| `/admin/api/thresholds` | only when modal opens | not addressed |
| `/admin/api/nostr-context/:sha256` | only on detail-view click | not addressed |
| `/admin/api/transcript/:sha256` | only on detail-view click | not addressed |
| `/admin/api/uploader/:pubkey` | only on detail-view click | not addressed |
| `/admin/api/realness/:sha256` | only on detail-view click | not addressed |
| `/admin/api/classifier/:sha256` | only on detail-view click | not addressed |

The on-mount fetches are all addressed. Detail-view fetches are
out of scope for this spec; they fire only when a moderator opens
a single video.

## Open questions

- Should the backfill cron also populate `uploaded_by` if missing?
  Currently `uploaded_by` is well-populated on legacy rows; defer.
- Should `getUploaderEnforcement` move off the list endpoint
  entirely, fetched only on detail-view? Defer; the batched
  `WHERE pubkey IN (…)` should be fast enough.

## Out of scope (follow-ups, separate spec if needed)

- Server-side rendering of the dashboard.
- Replacing the inline 5,490-line `dashboard.html` with a bundled
  asset.
- Migrating off D1 to a different store.
- Pagination via cursors instead of offsets.
