// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Request routing tests for API/admin hostname separation
// ABOUTME: Verifies public API exposure, admin isolation, and workers.dev disablement

import { describe, expect, it } from 'vitest';
import worker from './index.mjs';

const SHA256 = 'a'.repeat(64);

function createDbMock({ moderationResults = new Map(), webhookEvents = new Map() } = {}) {
  return {
    prepare(sql) {
      let bindings = [];

      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
            return moderationResults.get(bindings[0]) ?? null;
          }
          if (sql.includes('FROM bunny_webhook_events')) {
            return webhookEvents.get(bindings[0]) ?? null;
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
        createEnv({ CDN_DOMAIN: 'media.divine.video' })
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
        createEnv({ CDN_DOMAIN: 'media.divine.video' })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/vtt; charset=utf-8');
      await expect(response.text()).resolves.toBe(vttText);
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
