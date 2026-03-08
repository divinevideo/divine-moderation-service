// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Request routing tests for API/admin hostname separation
// ABOUTME: Verifies public API exposure, admin isolation, and workers.dev disablement

import { describe, expect, it } from 'vitest';
import worker from './index.mjs';

const SHA256 = 'a'.repeat(64);

function createDbMock({ moderationResults = new Map() } = {}) {
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
