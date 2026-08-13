// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Nostr event publisher for faro.nos.social moderation system
// ABOUTME: Creates and publishes NIP-56 (kind 1984) reports and NIP-32 (kind 1985) labels

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';
import { isContained } from './relay-override.mjs';

/**
 * NIP-32 label mapping for content categories
 */
export const CATEGORY_LABELS = {
  'nudity': 'nudity',
  'violence': 'violence',
  'gore': 'gore',
  'offensive': 'profanity',
  'weapon': 'weapons',
  'self_harm': 'self-harm',
  'recreational_drug': 'drugs',
  'alcohol': 'alcohol',
  'tobacco': 'tobacco',
  'ai_generated': 'ai-generated',
  'deepfake': 'deepfake',
  'medical': 'medical',
  'gambling': 'gambling'
};

/**
 * Publish moderation event to faro.nos.social
 * @param {Object} report - Moderation report data
 * @param {string} report.type - Report type: 'quarantine', 'review', 'safe'
 * @param {string} report.sha256 - Video hash
 * @param {Object} report.scores - Moderation scores
 * @param {string} [report.reason] - Human-readable reason
 * @param {string} [report.cdnUrl] - URL to video
 * @param {Object} env - Environment with Nostr credentials
 * @param {Object} [mockRelay] - Mock relay for testing
 */
export async function publishToFaro(report, env, mockRelay = null) {
  // Don't publish safe content
  if (report.type === 'safe') {
    return;
  }

  // Validate configuration
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }
  if (!env.FARO_RELAY_URL) {
    throw new Error('FARO_RELAY_URL not configured');
  }

  // Create kind 1984 report event (NIP-56)
  const event = createReportEvent(report, env.NOSTR_PRIVATE_KEY);

  // Publish to relay
  if (mockRelay) {
    // Testing path
    await mockRelay.publish(event);
  } else {
    // Production path - add Cloudflare Access headers if configured
    const relayOptions = {};
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      relayOptions.headers = {
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
      };
    }

    const relay = await Relay.connect(env.FARO_RELAY_URL, relayOptions);
    try {
      await relay.publish(event);
    } finally {
      relay.close();
    }
  }
}

/**
 * Publish moderation report to the content relay (relay.divine.video)
 * This ensures the content relay is aware of moderation decisions and can stop serving flagged events
 * @param {Object} report - Same report object as publishToFaro
 * @param {Object} env - Environment with Nostr credentials
 * @param {Object} [mockRelay] - Mock relay for testing
 */
export async function publishToContentRelay(report, env, mockRelay = null) {
  // Don't publish safe content
  if (report.type === 'safe') {
    return;
  }

  // Validate configuration
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }
  if (!env.NOSTR_RELAY_URL) {
    console.log('[PUBLISHER] NOSTR_RELAY_URL not configured, skipping content relay publish');
    return;
  }

  // Don't double-publish if content relay is the same as faro
  if (env.NOSTR_RELAY_URL === env.FARO_RELAY_URL) {
    console.log('[PUBLISHER] Content relay same as Faro relay, skipping duplicate publish');
    return;
  }

  // Create kind 1984 report event (NIP-56)
  const event = createReportEvent(report, env.NOSTR_PRIVATE_KEY);

  // Publish to content relay
  if (mockRelay) {
    await mockRelay.publish(event);
  } else {
    const relayOptions = {};
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      relayOptions.headers = {
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
      };
    }

    const relay = await Relay.connect(env.NOSTR_RELAY_URL, relayOptions);
    try {
      await relay.publish(event);
      console.log(`[PUBLISHER] NIP-56 report published to content relay ${env.NOSTR_RELAY_URL}`);
    } finally {
      relay.close();
    }
  }
}

/**
 * Create a signed NIP-56 report event
 * @param {Object} report - Report data
 * @param {string} privateKeyHex - Nostr private key (hex)
 * @returns {Object} Signed Nostr event
 */
function createReportEvent(report, privateKeyHex) {
  const { sha256, scores, reason, cdnUrl, type, source } = report;

  // Determine label based on primary concern
  let label = 'NS'; // Not Safe (NSFW)
  if (scores.violence > scores.nudity && scores.violence > (scores.ai_generated || 0)) {
    label = 'VI'; // Violence
  } else if ((scores.ai_generated || 0) > scores.nudity && (scores.ai_generated || 0) > scores.violence) {
    label = 'AI'; // AI-generated
  }

  // Build tags
  const tags = [
    ['L', 'MOD'],  // Namespace: Moderation
    ['l', label, 'MOD'],  // Label within MOD namespace
    ['p', sha256]  // Report target (using video hash as identifier)
  ];

  if (cdnUrl) {
    tags.push(['r', cdnUrl]);  // Reference URL
  }

  // Build content
  const content = JSON.stringify({
    reason: reason || `${type} flagged by automated moderation`,
    scores,
    type,
    source: source || 'ai',
    timestamp: Date.now()
  }, null, 2);

  // Create unsigned event
  const unsignedEvent = {
    kind: 1984,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  };

  // Sign event
  const secretKey = hexToBytes(privateKeyHex);
  const signedEvent = finalizeEvent(unsignedEvent, secretKey);

  return signedEvent;
}

/**
 * Publish a NIP-32 kind 1985 label event for human-verified content
 * @param {Object} labelData - Label information
 * @param {string} labelData.sha256 - Video hash
 * @param {string} labelData.category - Category being labeled (e.g., 'ai_generated')
 * @param {string} labelData.status - 'confirmed' or 'rejected'
 * @param {number} labelData.score - AI confidence score (0-1)
 * @param {string} [labelData.cdnUrl] - URL to video
 * @param {string} [labelData.nostrEventId] - Original Nostr event ID if known
 * @param {string} [labelData.source] - 'human-moderator' (default) or 'automated' (Hive/RD/etc.)
 * @param {Object} env - Environment with Nostr credentials
 * @param {Object} [mockRelay] - Mock relay for testing
 * @returns {Promise<Object>} Published event details
 */
export async function publishLabelEvent(labelData, env, mockRelay = null) {
  const { sha256, category, status, nostrEventId } = labelData;

  const event = buildLabelEvent(labelData, env);
  if (!event) {
    return { published: false, reason: 'No signing key configured' };
  }

  console.log(`[LABEL] Publishing kind 1985 label: ${category}=${status} for ${sha256 ?? `event ${nostrEventId}`}`);
  return publishPreparedLabelEvent(event, env, mockRelay);
}

/**
 * Build (but do not publish) a signed NIP-32 kind 1985 label event.
 *
 * Split out from {@link publishLabelEvent} so callers that must persist the
 * exact event bytes BEFORE publishing (the community sweep's claim-before-send)
 * can store this event and replay it verbatim on retry — a code or key change
 * between publish and confirm then cannot mint a second label id.
 *
 * @param {Object} labelData - Same shape as {@link publishLabelEvent}.
 * @param {Object} env - Environment with Nostr credentials.
 * @returns {Object|null} Signed event, or null when no signing key is configured.
 */
export function buildLabelEvent(labelData, env) {
  if (!env.NOSTR_PRIVATE_KEY) {
    console.log('[LABEL] No NOSTR_PRIVATE_KEY configured, skipping label build');
    return null;
  }
  return createLabelEvent(labelData, env.NOSTR_PRIVATE_KEY);
}

/**
 * Publish an already-signed label event verbatim.
 *
 * The event is published exactly as given — no rebuild, no re-sign — so a
 * caller replaying a stored event across retries gets a byte-identical event
 * the relay dedups by id.
 *
 * @param {Object} event - A signed kind 1985 event (from {@link buildLabelEvent}).
 * @param {Object} env - Environment with relay config.
 * @param {Object} [mockRelay] - Mock relay for testing.
 * @returns {Promise<Object>} Publish result ({ published, eventId, ... }).
 */
export async function publishPreparedLabelEvent(event, env, mockRelay = null) {
  const relayUrl = env.NOSTR_RELAY_URL || env.FARO_RELAY_URL;
  if (!relayUrl) {
    console.log('[LABEL] No relay URL configured, skipping label publish');
    return { published: false, reason: 'No relay URL configured' };
  }

  try {
    if (mockRelay) {
      await mockRelay.publish(event);
      return {
        published: true,
        eventId: event.id,
        pubkey: event.pubkey,
        relay: relayUrl
      };
    }

    // Connect and publish
    const relayOptions = {};
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      relayOptions.headers = {
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
      };
    }

    const relay = await Relay.connect(relayUrl, relayOptions);
    try {
      await relay.publish(event);
      console.log(`[LABEL] Published label event ${event.id} to ${relayUrl}`);
      return {
        published: true,
        eventId: event.id,
        pubkey: event.pubkey,
        relay: relayUrl
      };
    } finally {
      relay.close();
    }
  } catch (error) {
    console.error(`[LABEL] Failed to publish label event:`, error.message);
    return { published: false, reason: error.message };
  }
}

/**
 * Create a signed NIP-32 label event (kind 1985)
 * @param {Object} labelData - Label data
 * @param {string} privateKeyHex - Nostr private key (hex)
 * @returns {Object} Signed Nostr event
 */
function createLabelEvent(labelData, privateKeyHex) {
  const { sha256, category, status, score, cdnUrl, nostrEventId, voteCount } = labelData;
  const source = ['automated', 'community'].includes(labelData.source)
    ? labelData.source
    : 'human-moderator';
  const verified = source === 'human-moderator';

  // Get the standard label name
  const labelName = CATEGORY_LABELS[category] || category;

  // Namespace for content warnings
  const namespace = 'content-warning';

  // Build tags
  const tags = [
    ['L', namespace],  // Label namespace declaration
  ];

  // For confirmed labels, add the positive label
  // For rejected labels, add a "not-X" label to indicate the labeler says it is NOT this
  if (status === 'confirmed') {
    // Positive label with metadata
    const metadata = JSON.stringify({
      confidence: score,
      verified,
      source,
      sha256: sha256
    });
    tags.push(['l', labelName, namespace, metadata]);
  } else if (status === 'rejected') {
    // Negative label - labeler says this is NOT the category
    const metadata = JSON.stringify({
      confidence: score,
      verified,
      source,
      rejected: true,
      sha256: sha256
    });
    tags.push(['l', `not-${labelName}`, namespace, metadata]);
  }

  // Reference the content being labeled
  if (nostrEventId) {
    tags.push(['e', nostrEventId]);  // Reference Nostr event
  }

  // Add reference URL
  if (cdnUrl) {
    tags.push(['r', cdnUrl]);
  }

  // Include the sha256 identifier when the video carries one; videos with
  // no x/imeta-x tag stay targetable via the e tag alone.
  if (sha256) {
    tags.push(['x', sha256]);  // Content hash reference
  }

  // Build content (human-readable summary)
  let content;
  if (source === 'community') {
    content = `Community consensus flagged: This content contains ${labelName} (${voteCount} distinct reporters)`;
  } else {
    const subject = source === 'automated' ? 'Automated moderator flagged' : 'Human moderator verified';
    content = status === 'confirmed'
      ? `${subject}: This content contains ${labelName} (confidence: ${(score * 100).toFixed(0)}%)`
      : `${subject}: This content does NOT contain ${labelName} (was ${(score * 100).toFixed(0)}%)`;
  }

  // A caller-supplied created_at makes the event id deterministic across
  // retries (the community sweep freezes it in its claim row so the relay
  // dedups a re-published label by id). Absent one, stamp the current time.
  const createdAt = Number.isInteger(labelData.createdAt) && labelData.createdAt > 0
    ? labelData.createdAt
    : Math.floor(Date.now() / 1000);

  // Create unsigned event
  const unsignedEvent = {
    kind: 1985,  // NIP-32 label event
    created_at: createdAt,
    tags,
    content
  };

  // Sign event
  const secretKey = hexToBytes(privateKeyHex);
  const signedEvent = finalizeEvent(unsignedEvent, secretKey);

  return signedEvent;
}

/**
 * Build a signed NIP-17 kind 10050 DM inbox relay list event.
 *
 * The `relay` tags advertise where this pubkey receives gift-wrapped (kind 1059)
 * DMs. They must match where we actually read from (see dm-reader), or senders
 * will deliver to relays we don't listen on.
 *
 * @param {string[]} inboxRelays - Relay URLs where moderation@ receives DMs.
 * @param {string} privateKeyHex - Signing key (hex).
 * @returns {Object} Signed kind-10050 event.
 */
function createDmInboxRelayListEvent(inboxRelays, privateKeyHex) {
  const tags = inboxRelays.map((url) => ['relay', url]);

  const unsignedEvent = {
    kind: 10050,  // NIP-17 DM inbox relay list
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  };

  const secretKey = hexToBytes(privateKeyHex);
  return finalizeEvent(unsignedEvent, secretKey);
}

/**
 * Publish moderation@'s NIP-17 kind 10050 DM inbox relay list.
 *
 * Without this, the moderation account has no advertised DM inbox, so a strict
 * NIP-17 client "shouldn't try" to message it. The `relay` tags point only at
 * the relay we actually poll for DMs; we additionally push the event to public
 * aggregators so clients can discover it. Replaceable (kind 10050), so this is
 * idempotent and safe to republish.
 *
 * @param {Object} env - Worker environment (NOSTR_PRIVATE_KEY, relay config).
 * @param {Object} [opts] - Test seams.
 * @param {(url: string) => Promise<{publish: Function, close: Function}>} [opts.connect]
 *   - Relay connector for the multi-relay path; defaults to the real transport.
 *     Injected in tests so the per-relay success/failure branches are deterministic
 *     and never touch the network (the pool runs all files in one worker, so a
 *     module-level mock of the transport does not reliably isolate).
 * @returns {Promise<Object>} Publish summary.
 */
export async function publishDmInboxRelayList(env, { connect = Relay.connect } = {}) {
  if (!env.NOSTR_PRIVATE_KEY) {
    console.log('[DM-INBOX] No NOSTR_PRIVATE_KEY configured, skipping DM inbox publish');
    return { published: false, reason: 'No signing key configured' };
  }

  // DM_RELAY_URLS declares a non-production run, and this is the second path that
  // publishes with the signing key. Announcing widely is right in production and
  // wrong here: a contained run would tell purplepag.es, relay.nostr.band and
  // relay.damus.io that moderation@'s DM inbox is a localhost relay, replacing
  // the real kind-10050 on the relays clients actually consult. Strict NIP-17
  // clients could then not deliver DMs to the moderation account until it was
  // republished.
  //
  // `isContained` is true whenever the variable is PRESENT, including when its
  // value is unusable, and it is shared with the DM path on purpose. When the two
  // parsed it separately they disagreed: a TOML array made the DM path refuse
  // while this one took the production branch, so the exact misconfiguration the
  // refusal exists to catch produced the exact harm it exists to prevent.
  const contained = isContained(env);

  // Inbox = where dm-reader actually polls for gift-wrapped DMs. Keep in sync with it.
  //
  // Suppressing the discovery relays is not enough to contain this path, because
  // homeRelay is unconditionally a target and its fallback is the production
  // relay. A contained run with no explicit home relay would still publish a
  // freshly-signed REPLACEABLE kind-10050 to relay.divine.video with the real key.
  // Containment must not depend on remembering a second variable, so with nothing
  // safe to announce, it does not announce.
  if (contained && !env.RELAY_POLLING_RELAY_URL) {
    console.warn(
      '[DM-INBOX] DM_RELAY_URLS is set but RELAY_POLLING_RELAY_URL is not. ' +
        'Skipping the kind-10050 announcement rather than publishing to the ' +
        'production relay from a run declared contained.',
    );
    return { published: false, reason: 'Contained run without RELAY_POLLING_RELAY_URL' };
  }

  const homeRelay = env.RELAY_POLLING_RELAY_URL || 'wss://relay.divine.video';
  const inboxRelays = [homeRelay];

  // Discovery targets: where we publish the event so clients can resolve it.
  if (contained && env.DM_INBOX_DISCOVERY_RELAYS) {
    console.warn(
      '[DM-INBOX] Ignoring DM_INBOX_DISCOVERY_RELAYS because DM_RELAY_URLS is set. ' +
        'A contained run announces only to its own home relay.',
    );
  }
  const discoveryRelays = contained
    ? []
    : env.DM_INBOX_DISCOVERY_RELAYS
      ? env.DM_INBOX_DISCOVERY_RELAYS.split(',').map((r) => r.trim()).filter(Boolean)
      : ['wss://purplepag.es', 'wss://relay.nostr.band', 'wss://relay.damus.io'];
  const targets = [...new Set([homeRelay, ...discoveryRelays])];

  const event = createDmInboxRelayListEvent(inboxRelays, env.NOSTR_PRIVATE_KEY);
  console.log(`[DM-INBOX] Publishing kind 10050 ${event.id} (inbox: ${inboxRelays.join(', ')}) to ${targets.length} relays`);

  const published = [];
  const failed = [];
  for (const url of targets) {
    try {
      // relay.divine.video is a public Nostr relay that does not require CF Access for
      // protocol traffic (matches the read path in dm-reader.mjs), and CF Access creds
      // must never be sent to third-party discovery relays — so we send no headers here.
      const relay = await connect(url);
      try {
        await relay.publish(event);
        console.log(`[DM-INBOX] Published kind 10050 ${event.id} to ${url}`);
        published.push(url);
      } finally {
        relay.close();
      }
    } catch (error) {
      const reason = error?.message || String(error);
      console.error(`[DM-INBOX] Failed to publish to ${url}:`, reason);
      failed.push({ relay: url, reason });
    }
  }

  return {
    published: published.length > 0,
    // The home relay is the only inbox tag and where we actually read DMs, so callers
    // throttle on this rather than on best-effort discovery-relay success.
    homeRelayPublished: published.includes(homeRelay),
    eventId: event.id,
    pubkey: event.pubkey,
    relays: published,
    failed
  };
}
