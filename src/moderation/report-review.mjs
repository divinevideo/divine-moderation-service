// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared user-report recording for HTTP and Nostr relay report ingestion
// ABOUTME: Writes user_reports, moderation_results, and AI report telemetry consistently

import { addReport, isAiReportType, isNsfwReportType } from '../reports.mjs';
import { buildAIReportEvent, recordAIDetectionEvent } from './ai-detection-events.mjs';

/**
 * The uploader of the reported content — the party a report names. Only a
 * previously-scanned sha256 has a moderation row, so an unknown one returns
 * null and the self-report guard skips rather than guesses.
 */
async function lookupUploadedBy(db, sha256) {
  try {
    const row = await db
      .prepare('SELECT uploaded_by FROM moderation_results WHERE sha256 = ?')
      .bind(sha256)
      .first();
    return row?.uploaded_by ?? null;
  } catch {
    return null;
  }
}

export async function recordReportForReview(db, {
  sha256,
  reporterPubkey,
  reportType,
  reason = null,
  source = 'user-report',
  reportedAt = null,
  reportEventId = null,
  targetEventId = null,
  uploadedBy = null,
  allowAutoAgeRestrict = source === 'user-report',
} = {}) {
  // Self-report guard (#211): a user reporting their own content. The reported
  // party is the content's uploader; prefer the caller-supplied value (the relay
  // poller passes the target event's signature-verified pubkey), else look it up
  // from any existing moderation row. On a match, flag it as a self-report —
  // still recorded for audit, but source 'self-report' is non-escalating so it
  // can never drive an automatic outcome. Flag, not drop: the HTTP path's
  // reporter pubkey is self-asserted, so a spoofed self-match must not be able
  // to silently suppress a real report.
  const effectiveUploader = uploadedBy ?? (await lookupUploadedBy(db, sha256));
  const isSelfReport = Boolean(
    reporterPubkey &&
      effectiveUploader &&
      reporterPubkey.toLowerCase() === effectiveUploader.toLowerCase(),
  );
  // KNOWN GAP (#211): on the HTTP path the uploader is only resolvable once the
  // scan queue has written moderation_results.uploaded_by. A self-report on a
  // freshly-uploaded, not-yet-scanned sha256 falls through unflagged here and is
  // not retroactively corrected once the scan lands. The relay-poll path is
  // unaffected (it passes the target event's signature-verified pubkey).
  const originalSource = source;
  // Verified only when the match used the caller-supplied uploader (the
  // relay-poll's signature-verified pubkey), not the self-asserted DB fallback —
  // the distinction the "flag, not drop" decision rests on, surfaced to the
  // moderator rather than lost.
  const uploaderMatchVerified = isSelfReport && uploadedBy != null;
  if (isSelfReport) {
    source = 'self-report';
    allowAutoAgeRestrict = false;
  }

  const result = await addReport(db, {
    sha256,
    reporter_pubkey: reporterPubkey,
    report_type: reportType,
    reason,
    created_at: reportedAt,
    source,
  });

  const isNsfw = isNsfwReportType(reportType);
  // Gate on escalationReporterCount, not distinctReporterCount: the two differ
  // exactly when a source that may not drive automatic outcomes (a report DM)
  // has also reported this sha256. Counting those would let one actor supply
  // half the threshold for free, which is the same trust boundary that keeps
  // the DM path itself REVIEW-only.
  const action = (allowAutoAgeRestrict && isNsfw && result.escalationReporterCount >= 2) ? 'AGE_RESTRICTED' : 'REVIEW';
  const moderatedAt = reportedAt || new Date().toISOString();
  const categories = isNsfw ? ['adult'] : [];
  let moderationResultRecorded = false;
  let moderationResultError = null;

  try {
    await db.prepare(`
      INSERT INTO moderation_results (
        sha256, action, provider, scores, categories, raw_response, moderated_at, reviewed_by, reviewed_at, review_notes, uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        action = CASE
          WHEN moderation_results.reviewed_by IS NOT NULL THEN moderation_results.action
          WHEN moderation_results.action = 'PERMANENT_BAN' THEN moderation_results.action
          WHEN excluded.action = 'AGE_RESTRICTED' AND moderation_results.action IN ('SAFE', 'REVIEW') THEN excluded.action
          WHEN excluded.action = 'REVIEW' AND moderation_results.action = 'SAFE' THEN excluded.action
          ELSE moderation_results.action
        END,
        provider = CASE
          WHEN moderation_results.reviewed_by IS NOT NULL THEN moderation_results.provider
          ELSE excluded.provider
        END,
        categories = CASE
          WHEN moderation_results.reviewed_by IS NOT NULL THEN moderation_results.categories
          ELSE excluded.categories
        END,
        moderated_at = CASE
          WHEN moderation_results.reviewed_by IS NOT NULL THEN moderation_results.moderated_at
          ELSE excluded.moderated_at
        END,
        uploaded_by = CASE
          WHEN moderation_results.uploaded_by IS NULL THEN excluded.uploaded_by
          ELSE moderation_results.uploaded_by
        END
    `).bind(
      sha256,
      action,
      'user-report',
      JSON.stringify({}),
      JSON.stringify(categories),
      JSON.stringify({
        source,
        originalSource,
        selfReport: isSelfReport,
        uploaderMatchVerified,
        reportType,
        reportedBy: reporterPubkey,
        distinctReporterCount: result.distinctReporterCount,
        escalationReporterCount: result.escalationReporterCount,
        reason,
        reportEventId,
        targetEventId,
      }),
      moderatedAt,
      null,
      null,
      null,
      uploadedBy,
    ).run();
    moderationResultRecorded = true;
  } catch (error) {
    moderationResultError = error?.message || String(error);
    console.error(`[REPORT_REVIEW] Failed to write moderation row for reported ${sha256}:`, moderationResultError);
  }

  let aiTelemetryRecorded = false;
  let aiTelemetryError = null;
  if (isAiReportType(reportType)) {
    try {
      await recordAIDetectionEvent(db, buildAIReportEvent({
        sha256,
        reportType,
        createdAt: moderatedAt,
      }));
      aiTelemetryRecorded = true;
    } catch (error) {
      aiTelemetryError = error?.message || String(error);
      console.error(`[REPORT_REVIEW] Failed to record AI report event for ${sha256}:`, aiTelemetryError);
    }
  }

  return {
    success: true,
    ...result,
    action,
    isSelfReport,
    moderationResultRecorded,
    moderationResultError,
    aiTelemetryRecorded,
    aiTelemetryError,
  };
}
