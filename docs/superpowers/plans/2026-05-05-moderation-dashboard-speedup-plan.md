# Moderation Dashboard Speedup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `moderation.admin.divine.video` p95 page load < 1.5s (today: 5–15s) without changing what the dashboard displays.

**Architecture:** Five PRs. (1) D1 indexes + new column. (2) Widen SELECTs and remove the 50× funnelcake fan-out. (3) KV-cached stats. (4) Untriaged endpoint cleanup. (5) Backfill cron for legacy rows. Spec: `docs/superpowers/specs/2026-05-05-moderation-dashboard-speedup-design.md`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), KV, vitest with `@cloudflare/vitest-pool-workers`.

**Conventions used everywhere:**
- TDD: write failing test → confirm it fails → implement → confirm it passes → commit.
- Tests live next to source: `src/foo.mjs` ↔ `src/foo.test.mjs`.
- Run a single test file: `npm test -- src/path/to/file.test.mjs`.
- Run the full suite: `npm test`.
- All commits are conventional: `feat:`, `fix:`, `perf:`, `test:`, `refactor:`, `chore:`.
- Don't merge to main without `npm test` passing locally.

---

## Chunk 1: PR1 — D1 migration (indexes + lookup_attempted_at column)

This is the only PR that ships pure schema. Code changes that depend on the new index land in PR2.

### Task 1.1: Write the migration file

**Files:**
- Create: `migrations/009-dashboard-speedup-indexes.sql`

- [ ] **Step 1: Create the SQL file**

```sql
-- Composite index that satisfies the dashboard's primary list query:
-- WHERE action = ? ORDER BY moderated_at DESC LIMIT N
-- Replaces the temp B-tree sort on every page nav.
CREATE INDEX IF NOT EXISTS idx_moderation_action_date
  ON moderation_results(action, moderated_at DESC);

-- Supports the uploader-history query in buildUploaderHistory().
CREATE INDEX IF NOT EXISTS idx_moderation_uploaded_by_date
  ON moderation_results(uploaded_by, moderated_at DESC);

-- Supports the latest-event-per-sha lookup that PR4 will rewrite.
CREATE INDEX IF NOT EXISTS idx_bunny_events_sha256_received
  ON bunny_webhook_events(sha256, received_at DESC);

-- Partial index for the FLAGGED filter
-- (action IN (...) AND reviewed_by IS NULL).
CREATE INDEX IF NOT EXISTS idx_moderation_unreviewed
  ON moderation_results(action, moderated_at DESC)
  WHERE reviewed_by IS NULL;

-- Tracks last attempt time so the backfill cron in PR5 can skip rows
-- it already tried. Nullable; populated by the backfill.
ALTER TABLE moderation_results ADD COLUMN lookup_attempted_at TEXT;
```

### Task 1.2: Wire migrations into miniflare (test runner)

The current `wrangler.toml` does not set `migrations_dir`, so
`@cloudflare/vitest-pool-workers` initialises an empty schema in
miniflare. Once PR2's tests start asserting on the new column /
indexes, the test schema must match production.

**Files:**
- Modify: `wrangler.toml` (the `[[d1_databases]]` block)

- [ ] **Step 1:** Add `migrations_dir = "migrations"` under the existing D1 binding:

```toml
[[d1_databases]]
binding = "BLOSSOM_DB"
database_name = "blossom-webhook-events"
database_id = "829f06cf-294b-4491-8611-30fc53df2589"
migrations_dir = "migrations"
```

- [ ] **Step 2:** Verify locally that `npm test` still passes — miniflare
will replay migrations on every test boot.

- [ ] **Step 3:** Commit alongside the migration file.

### Task 1.3: Apply migration to remote D1

- [ ] **Step 1: Dry-run / inspect**

Run: `wrangler d1 migrations list blossom-webhook-events --remote`
Expected: `009-dashboard-speedup-indexes.sql` listed as not yet applied.

- [ ] **Step 2: Apply**

Run: `wrangler d1 migrations apply blossom-webhook-events --remote`
Expected: "✓ 009-dashboard-speedup-indexes.sql".

- [ ] **Step 3: Verify schema**

Run:
```
wrangler d1 execute blossom-webhook-events --remote --command \
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='moderation_results' ORDER BY name"
```
Expected output includes `idx_moderation_action_date`, `idx_moderation_unreviewed`, `idx_moderation_uploaded_by_date`.

Run:
```
wrangler d1 execute blossom-webhook-events --remote --command \
  "PRAGMA table_info(moderation_results)" | grep lookup_attempted_at
```
Expected: column present.

### Task 1.4: Add a verify-query-plans script

**Files:**
- Create: `scripts/verify-query-plans.mjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// ABOUTME: Run EXPLAIN QUERY PLAN on the dashboard's hot queries and
// fail loudly if any of them regress to a temp B-tree sort or correlated scan.

import { execSync } from 'node:child_process';

const DB = 'blossom-webhook-events';
const QUERIES = [
  {
    name: 'list-by-action',
    sql: `EXPLAIN QUERY PLAN SELECT sha256 FROM moderation_results WHERE action='REVIEW' ORDER BY moderated_at DESC LIMIT 50`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_action_date']
  },
  {
    name: 'flagged-count',
    sql: `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM moderation_results WHERE action='REVIEW' AND reviewed_by IS NULL`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_unreviewed']
  },
  {
    name: 'uploader-history',
    sql: `EXPLAIN QUERY PLAN SELECT sha256 FROM moderation_results WHERE uploaded_by='abc' ORDER BY moderated_at DESC LIMIT 10`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_uploaded_by_date']
  }
];

let failed = 0;
for (const q of QUERIES) {
  const out = execSync(
    `wrangler d1 execute ${DB} --remote --command ${JSON.stringify(q.sql)}`,
    { encoding: 'utf8' }
  );
  const ok =
    q.forbid.every((bad) => !out.includes(bad)) &&
    q.require.every((needle) => out.includes(needle));
  console.log(`${ok ? '✓' : '✗'} ${q.name}`);
  if (!ok) {
    console.log(out);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it post-migration**

Run: `node scripts/verify-query-plans.mjs`
Expected: three checkmarks, exit 0.

### Task 1.5: Commit and open PR1

- [ ] **Step 1: Commit**

```
git add migrations/009-dashboard-speedup-indexes.sql scripts/verify-query-plans.mjs
git commit -m "perf: add composite indexes + lookup_attempted_at for dashboard speedup

Adds idx_moderation_action_date, idx_moderation_uploaded_by_date,
idx_moderation_unreviewed, idx_bunny_events_sha256_received, and a
nullable lookup_attempted_at column for the backfill cron in PR5.

EXPLAIN QUERY PLAN verified: list, flagged-count, and uploader-history
queries no longer require a temp B-tree sort.

Spec: docs/superpowers/specs/2026-05-05-moderation-dashboard-speedup-design.md"
```

- [ ] **Step 2: Open PR**

Run `gh pr create` with body summarizing: layer L1 of the speedup spec, no code change, EXPLAIN output attached. Wait for the auto-deploy + verify in production before starting Chunk 2.

---

## Chunk 2: PR2 — Widen SELECTs, remove fan-out, batch uploader_enforcement

This is the big perceived speedup. Target: `/admin/api/videos?limit=50` from 3-10s to <200ms.

### Task 2.1: Extract `buildAdminVideoFromRow` into its own module

Why: makes it pure, testable, and prevents a regression where `buildStoredLookupMetadata` reads columns that aren't selected.

**Files:**
- Create: `src/admin/lookup-helpers.mjs`
- Create: `src/admin/lookup-helpers.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// src/admin/lookup-helpers.test.mjs
import { describe, it, expect } from 'vitest';
import { buildAdminVideoFromRow, ADMIN_VIDEO_COLUMNS } from './lookup-helpers.mjs';

describe('buildAdminVideoFromRow', () => {
  it('produces a complete video shape from a fully-populated row', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'REVIEW',
      provider: 'manual-review',
      scores: '{"nsfw":0.2}',
      categories: '["nsfw"]',
      moderated_at: '2026-05-05T00:00:00Z',
      reviewed_by: null,
      reviewed_at: null,
      uploaded_by: 'b'.repeat(64),
      event_id: 'c'.repeat(64),
      title: 'Test Video',
      author: 'Alice',
      content_url: 'https://example.com/v.mp4',
      published_at: '1717200000'
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out).toMatchObject({
      sha256: row.sha256,
      action: 'REVIEW',
      eventId: row.event_id,
      divineUrl: `https://divine.video/video/${row.event_id}`,
      uploaded_by: row.uploaded_by,
      nostrContext: {
        title: 'Test Video',
        author: 'Alice',
        url: row.content_url,
        eventId: row.event_id
      }
    });
    expect(out.scores).toEqual({ nsfw: 0.2 });
  });

  it('returns null eventId/divineUrl/nostrContext when row has no metadata', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      moderated_at: '2026-05-05T00:00:00Z'
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out.eventId).toBeNull();
    expect(out.divineUrl).toBeNull();
    expect(out.nostrContext).toBeNull();
  });

  it('exports the column list expected to be in SELECTs', () => {
    expect(ADMIN_VIDEO_COLUMNS).toContain('event_id');
    expect(ADMIN_VIDEO_COLUMNS).toContain('title');
    expect(ADMIN_VIDEO_COLUMNS).toContain('author');
    expect(ADMIN_VIDEO_COLUMNS).toContain('content_url');
    expect(ADMIN_VIDEO_COLUMNS).toContain('published_at');
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test -- src/admin/lookup-helpers.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/admin/lookup-helpers.mjs
// ABOUTME: Pure helpers that turn a moderation_results row into the shape
// the admin dashboard expects. No side effects, no DB, no fetch.

export const ADMIN_VIDEO_COLUMNS = [
  'sha256',
  'action',
  'provider',
  'scores',
  'categories',
  'moderated_at',
  'reviewed_by',
  'reviewed_at',
  'uploaded_by',
  'event_id',
  'title',
  'author',
  'content_url',
  'published_at'
];

function safeParseJSON(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function buildAdminVideoFromRow(row, { cdnDomain }) {
  const eventId = row.event_id || null;
  const publishedAt = row.published_at ? Number.parseInt(row.published_at, 10) : null;
  const hasContext = Boolean(
    row.title || row.author || row.content_url || eventId || row.uploaded_by || publishedAt
  );

  return {
    sha256: row.sha256,
    action: row.action,
    provider: row.provider || null,
    scores: safeParseJSON(row.scores, {}),
    categories: safeParseJSON(row.categories, []),
    processedAt: row.moderated_at ? new Date(row.moderated_at).getTime() : null,
    moderated_at: row.moderated_at,
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    uploaded_by: row.uploaded_by || null,
    eventId,
    divineUrl: eventId ? `https://divine.video/video/${encodeURIComponent(eventId)}` : null,
    cdnUrl: `https://${cdnDomain}/${row.sha256}`,
    nostrContext: hasContext ? {
      title: row.title || null,
      author: row.author || null,
      // client/content are not stored. List view leaves them null;
      // detail view (/admin/api/video/:id) still fills them via funnelcake.
      client: null,
      content: null,
      url: row.content_url || null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      pubkey: row.uploaded_by ? `${row.uploaded_by.substring(0, 16)}...` : null,
      eventId,
      platform: null
    } : null
  };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npm test -- src/admin/lookup-helpers.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```
git add src/admin/lookup-helpers.mjs src/admin/lookup-helpers.test.mjs
git commit -m "refactor: extract buildAdminVideoFromRow into pure helper

Pure row→admin-video mapper that the new /admin/api/videos handler
will use directly, replacing the per-row getAdminLookupVideo +
funnelcake fetch fan-out."
```

### Task 2.2: Add a fan-out test that pins current behavior on a fully-populated row

Why: prove there are zero funnelcake calls when the row already has `event_id`, and snapshot the JSON shape so any field regression fails loudly.

**Files:**
- Create: `src/admin/dashboard-fanout.test.mjs`

- [ ] **Step 1: Write the failing test**

**Note on the testing approach.** Spying on `globalThis.fetch` under
`@cloudflare/vitest-pool-workers` is unreliable — the worker module
captures its `fetch` reference at module-eval time inside the isolate.
Instead, we prove "no fan-out" **structurally** by counting calls to
`env.BLOSSOM_DB.prepare`. The new code calls it exactly twice (list +
uploader_enforcement IN); the old code called it ~50+ times. We also
intercept funnelcake by having the test set the legacy fallthrough
trigger off — i.e., every seeded row has `event_id` populated. If the
production code accidentally still calls funnelcake we observe it via
a wrapper around `fetchFunnelcakeLookupVideo` (Task 2.3 step 0 below
exports a hook for this).

```js
// src/admin/dashboard-fanout.test.mjs
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../index.mjs';
import { env } from 'cloudflare:test';

// IMPORTANT: do NOT include lookup_attempted_at — that column ships in
// PR1's migration; PR2's test environment may not have it.
const ROW = {
  sha256: 'a'.repeat(64),
  action: 'REVIEW',
  provider: 'manual-review',
  scores: '{"nsfw":0.2}',
  categories: '["nsfw"]',
  raw_response: null,
  moderated_at: '2026-05-05T00:00:00Z',
  reviewed_by: null,
  reviewed_at: null,
  review_notes: null,
  published_label_id: null,
  uploaded_by: 'b'.repeat(64),
  title: 'Test',
  author: 'Alice',
  event_id: 'c'.repeat(64),
  content_url: 'https://example.com/v.mp4',
  published_at: '1717200000',
  videoseal: null,
  transcript_pending: 0,
  transcript_pending_since: null,
  transcript_last_checked_at: null,
  transcript_resolved_at: null
};

describe('/admin/api/videos fan-out', () => {
  let prepareSpy;
  beforeEach(async () => {
    prepareSpy = vi.spyOn(env.BLOSSOM_DB, 'prepare');
    await env.BLOSSOM_DB.prepare(
      `INSERT OR REPLACE INTO moderation_results (${Object.keys(ROW).join(',')}) VALUES (${Object.keys(ROW).map(() => '?').join(',')})`
    ).bind(...Object.values(ROW)).run();
    prepareSpy.mockClear(); // ignore the seeding call
  });
  afterEach(async () => {
    prepareSpy.mockRestore();
    await env.BLOSSOM_DB.prepare('DELETE FROM moderation_results WHERE sha256=?').bind(ROW.sha256).run();
  });

  it('issues at most 2 D1 prepare calls (list + uploader_enforcement)', async () => {
    const req = new Request('https://moderation.admin.divine.video/admin/api/videos?limit=50', {
      headers: { 'CF-Access-Authenticated-User-Email': 'test@divine.video' }
    });
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.videos.length).toBeGreaterThan(0);
    // Exactly: 1 list query + 1 uploader_enforcement IN query.
    // Anything more = fan-out has been reintroduced.
    expect(prepareSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('preserves the response shape (golden snapshot)', async () => {
    const req = new Request('https://moderation.admin.divine.video/admin/api/videos?limit=50', {
      headers: { 'CF-Access-Authenticated-User-Email': 'test@divine.video' }
    });
    const res = await worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
    const body = await res.json();
    const v = body.videos.find((row) => row.sha256 === ROW.sha256);
    // All keys expected on the response, including uploaderEnforcement
    // attached by the batch query.
    expect(Object.keys(v).sort()).toEqual([
      'action', 'categories', 'cdnUrl', 'divineUrl', 'eventId',
      'moderated_at', 'nostrContext', 'processedAt', 'provider',
      'reviewed_at', 'reviewed_by', 'scores', 'sha256', 'uploaded_by',
      'uploaderEnforcement'
    ]);
    expect(v.eventId).toBe(ROW.event_id);
    expect(v.divineUrl).toBe(`https://divine.video/video/${ROW.event_id}`);
    expect(v.nostrContext).toMatchObject({
      title: 'Test',
      author: 'Alice',
      client: null,
      content: null,
      url: ROW.content_url,
      eventId: ROW.event_id,
      platform: null
    });
    expect(typeof v.nostrContext.publishedAt).toBe('number');
    expect(v.uploaderEnforcement).toMatchObject({
      pubkey: ROW.uploaded_by
    });
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test -- src/admin/dashboard-fanout.test.mjs`
Expected: FAIL — funnelcake fetch happens (`funnelcakeCalls.length` > 0) and snapshot keys are wrong.

(Auth is bypassed by the test harness when `CF-Access-Authenticated-User-Email` is set; if the codebase uses different test auth, mirror an existing test in `src/admin/auth.test.mjs`.)

### Task 2.3: Wire the helper into `/admin/api/videos`

**Files:**
- Modify: `src/index.mjs` lines 1469-1570

- [ ] **Step 1: Replace the SELECT and the per-row fan-out**

Find the block at `src/index.mjs:1469-1570`. Replace the SELECT column list at line 1511 and the `Promise.all(videoRows.map(...))` block at lines 1539-1558 with:

```js
// at top of file, near existing imports
import { ADMIN_VIDEO_COLUMNS, buildAdminVideoFromRow } from './admin/lookup-helpers.mjs';
```

```js
// inside the /admin/api/videos handler, replacing the existing query:
const query = `
  SELECT ${ADMIN_VIDEO_COLUMNS.join(', ')}
  FROM moderation_results
  ${whereClause}
  ORDER BY moderated_at ${orderDirection}
  LIMIT ? OFFSET ?
`;
params.push(limit + 1, offset);

const result = await env.BLOSSOM_DB.prepare(query).bind(...params).all();
const rows = result.results || [];
const hasMore = rows.length > limit;
const pageRows = rows.slice(0, limit);

// Build videos directly from rows. No second D1 read, no funnelcake fetch.
const videos = pageRows.map((row) => buildAdminVideoFromRow(row, {
  cdnDomain: env.CDN_DOMAIN || 'media.divine.video'
}));

// Batch uploader_enforcement: one query for all unique uploaded_by values.
const uploaderPubkeys = [...new Set(videos.map((v) => v.uploaded_by).filter(Boolean))];
if (uploaderPubkeys.length > 0) {
  const placeholders = uploaderPubkeys.map(() => '?').join(',');
  const enf = await env.BLOSSOM_DB.prepare(
    `SELECT pubkey, approval_required, relay_banned FROM uploader_enforcement WHERE pubkey IN (${placeholders})`
  ).bind(...uploaderPubkeys).all();
  const map = new Map((enf.results || []).map((r) => [r.pubkey, r]));
  for (const v of videos) {
    if (v.uploaded_by) {
      v.uploaderEnforcement = map.get(v.uploaded_by) || {
        pubkey: v.uploaded_by,
        approval_required: 0,
        relay_banned: 0
      };
    }
  }
}

console.log(`[${requestId}] Returning ${videos.length} videos in ${Date.now() - startTime}ms`);
return new Response(JSON.stringify({
  videos,
  offset,
  limit,
  hasMore,
  nextOffset: hasMore ? offset + limit : null
}), { headers: JSON_HEADERS });
```

(Drop the `await Promise.all(videoRows.map(...))` block entirely. The legacy fallthrough — fetching funnelcake when `event_id IS NULL` — does NOT happen on the list endpoint anymore. After PR5's backfill, ~0% of rows lack event_id; until then, those rows render with `eventId: null` on cards but the detail-view link still works because the dashboard falls back to `sha256`-based lookups.)

- [ ] **Step 2: Run the fan-out test**

Run: `npm test -- src/admin/dashboard-fanout.test.mjs`
Expected: both tests pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 305+ tests pass (303 existing + 3 new from Task 2.1 + 2 new from Task 2.2). No regressions.

### Task 2.4: Widen the SELECTs in `getAdminLookupVideo` and `/api/v1/decisions`

These power the manual-lookup ("Open Video") field and the public API.

**Files:**
- Modify: `src/index.mjs:992-996` (getAdminLookupVideo)
- Modify: `src/index.mjs:3939-3989` (/api/v1/decisions)

- [ ] **Step 1: getAdminLookupVideo — widen the SELECT**

Replace the SELECT at `src/index.mjs:992-996`:
```js
const moderatedRow = await env.BLOSSOM_DB.prepare(`
  SELECT ${ADMIN_VIDEO_COLUMNS.join(', ')}, raw_response, review_notes, videoseal
  FROM moderation_results
  WHERE sha256 = ?
`).bind(hash).first();
```

This keeps the manual-lookup detail-view path consistent with the list path. `enrichAdminLookupVideo` still runs here (one row, one funnelcake call max) — by design, the detail view fills `nostrContext.client/content`.

- [ ] **Step 2: /api/v1/decisions — widen the SELECT**

Replace the SELECT at line 3951:
```js
let query = `SELECT ${ADMIN_VIDEO_COLUMNS.join(', ')} FROM moderation_results`;
```

Public response shape only gains fields; downstream consumers tolerating additive change keep working.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```
git add src/index.mjs src/admin/dashboard-fanout.test.mjs
git commit -m "perf: kill per-row funnelcake fan-out in /admin/api/videos

- Widen SELECT to include event_id/title/author/content_url/published_at
  (columns added by migration 004 but never selected here).
- Replace 50× getAdminLookupVideo + funnelcake fetch with a synchronous
  buildAdminVideoFromRow mapper.
- Batch uploader_enforcement into one IN(?,?,...) query.
- Detail view (/admin/api/video/:id) still calls funnelcake on demand,
  so client/content fields keep rendering for opened videos.

Per-page round-trips drop from ~150-250 to ~3."
```

- [ ] **Step 5: Open PR2**

`gh pr create` with the spec link and a curl-timing before/after.

---

## Chunk 3: PR3 — KV cache for stats

Target: `/admin/api/stats` from 200-500ms to <50ms (cached).

### Task 3.1: Build the `cachedStat` helper

**Files:**
- Create: `src/admin/cache.mjs`
- Create: `src/admin/cache.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// src/admin/cache.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { cachedStat } from './cache.mjs';
import { env } from 'cloudflare:test';

const KEY = 'stats:v1:test';

describe('cachedStat', () => {
  it('computes on miss and writes to KV via waitUntil', async () => {
    await env.MODERATION_KV.delete(KEY);
    const compute = vi.fn().mockResolvedValue({ ok: 1 });
    const waitUntil = vi.fn();
    const result = await cachedStat(env, { waitUntil }, 'test', 60, compute);
    expect(result).toEqual({ ok: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The waitUntil callback writes to KV.
    await waitUntil.mock.calls[0][0];
    const cached = JSON.parse(await env.MODERATION_KV.get(KEY));
    expect(cached).toEqual({ ok: 1 });
  });

  it('returns cached value on hit without calling compute', async () => {
    await env.MODERATION_KV.put(KEY, JSON.stringify({ ok: 99 }));
    const compute = vi.fn();
    const result = await cachedStat(env, { waitUntil: () => {} }, 'test', 60, compute);
    expect(result).toEqual({ ok: 99 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('bypasses cache read when fresh=true but still writes back', async () => {
    await env.MODERATION_KV.put(KEY, JSON.stringify({ ok: 'stale' }));
    const compute = vi.fn().mockResolvedValue({ ok: 'fresh' });
    const waitUntil = vi.fn();
    const result = await cachedStat(env, { waitUntil }, 'test', 60, compute, { fresh: true });
    expect(result).toEqual({ ok: 'fresh' });
    expect(compute).toHaveBeenCalled();
    await waitUntil.mock.calls[0][0];
    const cached = JSON.parse(await env.MODERATION_KV.get(KEY));
    expect(cached).toEqual({ ok: 'fresh' });
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npm test -- src/admin/cache.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/admin/cache.mjs
// ABOUTME: Tiny KV wrapper for caching stat aggregates with non-blocking writes.

export async function cachedStat(env, ctx, key, ttlSeconds, compute, options = {}) {
  const fullKey = `stats:v1:${key}`;
  if (!options.fresh) {
    const cached = await env.MODERATION_KV.get(fullKey);
    if (cached !== null) {
      try { return JSON.parse(cached); } catch { /* fall through to compute */ }
    }
  }
  const fresh = await compute();
  // Don't block the response on the KV write.
  ctx.waitUntil(env.MODERATION_KV.put(
    fullKey,
    JSON.stringify(fresh),
    { expirationTtl: ttlSeconds }
  ));
  return fresh;
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `npm test -- src/admin/cache.test.mjs`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```
git add src/admin/cache.mjs src/admin/cache.test.mjs
git commit -m "feat: add cachedStat helper for KV-cached aggregates"
```

### Task 3.2: Wrap `/admin/api/stats` and `/admin/api/ai-detection/stats`

**Files:**
- Modify: `src/index.mjs:1573-1677` (stats handler)
- Modify: `src/index.mjs:1680-1707` (ai-detection-stats handler)

- [ ] **Step 1: Add import**

```js
import { cachedStat } from './admin/cache.mjs';
```

- [ ] **Step 2: Wrap stats endpoint**

Inside the `/admin/api/stats` handler at `src/index.mjs:1573-1677`, after
the auth check and `console.log` line, replace the entire `try { … }
catch { … }` body with the version below. The closure must reproduce
the **exact** response shape the dashboard expects (verified at
`dashboard.html:2643-2649`): `totalInD1`, `totalModerated`, `untriaged`,
`pendingFlagged`, plus `breakdown.{safe,review,ageRestricted,permanentBan}`
and `pending.{review,quarantine,ageRestricted,permanentBan}`.

```js
try {
  const fresh = url.searchParams.get('fresh') === '1';
  const stats = await cachedStat(env, ctx, 'admin-stats', 60, async () => {
    const [totalResult, moderationStats, pendingStats] = await Promise.all([
      env.BLOSSOM_DB.prepare(`
        SELECT COUNT(DISTINCT sha256) as total
        FROM bunny_webhook_events
        WHERE sha256 IS NOT NULL AND status_name NOT IN ('error', 'deleted')
      `).first(),
      env.BLOSSOM_DB.prepare(`
        SELECT action, COUNT(*) as count FROM moderation_results GROUP BY action
      `).all(),
      env.BLOSSOM_DB.prepare(`
        SELECT action, COUNT(*) as count FROM moderation_results
        WHERE reviewed_by IS NULL GROUP BY action
      `).all()
    ]);

    const totalInD1 = totalResult?.total || 0;
    const breakdown = { safe: 0, review: 0, ageRestricted: 0, permanentBan: 0 };
    let totalModerated = 0;
    for (const row of (moderationStats?.results || [])) {
      const count = row.count || 0;
      totalModerated += count;
      if (row.action === 'SAFE') breakdown.safe = count;
      else if (row.action === 'REVIEW') breakdown.review = count;
      else if (row.action === 'AGE_RESTRICTED') breakdown.ageRestricted = count;
      else if (row.action === 'PERMANENT_BAN') breakdown.permanentBan = count;
    }

    const pending = { review: 0, quarantine: 0, ageRestricted: 0, permanentBan: 0 };
    for (const row of (pendingStats?.results || [])) {
      const count = row.count || 0;
      if (row.action === 'REVIEW') pending.review = count;
      else if (row.action === 'QUARANTINE') pending.quarantine = count;
      else if (row.action === 'AGE_RESTRICTED') pending.ageRestricted = count;
      else if (row.action === 'PERMANENT_BAN') pending.permanentBan = count;
    }

    const pendingFlagged = pending.review + pending.quarantine + pending.ageRestricted + pending.permanentBan;
    const untriaged = Math.max(0, totalInD1 - totalModerated);

    return { totalInD1, totalModerated, untriaged, pendingFlagged, breakdown, pending };
  }, { fresh });

  return new Response(JSON.stringify(stats), { headers: JSON_HEADERS });
} catch (error) {
  console.error(`[${requestId}] Failed to get stats:`, error);
  return new Response(JSON.stringify({ error: error.message }), {
    status: 500, headers: { 'Content-Type': 'application/json' }
  });
}
```

The handler signature is `async fetch(request, env, ctx)` so `ctx` is in scope.

- [ ] **Step 3: Wrap ai-detection-stats endpoint**

Same shape, key `ai-detection-stats:${windowValue}`.

- [ ] **Step 4: Add Refresh button → ?fresh=1**

In `src/admin/dashboard.html`:
- Find `loadRealStats` (line 2633).
- Change `fetch('/admin/api/stats')` to `fetch('/admin/api/stats' + (forceFresh ? '?fresh=1' : ''))`, where `forceFresh` is a parameter.
- Find the existing Refresh button (`onclick="loadVideos()"` at line 2075). Add a sibling that calls `loadRealStats(true)`.

(If a single Refresh button is preferred, have `loadVideos()` also call `loadRealStats(true)`.)

- [ ] **Step 5: Add a stats integration test**

Create `src/admin/stats-cache.test.mjs` with two cases: cold call hits D1 once, warm call within 60s reads only KV (assert no `BLOSSOM_DB.prepare` call via spy).

- [ ] **Step 6: Run full suite + commit**

Run: `npm test`
Commit:
```
perf: cache /admin/api/stats and /admin/api/ai-detection/stats in KV (60s)

Aggregations on the 322k-row moderation_results table no longer fire
on every dashboard mount. Refresh button passes ?fresh=1 to bypass.
```

### Task 3.3: Cache `/admin/api/untriaged` COUNT and `/api/v1/decisions` COUNT

Same wrapper, smaller keys.

- [ ] **Step 1**: In `/admin/api/untriaged` (line 1793-1803), wrap the COUNT in `cachedStat(env, ctx, 'untriaged-total', 60, compute)`.
- [ ] **Step 2**: In `/api/v1/decisions` (line 3974-3979), wrap the COUNT in `cachedStat(env, ctx, 'decisions-count:' + filterKey, 60, compute)`.
- [ ] **Step 3**: Run `npm test`. Commit.

### Task 3.4: Open PR3

`gh pr create`. Wait for deploy and verify.

---

## Chunk 4: PR4 — Untriaged endpoint cleanup

Target: `/admin/api/untriaged?limit=50` from 1-3s to <300ms.

### Task 4.1: Extract `latestBunnyEventBySha` helper

**Files:**
- Create: `src/admin/bunny-events.mjs`
- Create: `src/admin/bunny-events.test.mjs`

- [ ] **Step 1: Write the failing test**

Test cases:
- Single sha with multiple events → returns only the latest by `received_at`.
- Limit/offset pagination over the latest-per-sha view.
- COUNT helper returns same total.
- `EXPLAIN QUERY PLAN` (run once via `wrangler d1 execute` in a release-checklist script, NOT vitest) does not show `CORRELATED` and does show `idx_bunny_events_sha256_received`.

- [ ] **Step 2: Implement**

Use `ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC)`.
**Do NOT use `GROUP BY sha256 HAVING received_at = MAX(received_at)`** —
SQLite's "bare column" rule only picks the MAX row's columns when the
MAX aggregate appears in the SELECT list. With MAX only in HAVING,
the non-aggregated columns (`hls_url`, `mp4_url`, etc.) come from an
arbitrary row in the group. Window-function form is deterministic and
uses `idx_bunny_events_sha256_received` for the partition order.

```js
// src/admin/bunny-events.mjs
export async function latestBunnyEventBySha(env, { limit = 50, offset = 0, excludeStatusNames = ['error', 'deleted'] } = {}) {
  const placeholders = excludeStatusNames.map(() => '?').join(',');
  const sql = `
    WITH ranked AS (
      SELECT
        sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name,
        ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC) AS rn
      FROM bunny_webhook_events
      WHERE sha256 IS NOT NULL
        AND status_name NOT IN (${placeholders})
    )
    SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name
    FROM ranked
    WHERE rn = 1
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `;
  const result = await env.BLOSSOM_DB.prepare(sql)
    .bind(...excludeStatusNames, limit, offset)
    .all();
  return result.results || [];
}

export async function countLatestBunnyEvents(env, { excludeStatusNames = ['error', 'deleted'] } = {}) {
  const placeholders = excludeStatusNames.map(() => '?').join(',');
  const sql = `
    SELECT COUNT(DISTINCT sha256) AS total
    FROM bunny_webhook_events
    WHERE sha256 IS NOT NULL
      AND status_name NOT IN (${placeholders})
  `;
  const row = await env.BLOSSOM_DB.prepare(sql).bind(...excludeStatusNames).first();
  return row?.total || 0;
}

export async function latestBunnyEventForSha(env, sha256) {
  const row = await env.BLOSSOM_DB.prepare(`
    SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name
    FROM bunny_webhook_events
    WHERE sha256 = ?
    ORDER BY received_at DESC
    LIMIT 1
  `).bind(sha256).first();
  return row || null;
}
```

After implementing, add a test that seeds two events for the same sha
with different `hls_url` values, then asserts the helper returns the
URL from the row with the larger `received_at`. This is the test that
fails on the GROUP BY HAVING variant.

- [ ] **Step 3: Run tests, confirm pass.**

- [ ] **Step 4: Commit**

```
refactor: extract latestBunnyEventBySha helper, drop correlated subquery

Replaces four hand-rolled copies of the latest-event-per-sha lookup
(src/index.mjs:1036, 1149, 1707, 1779) with a single helper that uses
ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC),
backed by idx_bunny_events_sha256_received added in PR1.
```

### Task 4.2: Replace the four call sites

- [ ] **Step 1**: `src/index.mjs:685-693` (transcript reprocess area, only if it uses the same pattern — re-verify; if not, leave it).
- [ ] **Step 2**: `src/index.mjs:1031-1039` (getAdminLookupVideo) → `latestBunnyEventForSha(env, hash)`.
- [ ] **Step 3**: `src/index.mjs:1138-` (getStoredAdminPlaybackCandidates) → `latestBunnyEventForSha(env, sha256)` for the second branch.
- [ ] **Step 4**: `src/index.mjs:1707-1732` (untriaged list) → `latestBunnyEventBySha(env, { limit, offset })`.
- [ ] **Step 5**: `src/index.mjs:1779-1803` (untriaged count) → wrap `countLatestBunnyEvents(env)` in `cachedStat`.

After each, run `npm test`. Commit each in its own atomic patch (small diffs).

### Task 4.3: Parallelize the KV reads in untriaged

- [ ] **Step 1**: At `src/index.mjs:1736-1741`, replace:
```js
for (const row of result.results) {
  const existingResult = await env.MODERATION_KV.get(`moderation:${row.sha256}`);
  if (!existingResult) unmoderatedRows.push(row);
}
```
with:
```js
const moderationFlags = await Promise.all(
  result.results.map((row) => env.MODERATION_KV.get(`moderation:${row.sha256}`))
);
const unmoderatedRows = result.results.filter((_, i) => !moderationFlags[i]);
```

### Task 4.4: Cache the per-row Nostr fetch

- [ ] **Step 1**: Wrap `fetchNostrEventBySha256` in untriaged with KV cache:

```js
async function cachedNostrEvent(env, sha256, relays) {
  const key = `nostr:event:${sha256}`;
  const cached = await env.MODERATION_KV.get(key);
  if (cached) return JSON.parse(cached);
  const event = await fetchNostrEventBySha256(sha256, relays, env);
  if (event) {
    // 1-hour TTL; events for unmoderated content rarely change.
    await env.MODERATION_KV.put(key, JSON.stringify(event), { expirationTtl: 3600 });
  }
  return event;
}
```

Use it in the `nostrPromises.map` at `src/index.mjs:1745-1763`.

### Task 4.5: Tests + commit + PR

- [ ] Run `npm test`. Add `src/admin/untriaged-query.test.mjs` with a golden fixture: seed 3 sha256 with 5 events each, assert latest-per-sha returns 3 rows in correct order.
- [ ] Run `node scripts/verify-query-plans.mjs` adapted to include the new `latestBunnyEventBySha` query.
- [ ] Commit and open PR4.

---

## Chunk 5: PR5 — Backfill cron for legacy rows

Behind feature flag `BACKFILL_ENABLED`. Defaults to off.

### Task 5.1: Build `backfillLookupColumns`

**Files:**
- Create: `src/admin/backfill-lookup-columns.mjs`
- Create: `src/admin/backfill-lookup-columns.test.mjs`

- [ ] **Step 1: Write failing tests**

Test cases:
1. Picks rows with `event_id IS NULL`, ordered by `moderated_at DESC`, limit honored.
2. On hit, UPDATE sets event_id/title/author/content_url/published_at + lookup_attempted_at; row with non-null event_id is not touched.
3. On 404, sets `lookup_attempted_at` only.
4. On HTTP error, no DB write.
5. Concurrency cap respected (mock `fetch` to track in-flight count).
6. Mutex: two concurrent `runBackfill` calls — one runs, one returns `{ skipped: 'locked' }`. Each row processed at most once.
7. Mutex auto-releases after TTL (use a fake clock or `expirationTtl` mock).

- [ ] **Step 2: Implement**

The backfill takes `fetchLookup` as a dependency-injected function. In
production it's `fetchFunnelcakeLookupVideo` (which already wraps the
HTTP call + `buildFunnelcakeVideoLookup` parse). In tests it's a stub.
This avoids re-implementing the funnelcake response parser and keeps
the test mock unambiguous (no `vi.spyOn(globalThis, 'fetch')` games).

`fetchFunnelcakeLookupVideo` returns either:
- `null` on 404 (treat as "missing")
- A parsed object: `{ eventId, videoUrl, uploadedBy, createdAt, nostrContext: { title, author, publishedAt, url, ... }, ... }` (see `src/index.mjs:212-249`)
- Or throws on non-2xx HTTP

```js
// src/admin/backfill-lookup-columns.mjs
// ABOUTME: Cron worker that fills event_id/title/author/content_url/published_at
// on legacy moderation_results rows by calling the funnelcake video API.

const LOCK_KEY = 'backfill:lock';
const LOCK_TTL_S = 300;

export async function runBackfill(env, options = {}) {
  const {
    limit,
    concurrency = 10,
    fetchLookup,                              // REQUIRED: (sha256) => Promise<lookup|null>
    now = () => new Date().toISOString()
  } = options;

  if (typeof fetchLookup !== 'function') {
    throw new Error('runBackfill: fetchLookup is required');
  }
  if (env.BACKFILL_ENABLED !== 'true') return { skipped: 'disabled' };

  const lock = await env.MODERATION_KV.get(LOCK_KEY);
  if (lock) return { skipped: 'locked' };
  await env.MODERATION_KV.put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL_S });

  try {
    const rowsLimit = Math.max(1, Math.min(limit ?? Number(env.BACKFILL_ROWS_PER_TICK ?? '200'), 500));
    const retryAfter = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const rows = (await env.BLOSSOM_DB.prepare(`
      SELECT sha256
      FROM moderation_results
      WHERE event_id IS NULL
        AND (lookup_attempted_at IS NULL OR lookup_attempted_at < ?)
      ORDER BY moderated_at DESC
      LIMIT ?
    `).bind(retryAfter, rowsLimit).all()).results || [];

    let updated = 0, missing = 0, errored = 0;

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
          // 404 — record the attempt so we don't re-poll for 7 days.
          await env.BLOSSOM_DB.prepare(
            `UPDATE moderation_results SET lookup_attempted_at = ? WHERE sha256 = ? AND event_id IS NULL`
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
           WHERE sha256 = ? AND event_id IS NULL`
        ).bind(
          lookup.eventId || null,
          ctx.title || null,
          ctx.author || null,
          lookup.videoUrl || ctx.url || null,
          ctx.publishedAt != null ? String(ctx.publishedAt) : null,
          attemptedAt,
          row.sha256
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
```

- [ ] **Step 3: Run tests, confirm pass.**

### Task 5.2: Wire into the every-minute cron

**Files:**
- Modify: `src/index.mjs:4601-4622` (scheduled handler)

- [ ] **Step 1**: After the `creator-delete` block at 4604-4621, add:

```js
// Backfill legacy moderation_results lookup columns. Gated by BACKFILL_ENABLED.
try {
  const result = await runBackfill(env, {
    fetchLookup: (sha256) => fetchFunnelcakeLookupVideo(sha256)
  });
  if (!result.skipped) {
    console.log(`[BACKFILL] picked=${result.picked} updated=${result.updated} missing=${result.missing} errored=${result.errored}`);
  }
} catch (e) {
  console.error('[BACKFILL] failed:', e);
}
```

Add the import at the top of the file:
```js
import { runBackfill } from './admin/backfill-lookup-columns.mjs';
```

`fetchFunnelcakeLookupVideo` is already in scope at module level (defined at `src/index.mjs:305`).

### Task 5.3: Manual trigger endpoint

- [ ] **Step 1**: Add to `src/index.mjs` near other admin endpoints:

```js
if (url.pathname === '/admin/api/backfill/run' && request.method === 'POST') {
  const authError = await requireAuth(request, env);
  if (authError) return authError;
  const count = Math.min(Number(url.searchParams.get('count') || '200'), 500);
  const result = await runBackfill(env, {
    limit: count,
    fetchLookup: (sha256) => fetchFunnelcakeLookupVideo(sha256)
  });
  return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
}
```

### Task 5.4: Update `wrangler.toml`

- [ ] **Step 1**: Add to `[vars]`:
```
BACKFILL_ENABLED = "false"  # flip to "true" via secret/var to start the backfill
BACKFILL_ROWS_PER_TICK = "200"
```

(Cron is already wired at `* * * * *`, no change needed.)

### Task 5.5: Tests + commit + PR

- [ ] **Step 1**: Run `npm test`.
- [ ] **Step 2**: Commit:

```
feat: backfill cron for legacy moderation_results lookup columns

Populates event_id/title/author/content_url/published_at on rows
predating migration 004's storage of those columns. Idempotent,
rate-limited (200/min default), KV-mutex protected against
overlapping cron + manual-trigger runs. Off by default behind
BACKFILL_ENABLED=true.

After full backfill (~26h at default rate), the funnelcake fallback
in /admin/api/video/:id and getAdminLookupVideo becomes near-zero
on legacy data.
```

- [ ] **Step 3**: Open PR5.

### Task 5.6: Production verification

- [ ] **Step 1**: After PR5 merges, manually trigger a 100-row batch:

`curl -X POST -H "Cookie: ..." 'https://moderation.admin.divine.video/admin/api/backfill/run?count=100'`

Expected: `{ picked: 100, updated: <up_to_100>, missing: ..., errored: 0 }`.

- [ ] **Step 2**: Inspect the rows updated:

```
wrangler d1 execute blossom-webhook-events --remote --command \
  "SELECT COUNT(*) FROM moderation_results WHERE event_id IS NULL"
```

Should drop by `updated` from the previous count.

- [ ] **Step 3**: Flip `BACKFILL_ENABLED=true`:

`wrangler secret put BACKFILL_ENABLED` (set to `true`) — or update `[vars]` and redeploy.

- [ ] **Step 4**: Monitor over 24h with the same `COUNT(*)` query. Expect ~12k/hr decrease.

---

## Final acceptance

- [ ] All five PRs merged and deployed.
- [ ] `curl -w '%{time_total}'` against `/admin/api/videos?limit=50` returns < 0.3s (warm).
- [ ] `curl -w '%{time_total}'` against `/admin/api/stats` returns < 0.1s (cached).
- [ ] `curl -w '%{time_total}'` against `/admin/api/untriaged?limit=50` returns < 0.4s (warm).
- [ ] Manual dashboard load (cleared cache, fresh tab): first paint < 1.5s, full grid < 2s.
- [ ] `SELECT COUNT(*) FROM moderation_results WHERE event_id IS NULL` trends to near 0 over 24-48h after backfill is enabled.
- [ ] No regression in the 303-test baseline; new tests added (~12-15 additional).
- [ ] Moderators stop complaining.
