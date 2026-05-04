// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Main entry point for Divine video moderation worker
// ABOUTME: Consumes queue messages and processes videos for harmful content

import { validateQueueMessage } from './schemas/queue-message.mjs';
import { moderateVideo, classifyVideoOnly } from './moderation/pipeline.mjs';
import { applyForceProvider, shouldQueueHiveRecheck } from './moderation/report-trigger.mjs';
import { publishToFaro, publishToContentRelay, publishLabelEvent } from './nostr/publisher.mjs';
import { requireAuth, getAuthenticatedUser } from './admin/auth.mjs';
import { verifyZeroTrustJWT } from './admin/zerotrust.mjs';
import { getConfiguredBearerTokens, authenticateApiRequest, apiUnauthorizedResponse, authSourceFromVerification, verifyLegacyBearerAuth } from './auth-api.mjs';
import { fetchNostrEventBySha256, fetchNostrVideoEventsByDTag, parseVideoEventMetadata, fetchKind5EventsSince, fetchNostrEventById } from './nostr/relay-client.mjs';
import { pollRelayForVideos, getLastPollTimestamp, setLastPollTimestamp, getPollingStatus } from './nostr/relay-poller.mjs';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import dashboardHTML from './admin/dashboard.html';
import swipeReviewHTML from './admin/swipe-review.html';
import messagesHTML from './admin/messages.html';
import { initReportsTable, addReport, isAiReportType } from './reports.mjs';
import { initUploaderEnforcementTable, getUploaderEnforcement, setUploaderEnforcement, applyUploaderEnforcementToResult } from './uploader-enforcement.mjs';
import { formatForStorage, formatForGorse, formatForFunnelcake } from './classification/pipeline.mjs';
import { extractTopics, topicsToLabels, topicsToWeightedFeatures } from './classification/topic-extractor.mjs';
import { classifyModerationResult, getKVThresholds, kvThresholdsToEnv, setKVThresholds, DEFAULT_THRESHOLDS } from './moderation/classifier.mjs';
import { shouldForceAIDetection } from './moderation/ai-detection-policy.mjs';
import { buildAIOutcomeEvent, buildAIPolicyDecisionEvent, buildAIReportEvent, getAIDetectionStats, initAIDetectionEventsTable, recordAIDetectionEvent } from './moderation/ai-detection-events.mjs';
import { isValidSha256, isValidLookupIdentifier, isValidPubkey, parseMaybeJson, getEventTagValue, parseImetaParams, extractShaFromUrl, extractMediaShaFromEvent } from './validation.mjs';
import { parseRetryAfterSeconds } from './http-utils.mjs';
import { classifyText, parseVttText } from './moderation/text-classifier.mjs';
import { notifyAtprotoLabeler } from './atproto/label-webhook.mjs';
import { buildDownstreamPublishContext } from './moderation/downstream-publishing.mjs';
import { runClassicVineRollback } from './moderation/classic-vine-rollback.mjs';
import { notifyBlossom } from './blossom-client.mjs';
import { handleSyncDelete } from './creator-delete/sync-endpoint.mjs';
import { handleStatusQuery } from './creator-delete/status-endpoint.mjs';
import { runCreatorDeleteCron } from './creator-delete/cron.mjs';
import { fetchKind5WithRetry } from './creator-delete/funnelcake-fetch.mjs';
import {
  listAgeRestrictedCandidates,
  fetchBlossomBlobDetail,
  classifyAgeRestrictedCandidate,
  buildPreviewResponse,
  applyAgeRestrictedRepairs
} from './moderation/age-restricted-reconcile.mjs';
/**
 * NIP-32 label mapping for content categories
 * Maps internal category names to NIP-32/NIP-56 compatible labels
 */
const CATEGORY_TO_LABEL = {
  'nudity': { label: 'nudity', namespace: 'content-warning' },
  'violence': { label: 'violence', namespace: 'content-warning' },
  'gore': { label: 'gore', namespace: 'content-warning' },
  'offensive': { label: 'profanity', namespace: 'content-warning' },  // NIP-56 term
  'weapon': { label: 'weapons', namespace: 'content-warning' },
  'self_harm': { label: 'self-harm', namespace: 'content-warning' },
  'recreational_drug': { label: 'drugs', namespace: 'content-warning' },
  'alcohol': { label: 'alcohol', namespace: 'content-warning' },
  'tobacco': { label: 'tobacco', namespace: 'content-warning' },
  'ai_generated': { label: 'ai-generated', namespace: 'content-warning' },
  'deepfake': { label: 'deepfake', namespace: 'content-warning' },
  'medical': { label: 'medical', namespace: 'content-warning' },
  'gambling': { label: 'gambling', namespace: 'content-warning' }
};

const ADMIN_HOSTNAME = 'moderation.admin.divine.video';
const API_HOSTNAME = 'moderation-api.divine.video';
const DEFAULT_RELAY_ADMIN_URL = 'https://relay.admin.divine.video';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const VALID_MODERATION_ACTIONS = new Set(['SAFE', 'REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN']);

// ETags for admin HTML pages — computed once at module load, change only on deploy.
// Allows browsers to cache the HTML but revalidate on every request (304 if unchanged).
const HTML_ETAGS = {
  dashboard: `"${hashCode(dashboardHTML)}"`,
  review: `"${hashCode(swipeReviewHTML)}"`,
  messages: `"${hashCode(messagesHTML)}"`,
};

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function serveHTML(html, etag, request) {
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { 'ETag': etag } });
  }
  return new Response(html, {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'ETag': etag }
  });
}
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Generate NIP-32 style label tags based on scores and human verifications
 * @param {Object} scores - AI-generated scores for each category
 * @param {Object} categoryVerifications - Human verification status for each category
 * @returns {Array} Array of NIP-32 label tag arrays
 */
function generateNIP85Tags(scores, categoryVerifications = {}) {
  const tags = [];
  const namespaces = new Set();

  for (const [category, score] of Object.entries(scores || {})) {
    if (typeof score !== 'number' || score < 0.3) continue;

    const labelInfo = CATEGORY_TO_LABEL[category];
    if (!labelInfo) continue;

    const verification = categoryVerifications[category];

    // Only include tags that are:
    // 1. Confirmed by human, OR
    // 2. High confidence AI detection (>=0.7) and NOT rejected by human
    const isConfirmed = verification === 'confirmed';
    const isRejected = verification === 'rejected';
    const isHighConfidence = score >= 0.7;

    if (isRejected) continue;  // Human said "no, this is NOT this category"
    if (!isConfirmed && !isHighConfidence) continue;  // Low confidence and not verified

    namespaces.add(labelInfo.namespace);

    // NIP-32 format: ["l", "label", "namespace", {metadata}]
    const metadata = {
      confidence: score,
      verified: isConfirmed,
      source: isConfirmed ? 'human' : 'ai'
    };

    tags.push(['l', labelInfo.label, labelInfo.namespace, JSON.stringify(metadata)]);
  }

  // Add namespace declaration tags (L tags)
  for (const ns of namespaces) {
    tags.unshift(['L', ns]);
  }

  return tags;
}

function deriveCategoriesFromClassification(classification) {
  const categories = new Set();
  const scores = classification?.scores || {};
  for (const [category, score] of Object.entries(scores)) {
    if (typeof score === 'number' && score >= 0.5) {
      categories.add(category);
    }
  }

  if (typeof classification?.category === 'string' && classification.category.length > 0) {
    categories.add(classification.category);
  }

  return [...categories];
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

function isApiSurfacePath(pathname) {
  return pathname === '/'
    || pathname === '/health'
    || pathname === '/test-moderate'
    || pathname === '/test-kv'
    || pathname.startsWith('/check-result/')
    || pathname.startsWith('/api/v1/')
    || pathname.startsWith('/api/delete/')
    || pathname.startsWith('/api/delete-status/');
}

function isAdminSurfacePath(pathname) {
  return pathname === '/' || pathname.startsWith('/admin');
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS
  });
}

function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function hostMismatchResponse(requestId, hostname, pathname, expectedHost) {
  console.log(`[${requestId}] Rejected ${pathname} on ${hostname}; expected ${expectedHost}`);
  return jsonError(`Not found on ${hostname}. Use https://${expectedHost}${pathname}`, 404);
}

function buildFunnelcakeVideoLookup(eventResponse, identifier) {
  if (!eventResponse?.event) {
    return null;
  }

  const event = eventResponse.event;
  const stats = eventResponse.stats || {};
  const tags = event.tags || [];
  const metadata = parseVideoEventMetadata(event) || {};
  const imeta = parseImetaParams(tags);
  const mediaSha = extractMediaShaFromEvent(event);
  const videoUrl = metadata.url || imeta.url || getEventTagValue(tags, 'url') || null;
  const thumbnailUrl = imeta.image || getEventTagValue(tags, 'thumb') || getEventTagValue(tags, 'image') || null;
  const stableId = getEventTagValue(tags, 'd') || event.id || identifier;

  return {
    eventId: event.id,
    stableId,
    lookupId: identifier,
    mediaSha,
    videoUrl,
    thumbnailUrl,
    uploadedBy: event.pubkey || null,
    createdAt: event.created_at || null,
    nostrContext: {
      title: metadata.title || null,
      author: metadata.author || stats.author_name || null,
      client: metadata.client || null,
      content: metadata.content || event.content || null,
      url: videoUrl || null,
      publishedAt: metadata.publishedAt || null,
      pubkey: event.pubkey ? `${event.pubkey.substring(0, 16)}...` : null,
      eventId: event.id,
      platform: metadata.platform || null
    },
    divineUrl: `https://divine.video/video/${encodeURIComponent(stableId)}`
  };
}

function buildStoredLookupMetadata(row) {
  if (!row) {
    return {
      eventId: null,
      divineUrl: null,
      nostrContext: null
    };
  }

  const eventId = row.event_id || null;
  const publishedAt = row.published_at ? parseInt(row.published_at, 10) : null;
  const hasStoredContext = Boolean(
    row.title || row.author || row.content_url || eventId || row.uploaded_by || publishedAt
  );

  return {
    eventId,
    divineUrl: eventId ? `https://divine.video/video/${encodeURIComponent(eventId)}` : null,
    nostrContext: hasStoredContext ? {
      title: row.title || null,
      author: row.author || null,
      client: null,
      content: null,
      url: row.content_url || null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      pubkey: row.uploaded_by ? `${row.uploaded_by.substring(0, 16)}...` : null,
      eventId,
      platform: null
    } : null
  };
}

function buildAdminNostrMetadata(metadata = {}, extras = {}) {
  return {
    title: metadata.title || null,
    author: metadata.author || null,
    platform: metadata.platform || null,
    client: metadata.client || null,
    loops: metadata.loops ?? null,
    likes: metadata.likes ?? null,
    comments: metadata.comments ?? null,
    url: metadata.url || null,
    sourceUrl: metadata.sourceUrl || null,
    publishedAt: metadata.publishedAt ?? null,
    archivedAt: metadata.archivedAt ?? null,
    importedAt: metadata.importedAt ?? null,
    vineHashId: metadata.vineHashId ?? null,
    vineUserId: metadata.vineUserId ?? null,
    content: metadata.content || null,
    eventId: metadata.eventId || null,
    createdAt: extras.createdAt ?? metadata.createdAt ?? null
  };
}

async function fetchFunnelcakeLookupVideo(identifier) {
  const response = await fetch(`https://relay.divine.video/api/videos/${encodeURIComponent(identifier)}`, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Funnelcake lookup failed with HTTP ${response.status}`);
  }

  return buildFunnelcakeVideoLookup(await response.json(), identifier);
}

function mergeLookupMetadata(baseVideo, funnelcakeVideo) {
  if (!funnelcakeVideo) {
    return baseVideo;
  }

  const baseNostrContext = Object.fromEntries(
    Object.entries(baseVideo.nostrContext || {}).filter(([, value]) => value !== null && value !== undefined)
  );

  return {
    ...baseVideo,
    cdnUrl: funnelcakeVideo.videoUrl || baseVideo.cdnUrl || null,
    thumbnailUrl: baseVideo.thumbnailUrl || funnelcakeVideo.thumbnailUrl || null,
    uploaded_by: baseVideo.uploaded_by || funnelcakeVideo.uploadedBy || null,
    eventId: baseVideo.eventId || funnelcakeVideo.eventId || null,
    divineUrl: funnelcakeVideo.divineUrl || baseVideo.divineUrl,
    lookupId: funnelcakeVideo.lookupId || baseVideo.lookupId,
    nostrContext: {
      ...(funnelcakeVideo.nostrContext || {}),
      ...baseNostrContext
    }
  };
}

function getRelayAdminUrl(env) {
  return env.RELAY_ADMIN_URL || DEFAULT_RELAY_ADMIN_URL;
}

function getRelayAdminHeaders(env) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}


function getTranscriptSourceUrl(sha256, env) {
  return `https://${env.CDN_DOMAIN || 'media.divine.video'}/${sha256}.vtt`;
}

function getAdminTranscriptProxyUrl(sha256) {
  return `/admin/transcript/${sha256}.vtt`;
}

async function fetchTranscriptAsset(sha256, env) {
  const sourceUrl = getTranscriptSourceUrl(sha256, env);
  const response = await fetch(sourceUrl);
  const subtitleUrl = getAdminTranscriptProxyUrl(sha256);

  if (response.status === 404) {
    return {
      found: false,
      pending: false,
      sha256,
      sourceUrl,
      subtitleUrl,
      vttContent: null,
      transcriptText: ''
    };
  }

  if (response.status === 202) {
    let pendingBody = null;
    try {
      pendingBody = await response.json();
    } catch {
      pendingBody = null;
    }

    return {
      found: false,
      pending: true,
      sha256,
      sourceUrl,
      subtitleUrl,
      vttContent: null,
      transcriptText: '',
      retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('Retry-After')),
      pendingStatus: typeof pendingBody?.status === 'string' ? pendingBody.status : null,
      pendingMessage: typeof pendingBody?.message === 'string' ? pendingBody.message : null
    };
  }

  if (!response.ok) {
    throw new Error(`Transcript fetch failed with HTTP ${response.status}`);
  }

  const vttContent = await response.text();
  return {
    found: true,
    pending: false,
    sha256,
    sourceUrl,
    subtitleUrl,
    vttContent,
    transcriptText: parseVttText(vttContent).trim()
  };
}

function normalizeModerationAction(action, { sha256 = null, source = null } = {}) {
  const rawAction = typeof action === 'string' ? action : '';
  const normalized = rawAction.toUpperCase();
  if (!VALID_MODERATION_ACTIONS.has(normalized) && rawAction.trim()) {
    const contextLabel = source ? ` (${source})` : '';
    const safeSha = sha256 || 'unknown-sha';
    console.warn(
      `[CRON] Transcript reprocess normalized unknown moderation action to SAFE${contextLabel} for ${safeSha}: ${rawAction}`
    );
  }
  return VALID_MODERATION_ACTIONS.has(normalized) ? normalized : 'SAFE';
}

function parseIsoTimestampMs(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

async function getEffectiveModerationEnv(env) {
  let effectiveEnv = env;
  try {
    const kvThresholds = await getKVThresholds(env.MODERATION_KV);
    if (kvThresholds) {
      effectiveEnv = { ...env, ...kvThresholdsToEnv(kvThresholds) };
    }
  } catch (error) {
    console.warn('[CRON] Failed to load KV thresholds for transcript reprocess:', error.message);
  }
  return effectiveEnv;
}

async function syncActionSpecificKVState(sha256, action, reason, category, env) {
  await Promise.all([
    env.MODERATION_KV.delete(`review:${sha256}`),
    env.MODERATION_KV.delete(`age-restricted:${sha256}`),
    env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
    env.MODERATION_KV.delete(`quarantine:${sha256}`)
  ]);

  if (!['REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action)) {
    return;
  }

  const kvPayload = JSON.stringify({
    category: category || null,
    reason: reason || null,
    timestamp: Date.now(),
    transcriptReprocess: true
  });

  if (action === 'REVIEW') {
    await env.MODERATION_KV.put(`review:${sha256}`, kvPayload);
  } else if (action === 'QUARANTINE') {
    await env.MODERATION_KV.put(`quarantine:${sha256}`, kvPayload, { expirationTtl: 60 * 60 * 24 * 90 });
  } else if (action === 'AGE_RESTRICTED') {
    await env.MODERATION_KV.put(`age-restricted:${sha256}`, kvPayload);
  } else if (action === 'PERMANENT_BAN') {
    await env.MODERATION_KV.put(`permanent-ban:${sha256}`, kvPayload);
  }
}

function normalizeFlaggedFrames(value) {
  return Array.isArray(value) ? value : [];
}

async function loadPersistedFlaggedFrames(sha256, env, existingClassifier = null, existingModerationKv = null) {
  const classifierPayload = existingClassifier || parseMaybeJson(await env.MODERATION_KV.get(`classifier:${sha256}`), {});
  const classifierFrames = normalizeFlaggedFrames(classifierPayload?.flaggedFrames);
  if (classifierFrames.length > 0) {
    return classifierFrames;
  }

  const moderationPayload = existingModerationKv || parseMaybeJson(await env.MODERATION_KV.get(`moderation:${sha256}`), null);
  return normalizeFlaggedFrames(moderationPayload?.flaggedFrames);
}

function transcriptReprocessNotificationKey(sha256, oldAction, newAction) {
  const fromAction = normalizeModerationAction(oldAction || 'UNKNOWN');
  const toAction = normalizeModerationAction(newAction || 'UNKNOWN');
  return `transcript-reprocess-notified:${sha256}:${fromAction}:${toAction}`;
}

async function processPendingTranscriptReprocess(env) {
  if (!env.BLOSSOM_DB || !env.MODERATION_KV) {
    return;
  }

  const maxAgeDaysRaw = Number.parseInt(env.TRANSCRIPT_REPROCESS_MAX_AGE_DAYS || '7', 10);
  const maxAgeDays = Math.min(Math.max(Number.isFinite(maxAgeDaysRaw) ? maxAgeDaysRaw : 7, 1), 365);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const batchSize = Math.min(Math.max(Number.parseInt(env.TRANSCRIPT_REPROCESS_BATCH_SIZE || '20', 10) || 20, 1), 100);
  const pendingResult = await env.BLOSSOM_DB.prepare(`
    SELECT sha256, action, provider, scores, categories, raw_response, uploaded_by, title, published_at, content_url,
           transcript_pending_since, moderated_at
    FROM moderation_results
    WHERE transcript_pending = 1
    ORDER BY COALESCE(transcript_pending_since, moderated_at) ASC
    LIMIT ?
  `).bind(batchSize).all();

  const rows = pendingResult?.results || [];
  if (rows.length === 0) {
    return;
  }

  const effectiveEnv = await getEffectiveModerationEnv(env);
  console.log(`[CRON] Transcript reprocess: processing ${rows.length} pending rows`);

  for (const row of rows) {
    const { sha256 } = row;
    const checkedAt = new Date().toISOString();
    const pendingSinceMs = parseIsoTimestampMs(row.transcript_pending_since) ?? parseIsoTimestampMs(row.moderated_at);

    try {
      if (pendingSinceMs !== null && (nowMs - pendingSinceMs) >= maxAgeMs) {
        const staleUpdate = await env.BLOSSOM_DB.prepare(`
          UPDATE moderation_results
          SET transcript_pending = 0,
              transcript_last_checked_at = ?,
              transcript_resolved_at = ?
          WHERE sha256 = ? AND transcript_pending = 1 AND reviewed_by IS NULL
        `).bind(checkedAt, checkedAt, sha256).run();

        if (staleUpdate?.meta?.changes === 0) {
          console.log(`[CRON] Transcript reprocess skipped ${sha256} because row was manually reviewed`);
          continue;
        }

        const existingModerationKv = parseMaybeJson(await env.MODERATION_KV.get(`moderation:${sha256}`), null);
        const staleAction = normalizeModerationAction(row.action);
        const moderationPayload = {
          ...(existingModerationKv || {}),
          sha256,
          action: existingModerationKv?.action || staleAction,
          transcriptPending: false,
          transcriptResolvedAt: checkedAt,
          transcriptResolutionReason: 'max_age_abandoned'
        };
        await env.MODERATION_KV.put(
          `moderation:${sha256}`,
          JSON.stringify(moderationPayload),
          { expirationTtl: 60 * 60 * 24 * 90 }
        );

        console.log(`[CRON] Transcript reprocess abandoned ${sha256} after ${maxAgeDays} day max age`);
        continue;
      }

      const transcript = await fetchTranscriptAsset(sha256, env);

      if (transcript.pending) {
        await env.BLOSSOM_DB.prepare(`
          UPDATE moderation_results
          SET transcript_last_checked_at = ?
          WHERE sha256 = ? AND transcript_pending = 1 AND reviewed_by IS NULL
        `).bind(checkedAt, sha256).run();
        continue;
      }

      if (!transcript.found || !transcript.transcriptText) {
        await env.BLOSSOM_DB.prepare(`
          UPDATE moderation_results
          SET transcript_pending = 0,
              transcript_last_checked_at = ?,
              transcript_resolved_at = ?
          WHERE sha256 = ? AND transcript_pending = 1 AND reviewed_by IS NULL
        `).bind(checkedAt, checkedAt, sha256).run();
        continue;
      }

      const textScores = classifyText(transcript.transcriptText);
      let topicProfile = null;
      try {
        topicProfile = extractTopics(transcript.transcriptText);
      } catch (error) {
        console.warn(`[CRON] Topic extraction failed during transcript reprocess for ${sha256}: ${error.message}`);
      }

      const videoScores = parseMaybeJson(row.scores, {});
      const existingClassifier = parseMaybeJson(await env.MODERATION_KV.get(`classifier:${sha256}`), {});
      const existingModerationKv = parseMaybeJson(await env.MODERATION_KV.get(`moderation:${sha256}`), null);
      const persistedFlaggedFrames = await loadPersistedFlaggedFrames(sha256, env, existingClassifier, existingModerationKv);
      const classification = classifyModerationResult({
        maxScores: videoScores || {},
        flaggedFrames: persistedFlaggedFrames,
        text_scores: textScores
      }, effectiveEnv);
      const reprocessedCategories = deriveCategoriesFromClassification(classification);

      const oldAction = normalizeModerationAction(row.action, {
        sha256,
        source: 'stored-action'
      });
      const newAction = normalizeModerationAction(classification.action, {
        sha256,
        source: 'classification-action'
      });

      const transcriptActionUpdate = await env.BLOSSOM_DB.prepare(`
        UPDATE moderation_results
        SET action = ?,
            scores = ?,
            categories = ?,
            transcript_pending = 0,
            transcript_last_checked_at = ?,
            transcript_resolved_at = ?
        WHERE sha256 = ? AND transcript_pending = 1 AND reviewed_by IS NULL
      `).bind(
        newAction,
        JSON.stringify(classification.scores || {}),
        JSON.stringify(reprocessedCategories),
        checkedAt,
        checkedAt,
        sha256
      ).run();
      if (transcriptActionUpdate?.meta?.changes === 0) {
        console.log(`[CRON] Transcript reprocess skipped ${sha256} because row was manually reviewed`);
        continue;
      }

      const classifierPayload = {
        sha256,
        provider: existingClassifier?.provider || row.provider || 'transcript-reprocess',
        moderatedAt: existingClassifier?.moderatedAt || checkedAt,
        rawClassifierData: existingClassifier?.rawClassifierData || null,
        sceneClassification: existingClassifier?.sceneClassification || null,
        flaggedFrames: persistedFlaggedFrames,
        topicProfile: topicProfile || null,
        text_scores: textScores
      };
      await env.MODERATION_KV.put(
        `classifier:${sha256}`,
        JSON.stringify(classifierPayload),
        { expirationTtl: 60 * 60 * 24 * 180 }
      );

      if (existingModerationKv) {
        const moderationPayload = {
          ...existingModerationKv,
          action: newAction,
          scores: classification.scores || existingModerationKv.scores || {},
          categories: reprocessedCategories,
          reason: classification.reason || existingModerationKv.reason || null,
          text_scores: textScores,
          topicProfile: topicProfile || null,
          transcriptPending: false,
          transcriptResolvedAt: checkedAt
        };
        await env.MODERATION_KV.put(
          `moderation:${sha256}`,
          JSON.stringify(moderationPayload),
          { expirationTtl: 60 * 60 * 24 * 90 }
        );
      }

      if (oldAction !== newAction) {
        const notificationKey = transcriptReprocessNotificationKey(sha256, oldAction, newAction);
        const alreadyNotified = await env.MODERATION_KV.get(notificationKey);
        if (alreadyNotified) {
          console.log(`[CRON] Transcript reprocess skipped duplicate downstream notify for ${sha256} (${oldAction} -> ${newAction})`);
          continue;
        }

        await syncActionSpecificKVState(sha256, newAction, classification.reason, classification.category, env);
        await handleModerationResult({
          ...classification,
          sha256,
          action: newAction,
          flaggedFrames: persistedFlaggedFrames,
          cdnUrl: row.content_url || `https://${env.CDN_DOMAIN || 'media.divine.video'}/${sha256}`,
          uploadedBy: row.uploaded_by || null,
          categories: reprocessedCategories,
          provider: row.provider || 'transcript-reprocess',
          nostrContext: {
            title: row.title || null,
            publishedAt: row.published_at || null
          },
          topicProfile: topicProfile || null,
          text_scores: textScores
        }, env);
        await env.MODERATION_KV.put(notificationKey, checkedAt, { expirationTtl: 60 * 60 * 24 * 7 });
      } else {
        console.log(`[CRON] Transcript reprocess resolved ${sha256} without action change (${newAction})`);
      }
    } catch (error) {
      console.error(`[CRON] Transcript reprocess failed for ${sha256}:`, error.message);
    }
  }
}

async function callRelayAdminAction(env, payload) {
  const response = await fetch(`${getRelayAdminUrl(env)}/api/moderate`, {
    method: 'POST',
    headers: getRelayAdminHeaders(env),
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `Relay admin error: HTTP ${response.status}`);
  }

  return data;
}

async function deleteRelayEventIds(eventIds, env, reason) {
  const uniqueEventIds = [...new Set(
    (eventIds || []).filter((eventId) => typeof eventId === 'string' && isValidSha256(eventId))
  )];

  if (uniqueEventIds.length === 0) {
    return {
      success: false,
      reason: 'no_event_found',
      eventId: null,
      eventIds: [],
      deletedCount: 0,
      attemptedCount: 0,
      failures: []
    };
  }

  const deletedEventIds = [];
  const failures = [];

  for (const eventId of uniqueEventIds) {
    try {
      await callRelayAdminAction(env, {
        action: 'delete_event',
        eventId,
        reason
      });
      deletedEventIds.push(eventId);
    } catch (error) {
      failures.push({
        eventId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    success: failures.length === 0,
    eventId: deletedEventIds[0] || uniqueEventIds[0],
    eventIds: deletedEventIds,
    deletedCount: deletedEventIds.length,
    attemptedCount: uniqueEventIds.length,
    failures
  };
}

/**
 * Look up all Nostr event versions for a SHA256 d-tag and delete them from the relay.
 * Used to enforce PERMANENT_BAN on content that may be hosted externally.
 */
async function deleteEventFromRelayBySha256(sha256, env, source = 'unknown', reasonOverride = null) {
  try {
    const events = await fetchNostrVideoEventsByDTag(sha256, ['wss://relay.divine.video'], env, { limit: 50 });
    const fallbackEvent = events.length === 0
      ? await fetchNostrEventBySha256(sha256, ['wss://relay.divine.video'], env)
      : null;
    const eventIds = events.length > 0
      ? events.map((event) => event?.id)
      : [fallbackEvent?.id];

    if (eventIds.filter(Boolean).length === 0) {
      console.log(`[RELAY-ENFORCE] ${sha256} - No relay events found for d-tag, skipping delete`);
      return { success: false, reason: 'no_event_found' };
    }

    const result = await deleteRelayEventIds(
      eventIds,
      env,
      reasonOverride || `PERMANENT_BAN enforcement (${source})`
    );

    if (result.success) {
      console.log(`[RELAY-ENFORCE] ${sha256} - Deleted ${result.deletedCount}/${result.attemptedCount} relay event version(s)`);
    } else {
      console.warn(`[RELAY-ENFORCE] ${sha256} - Partial relay delete ${result.deletedCount}/${result.attemptedCount}`, result.failures);
    }

    return result;
  } catch (error) {
    console.error(`[RELAY-ENFORCE] ${sha256} - Failed to delete from relay:`, error.message);
    return { success: false, error: error.message };
  }
}

async function fetchLookupNostrContext(hash, env) {
  try {
    const event = await fetchNostrEventBySha256(hash, ['wss://relay.divine.video'], env);
    if (!event) {
      return null;
    }

    const metadata = parseVideoEventMetadata(event) || {};
    const tags = event.tags || [];
    const stableId = getEventTagValue(tags, 'd') || event.id || hash;

    return {
      eventId: event.id,
      uploadedBy: event.pubkey || null,
      divineUrl: `https://divine.video/video/${encodeURIComponent(stableId)}`,
      nostrContext: {
        title: metadata.title || null,
        author: metadata.author || null,
        client: metadata.client || null,
        content: metadata.content || event.content || null,
        pubkey: event.pubkey ? `${event.pubkey.substring(0, 16)}...` : null,
        eventId: event.id,
        platform: metadata.platform || null
      }
    };
  } catch (error) {
    console.error(`[ADMIN] Failed to fetch Nostr context for ${hash}:`, error.message);
    return null;
  }
}

async function enrichAdminLookupVideo(video, env) {
  if (!video) {
    return null;
  }

  let enriched = { ...video };

  if (enriched.sha256 && (!enriched.eventId || !enriched.divineUrl || !enriched.nostrContext)) {
    const funnelcakeVideo = await fetchFunnelcakeLookupVideo(enriched.lookupId || enriched.eventId || enriched.sha256).catch((error) => {
      console.error(`[ADMIN] Failed to fetch relay context for ${enriched.sha256}:`, error.message);
      return null;
    });

    if (funnelcakeVideo) {
      enriched = mergeLookupMetadata(enriched, funnelcakeVideo);
    } else {
      const nostrContext = await fetchLookupNostrContext(enriched.sha256, env);
      if (nostrContext) {
        enriched = {
          ...enriched,
          eventId: enriched.eventId || nostrContext.eventId,
          divineUrl: enriched.divineUrl || nostrContext.divineUrl,
          nostrContext: {
            ...(nostrContext.nostrContext || {}),
            ...(enriched.nostrContext || {})
          },
          uploaded_by: enriched.uploaded_by || nostrContext.uploadedBy || null
        };
      }
    }
  }

  if (enriched.uploaded_by) {
    const uploaderEnforcement = await getUploaderEnforcement(env.BLOSSOM_DB, enriched.uploaded_by).catch(() => null);

    enriched = {
      ...enriched,
      uploaderEnforcement: uploaderEnforcement || {
        pubkey: enriched.uploaded_by,
        approval_required: false,
        relay_banned: false
      }
    };
  }

  return enriched;
}

const UPLOADER_HISTORY_ACTIONS = ['SAFE', 'REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'];

function extractReasonFromRow(row) {
  if (row.review_notes) return row.review_notes;
  if (row.raw_response) {
    try {
      const raw = typeof row.raw_response === 'string' ? JSON.parse(row.raw_response) : row.raw_response;
      if (raw && typeof raw === 'object') {
        if (typeof raw.reason === 'string' && raw.reason.trim()) return raw.reason;
        if (Array.isArray(raw.categories) && raw.categories.length > 0) return raw.categories.join(', ');
      }
    } catch {}
  }
  return null;
}

async function resolveProfileWithTimeout(pubkey, env, timeoutMs = 250) {
  if (env.SKIP_PROFILE_RESOLUTION === 'true') return null;
  try {
    const { resolveProfile } = await import('./nostr/profile-resolver.mjs');
    return await Promise.race([
      resolveProfile(pubkey, env).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
  } catch {
    return null;
  }
}

async function buildUploaderHistory(pubkey, env) {
  const db = env.BLOSSOM_DB;
  const actionBreakdown = Object.fromEntries(UPLOADER_HISTORY_ACTIONS.map((action) => [action, 0]));

  const [totalsRow, breakdownRows, recentRows, dmRow, aiRow, enforcement, profile] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS videos, MIN(moderated_at) AS firstSeen, MAX(moderated_at) AS lastSeen
       FROM moderation_results WHERE uploaded_by = ?`
    ).bind(pubkey).first().catch(() => null),
    db.prepare(
      `SELECT action, COUNT(*) AS count FROM moderation_results WHERE uploaded_by = ? GROUP BY action`
    ).bind(pubkey).all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT sha256, action, moderated_at, review_notes, raw_response
       FROM moderation_results
       WHERE uploaded_by = ? AND action IN ('REVIEW','QUARANTINE','AGE_RESTRICTED','PERMANENT_BAN')
       ORDER BY moderated_at DESC LIMIT 10`
    ).bind(pubkey).all().catch(() => ({ results: [] })),
    db.prepare(
      `SELECT COUNT(*) AS dmCount FROM dm_log WHERE sender_pubkey = ? OR recipient_pubkey = ?`
    ).bind(pubkey, pubkey).first().catch(() => null),
    db.prepare(
      `SELECT COUNT(*) AS aiFlaggedCount FROM moderation_results
       WHERE uploaded_by = ? AND (categories LIKE '%ai_generated%' OR categories LIKE '%deepfake%')`
    ).bind(pubkey).first().catch(() => null),
    getUploaderEnforcement(db, pubkey).catch(() => null),
    resolveProfileWithTimeout(pubkey, env)
  ]);

  for (const row of (breakdownRows?.results || [])) {
    if (row?.action && actionBreakdown[row.action] !== undefined) {
      actionBreakdown[row.action] = Number(row.count) || 0;
    }
  }

  const recentFlagged = (recentRows?.results || []).map((row) => ({
    sha256: row.sha256,
    action: row.action,
    processedAt: row.moderated_at,
    reason: extractReasonFromRow(row)
  }));

  return {
    pubkey,
    profile: profile || null,
    totals: {
      videos: Number(totalsRow?.videos) || 0,
      firstSeen: totalsRow?.firstSeen || null,
      lastSeen: totalsRow?.lastSeen || null
    },
    actionBreakdown,
    recentFlagged,
    aiFlaggedCount: Number(aiRow?.aiFlaggedCount) || 0,
    dmCount: Number(dmRow?.dmCount) || 0,
    enforcement: enforcement || null
  };
}

async function getAdminLookupVideo(identifier, env, options = {}) {
  const { allowFunnelcakeFallback = true } = options;
  const hash = isValidSha256(identifier) ? identifier.toLowerCase() : null;
  const cdnUrl = `https://${env.CDN_DOMAIN || 'media.divine.video'}/${hash}`;
  if (hash) {
    const moderatedRow = await env.BLOSSOM_DB.prepare(`
      SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, review_notes, uploaded_by, raw_response, videoseal
      FROM moderation_results
      WHERE sha256 = ?
    `).bind(hash).first();

    const kvModerationRaw = await env.MODERATION_KV.get(`moderation:${hash}`);
    const kvModeration = parseMaybeJson(kvModerationRaw, null);

    if (moderatedRow || kvModeration) {
      const moderatedAt = kvModeration?.moderated_at || moderatedRow?.moderated_at || null;
      const storedLookup = buildStoredLookupMetadata(moderatedRow);
      const storedRaw = parseMaybeJson(moderatedRow?.raw_response, null);
      return enrichAdminLookupVideo({
        sha256: hash,
        action: kvModeration?.action || moderatedRow?.action || 'REVIEW',
        provider: kvModeration?.provider || moderatedRow?.provider || null,
        scores: parseMaybeJson(kvModeration?.scores, null) || parseMaybeJson(moderatedRow?.scores, {}),
        categories: parseMaybeJson(kvModeration?.categories, null) || parseMaybeJson(moderatedRow?.categories, []),
        processedAt: moderatedAt ? new Date(moderatedAt).getTime() : null,
        moderated_at: moderatedAt,
        reviewed_by: moderatedRow?.reviewed_by || kvModeration?.reviewedBy || kvModeration?.overriddenBy || null,
        reviewed_at: moderatedRow?.reviewed_at || null,
        uploaded_by: moderatedRow?.uploaded_by || kvModeration?.uploadedBy || null,
        eventId: storedLookup.eventId,
        divineUrl: storedLookup.divineUrl,
        nostrContext: storedLookup.nostrContext,
        reason: kvModeration?.reason || moderatedRow?.review_notes || null,
        manualOverride: Boolean(kvModeration?.manualOverride),
        overriddenAt: kvModeration?.overriddenAt || moderatedRow?.reviewed_at || null,
        previousAction: kvModeration?.previousAction || null,
        detailedCategories: parseMaybeJson(kvModeration?.detailedCategories, null),
        categoryVerifications: parseMaybeJson(kvModeration?.categoryVerifications, {}) || {},
        cdnUrl: kvModeration?.cdnUrl || cdnUrl,
        c2pa: (storedRaw && typeof storedRaw === 'object' && storedRaw.c2pa) || null,
        videoseal: parseMaybeJson(kvModeration?.videoseal, null) || parseMaybeJson(moderatedRow?.videoseal, null)
      }, env);
    }

    const untriagedRow = await env.BLOSSOM_DB.prepare(`
      SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name
      FROM bunny_webhook_events e1
      WHERE e1.sha256 = ?
        AND received_at = (
          SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
        )
      LIMIT 1
    `).bind(hash).first();

    if (untriagedRow && !['error', 'deleted'].includes(untriagedRow.status_name)) {
      let nostrContext = null;
      let eventId = null;
      let divineUrl = null;
      let uploaderPubkey = null;
      try {
        const event = await fetchNostrEventBySha256(hash, ['wss://relay.divine.video'], env);
        if (event) {
          const metadata = parseVideoEventMetadata(event);
          const stableId = getEventTagValue(event.tags || [], 'd') || event.id || hash;
          eventId = event.id;
          divineUrl = `https://divine.video/video/${encodeURIComponent(stableId)}`;
          uploaderPubkey = event.pubkey || null;
          nostrContext = {
            title: metadata?.title || null,
            author: metadata?.author || null,
            client: metadata?.client || null,
            content: metadata?.content || event.content || null,
            pubkey: event.pubkey ? `${event.pubkey.substring(0, 16)}...` : null,
            eventId
          };
        }
      } catch (error) {
        console.error(`[ADMIN] Failed to fetch Nostr context for ${hash}:`, error.message);
      }

      return enrichAdminLookupVideo({
        sha256: hash,
        videoGuid: untriagedRow.video_guid,
        hlsUrl: untriagedRow.hls_url,
        mp4Url: untriagedRow.mp4_url,
        thumbnailUrl: untriagedRow.thumbnail_url,
        receivedAt: untriagedRow.received_at,
        status: 'UNTRIAGED',
        cdnUrl,
        nostrContext,
        eventId,
        divineUrl,
        uploaded_by: uploaderPubkey
      }, env);
    }
  }

  if (!allowFunnelcakeFallback) {
    return null;
  }

  const funnelcakeVideo = await fetchFunnelcakeLookupVideo(identifier);
  if (!funnelcakeVideo) {
    return null;
  }

  if (funnelcakeVideo.mediaSha) {
    const resolvedByMediaSha = await getAdminLookupVideo(funnelcakeVideo.mediaSha, env, {
      allowFunnelcakeFallback: false
    });
    if (resolvedByMediaSha) {
      return enrichAdminLookupVideo(mergeLookupMetadata(resolvedByMediaSha, funnelcakeVideo), env);
    }
  }

  if (!funnelcakeVideo.mediaSha) {
    return null;
  }

  return enrichAdminLookupVideo({
    sha256: funnelcakeVideo.mediaSha,
    receivedAt: funnelcakeVideo.createdAt ? new Date(funnelcakeVideo.createdAt * 1000).toISOString() : null,
    status: 'UNTRIAGED',
    cdnUrl: funnelcakeVideo.videoUrl || `https://${env.CDN_DOMAIN || 'media.divine.video'}/${funnelcakeVideo.mediaSha}`,
    thumbnailUrl: funnelcakeVideo.thumbnailUrl,
    nostrContext: funnelcakeVideo.nostrContext,
    uploaded_by: funnelcakeVideo.uploadedBy,
    divineUrl: funnelcakeVideo.divineUrl,
    lookupId: funnelcakeVideo.lookupId,
    eventId: funnelcakeVideo.eventId
  }, env);
}

function appendAdminPlaybackCandidate(candidates, seenUrls, url, source) {
  if (typeof url !== 'string' || !url.trim()) {
    return;
  }

  try {
    const normalizedUrl = new URL(url).toString();
    if (seenUrls.has(normalizedUrl)) {
      return;
    }
    seenUrls.add(normalizedUrl);
    candidates.push({ url: normalizedUrl, source });
  } catch {
    // Ignore malformed URLs stored in metadata and continue through other candidates.
  }
}

async function getStoredAdminPlaybackCandidates(sha256, env) {
  const [moderatedRow, untriagedRow, kvModerationRaw] = await Promise.all([
    env.BLOSSOM_DB.prepare(`
      SELECT content_url
      FROM moderation_results
      WHERE sha256 = ?
    `).bind(sha256).first(),
    env.BLOSSOM_DB.prepare(`
      SELECT mp4_url, hls_url
      FROM bunny_webhook_events e1
      WHERE e1.sha256 = ?
        AND received_at = (
          SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
        )
      LIMIT 1
    `).bind(sha256).first(),
    env.MODERATION_KV.get(`moderation:${sha256}`)
  ]);

  const kvModeration = parseMaybeJson(kvModerationRaw, null);
  const candidates = [];
  const seenUrls = new Set();

  appendAdminPlaybackCandidate(candidates, seenUrls, moderatedRow?.content_url, 'stored-content-url');
  appendAdminPlaybackCandidate(candidates, seenUrls, kvModeration?.cdnUrl, 'stored-cdn-url');
  appendAdminPlaybackCandidate(candidates, seenUrls, untriagedRow?.mp4_url, 'bunny-mp4-url');
  appendAdminPlaybackCandidate(candidates, seenUrls, untriagedRow?.hls_url, 'bunny-hls-url');

  return candidates;
}

function buildAdminVideoProxyRequestInit(request, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  for (const headerName of ['Range', 'If-Range']) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  return {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers
  };
}

function createAdminVideoProxyResponse(upstreamResponse, proxySource, extraHeaders = {}) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Admin-Proxy': proxySource
  });

  for (const headerName of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = upstreamResponse.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'video/mp4');
  }

  for (const [headerName, value] of Object.entries(extraHeaders)) {
    if (value) {
      headers.set(headerName, value);
    }
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers
  });
}

async function handleLegacyScan(request, env) {
  const body = await request.json();
  const { sha256, url: videoUrl, source, pubkey, metadata } = body;

  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'sha256 required (64 hex characters)' });
  }

  const hash = sha256.toLowerCase();
  const existing = await env.BLOSSOM_DB.prepare(
    'SELECT sha256, action FROM moderation_results WHERE sha256 = ?'
  ).bind(hash).first();

  if (existing) {
    return jsonResponse(200, {
      sha256: hash,
      status: 'already_moderated',
      action: existing.action,
      queued: false
    });
  }

  const resolvedVideoUrl = videoUrl || `https://media.divine.video/${hash}`;
  await env.MODERATION_QUEUE.send({
    sha256: hash,
    r2Key: `blobs/${hash}`,
    uploadedBy: pubkey || undefined,
    uploadedAt: Date.now(),
    metadata: {
      ...(metadata || {}),
      source: source || 'api',
      videoUrl: resolvedVideoUrl
    }
  });

  console.log(`[SCAN] Queued ${hash} from ${source || 'api'}`);
  return jsonResponse(202, {
    sha256: hash,
    status: 'queued',
    queued: true,
    videoUrl: resolvedVideoUrl
  });
}

async function handleLegacyBatchScan(request, env) {
  const body = await request.json();
  const { videos, source: defaultSource } = body;

  if (!Array.isArray(videos) || videos.length === 0) {
    return jsonResponse(400, { error: 'videos array required' });
  }

  if (videos.length > 100) {
    return jsonResponse(400, { error: 'Maximum 100 videos per batch' });
  }

  const results = [];
  let queued = 0;
  let skipped = 0;
  let errors = 0;

  for (const video of videos) {
    const { sha256, url: videoUrl, source, pubkey, metadata } = video;

    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
      results.push({ sha256, status: 'error', error: 'Invalid sha256' });
      errors++;
      continue;
    }

    const hash = sha256.toLowerCase();
    const existing = await env.BLOSSOM_DB.prepare(
      'SELECT sha256, action FROM moderation_results WHERE sha256 = ?'
    ).bind(hash).first();

    if (existing) {
      results.push({ sha256: hash, status: 'already_moderated', action: existing.action });
      skipped++;
      continue;
    }

    const resolvedVideoUrl = videoUrl || `https://media.divine.video/${hash}`;
    await env.MODERATION_QUEUE.send({
      sha256: hash,
      r2Key: `blobs/${hash}`,
      uploadedBy: pubkey || undefined,
      uploadedAt: Date.now(),
      metadata: {
        ...(metadata || {}),
        source: source || defaultSource || 'batch-api',
        videoUrl: resolvedVideoUrl
      }
    });

    results.push({ sha256: hash, status: 'queued' });
    queued++;
  }

  console.log(`[BATCH] Queued ${queued}, skipped ${skipped}, errors ${errors}`);
  return jsonResponse(202, {
    total: videos.length,
    queued,
    skipped,
    errors,
    results
  });
}

async function handleLegacyStatus(sha256, env) {
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'Invalid sha256' });
  }

  const hash = sha256.toLowerCase();
  const result = await env.BLOSSOM_DB.prepare(`
    SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
    FROM moderation_results
    WHERE sha256 = ?
  `).bind(hash).first();

  if (!result) {
    return jsonResponse(200, {
      sha256: hash,
      moderated: false,
      action: null,
      message: 'No moderation result found'
    });
  }

  return jsonResponse(200, {
    sha256: hash,
    moderated: true,
    action: result.action,
    provider: result.provider,
    scores: result.scores ? JSON.parse(result.scores) : null,
    categories: result.categories ? JSON.parse(result.categories) : null,
    moderated_at: result.moderated_at,
    reviewed_by: result.reviewed_by,
    reviewed_at: result.reviewed_at,
    blocked: result.action === 'PERMANENT_BAN',
    age_restricted: result.action === 'AGE_RESTRICTED',
    needs_review: result.action === 'REVIEW'
  });
}

export default {
  /**
   * HTTP handler for testing and admin dashboard
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startTime = Date.now();
    const requestId = crypto.randomUUID().substring(0, 8);
    const hostname = url.hostname;
    const isLocalRequest = isLocalHostname(hostname);

    // Log all incoming requests
    console.log(`[${requestId}] ${request.method} ${url.pathname}${url.search ? '?' + url.search.substring(0, 100) : ''}`);

    // Do not expose the workers.dev hostname in production.
    if (hostname.endsWith('.workers.dev')) {
      console.log(`[${requestId}] Rejected workers.dev request to ${url.pathname}`);
      return new Response('Not Found', { status: 404 });
    }

    if (!isLocalRequest && hostname !== API_HOSTNAME && hostname !== ADMIN_HOSTNAME) {
      console.log(`[${requestId}] Rejected unknown hostname ${hostname}`);
      return new Response('Not Found', { status: 404 });
    }

    if (!isLocalRequest && hostname === ADMIN_HOSTNAME) {
      if (url.pathname === '/') {
        return Response.redirect(`${url.origin}/admin`, 302);
      }

      if (!isAdminSurfacePath(url.pathname)) {
        const expectedHost = isApiSurfacePath(url.pathname) ? API_HOSTNAME : ADMIN_HOSTNAME;
        return hostMismatchResponse(requestId, hostname, url.pathname, expectedHost);
      }
    }

    if (!isLocalRequest && hostname === API_HOSTNAME && !isApiSurfacePath(url.pathname)) {
      const expectedHost = url.pathname.startsWith('/admin') ? ADMIN_HOSTNAME : API_HOSTNAME;
      return hostMismatchResponse(requestId, hostname, url.pathname, expectedHost);
    }

    await initUploaderEnforcementTable(env.BLOSSOM_DB);

    // Ensure reports table exists
    await initReportsTable(env.BLOSSOM_DB);
    await initAIDetectionEventsTable(env.BLOSSOM_DB);

    if (url.pathname === '/health') {
      return corsResponse(jsonResponse(200, {
        status: 'ok',
        service: hostname === API_HOSTNAME || isLocalRequest ? 'divine-moderation-api' : 'divine-moderation-service',
        timestamp: new Date().toISOString(),
        hostname
      }));
    }

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/v1/')) {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Admin dashboard routes
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      console.log(`[${requestId}] Redirecting to dashboard`);
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }

    // Login is handled by Cloudflare Zero Trust at the edge
    // Redirect any direct login requests to the dashboard (Zero Trust will prompt if needed)
    if (url.pathname === '/admin/login') {
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }

    // Logout via Cloudflare Access
    if (url.pathname === '/admin/logout') {
      console.log(`[${requestId}] Logout request - redirecting to CF Access logout`);
      // Cloudflare Access logout URL clears the session
      return Response.redirect(`${url.origin}/cdn-cgi/access/logout`, 302);
    }

    if (url.pathname === '/admin/dashboard') {
      // Check authentication (defense-in-depth; Zero Trust handles this at edge)
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      return new Response(dashboardHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/admin/review') {
      // Check authentication (defense-in-depth; Zero Trust handles this at edge)
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      return new Response(swipeReviewHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/admin/messages') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      return new Response(messagesHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/admin/api/videos') {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/videos`);
        return authError;
      }

      // Parse pagination parameters
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const actionFilter = url.searchParams.get('action') || 'all';
      console.log(`[${requestId}] Fetching videos: filter=${actionFilter}, limit=${limit}, offset=${offset}`);

      // Build SQL query based on filter
      let conditions = [];
      const params = [];

      if (actionFilter === 'FLAGGED') {
        conditions.push("action IN ('REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL");
      } else if (actionFilter === 'QUARANTINE') {
        conditions.push("action IN ('AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL");
      } else if (actionFilter !== 'all') {
        conditions.push('action = ?');
        params.push(actionFilter.toUpperCase());
      }

      // Date filter — exclude old test content from review queues
      const sinceParam = url.searchParams.get('since');
      if (sinceParam) {
        conditions.push('moderated_at >= ?');
        params.push(sinceParam);
      }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      // Sort order — 'oldest' fetches from the back of the queue
      const sortParam = url.searchParams.get('sort');
      const orderDirection = sortParam === 'oldest' ? 'ASC' : 'DESC';

      // Query D1 with pagination
      const query = `
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, uploaded_by
        FROM moderation_results
        ${whereClause}
        ORDER BY moderated_at ${orderDirection}
        LIMIT ? OFFSET ?
      `;
      params.push(limit + 1, offset); // Fetch one extra to check if more exist

      const result = await env.BLOSSOM_DB.prepare(query).bind(...params).all();
      const rows = result.results || [];

      // Check if there are more results
      const hasMore = rows.length > limit;
      const videoRows = rows.slice(0, limit).map(row => ({
        sha256: row.sha256,
        action: row.action,
        provider: row.provider,
        scores: row.scores ? JSON.parse(row.scores) : {},
        categories: row.categories ? JSON.parse(row.categories) : [],
        processedAt: new Date(row.moderated_at).getTime(),
        moderated_at: row.moderated_at,
        reviewed_by: row.reviewed_by,
        reviewed_at: row.reviewed_at,
        uploaded_by: row.uploaded_by || null
      }));

      // Reuse the existing relay-aware per-item lookup so dashboard cards can render
      // publisher/post metadata immediately instead of starting from an "unknown" state.
      const videos = await Promise.all(videoRows.map(async (video) => {
        try {
          const enriched = await getAdminLookupVideo(video.sha256, env);
          if (!enriched) {
            return video;
          }

          return {
            ...video,
            uploaded_by: enriched.uploaded_by || video.uploaded_by || null,
            eventId: enriched.eventId || null,
            divineUrl: enriched.divineUrl || null,
            lookupId: enriched.lookupId || null,
            nostrContext: enriched.nostrContext || null
          };
        } catch (error) {
          console.error(`[${requestId}] Failed to enrich dashboard row ${video.sha256}:`, error.message);
          return video;
        }
      }));

      console.log(`[${requestId}] Returning ${videos.length} videos in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify({
        videos,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + limit : null
      }), {
        headers: JSON_HEADERS
      });
    }

    // Get real stats for dashboard
    if (url.pathname === '/admin/api/stats') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/stats`);
        return authError;
      }
      console.log(`[${requestId}] Fetching stats`);

      try {
        // All stats from D1 - fast SQL queries instead of KV iteration
        const [totalResult, moderationStats, pendingStats] = await Promise.all([
          // Total videos (excluding deleted/error)
          env.BLOSSOM_DB.prepare(`
            SELECT COUNT(DISTINCT sha256) as total
            FROM bunny_webhook_events
            WHERE sha256 IS NOT NULL
              AND status_name NOT IN ('error', 'deleted')
          `).first(),
          // Moderation breakdown by action (all, for "Total Moderated" and "Safe" cards)
          env.BLOSSOM_DB.prepare(`
            SELECT
              action,
              COUNT(*) as count
            FROM moderation_results
            GROUP BY action
          `).all(),
          // Pending review breakdown (unreviewed, for "AI Flagged" and queue counts)
          env.BLOSSOM_DB.prepare(`
            SELECT
              action,
              COUNT(*) as count
            FROM moderation_results
            WHERE reviewed_by IS NULL
            GROUP BY action
          `).all()
        ]);

        const totalInD1 = totalResult?.total || 0;

        // Parse total moderation stats
        let totalModerated = 0;
        let safeCount = 0;
        let reviewCount = 0;
        let ageRestrictedCount = 0;
        let permanentBanCount = 0;

        for (const row of (moderationStats?.results || [])) {
          const count = row.count || 0;
          totalModerated += count;
          switch (row.action) {
            case 'SAFE': safeCount = count; break;
            case 'REVIEW': reviewCount = count; break;
            case 'AGE_RESTRICTED': ageRestrictedCount = count; break;
            case 'PERMANENT_BAN': permanentBanCount = count; break;
          }
        }

        // Parse pending review stats (items not yet reviewed by a human)
        let pendingReviewCount = 0;
        let pendingQuarantineCount = 0;
        let pendingAgeRestrictedCount = 0;
        let pendingPermanentBanCount = 0;

        for (const row of (pendingStats?.results || [])) {
          const count = row.count || 0;
          switch (row.action) {
            case 'REVIEW': pendingReviewCount = count; break;
            case 'QUARANTINE': pendingQuarantineCount = count; break;
            case 'AGE_RESTRICTED': pendingAgeRestrictedCount = count; break;
            case 'PERMANENT_BAN': pendingPermanentBanCount = count; break;
          }
        }

        const pendingFlagged = pendingReviewCount + pendingQuarantineCount + pendingAgeRestrictedCount + pendingPermanentBanCount;
        const untriaged = Math.max(0, totalInD1 - totalModerated);

        console.log(`[${requestId}] Stats: total=${totalInD1}, moderated=${totalModerated}, untriaged=${untriaged}, pendingFlagged=${pendingFlagged} in ${Date.now() - startTime}ms`);
        return new Response(JSON.stringify({
          totalInD1,
          totalModerated,
          untriaged,
          pendingFlagged,
          breakdown: {
            safe: safeCount,
            review: reviewCount,
            ageRestricted: ageRestrictedCount,
            permanentBan: permanentBanCount
          },
          pending: {
            review: pendingReviewCount,
            quarantine: pendingQuarantineCount,
            ageRestricted: pendingAgeRestrictedCount,
            permanentBan: pendingPermanentBanCount
          }
        }), {
          headers: JSON_HEADERS
        });
      } catch (error) {
        console.error(`[${requestId}] Failed to get stats:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get AI-detection policy reporting stats for dashboard
    if (url.pathname === '/admin/api/ai-detection/stats') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/ai-detection/stats`);
        return authError;
      }

      try {
        const estimatedCostCents = Number(env.HIVE_AI_DETECTION_ESTIMATED_COST_CENTS);
        const stats = await getAIDetectionStats(env.BLOSSOM_DB, {
          window: url.searchParams.get('window') || '24h',
          estimatedCostCents: Number.isFinite(estimatedCostCents) && estimatedCostCents > 0
            ? estimatedCostCents
            : null,
        });
        return new Response(JSON.stringify(stats), {
          headers: JSON_HEADERS
        });
      } catch (error) {
        console.error(`[${requestId}] Failed to get AI detection stats:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
    }

    // Get untriaged (unmoderated) videos from D1
    if (url.pathname === '/admin/api/untriaged') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to /admin/api/untriaged`);
        return authError;
      }

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      console.log(`[${requestId}] Fetching untriaged videos: limit=${limit}, offset=${offset}`);

      try {
        // Get recent finished videos from D1, excluding those with later deleted/error status
        // Uses subquery to get only the LATEST status for each sha256
        const result = await env.BLOSSOM_DB.prepare(`
          SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at
          FROM bunny_webhook_events e1
          WHERE sha256 IS NOT NULL
            AND received_at = (
              SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
            )
            AND status_name NOT IN ('error', 'deleted')
          ORDER BY received_at DESC
          LIMIT ? OFFSET ?
        `).bind(limit, offset).all();

        // Check which ones are already moderated
        const unmoderatedRows = [];
        for (const row of result.results) {
          const existingResult = await env.MODERATION_KV.get(`moderation:${row.sha256}`);
          if (!existingResult) {
            unmoderatedRows.push(row);
          }
        }

        // Fetch Nostr context in parallel for all unmoderated videos
        const nostrPromises = unmoderatedRows.map(async (row) => {
          try {
            const event = await fetchNostrEventBySha256(row.sha256, ['wss://relay.divine.video'], env);
            if (event) {
              const metadata = parseVideoEventMetadata(event);
              return {
                sha256: row.sha256,
                eventId: event.id,
                title: metadata?.title || null,
                author: metadata?.author || null,
                client: metadata?.client || null,
                content: metadata?.content || event.content || null,
                pubkey: event.pubkey || null
              };
            }
          } catch (e) {
            console.error(`[ADMIN] Failed to fetch Nostr context for ${row.sha256}:`, e.message);
          }
          return { sha256: row.sha256 };
        });

        const nostrResults = await Promise.all(nostrPromises);
        const nostrMap = new Map(nostrResults.map(r => [r.sha256, r]));

        // Build videos with Nostr context
        const videos = unmoderatedRows.map(row => {
          const nostr = nostrMap.get(row.sha256) || {};
          return {
            sha256: row.sha256,
            videoGuid: row.video_guid,
            hlsUrl: row.hls_url,
            mp4Url: row.mp4_url,
            thumbnailUrl: row.thumbnail_url,
            receivedAt: row.received_at,
            status: 'UNTRIAGED',
            cdnUrl: `https://${env.CDN_DOMAIN}/${row.sha256}`,
            eventId: nostr.eventId || null,
            uploaded_by: nostr.pubkey || null,
            nostrContext: {
              title: nostr.title,
              author: nostr.author,
              client: nostr.client,
              content: nostr.content,
              pubkey: nostr.pubkey ? nostr.pubkey.substring(0, 16) + '...' : null
            }
          };
        });

        // Get total count of untriaged (same logic - latest status not deleted/error)
        const countResult = await env.BLOSSOM_DB.prepare(`
          SELECT COUNT(*) as total FROM (
            SELECT sha256
            FROM bunny_webhook_events e1
            WHERE sha256 IS NOT NULL
              AND received_at = (
                SELECT MAX(received_at) FROM bunny_webhook_events e2 WHERE e2.sha256 = e1.sha256
              )
              AND status_name NOT IN ('error', 'deleted')
          )
        `).first();

        return new Response(JSON.stringify({
          videos,
          total: countResult?.total || 0,
          offset,
          limit,
          hasMore: offset + limit < (countResult?.total || 0)
        }), {
          headers: JSON_HEADERS
        });
      } catch (error) {
        console.error('[ADMIN] Failed to fetch untriaged videos:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/admin/api/video/') && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to ${url.pathname}`);
        return authError;
      }

      const identifier = decodeURIComponent(url.pathname.split('/')[4] || '');
      if (!isValidLookupIdentifier(identifier)) {
        return new Response(JSON.stringify({ error: 'Invalid video lookup identifier' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const video = await getAdminLookupVideo(identifier, env);
        if (!video) {
          return new Response(JSON.stringify({ error: 'Video not found', identifier }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({ video }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[${requestId}] Failed admin lookup for ${identifier}:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/admin/api/uploader/') && url.pathname.endsWith('/enforcement') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const pubkey = url.pathname.split('/')[4];
      if (!isValidPubkey(pubkey)) {
        return new Response(JSON.stringify({ error: 'Invalid uploader pubkey' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const body = await request.json();
      const hasApprovalUpdate = typeof body.approvalRequired === 'boolean';
      const hasRelayUpdate = typeof body.relayBanned === 'boolean';

      if (!hasApprovalUpdate && !hasRelayUpdate && body.notes == null) {
        return new Response(JSON.stringify({ error: 'No enforcement update provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const moderatorEmail = getAuthenticatedUser(request) || 'admin';
      const current = await getUploaderEnforcement(env.BLOSSOM_DB, pubkey);

      if (hasRelayUpdate && body.relayBanned !== Boolean(current?.relay_banned)) {
        await callRelayAdminAction(env, {
          action: body.relayBanned ? 'ban_pubkey' : 'allow_pubkey',
          pubkey,
          reason: body.reason || `Moderator action by ${moderatorEmail}`
        });
      }

      const enforcement = await setUploaderEnforcement(env.BLOSSOM_DB, pubkey, {
        approval_required: hasApprovalUpdate ? body.approvalRequired : undefined,
        approval_reason: hasApprovalUpdate ? (body.reason || null) : undefined,
        relay_banned: hasRelayUpdate ? body.relayBanned : undefined,
        relay_ban_reason: hasRelayUpdate ? (body.reason || null) : undefined,
        notes: body.notes,
        updated_by: moderatorEmail
      });

      return new Response(JSON.stringify({
        success: true,
        pubkey,
        enforcement
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname.startsWith('/admin/api/event/') && url.pathname.endsWith('/delete') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const eventId = url.pathname.split('/')[4];
      if (!isValidSha256(eventId)) {
        return new Response(JSON.stringify({ error: 'Invalid event id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const body = await request.json().catch(() => ({}));
      const moderatorEmail = getAuthenticatedUser(request) || 'admin';
      const reason = body.reason || `Deleted by moderator ${moderatorEmail}`;
      const relayResult = isValidSha256(body.sha256)
        ? await deleteEventFromRelayBySha256(body.sha256, env, 'admin-delete-event', reason)
        : await deleteRelayEventIds([eventId], env, reason);

      if (!relayResult.success) {
        return new Response(JSON.stringify({
          success: false,
          eventId,
          relayResult,
          error: relayResult.error || relayResult.reason || 'Failed to delete relay event'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        eventId,
        relayResult
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Queue an untriaged video for moderation
    if (url.pathname === '/admin/api/queue-moderation' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const { sha256, videoUrl, uploadedBy } = await request.json();
      if (!isValidSha256(sha256)) {
        return new Response(JSON.stringify({ error: 'sha256 required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Queue for moderation
      await env.MODERATION_QUEUE.send({
        sha256,
        r2Key: `videos/${sha256}.mp4`,
        uploadedBy: isValidPubkey(uploadedBy) ? uploadedBy : undefined,
        uploadedAt: Date.now(),
        metadata: {
          source: 'admin-dashboard',
          ...(videoUrl ? { videoUrl } : {})
        }
      });

      return new Response(JSON.stringify({ success: true, sha256, message: 'Queued for moderation' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update moderation action (take down, change classification, etc.)
    if (url.pathname.startsWith('/admin/api/moderate/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      const { action, reason, scores, videoUrl, uploadedBy } = await request.json();

      // Validate action
      if (!['SAFE', 'REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action)) {
        return new Response(JSON.stringify({ error: 'Invalid action. Must be SAFE, REVIEW, QUARANTINE, AGE_RESTRICTED, or PERMANENT_BAN' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get existing moderation result — check D1 first, fall back to KV
      let existing = null;
      const d1Row = await env.BLOSSOM_DB.prepare(
        'SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, uploaded_by FROM moderation_results WHERE sha256 = ?'
      ).bind(sha256).first();

      if (d1Row) {
        existing = {
          action: d1Row.action,
          scores: d1Row.scores ? JSON.parse(d1Row.scores) : {},
          provider: d1Row.provider,
          categories: d1Row.categories ? JSON.parse(d1Row.categories) : [],
          moderated_at: d1Row.moderated_at
        };
      } else {
        // Fall back to KV for legacy data
        const kvData = await env.MODERATION_KV.get(`moderation:${sha256}`);
        if (kvData) {
          existing = JSON.parse(kvData);
        }
      }

      if (!existing) {
        existing = {
          action: null,
          scores: {},
          provider: 'manual',
          categories: [],
          moderated_at: new Date().toISOString(),
          cdnUrl: videoUrl || `https://${env.CDN_DOMAIN}/${sha256}`,
          uploadedBy: isValidPubkey(uploadedBy) ? uploadedBy : null
        };
      }

      const previousAction = existing.action;
      const reviewedAtIso = new Date().toISOString();

      // Update moderation result in KV
      const updated = {
        ...existing,
        action,
        reason: reason || `Manual override by moderator`,
        manualOverride: true,
        overriddenBy: 'admin',
        overriddenAt: Date.now(),
        previousAction
      };

      // If scores provided, override them
      if (scores) {
        updated.scores = {
          ...existing.scores,
          ...scores
        };
        console.log(`[ADMIN] Score override applied for ${sha256}`);
      }

      // Write updated result to KV
      await env.MODERATION_KV.put(
        `moderation:${sha256}`,
        JSON.stringify(updated),
        {
          expirationTtl: 60 * 60 * 24 * 90 // 90 days
        }
      );

      // Update D1 with new action
      await env.BLOSSOM_DB.prepare(`
        INSERT INTO moderation_results (
          sha256, action, provider, scores, categories, raw_response, moderated_at, reviewed_by, reviewed_at, review_notes, uploaded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          action = excluded.action,
          provider = excluded.provider,
          scores = excluded.scores,
          categories = excluded.categories,
          reviewed_by = excluded.reviewed_by,
          reviewed_at = excluded.reviewed_at,
          review_notes = excluded.review_notes,
          transcript_pending = 0,
          transcript_last_checked_at = excluded.reviewed_at,
          transcript_resolved_at = excluded.reviewed_at,
          uploaded_by = COALESCE(moderation_results.uploaded_by, excluded.uploaded_by),
          title = COALESCE(moderation_results.title, excluded.title),
          author = COALESCE(moderation_results.author, excluded.author),
          event_id = COALESCE(moderation_results.event_id, excluded.event_id),
          content_url = COALESCE(moderation_results.content_url, excluded.content_url),
          published_at = COALESCE(moderation_results.published_at, excluded.published_at)
      `).bind(
        sha256,
        action,
        updated.provider || 'manual',
        JSON.stringify(updated.scores || {}),
        JSON.stringify(updated.categories || []),
        JSON.stringify({
          source: 'admin-manual',
          reason: updated.reason,
          previousAction: previousAction || null
        }),
        existing.moderated_at || new Date().toISOString(),
        'admin',
        reviewedAtIso,
        reason || 'Manual override by moderator',
        d1Row?.uploaded_by || updated.uploadedBy || null
      ).run();

      // Update action-specific KV keys
      await Promise.all([
        // Clear old keys
        env.MODERATION_KV.delete(`review:${sha256}`),
        env.MODERATION_KV.delete(`age-restricted:${sha256}`),
        env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
        env.MODERATION_KV.delete(`quarantine:${sha256}`)
      ]);

      // Set new key based on action
      const kvPayload = JSON.stringify({
        category: updated.category,
        reason: updated.reason,
        timestamp: Date.now(),
        manualOverride: true
      });

      if (action === 'REVIEW') {
        await env.MODERATION_KV.put(`review:${sha256}`, kvPayload);
      } else if (action === 'QUARANTINE') {
        await env.MODERATION_KV.put(`quarantine:${sha256}`, kvPayload, { expirationTtl: 60 * 60 * 24 * 90 });
      } else if (action === 'AGE_RESTRICTED') {
        await env.MODERATION_KV.put(`age-restricted:${sha256}`, kvPayload);
      } else if (action === 'PERMANENT_BAN') {
        await env.MODERATION_KV.put(`permanent-ban:${sha256}`, kvPayload);
      }

      // Notify Blossom of the moderation decision.
      const blossomResult = await notifyBlossom(sha256, action, env);

      if (!blossomResult.success && !blossomResult.skipped) {
        console.warn(`[ADMIN] Blossom notification failed: ${blossomResult.error}`);
        return blossomFailureResponse(sha256, action, blossomResult.error);
      }

      // For PERMANENT_BAN: also delete the event from the relay (funnelcake),
      // but only after Blossom confirms enforcement to avoid partial moderation.
      let relayDeleteResult = null;
      if (action === 'PERMANENT_BAN') {
        relayDeleteResult = await deleteEventFromRelayBySha256(sha256, env, 'admin-moderate');
      }

      // Publish kind 1984 (NIP-56) report for non-SAFE actions so human moderation
      // decisions are visible to Osprey and other Nostr event consumers. Without this,
      // only AI classifications (via handleModerationResult) were published; human
      // overrides from the swipe review UI were invisible to the relay.
      let reportPublished = false;
      if (action !== 'SAFE') {
        try {
          const reportData = {
            type: action.toLowerCase().replace('_', '-'),
            sha256,
            cdnUrl: existing.cdnUrl,
            category: existing.category || updated.category,
            scores: updated.scores || {},
            reason: reason || `Manual override by moderator (${previousAction} → ${action})`,
            severity: action === 'PERMANENT_BAN' ? 'high' : 'medium',
            source: 'human-moderator'
          };
          await publishToFaro(reportData, env);
          await publishToContentRelay(reportData, env).catch(
            (err) => console.error(`[ADMIN] Content relay publish failed:`, err)
          );
          reportPublished = true;
          console.log(`[ADMIN] Published kind 1984 report for ${sha256} (${action}, human-moderator)`);
        } catch (error) {
          console.error(`[ADMIN] Failed to publish kind 1984 report:`, error);
          // Non-fatal: don't fail the moderation action over a publish failure
        }
      }

      console.log(`[ADMIN] Updated ${sha256} from ${previousAction} to ${action} (blossom: ${blossomResult.success}, relayDelete: ${relayDeleteResult?.success ?? 'n/a'})`);

      // DM creator about moderation action (non-blocking)
      // DMs sent for permanent actions only. QUARANTINE is temporary (pending secondary
      // verification) — DM fires when it resolves to PERMANENT_BAN via auto-escalation.
      let dmSent = false;
      if (['PERMANENT_BAN', 'AGE_RESTRICTED'].includes(action) && env.NOSTR_PRIVATE_KEY) {
        try {
          // Look up uploaded_by from D1
          const uploaderRow = await env.BLOSSOM_DB.prepare(
            'SELECT uploaded_by, categories, title, published_at FROM moderation_results WHERE sha256 = ?'
          ).bind(sha256).first();
          if (uploaderRow?.uploaded_by) {
            const { sendModerationDM } = await import('./nostr/dm-sender.mjs');
            await sendModerationDM(uploaderRow.uploaded_by, sha256, action, reason || 'Manual moderator action', env, null, { categories: uploaderRow?.categories, title: uploaderRow?.title, publishedAt: uploaderRow?.published_at });
            dmSent = true;
            console.log(`[ADMIN] DM sent to creator ${uploaderRow.uploaded_by.substring(0, 16)}...`);
          }
        } catch (dmErr) {
          console.error(`[ADMIN] DM to creator failed:`, dmErr.message);
        }
      }

      // Notify reporters who filed reports on this content (non-blocking)
      const { notifyReporters } = await import('./nostr/dm-sender.mjs');
      notifyReporters(sha256, action, env, '[ADMIN]').catch(() => {});
      // Notify ATProto labeler of manual override
      notifyAtprotoLabeler({ sha256, action, scores: updated.scores || {}, reviewed_by: 'admin' }, env).catch(err => {
        console.error('[ADMIN] ATProto labeler notification failed:', err.message);
      });

      return new Response(JSON.stringify({
        success: true,
        sha256,
        action,
        previousAction,
        message: `Content updated to ${action}`,
        blossom_notified: blossomResult.success || false,
        relay_event_deleted: relayDeleteResult?.success || false,
        relay_event_id: relayDeleteResult?.eventId || null,
        report_published: reportPublished,
        dm_sent: dmSent
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify/reject individual category detection (for NIP-85 tagging)
    if (url.pathname.startsWith('/admin/api/verify-category/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized verify-category request`);
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      const { category, status } = await request.json();
      console.log(`[${requestId}] Verify category: ${sha256.substring(0, 16)}... ${category} = ${status}`);

      // Validate inputs
      const validCategories = [
        'nudity', 'violence', 'gore', 'offensive', 'weapon', 'self_harm',
        'recreational_drug', 'alcohol', 'tobacco', 'ai_generated', 'deepfake',
        'medical', 'gambling', 'money', 'destruction', 'military',
        'text_profanity', 'qr_unsafe'
      ];

      // Major flags that affect overall content action
      const majorFlags = ['nudity', 'violence', 'gore', 'ai_generated', 'deepfake', 'self_harm'];

      if (!validCategories.includes(category)) {
        return new Response(JSON.stringify({ error: `Invalid category: ${category}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (status !== null && status !== 'confirmed' && status !== 'rejected') {
        return new Response(JSON.stringify({ error: 'Status must be "confirmed", "rejected", or null' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get existing moderation result — check KV first, fall back to D1
      let existing = null;
      const existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
      if (existingData) {
        existing = JSON.parse(existingData);
      } else {
        // Fall back to D1
        const d1Row = await env.BLOSSOM_DB.prepare(
          'SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at FROM moderation_results WHERE sha256 = ?'
        ).bind(sha256).first();
        if (d1Row) {
          existing = {
            action: d1Row.action,
            scores: d1Row.scores ? JSON.parse(d1Row.scores) : {},
            provider: d1Row.provider,
            categories: d1Row.categories ? JSON.parse(d1Row.categories) : [],
            moderated_at: d1Row.moderated_at
          };
        }
      }

      if (!existing) {
        return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const previousAction = existing.action;

      // Update category verifications
      if (!existing.categoryVerifications) {
        existing.categoryVerifications = {};
      }

      if (status === null) {
        delete existing.categoryVerifications[category];
      } else {
        existing.categoryVerifications[category] = status;
      }

      // Generate NIP-85 tags based on verifications
      existing.nip85Tags = generateNIP85Tags(existing.scores, existing.categoryVerifications);

      // Track who verified and when
      existing.lastVerifiedAt = Date.now();
      existing.lastVerifiedBy = 'admin';

      // AUTO-APPROVE LOGIC: Check if rejecting a major flag should auto-approve
      let autoApproved = false;
      if (status === 'rejected' && majorFlags.includes(category) && existing.action !== 'SAFE') {
        // Check if there are any remaining unrejected major flags with high scores
        const remainingMajorFlags = majorFlags.filter(flag => {
          const score = existing.scores?.[flag] || 0;
          const verification = existing.categoryVerifications[flag];
          // Flag is still active if: score >= 0.6 AND NOT rejected
          return score >= 0.6 && verification !== 'rejected';
        });

        console.log(`[${requestId}] Remaining major flags after rejecting ${category}:`, remainingMajorFlags);

        if (remainingMajorFlags.length === 0) {
          // No more major flags - auto-approve!
          console.log(`[${requestId}] Auto-approving ${sha256.substring(0, 16)}... - all major flags rejected`);
          existing.action = 'SAFE';
          existing.autoApprovedAt = Date.now();
          existing.autoApprovedReason = `All major flags rejected by human moderator (last: ${category})`;
          autoApproved = true;

          // Clear action-specific keys
          await Promise.all([
            env.MODERATION_KV.delete(`review:${sha256}`),
            env.MODERATION_KV.delete(`age-restricted:${sha256}`),
            env.MODERATION_KV.delete(`permanent-ban:${sha256}`)
          ]);
        }
      }

      // Write updated result
      await env.MODERATION_KV.put(
        `moderation:${sha256}`,
        JSON.stringify(existing),
        {
          expirationTtl: 60 * 60 * 24 * 90 // 90 days
        }
      );

      // PUBLISH NIP-32 LABEL EVENT (if status is confirmed or rejected)
      let labelResult = null;
      if (status === 'confirmed' || status === 'rejected') {
        const score = existing.scores?.[category] || 0;
        labelResult = await publishLabelEvent({
          sha256,
          category,
          status,
          score,
          cdnUrl: existing.cdnUrl
        }, env);
        console.log(`[${requestId}] Label publish result:`, labelResult);
      }

      console.log(`[${requestId}] Category verification complete: ${category} = ${status}, autoApproved=${autoApproved}`);

      return new Response(JSON.stringify({
        success: true,
        sha256,
        category,
        status,
        categoryVerifications: existing.categoryVerifications,
        nip85Tags: existing.nip85Tags,
        autoApproved,
        previousAction: autoApproved ? previousAction : undefined,
        newAction: autoApproved ? 'SAFE' : undefined,
        labelEvent: labelResult
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // GET /admin/api/inbound-labels — list pending inbound ATProto labels
    if (url.pathname === '/admin/api/inbound-labels' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      // Query pending inbound labels from bridge DB via REST
      // For MVP: query the bridge DB's inbound_labels table via its API
      // This will be wired once the Rust labeler has an HTTP API
      return new Response(JSON.stringify({ labels: [], message: 'Pending bridge DB integration' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /admin/api/inbound-labels/:id/approve — approve an inbound label for Nostr propagation
    if (url.pathname.match(/^\/admin\/api\/inbound-labels\/\d+\/approve$/) && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;
      // For MVP: stub - will call bridge DB API to update review_state
      // Then publish NIP-32 label to Nostr via existing publishLabelEvent()
      return new Response(JSON.stringify({ status: 'approved', message: 'Pending bridge DB integration' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Nostr event context for a video
    if (url.pathname.startsWith('/admin/api/nostr-context/')) {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];

      try {
        const storedRow = await env.BLOSSOM_DB.prepare(`
          SELECT uploaded_by, title, author, event_id, content_url, published_at
          FROM moderation_results
          WHERE sha256 = ?
        `).bind(sha256).first();
        const storedLookup = buildStoredLookupMetadata(storedRow);

        if (storedLookup.nostrContext) {
          return new Response(JSON.stringify({
            found: true,
            metadata: buildAdminNostrMetadata(storedLookup.nostrContext)
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const funnelcakeVideo = await fetchFunnelcakeLookupVideo(sha256).catch((error) => {
          console.error(`[ADMIN] Failed to fetch relay context for ${sha256}:`, error.message);
          return null;
        });

        if (funnelcakeVideo?.nostrContext) {
          return new Response(JSON.stringify({
            found: true,
            metadata: buildAdminNostrMetadata(funnelcakeVideo.nostrContext, {
              createdAt: funnelcakeVideo.createdAt
            })
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const event = await fetchNostrEventBySha256(sha256, ['wss://relay.divine.video'], env);
        if (!event) {
          return new Response(JSON.stringify({ found: false }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const metadata = parseVideoEventMetadata(event) || {};
        const eventId = event.id || null;

        return new Response(JSON.stringify({
          found: true,
          metadata: buildAdminNostrMetadata({
            ...metadata,
            content: metadata.content || event.content || null,
            eventId
          }, {
            createdAt: event.created_at || null
          })
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[ADMIN] Failed to fetch Nostr context for ${sha256}:`, error);
        return new Response(JSON.stringify({ found: false, error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get classifier data for a specific video (admin endpoint)
    if (url.pathname.startsWith('/admin/api/classifier/')) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const classifierData = await env.MODERATION_KV.get(`classifier:${sha256}`);
        if (!classifierData) {
          return new Response(JSON.stringify({ sha256, classifier_data: null }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(classifierData, {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[ADMIN] Error fetching classifier data for ${sha256}:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/admin/api/transcript/')) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];
      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400,
          headers: JSON_HEADERS
        });
      }

      try {
        const transcript = await fetchTranscriptAsset(sha256, env);
        if (transcript.pending) {
          const headers = { ...JSON_HEADERS };
          if (transcript.retryAfterSeconds !== null) {
            headers['Retry-After'] = String(transcript.retryAfterSeconds);
          }

          return new Response(JSON.stringify({
            sha256,
            found: false,
            pending: true,
            subtitleUrl: transcript.subtitleUrl,
            sourceUrl: transcript.sourceUrl,
            retryAfterSeconds: transcript.retryAfterSeconds,
            status: transcript.pendingStatus,
            message: transcript.pendingMessage
          }), {
            status: 202,
            headers
          });
        }

        if (!transcript.found) {
          return new Response(JSON.stringify({
            sha256,
            found: false,
            subtitleUrl: transcript.subtitleUrl,
            sourceUrl: transcript.sourceUrl
          }), {
            status: 404,
            headers: JSON_HEADERS
          });
        }

        return new Response(JSON.stringify({
          sha256,
          found: true,
          subtitleUrl: transcript.subtitleUrl,
          sourceUrl: transcript.sourceUrl,
          transcriptText: transcript.transcriptText
        }), {
          headers: JSON_HEADERS
        });
      } catch (error) {
        console.error(`[ADMIN] Error fetching transcript for ${sha256}:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
    }

    // Get current moderation thresholds (KV overrides + defaults)
    if (url.pathname === '/admin/api/thresholds' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const kvThresholds = await getKVThresholds(env.MODERATION_KV);
      return new Response(JSON.stringify({
        thresholds: kvThresholds || DEFAULT_THRESHOLDS,
        source: kvThresholds ? 'admin' : 'defaults',
        defaults: DEFAULT_THRESHOLDS
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update moderation thresholds (saves to KV)
    if (url.pathname === '/admin/api/thresholds' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const { thresholds } = await request.json();
      if (!thresholds || typeof thresholds !== 'object') {
        return new Response(JSON.stringify({ error: 'thresholds object required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate threshold values
      for (const [category, values] of Object.entries(thresholds)) {
        if (typeof values !== 'object') continue;
        if (values.high !== undefined && (typeof values.high !== 'number' || values.high < 0 || values.high > 1)) {
          return new Response(JSON.stringify({ error: `Invalid high threshold for ${category}: must be 0-1` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (values.medium !== undefined && (typeof values.medium !== 'number' || values.medium < 0 || values.medium > 1)) {
          return new Response(JSON.stringify({ error: `Invalid medium threshold for ${category}: must be 0-1` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (values.high !== undefined && values.medium !== undefined && values.medium >= values.high) {
          return new Response(JSON.stringify({ error: `${category}: medium (${values.medium}) must be less than high (${values.high})` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      await setKVThresholds(env.MODERATION_KV, thresholds);
      console.log(`[ADMIN] Thresholds updated by admin`);

      return new Response(JSON.stringify({ success: true, thresholds }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Reset thresholds to defaults
    if (url.pathname === '/admin/api/thresholds/reset' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      await env.MODERATION_KV.delete('admin:thresholds');
      console.log(`[ADMIN] Thresholds reset to defaults`);

      return new Response(JSON.stringify({ success: true, thresholds: DEFAULT_THRESHOLDS, source: 'defaults' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get moderation service's Nostr pubkey (for adding to relay ADMIN_PUBKEYS)
    if (url.pathname === '/admin/api/nostr-pubkey') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      try {
        if (!env.NOSTR_PRIVATE_KEY) {
          return new Response(JSON.stringify({ error: 'NOSTR_PRIVATE_KEY not configured' }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
          });
        }

        const pubkey = getPublicKey(env.NOSTR_PRIVATE_KEY);
        return new Response(JSON.stringify({ pubkey }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }, null, 2), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get relay polling status
    if (url.pathname === '/admin/api/relay-polling/status') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to relay-polling/status`);
        return authError;
      }

      console.log(`[${requestId}] Fetching relay polling status`);
      const status = await getPollingStatus(env);

      return new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Manually trigger relay polling
    if (url.pathname === '/admin/api/relay-polling/trigger' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        console.log(`[${requestId}] Unauthorized access to relay-polling/trigger`);
        return authError;
      }

      console.log(`[${requestId}] Manually triggering relay poll`);

      // Parse optional parameters from request body
      let since, limit;
      try {
        const body = await request.json();
        since = body.since;
        limit = body.limit;
      } catch (e) {
        // Body is optional
      }

      // Get default since from last poll or config
      if (!since) {
        const lastPoll = await getLastPollTimestamp(env);
        if (lastPoll) {
          since = lastPoll;
        } else {
          const lookbackHours = parseInt(env.RELAY_POLLING_LOOKBACK_HOURS || '1', 10);
          since = Math.floor(Date.now() / 1000) - (lookbackHours * 3600);
        }
      }

      const relays = env.RELAY_POLLING_RELAY_URL
        ? [env.RELAY_POLLING_RELAY_URL]
        : ['wss://relay.divine.video'];

      const results = await pollRelayForVideos(env, {
        since,
        limit: limit || parseInt(env.RELAY_POLLING_LIMIT || '100', 10),
        relays
      });

      // Update last poll timestamp
      await setLastPollTimestamp(env, Math.floor(Date.now() / 1000), {
        totalEvents: results.totalEvents,
        queuedForModeration: results.queuedForModeration,
        alreadyModerated: results.alreadyModerated,
        trigger: 'manual'
      });

      console.log(`[${requestId}] Manual poll complete: ${results.queuedForModeration} videos queued`);

      return new Response(JSON.stringify({
        success: true,
        ...results
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Admin video proxy - fetch from Blossom server
    if (url.pathname.startsWith('/admin/video/')) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return new Response('Unauthorized', { status: 401 });
      }

      const sha256 = url.pathname.split('/')[3].replace(/\.mp4$/i, '').toLowerCase();
      const cdnDomain = env.CDN_DOMAIN || 'media.divine.video';
      const cdnUrl = `https://${cdnDomain}/${sha256}`;
      const adminBypassUrl = `https://${cdnDomain}/admin/api/blob/${sha256}/content`;

      const BROWSER_PLAYABLE_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);

      try {
        const upstreamRequestInit = buildAdminVideoProxyRequestInit(request);

        // CDN fetch (unauthenticated) — works for SAFE/unmoderated content
        const cdnResponse = await fetch(cdnUrl, upstreamRequestInit);
        if (cdnResponse.ok) {
          const contentType = cdnResponse.headers.get('Content-Type') || 'video/mp4';

          // If the format is browser-playable, serve directly
          if (BROWSER_PLAYABLE_TYPES.has(contentType)) {
            console.log(`[ADMIN] Serving video from CDN: ${sha256}`);
            return createAdminVideoProxyResponse(cdnResponse, 'cdn');
          }

          // Non-browser format (e.g. video/3gpp, video/x-matroska) — try transcoded 720p MP4 from Blossom
          console.log(`[ADMIN] CDN returned non-playable ${contentType}, trying transcoded 720p for ${sha256}`);
          const transcodeUrl = `https://${cdnDomain}/${sha256}/720p.mp4`;
          const transcodeResponse = await fetch(transcodeUrl, upstreamRequestInit);
          if (transcodeResponse.ok) {
            console.log(`[ADMIN] Serving transcoded 720p MP4 for ${sha256}`);
            return createAdminVideoProxyResponse(transcodeResponse, 'cdn-transcode');
          }
          console.warn(`[ADMIN] Transcoded 720p not available (${transcodeResponse.status}) for ${sha256}`);
        }

        // CDN returned non-200 or non-playable with no transcode available
        // Fall back to admin bypass endpoint which serves regardless of moderation status
        if (env.BLOSSOM_WEBHOOK_SECRET) {
          console.log(`[ADMIN] CDN returned ${cdnResponse.status}, trying admin bypass for ${sha256}`);
          const bypassResponse = await fetch(
            adminBypassUrl,
            buildAdminVideoProxyRequestInit(request, {
              'Authorization': `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`
            })
          );
          if (bypassResponse.ok) {
            console.log(`[ADMIN] Serving video from admin bypass: ${sha256}`);
            const moderationStatus = bypassResponse.headers.get('X-Moderation-Status');
            return createAdminVideoProxyResponse(bypassResponse, 'blossom-admin', {
              'X-Moderation-Status': moderationStatus
            });
          }
          console.error(`[ADMIN] Admin bypass returned ${bypassResponse.status} for ${sha256}`);
        }

        const storedPlaybackCandidates = await getStoredAdminPlaybackCandidates(sha256, env);
        for (const candidate of storedPlaybackCandidates) {
          if (candidate.url === cdnUrl || candidate.url === adminBypassUrl) {
            continue;
          }

          try {
            const fallbackResponse = await fetch(candidate.url, upstreamRequestInit);
            if (!fallbackResponse.ok) {
              console.warn(`[ADMIN] Stored playback candidate ${candidate.source} returned ${fallbackResponse.status} for ${sha256}`);
              continue;
            }

            console.log(`[ADMIN] Serving video from ${candidate.source}: ${sha256}`);
            return createAdminVideoProxyResponse(fallbackResponse, candidate.source);
          } catch (candidateError) {
            console.warn(`[ADMIN] Stored playback candidate ${candidate.source} failed for ${sha256}: ${candidateError.message}`);
          }
        }

        return new Response(JSON.stringify({
          error: 'Video not found',
          sha256
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[ADMIN] Blossom fetch error for ${sha256}:`, error);
        return new Response(JSON.stringify({
          error: 'Failed to fetch video from Blossom',
          sha256,
          details: error.message
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname.startsWith('/admin/transcript/')) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return new Response('Unauthorized', { status: 401 });
      }

      const sha256 = url.pathname.split('/')[3].replace('.vtt', '');
      if (!isValidSha256(sha256)) {
        return new Response('Invalid sha256 hash', { status: 400 });
      }

      try {
        const transcript = await fetchTranscriptAsset(sha256, env);
        if (transcript.pending) {
          const headers = { ...JSON_HEADERS };
          if (transcript.retryAfterSeconds !== null) {
            headers['Retry-After'] = String(transcript.retryAfterSeconds);
          }

          return new Response(JSON.stringify({
            sha256,
            found: false,
            pending: true,
            subtitleUrl: transcript.subtitleUrl,
            sourceUrl: transcript.sourceUrl,
            retryAfterSeconds: transcript.retryAfterSeconds,
            status: transcript.pendingStatus,
            message: transcript.pendingMessage
          }), {
            status: 202,
            headers
          });
        }

        if (!transcript.found || !transcript.vttContent) {
          return new Response('Transcript not found', { status: 404 });
        }

        return new Response(transcript.vttContent, {
          headers: {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Cache-Control': 'private, no-store'
          }
        });
      } catch (error) {
        console.error(`[ADMIN] Transcript proxy error for ${sha256}:`, error);
        return new Response('Failed to fetch transcript', { status: 502 });
      }
    }

    // Test endpoint to manually trigger moderation
    if (url.pathname === '/test-moderate' && request.method === 'POST') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      const body = await request.json();
      const { sha256, force } = body;

      // If force=true, delete existing result to allow re-moderation
      if (force) {
        await env.BLOSSOM_DB.prepare('DELETE FROM moderation_results WHERE sha256 = ?').bind(sha256).run();
        console.log(`[TEST] Force re-moderation: deleted existing result for ${sha256}`);
      }

      // Send to queue (uploadedBy is optional, omit for test)
      await env.MODERATION_QUEUE.send({
        sha256,
        r2Key: `videos/${sha256}.mp4`,
        uploadedAt: Date.now(),
        metadata: { fileSize: 1000000, contentType: 'video/mp4', duration: 6 }
      });

      return new Response(JSON.stringify({ success: true, message: 'Moderation queued', sha256 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Test KV write
    if (url.pathname === '/test-kv') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        await env.MODERATION_KV.put('test-key', JSON.stringify({ test: true, timestamp: Date.now() }));
        const readBack = await env.MODERATION_KV.get('test-key');
        return new Response(JSON.stringify({ success: true, written: true, readBack }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500
        });
      }
    }

    // Batch classification page - classify already-moderated videos missing classifier data
    if (url.pathname === '/admin/classify') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      return new Response(`<!DOCTYPE html>
<html><head><title>Batch Video Classification</title></head>
<body style="font-family:monospace;padding:20px;max-width:900px;margin:0 auto;background:#1a1a2e;color:#e0e0e0">
<h1 style="color:#00d4ff">Batch Video Classification</h1>
<p style="color:#aaa">Classifies already-moderated videos that are missing classifier data (VLM scene + VTT topics).<br>
Skips expensive moderation — only runs classification pipeline.</p>
<div style="margin:20px 0">
  <label>Batch size: <input id="batchSize" type="number" value="10" min="1" max="50" style="width:60px;background:#222;color:#fff;border:1px solid #444;padding:4px"></label>
  <button id="start" onclick="runClassification()" style="padding:8px 20px;font-size:14px;background:#00d4ff;color:#000;border:none;cursor:pointer;margin-left:10px">Start Batch Classification</button>
  <button id="stop" onclick="stopClassification()" style="padding:8px 20px;font-size:14px;background:#ff4444;color:#fff;border:none;cursor:pointer;margin-left:5px;display:none">Stop</button>
</div>
<div id="stats" style="margin:10px 0;color:#aaa"></div>
<pre id="log" style="background:#111;color:#0f0;padding:20px;height:500px;overflow:auto;border:1px solid #333;font-size:12px"></pre>
<script>
let running = false;
function log(msg) {
  const el = document.getElementById('log');
  el.textContent += new Date().toISOString().substr(11,8) + ' ' + msg + '\\n';
  el.scrollTop = el.scrollHeight;
}
function stopClassification() { running = false; }
async function runClassification() {
  if (running) return;
  running = true;
  const btn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const statsEl = document.getElementById('stats');
  btn.disabled = true;
  stopBtn.style.display = 'inline';
  const batchSize = parseInt(document.getElementById('batchSize').value) || 10;
  let offset = 0, totalClassified = 0, totalSkipped = 0, totalErrors = 0, batch = 0;
  log('Starting batch classification (batchSize=' + batchSize + ')...');
  while (running) {
    batch++;
    log('--- Batch ' + batch + ' (offset=' + offset + ') ---');
    try {
      const res = await fetch('/admin/api/classify-batch', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cursor: offset, batchSize})
      });
      if (!res.ok) { log('ERROR: HTTP ' + res.status); break; }
      const data = await res.json();
      totalClassified += data.classified || 0;
      totalSkipped += data.skipped || 0;
      totalErrors += data.errors || 0;
      log('Classified: ' + (data.classified||0) + ', Skipped: ' + (data.skipped||0) + ', Errors: ' + (data.errors||0));
      if (data.details) data.details.forEach(d => log('  ' + d.sha256.substr(0,12) + '... ' + d.status + (d.error ? ' (' + d.error + ')' : '')));
      statsEl.textContent = 'Total — Classified: ' + totalClassified + ' | Skipped: ' + totalSkipped + ' | Errors: ' + totalErrors;
      if (!data.hasMore) { log('\\n✅ DONE! All videos processed.'); break; }
      offset = data.offset;
    } catch (err) {
      log('FETCH ERROR: ' + err.message);
      break;
    }
  }
  running = false;
  btn.disabled = false;
  stopBtn.style.display = 'none';
  log('Finished.');
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // Batch classification API endpoint - classify videos missing classifier data
    if (url.pathname === '/admin/api/classify-batch' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const body = await request.json().catch(() => ({}));
      const offset = body.cursor || 0;
      const batchSize = Math.min(body.batchSize || 10, 50);

      console.log(`[CLASSIFY-BATCH] Starting batch, offset=${offset}, batchSize=${batchSize}`);

      try {
        // Query D1 for moderated videos
        const rows = await env.MODERATION_DB.prepare(
          'SELECT sha256 FROM moderation_results ORDER BY moderated_at LIMIT ? OFFSET ?'
        ).bind(batchSize, offset).all();

        if (!rows.results || rows.results.length === 0) {
          return new Response(JSON.stringify({
            classified: 0, skipped: 0, errors: 0, offset, hasMore: false,
            message: 'No more videos to process'
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        const details = [];
        let classified = 0, skipped = 0, errors = 0;

        for (const row of rows.results) {
          const { sha256 } = row;
          try {
            // Check if classifier data already exists
            const existing = await env.MODERATION_KV.get(`classifier:${sha256}`);
            if (existing) {
              details.push({ sha256, status: 'skipped', reason: 'already has classifier data' });
              skipped++;
              continue;
            }

            // Run classify-only pipeline
            const result = await classifyVideoOnly(sha256, env);

            // Store in KV (same format as queue handler step 7.5, rawClassifierData: null)
            const classifierPayload = {
              sha256,
              provider: 'classify-only',
              moderatedAt: new Date().toISOString(),
              rawClassifierData: null,
              sceneClassification: result.sceneClassification ? formatForStorage(result.sceneClassification) : null,
              topicProfile: result.topicProfile || null
            };
            await env.MODERATION_KV.put(
              `classifier:${sha256}`,
              JSON.stringify(classifierPayload),
              { expirationTtl: 60 * 60 * 24 * 180 }
            );

            const hasScene = !!result.sceneClassification;
            const hasTopics = !!result.topicProfile;
            details.push({ sha256, status: 'classified', hasScene, hasTopics });
            classified++;
            console.log(`[CLASSIFY-BATCH] Classified ${sha256}: scene=${hasScene}, topics=${hasTopics}`);
          } catch (err) {
            details.push({ sha256, status: 'error', error: err.message });
            errors++;
            console.error(`[CLASSIFY-BATCH] Error classifying ${sha256}: ${err.message}`);
          }
        }

        const nextOffset = offset + rows.results.length;
        // Check if there are more rows beyond this batch
        const countResult = await env.MODERATION_DB.prepare(
          'SELECT COUNT(*) as total FROM moderation_results'
        ).first();
        const hasMore = nextOffset < (countResult?.total || 0);

        return new Response(JSON.stringify({
          classified, skipped, errors, offset: nextOffset, hasMore, details
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        console.error(`[CLASSIFY-BATCH] Batch error: ${err.message}`);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Single-video classification endpoint (useful for testing/debugging)
    if (url.pathname.startsWith('/admin/api/classify/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const sha256 = url.pathname.split('/admin/api/classify/')[1];
      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        console.log(`[CLASSIFY-SINGLE] Classifying ${sha256}`);
        const result = await classifyVideoOnly(sha256, env);

        const classifierPayload = {
          sha256,
          provider: 'classify-only',
          moderatedAt: new Date().toISOString(),
          rawClassifierData: null,
          sceneClassification: result.sceneClassification ? formatForStorage(result.sceneClassification) : null,
          topicProfile: result.topicProfile || null
        };
        await env.MODERATION_KV.put(
          `classifier:${sha256}`,
          JSON.stringify(classifierPayload),
          { expirationTtl: 60 * 60 * 24 * 180 }
        );

        console.log(`[CLASSIFY-SINGLE] Stored classifier data for ${sha256}`);
        return new Response(JSON.stringify(classifierPayload), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.error(`[CLASSIFY-SINGLE] Error: ${err.message}`);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Migration page - simple UI to run migration
    if (url.pathname === '/admin/migrate') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      return new Response(`<!DOCTYPE html>
<html><head><title>KV to D1 Migration</title></head>
<body style="font-family:monospace;padding:20px;max-width:800px;margin:0 auto">
<h1>KV to D1 Migration</h1>
<button id="start" onclick="runMigration()" style="padding:10px 20px;font-size:16px">Start Migration</button>
<pre id="log" style="background:#111;color:#0f0;padding:20px;height:400px;overflow:auto"></pre>
<script>
async function runMigration() {
  const log = document.getElementById('log');
  const btn = document.getElementById('start');
  btn.disabled = true;
  let cursor = null, total = 0, batch = 0;
  while (true) {
    batch++;
    log.textContent += 'Batch ' + batch + '...\\n';
    log.scrollTop = log.scrollHeight;
    const res = await fetch('/admin/api/migrate-kv', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cursor, batchSize: 500})
    });
    const data = await res.json();
    total += data.migrated || 0;
    log.textContent += 'Migrated ' + (data.migrated||0) + ' (total: ' + total + ')\\n';
    if (data.error) { log.textContent += 'ERROR: ' + data.error + '\\n'; break; }
    if (data.done) { log.textContent += '✅ DONE! ' + total + ' records migrated\\n'; break; }
    cursor = data.cursor;
  }
  btn.disabled = false;
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // Migration API endpoint - migrate KV data to D1 in batches
    if (url.pathname === '/admin/api/migrate-kv' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const body = await request.json().catch(() => ({}));
      const cursor = body.cursor || undefined;
      const batchSize = Math.min(body.batchSize || 500, 1000);

      console.log(`[MIGRATE] Starting batch migration, cursor=${cursor ? 'yes' : 'start'}, batchSize=${batchSize}`);

      try {
        // List KV keys
        const listResult = await env.MODERATION_KV.list({
          prefix: 'moderation:',
          cursor,
          limit: batchSize
        });

        const keys = listResult.keys;
        console.log(`[MIGRATE] Found ${keys.length} keys in this batch`);

        if (keys.length === 0) {
          return new Response(JSON.stringify({
            done: true,
            migrated: 0,
            message: 'Migration complete - no more keys'
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Fetch action flags for this batch
        const sha256List = keys.map(k => k.name.replace('moderation:', ''));
        const flagChecks = await Promise.all([
          ...sha256List.map(s => env.MODERATION_KV.get(`review:${s}`).then(v => v ? ['review', s] : null)),
          ...sha256List.map(s => env.MODERATION_KV.get(`age-restricted:${s}`).then(v => v ? ['age-restricted', s] : null)),
          ...sha256List.map(s => env.MODERATION_KV.get(`permanent-ban:${s}`).then(v => v ? ['permanent-ban', s] : null))
        ]);

        const reviewSet = new Set();
        const ageRestrictedSet = new Set();
        const permanentBanSet = new Set();

        for (const flag of flagChecks) {
          if (flag) {
            if (flag[0] === 'review') reviewSet.add(flag[1]);
            else if (flag[0] === 'age-restricted') ageRestrictedSet.add(flag[1]);
            else if (flag[0] === 'permanent-ban') permanentBanSet.add(flag[1]);
          }
        }

        // Fetch all values in parallel
        const values = await Promise.all(
          keys.map(async (k) => {
            const sha256 = k.name.replace('moderation:', '');
            const valueStr = await env.MODERATION_KV.get(k.name);
            if (!valueStr) return null;

            try {
              const value = JSON.parse(valueStr);
              let action = value.action || 'SAFE';
              if (permanentBanSet.has(sha256)) action = 'PERMANENT_BAN';
              else if (ageRestrictedSet.has(sha256)) action = 'AGE_RESTRICTED';
              else if (reviewSet.has(sha256)) action = 'REVIEW';

              return {
                sha256,
                action,
                provider: value.provider || 'sightengine',
                scores: JSON.stringify(value.scores || {}),
                categories: JSON.stringify(value.categories || []),
                raw_response: JSON.stringify(value.rawResponse || value.raw || {}),
                moderated_at: value.moderatedAt || value.timestamp || new Date().toISOString()
              };
            } catch (e) {
              console.error(`[MIGRATE] Error parsing ${sha256}:`, e.message);
              return null;
            }
          })
        );

        const validValues = values.filter(v => v !== null);

        // Batch insert into D1
        if (validValues.length > 0) {
          const stmt = env.BLOSSOM_DB.prepare(`
            INSERT OR REPLACE INTO moderation_results
            (sha256, action, provider, scores, categories, raw_response, moderated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          const batch = validValues.map(v => stmt.bind(
            v.sha256, v.action, v.provider, v.scores, v.categories, v.raw_response, v.moderated_at
          ));

          await env.BLOSSOM_DB.batch(batch);
        }

        const nextCursor = listResult.list_complete ? null : listResult.cursor;

        console.log(`[MIGRATE] Batch complete: migrated=${validValues.length}, hasMore=${!!nextCursor}`);

        return new Response(JSON.stringify({
          done: !nextCursor,
          migrated: validValues.length,
          cursor: nextCursor,
          message: nextCursor ? 'Batch complete, continue with cursor' : 'Migration complete'
        }), { headers: { 'Content-Type': 'application/json' } });

      } catch (error) {
        console.error(`[MIGRATE] Error:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Admin API: Trigger immediate DM inbox sync
    if (url.pathname === '/admin/api/messages/sync' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const { syncInbox } = await import('./nostr/dm-reader.mjs');
      const result = await syncInbox(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: List DM conversations
    if (url.pathname === '/admin/api/messages' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const { getConversations } = await import('./nostr/dm-store.mjs');
      const { getModeratorPubkey } = await import('./nostr/dm-reader.mjs');
      // Pass moderatorPubkey so rows are augmented with participant_pubkey
      // (the non-moderator side) + latest_message/message_type aliases that
      // the admin messages UI expects. Without this, every conversation
      // renders as "(unknown)" because the raw column names don't match.
      const moderatorPubkey = env.NOSTR_PRIVATE_KEY ? getModeratorPubkey(env) : undefined;
      const conversations = await getConversations(env.BLOSSOM_DB, { limit, offset, moderatorPubkey });
      return new Response(JSON.stringify(conversations), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: Get full DM thread by pubkey
    if (url.pathname.startsWith('/admin/api/messages/') && request.method === 'GET' && url.pathname.split('/').length === 5) {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const pubkey = url.pathname.split('/')[4];
      const { getConversationByPubkey } = await import('./nostr/dm-store.mjs');
      const messages = await getConversationByPubkey(env.BLOSSOM_DB, pubkey);
      if (!messages) {
        return new Response(JSON.stringify({ error: 'No conversation found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(messages), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: Send DM reply to a user
    if (url.pathname.startsWith('/admin/api/messages/') && request.method === 'POST' && url.pathname.split('/').length === 5) {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const pubkey = url.pathname.split('/')[4];
      const { message, sha256 } = await request.json();
      if (!message) {
        return new Response(JSON.stringify({ error: 'message is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const { sendModeratorReply } = await import('./nostr/dm-sender.mjs');
      await sendModeratorReply(pubkey, message, sha256 || null, env, null);
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: Resolve Nostr profiles for pubkeys
    if (url.pathname === '/admin/api/profiles' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const pubkeys = (url.searchParams.get('pubkeys') || '').split(',').filter(Boolean).slice(0, 50);
      if (pubkeys.length === 0) {
        return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
      }
      const { resolveProfiles } = await import('./nostr/profile-resolver.mjs');
      const profiles = await resolveProfiles(pubkeys, env);
      return new Response(JSON.stringify(profiles), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin API: Get divine-realness AI verification results for a video
    if (url.pathname.startsWith('/admin/api/realness/') && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const sha256 = url.pathname.split('/').pop();
      const { getRealnessResult } = await import('./moderation/realness-client.mjs');
      const result = await getRealnessResult(sha256, env);
      if (!result) {
        return new Response(JSON.stringify({ error: 'No realness verification found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname.startsWith('/admin/api/uploader/')
        && request.method === 'GET'
        && !url.pathname.endsWith('/enforcement')) {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const parts = url.pathname.split('/');
      const pubkey = parts[4];
      if (!pubkey || parts.length !== 5) {
        return jsonResponse(400, { error: 'pubkey required' });
      }

      try {
        const body = await buildUploaderHistory(pubkey, env);
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.error('[UPLOADER-HISTORY] Error:', err);
        return jsonResponse(500, { error: err.message });
      }
    }

    if (url.pathname === '/admin/api/classic-vines/rollback' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      try {
        const body = await request.json();
        const result = await runClassicVineRollback(body, env, {
          notifyBlossom: (sha256, action) => notifyBlossom(sha256, action, env)
        });
        return jsonResponse(200, result);
      } catch (error) {
        console.error('[CLASSIC-VINES] Rollback error:', error);
        return jsonResponse(error.status || 500, { error: error.message });
      }
    }

    // Creator-delete endpoints — gated by CREATOR_DELETE_PIPELINE_ENABLED feature flag
    if (url.hostname === API_HOSTNAME && env.CREATOR_DELETE_PIPELINE_ENABLED === 'true') {
      const relayUrl = env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video';

      // Adapter: processKind5 and handleSyncDelete expect notifyBlossom's return shape
      // (success, status?, error?, networkError?, skipped?) bound to the DELETE action.
      const callBlossomDelete = (sha256) => notifyBlossom(sha256, 'DELETE', env);

      if (url.pathname.startsWith('/api/delete/') && request.method === 'POST') {
        return handleSyncDelete(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV,
          ctx,
          fetchKind5WithRetry: (id) => fetchKind5WithRetry(id, {
            fetchEventById: (eid) => fetchNostrEventById(eid, [relayUrl], env)
          }),
          fetchTargetEvent: (eid) => fetchNostrEventById(eid, [relayUrl], env),
          callBlossomDelete
        });
      }

      if (url.pathname.startsWith('/api/delete-status/') && request.method === 'GET') {
        return handleStatusQuery(request, {
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV
        });
      }
    }

    // Preview drift between D1 AGE_RESTRICTED rows and live Blossom state.
    // Read-only: never calls notifyBlossom, never writes D1 or KV.
    if (
      url.pathname === '/admin/api/reconcile/age-restricted/preview'
      && (request.method === 'POST' || request.method === 'GET')
    ) {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      let body = {};
      if (request.method === 'POST') {
        try {
          body = await request.json();
        } catch (_) {
          body = {};
        }
      } else {
        const queryLimit = url.searchParams.get('limit');
        const queryCursor = url.searchParams.get('cursor');
        if (queryLimit !== null) body.limit = queryLimit;
        if (queryCursor !== null) body.cursor = queryCursor;
      }

      const rawLimit = body.limit;
      let limit = 50;
      if (rawLimit !== undefined && rawLimit !== null) {
        const normalizedLimit = typeof rawLimit === 'string' ? Number(rawLimit) : rawLimit;
        if (typeof normalizedLimit !== 'number' || !Number.isInteger(normalizedLimit) || normalizedLimit <= 0) {
          return jsonResponse(400, { error: 'limit must be a positive integer' });
        }
        limit = Math.min(normalizedLimit, 100);
      }

      const rawCursor = body.cursor;
      let cursorSha = null;
      if (rawCursor !== undefined && rawCursor !== null) {
        if (typeof rawCursor !== 'string') {
          return jsonResponse(400, { error: 'cursor must be a string' });
        }
        cursorSha = rawCursor;
      }

      try {
        const { rows, nextCursor } = await listAgeRestrictedCandidates(env.BLOSSOM_DB, { cursorSha, limit });

        // Bounded concurrency (<= 6) so a single preview page never overwhelms
        // the Workers subrequest budget even with retries.
        const classifications = [];
        const CONCURRENCY = 6;
        let cursor = 0;
        async function worker() {
          while (true) {
            const idx = cursor++;
            if (idx >= rows.length) return;
            const row = rows[idx];
            let blossomDetail = null;
            let blossomError = null;
            try {
              blossomDetail = await fetchBlossomBlobDetail(row.sha256, env);
            } catch (err) {
              blossomError = err;
            }
            classifications[idx] = classifyAgeRestrictedCandidate({
              sha256: row.sha256,
              blossomDetail,
              blossomError
            });
          }
        }
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, rows.length); i++) {
          workers.push(worker());
        }
        await Promise.all(workers);

        const payload = buildPreviewResponse({ rows, classifications, limit, nextCursor });

        // One structured log line per preview so wrangler tail shows real drift.
        console.log(JSON.stringify({
          event: 'age_restricted_reconcile.preview',
          limit,
          cursor: cursorSha,
          nextCursor: payload.nextCursor,
          counts: payload.counts
        }));

        return jsonResponse(200, payload);
      } catch (error) {
        console.error('[AGE-RESTRICTED-RECONCILE] Preview error:', error);
        return jsonResponse(error.status || 500, { error: error.message });
      }
    }

    // Admin API: Apply age-restricted Blossom reconciliation to an explicit list of SHAs.
    // Re-reads live Blossom state per SHA and only replays the AGE_RESTRICTED
    // webhook when Blossom still reports `restricted`. Returns explicit failed
    // SHAs so the operator can retry the exact list. See
    // docs/superpowers/plans/2026-04-17-age-restricted-blossom-reconciliation-plan.md
    if (url.pathname === '/admin/api/reconcile/age-restricted/apply' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      let body;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse(400, { error: 'Invalid JSON body' });
      }

      const shas = body?.shas;
      if (!Array.isArray(shas) || shas.length === 0) {
        return jsonResponse(400, { error: 'shas must be a non-empty array' });
      }
      if (shas.length > 100) {
        return jsonResponse(400, { error: 'shas exceeds max batch size of 100' });
      }
      for (const sha of shas) {
        if (typeof sha !== 'string' || !isValidSha256(sha)) {
          return jsonResponse(400, { error: `Invalid SHA-256: ${sha}` });
        }
      }

      try {
        const result = await applyAgeRestrictedRepairs({
          shas,
          env,
          fetchBlossomBlobDetail,
          notifyBlossom
        });
        console.log('[AR-RECONCILE][apply]', JSON.stringify({
          attempted: result.attempted,
          notified: result.notified,
          failed: result.failed,
          skipped: result.skipped
        }));
        return jsonResponse(200, result);
      } catch (error) {
        console.error('[AR-RECONCILE][apply] Unhandled error:', error);
        return jsonResponse(500, { error: error.message });
      }
    }

    // API: Submit a user report for a piece of content (NIP-56)
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname === '/api/v1/scan' && request.method === 'POST') {
      const authError = verifyLegacyBearerAuth(request, env);
      if (authError) return corsResponse(authError);

      try {
        return corsResponse(await handleLegacyScan(request, env));
      } catch (error) {
        console.error('[SCAN] Error:', error);
        return corsResponse(jsonResponse(500, { error: error.message }));
      }
    }

    if (url.pathname === '/api/v1/batch-scan' && request.method === 'POST') {
      const authError = verifyLegacyBearerAuth(request, env);
      if (authError) return corsResponse(authError);

      try {
        return corsResponse(await handleLegacyBatchScan(request, env));
      } catch (error) {
        console.error('[BATCH] Error:', error);
        return corsResponse(jsonResponse(500, { error: error.message }));
      }
    }

    if (url.pathname.startsWith('/api/v1/status/') && request.method === 'GET') {
      const authError = verifyLegacyBearerAuth(request, env);
      if (authError) return corsResponse(authError);

      try {
        const sha256 = url.pathname.split('/')[4];
        return corsResponse(await handleLegacyStatus(sha256, env));
      } catch (error) {
        console.error('[STATUS] Error:', error);
        return corsResponse(jsonResponse(500, { error: error.message }));
      }
    }

    if (url.pathname === '/api/v1/report' && request.method === 'POST') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        console.log(`[API] Authentication failed for /api/v1/report: ${verification.error}`);
        return apiUnauthorizedResponse(verification);
      }

      try {
        const { sha256, reporter_pubkey, report_type, reason } = await request.json();

        if (!sha256 || !reporter_pubkey || !report_type) {
          return new Response(JSON.stringify({ error: 'sha256, reporter_pubkey, and report_type are required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const result = await addReport(env.BLOSSOM_DB, { sha256, reporter_pubkey, report_type, reason });

        console.log(`[API] Report added: ${sha256} by ${reporter_pubkey.substring(0, 16)}... escalate=${result.escalate}`);

        if (isAiReportType(report_type) && env.MODERATION_QUEUE) {
          const reportedAt = new Date().toISOString();
          await env.MODERATION_QUEUE.send({
            sha256,
            r2Key: `videos/${sha256}.mp4`,
            uploadedAt: Date.now(),
            metadata: {
              source: 'user-report',
              forceAIDetection: true,
              reportType: report_type,
              reportedBy: reporter_pubkey,
              ...(reason ? { reportReason: reason } : {})
            }
          });
          console.log(`[API] Queued forced AI detection for reported content ${sha256}`);

          try {
            await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIReportEvent({
              sha256,
              reportType: report_type,
              createdAt: reportedAt,
            }));
          } catch (eventErr) {
            console.error(`[API] Failed to record AI report event for ${sha256}:`, eventErr.message);
          }
        } else if (env.MODERATION_QUEUE) {
          const allowed = await shouldQueueHiveRecheck(env.BLOSSOM_DB, sha256);
          if (allowed) {
            await env.MODERATION_QUEUE.send({
              sha256,
              r2Key: `videos/${sha256}.mp4`,
              uploadedAt: Date.now(),
              metadata: {
                source: 'user-report',
                forceProvider: 'hiveai',
                reportType: report_type,
                reportedBy: reporter_pubkey,
                ...(reason ? { reportReason: reason } : {})
              }
            });
            console.log(`[API] Queued Hive recheck for reported content ${sha256} (report_type=${report_type})`);
          } else {
            console.log(`[API] Skipped Hive recheck for ${sha256} - rate-limited (recent hiveai run)`);
          }
        }

        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[API] Error adding report:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Send DM notification only (no Blossom/D1 moderation side effects)
    // Used by relay-manager to notify users after NIP-86 moderation actions
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname === '/api/v1/notify' && request.method === 'POST') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        console.log(`[API] Authentication failed for /api/v1/notify: ${verification.error}`);
        return apiUnauthorizedResponse(verification);
      }

      try {
        const body = await request.json();
        const { recipientPubkey, action, reason, sha256, eventId } = body;

        if (!isValidPubkey(recipientPubkey)) {
          return new Response(JSON.stringify({ error: 'Valid recipientPubkey (64-char hex) required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (!action || typeof action !== 'string') {
          return new Response(JSON.stringify({ error: 'action required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const validNotifyActions = ['PERMANENT_BAN', 'AGE_RESTRICTED', 'QUARANTINE', 'ACCOUNT_SUSPENDED', 'REPORT_OUTCOME_ACTION', 'REPORT_OUTCOME_NO_ACTION'];
        if (!validNotifyActions.includes(action)) {
          return new Response(JSON.stringify({
            error: `Invalid action. Must be one of: ${validNotifyActions.join(', ')}`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (!env.NOSTR_PRIVATE_KEY) {
          console.warn('[API] /api/v1/notify called but NOSTR_PRIVATE_KEY not configured');
          return new Response(JSON.stringify({ success: true, dm_sent: false, reason: 'DM sending not configured' }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const { sendModerationDM } = await import('./nostr/dm-sender.mjs');
        const dmResult = await sendModerationDM(
          recipientPubkey,
          sha256 || null,
          action,
          reason || null,
          env,
          null
        );

        const authSource = authSourceFromVerification(verification);
        console.log(`[API] /api/v1/notify: action=${action} recipient=${recipientPubkey.substring(0, 16)}... dm_sent=${dmResult.sent} (auth: ${authSource})${eventId ? ` eventId=${eventId}` : ''}`);

        return new Response(JSON.stringify({
          success: true,
          dm_sent: dmResult.sent,
          reason: dmResult.reason || null
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[API] Error in /api/v1/notify:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Update moderation status (for external services)
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname === '/api/v1/moderate' && request.method === 'POST') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        console.log(`[API] Authentication failed: ${verification.error}`);
        return apiUnauthorizedResponse(verification);
      }

      // Determine auth source for logging
      const authSource = authSourceFromVerification(verification);

      try {
        const body = await request.json();
        const { sha256, action, reason, source } = body;

        if (!sha256 || !action) {
          return new Response(JSON.stringify({ error: 'sha256 and action required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Validate action
        const validActions = ['SAFE', 'REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
        if (!validActions.includes(action.toUpperCase())) {
          return new Response(JSON.stringify({
            error: `Invalid action. Must be one of: ${validActions.join(', ')}`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Update or insert moderation result
        await env.BLOSSOM_DB.prepare(`
          INSERT INTO moderation_results (sha256, action, provider, scores, categories, moderated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(sha256) DO UPDATE SET
            action = excluded.action,
            provider = excluded.provider,
            review_notes = ?,
            reviewed_at = ?
        `).bind(
          sha256,
          action.toUpperCase(),
          source || 'external-api',
          JSON.stringify({}),
          JSON.stringify([reason || action.toLowerCase()]),
          new Date().toISOString(),
          reason || null,
          new Date().toISOString()
        ).run();

        console.log(`[API] Moderation updated: ${sha256} -> ${action} by ${source || 'external-api'} (auth: ${authSource})`);

        // Notify divine-blossom of the moderation decision
        const blossomResult = await notifyBlossom(sha256, action.toUpperCase(), env);

        // If Blossom notification failed (and wasn't skipped), return 502.
        // The D1 record is written but enforcement didn't land.
        if (!blossomResult.success && !blossomResult.skipped) {
          console.warn(`[API] Blossom notification failed but moderation was recorded: ${blossomResult.error}`);
          return blossomFailureResponse(sha256, action.toUpperCase(), blossomResult.error);
        }

        return new Response(JSON.stringify({
          success: true,
          sha256,
          action: action.toUpperCase(),
          updated_at: new Date().toISOString(),
          blossom_notified: blossomResult.success || false
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (error) {
        console.error('[API] Error updating moderation:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Check moderation result
    if (url.pathname.startsWith('/check-result/')) {
      const sha256 = url.pathname.split('/')[2];

      // Query D1 for moderation result
      const d1Result = await env.BLOSSOM_DB.prepare(`
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, videoseal
        FROM moderation_results
        WHERE sha256 = ?
      `).bind(sha256).first();

      if (!d1Result) {
        return corsResponse(new Response(JSON.stringify({
          sha256,
          status: 'unknown',
          moderated: false,
          blocked: false,
          age_restricted: false
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      // Simplified response for external tools
      const action = d1Result.action;
      return corsResponse(new Response(JSON.stringify({
        sha256,
        status: action.toLowerCase(),
        moderated: true,
        blocked: action === 'PERMANENT_BAN',
        quarantined: action === 'QUARANTINE',
        age_restricted: action === 'AGE_RESTRICTED',
        needs_review: action === 'REVIEW' || action === 'QUARANTINE' || action === 'PERMANENT_BAN',
        action,
        provider: d1Result.provider,
        scores: d1Result.scores ? JSON.parse(d1Result.scores) : null,
        categories: d1Result.categories ? JSON.parse(d1Result.categories) : null,
        videoseal: parseMaybeJson(d1Result.videoseal, null),
        moderated_at: d1Result.moderated_at,
        reviewed_by: d1Result.reviewed_by,
        reviewed_at: d1Result.reviewed_at
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // API: Canonical moderation vocabulary (public, no auth required)
    if (url.pathname === '/api/v1/moderation/vocabulary' && request.method === 'GET') {
      const { CANONICAL_LABELS, ALIASES } = await import('./moderation/vocabulary.mjs');
      return corsResponse(new Response(JSON.stringify({
        labels: [...CANONICAL_LABELS],
        aliases: { ...ALIASES },
        version: '1.0',
      }), {
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // API: Moderation decisions list (for divine-relay-manager integration)
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname === '/api/v1/decisions' && request.method === 'GET') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        const action = url.searchParams.get('action');
        const since = url.searchParams.get('since');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        let query = 'SELECT sha256, action, provider, scores, moderated_at, reviewed_by, reviewed_at, uploaded_by FROM moderation_results';
        const conditions = [];
        const bindings = [];

        if (action) {
          conditions.push('action = ?');
          bindings.push(action.toUpperCase());
        }
        if (since) {
          conditions.push('moderated_at >= ?');
          bindings.push(since);
        }

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY moderated_at DESC LIMIT ? OFFSET ?';
        bindings.push(limit, offset);

        const results = await env.BLOSSOM_DB.prepare(query).bind(...bindings).all();

        // Get total count for pagination
        let countQuery = 'SELECT COUNT(*) as total FROM moderation_results';
        if (conditions.length > 0) {
          countQuery += ' WHERE ' + conditions.join(' AND ');
        }
        const countResult = await env.BLOSSOM_DB.prepare(countQuery).bind(...bindings.slice(0, -2)).all();
        const total = countResult.results[0]?.total || 0;

        return new Response(JSON.stringify({
          decisions: results.results.map(r => ({
            ...r,
            scores: r.scores ? JSON.parse(r.scores) : null
          })),
          pagination: { total, limit, offset, has_more: offset + limit < total }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[API] Error fetching decisions:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Single moderation decision lookup (for divine-relay-manager integration)
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname.startsWith('/api/v1/decisions/') && request.method === 'GET') {
      const sha256 = url.pathname.split('/')[4];

      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        const result = await env.BLOSSOM_DB.prepare(
          'SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, review_notes FROM moderation_results WHERE sha256 = ?'
        ).bind(sha256).first();

        if (!result) {
          return new Response(JSON.stringify({ error: 'No decision found', sha256 }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify({
          ...result,
          scores: result.scores ? JSON.parse(result.scores) : null,
          categories: result.categories ? JSON.parse(result.categories) : null
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[API] Error fetching decision:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Quarantine/unquarantine content
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname.startsWith('/api/v1/quarantine/') && request.method === 'POST') {
      const sha256 = url.pathname.split('/')[4];

      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        const body = await request.json();
        const { quarantine, reason } = body;
        const newAction = quarantine === false ? 'REVIEW' : 'QUARANTINE';

        const authSource = authSourceFromVerification(verification);

        // Update D1
        await env.BLOSSOM_DB.prepare(`
          UPDATE moderation_results
          SET action = ?, review_notes = ?, reviewed_by = ?, reviewed_at = ?
          WHERE sha256 = ?
        `).bind(
          newAction,
          reason || (quarantine === false ? 'Unquarantined by moderator' : 'Quarantined by moderator'),
          authSource,
          new Date().toISOString(),
          sha256
        ).run();

        // Update KV quarantine flag
        if (quarantine === false) {
          await env.MODERATION_KV.delete(`quarantine:${sha256}`);
        } else {
          await env.MODERATION_KV.put(`quarantine:${sha256}`, JSON.stringify({
            action: 'QUARANTINE',
            reason: reason || 'Quarantined by moderator',
            by: authSource,
            timestamp: new Date().toISOString()
          }), { expirationTtl: 60 * 60 * 24 * 90 });
        }

        // Notify Blossom (relay notification removed — see comment in admin moderate handler)
        const blossomResult = await notifyBlossom(sha256, newAction, env);

        // If Blossom notification failed (and wasn't skipped), return 502.
        // The D1/KV records are written but enforcement didn't land.
        if (!blossomResult.success && !blossomResult.skipped) {
          console.warn(`[API] Blossom notification failed for quarantine ${sha256}: ${blossomResult.error}`);
          return blossomFailureResponse(sha256, newAction, blossomResult.error);
        }

        console.log(`[API] Quarantine updated: ${sha256} -> ${newAction} by ${authSource}`);

        return new Response(JSON.stringify({
          success: true,
          sha256,
          action: newAction,
          updated_at: new Date().toISOString(),
          blossom_notified: blossomResult.success || false
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[API] Error updating quarantine:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Classify-only endpoint — run VLM classification without full moderation
    // Used by funnelcake janitor for bulk backfill of ~21k existing videos
    if (url.pathname === '/api/v1/classify' && request.method === 'POST') {
      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        const body = await request.json();
        const { sha256, url: videoUrl } = body;

        if (!sha256 || sha256.length !== 64) {
          return new Response(JSON.stringify({ error: 'Invalid or missing sha256 (must be 64 hex chars)' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
          });
        }

        console.log(`[API] POST /api/v1/classify — sha256=${sha256}, url=${videoUrl || 'auto-resolve'}`);

        // Check if classifier data already exists
        const existing = await env.MODERATION_KV.get(`classifier:${sha256}`);
        if (existing) {
          console.log(`[API] Classifier data already exists for ${sha256}, returning existing`);
          return new Response(JSON.stringify({
            sha256,
            status: 'already_classified',
            classifier_data: JSON.parse(existing)
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Run classify-only pipeline (synchronous — VLM takes ~7s)
        const result = await classifyVideoOnly(sha256, env, { videoUrl });

        // Store in KV (same format as queue handler step 7.5)
        const classifierPayload = {
          sha256,
          provider: 'classify-only',
          moderatedAt: new Date().toISOString(),
          rawClassifierData: null,
          sceneClassification: result.sceneClassification ? formatForStorage(result.sceneClassification) : null,
          topicProfile: result.topicProfile || null
        };
        await env.MODERATION_KV.put(
          `classifier:${sha256}`,
          JSON.stringify(classifierPayload),
          { expirationTtl: 60 * 60 * 24 * 180 }
        );

        console.log(`[API] Classify-only complete for ${sha256}: scene=${!!result.sceneClassification}, topics=${!!result.topicProfile}`);

        return new Response(JSON.stringify({
          sha256,
          status: 'classified',
          classifier_data: classifierPayload
        }), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        console.error(`[API] Error in /api/v1/classify:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Classifier endpoints for recommendation system data
    // Auth: Bearer token or Cloudflare Access JWT
    if (url.pathname.startsWith('/api/v1/classifier/')) {
      // Parse the path segments: /api/v1/classifier/{sha256}[/recommendations]
      const pathParts = url.pathname.split('/').filter(Boolean);
      // pathParts: ['api', 'v1', 'classifier', sha256, ?'recommendations']
      const sha256 = pathParts[3];
      const subRoute = pathParts[4] || null;

      if (!sha256 || sha256.length !== 64) {
        return new Response(JSON.stringify({ error: 'Invalid sha256 hash' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const verification = await authenticateApiRequest(request, env);
      if (!verification.valid) {
        return apiUnauthorizedResponse(verification);
      }

      try {
        const classifierData = await env.MODERATION_KV.get(`classifier:${sha256}`);
        if (!classifierData) {
          return new Response(JSON.stringify({
            sha256,
            classifier_data: null,
            message: 'No classifier data available for this hash'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // GET /api/v1/classifier/{sha256}/recommendations — pre-formatted for gorse/funnelcake
        if (subRoute === 'recommendations') {
          const parsed = JSON.parse(classifierData);
          const { classifierCategoryToLabels } = await import('./moderation/vocabulary.mjs');

          // Collect content labels from all classification layers
          const contentLabels = [];
          const allFeatures = {};

          // Layer 1: VLM scene classification labels (topics, setting, objects, activities, mood)
          if (parsed.sceneClassification) {
            const sceneLabels = formatForGorse(parsed.sceneClassification);
            contentLabels.push(...sceneLabels);
            const sceneFeatures = formatForFunnelcake(parsed.sceneClassification);
            Object.assign(allFeatures, sceneFeatures);
          }

          // Layer 2: VTT topic labels
          if (parsed.topicProfile) {
            const topicLabels = topicsToLabels(parsed.topicProfile);
            contentLabels.push(...topicLabels);
            const topicFeatures = topicsToWeightedFeatures(parsed.topicProfile);
            Object.assign(allFeatures, topicFeatures);
          }

          // Layer 3: Raw moderation scores — extract moderation labels and content features
          const moderationLabels = [];
          const moderationSources = {};
          if (parsed.rawClassifierData) {
            const rawData = parsed.rawClassifierData;
            if (rawData.maxScores) {
              for (const [key, value] of Object.entries(rawData.maxScores)) {
                if (typeof value === 'number') {
                  // Check if this category maps to a moderation label
                  const modLabels = classifierCategoryToLabels(key, value);
                  if (modLabels.length > 0 && value >= 0.5) {
                    for (const ml of modLabels) {
                      if (!moderationLabels.includes(ml)) {
                        moderationLabels.push(ml);
                        moderationSources[ml] = ['divine-hive'];
                      }
                    }
                  }
                  // Keep all scores as features for compatibility
                  allFeatures[key] = value;
                }
              }
            }
          }

          // Determine safety from moderation result
          const moderationResult = await env.BLOSSOM_DB.prepare(
            'SELECT action, scores FROM moderation_results WHERE sha256 = ?'
          ).bind(sha256).first();

          const action = moderationResult?.action || 'UNKNOWN';
          const isSafe = action === 'SAFE';

          // Also extract moderation labels from D1 moderation scores
          if (moderationResult?.scores) {
            try {
              const scores = JSON.parse(moderationResult.scores);
              for (const [cat, score] of Object.entries(scores)) {
                if (typeof score === 'number' && score >= 0.5) {
                  const modLabels = classifierCategoryToLabels(cat, score);
                  for (const ml of modLabels) {
                    if (!moderationLabels.includes(ml)) {
                      moderationLabels.push(ml);
                      moderationSources[ml] = ['divine-hive'];
                    }
                  }
                }
              }
            } catch (e) {
              // Ignore parse errors
            }
          }

          return new Response(JSON.stringify({
            sha256,
            content_labels: [...new Set(contentLabels)],
            moderation_labels: moderationLabels,
            moderation_sources: moderationSources,
            gorse: {
              labels: [...new Set(contentLabels)],  // content labels only, no moderation
              features: allFeatures
            },
            description: parsed.sceneClassification?.description || null,
            primary_topic: parsed.topicProfile?.primary_topic || null,
            has_speech: parsed.topicProfile?.has_speech || false,
            is_safe: isSafe,
            action
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // GET /api/v1/classifier/{sha256} — full classifier data (all three layers)
        return new Response(classifierData, {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[API] Error fetching classifier data for ${sha256}:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Divine Moderation API\n\nPublic endpoints:\nGET  /health\nGET  /check-result/{sha256}\nGET  /api/v1/moderation/vocabulary\n\nAuthenticated endpoints:\nPOST /test-moderate {"sha256":"..."}\nGET  /api/v1/decisions\nGET  /api/v1/decisions/{sha256}\nPOST /api/v1/quarantine/{sha256}\nPOST /api/v1/moderate\nPOST /api/v1/classify\nGET  /api/v1/classifier/{sha256}\nGET  /api/v1/classifier/{sha256}/recommendations\n\nAdmin UI: https://moderation.admin.divine.video/admin', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  /**
   * Queue consumer for video moderation
   * Triggered when messages are sent to the video-moderation-queue
   */
  async queue(batch, env) {
    console.log(`[MODERATION] Processing batch of ${batch.messages.length} videos`);
    await initAIDetectionEventsTable(env.BLOSSOM_DB);

    for (const message of batch.messages) {
      const startTime = Date.now();

      try {
        console.log('[MODERATION] Step 1: Validating message');

        // Validate message schema
        const validation = validateQueueMessage(message.body);
        if (!validation.valid) {
          console.error(`[MODERATION] Invalid message schema: ${validation.error}`);
          message.ack(); // Acknowledge to remove invalid message
          continue;
        }

        const {
          sha256,
          uploadedBy,
          uploadedAt,
          metadata,
          videoSealPayload,
          videoSealBitAccuracy
        } = validation.data;
        console.log(`[MODERATION] Step 2: Message validated for ${sha256}`);

        // Check if already moderated (duplicate prevention) - use D1
        console.log(`[MODERATION] Step 3: Checking for existing moderation result`);
        const existingResult = await env.BLOSSOM_DB.prepare(
          'SELECT sha256, action, moderated_at FROM moderation_results WHERE sha256 = ?'
        ).bind(sha256).first();

        const forceAIDetection = shouldForceAIDetection(metadata);
        const forcedProviderEnv = applyForceProvider(env, metadata);
        const providerOverridden = forcedProviderEnv !== env;

        if (existingResult && !forceAIDetection && !providerOverridden) {
          console.log(`[MODERATION] ⚠️ SKIPPED ${sha256} - already moderated`);
          console.log(`[MODERATION] Previous result: action=${existingResult.action}, moderated_at=${existingResult.moderated_at}`);
          message.ack();
          continue;
        }

        if (existingResult && providerOverridden) {
          console.log(`[MODERATION] Step 4: Provider override requested for already moderated ${sha256}; previous action=${existingResult.action}; new provider=${metadata?.forceProvider}`);
        } else if (existingResult && forceAIDetection) {
          console.log(`[MODERATION] Step 4: Forced AI detection requested for already moderated ${sha256}; previous action=${existingResult.action}`);
        } else {
          console.log(`[MODERATION] Step 4: No existing result found, starting analysis for ${sha256}`);
        }
        console.log(`[MODERATION] Blossom blob URL: https://${env.CDN_DOMAIN}/blobs/${sha256}`);

        // Run moderation pipeline
        const result = await moderateVideo({
          sha256,
          uploadedBy,
          uploadedAt,
          metadata,
          videoSealPayload,
          videoSealBitAccuracy
        }, forcedProviderEnv);

        if (result.uploadedBy) {
          try {
            const uploaderEnforcement = await getUploaderEnforcement(env.BLOSSOM_DB, result.uploadedBy);
            const enforcedResult = applyUploaderEnforcementToResult(result, uploaderEnforcement);
            if (enforcedResult.applied) {
              console.log(
                `[MODERATION] Enforcement applied for uploader ${result.uploadedBy.substring(0, 16)}... `
                + `(${enforcedResult.mode}: ${enforcedResult.previousAction} -> ${enforcedResult.result.action})`
              );
              Object.assign(result, enforcedResult.result);
            }
          } catch (enforcementErr) {
            console.error(`[MODERATION] Failed to apply uploader enforcement:`, enforcementErr.message);
          }
        }

        console.log(`[MODERATION] Step 5: Analysis complete for ${sha256}`);
        console.log(`[MODERATION] Result: action=${result.action}, severity=${result.severity}`);
        console.log(`[MODERATION] Scores: nudity=${result.scores.nudity}, violence=${result.scores.violence}, ai=${result.scores.ai_generated}`);

        console.log(`[MODERATION] Step 6: Storing result in D1`);
        const moderatedAt = new Date().toISOString();
        const transcriptPending = result.transcriptPending ? 1 : 0;
        const transcriptPendingSince = result.transcriptPending ? moderatedAt : null;
        const transcriptLastCheckedAt = result.transcriptPending ? moderatedAt : null;
        // Store result in D1
        await env.BLOSSOM_DB.prepare(`
          INSERT OR REPLACE INTO moderation_results
          (sha256, action, provider, scores, categories, raw_response, moderated_at, uploaded_by,
           title, author, event_id, content_url, published_at,
           videoseal, transcript_pending, transcript_pending_since, transcript_last_checked_at, transcript_resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          sha256,
          result.action,
          result.provider || 'unknown',
          JSON.stringify(result.scores || {}),
          JSON.stringify(result.categories || []),
          JSON.stringify({ ...(result.rawResponse || {}), c2pa: result.c2pa || null }),
          moderatedAt,
          result.uploadedBy || null,
          result.nostrContext?.title || null,
          result.nostrContext?.author || null,
          result.nostrEventId || null,
          result.nostrContext?.url || result.cdnUrl || null,
          result.nostrContext?.publishedAt || null,
          JSON.stringify(result.videoseal || null),
          transcriptPending,
          transcriptPendingSince,
          transcriptLastCheckedAt,
          null
        ).run();
        console.log(`[MODERATION] Step 7: D1 write successful`);

        try {
          await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIPolicyDecisionEvent({
            sha256,
            uploadedAt,
            result,
          }));
          await recordAIDetectionEvent(env.BLOSSOM_DB, buildAIOutcomeEvent({
            sha256,
            uploadedAt,
            result,
          }));
          console.log(`[MODERATION] Step 7.1: AI detection reporting events recorded for ${sha256}`);
        } catch (eventErr) {
          console.error(`[MODERATION] Failed to record AI detection events for ${sha256}:`, eventErr.message);
        }

        // Step 7.5: Store classifier + classification data in KV for recommendation systems
        {
          try {
            const classifierPayload = {
              sha256,
              provider: result.provider || 'unknown',
              moderatedAt: new Date().toISOString(),
              // Layer 1: Raw Hive moderation scores (all classes, all frames)
              rawClassifierData: result.rawClassifierData || null,
              // Layer 2: VLM scene classification (topics, setting, objects, activities, mood, description)
              sceneClassification: formatForStorage(result.sceneClassification),
              // Preserve frame-level evidence for transcript reprocess republishing.
              flaggedFrames: result.flaggedFrames || [],
              // Layer 3: VTT topic extraction (topic categories from transcript)
              topicProfile: result.topicProfile || null
            };
            await env.MODERATION_KV.put(
              `classifier:${sha256}`,
              JSON.stringify(classifierPayload),
              { expirationTtl: 60 * 60 * 24 * 180 }  // 180 days — longer TTL for recommendation data
            );
            console.log(`[MODERATION] Step 7.5: Classifier data stored in KV (classifier:${sha256}) — raw=${!!result.rawClassifierData}, scene=${!!result.sceneClassification}, topics=${!!result.topicProfile}`);
          } catch (classifierErr) {
            // Non-fatal: don't fail moderation if classifier storage fails
            console.error(`[MODERATION] Failed to store classifier data for ${sha256}:`, classifierErr.message);
          }
        }

        // Step 7.6: Set quarantine flag in KV if action is QUARANTINE
        if (result.action === 'QUARANTINE') {
          await env.MODERATION_KV.put(`quarantine:${sha256}`, JSON.stringify({
            action: 'QUARANTINE',
            reason: result.reason,
            category: result.category,
            timestamp: new Date().toISOString()
          }), { expirationTtl: 60 * 60 * 24 * 90 });
          console.log(`[MODERATION] Step 7.6: Quarantine flag set for ${sha256}`);
        }

        // Handle based on severity
        console.log(`[MODERATION] Step 8: Handling result (action=${result.action})`);
        await handleModerationResult(result, env);
        console.log(`[MODERATION] Step 9: Result handled`);

        // Acknowledge successful processing
        message.ack();

        console.log(`[MODERATION] ✅ COMPLETED ${sha256} in ${Date.now() - startTime}ms - ${result.action}`);

      } catch (error) {
        console.error(`[MODERATION] Error processing message:`, error);

        // Retry logic
        if (message.attempts < 3) {
          console.log(`[MODERATION] Retrying (attempt ${message.attempts + 1}/3)`);
          message.retry({ delaySeconds: Math.pow(2, message.attempts) * 10 });
        } else {
          console.error(`[MODERATION] Max retries exceeded, logging failure`);

          // Log failed moderation
          await env.MODERATION_KV.put(
            `failed:${message.body.sha256 || 'unknown'}`,
            JSON.stringify({
              error: error.message,
              stack: error.stack,
              message: message.body,
              attempts: message.attempts,
              timestamp: Date.now()
            })
          );

          message.ack(); // Acknowledge to prevent infinite retries
        }
      }
    }
  },

  /**
   * Scheduled handler for cron-triggered relay polling
   * Polls relay.divine.video for new video events and queues them for moderation
   */
  async scheduled(event, env, ctx) {
    if (event.cron === '* * * * *') {
      // Every-minute: creator-delete pipeline (gated by feature flag)
      if (env.CREATOR_DELETE_PIPELINE_ENABLED !== 'true') {
        return;
      }
      const relayUrl = env.CREATOR_DELETE_RELAY_URL || 'wss://relay.divine.video';
      try {
        const result = await runCreatorDeleteCron({
          db: env.BLOSSOM_DB,
          kv: env.MODERATION_KV,
          queryKind5Since: async (sinceSeconds) =>
            fetchKind5EventsSince(sinceSeconds, relayUrl, env),
          fetchTargetEvent: (eid) => fetchNostrEventById(eid, [relayUrl], env),
          callBlossomDelete: (sha256) => notifyBlossom(sha256, 'DELETE', env)
        });
        console.log(`[CREATOR-DELETE-CRON] Processed ${result.processed}, errors: ${result.errors.length}`);
      } catch (e) {
        console.error('[CREATOR-DELETE-CRON] failed:', e);
      }
      return;
    }

    if (event.cron === '*/5 * * * *') {
      console.log(`[RELAY-POLLER] Cron triggered at ${new Date().toISOString()}`);

      if (env.RELAY_POLLING_ENABLED === 'false') {
        console.log('[RELAY-POLLER] Polling is disabled, skipping');
      } else {
        try {
          // Get the timestamp to poll from
          let since = await getLastPollTimestamp(env);

          if (!since) {
            // First run - look back based on config
            const lookbackHours = parseInt(env.RELAY_POLLING_LOOKBACK_HOURS || '1', 10);
            since = Math.floor(Date.now() / 1000) - (lookbackHours * 3600);
            console.log(`[RELAY-POLLER] First run, looking back ${lookbackHours} hours`);
          } else {
            console.log(`[RELAY-POLLER] Continuing from last poll at ${new Date(since * 1000).toISOString()}`);
          }

          // Get relay URL from config
          const relays = env.RELAY_POLLING_RELAY_URL
            ? [env.RELAY_POLLING_RELAY_URL]
            : ['wss://relay.divine.video'];

          // Poll for new video events
          const results = await pollRelayForVideos(env, {
            since,
            limit: parseInt(env.RELAY_POLLING_LIMIT || '100', 10),
            relays
          });

          // Update last poll timestamp
          await setLastPollTimestamp(env, Math.floor(Date.now() / 1000), {
            totalEvents: results.totalEvents,
            queuedForModeration: results.queuedForModeration,
            alreadyModerated: results.alreadyModerated,
            errors: results.errors.length,
            trigger: 'cron'
          });

          console.log(`[RELAY-POLLER] Cron complete: ${results.totalEvents} events found, ${results.queuedForModeration} queued for moderation`);

        } catch (error) {
          console.error('[RELAY-POLLER] Cron poll failed:', error);

          // Store error for debugging
          try {
            await env.MODERATION_KV.put('relay-poller:last-error', JSON.stringify({
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString()
            }));
          } catch (kvError) {
            console.error('[RELAY-POLLER] Failed to store error:', kvError);
          }
        }
      }

      try {
        await processPendingTranscriptReprocess(env);
      } catch (error) {
        console.error('[CRON] Transcript reprocess step failed:', error);
      }

      // Sync DM inbox from relay
      if (env.NOSTR_PRIVATE_KEY) {
        try {
          const { syncInbox } = await import('./nostr/dm-reader.mjs');
          const syncResult = await syncInbox(env);
          console.log(`[CRON] DM inbox sync: ${syncResult.synced} new, ${syncResult.skipped} deduped, ${syncResult.errors} errors`);
        } catch (err) {
          console.error('[CRON] DM inbox sync failed:', err);
        }
      }

      // Poll pending Reality Defender results and auto-escalate confirmed fakes
      if (env.REALITY_DEFENDER_API_KEY && env.MODERATION_KV) {
        try {
          const pendingKeys = await env.MODERATION_KV.list({ prefix: 'rd:', limit: 20 });
          let polled = 0;
          let escalated = 0;
          for (const key of pendingKeys.keys) {
            const cached = await env.MODERATION_KV.get(key.name);
            if (!cached) continue;
            const parsed = JSON.parse(cached);

            const sha256 = key.name.replace('rd:', '');

            // Two cases to handle:
            // 1. pending → poll RD API for results
            // 2. complete + likely_ai but not yet escalated → retry escalation
            let result = null;
            if (parsed.status === 'pending') {
              const { pollRealityDefender } = await import('./moderation/realness-client.mjs');
              result = await pollRealityDefender(sha256, env);
            } else if (parsed.status === 'complete' && parsed.verdict === 'likely_ai' && !parsed.escalated) {
              // Previous escalation attempt failed — retry
              result = parsed;
              console.log(`[CRON] Retrying failed escalation for ${sha256}`);
            } else {
              continue; // complete + escalated, or complete + authentic — nothing to do
            }

            if (result && result.status === 'complete') {
              polled++;
              console.log(`[CRON] Reality Defender result for ${sha256}: ${result.verdict} (score=${result.score})`);

              // Auto-escalate confirmed fakes if content is still quarantined.
              // De-escalation (AUTHENTIC → SAFE) requires moderator action.
              // Human decisions are never overridden.
              if (result.verdict === 'likely_ai') {
                const moderationData = await env.MODERATION_KV.get(`moderation:${sha256}`);
                if (moderationData) {
                  const moderation = JSON.parse(moderationData);
                  if (moderation.action === 'QUARANTINE') {
                    console.log(`[CRON] Auto-escalating ${sha256} from QUARANTINE to PERMANENT_BAN (RD verdict: ${result.verdict})`);

                    // Update KV classification
                    moderation.action = 'PERMANENT_BAN';
                    moderation.reason = `Auto-escalated: Reality Defender confirmed AI-generated (score=${result.score})`;
                    moderation.reviewedAt = new Date().toISOString();
                    moderation.reviewedBy = 'reality-defender-auto';
                    await env.MODERATION_KV.put(
                      `moderation:${sha256}`,
                      JSON.stringify(moderation),
                      { expirationTtl: 60 * 60 * 24 * 90 }
                    );

                    // Update action-specific KV keys
                    await env.MODERATION_KV.delete(`quarantine:${sha256}`);
                    await env.MODERATION_KV.put(`permanent-ban:${sha256}`, JSON.stringify({
                      category: moderation.category || 'ai_generated',
                      reason: moderation.reason,
                      timestamp: Date.now(),
                      autoEscalated: true,
                    }));

                    // Update D1
                    try {
                      await env.BLOSSOM_DB.prepare(`
                        UPDATE moderation_results
                        SET action = ?, review_notes = ?, reviewed_by = ?, reviewed_at = ?
                        WHERE sha256 = ?
                      `).bind(
                        'PERMANENT_BAN',
                        moderation.reason,
                        'reality-defender-auto',
                        new Date().toISOString(),
                        sha256
                      ).run();
                    } catch (dbErr) {
                      console.error(`[CRON] D1 update failed for ${sha256}:`, dbErr.message);
                    }

                    // Notify Blossom (PERMANENT_BAN → Banned)
                    const blossomResult = await notifyBlossom(sha256, 'PERMANENT_BAN', env);
                    if (!blossomResult.success && !blossomResult.skipped) {
                      console.warn(`[CRON] Blossom notification failed for ${sha256}: ${blossomResult.error}`);
                    }

                    // Delete event from relay (critical for externally-hosted content)
                    const relayDeleteResult = await deleteEventFromRelayBySha256(sha256, env, 'rd-auto-escalation');
                    if (relayDeleteResult?.success) {
                      console.log(`[CRON] Deleted relay event ${relayDeleteResult.eventId} for auto-escalated ${sha256}`);
                    }

                    // Send moderation DM to creator
                    const uploadedBy = moderation.uploadedBy;
                    if (uploadedBy && env.NOSTR_PRIVATE_KEY) {
                      try {
                        const { sendModerationDM } = await import('./nostr/dm-sender.mjs');
                        const metaRow = await env.BLOSSOM_DB.prepare(
                          'SELECT title, published_at FROM moderation_results WHERE sha256 = ?'
                        ).bind(sha256).first();
                        await sendModerationDM(uploadedBy, sha256, 'PERMANENT_BAN', moderation.reason, env, null, { title: metaRow?.title, publishedAt: metaRow?.published_at });
                        console.log(`[CRON] DM sent to creator for auto-escalated ${sha256}`);
                      } catch (dmErr) {
                        console.error(`[CRON] DM failed for ${sha256}:`, dmErr.message);
                      }
                    }

                    // Notify reporters
                    const { notifyReporters: notifyCronReporters } = await import('./nostr/dm-sender.mjs');
                    notifyCronReporters(sha256, 'PERMANENT_BAN', env, '[CRON]').catch(() => {});

                    // Mark escalation complete so cron doesn't retry
                    const rdCached = await env.MODERATION_KV.get(`rd:${sha256}`);
                    if (rdCached) {
                      const rdData = JSON.parse(rdCached);
                      rdData.escalated = true;
                      await env.MODERATION_KV.put(`rd:${sha256}`, JSON.stringify(rdData), {
                        expirationTtl: 86400 * 7
                      });
                    }

                    escalated++;
                  } else {
                    // Human already resolved — mark so we don't re-check
                    const rdCached = await env.MODERATION_KV.get(`rd:${sha256}`);
                    if (rdCached) {
                      const rdData = JSON.parse(rdCached);
                      rdData.escalated = true; // nothing to escalate, but stop retrying
                      await env.MODERATION_KV.put(`rd:${sha256}`, JSON.stringify(rdData), {
                        expirationTtl: 86400 * 7
                      });
                    }
                    console.log(`[CRON] Skipping auto-escalation for ${sha256}: no longer quarantined (action=${moderation.action})`);
                  }
                }
              }
            }
          }
          if (polled > 0) {
            console.log(`[CRON] Polled ${polled} Reality Defender results, auto-escalated ${escalated}`);
          }
        } catch (err) {
          console.error('[CRON] Reality Defender polling failed:', err);
        }
      }
    }
  }
};

/**
 * Handle moderation result - publish notifications
 * Action is already stored in D1, this just handles notifications
 */
async function handleModerationResult(result, env) {
  const { sha256, action, scores, reason, flaggedFrames, severity, cdnUrl, uploadedBy } = result;
  const downstreamContext = buildDownstreamPublishContext(result);

  console.log(`[MODERATION] handleModerationResult called for ${sha256} with action ${action}`);

  // Publish Nostr notifications for flagged content
  if (downstreamContext.publishReport) {
    try {
      const reportData = downstreamContext.reportData;
      await publishToFaro(reportData, env);
      console.log(`[MODERATION] ${sha256} - Nostr ${reportData.type} event published to Faro`);

      // Also publish to content relay so it can stop serving flagged events
      try {
        await publishToContentRelay(reportData, env);
        console.log(`[MODERATION] ${sha256} - Nostr ${reportData.type} event published to content relay`);
      } catch (relayError) {
        console.error(`[MODERATION] ${sha256} - Content relay publish failed:`, relayError);
      }
    } catch (error) {
      console.error(`[MODERATION] ${sha256} - Nostr publish failed:`, error);
      // Don't throw - we don't want Nostr failures to fail the whole moderation
    }
  } else {
    console.log(`[MODERATION] ${sha256} approved (no notification needed)`);
  }

  const blossomResult = await notifyBlossom(sha256, action, env);

  if (!blossomResult.success && !blossomResult.skipped) {
    console.warn(`[MODERATION] Blossom notification failed: ${blossomResult.error}`);
  }

  // For PERMANENT_BAN: delete the event from the relay so externally-hosted content
  // is no longer discoverable via funnelcake.
  if (action === 'PERMANENT_BAN') {
    const relayDeleteResult = await deleteEventFromRelayBySha256(sha256, env, 'auto-moderation');
    if (relayDeleteResult?.success) {
      console.log(`[MODERATION] ${sha256} - Relay event ${relayDeleteResult.eventId} deleted`);
    }
  }

  // Send DM to creator for non-SAFE actions (non-blocking)
  // DMs sent for permanent actions only. QUARANTINE is temporary (pending secondary
  // verification) — DM fires when it resolves to PERMANENT_BAN via auto-escalation.
  if (['PERMANENT_BAN', 'AGE_RESTRICTED'].includes(action) && uploadedBy && env.NOSTR_PRIVATE_KEY) {
    try {
      const { sendModerationDM } = await import('./nostr/dm-sender.mjs');
      await sendModerationDM(uploadedBy, sha256, action, reason, env, null, { categories: result.categories, title: result.nostrContext?.title, publishedAt: result.nostrContext?.publishedAt });
      console.log(`[MODERATION] ${sha256} - DM notification sent to creator ${uploadedBy.substring(0, 16)}...`);
    } catch (dmErr) {
      console.error(`[MODERATION] ${sha256} - DM notification failed:`, dmErr.message);
    }
  }

  // Notify reporters who filed reports on this content (non-blocking)
  if (env.NOSTR_PRIVATE_KEY) {
    const { notifyReporters: notifyReportersOfOutcome } = await import('./nostr/dm-sender.mjs');
    notifyReportersOfOutcome(sha256, action, env, '[MODERATION]').catch(() => {});
  }

  // Write normalized moderation labels to ClickHouse
  try {
    const { writeModerationLabels } = await import('./moderation/label-writer.mjs');
    await writeModerationLabels(sha256, downstreamContext.labelResult, env, {
      sourceId: result.provider || 'divine-hive',
      sourceOwner: 'divine',
      sourceType: 'machine-labeler',
      transport: 'moderation-api',
    });
  } catch (err) {
    console.error('[MODERATION] Failed to write moderation labels:', err.message);
  }

  // Notify ATProto labeler service (fire-and-forget)
  notifyAtprotoLabeler({ ...downstreamContext.labelResult, sha256, action, reviewed_by: result.reviewed_by }, env).catch(err => {
    console.error('[MODERATION] ATProto labeler notification failed:', err.message);
  });

  console.log(`[MODERATION] handleModerationResult finished for ${sha256}`);
}

/**
 * Build a 502 response for when Blossom notification fails.
 * Used by /admin/api/moderate, /api/v1/moderate, and /api/v1/quarantine.
 */
function blossomFailureResponse(sha256, action, blossomError) {
  return new Response(JSON.stringify({
    success: false,
    sha256,
    action,
    blossom_notified: false,
    error: `Moderation recorded but media server did not confirm: ${blossomError}`,
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' }
  });
}
