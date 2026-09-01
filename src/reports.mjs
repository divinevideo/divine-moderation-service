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

/**
 * Whether this reporter already has a row for this sha256.
 *
 * Used by the DM reader to tell "this report is already ingested" apart from
 * "this gift wrap is already in dm_log", which are not the same thing: the
 * report write is wrapped in a warn-and-continue block, so a transient failure
 * leaves the DM logged and the report missing. Asking about the report row
 * directly is what keeps that case retryable on the next poll.
 *
 * @param {D1Database} db
 * @param {string} sha256
 * @param {string} reporterPubkey
 * @returns {Promise<Object|null>} the matching row, or null
 */
export async function findReportByReporter(db, sha256, reporterPubkey) {
  return db.prepare(
    'SELECT id FROM user_reports WHERE sha256 = ? AND reporter_pubkey = ?'
  ).bind(sha256, reporterPubkey).first();
}

// Sources whose reporters may never drive an automatic outcome, and so are
// excluded from escalationReporterCount. A report DM is the least verified
// path; an untrusted-client relay report carries an unauthenticated, optional
// NIP-89 `client` tag that anyone can forge; and a `self-report` is someone
// reporting their own content (#211) — none may supply part of the
// AGE_RESTRICTED threshold. All are still recorded for human review.
export const NON_ESCALATING_SOURCES = Object.freeze(['dm-report', 'relay-report-untrusted', 'self-report']);

const nonEscalatingPlaceholders = NON_ESCALATING_SOURCES.map(() => '?').join(', ');

// The subset of non-escalating sources a stronger, escalation-eligible report
// may supersede on conflict: a reporter first seen via a weak path (a DM, an
// untrusted-client relay report) should count toward escalation once they also
// report through an authenticated/trusted path. 'self-report' is deliberately
// excluded (#212): it describes the reporter's identity relative to the content
// (permanent), not verification strength — a later report from the same person
// on their own content is still a self-report and must never be upgraded back to
// an escalating source.
export const SUPERSEDABLE_SOURCES = Object.freeze(['dm-report', 'relay-report-untrusted']);

const supersedablePlaceholders = SUPERSEDABLE_SOURCES.map(() => '?').join(', ');

/**
 * Scan-time self-report reconcile (#212). Once the scan pipeline knows the
 * verified uploader for [sha256], flag any report already filed by that uploader
 * as a self-report — the HTTP path may have recorded it before uploaded_by
 * existed, so the ingest-time guard in recordReportForReview could not see the
 * match. This excludes it from all future escalation counts; it does not undo an
 * escalation that already fired (which needs a co-reporter in the sub-scan window
 * and gets human review anyway).
 *
 * PROVENANCE (accepted risk): [uploadedBy] is only as trustworthy as its
 * producer. Today's callers pass the value the scan pipeline derived for the
 * content, and self-report is non-escalating — flagging can only *suppress*
 * escalation, never cause it — so a wrong uploader at worst under-flags. It can
 * never manufacture a self-report against a third party's content, since the
 * match is uploader-against-reporter on the same sha256. If a future caller ever
 * fed an attacker-controlled uploader here, revisit: the safe direction is still
 * that self-report only ever removes a reporter from the escalation count.
 *
 * KNOWN GAP (#212): this updates user_reports.source only. A moderation_results
 * row written by an earlier ingest still carries raw_response.selfReport=false;
 * nothing reads that field yet, but a consumer that did would see it disagree
 * with the reconciled source until the next write. Left as follow-up.
 *
 * @param {D1Database} db
 * @param {string} sha256
 * @param {string|null|undefined} uploadedBy - the verified content uploader
 */
export async function reconcileSelfReportsForUploader(db, sha256, uploadedBy) {
  if (!sha256 || !uploadedBy) return;
  await db.prepare(`
    UPDATE user_reports
    SET source = 'self-report'
    WHERE sha256 = ?
      AND LOWER(reporter_pubkey) = LOWER(?)
      AND (source IS NULL OR source != 'self-report')
  `).bind(sha256, uploadedBy).run();
}

/**
 * Insert a report and return two reporter counts, so callers can apply
 * per-report-type policy (e.g. NSFW needs 2 unique reporters before auto
 * AGE_RESTRICTED to defend against single-token griefing).
 *
 * Counting is all this does. It used to also return an `escalate` level of its
 * own, off 3-and-5-reporter thresholds that nothing in the service enforced --
 * a second opinion with no authority, which `/api/v1/report` then echoed to
 * clients as though it were the outcome. Whether a report escalates depends on
 * the report type and the source policy, neither of which is knowable here;
 * recordReportForReview is the only caller and the only place that knows both.
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
 * @returns {Promise<{distinctReporterCount: number, escalationReporterCount: number}>}
 */
export async function addReport(db, { sha256, reporter_pubkey, report_type, reason, created_at, source = null }) {
  // One report can reach two ingestion paths: divine-mobile publishes the
  // kind-1984 and sends the report DM for the same content from the same key,
  // so both write this same (sha256, reporter_pubkey) row. The two paths were
  // made to agree on `report_type`, but they cannot agree on `source` -- it
  // names the path they came in through. Under a plain INSERT OR IGNORE that
  // left arrival order deciding whether a reporter is escalation-eligible,
  // and a reporter pinned to 'dm-report' stayed excluded from
  // escalationReporterCount forever, even after reporting again through the
  // authenticated route.
  //
  // So upgrade on conflict, in one direction only: once a reporter has been
  // seen through a path that may drive an automatic outcome, that sticks. A
  // later report DM or untrusted-client relay report never downgrades a
  // reporter the HTTP or trusted relay path already established. Everything
  // else about the row stays first-write-wins -- `report_type`, `reason` and
  // `created_at` keep the report of record as it was first filed.
  //
  // Only a SUPERSEDABLE source may be upgraded (#212): the existing row must be
  // 'dm-report' or 'relay-report-untrusted'. 'self-report' is deliberately not
  // in that set, so a later user-report from the same key on the same content --
  // e.g. a self-reporter's client retrying while the ingest-time uploader lookup
  // was momentarily unavailable -- can never flip a reconciled self-report back
  // to an escalating source. The excluded-source guard still uses the full
  // non-escalating set, so an incoming self-report never upgrades anything either.
  await db.prepare(`
    INSERT OR IGNORE INTO user_reports (sha256, reporter_pubkey, report_type, reason, created_at, source)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
    ON CONFLICT(sha256, reporter_pubkey) DO UPDATE SET source = excluded.source
      WHERE user_reports.source IN (${supersedablePlaceholders})
        AND excluded.source IS NOT NULL
        AND excluded.source NOT IN (${nonEscalatingPlaceholders})
  `).bind(
    sha256,
    reporter_pubkey,
    report_type,
    reason ?? null,
    created_at ?? null,
    source ?? null,
    ...SUPERSEDABLE_SOURCES,
    ...NON_ESCALATING_SOURCES,
  ).run();

  const row = await db.prepare(`
    SELECT
      COUNT(DISTINCT reporter_pubkey) AS cnt,
      COUNT(DISTINCT CASE
        WHEN source IS NULL OR source NOT IN (${nonEscalatingPlaceholders}) THEN reporter_pubkey
      END) AS escalation_cnt
    FROM user_reports
    WHERE sha256 = ?
  `).bind(...NON_ESCALATING_SOURCES, sha256).first();

  return {
    distinctReporterCount: row?.cnt ?? 0,
    escalationReporterCount: row?.escalation_cnt ?? 0,
  };
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
