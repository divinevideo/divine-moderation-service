// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Queue consumer regression tests for moderation worker
// ABOUTME: Verifies validated queue fields are forwarded into the moderation pipeline

import { describe, it, expect, vi, beforeEach } from 'vitest';

const moderateVideoMock = vi.fn();

function createDbMock({ writes = [] } = {}) {
  return {
    prepare(sql) {
      let bindings = [];

      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          writes.push({ sql, bindings });
          return { success: true, bindings };
        }
      };
    },
    async batch() {
      return [];
    }
  };
}

// A DB mock whose dedup lookup returns an existing moderation row, so the queue
// consumer takes the "already moderated" skip branch. Captures .run() writes so a
// test can assert what still ran on that path.
function createSkipDbMock({ writes = [], existingRow } = {}) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async first() {
          if (sql.includes('SELECT sha256, action, moderated_at FROM moderation_results')) {
            return existingRow;
          }
          return null;
        },
        async run() {
          writes.push({ sql, bindings });
          return { success: true, bindings };
        }
      };
    },
    async batch() {
      return [];
    }
  };
}

function createEnv(overrides = {}) {
  return {
    BLOSSOM_DB: createDbMock(),
    MODERATION_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    CDN_DOMAIN: 'media.divine.video',
    ...overrides
  };
}

describe('queue consumer', () => {
  beforeEach(() => {
    vi.resetModules();
    moderateVideoMock.mockReset();
    moderateVideoMock.mockResolvedValue({
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      severity: 'low',
      scores: { nudity: 0, violence: 0, ai_generated: 0 },
      categories: [],
      provider: 'mock-provider',
      rawClassifierData: null,
      sceneClassification: null,
      topicProfile: null,
      cdnUrl: `https://media.divine.video/${'a'.repeat(64)}`,
      uploadedBy: null,
      nostrContext: null
    });
  });

  it('forwards Video Seal fields from the queue message into moderateVideo', async () => {
    vi.doMock('./moderation/pipeline.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        moderateVideo: moderateVideoMock
      };
    });

    const { default: worker } = await import('./index.mjs');

    const ack = vi.fn();
    const retry = vi.fn();
    const payload = `01${'b'.repeat(62)}`;

    await worker.queue({
      messages: [{
        body: {
          sha256: 'a'.repeat(64),
          uploadedAt: Date.now(),
          metadata: { source: 'blossom' },
          videoSealPayload: payload,
          videoSealBitAccuracy: 0.93
        },
        attempts: 0,
        ack,
        retry
      }]
    }, createEnv());

    expect(moderateVideoMock).toHaveBeenCalledTimes(1);
    expect(moderateVideoMock).toHaveBeenCalledWith(expect.objectContaining({
      videoSealPayload: payload,
      videoSealBitAccuracy: 0.93
    }), expect.any(Object));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('persists the interpreted Video Seal signal in D1', async () => {
    const writes = [];
    const videoseal = {
      signal: 'videoseal',
      detected: true,
      source: 'divine',
      isAI: false,
      payload: `01${'d'.repeat(62)}`,
      confidence: 0.93
    };

    moderateVideoMock.mockResolvedValue({
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      severity: 'low',
      scores: { nudity: 0, violence: 0, ai_generated: 0 },
      categories: [],
      provider: 'mock-provider',
      rawClassifierData: null,
      sceneClassification: null,
      topicProfile: null,
      cdnUrl: `https://media.divine.video/${'a'.repeat(64)}`,
      uploadedBy: null,
      nostrContext: null,
      videoseal
    });

    vi.doMock('./moderation/pipeline.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        moderateVideo: moderateVideoMock
      };
    });

    const { default: worker } = await import('./index.mjs');

    await worker.queue({
      messages: [{
        body: {
          sha256: 'a'.repeat(64),
          uploadedAt: Date.now(),
          metadata: { source: 'blossom' },
          videoSealPayload: videoseal.payload,
          videoSealBitAccuracy: 0.93
        },
        attempts: 0,
        ack: vi.fn(),
        retry: vi.fn()
      }]
    }, createEnv({
      BLOSSOM_DB: createDbMock({ writes })
    }));

    const moderationWrite = writes.find(({ sql }) => sql.includes('INSERT OR REPLACE INTO moderation_results'));

    expect(moderationWrite).toBeDefined();
    expect(moderationWrite.sql).toContain('videoseal');
    expect(moderationWrite.bindings).toContain(JSON.stringify(videoseal));
  });

  it('reconciles self-reports on the dedup-skip path when a report already wrote a moderation row (#212)', async () => {
    // The #212 race: a user reports their own freshly-uploaded video before the
    // scan runs. The report path writes a moderation_results row, so when the
    // delayed scan message arrives it trips the "already moderated" dedup skip.
    // The scan message still carries the verified uploader, so the reconcile must
    // run on the skip path too — otherwise the self-report the reconcile exists
    // to catch stays escalating forever.
    const writes = [];
    const SHA = 'a'.repeat(64);
    const UPLOADER = 'e'.repeat(64);

    vi.doMock('./moderation/pipeline.mjs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        moderateVideo: moderateVideoMock
      };
    });

    const { default: worker } = await import('./index.mjs');
    const ack = vi.fn();

    await worker.queue({
      messages: [{
        body: {
          sha256: SHA,
          uploadedBy: UPLOADER,
          uploadedAt: Date.now(),
          metadata: { source: 'blossom' }
        },
        attempts: 0,
        ack,
        retry: vi.fn()
      }]
    }, createEnv({
      BLOSSOM_DB: createSkipDbMock({
        writes,
        existingRow: { sha256: SHA, action: 'REVIEW', moderated_at: '2026-08-31T00:00:00.000Z' }
      })
    }));

    // The scan skipped — a moderation row already existed, and this is not a rescan.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(moderateVideoMock).not.toHaveBeenCalled();

    // ...but the self-report reconcile still ran, keyed on the message's verified uploader.
    const reconcileWrite = writes.find(({ sql }) =>
      sql.includes('UPDATE user_reports') && sql.includes("SET source = 'self-report'"));
    expect(reconcileWrite).toBeDefined();
    expect(reconcileWrite.bindings).toEqual([SHA, UPLOADER]);
  });
});
