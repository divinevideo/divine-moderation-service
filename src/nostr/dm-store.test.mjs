// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM conversation storage (dm-store.mjs)
// ABOUTME: Verifies D1-backed message logging, dedup, and conversation queries

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { computeConversationId, ensureDmLogExcerptColumn, logDm, getConversations, getConversation, getConversationByPubkey, getConversationState, getFilterCounts, initDmLogTable, markConversationRead, markNoReplyNeeded, clearNoReplyNeeded, pruneExpiredDmLog, CONVERSATION_FILTERS } from './dm-store.mjs';

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
      // Small gap between inserts. Note created_at is CURRENT_TIMESTAMP at
      // 1-second resolution, so these rows usually share a last_message_at;
      // deterministic ordering comes from the `dl.id DESC` tiebreaker in the
      // query, not from this stagger. The assertions below only check page
      // sizes, which hold regardless of intra-second tie order.
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
  const OTHER = ('b'.repeat(63) + '1').slice(0, 64);

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

  it('uses the most recently updated matching conversation in the legacy fallback', async () => {
    const olderConversationId = computeConversationId(CREATOR, OTHER);
    const newerConversationId = computeConversationId(MODERATOR, CREATOR);

    await logDm(db, {
      conversationId: olderConversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: OTHER,
      content: 'older unrelated conversation',
      nostrEventId: 'evt-fallback-older',
    });
    await logDm(db, {
      conversationId: newerConversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'newer moderator conversation',
      nostrEventId: 'evt-fallback-newer',
    });

    const messages = await getConversationByPubkey(db, CREATOR);

    expect(messages).not.toBeNull();
    expect(messages.map((m) => m.content)).toEqual(['newer moderator conversation']);
  });
});

// Regression suite for the unread badge (divine-mobile#6593): prior to this
// change, admin/dashboard.html and admin/messages.html read `conv.unread` /
// `conv.has_unread`, fields getConversations() never produced -- the badge
// was structurally always empty. These tests run against real D1 so the
// SQL CASE/JOIN logic (and the timestamp-format hazard called out in
// migrations/012-dm-read-state.sql -- read_at and created_at must both be
// generated via SQLite CURRENT_TIMESTAMP to stay comparably ordered) is
// verified for real, not against a hand-rolled mock that could silently
// drift from actual SQLite semantics.
describe('DM Store - unread / markConversationRead against real D1', () => {
  const db = env.BLOSSOM_DB;

  const MODERATOR = 'f'.repeat(64);
  const CREATOR = ('a'.repeat(63) + '1').slice(0, 64);
  const OTHER_CREATOR = ('a'.repeat(63) + '2').slice(0, 64);

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM dm_conversation_read_state').run();
    await db.prepare('DELETE FROM dm_conversation_reply_state').run();
  });

  async function backdateMessage(nostrEventId, timestamp) {
    await db.prepare('UPDATE dm_log SET created_at = ? WHERE nostr_event_id = ?').bind(timestamp, nostrEventId).run();
  }

  async function unreadFor(conversationId) {
    const conversations = await getConversations(db, { limit: 20, offset: 0 });
    return conversations.find((c) => c.conversation_id === conversationId).unread;
  }

  it('a fresh conversation with an incoming message and no read state is unread', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi',
      nostrEventId: 'evt-1',
    });

    expect(await unreadFor(conversationId)).toBe(1);
  });

  it('markConversationRead clears unread for a message sent before the mark', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi',
      nostrEventId: 'evt-1',
    });
    await backdateMessage('evt-1', '2000-01-01 00:00:00');

    await markConversationRead(db, conversationId);

    expect(await unreadFor(conversationId)).toBe(0);
  });

  it('a new incoming message after markConversationRead flips the conversation unread again', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'first',
      nostrEventId: 'evt-1',
    });
    await backdateMessage('evt-1', '2000-01-01 00:00:00');
    await markConversationRead(db, conversationId);
    expect(await unreadFor(conversationId)).toBe(0);

    // A message that arrives after the mark-read timestamp must flip the
    // conversation back to unread -- this is the exact comparison this
    // suite exists to pin: read_at and created_at share the same
    // CURRENT_TIMESTAMP-generated text format, so `>` compares correctly
    // regardless of which side is "later" in wall-clock terms.
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'second, after read',
      nostrEventId: 'evt-2',
    });
    await backdateMessage('evt-2', '2099-01-01 00:00:00');

    expect(await unreadFor(conversationId)).toBe(1);
  });

  it('a conversation with only an outgoing message (moderator sent first) is never unread', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: CREATOR,
      messageType: 'moderator_reply',
      content: 'starting a conversation',
      nostrEventId: 'evt-1',
    });

    expect(await unreadFor(conversationId)).toBe(0);
  });

  it('the moderators own reply after marking read does not flip the conversation back to unread', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi',
      nostrEventId: 'evt-1',
    });
    await backdateMessage('evt-1', '2000-01-01 00:00:00');
    await markConversationRead(db, conversationId);
    expect(await unreadFor(conversationId)).toBe(0);

    // Moderator's own reply, timestamped after the mark-read point --
    // must NOT flip unread, or a moderator would see their own inbox as
    // unread immediately after replying.
    await logDm(db, {
      conversationId,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: CREATOR,
      messageType: 'moderator_reply',
      content: 'here is my reply',
      nostrEventId: 'evt-2',
    });
    await backdateMessage('evt-2', '2099-01-01 00:00:00');

    expect(await unreadFor(conversationId)).toBe(0);
  });

  it('unread state is independent per conversation', async () => {
    const readConvId = computeConversationId(MODERATOR, CREATOR);
    const unreadConvId = computeConversationId(MODERATOR, OTHER_CREATOR);

    await logDm(db, {
      conversationId: readConvId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi from creator',
      nostrEventId: 'evt-read',
    });
    await backdateMessage('evt-read', '2000-01-01 00:00:00');
    await markConversationRead(db, readConvId);

    await logDm(db, {
      conversationId: unreadConvId,
      direction: 'incoming',
      senderPubkey: OTHER_CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi from other creator',
      nostrEventId: 'evt-unread',
    });

    expect(await unreadFor(readConvId)).toBe(0);
    expect(await unreadFor(unreadConvId)).toBe(1);
  });

  it('markConversationRead is safe to call on a conversation with no messages', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await expect(markConversationRead(db, conversationId)).resolves.not.toThrow();
  });

  it('markConversationRead does not move read_at backwards on a second call', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR,
      recipientPubkey: MODERATOR,
      content: 'hi',
      nostrEventId: 'evt-1',
    });

    await markConversationRead(db, conversationId);
    // The exact value isn't asserted (CURRENT_TIMESTAMP has 1s resolution),
    // only that the first call inserted a row for the upsert to conflict on.
    const firstRow = await db.prepare('SELECT read_at FROM dm_conversation_read_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(firstRow.read_at).toBeTruthy();

    // Simulate an out-of-order retry carrying an earlier read_at than what's
    // already stored -- the WHERE guard in markConversationRead's upsert
    // must leave the newer stored value alone rather than regressing it.
    await db.prepare('UPDATE dm_conversation_read_state SET read_at = ? WHERE conversation_id = ?').bind('2099-01-01 00:00:00', conversationId).run();
    await markConversationRead(db, conversationId);
    const secondReadAt = (await db.prepare('SELECT read_at FROM dm_conversation_read_state WHERE conversation_id = ?').bind(conversationId).first()).read_at;

    expect(secondReadAt).toBe('2099-01-01 00:00:00');
  });
});

describe('DM Store - pruneExpiredDmLog against real D1', () => {
  const db = env.BLOSSOM_DB;

  const MODERATOR = 'f'.repeat(64);
  const CREATOR_A = ('a'.repeat(63) + '1').slice(0, 64);
  const CREATOR_B = ('a'.repeat(63) + '2').slice(0, 64);

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM dm_conversation_read_state').run();
  });

  async function backdateMessage(nostrEventId, timestamp) {
    await db.prepare('UPDATE dm_log SET created_at = ? WHERE nostr_event_id = ?').bind(timestamp, nostrEventId).run();
  }

  it('deletes a dm_log row older than one year and keeps a recent one', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_A);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old',
    });
    await backdateMessage('evt-old', '2000-01-01 00:00:00');
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'fresh',
      nostrEventId: 'evt-new',
    });

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedMessages).toBe(1);
    const remaining = await db.prepare('SELECT nostr_event_id FROM dm_log').all();
    expect(remaining.results.map((r) => r.nostr_event_id)).toEqual(['evt-new']);
  });

  it('deletes the read-state row for a conversation whose only message expired', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_A);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old',
    });
    await backdateMessage('evt-old', '2000-01-01 00:00:00');
    await markConversationRead(db, conversationId);

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedReadStates).toBe(1);
    const readState = await db.prepare('SELECT * FROM dm_conversation_read_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(readState).toBeNull();
  });

  it('keeps the read-state row for a conversation that still has a non-expired message', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_B);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old-2',
    });
    await backdateMessage('evt-old-2', '2000-01-01 00:00:00');
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'fresh',
      nostrEventId: 'evt-new-2',
    });
    await markConversationRead(db, conversationId);

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedMessages).toBe(1);
    expect(result.deletedReadStates).toBe(0);
    const readState = await db.prepare('SELECT * FROM dm_conversation_read_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(readState).not.toBeNull();
  });

  it('is a no-op when nothing has expired', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_A);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'fresh',
      nostrEventId: 'evt-new-3',
    });

    const result = await pruneExpiredDmLog(db);

    expect(result).toEqual({ deletedMessages: 0, deletedReadStates: 0, deletedReplyStates: 0 });
    const remaining = await db.prepare('SELECT COUNT(*) AS n FROM dm_log').first();
    expect(remaining.n).toBe(1);
  });

  it('deletes the reply-state row for a conversation whose only message expired', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_A);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old-r1',
    });
    await backdateMessage('evt-old-r1', '2000-01-01 00:00:00');
    await markNoReplyNeeded(db, conversationId);

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedReplyStates).toBe(1);
    const row = await db.prepare('SELECT * FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(row).toBeNull();
  });

  it('keeps the reply-state row for a conversation with a surviving message', async () => {
    const conversationId = computeConversationId(MODERATOR, CREATOR_B);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old-r2',
    });
    await backdateMessage('evt-old-r2', '2000-01-01 00:00:00');
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_B,
      recipientPubkey: MODERATOR,
      content: 'fresh',
      nostrEventId: 'evt-new-r2',
    });
    await markNoReplyNeeded(db, conversationId);

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedReplyStates).toBe(0);
    const row = await db.prepare('SELECT * FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(row).not.toBeNull();
  });

  it('runs when neither state table exists yet', async () => {
    // CI deploys on merge without applying migrations, so the retention sweep
    // can be the first thing to touch these tables on a fresh environment.
    const conversationId = computeConversationId(MODERATOR, CREATOR_A);
    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: CREATOR_A,
      recipientPubkey: MODERATOR,
      content: 'ancient',
      nostrEventId: 'evt-old-r3',
    });
    await backdateMessage('evt-old-r3', '2000-01-01 00:00:00');
    await db.prepare('DROP TABLE dm_conversation_read_state').run();
    await db.prepare('DROP TABLE dm_conversation_reply_state').run();

    const result = await pruneExpiredDmLog(db);

    expect(result.deletedMessages).toBe(1);
    const remaining = await db.prepare('SELECT COUNT(*) AS n FROM dm_log').first();
    expect(remaining.n).toBe(0);
  });
});

describe('DM Store - no reply needed against real D1', () => {
  const db = env.BLOSSOM_DB;
  const conversationId = computeConversationId('f'.repeat(64), 'a'.repeat(64));

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM dm_conversation_read_state').run();
    await db.prepare('DELETE FROM dm_conversation_reply_state').run();
  });

  async function markValue() {
    const row = await db.prepare('SELECT no_reply_needed_at FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(conversationId).first();
    return row ? row.no_reply_needed_at : null;
  }

  it('markNoReplyNeeded writes a CURRENT_TIMESTAMP-format mark', async () => {
    await markNoReplyNeeded(db, conversationId);
    expect(await markValue()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('markNoReplyNeeded does not move the mark backwards', async () => {
    await markNoReplyNeeded(db, conversationId);
    await db.prepare('UPDATE dm_conversation_reply_state SET no_reply_needed_at = ? WHERE conversation_id = ?').bind('2999-01-01 00:00:00', conversationId).run();

    await markNoReplyNeeded(db, conversationId);

    expect(await markValue()).toBe('2999-01-01 00:00:00');
  });

  it('clearNoReplyNeeded removes the mark', async () => {
    await markNoReplyNeeded(db, conversationId);
    await clearNoReplyNeeded(db, conversationId);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(conversationId).first();
    expect(count.n).toBe(0);
  });

  it('clearNoReplyNeeded is safe on a conversation with no row', async () => {
    await expect(clearNoReplyNeeded(db, conversationId)).resolves.toBeUndefined();
  });

  it('initDmLogTable creates dm_conversation_reply_state', async () => {
    await db.prepare('DROP TABLE dm_conversation_reply_state').run();
    await initDmLogTable(db);
    const row = await db.prepare(`SELECT name FROM sqlite_master WHERE name = 'dm_conversation_reply_state'`).first();
    expect(row).not.toBeNull();
  });
});

// A reporter can include the message they are reporting (divine-mobile#7340).
// It lives in its own dm_log column, so production's existing table needs the
// column added in code: CI deploys on merge but never applies migrations/.
describe('DM Store - unverified excerpt column against real D1', () => {
  const db = env.BLOSSOM_DB;
  const MODERATOR = 'f'.repeat(64);
  const REPORTER = ('a'.repeat(63) + '1').slice(0, 64);

  // dm_log exactly as migrations/003-dm-support.sql created it in production.
  async function createPreExcerptDmLog() {
    await db.prepare('DROP TABLE IF EXISTS dm_log').run();
    await db.prepare(`
      CREATE TABLE dm_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        sha256 TEXT,
        direction TEXT NOT NULL,
        sender_pubkey TEXT NOT NULL,
        recipient_pubkey TEXT NOT NULL,
        message_type TEXT,
        content TEXT NOT NULL,
        nostr_event_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  async function dmLogColumns() {
    const { results } = await db.prepare('PRAGMA table_info(dm_log)').all();
    return results.map((column) => column.name);
  }

  it('adds the column to a dm_log created before it existed, and is safe to run again', async () => {
    await createPreExcerptDmLog();
    expect(await dmLogColumns()).not.toContain('unverified_excerpt');

    await ensureDmLogExcerptColumn(db);
    await ensureDmLogExcerptColumn(db);

    expect(await dmLogColumns()).toContain('unverified_excerpt');
  });

  // The cron sync and a moderator's Refresh can both run the first sync after
  // a deploy. Both read the schema before either alters it, so the slower one
  // hits a column the faster one just added; that must not fail its sync.
  it('tolerates another sync adding the column between its check and its ALTER', async () => {
    await createPreExcerptDmLog();
    const { results: staleColumns } = await db.prepare('PRAGMA table_info(dm_log)').all();
    await ensureDmLogExcerptColumn(db); // the other sync wins the race
    const racingDb = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (sql.startsWith('PRAGMA table_info(dm_log)')) {
          return { all: async () => ({ results: staleColumns }) };
        }
        return statement;
      },
    };

    await expect(ensureDmLogExcerptColumn(racingDb)).resolves.toBeUndefined();
    expect(await dmLogColumns()).toContain('unverified_excerpt');
  });

  it('still surfaces an ALTER failure that is not the race', async () => {
    const brokenDb = {
      prepare(sql) {
        if (sql.startsWith('PRAGMA')) return { all: async () => ({ results: [] }) };
        return { run: async () => { throw new Error('D1_ERROR: no such table: dm_log'); } };
      },
    };

    await expect(ensureDmLogExcerptColumn(brokenDb)).rejects.toThrow('no such table');
  });

  it('initDmLogTable creates a table that already has the column', async () => {
    await db.prepare('DROP TABLE IF EXISTS dm_log').run();
    await initDmLogTable(db);
    expect(await dmLogColumns()).toContain('unverified_excerpt');
  });

  it('stores the excerpt apart from the content and returns it with the thread', async () => {
    await db.prepare('DROP TABLE IF EXISTS dm_log').run();
    await initDmLogTable(db);
    const conversationId = computeConversationId(MODERATOR, REPORTER);

    await logDm(db, {
      conversationId,
      direction: 'incoming',
      senderPubkey: REPORTER,
      recipientPubkey: MODERATOR,
      messageType: 'conversation_report',
      content: 'DM Message Report\nReason: Harassment',
      unverifiedExcerpt: 'you will regret this',
      nostrEventId: 'evt-excerpt',
    });

    const [row] = await getConversation(db, conversationId);
    expect(row.content).toBe('DM Message Report\nReason: Harassment');
    expect(row.unverified_excerpt).toBe('you will regret this');
  });

  // dm-sender's logDm calls (moderator notices and replies) run on paths that
  // never ensure the column. A message without an excerpt must not name it,
  // or every one of those writes would fail until the DM reader next ran.
  it('logs a message without an excerpt into a dm_log that lacks the column', async () => {
    await createPreExcerptDmLog();
    const conversationId = computeConversationId(MODERATOR, REPORTER);

    const result = await logDm(db, {
      conversationId,
      direction: 'outgoing',
      senderPubkey: MODERATOR,
      recipientPubkey: REPORTER,
      messageType: 'moderator_reply',
      content: 'Thanks, we are looking into it.',
      nostrEventId: 'evt-no-excerpt',
    });

    expect(result.id).toBeGreaterThan(0);
    const [row] = await getConversation(db, conversationId);
    expect(row.content).toBe('Thanks, we are looking into it.');
    expect(row).not.toHaveProperty('unverified_excerpt');
  });
});

describe('DM Store - conversation filters against real D1', () => {
  const db = env.BLOSSOM_DB;

  const MODERATOR = 'f'.repeat(64);
  const creator = (n) => 'a'.repeat(62) + String(n).padStart(2, '0');
  const convFor = (n) => computeConversationId(MODERATOR, creator(n));

  beforeEach(async () => {
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM dm_conversation_read_state').run();
    await db.prepare('DELETE FROM dm_conversation_reply_state').run();
  });

  // Log one message, then pin its created_at: logDm always stamps
  // CURRENT_TIMESTAMP, and these tests are about timestamps.
  async function seed(conv, sender, recipient, direction, messageType, createdAt, eventId) {
    await logDm(db, {
      conversationId: conv,
      direction,
      senderPubkey: sender,
      recipientPubkey: recipient,
      messageType,
      content: `${messageType} ${eventId}`,
      nostrEventId: eventId,
    });
    await db.prepare('UPDATE dm_log SET created_at = ? WHERE nostr_event_id = ?').bind(createdAt, eventId).run();
  }

  // A timestamp N days before D1's own clock, in CURRENT_TIMESTAMP format.
  async function recent(daysAgo) {
    const row = await db.prepare(`SELECT datetime('now', ?) AS t`).bind(`-${daysAgo} days`).first();
    return row.t;
  }

  // Shorthands over seed() for the two sides of a conversation.
  const fromCreator = (n, messageType, createdAt, eventId) =>
    seed(convFor(n), creator(n), MODERATOR, 'incoming', messageType, createdAt, eventId);
  const fromUs = (n, messageType, createdAt, eventId) =>
    seed(convFor(n), MODERATOR, creator(n), 'outgoing', messageType, createdAt, eventId);

  async function idsFor(filter) {
    const rows = await getConversations(db, { limit: 100, offset: 0, filter });
    return rows.map((row) => row.conversation_id);
  }

  async function rowFor(conversationId) {
    const rows = await getConversations(db, { limit: 100, offset: 0 });
    return rows.find((row) => row.conversation_id === conversationId);
  }

  it('a creator_reply one second before the cutoff is not a typed row', async () => {
    await fromCreator(1, 'creator_reply', '2026-08-12 23:59:59', 'e1');
    expect(await idsFor('person')).not.toContain(convFor(1));
  });

  it('a creator_reply at the cutoff is a typed row', async () => {
    await fromCreator(1, 'creator_reply', '2026-08-13 00:00:00', 'e1');
    expect(await idsFor('person')).toContain(convFor(1));
  });

  it('automated messages after a typed row do not clear waiting', async () => {
    const automated = ['moderation_notice', 'report_outcome', 'community_warning'];
    for (const [i, messageType] of automated.entries()) {
      await fromCreator(i + 1, 'creator_reply', await recent(2), `typed-${i}`);
      await fromUs(i + 1, messageType, await recent(1), `auto-${i}`);
    }

    const waiting = await idsFor('waiting');
    const withModerator = await getConversations(db, { limit: 100, offset: 0, moderatorPubkey: MODERATOR });
    for (const n of [1, 2, 3]) {
      expect(waiting).toContain(convFor(n));
      expect((await rowFor(convFor(n))).waiting).toBe(true);
      expect(withModerator.find((row) => row.conversation_id === convFor(n)).waiting).toBe(true);
    }
  });

  it('an outgoing moderator_reply after the typed row clears waiting, and a later typed row restores it', async () => {
    await fromCreator(1, 'creator_reply', await recent(3), 'typed-1');
    await fromUs(1, 'moderator_reply', await recent(2), 'reply-1');

    expect(await idsFor('waiting')).not.toContain(convFor(1));
    expect((await rowFor(convFor(1))).waiting).toBe(false);

    await fromCreator(1, 'creator_reply', await recent(1), 'typed-2');

    expect(await idsFor('waiting')).toContain(convFor(1));
    expect((await rowFor(convFor(1))).waiting).toBe(true);
  });

  it('a typed row 31 days old is not waiting; 29 days old is', async () => {
    await fromCreator(1, 'creator_reply', await recent(31), 'old');
    await fromCreator(2, 'creator_reply', await recent(29), 'young');

    const waiting = await idsFor('waiting');
    expect(waiting).not.toContain(convFor(1));
    expect(waiting).toContain(convFor(2));
    // Still "a person wrote", just outside the window.
    expect(await idsFor('person')).toContain(convFor(1));
  });

  it('a typed row in the same second as the reply is not waiting', async () => {
    const sameSecond = await recent(1);
    await fromCreator(1, 'creator_reply', sameSecond, 'typed');
    await fromUs(1, 'moderator_reply', sameSecond, 'reply');

    expect(await idsFor('waiting')).not.toContain(convFor(1));
  });

  it('no reply needed clears waiting; a later typed row restores it; clearNoReplyNeeded restores it', async () => {
    const conv = convFor(1);
    await fromCreator(1, 'creator_reply', await recent(3), 'typed-1');
    expect(await idsFor('waiting')).toContain(conv);

    await markNoReplyNeeded(db, conv);
    expect(await idsFor('waiting')).not.toContain(conv);

    // Pretend the mark was made two days ago, so a typed row after it can exist.
    await db.prepare('UPDATE dm_conversation_reply_state SET no_reply_needed_at = ? WHERE conversation_id = ?').bind(await recent(2), conv).run();
    await fromCreator(1, 'creator_reply', await recent(1), 'typed-2');
    expect(await idsFor('waiting')).toContain(conv);

    await markNoReplyNeeded(db, conv);
    expect(await idsFor('waiting')).not.toContain(conv);

    await clearNoReplyNeeded(db, conv);
    expect(await idsFor('waiting')).toContain(conv);
  });

  it('reports / notices / outcomes / warnings match conversations that ever contained that type', async () => {
    const cases = [
      ['reports', 'conversation_report', fromCreator],
      ['notices', 'moderation_notice', fromUs],
      ['outcomes', 'report_outcome', fromUs],
      ['warnings', 'community_warning', fromUs],
    ];
    for (const [i, [, messageType, from]] of cases.entries()) {
      const n = i + 1;
      await from(n, messageType, await recent(5), `early-${n}`);
      await fromCreator(n, 'creator_reply', await recent(1), `later-${n}`);
    }
    // A conversation with none of the four types.
    await fromCreator(9, 'creator_reply', await recent(1), 'plain');

    for (const [i, [filter]] of cases.entries()) {
      const n = i + 1;
      expect(await idsFor(filter), filter).toEqual([convFor(n)]);
      // The matching type is not the latest message.
      expect((await rowFor(convFor(n))).last_message_type).toBe('creator_reply');
    }
  });

  it('rows carry the latest typed message even when an automated message came later', async () => {
    const typedAt = await recent(4);
    await fromCreator(1, 'creator_reply', typedAt, 'typed');
    await fromUs(1, 'moderation_notice', await recent(3), 'notice');

    const row = await rowFor(convFor(1));
    expect(row.last_message).toBe('moderation_notice notice');
    expect(row.last_typed_message).toBe('creator_reply typed');
    expect(row.last_typed_at).toBe(typedAt);
  });

  it('last_typed_message is null when the conversation has no typed row since the cutoff', async () => {
    await fromCreator(1, 'creator_reply', '2026-08-12 23:59:59', 'pre-cutoff');
    await fromUs(2, 'moderation_notice', await recent(2), 'notice');

    for (const n of [1, 2]) {
      const row = await rowFor(convFor(n));
      expect(row.last_typed_message).toBeNull();
      expect(row.last_typed_at).toBeNull();
    }
  });

  it('the latest of several typed rows wins', async () => {
    await fromCreator(1, 'creator_reply', await recent(5), 'first');
    await fromCreator(1, 'creator_reply', await recent(2), 'second');
    await fromUs(1, 'moderation_notice', await recent(1), 'notice');

    expect((await rowFor(convFor(1))).last_typed_message).toBe('creator_reply second');
  });

  it('no filter returns every conversation, unchanged order', async () => {
    await fromCreator(1, 'creator_reply', '2026-10-01 10:00:00', 'c1');
    await fromCreator(2, 'conversation_report', '2026-10-03 10:00:00', 'c2');
    await fromUs(3, 'moderation_notice', '2026-10-02 10:00:00', 'c3');
    // Same second as conversation 3, logged later: the id DESC tiebreaker puts it first.
    await fromCreator(4, 'creator_reply', '2026-10-02 10:00:00', 'c4');

    const expected = [convFor(2), convFor(4), convFor(3), convFor(1)];
    expect(await idsFor(undefined)).toEqual(expected);
    const omitted = await getConversations(db, { limit: 100, offset: 0 });
    expect(omitted.map((row) => row.conversation_id)).toEqual(expected);
  });

  it('getConversations throws on an unknown filter', async () => {
    await expect(getConversations(db, { filter: 'bogus' })).rejects.toThrow('Unknown conversation filter: bogus');
  });

  it('counts equal paged results for every filter', async () => {
    await fromCreator(1, 'creator_reply', await recent(1), 'c1'); // waiting, person
    await fromCreator(2, 'creator_reply', await recent(3), 'c2-typed'); // person (replied)
    await fromUs(2, 'moderator_reply', await recent(2), 'c2-reply');
    await fromCreator(3, 'conversation_report', await recent(4), 'c3'); // reports
    await fromUs(4, 'moderation_notice', await recent(4), 'c4'); // notices
    await fromUs(5, 'report_outcome', await recent(4), 'c5-outcome'); // outcomes, waiting, person
    await fromCreator(5, 'creator_reply', await recent(1), 'c5-typed');
    await fromUs(6, 'community_warning', await recent(4), 'c6'); // warnings
    await fromCreator(7, 'creator_reply', '2026-08-01 00:00:00', 'c7'); // none: before the cutoff
    await fromCreator(8, 'creator_reply', await recent(2), 'c8'); // person, marked no reply needed
    await markNoReplyNeeded(db, convFor(8));

    const counts = await getFilterCounts(db);
    expect(counts).toEqual({ all: 8, waiting: 2, person: 4, reports: 1, notices: 1, outcomes: 1, warnings: 1 });

    async function pagedLength(filter) {
      let total = 0;
      for (let offset = 0; ; offset += 2) {
        const page = await getConversations(db, { limit: 2, offset, filter });
        total += page.length;
        if (page.length < 2) return total;
      }
    }

    expect(await pagedLength(undefined)).toBe(counts.all);
    for (const filter of CONVERSATION_FILTERS) {
      expect(await pagedLength(filter), filter).toBe(counts[filter]);
    }
  });

  it('getFilterCounts is all zeros on an empty dm_log', async () => {
    expect(await getFilterCounts(db)).toEqual({ all: 0, waiting: 0, person: 0, reports: 0, notices: 0, outcomes: 0, warnings: 0 });
  });

  it('markNoReplyNeeded through a seen message leaves a typed message logged after it waiting', async () => {
    const seenAt = await recent(2);
    const unseenAt = await recent(1);
    await fromCreator(1, 'creator_reply', seenAt, 'seen');
    await fromCreator(1, 'creator_reply', unseenAt, 'unseen');
    const idOf = async (eventId) =>
      (await db.prepare('SELECT id FROM dm_log WHERE nostr_event_id = ?').bind(eventId).first()).id;
    const justBefore = (await db.prepare(`SELECT datetime(?, '-1 second') AS t`).bind(unseenAt).first()).t;

    await markNoReplyNeeded(db, convFor(1), { seenThroughId: await idOf('seen') });
    expect(await getConversationState(db, convFor(1))).toEqual({ waiting: true, no_reply_needed_at: justBefore });

    await markNoReplyNeeded(db, convFor(1), { seenThroughId: await idOf('unseen') });
    expect((await getConversationState(db, convFor(1))).waiting).toBe(false);
  });

  it('getConversationState for a conversation with no rows', async () => {
    expect(await getConversationState(db, convFor(1))).toEqual({ waiting: false, no_reply_needed_at: null });
  });

  it('getConversationState agrees with the row\'s waiting flag', async () => {
    await fromCreator(1, 'creator_reply', await recent(1), 'c1');
    await fromCreator(2, 'creator_reply', await recent(1), 'c2');
    await markNoReplyNeeded(db, convFor(2));
    const mark = await db.prepare('SELECT no_reply_needed_at FROM dm_conversation_reply_state WHERE conversation_id = ?').bind(convFor(2)).first();

    expect(await getConversationState(db, convFor(1))).toEqual({ waiting: true, no_reply_needed_at: null });
    expect((await rowFor(convFor(1))).waiting).toBe(true);

    expect(await getConversationState(db, convFor(2))).toEqual({ waiting: false, no_reply_needed_at: mark.no_reply_needed_at });
    expect((await rowFor(convFor(2))).waiting).toBe(false);
  });
});
