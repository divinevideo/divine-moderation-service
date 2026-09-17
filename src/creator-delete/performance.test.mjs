// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Regression tests for deletion performance phases and lookup outcomes.
// ABOUTME: Exercises real handler control flow with synthetic events and dependency failures.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fetchKind5WithRetry } from './funnelcake-fetch.mjs';
import { fetchNostrEventById } from '../nostr/relay-client.mjs';
import { handleSyncDelete } from './sync-endpoint.mjs';
import { handleStatusQuery } from './status-endpoint.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const ID = 'a'.repeat(64);
const TARGET = 'b'.repeat(64);
const SHA = 'c'.repeat(64);
let logs;
let clock;

function events(phase) {
  return logs.mock.calls.flatMap(([message]) => {
    try {
      const data = typeof message === 'string' ? JSON.parse(message) : message;
      return data.event === 'creator_delete.performance' && (!phase || data.phase === phase) ? [data] : [];
    } catch { return []; }
  });
}

beforeEach(() => {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deletion lookup measurements', () => {
  it('records each attempt and includes retry waits only in the total', async () => {
    const fetchEventById = vi.fn(async () => {
      clock += 7;
      return fetchEventById.mock.calls.length === 3 ? { id: ID } : null;
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      clock += delay;
      callback();
      return 1;
    });
    await expect(fetchKind5WithRetry(ID, { fetchEventById })).resolves.toEqual({ id: ID });
    expect(events('kind5_attempt')).toMatchObject([
      { attempt: 1, duration_ms: 7, outcome: 'unresolved', retry_delay_ms: 0 },
      { attempt: 2, duration_ms: 7, outcome: 'unresolved', retry_delay_ms: 100 },
      { attempt: 3, duration_ms: 7, outcome: 'found', retry_delay_ms: 500 }
    ]);
    expect(events('kind5_retries')).toMatchObject([{ attempts: 3, duration_ms: 621, outcome: 'found' }]);
  });

  it('preserves all five missing attempts and the default retry schedule', async () => {
    const waits = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      waits.push(delay);
      clock += delay;
      callback();
      return 1;
    });
    const fetchEventById = vi.fn(async () => null);
    await expect(fetchKind5WithRetry(ID, { fetchEventById })).resolves.toBeNull();
    expect(waits).toEqual([100, 500, 1000, 2000]);
    expect(fetchEventById).toHaveBeenCalledTimes(5);
    expect(events('kind5_retries')).toMatchObject([{ attempts: 5, duration_ms: 3600, outcome: 'unresolved' }]);
  });

  it('records thrown dependencies and preserves the original exception without retrying', async () => {
    const error = new Error('synthetic sensitive dependency detail');
    const fetchEventById = vi.fn(async () => { clock += 11; throw error; });
    await expect(fetchKind5WithRetry(ID, { fetchEventById })).rejects.toBe(error);
    expect(fetchEventById).toHaveBeenCalledTimes(1);
    expect(events('kind5_attempt')).toMatchObject([{ attempt: 1, duration_ms: 11, outcome: 'error' }]);
    expect(events('kind5_retries')).toMatchObject([{ attempts: 1, outcome: 'error' }]);
    expect(JSON.stringify(events())).not.toContain(error.message);
  });

  it.each([
    [404, '', 'missing'],
    [503, '', 'transient'],
    [429, '', 'transient'],
    [403, '', 'transient'],
    [200, 'invalid json', 'invalid'],
    [200, '{}', 'invalid']
  ])('records upstream status %i and outcome without altering lookup result', async (status, body, outcome) => {
    vi.stubGlobal('fetch', vi.fn(async () => { clock += 9; return new Response(body, { status }); }));
    await expect(fetchNostrEventById(ID, ['wss://relay.example'], {}, { observePerformance: true })).resolves.toBeNull();
    expect(events('relay_lookup')).toMatchObject([{ status_code: status, duration_ms: 9, outcome, attempt: 1 }]);
  });

  it('records signed success and transport failures without logging identities or error text', async () => {
    const signed = finalizeEvent({ kind: 5, created_at: 1, tags: [], content: 'synthetic private content' }, generateSecretKey());
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic credential'))
      .mockResolvedValueOnce(new Response(JSON.stringify(signed)));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchNostrEventById(signed.id, ['wss://one.example', 'wss://two.example'], {}, { observePerformance: true, throwOnTransient: true })).resolves.toEqual(signed);
    expect(events('relay_lookup')).toMatchObject([
      { outcome: 'transport_error', attempt: 1 },
      { outcome: 'found', attempt: 2, status_code: 200 }
    ]);
    expect(events('relay_lookup')[0]).not.toHaveProperty('status_code');
    const serialized = JSON.stringify(events());
    for (const privateValue of [signed.id, signed.pubkey, signed.sig, signed.content, 'synthetic credential', 'one.example']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('preserves strict transient failure when the telemetry sink also throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    logs.mockImplementation(() => { throw new Error('logging failure'); });
    await expect(fetchNostrEventById(ID, ['wss://relay.example'], {}, {
      observePerformance: true, throwOnTransient: true
    })).rejects.toThrow(/transient/);
    await expect(fetchKind5WithRetry(ID, { fetchEventById: async () => ({ id: ID }) })).resolves.toEqual({ id: ID });
  });

  it('leaves unrelated relay callers uninstrumented', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await fetchNostrEventById(ID);
    expect(events()).toEqual([]);
  });
});

describe('deletion handler phase measurements', () => {
  function fixture(method = 'POST') {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const route = method === 'POST' ? 'delete' : 'delete-status';
    const url = `https://moderation-api.divine.video/api/${route}/${ID}`;
    const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(clock / 1000), tags: [['u', url], ['method', method]], content: '' }, sk);
    return {
      request: new Request(url, { method, headers: { Authorization: `Nostr ${btoa(JSON.stringify(auth))}` } }),
      deps: {
        db: makeFakeD1(), kv: makeFakeKV(),
        fetchKind5WithRetry: async () => { clock += 20; return { id: ID, pubkey: pk, tags: [['e', TARGET]] }; },
        fetchTargetEvent: async () => { clock += 30; return { id: TARGET, pubkey: pk, tags: [['imeta', `x ${SHA}`]] }; },
        callBlossomDelete: async () => { clock += 40; return { success: true, status: 200 }; },
        budgetMs: 10
      },
      pk
    };
  }

  it('measures successful phases and keeps all new telemetry bounded', async () => {
    const { request, deps, pk } = fixture();
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('success');
    expect(events('kind5_lookup')).toMatchObject([{ duration_ms: 20, outcome: 'found' }]);
    expect(events('target_lookup')).toMatchObject([{ duration_ms: 30, outcome: 'found' }]);
    expect(events('blob_delete')).toMatchObject([{ duration_ms: 40, outcome: 'success', status_code: 200 }]);
    expect(events('processing')).toMatchObject([{ duration_ms: 70, outcome: 'success' }]);
    expect(events('request')).toMatchObject([{ duration_ms: 90, outcome: 'completed', status_code: 200, operation: 'delete' }]);
    const serialized = JSON.stringify(events());
    for (const identity of [ID, TARGET, SHA, pk, request.url, request.headers.get('Authorization')]) expect(serialized).not.toContain(identity);
  });

  it('records request and dependency failure without replacing the thrown value', async () => {
    const { request, deps } = fixture();
    const error = new Error('synthetic database detail');
    deps.kv.get = async () => { throw error; };
    await expect(handleSyncDelete(request, deps)).rejects.toBe(error);
    expect(events('ip_rate_limit')).toMatchObject([{ outcome: 'error' }]);
    expect(events('request')).toMatchObject([{ outcome: 'error' }]);
    expect(events('request')[0]).not.toHaveProperty('status_code');
  });

  it('distinguishes a failed cleanup from a successful HTTP response', async () => {
    const { request, deps } = fixture();
    deps.callBlossomDelete = async () => ({ success: false, status: 503 });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('failed');
    expect(events('blob_delete')).toMatchObject([{ outcome: 'failed', status_code: 503 }]);
    expect(events('processing')).toMatchObject([{ outcome: 'failed' }]);
  });

  it('records processing completion after the request budget returns 202', async () => {
    const { request, deps } = fixture();
    let complete;
    deps.callBlossomDelete = () => new Promise(resolve => { complete = resolve; });
    const pending = [];
    deps.ctx = { waitUntil: promise => pending.push(promise) };
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(202);
    expect(events('request')).toMatchObject([{ outcome: 'in_progress', status_code: 202 }]);
    expect(events('processing')).toEqual([]);
    complete({ success: true, status: 200 });
    await Promise.all(pending);
    expect(events('processing')).toMatchObject([{ outcome: 'success' }]);
    expect(events('request')).toHaveLength(1);
  });

  it('records blob exceptions through processing and request without masking them', async () => {
    const { request, deps } = fixture();
    const error = new Error('synthetic blob detail');
    deps.callBlossomDelete = async () => { throw error; };
    await expect(handleSyncDelete(request, deps)).rejects.toBe(error);
    expect(events('blob_delete')).toMatchObject([{ outcome: 'error' }]);
    expect(events('processing')).toMatchObject([{ outcome: 'error' }]);
    expect(events('request')).toMatchObject([{ outcome: 'error' }]);
    expect(JSON.stringify(events())).not.toContain(error.message);
  });

  it('records target lookup exceptions while retaining existing failed-result behavior', async () => {
    const { request, deps } = fixture();
    deps.fetchTargetEvent = async () => { throw new Error('synthetic lookup detail'); };
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('failed');
    expect(events('target_lookup')).toMatchObject([{ outcome: 'error' }]);
    expect(events('processing')).toMatchObject([{ outcome: 'failed' }]);
  });

  it('records a status database read and final response', async () => {
    const { request, deps } = fixture('GET');
    const response = await handleStatusQuery(request, deps);
    expect(response.status).toBe(404);
    expect(events('status_read')).toMatchObject([{ outcome: 'missing', operation: 'delete_status' }]);
    expect(events('request')).toMatchObject([{ status_code: 404, operation: 'delete_status' }]);
  });

  it.each([
    ['accepted', 'in_progress'],
    ['success', 'success'],
    ['failed:permanent:target_unresolved', 'failed']
  ])('records polling status %s as %s after authorization', async (status, outcome) => {
    const { request, deps, pk } = fixture('GET');
    deps.db.rows.set(`${ID}:${TARGET}`, { kind5_id: ID, target_event_id: TARGET, creator_pubkey: pk, status });
    const response = await handleStatusQuery(request, deps);
    expect(response.status).toBe(200);
    expect((await response.json()).targets[0].status).toBe(status);
    expect(events('status_result')).toMatchObject([{ operation: 'delete_status', outcome }]);
  });

  it('does not report polling target outcomes before ownership validation', async () => {
    const { request, deps } = fixture('GET');
    deps.db.rows.set(`${ID}:${TARGET}`, { kind5_id: ID, target_event_id: TARGET, creator_pubkey: 'd'.repeat(64), status: 'success' });
    const response = await handleStatusQuery(request, deps);
    expect(response.status).toBe(403);
    expect(events('status_result')).toEqual([]);
  });

  it('isolates new telemetry sink failures from the request result', async () => {
    const { request, deps } = fixture();
    logs.mockImplementation(message => {
      if (message?.event === 'creator_delete.performance') throw new Error('telemetry unavailable');
    });
    const response = await handleSyncDelete(request, deps);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('success');
  });
});
