// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Resolves a nip-05 "user@domain" to an authoritative hex pubkey via the
// ABOUTME: domain's .well-known/nostr.json. KV-cached (1h). null on any failure.

const NIP05_CACHE_TTL = 3600; // 1 hour
const FETCH_TIMEOUT_MS = 5000;

const LOCAL_PART_RE = /^[a-z0-9._-]+$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Parse "user@domain" into { name, domain } or null if malformed.
 * @param {string} address
 * @returns {{name: string, domain: string} | null}
 */
export function parseNip05(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const name = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!LOCAL_PART_RE.test(name) || !DOMAIN_RE.test(domain)) return null;
  return { name, domain };
}

/**
 * Resolve a nip-05 address to an authoritative hex pubkey.
 * Returns { pubkey, address, domain } or null.
 * @param {string} address - "user@domain"
 * @param {Object} env - Cloudflare env (uses MODERATION_KV for caching)
 */
export async function resolveNip05(address, env) {
  const parsed = parseNip05(address);
  if (!parsed) return null;
  const { name, domain } = parsed;
  const canonical = `${name}@${domain}`;
  const cacheKey = `nip05:${canonical.toLowerCase()}`;

  if (env?.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(cacheKey);
      if (cached !== null) {
        const { pubkey } = JSON.parse(cached);
        return pubkey ? { pubkey, address: canonical, domain } : null;
      }
    } catch { /* ignore cache read errors */ }
  }

  let pubkey = null;
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const json = await res.json();
      const found = json?.names?.[name];
      if (typeof found === 'string' && HEX64_RE.test(found)) {
        pubkey = found.toLowerCase();
      }
    }
  } catch (err) {
    console.error('[NIP05] resolve failed:', err.message);
  }

  if (env?.MODERATION_KV) {
    try {
      await env.MODERATION_KV.put(cacheKey, JSON.stringify({ pubkey: pubkey || null }), {
        expirationTtl: NIP05_CACHE_TTL,
      });
    } catch { /* ignore cache write errors */ }
  }

  return pubkey ? { pubkey, address: canonical, domain } : null;
}
