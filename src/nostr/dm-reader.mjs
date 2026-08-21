// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-17 DM inbox reader for moderation conversations
// ABOUTME: Syncs gift-wrapped DMs from relay and stores in D1 dm_log

import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import { unwrapEvent } from 'nostr-tools/nip17';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { computeConversationId, findDmByNostrEventId, logDm } from './dm-store.mjs';
import { recordReportForReview } from '../moderation/report-review.mjs';
import { extractReportType } from './report-poller.mjs';
import { findReportByReporter, initReportsTable } from '../reports.mjs';
import { isValidSha256 } from '../validation.mjs';

// How far back a first sync looks for gift wraps. Also the plausibility floor
// for a report's self-reported timestamp: older values are still ingested, but
// are stamped with receipt time so they surface in the current review queue.
const INBOX_FIRST_RUN_LOOKBACK_SECONDS = 7 * 86400;

// Tolerance for a reporting client whose clock runs a little fast.
const REPORT_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * Resolve the timestamp a report DM should be recorded under.
 *
 * `rumor.created_at` comes out of the decrypted rumor, so it is written by
 * whoever sent the DM and constrained by nothing. Two ways that bites:
 * a missing or non-numeric value makes `new Date(x * 1000).toISOString()`
 * throw `RangeError`, and because the caller records reports inside a
 * warn-and-continue block, the whole report would be dropped rather than
 * mis-stamped; a backdated value lands in `moderation_results.moderated_at`,
 * which the admin queue sorts on and its `since` filter excludes, hiding the
 * report from the humans it was escalated to.
 *
 * So the rumor's own timestamp is used only where it could plausibly be true,
 * and receipt time stands in otherwise. Both failure directions round toward
 * "surfaces now", never toward "surfaces never".
 *
 * @param {unknown} createdAt - rumor.created_at, in seconds
 * @param {number} nowMs - current time in ms, injectable for tests
 * @returns {string} ISO-8601 timestamp
 */
export function resolveReportedAt(createdAt, nowMs = Date.now()) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const isUsable = Number.isFinite(createdAt)
    && createdAt > 0
    && createdAt <= nowSeconds + REPORT_CLOCK_SKEW_SECONDS
    && createdAt >= nowSeconds - INBOX_FIRST_RUN_LOOKBACK_SECONDS;

  return new Date(isUsable ? createdAt * 1000 : nowMs).toISOString();
}

async function findModerationResultBySha(db, sha256) {
  return db.prepare(
    'SELECT sha256 FROM moderation_results WHERE sha256 = ?'
  ).bind(sha256).first();
}

/**
 * Derive the moderator's hex pubkey from NOSTR_PRIVATE_KEY (hex)
 * @param {Object} env - Environment with NOSTR_PRIVATE_KEY
 * @returns {string} Hex pubkey
 */
export function getModeratorPubkey(env) {
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }
  return getPublicKey(env.NOSTR_PRIVATE_KEY);
}

/**
 * Sync the DM inbox from relay.divine.video
 * Fetches kind 1059 (gift wrap) events addressed to the moderator,
 * unwraps them, and stores in D1 dm_log table.
 *
 * @param {Object} env - Environment bindings
 * @returns {Promise<{synced: number, skipped: number, errors: number}>}
 */
export async function syncInbox(env) {
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }

  const privateKey = hexToBytes(env.NOSTR_PRIVATE_KEY);
  const moderatorPubkey = getPublicKey(privateKey);

  // The fetch handler ensures the reports schema on every request, but this
  // runs from the cron trigger too, which never touches it. Without this, the
  // first tick after a deploy could reach a user_reports table that has no
  // `source` column yet and drop every report it decrypted -- processRumor
  // catches the write failure and moves on.
  if (env.BLOSSOM_DB) {
    await initReportsTable(env.BLOSSOM_DB);
  }

  // Get last sync timestamp from KV
  let lastSync = null;
  if (env.MODERATION_KV) {
    const stored = await env.MODERATION_KV.get('dm-inbox:last-sync');
    if (stored) {
      lastSync = parseInt(stored, 10);
    }
  }

  // Calculate 'since' with 2-day buffer for NIP-17 randomized timestamps
  const TWO_DAYS = 2 * 86400;
  let since;
  if (lastSync) {
    since = lastSync - TWO_DAYS;
  } else {
    // First run: look back 7 days
    since = Math.floor(Date.now() / 1000) - INBOX_FIRST_RUN_LOOKBACK_SECONDS;
  }

  // Fetch gift wrap events from relay
  const relayUrl = env.RELAY_POLLING_RELAY_URL || 'wss://relay.divine.video';
  const filter = {
    kinds: [1059],
    '#p': [moderatorPubkey],
    since,
    limit: 200
  };

  console.log(`[DM-READER] Syncing inbox from ${relayUrl}, since=${new Date(since * 1000).toISOString()}`);

  const { events, complete } = await fetchGiftWraps(relayUrl, filter, env);
  console.log(`[DM-READER] Fetched ${events.length} gift wrap events (complete=${complete})`);

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const giftWrap of events) {
    try {
      // Unwrap the gift wrap -> seal -> rumor
      const rumor = unwrapEvent(giftWrap, privateKey);

      if (!rumor || !rumor.content) {
        console.warn(`[DM-READER] Empty rumor from event ${giftWrap.id}`);
        errors++;
        continue;
      }

      const outcome = await processRumor(rumor, giftWrap.id, moderatorPubkey, env);
      if (outcome === null) {
        // Malformed outgoing self-copy (no resolvable counterparty) --
        // logged inside processRumor.
        errors++;
      } else if (outcome === 'synced') {
        synced++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[DM-READER] Failed to process event ${giftWrap.id}:`, err.message);
      errors++;
    }
  }

  // Advance the inbox checkpoint only when the relay actually completed the
  // read -- it sent EOSE, after answering any NIP-42 AUTH challenge. A sync that
  // timed out, was auth-refused, or errored leaves the checkpoint where it was
  // so the next tick retries the same window. Advancing on an incomplete sync is
  // how a silent regression becomes permanent: the moment the relay starts
  // gating kind-1059 reads behind AUTH, an unauthed reader collects zero gift
  // wraps yet still "succeeds", and moving the checkpoint past those DMs drops
  // every report in the window for good -- the two-day overlap only masks it for
  // two days.
  if (complete && env.MODERATION_KV) {
    await env.MODERATION_KV.put('dm-inbox:last-sync', String(Math.floor(Date.now() / 1000)));
  } else if (!complete) {
    console.warn('[DM-READER] Sync incomplete (no EOSE); leaving inbox checkpoint unchanged so the next tick retries the same window');
  }

  console.log(`[DM-READER] Sync complete: ${synced} new, ${skipped} deduped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Classify and persist a single already-unwrapped NIP-17 rumor addressed
 * to (or from) the moderator. Split out from syncInbox's loop so the
 * classify logic (tag-based report detection, direction handling) is
 * directly testable against a plain rumor object -- no relay connection
 * or gift-wrap crypto round-trip required.
 *
 * @param {Object} rumor - decrypted kind-14 rumor (unwrapEvent's output)
 * @param {string} giftWrapId - the outer kind-1059 event id (dm_log dedup key)
 * @param {string} moderatorPubkey
 * @param {Object} env - Environment bindings (BLOSSOM_DB)
 * @returns {Promise<'synced'|'skipped'|null>} null means malformed
 *   (logged internally) and should count as an error, not synced/skipped.
 */
export async function processRumor(rumor, giftWrapId, moderatorPubkey, env) {
  const senderPubkey = rumor.pubkey;
  const content = rumor.content;
  const createdAt = rumor.created_at;

  // NIP-17 gift wraps reach the moderator's inbox in two shapes:
  //   1. Inbound: someone writes to moderator. rumor.pubkey = them,
  //      rumor's ['p'] tag = moderator.
  //   2. Outbound self-copy: moderator writes to someone else, client
  //      also wraps a copy addressed to moderator so sent messages
  //      aren't lost. rumor.pubkey = moderator, rumor's ['p'] tag =
  //      real recipient.
  // Without handling (2), outgoing replies get stored with
  // sender = recipient = moderator, which produces a separate
  // conversation_id (moderator+moderator) and breaks threading.
  const isOutgoing = senderPubkey === moderatorPubkey;
  let counterpartyPubkey = null;
  if (isOutgoing) {
    // Find the real recipient in rumor tags: first 'p' tag whose value
    // is not the moderator itself. A valid NIP-17 outgoing rumor must
    // have one; if it doesn't, the gift wrap is malformed and we can't
    // thread it correctly. Skip rather than store as a self-conversation
    // that would later disappear from the admin UI.
    const pTags = Array.isArray(rumor.tags)
      ? rumor.tags.filter((t) => Array.isArray(t) && t[0] === 'p' && t[1])
      : [];
    const other = pTags.find((t) => t[1] !== moderatorPubkey);
    if (!other) {
      console.warn(
        `[DM-READER] Outgoing rumor has no non-moderator 'p' tag; skipping event ${giftWrapId}. rumor.tags=${JSON.stringify(rumor.tags || [])}`
      );
      return null;
    }
    counterpartyPubkey = other[1];
  } else {
    counterpartyPubkey = senderPubkey;
  }

  const recipientPubkey = isOutgoing ? counterpartyPubkey : moderatorPubkey;
  const direction = isOutgoing ? 'outgoing' : 'incoming';
  // Compute conversation ID against the non-moderator side so inbound
  // and outbound messages in the same thread share a conversation_id.
  const conversationId = computeConversationId(moderatorPubkey, counterpartyPubkey);

  // syncInbox deliberately overlaps two days of gift wraps on every tick for
  // NIP-17 timestamp randomization, so the same gift wrap is re-processed for
  // up to two days. Look up whether it already reached dm_log, but don't
  // return yet: a dm_log row proves the DM was stored, not that its report
  // was. The report write below warns and continues, and logDm runs either
  // way, so returning here would make a transient failure permanent -- the
  // next tick would skip before it ever retried. Each side is deduped against
  // its own row instead.
  const alreadyLogged = env.BLOSSOM_DB
    ? await findDmByNostrEventId(env.BLOSSOM_DB, giftWrapId)
    : null;

  // Structured report data travels as NIP-17 tags on the rumor, not as
  // JSON-encoded content -- content stays plain human-readable text
  // (matching NIP-17's "content MUST be plain text" convention) so the
  // admin Messages UI can keep rendering it as-is. A report DM carries the
  // same NIP-32 ['L'/'l', ...] label pair its kind-1984 sibling publishes,
  // plus a coarse ['report_type', <nip-56 type>] fallback; only content
  // reports also carry ['sha256', <hash>], because user reports and
  // DM-message reports have no resolvable Blossom blob hash (by design: see
  // divine-mobile#6593 plan's "Non-goals"). So the label classifies the
  // message and sha256 gates the user_reports row.
  //
  // extractReportType is the relay poller's resolver, shared deliberately:
  // both paths write the same (sha256, reporter_pubkey) row under
  // INSERT OR IGNORE, so if they disagreed on vocabulary whichever ingested
  // first would pin its answer permanently.
  const rumorTags = Array.isArray(rumor.tags) ? rumor.tags : [];
  const shaTag = rumorTags.find((t) => Array.isArray(t) && t[0] === 'sha256' && t[1]);
  const hasReportTag = rumorTags.some(
    (t) => Array.isArray(t) && (
      (t[0] === 'report_type' && t[1])
      || (t[0] === 'l' && t[1] && t[2] === 'social.nos.ontology')
    )
  );
  const rawSha256 = typeof shaTag?.[1] === 'string' ? shaTag[1].toLowerCase() : null;
  const relatedSha256 = rawSha256 && isValidSha256(rawSha256) ? rawSha256 : null;
  const reportType = hasReportTag ? extractReportType(rumor) : 'dm_report';

  if (rawSha256 && !relatedSha256) {
    console.warn(`[DM-READER] Ignoring invalid sha256 tag on report DM ${giftWrapId}`);
  }

  // user_reports.sha256 is NOT NULL (it exists to count distinct
  // reporters per piece of content for escalation policy -- see
  // reports.mjs), so this can only ever fire when a sha256 tag is
  // present. Skip for outgoing self-copies: the reporter is the
  // counterparty, not the moderator (who is echoing their own sent
  // message).
  // No allowAutoAgeRestrict override: a report DM is the least verified
  // report we accept. The sender is any key that can reach the moderation
  // inbox, the sha256 is client-supplied, and unlike the relay poller this
  // path does not fetch the target event, require a Divine client, or pass
  // the processed-key gate. So it records the report and leaves the call to
  // a human -- `source: 'dm-report'` takes the REVIEW-only default, which
  // is what the relay path (`'relay-report'`) already takes. Only the
  // authenticated HTTP report API still auto-escalates.
  //
  // On a re-poll, skip only once this reporter's row and the review row both
  // exist for this sha256.
  // recordReportForReview is not idempotent for a report whose timestamp fell
  // back to receipt time: moderated_at moves and the AI telemetry event_key
  // (report:<sha>:<type>:<createdAt>) changes, so INSERT OR IGNORE stops
  // deduping it. Keying the skip on the completed report+review pair, rather
  // than the dm_log row alone or user_reports alone, suppresses that without
  // also suppressing the retry a partial failed write needs.
  if (relatedSha256 && env.BLOSSOM_DB && !isOutgoing) {
    const alreadyRecorded = alreadyLogged
      && await findReportByReporter(env.BLOSSOM_DB, relatedSha256, senderPubkey)
      && await findModerationResultBySha(env.BLOSSOM_DB, relatedSha256);
    if (!alreadyRecorded) {
      try {
        await recordReportForReview(env.BLOSSOM_DB, {
          sha256: relatedSha256,
          reporterPubkey: senderPubkey,
          reportType,
          reason: content,
          source: 'dm-report',
          reportedAt: resolveReportedAt(createdAt),
        });
      } catch (reportErr) {
        console.warn(`[DM-READER] Failed to record report for review:`, reportErr.message);
      }
    }
  }

  // The DM side is settled once dm_log holds this gift wrap. Returning here
  // rather than letting logDm's own dedup decide keeps the outcome honest:
  // logDm hands back the *existing* row on a dedup hit, whose truthy .id is
  // indistinguishable from a fresh insert, so a re-poll used to count as
  // 'synced'.
  if (alreadyLogged) {
    return 'skipped';
  }

  // Log to dm_log (dedup by nostr_event_id). Either machine-readable tag
  // marks the DM as a report: the report tags are present on all three
  // report variants, sha256 only on content reports. Keying the badge off
  // sha256 alone would render a user report or a DM-message report as an
  // ordinary reply in the admin Messages UI, which is a display gap rather
  // than the deliberate user_reports non-goal above.
  const messageType = (relatedSha256 || hasReportTag)
    ? 'conversation_report'
    : (isOutgoing ? 'moderator_reply' : 'creator_reply');
  const result = await logDm(env.BLOSSOM_DB, {
    conversationId,
    nostrEventId: giftWrapId,
    senderPubkey,
    recipientPubkey,
    content,
    direction,
    messageType,
    sha256: relatedSha256
  });

  return result && result.id ? 'synced' : 'skipped';
}

/**
 * Fetch gift wrap events from relay via WebSocket
 * Uses the same pattern as relay-client.mjs: connect -> REQ -> collect -> EOSE -> close
 *
 * relay.divine.video gates kind-1059 (gift wrap) reads behind NIP-42 AUTH to the
 * addressed recipient, so this speaks the AUTH handshake. On an ["AUTH", challenge]
 * it signs a kind-22242 event with the moderator key and replies ["AUTH", event];
 * for the ["CLOSED", subid, "auth-required: ..."] the relay sends for the pre-auth
 * REQ it re-sends the REQ once the AUTH is confirmed, so the subscription is served
 * post-auth. Any other CLOSED, or a rejected AUTH, rejects loudly rather than
 * silently resolving an empty inbox -- a silent empty read that also advanced the
 * checkpoint is exactly how reported DMs would be lost permanently.
 *
 * @param {string} relayUrl - WebSocket relay URL
 * @param {Object} filter - Nostr filter object
 * @param {Object} env - Environment with NOSTR_PRIVATE_KEY (for NIP-42 AUTH)
 * @returns {Promise<{events: Array, complete: boolean}>} `complete` is true only
 *   when the relay sent EOSE (after any needed auth). The caller must not advance
 *   the inbox checkpoint on a `false`/rejected result, or unread gift wraps in the
 *   window are skipped forever.
 */
export function fetchGiftWraps(relayUrl, filter, env) {
  return new Promise((resolve, reject) => {
    const events = [];
    let ws;
    let settled = false;

    // NIP-42 handshake state. The relay's auth-required CLOSED (which invalidates
    // the pre-auth subscription) and the OK confirming our AUTH can arrive in
    // either order, so the re-REQ waits for both and fires exactly once. A relay
    // that requires no auth sends neither, so it never re-REQs.
    let authEventId = null;
    let authConfirmed = false;
    let subClosedForAuth = false;
    let reqResent = false;

    const subscriptionId = 'dm-sync-' + Math.random().toString(36).substring(7);
    const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);

    const timeout = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch {}
      // No EOSE means the read was cut short. Return what arrived but mark it
      // incomplete so the caller leaves the checkpoint where it was.
      console.warn(`[DM-READER] WebSocket timeout, returning ${events.length} events collected so far (incomplete)`);
      finish({ events, complete: false });
    }, 15000); // 15 second timeout for potentially many events

    function finish(resultOrError) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (resultOrError instanceof Error) {
        reject(resultOrError);
        return;
      }
      resolve(resultOrError);
    }

    // Re-send the original REQ once the relay has both closed the pre-auth
    // subscription for auth and confirmed our AUTH. Guarded so we re-REQ at most
    // once (a second auth-required CLOSED after this means auth did not take, and
    // is handled as a hard failure below).
    function maybeResendReq() {
      if (authConfirmed && subClosedForAuth && !reqResent) {
        reqResent = true;
        console.log(`[DM-READER] Re-sending REQ after NIP-42 auth to ${relayUrl}`);
        ws.send(reqMessage);
      }
    }

    try {
      // Cloudflare Workers' WebSocket constructor only accepts a subprotocol
      // string/array as the second argument; passing an options object fails
      // with "The protocol header token is invalid" and silently breaks the
      // cron. relay.divine.video is a public Nostr relay that does not require
      // CF Access, so we don't need to forward those headers here. If we ever
      // point at a CF-Access-protected relay, switch to the fetch({ Upgrade })
      // pattern and use the returned response.webSocket.
      ws = new WebSocket(relayUrl);

      ws.addEventListener('open', () => {
        console.log(`[DM-READER] Sent REQ to ${relayUrl} with filter: kinds=[1059], since=${filter.since}, limit=${filter.limit}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch (err) {
          console.error('[DM-READER] Failed to parse message:', err);
          return;
        }

        if (data[0] === 'EVENT' && data[1] === subscriptionId && data[2]) {
          events.push(data[2]);
          return;
        }

        if (data[0] === 'EOSE' && data[1] === subscriptionId) {
          try {
            ws.send(JSON.stringify(['CLOSE', subscriptionId]));
            ws.close();
          } catch {}
          finish({ events, complete: true });
          return;
        }

        if (data[0] === 'AUTH' && typeof data[1] === 'string') {
          // NIP-42 challenge: sign a kind-22242 event with the moderator key and
          // answer. syncInbox guarantees env.NOSTR_PRIVATE_KEY is set.
          try {
            const authEvent = finalizeEvent(
              makeAuthEvent(relayUrl, data[1]),
              hexToBytes(env.NOSTR_PRIVATE_KEY)
            );
            authEventId = authEvent.id;
            console.log(`[DM-READER] Answering NIP-42 AUTH challenge from ${relayUrl}`);
            ws.send(JSON.stringify(['AUTH', authEvent]));
          } catch (err) {
            finish(new Error(`Failed to answer NIP-42 AUTH challenge: ${err.message}`));
          }
          return;
        }

        if (data[0] === 'OK' && data[1] === authEventId) {
          // Relay's verdict on our AUTH event specifically.
          if (data[2] === true) {
            authConfirmed = true;
            maybeResendReq();
          } else {
            const reason = typeof data[3] === 'string' && data[3] ? data[3] : 'no reason given';
            finish(new Error(`Relay rejected NIP-42 AUTH: ${reason}`));
          }
          return;
        }

        if (data[0] === 'CLOSED' && data[1] === subscriptionId) {
          const reason = typeof data[2] === 'string' && data[2] ? data[2] : 'unknown reason';
          const isAuthGate = reason.startsWith('auth-required:') || reason.startsWith('restricted:');
          if (isAuthGate && !reqResent) {
            // Expected pre-auth close: the relay wants us to authenticate and
            // re-subscribe. Note it and re-REQ once the AUTH is confirmed.
            subClosedForAuth = true;
            maybeResendReq();
          } else {
            // A non-auth CLOSED, or an auth gate that persisted after we already
            // authenticated and re-subscribed -- both are real failures, not an
            // empty inbox. Reject rather than resolve empty.
            finish(new Error(`Relay closed subscription ${subscriptionId}: ${reason}`));
          }
          return;
        }

        if (data[0] === 'NOTICE') {
          console.log(`[DM-READER] Relay notice: ${data[1]}`);
        }
      });

      ws.addEventListener('error', (err) => {
        finish(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
      });

      ws.addEventListener('close', () => {
        // Reaching here without an EOSE means the read was incomplete. The
        // once-guard drops this when EOSE/CLOSED/timeout already settled.
        finish({ events, complete: false });
      });

    } catch (error) {
      finish(error instanceof Error ? error : new Error('WebSocket setup failed'));
    }
  });
}
