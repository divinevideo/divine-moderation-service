// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Complete moderation pipeline orchestration
// ABOUTME: Coordinates video analysis and classification using pluggable providers

import { classifyText, parseVttText } from './text-classifier.mjs';
import { interpretVideoSealPayload } from './videoseal.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata, isOriginalVine, hasStrongOriginalVineEvidence } from '../nostr/relay-client.mjs';
import { extractTopics } from '../classification/topic-extractor.mjs';
import { verifyC2pa } from './inquisitor-client.mjs';
import { shouldForceAIDetection } from './ai-detection-policy.mjs';

const ARCHIVE_ORIGINAL_VINE_SOURCES = new Set(['archive-export', 'incident-backfill', 'sha-list']);
const C2PA_CACHE_PREFIX = 'c2pa:';
const C2PA_CACHE_TTL = 30 * 86400;

async function getCachedC2paOrVerify({ sha256, videoUrl, env, fetchFn }) {
  if (env.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(`${C2PA_CACHE_PREFIX}${sha256}`);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.warn(`[C2PA] KV read failed for ${sha256}: ${err.message}`);
    }
  }

  const result = await verifyC2pa({ url: videoUrl, mimeType: 'video/mp4' }, env, { fetchFn });

  if (env.MODERATION_KV && result.state !== 'unchecked') {
    try {
      await env.MODERATION_KV.put(`${C2PA_CACHE_PREFIX}${sha256}`, JSON.stringify(result), {
        expirationTtl: C2PA_CACHE_TTL,
      });
    } catch (err) {
      console.warn(`[C2PA] KV write failed for ${sha256}: ${err.message}`);
    }
  }

  return result;
}

function buildManualReviewAIDetectionPolicy({ c2pa, metadata }) {
  return {
    aiDetectionAllowed: false,
    aiDetectionForced: shouldForceAIDetection(metadata),
    aiDetectionRan: false,
    aiDetectionSkipped: true,
    policyReason: 'manual_review_external_ai_disabled',
    c2paState: c2pa?.state || 'unchecked',
  };
}

function buildManualReviewResult({
  sha256,
  uploadedBy,
  uploadedAt,
  metadata,
  videoUrl,
  nostrContext,
  nostrEventId,
  c2pa,
  videoseal,
  textScores,
  topicProfile,
  originalVine,
  originalVineLegacyFallback,
  transcriptPending,
  transcriptRetryAfterSeconds,
}) {
  return {
    action: 'REVIEW',
    severity: 'medium',
    category: 'manual_review',
    reason: 'Team review required before final moderation decision',
    requiresSecondaryVerification: false,
    scores: {},
    provider: 'manual-review',
    processingTime: 0,
    detailedCategories: null,
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    cdnUrl: videoUrl,
    nostrEventId,
    nostrContext,
    policyContext: {
      originalVine,
      originalVineLegacyFallback,
      enforcementOverridden: false,
      overrideReason: null,
      originalAction: 'REVIEW',
    },
    aiDetectionPolicy: buildManualReviewAIDetectionPolicy({ c2pa, metadata }),
    downstreamSignals: {
      hasSignals: false,
      scores: {},
      primaryConcern: null,
      category: null,
      severity: 'low',
      reason: null,
    },
    text_scores: textScores,
    providerRaw: null,
    rawClassifierData: null,
    sceneClassification: null,
    topicProfile,
    c2pa,
    videoseal,
    transcriptPending,
    transcriptRetryAfterSeconds,
  };
}

function parseOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOptionalInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getRetryAfterSeconds(response) {
  if (typeof response?.headers?.get !== 'function') {
    return null;
  }

  const value = response.headers.get('Retry-After');
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildQueueMetadataNostrContext(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const source = parseOptionalString(metadata.source);
  const publishedAt = parseOptionalInteger(metadata.publishedAt ?? metadata.published_at);
  const context = {
    title: parseOptionalString(metadata.title),
    author: parseOptionalString(metadata.author),
    platform: parseOptionalString(metadata.platform),
    client: parseOptionalString(metadata.client),
    loops: parseOptionalInteger(metadata.loops),
    likes: parseOptionalInteger(metadata.likes),
    comments: parseOptionalInteger(metadata.comments),
    url: parseOptionalString(metadata.videoUrl ?? metadata.url),
    sourceUrl: parseOptionalString(metadata.sourceUrl ?? metadata.source_url ?? metadata.r),
    publishedAt: ARCHIVE_ORIGINAL_VINE_SOURCES.has(source) ? publishedAt : null,
    archivedAt: parseOptionalString(metadata.archivedAt ?? metadata.archived_at),
    importedAt: parseOptionalInteger(metadata.importedAt ?? metadata.imported_at),
    vineHashId: parseOptionalString(metadata.vineHashId ?? metadata.vine_hash_id ?? metadata.vine_id),
    vineUserId: parseOptionalString(metadata.vineUserId ?? metadata.vine_user_id),
    content: parseOptionalString(metadata.content),
    eventId: parseOptionalString(metadata.eventId ?? metadata.event_id),
    createdAt: parseOptionalInteger(metadata.createdAt ?? metadata.created_at)
  };

  if (
    context.platform === 'vine'
    || (context.client && /vine-(archive-importer|archaeologist)/.test(context.client))
    || context.vineHashId
    || (context.sourceUrl && context.sourceUrl.includes('vine.co'))
  ) {
    context.publishedAt = publishedAt;
  }

  return Object.values(context).some((value) => value !== null) ? context : null;
}

/**
 * Run classify-only pipeline on a video that already has moderation results.
 * Skips Hive VLM and only runs local VTT topic extraction.
 *
 * @param {string} sha256 - Video hash
 * @param {Object} env - Environment variables
 * @param {Object} [options] - Options
 * @param {string} [options.videoUrl] - Explicit video URL (skips Nostr/CDN resolution)
 * @param {Function} [options.fetchFn] - Fetch function (for testing)
 * @returns {Promise<Object>} { sceneClassification, topicProfile, sha256 }
 */
export async function classifyVideoOnly(sha256, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  if (!options.videoUrl && !env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured and no videoUrl provided');
  }

  // Resolve video URL — use explicit URL, or try Nostr metadata, fall back to CDN
  let videoUrl = options.videoUrl || `https://${env.CDN_DOMAIN}/${sha256}`;
  if (!options.videoUrl) {
    try {
      const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
      const event = await fetchNostrEventBySha256(sha256, relays);
      if (event) {
        const nostrContext = parseVideoEventMetadata(event);
        if (nostrContext.url) {
          videoUrl = nostrContext.url;
          console.log(`[CLASSIFY-ONLY] Using video URL from Nostr event for ${sha256}: ${videoUrl}`);
        }
      }
    } catch (error) {
      console.log(`[CLASSIFY-ONLY] Nostr lookup failed for ${sha256}, using CDN fallback: ${error.message}`);
    }
  } else {
    console.log(`[CLASSIFY-ONLY] Using provided video URL for ${sha256}: ${videoUrl}`);
  }

  console.log(`[CLASSIFY-ONLY] Skipping Hive VLM scene classification for ${sha256}; using local transcript topics only`);

  let topicProfile = null;
  try {
    const vttUrl = `https://media.divine.video/${sha256}.vtt`;
    const vttResponse = await fetchFn(vttUrl);
    if (vttResponse.status === 202) {
      const retryAfterSeconds = getRetryAfterSeconds(vttResponse);
      console.log(`[CLASSIFY-ONLY] VTT transcript for ${sha256} is still pending${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ''}`);
    } else if (vttResponse.status === 404) {
      console.log(`[CLASSIFY-ONLY] No VTT transcript for ${sha256} (404)`);
    } else if (!vttResponse.ok) {
      console.warn(`[CLASSIFY-ONLY] VTT fetch returned ${vttResponse.status} for ${sha256}`);
    } else {
      const vttContent = await vttResponse.text();
      const plainText = parseVttText(vttContent);
      if (plainText.trim().length > 0) {
        topicProfile = extractTopics(plainText);
        console.log(`[CLASSIFY-ONLY] Topic extraction for ${sha256}: primary_topic=${topicProfile.primary_topic}, ${topicProfile.topics.length} topics`);
      } else {
        console.log(`[CLASSIFY-ONLY] VTT transcript for ${sha256} contains no extractable text`);
      }
    }
  } catch (error) {
    console.error(`[CLASSIFY-ONLY] VTT/topic extraction failed for ${sha256}: ${error.message}`);
  }

  return { sha256, sceneClassification: null, topicProfile };
}

/**
 * Run full moderation pipeline on a video
 * @param {Object} videoData - Video information from queue message
 * @param {string} videoData.sha256 - Video hash
 * @param {string} [videoData.uploadedBy] - Uploader's nostr pubkey
 * @param {number} videoData.uploadedAt - Upload timestamp
 * @param {Object} [videoData.metadata] - Additional metadata
 * @param {Object} env - Environment variables
 * @param {Function} [fetchFn] - Fetch function (for testing)
 * @returns {Promise<Object>} Complete moderation result with classification
 */
export async function moderateVideo(videoData, env, fetchFn = fetch) {
  const {
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    videoSealPayload = null,
    videoSealBitAccuracy = null
  } = videoData;

  // Validate configuration
  if (!env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured');
  }

  // Step 1: Determine video URL - prefer metadata.videoUrl if provided (e.g., from relay-poller)
  const queueNostrContext = buildQueueMetadataNostrContext(metadata);
  let nostrContext = queueNostrContext;
  let videoUrl = metadata?.videoUrl || queueNostrContext?.url || `https://${env.CDN_DOMAIN}/${sha256}`; // Default: blossom content-addressed URL
  let nostrEventId = queueNostrContext?.eventId || metadata?.eventId || metadata?.event_id || null;

  // Always attempt to resolve Nostr context so policy decisions can use archive metadata
  try {
    const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay.divine.video'];
    const event = await fetchNostrEventBySha256(sha256, relays);
    if (event) {
      const relayNostrContext = parseVideoEventMetadata(event);
      nostrContext = queueNostrContext
        ? { ...queueNostrContext, ...relayNostrContext }
        : relayNostrContext;
      nostrEventId = event.id;
      console.log(`[MODERATION] Found Nostr context for ${sha256}:`, nostrContext);

      // Prefer explicit metadata.videoUrl when provided, otherwise trust the relay URL
      if (!metadata?.videoUrl && nostrContext.url) {
        videoUrl = nostrContext.url;
        console.log(`[MODERATION] Using video URL from Nostr event: ${videoUrl}`);
      }
    } else {
      console.log(`[MODERATION] No Nostr event found for ${sha256}, using fallback URL: ${videoUrl}`);
    }
  } catch (error) {
    console.error(`[MODERATION] Failed to fetch Nostr context for ${sha256}:`, error);
    console.log(`[MODERATION] Using fallback URL: ${videoUrl}`);
    // Don't fail moderation if Nostr fetch fails
  }

  if (metadata?.videoUrl) {
    console.log(`[MODERATION] Using video URL from metadata: ${videoUrl}`);
  } else {
    console.log(`[MODERATION] Using resolved video URL: ${videoUrl}`);
  }

  // Step 2: Check if this is an original Vine (skip AI detection for pre-2018 content)
  const originalVineSkipsAIDetection = isOriginalVine(nostrContext);
  const shouldForceServeable = hasStrongOriginalVineEvidence(nostrContext);
  if (originalVineSkipsAIDetection) {
    console.log(`[MODERATION] Original Vine detected for ${sha256}; preserving context for team review`);
  }

  // Step 2.5: Call divine-inquisitor for human review context only. Do not
  // short-circuit to external moderation; every upload now goes to team review.
  const c2pa = await getCachedC2paOrVerify({ sha256, videoUrl, env, fetchFn });
  console.log(`[MODERATION] ${sha256} - C2PA state: ${c2pa.state}${c2pa.claimGenerator ? ` (claim=${c2pa.claimGenerator})` : ''}`);
  const videoseal = interpretVideoSealPayload(videoSealPayload, videoSealBitAccuracy);

  // Step 3: Fetch VTT transcript and analyze text content + extract topics.
  let textScores = null;
  let topicProfile = null;
  let transcriptPending = false;
  let transcriptRetryAfterSeconds = null;
  try {
    const vttUrl = `https://media.divine.video/${sha256}.vtt`;
    console.log(`[MODERATION] Fetching VTT transcript: ${vttUrl}`);
    const vttResponse = await fetchFn(vttUrl);
    if (vttResponse.status === 202) {
      const retryAfterSeconds = getRetryAfterSeconds(vttResponse);
      transcriptPending = true;
      transcriptRetryAfterSeconds = retryAfterSeconds;
      console.log(`[MODERATION] VTT transcript for ${sha256} is still pending${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ''} - skipping text analysis`);
    } else if (vttResponse.status === 404) {
      console.log(`[MODERATION] No VTT transcript found for ${sha256} (404) - skipping text analysis`);
    } else if (!vttResponse.ok) {
      console.warn(`[MODERATION] VTT fetch returned ${vttResponse.status} for ${sha256} - skipping text analysis`);
    } else {
      const vttContent = await vttResponse.text();
      const plainText = parseVttText(vttContent);
      if (plainText.trim().length > 0) {
        textScores = classifyText(plainText);
        console.log(`[MODERATION] Text analysis scores for ${sha256}:`, textScores);

        // Extract topics from the same VTT text (local computation, fast)
        try {
          topicProfile = extractTopics(plainText);
          console.log(`[MODERATION] Topic extraction for ${sha256}: primary_topic=${topicProfile.primary_topic}, ${topicProfile.topics.length} topics, has_speech=${topicProfile.has_speech}`);
        } catch (topicError) {
          console.error(`[MODERATION] Topic extraction failed for ${sha256} (non-fatal):`, topicError.message);
        }
      } else {
        console.log(`[MODERATION] VTT transcript for ${sha256} contains no extractable text`);
      }
    }
  } catch (error) {
    console.error(`[MODERATION] Failed to fetch/analyze VTT for ${sha256}:`, error);
    // Don't fail moderation if VTT analysis fails
  }

  console.log(`[MODERATION] ${sha256} - defaulting to playable team review; external Hive moderation/classification skipped`);
  return buildManualReviewResult({
    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    videoUrl,
    nostrEventId,
    nostrContext,
    c2pa,
    videoseal,
    textScores,
    topicProfile,
    originalVine: shouldForceServeable,
    originalVineLegacyFallback: originalVineSkipsAIDetection && !shouldForceServeable,
    transcriptPending,
    transcriptRetryAfterSeconds
  });
}
