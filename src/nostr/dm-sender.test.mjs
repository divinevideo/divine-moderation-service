// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM sender module (dm-sender.mjs)
// ABOUTME: Verifies message templates, key derivation, rate limiting, and relay discovery

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import {
  getMessageForAction,
  getReportOutcomeMessage,
  getCommunityStrikeWarningMessage,
  getModeratorKeys,
  checkRateLimit,
  discoverUserRelays,
  sendModerationDM,
  sendModeratorReply,
  sendCommunityStrikeWarning,
  selectTemplate,
  notifyReporters,
  COMPOSE_TEMPLATES,
  renderComposeTemplate,
  publishToRelays,
} from './dm-sender.mjs';
import { createMockKV } from '../test/helpers.mjs';

// Generate a stable test key in hex format (matching production usage)
const testSecretKey = generateSecretKey();
const testHex = bytesToHex(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Sender - Message Templates', () => {
  it('should produce correct message for PERMANENT_BAN', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'contain explicit content', 'abc123');

    expect(message).toContain('Your content was removed');
    expect(message).toContain('contain explicit content');
    expect(message).toContain('reply to this message to appeal');
    expect(message).toContain('divine.video/video/abc123');
    expect(message).toContain('Learn more about our content policies');
    expect(message).toContain('divine.video/terms');
  });

  it('should produce correct message for AGE_RESTRICTED', () => {
    const message = getMessageForAction('AGE_RESTRICTED', 'contain mature themes', 'def456');

    expect(message).toContain('age-restricted');
    expect(message).toContain('contain mature themes');
    expect(message).toContain('confirmed their age');
    expect(message).toContain('divine.video/video/def456');
  });

  it('should include title and published date when provided', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'violate content policies', 'abc123', 'My Cool Video', '2026-03-15T00:00:00Z');

    expect(message).toContain('Your video "My Cool Video"');
    expect(message).toContain('(posted Mar 15)');
    expect(message).not.toContain('Your content was');
  });

  it('should include title in AGE_RESTRICTED when provided', () => {
    const message = getMessageForAction('AGE_RESTRICTED', 'contain mature themes', 'def456', 'Beach Day');

    expect(message).toContain('Your video "Beach Day" has been age-restricted');
  });

  it('should fall back to "your content" when title is null', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'violate content policies', 'abc123', null);

    expect(message).toContain('Your content was removed');
    expect(message).not.toContain('(posted');
  });

  it('should produce correct message for QUARANTINE', () => {
    const message = getMessageForAction('QUARANTINE', 'potential violation', 'ghi789');

    expect(message).toContain('under review');
    // Creators need to know roughly when to expect a decision; the 24h SLA
    // is what we promise in policy and what the plan calls for explicitly.
    expect(message).toMatch(/24 hours|24h|within a day/i);
    // Author can still see their own under-review content via direct link;
    // surfacing that prevents "did I get shadow-banned?" confusion.
    expect(message).toMatch(/your profile|signed in|direct link/i);
    expect(message).toContain('divine.video/video/ghi789');
  });

  it('should return null for unknown action', () => {
    const message = getMessageForAction('UNKNOWN_ACTION', 'test');
    expect(message).toBeNull();
  });

  it('should use default reason when none provided', () => {
    const message = getMessageForAction('PERMANENT_BAN');
    expect(message).toContain('content policies');
    expect(message).not.toContain('divine.video/video/');
  });

  it('should handle null sha256 for relay-only actions', () => {
    const message = getMessageForAction('PERMANENT_BAN', 'violate Divine\'s content policies', null);
    expect(message).toContain('Your content was removed');
    expect(message).not.toContain('divine.video/video/');
  });

  it('should include sha256 link when provided', () => {
    const message = getMessageForAction('AGE_RESTRICTED', 'contain mature content', 'deadbeef1234');
    expect(message).toContain('divine.video/video/deadbeef1234');
  });

  it('should produce the community strike warning with appeal path and footer', () => {
    const sha = 'f'.repeat(64);
    const message = getCommunityStrikeWarningMessage(3, sha);

    expect(message).toContain('3 content-warning strikes');
    expect(message).toContain('reply to this message to appeal');
    expect(message).toContain(`divine.video/video/${sha}`);
    expect(message).toContain('Learn more about our content policies');
  });

  it('should produce correct report outcome message for removal', () => {
    const message = getReportOutcomeMessage('PERMANENT_BAN', 'abc123', 'Sunset Clip', '2026-03-10T00:00:00Z', '2026-03-18T00:00:00Z');

    expect(message).toContain('Thanks for your report');
    expect(message).toContain('"Sunset Clip"');
    expect(message).toContain('(posted Mar 10)');
    expect(message).toContain('has been removed');
    expect(message).toContain('reported this content on Mar 18');
    expect(message).toContain('divine.video/video/abc123');
    expect(message).toContain('Learn more about our content policies');
  });

  it('should produce correct report outcome message for age restriction', () => {
    const message = getReportOutcomeMessage('AGE_RESTRICTED', 'def456');

    expect(message).toContain('age-restricted');
    expect(message).toContain('confirmed their age');
    expect(message).toContain('divine.video/video/def456');
  });

  it('should produce account suspension message without content reference', () => {
    const message = getMessageForAction('ACCOUNT_SUSPENDED');
    expect(message).toContain('Your account has been suspended');
    expect(message).toContain('reply to this message to appeal');
    expect(message).not.toContain('divine.video/video/');
    expect(message).not.toContain('Your content');
  });

  it('should produce account banned message without content reference', () => {
    const message = getMessageForAction('ACCOUNT_BANNED');
    expect(message).toContain('Your account has been banned');
    expect(message).toContain('This is a permanent action');
    expect(message).toContain('reply to this message to appeal');
    expect(message).not.toContain('divine.video/video/');
    expect(message).not.toContain('Your content');
  });

  it('should produce account restored message without appeal or content reference', () => {
    const message = getMessageForAction('ACCOUNT_RESTORED');
    expect(message).toContain('Your account has been restored');
    expect(message).toContain('use Divine again');
    expect(message).not.toContain('reply to this message to appeal');
    expect(message).not.toContain('divine.video/video/');
    expect(message).not.toContain('Your content');
  });

  it('should produce correct report outcome message for no action', () => {
    const message = getReportOutcomeMessage('SAFE', 'ghi789');

    expect(message).toContain('no action was taken');
    expect(message).toContain('disagree with this outcome');
  });

  it('should treat dismiss as no action', () => {
    const message = getReportOutcomeMessage('DISMISS', 'jkl012');

    expect(message).toContain('no action was taken');
  });

  it('should omit dates when not provided in report outcome', () => {
    const message = getReportOutcomeMessage('PERMANENT_BAN', 'abc123');

    expect(message).toContain('the reported content');
    expect(message).not.toContain('(posted');
    expect(message).not.toContain('reported this content on');
  });
});

describe('DM Sender - getModeratorKeys', () => {
  it('should derive correct pubkey from hex private key', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const { privateKey, publicKey } = getModeratorKeys(env);

    expect(publicKey).toBe(testPubkey);
    expect(privateKey).toBeInstanceOf(Uint8Array);
    expect(privateKey.length).toBe(32);
  });

  it('should throw when NOSTR_PRIVATE_KEY is missing', () => {
    expect(() => getModeratorKeys({})).toThrow('NOSTR_PRIVATE_KEY not configured');
  });

  it('should cache keys for the same env object', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const keys1 = getModeratorKeys(env);
    const keys2 = getModeratorKeys(env);

    expect(keys1).toBe(keys2); // same reference, not just equal
  });

  it('should produce different keys for different env objects', () => {
    const otherKey = generateSecretKey();
    const env1 = { NOSTR_PRIVATE_KEY: testHex };
    const env2 = { NOSTR_PRIVATE_KEY: bytesToHex(otherKey) };

    const keys1 = getModeratorKeys(env1);
    const keys2 = getModeratorKeys(env2);

    expect(keys1.publicKey).not.toBe(keys2.publicKey);
  });
});

describe('DM Sender - Rate Limiting', () => {
  let mockKV;
  let env;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn()
    };
    env = { MODERATION_KV: mockKV };
  });

  it('should allow first DM (no existing rate limit)', async () => {
    mockKV.get.mockResolvedValue(null);

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(true);
    expect(mockKV.get).toHaveBeenCalledWith(`dm-ratelimit:${'b'.repeat(64)}`);
  });

  it('should allow when under limit', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Simulate 3 recent timestamps
    mockKV.get.mockResolvedValue(JSON.stringify([now - 10, now - 20, now - 30]));

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(true);
  });

  it('should block the 6th DM within the rate limit window', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Simulate 5 recent timestamps (at the limit)
    mockKV.get.mockResolvedValue(JSON.stringify([now - 5, now - 10, now - 15, now - 20, now - 25]));

    const allowed = await checkRateLimit('b'.repeat(64), env);

    expect(allowed).toBe(false);
  });

  it('should allow DMs when no KV is configured', async () => {
    const envNoKV = {};
    const allowed = await checkRateLimit('b'.repeat(64), envNoKV);
    expect(allowed).toBe(true);
  });

  it('should use recipient pubkey in the rate limit key', async () => {
    const recipientPubkey = 'c'.repeat(64);
    mockKV.get.mockResolvedValue(null);

    await checkRateLimit(recipientPubkey, env);

    expect(mockKV.get).toHaveBeenCalledWith(`dm-ratelimit:${recipientPubkey}`);
  });
});

describe('DM Sender - discoverUserRelays', () => {
  let mockKV;
  let env;

  beforeEach(() => {
    mockKV = {
      get: vi.fn(),
      put: vi.fn()
    };
    env = { MODERATION_KV: mockKV };
  });

  it('should return cached relays from KV', async () => {
    const cachedRelays = ['wss://relay1.example.com', 'wss://relay2.example.com'];
    mockKV.get.mockResolvedValue(JSON.stringify(cachedRelays));

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(cachedRelays);
    expect(mockKV.get).toHaveBeenCalledWith(expect.stringContaining('relay-list:'));
  });

  it('should fall back to default relays when no cache and no relay list', async () => {
    mockKV.get.mockResolvedValue(null);
    // No WebSocket available in test — fetchRelayList will throw

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays.length).toBeGreaterThan(0);
    expect(relays.length).toBeLessThanOrEqual(5);
    // Should include divine relay as default
    expect(relays).toContain('wss://relay.divine.video');
  });

  it('should cap relays at 5', async () => {
    const manyRelays = [
      'wss://r1.example.com', 'wss://r2.example.com', 'wss://r3.example.com',
      'wss://r4.example.com', 'wss://r5.example.com', 'wss://r6.example.com',
      'wss://r7.example.com'
    ];
    mockKV.get.mockResolvedValue(JSON.stringify(manyRelays));

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays.length).toBeLessThanOrEqual(5);
  });

  it('should work when KV is not configured', async () => {
    const envNoKV = {};

    const relays = await discoverUserRelays('b'.repeat(64), envNoKV);

    expect(relays.length).toBeGreaterThan(0);
  });

  it('never returns an empty list when the cache holds "[]"', async () => {
    // A poisoned/empty cached list must not yield zero relays: publishing to
    // zero relays is read downstream as success===0 and misclassified as an
    // ambiguous send. Fall through to discovery, which always includes the
    // divine relay.
    mockKV.get.mockResolvedValue('[]');

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays.length).toBeGreaterThan(0);
    expect(relays).toContain('wss://relay.divine.video');
  });
});

describe('DM Sender - DM_RELAY_URLS override', () => {
  let mockKV;

  beforeEach(() => {
    mockKV = { get: vi.fn(), put: vi.fn() };
  });

  it('publishes only to DM_RELAY_URLS when set', async () => {
    mockKV.get.mockResolvedValue(null);
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(['ws://127.0.0.1:4444']);
    expect(relays).not.toContain('wss://relay.divine.video');
  });

  it('ignores the KV relay cache when DM_RELAY_URLS is set', async () => {
    // Containment must not be defeatable by a cache entry written before the
    // override was configured.
    mockKV.get.mockResolvedValue(JSON.stringify(['wss://relay.damus.io']));
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(['ws://127.0.0.1:4444']);
  });

  it('does not write the override list back into the KV cache', async () => {
    // Caching it would leak a local/staging relay into a later prod-configured
    // run of the same worker against the same namespace.
    mockKV.get.mockResolvedValue(null);
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    await discoverUserRelays('b'.repeat(64), env);

    expect(mockKV.put).not.toHaveBeenCalled();
  });

  it('parses a comma-separated list, trimming blanks', async () => {
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: ' ws://127.0.0.1:4444 , ,ws://127.0.0.1:5555 ',
    };

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(['ws://127.0.0.1:4444', 'ws://127.0.0.1:5555']);
  });

  it('still caps the override at MAX_RELAYS', async () => {
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: [
        'ws://r1', 'ws://r2', 'ws://r3', 'ws://r4', 'ws://r5', 'ws://r6',
      ].join(','),
    };

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toHaveLength(5);
  });

  it('dedupes before capping, so a distinct relay is not crowded out', async () => {
    // Without dedupe the cap consumes the duplicates and drops the one relay
    // that was actually different, while the send path still reports five
    // successes -- a single-relay delivery that reads as five-relay redundancy.
    const env = {
      MODERATION_KV: mockKV,
      DM_RELAY_URLS: 'ws://a,ws://a,ws://a,ws://a,ws://a,ws://b',
    };

    const relays = await discoverUserRelays('b'.repeat(64), env);

    expect(relays).toEqual(['ws://a', 'ws://b']);
  });

  it('does not read the cache or open a discovery socket when the override is set', async () => {
    // The other override tests assert the resulting list, which stays correct
    // even if discovery still runs and its result is discarded. That would mean
    // a "contained" run opening a socket to the production relay on every DM,
    // invisibly. Assert the calls that must not happen, not just the answer.
    mockKV.get.mockResolvedValue(null);
    const sockets = [];
    class SpyWS {
      constructor(url) {
        sockets.push(url);
        this.readyState = 3;
      }
      addEventListener() {}
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', SpyWS);
    try {
      const env = { MODERATION_KV: mockKV, DM_RELAY_URLS: 'ws://127.0.0.1:4444' };

      await discoverUserRelays('b'.repeat(64), env);

      expect(mockKV.get).not.toHaveBeenCalled();
      expect(sockets).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('set but unusable', () => {
    // The whole point of this variable is that an operator who sets it has said
    // "do not send outside this list". Quietly falling back to the production
    // defaults honours the opposite of what they asked for, and does it silently:
    // there is no log distinguishing a bad value from an unset one.
    //
    // So a value that is PRESENT and unusable is a configuration error, and it
    // refuses rather than sends. Unset remains the production default and is
    // unaffected. Returning an empty list instead is not an option -- it reads
    // downstream as success===0, an ambiguous send that makes the sweep retain a
    // warning claim and never resend it.
    for (const [name, value] of [
      ['a TOML array, which wrangler accepts in vars', ['ws://127.0.0.1:4444']],
      ['a number', 4444],
      ['an object', { url: 'ws://127.0.0.1:4444' }],
      ['whitespace only', '   '],
      ['separators only', ' , , '],
      ['an empty string', ''],
    ]) {
      it(`refuses to send when DM_RELAY_URLS is ${name}`, async () => {
        mockKV.get.mockResolvedValue(null);
        const env = { MODERATION_KV: mockKV, DM_RELAY_URLS: value };

        await expect(discoverUserRelays('b'.repeat(64), env)).rejects.toThrow(
          /DM_RELAY_URLS/,
        );
      });
    }

    it('sends nothing when the override is unusable, rather than falling back', async () => {
      // Proving parseRelayOverride throws is not the same as proving no DM is
      // sent. All three send entry points wrap discovery in a catch-all, so a
      // try/catch that restored the production list would swallow the refusal
      // and pass every other test in this file.
      const sockets = [];
      class SpyWS {
        constructor(url) {
          sockets.push(url);
          this.readyState = 3;
        }
        addEventListener() {}
        close() {}
        send() {}
      }
      vi.stubGlobal('WebSocket', SpyWS);
      try {
        const env = {
          NOSTR_PRIVATE_KEY: 'a'.repeat(64),
          MODERATION_KV: mockKV,
          DM_RELAY_URLS: ['ws://127.0.0.1:4444'],
        };

        const result = await sendModerationDM('b'.repeat(64), 'hello', env);

        expect(result.sent).toBe(false);
        // The point: no socket to any relay, production or otherwise.
        expect(sockets).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('reports an unusable override as a DEFINITIVE non-send, so warnings are not swallowed', async () => {
      // `definitive` decides what the community-strike sweep does with a failure.
      // A no-send that is definitive releases the claim; a non-definitive one is
      // ambiguous, so the sweep RETAINS the claim and never resends. That is the
      // outcome the throw exists to avoid, reached by a different route than the
      // empty-list return the parser guards against.
      //
      // Nothing pinned this: moving `publishAttempted = true` above the discovery
      // call turns every misconfigured warning into a permanent silent swallow,
      // and the whole suite still passed.
      const sockets = [];
      class SpyWS {
        constructor(url) {
          sockets.push(url);
          this.readyState = 3;
        }
        addEventListener() {}
        close() {}
        send() {}
      }
      vi.stubGlobal('WebSocket', SpyWS);
      try {
        const env = {
          NOSTR_PRIVATE_KEY: 'a'.repeat(64),
          MODERATION_KV: mockKV,
          DM_RELAY_URLS: ['ws://127.0.0.1:4444'],
        };

        const result = await sendCommunityStrikeWarning(
          'b'.repeat(64), 'warning', 'c'.repeat(64), env, null,
        );

        expect(result.sent).toBe(false);
        expect(result.definitive).toBe(true);
        expect(sockets).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('leaves the production default alone when DM_RELAY_URLS is absent', async () => {
      mockKV.get.mockResolvedValue(null);

      const relays = await discoverUserRelays('b'.repeat(64), { MODERATION_KV: mockKV });

      expect(relays).toContain('wss://relay.divine.video');
    });
  });
});

describe('DM Sender - Error Handling', () => {
  it('should return failure when NOSTR_PRIVATE_KEY is missing', async () => {
    const env = {};
    const ctx = { waitUntil: vi.fn() };

    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('NOSTR_PRIVATE_KEY');
  });

  it('should not throw when rate limited', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockKV = {
      get: vi.fn().mockResolvedValue(JSON.stringify([now - 1, now - 2, now - 3, now - 4, now - 5])),
      put: vi.fn()
    };
    const env = {
      NOSTR_PRIVATE_KEY: testHex,
      MODERATION_KV: mockKV
    };
    const ctx = { waitUntil: vi.fn() };

    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
  });

  it('should not throw when options is explicitly null', async () => {
    const env = {};
    const ctx = { waitUntil: vi.fn() };

    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test', env, ctx, null);
    expect(result).toBeDefined();
    expect(result.sent).toBe(false);
    // Should fail gracefully (no keys configured) rather than TypeError on null destructuring
    expect(result.reason).toContain('NOSTR_PRIVATE_KEY');
  });

  it('should not throw when relay connection fails', async () => {
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn()
    };
    const env = {
      NOSTR_PRIVATE_KEY: testHex,
      MODERATION_KV: mockKV
      // No BLOSSOM_DB — will skip D1 logging
    };
    const ctx = { waitUntil: vi.fn() };

    // This will fail on WebSocket connect but should catch gracefully
    const result = await sendModerationDM('b'.repeat(64), 'c'.repeat(64), 'PERMANENT_BAN', 'test reason', env, ctx);
    // Should not throw — either succeeds or returns failure gracefully
    expect(result).toBeDefined();
  });
});

describe('DM Sender - selectTemplate (Category-Specific)', () => {
  it('should include specific reason for nudity category and content link', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}', 'abc123');

    expect(msg).toContain('sexual or nude content');
    expect(msg).toContain('divine.video/video/abc123');
    expect(msg).toContain('reply to this message to appeal');
    expect(msg).toContain('Learn more about our content policies');
    expect(msg).not.toContain('https://divine.video/policies#sexual-content');
  });

  it('should include crisis resources for self_harm category before footer', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"self_harm": 0.8}', 'abc123');

    expect(msg).toContain('self-harm');
    expect(msg).toContain('helpguide.org/find-help');
    expect(msg).toContain('suicide.org/international-suicide-hotlines.html');
    expect(msg).toContain('988');
    expect(msg).not.toContain('https://divine.video/policies#self-harm');
    // Crisis resources should appear before footer links
    const crisisIdx = msg.indexOf('helpguide.org');
    const footerIdx = msg.indexOf('divine.video/terms');
    expect(crisisIdx).toBeLessThan(footerIdx);
  });

  it('should ignore caller-provided reason for QUARANTINE (intentional)', () => {
    const msg = selectTemplate('QUARANTINE', 'custom reason', null, 'abc123');

    // QUARANTINE template is generic per spec — reason param is unused
    expect(msg).toContain('under review');
    expect(msg).not.toContain('custom reason');
  });

  it('should use per-action default reason when no category and no reason (PERMANENT_BAN)', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, null, 'abc123');

    expect(msg).toContain('content policies');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should use per-action default reason for AGE_RESTRICTED', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, null, 'abc123');

    expect(msg).toContain('not be suitable for all audiences');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should ignore raw caller reason in favor of per-action default', () => {
    // Callers like index.mjs pass freeform reasons like "Manual moderator action"
    // which don't fit the "was found to {reason}" grammar. selectTemplate ignores them.
    const msg = selectTemplate('PERMANENT_BAN', 'Manual moderator action', null, 'abc123');

    expect(msg).not.toContain('Manual moderator action');
    expect(msg).toContain('content policies');
  });

  it('should return null for unknown action', () => {
    const msg = selectTemplate('SAFE', null, null, 'abc123');
    expect(msg).toBeNull();
  });

  it('should return null for non-string action', () => {
    const msg = selectTemplate(null, null, '{"self_harm": 0.9}', 'abc123');
    expect(msg).toBeNull();
  });

  it('should handle plain string category', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, 'offensive', 'abc123');

    expect(msg).toContain('offensive or hateful content');
    expect(msg).toContain('divine.video/video/abc123');
  });

  it('should handle ai_generated category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"ai_generated": 0.9}', 'abc123');

    expect(msg).toContain('AI-generated');
    expect(msg).not.toContain('https://divine.video/policies#ai-content');
  });

  it('should handle scam category', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, 'scam', 'abc123');

    expect(msg).toContain('fraudulent or scam');
  });

  it('should produce AGE_RESTRICTED template with content link', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, '{"nudity": 0.7}', 'def456');

    expect(msg).toContain('age-restricted');
    expect(msg).toContain('confirmed their age');
    expect(msg).toContain('divine.video/video/def456');
  });

  it('should produce QUARANTINE template with reply invitation', () => {
    const msg = selectTemplate('QUARANTINE', null, '{"deepfake": 0.85}', 'ghi789');

    expect(msg).toContain('under review');
    expect(msg).toContain('reply to this message');
    expect(msg).toContain('divine.video/video/ghi789');
  });

  it('should append crisis resources to AGE_RESTRICTED for self_harm', () => {
    const msg = selectTemplate('AGE_RESTRICTED', null, '{"self_harm": 0.8}', 'abc123');

    expect(msg).toContain('age-restricted');
    expect(msg).toContain('helpguide.org/find-help');
    expect(msg).toContain('988');
  });

  it('should handle missing sha256 gracefully', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, null, null);

    expect(msg).not.toContain('divine.video/video/');
    expect(msg).toContain('content policies');
    expect(msg).toContain('divine.video/terms');
  });

  it('should include title and published date in template when provided', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}', 'abc123', 'Sunset Clip', '2026-03-15T00:00:00Z');

    expect(msg).toContain('Your video "Sunset Clip"');
    expect(msg).toContain('(posted Mar 15)');
    expect(msg).not.toContain('Your content was');
    expect(msg).toContain('sexual or nude content');
  });

  it('should fall back to "your content" with no date when metadata is null', () => {
    const msg = selectTemplate('PERMANENT_BAN', null, '{"nudity": 0.95}', 'abc123', null, null);

    expect(msg).toContain('Your content was removed');
    expect(msg).not.toContain('(posted');
  });

  // selectTemplate is the path /api/v1/notify actually uses, so cover the new
  // account-level actions through it (not just getMessageForAction).
  it('should resolve ACCOUNT_BANNED through the live dispatch path', () => {
    const msg = selectTemplate('ACCOUNT_BANNED', null, null, null);

    expect(msg).toContain('Your account has been banned');
    expect(msg).toContain('permanent action');
    expect(msg).toContain('reply to this message to appeal');
    expect(msg).not.toContain('divine.video/video/');
  });

  it('should resolve ACCOUNT_RESTORED through the live dispatch path', () => {
    const msg = selectTemplate('ACCOUNT_RESTORED', null, null, null);

    expect(msg).toContain('Your account has been restored');
    expect(msg).not.toContain('appeal');
    expect(msg).not.toContain('divine.video/video/');
  });

  it('should never splice category extra (e.g. crisis lines) into account-level messages', () => {
    // Even if a caller passes a self_harm category, an account notice must not
    // get the crisis-line `extra` injected.
    const msg = selectTemplate('ACCOUNT_BANNED', null, '{"self_harm": 0.9}', null);

    expect(msg).toContain('Your account has been banned');
    expect(msg).not.toContain('crisis');
    expect(msg).not.toContain('988');
  });

  it('applies the guard to ACCOUNT_SUSPENDED too (unchanged message, no crisis injection)', () => {
    const msg = selectTemplate('ACCOUNT_SUSPENDED', null, '{"self_harm": 0.9}', null);

    expect(msg).toContain('Your account has been suspended');
    expect(msg).not.toContain('crisis');
    expect(msg).not.toContain('988');
  });
});

describe('DM Sender - notifyReporters', () => {
  it('should be a function', () => {
    expect(typeof notifyReporters).toBe('function');
  });

  it('should return zeros when NOSTR_PRIVATE_KEY is missing', async () => {
    const result = await notifyReporters('abc123', 'PERMANENT_BAN', {}, '[TEST]');
    expect(result).toEqual({ notified: 0, failed: 0 });
  });

  it('should skip notification for QUARANTINE (intermediate state)', async () => {
    const result = await notifyReporters('abc123', 'QUARANTINE', { NOSTR_PRIVATE_KEY: testHex }, '[TEST]');
    expect(result).toEqual({ notified: 0, failed: 0 });
  });

  it('should skip notification for REVIEW (intermediate state)', async () => {
    const result = await notifyReporters('abc123', 'REVIEW', { NOSTR_PRIVATE_KEY: testHex }, '[TEST]');
    expect(result).toEqual({ notified: 0, failed: 0 });
  });
});

describe('COMPOSE_TEMPLATES / renderComposeTemplate', () => {
  it('exposes the six creator-facing templates and excludes report-outcome', () => {
    const keys = COMPOSE_TEMPLATES.map(t => t.key);
    expect(keys).toEqual(['PERMANENT_BAN', 'AGE_RESTRICTED', 'QUARANTINE', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ACCOUNT_RESTORED']);
    expect(keys).not.toContain('REPORT_OUTCOME_ACTION');
    COMPOSE_TEMPLATES.forEach(t => expect(typeof t.label).toBe('string'));
  });

  it('renders the account-state templates with no args', () => {
    expect(renderComposeTemplate('ACCOUNT_BANNED')).toContain('account has been banned');
    expect(renderComposeTemplate('ACCOUNT_RESTORED')).toContain('account has been restored');
  });

  it('renders without a video (null-safe) using the generic subject', () => {
    const body = renderComposeTemplate('PERMANENT_BAN');
    expect(body).toContain('Your content');
    expect(body).not.toContain('divine.video/video/'); // no content link when sha256 is null
  });

  it('renders ACCOUNT_SUSPENDED with no args', () => {
    const body = renderComposeTemplate('ACCOUNT_SUSPENDED');
    expect(body).toContain('account has been suspended');
  });

  it('category specialization matches selectTemplate output', () => {
    const sha = '11'.repeat(32);
    expect(renderComposeTemplate('PERMANENT_BAN', { category: 'nudity', sha256: sha }))
      .toBe(selectTemplate('PERMANENT_BAN', null, 'nudity', sha));
  });

  it('returns null for an unknown key', () => {
    expect(renderComposeTemplate('NOPE')).toBeNull();
  });
});

describe('publishToRelays — Workers WebSocket construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Regression guard: Cloudflare Workers' WebSocket constructor only accepts a
  // subprotocol string/array as its 2nd arg. Passing an options/headers object
  // throws "protocol header token is invalid", so publishing silently fails and
  // composed messages never leave the worker. Connect with the URL alone.
  it('constructs each relay WebSocket with the URL only (no options object)', async () => {
    const ctorArgs = [];
    class FakeWS {
      constructor(...args) {
        ctorArgs.push(args);
        this._cbs = {};
        queueMicrotask(() => {
          this._cbs.open && this._cbs.open();
          this._cbs.message && this._cbs.message({ data: JSON.stringify(['OK', 'evt1', true, '']) });
        });
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWS);

    const res = await publishToRelays({ id: 'evt1' }, ['wss://relay.example.com'], {});

    expect(res).toEqual({ success: 1, failed: 0, rejected: 0 });
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0]).toHaveLength(1); // URL only — the regression guard
    expect(ctorArgs[0][0]).toBe('wss://relay.example.com');
  });
});

describe('discoverUserRelays — Workers WebSocket construction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('constructs the relay-list WebSocket with the URL only', async () => {
    const ctorArgs = [];
    class FakeWS {
      constructor(...args) {
        ctorArgs.push(args);
        this._cbs = {};
        setTimeout(() => this._cbs.error && this._cbs.error(new Error('x')), 0);
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWS);

    await discoverUserRelays('a'.repeat(64), { MODERATION_KV: createMockKV() });

    expect(ctorArgs.length).toBeGreaterThan(0);
    ctorArgs.forEach((args) => expect(args).toHaveLength(1));
  });
});

describe('community-warning vs moderator-reply audit trail (#180)', () => {
  const recipient = 'a'.repeat(64);
  const originalWebSocket = globalThis.WebSocket;
  // dm-store logDm binds message_type at position 5 (conversation_id, sha256,
  // direction, sender_pubkey, recipient_pubkey, message_type, ...).
  const MESSAGE_TYPE_BIND_INDEX = 5;
  let env;
  let loggedInserts;

  // Gift-wrap seam: a plain event (real wrapEvent's per-call crypto wedges the
  // pool). Its id is echoed back by the fake publish socket below.
  const fakeWrap = () => ({
    id: 'e'.repeat(64),
    kind: 1059,
    pubkey: 'f'.repeat(64),
    created_at: 1,
    tags: [['p', 'a'.repeat(64)]],
    content: 'wrapped',
    sig: '0'.repeat(128),
  });

  // Capture the real dm-store INSERT so we can read the audit message_type
  // without mocking the module (a mocked dynamic import wedges the pool
  // worker's RPC in this environment).
  function capturingDb() {
    return {
      prepare(sql) {
        return {
          _sql: sql,
          _binds: [],
          bind(...args) { this._binds = args; return this; },
          async first() { return null; },
          async run() {
            if (this._sql.includes('INSERT INTO dm_log')) {
              loggedInserts.push(this._binds);
            }
            return { meta: { changes: 1 } };
          },
          async all() { return { results: [] }; },
        };
      },
    };
  }

  beforeEach(() => {
    loggedInserts = [];
    // Seed the relay-list cache so discoverUserRelays resolves without a
    // WebSocket, and swap in a publish socket that acknowledges the wrapped
    // event.
    // Use the reserved-domain relay the working publishToRelays test uses:
    // under vitest-pool-workers, constructing a socket to the real
    // relay.divine.video host wedges the worker's RPC even with a fake
    // WebSocket, whereas relay.example.com resolves nowhere and stays local.
    env = {
      NOSTR_PRIVATE_KEY: testHex,
      BLOSSOM_DB: capturingDb(),
      MODERATION_KV: createMockKV({
        [`relay-list:${recipient}`]: JSON.stringify(['wss://relay.example.com']),
      }),
    };
    class FakeWS {
      constructor() {
        this._cbs = {};
        queueMicrotask(() => this._cbs.open && this._cbs.open());
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send(msg) {
        // Acknowledge synchronously within send (a queued reply wedges the
        // pool worker for this send path).
        const parsed = JSON.parse(msg);
        if (parsed[0] === 'EVENT') {
          this._cbs.message
            && this._cbs.message({ data: JSON.stringify(['OK', parsed[1].id, true, '']) });
        }
      }
      close() {}
    }
    globalThis.WebSocket = FakeWS;
  });

  afterEach(() => { globalThis.WebSocket = originalWebSocket; });

  it('records the community strike warning with a distinct community_warning type', async () => {
    const result = await sendCommunityStrikeWarning(
      recipient, 'You have 3 content-warning strikes.', 'f'.repeat(64), env, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(true);
    expect(loggedInserts).toHaveLength(1);
    expect(loggedInserts[0][MESSAGE_TYPE_BIND_INDEX]).toBe('community_warning');
  });

  it('keeps the manual moderator reply as moderator_reply', async () => {
    const result = await sendModeratorReply(
      recipient, 'Manual appeal response.', 'f'.repeat(64), env, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(true);
    expect(loggedInserts).toHaveLength(1);
    expect(loggedInserts[0][MESSAGE_TYPE_BIND_INDEX]).toBe('moderator_reply');
  });

  it('reports a rate-limited warning as a definitive pre-send failure', async () => {
    // checkRateLimit fails before any gift-wrap is created or published, so the
    // caller learns nothing went out and may safely retry (definitive: true).
    const now = Math.floor(Date.now() / 1000);
    const rateLimitedEnv = {
      NOSTR_PRIVATE_KEY: testHex,
      BLOSSOM_DB: capturingDb(),
      MODERATION_KV: createMockKV({
        [`dm-ratelimit:${recipient}`]: JSON.stringify([now - 5, now - 10, now - 15, now - 20, now - 25]),
      }),
    };

    const result = await sendCommunityStrikeWarning(
      recipient, 'You have 3 content-warning strikes.', 'f'.repeat(64), rateLimitedEnv, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(false);
    expect(result.definitive).toBe(true);
    expect(loggedInserts).toHaveLength(0);
  });

  it('reports an all-relays-EXPLICITLY-rejected warning as a definitive failure', async () => {
    // Every relay returned OK=false: the event was received and refused
    // everywhere, so nothing was stored and a retry cannot duplicate. That is a
    // definitive non-delivery (definitive: true), so the claim may be released.
    class RejectWS {
      constructor() {
        this._cbs = {};
        queueMicrotask(() => this._cbs.open && this._cbs.open());
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send(msg) {
        const parsed = JSON.parse(msg);
        if (parsed[0] === 'EVENT') {
          this._cbs.message
            && this._cbs.message({ data: JSON.stringify(['OK', parsed[1].id, false, 'blocked']) });
        }
      }
      close() {}
    }
    globalThis.WebSocket = RejectWS;

    const result = await sendCommunityStrikeWarning(
      recipient, 'You have 3 content-warning strikes.', 'f'.repeat(64), env, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(false);
    expect(result.definitive).toBe(true);
    expect(result.reason).toContain('All relay publishes failed');
  });

  it('reports a warning with no relay acknowledgement as an ambiguous failure', async () => {
    // The relay opened and received the EVENT but closed without ever sending
    // an OK. A relay can store an event and lose (or never send) its OK, so
    // delivery is unknown (definitive: false) and the warning must not be
    // resent — unlike an explicit OK=false, we cannot prove nothing was stored.
    class NoAckWS {
      constructor() {
        this._cbs = {};
        queueMicrotask(() => this._cbs.open && this._cbs.open());
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send(msg) {
        const parsed = JSON.parse(msg);
        if (parsed[0] === 'EVENT') {
          // Close without an OK response.
          this._cbs.close && this._cbs.close();
        }
      }
      close() { this._cbs.close && this._cbs.close(); }
    }
    globalThis.WebSocket = NoAckWS;

    const result = await sendCommunityStrikeWarning(
      recipient, 'You have 3 content-warning strikes.', 'f'.repeat(64), env, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(false);
    expect(result.definitive).toBe(false);
    expect(result.reason).toContain('All relay publishes failed');
  });

  it('stays ambiguous when relays are split between explicit rejection and no-ack', async () => {
    // One relay explicitly rejects (OK=false), another closes without an OK.
    // Only ALL-explicit-rejection is definitive; the lone missing ack could be
    // a stored-but-lost-OK, so the mixed outcome is ambiguous (definitive:false)
    // and the warning must not be resent. Pins the `rejected === failed`
    // boundary. (A seeded relay cache is returned verbatim, so exactly these two
    // relays are contacted.)
    const mixedEnv = {
      NOSTR_PRIVATE_KEY: testHex,
      BLOSSOM_DB: capturingDb(),
      MODERATION_KV: createMockKV({
        [`relay-list:${recipient}`]: JSON.stringify(['wss://reject.example.com', 'wss://noack.example.com']),
      }),
    };
    class MixedWS {
      constructor(url) {
        this._url = url;
        this._cbs = {};
        queueMicrotask(() => this._cbs.open && this._cbs.open());
      }
      addEventListener(type, cb) { this._cbs[type] = cb; }
      send(msg) {
        const parsed = JSON.parse(msg);
        if (parsed[0] !== 'EVENT') return;
        if (this._url.includes('reject')) {
          this._cbs.message
            && this._cbs.message({ data: JSON.stringify(['OK', parsed[1].id, false, 'blocked']) });
        } else {
          this._cbs.close && this._cbs.close();
        }
      }
      close() { this._cbs.close && this._cbs.close(); }
    }
    globalThis.WebSocket = MixedWS;

    const result = await sendCommunityStrikeWarning(
      recipient, 'You have 3 content-warning strikes.', 'f'.repeat(64), mixedEnv, null,
      { wrap: fakeWrap },
    );

    expect(result.sent).toBe(false);
    expect(result.definitive).toBe(false);
  });
});
