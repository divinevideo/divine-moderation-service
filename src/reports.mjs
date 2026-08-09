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
      source TEXT,
      UNIQUE(sha256, reporter_pubkey)
    )
  `).run();

  // CREATE TABLE IF NOT EXISTS cannot add `source` to a table that already
  // exists, and `user_reports` is created here rather than by a file in
  // migrations/ -- so for every database that predates this column, the
  // ALTER below is the only thing that adds it. Same reasoning as
  // initDmReadStateTable's: CI deploys the worker on every push to main but
  // never runs `wrangler d1 migrations apply`, so a schema change that only
  // exists as a migration would ship code referencing a column production
  // does not have.
  const columns = await db.prepare('PRAGMA table_info(user_reports)').all();
  const hasSource = (columns?.results || []).some((column) => column.name === 'source');
  if (!hasSource) {
    await db.prepare('ALTER TABLE user_reports ADD COLUMN source TEXT').run();
  }
}

// The one report source whose reporter identity is not established well enough
// to count toward an automatic moderation outcome. A `dm-report` reporter is
// whatever key reached the moderation inbox over NIP-17: nothing signs for the
// reported sha256, nothing proves the key belongs to a distinct person, and
// minting fresh keys is free. Such a report is still recorded and still shown
// to a human -- it just cannot be one of the two "distinct reporters" that
// auto age-restriction counts, or a single actor could supply both halves of
// the threshold the authenticated path relies on.
const NON_ESCALATING_SOURCE = 'dm-report';

/**
 * Insert a report and return the legacy escalation level plus two reporter
 * counts, so callers can apply per-report-type policy (e.g. NSFW needs 2
 * unique reporters before auto AGE_RESTRICTED to defend against single-token
 * griefing).
 *
 * `distinctReporterCount` counts every distinct reporter, whatever the source
 * -- it is what the admin UI and the HTTP report response report, and its
 * meaning is unchanged. `escalationReporterCount` counts only the reporters
 * whose source may drive an automatic outcome; it is the one the
 * AGE_RESTRICTED gate uses. Rows written before `source` existed are NULL and
 * count toward both, since the DM path never actually produced a row until
 * tag-based report classification landed (its predecessor sat behind a
 * `JSON.parse(content)` branch no client ever triggered).
 *
 * @param {D1Database} db
 * @param {{sha256: string, reporter_pubkey: string, report_type: string, reason?: string, created_at?: string, source?: string}} report
 * @returns {Promise<{escalate: 'AGE_RESTRICTED'|'REVIEW'|null, distinctReporterCount: number, escalationReporterCount: number}>}
 */
export async function addReport(db, { sha256, reporter_pubkey, report_type, reason, created_at, source = null }) {
  await db.prepare(`
    INSERT OR IGNORE INTO user_reports (sha256, reporter_pubkey, report_type, reason, created_at, source)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
  `).bind(sha256, reporter_pubkey, report_type, reason ?? null, created_at ?? null, source ?? null).run();

  const row = await db.prepare(`
    SELECT
      COUNT(DISTINCT reporter_pubkey) AS cnt,
      COUNT(DISTINCT CASE
        WHEN source IS NULL OR source <> ? THEN reporter_pubkey
      END) AS escalation_cnt
    FROM user_reports
    WHERE sha256 = ?
  `).bind(NON_ESCALATING_SOURCE, sha256).first();

  const count = row?.cnt ?? 0;
  const escalationCount = row?.escalation_cnt ?? 0;

  let escalate = null;
  if (count >= 5) escalate = 'AGE_RESTRICTED';
  else if (count >= 3) escalate = 'REVIEW';

  return { escalate, distinctReporterCount: count, escalationReporterCount: escalationCount };
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
