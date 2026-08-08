// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-17 DM inbox reader for moderation conversations
// ABOUTME: Syncs gift-wrapped DMs from relay and stores in D1 dm_log

import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';
import { unwrapEvent } from 'nostr-tools/nip17';
import { computeConversationId, logDm } from './dm-store.mjs';
import { recordReportForReview } from '../moderation/report-review.mjs';
import { extractReportType } from './report-poller.mjs';
import { isValidSha256 } from '../validation.mjs';

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
    since = Math.floor(Date.now() / 1000) - (7 * 86400);
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

  const events = await fetchGiftWraps(relayUrl, filter, env);
  console.log(`[DM-READER] Fetched ${events.length} gift wrap events`);

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

  // Update last sync timestamp
  if (env.MODERATION_KV) {
    await env.MODERATION_KV.put('dm-inbox:last-sync', String(Math.floor(Date.now() / 1000)));
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
  if (relatedSha256 && env.BLOSSOM_DB && !isOutgoing) {
    try {
      await recordReportForReview(env.BLOSSOM_DB, {
        sha256: relatedSha256,
        reporterPubkey: senderPubkey,
        reportType,
        reason: content,
        source: 'dm-report',
        reportedAt: new Date(createdAt * 1000).toISOString(),
      });
    } catch (reportErr) {
      console.warn(`[DM-READER] Failed to record report for review:`, reportErr.message);
    }
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
 * @param {string} relayUrl - WebSocket relay URL
 * @param {Object} filter - Nostr filter object
 * @param {Object} env - Environment with CF Access credentials
 * @returns {Promise<Array>} Array of gift wrap events
 */
function fetchGiftWraps(relayUrl, filter, env) {
  return new Promise((resolve, reject) => {
    let ws;
    const events = [];
    const timeout = setTimeout(() => {
      if (ws) ws.close();
      // Resolve with whatever we have rather than rejecting
      console.warn(`[DM-READER] WebSocket timeout, returning ${events.length} events collected so far`);
      resolve(events);
    }, 15000); // 15 second timeout for potentially many events

    try {
      // Cloudflare Workers' WebSocket constructor only accepts a subprotocol
      // string/array as the second argument; passing an options object fails
      // with "The protocol header token is invalid" and silently breaks the
      // cron. relay.divine.video is a public Nostr relay that does not require
      // CF Access, so we don't need to forward those headers here. If we ever
      // point at a CF-Access-protected relay, switch to the fetch({ Upgrade })
      // pattern and use the returned response.webSocket.
      ws = new WebSocket(relayUrl);
      const subscriptionId = 'dm-sync-' + Math.random().toString(36).substring(7);

      ws.addEventListener('open', () => {
        const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);
        console.log(`[DM-READER] Sent REQ to ${relayUrl} with filter: kinds=[1059], since=${filter.since}, limit=${filter.limit}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[2]) {
            events.push(data[2]);
          }

          if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(events);
          }
        } catch (err) {
          console.error('[DM-READER] Failed to parse message:', err);
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${err.message || 'connection failed'}`));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        // Resolve with whatever we collected if not already resolved
        resolve(events);
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}
