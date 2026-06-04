// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for resolveNip05 / parseNip05 — well-known verification + KV cache.
// ABOUTME: Mocks global fetch; no real network.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseNip05, resolveNip05, normalizeNip05Input } from './nip05.mjs';
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
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video', display: '@alice.divine.video' });
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
    // A space in the local part survives normalization but fails parse, so no fetch.
    const result = await resolveNip05('bad name@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves a cached positive result without fetching again', async () => {
    const kv = createMockKV({ 'nip05:alice@divine.video': JSON.stringify({ pubkey: HEX }) });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: kv });
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video', display: '@alice.divine.video' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves the divine profile-badge form (@user.divine.video) and echoes the @ display', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { _: HEX } }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveNip05('@mjb.divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toEqual({ pubkey: HEX, address: '_@mjb.divine.video', domain: 'mjb.divine.video', display: '@mjb.divine.video' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mjb.divine.video/.well-known/nostr.json?name=_',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});

describe('normalizeNip05Input', () => {
  it('maps divine display + bare forms to the subdomain identity', () => {
    expect(normalizeNip05Input('@mjb.divine.video')).toBe('_@mjb.divine.video');
    expect(normalizeNip05Input('@mjb')).toBe('_@mjb.divine.video');
    expect(normalizeNip05Input('mjb')).toBe('_@mjb.divine.video');
    expect(normalizeNip05Input('mjb.divine.video')).toBe('_@mjb.divine.video');
  });
  it('passes canonical and cross-domain forms through unchanged', () => {
    expect(normalizeNip05Input('mjb@divine.video')).toBe('mjb@divine.video');
    expect(normalizeNip05Input('_@mjb.divine.video')).toBe('_@mjb.divine.video');
    expect(normalizeNip05Input('mjb@nos.social')).toBe('mjb@nos.social');
  });
  it('returns null for empty / @-only / non-string', () => {
    expect(normalizeNip05Input('')).toBeNull();
    expect(normalizeNip05Input('@')).toBeNull();
    expect(normalizeNip05Input(null)).toBeNull();
  });
});
