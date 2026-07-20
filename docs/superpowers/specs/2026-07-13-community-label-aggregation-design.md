# Authoritative community content-warning aggregation

Issue: #180 (backend half of divinevideo/divine-mobile#4771).
Status: design approved (decisions confirmed with Matt 2026-07-13).

## Problem

The mobile app (divine-mobile PR #5720) lets viewers publish NIP-32
kind 1985 `content-warning` labels ("votes") on videos whose creators
failed to self-label, and shows a client-side advisory warning at a
local threshold. That client threshold is provisional by design. The
issue's operative ask — "once a configurable threshold of reports is
reached, the system should automatically apply the tag to the video,"
plus strikes/warnings for repeat mislabelers — requires one
authoritative actor acting for all clients. That actor is this worker:
it holds the moderation identity, the label publisher, D1/KV state,
cron triggers, and the relay-admin service binding.

## Confirmed decisions

- **Threshold:** distinct-author count per (video, label), counting
  only authors with a Divine NIP-05 identity (name-server `by-pubkey`).
  Value from KV `community_label_threshold`, code default **3** —
  runtime-configurable without a deploy.
- **Strike policy:** a strike = one of a creator's videos crosses the
  community threshold for a label the creator did **not** self-apply.
  Strikes are recorded in D1. At KV `strike_warning_count` (default
  **3**) the moderation account DMs the creator a warning, once per
  escalation level. **Bans are never automated** — repeat offenders
  surface via an admin endpoint for human review; humans use the
  existing relay-manager ban tooling.
- **Kill switch:** KV `community_labels_enabled` (default **off**).
  Deploying is not activating. This is also the Osprey cutover lever.

## Architecture

One new module tree, one new cron branch, two D1 tables. Everything
else reuses production-exercised plumbing in this worker.

### Data flow (5-minute cron, behind the kill switch)

1. **Poll:** query the relay for kind 1985 events in the
   `content-warning` namespace with `since = KV cursor`, via the
   existing generic WebSocket REQ client (`src/nostr/relay-client.mjs`)
   — the same poll-with-cursor loop the creator-delete cron uses.
2. **Group:** bucket new votes by target video (`e` / `a` tags).
   Discard: events from the moderation account itself, label values
   that do not normalize to the known content-warning vocabulary
   (mirror of the mobile `ContentLabel` set), and malformed targets.
3. **Evaluate (pure decision module):** for each touched video, query
   the relay for **all** kind 1985 `content-warning` events targeting
   that video (`#e` / `#a` filters — same shape as the mobile
   repository's query), so the tally is complete rather than
   incremental. Count distinct authors per label, excluding the video
   creator's own events. Gate each distinct author through the
   name-server `by-pubkey` check (`found: true` required), cached in
   KV for 24h (matches the moderation NIP-05 TTL convention; failures
   count as not-Divine — conservative). A label crosses when
   `distinctDivineAuthors >= threshold`.
4. **Auto-apply:** for each crossing not already recorded in
   `community_label_decisions`, publish one authoritative kind 1985
   via the existing `publishLabelEvent` (targets `e` + `x`; the mobile
   app already renders moderation-account labels through its
   trusted-labeler path — zero app changes). Record the decision row
   only after successful publish (publish-once dedup; failures retry
   next tick).
5. **Strikes:** with each recorded decision, if the crossed label was
   absent from the creator's self-labels on the video event, insert a
   `community_strikes` row. When a creator's strike count reaches the
   warning threshold and no warning at that level has been sent, DM
   the creator via the existing moderation-DM path and record the
   warning (send-once).
6. **Advance the watermark.** The cursor is a watermark persisted every
   tick: videos process oldest-first by earliest new vote, and the
   watermark advances to just before the earliest vote of any deferred or
   failed video (so no vote is ever behind it unprocessed). A fully clean
   tick advances to `now`, or to the newest vote seen when the since-poll
   page came back full (possible relay truncation). Retried videos are
   safe to re-process (all steps idempotent).

### D1 schema (new migration)

```sql
CREATE TABLE community_label_decisions (
  video_event_id TEXT NOT NULL,
  label          TEXT NOT NULL,
  vote_count     INTEGER NOT NULL,
  published_event_id TEXT NOT NULL,
  video_sha256   TEXT,
  creator_pubkey TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (video_event_id, label)
);

CREATE TABLE community_strikes (
  creator_pubkey TEXT NOT NULL,
  video_event_id TEXT NOT NULL,
  label          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (creator_pubkey, video_event_id, label)
);

CREATE TABLE community_strike_warnings (
  creator_pubkey TEXT NOT NULL,
  strike_count   INTEGER NOT NULL,
  sent_at        INTEGER NOT NULL,
  PRIMARY KEY (creator_pubkey, strike_count)
);
```

Full 64-char hex everywhere; never truncate Nostr IDs.

### Admin surface

`GET /admin/api/community-strikes` (existing admin auth): creators ranked
by strike count with per-strike detail — the human-review feed for ban
decisions. No write endpoints in v1.

### Module layout (the Osprey seam)

```
src/community-labels/
  decision.mjs      # PURE: votes in -> crossings/strikes out. No I/O.
  sweep.mjs         # cron orchestration: poll, evaluate, act, cursor
  identity.mjs      # by-pubkey check + KV cache
  d1.mjs            # decisions / strikes / warnings queries
  config.mjs        # KV-backed settings with code defaults
```

**Osprey rebuild contract:** when Osprey becomes the decisions engine,
`decision.mjs` + the poll half of `sweep.mjs` are deleted and replaced
by an Osprey rule; the actuator (publish, DM, strike tables, admin
surface) stays exactly as built. Cutover = flip
`community_labels_enabled` off as the Osprey rule goes live. The pure
module must therefore never grow I/O or worker-specific dependencies.

## Failure posture

- Publish failure → no decision row → retried next tick.
- DM failure → no warning row → retried next tick.
- Identity lookup failure → author not counted (conservative).
- Cursor advances only on full success; sweeps are idempotent, so
  re-processing a window is harmless (dedup by primary keys).
- The sweep is bounded per tick (cap on videos evaluated per run;
  KV `community_sweep_batch_limit`, default 50) to stay far inside
  Worker CPU/subrequest limits; excess work rolls to the next tick.

## Not in v1 (documented, deliberate)

- Retraction / un-labeling (NIP-32 has no un-vote; moderators can
  NIP-09-delete a published label manually).
- Automated bans (human-only, via existing tooling).
- Reputation weighting, rate limits, account-age gating, and brigading
  / velocity detection beyond the Divine-identity gate. v1's authoritative
  trigger is intentionally the **same** simple distinct-Divine-identity
  count the client uses; hardening it against Sybil/brigading is the
  Osprey rebuild's job (the `decision.mjs` seam). See the security note
  below — this is a deliberate, stated posture, not an oversight.
- `a`-only touched-video detection. The sweep detects touched videos by
  their `e` (event id) tag; the whole pipeline is event-id-keyed, and the
  client always co-tags `e`+`a`, so purely addressable-scoped votes from
  a hypothetical other client are not evaluated.
- Funnelcake-side SQL aggregation (optimization valve if sweep cost
  ever grows; not needed at current volume).

### Security posture (v1)

The authoritative trigger is the Divine-identity gate plus the distinct-
author threshold — nothing stronger. Because Divine NIP-05 registration
is open, a small number of minted identities (default 3) can force an
authoritative label **and** a creator strike on any video, with no
velocity, account-age, or brigading guard. This is acceptable **only**
because the whole pipeline is kill-switched (default off), strikes never
auto-ban (human review via the admin feed), and the abuse-resistance the
issue asks for is deferred to the Osprey rebuild. The T&S sign-off before
enabling in prod should treat this Sybil vector as a known, accepted v1
limitation.

### Known high-volume limitations (v1)

The watermark cursor drains correctly at the volume this feature ships
for. Three residuals appear only under load well beyond v1 (backlog
above the batch cap, or >1000 votes in one poll window) and are all
observable via the held-watermark-age log:

- **Truncated poll window (>1000 votes/window).** Funnelcake truncates
  newest-first, so a full page has dropped the oldest votes. The sweep
  now **holds and freezes the cursor** on a full page rather than
  advancing past the unseen older votes, so there is no silent drop in
  steady state or on cold start. The cost is a wedge: because a held
  cursor's window never sheds votes on its own, sustained ≥1000/window
  progress on the oldest stays stuck until new-vote arrivals slow enough
  that a poll returns below the page limit — it does **not** self-heal
  tick-to-tick while the burst continues. New content still labels (it
  rides the newest-N page) and the wedge is observable via the
  held-watermark-age log. Scale fix: page the window backward with
  `until`. Fast-follow.
- **Batch-boundary timestamp ties.** When the first deferred video shares
  its earliest-vote second with in-batch videos, those keep their slots
  and the deferred video is starved. Needs backlog above the batch cap
  plus same-second ties.
- **Permanently-failing oldest video.** A video whose publish fails every
  tick pins the watermark, so videos beyond the batch cap never get a
  turn (in-cap videos still process idempotently). Needs backlog above
  the cap plus a persistent per-video failure.

The last two share one fast-follow: batch-prioritise not-yet-processed
videos and add a bounded-retry / dead-letter for persistent per-video
failures — i.e. the per-video D1 processed-state that was consciously
deferred at design time in favour of the simpler watermark. Acceptable
for the staged, kill-switched, low-volume v1 rollout.

## Testing (Vitest, existing mock-relay patterns)

- `decision.mjs`: threshold boundary (2 vs 3), distinct-author dedup,
  creator self-vote exclusion, moderation-account exclusion, unknown
  label rejection, strike determination (no strike when self-labeled).
- `sweep.mjs`: publish-once (no republish on re-sweep), cursor
  advance/hold semantics, batch cap, kill-switch off = no-op.
- `identity.mjs`: found/not-found/error/cache-hit, 24h expiry.
- `d1.mjs`: idempotent inserts, warning send-once per level.
- Admin endpoint: auth-gated, ranking shape.

## Operational notes (per AGENTS.md)

This changes relay publishing behavior and moderation outcomes: the PR
description must call that out explicitly. Rollout: deploy dark →
verify sweep logs with kill switch off → enable in staging KV →
observe → enable in prod KV.
