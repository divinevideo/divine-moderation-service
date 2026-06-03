// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for resolveNip05 / parseNip05 — well-known verification + KV cache.
// ABOUTME: Mocks global fetch; no real network.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseNip05, resolveNip05 } from './nip05.mjs';
import { createMockKV } from '../test/helpers.mjs';

const HEX = '00000000000000000000000000000000000000000000000000000000000000ab';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseNip05', () => {
  it('splits a valid address', () => {
    expect(parseNip05('alice@divine.video')).toEqual({ name: 'alice', domain: 'divine.video' });
  });
  it('rejects input without @', () => {
    expect(parseNip05('alice')).toBeNull();
  });
  it('rejects bad local-part chars', () => {
    expect(parseNip05('al ice@divine.video')).toBeNull();
  });
  it('rejects non-string', () => {
    expect(parseNip05(null)).toBeNull();
  });
});

describe('resolveNip05', () => {
  it('returns the authoritative pubkey when names[name] is valid hex', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ names: { alice: HEX } }),
    }));
    const env = { MODERATION_KV: createMockKV() };
    const result = await resolveNip05('alice@divine.video', env);
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video' });
    expect(fetch).toHaveBeenCalledWith(
      'https://divine.video/.well-known/nostr.json?name=alice',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('returns null when the name is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: {} }) }));
    const result = await resolveNip05('ghost@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
  });

  it('returns null on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
  });

  it('returns null when the well-known response is a redirect (not followed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect', json: async () => ({}) }));
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
  });

  it('returns null for malformed address and never fetches', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await resolveNip05('not-an-address', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves a cached positive result without fetching again', async () => {
    const kv = createMockKV({ 'nip05:alice@divine.video': JSON.stringify({ pubkey: HEX }) });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: kv });
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video' });
    expect(spy).not.toHaveBeenCalled();
  });
});
