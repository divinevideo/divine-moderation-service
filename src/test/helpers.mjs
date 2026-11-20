// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared test helpers and mock factories for divine-moderation-service tests
// ABOUTME: Provides KV, Queue mock builders and test data generators

import { afterEach, beforeEach, expect } from 'vitest';

/**
 * Build a mock KV namespace that captures operations.
 */
export function createMockKV(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async ({ prefix } = {}) => {
      const keys = [];
      for (const [k] of store) {
        if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys };
    },
    _store: store,
  };
}

/**
 * Build a mock Queue that captures sent messages.
 */
export function createMockQueue() {
  const messages = [];
  return {
    send: async (msg) => { messages.push(msg); },
    sendBatch: async (batch) => { messages.push(...batch); },
    _messages: messages,
  };
}

/**
 * Build a minimal env object for unit tests.
 */
export function createMockEnv(overrides = {}) {
  return {
    SERVICE_API_TOKEN: 'test-token-123',
    API_BEARER_TOKEN: '',
    MODERATION_API_KEY: '',
    ALLOW_DEV_ACCESS: 'false',
    CDN_DOMAIN: 'media.divine.video',
    TEAM_DOMAIN: 'divine',
    POLICY_AUD: 'test-aud',
    RELAY_ADMIN_URL: 'https://relay.divine.video',
    CF_ACCESS_CLIENT_ID: 'test-client-id',
    CF_ACCESS_CLIENT_SECRET: 'test-client-secret',
    NOSTR_PRIVATE_KEY: null,
    MODERATION_KV: createMockKV(),
    MODERATION_QUEUE: createMockQueue(),
    ...overrides,
  };
}

/**
 * Create a valid SHA256 hash for testing.
 */
export function testSha256(suffix = '0') {
  return ('a'.repeat(63) + suffix).slice(0, 64);
}

/**
 * Create a valid Nostr pubkey for testing.
 */
export function testPubkey(suffix = '0') {
  return ('b'.repeat(63) + suffix).slice(0, 64);
}

/**
 * Build a mock Request object.
 */
export function createRequest(method, path, { body, headers } = {}) {
  const url = `https://moderation.admin.divine.video${path}`;
  const init = { method, headers: new Headers(headers || {}) };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers.set('Content-Type', 'application/json');
  }
  return new Request(url, init);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLoopbackRelay(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
// Allowlist, not a blocklist: only a read (REQ) or its CLOSE, exactly as
// JSON.stringify writes them, may reach a non-loopback relay. EVENT, AUTH,
// binary, non-string, BOM-prefixed or escaped forms are all dropped.
const isReadFrame = (data) => typeof data === 'string' && /^\["(?:REQ|CLOSE)",/.test(data);

/**
 * Fail any test in the calling file that writes to a real relay.
 *
 * Call once at the top level of a test file. Tests once gift-wrapped DMs with a
 * throwaway key and published them to public relays, including the production
 * one, on every run. The real WebSocket is reachable from this runtime and the
 * DM sender swallows socket errors, so a leak shows up as nothing but a log
 * line. Before each test this wraps WebSocket so that any frame bound for a
 * non-loopback relay other than a read (REQ) or its CLOSE is dropped, never
 * sent, and after the test it fails if any was. Reads pass through: some tests
 * still read from the production relay, which is a separate problem from
 * writing to it. A test that installs its own fake WebSocket replaces the guard
 * for its duration.
 *
 * The guard is a Proxy over the real class, not a replacement: the pool's own
 * RPC reads WebSocket.READY_STATE_OPEN from the global and silently drops every
 * message if it is missing, which wedges the run. Any fake WebSocket needs the
 * READY_STATE_* statics for the same reason.
 *
 * @returns {{ readonly blocked: string[], clear(): void }} relay URLs whose
 *   frames were dropped in the current test (for the guard's own test)
 */
export function guardRelayPublishes() {
  let blocked = [];
  let realWebSocket;
  beforeEach(() => {
    blocked = [];
    realWebSocket = globalThis.WebSocket;
    const proxy = new Proxy(realWebSocket, {
      construct(target, args, newTarget) {
        const url = String(args[0]);
        const ws = Reflect.construct(target, [url, ...args.slice(1)], newTarget === proxy ? target : newTarget);
        if (isLoopbackRelay(url)) return ws;
        const realSend = ws.send.bind(ws);
        const guardedSend = (data) => {
          if (!isReadFrame(data)) {
            blocked.push(url);
            return; // dropped: never reaches the relay
          }
          realSend(data);
        };
        Object.defineProperty(ws, 'send', { value: guardedSend, configurable: true });
        if (ws.send !== guardedSend) {
          // The override did not take, so nothing can be sent safely.
          ws.close();
          blocked.push(url);
          throw new Error(`guardRelayPublishes: could not guard a WebSocket to ${url}`);
        }
        return ws;
      },
    });
    globalThis.WebSocket = proxy;
  });
  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
    expect(blocked, 'test tried to write to a real relay').toEqual([]);
  });
  return {
    get blocked() { return blocked; },
    clear() { blocked = []; },
  };
}
