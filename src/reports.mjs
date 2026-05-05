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
 * Insert a report and return escalation level based on unique reporter count
 * @param {D1Database} db
 * @param {{sha256: string, reporter_pubkey: string, report_type: string, reason?: string}} report
 * @returns {Promise<{escalate: 'AGE_RESTRICTED'|'REVIEW'|null}>}
 */
export async function addReport(db, { sha256, reporter_pubkey, report_type, reason }) {
  await db.prepare(`
    INSERT OR IGNORE INTO user_reports (sha256, reporter_pubkey, report_type, reason)
    VALUES (?, ?, ?, ?)
  `).bind(sha256, reporter_pubkey, report_type, reason ?? null).run();

  const row = await db.prepare(`
    SELECT COUNT(DISTINCT reporter_pubkey) AS cnt
    FROM user_reports
    WHERE sha256 = ?
  `).bind(sha256).first();

  const count = row?.cnt ?? 0;

  if (count >= 5) return { escalate: 'AGE_RESTRICTED' };
  if (count >= 3) return { escalate: 'REVIEW' };
  return { escalate: null };
}

const AI_REPORT_TYPES = new Set([
  'ai',
  'ai-generated',
  'ai_generated',
  'aigenerated',
  'synthetic',
  'synthetic-media',
  'synthetic_media',
  'deepfake',
]);

const NSFW_REPORT_TYPES = new Set([
  'nudity',
  'porn',
  'pornography',
  'nsfw',
  'sexual',
  'sexual_content',
  'sexual-content',
  'explicit',
  'adult',
  'adult_content',
  'adult-content',
]);

function normalizeReportType(reportType) {
  if (typeof reportType !== 'string') return '';
  return reportType.trim().toLowerCase().replace(/\s+/g, '_');
}

export function isAiReportType(reportType) {
  return AI_REPORT_TYPES.has(normalizeReportType(reportType));
}

export function isNsfwReportType(reportType) {
  return NSFW_REPORT_TYPES.has(normalizeReportType(reportType));
}

/**
 * Return the number of unique reporters for a sha256
 * @param {D1Database} db
 * @param {string} sha256
 * @returns {Promise<number>}
 */
export async function getReportCount(db, sha256) {
  const row = await db.prepare(`
    SELECT COUNT(DISTINCT reporter_pubkey) AS cnt
    FROM user_reports
    WHERE sha256 = ?
  `).bind(sha256).first();

  return row?.cnt ?? 0;
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
