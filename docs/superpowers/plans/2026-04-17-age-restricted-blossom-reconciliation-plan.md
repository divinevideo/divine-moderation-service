# Age-Restricted Blossom Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the large population of publicly `404`ing blobs whose moderation source of truth is `AGE_RESTRICTED`, while avoiding accidental rewrites of intentionally `Deleted`, missing, or otherwise non-repairable Blossom states.

**Architecture:** Use a two-phase, read-then-repair reconciler in `divine-moderation-service`. Preview pages through D1 rows where `moderation_results.action = 'AGE_RESTRICTED'`, inspects current Blossom state via Blossom’s authenticated `GET /admin/api/blob/{hash}` detail endpoint, and classifies each SHA before any mutation. Apply accepts an explicit SHA list, revalidates each SHA against Blossom immediately before writing, and only replays rows whose live Blossom status is still `restricted`. This avoids the unsafe blanket rewrite problem in Blossom’s KV backfill script and prevents replaying over `Deleted` or otherwise changed states.

**Tech Stack:** Cloudflare Workers (`src/index.mjs`), D1 (`moderation_results`), existing Blossom webhook integration (`notifyBlossom`), Blossom admin detail endpoint (`/admin/api/blob/{hash}`), Vitest (`src/index.test.mjs`), operator verification via `curl`, `wrangler tail`, and public `HEAD` checks against `media.divine.video`.

---

## Scope and Constraints

- Source of truth for intended age-gating is `moderation_results.action = 'AGE_RESTRICTED'` in this repo.
- Current Blossom state must be read before any repair decision.
- Only blobs whose live Blossom status is `restricted` are repairable by this reconciler.
- `deleted`, missing, unreadable, and unexpected Blossom states must be classified and skipped, not rewritten.
- Apply must accept explicit SHA lists and revalidate state before writing.
- Failures must be durable and exact: every failed SHA must be returned to the caller and logged.
- Do **not** use Blossom’s `scripts/backfill_restricted_to_age_restricted.py` as a global fix. The dry-run showed the eligible `restricted` population spread across thousands of owners, so global KV reinterpretation is unsafe.

### Known Hazards

- **Blossom Simple Cache staleness (≤5 min).** `get_blob_metadata` in `divine-blossom/src/metadata.rs` reads Simple Cache first. Both preview and apply-time revalidation see cached values up to 5 minutes old. Consequences:
  - Preview may overcount `repairable_mismatch` if moderation just flipped the blob.
  - Apply may fire a redundant `notifyBlossom` (benign — webhook is idempotent).
  - Apply may replay `AGE_RESTRICTED` over a blob that was admin-deleted in the last 5 minutes (direct Blossom admin delete does not touch D1). **This is the only write-over-intent hazard.**
  - Mitigation: operator must not run apply within 5 minutes of a direct Blossom admin state change; if needed, prefer adding an uncached variant (e.g. `GET /admin/api/blob/{hash}?cache=bypass`) to Blossom as a follow-up. This plan does NOT assume uncached reads exist.
- **Cloudflare Workers subrequest limit.** Default tier caps at 50 subrequests per request (1000 on paid). Limits in this plan are sized for the paid tier: preview default `50` / max `100`, apply max `100`. A single apply batch of `100` costs up to 200 subrequests (one read + one notify per SHA).
- **D1 drift on skips.** When preview classifies a row as `skip_deleted` / `skip_missing` / `unexpected_state`, the D1 `moderation_results.action` still reads `AGE_RESTRICTED`. Every future reconcile run will re-page and re-fetch those same SHAs. This plan accepts that cost; a later cleanup can record the skip reason back into D1 if the skip set grows large.

## Existing System References

- Moderation truth lives in `moderation_results` in `src/index.mjs`.
- Existing moderation writes D1/KV first, then calls Blossom via `notifyBlossom()`, which is the current split-brain source:
  - admin path: [src/index.mjs](/Users/rabble/code/divine/divine-moderation-service/src/index.mjs:1579), [src/index.mjs](/Users/rabble/code/divine/divine-moderation-service/src/index.mjs:1643)
  - API path: [src/index.mjs](/Users/rabble/code/divine/divine-moderation-service/src/index.mjs:3045), [src/index.mjs](/Users/rabble/code/divine/divine-moderation-service/src/index.mjs:3067)
- Blossom read path for current blob status:
  - `GET /admin/api/blob/{hash}` in [admin.rs](/Users/rabble/code/divine/divine-blossom/src/admin.rs:759)
- Blossom write path for moderation actions:
  - moderation webhook maps `AGE_RESTRICTED -> AgeRestricted` and `RESTRICT|QUARANTINE -> Restricted` in [main.rs](/Users/rabble/code/divine/divine-blossom/src/main.rs:4659)
- Blossom soft-delete/restore semantics that must not be overridden blindly:
  - [delete_policy.rs](/Users/rabble/code/divine/divine-blossom/src/delete_policy.rs:39)
  - [delete_policy.rs](/Users/rabble/code/divine/divine-blossom/src/delete_policy.rs:66)

## File Structure

**Modify:**
- `src/index.mjs`
  Adds preview/apply admin endpoints, Blossom inspection wiring, and structured reconciliation logging.
- `src/index.test.mjs`
  Adds regression coverage for Blossom-state classification, preview/apply routes, revalidation behavior, and failure handling.
- `docs/superpowers/plans/2026-04-17-age-restricted-blossom-reconciliation-plan.md`
  This implementation plan.

**Create:**
- `src/moderation/age-restricted-reconcile.mjs`
  Focused helper module for candidate selection, Blossom status inspection, mismatch classification, preview shaping, and safe apply semantics.

**Optional follow-up:**
- `scripts/reconcile-age-restricted-sample.sh`
  Thin operator wrapper for sample preview/apply calls and public `HEAD` verification.

---

## Classification Model

Every previewed SHA must be placed into exactly one bucket:

- `aligned`
  D1 says `AGE_RESTRICTED`, Blossom says `age_restricted`
- `repairable_mismatch`
  D1 says `AGE_RESTRICTED`, Blossom says `restricted`
- `skip_deleted`
  Blossom says `deleted`
- `skip_missing`
  Blossom detail endpoint returns `404` / no metadata
- `unexpected_state`
  Blossom says `active`, `pending`, `banned`, or any other non-repairable status
- `read_failed`
  Blossom inspection failed due to auth/network/5xx/parse issues

Only `repairable_mismatch` is eligible for apply.

---

## Chunk 1: Blossom Inspection and Classification Helper

### Task 1: Build the read-then-classify helper

**Files:**
- Create: `src/moderation/age-restricted-reconcile.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write failing tests for candidate paging**

Add tests that seed `moderation_results` rows with:
- `AGE_RESTRICTED`
- `SAFE`
- `QUARANTINE`
- `PERMANENT_BAN`

Expected behavior:
- only `AGE_RESTRICTED` rows are selected
- rows are ordered deterministically by `sha256`
- keyset pagination uses `sha256 > ?`
- `limit + 1` rows are fetched internally so `nextCursor` is exact

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted reconcile candidate paging"
```

Expected: FAIL because helper does not exist yet.

- [ ] **Step 2: Implement candidate paging helper**

Create `src/moderation/age-restricted-reconcile.mjs` exports:

```js
export async function listAgeRestrictedCandidates(db, { cursorSha = null, limit = 100 }) {}
export async function fetchBlossomBlobDetail(sha256, env, fetchImpl = fetch) {}
export function classifyAgeRestrictedCandidate({ sha256, blossomDetail, blossomError }) {}
export function buildPreviewResponse({ rows, classifications, limit, nextCursor }) {}
export async function applyAgeRestrictedRepairs({ shas, env, fetchBlossomBlobDetail, notifyBlossom }) {}
```

Rules:
- D1 selection only reads `action = 'AGE_RESTRICTED'`
- `fetchBlossomBlobDetail` calls Blossom `GET /admin/api/blob/{sha}` with Bearer auth
- use the existing Blossom secret path already accepted by Blossom admin auth
- do not mix HTTP response formatting into the paging/classification functions

- [ ] **Step 3: Run paging tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted reconcile candidate paging"
```

Expected: PASS.

- [ ] **Step 4: Write failing classification tests**

Add tests covering:
- Blossom `status = "age_restricted"` -> `aligned`
- Blossom `status = "restricted"` -> `repairable_mismatch`
- Blossom `status = "deleted"` -> `skip_deleted`
- Blossom `404` -> `skip_missing`
- Blossom `status = "active"` -> `unexpected_state`
- Blossom fetch throws -> `read_failed`

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted reconcile classification"
```

Expected: FAIL until classification exists.

- [ ] **Step 5: Implement classification logic**

Implement exact bucket mapping and keep the output explicit:

```js
{
  sha256,
  category: 'repairable_mismatch',
  blossomStatus: 'restricted',
  error: null
}
```

- [ ] **Step 6: Run classification tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted reconcile classification"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/moderation/age-restricted-reconcile.mjs src/index.test.mjs
git commit -m "feat: add age-restricted reconciliation classifier"
```

---

## Chunk 2: Preview Endpoint

### Task 2: Add a non-mutating preview endpoint that reports real Blossom drift

**Files:**
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write failing route tests for preview**

Add tests for:

```text
POST /admin/api/reconcile/age-restricted/preview
```

Request body:

```json
{
  "limit": 50,
  "cursor": "optional-last-sha"
}
```

Limit default `50`, max `100`. Sized so one preview stays under the 1000-subrequest Workers cap even with retries.

Expected response shape:

```json
{
  "success": true,
  "limit": 50,
  "nextCursor": "...",
  "counts": {
    "aligned": 0,
    "repairable_mismatch": 0,
    "skip_deleted": 0,
    "skip_missing": 0,
    "unexpected_state": 0,
    "read_failed": 0
  },
  "repairableShas": [],
  "samples": {
    "skip_deleted": [],
    "skip_missing": [],
    "unexpected_state": [],
    "read_failed": []
  }
}
```

Run:

```bash
npx vitest run src/index.test.mjs -t "admin age restricted reconcile preview endpoint"
```

Expected: FAIL because route does not exist yet.

- [ ] **Step 2: Implement preview route**

In `src/index.mjs`:
- add `POST /admin/api/reconcile/age-restricted/preview`
- require existing admin auth
- parse `limit` with default `50`, max `100`
- parse optional `cursor`
- page D1 candidates
- inspect Blossom state for that page
- return counts plus explicit `repairableShas`

Important:
- `preview` must never call `notifyBlossom`
- `preview` should include a small sample per non-repairable bucket for operator sanity-checking

- [ ] **Step 3: Run preview route tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "admin age restricted reconcile preview endpoint"
```

Expected: PASS.

- [ ] **Step 4: Add preview logging tests**

Write a failing test proving preview logs structured mismatch counts:
- `limit`
- `cursor`
- `nextCursor`
- all bucket counts

Run:

```bash
npx vitest run src/index.test.mjs -t "preview logs age restricted mismatch counts"
```

Expected: FAIL until logging is implemented.

- [ ] **Step 5: Implement structured preview logs**

Add one structured log line per preview request so `wrangler tail` shows real drift, not just population size.

- [ ] **Step 6: Run logging tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "preview logs age restricted mismatch counts"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: add age-restricted reconciliation preview endpoint"
```

---

## Chunk 3: Apply Endpoint with Revalidation

### Task 3: Add explicit-SHA apply semantics

**Files:**
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write failing apply route tests**

Add tests for:

```text
POST /admin/api/reconcile/age-restricted/apply
```

Request body:

```json
{
  "shas": ["sha1", "sha2"]
}
```

Expected behavior:
- requires admin auth
- rejects empty or oversized SHA lists
- re-reads Blossom state for each SHA before writing
- only calls `notifyBlossom(sha, 'AGE_RESTRICTED', env)` when live Blossom status is still `restricted`

Run:

```bash
npx vitest run src/index.test.mjs -t "admin age restricted reconcile apply endpoint"
```

Expected: FAIL because route does not exist yet.

- [ ] **Step 2: Implement apply route**

In `src/index.mjs`:
- add `POST /admin/api/reconcile/age-restricted/apply`
- require admin auth
- validate:
  - `shas` must be an array of valid SHA-256 strings
  - max batch size `100` (fits 1000-subrequest Workers cap with headroom)
- call helper `applyAgeRestrictedRepairs`

Response shape (skip keys mirror preview classification vocabulary exactly):

```json
{
  "success": true,
  "attempted": 20,
  "notified": 17,
  "failed": 1,
  "skipped": {
    "aligned": 1,
    "skip_deleted": 1,
    "skip_missing": 0,
    "unexpected_state": 0,
    "read_failed": 0
  },
  "failures": [
    { "sha256": "...", "error": "HTTP 500: ...", "stage": "notify" }
  ]
}
```

- [ ] **Step 3: Add failing tests for revalidation**

Write explicit tests for:
- preview says `repairable_mismatch`, but apply sees `age_restricted` -> skip, no write
- apply sees `deleted` -> skip, no write
- apply sees `restricted` -> replay
- apply sees Blossom read failure -> failure, no write

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted apply revalidates blossom state"
```

Expected: FAIL until revalidation logic exists.

- [ ] **Step 4: Implement safe apply logic**

`applyAgeRestrictedRepairs` rules:
- re-fetch Blossom detail for every SHA at apply time
- if state is `restricted`, call `notifyBlossom(sha, 'AGE_RESTRICTED', env)`
- if state changed, skip and classify the skip
- do not advance or erase failed SHAs; return them explicitly
- sequential execution is acceptable for the first version; optimize later only if needed

- [ ] **Step 5: Run apply tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "admin age restricted reconcile apply endpoint"
npx vitest run src/index.test.mjs -t "age restricted apply revalidates blossom state"
```

Expected: PASS.

- [ ] **Step 6: Add failure visibility tests**

Write a failing test proving failed SHAs are preserved in the response so the operator can retry the exact list.

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted apply returns exact failed shas"
```

Expected: FAIL until response formatting is complete.

- [ ] **Step 7: Implement exact-failure reporting**

Return failed SHA records like:

```json
{
  "sha256": "...",
  "error": "HTTP 500: ...",
  "stage": "notify"
}
```

- [ ] **Step 8: Run failure visibility tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted apply returns exact failed shas"
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat: add safe age-restricted reconciliation apply endpoint"
```

---

## Chunk 4: Production Verification and Rollout

### Task 4: Prove repaired rows flip from public `404` to `401`

**Files:**
- Modify: `src/index.test.mjs`
- Optional Create: `scripts/reconcile-age-restricted-sample.sh`

- [ ] **Step 1: Add regression coverage for exact write semantics**

Write a focused test that proves apply emits:

```js
notifyBlossom(sha256, 'AGE_RESTRICTED', env)
```

and never emits `RESTRICT`.

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted reconcile writes AGE_RESTRICTED"
```

Expected: PASS.

- [ ] **Step 2: Document operator preview/apply commands**

Preview:

```bash
curl -X POST https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":100}'
```

Apply:

```bash
curl -X POST https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shas":["sha1","sha2"]}'
```

Verify repaired blobs:

```bash
curl -I https://media.divine.video/b9c36f9d87363cc31b9ca5ce011bc1295858feeccf5a4f006b4b5a2acc1eda90
curl -I https://media.divine.video/fd174f7fc1cfde0e611cdfe59a1792e3cf77430626eecf15b89f4e75aaa7f060
```

Expected after repair:
- Funny Vine hash returns `401`
- Logan sample remains `401`

- [ ] **Step 3: Add batch-audit verification**

After applying one batch, audit actual repaired SHAs from that batch:
- sample at least 10 returned `notified` SHAs
- verify public `HEAD` is now `401`
- verify none of the returned `skip_deleted` SHAs changed state

- [ ] **Step 4: Add deploy-tail verification**

Operator should run:

```bash
npx wrangler tail --format pretty
```

and confirm:
- preview logs show real bucket counts
- apply logs show `attempted`, `notified`, `failed`, and exact failed SHAs

- [ ] **Step 5: Commit**

```bash
git add src/index.test.mjs scripts/reconcile-age-restricted-sample.sh
git commit -m "test: cover age-restricted reconciliation rollout verification"
```

If no helper script was needed, omit it from the commit.

---

## Chunk 5: Recurrence Prevention

### Task 5: Make future drift measurable

**Files:**
- Modify: `src/index.mjs`
- Test: `src/index.test.mjs`

This chunk reuses the preview endpoint's classification output — no scheduled-event wiring. If a scheduled drift check is desired, add it in a follow-up plan once the preview endpoint has been exercised in production.

- [ ] **Step 1: Write failing tests for preview-based drift reporting**

Add a test proving the non-mutating preview route reports actual mismatch categories, not just raw `AGE_RESTRICTED` population counts. Specifically: given a mix of `aligned` / `repairable_mismatch` / `skip_deleted` rows, the response `counts` object must reflect each bucket distinctly rather than summing them under a single total.

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted preview reports real blossom drift"
```

Expected: FAIL until preview reporting distinguishes buckets.

- [ ] **Step 2: Confirm preview emits bucketed counts**

Verify the preview implementation from Chunk 2 already satisfies the test. If it does not (e.g. counts are collapsed), adjust `buildPreviewResponse` until buckets are reported independently.

- [ ] **Step 3: Run prevention tests**

Run:

```bash
npx vitest run src/index.test.mjs -t "age restricted preview reports real blossom drift"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "test: cover age-restricted drift bucket reporting"
```

---

## Verification Checklist

- [ ] `npx vitest run src/index.test.mjs -t "age restricted reconcile candidate paging"`
- [ ] `npx vitest run src/index.test.mjs -t "age restricted reconcile classification"`
- [ ] `npx vitest run src/index.test.mjs -t "admin age restricted reconcile preview endpoint"`
- [ ] `npx vitest run src/index.test.mjs -t "admin age restricted reconcile apply endpoint"`
- [ ] `npx vitest run src/index.test.mjs -t "age restricted apply revalidates blossom state"`
- [ ] `npm test`
- [ ] `npx wrangler deploy`
- [ ] Run production preview on one page and confirm mismatch counts look sane
- [ ] Apply one small explicit SHA batch
- [ ] Confirm repaired sample SHAs return `401` instead of `404`
- [ ] Confirm divine-web now shows age-gate UI instead of generic placeholder for repaired blobs

## Rollout Notes

- Start with preview only.
- Inspect all non-repairable buckets before writing anything.
- Apply only the `repairableShas` returned for one preview page.
- Verify public `HEAD` behavior before continuing.
- **Stopping condition:** advance the `cursor` until a full pass across the `AGE_RESTRICTED` population reports `counts.repairable_mismatch == 0` on every page. A single page of `0` is not sufficient — the reconciler pages by `sha256`, and mismatches may exist past the current cursor.
- If failures occur, retry using the exact failed SHA list. Do not rely on a cursor to recover failed writes.
- **Avoid the 5-minute cache window.** Do not run apply within 5 minutes of a direct Blossom admin state change (admin delete, manual status edit, etc.), since Simple Cache can return stale `restricted` for up to 5 minutes and apply will replay `AGE_RESTRICTED` over the new state. Coordinate with anyone touching Blossom admin during rollout.
- **Concurrent apply is safe.** `notifyBlossom` maps `AGE_RESTRICTED` idempotently; two operators applying overlapping SHA lists will not corrupt state. But they will double-count subrequests — coordinate batches to stay under the Workers limit.

## Why This Plan and Not the Blossom KV Script

- Blossom’s direct KV backfill script is a status-shape tool, not a source-of-truth repair.
- The global dry-run showed the `restricted` population is far broader than the known historical age-gate bug.
- This plan reads Blossom first, repairs only proven `restricted` mismatches, and avoids rewriting `deleted`, missing, or otherwise changed blobs.

Plan complete and saved to `docs/superpowers/plans/2026-04-17-age-restricted-blossom-reconciliation-plan.md`. Ready to execute?
