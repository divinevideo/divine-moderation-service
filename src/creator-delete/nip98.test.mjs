// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for NIP-98 validator — happy path + rejection paths (missing, wrong kind, expired, mismatched, tampered).
// ABOUTME: Uses nostr-tools to sign test fixtures with ephemeral keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { validateNip98Header, normalizeUrl } from './nip98.mjs';

describe('validateNip98Header', () => {
  let sk, pk;

  beforeEach(() => {
    sk = generateSecretKey();
    pk = getPublicKey(sk);
  });

  function signNip98(url, method, skOverride) {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', method]],
      content: ''
    }, skOverride || sk);
    const encoded = btoa(JSON.stringify(event));
    return `Nostr ${encoded}`;
  }

  it('accepts a valid signature for matching url and method', async () => {
    const header = signNip98('https://moderation-api.divine.video/api/delete/abc123', 'POST');
    const result = await validateNip98Header(header, 'https://moderation-api.divine.video/api/delete/abc123', 'POST');
    expect(result.valid).toBe(true);
    expect(result.pubkey).toBe(pk);
  });

  it('rejects missing Authorization header', async () => {
    const result = await validateNip98Header(undefined, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing or malformed/);
  });

  it('rejects non-Nostr scheme', async () => {
    const result = await validateNip98Header('Bearer abc', 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
  });

  it('rejects wrong kind', async () => {
    const event = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Expected kind 27235/);
  });

  it('rejects expired created_at (outside ±60s)', async () => {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - 120,
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/outside/);
  });

  it('rejects mismatched url', async () => {
    const header = signNip98('https://x/different', 'POST');
    const result = await validateNip98Header(header, 'https://x/expected', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/u tag/);
  });

  it('rejects mismatched method', async () => {
    const header = signNip98('https://x/y', 'GET');
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/method tag/);
  });

  it('rejects event with missing tags array', async () => {
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    delete event.tags;
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/missing tags/);
  });

  it('rejects tampered signature', async () => {
    const realEvent = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', 'https://x/y'], ['method', 'POST']],
      content: ''
    }, sk);
    realEvent.sig = realEvent.sig.slice(0, -4) + '0000';
    const header = `Nostr ${btoa(JSON.stringify(realEvent))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature/);
  });

  it.each([
    null,
    { kind: 27235, tags: [null] },
    { kind: 27235, created_at: 'invalid', tags: [] },
    { kind: 27235, tags: [['method', 42]] }
  ])('rejects malformed untrusted auth events without throwing: %j', async event => {
    if (event && event.created_at === undefined) event.created_at = Math.floor(Date.now() / 1000);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    expect((await validateNip98Header(header, 'https://x/y', 'POST')).valid).toBe(false);
  });

  it('rejects duplicate payload tags even when one hash matches', async () => {
    const bytes = new TextEncoder().encode('{}');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const event = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', 'https://x/y'], ['method', 'POST'], ['payload', hash], ['payload', '0'.repeat(64)]]
    }, sk);
    const header = `Nostr ${btoa(JSON.stringify(event))}`;
    const result = await validateNip98Header(header, 'https://x/y', 'POST', bytes);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/payload/);
  });

  describe('URL canonicalization', () => {
    it('accepts signed https://host:443/ when request is https://host/', async () => {
      const header = signNip98('https://moderation-api.divine.video:443/api/delete/abc123', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts signed http://host:80/ when request is http://host/', async () => {
      const header = signNip98('http://moderation-api.divine.video:80/api/delete/abc123', 'POST');
      const result = await validateNip98Header(
        header,
        'http://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts uppercase scheme and host', async () => {
      const header = signNip98('HTTPS://Moderation-API.Divine.Video/api/delete/abc123', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(true);
    });

    it('accepts root URL with and without trailing slash', async () => {
      const header = signNip98('https://moderation-api.divine.video', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/',
        'POST'
      );
      expect(result.valid).toBe(true);
    });

    it('strips fragment when comparing', async () => {
      const header = signNip98('https://moderation-api.divine.video/api/delete/abc123#frag', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(true);
    });

    it('keeps non-root trailing slash distinct (not equivalent resources)', async () => {
      const header = signNip98('https://moderation-api.divine.video/api/delete/abc123/', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/does not match/);
    });

    it('keeps different paths distinct', async () => {
      const header = signNip98('https://moderation-api.divine.video/api/delete/abc123', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/xyz789',
        'POST'
      );
      expect(result.valid).toBe(false);
    });

    it('rejects mismatched host even after canonicalization', async () => {
      const header = signNip98('https://evil.example.com/api/delete/abc123', 'POST');
      const result = await validateNip98Header(
        header,
        'https://moderation-api.divine.video/api/delete/abc123',
        'POST'
      );
      expect(result.valid).toBe(false);
    });

    it('rejects an unparseable u tag as a URL', async () => {
      const header = signNip98('not a url', 'POST');
      const result = await validateNip98Header(header, 'https://x/y', 'POST');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/canonicalization/);
    });

    it('leaves the existing replay-window check unchanged (expired event still rejected)', async () => {
      const event = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000) - 120,
        tags: [['u', 'https://x/y'], ['method', 'POST']],
        content: ''
      }, sk);
      const header = `Nostr ${btoa(JSON.stringify(event))}`;
      const result = await validateNip98Header(header, 'https://x/y', 'POST');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/outside.*window/);
    });

    it('leaves the existing method check unchanged (method mismatch rejected)', async () => {
      const header = signNip98('https://x/y', 'GET');
      const result = await validateNip98Header(header, 'https://x/y', 'POST');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/method/);
    });
  });

  describe('normalizeUrl helper', () => {
    it('normalizes explicit https default port', () => {
      expect(normalizeUrl('https://x:443/path')).toBe('https://x/path');
    });

    it('normalizes explicit http default port', () => {
      expect(normalizeUrl('http://x:80/path')).toBe('http://x/path');
    });

    it('preserves non-default port', () => {
      expect(normalizeUrl('https://x:8443/path')).toBe('https://x:8443/path');
    });

    it('lowercases scheme and host', () => {
      expect(normalizeUrl('HTTPS://X.Example.COM/path')).toBe('https://x.example.com/path');
    });

    it('adds root trailing slash', () => {
      expect(normalizeUrl('https://x')).toBe('https://x/');
    });

    it('preserves non-root path as-is', () => {
      expect(normalizeUrl('https://x/foo')).toBe('https://x/foo');
      expect(normalizeUrl('https://x/foo/')).toBe('https://x/foo/');
    });

    it('strips fragment', () => {
      expect(normalizeUrl('https://x/path#frag')).toBe('https://x/path');
    });

    it('strips userinfo', () => {
      expect(normalizeUrl('https://user:pass@x/path')).toBe('https://x/path');
    });

    it('returns null for unparseable input', () => {
      expect(normalizeUrl('not a url')).toBeNull();
      expect(normalizeUrl('')).toBeNull();
      expect(normalizeUrl(null)).toBeNull();
      expect(normalizeUrl(undefined)).toBeNull();
    });
  });
});
