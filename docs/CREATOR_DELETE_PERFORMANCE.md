# Creator deletion performance monitoring

Deletion confirmation spans client signing, the POST, and optional status polling. This service measures the server part of that journey. Client Firebase traces measure the full user operation and its terminal result; server logs identify the slow dependency. These datasets are separate and should be compared by time window and operation, without sending event identifiers to Firebase.

## Event contract

New measurements use structured console objects with `event = creator_delete.performance`. Every event includes `operation` (`delete` or `delete_status`), `phase`, `duration_ms`, and a bounded `outcome`. Optional integer fields are `attempt`, `attempts`, `retry_delay_ms`, and `status_code` (only when observed). Durations use wall-clock milliseconds, including awaited I/O. Very short CPU-only phases can measure zero in the Workers runtime.

| Phase | What it measures | Outcomes / extra fields |
| --- | --- | --- |
| `request` | Handler entry through response construction or thrown failure | `completed`, `in_progress` (202), `rejected` (4xx/5xx), `error` (throw); `status_code` on a response |
| `ip_rate_limit`, `pubkey_rate_limit` | KV rate-limit checks | `allowed`, `limited`, `error` |
| `auth` | NIP-98 validation | `valid`, `invalid`, `error` |
| `kind5_lookup` | Handler's deletion-event dependency, including retries | `found`, `unresolved`, `error` |
| `kind5_retries` | Complete retry loop including backoff | `found`, `unresolved`, `error`; `attempts` |
| `kind5_attempt` | One deletion-event lookup, excluding preceding backoff | `found`, `unresolved`, `error`; one-based `attempt`, configured `retry_delay_ms` |
| `relay_lookup` | One REST relay fetch including body parsing and signature verification | `found`, `missing` (404), `transient` (other non-2xx), `invalid` (body/validation failure), `transport_error` (failure before a response); one-based relay `attempt`, observed `status_code` |
| `target_lookup` | One target event dependency | `found`, `missing`, `error` |
| `blob_delete` | One media-deletion dependency | `success`, `failed`, `skipped`, `error`; observed `status_code` |
| `processing` | Entire synchronous deletion processor, including database operations and all targets | `success`, `failed`, `in_progress`, `error` |
| `status_read` | Polling database read | `found`, `missing`, `error` |
| `status_result` | Authorized polling response shaping (not operation duration) | `failed` when any row failed; otherwise `success` when all rows succeeded, or `in_progress` |

`unresolved` deliberately does not assert that an event is absent: the existing deletion-event lookup returns null for both missing and transient upstream responses. Inspect `relay_lookup` to distinguish those cases. `attempt` in `relay_lookup` counts relays within one lookup; `attempt` in `kind5_attempt` counts retry-loop iterations. Use the invocation view and event order to inspect a particular retry.

An HTTP 200 means the response completed, not necessarily that cleanup succeeded. Use `processing.outcome` for cleanup results. A processing result of `in_progress` means another attempt owns work; it is not a failure. A request returning 202 may still have a later `processing` event in the same invocation because existing `ctx.waitUntil` work continues after the response. Cron processing durations are not included in these new measurements; later authorized `status_result` events reveal its resulting state when a client polls. Use client terminal outcomes for eventual completion rates.

The new log fields are allowlisted. They contain no event IDs, public keys, IPs, URLs, credentials, payloads, or exception messages. Existing operational logs and Cloudflare invocation metadata are unchanged and may contain identifiers; do not export those alongside these measurements to public reports. Logging and outcome classification are best effort and do not replace dependency exceptions or results.

## Operator queries

In the deployed Worker's Observability Query Builder, select a bounded time window and add `event equals creator_delete.performance` to every query below. Fields are indexed from the structured console object; use field autocomplete after the first deployed event. Add `Count` beside every latency visualization so low sample counts remain visible.

| Saved query purpose | Additional filters | Visualizations | Group by |
| --- | --- | --- | --- |
| API response latency and rejection mix | `phase equals request` | Count, P50/P90/P95 of `duration_ms` | `operation`, `status_code`, `outcome` |
| Where deletion time goes | `operation equals delete` | Count, P90/P95 of `duration_ms` | `phase`, `outcome` |
| Lookup visibility and retry cost | `phase equals kind5_retries` | Count, P90 of `duration_ms`, Average of `attempts` | `outcome`, `attempts` |
| Upstream failures | `phase equals relay_lookup` | Count, P90 of `duration_ms` | `outcome`, `status_code` |
| Cleanup completion | `phase equals processing` | Count, P90/P95 of `duration_ms` | `outcome` |
| Polling outcomes | `phase equals status_result` | Count | `outcome` |
| Polling database latency | `operation equals delete_status`, `phase equals status_read` | Count, P90/P95 of `duration_ms` | `outcome` |

The Query Builder supports these [aggregations and filters](https://developers.cloudflare.com/workers/observability/query-builder/). For an individual slow request, open its invocation and compare `kind5_retries`, each `relay_lookup`, and `processing`. Avoid summing phase percentiles: phases overlap (`kind5_lookup` contains `kind5_retries`, which contains attempts; `processing` contains target and blob work).

Use only `phase=request` as the denominator for response counts. Compute HTTP rejection rate as request events with status >=400 divided by all request events that have a status; report thrown `outcome=error` separately. Compute cleanup failure share from `processing` events, never by dividing target or retry events by request counts. One operation can have several targets, attempts, and polling requests. `status_result` counts describe poll observations, not unique deletions or terminal-operation rates; transient failed rows can later recover. Compare equal windows and sampling settings; sample counts are not population counts when collection is sampled.

## Deployment and validation

The tracked `wrangler.toml` enables persisted Workers Logs at a sampling rate of 1 (100%) after deployment, so rare deletion failures remain observable. Automatic invocation logs are disabled to avoid adding log messages containing full request URLs. Existing console messages will also be persisted: the new event allowlist does not redact those legacy messages. Account access controls, retention, and log volume still matter. Monitor volume after rollout and explicitly document any future sampling change before comparing counts.

This code and configuration require an approved deployment; they do not configure Firebase alerts or prove that live collection is active. After deploying, verify the returned Worker settings and inspect actual new events. See [Workers Logs collection and sampling](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

After an approved deployment:

1. Confirm the expected Worker version serves the endpoint and inspect its log settings.
2. Perform one deletion using synthetic test content and inspect the invocation: one `request` event, bounded phase names, retry count, and no identifiers in new event fields.
3. Check a delayed or failed lookup in a controlled environment and confirm observed statuses and retry counts. The default delay schedule remains 0, 100, 500, 1000, and 2000 ms.
4. Exercise a 202 response and confirm the later processing completion is visible where the operation completes within the existing background lifetime.
5. Compare client Firebase deletion-confirmation outcomes and server phase distributions over the same window. Separate `/api/delete/*`, `/api/delete-status/*`, and `/check-result/*` in Firebase URL patterns so route aggregation cannot hide failures.

Establish a baseline with sample counts before setting latency or failure alerts. Alert separately on lookup failures, cleanup failures, and status-read errors; a slow or unsuccessful deletion should not be labeled a moderation lookup regression. Missing events can mean sampling, log retention, disabled collection, or a runtime termination before completion; they do not establish success.
