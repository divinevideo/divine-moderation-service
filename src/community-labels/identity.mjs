// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Divine-identity gate — name-server by-pubkey lookup with KV cache.
// ABOUTME: Only definitive verdicts are cached; transient failures never are.

const BY_PUBKEY_BASE = 'https://names.divine.video/api/username/by-pubkey';
// Matches the moderation NIP-05 resolution TTL used across Divine clients.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function transientError(normalized, detail) {
  return new Error(`[identity] transient by-pubkey lookup failure for ${normalized}: ${detail}`);
}

/**
 * Whether a pubkey resolves to a Divine identity (name@divine.video).
 *
 * Only definitive verdicts are cached in KV for 24h: a 200 with a boolean
 * `found`. Transient failures — network error, non-200 (401/403/5xx), or a
 * malformed/unparseable 200 body — are never cached.
 *
 * `throwOnTransient` controls how a transient failure surfaces:
 * - false (default): the failure is swallowed and the pubkey counts as
 *   not-Divine (conservative). Used where a miscount is tolerable.
 * - true: the failure THROWS so the caller can hold its cursor and retry,
 *   rather than treating a transient blip as a confirmed non-Divine author.
 *   A confirmed 200 found:false still returns false (definitive).
 */
export async function isDivineIdentity(
  pubkey,
  { kv, fetchImpl = fetch, now = Date.now(), throwOnTransient = false },
) {
  const normalized = String(pubkey).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return false;

  const cacheKey = `divine_identity:${normalized}`;
  const cachedRaw = await kv.get(cacheKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      if (typeof cached?.value === 'boolean' && now - cached.at < CACHE_TTL_MS) {
        return cached.value;
      }
    } catch {
      // Corrupt cache entry: fall through to a fresh lookup.
    }
  }

  let response;
  try {
    response = await fetchImpl(`${BY_PUBKEY_BASE}/${normalized}`);
  } catch (error) {
    if (throwOnTransient) throw transientError(normalized, error?.message ?? String(error));
    return false;
  }

  if (response.status !== 200) {
    if (throwOnTransient) throw transientError(normalized, `status ${response.status}`);
    return false;
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (throwOnTransient) throw transientError(normalized, `unparseable body: ${error?.message ?? String(error)}`);
    body = null;
  }

  let found;
  if (typeof body?.found === 'boolean') {
    found = body.found;
  } else if (throwOnTransient) {
    throw transientError(normalized, 'malformed body (no boolean found)');
  } else {
    found = body?.found === true;
  }

  await kv.put(cacheKey, JSON.stringify({ value: found, at: now }));
  return found;
}

/**
 * Resolve a set of authors to a Map<pubkey, isDivine>. Sequential on
 * purpose: sweeps are batched and most lookups are KV cache hits.
 */
export async function resolveDivineAuthors(pubkeys, deps) {
  const map = new Map();
  for (const pubkey of pubkeys) {
    map.set(pubkey, await isDivineIdentity(pubkey, deps));
  }
  return map;
}
