# Divine Moderation Service

The Trust & Safety worker behind [Divine](https://divine.video). It runs the human-in-the-loop review pipeline for uploaded 6-second videos — ingesting reports, giving moderators a dashboard to triage them, and pushing decisions back out to the relay, CDN, and Nostr. Divine's promise is [no slop, all human](https://github.com/divinevideo/brand-guidelines), and this service is where a person makes the final call on borderline content.

It is a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) (`divine-moderation-service`) serving two custom domains:

- `moderation-api.divine.video` — public and service-to-service API routes.
- `moderation.admin.divine.video` — the moderator dashboard, behind Cloudflare Access.

## How moderation works today

The service runs in **reactive mode** (`REACTIVE_MODERATION_ONLY = "true"`). Rather than machine-scanning every upload, it acts on signals that something needs a human look:

1. **Reports come in** — from authenticated Divine clients (`POST /api/v1/report`), from public NIP-56 (kind `1984`) report events polled off `relay.divine.video`, and from NIP-17 report DMs sent to the moderation@ inbox. Each report is written to D1 as a review row.
2. **A moderator triages** — the admin dashboard presents a swipe-review queue of untriaged content, with video playback, uploader context, and any available provenance/AI signals.
3. **A decision is applied** — the moderator picks an action, and the worker fans it out: it records the decision, publishes Nostr labels/reports, notifies the relay (ban/unban/delete via the relay-admin service binding) and Blossom (blob delete), and hands labels to the ATProto labeler webhook.

Moderation actions are `SAFE`, `REVIEW`, `QUARANTINE`, `AGE_RESTRICTED`, `PERMANENT_BAN`, and `DELETE`.

Because the service is report-driven, the queue consumer for the legacy `video-moderation-queue` currently **acknowledges and skips** every message. The automated multi-provider classifier pipeline still lives in the codebase (`src/moderation/`) and can be re-enabled, but it is not on the upload path in production.

## Features

- **Human review dashboard** — swipe-review queue, per-category verification (confirm/reject an individual detection), direct-message templates for creator communication, stats, and tunable classifier thresholds. Served behind Cloudflare Access on `moderation.admin.divine.video`.
- **Report ingestion** — authenticated client reports, inbound public NIP-56 (kind `1984`) reports polled from the relay, and NIP-17 report DMs to the moderation@ inbox. Both Nostr paths are review-only and never auto-escalate, since client tags and reporter pubkeys are self-asserted public signals. A relay report is ingested whatever client it came from; the NIP-89 `client` tag only decides whether its reporter counts toward the distinct-reporter threshold the authenticated path escalates on — reports from clients outside `TRUSTED_REPORT_CLIENTS`, like report DMs, do not. Only `POST /api/v1/report` can produce an automatic `AGE_RESTRICTED`.
- **Content categories** — nudity/NSFW, violence, gore, weapons, recreational drugs, self-harm, hate speech / offensive symbols, AI-generated, and deepfake, plus content-warning labels for alcohol, tobacco, medical, and gambling.
- **AI-generation & provenance signals** (surfaced to moderators as review context, not auto-enforcement):
  - `divine-ai-detector` for per-signal detection, with vendor fallback to Hive and Reality Defender.
  - `divine-inquisitor` for C2PA / ProofMode verification (`inquisitor.divine.video`).
  - **Video Seal** — interprets the neural-watermark payload extracted upstream; `0x01` is reserved for trusted Divine attestations.
- **Creator-delete pipeline** — honors Nostr kind `5` deletion requests from creators, removing their own content from Blossom.
- **Downstream publishing** — NIP-56 reports to Faro and the content relay, NIP-32 (kind `1985`) label events for human-verified labels, and a moderation@ NIP-17 DM inbox.

## Architecture

Everything runs inside one Worker (`src/index.mjs`), which exports three handlers:

- **`fetch`** — the HTTP API and admin dashboard.
- **`queue`** — the `video-moderation-queue` consumer (ack-and-skip under reactive mode).
- **`scheduled`** — cron work. The every-minute trigger runs the creator-delete pipeline and the lookup-column backfill; the every-5-minute trigger polls the relay for new video events and for inbound reports.

Storage and integrations, all bound in `wrangler.toml`:

- **D1** (`BLOSSOM_DB`, database `blossom-webhook-events`) — moderation results, reports, review rows, uploader enforcement, AI-detection events. Schema lives in `migrations/`.
- **KV** (`MODERATION_KV`) — poller checkpoints, cached lookups, and operational markers.
- **Queue** (`video-moderation-queue`) — producer + consumer bindings retained for the legacy pipeline.
- **Service binding** (`RELAY_ADMIN` → `divine-relay-admin-api-prod`) — worker-to-worker ban/unban/delete-event RPCs, authorized with a shared key from Secrets Store. Bypasses the public edge and Cloudflare Access; falls back to the public HTTPS + CF Access path when the binding is absent.

### Where it fits in Divine Trust & Safety

Reports and creator-delete requests flow in from the Divine clients and the relay. Moderators act in this service. Decisions flow back out to the relay (`divine-relay-manager` / Funnelcake), the Blossom CDN, Nostr (labels and reports), and the ATProto labeler — so a single human decision is reflected everywhere the content is served.

## Getting started

Requires Node.js 22 and a Cloudflare account with access to the `divine.video` zone.

```bash
npm install        # install dependencies
npm run dev        # run the Worker locally with Wrangler
npm test           # run the Vitest suite
npm run lint       # custom repo lint pass
npm run tail       # tail production logs
```

Tests are written with Vitest on `@cloudflare/vitest-pool-workers`. Every source module has a colocated `*.test.mjs`.

## Configuration

Bindings, routes, feature flags, and non-secret vars live in `wrangler.toml`. Highlights:

| Var | Purpose |
|-----|---------|
| `REACTIVE_MODERATION_ONLY` | `"true"` — queue consumer ack-skips; moderation is report-driven. |
| `MODERATION_ENABLED` | Master enable flag. |
| `CDN_DOMAIN` | Blossom CDN host for video access (`media.divine.video`). |
| `TEAM_DOMAIN` | Cloudflare Access team domain for Zero Trust JWT verification. |
| `RELAY_POLLING_*` | Relay video-event polling (URL, lookback, limit, enable). |
| `REPORT_POLLING_*` | Inbound NIP-56 report polling (URL, lookback, limit, max pages). |
| `TRUSTED_REPORT_CLIENTS` | Comma-separated NIP-89 `client` tags whose relay reports may drive automatic outcomes. Reports from any other client are still recorded for review, on a non-escalating source. |
| `CREATOR_DELETE_PIPELINE_ENABLED` | Enable the kind `5` creator-delete cron. |
| `AI_DETECTOR_BASE_URL` / `AI_DETECTOR_MODE_*` | `divine-ai-detector` endpoint and per-signal cutover mode. |
| `INQUISITOR_BASE_URL` | `divine-inquisitor` C2PA / ProofMode service. |
| `FUNNELCAKE_ADMIN_URL` / `FUNNELCAKE_LOOKUP_URL` | Relay admin (writes) and video-lookup (reads) hosts. |
| `*_THRESHOLD_HIGH` / `*_THRESHOLD_MEDIUM` | Legacy classifier thresholds, retained for provider/classifier tests. |

Secrets are set with `wrangler secret put <NAME>`. The ones the service reads (see the header of `wrangler.toml` for the full list):

- `SERVICE_API_TOKEN` — bearer token for authenticated `moderation-api.divine.video` requests.
- `POLICY_AUD` — Zero Trust application audience tag for the admin app.
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — Cloudflare Access service token for the relay.
- `NOSTR_PRIVATE_KEY` — signs NIP-56 report events.
- `MODERATOR_NSEC` / `NOSTR_RELAY_URL` — signs and publishes NIP-32 human-moderator label events.
- `ADMIN_PASSWORD_HASH` — SHA-256 of the admin dashboard password (`generate-admin-hash.mjs`).
- `ATPROTO_LABELER_WEBHOOK_URL` / `ATPROTO_LABELER_TOKEN` — the divine-labeler webhook and its bearer token.
- `REALITY_DEFENDER_API_KEY` — secondary AI verification.
- `SIGHTENGINE_API_USER` / `SIGHTENGINE_API_SECRET` — optional, for the legacy classifier fallback.

`RELAY_ADMIN_API_KEY` is **not** a per-worker secret — it is bound from Secrets Store (`MODERATION_TO_RELAY_ADMIN_KEY`) and sent as the `X-Admin-Key` header on relay-admin calls. Hive secrets are intentionally unused by the upload and classification paths; do not set them without a reviewed Hive integration.

## Deployment

CI is defined in `.github/workflows/ci.yml`. On every pull request it runs lint and the test suite; on push to `main` it also deploys the Worker via `cloudflare/wrangler-action` using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. `semantic_pr.yml` enforces Conventional Commit PR titles.

To deploy manually:

```bash
npm run deploy     # wrangler deploy
```

Binding the Secrets Store secret requires the deploy token to have account **Secrets Store: Write** permission — see the note in `wrangler.toml`.

## Further reading

- `CONTENT_MODERATION.md` — moderation strategy and the Video Seal provenance model.
- `AGENTS.md` — repository guidelines and contribution guardrails.
- `CDN_INTEGRATION.md`, `CLOUDFLARE_ACCESS_SETUP.md`, `ADMIN_SETUP.md` — integration and setup detail.
- `CHANGELOG.md` — notable changes.

## License

Mozilla Public License 2.0. See `LICENSE`.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
