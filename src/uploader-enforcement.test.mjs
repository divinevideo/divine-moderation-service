// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Verifies uploader enforcement state and admin endpoints for relay/user actions

import { describe, expect, it } from 'vitest';
import worker from './index.mjs';
import { applyUploaderEnforcementToResult, getUploaderEnforcement, setUploaderEnforcement } from './uploader-enforcement.mjs';

const SHA256 = 'a'.repeat(64);
const PUBKEY = 'b'.repeat(64);
const EVENT_ID = 'c'.repeat(64);

function createDbMock({
  moderationResults = new Map(),
  webhookEvents = new Map(),
  uploaderEnforcements = new Map()
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
          if (sql.includes('INSERT INTO uploader_enforcement')) {
            uploaderEnforcements.set(bindings[0], {
              pubkey: bindings[0],
              approval_required: bindings[1],
              approval_reason: bindings[2],
              approval_updated_at: bindings[3],
              approval_updated_by: bindings[4],
              relay_banned: bindings[5],
              relay_ban_reason: bindings[6],
              relay_ban_updated_at: bindings[7],
              relay_ban_updated_by: bindings[8],
              notes: bindings[9],
              created_at: bindings[10],
              updated_at: bindings[11]
            });
          }

          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
            return moderationResults.get(bindings[0]) ?? null;
          }
          if (sql.includes('FROM bunny_webhook_events')) {
            return webhookEvents.get(bindings[0]) ?? null;
          }
          if (sql.includes('FROM uploader_enforcement')) {
            return uploaderEnforcements.get(bindings[0]) ?? null;
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
    CDN_DOMAIN: 'media.divine.video',
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

describe('uploader enforcement logic', () => {
  it('stores and reads uploader enforcement rows', async () => {
    const db = createDbMock();

    const saved = await setUploaderEnforcement(db, PUBKEY, {
      approval_required: true,
      approval_reason: 'Manual approval required',
      relay_banned: false,
      updated_by: 'mod@divine.video'
    });

    const fetched = await getUploaderEnforcement(db, PUBKEY);

    expect(saved).toMatchObject({
      pubkey: PUBKEY,
      approval_required: true,
      approval_reason: 'Manual approval required',
      relay_banned: false
    });
    expect(fetched).toMatchObject({
      pubkey: PUBKEY,
      approval_required: true,
      approval_reason: 'Manual approval required',
      approval_updated_by: 'mod@divine.video'
    });
  });

  it('forces approval-required uploads into quarantine', () => {
    const result = applyUploaderEnforcementToResult({
      sha256: SHA256,
      action: 'SAFE',
      severity: 'low',
      reason: 'No issues found',
      rawResponse: {}
    }, {
      approval_required: true,
      relay_banned: false
    });

    expect(result.applied).toBe(true);
    expect(result.mode).toBe('approval_required');
    expect(result.result.action).toBe('QUARANTINE');
    expect(result.result.reason).toContain('manual approval');
  });

  it('forces relay-banned uploads into permanent ban', () => {
    const result = applyUploaderEnforcementToResult({
      sha256: SHA256,
      action: 'REVIEW',
      severity: 'medium',
      reason: 'Borderline content',
      rawResponse: {}
    }, {
      approval_required: false,
      relay_banned: true
    });

    expect(result.applied).toBe(true);
    expect(result.mode).toBe('relay_banned');
    expect(result.result.action).toBe('PERMANENT_BAN');
    expect(result.result.reason).toContain('relay-banned');
  });
});

describe('admin uploader enforcement routes', () => {
  it('updates uploader enforcement and syncs relay bans', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const db = createDbMock();
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}/enforcement`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({
            approvalRequired: true,
            relayBanned: true,
            reason: 'Escalated by trust and safety'
          })
        }),
        createEnv({
          BLOSSOM_DB: db,
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video',
          CF_ACCESS_CLIENT_ID: 'client-id',
          CF_ACCESS_CLIENT_SECRET: 'client-secret'
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        pubkey: PUBKEY,
        enforcement: {
          approval_required: true,
          relay_banned: true
        }
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe('https://relay.admin.divine.video/api/relay-rpc');
      expect(fetchCalls[0].init.headers['CF-Access-Client-Id']).toBe('client-id');
      const banBody = JSON.parse(fetchCalls[0].init.body);
      expect(banBody.method).toBe('banpubkey');
      expect(banBody.params[0]).toBe(PUBKEY);
      expect(banBody.params[1]).toBe('Escalated by trust and safety');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes relay bans through the RELAY_ADMIN service binding with X-Admin-Key when configured', async () => {
    const originalFetch = globalThis.fetch;
    // Prove the public-edge fetch is NOT used when the binding is present.
    globalThis.fetch = async () => {
      throw new Error('public-edge fetch should not be called when RELAY_ADMIN binding is configured');
    };
    const bindingCalls = [];
    const RELAY_ADMIN = {
      fetch: async (input, init) => {
        bindingCalls.push({ input: String(input), init });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    };

    try {
      const db = createDbMock();
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}/enforcement`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ relayBanned: true, reason: 'Escalated by trust and safety' })
        }),
        createEnv({
          BLOSSOM_DB: db,
          RELAY_ADMIN,
          RELAY_ADMIN_API_KEY: 'super-secret-admin-key',
          // CF Access secrets intentionally omitted: the binding path must not need them.
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video'
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ success: true, pubkey: PUBKEY });
      expect(bindingCalls).toHaveLength(1);
      expect(bindingCalls[0].input).toBe('https://relay.admin.divine.video/api/relay-rpc');
      expect(bindingCalls[0].init.headers['X-Admin-Key']).toBe('super-secret-admin-key');
      expect(bindingCalls[0].init.headers['CF-Access-Client-Id']).toBeUndefined();
      const banBody = JSON.parse(bindingCalls[0].init.body);
      expect(banBody.method).toBe('banpubkey');
      expect(banBody.params[0]).toBe(PUBKEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('removes the relay ban via unbanpubkey when relayBanned is cleared', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const db = createDbMock({
        uploaderEnforcements: new Map([[PUBKEY, {
          pubkey: PUBKEY,
          approval_required: 0,
          approval_reason: null,
          relay_banned: 1,
          relay_ban_reason: 'prior ban',
          created_at: '2026-03-14T00:00:00.000Z',
          updated_at: '2026-03-14T00:00:00.000Z'
        }]])
      });
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}/enforcement`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ relayBanned: false, reason: 'Cleared by trust and safety' })
        }),
        createEnv({
          BLOSSOM_DB: db,
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video',
          CF_ACCESS_CLIENT_ID: 'client-id',
          CF_ACCESS_CLIENT_SECRET: 'client-secret'
        })
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].input).toBe('https://relay.admin.divine.video/api/relay-rpc');
      const unbanBody = JSON.parse(fetchCalls[0].init.body);
      expect(unbanBody.method).toBe('unbanpubkey');
      expect(unbanBody.params[0]).toBe(PUBKEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast with a timeout error when the relay-admin call aborts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}/enforcement`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ relayBanned: true, reason: 'Escalated by trust and safety' })
        }),
        createEnv({
          BLOSSOM_DB: createDbMock(),
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video',
          CF_ACCESS_CLIENT_ID: 'client-id',
          CF_ACCESS_CLIENT_SECRET: 'client-secret'
        })
      );

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(String(body.error || '')).toMatch(/timed out/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns uploader enforcement in focused lookup responses', async () => {
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
          uploaded_by: PUBKEY
        }]]),
        uploaderEnforcements: new Map([[PUBKEY, {
          pubkey: PUBKEY,
          approval_required: 1,
          approval_reason: 'Manual approval required',
          approval_updated_at: '2026-03-14T00:00:00.000Z',
          approval_updated_by: 'mod@divine.video',
          relay_banned: 0,
          relay_ban_reason: null,
          relay_ban_updated_at: null,
          relay_ban_updated_by: null,
          notes: null,
          created_at: '2026-03-14T00:00:00.000Z',
          updated_at: '2026-03-14T00:00:00.000Z'
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
        uploaded_by: PUBKEY,
        uploaderEnforcement: {
          approval_required: true,
          relay_banned: false
        }
      }
    });
  });

  it('deletes relay events through relay admin', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/event/${EVENT_ID}/delete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({ reason: 'Delete bad event' })
        }),
        createEnv({
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video'
        })
      );

      expect(response.status).toBe(200);
      expect(fetchCalls).toHaveLength(1);
      const delBody = JSON.parse(fetchCalls[0].init.body);
      expect(delBody.method).toBe('banevent');
      expect(delBody.params).toEqual([EVENT_ID, 'Delete bad event']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('deletes all relay event versions when sha256 is provided', async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const secondEventId = 'd'.repeat(64);
    const fetchCalls = [];

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
          this.emit('message', {
            data: JSON.stringify(['EVENT', subscriptionId, { id: EVENT_ID, kind: 34236, tags: [['d', SHA256]] }])
          });
          this.emit('message', {
            data: JSON.stringify(['EVENT', subscriptionId, { id: secondEventId, kind: 34236, tags: [['d', SHA256]] }])
          });
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
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const response = await worker.fetch(
        new Request(`https://moderation.admin.divine.video/admin/api/event/${EVENT_ID}/delete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
          },
          body: JSON.stringify({
            reason: 'Delete all versions',
            sha256: SHA256
          })
        }),
        createEnv({
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video'
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        relayResult: {
          deletedCount: 2,
          attemptedCount: 2
        }
      });
      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls.map((call) => JSON.parse(call.init.body).params[0])).toEqual([EVENT_ID, secondEventId]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
