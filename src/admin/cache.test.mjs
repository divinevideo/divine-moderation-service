// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for cachedStat — KV-backed stat aggregate cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cachedStat } from './cache.mjs';
import { env } from 'cloudflare:test';

const KEY = 'stats:v1:test';

beforeEach(async () => {
  await env.MODERATION_KV.delete(KEY);
});

describe('cachedStat', () => {
  it('computes on miss and writes via waitUntil', async () => {
    const compute = vi.fn().mockResolvedValue({ ok: 1 });
    const writes = [];
    const waitUntil = (p) => writes.push(p);
    const result = await cachedStat(env, { waitUntil }, 'test', 60, compute);
    expect(result).toEqual({ ok: 1 });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    await Promise.all(writes);
    const cached = JSON.parse(await env.MODERATION_KV.get(KEY));
    expect(cached).toEqual({ ok: 1 });
  });

  it('returns cached value on hit without calling compute', async () => {
    await env.MODERATION_KV.put(KEY, JSON.stringify({ ok: 99 }));
    const compute = vi.fn();
    const result = await cachedStat(env, { waitUntil: () => {} }, 'test', 60, compute);
    expect(result).toEqual({ ok: 99 });
    expect(compute).not.toHaveBeenCalled();
  });

  it('bypasses cache read when fresh=true but still writes back', async () => {
    await env.MODERATION_KV.put(KEY, JSON.stringify({ ok: 'stale' }));
    const compute = vi.fn().mockResolvedValue({ ok: 'fresh' });
    const writes = [];
    const waitUntil = (p) => writes.push(p);
    const result = await cachedStat(env, { waitUntil }, 'test', 60, compute, { fresh: true });
    expect(result).toEqual({ ok: 'fresh' });
    expect(compute).toHaveBeenCalledTimes(1);
    await Promise.all(writes);
    const cached = JSON.parse(await env.MODERATION_KV.get(KEY));
    expect(cached).toEqual({ ok: 'fresh' });
  });

  it('falls through to compute when cached value is corrupt JSON', async () => {
    await env.MODERATION_KV.put(KEY, '{not valid json');
    const compute = vi.fn().mockResolvedValue({ ok: 'recovered' });
    const writes = [];
    const waitUntil = (p) => writes.push(p);
    const result = await cachedStat(env, { waitUntil }, 'test', 60, compute);
    expect(result).toEqual({ ok: 'recovered' });
    expect(compute).toHaveBeenCalledTimes(1);
    // Await the recompute write so it doesn't leak past the test.
    await Promise.all(writes);
  });
});
