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

// Byte-for-byte what ContentReportingService.moderationDmTags() produces,
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
  async function roundTrip(tags, content, giftWrapId, sk = reporterSk) {
    // The kind-14 rumor divine-mobile builds: nip17_message_service.buildRumor
    // prepends ['p', recipient], then dm_repository's additionalTags follow.
    const giftWrap = wrapEvent(
      {
        kind: 14,
        content,
        tags: [['p', moderatorPubkey], ...tags],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
      moderatorPubkey,
    );
    expect(giftWrap.kind).toBe(1059);
    const rumor = unwrapEvent(giftWrap, moderatorSk);
    expect(rumor.kind).toBe(14);
    expect(rumor.pubkey).toBe(getPublicKey(sk));
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

  it('a sexualContent report decodes to the NSFW report type', async () => {
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

  // The trust boundary: a report DM is the least verified report we accept.
  // Any key that can reach the moderation inbox can send one, the sha256 is
  // client-supplied, and nothing here fetches the target event, requires a
  // Divine client, or passes the relay's processed-key gate. Two of them must
  // therefore still land on a human rather than auto-hiding public content.
  it('two distinct NSFW report DMs stay REVIEW instead of auto age-restricting', async () => {
    const secondReporterSk = generateSecretKey();
    expect(getPublicKey(secondReporterSk)).not.toBe(getPublicKey(reporterSk));

    for (const [i, sk] of [reporterSk, secondReporterSk].entries()) {
      await roundTrip(
        mobileReportDmTags({
          nip32Label: 'NS-sexualContent',
          nip56Type: 'nudity',
          sha256: SHA256,
        }),
        'Content Report\nReason: Sexual Content\nEvent: ' + 'e'.repeat(64),
        `gw-nsfw-escalation-${i}`,
        sk,
      );
    }

    // Two distinct reporters really did land — this is the input that would
    // trip AGE_RESTRICTED if the DM path opted into auto-escalation.
    const reports = await db.prepare('SELECT * FROM user_reports').all();
    expect(reports.results).toHaveLength(2);
    const { isNsfwReportType } = await import('../reports.mjs');
    expect(isNsfwReportType(reports.results[0].report_type)).toBe(true);

    const moderation = await db.prepare('SELECT * FROM moderation_results').first();
    expect(moderation.action).toBe('REVIEW');
    expect(moderation.action).not.toBe('AGE_RESTRICTED');
    expect(JSON.parse(moderation.raw_response).source).toBe('dm-report');
  });

  // The same boundary from the other side. Keeping the DM path REVIEW-only
  // stops a report DM escalating on its own, but the authenticated HTTP route
  // still auto-escalates on two distinct reporters -- and it counts reporters
  // per sha256, not per source. A report DM must therefore not be able to
  // supply one of those two, or a single minted key plus one genuine report
  // would hide public content.
  it('a report DM cannot complete the authenticated path\'s two-reporter threshold', async () => {
    const { recordReportForReview } = await import('../moderation/report-review.mjs');

    await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-sexualContent',
        nip56Type: 'nudity',
        sha256: SHA256,
      }),
      'Content Report\nReason: Sexual Content\nEvent: ' + 'e'.repeat(64),
      'gw-nsfw-mixed',
    );

    // Now a genuine report for the same blob through POST /api/v1/report.
    const httpResult = await recordReportForReview(db, {
      sha256: SHA256,
      reporterPubkey: 'c'.repeat(64),
      reportType: 'nudity',
      source: 'user-report',
    });

    expect(httpResult.distinctReporterCount).toBe(2);
    expect(httpResult.escalationReporterCount).toBe(1);
    expect(httpResult.action).toBe('REVIEW');

    const moderation = await db.prepare('SELECT * FROM moderation_results').first();
    expect(moderation.action).toBe('REVIEW');
  });

  // The upgrade side of that same boundary. A reporter who DM'd first and then
  // filed an authenticated report is one genuine reporter, not zero -- but
  // INSERT OR IGNORE pinned their row to 'dm-report', so they stayed out of the
  // escalation count for good. Only the trusted paths can drive the upgrade; a
  // report DM never promotes itself.
  it('a reporter who DM\'d first counts once they report through the authenticated path', async () => {
    const { recordReportForReview } = await import('../moderation/report-review.mjs');

    const { rumor } = await roundTrip(
      mobileReportDmTags({
        nip32Label: 'NS-sexualContent',
        nip56Type: 'nudity',
        sha256: SHA256,
      }),
      'Content Report\nReason: Sexual Content\nEvent: ' + 'e'.repeat(64),
      'gw-nsfw-upgrade',
    );

    // Same key, same blob, now through POST /api/v1/report.
    const upgraded = await recordReportForReview(db, {
      sha256: SHA256,
      reporterPubkey: rumor.pubkey,
      reportType: 'nudity',
      source: 'user-report',
    });

    expect(upgraded.distinctReporterCount).toBe(1);
    expect(upgraded.escalationReporterCount).toBe(1);
    expect(upgraded.action).toBe('REVIEW'); // one reporter is still only one

    // And they now count as one of the two the authenticated path escalates on.
    const second = await recordReportForReview(db, {
      sha256: SHA256,
      reporterPubkey: 'c'.repeat(64),
      reportType: 'nudity',
      source: 'user-report',
    });

    expect(second.escalationReporterCount).toBe(2);
    expect(second.action).toBe('AGE_RESTRICTED');
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
