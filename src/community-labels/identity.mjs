// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Divine-identity gate — name-server by-pubkey lookup with KV cache.
// ABOUTME: Failures count an author as not-Divine (conservative) and are not cached.

const BY_PUBKEY_BASE = 'https://names.divine.video/api/username/by-pubkey';
// Matches the moderation NIP-05 resolution TTL used across Divine clients.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a pubkey resolves to a Divine identity (name@divine.video).
 *
 * Successful determinations (true or false) are cached in KV for 24h.
 * Lookup failures return false without caching so the next sweep retries.
 */
export async function isDivineIdentity(pubkey, { kv, fetchImpl = fetch, now = Date.now() }) {
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

  let found;
  try {
    const response = await fetchImpl(`${BY_PUBKEY_BASE}/${normalized}`);
    if (response.status !== 200) return false;
    const body = await response.json();
    found = body?.found === true;
  } catch {
    return false;
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
