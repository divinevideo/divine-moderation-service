// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for reporter lookup helpers (reports.mjs)
// ABOUTME: Verifies D1-backed reporter pubkey lookup used by dm-sender

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { initReportsTable, getReporterPubkeys } from './reports.mjs';

const SHA256 = ('a'.repeat(63) + '1').slice(0, 64);
const REPORTER1 = ('b'.repeat(63) + '1').slice(0, 64);
const REPORTER2 = ('b'.repeat(63) + '2').slice(0, 64);

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
