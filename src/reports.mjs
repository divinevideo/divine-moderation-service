// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Reporter lookup for DM moderation notifications
// ABOUTME: Exposes the user_reports table schema + reporter pubkey lookup used by dm-sender

/**
 * Create user_reports table if it doesn't exist
 * @param {D1Database} db
 */
export async function initReportsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS user_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL,
      reporter_pubkey TEXT NOT NULL,
      report_type TEXT NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sha256, reporter_pubkey)
    )
  `).run();
}

/**
 * Return all unique reporters for a sha256 with their earliest report date
 * @param {D1Database} db
 * @param {string} sha256
 * @returns {Promise<Array<{pubkey: string, reportedAt: string}>>}
 */
export async function getReporterPubkeys(db, sha256) {
  const { results } = await db.prepare(`
    SELECT reporter_pubkey, MIN(created_at) as reported_at
    FROM user_reports
    WHERE sha256 = ?
    GROUP BY reporter_pubkey
  `).bind(sha256).all();

  return results.map(r => ({ pubkey: r.reporter_pubkey, reportedAt: r.reported_at }));
}
