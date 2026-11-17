# Messages page filters: design

Status: draft for review, 2026-11-16
Scope: `src/admin/messages.html`, `src/nostr/dm-store.mjs`, the `/admin/api/messages*` routes in `src/index.mjs`, and their tests.

## Why

The admin Messages page is where Trust & Safety read and answer NIP-17 DMs sent to the shared moderation identity. The list mixes three kinds of traffic:

- automatic report DMs the app sends on a user's behalf
- automated messages we send (moderation notices, report outcomes, community warnings)
- messages a person actually typed to us, some of them from minors in age review

The team asked for three things:

- hide the automatic traffic and see the conversations with people
- see who has actually written to us
- stop real questions from getting buried

Today each row shows only the type of its latest message, so a typed "hi" disappears behind the next automatic report. Name search works only over the pages already loaded.

The options were put to the team in a clickable preview. They chose filter chips, last-message row labels, counts on the filters and a 30-day window. Matt chose the rest (below).

## Goals

- One-tap filters that narrow the conversation list on the server, so a filter pages through every matching conversation, not just the ones already loaded.
- A "Waiting on us" filter that answers: who typed to us recently and hasn't had a human reply since?
- A count on each filter, so the team can see at a glance whether anything is waiting.
- A shared "No reply needed" action, so wrap-up messages like "thanks" stop counting as waiting.

## Non-goals

- New classification columns: the notice action (suspended, banned, restored...), the report category or the report variant. Filters use the existing `message_type` values only.
- Relabelling the report DMs that were mislabelled before 12 August (see Constraints).
- Per-moderator state. The moderation identity is shared, so "done", unread and dismissed are shared too.
- Combining filters (option B), or a dropdown (option C).
- Changing the row badge. Rows keep today's last-message badge.
- Server-side search over message content (a separate, existing follow-up).
- The thread header's full-npub copy that Charlie asked for. It is small and worth doing, but as its own PR.

## Anti-goals

- A filter that hides a conversation someone needs to answer. Every filter is opt-in, "All" is the default, and opening a conversation always shows every message.
- Automated messages counting as our reply. A notice we sent must never take a person out of "Waiting on us".
- Filtering client-side over loaded pages. #206 moved paging to the server for this reason.

## Constraints

**The creator_reply mislabel.** Before #194 (merged 2026-08-12 06:32 UTC, deployed by CI on merge), report DMs were detected only by a JSON shape no client sent, so every report DM was stored as `creator_reply`, the same type as a typed message. A production count confirms it: almost all incoming `creator_reply` rows from before the cutoff carry the app's report wording (a `Reason: ...` line). Those rows were never relabelled. The one-year retention (#219) is decided but not switched on (`DM_LOG_RETENTION_ENABLED = "false"`, `wrangler.toml`), so they stay indefinitely. Treat the cutoff as permanent: no "remove later" TODO. So a `creator_reply` row is only trusted as typed by a person if it was logged after #194 deployed.

**Untagged reports after the cutoff.** The reader marks a DM as a report only if it carries a `sha256`, `report_type` or `social.nos.ontology` label tag (`dm-reader.mjs:351-357`). A report from an older app without those tags is still logged as `creator_reply` today. Production counts show a small number of these in the weeks after the cutoff and none among the typed rows of the 30 days to 2026-11-16, so they have stopped reaching Waiting on us. v1 accepts this as a known limitation and adds no content-matching rule.

**`dm_log.created_at` is the time we logged the row** (`CURRENT_TIMESTAMP` on insert), not the Nostr event's time. That suits the cutoff, because classification happens when a row is logged. It also means order is the order we logged rows, not the order they were sent (see Known limitations).

**Schema changes go in code.** CI deploys on merge but never runs `wrangler d1 migrations apply`. A new table needs an `ensure`/`init` function called on every path that reads it, as `initDmReadStateTable` does, plus a matching migration file for the record.

## What the team decided

| Choice | Decision | By |
|---|---|---|
| Layout | A: a row of filter chips above the list, one active at a time, "All" to go back | team, then Matt broke the A/B tie |
| Row labels | Last message only, as today | team |
| Counts | Shown on each chip | team |
| Waiting window | 30 days | team |
| Matching | "Ever contained": a conversation matches if any of its messages qualifies | Matt |
| Default | Everything visible; filters are opt-in | Matt |
| Typed-message cutoff | Only `creator_reply` rows logged after #194 count as typed by a person | Matt |
| What counts as our reply | Only `moderator_reply`, from any client signed as the moderation identity. `moderation_notice`, `report_outcome` and `community_warning` never count | Matt |
| No reply needed | In v1: a shared action that takes a conversation out of Waiting on us until the person writes again | Matt |

## The filters

Terms used below:

- **Typed row**: `direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= CUTOFF`.
- **Our reply**: `message_type = 'moderator_reply'`. This covers panel replies (`sendModeratorReply`) and self-copies of replies sent from other clients, which the reader logs as outgoing `moderator_reply` (`dm-reader.mjs:494-496`).
- **CUTOFF**: `'2026-08-13 00:00:00'` UTC. See Builder's calls.

| Chip | A conversation matches when... |
|---|---|
| All | always (today's list) |
| Waiting on us | its latest typed row is within the last 30 days, is later than its latest "our reply" row (if any), and is later than its "No reply needed" mark (if any) |
| A person wrote | it has at least one typed row |
| Reports | it has at least one `conversation_report` row |
| Notices | it has at least one `moderation_notice` row |
| Outcomes | it has at least one `report_outcome` row |
| Warnings | it has at least one `community_warning` row |

Order within every filter stays newest activity first (`last_message_at DESC, id DESC`), as today.

The "A person wrote" chip's description points people at Waiting on us, because "A person wrote" includes conversations we've already answered. Suggested tooltip: "Everyone who has typed to us since 13 August, answered or not. For the ones that need a reply, use Waiting on us." This answers the clarity question Matt raised after the preview went out.

## Counts

Each chip shows how many conversations match it ("All" shows the total). Counts come from the server, from the same per-conversation flags the list filter uses, so a chip's count always equals the number of rows that filter can page through. Counts reload on page load, on switching chips, after Refresh/sync, after sending a reply, and after No reply needed or its undo.

## No reply needed

- **Where:** a button in the open thread's header, shown only while that conversation is in Waiting on us (read from the conversation's `state` endpoint, see Server shape). It stays disabled until the open thread has rendered, and while it reloads, because the mark needs the newest message id the thread showed (decided 2026-11-17).
- **Rows already loaded:** after a reply or No reply needed, the counts reload, but the row stays in the currently loaded Waiting list until the next fetch. Removing the row would make it vanish under the moderator mid-task, so instead the row is shown greyed. Greying alone doesn't keep paging correct: the server has already dropped the conversation from Waiting, so on Waiting on us the page moves its next-page offset back by one for each row that stops waiting, and forward by one if Undo makes it wait again. Without that, the next page would skip one waiting conversation per row handled. A Refresh sets the offset from the fresh page alone, so a change that lands while a Refresh is fetching is dropped, not carried into the next page. Another moderator's actions can still shift the list until the next Refresh, which is inherent to offset paging. The row is shown greyed, with a tooltip saying it's no longer waiting on us (added 2026-11-16 after Matt's review of the local preview). Grey is derived, never stored: a row is greyed only when the active chip is Waiting on us and that row's current `waiting` is false. The page keeps each loaded row's `waiting` up to date from every state response (mark, undo, a reply sent, and any reload of the open conversation's state), so:
  - it goes grey on No reply needed or a reply sent from the thread;
  - it returns to normal on Undo, or when a later state or list response says it's waiting again (the person wrote back);
  - switching chips, Refresh or reload fetches fresh rows, so nothing grey survives;
  - it's never greyed on any other chip.
- **Effect:** records a shared mark for the conversation covering what the moderator saw. The page sends the newest message id its open thread showed; the mark is the current time, or one second before the first typed message logged after that id. The open thread doesn't refresh itself while the inbox sync logs new messages every five minutes and on Refresh, so marking the current time alone could cover a message nobody read. If the mark leaves the conversation waiting, the page keeps the button and reloads the thread to show that message. Otherwise the conversation leaves Waiting on us (and its count) for everyone. A typed message logged after the mark puts it back.
- **Undo:** after clicking, the header shows "Marked no reply needed · Undo" until the conversation is closed or changed. Undo deletes the mark.
- **Does not:** send anything, change the unread dot, or hide the conversation from All or any other chip.
- **Storage:** a new table, `dm_conversation_reply_state (conversation_id TEXT PRIMARY KEY, no_reply_needed_at TEXT NOT NULL)`, ensured in code like `dm_conversation_read_state`, plus a migration file. `pruneExpiredDmLog` deletes orphaned rows in the same batch as orphaned read-state rows. The prune is off in production today (see Constraints) but has to work when it's switched on. Because a missing table fails the whole D1 batch, including the `dm_log` delete, the prune path must ensure both the new table and `dm_conversation_read_state` before it runs. Today it ensures neither.

## Server shape

- `getConversations(db, { limit, offset, moderatorPubkey, filter })`. `filter` is one of `waiting`, `person`, `reports`, `notices`, `outcomes`, `warnings`, or absent for All. An unknown value returns 400 at the route rather than silently returning everything.
- The per-conversation flags come from conditional aggregation in the existing `latest` GROUP BY over `dm_log` (for example `MAX(CASE WHEN <typed row> THEN created_at END) AS last_typed_at`, `MAX(CASE WHEN message_type = 'moderator_reply' THEN created_at END) AS last_reply_at`, `SUM(CASE WHEN message_type = 'conversation_report' THEN 1 ELSE 0 END) AS report_count`, and so on). The filter is a WHERE over those flags, placed before ORDER BY/LIMIT. Values are bound parameters, never interpolated. This is the same single scan `getConversations` already does, so no new index.
- Each row gains `waiting` (boolean) so the client knows whether to show No reply needed.
- Each row also gains `last_typed_message` and `last_typed_at`: the content and time of the conversation's latest typed row (the same definition `last_typed_at` already uses), or null when there is none. Taken from the row whose id is the latest typed row's id, via one LEFT JOIN on the existing query.
- Counts come from a new `GET /admin/api/messages/counts` returning `{ all, waiting, person, reports, notices, outcomes, warnings }`. The list route keeps returning a bare array, so the response shape doesn't change for existing clients. **Route order matters:** the thread route (`GET /admin/api/messages/:pubkey`) matches any five-segment path and doesn't validate the pubkey, so a counts route registered after it would silently return an empty thread with a 200. Register counts before the thread route, as `/sync` is, and pin that with a route test.
- `GET /admin/api/messages/:pubkey/state` returning `{ waiting, no_reply_needed_at }` for one conversation. The client needs this because a conversation opened by identifier lookup, or one beyond the loaded pages, has no list row to read `waiting` from, and the thread route's bare-array response shouldn't change. The list's per-row `waiting` and this endpoint share one store-level definition, so they can't disagree.
- `POST /admin/api/messages/:pubkey/no-reply-needed` and `DELETE` on the same path, with the same auth and pubkey validation as `/read`. The POST takes an optional JSON body `{ seen_through_id }` (a non-negative integer, else 400; a body that isn't a JSON object is also a 400); with no body the mark is the current time. Both return `{ success, waiting, no_reply_needed_at }`.
- The window (30 days) and CUTOFF are named constants in `dm-store.mjs`, with a comment explaining each.

## Client shape

- A chip row in `.conversation-list-header`, under the search box: `All · Waiting on us · A person wrote · Reports · Notices · Outcomes · Warnings`, each with its count.
- Picking a chip resets paging (offset 0, clear the list and the dedupe set) and fetches with `&filter=`. The append-retry row (#208) and dedupe-on-append keep working per filter.
- If a local waiting-state change moves the boundary while a Waiting page is loading, retry that page at the corrected offset. Its server snapshot may precede or follow the change, so adjusting only the offset after accepting the response can still skip a conversation.
- That includes a conversation that isn't loaded yet, such as the open thread just after switching to Waiting on us, or one opened from search: it may sit inside the page being fetched, so a change to it also retries that page, with the offset unchanged because its position isn't known.
- Waiting pages pause while a local reply, No reply needed or Undo is in flight, including the reply-state refresh after the write. The server can apply the write before its response reaches the page, so waiting only for the row flag to change leaves a gap.
- Reopened-thread state reads stay in that pause until the winning response reconciles the row. If an action or state read fails, the next Waiting page starts fresh at offset zero because the old offset can no longer be trusted.
- **Row preview in the people chips** (added 2026-11-16 after Matt's review). On Waiting on us and A person wrote, each row shows the person's latest typed message, its time, and a Creator Reply badge, instead of the conversation's last message, because a later automated notice would otherwise hide what the person said. All and the automated chips keep the team's last-message labels. Row order is unchanged (latest activity in either direction).
- Name search keeps filtering the loaded rows client-side, so within a chip it narrows that chip's loaded rows. Identifier lookup (Enter) still opens the matching conversation whatever chip is active.
- The active chip is remembered per browser tab (sessionStorage, wrapped in try/catch), so a new tab starts on All, the default. A followed `?pubkey=` link always opens on All so the linked conversation is in the list (decided 2026-11-17).

## Known limitations (stated in the UI help text and the PR)

- **Before 12 August:** report DMs logged before #194 look like typed messages, so typed messages from before 13 August don't count. Those conversations stay in All and in search, but miss A person wrote and Waiting on us, and their reports miss Reports.
- **Untagged reports from older apps count as typed.** See Constraints. None reached Waiting on us in the 30 days before this design.
- **Typed spam counts as a person writing.** It shows in A person wrote and Waiting on us until someone replies or marks it No reply needed.
- **Same-second ties:** `created_at` has one-second resolution. A typed message logged in the same second as our reply or a No reply needed mark counts as handled, the same convention the unread dot uses (strictly later wins).
- **Order in one sync:** if a person's message and our reply from another client arrive in the same sync, they are ordered by when we logged them, which can be the reverse of when they were sent. A reply sent from the panel is logged immediately, so this only affects replies from other clients. The next message or reply settles it.

## Testing

D1 tests in `dm-store.test.mjs` with seeded rows covering:

- the cutoff boundary: a `creator_reply` one second before CUTOFF doesn't count, one at CUTOFF does
- each automated type in turn, logged after a typed row, leaves the conversation Waiting
- an outgoing `moderator_reply` (panel or synced self-copy) clears Waiting, and a later typed row brings it back
- the 30-day window boundary
- No reply needed clears Waiting, a later typed row brings it back, and undo restores it
- every filter pages across more than one page
- parity: for each filter, the count equals the number of rows paging returns

Route tests in `index.test.mjs` for `filter` validation, the counts endpoint (including that it isn't swallowed by the thread route), the state endpoint, and auth/validation on the new POST/DELETE. UI tests in `messages-ui.test.mjs` for the reset-on-chip-change and the button's visibility. Each guard's test must be shown to fail with the guard removed.

## Builder's calls (Claude's, for Matt to check)

1. **CUTOFF is 13 August 00:00 UTC, not 12 August.** #194 merged at 06:32 UTC on the 12th and deployed minutes later, so report DMs logged earlier that day were still mislabelled. Losing about 18 hours of typed messages is the safer side.
2. **No reply needed doesn't record who clicked.** Admin auth exposes the moderator's Access email, but nothing else in the DM tables records a person, and no one asked for it. It can be added later as a nullable column.
3. **The window is a constant, not a setting.**
4. **Unknown `filter` values return 400**, so a typo shows up rather than quietly returning All.
5. **Counts are a separate endpoint**, so the list route's response shape doesn't change.
6. **No content-matching rule for untagged reports.** Production counts show they stopped reaching the 30-day window, and a rule on report wording would need its own false-positive analysis.

## Prior work

A September worktree (`.claude/worktrees/feat+messages-filter-chips`, uncommitted) filtered by the latest message's type only (reports / notices / replies). That filed moderator replies and the pre-#194 mislabelled reports under "replies", and didn't match the decisions above. Parts are worth reusing: the bound-parameter WHERE placed before ORDER BY/LIMIT, and its tests' seeding approach.
