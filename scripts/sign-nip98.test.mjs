// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the exported NIP-98 signing helper consumed by e2e and ad-hoc scripts.

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { signNip98Header } from './sign-nip98.mjs';

describe('signNip98Header', () => {
  it('returns a Nostr-scheme Authorization header with a base64-encoded signed kind-27235 event', () => {
    const sk = generateSecretKey();
    const header = signNip98Header(sk, 'https://example/api', 'POST');
    expect(header.startsWith('Nostr ')).toBe(true);
    const eventJson = Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
    const event = JSON.parse(eventJson);
    expect(event.kind).toBe(27235);
    expect(event.tags).toEqual(expect.arrayContaining([['u', 'https://example/api'], ['method', 'POST']]));
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(event)).toBe(true);
  });

  it('normalizes method to uppercase', () => {
    const sk = generateSecretKey();
    const header = signNip98Header(sk, 'https://example', 'get');
    const event = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'));
    expect(event.tags).toEqual(expect.arrayContaining([['method', 'GET']]));
  });
});
