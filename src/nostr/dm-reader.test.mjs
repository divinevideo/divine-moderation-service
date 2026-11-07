// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for DM inbox reader module (dm-reader.mjs)
// ABOUTME: Verifies pubkey derivation, inbox sync behavior, and error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent } from 'nostr-tools/nip59';
import { bytesToHex } from '@noble/hashes/utils';
import { fetchGiftWraps, getModeratorPubkey, processRumor, resolveReportedAt, syncInbox } from './dm-reader.mjs';
import { initDmLogTable } from './dm-store.mjs';
import { UNVERIFIED_EXCERPT_HEADING } from './dm-evidence.mjs';
import { initReportsTable } from '../reports.mjs';
import { initPrivateReportIntakeTable } from '../moderation/private-report-intake.mjs';

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

  it('re-processing the same gift-wrap id skips before re-recording review state', async () => {
    const rumor = {
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'nudity']],
      content: 'Content Report',
    };

    const first = await processRumor(rumor, 'evt-dedup', MODERATOR, { BLOSSOM_DB: db });
    expect(first).toBe('synced');

    await db.prepare('UPDATE moderation_results SET moderated_at = ? WHERE sha256 = ?')
      .bind('2000-01-01T00:00:00.000Z', SHA256)
      .run();

    const second = await processRumor(rumor, 'evt-dedup', MODERATOR, { BLOSSOM_DB: db });
    expect(second).toBe('skipped');

    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(1);
    const dmRows = await db.prepare('SELECT * FROM dm_log').all();
    expect(dmRows.results).toHaveLength(1);

    const moderation = await db.prepare('SELECT * FROM moderation_results WHERE sha256 = ?').bind(SHA256).first();
    expect(moderation.moderated_at).toBe('2000-01-01T00:00:00.000Z');
  });

  // The other half of that dedup: a report whose write failed is not "already
  // recorded", and the DM being in dm_log doesn't make it so. The report write
  // sits in a warn-and-continue block and logDm runs regardless, so gating the
  // re-poll on the dm_log row alone turns any transient D1 failure into a
  // permanently dropped report -- counted as 'deduped' in the sync log, so it
  // reads as handled. Same shape as the RangeError this branch removed.
  it('retries a report whose write failed, on the next pass over the same gift wrap', async () => {
    let failReportWrite = true;
    const flakyDb = {
      prepare(sql) {
        if (failReportWrite && sql.includes('INSERT OR IGNORE INTO user_reports')) {
          throw new Error('D1_ERROR: Network connection lost');
        }
        return db.prepare(sql);
      },
      batch: (...args) => db.batch(...args),
      exec: (...args) => db.exec(...args),
    };

    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'nudity']],
      content: 'Content Report',
    });

    // First pass: the report write blows up, the DM is still logged.
    expect(await processRumor(rumor, 'evt-flaky', MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('synced');
    expect((await db.prepare('SELECT * FROM user_reports').all()).results).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);

    // Second pass, inside syncInbox's two-day overlap, D1 healthy again.
    failReportWrite = false;
    expect(await processRumor(rumor, 'evt-flaky', MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('skipped');

    const reportRows = await db.prepare('SELECT * FROM user_reports').all();
    expect(reportRows.results).toHaveLength(1);
    expect(reportRows.results[0].source).toBe('dm-report');
    const moderation = await db.prepare('SELECT * FROM moderation_results WHERE sha256 = ?').bind(SHA256).first();
    expect(moderation.action).toBe('REVIEW');

    // The DM itself is still deduped -- the retry must not double-log it.
    expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);
  });

  it('retries a report whose review row write failed after the reporter row was stored', async () => {
    let failReviewWrite = true;
    const flakyDb = {
      prepare(sql) {
        if (failReviewWrite && /INSERT INTO moderation_results/i.test(sql)) {
          throw new Error('D1_ERROR: Network connection lost');
        }
        return db.prepare(sql);
      },
      batch: (...args) => db.batch(...args),
      exec: (...args) => db.exec(...args),
    };

    const rumor = makeRumor({
      pubkey: REPORTER,
      tags: [['p', MODERATOR], ['sha256', SHA256], ['report_type', 'nudity']],
      content: 'Content Report',
    });

    expect(await processRumor(rumor, 'evt-flaky-review', MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('synced');
    expect((await db.prepare('SELECT * FROM user_reports').all()).results).toHaveLength(1);
    expect(await db.prepare('SELECT * FROM moderation_results WHERE sha256 = ?').bind(SHA256).first()).toBeNull();
    expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);

    failReviewWrite = false;
    expect(await processRumor(rumor, 'evt-flaky-review', MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('skipped');

    expect((await db.prepare('SELECT * FROM user_reports').all()).results).toHaveLength(1);
    const moderation = await db.prepare('SELECT * FROM moderation_results WHERE sha256 = ?').bind(SHA256).first();
    expect(moderation.action).toBe('REVIEW');
    expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);
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

// A reporter can include the direct message they are reporting
// (divine-mobile#7340). It arrives at the end of the DM body under a fixed
// heading, with an ['evidence', 'unverified_excerpt'] tag on the rumor.
describe('DM Reader - processRumor reporter-included message', () => {
  const db = env.BLOSSOM_DB;
  const MODERATOR = ('f'.repeat(63) + '1').slice(0, 64);
  const REPORTER = ('a'.repeat(63) + '1').slice(0, 64);
  const RECIPIENT = ('b'.repeat(63) + '1').slice(0, 64);
  const SHA256 = ('c'.repeat(63) + '1').slice(0, 64);
  const NOTE = 'DM Message Report\nReason: Harassment\nMessage ID: ' + 'e'.repeat(64) + '\nDetails: keeps messaging me';
  const EXCERPT = 'you will regret this';
  const CONTENT = `${NOTE}\n\n${UNVERIFIED_EXCERPT_HEADING}\n${EXCERPT}`;
  const REPORT_TAGS = [
    ['p', MODERATOR],
    ['L', 'social.nos.ontology'],
    ['l', 'NS-harassment', 'social.nos.ontology'],
    ['report_type', 'profanity'],
  ];
  const EVIDENCE_TAG = ['evidence', 'unverified_excerpt'];

  beforeEach(async () => {
    await initDmLogTable(db);
    await initReportsTable(db);
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS moderation_results (
        sha256 TEXT PRIMARY KEY, action TEXT, provider TEXT, scores TEXT,
        categories TEXT, raw_response TEXT, moderated_at TEXT,
        reviewed_by TEXT, reviewed_at TEXT, review_notes TEXT, uploaded_by TEXT
      )`).run();
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM user_reports').run();
    await db.prepare('DELETE FROM moderation_results').run();
  });

  async function storedDm(rumor) {
    await processRumor(
      { created_at: Math.floor(Date.now() / 1000), ...rumor },
      'evt-' + Math.random().toString(36).slice(2),
      MODERATOR,
      { BLOSSOM_DB: db },
    );
    return db.prepare('SELECT * FROM dm_log').first();
  }

  it('stores the included message as its own field, apart from the reporter\'s note', async () => {
    const dm = await storedDm({ pubkey: REPORTER, tags: [...REPORT_TAGS, EVIDENCE_TAG], content: CONTENT });

    expect(dm.message_type).toBe('conversation_report');
    expect(dm.content).toBe(NOTE);
    expect(dm.unverified_excerpt).toBe(EXCERPT);
  });

  // The heading is text anyone can type, so only the tag marks an excerpt.
  it('keeps a report whole when the body has the heading but the rumor has no tag', async () => {
    const dm = await storedDm({ pubkey: REPORTER, tags: REPORT_TAGS, content: CONTENT });

    expect(dm.content).toBe(CONTENT);
    expect(dm.unverified_excerpt).toBeNull();
  });

  it('keeps a tagged report whole when the heading is missing', async () => {
    const dm = await storedDm({ pubkey: REPORTER, tags: [...REPORT_TAGS, EVIDENCE_TAG], content: NOTE });

    expect(dm.content).toBe(NOTE);
    expect(dm.unverified_excerpt).toBeNull();
  });

  // syncInbox re-reads two days of gift wraps on every tick, so a warning
  // about one malformed DM must not repeat every five minutes.
  it('warns once, not on every re-poll, about a tagged report with no excerpt section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rumor = { pubkey: REPORTER, tags: [...REPORT_TAGS, EVIDENCE_TAG], content: NOTE, created_at: Math.floor(Date.now() / 1000) };
      await processRumor(rumor, 'evt-tag-no-heading', MODERATOR, { BLOSSOM_DB: db });
      await processRumor(rumor, 'evt-tag-no-heading', MODERATOR, { BLOSSOM_DB: db });

      const excerptWarnings = warn.mock.calls.filter(([message]) => String(message).includes('has no excerpt section'));
      expect(excerptWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  // Only a report has a reporter for the excerpt to have come from.
  it('keeps an ordinary reply whole even when it carries the tag', async () => {
    const dm = await storedDm({ pubkey: REPORTER, tags: [['p', MODERATOR], EVIDENCE_TAG], content: CONTENT });

    expect(dm.message_type).toBe('creator_reply');
    expect(dm.content).toBe(CONTENT);
    expect(dm.unverified_excerpt).toBeNull();
  });

  it('keeps the moderator\'s own outgoing copy whole even when it carries the tag', async () => {
    const dm = await storedDm({
      pubkey: MODERATOR,
      tags: [['p', RECIPIENT], ...REPORT_TAGS.slice(1), EVIDENCE_TAG],
      content: CONTENT,
    });

    expect(dm.direction).toBe('outgoing');
    expect(dm.content).toBe(CONTENT);
    expect(dm.unverified_excerpt).toBeNull();
  });

  // Today's DM-message reports name no blob, so they never reach
  // recordReportForReview. A report that does name one must still not carry
  // the excerpt into user_reports or moderation_results: those are the
  // records automated enforcement reads, and user_reports has no retention
  // limit, unlike dm_log's decided one year.
  it('records a report that also names a blob without the included message', async () => {
    const dm = await storedDm({
      pubkey: REPORTER,
      tags: [...REPORT_TAGS, ['sha256', SHA256], EVIDENCE_TAG],
      content: CONTENT,
    });
    expect(dm.unverified_excerpt).toBe(EXCERPT);

    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report.reason).toBe(NOTE);

    const moderation = await db.prepare('SELECT * FROM moderation_results').first();
    expect(moderation.action).toBe('REVIEW');
    expect(JSON.parse(moderation.raw_response).reason).toBe(NOTE);
    expect(moderation.raw_response).not.toContain(EXCERPT);
  });
});

// divine-mobile#10718: a private report of a message or an account sends no
// kind-1984 and files no ticket, so this DM is the only copy of it. It names
// the reported account in a ['reported_pubkey', <hex>] tag (not a 'p' tag,
// which would add that person to the moderation conversation) and must become
// exactly one private_report_intake row, which the cron hands to relay-manager.
describe('DM Reader - processRumor private report intake', () => {
  const db = env.BLOSSOM_DB;
  const MODERATOR = 'f'.repeat(63) + '1';
  const REPORTER = 'a'.repeat(63) + '1';
  const REPORTED = 'b'.repeat(63) + '1';
  const SHA256 = 'c'.repeat(63) + '1';
  const GIFT_WRAP = 'd'.repeat(63) + '1';
  const SECOND_GIFT_WRAP = 'd'.repeat(63) + '2';
  const REPORT_ID = '3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b';
  const MESSAGE_NOTE = 'DM Message Report\nReason: Harassment\nMessage ID: ' + 'e'.repeat(64)
    + '\nSender Pubkey: ' + REPORTED + '\nDetails: keeps messaging me';
  const ACCOUNT_NOTE = 'User Report\nReason: Underage User\nUser Pubkey: ' + REPORTED;
  const EXCERPT = 'you will regret this';
  const EVIDENCE_TAG = ['evidence', 'unverified_excerpt'];

  // The private report tags in the order divine-mobile sends them:
  // ContentReportingService.moderationDmTags, then reported_pubkey, then the
  // evidence tag when the message is included, then the batch tag
  // DmRepository appends with the report id.
  function privateReportTags({ label, nip56Type, reportedPubkey = REPORTED, includesMessage = false, batch = REPORT_ID }) {
    return [
      ['p', MODERATOR],
      ['L', 'social.nos.ontology'],
      ['l', label, 'social.nos.ontology'],
      ['report_type', nip56Type],
      ...(reportedPubkey === null ? [] : [['reported_pubkey', reportedPubkey]]),
      ...(includesMessage ? [EVIDENCE_TAG] : []),
      ...(batch === null ? [] : [['batch', batch]]),
    ];
  }

  function rumor({ tags, content, pubkey = REPORTER }) {
    return { pubkey, tags, content, created_at: Math.floor(Date.now() / 1000) };
  }

  async function intakeRows() {
    return (await db.prepare('SELECT * FROM private_report_intake ORDER BY id').all()).results;
  }

  beforeEach(async () => {
    await initDmLogTable(db);
    await initReportsTable(db);
    await db.prepare('DROP TABLE IF EXISTS private_report_intake').run();
    await initPrivateReportIntakeTable(db);
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS moderation_results (
        sha256 TEXT PRIMARY KEY, action TEXT, provider TEXT, scores TEXT,
        categories TEXT, raw_response TEXT, moderated_at TEXT,
        reviewed_by TEXT, reviewed_at TEXT, review_notes TEXT, uploaded_by TEXT
      )`).run();
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DELETE FROM user_reports').run();
    await db.prepare('DELETE FROM moderation_results').run();
  });

  for (const { name, label, nip56Type, note, reportType } of [
    { name: 'message', label: 'NS-harassment', nip56Type: 'profanity', note: MESSAGE_NOTE, reportType: 'harassment' },
    { name: 'account', label: 'NS-underageUser', nip56Type: 'other', note: ACCOUNT_NOTE, reportType: 'underage_user' },
  ]) {
    for (const includesMessage of [false, true]) {
      it(`a private ${name} report ${includesMessage ? 'with' : 'without'} an included message creates one intake row`, async () => {
        const content = includesMessage
          ? `${note}\n\n${UNVERIFIED_EXCERPT_HEADING}\n${EXCERPT}`
          : note;
        const outcome = await processRumor(
          rumor({ tags: privateReportTags({ label, nip56Type, includesMessage }), content }),
          GIFT_WRAP,
          MODERATOR,
          { BLOSSOM_DB: db },
        );
        expect(outcome).toBe('synced');

        const rows = await intakeRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          report_id: REPORT_ID,
          reporter_pubkey: REPORTER,
          reported_pubkey: REPORTED,
          report_type: reportType,
          gift_wrap_id: GIFT_WRAP,
          has_excerpt: includesMessage ? 1 : 0,
          status: 'pending',
          attempts: 0,
        });
        expect(Date.parse(rows[0].reported_at)).toBeGreaterThan(Date.now() - 60_000);
        // Identifiers only: neither the note nor the message is copied here.
        expect(JSON.stringify(rows[0])).not.toContain('keeps messaging me');
        expect(JSON.stringify(rows[0])).not.toContain(EXCERPT);

        // The inbox side is unchanged.
        const dm = await db.prepare('SELECT * FROM dm_log').first();
        expect(dm.message_type).toBe('conversation_report');
        expect(dm.content).toBe(note);
        expect(dm.unverified_excerpt).toBe(includesMessage ? EXCERPT : null);
        expect(await db.prepare('SELECT * FROM user_reports').first()).toBeNull();
      });
    }
  }

  it('lowercases an uppercase reported_pubkey', async () => {
    await processRumor(
      rumor({ tags: privateReportTags({ label: 'NS-spam', nip56Type: 'spam', reportedPubkey: REPORTED.toUpperCase() }), content: ACCOUNT_NOTE }),
      GIFT_WRAP,
      MODERATOR,
      { BLOSSOM_DB: db },
    );

    expect((await intakeRows())[0].reported_pubkey).toBe(REPORTED);
  });

  it('keys a report without a batch tag on its gift wrap id', async () => {
    await processRumor(
      rumor({ tags: privateReportTags({ label: 'NS-spam', nip56Type: 'spam', batch: null }), content: ACCOUNT_NOTE }),
      GIFT_WRAP,
      MODERATOR,
      { BLOSSOM_DB: db },
    );

    expect((await intakeRows())[0].report_id).toBe(GIFT_WRAP);
  });

  // A public report's kind-1984 already reaches Coop through Osprey, and a
  // content report has its own review row: queueing either again would
  // double-queue it.
  it('a content report that names a blob creates no intake row, and its review path is unchanged', async () => {
    const tags = [
      ...privateReportTags({ label: 'NS-sexualContent', nip56Type: 'nudity' }),
      ['sha256', SHA256],
    ];
    await processRumor(rumor({ tags, content: 'Content Report\nReason: Sexual Content' }), GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });

    expect(await intakeRows()).toHaveLength(0);
    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report).toMatchObject({ sha256: SHA256, reporter_pubkey: REPORTER, source: 'dm-report' });
    expect((await db.prepare('SELECT * FROM moderation_results').first()).action).toBe('REVIEW');
  });

  it('a report DM without a reported_pubkey creates no intake row', async () => {
    const outcome = await processRumor(
      rumor({ tags: privateReportTags({ label: 'NS-harassment', nip56Type: 'profanity', reportedPubkey: null }), content: MESSAGE_NOTE }),
      GIFT_WRAP,
      MODERATOR,
      { BLOSSOM_DB: db },
    );

    expect(outcome).toBe('synced');
    expect(await intakeRows()).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM dm_log').first()).message_type).toBe('conversation_report');
  });

  it('an ordinary reply that carries a reported_pubkey tag is not a report', async () => {
    await processRumor(
      rumor({ tags: [['p', MODERATOR], ['reported_pubkey', REPORTED]], content: 'thanks for looking' }),
      GIFT_WRAP,
      MODERATOR,
      { BLOSSOM_DB: db },
    );

    expect(await intakeRows()).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM dm_log').first()).message_type).toBe('creator_reply');
  });

  it('the moderator\'s own outgoing copy creates nothing', async () => {
    const tags = privateReportTags({ label: 'NS-harassment', nip56Type: 'profanity' })
      .map((tag) => (tag[0] === 'p' ? ['p', REPORTER] : tag));
    await processRumor(rumor({ pubkey: MODERATOR, tags, content: MESSAGE_NOTE }), GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });

    expect(await intakeRows()).toHaveLength(0);
  });

  it('ignores a malformed reported_pubkey, warning once rather than on every re-poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const malformed = rumor({
        tags: privateReportTags({ label: 'NS-harassment', nip56Type: 'profanity', reportedPubkey: 'npub1notahexkey' }),
        content: MESSAGE_NOTE,
      });

      await processRumor(malformed, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });
      await processRumor(malformed, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });

      expect(await intakeRows()).toHaveLength(0);
      const pubkeyWarnings = warn.mock.calls.filter(([message]) => String(message).includes('reported_pubkey'));
      expect(pubkeyWarnings).toHaveLength(1);
      expect(pubkeyWarnings[0][0]).toContain(GIFT_WRAP);
      // The DM itself is still in the inbox for a moderator to read.
      expect((await db.prepare('SELECT * FROM dm_log').first()).message_type).toBe('conversation_report');
    } finally {
      warn.mockRestore();
    }
  });

  it('a re-poll of the same gift wrap creates no second row', async () => {
    const report = rumor({ tags: privateReportTags({ label: 'NS-csam', nip56Type: 'illegal' }), content: MESSAGE_NOTE });

    expect(await processRumor(report, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db })).toBe('synced');
    expect(await processRumor(report, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db })).toBe('skipped');

    expect(await intakeRows()).toHaveLength(1);
  });

  // divine-mobile's retry worker re-drives an undelivered report, which sends
  // a new gift wrap around the same report id.
  it('a resend of the same report in a new gift wrap creates no second row', async () => {
    const report = rumor({ tags: privateReportTags({ label: 'NS-childSafety', nip56Type: 'illegal' }), content: MESSAGE_NOTE });

    await processRumor(report, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });
    await processRumor(report, SECOND_GIFT_WRAP, MODERATOR, { BLOSSOM_DB: db });

    const rows = await intakeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ report_id: REPORT_ID, gift_wrap_id: GIFT_WRAP, report_type: 'child_safety' });
    // Both copies stay in the inbox, as before.
    expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(2);
  });

  // Same reasoning as the user_reports retry above: the DM is logged whether
  // or not the intake write succeeded, so a re-poll must still try the write.
  it('retries an intake write that failed, on the next pass over the same gift wrap', async () => {
    let failIntakeWrite = true;
    const flakyDb = {
      prepare(sql) {
        if (failIntakeWrite && sql.includes('INSERT OR IGNORE INTO private_report_intake')) {
          throw new Error('D1_ERROR: Network connection lost');
        }
        return db.prepare(sql);
      },
      batch: (...args) => db.batch(...args),
      exec: (...args) => db.exec(...args),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = rumor({ tags: privateReportTags({ label: 'NS-harassment', nip56Type: 'profanity' }), content: MESSAGE_NOTE });

      expect(await processRumor(report, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('synced');
      expect(await intakeRows()).toHaveLength(0);
      expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('private report'), expect.stringContaining('Network connection lost'));

      failIntakeWrite = false;
      expect(await processRumor(report, GIFT_WRAP, MODERATOR, { BLOSSOM_DB: flakyDb })).toBe('skipped');

      expect(await intakeRows()).toHaveLength(1);
      expect((await db.prepare('SELECT * FROM dm_log').all()).results).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
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

// NIP-42 AUTH handshake + checkpoint guard for the gift-wrap reader.
//
// relay.divine.video is gating kind-1059 reads behind NIP-42 AUTH to the
// addressed recipient. Before this change fetchGiftWraps handled only EVENT and
// EOSE, so under the gate it ignored the AUTH challenge and the auth-required
// CLOSED, timed out, and resolved an empty array -- and syncInbox then advanced
// the inbox checkpoint anyway, so the reported DMs in that window were skipped
// forever. These tests pin the handshake and the "only advance on EOSE" guard.
//
// The WebSocket is mocked the same way report-poller.test.mjs mocks its relay:
// a class swapped onto globalThis.WebSocket that emits 'open' on a microtask and
// drives replies synchronously from each send(). Replies nest (a reply triggers
// the reader's next send, which triggers the next reply), so the effective order
// the reader observes is AUTH -> OK -> CLOSED; the re-REQ trigger is written to
// be order-independent (it fires once both the auth-required CLOSED and the OK
// have arrived, whichever is last).
describe('DM Reader - fetchGiftWraps NIP-42 AUTH', () => {
  const RELAY = 'wss://relay.example';
  const FILTER = { kinds: [1059], '#p': [testPubkey], since: 1, limit: 200 };

  function makeGiftWrap(id) {
    return {
      id,
      kind: 1059,
      pubkey: 'a'.repeat(64),
      created_at: 1_700_000_000,
      tags: [['p', testPubkey]],
      content: 'sealed',
      sig: 'b'.repeat(128),
    };
  }

  // Swap a scripted relay onto globalThis.WebSocket. onSend(parsed, ctx) is
  // called for every client->relay frame; ctx.reply(arr) pushes a relay->client
  // frame, ctx.closeConn() fires the socket 'close' event without an EOSE.
  // closes.count records socket teardown, so a test can pin that an exit path
  // actually closed the connection instead of leaking it.
  function installRelayMock(onSend) {
    const original = globalThis.WebSocket;
    const sent = [];
    const closes = { count: 0 };
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this._listeners = new Map();
        queueMicrotask(() => this._emit('open', {}));
      }
      addEventListener(type, listener) { this._listeners.set(type, listener); }
      send(message) {
        const parsed = JSON.parse(message);
        sent.push(parsed);
        onSend(parsed, {
          reply: (arr) => this._emit('message', { data: JSON.stringify(arr) }),
          closeConn: () => this._emit('close', {}),
          fail: (message) => this._emit('error', { message }),
        });
      }
      close() { closes.count += 1; }
      _emit(type, event) { this._listeners.get(type)?.(event); }
    };
    return { sent, closes, restore: () => { globalThis.WebSocket = original; } };
  }

  it('answers the AUTH challenge, re-subscribes after the auth-required close, and returns the gift wraps', async () => {
    const giftWrap = makeGiftWrap('gw-gated');
    let reqCount = 0;
    const { sent, restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        const subId = msg[1];
        reqCount += 1;
        if (reqCount === 1) {
          // Pre-auth REQ: the relay offers a challenge and closes the sub.
          ctx.reply(['AUTH', 'challenge-abc']);
          ctx.reply(['CLOSED', subId, 'auth-required: authentication required to read kind 1059']);
        } else {
          // Post-auth re-subscription is served.
          ctx.reply(['EVENT', subId, giftWrap]);
          ctx.reply(['EOSE', subId]);
        }
      } else if (msg[0] === 'AUTH') {
        ctx.reply(['OK', msg[1].id, true, '']);
      }
    });

    try {
      const result = await fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex });

      expect(result.complete).toBe(true);
      expect(result.events).toEqual([giftWrap]);

      // Signed a kind-22242 auth event with the moderator key, echoing the
      // challenge and target relay.
      const authSend = sent.find((m) => m[0] === 'AUTH');
      expect(authSend).toBeTruthy();
      expect(authSend[1].kind).toBe(22242);
      expect(authSend[1].pubkey).toBe(testPubkey);
      expect(authSend[1].sig).toMatch(/^[0-9a-f]{128}$/);
      expect(authSend[1].tags).toContainEqual(['challenge', 'challenge-abc']);
      expect(authSend[1].tags).toContainEqual(['relay', RELAY]);

      // The REQ was sent twice: the original, then the post-auth re-subscription.
      expect(sent.filter((m) => m[0] === 'REQ')).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('answers a proactively offered AUTH challenge and returns the served gift wraps on EOSE', async () => {
    const giftWrap = makeGiftWrap('gw-proactive');
    const { sent, restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        const subId = msg[1];
        // Relay offers auth but still serves the original sub (no CLOSED).
        ctx.reply(['AUTH', 'challenge-proactive']);
        ctx.reply(['EVENT', subId, giftWrap]);
        ctx.reply(['EOSE', subId]);
      }
    });

    try {
      const result = await fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex });

      expect(result.complete).toBe(true);
      expect(result.events).toEqual([giftWrap]);
      const authSend = sent.find((m) => m[0] === 'AUTH');
      expect(authSend[1].kind).toBe(22242);
      // No CLOSED means no re-subscription: the REQ is sent exactly once.
      expect(sent.filter((m) => m[0] === 'REQ')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('rejects loudly when the relay closes the subscription for a non-auth reason', async () => {
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.reply(['CLOSED', msg[1], 'blocked: you are banned']);
      }
    });

    try {
      await expect(fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex }))
        .rejects.toThrow('blocked: you are banned');
    } finally {
      restore();
    }
  });

  it('rejects loudly on a "restricted:" close (NIP-42 terminal denial, not a retry)', async () => {
    // 'restricted:' means we authenticated but this key is not allowed -- per
    // NIP-42 retrying can't help, so it must reject, not loop on re-REQ.
    let reqCount = 0;
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        reqCount += 1;
        ctx.reply(['CLOSED', msg[1], 'restricted: not the addressed recipient']);
      } else if (msg[0] === 'AUTH') {
        ctx.reply(['OK', msg[1].id, true, '']);
      }
    });

    try {
      await expect(fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex }))
        .rejects.toThrow('restricted: not the addressed recipient');
      expect(reqCount).toBe(1); // rejected on the first close, no re-REQ loop
    } finally {
      restore();
    }
  });

  it('rejects a "restricted:" close that arrives after a successful AUTH', async () => {
    // The shape relay.divine.video actually produces: it challenges on connect,
    // we authenticate, and the read is still refused because the filter is not
    // scoped to the authed key (funnelcake crates/relay/src/auth.rs only returns
    // Restricted for an already-authenticated connection). NIP-42 reserves
    // 'restricted:' for exactly this post-auth case, so there is nothing to
    // retry -- re-REQing can only draw the same refusal.
    let reqCount = 0;
    let authAnswered = false;
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        reqCount += 1;
        // Challenge first, so the AUTH round trip completes before the refusal.
        ctx.reply(['AUTH', 'challenge-post-auth']);
        ctx.reply(['CLOSED', msg[1], 'restricted: not authorized to read events for another pubkey']);
      } else if (msg[0] === 'AUTH') {
        authAnswered = true;
        ctx.reply(['OK', msg[1].id, true, '']);
      }
    });

    try {
      await expect(fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex }))
        .rejects.toThrow('restricted: not authorized to read events for another pubkey');
      expect(authAnswered).toBe(true); // we did authenticate, so this is the post-auth denial
      expect(reqCount).toBe(1); // and it is terminal: no second REQ was sent
    } finally {
      restore();
    }
  });

  it('rejects loudly when the relay refuses the AUTH (OK false)', async () => {
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        const subId = msg[1];
        ctx.reply(['AUTH', 'challenge-refuse']);
        ctx.reply(['CLOSED', subId, 'auth-required: nope']);
      } else if (msg[0] === 'AUTH') {
        ctx.reply(['OK', msg[1].id, false, 'pubkey not permitted']);
      }
    });

    try {
      await expect(fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex }))
        .rejects.toThrow('pubkey not permitted');
    } finally {
      restore();
    }
  });

  it('closes the socket on a reject path, not only on EOSE', async () => {
    // Every exit from fetchGiftWraps has to tear the connection down. The reject
    // paths used to return without closing, leaking the socket until the isolate
    // was torn down.
    const { closes, restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.reply(['CLOSED', msg[1], 'error: relay is shutting down']);
      }
    });

    try {
      await expect(fetchGiftWraps(RELAY, FILTER, { NOSTR_PRIVATE_KEY: testHex }))
        .rejects.toThrow('relay is shutting down');
      expect(closes.count).toBe(1);
    } finally {
      restore();
    }
  });
});

// The checkpoint guard, exercised through syncInbox (which owns the KV write).
// BLOSSOM_DB is left undefined so initReportsTable is skipped and no D1 is
// touched; every scenario drives zero decrypted events, so the classify path
// never runs -- the point under test is purely whether the checkpoint moves.
describe('DM Reader - syncInbox checkpoint guard', () => {
  function createKvMock(initial = new Map()) {
    const store = new Map(initial);
    const puts = [];
    return {
      store,
      puts,
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async put(key, value) { puts.push({ key, value }); store.set(key, value); },
    };
  }

  function installRelayMock(onSend) {
    const original = globalThis.WebSocket;
    const sent = [];
    globalThis.WebSocket = class {
      constructor(url) {
        this.url = url;
        this._listeners = new Map();
        queueMicrotask(() => this._emit('open', {}));
      }
      addEventListener(type, listener) { this._listeners.set(type, listener); }
      send(message) {
        const parsed = JSON.parse(message);
        sent.push(parsed);
        onSend(parsed, {
          reply: (arr) => this._emit('message', { data: JSON.stringify(arr) }),
          closeConn: () => this._emit('close', {}),
        });
      }
      close() {}
      _emit(type, event) { this._listeners.get(type)?.(event); }
    };
    return { sent, restore: () => { globalThis.WebSocket = original; } };
  }

  it('advances the checkpoint after a completed (EOSE) sync', async () => {
    const kv = createKvMock();
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.reply(['EOSE', msg[1]]); // clean completion, zero events
      }
    });

    try {
      const result = await syncInbox({ NOSTR_PRIVATE_KEY: testHex, MODERATION_KV: kv });
      expect(result).toEqual({ synced: 0, skipped: 0, errors: 0 });
      expect(kv.puts.map((p) => p.key)).toContain('dm-inbox:last-sync');
    } finally {
      restore();
    }
  });

  it('leaves the checkpoint unchanged when the sync never completes (no EOSE)', async () => {
    const kv = createKvMock(new Map([['dm-inbox:last-sync', '1700000000']]));
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.closeConn(); // relay drops the connection without an EOSE
      }
    });

    try {
      const result = await syncInbox({ NOSTR_PRIVATE_KEY: testHex, MODERATION_KV: kv });
      expect(result).toEqual({ synced: 0, skipped: 0, errors: 0 });
      expect(kv.puts).toHaveLength(0);
      expect(kv.store.get('dm-inbox:last-sync')).toBe('1700000000'); // untouched
    } finally {
      restore();
    }
  });

  it('does not advance the checkpoint when the relay refuses AUTH', async () => {
    const kv = createKvMock(new Map([['dm-inbox:last-sync', '1700000000']]));
    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        const subId = msg[1];
        ctx.reply(['AUTH', 'c']);
        ctx.reply(['CLOSED', subId, 'auth-required: nope']);
      } else if (msg[0] === 'AUTH') {
        ctx.reply(['OK', msg[1].id, false, 'not permitted']);
      }
    });

    try {
      await expect(syncInbox({ NOSTR_PRIVATE_KEY: testHex, MODERATION_KV: kv }))
        .rejects.toThrow('not permitted');
      expect(kv.puts).toHaveLength(0);
      expect(kv.store.get('dm-inbox:last-sync')).toBe('1700000000'); // untouched
    } finally {
      restore();
    }
  });

  // syncInbox runs from the cron trigger, which never reaches the fetch
  // handler, and production's dm_log predates the excerpt column. The first
  // tick after a deploy must add the column itself, or the insert fails and
  // the report is never logged.
  it('stores an included message against a dm_log created before the excerpt column existed', async () => {
    const db = env.BLOSSOM_DB;
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

    const reporterSk = generateSecretKey();
    const giftWrap = wrapEvent({
      kind: 14,
      content: `DM Message Report\nReason: Harassment\n\n${UNVERIFIED_EXCERPT_HEADING}\nyou will regret this`,
      tags: [
        ['p', testPubkey],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-harassment', 'social.nos.ontology'],
        ['report_type', 'profanity'],
        ['evidence', 'unverified_excerpt'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    }, reporterSk, testPubkey);

    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.reply(['EVENT', msg[1], giftWrap]);
        ctx.reply(['EOSE', msg[1]]);
      }
    });

    try {
      const result = await syncInbox({ NOSTR_PRIVATE_KEY: testHex, BLOSSOM_DB: db });
      expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    } finally {
      restore();
    }

    const dm = await db.prepare('SELECT * FROM dm_log').first();
    expect(dm.content).toBe('DM Message Report\nReason: Harassment');
    expect(dm.unverified_excerpt).toBe('you will regret this');
  });

  // Same as the excerpt column: the first cron tick after a deploy reaches a
  // database that has no private_report_intake table yet.
  it('creates the private report intake table before recording a private report', async () => {
    const db = env.BLOSSOM_DB;
    await initDmLogTable(db);
    await db.prepare('DELETE FROM dm_log').run();
    await db.prepare('DROP TABLE IF EXISTS private_report_intake').run();

    const reporterSk = generateSecretKey();
    const reportedPubkey = 'b'.repeat(63) + '1';
    const reportId = '3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b';
    const giftWrap = wrapEvent({
      kind: 14,
      content: 'User Report\nReason: Child Safety\nUser Pubkey: ' + reportedPubkey,
      tags: [
        ['p', testPubkey],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-childSafety', 'social.nos.ontology'],
        ['report_type', 'illegal'],
        ['reported_pubkey', reportedPubkey],
        ['batch', reportId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    }, reporterSk, testPubkey);

    const { restore } = installRelayMock((msg, ctx) => {
      if (msg[0] === 'REQ') {
        ctx.reply(['EVENT', msg[1], giftWrap]);
        ctx.reply(['EOSE', msg[1]]);
      }
    });

    try {
      const result = await syncInbox({ NOSTR_PRIVATE_KEY: testHex, BLOSSOM_DB: db });
      expect(result).toEqual({ synced: 1, skipped: 0, errors: 0 });
    } finally {
      restore();
    }

    const row = await db.prepare('SELECT * FROM private_report_intake').first();
    expect(row).toMatchObject({
      report_id: reportId,
      reporter_pubkey: getPublicKey(reporterSk),
      reported_pubkey: reportedPubkey,
      report_type: 'child_safety',
      gift_wrap_id: giftWrap.id,
      status: 'pending',
    });
  });
});
