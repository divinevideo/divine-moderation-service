// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: End-to-end contract test for divine-mobile's moderation report DM
// ABOUTME: Real NIP-59 gift-wrap round trip into the real processRumor + D1
//
// The unit tests elsewhere hand processRumor a plain rumor object. This one
// starts from the exact tag list divine-mobile builds, gift-wraps it with
// real NIP-44 crypto and schnorr signing, unwraps it, and asserts on the
// rows the real classify path writes -- so a change on either side of the
// producer/consumer contract fails here rather than in production.

import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import { processRumor } from './dm-reader.mjs';
import { initDmLogTable } from './dm-store.mjs';
import { initReportsTable } from '../reports.mjs';

const SHA256 = 'b'.repeat(64);

// Byte-for-byte what report_content_dialog.dart's _reportDmTags() produces,
// after dm_repository.sendMessage -> nip17_message_service.buildRumor
// prepends the ['p', recipient] tag.
function mobileReportDmTags({ nip32Label, nip56Type, sha256 }) {
  return [
    ['L', 'social.nos.ontology'],
    ['l', nip32Label, 'social.nos.ontology'],
    ['report_type', nip56Type],
    ...(sha256 ? [['sha256', sha256]] : []),
  ];
}

describe('divine-mobile#6593 cross-repo contract', () => {
  let db;
  let reporterSk;
  let moderatorSk;
  let moderatorPubkey;

  beforeEach(async () => {
    db = env.BLOSSOM_DB;
    await db.prepare('DROP TABLE IF EXISTS dm_log').run();
    await db.prepare('DROP TABLE IF EXISTS user_reports').run();
    await db.prepare('DROP TABLE IF EXISTS moderation_results').run();
    await initDmLogTable(db);
    await initReportsTable(db);
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS moderation_results (
        sha256 TEXT PRIMARY KEY, action TEXT, provider TEXT, scores TEXT,
        categories TEXT, raw_response TEXT, moderated_at TEXT,
        reviewed_by TEXT, reviewed_at TEXT, review_notes TEXT, uploaded_by TEXT
      )`).run();

    reporterSk = generateSecretKey();
    moderatorSk = generateSecretKey();
    moderatorPubkey = getPublicKey(moderatorSk);
  });

  // Real crypto: mobile's tags -> kind-14 rumor -> kind-13 seal -> kind-1059
  // gift wrap -> unwrap -> the backend's real classify path.
  async function roundTrip(tags, content, giftWrapId) {
    // The kind-14 rumor divine-mobile builds: nip17_message_service.buildRumor
    // prepends ['p', recipient], then dm_repository's additionalTags follow.
    const giftWrap = wrapEvent(
      {
        kind: 14,
        content,
        tags: [['p', moderatorPubkey], ...tags],
        created_at: Math.floor(Date.now() / 1000),
      },
      reporterSk,
      moderatorPubkey,
    );
    expect(giftWrap.kind).toBe(1059);
    const rumor = unwrapEvent(giftWrap, moderatorSk);
    expect(rumor.kind).toBe(14);
    expect(rumor.pubkey).toBe(getPublicKey(reporterSk));
    const outcome = await processRumor(rumor, giftWrapId, moderatorPubkey, {
      BLOSSOM_DB: db,
    });
    return { rumor, outcome };
  }

  it('an aiGenerated content report survives the wire as ai_generated', async () => {
    const { rumor, outcome } = await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-aiGenerated',
        nip56Type: 'other', // what contentFilterReasonToNip56Type collapses to
        sha256: SHA256,
      }),
      'Content Report\nReason: AI-Generated Content\nEvent: ' + 'e'.repeat(64),
      'gw-ai',
    );

    // The tags really did survive the gift wrap.
    expect(rumor.tags).toEqual(
      expect.arrayContaining([['l', 'NS-aiGenerated', 'social.nos.ontology']]),
    );
    expect(outcome).toBe('synced');

    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report.report_type).toBe('ai_generated');
    expect(report.report_type).not.toBe('other'); // the bug this change fixes

    const dm = await db.prepare('SELECT * FROM dm_log').first();
    expect(dm.message_type).toBe('conversation_report');
    expect(dm.content).toContain('Reason: AI-Generated Content'); // prose intact
  });

  it('a sexualContent report becomes NSFW-escalation eligible', async () => {
    await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-sexualContent',
        nip56Type: 'nudity',
        sha256: SHA256,
      }),
      'Content Report\nReason: Sexual Content\nEvent: ' + 'e'.repeat(64),
      'gw-nsfw',
    );

    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report.report_type).toBe('sexual_content');
    const { isNsfwReportType } = await import('../reports.mjs');
    expect(isNsfwReportType(report.report_type)).toBe(true);
  });

  it('a user report (no sha256) is badged but writes no user_reports row', async () => {
    const { outcome } = await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-underageUser',
        nip56Type: 'other',
        sha256: null,
      }),
      'User Report\nReason: Underage User\nUser Pubkey: ' + 'f'.repeat(64),
      'gw-user',
    );

    expect(outcome).toBe('synced');
    const dm = await db.prepare('SELECT * FROM dm_log').first();
    expect(dm.message_type).toBe('conversation_report');
    const report = await db.prepare('SELECT * FROM user_reports').first();
    expect(report).toBeFalsy(); // user_reports.sha256 is NOT NULL — by design
  });

  it('the DM and the kind-1984 poller agree, so INSERT OR IGNORE cannot mis-pin', async () => {
    const { extractReportType } = await import('./report-poller.mjs');

    // What the kind-1984 report event looks like (content_reporting_service).
    const kind1984 = {
      kind: 1984,
      tags: [
        ['e', 'e'.repeat(64), 'other'],
        ['p', 'f'.repeat(64), 'other'],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-aiGenerated', 'social.nos.ontology'],
      ],
      content: 'CONTENT REPORT - NIP-56\nReason: aiGenerated\nDetails: x',
    };

    const { rumor } = await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-aiGenerated',
        nip56Type: 'other',
        sha256: SHA256,
      }),
      'Content Report\nReason: AI-Generated Content\nEvent: ' + 'e'.repeat(64),
      'gw-agree',
    );

    expect(extractReportType(rumor)).toBe(extractReportType(kind1984));
    expect(extractReportType(rumor)).toBe('ai_generated');
  });
});
