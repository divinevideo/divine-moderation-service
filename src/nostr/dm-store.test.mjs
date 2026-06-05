// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM conversation storage (dm-store.mjs)
// ABOUTME: Verifies D1-backed message logging, dedup, and conversation queries

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { computeConversationId, logDm, getConversations, getConversation, getConversationByPubkey, initDmLogTable } from './dm-store.mjs';

/**
 * Create a mock D1 database that tracks calls and stores data in-memory
 */
function createMockDb() {
  const store = [];
  let idCounter = 0;

  return {
    _store: store,
    prepare: vi.fn((sql) => ({
      bind: vi.fn((...args) => ({
        run: vi.fn(async () => {
          if (sql.trim().toUpperCase().startsWith('INSERT')) {
            idCounter++;
            store.push({ id: idCounter, args, sql });
            return { meta: { last_row_id: idCounter } };
          }
          return { meta: {} };
        }),
        first: vi.fn(async () => {
          // For dedup check: SELECT id FROM dm_log WHERE nostr_event_id = ?
          if (sql.includes('nostr_event_id') && sql.includes('SELECT')) {
            const eventId = args[0];
            const found = store.find(row =>
              row.sql.includes('INSERT') && row.args[7] === eventId
            );
            return found ? { id: found.id } : null;
          }
          return null;
        }),
        all: vi.fn(async () => {
          // Return different results based on query type
          if (sql.includes('GROUP BY conversation_id') || sql.includes('ORDER BY last_message_at')) {
            // getConversations query
            return { results: store.filter(r => r.sql.includes('INSERT')).map(r => ({
              conversation_id: r.args[0],
              last_message_at: new Date().toISOString(),
              message_count: 1,
              sender_pubkey: r.args[3],
              recipient_pubkey: r.args[4],
              last_message: r.args[6],
              last_sha256: r.args[1],
              last_message_type: r.args[5]
            })) };
          }
          if (sql.includes('conversation_id = ?')) {
            // getConversation query
            const convId = args[0];
            return { results: store.filter(r =>
              r.sql.includes('INSERT') && r.args[0] === convId
            ).map(r => ({
              id: r.id,
              conversation_id: r.args[0],
              sha256: r.args[1],
              direction: r.args[2],
              sender_pubkey: r.args[3],
              recipient_pubkey: r.args[4],
              message_type: r.args[5],
              content: r.args[6],
              nostr_event_id: r.args[7],
              created_at: new Date().toISOString()
            })) };
          }
          if (sql.includes('sender_pubkey = ?') || sql.includes('recipient_pubkey = ?')) {
            // getConversationByPubkey query
            const pubkey = args[0];
            const matching = store.filter(r =>
              r.sql.includes('INSERT') && (r.args[3] === pubkey || r.args[4] === pubkey)
            );
            if (matching.length === 0) return { results: [] };
            return { results: [{ conversation_id: matching[0].args[0] }] };
          }
          return { results: [] };
        })
      })),
      run: vi.fn(async () => ({ meta: {} }))
    }))
  };
}

describe('DM Store - computeConversationId', () => {
  it('should produce a deterministic conversation ID', () => {
    const pubkeyA = 'a'.repeat(64);
    const pubkeyB = 'b'.repeat(64);

    const id1 = computeConversationId(pubkeyA, pubkeyB);
    const id2 = computeConversationId(pubkeyA, pubkeyB);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be order-independent (swapping pubkeys gives same ID)', () => {
    const pubkeyA = 'a'.repeat(64);
    const pubkeyB = 'b'.repeat(64);

    const idAB = computeConversationId(pubkeyA, pubkeyB);
    const idBA = computeConversationId(pubkeyB, pubkeyA);

    expect(idAB).toBe(idBA);
  });

  it('should produce different IDs for different pubkey pairs', () => {
    const id1 = computeConversationId('a'.repeat(64), 'b'.repeat(64));
    const id2 = computeConversationId('a'.repeat(64), 'c'.repeat(64));

    expect(id1).not.toBe(id2);
  });
});

describe('DM Store - logDm', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should store a message and return an id', async () => {
    const result = await logDm(mockDb, {
      conversationId: 'conv123',
      sha256: 'abc'.repeat(21) + 'a',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      messageType: 'moderation_notice',
      content: 'Your video has been removed.',
      nostrEventId: null
    });

    expect(result).toHaveProperty('id');
    expect(result.id).toBeGreaterThan(0);
  });

  it('should not create duplicate when same nostr_event_id is provided', async () => {
    const eventId = 'event_' + 'x'.repeat(59);

    // First insert
    const result1 = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'First message',
      nostrEventId: eventId
    });

    expect(result1).toHaveProperty('id');

    // Second insert with same event ID should return existing
    const result2 = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'Duplicate message',
      nostrEventId: eventId
    });

    expect(result2).toHaveProperty('id');
    expect(result2.id).toBe(result1.id);
  });

  it('should allow insert without nostrEventId (no dedup check)', async () => {
    const result = await logDm(mockDb, {
      conversationId: 'conv123',
      direction: 'incoming',
      senderPubkey: 'b'.repeat(64),
      recipientPubkey: 'a'.repeat(64),
      content: 'A reply',
      nostrEventId: null
    });

    expect(result).toHaveProperty('id');
    // prepare should have been called for INSERT but not for SELECT (no dedup)
    const prepareCalls = mockDb.prepare.mock.calls;
    const selectCalls = prepareCalls.filter(c => c[0].includes('SELECT') && c[0].includes('nostr_event_id'));
    expect(selectCalls).toHaveLength(0);
  });
});

describe('DM Store - getConversations', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should return conversations ordered by latest message', async () => {
    // Insert two messages in different conversations
    await logDm(mockDb, {
      conversationId: 'conv_old',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'Older message'
    });

    await logDm(mockDb, {
      conversationId: 'conv_new',
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'c'.repeat(64),
      content: 'Newer message'
    });

    const conversations = await getConversations(mockDb);

    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations.length).toBe(2);
    // Each conversation should have required fields
    for (const conv of conversations) {
      expect(conv).toHaveProperty('conversation_id');
      expect(conv).toHaveProperty('last_message');
      expect(conv).toHaveProperty('sender_pubkey');
      expect(conv).toHaveProperty('recipient_pubkey');
    }
  });

  it('should return empty array when no conversations exist', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const conversations = await getConversations(emptyDb);
    expect(conversations).toEqual([]);
  });

  it('augments rows with participant_pubkey, latest_message, message_type when moderatorPubkey is provided', async () => {
    const moderator = '8'.repeat(64);
    const userA = 'a'.repeat(64);
    const userB = 'b'.repeat(64);

    // Incoming: user -> moderator. participant should be the user.
    await logDm(mockDb, {
      conversationId: 'conv_in',
      direction: 'incoming',
      senderPubkey: userA,
      recipientPubkey: moderator,
      messageType: 'conversation_report',
      content: 'Report from user A'
    });

    // Outgoing: moderator -> user. participant should still be the user.
    await logDm(mockDb, {
      conversationId: 'conv_out',
      direction: 'outgoing',
      senderPubkey: moderator,
      recipientPubkey: userB,
      messageType: 'moderator_reply',
      content: 'Reply to user B'
    });

    const conversations = await getConversations(mockDb, { moderatorPubkey: moderator });

    expect(conversations).toHaveLength(2);
    for (const conv of conversations) {
      // New fields the admin UI expects
      expect(conv).toHaveProperty('participant_pubkey');
      expect(conv).toHaveProperty('latest_message');
      expect(conv).toHaveProperty('message_type');
      // Participant must never be the moderator
      expect(conv.participant_pubkey).not.toBe(moderator);
      // Aliases must mirror the existing columns
      expect(conv.latest_message).toBe(conv.last_message);
      expect(conv.message_type).toBe(conv.last_message_type);
    }
  });
});

describe('DM Store - getConversation', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should return messages in chronological order', async () => {
    const convId = 'conv_thread';

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'outgoing',
      senderPubkey: 'a'.repeat(64),
      recipientPubkey: 'b'.repeat(64),
      content: 'First message'
    });

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'incoming',
      senderPubkey: 'b'.repeat(64),
      recipientPubkey: 'a'.repeat(64),
      content: 'Reply'
    });

    const messages = await getConversation(mockDb, convId);

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe('First message');
    expect(messages[1].content).toBe('Reply');
    expect(messages[0].direction).toBe('outgoing');
    expect(messages[1].direction).toBe('incoming');
  });

  it('should return empty array for unknown conversation', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const messages = await getConversation(emptyDb, 'nonexistent');
    expect(messages).toEqual([]);
  });
});

// Regression suite against the real D1 (SQLite) runtime. The mocked
// describe-blocks above fabricate getConversations() results, which would
// not have caught the implicit-aggregate collapse bug: the outer SELECT
// mixed MAX()/COUNT() with bare columns and no GROUP BY, so SQLite
// collapsed the whole filtered set into a single row. Any inbox with N>1
// conversations rendered as exactly one sidebar entry.
describe('DM Store - getConversations against real D1', () => {
  const db = env.BLOSSOM_DB;

  const MODERATOR = 'f'.repeat(64);
  const CREATOR_A = ('a'.repeat(63) + '1').slice(0, 64);
  const CREATOR_B = ('a'.repeat(63) + '2').slice(0, 64);
  const CREATOR_C = ('a'.repeat(63) + '3').slice(0, 64);

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
  });

  it('returns one row per conversation, not one aggregated row across the inbox', async () => {
    // 3 rows across 2 conversations ⇒ 2 conversations returned.
    const convA = computeConversationId(MODERATOR, CREATOR_A);
    const convB = computeConversationId(MODERATOR, CREATOR_B);

    await logDm(db, {
      conversationId: convA,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'creator A says hi',
      nostrEventId: 'evt-a-1',
    });
    await logDm(db, {
      conversationId: convA,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: CREATOR_A,
      messageType: 'moderator_reply',
      content: 'moderator replies to A',
      nostrEventId: 'evt-a-2',
    });
    await logDm(db, {
      conversationId: convB,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'creator B says hi',
      nostrEventId: 'evt-b-1',
    });

    const conversations = await getConversations(db, { limit: 20, offset: 0 });

    expect(conversations).toHaveLength(2);

    const ids = new Set(conversations.map(c => c.conversation_id));
    expect(ids).toEqual(new Set([convA, convB]));

    // Per-conversation message_count must be independent (2 for A, 1 for B).
    const counts = Object.fromEntries(
      conversations.map(c => [c.conversation_id, c.message_count]),
    );
    expect(counts[convA]).toBe(2);
    expect(counts[convB]).toBe(1);
  });

  it('last_message for each conversation reflects its own most recent row', async () => {
    const convA = computeConversationId(MODERATOR, CREATOR_A);
    const convB = computeConversationId(MODERATOR, CREATOR_B);

    await logDm(db, {
      conversationId: convA,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'first A message',
      nostrEventId: 'evt-a-1',
    });
    await logDm(db, {
      conversationId: convB,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'only B message',
      nostrEventId: 'evt-b-1',
    });
    await logDm(db, {
      conversationId: convA,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: CREATOR_A,
      messageType: 'moderator_reply',
      content: 'latest A message',
      nostrEventId: 'evt-a-2',
    });

    const conversations = await getConversations(db, { limit: 20, offset: 0 });

    expect(conversations).toHaveLength(2);
    const byConv = Object.fromEntries(conversations.map(c => [c.conversation_id, c]));
    expect(byConv[convA].last_message).toBe('latest A message');
    expect(byConv[convB].last_message).toBe('only B message');
  });

  it('respects limit and offset', async () => {
    for (const [creator, eventId, content] of [
      [CREATOR_A, 'evt-a', 'from A'],
      [CREATOR_B, 'evt-b', 'from B'],
      [CREATOR_C, 'evt-c', 'from C'],
    ]) {
      await logDm(db, {
        conversationId: computeConversationId(MODERATOR, creator),
        direction: 'incoming',
        senderPubkey: creator,
        recipientPubkey: MODERATOR,
        content,
        nostrEventId: eventId,
      });
      // Stagger so created_at orders deterministically.
      await new Promise(r => setTimeout(r, 15));
    }

    const page1 = await getConversations(db, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await getConversations(db, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
  });

  it('returns an empty array when dm_log is empty', async () => {
    const conversations = await getConversations(db, { limit: 20, offset: 0 });
    expect(conversations).toEqual([]);
  });
});

describe('DM Store - getConversationByPubkey', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it('should find conversation by participant pubkey', async () => {
    const senderPubkey = 'a'.repeat(64);
    const recipientPubkey = 'b'.repeat(64);
    const convId = computeConversationId(senderPubkey, recipientPubkey);

    await logDm(mockDb, {
      conversationId: convId,
      direction: 'outgoing',
      senderPubkey,
      recipientPubkey,
      content: 'Hello there'
    });

    const messages = await getConversationByPubkey(mockDb, recipientPubkey);

    expect(messages).not.toBeNull();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toBe('Hello there');
  });

  it('should return null when pubkey has no conversations', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn((...args) => ({
          all: vi.fn(async () => ({ results: [] }))
        }))
      }))
    };

    const result = await getConversationByPubkey(emptyDb, 'z'.repeat(64));
    expect(result).toBeNull();
  });
});

describe('DM Store - getConversationByPubkey against real D1', () => {
  const db = env.BLOSSOM_DB;
  const MODERATOR = 'f'.repeat(64);
  const CREATOR = ('a'.repeat(63) + '1').slice(0, 64);

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
  });

  it('resolves the thread via the deterministic conversation id (moderator-aware fast path)', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi from creator',
      nostrEventId: 'evt-1',
    });
    await logDm(db, {
      conversationId,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: CREATOR,
      content: 'moderator reply',
      nostrEventId: 'evt-2',
    });

    // Look up by the creator pubkey with the moderator known — must resolve the
    // same conversation without touching sender_pubkey (the unindexed OR path).
    const messages = await getConversationByPubkey(db, CREATOR, MODERATOR);
    expect(messages).not.toBeNull();
    expect(messages.map((m) => m.content)).toEqual(['hi from creator', 'moderator reply']);
  });

  it('returns null for a participant with no conversation (fast path)', async () => {
    const messages = await getConversationByPubkey(db, 'd'.repeat(64), MODERATOR);
    expect(messages).toBeNull();
  });
});
