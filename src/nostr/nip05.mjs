// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Resolves a nip-05 "user@domain" to an authoritative hex pubkey via the
// ABOUTME: domain's .well-known/nostr.json. KV-cached (1h). null on any failure.

const NIP05_CACHE_TTL = 3600; // 1 hour
const FETCH_TIMEOUT_MS = 5000;

const LOCAL_PART_RE = /^[a-z0-9._-]+$/i;
// Deliberately strict allowlist on an egress path: requires an alpha TLD of 2+
// chars, so trailing dots and punycode (xn--) TLDs are rejected by design.
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

// Divine issues NIP-05 in two equivalent forms, both shown on profiles as
// "@username.divine.video": username@divine.video (apex) and
// _@username.divine.video (per-user subdomain). Profiles render the leading-@
// form, so that is what moderators paste.
const DIVINE_APEXES = ['divine.video', 'dvine.video'];
const DEFAULT_DIVINE_APEX = 'divine.video';

/**
 * Normalize the recipient forms a moderator actually sees into a canonical
 * "localpart@domain" NIP-05 address. Divine display forms map to the subdomain
 * identity; canonical and cross-domain forms pass through unchanged:
 *   @mjb.divine.video  -> _@mjb.divine.video   (profile badge)
 *   @mjb / mjb         -> _@mjb.divine.video   (bare handle, divine default)
 *   mjb.divine.video   -> _@mjb.divine.video   (subdomain host, e.g. from URL)
 *   mjb@divine.video, _@mjb.divine.video, mjb@nos.social -> unchanged
 * Returns the canonical address string, or null if there's nothing to resolve.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeNip05Input(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1).trim();
  if (!s) return null;
  if (s.includes('@')) return s;          // already localpart@domain
  if (s.includes('.')) return `_@${s}`;   // bare host (e.g. mjb.divine.video) -> root id
  return `_@${s}.${DEFAULT_DIVINE_APEX}`;  // bare handle -> divine subdomain
}

/**
 * Friendly display for a resolved divine address ("@username.divine.video"),
 * matching what profile pages show. Returns null for non-divine addresses.
 */
function divineDisplayName(name, domain) {
  for (const apex of DIVINE_APEXES) {
    if (name === '_' && domain.endsWith(`.${apex}`)) {
      const sub = domain.slice(0, -(apex.length + 1));
      if (sub && !sub.includes('.')) return `@${sub}.${apex}`;
    }
    if (domain === apex) return `@${name}.${apex}`;
  }
  return null;
}

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
  const parsed = parseNip05(normalizeNip05Input(address));
  if (!parsed) return null;
  const { name, domain } = parsed;
  const canonical = `${name}@${domain}`;
  const display = divineDisplayName(name, domain) || canonical;
  const cacheKey = `nip05:${canonical.toLowerCase()}`;

  if (env?.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(cacheKey);
      if (cached !== null) {
        const { pubkey } = JSON.parse(cached);
        return pubkey ? { pubkey, address: canonical, domain, display } : null;
      }
    } catch { /* ignore cache read errors */ }
  }

  let pubkey = null;
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // NIP-05: "Fetchers MUST ignore any HTTP redirects." Also an SSRF guard —
      // a moderator-supplied domain could 302 to an internal host, defeating
      // "resolve at the authoritative source". 'manual' yields an opaque-redirect
      // response whose res.ok is false, so the if (res.ok) branch returns null.
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const json = await res.json();
      // NIP-05 local part is case-sensitive; only the domain is lowercased.
      // Do not lowercase `name` here or resolution breaks for mixed-case names.
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

  return pubkey ? { pubkey, address: canonical, domain, display } : null;
}
