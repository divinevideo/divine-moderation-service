// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: The dashboard's SAFE and AGE_RESTRICTED writes ask relay manager's lift
// ABOUTME: check first, and refuse when it says no or cannot be asked (#231)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./admin/zerotrust.mjs', () => ({
  getZeroTrustVerifier: () => ({
    verify: async (token) => token === 'test-access-token'
      ? { valid: true, email: 'mod@divine.video', payload: { email: 'mod@divine.video' } }
      : { valid: false, error: 'Missing JWT token' }
  })
}));

import worker from './index.mjs';

const SHA = 'ab'.repeat(32);
const CASE_ID = '2f3a1c48-9d5e-4b17-9c0a-6e8b1d7f4a20';
const ADMIN_KEY = 'mod-relay-key';
const BLOSSOM_URL = 'https://media.test/admin/moderate';

let liftCalls;
let liftAnswer;
let kvPuts;
let kvDeletes;
let d1Writes;
let blossomCalls;

// relay manager, reached through the RELAY_ADMIN service binding. `liftAnswer`
// is what its lift check says; a function so a test can throw instead.
const relayAdmin = {
  async fetch(url, init) {
    const path = new URL(String(url)).pathname;
    liftCalls.push({ path, headers: init.headers, body: JSON.parse(init.body) });
    return liftAnswer(JSON.parse(init.body));
  }
};

const allowed = (body) => Response.json({
  success: true, allowed: true, checked: true, sha256: String(body.sha256).toLowerCase()
});

function env(overrides = {}) {
  return {
    ALLOW_DEV_ACCESS: 'true',
    SERVICE_API_TOKEN: 'test-service-token',
    CDN_DOMAIN: 'media.divine.video',
    REPORT_POLLING_ENABLED: 'false',
    BLOSSOM_WEBHOOK_URL: BLOSSOM_URL,
    RELAY_ADMIN: relayAdmin,
    RELAY_ADMIN_API_KEY: ADMIN_KEY,
    RELAY_ADMIN_UI_URL: 'https://relay.admin.test',
    MODERATION_QUEUE: { async send() {} },
    MODERATION_KV: {
      async get() { return null; },
      async put(key) { kvPuts.push(key); },
      async delete(key) { kvDeletes.push(key); },
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    BLOSSOM_DB: {
      prepare(sql) {
        let binds = [];
        const stmt = {
          bind(...args) { binds = args; return stmt; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() {
            // Data writes only: the worker's schema bootstrap runs CREATEs on
            // its first request whatever the route.
            if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) d1Writes.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          }
        };
        return stmt;
      },
      async batch() { return []; }
    },
    ...overrides
  };
}

function moderate(sha256, body, overrides) {
  return worker.fetch(
    new Request(`https://moderation.admin.divine.video/admin/api/moderate/${sha256}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-access-jwt-assertion': 'test-access-token' },
      body: JSON.stringify(body)
    }),
    env(overrides)
  );
}

// Nothing reached KV, D1 or the media server: the refusal came before any write.
function expectNoWrites() {
  expect(kvPuts).toEqual([]);
  expect(kvDeletes).toEqual([]);
  expect(d1Writes).toEqual([]);
  expect(blossomCalls).toEqual([]);
}

beforeEach(() => {
  liftCalls = [];
  liftAnswer = allowed;
  kvPuts = [];
  kvDeletes = [];
  d1Writes = [];
  blossomCalls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === BLOSSOM_URL) {
      blossomCalls.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    return new Response('not found', { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('POST /admin/api/moderate/:sha256 asks relay manager before a lift', () => {
  it.each(['SAFE', 'AGE_RESTRICTED'])('asks before a %s and writes once it is allowed', async (action) => {
    const response = await moderate(SHA, { action, reason: 'looks fine' });

    expect(response.status).toBe(200);
    expect(liftCalls).toEqual([{
      path: '/api/moderate-media/lift-check',
      headers: expect.objectContaining({ 'X-Admin-Key': ADMIN_KEY }),
      body: { sha256: SHA, action }
    }]);
    expect(d1Writes.some((w) => /INSERT INTO moderation_results/i.test(w.sql))).toBe(true);
    expect(blossomCalls).toHaveLength(1);
  });

  it.each(['REVIEW', 'QUARANTINE', 'PERMANENT_BAN'])('does not ask before a %s', async (action) => {
    const response = await moderate(SHA, { action, reason: 'hide it' });

    expect(response.status).toBe(200);
    expect(liftCalls).toEqual([]);
  });

  it('refuses while the owner has an open age review, naming the case to open', async () => {
    liftAnswer = () => Response.json({
      success: false,
      error: 'The account that owns this file has an open age review.',
      code: 'age_review_active',
      caseId: CASE_ID,
      state: 'open_reported'
    }, { status: 409 });

    const response = await moderate(SHA, { action: 'SAFE' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'The account that owns this file has an open age review.',
      code: 'age_review_active',
      caseId: CASE_ID,
      state: 'open_reported',
      caseUrl: `https://relay.admin.test/age-review?case=${CASE_ID}`
    });
    expectNoWrites();
  });

  it('refuses when the media server has no record of the file', async () => {
    liftAnswer = () => Response.json({
      success: false, error: 'The media server has no record of this file', code: 'media_record_missing'
    }, { status: 409 });

    const response = await moderate(SHA, { action: 'AGE_RESTRICTED' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: 'media_record_missing' });
    expectNoWrites();
  });

  it.each(['owner_unreadable', 'age_review_check_failed', 'state_unreadable'])(
    'refuses as retryable when relay manager could not check (%s)',
    async (code) => {
      liftAnswer = () => Response.json({ success: false, error: 'Could not check', code }, { status: 503 });

      const response = await moderate(SHA, { action: 'SAFE' });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ success: false, code });
      expectNoWrites();
    }
  );

  it('refuses when relay manager cannot be reached', async () => {
    liftAnswer = () => { throw new Error('connection refused'); };

    const response = await moderate(SHA, { action: 'SAFE' });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false, code: 'lift_check_unavailable' });
    expectNoWrites();
  });

  it.each([
    ['a 500', () => new Response('boom', { status: 500 })],
    ['a 401', () => Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })],
    ['a 400 it should never send', () => Response.json({ success: false, error: 'bad', code: 'invalid_action' }, { status: 400 })],
    ['a 200 that does not allow', () => Response.json({ success: true, allowed: false, checked: true, sha256: SHA })],
    ['a 200 that did not check', () => Response.json({ success: true, allowed: true, checked: false, sha256: SHA })],
    ['a 200 naming another file', () => Response.json({ success: true, allowed: true, checked: true, sha256: 'cd'.repeat(32) })],
    ['a 200 that is not JSON', () => new Response('ok', { status: 200 })],
    ['a 202 that allows', () => Response.json({ success: true, allowed: true, checked: true, sha256: SHA }, { status: 202 })]
  ])('refuses on %s', async (_label, answer) => {
    liftAnswer = answer;

    const response = await moderate(SHA, { action: 'SAFE' });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false, code: 'lift_check_unavailable' });
    expectNoWrites();
  });

  // A refusal is passed through only as relay manager sends it. A known code
  // under another status is not one of its answers, so it is "could not ask".
  it.each([
    ['age_review_active', 503],
    ['media_record_missing', 503],
    ['owner_unreadable', 409],
    ['state_unreadable', 500]
  ])('treats %s at %i as no answer', async (code, status) => {
    liftAnswer = () => Response.json({ success: false, error: 'refused', code, caseId: CASE_ID }, { status });

    const response = await moderate(SHA, { action: 'SAFE' });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false, code: 'lift_check_unavailable' });
    expectNoWrites();
  });

  it('refuses when the answer does not finish arriving in time', async () => {
    vi.useFakeTimers();
    try {
      // Headers arrive, the body never does.
      liftAnswer = () => new Response(new ReadableStream({ start() {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });

      let settled = false;
      const pending = moderate(SHA, { action: 'SAFE' }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(24999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const response = await pending;

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ success: false, code: 'lift_check_unavailable' });
      expectNoWrites();
    } finally {
      vi.useRealTimers();
    }
  });

  // relay manager's check can read the media server and then this service's
  // record, up to 10s each, so its answer can take about 20s.
  it('waits for a lift check that takes as long as relay manager allows itself', async () => {
    vi.useFakeTimers();
    try {
      liftAnswer = (body) => new Promise((resolve) => setTimeout(() => resolve(allowed(body)), 20000));

      const pending = moderate(SHA, { action: 'SAFE' });
      await vi.advanceTimersByTimeAsync(20001);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(blossomCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses without asking when the path does not name a sha256', async () => {
    const response = await moderate('not-a-hash', { action: 'SAFE' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: 'invalid_sha256' });
    expect(liftCalls).toEqual([]);
    expectNoWrites();
  });

  it('writes the lowercase hash relay manager checked', async () => {
    const response = await moderate(SHA.toUpperCase(), { action: 'SAFE' });

    expect(response.status).toBe(200);
    expect(liftCalls[0].body.sha256).toBe(SHA.toUpperCase());
    const insert = d1Writes.find((w) => /INSERT INTO moderation_results/i.test(w.sql));
    expect(insert.binds[0]).toBe(SHA);
    expect(kvPuts).toContain(`moderation:${SHA}`);
    expect(blossomCalls[0].sha256).toBe(SHA);
  });
});

// Rejecting the last high-scoring major flag on the dashboard sets the file to
// SAFE in KV, which is a lift like any other: the admin lookup then reports
// SAFE, and the KV-to-D1 migration would copy it to the public record.
describe('POST /admin/api/verify-category/:sha256 asks relay manager before auto-approving', () => {
  const LIFT_BLOCK = 'The account that owns this file has an open age review.';
  let kvStore;

  function verify(category, status) {
    const store = kvStore;
    return worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/verify-category/${SHA}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-access-jwt-assertion': 'test-access-token' },
        body: JSON.stringify({ category, status })
      }),
      env({
        MODERATION_KV: {
          async get(key) { return store.get(key) ?? null; },
          async put(key, value) { kvPuts.push(key); store.set(key, value); },
          async delete(key) { kvDeletes.push(key); store.delete(key); },
          async list() { return { keys: [], list_complete: true, cursor: null }; }
        }
      })
    );
  }

  const stored = () => JSON.parse(kvStore.get(`moderation:${SHA}`));
  const onlyNudity = () => kvStore.set(
    `moderation:${SHA}`,
    JSON.stringify({ action: 'AGE_RESTRICTED', scores: { nudity: 0.9 } })
  );

  beforeEach(() => {
    kvStore = new Map([
      [`moderation:${SHA}`, JSON.stringify({ action: 'AGE_RESTRICTED', scores: { nudity: 0.9, violence: 0.7 } })],
      [`age-restricted:${SHA}`, '1']
    ]);
  });

  it('asks before auto-approving, and approves once it is allowed', async () => {
    onlyNudity();

    const response = await verify('nudity', 'rejected');

    expect(response.status).toBe(200);
    expect(liftCalls.map((c) => c.body)).toEqual([{ sha256: SHA, action: 'SAFE' }]);
    expect((await response.json()).autoApproved).toBe(true);
    expect(stored().action).toBe('SAFE');
    expect(kvDeletes).toContain(`age-restricted:${SHA}`);
  });

  it('saves the rejection but leaves the action alone while the owner has an open age review', async () => {
    onlyNudity();
    liftAnswer = () => Response.json({
      success: false, error: LIFT_BLOCK, code: 'age_review_active', caseId: CASE_ID, state: 'open_reported'
    }, { status: 409 });

    const response = await verify('nudity', 'rejected');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.autoApproved).toBe(false);
    expect(body.newAction).toBeUndefined();
    expect(body.autoApproveRefused).toEqual({
      status: 409,
      error: LIFT_BLOCK,
      code: 'age_review_active',
      caseId: CASE_ID,
      state: 'open_reported',
      caseUrl: `https://relay.admin.test/age-review?case=${CASE_ID}`
    });
    expect(stored().action).toBe('AGE_RESTRICTED');
    expect(stored().categoryVerifications).toEqual({ nudity: 'rejected' });
    expect(kvDeletes).toEqual([]);
    expect(kvStore.has(`age-restricted:${SHA}`)).toBe(true);
  });

  it('leaves the action alone when relay manager cannot be asked', async () => {
    onlyNudity();
    liftAnswer = () => { throw new Error('connection refused'); };

    const response = await verify('nudity', 'rejected');

    const body = await response.json();
    expect(body.autoApproved).toBe(false);
    expect(body.autoApproveRefused).toMatchObject({ status: 502, code: 'lift_check_unavailable' });
    expect(stored().action).toBe('AGE_RESTRICTED');
    expect(kvDeletes).toEqual([]);
  });

  // The lift check can take seconds. A decision saved meanwhile, here a ban,
  // must survive the rejection being saved.
  const banWhileChecking = (answer) => (body) => {
    kvStore.set(`moderation:${SHA}`, JSON.stringify({
      action: 'PERMANENT_BAN', scores: { nudity: 0.9 }, reviewedBy: 'another-moderator'
    }));
    return answer(body);
  };

  it('does not approve over a decision saved while the lift was checked', async () => {
    onlyNudity();
    liftAnswer = banWhileChecking(allowed);

    const response = await verify('nudity', 'rejected');

    const body = await response.json();
    expect(body.autoApproved).toBe(false);
    expect(body.autoApproveRefused).toMatchObject({ status: 409, code: 'moderation_changed' });
    // The action now stored, so the dashboard can show it.
    expect(body.action).toBe('PERMANENT_BAN');
    expect(stored()).toMatchObject({
      action: 'PERMANENT_BAN',
      reviewedBy: 'another-moderator',
      categoryVerifications: { nudity: 'rejected' }
    });
    expect(kvDeletes).toEqual([]);
  });

  it('keeps a decision saved while a refused lift was checked', async () => {
    onlyNudity();
    liftAnswer = banWhileChecking(() => Response.json({
      success: false, error: LIFT_BLOCK, code: 'age_review_active', caseId: CASE_ID, state: 'open_reported'
    }, { status: 409 }));

    const response = await verify('nudity', 'rejected');

    expect((await response.json()).autoApproveRefused.code).toBe('age_review_active');
    expect(stored()).toMatchObject({
      action: 'PERMANENT_BAN',
      reviewedBy: 'another-moderator',
      categoryVerifications: { nudity: 'rejected' }
    });
  });

  it('does not approve when another flag was confirmed while the lift was checked', async () => {
    kvStore.set(`moderation:${SHA}`, JSON.stringify({
      action: 'AGE_RESTRICTED',
      scores: { nudity: 0.9, violence: 0.9 },
      categoryVerifications: { violence: 'rejected' }
    }));
    liftAnswer = (body) => {
      kvStore.set(`moderation:${SHA}`, JSON.stringify({
        action: 'AGE_RESTRICTED',
        scores: { nudity: 0.9, violence: 0.9 },
        categoryVerifications: { violence: 'confirmed' }
      }));
      return allowed(body);
    };

    const response = await verify('nudity', 'rejected');

    const body = await response.json();
    expect(body.autoApproved).toBe(false);
    expect(body.autoApproveRefused).toMatchObject({ status: 409, code: 'moderation_changed' });
    expect(stored()).toMatchObject({
      action: 'AGE_RESTRICTED',
      categoryVerifications: { violence: 'confirmed', nudity: 'rejected' }
    });
    expect(kvDeletes).toEqual([]);
  });

  it.each([
    ['an allowed', allowed],
    ['a refused', () => Response.json({ success: false, error: LIFT_BLOCK, code: 'age_review_active', caseId: CASE_ID }, { status: 409 })]
  ])('does not bring back a record removed while %s lift was checked', async (_name, answer) => {
    onlyNudity();
    liftAnswer = (body) => {
      kvStore.delete(`moderation:${SHA}`);
      return answer(body);
    };

    const response = await verify('nudity', 'rejected');

    expect(response.status).toBe(404);
    expect(kvStore.has(`moderation:${SHA}`)).toBe(false);
    expect(kvPuts).toEqual([]);
    expect(kvDeletes).toEqual([]);
  });

  it('does not ask while another major flag still stands', async () => {
    const response = await verify('nudity', 'rejected');

    const body = await response.json();
    expect(body.autoApproved).toBe(false);
    expect(body.autoApproveRefused).toBeUndefined();
    expect(liftCalls).toEqual([]);
    expect(stored().action).toBe('AGE_RESTRICTED');
  });

  it('does not ask when a flag is confirmed', async () => {
    const response = await verify('nudity', 'confirmed');

    expect((await response.json()).autoApproved).toBe(false);
    expect(liftCalls).toEqual([]);
  });
});
