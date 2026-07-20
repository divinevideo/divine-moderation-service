# Community Label Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cron-swept authoritative aggregation of community kind 1985 content-warning votes: at a KV-configurable Divine-identity-gated threshold, publish one authoritative label via the existing publisher, account strikes per creator, auto-DM warnings, human-only bans — all behind a KV kill switch.

**Architecture:** Mirrors the creator-delete pipeline: a dependency-injected cron orchestrator polls the relay since a KV cursor, a pure decision module computes crossings/strikes, existing plumbing acts (publishLabelEvent, sendModerationDM, D1, RELAY_ADMIN untouched). `decision.mjs` is the Osprey seam — pure, no I/O.

**Tech Stack:** Cloudflare Worker (ESM .mjs), D1 (SQL migrations), KV, Vitest, nostr-tools, existing `src/nostr/relay-client.mjs` WebSocket REQ client.

## Global Constraints

- Kill switch: KV `community_labels_enabled`, default off (absent = off). Deploy ≠ activate.
- KV settings with code defaults: `community_label_threshold` = 3, `strike_warning_count` = 3, `community_sweep_batch_limit` = 50, cursor key `community_labels_cursor`.
- Count only distinct authors with a Divine NIP-05 identity (`https://names.divine.video/api/username/by-pubkey/<hex>`, `found: true`), KV-cached 24h; lookup failure = not counted.
- Exclude the moderation account's own events and the video creator's events from tallies.
- Only labels normalizing to the known content-warning vocabulary count (port of mobile `ContentLabel` values + aliases).
- Publish-once per (video, label) via `community_label_decisions` PK; decision row written only after successful publish.
- Strike only when the crossed label was absent from the creator's self-labels on the video event; warning DM once per escalation level.
- Never truncate Nostr IDs. No secrets in code. Conventional-commit PR title. PR must explicitly call out changed relay-publishing/moderation behavior.
- Verify with `npm run lint` + `npm test` before every commit.

---

### Task 1: D1 migration + data access (`d1.mjs`)

**Files:** Create `migrations/010-community-labels.sql`, `src/community-labels/d1.mjs`, `src/community-labels/d1.test.mjs`

**Interfaces produced:**
- Migration: `community_label_decisions(video_event_id, label, vote_count, published_event_id, video_sha256, creator_pubkey, created_at, PK(video_event_id,label))`; `community_strikes(creator_pubkey, video_event_id, label, created_at, PK(creator_pubkey,video_event_id,label))`; `community_strike_warnings(creator_pubkey, strike_count, sent_at, PK(creator_pubkey,strike_count))`.
- `hasDecision(db, videoEventId, label) -> bool`
- `recordDecision(db, {videoEventId, label, voteCount, publishedEventId, videoSha256, creatorPubkey, now}) -> void` (INSERT OR IGNORE)
- `recordStrike(db, {creatorPubkey, videoEventId, label, now}) -> void` (INSERT OR IGNORE)
- `strikeCount(db, creatorPubkey) -> int`
- `warningSentAt(db, creatorPubkey, strikeCount) -> bool` / `recordWarning(db, {creatorPubkey, strikeCount, now})`
- `listStrikeSummary(db, {limit}) -> [{creator_pubkey, strikes, last_at}]` ordered desc

Steps: failing tests against a D1 test double (follow `src/creator-delete/d1.test.mjs` harness — check whether it uses miniflare D1 or a stub; mirror it) → run red → implement → green → commit `feat: community label decision/strike tables + access (#180)`.

### Task 2: KV config (`config.mjs`)

**Files:** Create `src/community-labels/config.mjs`, `src/community-labels/config.test.mjs`

**Interfaces produced:**
- `isEnabled(kv) -> bool` (KV `community_labels_enabled` === 'true')
- `getThreshold(kv) -> int` (default 3, parse-int-safe)
- `getWarningCount(kv) -> int` (default 3)
- `getBatchLimit(kv) -> int` (default 50)
- `getCursor(kv) -> int` (seconds; default now-24h on first run) / `setCursor(kv, seconds)`

Tests: defaults when keys absent, parse of stored values, garbage value falls back to default, enabled only on exact 'true'. Red → green → commit `feat: KV-backed community label settings (#180)`.

### Task 3: Divine identity gate (`identity.mjs`)

**Files:** Create `src/community-labels/identity.mjs`, `src/community-labels/identity.test.mjs`

**Interfaces produced:**
- `isDivineIdentity(pubkey, {kv, fetchImpl, now}) -> bool` — GET name-server by-pubkey, `found === true`; KV cache key `divine_identity:<pubkey>` with `{value, at}`, TTL 24h; on fetch error or non-200 return false and do NOT cache (retryable).
- `resolveDivineAuthors(pubkeys, deps) -> Map<pubkey,bool>`

Tests: found/not-found/500/network-throw, cache hit (fetch called once), error not cached, lowercase normalization. Red → green → commit `feat: Divine-identity gate with KV cache (#180)`.

### Task 4: Relay fetchers (extend `relay-client.mjs`)

**Files:** Modify `src/nostr/relay-client.mjs`, extend its existing test file (locate `relay-client.test.mjs`; if absent, create `src/nostr/relay-client.community.test.mjs` using the repo's mock-WebSocket pattern)

**Interfaces produced (follow `fetchKind5EventsSince` shape exactly):**
- `fetchLabelEventsSince(sinceSeconds, relayUrl, env) -> Event[]` — REQ `{kinds:[1985], since}` (namespace filtered by callers; relays may not index `#L`)
- `fetchLabelEventsForVideo({eventId, addressableId}, relayUrl, env) -> Event[]` — REQ `{kinds:[1985], '#e':[eventId]}` plus `{kinds:[1985], '#a':[addressableId]}` when present, deduped by event id

Red → green → commit `feat: kind 1985 relay fetchers (#180)`.

### Task 5: Pure decision module (`decision.mjs`) — the Osprey seam

**Files:** Create `src/community-labels/decision.mjs`, `src/community-labels/decision.test.mjs`

**Interfaces produced (NO I/O in this module):**
- `KNOWN_LABELS` + `normalizeLabel(value) -> string|null` (port of mobile ContentLabel values + aliases: nsfw→nudity, gore/graphic-violence→graphic-media, pornography/explicit→porn, hate-speech/offensive→hate, recreational-drug→drugs, weapon→violence, sexual-content→sexual, underscore/space→hyphen, lowercase)
- `extractVotes(labelEvents, {moderationPubkey, creatorPubkey}) -> Map<label, Set<authorPubkey>>` — only `['l', value, 'content-warning']` tags; skips moderation account + creator authors; skips unknown labels
- `decideCrossings(votesByLabel, divineByAuthor, threshold) -> [{label, voteCount}]` — distinct Divine authors >= threshold
- `creatorSelfLabels(videoEvent) -> Set<label>` — content-warning `l` tags + `content-warning` tag values on the kind 34236 event, normalized
- `strikesFor(crossings, selfLabels) -> [{label}]` — crossings whose label is not self-applied

Tests: threshold boundary 2-vs-3, same author thrice = 1, creator/moderation excluded, alias normalization, unknown label dropped, namespace mismatch dropped, malformed tags safe, self-labeled crossing yields no strike (incl. alias-form self-label), multi-label events. Red → green → commit `feat: pure community label decision module (#180)`.

### Task 6: Publisher source passthrough

**Files:** Modify `src/nostr/publisher.mjs` (createLabelEvent/publishLabelEvent source handling), extend `src/nostr/publisher.test.mjs`

**Change:** allow `source: 'community'` passthrough (currently coerced to `human-moderator`): `const source = ['automated','community'].includes(labelData.source) ? labelData.source : 'human-moderator'`; `verified = source === 'human-moderator'`; content line for community: `Community consensus flagged: This content contains <label> (N distinct reporters)` — pass `voteCount` via labelData and use in place of confidence percent when source is community.

Tests: community source emits `['l', label, 'content-warning', metadata]` with `source:'community'`, `verified:false`, correct content string; existing automated/human cases unchanged. Red → green → commit `feat: community source for kind 1985 label publishing (#180)`.

### Task 7: Sweep orchestrator (`sweep.mjs`)

**Files:** Create `src/community-labels/sweep.mjs`, `src/community-labels/sweep.test.mjs`

**Interface produced (DI shape mirrors `runCreatorDeleteCron`):**
```js
export async function runCommunityLabelSweep({
  db, kv, now,
  fetchLabelsSince,     // (since) -> Event[]
  fetchLabelsForVideo,  // ({eventId, addressableId}) -> Event[]
  fetchVideoEvent,      // (eventId) -> Event|null
  isDivine,             // (pubkey) -> bool
  publishLabel,         // ({videoEventId, sha256, label, voteCount}) -> {published, eventId}
  sendWarningDm,        // ({creatorPubkey, strikeCount, videoSha256}) -> {sent}
  moderationPubkey,
}) -> {swept, published, strikes, warned, cursorAdvanced}
```
Logic: cursor → poll since (explicit page limit; a full page caps the watermark at the newest vote seen) → group by target video with earliest new vote → sort oldest-first, cap at batch limit → per video: fetch video event (skip if missing, throw on transient), fetch all its label events, decide via Task 5, skip labels with existing decisions, publish → record decision (+vote count, sha256 from video event tags) → record strike if warranted → warning check (count, once per level) → DM. The cursor is a watermark persisted every tick: it advances to just before the earliest vote of any deferred or failed video, or to now on a fully clean tick, so deferred videos drain across ticks and no vote is silently dropped (idempotency via PKs makes re-sweeps safe).

Tests (mock deps): end-to-end crossing publishes once and re-sweep publishes zero; publish failure leaves no decision row + no cursor advance; strike only when not self-labeled; DM sent exactly once per level; batch cap defers excess videos without advancing cursor; missing video event skipped without wedging the sweep; empty poll advances cursor. Red → green → commit `feat: community label sweep orchestrator (#180)`.

### Task 8: Wiring — cron branch + admin endpoint

**Files:** Modify `src/index.mjs` (scheduled handler `*/5 * * * *` branch + admin route), extend `src/index.test.mjs` (or nearest admin-endpoint test file)

- Cron: inside the existing `*/5` branch, `if (await isEnabled(env.MODERATION_KV))` → build deps from real implementations (Tasks 3/4/6, `sendModerationDM` with a new `COMMUNITY_MISLABEL_WARNING` template added to dm-sender TEMPLATES) and call `runCommunityLabelSweep`, logging the result summary. Wrap in try/catch so a sweep failure cannot break the other `*/5` jobs.
- Admin: `GET /admin/api/community-strikes` behind the existing admin auth pattern, returns `listStrikeSummary` (limit 100) as JSON.

Tests: kill switch off → sweep not invoked; endpoint 401 without auth; endpoint returns ranked JSON with auth (follow neighboring admin endpoint tests). Red → green → commit `feat: wire community label sweep cron + strikes admin endpoint (#180)`.

### Task 9: Full verification + PR

- `npm run lint` clean, `npm test` fully green.
- Re-read spec; confirm each requirement maps to shipped code.
- PR (draft) to main: conventional title `feat: authoritative community content-warning aggregation (#180)`; description = summary, motivation (#180 / divine-mobile#4771), explicit callout of new relay-publishing + moderation-outcome behavior, kill-switch default-off rollout plan, manual validation plan (staging KV enable), linked issue.

## Self-Review notes

- Spec coverage: poll/cursor (T2,T4,T7), evaluate+identity (T3,T5), auto-apply publish-once (T1,T6,T7), strikes+warning DM (T1,T7,T8), admin surface (T8), kill switch (T2,T8), Osprey seam purity (T5 constraint), failure posture (T7 tests), batch cap (T2,T7).
- Interfaces consistent across tasks (names verbatim).
- No placeholders; test intent enumerated per task.
