// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Signed deletion payload regression tests for relay read-after-write delays.
// ABOUTME: Exercises body authentication, bounded input, and retained target ownership checks.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { handleSyncDelete } from './sync-endpoint.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const TARGET_ID = 'b'.repeat(64);
const SHA = 'c'.repeat(64);
const MAX_BYTES = 64 * 1024;

async function hashBody(body) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('supplied creator deletion event', () => {
  let sk, event, deps;

  beforeEach(() => {
    sk = generateSecretKey();
    event = signDelete();
    deps = {
      db: makeFakeD1(),
      kv: makeFakeKV(),
      fetchKind5WithRetry: vi.fn().mockResolvedValue(null),
      fetchTargetEvent: vi.fn().mockResolvedValue({
        id: TARGET_ID, pubkey: event.pubkey, tags: [['imeta', `x ${SHA}`]]
      }),
      callBlossomDelete: vi.fn().mockResolvedValue({ success: true, status: 200 })
    };
  });

  function signDelete(overrides = {}, key = sk) {
    return finalizeEvent({
      kind: 5, created_at: Math.floor(Date.now() / 1000),
      tags: [['e', TARGET_ID]], content: 'Remove café 🎬', ...overrides
    }, key);
  }

  async function makeRequest({ body = JSON.stringify({ event }), id = event.id, payload, omitPayload = false, headers = {} } = {}) {
    const url = `https://moderation.example/api/delete/${id}`;
    const tags = [['u', url], ['method', 'POST']];
    if (!omitPayload) tags.push(['payload', payload ?? await hashBody(body)]);
    const auth = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk);
    return new Request(url, {
      method: 'POST', body,
      headers: { Authorization: `Nostr ${btoa(JSON.stringify(auth))}`, 'Content-Type': 'application/json', ...headers }
    });
  }

  function expectNoProcessing() {
    expect(deps.fetchKind5WithRetry).not.toHaveBeenCalled();
    expect(deps.fetchTargetEvent).not.toHaveBeenCalled();
    expect(deps.callBlossomDelete).not.toHaveBeenCalled();
  }

  it('cleans up a signed event before the relay can return it, without lookup or backoff', async () => {
    const response = await handleSyncDelete(await makeRequest(), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind5_id: event.id, status: 'success', targets: [{ target_event_id: TARGET_ID, status: 'success' }] });
    expect(deps.fetchKind5WithRetry).not.toHaveBeenCalled();
    expect(deps.fetchTargetEvent).toHaveBeenCalledWith(TARGET_ID);
    expect(deps.callBlossomDelete).toHaveBeenCalledWith(SHA);
  });

  it('retains idempotency when a supplied event is retried', async () => {
    await handleSyncDelete(await makeRequest(), deps);
    const response = await handleSyncDelete(await makeRequest(), deps);
    expect((await response.json()).targets[0]).toMatchObject({ status: 'success', skipped: true });
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(1);
    expect(deps.fetchKind5WithRetry).not.toHaveBeenCalled();
  });

  it('still refuses to delete a target owned by somebody else', async () => {
    deps.fetchTargetEvent.mockResolvedValue({ id: TARGET_ID, pubkey: getPublicKey(generateSecretKey()), tags: [['imeta', `x ${SHA}`]] });
    const response = await handleSyncDelete(await makeRequest(), deps);
    expect((await response.json()).targets[0].status).toBe('failed:permanent:author_mismatch');
    expect(deps.callBlossomDelete).not.toHaveBeenCalled();
    expect(deps.fetchKind5WithRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { omitPayload: true }],
    ['incorrect', { payload: '0'.repeat(64) }],
    ['hash of differently serialized JSON', { payload: null }]
  ])('rejects %s payload authentication', async (label, options) => {
    if (options.payload === null) options.payload = await hashBody(JSON.stringify({ event }, null, 2));
    const response = await handleSyncDelete(await makeRequest(options), deps);
    expect(response.status).toBe(401);
    expectNoProcessing();
  });

  it.each(['{', 'null', '[]', '{}', '{"event":null}', '{"event":42}', ' '])('rejects malformed or missing supplied events: %s', async body => {
    const response = await handleSyncDelete(await makeRequest({ body }), deps);
    expect(response.status).toBe(400);
    expectNoProcessing();
  });

  it.each([
    ['forged signature', () => ({ ...event, sig: '0'.repeat(128) })],
    ['tampered content', () => ({ ...event, content: 'changed' })],
    ['malformed tags', () => ({ ...event, tags: [null] })],
    ['wrong kind', () => signDelete({ kind: 1 })],
    ['no targets', () => signDelete({ tags: [] })],
    ['invalid target ID', () => signDelete({ tags: [['e', 'not-an-id']] })]
  ])('rejects %s without falling back to relay lookup', async (label, makeEvent) => {
    event = makeEvent();
    const response = await handleSyncDelete(await makeRequest(), deps);
    expect(response.status).toBe(400);
    expectNoProcessing();
  });

  it('rejects a different event than the URL names', async () => {
    const response = await handleSyncDelete(await makeRequest({ id: 'a'.repeat(64) }), deps);
    expect(response.status).toBe(400);
    expectNoProcessing();
  });

  it('rejects an event signed by someone other than the authenticated caller', async () => {
    event = signDelete({}, generateSecretKey());
    const response = await handleSyncDelete(await makeRequest(), deps);
    expect(response.status).toBe(403);
    expectNoProcessing();
  });

  it('accepts a body at the byte limit', async () => {
    const serialized = JSON.stringify({ event });
    const body = serialized + ' '.repeat(MAX_BYTES - new TextEncoder().encode(serialized).byteLength);
    const response = await handleSyncDelete(await makeRequest({ body }), deps);
    expect(response.status).toBe(200);
    expect(deps.fetchKind5WithRetry).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies without trusting Content-Length', async () => {
    const body = 'é'.repeat(MAX_BYTES / 2 + 1);
    const response = await handleSyncDelete(await makeRequest({ body }), deps);
    expect(response.status).toBe(413);
    expectNoProcessing();
  });

  it('stops and cancels chunked input after crossing the byte limit', async () => {
    const request = await makeRequest();
    const cancel = vi.fn();
    const chunks = [new Uint8Array(MAX_BYTES), new Uint8Array(1)];
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(chunks.shift() || new Uint8Array(1)); },
      cancel
    });
    const streamed = new Request(request.url, { method: 'POST', headers: request.headers, body });
    const response = await handleSyncDelete(streamed, deps);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expectNoProcessing();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('cancel failed'))],
    ['never settles', () => new Promise(() => {})]
  ])('returns 413 promptly even when stream cancellation %s', async (label, cancel) => {
    const request = await makeRequest();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES + 1)); },
      cancel
    });
    const streamed = new Request(request.url, { method: 'POST', headers: request.headers, body });
    const response = await handleSyncDelete(streamed, deps);
    expect(response.status).toBe(413);
    expectNoProcessing();
  }, 1000);
});
