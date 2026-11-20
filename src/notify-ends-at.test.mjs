// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests that /api/v1/notify forwards a suspension end time to the DM sender
// ABOUTME: Separate file so the dm-sender mock cannot leak into the main index suite

import { describe, expect, it, vi, beforeEach } from 'vitest';

const dmMocks = vi.hoisted(() => ({
  sendModerationDM: vi.fn(),
}));

// Keep the real module for everything index.mjs imports statically; replace only
// sendModerationDM so no DM is built, wrapped or published.
vi.mock('./nostr/dm-sender.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendModerationDM: dmMocks.sendModerationDM };
});

import worker from './index.mjs';

const PK = 'ab'.repeat(32);
const END = '2026-11-24T14:00:00.000Z';

// Trimmed copy of index.test.mjs's createEnv: just what the notify route reads.
function createEnv(overrides = {}) {
  return {
    ALLOW_DEV_ACCESS: 'true',
    SERVICE_API_TOKEN: 'test-service-token',
    // A key is set so the route goes past its "not configured" exit and calls
    // the (mocked) sender.
    NOSTR_PRIVATE_KEY: 'deadbeef'.repeat(8),
    // The router touches D1 before it reaches the notify route; nothing here
    // reads rows back.
    BLOSSOM_DB: {
      prepare() {
        return {
          bind() { return this; },
          async run() { return { success: true, meta: { changes: 0 } }; },
          async first() { return null; },
          async all() { return { results: [] }; },
        };
      },
      async batch() { return []; },
      async exec() { return { count: 0 }; },
    },
    MODERATION_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    REPORT_POLLING_ENABLED: 'false',
    ...overrides
  };
}

async function post(body) {
  return worker.fetch(
    new Request('http://localhost/api/v1/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    createEnv()
  );
}

describe('POST /api/v1/notify forwards endsAt', () => {
  beforeEach(() => {
    dmMocks.sendModerationDM.mockReset();
    dmMocks.sendModerationDM.mockResolvedValue({ sent: true });
  });

  it('passes endsAt through to the DM sender', async () => {
    const response = await post({ recipientPubkey: PK, action: 'ACCOUNT_SUSPENDED', endsAt: END });
    expect(response.status).toBe(200);
    expect(dmMocks.sendModerationDM).toHaveBeenCalledWith(PK, null, 'ACCOUNT_SUSPENDED', null, expect.anything(), null,
      expect.objectContaining({ endsAt: END }));
  });

  it('passes endsAt through for ACCOUNT_SUSPENSION_CHANGED', async () => {
    const response = await post({ recipientPubkey: PK, action: 'ACCOUNT_SUSPENSION_CHANGED', endsAt: END });
    expect(response.status).toBe(200);
    expect(dmMocks.sendModerationDM).toHaveBeenCalledWith(PK, null, 'ACCOUNT_SUSPENSION_CHANGED', null, expect.anything(), null,
      expect.objectContaining({ endsAt: END }));
  });

  it('does not pass endsAt for a non-suspension action', async () => {
    const response = await post({ recipientPubkey: PK, action: 'ACCOUNT_RESTORED', endsAt: END });
    expect(response.status).toBe(200);
    expect(dmMocks.sendModerationDM).toHaveBeenCalledTimes(1);
    expect(dmMocks.sendModerationDM.mock.calls[0][6]?.endsAt).toBeUndefined();
  });

  it('passes no endsAt when the caller sends none', async () => {
    const response = await post({ recipientPubkey: PK, action: 'ACCOUNT_SUSPENDED' });
    expect(response.status).toBe(200);
    expect(dmMocks.sendModerationDM).toHaveBeenCalledTimes(1);
    expect(dmMocks.sendModerationDM.mock.calls[0][6]?.endsAt).toBeUndefined();
  });

  it('does not call the DM sender when endsAt is invalid', async () => {
    const response = await post({ recipientPubkey: PK, action: 'ACCOUNT_SUSPENDED', endsAt: 'hello 2' });
    expect(response.status).toBe(400);
    expect(dmMocks.sendModerationDM).not.toHaveBeenCalled();
  });
});
