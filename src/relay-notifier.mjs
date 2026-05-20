// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: NIP-98 outbound client paired with notifyBlossom — adds/removes
// ABOUTME: events from funnelcake's quarantined_events_set on action transitions.

import { finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

const QUARANTINE_PATH = '/api/moderation/quarantine';
const HEX64 = /^[0-9a-f]{64}$/;

function sha256Hex(bytes) {
  return bytesToHex(sha256(bytes));
}

function buildNip98Token(privateKeyHex, method, url, bodyBytes) {
  const tags = [
    ['u', url],
    ['method', method],
  ];
  if (bodyBytes && bodyBytes.length > 0) {
    tags.push(['payload', sha256Hex(bodyBytes)]);
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    hexToBytes(privateKeyHex),
  );
  // Cloudflare Workers don't have Buffer; use btoa with the JSON-stringified event.
  // btoa requires Latin-1; the JSON of a NIP-98 event is ASCII so it's safe.
  const json = JSON.stringify(event);
  return typeof Buffer !== 'undefined'
    ? Buffer.from(json).toString('base64')
    : btoa(json);
}

/**
 * Tell funnelcake to add/remove the relay event from its quarantine Set so
 * public/discovery feeds stop serving it (or resume serving it on un-quarantine).
 *
 * Symmetric with notifyBlossom: same call site in handleModerationResult,
 * same {success, skipped, error} shape, same fire-and-forget failure mode.
 *
 * @param {string} sha256Hex Video sha256 (carried for logging only)
 * @param {string|null} eventId Relay event id (kind 34236). Required.
 * @param {string} action SAFE | REVIEW | QUARANTINE | AGE_RESTRICTED | PERMANENT_BAN | DELETE
 * @param {Object} env Worker env. Reads FUNNELCAKE_ADMIN_URL, NOSTR_PRIVATE_KEY.
 * @param {typeof fetch} [fetcher] Injected fetch for testing.
 * @returns {Promise<{success: boolean, skipped?: boolean, reason?: string, error?: string}>}
 */
export async function notifyRelay(sha256Hex, eventId, action, env, fetcher = fetch) {
  if (!env?.FUNNELCAKE_ADMIN_URL) {
    return { success: true, skipped: true, reason: 'FUNNELCAKE_ADMIN_URL not configured' };
  }
  if (action === 'PERMANENT_BAN') {
    // PERMANENT_BAN already deletes the event via NIP-09; quarantine entry
    // (if any) becomes moot once the event is deleted.
    return { success: true, skipped: true, reason: 'PERMANENT_BAN handled by NIP-09 path' };
  }
  if (action === 'REVIEW') {
    // REVIEW is internal — content stays publicly accessible until a moderator decides.
    return { success: true, skipped: true, reason: 'REVIEW is internal-only' };
  }
  if (action === 'DELETE') {
    // Creator kind-5 deletes already handled relay-side removal before this
    // moderation API path mirrors the terminal blob state into Blossom.
    return { success: true, skipped: true, reason: 'DELETE assumes relay-side removal already happened' };
  }
  if (!eventId) {
    return { success: true, skipped: true, reason: 'no event_id on moderation result' };
  }
  if (!HEX64.test(eventId)) {
    return { success: false, skipped: true, error: 'event_id must be 64-char lowercase hex' };
  }
  if (!env.NOSTR_PRIVATE_KEY) {
    return { success: false, error: 'NOSTR_PRIVATE_KEY not configured' };
  }

  const isQuarantine = action === 'QUARANTINE';
  const isClear = action === 'SAFE' || action === 'AGE_RESTRICTED';

  if (!isQuarantine && !isClear) {
    return { success: true, skipped: true, reason: `no relay action for ${action}` };
  }

  const url = isQuarantine
    ? `${env.FUNNELCAKE_ADMIN_URL}${QUARANTINE_PATH}`
    : `${env.FUNNELCAKE_ADMIN_URL}${QUARANTINE_PATH}/${eventId}`;
  const method = isQuarantine ? 'POST' : 'DELETE';
  const bodyObj = isQuarantine
    ? { event_id: eventId, reason: `auto-${action.toLowerCase()}` }
    : null;
  const bodyBytes = bodyObj ? new TextEncoder().encode(JSON.stringify(bodyObj)) : null;

  const token = buildNip98Token(env.NOSTR_PRIVATE_KEY, method, url, bodyBytes);

  try {
    const headers = {
      Authorization: `Nostr ${token}`,
      'Content-Type': 'application/json',
    };
    const init = { method, headers };
    if (bodyBytes) {
      init.body = JSON.stringify(bodyObj);
    }
    const res = await fetcher(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
