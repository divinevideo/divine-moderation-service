// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Durable intake for private DM reports of a message or an account
// ABOUTME: Records each report once and hands it to relay-manager for human review

import { isAiReportType, isNsfwReportType } from '../reports.mjs';
import { getRelayAdminHeaders, getRelayAdminUrl, resolveSecret } from '../relay-admin-transport.mjs';

// relay-manager's internal route for private reports. It queues the reported
// account in Coop, or opens an age-review case for an under-16 report. It does
// no enforcement: everything it creates is a review item for a human.
export const PRIVATE_REPORT_INTAKE_PATH = '/api/internal/private-reports';

// The vocabulary extractReportType resolves a report DM's NS- label to, and the
// only values the handoff sends.
const CANONICAL_PRIVATE_REPORT_TYPES = new Set([
  'spam',
  'harassment',
  'violence',
  'sexual_content',
  'copyright',
  'false_information',
  'child_safety',
  'csam',
  'underage_user',
  'ai_generated',
  'other',
]);

const DEFAULT_DELIVERY_BATCH_LIMIT = 20;
// Comfortably above relay-manager's bound on a Coop handoff, whose Coop call
// times out at 10s. An under-16 report's handoff has no fixed bound there,
// because its keycast read has no timeout, so one can run past this and is
// then retried like any other timeout.
const DELIVERY_TIMEOUT_MS = 30000;
// One timeout is treated as that report's route being slow; this many in a
// row as relay-manager being unreachable, which ends the run.
const CONSECUTIVE_TIMEOUTS_TO_STOP = 2;
// No new handoff starts after this much of a run, so a slow relay-manager
// holds the cron for at most this plus one call's timeout, not 20 timeouts.
// The cron's later steps (dm_log retention, the kind-10050 publish) wait on it.
const DELIVERY_RUN_BUDGET_MS = 90000;
const RETRY_BASE_DELAY_MS = 5 * 60 * 1000;
const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;

const HEX_64 = /^[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create private_report_intake if it doesn't exist.
 *
 * One row per private report: a DM report of a message or an account, which
 * carries a `reported_pubkey` tag and no video sha256, so it has no
 * user_reports row to land in. The row is both the idempotency ledger for the
 * DM reader's two-day re-poll and the outbox the cron delivers to
 * relay-manager from.
 *
 * It holds identifiers only -- who reported whom, for what, and the gift wrap
 * id that links it to its dm_log row -- never the reporter's note or the
 * message they included, which stay in dm_log. Created in code rather than in
 * migrations/ for the reason initReportsTable gives: CI deploys the worker
 * without running `wrangler d1 migrations apply`.
 *
 * Retention: a row pairs a reporter with the account they reported, the same
 * pairing the report's dm_log row already holds, so it follows dm_log's
 * Trust & Safety-decided one-year retention. prunePrivateReportIntake deletes
 * delivered and rejected rows a year after they were recorded, in the cron
 * sweep gated by DM_LOG_RETENTION_ENABLED. A row still pending is kept: it is
 * a report that has not reached a moderator yet, and deleting it would lose
 * the report. See docs/trust-safety-report.md.
 *
 * @param {D1Database} db
 */
export async function initPrivateReportIntakeTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS private_report_intake (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      reporter_pubkey TEXT NOT NULL,
      reported_pubkey TEXT NOT NULL,
      report_type TEXT NOT NULL,
      gift_wrap_id TEXT NOT NULL,
      has_excerpt INTEGER NOT NULL DEFAULT 0,
      reported_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'rejected')),
      outcome TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(reporter_pubkey, report_id)
    )
  `).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_private_report_intake_pending ON private_report_intake(status, next_attempt_at)'
  ).run();
}

/**
 * The idempotency key for a private report.
 *
 * divine-mobile mints one id per report and reuses it on every resend of that
 * report's DM, as the rumor's `batch` tag, so a resend from the retry worker
 * maps onto the row the first send created. Only a UUID or a 64-hex token is
 * taken as one; anything else falls back to the gift wrap id, which still
 * dedups the reader's re-poll of the same gift wrap.
 *
 * @param {Array} tags - rumor tags
 * @param {string} giftWrapId
 * @returns {string}
 */
export function resolvePrivateReportId(tags, giftWrapId) {
  const value = (Array.isArray(tags) ? tags : [])
    .find((tag) => Array.isArray(tag) && tag[0] === 'batch')?.[1];
  if (typeof value === 'string' && (UUID.test(value) || HEX_64.test(value))) {
    return value.toLowerCase();
  }
  return giftWrapId;
}

/**
 * Read a private report's `reported_pubkey` tag.
 *
 * It is the reporter's claim about who they are reporting -- the rumor is
 * unsigned and the reported person's own seal is not forwarded -- so it opens
 * a review item and nothing else.
 *
 * @param {Array} tags - rumor tags
 * @returns {{present: boolean, pubkey: string|null}} `present` with a null
 *   `pubkey` means the tag is there but is not 64 hex
 */
export function parseReportedPubkeyTag(tags) {
  const tag = (Array.isArray(tags) ? tags : [])
    .find((entry) => Array.isArray(entry) && entry[0] === 'reported_pubkey');
  if (!tag) return { present: false, pubkey: null };
  const value = tag[1];
  if (typeof value !== 'string' || !HEX_64.test(value)) {
    return { present: true, pubkey: null };
  }
  return { present: true, pubkey: value.toLowerCase() };
}

/**
 * Clamp a resolved report type to the handoff's vocabulary.
 *
 * extractReportType returns any normalized string when a DM carries no NS-
 * label, so a value outside the set is mapped by meaning where the shared
 * predicates know it, and to 'other' otherwise, which relay-manager queues for
 * general review.
 *
 * @param {string|null|undefined} reportType
 * @returns {string}
 */
export function canonicalPrivateReportType(reportType) {
  if (CANONICAL_PRIVATE_REPORT_TYPES.has(reportType)) return reportType;
  if (isNsfwReportType(reportType)) return 'sexual_content';
  if (isAiReportType(reportType)) return 'ai_generated';
  return 'other';
}

/**
 * Build the INSERT for one private report without running it, so the DM
 * reader can put it in one D1 batch with the report's dm_log row.
 *
 * ON CONFLICT(reporter_pubkey, report_id) DO NOTHING, so the reader's re-poll
 * of the same gift wrap and a second gift wrap carrying the same report id
 * from the same reporter both leave the first row alone. Only that conflict is
 * ignored: unlike INSERT OR IGNORE, a NOT NULL or CHECK violation throws, so
 * a malformed row is logged by the caller rather than dropped without a
 * trace.
 *
 * @param {D1Database} db
 * @param {{reportId: string, reporterPubkey: string, reportedPubkey: string,
 *   reportType: string, giftWrapId: string, hasExcerpt: boolean,
 *   reportedAt: string}} report
 * @returns {D1PreparedStatement}
 */
export function preparePrivateReportIntakeInsert(db, {
  reportId,
  reporterPubkey,
  reportedPubkey,
  reportType,
  giftWrapId,
  hasExcerpt,
  reportedAt,
}) {
  return db.prepare(`
    INSERT INTO private_report_intake (
      report_id, reporter_pubkey, reported_pubkey, report_type,
      gift_wrap_id, has_excerpt, reported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reporter_pubkey, report_id) DO NOTHING
  `).bind(
    reportId,
    reporterPubkey,
    reportedPubkey,
    reportType,
    giftWrapId,
    hasExcerpt ? 1 : 0,
    reportedAt,
  );
}

/**
 * Log a report whose insert changed nothing because its (reporter, report id)
 * is already recorded, when it is not the same report: it names a different
 * account or reason. The recorded row is left as it is, so the conflicting
 * DM is never queued; this makes sure someone hears about it. A faithful
 * resend, the usual reason for a conflict, logs nothing.
 *
 * Logs report and gift wrap ids only, never a pubkey. Never throws: the
 * report's writes have already landed and a failed check must not undo that.
 *
 * @param {D1Database} db
 * @param {Object} report - as for preparePrivateReportIntakeInsert
 * @returns {Promise<boolean>} true when a conflict was logged
 */
export async function logConflictingPrivateReport(db, report) {
  try {
    const stored = await db.prepare(`
      SELECT reported_pubkey, report_type, gift_wrap_id
      FROM private_report_intake
      WHERE reporter_pubkey = ? AND report_id = ?
    `).bind(report.reporterPubkey, report.reportId).first();
    if (!stored) return false;
    const differs = [
      stored.reported_pubkey !== report.reportedPubkey && 'reported account',
      stored.report_type !== report.reportType && 'reason',
    ].filter(Boolean);
    if (!differs.length) return false;
    console.error(`[PRIVATE-REPORTS] Report ${report.reportId} in gift wrap ${report.giftWrapId} names a different ${differs.join(' and ')} than the report recorded under that id from gift wrap ${stored.gift_wrap_id}. The recorded report is kept and this one is not queued for review; read both DMs in the Messages inbox.`);
    return true;
  } catch (err) {
    console.error(`[PRIVATE-REPORTS] Could not check report ${report.reportId} in gift wrap ${report.giftWrapId} against the report already recorded under that id:`, err?.message || String(err));
    return false;
  }
}

/**
 * Record a private report on its own, once: the DM reader's path for a report
 * whose dm_log row already exists. See preparePrivateReportIntakeInsert.
 *
 * @param {D1Database} db
 * @param {Object} report - as for preparePrivateReportIntakeInsert
 * @returns {Promise<{inserted: boolean}>}
 */
export async function recordPrivateReportIntake(db, report) {
  const result = await preparePrivateReportIntakeInsert(db, report).run();
  return { inserted: (result?.meta?.changes ?? 0) > 0 };
}

/**
 * Delay before retrying a report whose handoff failed: five minutes, doubling
 * per attempt, capped at an hour so a stuck child-safety report is never more
 * than an hour from its next try once the cause is fixed.
 *
 * @param {number} attempts - attempts made so far, including the failed one
 * @returns {number} milliseconds
 */
export function privateReportRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(attempts - 1, 16));
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

function handoffBody(row) {
  // Identifiers only. The reporter's note and any message they included stay
  // in dm_log; nothing outside this service receives them.
  return {
    reportId: row.report_id,
    reportedPubkey: row.reported_pubkey,
    reporterPubkey: row.reporter_pubkey,
    reportType: row.report_type,
    reportedAt: row.reported_at,
    hasExcerpt: row.has_excerpt === 1,
    giftWrapId: row.gift_wrap_id,
  };
}

/**
 * POST one report to relay-manager and classify the answer.
 *
 * @returns {Promise<{kind: 'delivered'|'rejected'|'retry', outcome?: string|null,
 *   duplicate?: boolean, error?: string, stopRun?: boolean, timedOut?: boolean}>}
 *   `stopRun` marks a failure every other call in this run would hit too: bad
 *   credentials, an Access bounce, or a connection that failed outright.
 *   `timedOut` is left to the caller, which stops only on consecutive ones.
 */
async function postHandoff(transport, row, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const init = {
    method: 'POST',
    headers: transport.headers,
    body: JSON.stringify(handoffBody(row)),
    redirect: 'manual',
    signal: controller.signal,
  };

  // The timeout covers the body as well as the headers: a response that
  // stalls after its status line would otherwise hold the run open forever.
  let response;
  let text;
  try {
    response = transport.binding
      ? await transport.binding.fetch(transport.url, init)
      : await fetch(transport.url, init);
    text = await response.text();
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { kind: 'retry', error: `timed out after ${timeoutMs / 1000}s`, timedOut: true };
    }
    return { kind: 'retry', error: err?.message || 'request failed', stopRun: true };
  } finally {
    clearTimeout(timeoutId);
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: classified by status alone below.
  }
  // relay-manager's `code` (report_id_conflict, coop_not_configured, ...) is
  // what an operator acts on, so it leads the stored error, ahead of the text.
  const code = typeof data?.code === 'string' && data.code ? ` ${data.code}` : '';
  const detail = `${code}${typeof data?.error === 'string' && data.error ? `: ${data.error}` : ''}`;

  if (response.status === 200 && data?.success === true) {
    return {
      kind: 'delivered',
      outcome: typeof data.outcome === 'string' ? data.outcome : null,
      duplicate: data.duplicate === true,
    };
  }
  if (response.status === 400) {
    return { kind: 'rejected', error: `HTTP 400${detail}` };
  }

  let error = `HTTP ${response.status}${detail}`;
  if (response.status === 302 && /cloudflareaccess\.com/i.test(response.headers.get('location') || '')) {
    error += ' (redirected to Cloudflare Access login)';
  }
  const stopRun = response.status === 401 || response.status === 403 || response.status === 302;
  return { kind: 'retry', error, stopRun };
}

async function resolveTransport(env) {
  const url = `${getRelayAdminUrl(env)}${PRIVATE_REPORT_INTAKE_PATH}`;
  // Same transport callRelayAdminAction uses: the service binding with the
  // shared X-Admin-Key when bound, else the public edge through Cloudflare
  // Access. The shared key is never sent across the public edge.
  const binding = env.RELAY_ADMIN || null;
  if (!binding) {
    return { url, binding: null, headers: getRelayAdminHeaders(env) };
  }
  const adminKey = await resolveSecret(env.RELAY_ADMIN_API_KEY);
  if (!adminKey) {
    console.warn('[PRIVATE-REPORTS] RELAY_ADMIN service binding is present but RELAY_ADMIN_API_KEY is not set; relay-manager will reject the handoff as unauthorized');
  }
  return {
    url,
    binding,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
  };
}

/**
 * Apply one delivery result to a row that is still pending.
 *
 * @returns {Promise<boolean>} false when the row was no longer pending: an
 *   overlapping run settled it first, and its result is kept.
 */
async function settlePendingRow(db, assignments, values, id) {
  const result = await db.prepare(`
    UPDATE private_report_intake
    SET ${assignments}
    WHERE id = ? AND status = 'pending'
  `).bind(...values, id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Hand pending private reports to relay-manager. Runs from the cron.
 *
 * Takes a bounded batch of pending rows whose backoff has expired, CSAM, child
 * safety and under-16 reports first and in arrival order within each, and
 * POSTs each one. Arrival order is the row id, not reported_at: that comes
 * from the rumor, which the sender writes. A 200 with success: true
 * (including `duplicate: true`, an earlier attempt that already landed) marks
 * the row delivered; a 400 marks it rejected, which no retry can fix;
 * anything else keeps it pending with its error and a growing backoff.
 * relay-manager dedups on (reporter, report id), the same key as this table,
 * so a row delivered again after its update was lost comes back
 * `duplicate: true` rather than as a second review item. Two overlapping runs
 * are kept apart by relay-manager's lease: while one attempt holds it, the
 * other gets 503 attempt_in_progress and retries later, and no settle here
 * overwrites a row that is no longer pending.
 *
 * Bounded in time as well as rows: no handoff starts once the run has used
 * its budget, so the cron steps after it are not held for long. Reports left
 * over stay pending for the next run.
 *
 * Never throws: a delivery failure must not fail the cron step that follows.
 *
 * @param {Object} env - BLOSSOM_DB, RELAY_ADMIN / RELAY_ADMIN_URL, RELAY_ADMIN_API_KEY
 * @param {{nowMs?: number, limit?: number, timeoutMs?: number,
 *   budgetMs?: number, clock?: () => number}} [options] timeoutMs bounds each
 *   call, body included; budgetMs bounds the run, measured with clock
 * @returns {Promise<{attempted: number, delivered: number, rejected: number,
 *   retrying: number, stoppedEarly: boolean, error?: string}>}
 */
export async function deliverPendingPrivateReports(env, {
  nowMs = Date.now(),
  limit = DEFAULT_DELIVERY_BATCH_LIMIT,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  budgetMs = DELIVERY_RUN_BUDGET_MS,
  clock = Date.now,
} = {}) {
  const summary = { attempted: 0, delivered: 0, rejected: 0, retrying: 0, stoppedEarly: false };
  const db = env?.BLOSSOM_DB;
  if (!db) return summary;

  try {
    await initPrivateReportIntakeTable(db);
    // One timestamp for the whole run: last_attempt_at, delivered_at and a
    // retry's next_attempt_at count from when the run started, not from each
    // call. The cron runs every 5 minutes and the first retry waits 5, so a
    // retry counted from a call late in this run would more often fall just
    // after the next run's selection and wait 10.
    const now = new Date(nowMs).toISOString();
    const { results } = await db.prepare(`
      SELECT * FROM private_report_intake
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY
        CASE report_type
          WHEN 'csam' THEN 0
          WHEN 'child_safety' THEN 1
          WHEN 'underage_user' THEN 2
          ELSE 3
        END,
        id ASC
      LIMIT ?
    `).bind(now, limit).all();
    if (!results?.length) return summary;

    const transport = await resolveTransport(env);
    let consecutiveTimeouts = 0;
    const startedAt = clock();

    for (const row of results) {
      if (clock() - startedAt >= budgetMs) {
        summary.stoppedEarly = true;
        console.warn(`[PRIVATE-REPORTS] Delivery run used its ${budgetMs / 1000}s budget; ${results.length - summary.attempted} report(s) stay pending for the next run`);
        break;
      }
      summary.attempted++;
      const result = await postHandoff(transport, row, timeoutMs);
      const attempts = (row.attempts ?? 0) + 1;
      consecutiveTimeouts = result.timedOut ? consecutiveTimeouts + 1 : 0;

      // Every settle is guarded on status = 'pending': if an overlapping run
      // settled the row while this call was in flight, its answer stands.
      // attempts counts up in SQL for the same reason.
      if (result.kind === 'delivered') {
        const settled = await settlePendingRow(db, `
          status = 'delivered', outcome = ?, attempts = attempts + 1, last_attempt_at = ?,
          delivered_at = ?, last_error = NULL, next_attempt_at = NULL
        `, [result.outcome, now, now], row.id);
        if (!settled) continue;
        summary.delivered++;
        console.log(`[PRIVATE-REPORTS] Delivered report ${row.report_id} (${row.report_type}) from gift wrap ${row.gift_wrap_id}: ${result.outcome ?? 'no outcome'}${result.duplicate ? ' (already delivered)' : ''}`);
      } else if (result.kind === 'rejected') {
        const settled = await settlePendingRow(db, `
          status = 'rejected', attempts = attempts + 1, last_attempt_at = ?,
          last_error = ?, next_attempt_at = NULL
        `, [now, result.error], row.id);
        if (!settled) continue;
        summary.rejected++;
        console.error(`[PRIVATE-REPORTS] relay-manager rejected report ${row.report_id} (${row.report_type}) from gift wrap ${row.gift_wrap_id}; it will not be retried and needs a person to look at it: ${result.error}`);
      } else {
        const nextAttemptAt = new Date(nowMs + privateReportRetryDelayMs(attempts)).toISOString();
        const settled = await settlePendingRow(db, `
          attempts = attempts + 1, last_attempt_at = ?, last_error = ?, next_attempt_at = ?
        `, [now, result.error, nextAttemptAt], row.id);
        if (settled) {
          summary.retrying++;
          console.warn(`[PRIVATE-REPORTS] Handoff of report ${row.report_id} (${row.report_type}) failed, attempt ${attempts}, retrying after ${nextAttemptAt}: ${result.error}`);
        }
        if (result.stopRun || consecutiveTimeouts >= CONSECUTIVE_TIMEOUTS_TO_STOP) {
          summary.stoppedEarly = true;
          break;
        }
      }
    }
  } catch (err) {
    summary.error = err?.message || String(err);
    console.error('[PRIVATE-REPORTS] Delivery run failed:', summary.error);
  }

  return summary;
}

/**
 * Delete delivered and rejected rows recorded more than a year ago, the
 * retention initPrivateReportIntakeTable documents. Pending rows are kept.
 *
 * @param {D1Database} db
 * @returns {Promise<{deleted: number}>}
 */
export async function prunePrivateReportIntake(db) {
  await initPrivateReportIntakeTable(db);
  const result = await db.prepare(`
    DELETE FROM private_report_intake
    WHERE status IN ('delivered', 'rejected')
      AND created_at < datetime('now', '-1 years')
  `).run();
  return { deleted: result.meta.changes };
}
