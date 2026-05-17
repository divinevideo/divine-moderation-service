// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared user-report recording for HTTP and Nostr relay report ingestion
// ABOUTME: Writes user_reports, moderation_results, and AI report telemetry consistently

import { addReport, isAiReportType, isNsfwReportType } from '../reports.mjs';
import { buildAIReportEvent, recordAIDetectionEvent } from './ai-detection-events.mjs';

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
  const result = await addReport(db, {
    sha256,
    reporter_pubkey: reporterPubkey,
    report_type: reportType,
    reason,
    created_at: reportedAt,
  });

  const isNsfw = isNsfwReportType(reportType);
  const action = (allowAutoAgeRestrict && isNsfw && result.distinctReporterCount >= 2) ? 'AGE_RESTRICTED' : 'REVIEW';
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
        reportType,
        reportedBy: reporterPubkey,
        distinctReporterCount: result.distinctReporterCount,
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
    moderationResultRecorded,
    moderationResultError,
    aiTelemetryRecorded,
    aiTelemetryError,
  };
}
