// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  fetchNostrEventBySha256,
  fetchNostrEventsBySha256Batch,
  fetchNostrVideoEventsByDTag,
  parseVideoEventMetadata,
  isOriginalVine,
  hasStrongOriginalVineEvidence,
  fetchNostrEventById
} from './relay-client.mjs';

const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('parseVideoEventMetadata', () => {
  it('extracts title from title tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['title', 'My Video Title']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.title).toBe('My Video Title');
  });

  it('does not extract title from subject tag (no fallback)', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['subject', 'Subject Line']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.title).toBeNull();
  });

  it('extracts author from author tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['author', 'Jane Doe']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.author).toBe('Jane Doe');
  });

  it('extracts client from client tag', () => {
    const event = {
      id: 'abc123',
      content: '',
      created_at: 1700000000,
      tags: [['client', 'vine-archaeologist']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.client).toBe('vine-archaeologist');
  });

  it('returns null for null event', () => {
    expect(parseVideoEventMetadata(null)).toBeNull();
  });

  it('returns null for event without tags', () => {
    expect(parseVideoEventMetadata({ content: 'hello' })).toBeNull();
  });

  it('returns metadata with content from event.content', () => {
    const event = {
      id: 'evt1',
      content: 'This is a video description',
      created_at: 1700000000,
      tags: [['title', 'Test']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.content).toBe('This is a video description');
  });

  it('falls back to summary tag when event.content is empty', () => {
    const event = {
      id: 'evt1',
      content: '',
      created_at: 1700000000,
      tags: [['summary', 'Summary body text']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.content).toBe('Summary body text');
  });

  it('extracts eventId and createdAt from event', () => {
    const event = {
      id: 'evt999',
      content: '',
      created_at: 1700000000,
      tags: [],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.eventId).toBe('evt999');
    expect(result.createdAt).toBe(1700000000);
  });

  it('extracts stableId from d tag', () => {
    const event = {
      id: 'evt999',
      content: '',
      created_at: 1700000000,
      tags: [['d', 'stable-video-id']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.stableId).toBe('stable-video-id');
  });

  it('extracts platform tag', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [['platform', 'vine']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.platform).toBe('vine');
  });

  it('parses numeric fields as integers', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [
        ['loops', '12345'],
        ['likes', '99'],
        ['comments', '7'],
      ],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.loops).toBe(12345);
    expect(result.likes).toBe(99);
    expect(result.comments).toBe(7);
  });

  it('extracts URL from imeta tag', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [['imeta', 'url https://blossom.example.com/abc123', 'm video/mp4']],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.url).toBe('https://blossom.example.com/abc123');
  });

  it('preserves published, source, Vine, and proofmode metadata', () => {
    const event = {
      id: 'abc',
      content: '',
      created_at: 1700000000,
      tags: [
        ['r', 'https://vine.co/v/abc123'],
        ['published_at', '1408579200'],
        ['imported_at', '1710000000'],
        ['vine_hash_id', 'vine-hash'],
        ['vine_user_id', 'vine-user'],
        ['proofmode', 'created_at 1561939200', 'device Pixel 3', 'proof abc123'],
      ],
    };
    const result = parseVideoEventMetadata(event);
    expect(result.sourceUrl).toBe('https://vine.co/v/abc123');
    expect(result.publishedAt).toBe(1408579200);
    expect(result.importedAt).toBe(1710000000);
    expect(result.vineHashId).toBe('vine-hash');
    expect(result.vineUserId).toBe('vine-user');
    expect(result.proofmode).toEqual({
      createdAt: 1561939200,
      device: 'Pixel 3',
      proof: 'abc123',
      raw: ['created_at 1561939200', 'device Pixel 3', 'proof abc123'],
    });
  });
});

describe('isOriginalVine', () => {
  it('returns true for event with platform=vine', () => {
    expect(isOriginalVine({ platform: 'vine' })).toBe(true);
  });

  it('returns true for event with client=vine-archaeologist', () => {
    expect(isOriginalVine({ client: 'vine-archaeologist' })).toBe(true);
  });

  it('returns true for event with vineHashId set', () => {
    expect(isOriginalVine({ vineHashId: 'abc123' })).toBe(true);
  });

  it('returns true for event with vine.co sourceUrl', () => {
    expect(isOriginalVine({ sourceUrl: 'https://vine.co/v/abc123' })).toBe(true);
  });

  it('returns true for event published before 2018', () => {
    // Dec 31, 2017
    expect(isOriginalVine({ publishedAt: 1514678400 })).toBe(true);
  });

  it('returns false for divine-mobile client', () => {
    expect(isOriginalVine({ client: 'divine-mobile' })).toBe(false);
  });

  it('returns false for null event', () => {
    expect(isOriginalVine(null)).toBe(false);
  });

  it('returns false for empty object with no vine indicators', () => {
    expect(isOriginalVine({ client: 'some-other-client', platform: 'youtube' })).toBe(false);
  });
});

describe('hasStrongOriginalVineEvidence', () => {
  it('returns true for explicit vine platform markers', () => {
    expect(hasStrongOriginalVineEvidence({ platform: 'vine' })).toBe(true);
  });

  it('returns true for archive importer client markers', () => {
    expect(hasStrongOriginalVineEvidence({ client: 'vine-archive-importer' })).toBe(true);
  });

  it('returns true for vine.co source URLs', () => {
    expect(hasStrongOriginalVineEvidence({ sourceUrl: 'https://vine.co/v/abc123' })).toBe(true);
  });

  it('returns false for timestamp-only legacy fallback matches', () => {
    expect(hasStrongOriginalVineEvidence({ publishedAt: 1514678400 })).toBe(false);
  });
});

describe('fetchNostrVideoEventsByDTag', () => {
  it('returns all matching event versions for the d-tag', async () => {
    const sha256 = 'a'.repeat(64);
    const versionA = { id: 'b'.repeat(64), kind: 34236, tags: [['d', sha256]] };
    const versionB = { id: 'c'.repeat(64), kind: 34236, tags: [['d', sha256]] };

    class FakeWebSocket {
      constructor() {
        this.listeners = {};
        this.readyState = 0;
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit('open');
        });
      }

      addEventListener(type, handler) {
        if (!this.listeners[type]) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(handler);
      }

      send(message) {
        const [, subscriptionId] = JSON.parse(message);
        queueMicrotask(() => {
          this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, versionA]) });
          this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, versionB]) });
          this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
        });
      }

      close() {
        this.readyState = 3;
        queueMicrotask(() => this.emit('close'));
      }

      emit(type, event = {}) {
        for (const handler of this.listeners[type] || []) {
          handler(event);
        }
      }
    }

    globalThis.WebSocket = FakeWebSocket;

    const events = await fetchNostrVideoEventsByDTag(sha256);
    expect(events).toEqual([versionA, versionB]);
  });
});

describe('fetchNostrEventBySha256', () => {
  it('falls back to d tag when the media sha is stored directly there', async () => {
    const sha256 = 'c'.repeat(64);
    const event = {
      id: 'd'.repeat(64),
      kind: 34236,
      tags: [
        ['d', sha256],
        ['platform', 'vine']
      ]
    };

    class FakeWebSocket {
      constructor() {
        this.listeners = {};
        queueMicrotask(() => this.emit('open'));
      }

      addEventListener(type, handler) {
        if (!this.listeners[type]) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(handler);
      }

      send(message) {
        const [, subscriptionId, filter] = JSON.parse(message);
        queueMicrotask(() => {
          if (filter['#d']?.includes(sha256)) {
            this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
          }
          this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
        });
      }

      close() {
        queueMicrotask(() => this.emit('close'));
      }

      emit(type, event = {}) {
        for (const handler of this.listeners[type] || []) {
          handler(event);
        }
      }
    }

    globalThis.WebSocket = FakeWebSocket;

    await expect(fetchNostrEventBySha256(sha256)).resolves.toEqual(event);
  });

  it('finds legacy Vine events by x tag when d is the Vine ID', async () => {
    const sha256 = 'a'.repeat(64);
    const event = {
      id: 'b'.repeat(64),
      kind: 34236,
      tags: [
        ['d', 'legacy-vine-id'],
        ['x', sha256],
        ['imeta', `url https://media.divine.video/${sha256}`, 'm video/mp4', `x ${sha256}`]
      ]
    };

    class FakeWebSocket {
      constructor() {
        this.listeners = {};
        queueMicrotask(() => this.emit('open'));
      }

      addEventListener(type, handler) {
        if (!this.listeners[type]) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(handler);
      }

      send(message) {
        const [, subscriptionId, filter] = JSON.parse(message);
        queueMicrotask(() => {
          if (filter['#x']?.includes(sha256)) {
            this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
          }
          this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
        });
      }

      close() {
        queueMicrotask(() => this.emit('close'));
      }

      emit(type, event = {}) {
        for (const handler of this.listeners[type] || []) {
          handler(event);
        }
      }
    }

    globalThis.WebSocket = FakeWebSocket;

    await expect(fetchNostrEventBySha256(sha256)).resolves.toEqual(event);
  });
});

describe('fetchNostrEventsBySha256Batch', () => {
  it('resolves mixed SHA batches via x and d fallback filters', async () => {
    const shaViaX = 'a'.repeat(64);
    const shaViaD = 'b'.repeat(64);
    const eventViaX = {
      id: 'c'.repeat(64),
      kind: 34236,
      tags: [
        ['d', 'legacy-vine-id'],
        ['x', shaViaX],
        ['platform', 'vine']
      ]
    };
    const eventViaD = {
      id: 'd'.repeat(64),
      kind: 34236,
      tags: [
        ['d', shaViaD],
        ['platform', 'vine']
      ]
    };
    const filters = [];

    class FakeWebSocket {
      constructor() {
        this.listeners = {};
        queueMicrotask(() => this.emit('open'));
      }

      addEventListener(type, handler) {
        if (!this.listeners[type]) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(handler);
      }

      send(message) {
        const [, subscriptionId, filter] = JSON.parse(message);
        filters.push(filter);
        queueMicrotask(() => {
          if (filter['#x']?.includes(shaViaX)) {
            this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, eventViaX]) });
          }
          if (filter['#d']?.includes(shaViaD)) {
            this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, eventViaD]) });
          }
          this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
        });
      }

      close() {
        queueMicrotask(() => this.emit('close'));
      }

      emit(type, event = {}) {
        for (const handler of this.listeners[type] || []) {
          handler(event);
        }
      }
    }

    globalThis.WebSocket = FakeWebSocket;

    const result = await fetchNostrEventsBySha256Batch([shaViaX, shaViaD], ['wss://relay.divine.video'], {}, {
      chunkSize: 2,
      concurrency: 1
    });
    expect(result.get(shaViaX)).toEqual(eventViaX);
    expect(result.get(shaViaD)).toEqual(eventViaD);

    const xFilters = filters.filter((filter) => Array.isArray(filter['#x']));
    const dFilters = filters.filter((filter) => Array.isArray(filter['#d']));
    expect(xFilters).toHaveLength(1);
    expect(xFilters[0]['#x']).toEqual([shaViaX, shaViaD]);
    expect(dFilters).toHaveLength(1);
    expect(dFilters[0]['#d']).toEqual([shaViaD]);
  });

  it('deduplicates input SHAs and keeps unresolved items as null', async () => {
    const shaResolved = 'e'.repeat(64);
    const shaMissing = 'f'.repeat(64);
    const event = {
      id: '1'.repeat(64),
      kind: 34236,
      tags: [
        ['x', shaResolved],
        ['platform', 'vine']
      ]
    };

    class FakeWebSocket {
      constructor() {
        this.listeners = {};
        queueMicrotask(() => this.emit('open'));
      }

      addEventListener(type, handler) {
        if (!this.listeners[type]) {
          this.listeners[type] = [];
        }
        this.listeners[type].push(handler);
      }

      send(message) {
        const [, subscriptionId, filter] = JSON.parse(message);
        queueMicrotask(() => {
          if (filter['#x']?.includes(shaResolved)) {
            this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
          }
          this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
        });
      }

      close() {
        queueMicrotask(() => this.emit('close'));
      }

      emit(type, eventPayload = {}) {
        for (const handler of this.listeners[type] || []) {
          handler(eventPayload);
        }
      }
    }

    globalThis.WebSocket = FakeWebSocket;

    const result = await fetchNostrEventsBySha256Batch([shaResolved, shaResolved, shaMissing]);
    expect(result.size).toBe(2);
    expect(result.get(shaResolved)).toEqual(event);
    expect(result.get(shaMissing)).toBeNull();
  });
});

describe('fetchNostrEventById', () => {
  const VALID_ID = 'a'.repeat(64);

  it('returns null for non-hex event IDs without fetching', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };

    try {
      await expect(fetchNostrEventById('../not-hex')).resolves.toBeNull();
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and all relays return 5xx', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 503 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and all relays throw network errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and relay returns 429', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 429 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when throwOnTransient and relay returns 404', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 404 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when one relay 503 + one relay 404 with throwOnTransient', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) return new Response('', { status: 503 });
      return new Response('', { status: 404 });
    };
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test', 'wss://r2.test'], {}, { throwOnTransient: true })
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null on all-503 without throwOnTransient (backward compat)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 503 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'])
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and relay returns 401 (auth blip is retryable)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 401 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and relay returns 403 (auth blip is retryable)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 403 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and a 2xx body is invalid JSON', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when throwOnTransient and a 2xx body is missing id/pubkey (malformed)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ kind: 34236, tags: [] }), { status: 200 });
    try {
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns the event when the 2xx body is the requested, validly-signed event', async () => {
    const signed = finalizeEvent(
      { kind: 34236, created_at: 1700000000, tags: [], content: '' },
      generateSecretKey()
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(signed), { status: 200 });
    try {
      await expect(
        fetchNostrEventById(signed.id, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).resolves.toEqual(signed);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when a valid 2xx event is not the requested id', async () => {
    const signed = finalizeEvent(
      { kind: 34236, created_at: 1700000000, tags: [], content: '' },
      generateSecretKey()
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(signed), { status: 200 });
    try {
      // Ask for a different id than the returned body carries.
      await expect(
        fetchNostrEventById(VALID_ID, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when the 2xx event id matches but the signature is invalid', async () => {
    // The relay's claimed id is untrusted: a body whose id string matches but
    // whose signature (and thus canonical hash) is invalid must be rejected, or
    // the id match is meaningless. verifyEvent binds pubkey/tags/content to id.
    const signed = finalizeEvent(
      { kind: 34236, created_at: 1700000000, tags: [], content: '' },
      generateSecretKey()
    );
    const tampered = { ...signed, sig: 'f'.repeat(128) };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(tampered), { status: 200 });
    try {
      await expect(
        fetchNostrEventById(tampered.id, ['wss://r1.test'], {}, { throwOnTransient: true })
      ).rejects.toThrow(/transient/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
