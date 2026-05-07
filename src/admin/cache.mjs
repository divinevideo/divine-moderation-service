// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tiny KV wrapper for caching stat aggregates with non-blocking writes.

const KEY_PREFIX = 'stats:v1:';

/**
 * Cache the result of an expensive aggregate (e.g. SELECT COUNT/GROUP BY
 * over moderation_results) in MODERATION_KV with a short TTL. Read is
 * blocking; write is non-blocking (ctx.waitUntil).
 *
 * `?fresh=1` should set `options.fresh = true` to bypass the cache read,
 * but the helper still writes the fresh value back. This avoids a cache
 * stampede where many concurrent Refresh clicks all skip-and-recompute:
 * the first to finish populates KV for the rest.
 *
 * @param {object} env - worker env
 * @param {{waitUntil: (p: Promise<unknown>) => void}} ctx - fetch handler ctx
 * @param {string} key - cache key suffix (e.g. "admin-stats")
 * @param {number} ttlSeconds - KV TTL (60 is a reasonable default)
 * @param {() => Promise<unknown>} compute - the expensive aggregate
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<unknown>}
 */
export async function cachedStat(env, ctx, key, ttlSeconds, compute, options = {}) {
  const fullKey = `${KEY_PREFIX}${key}`;
  if (!options.fresh) {
    const cached = await env.MODERATION_KV.get(fullKey);
    if (cached !== null) {
      try {
        return JSON.parse(cached);
      } catch {
        // Corrupt cache entry — fall through to recompute.
      }
    }
  }
  const fresh = await compute();
  const writePromise = env.MODERATION_KV.put(fullKey, JSON.stringify(fresh), {
    expirationTtl: ttlSeconds,
  });
  // Production: hand the write to ctx.waitUntil and return immediately.
  // Tests / unusual call sites without ctx: await the write so we don't
  // throw on `ctx.waitUntil` being undefined.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(writePromise);
  } else {
    await writePromise;
  }
  return fresh;
}
