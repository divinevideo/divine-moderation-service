// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for kind 1985 label fetchers — since-cursor poll filter shape
// ABOUTME: and per-video #e/#a queries deduped by event id.

import { describe, it, expect, afterEach } from 'vitest';
import { fetchLabelEventsSince, fetchLabelEventsForVideo } from './relay-client.mjs';

const originalWebSocket = globalThis.WebSocket;
afterEach(() => { globalThis.WebSocket = originalWebSocket; });

function makeFakeWebSocket({ eventsForFilter }) {
  const sentFilters = [];
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
      (this.listeners[type] ||= []).push(handler);
    }

    send(message) {
      const [, subscriptionId, filter] = JSON.parse(message);
      sentFilters.push(filter);
      queueMicrotask(() => {
        for (const event of eventsForFilter(filter)) {
          this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
        }
        this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
      });
    }

    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }

    emit(type, event = {}) {
      for (const handler of this.listeners[type] || []) handler(event);
    }
  }
  FakeWebSocket.sentFilters = sentFilters;
  return FakeWebSocket;
}

// A socket that delivers any events for the filter and then drops WITHOUT
// ever sending EOSE — the mid-stream truncation the strict fetchers must
// treat as a transient failure rather than a complete result.
function makeClosingBeforeEoseWebSocket({ eventsForFilter }) {
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
      (this.listeners[type] ||= []).push(handler);
    }

    send(message) {
      const [, subscriptionId, filter] = JSON.parse(message);
      queueMicrotask(() => {
        for (const event of eventsForFilter(filter)) {
          this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
        }
        this.readyState = 3;
        this.emit('close');
      });
    }

    close() {
      this.readyState = 3;
    }

    emit(type, event = {}) {
      for (const handler of this.listeners[type] || []) handler(event);
    }
  }
  return FakeWebSocket;
}

describe('fetchLabelEventsSince', () => {
  it('requests kind 1985 since the cursor and returns all events', async () => {
    const label = { id: 'a'.repeat(64), kind: 1985, tags: [['L', 'content-warning']] };
    const Fake = makeFakeWebSocket({ eventsForFilter: () => [label] });
    globalThis.WebSocket = Fake;

    const events = await fetchLabelEventsSince(1_700_000_000);

    expect(events).toEqual([label]);
    expect(Fake.sentFilters[0]).toMatchObject({ kinds: [1985], since: 1_700_000_000 });
  });

  it('rejects when the stream closes before EOSE (possible truncation)', async () => {
    const label = { id: 'a'.repeat(64), kind: 1985, tags: [['L', 'content-warning']] };
    globalThis.WebSocket = makeClosingBeforeEoseWebSocket({ eventsForFilter: () => [label] });

    await expect(fetchLabelEventsSince(1_700_000_000)).rejects.toThrow(/EOSE/i);
  });
});

describe('fetchLabelEventsForVideo', () => {
  const videoId = 'b'.repeat(64);
  const addressableId = `34236:${'c'.repeat(64)}:vine1`;

  it('queries #e and #a and dedupes overlapping events by id', async () => {
    const viaE = { id: 'd'.repeat(64), kind: 1985, tags: [['e', videoId]] };
    const viaBoth = { id: 'e'.repeat(64), kind: 1985, tags: [['e', videoId], ['a', addressableId]] };
    const Fake = makeFakeWebSocket({
      eventsForFilter: (filter) => {
        if (filter['#e']) return [viaE, viaBoth];
        if (filter['#a']) return [viaBoth];
        return [];
      },
    });
    globalThis.WebSocket = Fake;

    const events = await fetchLabelEventsForVideo({ eventId: videoId, addressableId });

    expect(events.map((event) => event.id).sort()).toEqual([viaE.id, viaBoth.id].sort());
    expect(Fake.sentFilters).toHaveLength(2);
    expect(Fake.sentFilters[0]).toMatchObject({ kinds: [1985], '#e': [videoId], limit: 5000 });
    expect(Fake.sentFilters[1]).toMatchObject({ kinds: [1985], '#a': [addressableId], limit: 5000 });
  });

  it('skips the #a query when no addressable id is present', async () => {
    const Fake = makeFakeWebSocket({ eventsForFilter: () => [] });
    globalThis.WebSocket = Fake;

    await fetchLabelEventsForVideo({ eventId: videoId, addressableId: null });

    expect(Fake.sentFilters).toHaveLength(1);
    expect(Fake.sentFilters[0]).toMatchObject({ kinds: [1985], '#e': [videoId], limit: 5000 });
  });

  it('rejects when a per-video query closes before EOSE (possible truncation)', async () => {
    globalThis.WebSocket = makeClosingBeforeEoseWebSocket({ eventsForFilter: () => [] });

    await expect(
      fetchLabelEventsForVideo({ eventId: videoId, addressableId: null }),
    ).rejects.toThrow(/EOSE/i);
  });

  it('rejects when a per-video query fills the requested page', async () => {
    const Fake = makeFakeWebSocket({
      eventsForFilter: () => [
        { id: '1'.repeat(64), kind: 1985, tags: [['e', videoId]] },
        { id: '2'.repeat(64), kind: 1985, tags: [['e', videoId]] },
      ],
    });
    globalThis.WebSocket = Fake;

    await expect(
      fetchLabelEventsForVideo({ eventId: videoId, addressableId: null }, 'wss://relay.divine.video', {}, { limit: 2 }),
    ).rejects.toThrow(/page limit/);
    expect(Fake.sentFilters[0]).toMatchObject({ kinds: [1985], '#e': [videoId], limit: 2 });
  });
});
