// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-17 encrypted DM sender for moderation notifications
// ABOUTME: Sends gift-wrapped DMs to content creators about moderation actions

import { wrapEvent } from 'nostr-tools/nip17';
import { hexToBytes } from '@noble/hashes/utils';
import { getPublicKey } from 'nostr-tools/pure';

// Cache moderator keys per env object to avoid re-decoding
const keyCache = new WeakMap();

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
];

const DIVINE_RELAY = 'wss://relay.divine.video';

const MAX_RELAYS = 5;
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_TTL_SEC = 120;
const RELAY_TIMEOUT_MS = 5000;

// --- Message Templates ---

const FOOTER = 'Learn more about our content policies: divine.video/terms | about.divine.video/faqs/ | divine.video/support';

// Format helpers for optional metadata
const contentSubject = (title, fallback = 'Your content') =>
  title ? `Your video "${title}"` : fallback;
const postedDate = (publishedAt) =>
  publishedAt ? ` (posted ${formatDate(publishedAt)})` : '';
const contentLink = (sha256) =>
  sha256 ? `\ndivine.video/video/${sha256}\n` : '\n';

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch { return dateStr; }
}

const TEMPLATES = {
  PERMANENT_BAN: (reason, sha256, title, publishedAt) =>
    `${contentSubject(title)}${postedDate(publishedAt)} was removed because it was found to ${reason}.\n\nIf you believe this was a mistake, you can reply to this message to appeal.\n${contentLink(sha256)}\n${FOOTER}`,

  AGE_RESTRICTED: (reason, sha256, title, publishedAt) =>
    `${contentSubject(title)}${postedDate(publishedAt)} has been age-restricted because it was found to ${reason}. It's still available, but only visible to viewers who have confirmed their age.\n${contentLink(sha256)}\n${FOOTER}`,

  // QUARANTINE intentionally ignores reason — the message is generic per spec.
  // Mentions the 24-hour SLA and reassures the creator that the video is
  // still visible to them via direct link / their profile when signed in,
  // since the relay-side hide otherwise looks like a silent shadow-ban.
  QUARANTINE: (_reason, sha256, title, publishedAt) =>
    `${contentSubject(title)}${postedDate(publishedAt)} is currently under review by our moderation team. A human moderator will take a look within 24 hours and either restore it or contact you with next steps.\n\nUntil then, the video is hidden from public feeds but still visible to you via the direct link below or from your profile when you're signed in. If you'd like to provide context, you can reply to this message.\n${contentLink(sha256)}\n${FOOTER}`,

  // Account-level suspension — no content link, not content-specific.
  // Used by relay-manager when banning a user's pubkey.
  ACCOUNT_SUSPENDED: () =>
    `Your account has been suspended for violating Divine's content policies.\n\nIf you believe this was a mistake, you can reply to this message to appeal.\n\n${FOOTER}`,

  REPORT_OUTCOME_ACTION: (outcome, sha256, title, publishedAt, reportedAt) =>
    `Thanks for your report. We've reviewed ${contentSubject(title, 'the reported content')}${postedDate(publishedAt)} and it has been ${outcome}.${reportedAt ? ` You reported this content on ${formatDate(reportedAt)}.` : ''}\n${contentLink(sha256)}\nIf you have questions, you can reply to this message.\n\n${FOOTER}`,

  REPORT_OUTCOME_NO_ACTION: (sha256, title, publishedAt, reportedAt) =>
    `Thanks for your report. We've reviewed ${contentSubject(title, 'the reported content')}${postedDate(publishedAt)} and no action was taken at this time.${reportedAt ? ` You reported this content on ${formatDate(reportedAt)}.` : ''}\n${contentLink(sha256)}\nIf you disagree with this outcome, you can reply to this message.\n\n${FOOTER}`,
};

// Per-action default reasons so AGE_RESTRICTED gets its own fallback text
const DEFAULT_REASONS = {
  PERMANENT_BAN: 'violate Divine\'s content policies',
  AGE_RESTRICTED: 'contain material that may not be suitable for all audiences',
  QUARANTINE: '', // QUARANTINE template ignores reason
};

// --- Category-Specific Templates ---
// NOTE: `policy` URLs are retained for future use but intentionally not included
// in DM text until those pages exist. See 2026-03-19-dm-alignment-design.md.

const CATEGORY_TEMPLATES = {
  nudity: {
    reason: 'contain sexual or nude content',
    policy: 'https://divine.video/policies#sexual-content',
  },
  ai_generated: {
    reason: 'contain AI-generated content without disclosure',
    policy: 'https://divine.video/policies#ai-content',
  },
  deepfake: {
    reason: 'contain deepfake or manipulated media',
    policy: 'https://divine.video/policies#manipulated-media',
  },
  offensive: {
    reason: 'contain offensive or hateful content',
    policy: 'https://divine.video/policies#hate-speech',
  },
  self_harm: {
    reason: 'depict self-harm',
    policy: 'https://divine.video/policies#self-harm',
    extra: '\n\nIf you or someone you know is struggling, please reach out. International crisis lines: helpguide.org/find-help | suicide.org/international-suicide-hotlines.html — In the US/Canada, call or text 988.',
  },
  scam: {
    reason: 'contain fraudulent or scam content',
    policy: 'https://divine.video/policies#fraud',
  },
};

/**
 * Select a category-specific template for a moderation action.
 * Falls back to generic reason if no category match.
 * @param {string} action - PERMANENT_BAN, AGE_RESTRICTED, or QUARANTINE
 * @param {string|null} reason - Ignored when category matches. When used as fallback,
 *   must be a sentence completion after "was found to" (e.g., "violate content policies").
 *   Caller-provided freeform reasons are overridden by per-action defaults when no category matches.
 * @param {string|null} categories - JSON string of categories or plain category string
 * @param {string|null} sha256 - Content hash for divine.video link
 * @param {string|null} title - Content title for identification (e.g., "My cool video")
 * @param {string|null} publishedAt - ISO date when content was published
 * @returns {string|null} Message text or null if action has no template
 */
export function selectTemplate(action, reason, categories, sha256, title = null, publishedAt = null) {
  let categoryInfo = null;
  if (categories && typeof categories === 'string') {
    try {
      const parsed = JSON.parse(categories);
      for (const cat of Object.keys(parsed)) {
        if (CATEGORY_TEMPLATES[cat]) {
          categoryInfo = CATEGORY_TEMPLATES[cat];
          break;
        }
      }
    } catch { /* not JSON, try as plain string */ }
    if (!categoryInfo && CATEGORY_TEMPLATES[categories]) {
      categoryInfo = CATEGORY_TEMPLATES[categories];
    }
  }

  // Category reason takes priority. Caller-provided reason is ignored because it may not
  // fit the "was found to {reason}" grammar (e.g., "Manual moderator action").
  // Per-action defaults provide grammatically correct fallbacks.
  const specificReason = categoryInfo?.reason || DEFAULT_REASONS[action] || 'violate Divine\'s content policies';
  const extra = categoryInfo?.extra || '';

  const template = TEMPLATES[action];
  if (!template) return null;

  const body = template(specificReason, sha256, title, publishedAt);

  return extra ? body.replace(`\n${FOOTER}`, `${extra}\n\n${FOOTER}`) : body;
}

/**
 * Get message text for a given moderation action.
 * @param {string} action - PERMANENT_BAN, AGE_RESTRICTED, or QUARANTINE
 * @param {string} reason
 * @returns {string|null} Message text or null if action has no template
 */
export function getMessageForAction(action, reason = 'violate Divine\'s content policies', sha256 = null, title = null, publishedAt = null) {
  const template = TEMPLATES[action];
  return template ? template(reason, sha256, title, publishedAt) : null;
}

/**
 * Get report outcome message text.
 * @param {string} action - The moderation action (PERMANENT_BAN, AGE_RESTRICTED, SAFE, DISMISS, etc.)
 * @param {string} sha256 - Content hash for divine.video link
 * @param {string|null} title - Content title
 * @param {string|null} publishedAt - ISO date when content was published
 * @param {string|null} reportedAt - ISO date when the report was filed
 * @returns {string}
 */
export function getReportOutcomeMessage(action, sha256 = null, title = null, publishedAt = null, reportedAt = null) {
  const ACTION_OUTCOMES = {
    PERMANENT_BAN: 'removed',
    AGE_RESTRICTED: 'age-restricted. It\'s now only visible to viewers who have confirmed their age',
  };

  const outcome = ACTION_OUTCOMES[action];

  if (outcome) {
    return TEMPLATES.REPORT_OUTCOME_ACTION(outcome, sha256, title, publishedAt, reportedAt);
  }
  return TEMPLATES.REPORT_OUTCOME_NO_ACTION(sha256, title, publishedAt, reportedAt);
}

// --- Key Management ---

/**
 * Get moderator signing keys from NOSTR_PRIVATE_KEY env var (hex).
 * Results are cached per env object via WeakMap.
 * @param {Object} env
 * @returns {{ privateKey: Uint8Array, publicKey: string }}
 */
export function getModeratorKeys(env) {
  if (keyCache.has(env)) {
    return keyCache.get(env);
  }

  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }

  const privateKey = hexToBytes(env.NOSTR_PRIVATE_KEY);
  const publicKey = getPublicKey(privateKey);
  const keys = { privateKey, publicKey };
  keyCache.set(env, keys);
  return keys;
}

// --- Rate Limiting ---

/**
 * Check and update rate limit for a recipient.
 * @param {string} recipientPubkey
 * @param {Object} env - must have KV binding (MODERATION_KV)
 * @returns {Promise<boolean>} true if within limits, false if rate limited
 */
export async function checkRateLimit(recipientPubkey, env) {
  if (!env.MODERATION_KV) {
    // If KV not available, allow the message (fail open)
    console.warn('[DM] MODERATION_KV not bound, skipping rate limit check');
    return true;
  }

  const key = `dm-ratelimit:${recipientPubkey}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const raw = await env.MODERATION_KV.get(key);
    let timestamps = raw ? JSON.parse(raw) : [];

    // Filter to timestamps within the window
    timestamps = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_SEC);

    if (timestamps.length >= RATE_LIMIT_MAX) {
      console.warn(`[DM] Rate limited: ${recipientPubkey.substring(0, 16)}... (${timestamps.length} DMs in last ${RATE_LIMIT_WINDOW_SEC}s)`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[DM] Rate limit check failed:', err.message);
    // Fail open
    return true;
  }
}

/**
 * Record a sent DM in the rate limit window.
 */
async function recordRateLimit(recipientPubkey, env) {
  if (!env.MODERATION_KV) return;

  const key = `dm-ratelimit:${recipientPubkey}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const raw = await env.MODERATION_KV.get(key);
    let timestamps = raw ? JSON.parse(raw) : [];
    timestamps = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_SEC);
    timestamps.push(now);

    await env.MODERATION_KV.put(key, JSON.stringify(timestamps), {
      expirationTtl: RATE_LIMIT_TTL_SEC,
    });
  } catch (err) {
    console.error('[DM] Failed to record rate limit:', err.message);
  }
}

// --- Relay Discovery ---

/**
 * Discover relays a user reads from, via kind 10002 (NIP-65 relay list).
 * Checks KV cache first, then queries relay.divine.video.
 * Always includes relay.divine.video. Caps at MAX_RELAYS.
 *
 * @param {string} pubkey - Hex pubkey of user
 * @param {Object} env
 * @returns {Promise<string[]>} Relay URLs
 */
export async function discoverUserRelays(pubkey, env) {
  // Check KV cache
  if (env.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(`relay-list:${pubkey}`);
      if (cached) {
        const relays = JSON.parse(cached).slice(0, MAX_RELAYS);
        console.log(`[DM] Using cached relay list for ${pubkey.substring(0, 16)}... (${relays.length} relays)`);
        return relays;
      }
    } catch (err) {
      console.error('[DM] Failed to read relay cache:', err.message);
    }
  }

  // Query relay.divine.video for kind 10002
  let discoveredRelays = [];
  try {
    discoveredRelays = await queryRelayList(pubkey, env);
  } catch (err) {
    console.error(`[DM] Failed to discover relays for ${pubkey.substring(0, 16)}...:`, err.message);
  }

  // Build final list: discovered read relays + divine relay + defaults as fallback
  let relays;
  if (discoveredRelays.length > 0) {
    relays = [...new Set([DIVINE_RELAY, ...discoveredRelays])];
  } else {
    relays = [...new Set([DIVINE_RELAY, ...DEFAULT_RELAYS])];
  }

  // Cap at MAX_RELAYS
  relays = relays.slice(0, MAX_RELAYS);

  // Cache in KV (24h TTL)
  if (env.MODERATION_KV) {
    try {
      await env.MODERATION_KV.put(`relay-list:${pubkey}`, JSON.stringify(relays), {
        expirationTtl: 86400, // 24 hours
      });
    } catch (err) {
      console.error('[DM] Failed to cache relay list:', err.message);
    }
  }

  return relays;
}

/**
 * Query a relay for kind 10002 (NIP-65 relay list metadata) for a pubkey.
 * Returns read relay URLs extracted from 'r' tags.
 */
async function queryRelayList(pubkey, env) {
  return new Promise((resolve, reject) => {
    let ws;
    const timeout = setTimeout(() => {
      if (ws) {
        try { ws.close(); } catch (_) { /* ignore */ }
      }
      resolve([]); // Timeout -> return empty, don't reject
    }, RELAY_TIMEOUT_MS);

    try {
      const headers = {};
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }

      ws = new WebSocket(DIVINE_RELAY, { headers });
      const relays = [];
      let resolved = false;

      ws.addEventListener('open', () => {
        const subscriptionId = Math.random().toString(36).substring(7);
        ws.send(JSON.stringify([
          'REQ',
          subscriptionId,
          {
            kinds: [10002],
            authors: [pubkey],
            limit: 1,
          },
        ]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[2]) {
            const event = data[2];
            // Extract read relays from 'r' tags
            // Format: ['r', 'wss://relay.example.com'] or ['r', 'wss://relay.example.com', 'read']
            // If no marker, it's both read and write
            for (const tag of event.tags || []) {
              if (tag[0] === 'r' && tag[1]) {
                const marker = tag[2];
                if (!marker || marker === 'read') {
                  relays.push(tag[1]);
                }
              }
            }
          }

          if (data[0] === 'EOSE') {
            clearTimeout(timeout);
            resolved = true;
            try { ws.close(); } catch (_) { /* ignore */ }
            resolve(relays);
          }
        } catch (err) {
          console.error('[DM] Failed to parse relay list message:', err.message);
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve([]); // Don't reject, just return empty
        }
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve(relays);
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      resolve([]); // Don't reject
    }
  });
}

// --- Publishing ---

/**
 * Publish a signed nostr event to multiple relays in parallel.
 * @param {Object} event - Signed nostr event
 * @param {string[]} relayUrls - Relay WebSocket URLs
 * @param {Object} env
 * @returns {Promise<{ success: number, failed: number }>}
 */
export async function publishToRelays(event, relayUrls, env) {
  const results = await Promise.allSettled(
    relayUrls.map((url) => publishToSingleRelay(event, url, env))
  );

  let success = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      success++;
    } else {
      failed++;
    }
  }

  console.log(`[DM] Published to ${success}/${success + failed} relays`);
  return { success, failed };
}

/**
 * Publish event to a single relay via WebSocket.
 * Returns true on success, false on failure.
 */
function publishToSingleRelay(event, relayUrl, env) {
  return new Promise((resolve) => {
    let ws;
    const timeout = setTimeout(() => {
      try { if (ws) ws.close(); } catch (_) { /* ignore */ }
      console.warn(`[DM] Timeout publishing to ${relayUrl}`);
      resolve(false);
    }, RELAY_TIMEOUT_MS);

    try {
      const headers = {};
      if (relayUrl.includes('relay.divine.video') && env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }

      ws = new WebSocket(relayUrl, { headers });
      let resolved = false;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify(['EVENT', event]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // OK response: ["OK", event_id, success, message]
          if (data[0] === 'OK' && data[1] === event.id) {
            clearTimeout(timeout);
            resolved = true;
            try { ws.close(); } catch (_) { /* ignore */ }
            if (data[2]) {
              resolve(true);
            } else {
              console.warn(`[DM] Relay ${relayUrl} rejected event: ${data[3] || 'unknown reason'}`);
              resolve(false);
            }
          }
        } catch (err) {
          // Ignore parse errors on relay messages
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          console.warn(`[DM] WebSocket error for ${relayUrl}`);
          resolve(false);
        }
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      console.error(`[DM] Failed to connect to ${relayUrl}:`, error.message);
      resolve(false);
    }
  });
}

// --- DM Sending ---

/**
 * Send a moderation notification DM to a content creator.
 * Never throws - DM failures must not crash the moderation pipeline.
 *
 * @param {string} recipientPubkey - Hex pubkey of the content creator
 * @param {string} sha256 - Video hash
 * @param {string} action - PERMANENT_BAN, AGE_RESTRICTED, or QUARANTINE
 * @param {string} reason - Human-readable reason
 * @param {Object} env - Cloudflare Workers env
 * @param {Object} ctx - Execution context (for waitUntil)
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.categories] - JSON string of categories from moderation result
 * @param {string} [options.title] - Content title
 * @param {string} [options.publishedAt] - ISO date when content was published
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendModerationDM(recipientPubkey, sha256, action, reason, env, ctx, options = {}) {
  const { categories = null, title = null, publishedAt = null } = options || {};
  try {
    // Validate inputs
    if (!recipientPubkey || typeof recipientPubkey !== 'string') {
      return { sent: false, reason: 'Invalid recipient pubkey' };
    }
    // sha256 is optional — relay-only actions (ban_pubkey, delete_event) may not
    // have a content hash. Templates handle sha256=null by omitting the content link.
    if (sha256 && typeof sha256 !== 'string') {
      return { sent: false, reason: 'Invalid sha256' };
    }

    // Get moderator keys
    let keys;
    try {
      keys = getModeratorKeys(env);
    } catch (err) {
      console.error('[DM] Cannot send DM:', err.message);
      return { sent: false, reason: err.message };
    }

    // Build message: prefer category-specific template, fall back to generic
    const message = selectTemplate(action, reason, categories, sha256, title, publishedAt);
    if (!message) {
      return { sent: false, reason: `Unknown action: ${action}` };
    }

    // Check rate limit
    const withinLimit = await checkRateLimit(recipientPubkey, env);
    if (!withinLimit) {
      return { sent: false, reason: 'Rate limited' };
    }

    // Create NIP-17 gift-wrapped DM
    const wrappedEvent = wrapEvent(
      keys.privateKey,
      { publicKey: recipientPubkey },
      message
    );

    // Discover user relays
    const relayUrls = await discoverUserRelays(recipientPubkey, env);

    // Publish to relays
    const { success, failed } = await publishToRelays(wrappedEvent, relayUrls, env);

    if (success === 0) {
      console.error(`[DM] Failed to publish DM to any relay for ${recipientPubkey.substring(0, 16)}...`);
      return { sent: false, reason: 'All relay publishes failed' };
    }

    // Update rate limit
    await recordRateLimit(recipientPubkey, env);

    // Log to DM store (fire-and-forget, don't block on this)
    try {
      const { logDm, computeConversationId } = await import('./dm-store.mjs');
      const conversationId = computeConversationId(keys.publicKey, recipientPubkey);
      const logPromise = logDm(env.BLOSSOM_DB, {
        conversationId,
        sha256,
        direction: 'outgoing',
        senderPubkey: keys.publicKey,
        recipientPubkey,
        messageType: 'moderation_notice',
        content: message,
        nostrEventId: wrappedEvent.id,
      }).catch((err) => console.error('[DM] Failed to log DM:', err.message));
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(logPromise);
      } else {
        await logPromise;
      }
    } catch (err) {
      // dm-store.mjs may not exist yet (Phase 3)
      console.log('[DM] DM store not available, skipping log');
    }

    console.log(`[DM] Sent ${action} notification to ${recipientPubkey.substring(0, 16)}...${sha256 ? ` for ${sha256.substring(0, 16)}...` : ''} (${success} relays)`);
    return { sent: true, relaysPublished: success };
  } catch (err) {
    console.error('[DM] Unexpected error sending moderation DM:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Send a report outcome DM to the reporter who filed the report.
 * Never throws.
 *
 * @param {string} reporterPubkey - Hex pubkey of the reporter
 * @param {string} sha256 - Content hash that was reported
 * @param {string} action - Moderation action (PERMANENT_BAN, AGE_RESTRICTED, SAFE, etc.)
 * @param {Object} env
 * @param {Object} ctx
 * @param {Object} [metadata] - Optional content metadata {title, publishedAt, reportedAt}
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendReportOutcomeDM(reporterPubkey, sha256, action, env, ctx, metadata = {}) {
  try {
    if (!reporterPubkey || typeof reporterPubkey !== 'string') {
      return { sent: false, reason: 'Invalid reporter pubkey' };
    }

    let keys;
    try {
      keys = getModeratorKeys(env);
    } catch (err) {
      console.error('[DM] Cannot send report outcome DM:', err.message);
      return { sent: false, reason: err.message };
    }

    const message = getReportOutcomeMessage(action, sha256, metadata.title, metadata.publishedAt, metadata.reportedAt);

    const withinLimit = await checkRateLimit(reporterPubkey, env);
    if (!withinLimit) {
      return { sent: false, reason: 'Rate limited' };
    }

    const wrappedEvent = wrapEvent(
      keys.privateKey,
      { publicKey: reporterPubkey },
      message
    );

    const relayUrls = await discoverUserRelays(reporterPubkey, env);
    const { success } = await publishToRelays(wrappedEvent, relayUrls, env);

    if (success === 0) {
      return { sent: false, reason: 'All relay publishes failed' };
    }

    await recordRateLimit(reporterPubkey, env);

    // Log to DM store
    try {
      const { logDm, computeConversationId } = await import('./dm-store.mjs');
      const conversationId = computeConversationId(keys.publicKey, reporterPubkey);
      const logPromise = logDm(env.BLOSSOM_DB, {
        conversationId,
        sha256,
        direction: 'outgoing',
        senderPubkey: keys.publicKey,
        recipientPubkey: reporterPubkey,
        messageType: 'report_outcome',
        content: message,
        nostrEventId: wrappedEvent.id,
      }).catch((err) => console.error('[DM] Failed to log DM:', err.message));
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(logPromise);
      } else {
        await logPromise;
      }
    } catch (err) {
      console.log('[DM] DM store not available, skipping log');
    }

    console.log(`[DM] Sent report outcome to ${reporterPubkey.substring(0, 16)}... for ${sha256.substring(0, 16)}... (${success} relays)`);
    return { sent: true, relaysPublished: success };
  } catch (err) {
    console.error('[DM] Unexpected error sending report outcome DM:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Notify all reporters for a piece of content about the moderation outcome.
 * Queries user_reports for reporter pubkeys, sends each a report outcome DM.
 * Never throws. Logs failures per-reporter.
 *
 * @param {string} sha256 - Content hash
 * @param {string} action - Moderation action (PERMANENT_BAN, AGE_RESTRICTED, SAFE, etc.)
 * @param {Object} env - Environment with BLOSSOM_DB and NOSTR_PRIVATE_KEY
 * @param {string} logPrefix - Log prefix for context (e.g., "[ADMIN]", "[MODERATION]")
 * @returns {Promise<{ notified: number, failed: number }>}
 */
export async function notifyReporters(sha256, action, env, logPrefix = '[DM]') {
  if (!env.NOSTR_PRIVATE_KEY) {
    return { notified: 0, failed: 0 };
  }

  // Don't notify reporters for intermediate states. QUARANTINE and REVIEW are
  // pending human review -- the reporter should hear back when it resolves to
  // a final outcome (ban, age-restrict, or no-action).
  const INTERMEDIATE_ACTIONS = ['QUARANTINE', 'REVIEW'];
  if (INTERMEDIATE_ACTIONS.includes(action)) {
    return { notified: 0, failed: 0 };
  }

  let reporters;
  try {
    const { getReporterPubkeys } = await import('../reports.mjs');
    reporters = await getReporterPubkeys(env.BLOSSOM_DB, sha256);
  } catch (err) {
    console.error(`${logPrefix} Reporter notification lookup failed:`, err.message);
    return { notified: 0, failed: 0 };
  }

  if (reporters.length === 0) {
    return { notified: 0, failed: 0 };
  }

  // Fetch content metadata once for all reporters
  let contentMeta = {};
  try {
    const row = await env.BLOSSOM_DB.prepare(
      'SELECT title, published_at FROM moderation_results WHERE sha256 = ?'
    ).bind(sha256).first();
    if (row) {
      contentMeta = { title: row.title, publishedAt: row.published_at };
    }
  } catch (err) {
    console.error(`${logPrefix} Content metadata lookup failed:`, err.message);
  }

  let notified = 0;
  let failed = 0;
  for (const reporter of reporters) {
    try {
      const result = await sendReportOutcomeDM(reporter.pubkey, sha256, action, env, null, {
        title: contentMeta.title,
        publishedAt: contentMeta.publishedAt,
        reportedAt: reporter.reportedAt,
      });
      if (result.sent) {
        notified++;
        console.log(`${logPrefix} Reporter DM sent to ${reporter.pubkey.substring(0, 16)}...`);
      } else {
        failed++;
        console.error(`${logPrefix} Reporter DM not sent to ${reporter.pubkey.substring(0, 16)}...: ${result.reason}`);
      }
    } catch (rptErr) {
      failed++;
      console.error(`${logPrefix} Reporter DM failed for ${reporter.pubkey.substring(0, 16)}...:`, rptErr.message);
    }
  }

  return { notified, failed };
}

/**
 * Send a free-form moderator reply DM to a user.
 * Used from the admin dashboard for manual responses to appeals.
 * Never throws.
 *
 * @param {string} recipientPubkey - Hex pubkey of the recipient
 * @param {string} message - Free-form message text
 * @param {string} sha256 - Video hash (for conversation threading)
 * @param {Object} env
 * @param {Object} ctx
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendModeratorReply(recipientPubkey, message, sha256, env, ctx) {
  try {
    if (!recipientPubkey || typeof recipientPubkey !== 'string') {
      return { sent: false, reason: 'Invalid recipient pubkey' };
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return { sent: false, reason: 'Empty message' };
    }

    let keys;
    try {
      keys = getModeratorKeys(env);
    } catch (err) {
      console.error('[DM] Cannot send moderator reply:', err.message);
      return { sent: false, reason: err.message };
    }

    const withinLimit = await checkRateLimit(recipientPubkey, env);
    if (!withinLimit) {
      return { sent: false, reason: 'Rate limited' };
    }

    const wrappedEvent = wrapEvent(
      keys.privateKey,
      { publicKey: recipientPubkey },
      message.trim()
    );

    const relayUrls = await discoverUserRelays(recipientPubkey, env);
    const { success } = await publishToRelays(wrappedEvent, relayUrls, env);

    if (success === 0) {
      return { sent: false, reason: 'All relay publishes failed' };
    }

    await recordRateLimit(recipientPubkey, env);

    // Log to DM store
    try {
      const { logDm, computeConversationId } = await import('./dm-store.mjs');
      const conversationId = computeConversationId(keys.publicKey, recipientPubkey);
      const logPromise = logDm(env.BLOSSOM_DB, {
        conversationId,
        sha256,
        direction: 'outgoing',
        senderPubkey: keys.publicKey,
        recipientPubkey,
        messageType: 'moderator_reply',
        content: message.trim(),
        nostrEventId: wrappedEvent.id,
      }).catch((err) => console.error('[DM] Failed to log DM:', err.message));
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(logPromise);
      } else {
        await logPromise;
      }
    } catch (err) {
      console.log('[DM] DM store not available, skipping log');
    }

    console.log(`[DM] Sent moderator reply to ${recipientPubkey.substring(0, 16)}... for ${sha256.substring(0, 16)}... (${success} relays)`);
    return { sent: true, relaysPublished: success };
  } catch (err) {
    console.error('[DM] Unexpected error sending moderator reply:', err.message);
    return { sent: false, reason: err.message };
  }
}
