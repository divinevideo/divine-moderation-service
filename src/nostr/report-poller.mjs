// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Inbound NIP-56 report poller for relay.divine.video
// ABOUTME: Converts kind 1984 relay reports into moderation review records

import { extractMediaShaFromEvent, getEventTagValue } from '../validation.mjs';
import { recordReportForReview } from '../moderation/report-review.mjs';
import { fetchNostrEventById } from './relay-client.mjs';

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

export async function fetchReportsFromRelay(relayUrl, { since, until, limit }, env = {}) {
  return new Promise((resolve, reject) => {
    const reports = [];
    let ws;
    let settled = false;
    const timeout = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch {}
      finish(reports);
    }, 30000);

    function finish(resultOrError) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (resultOrError instanceof Error) {
        reject(resultOrError);
        return;
      }

      resolve(resultOrError);
    }

    try {
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        console.log(`[REPORT-POLLER] Connecting to ${relayUrl} with CF Access credentials`);
      }

      ws = new WebSocket(relayUrl);
      const subscriptionId = `report-poll-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      ws.addEventListener('open', () => {
        const filter = { kinds: [1984], since, limit };
        if (Number.isInteger(until)) {
          filter.until = until;
        }
        console.log(`[REPORT-POLLER] Sending REQ to ${relayUrl}: kinds=[1984], since=${since}, until=${filter.until ?? '<none>'}, limit=${limit}`);
        ws.send(JSON.stringify(['REQ', subscriptionId, filter]));
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[1] === subscriptionId) {
            reports.push(data[2]);
          }

          if (data[0] === 'EOSE' && data[1] === subscriptionId) {
            try {
              ws.send(JSON.stringify(['CLOSE', subscriptionId]));
              ws.close();
            } catch {}
            finish(reports);
          }

          if (data[0] === 'CLOSED' && data[1] === subscriptionId) {
            const reason = typeof data[2] === 'string' && data[2] ? data[2] : 'unknown reason';
            try {
              ws.close();
            } catch {}
            finish(new Error(`Relay closed subscription ${subscriptionId}: ${reason}`));
          }

          if (data[0] === 'NOTICE') {
            console.log(`[REPORT-POLLER] Relay notice: ${data[1]}`);
          }
        } catch (error) {
          console.error('[REPORT-POLLER] Failed to parse relay message:', error);
        }
      });

      ws.addEventListener('error', (error) => {
        finish(new Error(`WebSocket error: ${error.message || 'Unknown error'}`));
      });

      ws.addEventListener('close', () => {
        finish(reports);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error('WebSocket setup failed'));
    }
  });
}

export async function getLastReportPollTimestamp(env) {
  try {
    const data = await env.MODERATION_KV.get(REPORT_CHECKPOINT_KEY);
    if (data) {
      return JSON.parse(data).timestamp;
    }
  } catch (error) {
    console.error('[REPORT-POLLER] Failed to get last poll timestamp:', error);
  }
  return null;
}

export async function setLastReportPollTimestamp(env, timestamp, stats = {}) {
  try {
    await env.MODERATION_KV.put(REPORT_CHECKPOINT_KEY, JSON.stringify({
      timestamp,
      lastPollAt: new Date().toISOString(),
      ...stats,
    }));
  } catch (error) {
    console.error('[REPORT-POLLER] Failed to store last poll timestamp:', error);
  }
}

export async function pollRelayForReports(env, options = {}) {
  const {
    since = Math.floor(Date.now() / 1000) - 3600,
    limit = 100,
    maxPages = parseInt(env.REPORT_POLLING_MAX_PAGES || '5', 10),
    relays = ['wss://relay.divine.video'],
    fetchReportsFromRelay: injectedFetchReportsFromRelay,
    fetchTargetEvent: injectedFetchTargetEvent,
    recordReport: injectedRecordReport,
  } = options;

  const fetchReports = injectedFetchReportsFromRelay || fetchReportsFromRelay;
  const fetchTargetEvent = injectedFetchTargetEvent || ((eventId) => fetchNostrEventById(eventId, relays, env));
  const recordReport = injectedRecordReport || ((payload) => recordReportForReview(env.BLOSSOM_DB, payload));
  const requireDivineClient = env.RELAY_REPORTS_REQUIRE_DIVINE_CLIENT !== 'false';

  const results = {
    totalReports: 0,
    recorded: 0,
    alreadyProcessed: 0,
    skipped: 0,
    targetUnavailable: 0,
    errors: [],
    reports: [],
    maxTerminalCreatedAt: null,
    safeCheckpoint: null,
    saturated: false,
  };
  const terminalCreatedAts = [];
  const retryableCreatedAts = [];
  const seenReportIds = new Set();
  let hasUnboundedRetryableError = false;
  const pageLimit = Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : 5;

  console.log(`[REPORT-POLLER] Starting poll from ${relays.join(', ')} since ${new Date(since * 1000).toISOString()}`);

  for (const relayUrl of relays) {
    try {
      let until = null;
      for (let page = 1; page <= pageLimit; page++) {
        const query = Number.isInteger(until) ? { since, limit, until } : { since, limit };
        const reports = await fetchReports(relayUrl, query, env);
        console.log(`[REPORT-POLLER] Fetched ${reports.length} reports from ${relayUrl} page ${page}`);

        let pageNewReportIds = 0;
        for (const report of reports) {
          const reportId = typeof report?.id === 'string' ? report.id.toLowerCase() : null;
          if (reportId && seenReportIds.has(reportId)) {
            continue;
          }
          if (reportId) {
            seenReportIds.add(reportId);
            pageNewReportIds++;
          }

          results.totalReports++;
          const reportCreatedAt = Number.isInteger(report?.created_at) && report.created_at > 0
            ? report.created_at
            : null;

          try {
            const outcome = await processReportEvent(report, {
              kv: env.MODERATION_KV,
              requireDivineClient,
              fetchTargetEvent,
              recordReport,
            });

            results.reports.push(outcome);
            if (outcome.status === 'recorded') {
              results.recorded++;
            } else if (outcome.status === 'already_processed') {
              results.alreadyProcessed++;
            } else if (outcome.status === 'target_unavailable') {
              results.targetUnavailable++;
              if (reportCreatedAt !== null) {
                retryableCreatedAts.push(reportCreatedAt);
              } else {
                hasUnboundedRetryableError = true;
              }
            } else {
              results.skipped++;
            }

            if (outcome.status !== 'target_unavailable' && reportCreatedAt !== null) {
              terminalCreatedAts.push(reportCreatedAt);
            }
          } catch (error) {
            console.error(`[REPORT-POLLER] Failed to process report ${report?.id || '<missing-id>'}:`, error);
            results.errors.push({
              reportId: report?.id || null,
              error: error?.message || String(error),
            });
            if (reportCreatedAt !== null) {
              retryableCreatedAts.push(reportCreatedAt);
            } else {
              hasUnboundedRetryableError = true;
            }
          }
        }

        if (reports.length < limit) {
          break;
        }

        if (pageNewReportIds === 0) {
          results.saturated = true;
          break;
        }

        if (page >= pageLimit) {
          results.saturated = true;
          break;
        }

        const createdAts = reports
          .map((report) => report?.created_at)
          .filter((createdAt) => Number.isInteger(createdAt) && createdAt > 0);
        if (createdAts.length === 0) {
          results.saturated = true;
          break;
        }
        until = Math.min(...createdAts);
      }
    } catch (error) {
      console.error(`[REPORT-POLLER] Failed to poll ${relayUrl}:`, error);
      results.errors.push({
        relay: relayUrl,
        error: error?.message || String(error),
      });
      hasUnboundedRetryableError = true;
    }
  }

  const earliestRetryableCreatedAt = retryableCreatedAts.length > 0
    ? Math.min(...retryableCreatedAts)
    : null;
  const safeTerminalCreatedAts = hasUnboundedRetryableError || results.saturated
    ? []
    : terminalCreatedAts.filter((createdAt) =>
      earliestRetryableCreatedAt === null || createdAt < earliestRetryableCreatedAt
    );

  if (safeTerminalCreatedAts.length > 0) {
    results.maxTerminalCreatedAt = Math.max(...safeTerminalCreatedAts);
    results.safeCheckpoint = results.maxTerminalCreatedAt;
  }

  console.log(`[REPORT-POLLER] Poll complete: ${results.totalReports} reports, ${results.recorded} recorded, ${results.skipped} skipped`);

  return results;
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

  if (reportEvent.kind !== 1984) {
    await markProcessed(kv, processedKey, {
      status: 'skipped_non_report_kind',
      kind: reportEvent.kind ?? null,
    }, TERMINAL_SKIP_TTL_SECONDS);
    return { status: 'skipped_non_report_kind' };
  }

  if (!reportEvent.pubkey || !/^[0-9a-f]{64}$/i.test(reportEvent.pubkey)) {
    await markProcessed(kv, processedKey, {
      status: 'skipped_invalid_reporter_pubkey',
    }, TERMINAL_SKIP_TTL_SECONDS);
    return { status: 'skipped_invalid_reporter_pubkey' };
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
