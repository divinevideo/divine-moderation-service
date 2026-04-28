# Moderation DM Notification & Conversation System

## Overview

When videos are moderation-blocked, creators currently get no notification — their video just 404s. This plan adds NIP-17 encrypted DMs from the divine moderation account to notify creators, receive user reports of DM abuse, and provide a conversation UI in the admin dashboard.

## Architecture Decisions

### NIP-17 Private Direct Messages
- Kind 14 rumor → kind 13 seal (NIP-44 encrypted) → kind 1059 gift wrap (NIP-59)
- `nostr-tools/nip17` handles all layering via `wrapEvent`/`wrapManyEvents`
- NIP-44 crypto is pure JS (`@noble/ciphers`, `@noble/curves`) — works in Cloudflare Workers with `nodejs_compat`

### Key Management
- Use `MODERATOR_NSEC` (already exists as a Cloudflare secret) for DM identity, separate from `NOSTR_PRIVATE_KEY` (used for automated NIP-56 reports)
- This gives the moderation account a distinct identity from the automated reporter
- Private key never leaves the Worker — dashboard fetches decrypted conversations via API

### Relay Strategy (Critical)
- Publishing DMs only to `relay.divine.video` is insufficient — most users' clients don't connect there
- Must discover each user's relay list via **NIP-65** (kind 10002 relay list metadata)
- Publish DMs to the user's declared **read relays** (from NIP-65) plus `relay.divine.video` as fallback
- If no NIP-65 event found, fall back to well-known relays: `wss://relay.damus.io`, `wss://relay.primal.net`, `wss://nos.lol`
- Cap at 5 relays per DM to limit latency

### Storage
- **D1 `dm_log` table** as operational index for the admin dashboard
- **Relay** as source of truth for message content
- **KV** for sync timestamps and rate limiting

---

## Phase 1: Schema & Data Plumbing

### 1.1 D1 Migration (one-time, via `wrangler d1 execute`)

```sql
-- Add creator pubkey to moderation results
ALTER TABLE moderation_results ADD COLUMN uploaded_by TEXT;

-- DM conversation log
CREATE TABLE IF NOT EXISTS dm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,       -- SHA-256(sorted(pubkeyA + pubkeyB))
  sha256 TEXT,                         -- related video hash (nullable)
  direction TEXT NOT NULL,             -- 'outgoing' | 'incoming'
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  message_type TEXT,                   -- 'moderation_notice' | 'report_outcome' | 'conversation_report' | 'moderator_reply' | 'creator_reply'
  content TEXT NOT NULL,
  nostr_event_id TEXT,                 -- gift-wrap event ID on relay
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_conversation ON dm_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_log(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_dm_sha256 ON dm_log(sha256);
```

Run via: `wrangler d1 execute blossom-webhook-events --file=migrations/003-dm-support.sql`

### 1.2 Thread `uploadedBy` Through the Pipeline

**Problem:** `handleModerationResult()` doesn't receive `uploadedBy`. The creator pubkey is available in the queue consumer but lost before notification.

**Fix in `src/index.mjs`:**
1. Queue consumer (line ~2382): update `INSERT INTO moderation_results` to include `uploaded_by`
2. Pass `uploadedBy` into `handleModerationResult(result, env)` — either add it to the `result` object from `moderateVideo()` return, or pass as third argument
3. Update `moderateVideo()` in `src/moderation/pipeline.mjs` to include `uploadedBy` in its return value (it already receives it as `videoData.uploadedBy`)

### 1.3 New File: `src/nostr/dm-store.mjs`

Functions:
- `initDmLogTable(db)` — `CREATE TABLE IF NOT EXISTS` (safety net, main creation via migration)
- `logDm(db, { conversationId, sha256, direction, senderPubkey, recipientPubkey, messageType, content, nostrEventId })`
- `getConversations(db, { limit, offset })` — grouped by conversation_id, latest message, unread count
- `getConversation(db, conversationId)` — full thread ordered by created_at
- `getConversationByPubkey(db, pubkey)` — lookup by participant pubkey
- `computeConversationId(pubkeyA, pubkeyB)` — SHA-256 of sorted concatenation

---

## Phase 2: DM Sender

### 2.1 New File: `src/nostr/dm-sender.mjs`

```javascript
import { wrapManyEvents } from 'nostr-tools/nip17';
import { hexToBytes } from '@noble/hashes/utils';

// NIP-17 API: wrapEvent(senderPrivateKey, recipient, message, conversationTitle, replyTo)
// - senderPrivateKey: Uint8Array (NOT hex string)
// - recipient: { publicKey: string, relayUrl?: string }
// - message: string (plaintext content)
// - returns: gift-wrapped event (kind 1059)
```

Functions:
- `sendModerationDM(recipientPubkey, sha256, action, reason, env, ctx)` — compose notification, wrap, publish to user's relays
- `sendReportOutcomeDM(reporterPubkey, sha256, outcome, env, ctx)` — notify reporter of action taken
- `sendModeratorReply(recipientPubkey, message, sha256, env, ctx)` — free-form reply from admin dashboard
- `discoverUserRelays(pubkey, defaultRelays, env)` — fetch kind 10002 from relay, extract read relays
- `publishToRelays(events, relayUrls, env)` — publish gift wraps to multiple relays, include CF Access headers

### 2.2 Message Templates

**PERMANENT_BAN:**
> Your video has been removed for violating Divine's content policies. Reason: {reason}. If you believe this is an error, you can reply to this message to appeal.

**AGE_RESTRICTED:**
> Your video has been age-restricted: {reason}. It remains available but will only be shown to users who have confirmed their age.

**QUARANTINE:**
> Your video has been temporarily hidden pending manual review. Reason: {reason}. A moderator will review it shortly. You can reply to this message with any context.

**Report outcome (to reporter):**
> Thank you for your report. After review, the reported content has been {action}. We appreciate your help keeping the community safe.

### 2.3 Rate Limiting

KV key: `dm-ratelimit:{recipientPubkey}`, TTL 60s, max 5 per window.
Prevents spamming a creator if multiple videos are flagged in quick succession.

### 2.4 Wire Into Pipeline

In `handleModerationResult()`, after Blossom notification:

```javascript
// Send DM to creator (non-blocking via ctx.waitUntil)
if (['PERMANENT_BAN', 'AGE_RESTRICTED', 'QUARANTINE'].includes(action) && uploadedBy) {
  ctx.waitUntil(
    sendModerationDM(uploadedBy, sha256, action, reason, env, ctx)
      .catch(err => console.error('[DM] Failed to notify creator:', err))
  );
}
```

Using `ctx.waitUntil()` ensures DM sending doesn't block the queue consumer or add latency to the moderation pipeline.

**Also wire into:**
- `/admin/api/moderate/:sha256` — for manual moderator overrides (lookup `uploaded_by` from D1)

---

## Phase 2.5: DM Conversation Reports

### Client-Side (divine-mobile, future)

"Report Conversation" button in DM UI sends a NIP-17 DM to the moderation account containing:

```json
{
  "type": "conversation_report",
  "reported_pubkey": "<hex pubkey of other participant>",
  "reason": "harassment",
  "description": "User's description of why they're reporting",
  "messages": [
    {"from": "<pubkey>", "content": "message text", "created_at": 1234567890},
    ...
  ]
}
```

### Server-Side Processing

During inbox sync (Phase 3), detect `conversation_report` messages:
1. **Verify sender is a real participant** — check sender pubkey appears in the `messages[].from` array
2. Parse the structured report
3. Create entry in existing `user_reports` table with `report_type = 'dm_conversation'`
4. Log to `dm_log` with `message_type = 'conversation_report'`
5. Surface in admin dashboard with special "Reported Conversation" badge

**Trust model:** This is inherently trust-the-reporter — we cannot verify the bundled messages are authentic without access to both parties' keys. The admin dashboard should show these as "reported by {pubkey}" with the caveat that message authenticity is unverified.

---

## Phase 3: DM Inbox Reader

### 3.1 New File: `src/nostr/dm-reader.mjs`

Functions:
- `syncInbox(env)` — connects to relay, queries kind 1059 events tagged with moderation pubkey, unwraps with `unwrapEvent`, stores in `dm_log`
- `getModeratorPubkey(env)` — derives pubkey from `MODERATOR_NSEC`

**Inbox sync query:**
```json
{"kinds": [1059], "#p": ["<moderator_pubkey>"], "since": <last_sync - 2_days>, "limit": 200}
```

The 2-day buffer accounts for NIP-17's randomized gift-wrap timestamps (`randomNow()` can shift up to 2 days back). Dedup by `nostr_event_id` in D1 before inserting.

Use the existing `relay-client.mjs` connect-query-EOSE-close pattern.

### 3.2 Add to Cron Trigger

In the existing `scheduled()` handler (runs `*/5 * * * *`), add inbox sync:

```javascript
// Sync DM inbox from relay
if (env.MODERATOR_NSEC) {
  try {
    await syncInbox(env);
  } catch (err) {
    console.error('[CRON] DM inbox sync failed:', err);
  }
}
```

### 3.3 Admin API Endpoints

All behind existing auth (Cloudflare Access JWT):

- `GET /admin/api/messages` — conversation list with latest message, unread count, participant pubkey
- `GET /admin/api/messages/:pubkey` — full thread with a specific user
- `POST /admin/api/messages/:pubkey` — send reply (body: `{ message, sha256? }`)
- `POST /admin/api/messages/sync` — trigger immediate inbox sync (manual refresh)

---

## Phase 4: Admin Dashboard UI

### 4.1 Separate Messages Page

**New route: `/admin/messages`** serving a separate HTML page (NOT added to the existing 3,500-line dashboard).

File: `src/admin/messages.html`

Layout:
- Left panel: conversation list (pubkeys, preview, timestamp, badges for reports/unread)
- Right panel: thread view (chat bubbles, chronological)
- Bottom: compose input with send button
- Top: "Back to Dashboard" link, "Refresh" button

### 4.2 Conversation List View

Each conversation shows:
- Participant pubkey (truncated, e.g., `npub1abc...xyz`)
- Latest message preview (first 80 chars)
- Timestamp
- Badge: "Report" (if conversation_report), unread count
- Related video thumbnail/hash if available

### 4.3 Thread View

- Chat-style bubbles (left = incoming, right = outgoing)
- Each message shows: sender, timestamp, content
- If related to a video: clickable sha256 link to dashboard video detail
- Moderator can type a reply in the compose box

### 4.4 Dashboard Integration

On the main dashboard (`/admin`), add:
- "Messages" button in the header (links to `/admin/messages`)
- Unread message count badge
- "Message Creator" link on video detail cards when `uploaded_by` is present

---

## Phase 5: Testing

### Unit Tests

- `src/nostr/dm-sender.test.mjs` — message templates, gift-wrap structure, rate limiting, relay discovery
- `src/nostr/dm-reader.test.mjs` — unwrapping, conversation grouping, dedup, timestamp buffer
- `src/nostr/dm-store.test.mjs` — D1 operations, conversation queries

### Integration Tests

- In `src/index.test.mjs`: queue message with `uploadedBy` → verify kind 1059 event published (mock relay)
- Admin moderate override → verify DM sent to creator
- Inbox sync → verify incoming DMs stored in dm_log

---

## Implementation Sequence

```
Phase 1 (schema + plumbing)
  ├── 1.1 D1 migration
  ├── 1.2 Thread uploadedBy through pipeline
  └── 1.3 dm-store.mjs

Phase 2 (sender)
  ├── 2.1 dm-sender.mjs
  ├── 2.2 Message templates
  ├── 2.3 Rate limiting
  └── 2.4 Wire into pipeline + admin + reports

Phase 2.5 (conversation reports — server-side only, mobile later)

Phase 3 (inbox reader)
  ├── 3.1 dm-reader.mjs
  ├── 3.2 Cron trigger integration
  └── 3.3 Admin API endpoints

Phase 4 (dashboard UI)
  ├── 4.1 /admin/messages page
  ├── 4.2-4.3 Conversation + thread views
  └── 4.4 Dashboard integration links

Phase 5 (testing — alongside each phase)
```

## Dependencies

- **divine-mobile**: Needs DM support in the app before users can see/reply to moderation DMs (Phases 2-3 work regardless, messages will be waiting on relay)
- **divine-mobile**: Needs "Report Conversation" UI for Phase 2.5 client-side
- **relay.divine.video**: Must accept kind 1059 (gift wrap) events — verify before building
- **relay.divine.video**: Must support `#p` tag filter on kind 1059 for inbox queries

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| User's client doesn't read relay.divine.video | Critical | NIP-65 relay discovery + well-known relay fallbacks |
| Cloudflare Workers CPU limit on NIP-44 crypto | Medium | Single DM ≈ 4 ECDH ops ≈ 20ms, well under 50ms limit |
| DM latency blocking moderation pipeline | Medium | `ctx.waitUntil()` for non-blocking send |
| Gift wrap timestamp randomization vs inbox sync | Medium | 2-day buffer on `since` filter + event ID dedup |
| Conversation report authenticity | Medium | Trust-the-reporter model, verify sender is participant |
| Dashboard bloat | Medium | Separate `/admin/messages` page |
