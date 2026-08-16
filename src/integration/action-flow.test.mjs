// ABOUTME: Integration-style tests for action queue + relay publish + results queue
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock publisher to avoid network
vi.mock('../nostr/publisher.mjs', () => ({
  publishToFaro: vi.fn().mockResolvedValue(undefined),
  publishLabelEvent: vi.fn().mockResolvedValue({ published: true })
}));

// Mock relay client connect used by debug endpoint
vi.mock('nostr-tools/relay', () => ({
  Relay: {
    connect: vi.fn().mockResolvedValue({ publish: vi.fn(), close: vi.fn() })
  }
}));

// Simple KV mock
function makeKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys, list_complete: true };
    },
    _dump() { return store; }
  };
}

// Simple D1 mock
function makeD1() {
  return {
    prepare() {
      return {
        bind: () => ({
          run: async () => ({}),
          all: async () => ({ results: [] }),
          first: async () => null
        })
      };
    },
    batch: async () => {}
  };
}

function makeQueueSink() {
  const sent = [];
  return {
    async send(msg) { sent.push(msg); },
    _sent: sent
  };
}

describe('Action queue flow', () => {
  let worker;
  let env;

  beforeEach(async () => {
    // Dynamic import after mocks
    const mod = await import('../index.mjs');
    worker = mod.default;
    env = {
      MODERATION_KV: makeKV(),
      BLOSSOM_DB: makeD1(),
      ACTION_RESULTS_QUEUE: makeQueueSink(),
      CDN_DOMAIN: 'cdn.example.test',
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      NOSTR_RELAY_URL: 'wss://relay.example.test',
      ALLOW_DEV_ACCESS: 'true'
    };
  });

  it('processes moderation-action messages and emits result', async () => {
    const sha256 = 'f'.repeat(64);
    const msg = {
      body: {
        type: 'moderation-action',
        sha256,
        action: 'PERMANENT_BAN',
        reason: 'test-reason',
        source: 'test-suite',
        requestId: 'req-123'
      },
      attempts: 0,
      ack: vi.fn(),
      retry: vi.fn()
    };

    await worker.queue({ messages: [msg] }, env);

    // Acked
    expect(msg.ack).toHaveBeenCalled();

    // KV flags
    const kvBan = await env.MODERATION_KV.get(`permanent-ban:${sha256}`);
    expect(kvBan).toBeTruthy();

    // Result message emitted
    expect(env.ACTION_RESULTS_QUEUE._sent.length).toBe(1);
    expect(env.ACTION_RESULTS_QUEUE._sent[0]).toEqual(expect.objectContaining({
      type: 'moderation-action-result',
      sha256,
      action: 'PERMANENT_BAN',
      status: 'success',
      requestId: 'req-123'
    }));
  });

  it('debug relay endpoint reports config', async () => {
    const req = new Request('https://example.test/admin/api/debug-relay', {
      headers: { 'Cf-Access-Authenticated-User-Email': 'tester@example.com' }
    });
    const res = await worker.fetch(req, env);
    const data = await res.json();
    expect(data).toEqual(expect.objectContaining({
      hasPrivateKey: true,
      relayUrl: env.NOSTR_RELAY_URL
    }));
  });
});

