// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests shared user-report recording into D1 review rows
// ABOUTME: Ensures HTTP and relay report ingestion use identical moderation policy

import { describe, expect, it } from 'vitest';
import { recordReportForReview } from './report-review.mjs';

const SHA = 'a'.repeat(64);
const REPORTER = 'b'.repeat(64);

function createDbMock({
  reporterCount = 1,
  moderationWrites = [],
  userReportWrites = [],
  aiDetectionEvents = [],
  failModerationWrite = false,
  failAiTelemetryWrite = false,
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
            return { cnt: reporterCount };
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
    expect(userReportWrites[0].bindings).toEqual([
      SHA,
      REPORTER,
      'violence',
      'reported from relay',
      '2026-05-13T17:19:42.000Z',
    ]);
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
