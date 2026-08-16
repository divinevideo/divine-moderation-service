// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Nostr event publisher for faro.nos.social moderation system
// ABOUTME: Creates and publishes NIP-56 (kind 1984) reports and NIP-32 (kind 1985) labels

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from '@noble/hashes/utils';

/**
 * NIP-32 label mapping for content categories
 */
const CATEGORY_LABELS = {
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
 * @returns {Promise<Object>} Publish result with success status and event details
 */
export async function publishToFaro(report, env, mockRelay = null) {
  // Don't publish safe content
  if (report.type === 'safe') {
    return { published: false, reason: 'Safe content not published', skipped: true };
  }

  // Validate configuration
  if (!env.NOSTR_PRIVATE_KEY) {
    throw new Error('NOSTR_PRIVATE_KEY not configured');
  }
  const relayUrl = env.NOSTR_RELAY_URL || env.FARO_RELAY_URL;
  if (!relayUrl) {
    throw new Error('No relay URL configured (set NOSTR_RELAY_URL or FARO_RELAY_URL)');
  }

  // Create kind 1984 report event (NIP-56)
  const event = createReportEvent(report, env.NOSTR_PRIVATE_KEY);

  console.log(`[PUBLISH] Publishing kind 1984 event ${event.id.substring(0, 16)}... for ${report.sha256.substring(0, 16)}...`);

  // Publish to relay
  if (mockRelay) {
    // Testing path
    await mockRelay.publish(event);
    return {
      published: true,
      eventId: event.id,
      pubkey: event.pubkey,
      relay: 'mock',
      verified: true
    };
  } else {
    // Production path - add Cloudflare Access headers if configured
    const relayOptions = {};
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      relayOptions.headers = {
        'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
      };
    }

    const relay = await Relay.connect(relayUrl, relayOptions);
    try {
      // relay.publish() returns a promise that:
      // - resolves when relay sends OK with success=true
      // - rejects when relay sends OK with success=false or on timeout/error
      await relay.publish(event);

      console.log(`[PUBLISH] ✅ Relay accepted event ${event.id.substring(0, 16)}... on ${relayUrl}`);

      // Verify the event was actually stored by querying for it
      let verified = false;
      try {
        verified = await verifyEventOnRelay(relay, event.id);
        if (verified) {
          console.log(`[PUBLISH] ✅ Verified event ${event.id.substring(0, 16)}... exists on relay`);
        } else {
          console.warn(`[PUBLISH] ⚠️ Event ${event.id.substring(0, 16)}... accepted but not found on query`);
        }
      } catch (verifyErr) {
        console.warn(`[PUBLISH] ⚠️ Could not verify event: ${verifyErr.message}`);
      }

      return {
        published: true,
        eventId: event.id,
        pubkey: event.pubkey,
        relay: relayUrl,
        verified,
        sha256: report.sha256,
        type: report.type
      };
    } catch (publishErr) {
      console.error(`[PUBLISH] ❌ Relay rejected event ${event.id.substring(0, 16)}...: ${publishErr.message}`);
      return {
        published: false,
        eventId: event.id,
        pubkey: event.pubkey,
        relay: relayUrl,
        verified: false,
        error: publishErr.message,
        sha256: report.sha256,
        type: report.type
      };
    } finally {
      relay.close();
    }
  }
}

/**
 * Verify an event exists on the relay by querying for it
 * @param {Relay} relay - Connected relay instance
 * @param {string} eventId - Event ID to look for
 * @returns {Promise<boolean>} True if event was found
 */
async function verifyEventOnRelay(relay, eventId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(false);
    }, 3000); // 3 second timeout for verification

    const sub = relay.subscribe(
      [{ ids: [eventId], limit: 1 }],
      {
        onevent: () => {
          clearTimeout(timeout);
          sub.close();
          resolve(true);
        },
        oneose: () => {
          clearTimeout(timeout);
          sub.close();
          resolve(false);
        }
      }
    );
  });
}

/**
 * Create a signed NIP-56 report event
 * @param {Object} report - Report data
 * @param {string} privateKeyHex - Nostr private key (hex)
 * @returns {Object} Signed Nostr event
 */
function createReportEvent(report, privateKeyHex) {
  const { sha256, scores, reason, cdnUrl, type } = report;

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
    ['l', label, 'MOD']  // Label within MOD namespace
  ];

  // Identify target by content hash using standard 'x' tag
  if (sha256) {
    tags.push(['x', sha256]);
  }

  if (cdnUrl) {
    tags.push(['r', cdnUrl]);  // Reference URL
  }

  // Build content
  const content = JSON.stringify({
    reason: reason || `${type} flagged by automated moderation`,
    scores,
    type,
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
 * @param {Object} env - Environment with Nostr credentials
 * @returns {Promise<Object>} Published event details
 */
export async function publishLabelEvent(labelData, env) {
  const { sha256, category, status, score, cdnUrl, nostrEventId } = labelData;

  // Validate configuration
  if (!env.MODERATOR_NSEC && !env.NOSTR_PRIVATE_KEY) {
    console.log('[LABEL] No MODERATOR_NSEC or NOSTR_PRIVATE_KEY configured, skipping label publish');
    return { published: false, reason: 'No signing key configured' };
  }

  const relayUrl = env.NOSTR_RELAY_URL || env.FARO_RELAY_URL;
  if (!relayUrl) {
    console.log('[LABEL] No relay URL configured, skipping label publish');
    return { published: false, reason: 'No relay URL configured' };
  }

  // Use moderator key if available, otherwise fall back to service key
  const privateKeyHex = env.MODERATOR_NSEC || env.NOSTR_PRIVATE_KEY;

  // Create the label event
  const event = createLabelEvent(labelData, privateKeyHex);

  console.log(`[LABEL] Publishing kind 1985 label: ${category}=${status} for ${sha256.substring(0, 16)}...`);

  try {
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
  const { sha256, category, status, score, cdnUrl, nostrEventId } = labelData;

  // Get the standard label name
  const labelName = CATEGORY_LABELS[category] || category;

  // Namespace for content warnings
  const namespace = 'content-warning';

  // Build tags
  const tags = [
    ['L', namespace],  // Label namespace declaration
  ];

  // For confirmed labels, add the positive label
  // For rejected labels, add a "not-X" label to indicate human verified it's NOT this
  if (status === 'confirmed') {
    // Positive label with metadata
    const metadata = JSON.stringify({
      confidence: score,
      verified: true,
      source: 'human-moderator',
      sha256: sha256
    });
    tags.push(['l', labelName, namespace, metadata]);
  } else if (status === 'rejected') {
    // Negative label - human verified this is NOT the category
    const metadata = JSON.stringify({
      confidence: score,
      verified: true,
      source: 'human-moderator',
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

  // Always include the sha256 as an identifier
  tags.push(['x', sha256]);  // Content hash reference

  // Build content (human-readable summary)
  const content = status === 'confirmed'
    ? `Human moderator verified: This content contains ${labelName} (AI confidence: ${(score * 100).toFixed(0)}%)`
    : `Human moderator verified: This content does NOT contain ${labelName} (AI false positive, was ${(score * 100).toFixed(0)}%)`;

  // Create unsigned event
  const unsignedEvent = {
    kind: 1985,  // NIP-32 label event
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  };

  // Sign event
  const secretKey = hexToBytes(privateKeyHex);
  const signedEvent = finalizeEvent(unsignedEvent, secretKey);

  return signedEvent;
}
