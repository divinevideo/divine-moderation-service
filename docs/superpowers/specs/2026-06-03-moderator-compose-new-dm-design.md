# Moderator-initiated DM compose ("New Message" from Moderation)

**Date:** 2026-06-03
**Status:** Design — pending review
**Repo:** divine-moderation-service

## Problem

A moderator cannot start a brand-new DM to a user from the Messages inbox. Today the
only way to reach someone is to reply within an existing conversation, or to follow a
context deep-link ("Message Creator →" on a video card) that hands the recipient
pubkey in via `?pubkey=`. There is no affordance to pick an arbitrary recipient and
start composing.

This blocks proactive outreach "from Moderation" that a moderator might want to
initiate (welcomes, policy clarifications, appeals follow-up, account questions) when
there is no inbound message and no specific video to anchor on.

### Verified current state

The backend is already capable; the gap is the UI plus one API behavior:

| Layer | Capable of new outbound DM today? |
|-------|-----------------------------------|
| Send (`sendModeratorReply`, `dm-sender.mjs`) | Yes — accepts any hex pubkey, NIP-17 gift-wrap (kind 1059), NIP-65 relay discovery, logs outbound-first to `dm_log` |
| API `POST /admin/api/messages/{pubkey}` | Yes — sends to any pubkey, no prior-conversation check |
| API `GET /admin/api/messages/{pubkey}` | **No** — returns 404 when no conversation exists |
| Messages UI (`messages.html`) | **No** — left panel only lists/filters *existing* conversations; no "New Message" entry point; no way to address a never-messaged user |

Because `GET` returns 404 for a never-messaged user and `loadThread()` renders any
non-OK response as "Failed to load messages," even the existing "Message Creator →"
deep-link looks broken when the creator has no prior conversation.

## Attribution / history

The DM subsystem is a joint effort, not a single author's:

- **Rabble (Evan Henshaw-Plath)** — NIP-17 DM foundation + API/admin host split (#24);
  first cut of category templates, profile resolution, and the messages UI scaffold,
  plus the `docs/dm-gaps-plan.md` roadmap (#28); QUARANTINE relay notify (#133).
- **Matthew Bradley** — unify signing to `NOSTR_PRIVATE_KEY` (#31); **rewrite the DM
  templates for clarity + content links (#45)** — this is the template code we reuse
  here; reporter notifications (#47); `/api/v1/notify` (#53); null-guard (#61);
  **"make moderation messages UI actually work" (#109)** — the messages UI that
  functions today.
- **Liz Sweigart** — dead offender-tracking cleanup (#81).
- **Seydi Charyyev** — moderation-dm-plan docs cleanup (#123).

This feature builds on all of the above. It is not "finishing Rabble's Gap 1" — it
**exposes the existing #45 action-templates to a human composer** (a different shape
than either Rabble's plan or the automated decision path).

## Goals

1. A moderator can start a new DM from the Messages inbox by addressing a recipient
   one of two impersonation-safe ways: **paste an npub/hex pubkey**, or **type a full
   nip-05 (`user@domain`) that we verify** against the domain before composing. The
   existing context deep-links continue to work.
2. The moderator can **pre-fill from an existing template** (reused, editable) or write
   free-text.
3. New / empty threads render cleanly instead of as an error, repairing both the new
   flow and the existing "Message Creator →" deep-link.

## Non-goals

- **No display-name or fuzzy search.** Display names and `name` fields in kind-0
  profiles are unverified, non-unique, and spoofable; letting a moderator believe they
  found a user by display name risks messaging an impersonator (telling the wrong
  person their content was removed, or revealing a moderation action). Recipient
  resolution is restricted to a verifiable identifier: a pubkey/npub, or a nip-05
  resolved against its domain.
- No change to the automated moderation-decision DM path (`selectTemplate` firing on
  BAN/AGE_RESTRICTED/QUARANTINE). That stays as-is.
- No new outreach-specific template copy. We reuse the existing templates verbatim
  (see "Template reuse" caveat).
- No bulk / broadcast messaging.
- No change to NIP-17 wrapping, signing identity, relay discovery, or rate limiting.

## Design

### Component 1 — Recipient resolution (UI + one new endpoint)

A "New Message" button in the Messages header opens a single recipient input with two
resolution paths and nothing else — no suggestions, no display-name matching:

1. **Paste npub/hex.** Input decodes as a valid `npub` (bech32 → hex) or is exactly
   64 hex chars. The key *is* the identity, so this needs no verification. Invalid /
   key-like-but-malformed input (bad checksum, wrong length) shows inline validation
   and does not proceed.
2. **Type a full nip-05 (`user@domain`) — verified.** On submit, the worker resolves
   the address against the domain's `.well-known/nostr.json` and returns the
   authoritative pubkey, or "no such user." This is what NIP-05 verification means: a
   `nip05` value stored in someone's kind-0 profile is only a *claim* and is
   spoofable, so we never trust an indexed nip-05 — we resolve it at the source. Only a
   successful resolution yields a recipient.

If a nip-05 doesn't resolve and the moderator is confident the user is real, the
fallback is to paste their npub/pubkey (path 1). The error copy points them there:
"Couldn't verify `<address>`. If you have their npub or pubkey, paste it instead."

On success the UI shows a confirmation line before composing, e.g.
`✓ alice@divine.video → npub1…8a3 (verified via divine.video)`, then calls the
existing `selectConversation(hex)`, which reveals the working compose box and loads the
thread. No new send path is needed — `POST /admin/api/messages/{pubkey}` already
handles new recipients.

**New backend helper** — `src/nostr/nip05.mjs`:

```js
// Resolve "user@domain" to an authoritative hex pubkey via the domain's
// .well-known/nostr.json. Returns { pubkey } or null (not found / malformed /
// unreachable). https only; well-known path only.
export async function resolveNip05(address, env) { ... }
```

Resolution rules:
- Split on the last `@`; validate local part chars (`a-z0-9-_.`) and a plausible
  domain. Reject otherwise (no fetch).
- Fetch `https://{domain}/.well-known/nostr.json?name={urlencoded name}`.
- Read `json.names[name]`; require a 64-hex pubkey. Missing → not found.
- Short KV cache (1h) keyed by address, since nip-05 → pubkey can change and a
  moderation tool values freshness; cache nulls briefly to avoid hammering.

**New route** in `src/index.mjs` (auth-gated like the other `/admin/api/*` routes):

```
GET /admin/api/nip05/resolve?address=user@domain
  -> 200 { pubkey, address, domain }   on verified resolution
  -> 404 { error: 'not found' }        when the domain has no such name
  -> 400 { error: 'invalid address' }  for malformed input
```

No Funnelcake / profile-search dependency is introduced.

### Component 2 — Template picker (reuse existing #45 templates)

The existing templates in `dm-sender.mjs` are functions
`(reason, sha256, title, publishedAt)` and are already null-safe for compose with no
attached video: `contentSubject(null)` → "Your content", `postedDate(null)` → "",
`contentLink(null)` → bare newline.

**Expose the creator-facing subset for manual selection.** Add to `dm-sender.mjs`:

```js
// Templates a moderator may pre-fill manually. Excludes REPORT_OUTCOME_* (reporter-
// facing auto-sends with a different signature) and is the single source of truth
// shared with the automated path.
export const COMPOSE_TEMPLATES = [
  { key: 'PERMANENT_BAN',     label: 'Content removed' },
  { key: 'AGE_RESTRICTED',    label: 'Content age-restricted' },
  { key: 'QUARANTINE',        label: 'Content under review' },
  { key: 'ACCOUNT_SUSPENDED', label: 'Account suspended' },
];

// Render a compose template to editable text. category is optional and only
// specializes the "was found to {reason}" clause for the three content actions.
export function renderComposeTemplate(key, { category = null, sha256 = null,
  title = null, publishedAt = null } = {}) {
  // ACCOUNT_SUSPENDED takes no args; the rest go through selectTemplate so category
  // and content-link handling stay identical to the automated path.
}
```

**New route** in `src/index.mjs`:

```
GET /admin/api/dm-templates?sha256=&title=&publishedAt=&category=
  -> 200 [{ key, label, body }]   // body rendered (with optional video context)
```

When the picker is opened from a plain New Message (no video context), `body` renders
with the generic subject and no content link. When opened from a video deep-link, the
sha256/title/publishedAt can be threaded through so the body pre-fills the link.

**UI:** a template dropdown above the compose textarea. Selecting an entry inserts its
`body` into the (editable) textarea; the moderator can edit or replace it. Default is
empty (free-text).

#### Template reuse caveat (documented tradeoff)

These templates are **moderation-outcome notifications**, not general outreach copy.
Reusing them for a proactive message to a user who has had no moderation action is
mechanically fine (null-safe) but the wording assumes an event occurred. Per the
decision to reuse rather than author a new set, the dropdown is framed as
"pre-fill & edit" — the moderator is expected to edit when the context doesn't match.
If proactive-outreach-specific templates are wanted later, they can be added to
`COMPOSE_TEMPLATES` without structural change.

### Component 3 — Empty-thread fix

Change `GET /admin/api/messages/{pubkey}` (`index.mjs`) to return
`200 { messages: [] }` instead of `404` when `getConversationByPubkey` finds nothing.
Update `loadThread()` (`messages.html`) so a non-OK response still surfaces an error,
but an empty list renders a friendly empty state ("No messages yet — start the
conversation") rather than "Failed to load messages." This repairs the new-message
flow and the pre-existing "Message Creator →" deep-link for never-messaged creators.

## Data flow (new message)

```
New Message → paste npub/hex            → (decode, no network)
            → or type full nip-05       → GET /admin/api/nip05/resolve
                                          → .well-known/nostr.json → authoritative pubkey
   → confirm recipient → selectConversation(hex)
   → (optional) pick template → GET /admin/api/dm-templates → insert editable body
   → edit / free-text
   → Send → POST /admin/api/messages/{hex}
          → sendModeratorReply()  [existing, unchanged]
          → NIP-17 gift-wrap (kind 1059) from NOSTR_PRIVATE_KEY
          → NIP-65 relay discovery → publish → log outbound-first to dm_log
```

## Error handling / edge cases

- Invalid npub / wrong-length hex → inline validation, no send.
- Malformed nip-05 (no `@`, bad chars) → 400, inline message, no fetch.
- nip-05 not found / domain unreachable → "Couldn't verify `<address>`. If you have
  their npub or pubkey, paste it instead." (steers to the paste fallback).
- Per-recipient rate limit (5 / 60s, warn-only) is unchanged.
- Self-message: out of scope; no guard added (a moderator messaging the Moderation
  account is harmless and logged like any other).
- SSRF note: the `.well-known` fetch targets a moderator-supplied domain. The action
  is admin-authenticated, restricted to `https` + the fixed well-known path, so the
  exposure is minimal; documented here so it isn't a silent surprise.

## Files changed

| File | Change |
|------|--------|
| `src/index.mjs` | Add `GET /admin/api/nip05/resolve`; add `GET /admin/api/dm-templates`; change empty-thread `GET /admin/api/messages/{pubkey}` from 404 to `200 {messages:[]}` |
| `src/nostr/nip05.mjs` | New — `resolveNip05(address, env)` via `.well-known/nostr.json`, KV-cached, `null` on failure |
| `src/nostr/dm-sender.mjs` | Add `COMPOSE_TEMPLATES` + `renderComposeTemplate()`, reusing existing `TEMPLATES`/`selectTemplate` |
| `src/admin/messages.html` | "New Message" button; recipient input (paste npub/hex OR verified nip-05, with confirmation line); template dropdown over compose; friendly empty-thread copy |
| tests | `resolveNip05` (mock well-known), both new routes, the 404→200 change, `renderComposeTemplate` |

No new dependencies. No Funnelcake dependency. No schema/migration changes (`dm_log`
already supports outbound-first rows).

## Testing

Following the repo's vitest patterns:

- `resolveNip05` — returns `{pubkey}` when `names[name]` is a valid 64-hex; returns
  `null` for missing name, non-200, malformed JSON, or malformed address; never fetches
  on malformed input.
- `GET /admin/api/nip05/resolve` — auth required; 200 on verified, 404 on not-found,
  400 on malformed.
- `GET /admin/api/dm-templates` — returns the creator-facing set; renders with and
  without video context; excludes REPORT_OUTCOME_*.
- `renderComposeTemplate` — null-safe (no sha256/title) and category specialization
  matches `selectTemplate` output for the same inputs.
- `GET /admin/api/messages/{pubkey}` — returns `200 {messages:[]}` (not 404) for an
  unknown pubkey; still returns the thread for a known one.

## Relationship to `docs/dm-gaps-plan.md`

- Gap 2 (profile resolution) and Gap 4 (Message Creator link) already shipped.
- Gap 3 shipped as client-side filtering of existing conversations. This design
  deliberately does **not** extend it to display-name search; recipient resolution is
  verified-identifier-only (npub/hex or verified nip-05) for moderation-safety reasons.
- Gap 1 templates exist (action-driven, automated, policy URLs intentionally omitted);
  this **exposes** them to a human composer rather than building new ones.

## Open questions

None blocking. Future, non-blocking: proactive-outreach-specific template copy;
enabling the defined-but-omitted policy links once those pages exist (tracked by the
`dm-sender.mjs:81` NOTE and `2026-03-19-dm-alignment-design.md`); optional verified
nip-05 typeahead if discovery convenience is later wanted (must verify on selection).
