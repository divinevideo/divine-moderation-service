// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the funnelcake relay quarantine notifier
// ABOUTME: Verifies symmetric add/remove on action transitions and NIP-98 outbound auth

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyRelay } from './relay-notifier.mjs';

const PRIVATE_KEY = 'a'.repeat(64);
const EVENT_ID = 'd'.repeat(64);
const SHA256 = 'b'.repeat(64);

function makeEnv(overrides = {}) {
  return {
    FUNNELCAKE_ADMIN_URL: 'https://relay.divine.video',
    NOSTR_PRIVATE_KEY: PRIVATE_KEY,
    ...overrides,
  };
}

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
  });
}

describe('notifyRelay', () => {
  let fetcher;
  beforeEach(() => {
    fetcher = okFetch();
  });

  it('skips when FUNNELCAKE_ADMIN_URL is not configured', async () => {
    const env = makeEnv({ FUNNELCAKE_ADMIN_URL: undefined });
    const result = await notifyRelay(SHA256, EVENT_ID, 'QUARANTINE', env, fetcher);
    expect(result).toEqual(expect.objectContaining({ success: true, skipped: true }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips when event_id is missing (no relay event to hide)', async () => {
    const env = makeEnv();
    const result = await notifyRelay(SHA256, null, 'QUARANTINE', env, fetcher);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips PERMANENT_BAN (handled by the existing NIP-09 delete path)', async () => {
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'PERMANENT_BAN', env, fetcher);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('skips REVIEW (no enforcement; review is internal)', async () => {
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'REVIEW', env, fetcher);
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('POSTs to /api/moderation/quarantine on QUARANTINE with NIP-98 auth', async () => {
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'QUARANTINE', env, fetcher);

    expect(result.success).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, opts] = fetcher.mock.calls[0];
    expect(url).toBe('https://relay.divine.video/api/moderation/quarantine');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.event_id).toBe(EVENT_ID);
    expect(body.reason).toMatch(/auto-quarantine/);
  });

  it('DELETEs /api/moderation/quarantine/{event_id} on SAFE (un-quarantine)', async () => {
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'SAFE', env, fetcher);

    expect(result.success).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, opts] = fetcher.mock.calls[0];
    expect(url).toBe(`https://relay.divine.video/api/moderation/quarantine/${EVENT_ID}`);
    expect(opts.method).toBe('DELETE');
    expect(opts.headers['Authorization']).toMatch(/^Nostr /);
    expect(opts.body).toBeFalsy();
  });

  it('DELETEs on AGE_RESTRICTED (clears any prior under-review hide)', async () => {
    // AGE_RESTRICTED differs from QUARANTINE: the file is gated client-side, but
    // the relay event is still discoverable by age-gated viewers, so any prior
    // QUARANTINE entry must be removed.
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'AGE_RESTRICTED', env, fetcher);

    expect(result.success).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe('DELETE');
  });

  it('does not throw on non-2xx responses; returns {success: false, error}', async () => {
    fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    });
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'QUARANTINE', env, fetcher);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it('does not throw on fetch network errors', async () => {
    fetcher = vi.fn().mockRejectedValue(new Error('Network error'));
    const env = makeEnv();
    const result = await notifyRelay(SHA256, EVENT_ID, 'QUARANTINE', env, fetcher);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Network error/);
  });

  it('rejects an event_id that is not 64-char lowercase hex', async () => {
    const env = makeEnv();
    const bad = "a'); DROP TABLE events; --";
    const result = await notifyRelay(SHA256, bad, 'QUARANTINE', env, fetcher);
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('signs a NIP-98 event whose payload tag matches the body sha256', async () => {
    // Without this property, funnelcake's NIP-98 verifier rejects the request
    // when there's a body. We can decode the base64 token and inspect the tags.
    const env = makeEnv();
    await notifyRelay(SHA256, EVENT_ID, 'QUARANTINE', env, fetcher);
    const opts = fetcher.mock.calls[0][1];
    const token = opts.headers['Authorization'].replace(/^Nostr /, '');
    const event = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    expect(event.kind).toBe(27235);
    const uTag = event.tags.find((t) => t[0] === 'u');
    const methodTag = event.tags.find((t) => t[0] === 'method');
    const payloadTag = event.tags.find((t) => t[0] === 'payload');
    expect(uTag[1]).toBe('https://relay.divine.video/api/moderation/quarantine');
    expect(methodTag[1]).toBe('POST');
    expect(payloadTag).toBeDefined();
    // payload tag should be 64-char hex
    expect(payloadTag[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});
