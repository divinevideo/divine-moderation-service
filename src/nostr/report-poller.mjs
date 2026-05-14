// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Inbound NIP-56 report poller for relay.divine.video
// ABOUTME: Converts kind 1984 relay reports into moderation review records

import { extractMediaShaFromEvent, getEventTagValue } from '../validation.mjs';

const VIDEO_KINDS = new Set([34235, 34236]);
const PROCESSED_PREFIX = 'report-poller:processed:';

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
