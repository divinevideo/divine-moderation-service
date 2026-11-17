# Messages Page Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side filter chips with counts, a 30-day "Waiting on us" view, and a shared "No reply needed" action to the admin Messages page.

**Architecture:** One shared SQL builder in `dm-store.mjs` computes per-conversation flags (last typed time, last reply time, per-type counts, no-reply mark) by conditional aggregation over `dm_log`. The list filter, the counts endpoint and the per-conversation state endpoint all read those flags, so they can't disagree. A new one-row-per-conversation table holds the No reply needed mark, ensured in code like `dm_conversation_read_state`. The page adds a chip row and a thread-header button.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest with `@cloudflare/vitest-pool-workers` (`env.BLOSSOM_DB` is a real D1 in tests), a single-file admin page (`src/admin/messages.html`, vanilla JS).

**Spec:** `docs/superpowers/specs/2026-11-16-dm-panel-filters-design.md`

## Global Constraints

- Typed row: `direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= '2026-08-13 00:00:00'`.
- Our reply: `message_type = 'moderator_reply'` only. `moderation_notice`, `report_outcome`, `community_warning` never count as a reply.
- Waiting window: 30 days, compared as `created_at >= datetime('now', '-30 days')`.
- Waiting = latest typed row within the window AND strictly later than the latest our-reply row (if any) AND strictly later than `no_reply_needed_at` (if any).
- Filter keys, exactly: `waiting`, `person`, `reports`, `notices`, `outcomes`, `warnings`. Absent or empty = All. Anything else = HTTP 400.
- Every timestamp written by this feature uses SQL `CURRENT_TIMESTAMP` (never a JS ISO string), so text comparison with `dm_log.created_at` stays valid (see `migrations/012-dm-read-state.sql`).
- All SQL values are bound parameters, never interpolated.
- List order stays `last_message_at DESC, dl.id DESC`. The list route keeps returning a bare array.
- Schema changes are ensured in code on every path that touches them. CI deploys on merge but never runs D1 migrations.
- Copy: no em dashes. "Divine" casing. Chip labels, exactly: `All`, `Waiting on us`, `A person wrote`, `Reports`, `Notices`, `Outcomes`, `Warnings`.
- PR title in Conventional Commit form: `feat(messages): filter chips, Waiting on us and No reply needed`.

## Review Focus

1. **Rapid chip switching.** A slow response for the previous chip must not paint over the new chip's list. → Task 4 test: `setFilter` goes through a fresh (non-append) `fetchConversations`, which bumps `conversationsGen`.
2. **Switching conversations while a state or No reply needed request is in flight.** The button must not appear for, or act on, the wrong conversation. → Task 4 test: `loadReplyState` and the mark/undo handlers drop the response when `selectedPubkey` changed during the await.
3. **A saved chip that's no longer valid** (renamed key, bad localStorage). → Task 4 test: restore only accepts a key in `FILTER_CHIPS`, otherwise All, so the page never loops on a 400.
4. **State for a never-messaged pubkey** (New Message compose opens an empty thread). → Task 2 test: `getConversationState` returns `{ waiting: false, no_reply_needed_at: null }` for a conversation with no rows, and Task 3 tests the route returns 200.
5. **Count and list parity across pages.** A chip's count must equal what paging through it returns, including beyond page one. → Task 2 parity test with a page size smaller than the match count.

---

### Task 1: No reply needed storage and prune safety

**Files:**
- Create: `migrations/014-dm-reply-state.sql`
- Modify: `src/nostr/dm-store.mjs` (new functions near `initDmReadStateTable` / `markConversationRead`; `initDmLogTable`; `pruneExpiredDmLog`)
- Modify: `src/index.mjs:5617-5618` (prune log line includes the new count)
- Test: `src/nostr/dm-store.test.mjs`

**Interfaces:**
- Produces:
  - `initDmReplyStateTable(db): Promise<void>`: `CREATE TABLE IF NOT EXISTS dm_conversation_reply_state (conversation_id TEXT PRIMARY KEY, no_reply_needed_at TEXT NOT NULL)`
  - `markNoReplyNeeded(db, conversationId: string): Promise<void>`: upsert with `CURRENT_TIMESTAMP`. A second call moves the mark forward, never backwards (same guard as `markConversationRead`).
  - `clearNoReplyNeeded(db, conversationId: string): Promise<void>`: deletes the row.
  - `pruneExpiredDmLog(db)` now returns `{ deletedMessages, deletedReadStates, deletedReplyStates }`.

- [ ] **Step 1: Write the failing tests** in a new `describe('DM Store - no reply needed against real D1')` (`beforeEach`: `initDmLogTable`, delete from `dm_log`, `dm_conversation_read_state`, `dm_conversation_reply_state`):
  - `markNoReplyNeeded writes a CURRENT_TIMESTAMP-format mark`: after the call, `SELECT no_reply_needed_at` matches `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/`.
  - `markNoReplyNeeded does not move the mark backwards`: set the row to `'2999-01-01 00:00:00'`, call again, the value is still `'2999-01-01 00:00:00'`.
  - `clearNoReplyNeeded removes the mark`: the row count is 0 afterwards. Safe on a conversation with no row.
  - `initDmLogTable creates dm_conversation_reply_state`: `SELECT name FROM sqlite_master WHERE name = 'dm_conversation_reply_state'` returns a row.
  In `describe('DM Store - pruneExpiredDmLog against real D1')`, extend `beforeEach` to clear the reply-state table and add:
  - `deletes the reply-state row for a conversation whose only message expired`: `deletedReplyStates === 1`, row gone.
  - `keeps the reply-state row for a conversation with a surviving message`: `deletedReplyStates === 0`.
  - `runs when neither state table exists yet`: `DROP TABLE dm_conversation_read_state` and `DROP TABLE dm_conversation_reply_state`, then `pruneExpiredDmLog` resolves and still deletes the expired `dm_log` row.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/nostr/dm-store.test.mjs -t "no reply needed|pruneExpiredDmLog"`
  Expected: FAIL (`markNoReplyNeeded is not a function`, missing table, prune throws `no such table`).

- [ ] **Step 3: Implement** the three functions. Call `initDmReplyStateTable` from `initDmLogTable`. In `pruneExpiredDmLog`, await `initDmReadStateTable(db)` and `initDmReplyStateTable(db)` before the batch, and add the reply-state orphan DELETE (same `NOT IN (SELECT DISTINCT conversation_id FROM dm_log)` shape) as the batch's third statement. Update the doc comment. Write `migrations/014-dm-reply-state.sql` with the same `CREATE TABLE IF NOT EXISTS` and a header comment modelled on 012 (why a separate table, why `CURRENT_TIMESTAMP`). In `index.mjs`, add `deletedReplyStates` to the `[DM-RETENTION]` log line.

- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/nostr/dm-store.test.mjs`
  Expected: PASS, including the pre-existing prune tests.

- [ ] **Step 5: Mutation check.** Remove the two ensure calls from `pruneExpiredDmLog` and confirm `runs when neither state table exists yet` fails. Restore.

- [ ] **Step 6: Commit**
```bash
git add migrations/014-dm-reply-state.sql src/nostr/dm-store.mjs src/nostr/dm-store.test.mjs src/index.mjs
git commit -m "feat(messages): store a shared No reply needed mark per conversation"
```

### Task 2: Conversation flags, filtered list, counts and state

**Files:**
- Modify: `src/nostr/dm-store.mjs` (`getConversations`, new exports)
- Test: `src/nostr/dm-store.test.mjs`

**Interfaces:**
- Consumes: `dm_conversation_reply_state` and `initDmReplyStateTable` (Task 1).
- Produces:
  - `export const CONVERSATION_FILTERS = ['waiting', 'person', 'reports', 'notices', 'outcomes', 'warnings']`
  - `export const TYPED_MESSAGE_CUTOFF = '2026-08-13 00:00:00'` and `export const WAITING_WINDOW_DAYS = 30`, each with a comment (cutoff: #194 mislabel and why the 13th; window: the team's choice).
  - `getConversations(db, { limit, offset, moderatorPubkey, filter })`: `filter` is one of `CONVERSATION_FILTERS` or undefined. Throws `Error('Unknown conversation filter: <value>')` for anything else. Every row gains `waiting: boolean`.
  - `getFilterCounts(db): Promise<{ all, waiting, person, reports, notices, outcomes, warnings }>`, all integers.
  - `getConversationState(db, conversationId: string): Promise<{ waiting: boolean, no_reply_needed_at: string | null }>`

- [ ] **Step 1: Write the failing tests** in a new `describe('DM Store - conversation filters against real D1')`. Helpers: a `seed(conv, sender, recipient, direction, messageType, createdAt, eventId)` that calls `logDm` and then `UPDATE dm_log SET created_at = ?`, and a `recent(daysAgo)` that returns `datetime('now', '-N days')` from D1. Tests:
  - `a creator_reply one second before the cutoff is not a typed row`: a row at `'2026-08-12 23:59:59'` → the conversation isn't in `filter: 'person'`.
  - `a creator_reply at the cutoff is a typed row`: `'2026-08-13 00:00:00'` → it is in `person`.
  - `automated messages after a typed row do not clear waiting`: for each of `moderation_notice`, `report_outcome`, `community_warning` (outgoing, 1 day ago) after a typed row (2 days ago) → in `waiting`, `waiting === true` on the row.
  - `an outgoing moderator_reply after the typed row clears waiting, and a later typed row restores it`.
  - `a typed row 31 days old is not waiting; 29 days old is`.
  - `a typed row in the same second as the reply is not waiting` (strictly later wins).
  - `no reply needed clears waiting; a later typed row restores it; clearNoReplyNeeded restores it`.
  - `reports / notices / outcomes / warnings match conversations that ever contained that type`: put the type early, followed by a later `creator_reply` so it isn't the latest message → still matches. A conversation without it doesn't.
  - `no filter returns every conversation, unchanged order`: same ids and order as before this change.
  - `getConversations throws on an unknown filter`: `rejects.toThrow('Unknown conversation filter: bogus')`.
  - `counts equal paged results for every filter`: seed about 7 conversations that cover each filter, page each filter with `limit: 2` until a short page, and assert the collected length equals `getFilterCounts(db)[key]`. `all` equals the unfiltered paged length.
  - `getConversationState for a conversation with no rows`: `{ waiting: false, no_reply_needed_at: null }`.
  - `getConversationState agrees with the row's waiting flag` for one waiting and one not-waiting conversation.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/nostr/dm-store.test.mjs -t "conversation filters"`
  Expected: FAIL (`getFilterCounts is not a function`, `waiting` undefined).

- [ ] **Step 3: Implement** a private `conversationFlagsCte({ conversationId } = {}) → { sql, params }`, used by all three functions. It extends today's `latest` CTE (keep `MAX(id) AS max_id, COUNT(*) AS message_count`) with:
```sql
MAX(CASE WHEN direction = 'incoming' AND message_type = 'creator_reply' AND created_at >= ? THEN created_at END) AS last_typed_at,
MAX(CASE WHEN message_type = 'moderator_reply' THEN created_at END) AS last_reply_at,
SUM(CASE WHEN message_type = 'conversation_report' THEN 1 ELSE 0 END) AS report_count,
-- likewise notice_count (moderation_notice), outcome_count (report_outcome), warning_count (community_warning)
```
  plus an optional `WHERE conversation_id = ?`. A second CTE `flags` LEFT JOINs `dm_conversation_reply_state` and computes:
```sql
CASE WHEN last_typed_at IS NOT NULL
      AND last_typed_at >= datetime('now', ?)              -- bound '-30 days'
      AND (last_reply_at IS NULL OR last_typed_at > last_reply_at)
      AND (rps.no_reply_needed_at IS NULL OR last_typed_at > rps.no_reply_needed_at)
     THEN 1 ELSE 0 END AS waiting
```
  `getConversations` selects from `flags` in place of `latest`, adds `WHERE` for the filter (`waiting = 1`, `last_typed_at IS NOT NULL`, `report_count > 0`, ...), and binds the CTE params before `limit, offset`. Map `waiting` to a boolean in the returned rows (on both the moderator-augmented and raw paths). `getFilterCounts` runs `SELECT COUNT(*), SUM(waiting), SUM(last_typed_at IS NOT NULL), SUM(report_count > 0), ...` over `flags`, with SUM results coerced to 0 when the table is empty. Update the `getConversations` comment block to describe the flags and why no new index is needed (the existing query already reads full rows for `latest_incoming`).

- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/nostr/dm-store.test.mjs`
  Expected: PASS, including every pre-existing `getConversations` and unread test.

- [ ] **Step 5: Mutation checks.** One at a time, confirm the named test fails, then restore:
  - Change `>= ?` (cutoff) to `> ?` → the at-cutoff test fails.
  - Change `message_type = 'moderator_reply'` to `direction = 'outgoing'` → the automated-messages test fails.
  - Drop the `no_reply_needed_at` condition → the no-reply test fails.
  - Change `>` to `>=` in the reply comparison → the same-second test fails.

- [ ] **Step 6: Commit**
```bash
git add src/nostr/dm-store.mjs src/nostr/dm-store.test.mjs
git commit -m "feat(messages): filter conversations by typed, waiting and automated types"
```

### Task 3: Routes

**Files:**
- Modify: `src/index.mjs` (`/admin/api/messages` list route ~4051; new routes placed before the thread route at ~4073)
- Test: `src/index.test.mjs` (next to the existing `GET /admin/api/messages` and `/read` describes, ~7833-7960)

**Interfaces:**
- Consumes: `CONVERSATION_FILTERS`, `getConversations({ filter })`, `getFilterCounts`, `getConversationState`, `markNoReplyNeeded`, `clearNoReplyNeeded`, `initDmReplyStateTable`, `computeConversationId` (Tasks 1-2).
- Produces (used by Task 4):
  - `GET /admin/api/messages?limit&offset&filter=<key>` → bare array of rows with `waiting`. Unknown filter → 400 `{ error: 'Unknown filter', allowed: CONVERSATION_FILTERS }`. Empty `filter=` = All.
  - `GET /admin/api/messages/counts` → `{ all, waiting, person, reports, notices, outcomes, warnings }`
  - `GET /admin/api/messages/:pubkey/state` → `{ waiting, no_reply_needed_at }`
  - `POST /admin/api/messages/:pubkey/no-reply-needed` → `{ success: true, waiting, no_reply_needed_at }`
  - `DELETE /admin/api/messages/:pubkey/no-reply-needed` → same shape

- [ ] **Step 1: Write the failing tests** (same `worker.fetch` + `createEnv({ ALLOW_DEV_ACCESS: 'true', NOSTR_PRIVATE_KEY, BLOSSOM_DB })` pattern as the `/read` describe):
  - `GET /admin/api/messages?filter=bogus returns 400 listing the allowed filters`.
  - `GET /admin/api/messages ensures dm_conversation_reply_state before the query joins it` (same prepared-SQL ordering assertion as the existing read-state test).
  - `GET /admin/api/messages/counts returns counts, not an empty thread`: 200, the body has all seven keys and no `messages` key. This pins the route order.
  - `GET /admin/api/messages/:pubkey/state returns 200 for a never-messaged pubkey`.
  - `POST and DELETE /no-reply-needed return the success shape and touch dm_conversation_reply_state`.
  - `/state and /no-reply-needed reject a non-hex pubkey with 400` and `require auth` (no `cf-access-jwt-assertion` and no dev access → the same status the `/read` auth test expects).
  - `/state and /no-reply-needed return 500 when NOSTR_PRIVATE_KEY is unset` (mirrors `/read`).

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/index.test.mjs -t "admin/api/messages"`
  Expected: FAIL (the 400 test gets 200, and the counts test gets `{ messages: [] }`).

- [ ] **Step 3: Implement.** The list route validates `filter` against `CONVERSATION_FILTERS` before querying, calls `initDmReplyStateTable` beside `initDmReadStateTable`, and passes `filter`. The counts and state routes go before the thread route, with a comment saying why (the thread route matches any five-segment GET without validating). Pubkey validation, the moderator-key check and conversation-id derivation copy the `/read` route. If a shared helper falls out naturally across `/read`, `/state` and `/no-reply-needed`, extract it within those routes only.

- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/index.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Mutation check.** Move the counts route below the thread route and confirm the counts test fails. Restore.

- [ ] **Step 6: Commit**
```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat(messages): filter, counts, state and no-reply-needed admin routes"
```

### Task 4: Messages page

**Files:**
- Modify: `src/admin/messages.html` (header markup ~524-530 and ~551-553; CSS near `.conversation-list-header` ~90-120; `fetchConversations` ~816; `selectConversation` ~987; `sendMessage` ~1143; `refreshAll` ~1215; page init)
- Test: `src/admin/messages-ui.test.mjs`

**Interfaces:**
- Consumes: the Task 3 routes.
- Produces (page-internal): `FILTER_CHIPS`, `activeFilter`, `filterCounts`, `setFilter(key)`, `renderFilterChips()`, `fetchFilterCounts()`, `restoreFilter()`, `loadReplyState(pubkey)`, `markNoReplyNeeded()`, `undoNoReplyNeeded()`.

- [ ] **Step 1: Write the failing tests** (`extractFunction` or string assertions, matching the file's existing style):
  - `FILTER_CHIPS lists the seven chips in order with these labels`: `All, Waiting on us, A person wrote, Reports, Notices, Outcomes, Warnings`, keys `'' , waiting, person, reports, notices, outcomes, warnings`.
  - `chip tooltips carry the agreed copy`: the page contains exactly:
    - Waiting on us: `Someone typed to us in the last 30 days and nobody on the team has replied since. Our automatic messages don't count as a reply. Messages from before 13 August aren't counted.`
    - A person wrote: `Everyone who has typed to us since 13 August, answered or not. For the ones that need a reply, use Waiting on us.`
    - Reports: `Has at least one automatic report from the app.`
    - Notices / Outcomes / Warnings: `Has at least one moderation notice we sent.` / `Has at least one report outcome we sent.` / `Has at least one community warning we sent.`
  - `fetchConversations sends the active filter`: the source contains `'&filter=' + encodeURIComponent(activeFilter)`, guarded so All sends no param.
  - `setFilter starts a fresh load` (Review Focus 1): the `setFilter` body calls `fetchConversations()` with no `append`, and returns early when the key equals `activeFilter`.
  - `restoreFilter falls back to All for an unknown key` (Review Focus 3): call the extracted function with a stubbed `localStorage.getItem` returning `'bogus'`, and with one that throws. Both yield `''`.
  - `reply-state handlers drop stale responses` (Review Focus 2): `loadReplyState`, `markNoReplyNeeded` and `undoNoReplyNeeded` each compare `selectedPubkey` to the pubkey they started with after their await.
  - `counts refresh after refresh, send and no-reply changes`: `refreshAll`, the success path of `sendMessage`, `markNoReplyNeeded` and `undoNoReplyNeeded` each call `fetchFilterCounts`.
  - `the thread header has the No reply needed button and undo copy`: contains `id="no-reply-btn"`, `No reply needed`, `Marked no reply needed`, `Undo`.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/admin/messages-ui.test.mjs`
  Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement.**
  - A chip row under the search box, rendered by `renderFilterChips()` as buttons showing `label (count)` (no count until counts arrive) with `title` set to the tooltip. The active chip is styled with the page's existing primary colour variables.
  - `setFilter` stores the key in localStorage inside try/catch and calls `fetchConversations()` then `maybeAutoFillConversations()`. When a filter returns no rows, the empty state reads `No conversations match this filter.`
  - Page init calls `restoreFilter()` before the first `fetchConversations()`, then `fetchFilterCounts()`.
  - `selectConversation` calls `loadReplyState(pubkey)` after the existing mark-read. The button shows only when `waiting` is true.
  - Mark shows `Marked no reply needed · Undo` (Undo is a link-style button) until another conversation is selected. Undo calls DELETE and then re-applies `loadReplyState`.
  - Per the spec, the conversation's loaded list row isn't removed after mark or reply. Only counts refresh.

- [ ] **Step 4: Run to verify they pass**
  Run: `npx vitest run src/admin/messages-ui.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Visual check.** Run `npm run dev`, seed local D1 with `npx wrangler d1 execute blossom-webhook-events --local --command "<INSERTs>"`: one waiting conversation, one replied, one notice-only, and one with a pre-cutoff `creator_reply`. Open the Messages page with Playwright and screenshot:
  - All, with counts
  - Waiting on us
  - an open waiting thread showing the button
  - after clicking it, showing Undo
  - at 390px width (the chip row wraps, with no horizontal scroll)
  Expected: the counts match the seed (waiting 1, person 2, notices 1, all 4), and the pre-cutoff conversation appears only under All. Keep the screenshots for the PR. They use seeded fake pubkeys only.

- [ ] **Step 6: Full check and commit**
  Run: `npm run lint && npm test`
  Expected: both pass. If CI-style `Timeout calling onTaskUpdate` flakes appear, re-run once; that is a known pool flake, not this change.
```bash
git add src/admin/messages.html src/admin/messages-ui.test.mjs
git commit -m "feat(messages): filter chips with counts and a No reply needed action"
```

### Task 5: Greyed handled rows and people-chip previews (added 2026-11-16 after Matt's review)

Spec sections: "No reply needed → Rows already loaded", "Server shape" (`last_typed_message`, `last_typed_at`), "Client shape → Row preview in the people chips".

**Files:**
- Modify: `src/nostr/dm-store.mjs` (`conversationFlagsCte`, `getConversations`)
- Modify: `src/admin/messages.html` (`renderConversationList` ~1107-1150; `loadReplyState` ~943; `markNoReplyNeeded` ~959; `undoNoReplyNeeded` ~977; `sendMessage` success path; CSS for a handled row)
- Test: `src/nostr/dm-store.test.mjs`, `src/admin/messages-ui.test.mjs`

**Interfaces:**
- Consumes: the Task 2 typed-row definition in `conversationFlagsCte`; `activeFilter`, `conversations`, `selectedPubkey`, `renderConversations()` in the page.
- Produces: every `getConversations` row carries `last_typed_message: string | null` and `last_typed_at: string | null`; a page helper `setConversationWaiting(pubkey: string, waiting: boolean): void` that updates the loaded row for that participant (if any) and re-renders.

- [ ] **Step 1: Write the failing store tests** in the conversation-filters describe:
  - `rows carry the latest typed message even when an automated message came later`: typed row "That was a news clip" (4 days ago), then outgoing `moderation_notice` (3 days ago). The row's `last_message` is the notice, `last_typed_message === 'That was a news clip'`, and `last_typed_at` equals the typed row's `created_at`.
  - `last_typed_message is null when the conversation has no typed row since the cutoff`: a conversation with only a pre-cutoff `creator_reply` and one with only a `moderation_notice` both give `null` for both fields.
  - `the latest of several typed rows wins`: two typed rows, so the later one's content is returned.

- [ ] **Step 2: Write the failing page tests** (behavioral: extract the functions with stubbed globals, as the reply-state tests do):
  - `people chips preview the person's latest typed message`: with `activeFilter = 'waiting'` (and again with `'person'`), `renderConversationList` on a row whose `latest_message` is a notice and `last_typed_message` is "That was a news clip" renders "That was a news clip", a Creator Reply badge, and a time from `last_typed_at`. With `activeFilter = ''` (and `'notices'`) it renders the notice as today.
  - `falls back to the last message when last_typed_message is null` on a people chip.
  - `a row greys on Waiting on us only when it is no longer waiting`: `waiting: false` under `activeFilter = 'waiting'` renders the handled-row class. `waiting: true` doesn't. `waiting: false` under `''` or `'person'` doesn't.
  - `mark, undo and a later waiting state flip the grey`: after a successful mark, `setConversationWaiting(pubkey, false)` runs and the row renders greyed. After undo, or a `loadReplyState` response with `waiting: true`, it renders normal.
  - `a reply sent from the thread greys the row` on Waiting on us (via the state reload after send).

- [ ] **Step 3: Run to verify they fail**
  Run: `npx vitest run src/nostr/dm-store.test.mjs src/admin/messages-ui.test.mjs`
  Expected: FAIL on the new tests only.

- [ ] **Step 4: Implement.**
  - Store: add `MAX(CASE WHEN <typed row> THEN id END) AS last_typed_id` beside `last_typed_at` (same typed definition and bound cutoff). In `getConversations`, `LEFT JOIN dm_log lt ON lt.id = flags.last_typed_id` and select `lt.content AS last_typed_message` and `flags.last_typed_at`. Keep bind order and existing columns.
  - Page: grey is derived in `renderConversationList` (`activeFilter === 'waiting' && conv.waiting === false`), never stored. `loadReplyState`, mark success, undo success and the post-send state reload call `setConversationWaiting` with the server's `waiting`. The preview, time and badge switch to the typed fields when `activeFilter` is `waiting` or `person` and `last_typed_message` is non-null. The handled-row style is a muted opacity using existing CSS variables, and the row stays clickable.

- [ ] **Step 5: Run to verify they pass**, then mutation checks, one at a time (confirm the named test fails, then restore):
  - Drop the `activeFilter === 'waiting'` condition from the grey rule, so the other-chip test fails.
  - Remove the `setConversationWaiting` call from undo, so the undo test fails.
  - Make the store take `last_typed_message` from the latest row of any type, so the automated-later test fails.

- [ ] **Step 6: Full check and commit**
  Run: `npm run lint && npm test`. Expected: both pass.
```bash
git add src/nostr/dm-store.mjs src/nostr/dm-store.test.mjs src/admin/messages.html src/admin/messages-ui.test.mjs
git commit -m "feat(messages): grey handled rows and preview what the person wrote in people chips"
```
