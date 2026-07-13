// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the Divine-identity gate — name-server by-pubkey lookup
// ABOUTME: with KV caching (24h), conservative failure handling, no error caching.

import { describe, it, expect, beforeEach } from 'vitest';
import { isDivineIdentity, resolveDivineAuthors } from './identity.mjs';

const PUBKEY = 'a1b2c3d4e5f6'.padEnd(64, '0');
const OTHER = 'b2c3d4e5f6a1'.padEnd(64, '0');
const NOW = 1_700_000_000_000;

function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

function fetchReturning(status, body) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { status, ok: status === 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

describe('isDivineIdentity', () => {
  let kv;
  beforeEach(() => { kv = makeKv(); });

  it('is true when the name server reports found', async () => {
    const fetchImpl = fetchReturning(200, { ok: true, found: true, name: 'alice' });
    expect(await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW })).toBe(true);
    expect(fetchImpl.calls[0]).toContain(`/api/username/by-pubkey/${PUBKEY}`);
  });

  it('is false when not found', async () => {
    const fetchImpl = fetchReturning(200, { ok: true, found: false });
    expect(await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW })).toBe(false);
  });

  it('is false on non-200 and does not cache the failure', async () => {
    const failing = fetchReturning(500, { ok: false });
    expect(await isDivineIdentity(PUBKEY, { kv, fetchImpl: failing, now: NOW })).toBe(false);

    const recovered = fetchReturning(200, { ok: true, found: true });
    expect(await isDivineIdentity(PUBKEY, { kv, fetchImpl: recovered, now: NOW })).toBe(true);
    expect(recovered.calls.length).toBe(1);
  });

  it('is false when fetch throws, without caching', async () => {
    const throwing = async () => { throw new Error('network down'); };
    expect(await isDivineIdentity(PUBKEY, { kv, fetchImpl: throwing, now: NOW })).toBe(false);
    expect(kv.store.size).toBe(0);
  });

  it('serves a cached result within the TTL without refetching', async () => {
    const fetchImpl = fetchReturning(200, { ok: true, found: true });
    await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW });
    await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW + 1_000 });
    expect(fetchImpl.calls.length).toBe(1);
  });

  it('refetches after the 24h TTL expires', async () => {
    const fetchImpl = fetchReturning(200, { ok: true, found: true });
    await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW });
    await isDivineIdentity(PUBKEY, { kv, fetchImpl, now: NOW + 25 * 60 * 60 * 1000 });
    expect(fetchImpl.calls.length).toBe(2);
  });

  it('normalizes pubkeys to lowercase', async () => {
    const fetchImpl = fetchReturning(200, { ok: true, found: true });
    await isDivineIdentity(PUBKEY.toUpperCase(), { kv, fetchImpl, now: NOW });
    expect(fetchImpl.calls[0]).toContain(PUBKEY);
  });
});

describe('resolveDivineAuthors', () => {
  it('maps each pubkey to its identity result', async () => {
    const kv = makeKv();
    const fetchImpl = async (url) => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, found: url.includes(PUBKEY) }),
    });
    const map = await resolveDivineAuthors([PUBKEY, OTHER], { kv, fetchImpl, now: NOW });
    expect(map.get(PUBKEY)).toBe(true);
    expect(map.get(OTHER)).toBe(false);
  });
});
