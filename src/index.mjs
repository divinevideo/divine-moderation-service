// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Main entry point for Divine video moderation worker
// ABOUTME: Consumes queue messages and processes videos for harmful content

import { validateQueueMessage } from './schemas/queue-message.mjs';
import { moderateVideo, classifyVideoOnly } from './moderation/pipeline.mjs';
import { publishToFaro, publishToContentRelay, publishLabelEvent } from './nostr/publisher.mjs';
import { requireAuth, getAuthenticatedUser } from './admin/auth.mjs';
import { verifyZeroTrustJWT } from './admin/zerotrust.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata } from './nostr/relay-client.mjs';
import { pollRelayForVideos, getLastPollTimestamp, setLastPollTimestamp, getPollingStatus } from './nostr/relay-poller.mjs';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import dashboardHTML from './admin/dashboard.html';
import swipeReviewHTML from './admin/swipe-review.html';
import { initReportsTable, addReport } from './reports.mjs';
import { initOffenderTable, updateUploaderStats, getUploaderStats } from './offender-tracker.mjs';
import { formatForStorage, formatForGorse, formatForFunnelcake } from './classification/pipeline.mjs';
import { topicsToLabels, topicsToWeightedFeatures } from './classification/topic-extractor.mjs';
import { getKVThresholds, setKVThresholds, DEFAULT_THRESHOLDS } from './moderation/classifier.mjs';
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
const JSON_HEADERS = { 'Content-Type': 'application/json' };
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

function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

function isApiSurfacePath(pathname) {
  return pathname === '/'
    || pathname === '/health'
    || pathname === '/test-moderate'
    || pathname === '/test-kv'
    || pathname.startsWith('/check-result/')
    || pathname.startsWith('/api/v1/');
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

function getConfiguredBearerTokens(env) {
  return [env.SERVICE_API_TOKEN, env.API_BEARER_TOKEN, env.MODERATION_API_KEY]
    .filter((value, index, all) => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);
}

function hostMismatchResponse(requestId, hostname, pathname, expectedHost) {
  console.log(`[${requestId}] Rejected ${pathname} on ${hostname}; expected ${expectedHost}`);
  return jsonError(`Not found on ${hostname}. Use https://${expectedHost}${pathname}`, 404);
}

async function authenticateApiRequest(request, env) {
  if (env.ALLOW_DEV_ACCESS === 'true') {
    return { valid: true, email: 'dev@localhost', isServiceToken: false };
  }

  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const configuredTokens = getConfiguredBearerTokens(env);
  if (bearerToken && configuredTokens.includes(bearerToken)) {
    return { valid: true, email: 'service@internal', isServiceToken: true };
  }

  const jwtToken = request.headers.get('cf-access-jwt-assertion');
  if (jwtToken) {
    try {
      return await verifyZeroTrustJWT(jwtToken, env);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  if (configuredTokens.length === 0) {
    return { valid: false, error: 'No bearer token configured (SERVICE_API_TOKEN/API_BEARER_TOKEN/MODERATION_API_KEY)' };
  }

  return { valid: false, error: 'Missing bearer token or Cloudflare Access JWT' };
}

function apiUnauthorizedResponse(verification) {
  return jsonError(`Unauthorized - ${verification.error}`, 401);
}

function authSourceFromVerification(verification) {
  return verification.email
    ? `user:${verification.email}`
    : `service-token:${verification.payload?.sub || 'unknown'}`;
}

function verifyLegacyBearerAuth(request, env) {
  const configuredTokens = getConfiguredBearerTokens(env);
  if (configuredTokens.length === 0) {
    console.error('[AUTH] No legacy bearer token configured');
    return jsonResponse(500, { error: 'Server misconfigured — no auth token set' });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization: Bearer <token>' });
  }

  const token = authHeader.slice(7);
  if (!configuredTokens.includes(token)) {
    return jsonResponse(403, { error: 'Invalid token' });
  }

  return null;
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
  async fetch(request, env) {
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

    // Ensure offender tracking table exists (idempotent)
    await initOffenderTable(env.BLOSSOM_DB);

    // Ensure reports table exists
    await initReportsTable(env.BLOSSOM_DB);

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
      let whereClause = '';
      const params = [];

      if (actionFilter === 'FLAGGED') {
        whereClause = "WHERE action IN ('REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL";
      } else if (actionFilter === 'QUARANTINE') {
        whereClause = "WHERE action IN ('AGE_RESTRICTED', 'PERMANENT_BAN') AND reviewed_by IS NULL";
      } else if (actionFilter !== 'all') {
        whereClause = 'WHERE action = ?';
        params.push(actionFilter.toUpperCase());
      }

      // Query D1 with pagination
      const query = `
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
        FROM moderation_results
        ${whereClause}
        ORDER BY moderated_at DESC
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
        reviewed_at: row.reviewed_at
      }));

      // Classifier summaries fetched client-side via /admin/api/classifier/{sha256}
      const videos = videoRows;

      console.log(`[${requestId}] Returning ${videos.length} videos in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify({
        videos,
        offset,
        limit,
        hasMore,
        nextOffset: hasMore ? offset + limit : null
      }), {
        headers: { 'Content-Type': 'application/json' }
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
        const [totalResult, moderationStats] = await Promise.all([
          // Total videos (excluding deleted/error)
          env.BLOSSOM_DB.prepare(`
            SELECT COUNT(DISTINCT sha256) as total
            FROM bunny_webhook_events
            WHERE sha256 IS NOT NULL
              AND status_name NOT IN ('error', 'deleted')
          `).first(),
          // Moderation breakdown by action
          env.BLOSSOM_DB.prepare(`
            SELECT
              action,
              COUNT(*) as count
            FROM moderation_results
            GROUP BY action
          `).all()
        ]);

        const totalInD1 = totalResult?.total || 0;

        // Parse moderation stats
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

        const untriaged = Math.max(0, totalInD1 - totalModerated);

        console.log(`[${requestId}] Stats: total=${totalInD1}, moderated=${totalModerated}, untriaged=${untriaged}, safe=${safeCount}, review=${reviewCount} in ${Date.now() - startTime}ms`);
        return new Response(JSON.stringify({
          totalInD1,
          totalModerated,
          untriaged,
          breakdown: {
            safe: safeCount,
            review: reviewCount,
            ageRestricted: ageRestrictedCount,
            permanentBan: permanentBanCount
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error(`[${requestId}] Failed to get stats:`, error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
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
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('[ADMIN] Failed to fetch untriaged videos:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Queue an untriaged video for moderation
    if (url.pathname === '/admin/api/queue-moderation' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const { sha256 } = await request.json();
      if (!sha256) {
        return new Response(JSON.stringify({ error: 'sha256 required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Queue for moderation
      await env.MODERATION_QUEUE.send({
        sha256,
        r2Key: `videos/${sha256}.mp4`,
        uploadedAt: Date.now(),
        metadata: { source: 'admin-dashboard' }
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
      const { action, reason, scores } = await request.json();

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
      } else {
        // Fall back to KV for legacy data
        const kvData = await env.MODERATION_KV.get(`moderation:${sha256}`);
        if (kvData) {
          existing = JSON.parse(kvData);
        }
      }

      if (!existing) {
        return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const previousAction = existing.action;

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
        UPDATE moderation_results
        SET action = ?, review_notes = ?, reviewed_by = ?, reviewed_at = ?
        WHERE sha256 = ?
      `).bind(
        action,
        reason || 'Manual override by moderator',
        'admin',
        new Date().toISOString(),
        sha256
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
      // Relay notification intentionally removed: notifyRelay() called /api/admin/purge
      // which never existed in divine-relay-manager. There's no relay-manager endpoint
      // that accepts a sha256 and propagates enforcement to Funnelcake (the missing link
      // is sha256-to-event-ID lookup). Osprey's rules pipeline will handle relay-side
      // enforcement when operational, since it sees events in Kafka and can correlate
      // media hashes to event IDs natively.
      const blossomResult = await notifyBlossom(sha256, action, env);

      if (!blossomResult.success && !blossomResult.skipped) {
        console.warn(`[ADMIN] Blossom notification failed: ${blossomResult.error}`);
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

      console.log(`[ADMIN] Updated ${sha256} from ${previousAction} to ${action} (blossom: ${blossomResult.success})`);

      return new Response(JSON.stringify({
        success: true,
        sha256,
        action,
        previousAction,
        message: `Content updated to ${action}`,
        blossom_notified: blossomResult.success || false,
        report_published: reportPublished
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

    // Get Nostr event context for a video
    if (url.pathname.startsWith('/admin/api/nostr-context/')) {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[4];

      try {
        const event = await fetchNostrEventBySha256(sha256, ['wss://relay.divine.video'], env);

        if (!event) {
          return new Response(JSON.stringify({ found: false }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const metadata = parseVideoEventMetadata(event);

        return new Response(JSON.stringify({ found: true, metadata }), {
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

      if (!env.NOSTR_PRIVATE_KEY) {
        return new Response(JSON.stringify({ error: 'NOSTR_PRIVATE_KEY not configured' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
      const pubkey = bytesToHex(getPublicKey(hexToBytes(env.NOSTR_PRIVATE_KEY)));
      return new Response(JSON.stringify({ pubkey, note: 'Add this to ADMIN_PUBKEYS on the funnelcake relay' }), {
        headers: { 'Content-Type': 'application/json' }
      });
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

      const sha256 = url.pathname.split('/')[3].replace('.mp4', '');
      const cdnUrl = `https://${env.CDN_DOMAIN}/${sha256}`;
      const adminBypassUrl = `https://${env.CDN_DOMAIN}/admin/api/blob/${sha256}/content`;

      try {
        // CDN fetch (unauthenticated) — works for SAFE/unmoderated content
        const cdnResponse = await fetch(cdnUrl);
        if (cdnResponse.ok) {
          console.log(`[ADMIN] Serving video from CDN: ${sha256}`);
          return new Response(cdnResponse.body, {
            headers: {
              'Content-Type': cdnResponse.headers.get('Content-Type') || 'video/mp4',
              'Cache-Control': 'private, no-store',
              'X-Admin-Proxy': 'cdn'
            }
          });
        }

        // CDN returned non-200 (banned/restricted content returns 404)
        // Fall back to admin bypass endpoint which serves regardless of moderation status
        if (env.BLOSSOM_WEBHOOK_SECRET) {
          console.log(`[ADMIN] CDN returned ${cdnResponse.status}, trying admin bypass for ${sha256}`);
          const bypassResponse = await fetch(adminBypassUrl, {
            headers: { 'Authorization': `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}` }
          });
          if (bypassResponse.ok) {
            console.log(`[ADMIN] Serving video from admin bypass: ${sha256}`);
            const moderationStatus = bypassResponse.headers.get('X-Moderation-Status');
            return new Response(bypassResponse.body, {
              headers: {
                'Content-Type': bypassResponse.headers.get('Content-Type') || 'video/mp4',
                'Cache-Control': 'private, no-store',
                'X-Admin-Proxy': 'blossom-admin',
                ...(moderationStatus && { 'X-Moderation-Status': moderationStatus })
              }
            });
          }
          console.error(`[ADMIN] Admin bypass returned ${bypassResponse.status} for ${sha256}`);
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
        // This is fire-and-forget - we don't fail the request if blossom notification fails
        const blossomResult = await notifyBlossom(sha256, action.toUpperCase(), env);
        if (!blossomResult.success && !blossomResult.skipped) {
          console.warn(`[API] Blossom notification failed but moderation was recorded: ${blossomResult.error}`);
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
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
        FROM moderation_results
        WHERE sha256 = ?
      `).bind(sha256).first();

      if (!d1Result) {
        return new Response(JSON.stringify({
          sha256,
          status: 'unknown',
          moderated: false,
          blocked: false,
          age_restricted: false
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Simplified response for external tools
      const action = d1Result.action;
      return new Response(JSON.stringify({
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
        moderated_at: d1Result.moderated_at,
        reviewed_by: d1Result.reviewed_by,
        reviewed_at: d1Result.reviewed_at
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
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

        let query = 'SELECT sha256, action, provider, scores, moderated_at, reviewed_by, reviewed_at FROM moderation_results';
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

          // Collect labels from all three classification layers
          const allLabels = [];
          const allFeatures = {};

          // Layer 1: VLM scene classification labels (topics, setting, objects, activities, mood)
          if (parsed.sceneClassification) {
            const sceneLabels = formatForGorse(parsed.sceneClassification);
            allLabels.push(...sceneLabels);
            const sceneFeatures = formatForFunnelcake(parsed.sceneClassification);
            Object.assign(allFeatures, sceneFeatures);
          }

          // Layer 2: VTT topic labels
          if (parsed.topicProfile) {
            const topicLabels = topicsToLabels(parsed.topicProfile);
            allLabels.push(...topicLabels);
            const topicFeatures = topicsToWeightedFeatures(parsed.topicProfile);
            Object.assign(allFeatures, topicFeatures);
          }

          // Layer 3: Raw moderation scores as features (for safety signals)
          if (parsed.rawClassifierData) {
            // Extract top-level moderation scores for safety signals
            const rawData = parsed.rawClassifierData;
            if (rawData.maxScores) {
              for (const [key, value] of Object.entries(rawData.maxScores)) {
                if (typeof value === 'number') {
                  allFeatures[key] = value;
                }
              }
            }
          }

          // Determine safety from moderation result
          const moderationResult = await env.BLOSSOM_DB.prepare(
            'SELECT action FROM moderation_results WHERE sha256 = ?'
          ).bind(sha256).first();

          const action = moderationResult?.action || 'UNKNOWN';
          const isSafe = action === 'SAFE';

          return new Response(JSON.stringify({
            sha256,
            gorse: {
              labels: [...new Set(allLabels)],  // deduplicate
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

    return new Response('Divine Moderation API\n\nPublic endpoints:\nGET  /health\nGET  /check-result/{sha256}\n\nAuthenticated endpoints:\nPOST /test-moderate {"sha256":"..."}\nGET  /api/v1/decisions\nGET  /api/v1/decisions/{sha256}\nPOST /api/v1/quarantine/{sha256}\nPOST /api/v1/moderate\nPOST /api/v1/report\nPOST /api/v1/classify\nGET  /api/v1/classifier/{sha256}\nGET  /api/v1/classifier/{sha256}/recommendations\n\nAdmin UI: https://moderation.admin.divine.video/admin', {
      headers: { 'Content-Type': 'text/plain' }
    });
  },

  /**
   * Queue consumer for video moderation
   * Triggered when messages are sent to the video-moderation-queue
   */
  async queue(batch, env) {
    console.log(`[MODERATION] Processing batch of ${batch.messages.length} videos`);

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

        const { sha256, uploadedBy, uploadedAt, metadata } = validation.data;
        console.log(`[MODERATION] Step 2: Message validated for ${sha256}`);

        // Check if already moderated (duplicate prevention) - use D1
        console.log(`[MODERATION] Step 3: Checking for existing moderation result`);
        const existingResult = await env.BLOSSOM_DB.prepare(
          'SELECT sha256, action, moderated_at FROM moderation_results WHERE sha256 = ?'
        ).bind(sha256).first();

        if (existingResult) {
          console.log(`[MODERATION] ⚠️ SKIPPED ${sha256} - already moderated`);
          console.log(`[MODERATION] Previous result: action=${existingResult.action}, moderated_at=${existingResult.moderated_at}`);
          message.ack();
          continue;
        }

        console.log(`[MODERATION] Step 4: No existing result found, starting analysis for ${sha256}`);
        console.log(`[MODERATION] Blossom blob URL: https://${env.CDN_DOMAIN}/blobs/${sha256}`);

        // Run moderation pipeline
        const result = await moderateVideo({
          sha256,
          uploadedBy,
          uploadedAt,
          metadata
        }, env);

        console.log(`[MODERATION] Step 5: Analysis complete for ${sha256}`);
        console.log(`[MODERATION] Result: action=${result.action}, severity=${result.severity}`);
        console.log(`[MODERATION] Scores: nudity=${result.scores.nudity}, violence=${result.scores.violence}, ai=${result.scores.ai_generated}`);

        console.log(`[MODERATION] Step 6: Storing result in D1`);
        // Store result in D1
        await env.BLOSSOM_DB.prepare(`
          INSERT OR REPLACE INTO moderation_results
          (sha256, action, provider, scores, categories, raw_response, moderated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          sha256,
          result.action,
          result.provider || 'unknown',
          JSON.stringify(result.scores || {}),
          JSON.stringify(result.categories || []),
          JSON.stringify(result.rawResponse || {}),
          new Date().toISOString()
        ).run();
        console.log(`[MODERATION] Step 7: D1 write successful`);

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
    console.log(`[RELAY-POLLER] Cron triggered at ${new Date().toISOString()}`);

    // Check if polling is enabled
    if (env.RELAY_POLLING_ENABLED === 'false') {
      console.log('[RELAY-POLLER] Polling is disabled, skipping');
      return;
    }

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
};

/**
 * Handle moderation result - publish notifications
 * Action is already stored in D1, this just handles notifications
 */
async function handleModerationResult(result, env) {
  const { sha256, action, scores, reason, flaggedFrames, severity, cdnUrl } = result;

  console.log(`[MODERATION] handleModerationResult called for ${sha256} with action ${action}`);

  // Publish Nostr notifications for flagged content
  if (action !== 'SAFE') {
    try {
      const reportData = {
        type: action.toLowerCase().replace('_', '-'),
        sha256,
        cdnUrl,
        category: result.category,
        scores,
        reason,
        severity,
        frames: flaggedFrames
      };
      await publishToFaro(reportData, env);
      console.log(`[MODERATION] ${sha256} - Nostr ${action} event published to Faro`);

      // Also publish to content relay so it can stop serving flagged events
      try {
        await publishToContentRelay(reportData, env);
        console.log(`[MODERATION] ${sha256} - Nostr ${action} event published to content relay`);
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

  // Notify Blossom (relay notification removed — see comment in admin moderate handler)
  const blossomResult = await notifyBlossom(sha256, action, env);

  if (!blossomResult.success && !blossomResult.skipped) {
    console.warn(`[MODERATION] Blossom notification failed: ${blossomResult.error}`);
  }

  console.log(`[MODERATION] handleModerationResult finished for ${sha256}`);
}

/**
 * Notify divine-blossom of moderation decision via webhook
 * This allows blossom to update blob status and enforce blocking
 * @param {string} sha256 - The blob hash
 * @param {string} action - The moderation action (SAFE, REVIEW, AGE_RESTRICTED, PERMANENT_BAN)
 * @param {Object} env - Environment with BLOSSOM_WEBHOOK_URL and BLOSSOM_WEBHOOK_SECRET
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function notifyBlossom(sha256, action, env) {
  // Skip if webhook not configured
  if (!env.BLOSSOM_WEBHOOK_URL) {
    console.log('[BLOSSOM] Webhook not configured, skipping notification');
    return { success: true, skipped: true };
  }

  // Only forward actions that Blossom understands. Blossom has four states
  // (Active/Restricted/Pending/Banned) and returns 400 for unrecognized actions.
  // REVIEW and QUARANTINE are internal classification tiers; content in those
  // states stays publicly accessible (equivalent to Blossom's Pending).
  const blossomActions = ['SAFE', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
  if (!blossomActions.includes(action)) {
    console.log(`[BLOSSOM] Skipping notification for internal action: ${action}`);
    return { success: true, skipped: true };
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
    };

    // Add authentication if secret is configured
    if (env.BLOSSOM_WEBHOOK_SECRET) {
      headers['Authorization'] = `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`;
    }

    console.log(`[BLOSSOM] Notifying blossom of ${action} for ${sha256}`);

    const response = await fetch(env.BLOSSOM_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sha256,
        action,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BLOSSOM] Webhook failed: ${response.status} - ${errorText}`);
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();
    console.log(`[BLOSSOM] Webhook succeeded for ${sha256}:`, result);
    return { success: true, result };

  } catch (error) {
    console.error(`[BLOSSOM] Webhook error for ${sha256}:`, error);
    return { success: false, error: error.message };
  }
}
