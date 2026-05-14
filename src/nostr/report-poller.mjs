// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Inbound NIP-56 report poller for relay.divine.video
// ABOUTME: Converts kind 1984 relay reports into moderation review records

import { extractMediaShaFromEvent, getEventTagValue } from '../validation.mjs';

const VIDEO_KINDS = new Set([34235, 34236]);
const PROCESSED_PREFIX = 'report-poller:processed:';
const TERMINAL_SKIP_TTL_SECONDS = 60 * 60 * 24 * 90;
const RECORDED_TTL_SECONDS = 60 * 60 * 24 * 180;

export const REPORT_CHECKPOINT_KEY = 'report-poller:last-poll';

export function extractReportTargetEventId(reportEvent) {
  for (const tag of reportEvent?.tags || []) {
    if (tag[0] === 'e' && typeof tag[1] === 'string' && /^[0-9a-f]{64}$/i.test(tag[1])) {
      return tag[1].toLowerCase();
    }
  }
  return null;
}

function normalizeReportType(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (!normalized) {
    return null;
  }

  if (
    normalized === 'aigenerated'
    || normalized === 'ai_generated'
    || normalized === 'ns_aigenerated'
    || normalized === 'aigenerated_content'
    || normalized === 'ai_generated_content'
  ) {
    return 'ai_generated';
  }

  return normalized;
}

export function extractReportType(reportEvent) {
  const tags = reportEvent?.tags || [];
  const eMarker = tags.find((tag) => tag[0] === 'e' && tag[2])?.[2];
  const pMarker = tags.find((tag) => tag[0] === 'p' && tag[2])?.[2];
  const label = tags.find((tag) => tag[0] === 'l' && tag[1])?.[1];
  const content = typeof reportEvent?.content === 'string' ? reportEvent.content : '';
  const reasonMatch = content.match(/^Reason:\s*([^\n\r]+)/im);

  return normalizeReportType(label)
    || normalizeReportType(reasonMatch?.[1])
    || normalizeReportType(eMarker)
    || normalizeReportType(pMarker)
    || 'other';
}

export function isDivineClientReport(reportEvent) {
  const client = getEventTagValue(reportEvent?.tags || [], 'client');
  return typeof client === 'string' && client.toLowerCase() === 'divine';
}

export function shouldAcceptReportTarget(targetEvent) {
  return VIDEO_KINDS.has(targetEvent?.kind) && Boolean(extractMediaShaFromEvent(targetEvent));
}

export function processedReportKey(reportEventId) {
  return `${PROCESSED_PREFIX}${reportEventId}`;
}

async function markProcessed(kv, key, payload, expirationTtl) {
  await kv.put(key, JSON.stringify({
    ...payload,
    processedAt: new Date().toISOString(),
  }), { expirationTtl });
}

export async function processReportEvent(reportEvent, {
  kv,
  requireDivineClient = true,
  fetchTargetEvent,
  recordReport,
} = {}) {
  if (!reportEvent?.id || !/^[0-9a-f]{64}$/i.test(reportEvent.id)) {
    return { status: 'skipped_invalid_report_id' };
  }

  const reportEventId = reportEvent.id.toLowerCase();
  const processedKey = processedReportKey(reportEventId);
  const alreadyProcessed = await kv.get(processedKey);
  if (alreadyProcessed) {
    return { status: 'already_processed' };
  }

  if (requireDivineClient && !isDivineClientReport(reportEvent)) {
    await markProcessed(kv, processedKey, {
      status: 'skipped_non_divine_client',
    }, TERMINAL_SKIP_TTL_SECONDS);
    return { status: 'skipped_non_divine_client' };
  }

  const targetEventId = extractReportTargetEventId(reportEvent);
  if (!targetEventId) {
    await markProcessed(kv, processedKey, {
      status: 'skipped_missing_target',
    }, TERMINAL_SKIP_TTL_SECONDS);
    return { status: 'skipped_missing_target' };
  }

  const targetEvent = await fetchTargetEvent(targetEventId);
  if (!targetEvent) {
    return { status: 'target_unavailable', targetEventId };
  }

  if (!shouldAcceptReportTarget(targetEvent)) {
    await markProcessed(kv, processedKey, {
      status: 'skipped_non_video_target',
      targetEventId,
    }, TERMINAL_SKIP_TTL_SECONDS);
    return { status: 'skipped_non_video_target', targetEventId };
  }

  const sha256 = extractMediaShaFromEvent(targetEvent);
  const reportType = extractReportType(reportEvent);
  const reportedAt = typeof reportEvent.created_at === 'number' && Number.isFinite(reportEvent.created_at)
    ? new Date(reportEvent.created_at * 1000).toISOString()
    : new Date().toISOString();

  const recordResult = await recordReport({
    sha256,
    reporterPubkey: reportEvent.pubkey,
    reportType,
    reason: reportEvent.content || null,
    source: 'relay-report',
    reportedAt,
    reportEventId,
    targetEventId,
    uploadedBy: targetEvent.pubkey || null,
  });

  await markProcessed(kv, processedKey, {
    status: 'recorded',
    sha256,
    reportType,
    targetEventId,
    action: recordResult.action,
  }, RECORDED_TTL_SECONDS);

  return {
    status: 'recorded',
    sha256,
    reportType,
    targetEventId,
    action: recordResult.action,
    distinctReporterCount: recordResult.distinctReporterCount,
  };
}
