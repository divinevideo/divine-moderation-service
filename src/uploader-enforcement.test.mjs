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

  it('routes relay bans through the RELAY_ADMIN service binding with X-Admin-Key resolved from a Secrets Store binding', async () => {
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
          // Secrets Store binding shape (async .get()), as in prod.
          RELAY_ADMIN_API_KEY: { get: async () => 'super-secret-admin-key' },
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

  it('accepts a plain-string RELAY_ADMIN_API_KEY for the binding path (local dev / fallback)', async () => {
    const originalFetch = globalThis.fetch;
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
          RELAY_ADMIN_API_KEY: 'plain-string-key',
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video'
        })
      );

      expect(response.status).toBe(200);
      expect(bindingCalls).toHaveLength(1);
      expect(bindingCalls[0].init.headers['X-Admin-Key']).toBe('plain-string-key');
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

  it('fails fast with a timeout error when the relay-admin SERVICE BINDING call aborts', async () => {
    const originalFetch = globalThis.fetch;
    // The binding path must not touch the public-edge fetch.
    globalThis.fetch = async () => {
      throw new Error('public-edge fetch should not be called when RELAY_ADMIN binding is configured');
    };
    const RELAY_ADMIN = {
      fetch: async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
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
          RELAY_ADMIN,
          RELAY_ADMIN_API_KEY: { get: async () => 'super-secret-admin-key' },
          RELAY_ADMIN_URL: 'https://relay.admin.divine.video'
        })
      );

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(String(body.error || '')).toMatch(/timed out/i);
      expect(String(body.error || '')).toMatch(/via service binding/i);
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

// relay-manager refuses an un-ban of an account under age review and answers
// with a structured body rather than a bare failure (divine-relay-manager#217).
// These pin that the refusal survives the hop instead of being flattened into a
// generic 502 with no case to open (#191).
describe('age-review refusals on un-ban', () => {
  const CASE_ID = '2f3a1c48-9d5e-4b17-9c0a-6e8b1d7f4a20';
  const BLOCK_MESSAGE = 'This account is under age review. Restrict or clear it from the Age Review flow.';

  function bannedUploaderRows() {
    return new Map([[PUBKEY, {
      pubkey: PUBKEY,
      approval_required: 0,
      approval_reason: null,
      relay_banned: 1,
      relay_ban_reason: 'prior ban',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z'
    }]]);
  }

  async function postUnban(env) {
    return worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}/enforcement`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cf-Access-Authenticated-User-Email': 'mod@divine.video'
        },
        body: JSON.stringify({ relayBanned: false, reason: 'Relay ban removed by moderator' })
      }),
      env
    );
  }

  function stubRelayAdmin(status, body) {
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (input, init) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    return {
      fetchCalls,
      restore() { globalThis.fetch = originalFetch; }
    };
  }

  it('keeps code, caseId and state on an age-review block and points at the case', async () => {
    const relay = stubRelayAdmin(409, {
      success: false,
      error: 'This account is under age review. Restrict or clear it from the Age Review flow.',
      code: 'age_review_active',
      caseId: CASE_ID,
      state: 'restricted_pending_parental_consent'
    });

    try {
      const uploaderEnforcements = bannedUploaderRows();
      // The API host the worker calls is deliberately NOT the UI host the
      // moderator opens, so a case link built from the wrong one is visible.
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      // 409, not 502: this is a permanent refusal, not a relay malfunction.
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'This account is under age review. Restrict or clear it from the Age Review flow.',
        code: 'age_review_active',
        caseId: CASE_ID,
        state: 'restricted_pending_parental_consent',
        caseUrl: `https://relay.admin.divine.video/age-review?case=${CASE_ID}`
      });

      // The refused un-ban was the guarded method, and the local row still
      // records the ban the relay never lifted.
      expect(JSON.parse(relay.fetchCalls[0].init.body).method).toBe('unbanpubkey');
      expect(uploaderEnforcements.get(PUBKEY).relay_banned).toBe(1);
    } finally {
      relay.restore();
    }
  });

  it('builds the case link from RELAY_ADMIN_UI_URL when it is set', async () => {
    const relay = stubRelayAdmin(409, {
      success: false,
      error: 'This account is under age review. Restrict or clear it from the Age Review flow.',
      code: 'age_review_active',
      caseId: CASE_ID,
      state: 'open_reported'
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-staging.divine.video',
        RELAY_ADMIN_UI_URL: 'https://relay-staging.admin.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(409);
      // The UI host is configured separately from the API host the worker calls.
      await expect(response.json()).resolves.toMatchObject({
        caseUrl: `https://relay-staging.admin.divine.video/age-review?case=${CASE_ID}`
      });
    } finally {
      relay.restore();
    }
  });

  it('marks an age-review check that could not run as retryable', async () => {
    const relay = stubRelayAdmin(503, {
      success: false,
      error: 'Could not check age-review status. Try again.',
      code: 'age_review_check_failed'
    });

    try {
      const uploaderEnforcements = bannedUploaderRows();
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements }),
        RELAY_ADMIN_URL: 'https://relay.admin.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      // 503 is the retryable class; no case exists to link to.
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Could not check age-review status. Try again.',
        code: 'age_review_check_failed'
      });

      // The relay never lifted the ban, so neither does the local row. Asserted
      // on every refusing path, not just the 409: a regression that wrote the
      // row after a TRANSIENT failure is the one that quietly un-bans someone.
      expect(uploaderEnforcements.get(PUBKEY).relay_banned).toBe(1);
    } finally {
      relay.restore();
    }
  });

  it('leaves an uncoded relay failure as a 502', async () => {
    const relay = stubRelayAdmin(400, {
      success: false,
      error: 'Invalid pubkey'
    });

    try {
      const uploaderEnforcements = bannedUploaderRows();
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements }),
        RELAY_ADMIN_URL: 'https://relay.admin.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Invalid pubkey'
      });
      expect(uploaderEnforcements.get(PUBKEY).relay_banned).toBe(1);
    } finally {
      relay.restore();
    }
  });

  it('treats a non-string caseId or state as absent rather than linking to it', async () => {
    // The refusal body is another service's output, so it is only trusted as
    // far as its types go. A caseId that is not a string cannot identify a case,
    // and interpolating it anyway would hand the moderator a link to nothing.
    const relay = stubRelayAdmin(409, {
      success: false,
      error: BLOCK_MESSAGE,
      code: 'age_review_active',
      caseId: 12345,
      state: { name: 'restricted' }
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      // Still a refusal, still a 409 — just without a case to point at.
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: BLOCK_MESSAGE,
        code: 'age_review_active',
        caseId: null,
        state: null,
        caseUrl: null
      });
    } finally {
      relay.restore();
    }
  });

  it('treats a blank caseId as absent rather than linking to it', async () => {
    const relay = stubRelayAdmin(409, {
      success: false,
      error: BLOCK_MESSAGE,
      code: 'age_review_active',
      caseId: '   ',
      state: 'open_reported'
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        caseId: null,
        caseUrl: null
      });
    } finally {
      relay.restore();
    }
  });

  it('falls back to the status line when the relay names no usable error', async () => {
    // error was the one field read straight off the body while its three
    // siblings were type-guarded. A non-string one stringified into the toast
    // as "[object Object]", telling the moderator nothing.
    const relay = stubRelayAdmin(502, {
      success: false,
      error: { nested: 'not a string' }
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Relay admin error: HTTP 502'
      });
    } finally {
      relay.restore();
    }
  });

  it('trims a padded caseId instead of encoding the padding into the link', async () => {
    // A padded id clears the emptiness check, so without trimming it reaches the
    // link as `?case=%20...%20` — a live Open case button that resolves to no
    // case, which is worse than no button at all.
    const relay = stubRelayAdmin(409, {
      success: false,
      error: BLOCK_MESSAGE,
      code: 'age_review_active',
      caseId: `  ${CASE_ID}  `,
      state: '  open_reported  '
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        caseId: CASE_ID,
        state: 'open_reported',
        caseUrl: `https://relay.admin.divine.video/age-review?case=${CASE_ID}`
      });
    } finally {
      relay.restore();
    }
  });

  it('escapes a case id into the link instead of splicing it in raw', async () => {
    // Same untrusted-input reason: the case id goes into a query string that the
    // dashboard hands to window.open, so it is encoded rather than able to add
    // parameters or a fragment of its own. The raw id is still reported as-is.
    const awkwardCaseId = 'case 42&role=admin#top';
    const relay = stubRelayAdmin(409, {
      success: false,
      error: BLOCK_MESSAGE,
      code: 'age_review_active',
      caseId: awkwardCaseId,
      state: 'open_reported'
    });

    try {
      const response = await postUnban(createEnv({
        BLOSSOM_DB: createDbMock({ uploaderEnforcements: bannedUploaderRows() }),
        RELAY_ADMIN_URL: 'https://api-relay-prod.divine.video',
        CF_ACCESS_CLIENT_ID: 'client-id',
        CF_ACCESS_CLIENT_SECRET: 'client-secret'
      }));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        caseId: awkwardCaseId,
        caseUrl: 'https://relay.admin.divine.video/age-review?case=case%2042%26role%3Dadmin%23top'
      });
    } finally {
      relay.restore();
    }
  });
});
