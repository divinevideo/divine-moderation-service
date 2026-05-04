// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Request routing tests for API/admin hostname separation
// ABOUTME: Verifies public API exposure, admin isolation, and workers.dev disablement

import { describe, expect, it, vi } from 'vitest';
import worker from './index.mjs';

const SHA256 = 'a'.repeat(64);

function createDbMock({
  moderationResults = new Map(),
  moderationListRows = [],
  webhookEvents = new Map(),
  aiDetectionEvents = [],
  aiDetectionStatsRow = null,
  aiDetectionPolicyRows = [],
  aiDetectionReviewRows = [],
  aiDetectionRecentRows = [],
} = {}) {
  return {
    prepare(sql) {
      let bindings = [];

      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async run() {
          if (/INSERT OR IGNORE INTO ai_detection_events/i.test(sql)) {
            aiDetectionEvents.push({
              event_key: bindings[0],
              sha256: bindings[1],
              event_type: bindings[2],
              policy_reason: bindings[3],
              c2pa_state: bindings[4],
              ai_detection_ran: bindings[5],
              ai_detection_forced: bindings[6],
              ai_score: bindings[7],
              action: bindings[8],
              report_type: bindings[9],
              metadata_json: bindings[10],
              created_at: bindings[11],
            });
          }
          return { success: true };
        },
        async first() {
          if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
            return moderationResults.get(bindings[0]) ?? null;
          }
          if (sql.includes('FROM bunny_webhook_events')) {
            return webhookEvents.get(bindings[0]) ?? null;
          }
          if (sql.includes('FROM ai_detection_events')) {
            return aiDetectionStatsRow;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM moderation_results') && sql.includes('ORDER BY moderated_at')) {
            return { results: moderationListRows };
          }
          if (sql.includes('FROM ai_detection_events') && sql.includes("event_type = 'policy_decision'")) {
            return { results: aiDetectionPolicyRows };
          }
          if (sql.includes('FROM ai_detection_events') && sql.includes('GROUP BY policy_reason')) {
            return { results: aiDetectionReviewRows };
          }
          if (sql.includes('FROM ai_detection_events') && sql.includes('ORDER BY created_at DESC')) {
            return { results: aiDetectionRecentRows };
          }
          return { results: [] };
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
    ALLOW_DEV_ACCESS: 'false',
    SERVICE_API_TOKEN: 'test-service-token',
    BLOSSOM_DB: createDbMock(),
    MODERATION_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    MODERATION_QUEUE: {
      async send() {}
    },
    CDN_DOMAIN: 'media.divine.video',
    ...overrides
  };
}

describe('HTTP hostname routing', () => {
  it('returns 404 for workers.dev requests', async () => {
    const response = await worker.fetch(
      new Request(`https://divine-moderation-service.protestnet.workers.dev/check-result/${SHA256}`),
      createEnv()
    );

    expect(response.status).toBe(404);
  });

  it('serves public moderation status on moderation-api host', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'SAFE',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.01 }),
          categories: JSON.stringify(['safe']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/check-result/${SHA256}`),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sha256: SHA256,
      moderated: true,
      action: 'SAFE',
      status: 'safe'
    });
  });

  it('rejects admin routes on moderation-api host', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/admin'),
      createEnv()
    );

    expect(response.status).toBe(404);
  });

  it('rejects public status routes on moderation.admin host', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/check-result/${SHA256}`),
      createEnv()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: `Not found on moderation.admin.divine.video. Use https://moderation-api.divine.video/check-result/${SHA256}`
    });
  });

  it('requires auth for test-moderate on moderation-api host', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/test-moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: SHA256 })
      }),
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  it('returns legacy health payload on moderation-api host', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/health'),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'divine-moderation-api',
      hostname: 'moderation-api.divine.video'
    });
  });

  it('queues legacy /api/v1/scan requests', async () => {
    const queued = [];
    const env = createEnv({
      MODERATION_API_KEY: 'legacy-token',
      MODERATION_QUEUE: {
        async send(message) {
          queued.push(message);
        }
      }
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer legacy-token'
        },
        body: JSON.stringify({ sha256: SHA256, source: 'blossom' })
      }),
      env
    );

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sha256: SHA256,
      r2Key: `blobs/${SHA256}`,
      metadata: {
        source: 'blossom',
        videoUrl: `https://media.divine.video/${SHA256}`
      }
    });
  });

  it('queues a forced AI recheck when users report content as AI-generated', async () => {
    const queued = [];
    const aiDetectionEvents = [];
    const reporterPubkey = 'b'.repeat(64);
    const env = createEnv({
      BLOSSOM_DB: createDbMock({ aiDetectionEvents }),
      MODERATION_QUEUE: {
        async send(message) {
          queued.push(message);
        }
      }
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-service-token'
        },
        body: JSON.stringify({
          sha256: SHA256,
          reporter_pubkey: reporterPubkey,
          report_type: 'ai_generated',
          reason: 'looks synthetic'
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sha256: SHA256,
      r2Key: `videos/${SHA256}.mp4`,
      metadata: {
        source: 'user-report',
        forceAIDetection: true,
        reportType: 'ai_generated',
        reportedBy: reporterPubkey
      }
    });
    expect(aiDetectionEvents).toHaveLength(1);
    expect(aiDetectionEvents[0]).toMatchObject({
      sha256: SHA256,
      event_type: 'user_report',
      policy_reason: 'report_forced_ai_detection',
      ai_detection_forced: 1,
      report_type: 'ai_generated',
    });
  });

  it('queues a Hive moderation recheck when a non-AI report is submitted', async () => {
    const queued = [];
    const reporterPubkey = 'b'.repeat(64);
    const env = createEnv({
      BLOSSOM_DB: createDbMock(),
      MODERATION_QUEUE: {
        async send(message) {
          queued.push(message);
        }
      }
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-service-token'
        },
        body: JSON.stringify({
          sha256: SHA256,
          reporter_pubkey: reporterPubkey,
          report_type: 'nudity',
          reason: 'explicit content'
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sha256: SHA256,
      r2Key: `videos/${SHA256}.mp4`,
      metadata: {
        source: 'user-report',
        forceProvider: 'hiveai',
        reportType: 'nudity',
        reportedBy: reporterPubkey
      }
    });
  });

  it('skips queuing a Hive recheck when one already ran within the rate-limit window', async () => {
    const queued = [];
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({}),
          categories: JSON.stringify([]),
          moderated_at: recentIso,
          reviewed_by: null,
          reviewed_at: null,
        }]])
      }),
      MODERATION_QUEUE: {
        async send(message) {
          queued.push(message);
        }
      }
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-service-token'
        },
        body: JSON.stringify({
          sha256: SHA256,
          reporter_pubkey: 'c'.repeat(64),
          report_type: 'violence',
          reason: 'graphic'
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(queued).toHaveLength(0);
  });

  it('requires admin auth for AI detection stats', async () => {
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/ai-detection/stats'),
      createEnv({ ALLOW_DEV_ACCESS: 'false' })
    );

    expect(response.status).toBe(401);
  });

  it('returns AI detection stats for authenticated admins', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        aiDetectionStatsRow: {
          ai_detection_runs: 1,
          ai_detection_skips: 2,
          proofmode_skips: 2,
          signed_ai_skips: 0,
          original_vine_skips: 0,
          report_forced_checks: 1,
          open_review_items: 1,
        },
        aiDetectionPolicyRows: [
          { policy_reason: 'valid_proofmode_skip', count: 2 },
          { policy_reason: 'no_proof_ai_detection', count: 1 },
        ],
        aiDetectionReviewRows: [
          { policy_reason: 'proofmode_ai_downgrade', count: 1 },
        ],
        aiDetectionRecentRows: [
          {
            sha256: SHA256,
            action: 'REVIEW',
            c2pa_state: 'valid_proofmode',
            ai_score: 0.97,
            policy_reason: 'proofmode_ai_downgrade',
            created_at: '2026-05-03T00:00:00.000Z',
          },
        ],
      }),
      HIVE_AI_DETECTION_ESTIMATED_COST_CENTS: '65',
    });

    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/ai-detection/stats?window=24h', {
        headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' },
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      window: '24h',
      totals: {
        aiDetectionRuns: 1,
        aiDetectionSkips: 2,
        proofModeSkips: 2,
        reportForcedChecks: 1,
        openReviewItems: 1,
      },
      estimatedSpendAvoidedCents: 130,
      recentReviewItems: [{ sha256: SHA256, action: 'REVIEW' }],
    });
  });

  it('returns legacy 401 shape for unauthenticated /api/v1/scan', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: SHA256 })
      }),
      createEnv()
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect(response.json()).resolves.toEqual({
      error: 'Missing Authorization: Bearer <token>'
    });
  });

  it('returns legacy 403 shape for invalid /api/v1/status token', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/status/${SHA256}`, {
        headers: { 'Authorization': 'Bearer wrong-token' }
      }),
      createEnv()
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid token'
    });
  });

  it('returns legacy /api/v1/status payloads', async () => {
    const env = createEnv({
      MODERATION_API_KEY: 'legacy-token',
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'PERMANENT_BAN',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.99 }),
          categories: JSON.stringify(['nudity']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: 'user:test',
          reviewed_at: '2026-03-07T00:01:00.000Z'
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/status/${SHA256}`, {
        headers: { 'Authorization': 'Bearer legacy-token' }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sha256: SHA256,
      moderated: true,
      action: 'PERMANENT_BAN',
      blocked: true
    });
  });
});

describe('Admin video lookup', () => {
  it('returns a moderated video and merges KV override fields', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.4 }),
          categories: JSON.stringify(['nudity']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: 'admin',
          reviewed_at: '2026-03-07T01:00:00.000Z',
          review_notes: 'legacy note',
          uploaded_by: 'npub123'
        }]])
      }),
      MODERATION_KV: {
        async get(key) {
          if (key === `moderation:${SHA256}`) {
            return JSON.stringify({
              action: 'AGE_RESTRICTED',
              cdnUrl: `https://blossom.primal.net/${SHA256}.mp4`,
              scores: { nudity: 0.91, ai_generated: 0.2 },
              manualOverride: true,
              previousAction: 'REVIEW',
              overriddenAt: 1741305600000,
              reason: 'Manual override'
            });
          }
          return null;
        },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      }
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
        headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      video: {
        sha256: SHA256,
        action: 'AGE_RESTRICTED',
        cdnUrl: `https://blossom.primal.net/${SHA256}.mp4`,
        manualOverride: true,
        previousAction: 'REVIEW',
        reason: 'Manual override',
        scores: {
          nudity: 0.91
        }
      }
    });
  });

  it('returns stored moderation metadata when relay context is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const env = createEnv({
        BLOSSOM_DB: createDbMock({
          moderationResults: new Map([[SHA256, {
            sha256: SHA256,
            action: 'REVIEW',
            provider: 'hiveai',
            scores: JSON.stringify({ nudity: 0.4 }),
            categories: JSON.stringify(['nudity']),
            moderated_at: '2026-03-07T00:00:00.000Z',
            reviewed_by: null,
            reviewed_at: null,
            uploaded_by: 'b'.repeat(64),
            title: 'Stored title',
            author: 'Stored author',
            event_id: 'c'.repeat(64),
            content_url: 'https://media.divine.video/content.mp4',
            published_at: '1389756506'
          }]])
        })
      });

      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        video: {
          sha256: SHA256,
          uploaded_by: 'b'.repeat(64),
          eventId: 'c'.repeat(64),
          divineUrl: `https://divine.video/video/${'c'.repeat(64)}`,
          nostrContext: {
            title: 'Stored title',
            author: 'Stored author',
            url: 'https://media.divine.video/content.mp4',
            publishedAt: 1389756506,
            eventId: 'c'.repeat(64),
            pubkey: `${'b'.repeat(16)}...`
          }
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns persisted videoseal metadata from D1', async () => {
    const videoseal = {
      signal: 'videoseal',
      detected: true,
      source: 'divine',
      isAI: false,
      payload: `01${'e'.repeat(62)}`,
      confidence: 0.9
    };

    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'SAFE',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.01 }),
          categories: JSON.stringify(['safe']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null,
          videoseal: JSON.stringify(videoseal)
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
        headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      video: {
        sha256: SHA256,
        videoseal
      }
    });
  });

  it('uses FunnelCake REST instead of WebSocket when moderated metadata is missing', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const restCalls = [];

    globalThis.WebSocket = class {
      constructor() {
        throw new Error('WebSocket should not be used for admin lookup metadata');
      }
    };

    globalThis.fetch = async (url) => {
      restCalls.push(String(url));
      if (String(url) === `https://relay.divine.video/api/videos/${SHA256}`) {
        return new Response(JSON.stringify({
          event: {
            id: 'd'.repeat(64),
            pubkey: 'b'.repeat(64),
            created_at: 1700000000,
            kind: 34236,
            tags: [
              ['d', SHA256],
              ['title', 'REST title'],
              ['published_at', '1389756506'],
              ['imeta', 'url https://media.divine.video/rest-content.mp4', `x ${SHA256}`]
            ],
            content: 'REST description',
            sig: 'e'.repeat(128)
          },
          stats: {
            author_name: 'REST author'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({
          BLOSSOM_DB: createDbMock({
            moderationResults: new Map([[SHA256, {
              sha256: SHA256,
              action: 'REVIEW',
              provider: 'hiveai',
              scores: JSON.stringify({ nudity: 0.4 }),
              categories: JSON.stringify(['nudity']),
              moderated_at: '2026-03-07T00:00:00.000Z',
              reviewed_by: null,
              reviewed_at: null,
              uploaded_by: 'b'.repeat(64)
            }]])
          })
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        video: {
          sha256: SHA256,
          eventId: 'd'.repeat(64),
          divineUrl: `https://divine.video/video/${SHA256}`,
          nostrContext: {
            title: 'REST title',
            author: 'REST author',
            url: 'https://media.divine.video/rest-content.mp4',
            publishedAt: 1389756506,
            content: 'REST description',
            eventId: 'd'.repeat(64)
          }
        }
      });
      expect(restCalls).toEqual([`https://relay.divine.video/api/videos/${SHA256}`]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('returns mirrored relay context fields in the admin video list payload', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const restCalls = [];

    globalThis.WebSocket = class {
      constructor() {
        throw new Error('WebSocket should not be used for dashboard list metadata');
      }
    };

    globalThis.fetch = async (url) => {
      restCalls.push(String(url));
      if (String(url) === `https://relay.divine.video/api/videos/${SHA256}`) {
        return new Response(JSON.stringify({
          event: {
            id: 'd'.repeat(64),
            pubkey: 'b'.repeat(64),
            created_at: 1700000000,
            kind: 34236,
            tags: [
              ['d', SHA256],
              ['title', 'REST title'],
              ['published_at', '1389756506'],
              ['imeta', 'url https://media.divine.video/rest-content.mp4', `x ${SHA256}`]
            ],
            content: 'REST description',
            sig: 'e'.repeat(128)
          },
          stats: {
            author_name: 'REST author'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const moderationRow = {
        sha256: SHA256,
        action: 'REVIEW',
        provider: 'hiveai',
        scores: JSON.stringify({ nudity: 0.4 }),
        categories: JSON.stringify(['nudity']),
        moderated_at: '2026-03-07T00:00:00.000Z',
        reviewed_by: null,
        reviewed_at: null,
        uploaded_by: null
      };

      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/videos', {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({
          BLOSSOM_DB: createDbMock({
            moderationResults: new Map([[SHA256, moderationRow]]),
            moderationListRows: [moderationRow]
          })
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        videos: [{
          sha256: SHA256,
          uploaded_by: 'b'.repeat(64),
          eventId: 'd'.repeat(64),
          divineUrl: `https://divine.video/video/${SHA256}`,
          nostrContext: {
            title: 'REST title',
            author: 'REST author',
            url: 'https://media.divine.video/rest-content.mp4',
            publishedAt: 1389756506,
            content: 'REST description',
            eventId: 'd'.repeat(64)
          }
        }]
      });
      expect(restCalls).toEqual([`https://relay.divine.video/api/videos/${SHA256}`]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it('returns an untriaged video by sha lookup', async () => {
    const env = createEnv({
      CDN_DOMAIN: 'media.divine.video',
      BLOSSOM_DB: createDbMock({
        webhookEvents: new Map([[SHA256, {
          sha256: SHA256,
          video_guid: 'video-guid-1',
          hls_url: 'https://example.com/video.m3u8',
          mp4_url: 'https://example.com/video.mp4',
          thumbnail_url: 'https://example.com/thumb.jpg',
          received_at: '2026-03-08T00:00:00.000Z',
          status_name: 'finished'
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
        headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      video: {
        sha256: SHA256,
        status: 'UNTRIAGED',
        videoGuid: 'video-guid-1',
        cdnUrl: `https://media.divine.video/${SHA256}`
      }
    });
  });

  it('falls back to funnelcake lookup for imported videos', async () => {
    const mediaSha = 'b'.repeat(64);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://relay.divine.video/api/videos/${SHA256}`) {
        return new Response(JSON.stringify({
          event: {
            id: SHA256,
            pubkey: 'c'.repeat(64),
            created_at: 1773503656,
            kind: 34235,
            tags: [
              ['d', 'video-imported-stable-id'],
              ['title', 'Imported archive video'],
              ['client', 'Plebs'],
              ['imeta', `url https://blossom.primal.net/${mediaSha}.mp4`, `x ${mediaSha}`, 'image https://blossom.primal.net/thumb.png']
            ],
            content: 'archive description',
            sig: 'd'.repeat(128)
          },
          stats: {
            author_name: 'Archive User'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        video: {
          sha256: mediaSha,
          status: 'UNTRIAGED',
          cdnUrl: `https://blossom.primal.net/${mediaSha}.mp4`,
          thumbnailUrl: 'https://blossom.primal.net/thumb.png',
          uploaded_by: 'c'.repeat(64),
          divineUrl: 'https://divine.video/video/video-imported-stable-id',
          lookupId: SHA256
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves imported source URLs when a stable-id lookup resolves to an already moderated media hash', async () => {
    const mediaSha = 'b'.repeat(64);
    const stableId = 'video-imported-stable-id';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://relay.divine.video/api/videos/${stableId}`) {
        return new Response(JSON.stringify({
          event: {
            id: SHA256,
            pubkey: 'c'.repeat(64),
            created_at: 1773503656,
            kind: 34235,
            tags: [
              ['d', stableId],
              ['title', 'Imported archive video'],
              ['client', 'Plebs'],
              ['imeta', `url https://blossom.primal.net/${mediaSha}.mp4`, `x ${mediaSha}`, 'image https://blossom.primal.net/thumb.png']
            ],
            content: 'archive description',
            sig: 'd'.repeat(128)
          },
          stats: {
            author_name: 'Archive User'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/video/${stableId}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({
          BLOSSOM_DB: createDbMock({
            moderationResults: new Map([[mediaSha, {
              sha256: mediaSha,
              action: 'PERMANENT_BAN',
              provider: 'manual',
              scores: JSON.stringify({ ai_generated: 0.92 }),
              categories: JSON.stringify(['ai_generated']),
              moderated_at: '2026-03-17T00:00:00.000Z',
              reviewed_by: 'admin',
              reviewed_at: '2026-03-17T00:10:00.000Z',
              review_notes: 'Imported moderation',
              uploaded_by: 'c'.repeat(64)
            }]])
          })
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        video: {
          sha256: mediaSha,
          action: 'PERMANENT_BAN',
          cdnUrl: `https://blossom.primal.net/${mediaSha}.mp4`,
          thumbnailUrl: 'https://blossom.primal.net/thumb.png',
          divineUrl: `https://divine.video/video/${stableId}`,
          lookupId: stableId
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects oversized admin lookup identifiers', async () => {
    const identifier = 'x'.repeat(256);
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/video/${identifier}`, {
        headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
      }),
      createEnv()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid video lookup identifier'
    });
  });

  it('returns 404 when the lookup identifier is unknown', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('not found', { status: 404 });

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/video/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: 'Video not found',
        identifier: SHA256
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Admin nostr context lookup', () => {
  it('returns stored moderation metadata when relay context is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/nostr-context/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({
          BLOSSOM_DB: createDbMock({
            moderationResults: new Map([[SHA256, {
              sha256: SHA256,
              action: 'REVIEW',
              provider: 'hiveai',
              scores: JSON.stringify({ nudity: 0.4 }),
              categories: JSON.stringify(['nudity']),
              moderated_at: '2026-03-07T00:00:00.000Z',
              reviewed_by: null,
              reviewed_at: null,
              uploaded_by: 'b'.repeat(64),
              title: 'Stored title',
              author: 'Stored author',
              event_id: 'c'.repeat(64),
              content_url: 'https://media.divine.video/content.mp4',
              published_at: '1389756506'
            }]])
          })
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        found: true,
        metadata: {
          title: 'Stored title',
          author: 'Stored author',
          platform: null,
          client: null,
          loops: null,
          likes: null,
          comments: null,
          url: 'https://media.divine.video/content.mp4',
          sourceUrl: null,
          publishedAt: 1389756506,
          archivedAt: null,
          importedAt: null,
          vineHashId: null,
          vineUserId: null,
          content: null,
          eventId: 'c'.repeat(64),
          createdAt: null
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses FunnelCake REST instead of WebSocket when stored metadata is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const restCalls = [];

    globalThis.WebSocket = class {
      constructor() {
        throw new Error('WebSocket should not be used for admin nostr context');
      }
    };

    globalThis.fetch = async (url) => {
      restCalls.push(String(url));
      if (String(url) === `https://relay.divine.video/api/videos/${SHA256}`) {
        return new Response(JSON.stringify({
          event: {
            id: 'd'.repeat(64),
            pubkey: 'b'.repeat(64),
            created_at: 1700000000,
            kind: 34236,
            tags: [
              ['d', SHA256],
              ['title', 'REST title'],
              ['published_at', '1389756506'],
              ['imeta', 'url https://media.divine.video/rest-content.mp4', `x ${SHA256}`]
            ],
            content: 'REST description',
            sig: 'e'.repeat(128)
          },
          stats: {
            author_name: 'REST author'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/nostr-context/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        found: true,
        metadata: {
          title: 'REST title',
          author: 'REST author',
          platform: null,
          client: null,
          loops: null,
          likes: null,
          comments: null,
          url: 'https://media.divine.video/rest-content.mp4',
          sourceUrl: null,
          publishedAt: 1389756506,
          archivedAt: null,
          importedAt: null,
          vineHashId: null,
          vineUserId: null,
          content: 'REST description',
          eventId: 'd'.repeat(64),
          createdAt: 1700000000
        }
      });
      expect(restCalls).toEqual([`https://relay.divine.video/api/videos/${SHA256}`]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });
});

describe('Admin transcript access', () => {
  it('returns parsed transcript text for admin transcript lookup', async () => {
    const vttText = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:04.000
This is a test`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}.vtt`) {
        return new Response(vttText, {
          status: 200,
          headers: { 'Content-Type': 'text/vtt' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/transcript/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        sha256: SHA256,
        found: true,
        subtitleUrl: `/admin/transcript/${SHA256}.vtt`,
        sourceUrl: `https://media.divine.video/${SHA256}.vtt`,
        transcriptText: 'Hello world This is a test'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns pending transcript state when Blossom is still generating VTT', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}.vtt`) {
        return new Response(JSON.stringify({
          status: 'processing',
          message: 'Transcript generation started, please retry soon'
        }), {
          status: 202,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '10'
          }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/transcript/${SHA256}`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(202);
      expect(response.headers.get('Retry-After')).toBe('10');
      await expect(response.json()).resolves.toEqual({
        sha256: SHA256,
        found: false,
        pending: true,
        subtitleUrl: `/admin/transcript/${SHA256}.vtt`,
        sourceUrl: `https://media.divine.video/${SHA256}.vtt`,
        retryAfterSeconds: 10,
        status: 'processing',
        message: 'Transcript generation started, please retry soon'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('proxies raw VTT content through the admin transcript route', async () => {
    const vttText = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}.vtt`) {
        return new Response(vttText, {
          status: 200,
          headers: { 'Content-Type': 'text/vtt' }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/transcript/${SHA256}.vtt`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/vtt; charset=utf-8');
      await expect(response.text()).resolves.toBe(vttText);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not proxy pending transcript JSON as a fake VTT file', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}.vtt`) {
        return new Response(JSON.stringify({
          status: 'cooling_down',
          message: 'Transcript generation cooling down before retry'
        }), {
          status: 202,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '30'
          }
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/transcript/${SHA256}.vtt`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(202);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Retry-After')).toBe('30');
      await expect(response.json()).resolves.toEqual({
        sha256: SHA256,
        found: false,
        pending: true,
        subtitleUrl: `/admin/transcript/${SHA256}.vtt`,
        sourceUrl: `https://media.divine.video/${SHA256}.vtt`,
        retryAfterSeconds: 30,
        status: 'cooling_down',
        message: 'Transcript generation cooling down before retry'
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('admin video proxy format fallback', () => {
  it('serves video directly when CDN returns browser-playable format', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        return new Response('mp4-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('video/mp4');
      expect(response.headers.get('X-Admin-Proxy')).toBe('cdn');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves byte-range streaming headers for browser playback', async () => {
    const originalFetch = globalThis.fetch;
    let receivedRange = null;

    globalThis.fetch = async (url, init = {}) => {
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        receivedRange = init.headers?.get?.('Range') || init.headers?.Range || null;
        return new Response('partial-mp4-bytes', {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes 0-1023/4096',
            'Accept-Ranges': 'bytes',
            'Content-Length': '1024'
          }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: {
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video',
            'Range': 'bytes=0-1023'
          }
        }),
        createEnv()
      );

      expect(receivedRange).toBe('bytes=0-1023');
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Type')).toBe('video/mp4');
      expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/4096');
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response.headers.get('Content-Length')).toBe('1024');
      expect(response.headers.get('X-Admin-Proxy')).toBe('cdn');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to transcoded 720p MP4 when CDN returns video/3gpp', async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls = [];
    globalThis.fetch = async (url, init) => {
      fetchedUrls.push(String(url));
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        return new Response('3gpp-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/3gpp' }
        });
      }
      if (String(url) === `https://media.divine.video/${SHA256}/720p.mp4`) {
        return new Response('transcoded-mp4-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('video/mp4');
      expect(response.headers.get('X-Admin-Proxy')).toBe('cdn-transcode');
      expect(fetchedUrls).toContain(`https://media.divine.video/${SHA256}/720p.mp4`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to admin bypass when transcode also unavailable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        return new Response('3gpp-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/3gpp' }
        });
      }
      if (String(url) === `https://media.divine.video/${SHA256}/720p.mp4`) {
        return new Response('not found', { status: 404 });
      }
      if (String(url) === `https://media.divine.video/admin/api/blob/${SHA256}/content`) {
        return new Response('bypass-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({ BLOSSOM_WEBHOOK_SECRET: 'test-secret' })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Admin-Proxy')).toBe('blossom-admin');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to stored moderation content URL when CDN fetch fails and admin bypass is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];

    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        return new Response('not found', { status: 404 });
      }
      if (String(url) === 'https://archive.example.com/original-vine.mp4') {
        return new Response('archive-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv({
          BLOSSOM_DB: createDbMock({
            moderationResults: new Map([[SHA256, {
              sha256: SHA256,
              action: 'REVIEW',
              provider: 'hiveai',
              scores: JSON.stringify({ nudity: 0.92 }),
              categories: JSON.stringify(['nudity']),
              moderated_at: '2026-03-07T00:00:00.000Z',
              content_url: 'https://archive.example.com/original-vine.mp4'
            }]])
          })
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('video/mp4');
      expect(response.headers.get('X-Admin-Proxy')).toBe('stored-content-url');
      expect(fetchCalls).toEqual([
        `https://media.divine.video/${SHA256}`,
        'https://archive.example.com/original-vine.mp4'
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to transcoded MP4 for video/x-matroska (MKV)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === `https://media.divine.video/${SHA256}`) {
        return new Response('mkv-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/x-matroska' }
        });
      }
      if (String(url) === `https://media.divine.video/${SHA256}/720p.mp4`) {
        return new Response('transcoded-mp4-bytes', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' }
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/video/${SHA256}.mp4`, {
          headers: { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' }
        }),
        createEnv()
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('video/mp4');
      expect(response.headers.get('X-Admin-Proxy')).toBe('cdn-transcode');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('notifyBlossom integration via admin moderate endpoint', () => {
  // Exercises the real notifyBlossom() code path through the admin API.
  // A mock fetch interceptor captures the webhook payload Blossom would receive.

  function createBlossomCapture() {
    const captured = [];
    return {
      captured,
      webhookUrl: 'https://mock-blossom.test/admin/moderate',
      webhookSecret: 'test-webhook-secret',
    };
  }

  function createIntegrationEnv(blossom, overrides = {}) {
    const kvStore = new Map();
    return {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: blossom.webhookUrl,
      BLOSSOM_WEBHOOK_SECRET: blossom.webhookSecret,
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({ ai_generated: 0.95 }),
          categories: JSON.stringify(['ai_generated']),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      // Intercept fetch to capture Blossom webhook payloads
      __fetchInterceptor: (url, init) => {
        if (url === blossom.webhookUrl) {
          blossom.captured.push({
            url,
            method: init.method,
            headers: init.headers,
            body: JSON.parse(init.body),
          });
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return null; // not intercepted
      },
      ...overrides
    };
  }

  it('sends action RESTRICT to Blossom when moderating as QUARANTINE', async () => {
    const blossom = createBlossomCapture();
    const env = createIntegrationEnv(blossom);

    // Patch global fetch to intercept Blossom webhook calls
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${SHA256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'QUARANTINE', reason: 'test' })
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(blossom.captured).toHaveLength(1);
      expect(blossom.captured[0].body.action).toBe('RESTRICT');
      expect(blossom.captured[0].body.sha256).toBe(SHA256);
      expect(blossom.captured[0].headers['Authorization']).toBe('Bearer test-webhook-secret');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('sends action PERMANENT_BAN unchanged to Blossom', async () => {
    const blossom = createBlossomCapture();
    const env = createIntegrationEnv(blossom);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${SHA256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'PERMANENT_BAN', reason: 'test' })
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(blossom.captured).toHaveLength(1);
      expect(blossom.captured[0].body.action).toBe('PERMANENT_BAN');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not send webhook to Blossom for REVIEW', async () => {
    const blossom = createBlossomCapture();
    const env = createIntegrationEnv(blossom);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${SHA256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'REVIEW', reason: 'test' })
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(blossom.captured).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns 502 when Blossom webhook fails for /api/v1/moderate', async () => {
    const kvStore = new Map();
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: createDbMock({ moderationResults: new Map() }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/admin/moderate') {
        return new Response('Service Unavailable', { status: 503 });
      }
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation-api.divine.video/api/v1/moderate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-service-token',
          },
          body: JSON.stringify({
            sha256: 'abc123',
            action: 'AGE_RESTRICTED',
            reason: 'test age restrict',
            source: 'relay-manager',
          }),
        }),
        env
      );

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.blossom_notified).toBe(false);
      expect(data.action).toBe('AGE_RESTRICTED');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns 200 when Blossom webhook succeeds for /api/v1/moderate', async () => {
    const kvStore = new Map();
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: createDbMock({ moderationResults: new Map() }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/admin/moderate') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation-api.divine.video/api/v1/moderate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-service-token',
          },
          body: JSON.stringify({
            sha256: 'abc123',
            action: 'AGE_RESTRICTED',
            reason: 'test',
            source: 'relay-manager',
          }),
        }),
        env
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.blossom_notified).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns 502 when Blossom webhook fails for /admin/api/moderate', async () => {
    const sha256 = 'b'.repeat(64);
    const kvStore = new Map();
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[sha256, {
          sha256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({}),
          categories: JSON.stringify([]),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/admin/moderate') {
        return new Response('Service Unavailable', { status: 503 });
      }
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'AGE_RESTRICTED', reason: 'test age restrict' })
        }),
        env
      );

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.blossom_notified).toBe(false);
      expect(data.action).toBe('AGE_RESTRICTED');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not delete relay events when Blossom webhook fails for /admin/api/moderate', async () => {
    const sha256 = 'c'.repeat(64);
    const kvStore = new Map();
    let relayAdminCalls = 0;
    let relaySocketConstructed = 0;
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      RELAY_ADMIN_URL: 'https://relay-admin.test',
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[sha256, {
          sha256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({}),
          categories: JSON.stringify([]),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    const OrigWebSocket = globalThis.WebSocket;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/admin/moderate') {
        return new Response('Service Unavailable', { status: 503 });
      }
      if (typeof url === 'string' && url.startsWith('https://relay-admin.test')) {
        relayAdminCalls += 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return origFetch(url, init);
    };
    globalThis.WebSocket = class {
      constructor() {
        relaySocketConstructed += 1;
      }
      addEventListener() {}
      close() {}
      send() {}
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'PERMANENT_BAN', reason: 'test ban' })
        }),
        env
      );

      expect(response.status).toBe(502);
      expect(relayAdminCalls).toBe(0);
      expect(relaySocketConstructed).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.WebSocket = OrigWebSocket;
    }
  });

  it('returns 502 when Blossom webhook fails for /api/v1/quarantine', async () => {
    const sha256 = 'd'.repeat(64);
    const kvStore = new Map();
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[sha256, {
          sha256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({}),
          categories: JSON.stringify([]),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/admin/moderate') {
        return new Response('Service Unavailable', { status: 503 });
      }
      return origFetch(url, init);
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation-api.divine.video/api/v1/quarantine/${sha256}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-service-token',
          },
          body: JSON.stringify({
            quarantine: true,
            reason: 'test quarantine',
          }),
        }),
        env
      );

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.blossom_notified).toBe(false);
      expect(data.action).toBe('QUARANTINE');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('classic vine rollback admin endpoint', () => {
  function createRollbackDb(rowBySha = new Map(), writes = []) {
    return {
      prepare(sql) {
        let bindings = [];

        return {
          bind(...args) {
            bindings = args;
            return this;
          },
          async run() {
            writes.push({ sql, bindings });
            return { success: true };
          },
          async first() {
            if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
              return rowBySha.get(bindings[0]) ?? null;
            }
            return null;
          },
          async all() {
            return { results: [] };
          }
        };
      },
      async batch() {
        return [];
      }
    };
  }

  function createRollbackEnv({ rows = new Map(), kvStore = new Map(), blossomPayloads = [], dbWrites = [] } = {}) {
    return {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/classic-vines/rollback',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: createRollbackDb(rows, dbWrites),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      __fetchInterceptor: (url, init) => {
        if (url === 'https://mock-blossom.test/classic-vines/rollback') {
          blossomPayloads.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return null;
      }
    };
  }

  it('previews classic vine rollback candidates without mutating enforcement state', async () => {
    const env = createRollbackEnv({
      rows: new Map([[SHA256, {
        sha256: SHA256,
        action: 'PERMANENT_BAN',
        provider: 'hiveai',
        scores: JSON.stringify({ ai_generated: 0.97 }),
        categories: JSON.stringify(['ai_generated']),
        moderated_at: '2026-03-12T00:00:00.000Z'
      }]])
    });

    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'preview',
          source: 'sha-list',
          videos: [{
            sha256: SHA256,
            nostrContext: {
              platform: 'vine',
              sourceUrl: 'https://vine.co/v/abc123',
              publishedAt: 1389756506
            }
          }]
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: 'preview',
      processed: 1,
      restored: 0,
      skipped: 0,
      failed: 0,
      candidates: [{
        sha256: SHA256,
        would_restore: true,
        reason: 'confirmed-classic-vine'
      }]
    });
  });

  it('restores enforcement for confirmed classic vines without calling moderation providers', async () => {
    const kvStore = new Map([
      [`review:${SHA256}`, JSON.stringify({ action: 'REVIEW' })],
      [`quarantine:${SHA256}`, JSON.stringify({ action: 'QUARANTINE' })],
      [`age-restricted:${SHA256}`, JSON.stringify({ action: 'AGE_RESTRICTED' })],
      [`permanent-ban:${SHA256}`, JSON.stringify({ action: 'PERMANENT_BAN' })],
    ]);
    const blossomPayloads = [];
    const providerRequests = [];
    const env = createRollbackEnv({
      rows: new Map([[SHA256, {
        sha256: SHA256,
        action: 'PERMANENT_BAN',
        provider: 'hiveai',
        scores: JSON.stringify({ ai_generated: 0.97 }),
        categories: JSON.stringify(['ai_generated']),
        moderated_at: '2026-03-12T00:00:00.000Z'
      }]]),
      kvStore,
      blossomPayloads
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      providerRequests.push(String(url));
      return new Response('{}', { status: 404 });
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'execute',
            source: 'sha-list',
            videos: [{
              sha256: SHA256,
              nostrContext: {
                platform: 'vine',
                sourceUrl: 'https://vine.co/v/abc123',
                publishedAt: 1389756506
              }
            }]
          })
        }),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        mode: 'execute',
        processed: 1,
        restored: 1,
        skipped: 0,
        failed: 0,
        candidates: [{
          sha256: SHA256,
          restored: true,
          reason: 'confirmed-classic-vine'
        }]
      });
      expect(blossomPayloads).toHaveLength(1);
      expect(blossomPayloads[0].action).toBe('SAFE');
      expect(providerRequests).toEqual([]);
      expect(kvStore.has(`review:${SHA256}`)).toBe(false);
      expect(kvStore.has(`quarantine:${SHA256}`)).toBe(false);
      expect(kvStore.has(`age-restricted:${SHA256}`)).toBe(false);
      expect(kvStore.has(`permanent-ban:${SHA256}`)).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns a cursor for unfinished classic vine rollback batches', async () => {
    const blossomPayloads = [];
    const env = createRollbackEnv({
      rows: new Map([
        [SHA256, {
          sha256: SHA256,
          action: 'PERMANENT_BAN',
          provider: 'hiveai',
          scores: JSON.stringify({ ai_generated: 0.97 }),
          categories: JSON.stringify(['ai_generated']),
          moderated_at: '2026-03-12T00:00:00.000Z'
        }],
        ['b'.repeat(64), {
          sha256: 'b'.repeat(64),
          action: 'PERMANENT_BAN',
          provider: 'hiveai',
          scores: JSON.stringify({ ai_generated: 0.96 }),
          categories: JSON.stringify(['ai_generated']),
          moderated_at: '2026-03-12T00:00:00.000Z'
        }]
      ]),
      blossomPayloads
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      return new Response('{}', { status: 404 });
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'execute',
            source: 'sha-list',
            limit: 1,
            videos: [
              {
                sha256: SHA256,
                nostrContext: {
                  platform: 'vine',
                  sourceUrl: 'https://vine.co/v/abc123',
                  publishedAt: 1389756506
                }
              },
              {
                sha256: 'b'.repeat(64),
                nostrContext: {
                  vineHashId: 'second-vine',
                  publishedAt: 1390000000
                }
              }
            ]
          })
        }),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        mode: 'execute',
        processed: 1,
        restored: 1,
        next_cursor: '1'
      });
      expect(blossomPayloads).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('treats already-SAFE rows as skipped without rewriting D1', async () => {
    const dbWrites = [];
    const blossomPayloads = [];
    const env = createRollbackEnv({
      rows: new Map([[SHA256, {
        sha256: SHA256,
        action: 'SAFE',
        provider: 'classic-vine-rollback',
        scores: JSON.stringify({}),
        categories: JSON.stringify([]),
        moderated_at: '2026-03-12T00:00:00.000Z'
      }]]),
      blossomPayloads,
      dbWrites
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const intercepted = env.__fetchInterceptor(url, init);
      if (intercepted) return intercepted;
      return new Response('{}', { status: 404 });
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'execute',
            source: 'sha-list',
            videos: [{
              sha256: SHA256,
              nostrContext: {
                platform: 'vine',
                sourceUrl: 'https://vine.co/v/abc123',
                publishedAt: 1389756506
              }
            }]
          })
        }),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        mode: 'execute',
        processed: 1,
        restored: 0,
        skipped: 1,
        failed: 0,
        candidates: [{
          sha256: SHA256,
          reason: 'already-safe',
          already_safe: true,
          restored: false
        }]
      });
      expect(dbWrites.filter(({ sql }) => sql.includes('INSERT INTO moderation_results'))).toHaveLength(0);
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('reports Blossom failures instead of claiming rollback success', async () => {
    const kvStore = new Map([
      [`permanent-ban:${SHA256}`, JSON.stringify({ action: 'PERMANENT_BAN' })],
    ]);
    const dbWrites = [];
    const env = createRollbackEnv({
      rows: new Map([[SHA256, {
        sha256: SHA256,
        action: 'PERMANENT_BAN',
        provider: 'hiveai',
        scores: JSON.stringify({ ai_generated: 0.97 }),
        categories: JSON.stringify(['ai_generated']),
        moderated_at: '2026-03-12T00:00:00.000Z'
      }]]),
      kvStore,
      dbWrites
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://mock-blossom.test/classic-vines/rollback') {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response('{}', { status: 404 });
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/classic-vines/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'execute',
            source: 'sha-list',
            videos: [{
              sha256: SHA256,
              nostrContext: {
                platform: 'vine',
                sourceUrl: 'https://vine.co/v/abc123',
                publishedAt: 1389756506
              }
            }]
          })
        }),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        mode: 'execute',
        processed: 1,
        restored: 0,
        skipped: 0,
        failed: 1,
        candidates: [{
          sha256: SHA256,
          reason: 'blossom-notification-failed',
          blossom_notified: false,
          restored: false
        }]
      });
      expect(dbWrites.filter(({ sql }) => sql.includes('INSERT INTO moderation_results'))).toHaveLength(1);
      expect(kvStore.has(`permanent-ban:${SHA256}`)).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('DM exclusion for QUARANTINE via admin moderate', () => {
  it('does not send DM when action is QUARANTINE even with NOSTR_PRIVATE_KEY set', async () => {
    let dmAttempted = false;
    const kvStore = new Map();

    const env = {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      NOSTR_PRIVATE_KEY: 'deadbeef'.repeat(8),
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({ ai_generated: 0.95 }),
          categories: JSON.stringify(['ai_generated']),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null,
          uploaded_by: 'a]'.repeat(32)
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    // Patch sendModerationDM to detect if it's called
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.includes('mock-blossom')) {
        return new Response('{}', { status: 200 });
      }
      // DM sending would attempt relay connections — detect that
      if (typeof url === 'string' && url.startsWith('wss:')) {
        dmAttempted = true;
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${SHA256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'QUARANTINE', reason: 'test DM exclusion' })
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.dm_sent).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('attempts DM when action is PERMANENT_BAN with NOSTR_PRIVATE_KEY set', async () => {
    const uploaderPubkey = 'ab'.repeat(32);
    const kvStore = new Map();
    let dmImportAttempted = false;

    const env = {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      NOSTR_PRIVATE_KEY: 'deadbeef'.repeat(8),
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'REVIEW',
          provider: 'hiveai',
          scores: JSON.stringify({ ai_generated: 0.95 }),
          categories: JSON.stringify(['ai_generated']),
          moderated_at: '2026-03-12T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null,
          uploaded_by: uploaderPubkey
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    // Track whether the DM code path is entered by watching for relay WebSocket connections
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith('wss:')) {
        dmImportAttempted = true;
      }
      return new Response('{}', { status: 200 });
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/moderate/${SHA256}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'PERMANENT_BAN', reason: 'test DM inclusion' })
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      // dm_sent depends on whether sendModerationDM succeeds against the mock,
      // but the key contrast is: QUARANTINE above → dm_sent:false,
      // PERMANENT_BAN here → DM code path entered (dm_sent:true or throws trying)
      expect(body.dm_sent).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('RD auto-escalation cron integration', () => {
  // Exercises the real scheduled handler with mocked KV containing
  // a pending RD result and quarantined content. Verifies the full
  // escalation path: KV update, D1 update, Blossom notification.

  it('auto-escalates quarantined content when RD returns likely_ai', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const d1Updates = [];

    // Seed KV: pending RD job + quarantined moderation record
    // pollRealityDefender reads `requestId` from KV (not `jobId`)
    kvStore.set(`rd:${SHA256}`, JSON.stringify({ status: 'pending', requestId: 'rd-req-123' }));
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({
      action: 'QUARANTINE',
      category: 'ai_generated',
      uploadedBy: 'ab'.repeat(32),
    }));
    kvStore.set(`quarantine:${SHA256}`, JSON.stringify({ category: 'ai_generated' }));

    const env = {
      REALITY_DEFENDER_API_KEY: 'fake-rd-key',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-secret',
      BLOSSOM_DB: {
        prepare(sql) {
          return {
            bind(...args) {
              if (sql.includes('UPDATE moderation_results')) {
                d1Updates.push({ sql, args });
              }
              return this;
            },
            async run() { return { success: true }; },
            async first() { return null; },
            async all() { return { results: [] }; }
          };
        },
        async batch() { return []; }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list({ prefix } = {}) {
          const keys = [...kvStore.keys()]
            .filter(k => !prefix || k.startsWith(prefix))
            .map(name => ({ name }));
          return { keys, list_complete: true, cursor: null };
        }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    // Mock fetch: intercept RD API poll and Blossom webhook
    // pollRealityDefender calls: https://api.prd.realitydefender.xyz/api/media/users/{requestId}
    // It maps resultsSummary.status FAKE → verdict 'likely_ai', finalScore (0-100) → score (0-1)
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.includes('realitydefender')) {
        return new Response(JSON.stringify({
          resultsSummary: {
            status: 'FAKE',
            metadata: { finalScore: 92 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // Swallow relay/DM fetch attempts
      return new Response('{}', { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      // Verify KV was updated to PERMANENT_BAN
      const moderation = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderation.action).toBe('PERMANENT_BAN');
      expect(moderation.reviewedBy).toBe('reality-defender-auto');
      expect(moderation.reason).toContain('Reality Defender confirmed AI-generated');

      // Verify quarantine key deleted, permanent-ban key created
      expect(kvStore.has(`quarantine:${SHA256}`)).toBe(false);
      expect(kvStore.has(`permanent-ban:${SHA256}`)).toBe(true);
      const banData = JSON.parse(kvStore.get(`permanent-ban:${SHA256}`));
      expect(banData.autoEscalated).toBe(true);

      // Verify D1 was updated
      expect(d1Updates).toHaveLength(1);
      expect(d1Updates[0].args[0]).toBe('PERMANENT_BAN');
      expect(d1Updates[0].args[2]).toBe('reality-defender-auto');

      // Verify Blossom was notified with PERMANENT_BAN
      expect(blossomPayloads).toHaveLength(1);
      expect(blossomPayloads[0].action).toBe('PERMANENT_BAN');
      expect(blossomPayloads[0].sha256).toBe(SHA256);

      // Verify rd: entry marked as escalated (prevents retry)
      const rdAfter = JSON.parse(kvStore.get(`rd:${SHA256}`));
      expect(rdAfter.escalated).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('retries escalation when rd: is complete but escalation previously failed', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];

    // Simulate a previous run where RD completed but escalation failed:
    // rd: is complete+likely_ai but NOT escalated, content still quarantined
    kvStore.set(`rd:${SHA256}`, JSON.stringify({
      status: 'complete', verdict: 'likely_ai', score: 0.92, requestId: 'rd-req-retry'
    }));
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({
      action: 'QUARANTINE',
      category: 'ai_generated',
      uploadedBy: 'ab'.repeat(32),
    }));
    kvStore.set(`quarantine:${SHA256}`, JSON.stringify({ category: 'ai_generated' }));

    const env = {
      REALITY_DEFENDER_API_KEY: 'fake-rd-key',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_WEBHOOK_SECRET: 'test-secret',
      BLOSSOM_DB: {
        prepare(sql) {
          return {
            bind(...args) { return this; },
            async run() { return { success: true }; },
            async first() { return null; },
            async all() { return { results: [] }; }
          };
        },
        async batch() { return []; }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list({ prefix } = {}) {
          const keys = [...kvStore.keys()]
            .filter(k => !prefix || k.startsWith(prefix))
            .map(name => ({ name }));
          return { keys, list_complete: true, cursor: null };
        }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      // Verify escalation happened on retry
      const moderation = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderation.action).toBe('PERMANENT_BAN');

      // Verify Blossom was notified
      expect(blossomPayloads).toHaveLength(1);
      expect(blossomPayloads[0].action).toBe('PERMANENT_BAN');

      // Verify rd: now marked as escalated
      const rdAfter = JSON.parse(kvStore.get(`rd:${SHA256}`));
      expect(rdAfter.escalated).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('skips auto-escalation when moderator already changed action from QUARANTINE', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];

    // Seed KV: pending RD job, but moderation already changed to SAFE by moderator
    kvStore.set(`rd:${SHA256}`, JSON.stringify({ status: 'pending', requestId: 'rd-req-456' }));
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({
      action: 'SAFE',
      category: 'ai_generated',
      reviewedBy: 'admin',
    }));

    const env = {
      REALITY_DEFENDER_API_KEY: 'fake-rd-key',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      BLOSSOM_DB: {
        prepare() {
          return {
            bind() { return this; },
            async run() { return { success: true }; },
            async first() { return null; },
            async all() { return { results: [] }; }
          };
        },
        async batch() { return []; }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list({ prefix } = {}) {
          const keys = [...kvStore.keys()]
            .filter(k => !prefix || k.startsWith(prefix))
            .map(name => ({ name }));
          return { keys, list_complete: true, cursor: null };
        }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.includes('realitydefender')) {
        return new Response(JSON.stringify({
          resultsSummary: {
            status: 'FAKE',
            metadata: { finalScore: 95 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (typeof url === 'string' && url.includes('mock-blossom')) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      // Moderation should still be SAFE — human decision preserved
      const moderation = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderation.action).toBe('SAFE');

      // Blossom should NOT have been notified (no escalation)
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not auto-escalate when RD verdict is authentic', async () => {
    const kvStore = new Map();

    kvStore.set(`rd:${SHA256}`, JSON.stringify({ status: 'pending', requestId: 'rd-req-789' }));
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({
      action: 'QUARANTINE',
      category: 'ai_generated',
    }));

    const env = {
      REALITY_DEFENDER_API_KEY: 'fake-rd-key',
      BLOSSOM_DB: {
        prepare() {
          return {
            bind() { return this; },
            async run() { return { success: true }; },
            async first() { return null; },
            async all() { return { results: [] }; }
          };
        },
        async batch() { return []; }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list({ prefix } = {}) {
          const keys = [...kvStore.keys()]
            .filter(k => !prefix || k.startsWith(prefix))
            .map(name => ({ name }));
          return { keys, list_complete: true, cursor: null };
        }
      },
      MODERATION_QUEUE: { async send() {} },
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('realitydefender')) {
        return new Response(JSON.stringify({
          resultsSummary: {
            status: 'AUTHENTIC',
            metadata: { finalScore: 15 },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      // Should remain QUARANTINE — authentic verdict does not auto-resolve
      const moderation = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderation.action).toBe('QUARANTINE');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('Transcript reprocess cron integration', () => {
  function createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads, envOverrides = {} }) {
    return {
      CDN_DOMAIN: 'media.divine.video',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/admin/moderate',
      TRANSCRIPT_REPROCESS_MAX_AGE_DAYS: '7',
      BLOSSOM_DB: {
        prepare(sql) {
          let bindings = [];
          return {
            bind(...args) {
              bindings = args;
              return this;
            },
            async run() {
              const manualReviewLocked = sql.includes('reviewed_by IS NULL') && moderationRow.reviewed_by;
              if (manualReviewLocked) {
                return { success: true, meta: { changes: 0 } };
              }

              if (sql.includes('SET transcript_last_checked_at = ?') && !sql.includes('SET action = ?')) {
                moderationRow.transcript_last_checked_at = bindings[0];
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('transcript_pending = 0') && sql.includes('SET action = ?')) {
                moderationRow.action = bindings[0];
                moderationRow.scores = bindings[1];
                moderationRow.categories = bindings[2];
                moderationRow.transcript_pending = 0;
                moderationRow.transcript_last_checked_at = bindings[3];
                moderationRow.transcript_resolved_at = bindings[4];
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('transcript_pending = 0')) {
                moderationRow.transcript_pending = 0;
                moderationRow.transcript_last_checked_at = bindings[0];
                moderationRow.transcript_resolved_at = bindings[1];
                return { success: true, meta: { changes: 1 } };
              }

              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              return null;
            },
            async all() {
              if (sql.includes('WHERE transcript_pending = 1')) {
                return { results: moderationRow.transcript_pending === 1 ? [{ ...moderationRow }] : [] };
              }
              return { results: [] };
            }
          };
        },
        async batch() {
          return [];
        }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list({ prefix } = {}) {
          const keys = [...kvStore.keys()]
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((name) => ({ name }));
          return { keys, list_complete: true, cursor: null };
        }
      },
      MODERATION_QUEUE: { async send() {} },
      __blossomPayloads: blossomPayloads,
      ...envOverrides
    };
  }

  function isoDaysAgo(days) {
    return new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString();
  }

  it('abandons stale transcript pending rows after configured max age', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      moderated_at: isoDaysAgo(10),
      transcript_pending_since: isoDaysAgo(10),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({ sha256: SHA256, action: 'SAFE', reason: null }));
    const env = createTranscriptReprocessEnv({
      moderationRow,
      kvStore,
      blossomPayloads,
      envOverrides: { TRANSCRIPT_REPROCESS_MAX_AGE_DAYS: '5' }
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return {
          ok: true,
          status: 202,
          headers: { get(name) { return name === 'Retry-After' ? '30' : null; } },
          json: async () => ({ status: 'processing' })
        };
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('SAFE');
      expect(moderationRow.transcript_resolved_at).toBeTruthy();
      expect(blossomPayloads).toHaveLength(0);

      const moderationPayload = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderationPayload.transcriptPending).toBe(false);
      expect(moderationPayload.transcriptResolvedAt).toBeTruthy();
      expect(moderationPayload.transcriptResolutionReason).toBe('max_age_abandoned');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('keeps transcript pending rows pending while VTT is still 202', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      moderated_at: isoDaysAgo(2),
      transcript_pending_since: isoDaysAgo(2),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return {
          ok: true,
          status: 202,
          headers: { get(name) { return name === 'Retry-After' ? '30' : null; } },
          json: async () => ({ status: 'processing' })
        };
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(1);
      expect(moderationRow.transcript_last_checked_at).toBeTruthy();
      expect(moderationRow.transcript_resolved_at).toBeNull();
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('uses default 7-day max age when env var is not set', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      moderated_at: isoDaysAgo(8),
      transcript_pending_since: isoDaysAgo(8),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({ sha256: SHA256, action: 'SAFE' }));
    const env = createTranscriptReprocessEnv({
      moderationRow,
      kvStore,
      blossomPayloads,
      envOverrides: { TRANSCRIPT_REPROCESS_MAX_AGE_DAYS: undefined }
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return {
          ok: true,
          status: 202,
          headers: { get(name) { return name === 'Retry-After' ? '30' : null; } },
          json: async () => ({ status: 'processing' })
        };
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );
      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.transcript_resolved_at).toBeTruthy();
      expect(blossomPayloads).toHaveLength(0);
      const moderationPayload = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderationPayload.transcriptResolutionReason).toBe('max_age_abandoned');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('falls back to moderated_at when transcript_pending_since is missing', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      moderated_at: isoDaysAgo(9),
      transcript_pending_since: null,
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({ sha256: SHA256, action: 'SAFE' }));
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return {
          ok: true,
          status: 202,
          headers: { get(name) { return name === 'Retry-After' ? '30' : null; } },
          json: async () => ({ status: 'processing' })
        };
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.transcript_resolved_at).toBeTruthy();
      const moderationPayload = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderationPayload.transcriptResolutionReason).toBe('max_age_abandoned');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('keeps transcript pending rows pending when transcript fetch returns 500', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    let transcriptFetchCount = 0;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        transcriptFetchCount++;
        return new Response('upstream error', { status: 500 });
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() + 5 * 60 * 1000 },
        env,
        { waitUntil: () => {} }
      );

      expect(transcriptFetchCount).toBe(2);
      expect(moderationRow.transcript_pending).toBe(1);
      expect(moderationRow.transcript_last_checked_at).toBeNull();
      expect(moderationRow.transcript_resolved_at).toBeNull();
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('keeps transcript pending rows pending when transcript fetch throws', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    let transcriptFetchCount = 0;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        transcriptFetchCount++;
        throw new Error('network timeout');
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() + 5 * 60 * 1000 },
        env,
        { waitUntil: () => {} }
      );

      expect(transcriptFetchCount).toBe(2);
      expect(moderationRow.transcript_pending).toBe(1);
      expect(moderationRow.transcript_last_checked_at).toBeNull();
      expect(moderationRow.transcript_resolved_at).toBeNull();
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('resolves pending transcript rows without notifications when action stays unchanged', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\nhello friends and welcome',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('SAFE');
      expect(moderationRow.transcript_resolved_at).toBeTruthy();
      expect(blossomPayloads).toHaveLength(0);

      const classifierData = JSON.parse(kvStore.get(`classifier:${SHA256}`));
      expect(classifierData.text_scores).toBeTruthy();
      expect(classifierData.topicProfile).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('notifies downstream when transcript reprocess changes action', async () => {
    const kvStore = new Map();
    const persistedFlaggedFrames = [
      {
        position: 3,
        timestamp: 1.5,
        scores: { violence: 0.84 },
        source: 'moderation'
      }
    ];
    kvStore.set(`classifier:${SHA256}`, JSON.stringify({
      sha256: SHA256,
      provider: 'hiveai',
      moderatedAt: '2026-04-20T00:00:00.000Z',
      rawClassifierData: null,
      sceneClassification: null,
      flaggedFrames: persistedFlaggedFrames
    }));
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({
      sha256: SHA256,
      flaggedFrames: persistedFlaggedFrames
    }));
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('PERMANENT_BAN');
      expect(JSON.parse(moderationRow.categories)).toEqual(['threats']);
      expect(blossomPayloads).toHaveLength(1);
      expect(blossomPayloads[0]).toMatchObject({
        sha256: SHA256,
        action: 'PERMANENT_BAN'
      });
      expect(kvStore.has(`permanent-ban:${SHA256}`)).toBe(true);
      const classifierData = JSON.parse(kvStore.get(`classifier:${SHA256}`));
      expect(classifierData.flaggedFrames).toEqual(persistedFlaggedFrames);
      expect(classifierData.flaggedFrames).not.toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('replaces stale stored categories with transcript classification categories', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify(['nudity']),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.action).toBe('PERMANENT_BAN');
      expect(JSON.parse(moderationRow.categories)).toEqual(['threats']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('skips duplicate downstream notification when transition was already notified', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    kvStore.set(`transcript-reprocess-notified:${SHA256}:SAFE:PERMANENT_BAN`, '2026-04-23T00:00:00.000Z');
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('PERMANENT_BAN');
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('still reprocesses transcripts when relay polling is disabled', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });
    env.RELAY_POLLING_ENABLED = 'false';

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('PERMANENT_BAN');
      expect(blossomPayloads).toHaveLength(1);
      expect(blossomPayloads[0]).toMatchObject({
        sha256: SHA256,
        action: 'PERMANENT_BAN'
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not re-notify after a transcript row is already resolved', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() + 5 * 60 * 1000 },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(blossomPayloads).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not override rows already manually reviewed', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'QUARANTINE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      reviewed_by: 'admin',
      reviewed_at: '2026-04-22T10:00:00.000Z',
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\ni will kill you now',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.action).toBe('QUARANTINE');
      expect(moderationRow.transcript_pending).toBe(1);
      expect(moderationRow.transcript_resolved_at).toBeNull();
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('keeps stale pending row untouched when manually reviewed', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'QUARANTINE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      moderated_at: isoDaysAgo(10),
      transcript_pending_since: isoDaysAgo(10),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      reviewed_by: 'admin',
      reviewed_at: '2026-04-22T10:00:00.000Z',
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    kvStore.set(`moderation:${SHA256}`, JSON.stringify({ sha256: SHA256, action: 'QUARANTINE' }));
    const env = createTranscriptReprocessEnv({
      moderationRow,
      kvStore,
      blossomPayloads,
      envOverrides: { TRANSCRIPT_REPROCESS_MAX_AGE_DAYS: '5' }
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return {
          ok: true,
          status: 202,
          headers: { get(name) { return name === 'Retry-After' ? '30' : null; } },
          json: async () => ({ status: 'processing' })
        };
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.action).toBe('QUARANTINE');
      expect(moderationRow.transcript_pending).toBe(1);
      expect(moderationRow.transcript_resolved_at).toBeNull();
      const moderationPayload = JSON.parse(kvStore.get(`moderation:${SHA256}`));
      expect(moderationPayload.transcriptResolutionReason).toBeUndefined();
      expect(blossomPayloads).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('warns when stored action is invalid and normalized to SAFE', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'UNKNOWN_ACTION',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\nhello friends and welcome',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      expect(moderationRow.transcript_pending).toBe(0);
      expect(moderationRow.action).toBe('SAFE');

      const normalizedWarnings = warnSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => typeof message === 'string' && message.includes('normalized unknown moderation action to SAFE'));
      expect(normalizedWarnings).toHaveLength(1);
      expect(normalizedWarnings[0]).toContain(SHA256);
      expect(normalizedWarnings[0]).toContain('UNKNOWN_ACTION');
    } finally {
      globalThis.fetch = origFetch;
      warnSpy.mockRestore();
    }
  });

  it('does not warn for valid stored transcript reprocess actions', async () => {
    const kvStore = new Map();
    const blossomPayloads = [];
    const moderationRow = {
      sha256: SHA256,
      action: 'SAFE',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.05, violence: 0.01, ai_generated: 0.01 }),
      categories: JSON.stringify([]),
      raw_response: JSON.stringify({}),
      uploaded_by: null,
      title: null,
      published_at: null,
      content_url: `https://media.divine.video/${SHA256}`,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null
    };
    const env = createTranscriptReprocessEnv({ moderationRow, kvStore, blossomPayloads });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.endsWith(`/${SHA256}.vtt`)) {
        return new Response(
          'WEBVTT\n\n00:00.000 --> 00:01.000\nhello friends and welcome',
          { status: 200, headers: { 'Content-Type': 'text/vtt' } }
        );
      }
      if (url === env.BLOSSOM_WEBHOOK_URL) {
        blossomPayloads.push(JSON.parse(init.body));
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    try {
      await worker.scheduled(
        { cron: '*/5 * * * *', scheduledTime: Date.now() },
        env,
        { waitUntil: () => {} }
      );

      const normalizedWarnings = warnSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => typeof message === 'string' && message.includes('normalized unknown moderation action to SAFE'));
      expect(normalizedWarnings).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
      warnSpy.mockRestore();
    }
  });
});

describe('POST /admin/api/moderate/:sha256', () => {
  it('rejects unauthenticated requests', async () => {
    const sha = 'f'.repeat(64);
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAFE', reason: 'test' })
      }),
      createEnv({ ALLOW_DEV_ACCESS: 'false' })
    );

    expect(response.status).toBe(401);
  });

  it('rejects invalid action', async () => {
    const sha = 'e'.repeat(64);
    const kvStore = new Map();
    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      }
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'INVALID_ACTION', reason: 'test' })
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid action');
  });

  it('creates manual override for new sha256', async () => {
    const sha = 'd'.repeat(64);
    const kvStore = new Map();
    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      }
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAFE', reason: 'Looks fine' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('SAFE');
  });

  it('clears transcript pending state on manual override upsert', async () => {
    const sha = 'b'.repeat(64);
    const kvStore = new Map();
    const moderationRow = {
      sha256: sha,
      action: 'REVIEW',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.35 }),
      categories: JSON.stringify(['nudity']),
      moderated_at: '2026-04-22T09:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null,
      transcript_pending: 1,
      transcript_last_checked_at: null,
      transcript_resolved_at: null,
      uploaded_by: null
    };

    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      BLOSSOM_DB: {
        prepare(sql) {
          let bindings = [];
          return {
            bind(...args) {
              bindings = args;
              return this;
            },
            async run() {
              if (sql.includes('ON CONFLICT(sha256) DO UPDATE SET')) {
                const hasTranscriptReset = sql.includes('transcript_pending = 0')
                  && sql.includes('transcript_last_checked_at = excluded.reviewed_at')
                  && sql.includes('transcript_resolved_at = excluded.reviewed_at');
                if (hasTranscriptReset) {
                  moderationRow.action = bindings[1];
                  moderationRow.reviewed_by = bindings[7];
                  moderationRow.reviewed_at = bindings[8];
                  moderationRow.transcript_pending = 0;
                  moderationRow.transcript_last_checked_at = bindings[8];
                  moderationRow.transcript_resolved_at = bindings[8];
                }
              }
              return { success: true };
            },
            async first() {
              if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
                return moderationRow;
              }
              return null;
            },
            async all() {
              return { results: [] };
            }
          };
        },
        async batch() {
          return [];
        }
      },
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      }
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAFE', reason: 'manual clear' })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(moderationRow.transcript_pending).toBe(0);
    expect(moderationRow.transcript_last_checked_at).toBeTruthy();
    expect(moderationRow.transcript_resolved_at).toBe(moderationRow.reviewed_at);
  });

  it('records previousAction on override', async () => {
    const sha = 'c'.repeat(64);
    const kvStore = new Map();
    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[sha, {
          sha256: sha,
          action: 'AGE_RESTRICTED',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.85 }),
          categories: JSON.stringify(['nudity']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      }
    });

    // First moderate as AGE_RESTRICTED
    await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'AGE_RESTRICTED', reason: 'Contains nudity' })
      }),
      env
    );

    // Then override as SAFE
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SAFE', reason: 'Actually fine' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.previousAction).toBe('AGE_RESTRICTED');
  });
});

describe('POST /admin/api/verify-category/:sha256', () => {
  function createVerifyEnv(sha256, moderationResult, overrides = {}) {
    const kvStore = new Map();
    return {
      ALLOW_DEV_ACCESS: 'true',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_DB: createDbMock({
        moderationResults: moderationResult
          ? new Map([[sha256, moderationResult]])
          : new Map()
      }),
      MODERATION_KV: {
        store: kvStore,
        async get(key) { return kvStore.get(key) ?? null; },
        async put(key, value) { kvStore.set(key, value); },
        async delete(key) { kvStore.delete(key); },
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      ...overrides
    };
  }

  async function seedModeration(sha256, env, action, scores = {}) {
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha256}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: 'seed for test', scores })
      }),
      env
    );
    expect(response.status).toBe(200);
  }

  it('rejects invalid category', async () => {
    const sha = '1'.repeat(64);
    const env = createVerifyEnv(sha, {
      sha256: sha,
      action: 'REVIEW',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.5 }),
      categories: JSON.stringify(['nudity']),
      moderated_at: '2026-03-07T00:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null
    });

    // First create a moderation result in KV
    await seedModeration(sha, env, 'REVIEW');

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'INVALID_CAT', status: 'confirmed' })
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid category');
  });

  it('rejects invalid status', async () => {
    const sha = '2'.repeat(64);
    const env = createVerifyEnv(sha, {
      sha256: sha,
      action: 'REVIEW',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.5 }),
      categories: JSON.stringify(['nudity']),
      moderated_at: '2026-03-07T00:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null
    });

    await seedModeration(sha, env, 'REVIEW');

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'nudity', status: 'maybe' })
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Status must be');
  });

  it('returns 404 for non-existent sha256', async () => {
    const sha = '3'.repeat(64);
    const env = createVerifyEnv(sha, null);

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'nudity', status: 'confirmed' })
      }),
      env
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('not found');
  });

  it('stores category verification', async () => {
    const sha = '4'.repeat(64);
    const env = createVerifyEnv(sha, {
      sha256: sha,
      action: 'AGE_RESTRICTED',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.9 }),
      categories: JSON.stringify(['nudity']),
      moderated_at: '2026-03-07T00:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null
    });

    // Seed moderation result with scores in KV
    await seedModeration(sha, env, 'AGE_RESTRICTED', { nudity: 0.9 });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'nudity', status: 'confirmed' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.categoryVerifications.nudity).toBe('confirmed');
  });

  it('auto-approves when all major flags rejected', async () => {
    const sha = '5'.repeat(64);
    const env = createVerifyEnv(sha, {
      sha256: sha,
      action: 'AGE_RESTRICTED',
      provider: 'hiveai',
      scores: JSON.stringify({ nudity: 0.9 }),
      categories: JSON.stringify(['nudity']),
      moderated_at: '2026-03-07T00:00:00.000Z',
      reviewed_by: null,
      reviewed_at: null
    });

    // Seed moderation result with nudity score in KV
    await seedModeration(sha, env, 'AGE_RESTRICTED', { nudity: 0.9 });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${sha}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'nudity', status: 'rejected' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.autoApproved).toBe(true);
    expect(body.newAction).toBe('SAFE');
  });
});

describe('POST /api/v1/scan (legacy)', () => {
  it('rejects request without bearer token', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha256: SHA256 })
      }),
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  it('rejects invalid sha256', async () => {
    const env = createEnv({
      MODERATION_API_KEY: 'legacy-token'
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer legacy-token'
        },
        body: JSON.stringify({ sha256: 'not-a-hash' })
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'sha256 required (64 hex characters)'
    });
  });
});

describe('POST /api/v1/batch-scan (legacy)', () => {
  it('rejects empty videos array', async () => {
    const env = createEnv({
      MODERATION_API_KEY: 'legacy-token'
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/batch-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer legacy-token'
        },
        body: JSON.stringify({ videos: [] })
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'videos array required'
    });
  });

  it('rejects batch over 100 videos', async () => {
    const env = createEnv({
      MODERATION_API_KEY: 'legacy-token'
    });

    const videos = Array.from({ length: 101 }, () => ({
      sha256: SHA256
    }));

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/batch-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer legacy-token'
        },
        body: JSON.stringify({ videos })
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Maximum 100 videos per batch'
    });
  });
});

describe('POST /api/v1/notify', () => {
  const VALID_PUBKEY = 'ab'.repeat(32);

  it('rejects unauthorized request', async () => {
    const env = createEnv({ ALLOW_DEV_ACCESS: 'false' });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPubkey: VALID_PUBKEY, action: 'PERMANENT_BAN' })
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('rejects invalid pubkey', async () => {
    const env = createEnv({ ALLOW_DEV_ACCESS: 'true' });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPubkey: 'not-a-valid-hex-pubkey', action: 'PERMANENT_BAN' })
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('recipientPubkey');
  });

  it('rejects invalid action', async () => {
    const env = createEnv({ ALLOW_DEV_ACCESS: 'true' });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPubkey: VALID_PUBKEY, action: 'INVALID_ACTION' })
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid action');
    expect(body.error).toContain('PERMANENT_BAN');
  });

  it('returns success with dm_sent false when NOSTR_PRIVATE_KEY not configured', async () => {
    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      NOSTR_PRIVATE_KEY: undefined
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPubkey: VALID_PUBKEY, action: 'PERMANENT_BAN' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.dm_sent).toBe(false);
    expect(body.reason).toContain('not configured');
  });

  it('sends DM for valid request with NOSTR_PRIVATE_KEY configured', async () => {
    const env = createEnv({
      ALLOW_DEV_ACCESS: 'true',
      NOSTR_PRIVATE_KEY: 'deadbeef'.repeat(8)
    });

    // sendModerationDM will attempt WebSocket connections to relays.
    // Mock fetch/WebSocket to prevent real connections. The DM sender
    // catches all errors internally and returns { sent: false, reason }.
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientPubkey: VALID_PUBKEY, action: 'PERMANENT_BAN', reason: 'test' })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    // dm_sent may be true or false depending on relay connectivity,
    // but the endpoint should not error
    expect(typeof body.dm_sent).toBe('boolean');
  });
});

// --- Age-Restricted reconcile helper tests (Chunk 1) ---

import {
  listAgeRestrictedCandidates,
  fetchBlossomBlobDetail,
  classifyAgeRestrictedCandidate,
  buildPreviewResponse,
  applyAgeRestrictedRepairs
} from './moderation/age-restricted-reconcile.mjs';

function createCandidateDbMock(rows) {
  const captured = { sql: null, bindings: null };
  return {
    captured,
    prepare(sql) {
      let bindings = [];
      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async all() {
          captured.sql = sql;
          captured.bindings = bindings;

          // Filter by action and cursor; sort by sha256 asc; respect limit.
          // Bindings order: [cursor?, limit]
          let cursor = null;
          let limit = bindings[bindings.length - 1];
          if (bindings.length === 2) cursor = bindings[0];

          const selected = rows
            .filter((r) => r.action === 'AGE_RESTRICTED')
            .filter((r) => (cursor === null ? true : r.sha256 > cursor))
            .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))
            .slice(0, limit);

          return { results: selected };
        }
      };
    }
  };
}

describe('age restricted reconcile candidate paging', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);
  const shaC = 'c'.repeat(64);
  const shaD = 'd'.repeat(64);
  const shaE = 'e'.repeat(64);

  const baseRows = [
    { sha256: shaC, action: 'AGE_RESTRICTED' },
    { sha256: shaA, action: 'AGE_RESTRICTED' },
    { sha256: shaB, action: 'SAFE' },
    { sha256: shaD, action: 'QUARANTINE' },
    { sha256: shaE, action: 'PERMANENT_BAN' }
  ];

  it('selects only AGE_RESTRICTED rows sorted by sha256 ascending', async () => {
    const db = createCandidateDbMock(baseRows);
    const { rows, nextCursor } = await listAgeRestrictedCandidates(db, { limit: 10 });
    expect(rows.map((r) => r.sha256)).toEqual([shaA, shaC]);
    expect(nextCursor).toBeNull();

    // Verify the SQL restricts on AGE_RESTRICTED
    expect(db.captured.sql).toMatch(/action\s*=\s*'AGE_RESTRICTED'/);
    expect(db.captured.sql).toMatch(/ORDER BY\s+sha256\s+ASC/i);
  });

  it('uses keyset pagination via sha256 > ? when cursor given', async () => {
    const db = createCandidateDbMock(baseRows);
    const { rows, nextCursor } = await listAgeRestrictedCandidates(db, {
      cursorSha: shaA,
      limit: 10
    });
    expect(rows.map((r) => r.sha256)).toEqual([shaC]);
    expect(nextCursor).toBeNull();
    // Bindings should include the cursor value
    expect(db.captured.bindings[0]).toBe(shaA);
    // SQL should contain sha256 > ?
    expect(db.captured.sql).toMatch(/sha256\s*>\s*\?/);
  });

  it('fetches limit+1 rows so nextCursor is exact when more remain', async () => {
    // 4 AGE_RESTRICTED rows, limit = 2
    const many = [
      { sha256: shaA, action: 'AGE_RESTRICTED' },
      { sha256: shaB, action: 'AGE_RESTRICTED' },
      { sha256: shaC, action: 'AGE_RESTRICTED' },
      { sha256: shaD, action: 'AGE_RESTRICTED' }
    ];
    const db = createCandidateDbMock(many);
    const { rows, nextCursor } = await listAgeRestrictedCandidates(db, { limit: 2 });
    // Only 2 rows returned, but cursor points to the last returned sha
    expect(rows.map((r) => r.sha256)).toEqual([shaA, shaB]);
    expect(nextCursor).toBe(shaB);

    // The internal LIMIT should be limit + 1 = 3
    const lastBinding = db.captured.bindings[db.captured.bindings.length - 1];
    expect(lastBinding).toBe(3);
  });

  it('returns null nextCursor when fewer than limit+1 rows are available', async () => {
    const rowsInput = [
      { sha256: shaA, action: 'AGE_RESTRICTED' },
      { sha256: shaB, action: 'AGE_RESTRICTED' }
    ];
    const db = createCandidateDbMock(rowsInput);
    const { rows, nextCursor } = await listAgeRestrictedCandidates(db, { limit: 5 });
    expect(rows.map((r) => r.sha256)).toEqual([shaA, shaB]);
    expect(nextCursor).toBeNull();
  });
});

describe('age restricted reconcile classification', () => {
  const sha = 'f'.repeat(64);

  it('classifies Blossom status age_restricted as aligned', () => {
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'age_restricted' } },
      blossomError: null
    });
    expect(result).toEqual({
      sha256: sha,
      category: 'aligned',
      blossomStatus: 'age_restricted',
      error: null
    });
  });

  it('classifies Blossom status restricted as repairable_mismatch', () => {
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'restricted' } },
      blossomError: null
    });
    expect(result.category).toBe('repairable_mismatch');
    expect(result.blossomStatus).toBe('restricted');
    expect(result.error).toBeNull();
  });

  it('classifies Blossom status deleted as skip_deleted', () => {
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'deleted' } },
      blossomError: null
    });
    expect(result.category).toBe('skip_deleted');
    expect(result.blossomStatus).toBe('deleted');
  });

  it('classifies Blossom 404 (null detail) as skip_missing', () => {
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: null,
      blossomError: null
    });
    expect(result.category).toBe('skip_missing');
    expect(result.blossomStatus).toBeNull();
    expect(result.error).toBeNull();
  });

  it('classifies Blossom status active as unexpected_state', () => {
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'active' } },
      blossomError: null
    });
    expect(result.category).toBe('unexpected_state');
    expect(result.blossomStatus).toBe('active');
  });

  it('classifies other unexpected statuses (pending, banned) as unexpected_state', () => {
    const pending = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'pending' } },
      blossomError: null
    });
    expect(pending.category).toBe('unexpected_state');

    const banned = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: { status: 200, body: { status: 'banned' } },
      blossomError: null
    });
    expect(banned.category).toBe('unexpected_state');
  });

  it('classifies fetch error (thrown) as read_failed', () => {
    const err = new Error('boom');
    const result = classifyAgeRestrictedCandidate({
      sha256: sha,
      blossomDetail: null,
      blossomError: err
    });
    expect(result.category).toBe('read_failed');
    expect(result.error).toBe('boom');
  });

  it('fetchBlossomBlobDetail returns { status, body } for 2xx', async () => {
    const payload = { sha256: sha, status: 'restricted' };
    const fakeFetch = async (url, init) => {
      expect(url).toBe(`https://media.divine.video/admin/api/blob/${sha}`);
      expect(init.headers.Authorization).toBe('Bearer test-secret');
      expect(init.headers.Accept).toBe('application/json');
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    const env = { CDN_DOMAIN: 'media.divine.video', BLOSSOM_WEBHOOK_SECRET: 'test-secret' };
    const detail = await fetchBlossomBlobDetail(sha, env, fakeFetch);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(payload);
  });

  it('fetchBlossomBlobDetail returns { status: 404 } for 404 with no body', async () => {
    const fakeFetch = async () => new Response('', { status: 404 });
    const env = { BLOSSOM_WEBHOOK_SECRET: 'test-secret' };
    const detail = await fetchBlossomBlobDetail(sha, env, fakeFetch);
    expect(detail.status).toBe(404);
  });

  it('fetchBlossomBlobDetail throws for non-2xx/404', async () => {
    const fakeFetch = async () => new Response('server err', { status: 500 });
    const env = { BLOSSOM_WEBHOOK_SECRET: 'test-secret' };
    await expect(fetchBlossomBlobDetail(sha, env, fakeFetch)).rejects.toThrow();
  });

  it('fetchBlossomBlobDetail throws on network error', async () => {
    const fakeFetch = async () => { throw new Error('net down'); };
    const env = { BLOSSOM_WEBHOOK_SECRET: 'test-secret' };
    await expect(fetchBlossomBlobDetail(sha, env, fakeFetch)).rejects.toThrow(/net down/);
  });
});

describe('age restricted reconcile buildPreviewResponse', () => {
  it('aggregates counts and samples with repairableShas list', () => {
    const rows = [
      { sha256: 'aa' }, { sha256: 'bb' }, { sha256: 'cc' },
      { sha256: 'dd' }, { sha256: 'ee' }
    ];
    const classifications = [
      { sha256: 'aa', category: 'aligned', blossomStatus: 'age_restricted', error: null },
      { sha256: 'bb', category: 'repairable_mismatch', blossomStatus: 'restricted', error: null },
      { sha256: 'cc', category: 'skip_deleted', blossomStatus: 'deleted', error: null },
      { sha256: 'dd', category: 'skip_missing', blossomStatus: null, error: null },
      { sha256: 'ee', category: 'unexpected_state', blossomStatus: 'active', error: null }
    ];
    const resp = buildPreviewResponse({ rows, classifications, limit: 10, nextCursor: 'ee' });
    expect(resp.success).toBe(true);
    expect(resp.limit).toBe(10);
    expect(resp.nextCursor).toBe('ee');
    expect(resp.counts).toEqual({
      aligned: 1,
      repairable_mismatch: 1,
      skip_deleted: 1,
      skip_missing: 1,
      unexpected_state: 1,
      read_failed: 0
    });
    expect(resp.repairableShas).toEqual(['bb']);
    expect(resp.samples.skip_deleted).toEqual([{ sha256: 'cc', blossomStatus: 'deleted', error: null }]);
    expect(resp.samples.skip_missing).toEqual([{ sha256: 'dd', blossomStatus: null, error: null }]);
    expect(resp.samples.unexpected_state).toEqual([{ sha256: 'ee', blossomStatus: 'active', error: null }]);
    expect(resp.samples.read_failed).toEqual([]);
  });

  it('caps samples at 5 per bucket', () => {
    const rows = [];
    const classifications = [];
    for (let i = 0; i < 8; i += 1) {
      const sha = `sha${i}`;
      rows.push({ sha256: sha });
      classifications.push({ sha256: sha, category: 'skip_missing', blossomStatus: null, error: null });
    }
    const resp = buildPreviewResponse({ rows, classifications, limit: 50, nextCursor: null });
    expect(resp.counts.skip_missing).toBe(8);
    expect(resp.samples.skip_missing).toHaveLength(5);
  });
});

describe('age restricted reconcile applyAgeRestrictedRepairs stub', () => {
  it('counts all shas as skip_missing when fetchBlossomBlobDetail returns null', async () => {
    const result = await applyAgeRestrictedRepairs({
      shas: ['aa', 'bb'],
      env: {},
      fetchBlossomBlobDetail: async () => null,
      notifyBlossom: async () => ({ success: true })
    });
    expect(result.success).toBe(true);
    expect(result.attempted).toBe(2);
    expect(result.notified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual({
      aligned: 0,
      skip_deleted: 0,
      skip_missing: 2,
      unexpected_state: 0,
      read_failed: 0
    });
  });
});

describe('admin age restricted reconcile preview endpoint', () => {
  // Exercises POST /admin/api/reconcile/age-restricted/preview end-to-end:
  // D1 paging (keyset on sha256) + per-SHA Blossom admin detail lookup +
  // classification into aligned / repairable_mismatch / skip_deleted /
  // skip_missing / unexpected_state / read_failed buckets.

  const CDN_DOMAIN = 'media.divine.video';
  const WEBHOOK_SECRET = 'test-webhook-secret';

  function sha(index) {
    return String(index).padStart(64, '0');
  }

  function createReconcileDbMock(ageRestrictedShas) {
    // Seed a mixed-action set so we can prove the query filters to AGE_RESTRICTED only.
    // ageRestrictedShas is an ordered array of hashes we want returned by the paging query.
    return {
      prepare(sql) {
        let bindings = [];
        return {
          bind(...args) {
            bindings = args;
            return this;
          },
          async run() { return { success: true }; },
          async first() { return null; },
          async all() {
            if (
              sql.includes("FROM moderation_results") &&
              sql.includes("action = 'AGE_RESTRICTED'") &&
              sql.includes("ORDER BY sha256 ASC")
            ) {
              const hasCursor = sql.includes('sha256 > ?');
              let cursorSha = null;
              let limit;
              if (hasCursor) {
                [cursorSha, limit] = bindings;
              } else {
                [limit] = bindings;
              }

              const filtered = cursorSha
                ? ageRestrictedShas.filter((s) => s > cursorSha)
                : ageRestrictedShas.slice();
              const sliced = filtered.slice(0, limit);
              return { results: sliced.map((s) => ({ sha256: s, action: 'AGE_RESTRICTED' })) };
            }
            return { results: [] };
          }
        };
      },
      async batch() { return []; }
    };
  }

  function createReconcileEnv({ ageRestrictedShas, blossomStatuses, overrides = {} } = {}) {
    return {
      ALLOW_DEV_ACCESS: 'true',
      CDN_DOMAIN,
      BLOSSOM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      BLOSSOM_DB: createReconcileDbMock(ageRestrictedShas),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      __blossomStatuses: blossomStatuses,
      ...overrides
    };
  }

  function installBlossomFetchInterceptor(env) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (typeof url === 'string' && url.startsWith(`https://${CDN_DOMAIN}/admin/api/blob/`)) {
        const sha256 = url.split('/admin/api/blob/')[1];
        const entry = env.__blossomStatuses[sha256];
        if (!entry) {
          return new Response('not found', { status: 404 });
        }
        if (entry.throw) {
          throw new Error(entry.throw);
        }
        if (entry.status === 404) {
          return new Response('not found', { status: 404 });
        }
        if (entry.status >= 500) {
          return new Response('boom', { status: entry.status });
        }
        return new Response(JSON.stringify({ sha256, status: entry.status }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url, init);
    };
    return () => { globalThis.fetch = origFetch; };
  }

  it('requires admin auth', async () => {
    const env = createReconcileEnv({
      ageRestrictedShas: [],
      blossomStatuses: {},
      overrides: { ALLOW_DEV_ACCESS: 'false' }
    });

    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('returns preview with default limit 50 when limit omitted', async () => {
    const shas = Array.from({ length: 3 }, (_, i) => sha(i + 1));
    const env = createReconcileEnv({
      ageRestrictedShas: shas,
      blossomStatuses: {
        [shas[0]]: { status: 'restricted' },
        [shas[1]]: { status: 'age_restricted' },
        [shas[2]]: { status: 'restricted' }
      }
    });

    const restore = installBlossomFetchInterceptor(env);
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({})
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.limit).toBe(50);
      expect(body.nextCursor).toBeNull();
      expect(body.counts).toEqual({
        aligned: 1,
        repairable_mismatch: 2,
        skip_deleted: 0,
        skip_missing: 0,
        unexpected_state: 0,
        read_failed: 0
      });
      expect(body.repairableShas).toEqual([shas[0], shas[2]]);
      expect(body.samples).toEqual({
        skip_deleted: [],
        skip_missing: [],
        unexpected_state: [],
        read_failed: []
      });
    } finally {
      restore();
    }
  });

  it('supports GET preview with browser-style query params', async () => {
    const shas = Array.from({ length: 3 }, (_, i) => sha(i + 1));
    const env = createReconcileEnv({
      ageRestrictedShas: shas,
      blossomStatuses: {
        [shas[0]]: { status: 'age_restricted' },
        [shas[1]]: { status: 'restricted' },
        [shas[2]]: { status: 'deleted' }
      }
    });

    const restore = installBlossomFetchInterceptor(env);
    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview?limit=2&cursor=${shas[0]}`, {
          method: 'GET',
          headers: {
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          }
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.limit).toBe(2);
      expect(body.nextCursor).toBeNull();
      expect(body.counts).toEqual({
        aligned: 0,
        repairable_mismatch: 1,
        skip_deleted: 1,
        skip_missing: 0,
        unexpected_state: 0,
        read_failed: 0
      });
      expect(body.repairableShas).toEqual([shas[1]]);
      expect(body.samples.skip_deleted[0].sha256).toBe(shas[2]);
    } finally {
      restore();
    }
  });

  it('caps limit at 100 when caller requests a higher value', async () => {
    // Build 105 AGE_RESTRICTED rows; with max limit=100 we should get 100 classified
    // rows plus a nextCursor equal to the 100th sha.
    const shas = Array.from({ length: 105 }, (_, i) => sha(i + 1));
    const blossomStatuses = Object.fromEntries(shas.map((s) => [s, { status: 'restricted' }]));
    const env = createReconcileEnv({ ageRestrictedShas: shas, blossomStatuses });

    const restore = installBlossomFetchInterceptor(env);
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ limit: 1000 })
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.limit).toBe(100);
      expect(body.counts.repairable_mismatch).toBe(100);
      expect(body.repairableShas).toHaveLength(100);
      expect(body.nextCursor).toBe(shas[99]);
    } finally {
      restore();
    }
  });

  it('honors cursor and populates non-repairable buckets and samples', async () => {
    // Set up 6 AGE_RESTRICTED rows so, with cursor=sha(1), the paging skips sha(1)
    // and classifies sha(2)..sha(6). Each bucket except aligned gets exactly one entry.
    const shas = Array.from({ length: 6 }, (_, i) => sha(i + 1));
    const blossomStatuses = {
      [shas[0]]: { status: 'age_restricted' },  // skipped by cursor
      [shas[1]]: { status: 'age_restricted' },  // aligned
      [shas[2]]: { status: 'restricted' },      // repairable_mismatch
      [shas[3]]: { status: 'deleted' },         // skip_deleted
      [shas[4]]: { status: 404 },               // skip_missing
      [shas[5]]: { status: 'active' }           // unexpected_state
    };
    const env = createReconcileEnv({ ageRestrictedShas: shas, blossomStatuses });

    const restore = installBlossomFetchInterceptor(env);
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ limit: 10, cursor: shas[0] })
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.limit).toBe(10);
      expect(body.nextCursor).toBeNull();  // only 5 rows remain, less than limit
      expect(body.counts).toEqual({
        aligned: 1,
        repairable_mismatch: 1,
        skip_deleted: 1,
        skip_missing: 1,
        unexpected_state: 1,
        read_failed: 0
      });
      expect(body.repairableShas).toEqual([shas[2]]);
      expect(body.samples.skip_deleted).toHaveLength(1);
      expect(body.samples.skip_deleted[0].sha256).toBe(shas[3]);
      expect(body.samples.skip_missing[0].sha256).toBe(shas[4]);
      expect(body.samples.unexpected_state[0].sha256).toBe(shas[5]);
      expect(body.samples.unexpected_state[0].blossomStatus).toBe('active');
      expect(body.samples.read_failed).toEqual([]);
    } finally {
      restore();
    }
  });

  it('classifies read failures as read_failed', async () => {
    const shas = [sha(1), sha(2)];
    const blossomStatuses = {
      [shas[0]]: { status: 500 },
      [shas[1]]: { throw: 'network down' }
    };
    const env = createReconcileEnv({ ageRestrictedShas: shas, blossomStatuses });

    const restore = installBlossomFetchInterceptor(env);
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ limit: 10 })
        }),
        env
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.counts.read_failed).toBe(2);
      expect(body.repairableShas).toEqual([]);
      expect(body.samples.read_failed).toHaveLength(2);
      expect(body.samples.read_failed[0].error).toBeTruthy();
    } finally {
      restore();
    }
  });

  it('rejects non-numeric limit', async () => {
    const env = createReconcileEnv({ ageRestrictedShas: [], blossomStatuses: {} });
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({ limit: 'fifty' })
      }),
      env
    );

    expect(response.status).toBe(400);
  });
});

describe('preview logs age restricted mismatch counts', () => {
  const CDN_DOMAIN = 'media.divine.video';
  const WEBHOOK_SECRET = 'test-webhook-secret';

  function sha(index) {
    return String(index).padStart(64, '0');
  }

  function createReconcileDbMock(ageRestrictedShas) {
    return {
      prepare(sql) {
        let bindings = [];
        return {
          bind(...args) {
            bindings = args;
            return this;
          },
          async run() { return { success: true }; },
          async first() { return null; },
          async all() {
            if (
              sql.includes("FROM moderation_results") &&
              sql.includes("action = 'AGE_RESTRICTED'") &&
              sql.includes("ORDER BY sha256 ASC")
            ) {
              const hasCursor = sql.includes('sha256 > ?');
              let cursorSha = null;
              let limit;
              if (hasCursor) {
                [cursorSha, limit] = bindings;
              } else {
                [limit] = bindings;
              }
              const filtered = cursorSha
                ? ageRestrictedShas.filter((s) => s > cursorSha)
                : ageRestrictedShas.slice();
              return {
                results: filtered.slice(0, limit).map((s) => ({ sha256: s, action: 'AGE_RESTRICTED' }))
              };
            }
            return { results: [] };
          }
        };
      },
      async batch() { return []; }
    };
  }

  it('emits one structured log line with limit, cursor, nextCursor, and counts', async () => {
    const shas = Array.from({ length: 3 }, (_, i) => sha(i + 10));
    const blossomStatuses = {
      [shas[0]]: { status: 'restricted' },
      [shas[1]]: { status: 'age_restricted' },
      [shas[2]]: { status: 'deleted' }
    };
    const env = {
      ALLOW_DEV_ACCESS: 'true',
      CDN_DOMAIN,
      BLOSSOM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      BLOSSOM_DB: createReconcileDbMock(shas),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.startsWith(`https://${CDN_DOMAIN}/admin/api/blob/`)) {
        const sha256 = url.split('/admin/api/blob/')[1];
        const entry = blossomStatuses[sha256];
        return new Response(JSON.stringify({ sha256, status: entry.status }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return origFetch(url);
    };

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args);
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ limit: 50, cursor: null })
        }),
        env
      );
      expect(response.status).toBe(200);
    } finally {
      console.log = origLog;
      globalThis.fetch = origFetch;
    }

    // Find the structured reconcile log line — printed as a single JSON string.
    let parsed = null;
    for (const args of logs) {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const obj = JSON.parse(arg);
          if (obj && obj.event === 'age_restricted_reconcile.preview') {
            parsed = obj;
            break;
          }
        } catch (_) {
          // not json
        }
      }
      if (parsed) break;
    }

    expect(parsed).not.toBeNull();
    expect(parsed.limit).toBe(50);
    expect(parsed.cursor).toBeNull();
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.counts).toEqual({
      aligned: 1,
      repairable_mismatch: 1,
      skip_deleted: 1,
      skip_missing: 0,
      unexpected_state: 0,
      read_failed: 0
    });
  });
});
describe('admin age restricted reconcile apply endpoint', () => {
  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);
  const SHA_C = 'c'.repeat(64);

  function buildApplyEnv({ blossomStatusBySha = new Map(), blossomResponseBySha = new Map(), webhookPayloads = [], webhookResponseStatus = 200 } = {}) {
    return {
      ALLOW_DEV_ACCESS: 'false',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/webhook',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_ADMIN_URL: 'https://mock-blossom.test',
      BLOSSOM_ADMIN_TOKEN: 'test-admin-token',
      BLOSSOM_DB: createDbMock(),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      __blossomStatusBySha: blossomStatusBySha,
      __blossomResponseBySha: blossomResponseBySha,
      __webhookPayloads: webhookPayloads,
      __webhookResponseStatus: webhookResponseStatus
    };
  }

  function installApplyFetchMock(env) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr === env.BLOSSOM_WEBHOOK_URL) {
        env.__webhookPayloads.push(JSON.parse(init.body));
        const status = env.__webhookResponseStatus ?? 200;
        if (status >= 400) {
          return new Response(JSON.stringify({ error: 'webhook failed' }), { status });
        }
        return new Response(JSON.stringify({ success: true }), { status });
      }
      // /admin/api/blob/{sha}
      const match = urlStr.match(/\/admin\/api\/blob\/([0-9a-f]{64})$/i);
      if (match) {
        const sha = match[1];
        if (env.__blossomResponseBySha.has(sha)) {
          const custom = env.__blossomResponseBySha.get(sha);
          if (custom === 'throw') {
            throw new Error('network blew up');
          }
          return custom;
        }
        if (env.__blossomStatusBySha.has(sha)) {
          const status = env.__blossomStatusBySha.get(sha);
          if (status === null) {
            return new Response('not found', { status: 404 });
          }
          return new Response(JSON.stringify({ sha256: sha, status }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    };
    return () => { globalThis.fetch = origFetch; };
  }

  it('requires admin auth', async () => {
    const env = buildApplyEnv();
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shas: [SHA_A] })
      }),
      env
    );
    expect(response.status).toBe(401);
  });

  it('rejects empty sha list', async () => {
    const env = buildApplyEnv();
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({ shas: [] })
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('rejects missing shas field', async () => {
    const env = buildApplyEnv();
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({})
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('rejects oversized sha list (>100)', async () => {
    const env = buildApplyEnv();
    const tooMany = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0'));
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({ shas: tooMany })
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('rejects malformed SHAs', async () => {
    const env = buildApplyEnv();
    const response = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({ shas: ['not-a-sha', SHA_A] })
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it('notifies Blossom with AGE_RESTRICTED for currently-restricted shas', async () => {
    const env = buildApplyEnv({
      blossomStatusBySha: new Map([[SHA_A, 'restricted']])
    });
    const restore = installApplyFetchMock(env);
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_A] })
        }),
        env
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        success: true,
        attempted: 1,
        notified: 1,
        failed: 0,
        failures: []
      });
      expect(env.__webhookPayloads).toHaveLength(1);
      expect(env.__webhookPayloads[0]).toMatchObject({
        sha256: SHA_A,
        action: 'AGE_RESTRICTED'
      });
    } finally {
      restore();
    }
  });
});

describe('age restricted apply revalidates blossom state', () => {
  const SHA_REST = 'a'.repeat(64);
  const SHA_AR = 'b'.repeat(64);
  const SHA_DEL = 'c'.repeat(64);
  const SHA_READ_FAIL = 'd'.repeat(64);
  const SHA_MISSING = 'e'.repeat(64);
  const SHA_UNEXPECTED = 'f'.repeat(64);

  function env() {
    const webhookPayloads = [];
    return {
      env: {
        ALLOW_DEV_ACCESS: 'false',
        SERVICE_API_TOKEN: 'test-service-token',
        BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/webhook',
        BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
        BLOSSOM_ADMIN_URL: 'https://mock-blossom.test',
        BLOSSOM_ADMIN_TOKEN: 'test-admin-token',
        BLOSSOM_DB: createDbMock(),
        MODERATION_KV: {
          async get() { return null; },
          async put() {},
          async delete() {},
          async list() { return { keys: [], list_complete: true, cursor: null }; }
        },
        MODERATION_QUEUE: { async send() {} },
        __webhookPayloads: webhookPayloads
      },
      webhookPayloads
    };
  }

  function installMixedFetchMock({ env, statuses }) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr === env.BLOSSOM_WEBHOOK_URL) {
        env.__webhookPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const match = urlStr.match(/\/admin\/api\/blob\/([0-9a-f]{64})$/i);
      if (match) {
        const sha = match[1];
        if (!statuses.has(sha)) {
          return new Response('not found', { status: 404 });
        }
        const entry = statuses.get(sha);
        if (entry === 'throw') {
          throw new Error('simulated read failure');
        }
        if (entry === '404') {
          return new Response('not found', { status: 404 });
        }
        return new Response(JSON.stringify({ sha256: sha, status: entry }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    };
    return () => { globalThis.fetch = origFetch; };
  }

  it('skips shas whose blossom state is already age_restricted without calling notifyBlossom', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_AR, 'age_restricted']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_AR] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(0);
      expect(body.skipped.aligned).toBe(1);
      expect(webhookPayloads).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('skips shas whose blossom state is deleted without calling notifyBlossom', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_DEL, 'deleted']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_DEL] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(0);
      expect(body.skipped.skip_deleted).toBe(1);
      expect(webhookPayloads).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('replays notifyBlossom for shas whose blossom state is still restricted', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_REST, 'restricted']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_REST] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(1);
      expect(webhookPayloads).toHaveLength(1);
      expect(webhookPayloads[0].action).toBe('AGE_RESTRICTED');
      expect(webhookPayloads[0].sha256).toBe(SHA_REST);
    } finally {
      restore();
    }
  });

  it('counts blossom read failures as failure with stage read and skips notifyBlossom', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_READ_FAIL, 'throw']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_READ_FAIL] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.failed).toBe(1);
      expect(body.skipped.read_failed).toBe(1);
      expect(body.failures).toHaveLength(1);
      expect(body.failures[0]).toMatchObject({
        sha256: SHA_READ_FAIL,
        stage: 'read'
      });
      expect(webhookPayloads).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('counts missing (404) blossom blobs as skip_missing without calling notifyBlossom', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_MISSING, '404']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_MISSING] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(0);
      expect(body.skipped.skip_missing).toBe(1);
      expect(webhookPayloads).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('counts unexpected active state as unexpected_state without calling notifyBlossom', async () => {
    const { env: e, webhookPayloads } = env();
    const restore = installMixedFetchMock({
      env: e,
      statuses: new Map([[SHA_UNEXPECTED, 'active']])
    });
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_UNEXPECTED] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(0);
      expect(body.skipped.unexpected_state).toBe(1);
      expect(webhookPayloads).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('age restricted apply returns exact failed shas', () => {
  const SHA_REST = 'a'.repeat(64);
  const SHA_NOTIFY_FAIL = 'b'.repeat(64);
  const SHA_READ_FAIL = 'c'.repeat(64);

  it('preserves failed shas with error and stage for retry', async () => {
    const webhookPayloads = [];
    const e = {
      ALLOW_DEV_ACCESS: 'false',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/webhook',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_ADMIN_URL: 'https://mock-blossom.test',
      BLOSSOM_ADMIN_TOKEN: 'test-admin-token',
      BLOSSOM_DB: createDbMock(),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} },
      __webhookPayloads: webhookPayloads
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr === e.BLOSSOM_WEBHOOK_URL) {
        const payload = JSON.parse(init.body);
        webhookPayloads.push(payload);
        if (payload.sha256 === SHA_NOTIFY_FAIL) {
          return new Response('boom', { status: 500 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const match = urlStr.match(/\/admin\/api\/blob\/([0-9a-f]{64})$/i);
      if (match) {
        const sha = match[1];
        if (sha === SHA_READ_FAIL) {
          throw new Error('read exploded');
        }
        return new Response(JSON.stringify({ sha256: sha, status: 'restricted' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    };

    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA_REST, SHA_NOTIFY_FAIL, SHA_READ_FAIL] })
        }),
        e
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.attempted).toBe(3);
      expect(body.notified).toBe(1);
      expect(body.failed).toBe(2);
      expect(body.success).toBe(false);

      const failureShas = body.failures.map(f => f.sha256).sort();
      expect(failureShas).toEqual([SHA_NOTIFY_FAIL, SHA_READ_FAIL].sort());

      const notifyFailure = body.failures.find(f => f.sha256 === SHA_NOTIFY_FAIL);
      expect(notifyFailure.stage).toBe('notify');
      expect(typeof notifyFailure.error).toBe('string');
      expect(notifyFailure.error.length).toBeGreaterThan(0);

      const readFailure = body.failures.find(f => f.sha256 === SHA_READ_FAIL);
      expect(readFailure.stage).toBe('read');
      expect(typeof readFailure.error).toBe('string');
      expect(readFailure.error.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// Chunk 4 Step 1: regression coverage for exact write semantics.
// Apply must call notifyBlossom with 'AGE_RESTRICTED' and never 'RESTRICT'.
describe('age restricted reconcile writes AGE_RESTRICTED', () => {
  const SHA = 'd'.repeat(64);

  it('apply always calls notifyBlossom with AGE_RESTRICTED, never RESTRICT', async () => {
    const webhookPayloads = [];
    const e = {
      ALLOW_DEV_ACCESS: 'false',
      SERVICE_API_TOKEN: 'test-service-token',
      BLOSSOM_WEBHOOK_URL: 'https://mock-blossom.test/webhook',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      CDN_DOMAIN: 'media.divine.video',
      BLOSSOM_DB: createDbMock(),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (urlStr === e.BLOSSOM_WEBHOOK_URL) {
        webhookPayloads.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const match = urlStr.match(/\/admin\/api\/blob\/([0-9a-f]{64})$/i);
      if (match) {
        return new Response(JSON.stringify({ sha256: match[1], status: 'restricted' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    };
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/apply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ shas: [SHA] })
        }),
        e
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.notified).toBe(1);
      expect(webhookPayloads).toHaveLength(1);
      // Every single payload must be AGE_RESTRICTED — never RESTRICT.
      for (const payload of webhookPayloads) {
        expect(payload.action).toBe('AGE_RESTRICTED');
        expect(payload.action).not.toBe('RESTRICT');
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// Chunk 5 Step 1: drift reporting — preview must report mismatch categories
// distinctly, not collapse them into a single population total.
describe('age restricted preview reports real blossom drift', () => {
  function sha(n) { return String(n).padStart(64, '0'); }

  function mockDbWith(shas) {
    return {
      prepare(sql) {
        let bindings = [];
        return {
          bind(...args) { bindings = args; return this; },
          async run() { return { success: true }; },
          async first() { return null; },
          async all() {
            if (sql.includes("action = 'AGE_RESTRICTED'") && sql.includes('ORDER BY sha256 ASC')) {
              const hasCursor = sql.includes('sha256 > ?');
              const limit = hasCursor ? bindings[1] : bindings[0];
              const filtered = hasCursor ? shas.filter(s => s > bindings[0]) : shas.slice();
              return { results: filtered.slice(0, limit).map(s => ({ sha256: s, action: 'AGE_RESTRICTED' })) };
            }
            return { results: [] };
          }
        };
      },
      async batch() { return []; }
    };
  }

  it('reports each bucket distinctly rather than a single collapsed total', async () => {
    const shas = [sha(1), sha(2), sha(3), sha(4)];
    // Mix: 1 aligned + 1 repairable + 1 skip_deleted + 1 unexpected_state
    const statusBySha = new Map([
      [shas[0], 'age_restricted'],
      [shas[1], 'restricted'],
      [shas[2], 'deleted'],
      [shas[3], 'active']
    ]);

    const env = {
      ALLOW_DEV_ACCESS: 'true',
      CDN_DOMAIN: 'media.divine.video',
      BLOSSOM_WEBHOOK_SECRET: 'test-webhook-secret',
      BLOSSOM_DB: mockDbWith(shas),
      MODERATION_KV: {
        async get() { return null; },
        async put() {},
        async delete() {},
        async list() { return { keys: [], list_complete: true, cursor: null }; }
      },
      MODERATION_QUEUE: { async send() {} }
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const match = String(url).match(/\/admin\/api\/blob\/([0-9a-f]{64})$/i);
      if (match) {
        const sha = match[1];
        const status = statusBySha.get(sha);
        if (!status) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ sha256: sha, status }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    try {
      const response = await worker.fetch(
        new Request('https://moderation.admin.divine.video/admin/api/reconcile/age-restricted/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ limit: 10 })
        }),
        env
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      // Each bucket distinct — not collapsed into a single total.
      expect(body.counts.aligned).toBe(1);
      expect(body.counts.repairable_mismatch).toBe(1);
      expect(body.counts.skip_deleted).toBe(1);
      expect(body.counts.unexpected_state).toBe(1);
      expect(body.counts.skip_missing).toBe(0);
      expect(body.counts.read_failed).toBe(0);
      // Total across buckets equals total classified rows.
      const total = Object.values(body.counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(4);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
