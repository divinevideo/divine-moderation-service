# Creator-delete end-to-end test — design

**Date:** 2026-04-18
**Issue:** [divinevideo/divine-moderation-service#101](https://github.com/divinevideo/divine-moderation-service/issues/101)
**Repo:** divine-moderation-service (new script + tests)
**Status:** Design approved, pending implementation plan

## Context

PR #92 shipped creator-delete end-to-end enforcement with strong unit and integration coverage, but the full-pipeline e2e was deferred: a throwaway-key kind 34236 event did not persist to queryable state quickly enough for the in-house e2e attempt to complete. Issue #101 asks for a repeatable e2e test that exercises the real path from Nostr delete event through moderation-service to Blossom's deleted state — either sync or cron path, isolated, repeatable, without affecting production user content.

Investigation into Funnelcake's ingest code (`divine-funnelcake/crates/relay/src/relay.rs:844-1391`) and REST read path (`crates/api/src/handlers.rs:5322` → `crates/clickhouse/src/client.rs:1484`) confirmed there is no creator-registration gate. Ephemeral keys *are* indexed into ClickHouse once the normal video tag validation and batch-write pass. The previous e2e-failure attributions were likely ClickHouse batch-flush + ReplacingMergeTree dedup propagation latency, not a pubkey whitelist.

That opens up a cleaner shape: operator-run script with ephemeral keys, targeted against a mix of staging (relay) and prod (Blossom + mod-service worker) so that Nostr events stay out of prod user feeds while the media and pipeline are exercised for real.

## Goals

- Prove the full route from kind 5 publish through mod-service to Blossom's deleted state.
- Cover both pipeline paths: direct sync endpoint and cron pickup.
- Repeatable on demand, no human orchestration beyond invoking the script.
- Leave production Blossom and D1 in the same state after each run as before it, via active cleanup.
- Surface real regression signal when Blossom or mod-service pipeline code changes.

## Non-goals

- Not a CI-automated test. Hitting real prod Blossom on every commit is unsafe and generates audit-log noise.
- Not a replacement for unit tests. The in-script unit tests cover pure helpers; the e2e itself is an integration gate.
- Not a load or stress test. One sync + one cron scenario per run.
- Not intended to validate account-level vanish (NIP-62) or moderator-initiated deletes.
- Not designed to work when the prod worker's `CREATOR_DELETE_PIPELINE_ENABLED` is off. If that flag is unset, the test will fail with a polling timeout; operator verifies and re-runs.

## Environment targeting

| Layer | Target | Why |
|---|---|---|
| Nostr relay (publish + fetch) | `wss://relay.staging.divine.video` (staging Funnelcake) | Keeps test kind 34236 / kind 5 events out of prod user feeds. |
| Media server (upload + state check + cleanup) | `https://media.divine.video` (prod Blossom) | No staging Blossom exists; prod is the only real target for the media path. |
| mod-service worker (sync endpoint + cron) | `https://moderation-api.divine.video` (prod) | The live pipeline runs on the prod worker; "staging mod-service" is not deployed. |
| D1 (state check + cleanup) | `blossom-webhook-events` on prod via `wrangler --remote` | Same D1 binding the live pipeline writes. |

The mixed posture is the trade-off: prod Blossom + prod D1 unavoidable because no staging instances exist for them. Staging relay keeps the Nostr artifacts out of prod feeds. Active cleanup returns prod Blossom and prod D1 to their pre-run state.

## Architecture

```
operator laptop
   │
   └─ scripts/e2e-creator-delete.mjs  [--scenario=sync|cron|both]
        │
        ├─ generateTestKey()                       fresh ephemeral secp256k1; in-memory only
        ├─ generateSyntheticBlob()                 1KB bytes, unique sha256
        │
        ├─ uploadToBlossom(bytes)         ─→ https://media.divine.video (PUT /upload, BUD-02)
        ├─ publishKind34236(sk, sha256)   ─→ wss://relay.staging.divine.video
        ├─ waitForIndexing(event_id)      ─→ poll https://funnelcake.staging..../api/event/{id}
        │
        ├─ SCENARIO sync:
        │   ├─ publishKind5(sk, target_event_id)   ─→ staging relay
        │   ├─ callSyncEndpoint(sk, kind5_event)   ─→ prod mod-service /api/creator-delete/sync
        │   ├─ pollStatus(kind5_id)                ─→ prod mod-service /api/creator-delete/status/{id}
        │   └─ assertD1AndBlossomState
        │
        ├─ SCENARIO cron (independent key + blob):
        │   ├─ publishKind5(sk, target_event_id)   ─→ staging relay (no sync call)
        │   ├─ waitForCronPickup (poll status ≤180s)
        │   └─ assertD1AndBlossomState
        │
        └─ CLEANUP (always, even on failure; best-effort):
            ├─ cleanupBlossomVanish(pubkey)        ─→ POST /admin/api/vanish (full purge)
            └─ cleanupD1Row(kind5_id, target_id)   ─→ wrangler d1 execute --remote DELETE
```

**Boundaries:**

- Script is the orchestrator. No new mod-service or Blossom code.
- Each scenario uses its own ephemeral key + fresh blob — no cross-contamination.
- Cleanup uses `/admin/api/vanish` (verified in `divine-blossom/src/main.rs:209, 3975`), which for a pubkey owning one blob surgically purges GCS + KV + VCL for that single blob.

## Components

### `scripts/e2e-creator-delete.mjs`

Single-file Node ESM, no transpilation. Operator-run: `node scripts/e2e-creator-delete.mjs [flags]`.

**CLI flags:**

```
--scenario=sync|cron|both     Which scenarios to run. Default: both.
--staging-relay=URL           Default: wss://relay.staging.divine.video
--funnelcake-api=URL          Default: https://funnelcake.staging.dvines.org
--blossom-base=URL            Default: https://media.divine.video
--mod-service-base=URL        Default: https://moderation-api.divine.video
--d1-database=NAME            Default: blossom-webhook-events (prod)
--cron-wait-seconds=N         Default: 180 (derived from 1-minute cron interval)
--skip-cleanup                Leave artifacts in place for post-failure inspection.
--help
```

**Required env:**

- `BLOSSOM_WEBHOOK_SECRET` — Bearer for Blossom `/admin/api/vanish` during cleanup.
- Wrangler authed against the prod Cloudflare account.
- Node 20+ (global `fetch`).

**Blossom response contract (verified 2026-04-18):**

The admin vanish endpoint (`divine-blossom/src/main.rs:209` → `handle_admin_vanish`, `src/main.rs:3975` → `execute_vanish`) returns:

```json
{
  "vanished": true,
  "pubkey": "<hex>",
  "reason": "<string>",
  "fully_deleted": 1,
  "unlinked": 0,
  "errors": 0
}
```

The creator-delete moderate endpoint's response contract is pinned in `scripts/sweep-creator-deletes.mjs::classifyDeleteResult` — reads `success`, `physical_deleted`, `physical_delete_skipped` (from `divine-blossom/src/admin.rs:923-930`). The e2e script uses the same contract.

**Internal functions** (each small, side effects isolated for unit testing):

| Function | Purpose | Side effects |
|---|---|---|
| `parseArgs(argv)` | Typed config. | none (pure). |
| `generateTestKey()` | Fresh secp256k1 keypair per scenario, in-memory only. | none. |
| `generateSyntheticBlob()` | 1KB deterministic-looking pseudo-mp4 with unique sha256. | none. |
| `uploadToBlossom(bytes, sk, cfg)` | BUD-02 PUT `/upload` signed with BUD-01 auth. Returns `{sha256, url}`. | network. |
| `buildKind34236Event(sk, sha256, cfg)` | Pure: constructs the unsigned event JSON with all required video tags, signs, returns `{id, sig, ...}`. Tags: `d` (unique per test), `title`, `imeta` with space-delimited `url <blossom-url>` + `x <sha256>` + `m video/mp4`, and a `thumb` tag (synthetic URL; does not need to resolve per Funnelcake's check). Contract-grounded against `divine-funnelcake/crates/relay/src/relay.rs:1023-1087` + `validate_imeta_format` at the same file (each imeta item must contain a space). | none. |
| `publishKind34236(event, cfg)` | WebSocket publish of the pre-built event to the staging relay. Returns event_id on OK, throws on relay rejection. 10s timeout. | network. |
| `publishKind5(sk, target_event_id, cfg)` | WebSocket publish. Returns kind5_id. 10s timeout. | network. |
| `waitForIndexing(event_id, cfg, timeoutMs=30000)` | Poll Funnelcake REST GET `/api/event/{event_id}` every 1s until 200 or timeout. | network. |
| `signNip98(sk, url, method, payloadHash?)` | Reuses or imports from `scripts/sign-nip98.mjs`. | none. |
| `callSyncEndpoint(sk, kind5_event, cfg)` | POST mod-service `/api/creator-delete/sync`, NIP-98-authed. 30s timeout. | network. |
| `pollStatus(sk, kind5_id, cfg, timeoutMs)` | GET mod-service `/api/creator-delete/status/{kind5_id}`, NIP-98-authed (re-signs per poll). 2s interval (sync) or 3s interval (cron). | network. |
| `classifyByteProbeResponse(httpStatus)` | Pure: 404 → `{kind: 'bytes_gone', flag_state_inferred: 'on'}`, 200 → `{kind: 'bytes_present', flag_state_inferred: 'off'}`, other → `{kind: 'unknown', status}` (treated as assertion failure). | none. |
| `assertD1AndBlossomState(kind5_id, sha256, testPubkey, cfg)` | (a) Query D1 via wrangler to fetch the `creator_deletions` row; assert `status='success'`, `blob_sha256` matches. (b) GET `https://media.divine.video/<sha256>` (10s timeout); run `classifyByteProbeResponse(status)`; pass on `bytes_gone` OR `bytes_present`, fail on `unknown`. | reads D1, reads Blossom. |
| `cleanupBlossomVanish(testPubkey, cfg)` | POST `/admin/api/vanish` with Bearer auth, reason `"e2e-test cleanup"`. Log `fully_deleted`/`unlinked`/`errors`. 30s timeout. | writes prod Blossom. |
| `cleanupD1Row(kind5_id, target_event_id, cfg)` | `wrangler d1 execute --remote --command "DELETE FROM creator_deletions WHERE kind5_id=? AND target_event_id=?"`. 30s timeout. | writes prod D1. |
| `runSyncScenario(cfg)` | Full sync flow with cleanup in a `finally`. | all of the above. |
| `runCronScenario(cfg)` | Full cron flow (no sync call, longer wait) with cleanup in a `finally`. | all of the above. |
| `printSummary(results)` | Per-scenario pass/fail + timing + any manual-cleanup remnants. stderr. | stderr. |
| `main(argv)` | Wires it all together. | all. |

### `scripts/e2e-creator-delete.test.mjs`

Vitest, runs under the existing repo config. Covers pure/injectable helpers only — the e2e itself is validated by running the script.

| Unit | Coverage |
|---|---|
| `parseArgs` | Defaults, each flag, bad URL strings rejected. |
| `generateSyntheticBlob` | Output is exactly 1024 bytes, sha256 matches bytes, consecutive calls produce different hashes. |
| `buildKind34236Event` | All required tags present (`d`, `title`, `imeta` with `url`/`x`/`m`, thumbnail); imeta parses via regex matching Funnelcake's `validate_imeta_format`; event id matches computed sha256(canonicalized fields). Contract-grounded against `divine-funnelcake/crates/relay/src/relay.rs:1023-1087`. |
| `signNip98` | Expected payload shape, valid signature (verify with nostr-tools). |
| `classifyByteProbeResponse` | 404 → `{kind: 'bytes_gone'}`, 200 → `{kind: 'bytes_present'}`, other statuses → `{kind: 'unknown', status}`. |
| `cleanupBlossomVanish` / `cleanupD1Row` | Injected fetch/runner stubs; verify correct endpoint/body/args shape; verify graceful handling of `fully_deleted:0` vs `fully_deleted:1` responses. |

## Data flow

### Scenario A: sync

1. `generateTestKey()` → fresh secp256k1 keypair.
2. `generateSyntheticBlob()` → `{bytes, sha256}`.
3. `uploadToBlossom(bytes, sk, cfg)` → prod Blossom (BUD-02).
4. `buildKind34236Event(sk, sha256, cfg)` → signed event object. `publishKind34236(event, cfg)` → staging relay. 10s WS timeout.
5. `waitForIndexing(event_id, cfg, 30000)` → poll Funnelcake REST every 1s until 200.
6. `publishKind5(sk, target_event_id, cfg)` → staging relay. Returns kind5_id.
7. `callSyncEndpoint(sk, kind5_event, cfg)` — NIP-98 signed, 30s timeout. Expect 202 Accepted (or 200 if terminal on the fast path).
8. `pollStatus(sk, kind5_id, cfg, 60000)` — every 2s, NIP-98 re-signed per poll. Succeeds on `body.status === 'success'`. Fails on any `failed:*` terminal or timeout.
9. `assertD1AndBlossomState(kind5_id, sha256, testPubkey, cfg)` — D1 row + Blossom byte probe.
10. **Cleanup (always in `finally`):**
    - `cleanupBlossomVanish(testPubkey, cfg)` — full purge of testPubkey's one blob.
    - `cleanupD1Row(kind5_id, target_event_id, cfg)` — DELETE the two D1 rows.
11. Record outcome.

### Scenario B: cron

Identical to A except step 7 is replaced with:

7'. **No sync call.** Wait for cron to pick up kind 5 from the staging relay.
8'. `pollStatus(sk, kind5_id, cfg, 180000)` — every 3s, NIP-98 re-signed per poll. 180s total derived from 1-minute cron interval: worst-case next-fire (60s) + processing (10s) + one transient-retry cycle (60s + 10s) + 30s margin. Succeeds on `body.status === 'success'`. Fails on any `failed:*` terminal or timeout.

On timeout, error message includes: *"Common cause: `CREATOR_DELETE_PIPELINE_ENABLED` may be unset on the prod worker. Verify via `wrangler secret list` or check the worker's deployment config."*

**Running both:** sequential. Each scenario has its own ephemeral key and blob. A failure in A does not prevent B from running; the summary reports each independently.

## Per-step JSONL output (stdout)

One line per step, greppable, pipeable to `jq`:

```json
{"ts":"2026-04-18T...","scenario":"sync","step":"generate_key","ok":true,"pubkey":"<hex>","duration_ms":2}
{"ts":"...","scenario":"sync","step":"upload","ok":true,"sha256":"...","bytes":1024,"duration_ms":340}
{"ts":"...","scenario":"sync","step":"publish_kind34236","ok":true,"event_id":"...","duration_ms":820}
{"ts":"...","scenario":"sync","step":"wait_indexing","ok":true,"polled_times":3,"duration_ms":2800}
{"ts":"...","scenario":"sync","step":"publish_kind5","ok":true,"kind5_id":"...","duration_ms":730}
{"ts":"...","scenario":"sync","step":"call_sync","ok":true,"http":202,"duration_ms":410}
{"ts":"...","scenario":"sync","step":"poll_status","ok":true,"terminal_status":"success","polled_times":4,"duration_ms":3200}
{"ts":"...","scenario":"sync","step":"assert_d1","ok":true,"d1_status":"success","duration_ms":850}
{"ts":"...","scenario":"sync","step":"assert_blossom","ok":true,"bytes_probe":"404","flag_state_inferred":"on","duration_ms":200}
{"ts":"...","scenario":"sync","step":"cleanup_blossom","ok":true,"fully_deleted":1,"unlinked":0,"errors":0,"duration_ms":310}
{"ts":"...","scenario":"sync","step":"cleanup_d1","ok":true,"duration_ms":920}
{"ts":"...","scenario":"sync","outcome":"pass","total_duration_ms":10612}
```

## Error handling

| Stage | Failure | Cleanup attempted? | Exit impact |
|---|---|---|---|
| Pre-flight (env, wrangler auth, CLI args) | Any | No — nothing created yet | exit 2 |
| `uploadToBlossom` 4xx/5xx/network/timeout | Scenario fails | No — upload incomplete | exit 1 |
| `publishKind34236` WS timeout or relay rejection | Scenario fails | Blob cleanup runs | exit 1 |
| `waitForIndexing` 30s timeout | Scenario fails | Blob + relay-event cleanup attempted; relay stays | exit 1 |
| `publishKind5` WS timeout | Scenario fails | Blob cleanup runs | exit 1 |
| `callSyncEndpoint` 4xx/5xx/timeout | Scenario fails | Blob + D1 cleanup run | exit 1 |
| `pollStatus` timeout or `failed:*` terminal | Scenario fails (include `CREATOR_DELETE_PIPELINE_ENABLED` hint on timeout) | Blob + D1 cleanup run | exit 1 |
| `assertD1AndBlossomState` mismatch | Scenario fails | Blob + D1 cleanup run | exit 1 |
| `cleanupBlossomVanish` fails (404, 5xx, auth) | Print manual-cleanup curl; continue to D1 cleanup | — | exit 3 (or OR'd with 1) |
| `cleanupD1Row` fails (wrangler non-zero) | Print manual-cleanup wrangler command | — | exit 3 |
| SIGINT | Finally blocks attempt cleanup; on 2nd SIGINT, hard exit | Best-effort | exit 130 |

**Exit codes:**

- `0` — all requested scenarios passed; all cleanup succeeded.
- `1` — at least one scenario failed. Cleanup was attempted.
- `2` — pre-flight aborted (env, auth, args).
- `3` — scenarios passed but at least one cleanup failed. Prod has residual test artifacts; summary lists them.
- `130` — SIGINT.

If both `1` and `3` apply, `1` takes precedence in the exit code; the summary still itemizes cleanup failures.

## Summary format (stderr)

```
=== E2E SUMMARY ===
Scenario: sync    PASS   10.6s
Scenario: cron    PASS   183.4s

=== ARTIFACTS (cleaned) ===
sha=<sha>  kind5=<id>  vanish=fully_deleted:1  d1=cleaned  (sync)
sha=<sha>  kind5=<id>  vanish=fully_deleted:1  d1=cleaned  (cron)

=== MANUAL CLEANUP NEEDED ===
(none)

Exit: 0
```

On partial failure:

```
=== E2E SUMMARY ===
Scenario: sync    PASS   10.6s
Scenario: cron    FAIL   121.3s  (poll_status timeout — check CREATOR_DELETE_PIPELINE_ENABLED on prod worker)

=== ARTIFACTS (cleaned) ===
sha=<sha>  kind5=<id>  vanish=fully_deleted:1  d1=cleaned  (sync)

=== MANUAL CLEANUP NEEDED ===
sha=<sha>  kind5=<id>  (cron)
  curl -X POST -H "Authorization: Bearer $BLOSSOM_WEBHOOK_SECRET" \
       https://media.divine.video/admin/api/vanish \
       -d '{"pubkey":"<pubkey>","reason":"e2e-test manual cleanup"}'
  wrangler d1 execute blossom-webhook-events --remote \
       --command "DELETE FROM creator_deletions WHERE kind5_id='<id>' AND target_event_id='<id>';"

Exit: 1
```

## Operational runbook

1. Ensure `BLOSSOM_WEBHOOK_SECRET` is exported in the shell.
2. Confirm wrangler is authed against the prod Cloudflare account (`wrangler whoami`).
3. Run: `node scripts/e2e-creator-delete.mjs` (default: both scenarios).
4. Confirm `Exit: 0` and `=== MANUAL CLEANUP NEEDED === (none)` in the stderr summary.
5. On failure: inspect the JSONL stdout (`jq -s 'map(select(.outcome=="fail"))' < run.log`), then act on any "MANUAL CLEANUP NEEDED" lines in the stderr summary.

**Expected runtime:** sync ~15s, cron ~180s (worst case), both together ~200s.

**Audit-log note:** each run emits Blossom audit entries for `upload`, `creator_delete`, and `admin_vanish`, and mod-service console logs for the pipeline run. The `admin_vanish` `reason` field is always `"e2e-test cleanup"` for easy grep. Audit-log readers should filter on this string to distinguish e2e runs from operator actions.

## Forward-looking

The Blossom response contract (verified at `divine-blossom/src/admin.rs:923-930` and `src/main.rs:4795-4802`) drives the byte-probe + vanish-response interpretation in this script. If that contract changes (in-flight PR #97 adds coverage; future PRs may add fields or rename booleans), the script's `classifyByteProbeResponse` and cleanup response assertions must be reverified in lockstep.

The Funnelcake video-tag validation contract (`divine-funnelcake/crates/relay/src/relay.rs:1023-1087`) drives `buildKind34236Event`. Same drift caveat applies; the contract test in `scripts/e2e-creator-delete.test.mjs` is the first line of defense.

Once PR #106 (creator-delete validation-window sweep) and any open Blossom PRs land, re-run this e2e test as part of rollout validation. A green run from this script is a stronger signal for the pipeline being production-healthy than unit tests alone.

## Open questions

(none — all known ambiguities resolved during brainstorming)

## What this is not

- Not a CI-automated test. Operator-run only.
- Not a tool for validating per-blob admin deletes or moderator-initiated actions (BAN, RESTRICT, etc.).
- Not a load test or chaos-engineering tool.
