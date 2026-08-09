// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM inbox reader module (dm-reader.mjs)
// ABOUTME: Verifies pubkey derivation, inbox sync behavior, and error handling

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils';
import { getModeratorPubkey, processRumor, resolveReportedAt } from './dm-reader.mjs';
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
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS moderation_results (
        sha256 TEXT PRIMARY KEY,
        action TEXT,
        provider TEXT,
        scores TEXT,
        categories TEXT,
        raw_response TEXT,
        moderated_at TEXT,
        reviewed_by TEXT,
        reviewed_at TEXT,
        review_notes TEXT,
        uploaded_by TEXT
      )
    `).run();
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM user_reports').run();
    await db.prepare('DELETE FROM moderation_results').run();
  });

  function makeRumor({ pubkey, tags, content, created_at = Math.floor(Date.now() / 1000) }) {
    return { pubkey, tags, content, created_at };
  }

  // The DM and the kind-1984 report write the same
  // (sha256, reporter_pubkey) row under INSERT OR IGNORE, so whichever
  // ingests first pins report_type forever. Both must therefore resolve the
  // reason identically -- the NIP-56 report_type alone collapses aiGenerated
  // to 'other', which would strand the row as a mis-typed report.
  it('resolves report_type from the NIP-32 label, not the collapsed NIP-56 tag', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [
        ['p', MODERATOR],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-aiGenerated', 'social.nos.ontology'],
        ['report_type', 'other'],
        ['sha256', SHA256],
      ],
      content: 'Content Report\nReason: AI-Generated Content\nEvent: ' + 'e'.repeat(64),
    });

    expect(await processRumor(rumor, 'evt-label', MODERATOR, { BLOSSOM_DB: db })).toBe('synced');

    const reportRow = await db.prepare('SELECT * FROM user_reports').first();
    expect(reportRow.report_type).toBe('ai_generated');
  });

  it('badges a report DM that carries only the NIP-32 label', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [
        ['p', MODERATOR],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-underageUser', 'social.nos.ontology'],
      ],
      content: 'User Report\nReason: Underage User\nUser Pubkey: ' + 'f'.repeat(64),
    });

    expect(await processRumor(rumor, 'evt-label-only', MODERATOR, { BLOSSOM_DB: db })).toBe('synced');

    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('conversation_report');
  });

  it('does not badge unrelated NIP-32 labels as report DMs', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [
        ['p', MODERATOR],
        ['L', 'com.example.other'],
        ['l', 'NS-underageUser', 'com.example.other'],
      ],
      content: 'Plain creator reply with an unrelated label',
    });

    expect(await processRumor(rumor, 'evt-unrelated-label', MODERATOR, { BLOSSOM_DB: db })).toBe('synced');

    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('creator_reply');
    const reportRow = await db.prepare('SELECT * FROM user_reports').first();
    expect(reportRow).toBeFalsy();
  });

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

    const moderationRow = await db.prepare('SELECT * FROM moderation_results WHERE sha256 = ?').bind(SHA256).first();
    expect(moderationRow).toBeTruthy();
    expect(moderationRow.action).toBe('REVIEW');
    expect(moderationRow.provider).toBe('user-report');
    expect(JSON.parse(moderationRow.raw_response)).toMatchObject({
      source: 'dm-report',
      reportType: 'spam',
      reportedBy: REPORTER,
      reason: proseContent,
    });
  });

  it('normalizes a valid uppercase sha256 tag before recording review state', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256.toUpperCase()], ['report_type', 'spam']],
      content: 'Content Report',
    });

    const outcome = await processRumor(rumor, 'evt-upper-sha', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.sha256).toBe(SHA256);
    const reportRow = await db.prepare('SELECT * FROM user_reports').first();
    expect(reportRow.sha256).toBe(SHA256);
    const moderationRow = await db.prepare('SELECT action FROM moderation_results WHERE sha256 = ?').bind(SHA256).first();
    expect(moderationRow.action).toBe('REVIEW');
  });

  it('does not record user_reports or moderation_results for an invalid sha256 tag', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', 'not-a-sha'], ['report_type', 'spam']],
      content: 'Content Report',
    });

    const outcome = await processRumor(rumor, 'evt-invalid-sha', MODERATOR, { BLOSSOM_DB: db });

    expect(outcome).toBe('synced');
    const dmRow = await db.prepare('SELECT * FROM dm_log').first();
    expect(dmRow.message_type).toBe('conversation_report');
    expect(dmRow.sha256).toBeNull();
    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(0);
    const moderationRows = await db.prepare('SELECT * FROM moderation_results').all();
    expect(moderationRows.results).toHaveLength(0);
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

  // rumor.created_at is written by the sender and validated by nothing. Before
  // resolveReportedAt, a missing one threw RangeError out of
  // `new Date(undefined * 1000).toISOString()` inside the warn-and-continue
  // block, so the report vanished entirely -- the worst outcome available for
  // a moderation report.
  it('records a report whose rumor carries no created_at instead of dropping it', async () => {
    // Built literally rather than through makeRumor, whose default parameter
    // would substitute a valid timestamp and hide the case under test.
    const rumor = {
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'nudity']],
      content: 'Content Report',
    };
    expect(rumor.created_at).toBeUndefined();

    const outcome = await processRumor(rumor, 'evt-no-created-at', MODERATOR, { BLOSSOM_DB: db });
    expect(outcome).toBe('synced');

    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report).toBeTruthy();
    expect(report.sha256).toBe(SHA256);

    const moderation = await db.prepare('SELECT * FROM moderation_results').first();
    expect(moderation.action).toBe('REVIEW');
    // Stamped with receipt time, so it lands at the top of the queue rather
    // than nowhere.
    expect(Date.parse(moderation.moderated_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('does not let a backdated rumor bury its report at the bottom of the review queue', async () => {
    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'nudity']],
      content: 'Content Report',
      created_at: 1600000000, // 2020
    });

    await processRumor(rumor, 'evt-backdated', MODERATOR, { BLOSSOM_DB: db });

    const moderation = await db.prepare('SELECT * FROM moderation_results').first();
    expect(Date.parse(moderation.moderated_at)).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('DM Reader - resolveReportedAt', () => {
  const NOW_MS = Date.parse('2026-08-09T12:00:00.000Z');
  const NOW_SECONDS = Math.floor(NOW_MS / 1000);

  it('keeps a plausible timestamp exactly as sent', () => {
    const tenMinutesAgo = NOW_SECONDS - 600;
    expect(resolveReportedAt(tenMinutesAgo, NOW_MS)).toBe(new Date(tenMinutesAgo * 1000).toISOString());
  });

  it('keeps a timestamp at the far edge of the reader\'s own lookback', () => {
    const sixDaysAgo = NOW_SECONDS - (6 * 86400);
    expect(resolveReportedAt(sixDaysAgo, NOW_MS)).toBe(new Date(sixDaysAgo * 1000).toISOString());
  });

  it('falls back to receipt time for missing, non-numeric, or nonsense values', () => {
    const now = new Date(NOW_MS).toISOString();
    expect(resolveReportedAt(undefined, NOW_MS)).toBe(now);
    expect(resolveReportedAt(null, NOW_MS)).toBe(now);
    expect(resolveReportedAt('1600000000', NOW_MS)).toBe(now); // string, not a number
    expect(resolveReportedAt(NaN, NOW_MS)).toBe(now);
    expect(resolveReportedAt(Infinity, NOW_MS)).toBe(now);
    expect(resolveReportedAt(0, NOW_MS)).toBe(now);
    expect(resolveReportedAt(-1, NOW_MS)).toBe(now);
  });

  it('falls back to receipt time for a backdated or future timestamp', () => {
    const now = new Date(NOW_MS).toISOString();
    expect(resolveReportedAt(NOW_SECONDS - (8 * 86400), NOW_MS)).toBe(now);
    expect(resolveReportedAt(NOW_SECONDS + 3600, NOW_MS)).toBe(now);
  });

  it('tolerates a client clock that runs slightly fast', () => {
    const oneMinuteAhead = NOW_SECONDS + 60;
    expect(resolveReportedAt(oneMinuteAhead, NOW_MS)).toBe(new Date(oneMinuteAhead * 1000).toISOString());
  });
});
