// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for reporter lookup helpers (reports.mjs)
// ABOUTME: Verifies D1-backed reporter pubkey lookup used by dm-sender

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { initReportsTable, addReport, getReportCount, getReporterPubkeys, isAiReportType, isNsfwReportType } from './reports.mjs';

const SHA256 = ('a'.repeat(63) + '1').slice(0, 64);
const REPORTER1 = ('b'.repeat(63) + '1').slice(0, 64);
const REPORTER2 = ('b'.repeat(63) + '2').slice(0, 64);
const REPORTER3 = ('b'.repeat(63) + '3').slice(0, 64);
const REPORTER4 = ('b'.repeat(63) + '4').slice(0, 64);
const REPORTER5 = ('b'.repeat(63) + '5').slice(0, 64);

async function insertReport(db, { sha256, reporter_pubkey, report_type, reason }) {
  await db.prepare(`
    INSERT OR IGNORE INTO user_reports (sha256, reporter_pubkey, report_type, reason)
    VALUES (?, ?, ?, ?)
  `).bind(sha256, reporter_pubkey, report_type, reason ?? null).run();
}

describe('reports', () => {
  const db = env.BLOSSOM_DB;

  beforeEach(async () => {
    await initReportsTable(db);
    await db.prepare('DELETE FROM user_reports').run();
  });

  describe('isAiReportType', () => {
    it('matches AI and deepfake report labels case-insensitively', () => {
      expect(isAiReportType('ai')).toBe(true);
      expect(isAiReportType('AI_GENERATED')).toBe(true);
      expect(isAiReportType('synthetic-media')).toBe(true);
      expect(isAiReportType('deepfake')).toBe(true);
    });

    it('does not match ordinary safety report labels', () => {
      expect(isAiReportType('nudity')).toBe(false);
      expect(isAiReportType('violence')).toBe(false);
      expect(isAiReportType('spam')).toBe(false);
      expect(isAiReportType(null)).toBe(false);
    });
  });

  describe('isNsfwReportType', () => {
    it('matches nudity/porn/nsfw labels case-insensitively', () => {
      expect(isNsfwReportType('nudity')).toBe(true);
      expect(isNsfwReportType('PORN')).toBe(true);
      expect(isNsfwReportType('nsfw')).toBe(true);
      expect(isNsfwReportType('sexual_content')).toBe(true);
      expect(isNsfwReportType('explicit')).toBe(true);
      expect(isNsfwReportType('Adult Content')).toBe(true);
    });

    it('does not match non-NSFW report labels', () => {
      expect(isNsfwReportType('violence')).toBe(false);
      expect(isNsfwReportType('hate')).toBe(false);
      expect(isNsfwReportType('spam')).toBe(false);
      expect(isNsfwReportType('ai_generated')).toBe(false);
      expect(isNsfwReportType(null)).toBe(false);
      expect(isNsfwReportType(undefined)).toBe(false);
    });
  });

  describe('addReport', () => {
    it('should add a new report and not escalate', async () => {
      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
        reason: 'inappropriate content',
      });

      expect(result).toMatchObject({ escalate: null, distinctReporterCount: 1 });
    });

    it('should deduplicate same reporter for same sha256', async () => {
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
      });

      // Same reporter, same sha256 — should not increase count
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'spam',
        reason: 'duplicate report',
      });

      const count = await getReportCount(db, SHA256);
      expect(count).toBe(1);
    });

    it('should count different reporters separately', async () => {
      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER1,
        report_type: 'nudity',
      });

      await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER2,
        report_type: 'nudity',
      });

      const count = await getReportCount(db, SHA256);
      expect(count).toBe(2);
    });

    it('stores an explicit created_at timestamp when provided', async () => {
      const sha256 = 'a'.repeat(64);
      const reporter = 'b'.repeat(64);
      const createdAt = '2026-05-13T17:19:42.000Z';

      await addReport(env.BLOSSOM_DB, {
        sha256,
        reporter_pubkey: reporter,
        report_type: 'ai_generated',
        reason: 'reported from kind 1984',
        created_at: createdAt,
      });

      const row = await env.BLOSSOM_DB.prepare(`
        SELECT sha256, reporter_pubkey, report_type, reason, created_at
        FROM user_reports
        WHERE sha256 = ? AND reporter_pubkey = ?
      `).bind(sha256, reporter).first();

      expect(row).toMatchObject({
        sha256,
        reporter_pubkey: reporter,
        report_type: 'ai_generated',
        reason: 'reported from kind 1984',
        created_at: createdAt,
      });
    });

    it('keeps CURRENT_TIMESTAMP behavior when created_at is omitted', async () => {
      const sha256 = 'c'.repeat(64);
      const reporter = 'd'.repeat(64);

      await addReport(env.BLOSSOM_DB, {
        sha256,
        reporter_pubkey: reporter,
        report_type: 'nudity',
      });

      const row = await env.BLOSSOM_DB.prepare(`
        SELECT created_at
        FROM user_reports
        WHERE sha256 = ? AND reporter_pubkey = ?
      `).bind(sha256, reporter).first();

      expect(typeof row.created_at).toBe('string');
      expect(row.created_at.length).toBeGreaterThan(0);
    });
  });

  describe('escalation thresholds', () => {
    it('should escalate to REVIEW at 3 unique reporters', async () => {
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });

      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER3,
        report_type: 'nudity',
      });

      expect(result).toMatchObject({ escalate: 'REVIEW', distinctReporterCount: 3 });
    });

    it('should escalate to AGE_RESTRICTED at 5 unique reporters', async () => {
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER3, report_type: 'nudity' });
      await addReport(db, { sha256: SHA256, reporter_pubkey: REPORTER4, report_type: 'nudity' });

      const result = await addReport(db, {
        sha256: SHA256,
        reporter_pubkey: REPORTER5,
        report_type: 'nudity',
      });

      expect(result).toMatchObject({ escalate: 'AGE_RESTRICTED', distinctReporterCount: 5 });
    });
  });

  describe('getReportCount', () => {
    it('should return 0 for unreported sha256', async () => {
      const unreportedSha256 = ('c'.repeat(63) + '1').slice(0, 64);
      const count = await getReportCount(db, unreportedSha256);
      expect(count).toBe(0);
    });
  });

  describe('getReporterPubkeys', () => {
    it('should return empty array for unreported sha256', async () => {
      const reporters = await getReporterPubkeys(db, ('c'.repeat(63) + '1').slice(0, 64));
      expect(reporters).toEqual([]);
    });

    it('should return unique reporters with report dates', async () => {
      await insertReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await insertReport(db, { sha256: SHA256, reporter_pubkey: REPORTER2, report_type: 'nudity' });
      // Duplicate from REPORTER1 -- should not appear twice
      await insertReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'spam' });

      const reporters = await getReporterPubkeys(db, SHA256);
      expect(reporters).toHaveLength(2);
      const pubkeys = reporters.map(r => r.pubkey);
      expect(pubkeys).toContain(REPORTER1);
      expect(pubkeys).toContain(REPORTER2);
      // Each reporter should have a reportedAt date
      for (const r of reporters) {
        expect(r.reportedAt).toBeTruthy();
      }
    });

    it('should not return reporters for different sha256', async () => {
      const otherSha256 = ('d'.repeat(63) + '1').slice(0, 64);
      await insertReport(db, { sha256: SHA256, reporter_pubkey: REPORTER1, report_type: 'nudity' });
      await insertReport(db, { sha256: otherSha256, reporter_pubkey: REPORTER2, report_type: 'nudity' });

      const reporters = await getReporterPubkeys(db, SHA256);
      expect(reporters).toHaveLength(1);
      expect(reporters[0].pubkey).toBe(REPORTER1);
    });
  });
});
