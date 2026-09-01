// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests shared user-report recording into D1 review rows
// ABOUTME: Ensures HTTP and relay report ingestion use identical moderation policy

import { describe, expect, it } from 'vitest';
import { recordReportForReview } from './report-review.mjs';
import { NON_ESCALATING_SOURCES, SUPERSEDABLE_SOURCES } from '../reports.mjs';

const SHA = 'a'.repeat(64);
const REPORTER = 'b'.repeat(64);

function createDbMock({
  reporterCount = 1,
  // Defaults to reporterCount: unless a test says otherwise, every reporter on
  // the row is one whose source may drive an automatic outcome.
  escalationReporterCount = reporterCount,
  moderationWrites = [],
  userReportWrites = [],
  aiDetectionEvents = [],
  failModerationWrite = false,
  failAiTelemetryWrite = false,
  // undefined → the SELECT uploaded_by lookup finds no row (uploader unknown).
  storedUploadedBy,
} = {}) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async run() {
          if (/INSERT OR IGNORE INTO user_reports/i.test(sql)) {
            userReportWrites.push({ sql, bindings: [...bindings] });
          }
          if (/INSERT INTO moderation_results/i.test(sql)) {
            if (failModerationWrite) {
              throw new Error('moderation write failed');
            }
            moderationWrites.push({ sql, bindings: [...bindings] });
          }
          if (/INSERT OR IGNORE INTO ai_detection_events/i.test(sql)) {
            if (failAiTelemetryWrite) {
              throw new Error('ai telemetry write failed');
            }
            aiDetectionEvents.push({
              event_key: bindings[0],
              sha256: bindings[1],
              event_type: bindings[2],
              policy_reason: bindings[3],
              ai_detection_forced: bindings[6],
              report_type: bindings[9],
            });
          }
          return { success: true };
        },
        async first() {
          if (/COUNT\(DISTINCT reporter_pubkey\)/i.test(sql)) {
            return { cnt: reporterCount, escalation_cnt: escalationReporterCount };
          }
          if (/SELECT uploaded_by FROM moderation_results/i.test(sql)) {
            return storedUploadedBy === undefined ? null : { uploaded_by: storedUploadedBy };
          }
          return null;
        },
      };
    },
  };
}

describe('recordReportForReview', () => {
  it('writes REVIEW for a single non-NSFW report with report metadata and uploader', async () => {
    const moderationWrites = [];
    const userReportWrites = [];
    const db = createDbMock({ moderationWrites, userReportWrites });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'violence',
      reason: 'reported from relay',
      source: 'relay-report',
      reportedAt: '2026-05-13T17:19:42.000Z',
      reportEventId: 'c'.repeat(64),
      targetEventId: 'd'.repeat(64),
      uploadedBy: 'e'.repeat(64),
    });

    expect(result).toMatchObject({
      success: true,
      action: 'REVIEW',
      distinctReporterCount: 1,
      aiTelemetryRecorded: false,
    });
    expect(userReportWrites).toHaveLength(1);
    // The row itself, then the conflict guard: upgrade the stored source only
    // when the existing row is a SUPERSEDABLE source (a weak path a stronger
    // report may overtake) and the incoming one is escalation-eligible. The two
    // IN clauses bind different lists — supersedable (excludes self-report, #212)
    // for the existing row, the full non-escalating set for the incoming one.
    expect(userReportWrites[0].bindings).toEqual([
      SHA,
      REPORTER,
      'violence',
      'reported from relay',
      '2026-05-13T17:19:42.000Z',
      'relay-report',
      ...SUPERSEDABLE_SOURCES,
      ...NON_ESCALATING_SOURCES,
    ]);
    expect(userReportWrites[0].sql).toMatch(/ON CONFLICT\(sha256, reporter_pubkey\) DO UPDATE SET source = excluded\.source/i);
    expect(moderationWrites).toHaveLength(1);
    expect(moderationWrites[0].sql).toMatch(/uploaded_by = CASE/i);
    expect(moderationWrites[0].sql).toMatch(/moderation_results\.uploaded_by IS NULL/i);
    expect(moderationWrites[0].bindings[0]).toBe(SHA);
    expect(moderationWrites[0].bindings[1]).toBe('REVIEW');
    expect(moderationWrites[0].bindings[2]).toBe('user-report');
    expect(moderationWrites[0].bindings[10]).toBe('e'.repeat(64));
    expect(JSON.parse(moderationWrites[0].bindings[5])).toMatchObject({
      source: 'relay-report',
      reportType: 'violence',
      reportedBy: REPORTER,
      distinctReporterCount: 1,
      reason: 'reported from relay',
      reportEventId: 'c'.repeat(64),
      targetEventId: 'd'.repeat(64),
    });
  });

  it('writes AGE_RESTRICTED and adult category for the second distinct authenticated NSFW report', async () => {
    const moderationWrites = [];
    const db = createDbMock({ moderationWrites, reporterCount: 2 });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'nudity',
      source: 'user-report',
    });

    expect(result.action).toBe('AGE_RESTRICTED');
    expect(moderationWrites).toHaveLength(1);
    expect(moderationWrites[0].bindings[1]).toBe('AGE_RESTRICTED');
    expect(JSON.parse(moderationWrites[0].bindings[4])).toEqual(['adult']);
  });

  it('does not let a DM-sourced reporter complete the authenticated threshold', async () => {
    const moderationWrites = [];
    // Two distinct reporters on the row, but only one of them came from a
    // source allowed to drive an automatic outcome -- the other is a report DM.
    const db = createDbMock({ moderationWrites, reporterCount: 2, escalationReporterCount: 1 });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'nudity',
      source: 'user-report',
    });

    expect(result.action).toBe('REVIEW');
    expect(result.distinctReporterCount).toBe(2);
    expect(result.escalationReporterCount).toBe(1);
    expect(moderationWrites[0].bindings[1]).toBe('REVIEW');
    // Both counts are recorded so a moderator can see why it did not escalate.
    expect(JSON.parse(moderationWrites[0].bindings[5])).toMatchObject({
      distinctReporterCount: 2,
      escalationReporterCount: 1,
    });
  });

  it('keeps relay-origin NSFW reports in REVIEW even with multiple distinct reporters', async () => {
    const moderationWrites = [];
    const db = createDbMock({ moderationWrites, reporterCount: 2 });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'nudity',
      source: 'relay-report',
    });

    expect(result.action).toBe('REVIEW');
    expect(result.distinctReporterCount).toBe(2);
    expect(moderationWrites).toHaveLength(1);
    expect(moderationWrites[0].bindings[1]).toBe('REVIEW');
    expect(JSON.parse(moderationWrites[0].bindings[4])).toEqual(['adult']);
  });

  it('records AI telemetry for AI report types', async () => {
    const moderationWrites = [];
    const aiDetectionEvents = [];
    const db = createDbMock({ moderationWrites, aiDetectionEvents });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'ai_generated',
      source: 'relay-report',
      reportedAt: '2026-05-13T17:19:42.000Z',
    });

    expect(result.aiTelemetryRecorded).toBe(true);
    expect(aiDetectionEvents).toHaveLength(1);
    expect(aiDetectionEvents[0]).toMatchObject({
      sha256: SHA,
      event_type: 'user_report',
      policy_reason: 'report_forced_ai_detection',
      ai_detection_forced: 1,
      report_type: 'ai_generated',
    });
  });

  it('returns success with non-fatal moderation write failure details after addReport succeeds', async () => {
    const userReportWrites = [];
    const db = createDbMock({ userReportWrites, failModerationWrite: true });

    await expect(recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'violence',
      source: 'user-report',
    })).resolves.toMatchObject({
      success: true,
      action: 'REVIEW',
      distinctReporterCount: 1,
      moderationResultRecorded: false,
      moderationResultError: 'moderation write failed',
    });
    expect(userReportWrites).toHaveLength(1);
  });

  it('returns success and aiTelemetryRecorded false when AI telemetry write fails', async () => {
    const aiDetectionEvents = [];
    const db = createDbMock({ aiDetectionEvents, failAiTelemetryWrite: true });

    await expect(recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'ai_generated',
      source: 'user-report',
    })).resolves.toMatchObject({
      success: true,
      action: 'REVIEW',
      distinctReporterCount: 1,
      aiTelemetryRecorded: false,
      aiTelemetryError: 'ai telemetry write failed',
    });
    expect(aiDetectionEvents).toHaveLength(0);
  });
});

describe('recordReportForReview self-report guard (#211)', () => {
  it('flags a self-report (reporter == uploader) and never auto-acts', async () => {
    const userReportWrites = [];
    const moderationWrites = [];
    // NSFW + escalation >= 2 would normally AGE_RESTRICT; the flag must prevent
    // that AND mark the row a non-escalating self-report.
    const db = createDbMock({
      userReportWrites,
      moderationWrites,
      reporterCount: 2,
      escalationReporterCount: 2,
    });

    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'nudity',
      source: 'user-report',
      uploadedBy: REPORTER, // reporter reports their own upload
    });

    expect(NON_ESCALATING_SOURCES).toContain('self-report');
    expect(userReportWrites[0].bindings[5]).toBe('self-report'); // source column
    expect(result.action).toBe('REVIEW'); // not AGE_RESTRICTED
    expect(result.isSelfReport).toBe(true);
  });

  it('matches the uploader case-insensitively', async () => {
    const userReportWrites = [];
    const db = createDbMock({ userReportWrites });
    await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'spam',
      source: 'relay-report',
      uploadedBy: REPORTER.toUpperCase(),
    });
    expect(userReportWrites[0].bindings[5]).toBe('self-report'); // source column
  });

  it('does not flag when reporter and uploader differ', async () => {
    const userReportWrites = [];
    const db = createDbMock({ userReportWrites });
    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'spam',
      source: 'relay-report',
      uploadedBy: 'c'.repeat(64),
    });
    expect(userReportWrites[0].bindings[5]).toBe('relay-report'); // source unchanged
    expect(result.isSelfReport).toBe(false);
  });

  it('does not flag when the uploader is unknown (no param, no stored row)', async () => {
    const userReportWrites = [];
    // createDbMock's first() returns null for the SELECT uploaded_by lookup,
    // so the uploader is unknown and the guard must skip rather than guess.
    const db = createDbMock({ userReportWrites });
    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'spam',
      source: 'user-report',
    });
    expect(userReportWrites[0].bindings[5]).toBe('user-report'); // source unchanged
    expect(result.isSelfReport).toBe(false);
  });

  it('flags via the uploaded_by lookup when no uploadedBy param is passed', async () => {
    const userReportWrites = [];
    // No uploadedBy param → the guard must resolve the uploader from the stored
    // moderation row (the HTTP/DM path's only signal). Also regression-guards
    // the exact field name a lookup bug would get wrong.
    const db = createDbMock({ userReportWrites, storedUploadedBy: REPORTER });
    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'spam',
      source: 'user-report',
    });
    expect(userReportWrites[0].bindings[5]).toBe('self-report');
    expect(result.isSelfReport).toBe(true);
  });

  it('does not flag when the looked-up uploader differs from the reporter', async () => {
    const userReportWrites = [];
    const db = createDbMock({ userReportWrites, storedUploadedBy: 'c'.repeat(64) });
    const result = await recordReportForReview(db, {
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'spam',
      source: 'user-report',
    });
    expect(userReportWrites[0].bindings[5]).toBe('user-report');
    expect(result.isSelfReport).toBe(false);
  });
});
