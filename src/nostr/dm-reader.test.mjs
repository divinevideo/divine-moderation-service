// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM inbox reader module (dm-reader.mjs)
// ABOUTME: Verifies pubkey derivation, inbox sync behavior, and error handling

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { getModeratorPubkey, processRumor } from './dm-reader.mjs';
import { initDmLogTable } from './dm-store.mjs';
import { initReportsTable } from '../reports.mjs';

// Generate a stable test key in hex format (matching production usage)
const testSecretKey = generateSecretKey();
const testHex = bytesToHex(testSecretKey);
const testPubkey = getPublicKey(testSecretKey);

describe('DM Reader - getModeratorPubkey', () => {
  it('should derive correct pubkey from hex private key', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const pubkey = getModeratorPubkey(env);
    expect(pubkey).toBe(testPubkey);
  });

  it('should throw when NOSTR_PRIVATE_KEY is missing', () => {
    expect(() => getModeratorPubkey({})).toThrow('NOSTR_PRIVATE_KEY not configured');
  });

  it('should throw for invalid hex', () => {
    expect(() => getModeratorPubkey({ NOSTR_PRIVATE_KEY: 'not-valid-hex' })).toThrow();
  });

  it('should return a 64-character hex string', () => {
    const env = { NOSTR_PRIVATE_KEY: testHex };
    const pubkey = getModeratorPubkey(env);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Regression suite for processRumor -- the classify/persist logic
// syncInbox delegates to per gift-wrap. Prior to divine-mobile#6593, this
// logic (deciding whether an incoming DM becomes a user_reports row) had
// zero test coverage anywhere in this repo. These tests pin the tag-based
// contract that replaced the never-produced JSON-content-based one (see
// the issue and its linked plan for the full cross-repo investigation).
//
// processRumor operates on an already-decrypted rumor object, so these
// tests construct that object directly -- no relay connection or NIP-17
// gift-wrap crypto round-trip needed to exercise the classify logic
// itself (that round-trip is exercised by production traffic and by
// nostr-tools' own test suite, not re-proven here).
describe('DM Reader - processRumor classify logic (real D1)', () => {
  const db = env.BLOSSOM_DB;
  const MODERATOR = ('f'.repeat(63) + '1').slice(0, 64);
  const REPORTER = ('a'.repeat(63) + '1').slice(0, 64);
  const RECIPIENT = ('b'.repeat(63) + '1').slice(0, 64);
  const SHA256 = ('c'.repeat(63) + '1').slice(0, 64);

  beforeEach(async () => {
    await initDmLogTable(db);
    await initReportsTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM user_reports').run();
  });

  function makeRumor({ pubkey, tags, content }) {
    return { pubkey, tags, content, created_at: Math.floor(Date.now() / 1000) };
  }

  it('a rumor carrying [sha256, x] and [report_type, y] tags creates a user_reports row with those values', async () => {
    const proseContent = 'Content Report\nReason: Spam or Unwanted Content\nEvent: ' + 'e'.repeat(64);
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'spam']],
      content: proseContent,
    });

    const outcome = await processRumor(rumor, 'evt-1', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('conversation_report');
    expect(dmRow.sha256).toBe(SHA256);
    expect(dmRow.content).toBe(proseContent); // content stays the human-readable prose, unchanged

    const reportRow = await db.prepare('SELECT * FROM user_reports').first();
    expect(reportRow).toBeTruthy();
    expect(reportRow.sha256).toBe(SHA256);
    expect(reportRow.reporter_pubkey).toBe(REPORTER);
    expect(reportRow.report_type).toBe('spam');
    expect(reportRow.reason).toBe(proseContent);
  });

  it('a rumor with report_type but no sha256 (a user report or DM-message report) is still badged as a report, without a user_reports row', async () => {
    // user_reports.sha256 is NOT NULL, so these two report variants can
    // never become a report row -- but they are still reports, and the
    // admin Messages UI's badge comes from message_type. Classifying them
    // as creator_reply would hide them among ordinary chat replies.
    const proseContent = 'User Report\nReason: Impersonation\nUser Pubkey: ' + 'b'.repeat(64);
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['report_type', 'impersonation']],
      content: proseContent,
    });

    const outcome = await processRumor(rumor, 'evt-2', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('conversation_report');
    expect(dmRow.sha256).toBeNull();
    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(0);
  });

  it('an empty-string report_type tag is treated as absent, so an ordinary reply is not badged as a report', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['report_type', '']],
      content: 'just a normal reply',
    });

    const outcome = await processRumor(rumor, 'evt-2b', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('creator_reply');
  });

  it('a rumor with no tags at all (e.g. an ordinary chat reply) classifies as creator_reply, unchanged from before #6593', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR]],
      content: 'hey, following up on my last message',
    });

    const outcome = await processRumor(rumor, 'evt-3', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('creator_reply');
    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(0);
  });

  it('an empty-string sha256 tag is treated as absent, not inserted as a blank report', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', '']],
      content: 'Content Report',
    });

    const outcome = await processRumor(rumor, 'evt-4', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('creator_reply');
    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(0);
  });

  it('an outgoing self-copy carrying a sha256 tag never creates a user_reports row (reporter is the counterparty, not the moderator)', async () => {
    // Outgoing self-copy: rumor.pubkey === moderator, with a non-moderator
    // p tag identifying the real recipient -- the exact shape processRumor
    // detects via isOutgoing.
    const rumor = makeRumor({
      pubkey: MODERATOR,
      tags: [['p', RECIPIENT], ['sha256', SHA256]],
      content: 'moderator reply text',
    });

    const outcome = await processRumor(rumor, 'evt-5', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.direction).toBe('outgoing');
    expect(dmRow.message_type).toBe('conversation_report'); // dm_log still reflects the tag...
    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(0); // ...but user_reports is skipped for self-copies
  });

  it('an outgoing rumor with no resolvable non-moderator p tag returns null (malformed, counted as an error upstream)', async () => {
    const rumor = makeRumor({
      pubkey: MODERATOR,
      tags: [['p', MODERATOR]], // only the moderator itself -- no real recipient
      content: 'malformed self-copy',
    });

    const outcome = await processRumor(rumor, 'evt-6', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBeNull();
    const dmRows = await db.prepare('SELECT * FROM dm_log').all();
    expect(dmRows.results).toHaveLength(0);
  });

  it('re-processing the same gift-wrap id does not double-insert a user_reports row', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256]],
      content: 'Content Report',
    });

    const first = await processRumor(rumor, 'evt-dedup', MODERATOR, { BLOSSOM_DB: db });
    expect(first).toBe('synced');

    // logDm's dedup-by-nostr_event_id path returns the *existing* row (a
    // truthy .id), which processRumor can't tell apart from a fresh
    // insert -- so a dedup hit is pre-existing, unrelated-to-#6593
    // behavior that still reports 'synced' here (see the issue's own
    // note: "skipped is structurally always 0"). What this test actually
    // pins is the user_reports side: INSERT OR IGNORE against
    // UNIQUE(sha256, reporter_pubkey) must not create a second row.
    const second = await processRumor(rumor, 'evt-dedup', MODERATOR, { BLOSSOM_DB: db });
    expect(second).toBe('synced');

    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(1);
  });
});
