// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Main entry point for Divine video moderation worker
// ABOUTME: Consumes queue messages and processes videos for harmful content

import { validateQueueMessage } from './schemas/queue-message.mjs';
import { moderateVideo } from './moderation/pipeline.mjs';
import { publishToFaro, publishLabelEvent } from './nostr/publisher.mjs';
import { requireAuth, getAuthenticatedUser } from './admin/auth.mjs';
import { verifyZeroTrustJWT } from './admin/zerotrust.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata } from './nostr/relay-client.mjs';
import dashboardHTML from './admin/dashboard.html';
import swipeReviewHTML from './admin/swipe-review.html';
import { Relay } from 'nostr-tools/relay';

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

export default {
  /**
   * HTTP handler for testing and admin dashboard
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const startTime = Date.now();
    const requestId = crypto.randomUUID().substring(0, 8);

    // Log all incoming requests
    console.log(`[${requestId}] ${request.method} ${url.pathname}${url.search ? '?' + url.search.substring(0, 100) : ''}`);

    // Admin dashboard routes
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      console.log(`[${requestId}] Redirecting to dashboard`);
      return Response.redirect(`${url.origin}/admin/dashboard`, 302);
    }

    // Debug: verify relay config and connectivity; optional test publish
    if (url.pathname === '/admin/api/debug-relay') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const relayUrl = env.NOSTR_RELAY_URL || env.FARO_RELAY_URL || null;
      const hasPrivateKey = !!env.NOSTR_PRIVATE_KEY;
      const hasModeratorKey = !!env.MODERATOR_NSEC;
      const useAccessHeaders = !!(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET);

      let connectOk = false;
      let connectError = null;
      if (relayUrl) {
        try {
          const relayOptions = {};
          if (useAccessHeaders) {
            relayOptions.headers = {
              'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
              'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
            };
          }
          const relay = await Relay.connect(relayUrl, relayOptions);
          try {
            connectOk = true;
          } finally {
            relay.close();
          }
        } catch (e) {
          connectError = e?.message || String(e);
        }
      }

      // Optionally publish a test moderation event (requires sha256)
      let testPublish = null;
      const publishTest = url.searchParams.get('publishTest') === '1' || url.searchParams.get('publishTest') === 'true';
      const testSha = url.searchParams.get('sha256');
      if (publishTest && testSha) {
        try {
          await publishToFaro({
            type: 'review',
            sha256: testSha,
            scores: { nudity: 0.01, violence: 0.01 },
            reason: 'debug-relay-ping'
          }, env);
          testPublish = { published: true };
        } catch (e) {
          testPublish = { published: false, error: e?.message || String(e) };
        }
      }

      return new Response(JSON.stringify({
        hasPrivateKey,
        hasModeratorKey,
        relayUrl,
        useAccessHeaders,
        connectOk,
        connectError,
        testPublish
      }), { headers: { 'Content-Type': 'application/json' } });
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

    // Report page for a specific video - /reports/{sha256}
    if (url.pathname.startsWith('/reports/')) {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const sha256 = url.pathname.split('/')[2];
      if (!sha256 || sha256.length !== 64) {
        return new Response('Invalid SHA256', { status: 400 });
      }

      // Fetch video data from D1
      const d1Result = await env.BLOSSOM_DB.prepare(`
        SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at, review_notes
        FROM moderation_results
        WHERE sha256 = ?
      `).bind(sha256).first();

      // Fetch Nostr context
      let nostrContext = null;
      try {
        const event = await fetchNostrEventBySha256(sha256, ['wss://relay.divine.video'], env);
        if (event) {
          nostrContext = parseVideoEventMetadata(event);
          nostrContext.pubkey = event.pubkey || null;
        }
      } catch (e) {
        console.error(`[REPORTS] Failed to fetch Nostr context for ${sha256}:`, e.message);
      }

      // Fetch relay publish status
      let relayPublishStatus = null;
      try {
        const relayData = await env.MODERATION_KV.get(`relay-publish:${sha256}`);
        if (relayData) {
          relayPublishStatus = JSON.parse(relayData);
        }
      } catch (e) {
        console.error(`[REPORTS] Failed to fetch relay publish status for ${sha256}:`, e.message);
      }

      // Build report page HTML
      const reportHTML = buildReportPageHTML(sha256, d1Result, nostrContext, relayPublishStatus, env);

      return new Response(reportHTML, {
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
        whereClause = "WHERE action IN ('REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN')";
      } else if (actionFilter === 'QUARANTINE') {
        whereClause = "WHERE action IN ('AGE_RESTRICTED', 'PERMANENT_BAN')";
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
      const videos = rows.slice(0, limit).map(row => ({
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
                pubkey: event.pubkey || null,
                eventId: event.id || null
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
            cdnUrl: `https://${env.CDN_DOMAIN}/${row.sha256}.mp4`,
            nostrContext: {
              title: nostr.title,
              author: nostr.author,
              client: nostr.client,
              content: nostr.content,
              pubkey: nostr.pubkey || null,
              eventId: nostr.eventId || null
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
      if (!['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action)) {
        return new Response(JSON.stringify({ error: 'Invalid action. Must be SAFE, REVIEW, AGE_RESTRICTED, or PERMANENT_BAN' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get existing moderation result
      let existing;
      let existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
      if (existingData) {
        existing = JSON.parse(existingData);
      } else {
        // Fallback to D1 if KV is missing (post-migration path)
        const d1Row = await env.BLOSSOM_DB.prepare(`
          SELECT sha256, action, provider, scores, categories, moderated_at
          FROM moderation_results
          WHERE sha256 = ?
        `).bind(sha256).first();

        if (!d1Row) {
          return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        existing = {
          sha256: d1Row.sha256,
          action: d1Row.action,
          scores: d1Row.scores ? JSON.parse(d1Row.scores) : {},
          categories: d1Row.categories ? JSON.parse(d1Row.categories) : [],
          moderatedAt: d1Row.moderated_at
        };
        existingData = JSON.stringify(existing);
      }

      // Update moderation result
      const updated = {
        ...existing,
        action,
        reason: reason || `Manual override by moderator`,
        manualOverride: true,
        overriddenBy: 'admin',
        overriddenAt: Date.now(),
        previousAction: existing.action
      };

      // If scores provided, override them
      if (scores) {
        updated.scores = {
          ...existing.scores,
          ...scores
        };
        console.log(`[ADMIN] Score override applied for ${sha256}`);
      }

      // Write updated result
      await env.MODERATION_KV.put(
        `moderation:${sha256}`,
        JSON.stringify(updated),
        {
          expirationTtl: 60 * 60 * 24 * 90 // 90 days
        }
      );

      // Update action-specific keys
      await Promise.all([
        // Clear old keys
        env.MODERATION_KV.delete(`review:${sha256}`),
        env.MODERATION_KV.delete(`age-restricted:${sha256}`),
        env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
        env.MODERATION_KV.delete(`quarantine:${sha256}`)  // Legacy
      ]);

      // Set new key based on action
      if (action === 'REVIEW') {
        await env.MODERATION_KV.put(
          `review:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
      } else if (action === 'AGE_RESTRICTED') {
        await env.MODERATION_KV.put(
          `age-restricted:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
      } else if (action === 'PERMANENT_BAN') {
        await env.MODERATION_KV.put(
          `permanent-ban:${sha256}`,
          JSON.stringify({
            category: updated.category,
            reason: updated.reason,
            timestamp: Date.now(),
            manualOverride: true
          })
        );
        // Back-compat for older CDN workers expecting quarantine flag
        await env.MODERATION_KV.put(
          `quarantine:${sha256}`,
          JSON.stringify({
            reason: updated.reason || 'permanent ban',
            timestamp: Date.now()
          })
        );
      }

      console.log(`[ADMIN] Updated ${sha256} from ${existing.action} to ${action}`);

      // Publish to relay so ban/block takes effect at source
      let publishResult = null;
      try {
        if (action !== 'SAFE') {
          publishResult = await publishToFaro({
            type: action.toLowerCase().replace('_', '-'),
            sha256,
            cdnUrl: updated.cdnUrl,
            scores: updated.scores || {},
            reason: updated.reason
          }, env);

          if (publishResult?.published && publishResult?.verified) {
            console.log(`[ADMIN] ✅ Published and verified ${action} event to relay for ${sha256}`);
          } else if (publishResult?.published) {
            console.warn(`[ADMIN] ⚠️ Published ${action} event but could not verify on relay for ${sha256}`);
          } else {
            console.error(`[ADMIN] ❌ Failed to publish ${action} event: ${publishResult?.error || 'unknown error'}`);
          }

          // Audit KV for relay publishes (production observability)
          await env.MODERATION_KV.put(
            `relay-publish:${sha256}`,
            JSON.stringify({
              action,
              reason: updated.reason || null,
              publishedAt: Date.now(),
              source: 'admin-override',
              eventId: publishResult?.eventId || null,
              published: publishResult?.published || false,
              verified: publishResult?.verified || false,
              error: publishResult?.error || null
            }),
            { expirationTtl: 60 * 60 * 24 * 30 }
          );
        }
      } catch (e) {
        console.error(`[ADMIN] Failed to publish ${action} event for ${sha256}:`, e.message || e);
        // Store failure in KV for auditing
        await env.MODERATION_KV.put(
          `relay-publish:${sha256}`,
          JSON.stringify({
            action,
            reason: updated.reason || null,
            publishedAt: Date.now(),
            source: 'admin-override',
            published: false,
            verified: false,
            error: e.message || String(e)
          }),
          { expirationTtl: 60 * 60 * 24 * 30 }
        );
      }

      // Mirror update in D1 so dashboards and API reflect manual overrides
      try {
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
          'admin-override',
          JSON.stringify(updated.scores || {}),
          JSON.stringify(updated.categories || []),
          new Date().toISOString(),
          updated.reason || null,
          new Date().toISOString()
        ).run();
      } catch (e) {
        console.error(`[ADMIN] Failed to mirror action to D1 for ${sha256}:`, e);
        // Do not fail the request if D1 write fails
      }

      return new Response(JSON.stringify({
        success: true,
        sha256,
        action,
        previousAction: existing.action,
        message: `Content updated to ${action}`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Admin: production self-test for KV/D1/Relay
    if (url.pathname === '/admin/api/self-test') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const start = Date.now();
      const results = { ok: true, checks: {}, durationMs: 0 };

      // KV read/write
      try {
        const key = `selftest:${crypto.randomUUID()}`;
        await env.MODERATION_KV.put(key, JSON.stringify({ t: Date.now() }), { expirationTtl: 60 });
        const readBack = await env.MODERATION_KV.get(key);
        await env.MODERATION_KV.delete(key);
        results.checks.kv = { ok: !!readBack };
      } catch (e) {
        results.checks.kv = { ok: false, error: e.message };
        results.ok = false;
      }

      // D1 simple query
      try {
        const row = await env.BLOSSOM_DB.prepare('SELECT 1 as ok').first();
        results.checks.d1 = { ok: row?.ok === 1 };
      } catch (e) {
        results.checks.d1 = { ok: false, error: e.message };
        results.ok = false;
      }

      // Relay connectivity
      try {
        const relayUrl = env.NOSTR_RELAY_URL || env.FARO_RELAY_URL;
        if (!relayUrl) throw new Error('No relay configured');
        const relayOptions = {};
        if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
          relayOptions.headers = {
            'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET
          };
        }
        const relay = await Relay.connect(relayUrl, relayOptions);
        relay.close();
        results.checks.relay = { ok: true, relayUrl };
      } catch (e) {
        results.checks.relay = { ok: false, error: e.message };
        results.ok = false;
      }

      results.durationMs = Date.now() - start;
      return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
    }

    // Admin: combined status for a specific sha256 (D1 + KV + last relay publish)
    if (url.pathname.startsWith('/admin/api/status/')) {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const sha256 = url.pathname.split('/')[4] || url.pathname.split('/')[3];
      if (!sha256) {
        return new Response(JSON.stringify({ error: 'sha256 required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // D1
      const d1 = await env.BLOSSOM_DB.prepare(`
        SELECT sha256, action, provider, moderated_at FROM moderation_results WHERE sha256 = ?
      `).bind(sha256).first();

      // KV flags
      const [modKV, revKV, ageKV, banKV, legacy] = await Promise.all([
        env.MODERATION_KV.get(`moderation:${sha256}`),
        env.MODERATION_KV.get(`review:${sha256}`),
        env.MODERATION_KV.get(`age-restricted:${sha256}`),
        env.MODERATION_KV.get(`permanent-ban:${sha256}`),
        env.MODERATION_KV.get(`quarantine:${sha256}`)
      ]);

      // Relay audit
      const relayAudit = await env.MODERATION_KV.get(`relay-publish:${sha256}`);

      return new Response(JSON.stringify({
        sha256,
        d1,
        kv: {
          moderation: !!modKV,
          review: !!revKV,
          ageRestricted: !!ageKV,
          permanentBan: !!banKV,
          quarantine: !!legacy
        },
        relay: relayAudit ? JSON.parse(relayAudit) : null
      }), { headers: { 'Content-Type': 'application/json' } });
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

      // Get existing moderation result
      const existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
      if (!existingData) {
        return new Response(JSON.stringify({ error: 'Moderation result not found for this video' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existing = JSON.parse(existingData);
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
        // Include pubkey separately since it's on the event, not in metadata
        metadata.pubkey = event.pubkey || null;

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

    // Admin video proxy - bypasses quarantine check for authenticated moderators
    if (url.pathname.startsWith('/admin/video/')) {
      // Check authentication
      const authError = await requireAuth(request, env);
      if (authError) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Extract sha256 from path
      const sha256 = url.pathname.split('/')[3].replace('.mp4', '');

      console.log(`[ADMIN] Fetching video: ${sha256}`);

      // Try multiple R2 key formats (Blossom uses blobs/ prefix)
      const possibleKeys = [
        `blobs/${sha256}`,        // New SDK worker format
        `videos/${sha256}.mp4`,   // Old format
        `${sha256}.mp4`,
        sha256
      ];

      let object = null;
      let usedKey = null;

      for (const key of possibleKeys) {
        console.log(`[ADMIN] Trying R2 key: ${key}`);
        object = await env.R2_VIDEOS.get(key);
        if (object) {
          usedKey = key;
          console.log(`[ADMIN] Found video at: ${key}`);
          break;
        }
      }

      if (!object) {
        console.error(`[ADMIN] Video not found in R2: ${sha256}`);
        return new Response(JSON.stringify({
          error: 'Video not found in R2',
          sha256,
          triedKeys: possibleKeys
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log(`[ADMIN] Serving video from R2 key: ${usedKey}`);

      return new Response(object.body, {
        headers: {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'private, no-cache',
          'X-Admin-Bypass': 'true',
          'X-R2-Key': usedKey
        }
      });
    }

    // Test endpoint to manually trigger moderation
    if (url.pathname === '/test-moderate' && request.method === 'POST') {
      const body = await request.json();
      const { sha256 } = body;

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

    // API: Update moderation status (for external services)
    // Auth: Verify Zero Trust JWT using jose library
    if (url.pathname === '/api/v1/moderate' && request.method === 'POST') {
      const jwtToken = request.headers.get('cf-access-jwt-assertion');

      // Verify JWT signature, issuer, and audience
      const verification = await verifyZeroTrustJWT(jwtToken, env);

      if (!verification.valid) {
        console.log(`[API] JWT verification failed: ${verification.error}`);
        return new Response(JSON.stringify({
          error: `Unauthorized - ${verification.error}`
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Determine auth source for logging
      const authSource = verification.email
        ? `user:${verification.email}`
        : `service-token:${verification.payload?.sub || 'unknown'}`;

      try {
        const body = await request.json();
      const { sha256, action, reason, source, requestId } = body;

        if (!sha256 || !action) {
          return new Response(JSON.stringify({ error: 'sha256 and action required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Validate action
        const validActions = ['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
        if (!validActions.includes(action.toUpperCase())) {
          return new Response(JSON.stringify({
            error: `Invalid action. Must be one of: ${validActions.join(', ')}`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Update or insert moderation result (D1)
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

        // Sync KV flags and publish to relay so enforcement happens
        try {
          // Basic KV record
          const kvValue = {
            sha256,
            action: action.toUpperCase(),
            scores: {},
            categories: [],
            reason: reason || `External update by ${source || 'external-api'}`,
            provider: source || 'external-api',
            moderatedAt: new Date().toISOString()
          };
          await env.MODERATION_KV.put(`moderation:${sha256}`, JSON.stringify(kvValue), { expirationTtl: 60 * 60 * 24 * 90 });

          // Update action flags
          await Promise.all([
            env.MODERATION_KV.delete(`review:${sha256}`),
            env.MODERATION_KV.delete(`age-restricted:${sha256}`),
            env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
            env.MODERATION_KV.delete(`quarantine:${sha256}`)
          ]);

          if (action.toUpperCase() === 'REVIEW') {
            await env.MODERATION_KV.put(`review:${sha256}`, JSON.stringify({ reason: kvValue.reason, timestamp: Date.now() }));
          } else if (action.toUpperCase() === 'AGE_RESTRICTED') {
            await env.MODERATION_KV.put(`age-restricted:${sha256}`, JSON.stringify({ reason: kvValue.reason, timestamp: Date.now() }));
          } else if (action.toUpperCase() === 'PERMANENT_BAN') {
            await env.MODERATION_KV.put(`permanent-ban:${sha256}`, JSON.stringify({ reason: kvValue.reason, timestamp: Date.now() }));
            // legacy quarantine flag
            await env.MODERATION_KV.put(`quarantine:${sha256}`, JSON.stringify({ reason: kvValue.reason, timestamp: Date.now() }));
          }

          // Publish to relay
          if (action.toUpperCase() !== 'SAFE') {
            const publishResult = await publishToFaro({
              type: action.toLowerCase().replace('_', '-'),
              sha256,
              scores: {},
              reason: kvValue.reason
            }, env);

            // Store publish verification result
            await env.MODERATION_KV.put(
              `relay-publish:${sha256}`,
              JSON.stringify({
                action: action.toUpperCase(),
                reason: kvValue.reason,
                publishedAt: Date.now(),
                source: source || 'external-api',
                eventId: publishResult?.eventId || null,
                published: publishResult?.published || false,
                verified: publishResult?.verified || false,
                error: publishResult?.error || null
              }),
              { expirationTtl: 60 * 60 * 24 * 30 }
            );
          }
        } catch (e) {
          console.error('[API] KV/Relay sync failed:', e);
          // do not fail the request on sync issues
        }

        console.log(`[API] Moderation updated: ${sha256} -> ${action} by ${source || 'external-api'} (auth: ${authSource})`);

        // Emit result to results queue for observability/feedback
        try {
          if (env.ACTION_RESULTS_QUEUE) {
            await env.ACTION_RESULTS_QUEUE.send({
              type: 'moderation-action-result',
              sha256,
              action: action.toUpperCase(),
              status: 'success',
              reason: reason || null,
              source: source || 'external-api',
              processedAt: Date.now(),
              requestId: requestId || null
            });
          }
        } catch (e) {
          console.error('[API] Failed to emit result message:', e);
        }

        return new Response(JSON.stringify({
          success: true,
          sha256,
          action: action.toUpperCase(),
          updated_at: new Date().toISOString()
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

    // API: Queue moderation action for asynchronous handling
    // Useful for cross-service integration (e.g., realness.admin)
    if (url.pathname === '/api/v1/moderate/queue' && request.method === 'POST') {
      const jwtToken = request.headers.get('cf-access-jwt-assertion');
      const verification = await verifyZeroTrustJWT(jwtToken, env);
      if (!verification.valid) {
        return new Response(JSON.stringify({ error: `Unauthorized - ${verification.error}` }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      const body = await request.json();
      const { sha256, action, reason, source, requestId } = body || {};
      const validActions = ['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
      if (!sha256 || !action || !validActions.includes(action.toUpperCase())) {
        return new Response(JSON.stringify({ error: 'sha256 and valid action required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Send action message to ACTION_QUEUE
      await env.ACTION_QUEUE.send({
        type: 'moderation-action',
        sha256,
        action: action.toUpperCase(),
        reason: reason || null,
        source: source || (verification.email ? `user:${verification.email}` : 'external'),
        requestId: requestId || crypto.randomUUID()
      });

      return new Response(JSON.stringify({ success: true, queued: true, sha256, action: action.toUpperCase(), requestId }), { headers: { 'Content-Type': 'application/json' } });
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
        age_restricted: action === 'AGE_RESTRICTED',
        needs_review: action === 'REVIEW',
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

    return new Response('Divine Moderation Service\n\nEndpoints:\nPOST /test-moderate {"sha256":"..."}\nGET  /check-result/{sha256}\nGET  /admin (password protected)', {
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
        // Fast path: moderation-action messages (from ACTION_QUEUE)
        if (message.body && message.body.type === 'moderation-action') {
          const { sha256, action, reason, source, requestId } = message.body;
          const validActions = ['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
          if (!sha256 || !validActions.includes((action || '').toUpperCase())) {
            console.error('[ACTION] Invalid moderation-action message', message.body);
            message.ack();
            continue;
          }

          const act = action.toUpperCase();
          console.log(`[ACTION] Processing action ${act} for ${sha256} (source=${source || 'unknown'})`);

          // D1 mirror
          try {
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
              act,
              source || 'action-queue',
              JSON.stringify({}),
              JSON.stringify([reason || act.toLowerCase()]),
              new Date().toISOString(),
              reason || null,
              new Date().toISOString()
            ).run();
          } catch (e) {
            console.error('[ACTION] Failed to write D1:', e);
          }

          // KV flags
          try {
            await env.MODERATION_KV.put(`moderation:${sha256}`,
              JSON.stringify({ sha256, action: act, reason, provider: source || 'action-queue', moderatedAt: new Date().toISOString() }),
              { expirationTtl: 60 * 60 * 24 * 90 }
            );
            await Promise.all([
              env.MODERATION_KV.delete(`review:${sha256}`),
              env.MODERATION_KV.delete(`age-restricted:${sha256}`),
              env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
              env.MODERATION_KV.delete(`quarantine:${sha256}`)
            ]);
            if (act === 'REVIEW') {
              await env.MODERATION_KV.put(`review:${sha256}`, JSON.stringify({ reason, timestamp: Date.now() }));
            } else if (act === 'AGE_RESTRICTED') {
              await env.MODERATION_KV.put(`age-restricted:${sha256}`, JSON.stringify({ reason, timestamp: Date.now() }));
            } else if (act === 'PERMANENT_BAN') {
              await env.MODERATION_KV.put(`permanent-ban:${sha256}`, JSON.stringify({ reason, timestamp: Date.now() }));
              await env.MODERATION_KV.put(`quarantine:${sha256}`, JSON.stringify({ reason: reason || 'permanent ban', timestamp: Date.now() }));
            }
          } catch (e) {
            console.error('[ACTION] Failed to sync KV flags:', e);
          }

          // Relay publish
          try {
            if (act !== 'SAFE') {
              const publishResult = await publishToFaro({ type: act.toLowerCase().replace('_', '-'), sha256, scores: {}, reason }, env);

              if (publishResult?.published && publishResult?.verified) {
                console.log(`[ACTION] ✅ Published and verified event for ${sha256.substring(0, 16)}...`);
              } else if (publishResult?.published) {
                console.warn(`[ACTION] ⚠️ Published but unverified event for ${sha256.substring(0, 16)}...`);
              } else {
                console.error(`[ACTION] ❌ Publish failed for ${sha256.substring(0, 16)}...: ${publishResult?.error}`);
              }

              await env.MODERATION_KV.put(
                `relay-publish:${sha256}`,
                JSON.stringify({
                  action: act,
                  reason: reason || null,
                  publishedAt: Date.now(),
                  source: 'action-queue',
                  eventId: publishResult?.eventId || null,
                  published: publishResult?.published || false,
                  verified: publishResult?.verified || false,
                  error: publishResult?.error || null
                }),
                { expirationTtl: 60 * 60 * 24 * 30 }
              );
            }
          } catch (e) {
            console.error('[ACTION] Failed to publish relay event:', e);
            // Store failure for auditing
            await env.MODERATION_KV.put(
              `relay-publish:${sha256}`,
              JSON.stringify({
                action: act,
                reason: reason || null,
                publishedAt: Date.now(),
                source: 'action-queue',
                published: false,
                verified: false,
                error: e.message || String(e)
              }),
              { expirationTtl: 60 * 60 * 24 * 30 }
            ).catch(() => {});
          }

          // Emit result to results queue for external admin feedback
          try {
            if (env.ACTION_RESULTS_QUEUE) {
              await env.ACTION_RESULTS_QUEUE.send({
                type: 'moderation-action-result',
                sha256,
                action: act,
                status: 'success',
                reason: reason || null,
                source: source || 'action-queue',
                processedAt: Date.now(),
                requestId: requestId || null
              });
            }
          } catch (e) {
            console.error('[ACTION] Failed to emit result message:', e);
          }

          message.ack();
          console.log(`[ACTION] ✅ COMPLETED ${sha256} -> ${act} in ${Date.now() - startTime}ms`);
          continue;
        }

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

        // Keep KV in sync for legacy consumers and admin operations
        try {
          const kvValue = {
            sha256,
            action: result.action,
            scores: result.scores || {},
            categories: result.categories || [],
            reason: result.reason,
            severity: result.severity,
            provider: result.provider || 'unknown',
            cdnUrl: result.cdnUrl,
            flaggedFrames: result.flaggedFrames || [],
            moderatedAt: new Date().toISOString()
          };

          await env.MODERATION_KV.put(
            `moderation:${sha256}`,
            JSON.stringify(kvValue),
            { expirationTtl: 60 * 60 * 24 * 90 }
          );

          // Clear old action flags and set the current one
          await Promise.all([
            env.MODERATION_KV.delete(`review:${sha256}`),
            env.MODERATION_KV.delete(`age-restricted:${sha256}`),
            env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
            env.MODERATION_KV.delete(`quarantine:${sha256}`) // legacy
          ]);

          if (result.action === 'REVIEW') {
            await env.MODERATION_KV.put(
              `review:${sha256}`,
              JSON.stringify({ reason: result.reason, timestamp: Date.now() })
            );
          } else if (result.action === 'AGE_RESTRICTED') {
            await env.MODERATION_KV.put(
              `age-restricted:${sha256}`,
              JSON.stringify({ reason: result.reason, timestamp: Date.now() })
            );
          } else if (result.action === 'PERMANENT_BAN') {
            await env.MODERATION_KV.put(
              `permanent-ban:${sha256}`,
              JSON.stringify({ reason: result.reason, timestamp: Date.now() })
            );
            // Back-compat for older CDN workers expecting quarantine flag
            await env.MODERATION_KV.put(
              `quarantine:${sha256}`,
              JSON.stringify({ reason: result.reason || 'permanent ban', timestamp: Date.now() })
            );
          }

          console.log(`[MODERATION] Step 7b: KV synced (moderation + flags)`);
        } catch (e) {
          console.error(`[MODERATION] Failed to sync KV for ${sha256}:`, e);
          // Continue; KV write failures should not fail the moderation
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

        // If this was a moderation-action message, emit failure to results queue
        try {
          if (message.body && message.body.type === 'moderation-action' && env.ACTION_RESULTS_QUEUE) {
            const { sha256, action, reason, source, requestId } = message.body;
            await env.ACTION_RESULTS_QUEUE.send({
              type: 'moderation-action-result',
              sha256,
              action,
              status: 'failed',
              error: error?.message || String(error),
              source: source || 'action-queue',
              processedAt: Date.now(),
              requestId: requestId || null
            });
          }
        } catch (e2) {
          console.error('[ACTION] Failed to emit failure result:', e2);
        }

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
  }
};

/**
 * Build HTML for the report page
 * Shows detailed video information with copyable identifiers
 */
function buildReportPageHTML(sha256, d1Result, nostrContext, relayPublishStatus, env) {
  const action = d1Result?.action || 'UNKNOWN';
  const scores = d1Result?.scores ? JSON.parse(d1Result.scores) : {};
  const categories = d1Result?.categories ? JSON.parse(d1Result.categories) : [];
  const moderatedAt = d1Result?.moderated_at || null;
  const provider = d1Result?.provider || 'unknown';
  const reviewedBy = d1Result?.reviewed_by || null;
  const reviewedAt = d1Result?.reviewed_at || null;
  const reviewNotes = d1Result?.review_notes || null;

  const eventId = nostrContext?.eventId || null;
  const pubkey = nostrContext?.pubkey || null;
  const title = nostrContext?.title || null;
  const author = nostrContext?.author || null;
  const platform = nostrContext?.platform || null;

  // Relay publish status
  const relayPublished = relayPublishStatus?.published || false;
  const relayVerified = relayPublishStatus?.verified || false;
  const relayEventId = relayPublishStatus?.eventId || null;
  const relayError = relayPublishStatus?.error || null;
  const relayPublishedAt = relayPublishStatus?.publishedAt || null;

  // Action badge colors
  const actionColors = {
    'SAFE': '#22c55e',
    'REVIEW': '#f59e0b',
    'AGE_RESTRICTED': '#f97316',
    'PERMANENT_BAN': '#ef4444',
    'UNKNOWN': '#666'
  };
  const actionColor = actionColors[action] || '#666';

  // Build score rows
  const scoreRows = Object.entries(scores)
    .filter(([_, v]) => typeof v === 'number' && v > 0.01)
    .sort(([, a], [, b]) => b - a)
    .map(([category, score]) => `
      <tr>
        <td style="padding: 6px 12px; border-bottom: 1px solid #333;">${category}</td>
        <td style="padding: 6px 12px; border-bottom: 1px solid #333; text-align: right; font-family: monospace;">${(score * 100).toFixed(1)}%</td>
      </tr>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Report: ${sha256.substring(0, 16)}... - Divine Moderation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      padding: 20px;
      max-width: 1000px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #333;
    }
    .header h1 { font-size: 20px; font-weight: 500; }
    .back-link { color: #3b82f6; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .video-container {
      display: flex;
      gap: 24px;
      margin-bottom: 24px;
    }
    .video-player {
      flex: 0 0 400px;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
    }
    .video-player video { width: 100%; display: block; }
    .video-details { flex: 1; }
    .action-badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .section {
      background: #111;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 14px;
      color: #888;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .id-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #222;
    }
    .id-row:last-child { border-bottom: none; }
    .id-label {
      font-size: 12px;
      color: #888;
      width: 80px;
      flex-shrink: 0;
    }
    .id-value {
      font-family: monospace;
      font-size: 13px;
      color: #e5e5e5;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .id-full {
      font-family: monospace;
      font-size: 11px;
      color: #666;
      word-break: break-all;
      margin-top: 4px;
      padding: 8px;
      background: #0a0a0a;
      border-radius: 4px;
    }
    .copy-btn {
      background: #333;
      color: #888;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.2s;
    }
    .copy-btn:hover { background: #444; color: #fff; }
    .copy-btn.copied { background: #22c55e; color: #fff; }
    table { width: 100%; border-collapse: collapse; }
    .meta-item {
      display: flex;
      padding: 8px 0;
      border-bottom: 1px solid #222;
    }
    .meta-label { width: 120px; color: #888; font-size: 13px; }
    .meta-value { color: #e5e5e5; font-size: 13px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Video Report</h1>
    <a href="/admin/dashboard" class="back-link">← Back to Dashboard</a>
  </div>

  <div class="video-container">
    <div class="video-player">
      <video src="/admin/video/${sha256}.mp4" controls muted loop preload="auto"></video>
    </div>
    <div class="video-details">
      <div class="action-badge" style="background: ${actionColor};">${action}</div>

      ${title ? `<h2 style="font-size: 18px; margin-bottom: 12px;">${escapeHtmlForReport(title)}</h2>` : ''}
      ${author ? `<p style="color: #888; margin-bottom: 16px;">by ${escapeHtmlForReport(author)}${platform ? ` on ${escapeHtmlForReport(platform)}` : ''}</p>` : ''}

      <div style="font-size: 13px; color: #888;">
        ${provider ? `<div>Provider: <span style="color: #e5e5e5;">${escapeHtmlForReport(provider)}</span></div>` : ''}
        ${moderatedAt ? `<div>Moderated: <span style="color: #e5e5e5;">${new Date(moderatedAt).toLocaleString()}</span></div>` : ''}
        ${reviewedBy ? `<div>Reviewed by: <span style="color: #e5e5e5;">${escapeHtmlForReport(reviewedBy)}</span></div>` : ''}
        ${reviewedAt ? `<div>Reviewed: <span style="color: #e5e5e5;">${new Date(reviewedAt).toLocaleString()}</span></div>` : ''}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Identifiers (Click to copy)</div>

    <div class="id-row">
      <span class="id-label">SHA256</span>
      <span class="id-value">${sha256.substring(0, 24)}...</span>
      <button class="copy-btn" onclick="copyId('${sha256}', this)">📋 Copy</button>
    </div>
    <div class="id-full">${sha256}</div>

    ${eventId ? `
    <div class="id-row">
      <span class="id-label">Event ID</span>
      <span class="id-value">${eventId.substring(0, 24)}...</span>
      <button class="copy-btn" onclick="copyId('${eventId}', this)">📋 Copy</button>
    </div>
    <div class="id-full">${eventId}</div>
    ` : '<div class="id-row"><span class="id-label">Event ID</span><span class="id-value" style="color: #666;">No Nostr event found</span></div>'}

    <div class="id-row">
      <span class="id-label">d-tag</span>
      <span class="id-value">${sha256.substring(0, 24)}...</span>
      <button class="copy-btn" onclick="copyId('${sha256}', this)">📋 Copy</button>
    </div>

    ${pubkey ? `
    <div class="id-row">
      <span class="id-label">Pubkey</span>
      <span class="id-value">${pubkey.substring(0, 24)}...</span>
      <button class="copy-btn" onclick="copyId('${pubkey}', this)">📋 Copy</button>
    </div>
    <div class="id-full">${pubkey}</div>
    ` : ''}

    <div class="id-row">
      <span class="id-label">Video URL</span>
      <span class="id-value">https://cdn.divine.video/${sha256}.mp4</span>
      <button class="copy-btn" onclick="copyId('https://cdn.divine.video/${sha256}.mp4', this)">📋 Copy</button>
    </div>
  </div>

  ${scoreRows ? `
  <div class="section">
    <div class="section-title">AI Detection Scores</div>
    <table>
      <tbody>${scoreRows}</tbody>
    </table>
  </div>
  ` : ''}

  ${reviewNotes ? `
  <div class="section">
    <div class="section-title">Review Notes</div>
    <p style="color: #e5e5e5; font-size: 14px;">${escapeHtmlForReport(reviewNotes)}</p>
  </div>
  ` : ''}

  <div class="section">
    <div class="section-title">Relay Publish Status</div>
    ${action === 'SAFE' ? `
      <div style="display: flex; align-items: center; gap: 8px; color: #888;">
        <span style="font-size: 20px;">⏭️</span>
        <span>Not published (SAFE content not broadcast to relay)</span>
      </div>
    ` : relayPublished && relayVerified ? `
      <div style="display: flex; align-items: center; gap: 8px; color: #22c55e;">
        <span style="font-size: 20px;">✅</span>
        <span>Published and verified on relay</span>
      </div>
      ${relayEventId ? `
      <div class="id-row" style="margin-top: 12px;">
        <span class="id-label">Nostr Event</span>
        <span class="id-value">${relayEventId.substring(0, 24)}...</span>
        <button class="copy-btn" onclick="copyId('${relayEventId}', this)">📋 Copy</button>
      </div>
      <div class="id-full">${relayEventId}</div>
      ` : ''}
      ${relayPublishedAt ? `<div style="font-size: 12px; color: #666; margin-top: 8px;">Published: ${new Date(relayPublishedAt).toLocaleString()}</div>` : ''}
    ` : relayPublished ? `
      <div style="display: flex; align-items: center; gap: 8px; color: #f59e0b;">
        <span style="font-size: 20px;">⚠️</span>
        <span>Published but not verified (event may not be stored on relay)</span>
      </div>
      ${relayEventId ? `
      <div class="id-row" style="margin-top: 12px;">
        <span class="id-label">Nostr Event</span>
        <span class="id-value">${relayEventId.substring(0, 24)}...</span>
        <button class="copy-btn" onclick="copyId('${relayEventId}', this)">📋 Copy</button>
      </div>
      ` : ''}
      ${relayPublishedAt ? `<div style="font-size: 12px; color: #666; margin-top: 8px;">Published: ${new Date(relayPublishedAt).toLocaleString()}</div>` : ''}
    ` : relayError ? `
      <div style="display: flex; align-items: center; gap: 8px; color: #ef4444;">
        <span style="font-size: 20px;">❌</span>
        <span>Publish failed</span>
      </div>
      <div style="font-size: 12px; color: #888; margin-top: 8px; padding: 8px; background: #1a1a1a; border-radius: 4px; font-family: monospace;">
        Error: ${escapeHtmlForReport(relayError)}
      </div>
    ` : `
      <div style="display: flex; align-items: center; gap: 8px; color: #888;">
        <span style="font-size: 20px;">❓</span>
        <span>No publish record found</span>
      </div>
    `}
  </div>

  <div class="section">
    <div class="section-title">Quick Actions</div>
    <div style="display: flex; gap: 12px; margin-top: 8px;">
      <a href="https://divine.video/video/${eventId || sha256}" target="_blank" style="background: #3b82f6; color: white; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px;">View on Divine.video →</a>
      <a href="/admin/dashboard?focus=${sha256}" style="background: #333; color: #e5e5e5; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px;">Open in Dashboard</a>
    </div>
  </div>

  <script>
    function copyId(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Escape HTML for report page (simple version)
 */
function escapeHtmlForReport(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      const publishResult = await publishToFaro({
        type: action.toLowerCase().replace('_', '-'),
        sha256,
        cdnUrl,
        category: result.category,
        scores,
        reason,
        severity,
        frames: flaggedFrames
      }, env);

      if (publishResult?.published && publishResult?.verified) {
        console.log(`[MODERATION] ✅ ${sha256} - Nostr ${action} event published and verified`);
      } else if (publishResult?.published) {
        console.warn(`[MODERATION] ⚠️ ${sha256} - Nostr ${action} event published but not verified`);
      } else {
        console.error(`[MODERATION] ❌ ${sha256} - Nostr publish failed: ${publishResult?.error}`);
      }

      // Store publish verification result
      await env.MODERATION_KV.put(
        `relay-publish:${sha256}`,
        JSON.stringify({
          action,
          reason: reason || null,
          publishedAt: Date.now(),
          source: 'moderation-pipeline',
          eventId: publishResult?.eventId || null,
          published: publishResult?.published || false,
          verified: publishResult?.verified || false,
          error: publishResult?.error || null
        }),
        { expirationTtl: 60 * 60 * 24 * 30 }
      );
    } catch (error) {
      console.error(`[MODERATION] ${sha256} - Nostr publish failed:`, error);
      // Store failure for auditing
      try {
        await env.MODERATION_KV.put(
          `relay-publish:${sha256}`,
          JSON.stringify({
            action,
            reason: reason || null,
            publishedAt: Date.now(),
            source: 'moderation-pipeline',
            published: false,
            verified: false,
            error: error.message || String(error)
          }),
          { expirationTtl: 60 * 60 * 24 * 30 }
        );
      } catch (kvErr) {
        console.error(`[MODERATION] Failed to store publish failure:`, kvErr);
      }
      // Don't throw - we don't want Nostr failures to fail the whole moderation
    }
  } else {
    console.log(`[MODERATION] ${sha256} approved (no notification needed)`);
  }

  console.log(`[MODERATION] handleModerationResult finished for ${sha256}`);
}
