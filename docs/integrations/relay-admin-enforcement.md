# Relay-admin enforcement integration

Notes on how divine-moderation-service calls relay-admin (divine-relay-manager) to ban, un-ban and delete, and what a refusal means.

## Source of truth

The RPC contract belongs to `divine-relay-manager`:

- `worker/src/index.ts` — `handleRelayRpc`, the `/api/relay-rpc` endpoint
- `worker/src/age-review.ts` — `ageReviewActiveGuard`, which produces the refusals below

Those are canonical. Anything here defers to them when they disagree.

## How moderation-service calls relay-admin

`src/index.mjs` exports nothing for this; `callRelayAdminAction(env, payload)` POSTs to `<relay-admin>/api/relay-rpc`, preferring the `RELAY_ADMIN` service binding and falling back to the public edge + CF Access. `relayRpcForAction` maps three internal actions onto NIP-86 methods:

| Internal action | NIP-86 method | Guarded upstream? |
|---|---|---|
| `ban_pubkey` | `banpubkey` | No — the severe-action escape hatch is deliberately unguarded. |
| `allow_pubkey` | `unbanpubkey` | **Yes** — age-review guard. |
| `delete_event` | `banevent` | No. |

Only `allow_pubkey` can be refused by the age-review guard, so it is the only action that produces the codes below.

## Refusals on an un-ban

`unbanpubkey` calls relay-manager's `unsuspendUser`, so un-banning also lifts a *suspension* — including a minor-safety hold. divine-relay-manager#217 therefore refuses an un-ban of an account with an open (non-terminal) age-review case, and refuses when it cannot determine whether one exists.

| relay-admin returns | Meaning | This service answers |
|---|---|---|
| `409` `code: age_review_active`, plus `caseId` and `state` | Permanent. The case has to be resolved in the Age Review flow first. | `409` with `code`, `caseId`, `state` and a `caseUrl` deep-link. |
| `503` `code: age_review_check_failed` | The check could not run (D1 outage / no binding). Fail-closed, so the hold stays on. | `503` with `code`. Retryable. |
| any other non-2xx, or `success: false` | A genuine relay failure. | `502` with the message, as before. |

`caseUrl` is built from `RELAY_ADMIN_UI_URL` (default `https://relay.admin.divine.video`) as `/age-review?case=<caseId>`. Note this is the **UI** host, which is not the API host the worker calls (`RELAY_ADMIN_URL`, default `https://api-relay-prod.divine.video`). The age-review page also accepts `?pubkey=<hex>`, but that costs it a lookup to resolve the case a refusal already named.

`state` is one of relay-manager's `AGE_REVIEW_STATES` (`shared/age-review.ts`). Terminal states (`cleared`, `denied_closed`) never appear in a refusal, because a case in one of those no longer blocks the un-ban.

## Consumers

The only caller that can be refused is `POST /admin/api/uploader/:pubkey/enforcement`, reached from the dashboard's Ban/Unban User button. (`deleteRelayEventIds` calls `callRelayAdminAction` too, but only with `delete_event`, which is unguarded.) A refusal returns before `setUploaderEnforcement` runs, so no local row records an enforcement the relay never applied — including any `approvalRequired`/`notes` submitted in the same request.

On a `409` the dashboard shows the refusal with an **Open case** action that opens `caseUrl` — but only when `caseUrl` is `https:`, since it is handed to `window.open`. A non-https `RELAY_ADMIN_UI_URL` therefore drops both the action and the case id, leaving the plain message. On a `503` it shows `User action failed: <relay-admin's message>` — the same plain red toast as a `502`, so the two are not distinguishable in the UI beyond whatever the upstream message happens to say. Nothing here retries automatically.

## What this doc does not cover

- relay-manager's guard internals, the fail-open/fail-closed reasoning, or why `banpubkey` stays unguarded. Read the source files named above.
- The Coop enforcement adapter, which reaches the same guard by its own route.
