// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for classic Vine enforcement rollback helpers
// ABOUTME: Verifies rollback candidate matching and enforcement rewrite semantics

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClassicVineRollbackUpdate,
  executeClassicVineRollback,
  getClassicVineRollbackKvKeys,
  isClassicVineRollbackCandidate,
  runClassicVineRollback
} from './classic-vine-rollback.mjs';

const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('isClassicVineRollbackCandidate', () => {
  it('accepts explicit Vine platform metadata', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { platform: 'vine' }
    })).toBe(true);
  });

  it('accepts vine.co source URLs', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'sha-list',
      nostrContext: { sourceUrl: 'https://vine.co/v/abc123' }
    })).toBe(true);
  });

  it('accepts published_at fallback only for archive-oriented sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'archive-export',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(true);
  });

  it('rejects weak timestamp-only matches for generic sources', () => {
    expect(isClassicVineRollbackCandidate({
      source: 'd1-query',
      nostrContext: { publishedAt: 1389756506 }
    })).toBe(false);
  });
});

describe('buildClassicVineRollbackUpdate', () => {
  it('preserves stored scores and categories while forcing SAFE enforcement', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'PERMANENT_BAN',
      provider: 'hive',
      scores: JSON.stringify({ ai_generated: 0.97 }),
      categories: JSON.stringify(['ai_generated']),
      moderated_at: '2026-03-01T00:00:00.000Z'
    };

    const result = buildClassicVineRollbackUpdate(row, '2026-03-31T00:00:00.000Z');

    expect(result.action).toBe('SAFE');
    expect(result.scores).toBe(row.scores);
    expect(result.categories).toBe(row.categories);
    expect(result.reviewed_by).toBe('classic-vine-rollback');
  });
});

describe('getClassicVineRollbackKvKeys', () => {
  it('returns the full KV key list to clear on every execute pass', () => {
    expect(getClassicVineRollbackKvKeys('a'.repeat(64))).toEqual([
      `review:${'a'.repeat(64)}`,
      `quarantine:${'a'.repeat(64)}`,
      `age-restricted:${'a'.repeat(64)}`,
      `permanent-ban:${'a'.repeat(64)}`
    ]);
  });
});

describe('executeClassicVineRollback', () => {
  it('skips the D1 rewrite for rows that are already SAFE', async () => {
    const writes = [];
    const kvStore = new Map();
    const env = {
      BLOSSOM_DB: {
        prepare(sql) {
          let bindings = [];
          return {
            bind(...args) {
              bindings = args;
              return this;
            },
            async first() {
              return {
                sha256: 'a'.repeat(64),
                action: 'SAFE',
                provider: 'classic-vine-rollback',
                scores: JSON.stringify({}),
                categories: JSON.stringify([]),
                moderated_at: '2026-03-01T00:00:00.000Z',
                uploaded_by: null
              };
            },
            async run() {
              writes.push({ sql, bindings });
              return { success: true };
            }
          };
        }
      },
      MODERATION_KV: {
        async get(key) { return kvStore.get(key) ?? null; },
        async delete(key) { kvStore.delete(key); }
      }
    };

    const result = await executeClassicVineRollback({ sha256: 'a'.repeat(64) }, env, {
      notifyBlossom: async () => ({ success: true, skipped: true })
    });

    expect(writes).toHaveLength(0);
    expect(result.alreadySafe).toBe(true);
    expect(result.blossomNotified).toBe(true);
  });

  // A restore is a lift (#242). With no lift check to ask, it refuses.
  it('writes nothing when no lift check is wired', async () => {
    const writes = [];
    const notified = [];
    const env = {
      BLOSSOM_DB: {
        prepare(sql) {
          return {
            bind() { return this; },
            async first() { return { sha256: 'a'.repeat(64), action: 'PERMANENT_BAN', uploaded_by: null }; },
            async run() { writes.push(sql); return { success: true }; }
          };
        }
      },
      MODERATION_KV: {
        async get() { return null; },
        async delete(key) { writes.push(key); }
      }
    };

    const result = await executeClassicVineRollback({ sha256: 'a'.repeat(64) }, env, {
      notifyBlossom: async (...args) => { notified.push(args); return { success: true }; }
    });

    expect(result.liftRefused).toMatchObject({ code: 'lift_check_unavailable' });
    expect(writes).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe('runClassicVineRollback', () => {
  it('previews legacy Vine events discovered by x tag when d is a Vine ID', async () => {
    const sha256 = 'a'.repeat(64);
    const event = {
      id: 'b'.repeat(64),
      kind: 34236,
      content: '',
      created_at: 1465948644,
      tags: [
        ['d', 'legacy-vine-id'],
        ['x', sha256],
        ['imeta', `url https://media.divine.video/${sha256}`, 'm video/mp4', `x ${sha256}`],
        ['platform', 'vine'],
        ['client', 'vine-archive-importer'],
        ['r', 'https://vine.co/v/legacy-vine-id'],
        ['published_at', '1465948644']
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

    const result = await runClassicVineRollback({
      mode: 'preview',
      source: 'sha-list',
      sha256s: [sha256]
    }, {});

    expect(result.candidates).toEqual([
      {
        sha256,
        reason: 'confirmed-classic-vine',
        would_restore: true
      }
    ]);
  });

  it('resolves SHA-only batches through batched relay lookups', async () => {
    const firstSha = 'a'.repeat(64);
    const secondSha = 'b'.repeat(64);
    const calls = [];

    const result = await runClassicVineRollback({
      mode: 'preview',
      source: 'sha-list',
      sha256s: [firstSha, firstSha, secondSha]
    }, {}, {
      fetchNostrEventsBySha256Batch: async (sha256s, relays, env, options) => {
        calls.push({ sha256s, relays, env, options });
        return new Map([
          [firstSha, { tags: [['platform', 'vine']] }],
          [secondSha, null]
        ]);
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sha256s).toEqual([firstSha, secondSha]);
    expect(result.lookup).toMatchObject({
      sha_lookup_requested: 2,
      sha_lookup_resolved: 1,
      sha_lookup_missing: 1
    });
    expect(result.candidates).toEqual([
      {
        sha256: firstSha,
        reason: 'confirmed-classic-vine',
        would_restore: true
      },
      {
        sha256: firstSha,
        reason: 'confirmed-classic-vine',
        would_restore: true
      },
      {
        sha256: secondSha,
        reason: 'missing-vine-metadata',
        would_restore: false,
        restored: false
      }
    ]);
  });

  it('warns operators when large SHA-only batches are used', async () => {
    const items = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(64, '0'));
    const result = await runClassicVineRollback({
      mode: 'preview',
      source: 'sha-list',
      sha256s: items
    }, {}, {
      fetchNostrEventsBySha256Batch: async (sha256s) => new Map(sha256s.map((sha256) => [sha256, null]))
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Prefer videos[] with pre-resolved nostrContext');
  });

  it('skips relay lookup when all items already contain nostrContext', async () => {
    const sha256 = 'c'.repeat(64);
    let lookupCalled = false;

    const result = await runClassicVineRollback({
      mode: 'preview',
      source: 'sha-list',
      videos: [{
        sha256,
        nostrContext: {
          platform: 'vine',
          sourceUrl: 'https://vine.co/v/already-resolved'
        }
      }]
    }, {}, {
      fetchNostrEventsBySha256Batch: async () => {
        lookupCalled = true;
        return new Map();
      }
    });

    expect(lookupCalled).toBe(false);
    expect(result.lookup.sha_lookup_requested).toBe(0);
    expect(result.lookup.pre_resolved).toBe(1);
    expect(result.candidates).toEqual([
      {
        sha256,
        reason: 'confirmed-classic-vine',
        would_restore: true
      }
    ]);
  });

  it('reuses pre-resolved context for duplicate SHA items in mixed payloads', async () => {
    const sha256 = 'd'.repeat(64);
    const calls = [];

    const result = await runClassicVineRollback({
      mode: 'preview',
      source: 'sha-list',
      videos: [
        {
          sha256,
          nostrContext: {
            platform: 'vine'
          }
        },
        {
          sha256
        }
      ]
    }, {}, {
      fetchNostrEventsBySha256Batch: async (sha256s) => {
        calls.push(sha256s);
        return new Map();
      }
    });

    expect(calls).toEqual([]);
    expect(result.lookup.sha_lookup_requested).toBe(0);
    expect(result.candidates).toEqual([
      {
        sha256,
        reason: 'confirmed-classic-vine',
        would_restore: true
      },
      {
        sha256,
        reason: 'confirmed-classic-vine',
        would_restore: true
      }
    ]);
  });
});
