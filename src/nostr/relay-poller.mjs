// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Relay polling service for discovering new video events
// ABOUTME: Polls relay.divine.video for kind 34236 events and queues unmoderated videos

/**
 * Poll relay for new video events and queue them for moderation
 * @param {Object} env - Cloudflare Worker environment bindings
 * @param {Object} options - Polling options
 * @param {number} [options.since] - Only fetch events created after this timestamp (unix seconds)
 * @param {number} [options.limit] - Maximum number of events to fetch
 * @param {string[]} [options.relays] - Relay URLs to poll
 * @returns {Promise<Object>} Polling results with counts
 */
export async function pollRelayForVideos(env, options = {}) {
  const {
    since = Math.floor(Date.now() / 1000) - 3600, // Default: last 1 hour
    limit = 100,
    relays = ['wss://relay.divine.video']
  } = options;

  const results = {
    totalEvents: 0,
    alreadyModerated: 0,
    queuedForModeration: 0,
    errors: [],
    events: []
  };

  console.log(`[RELAY-POLLER] Starting poll from ${relays.join(', ')} since ${new Date(since * 1000).toISOString()}`);

  for (const relayUrl of relays) {
    try {
      const events = await fetchVideoEventsFromRelay(relayUrl, { since, limit }, env);
      console.log(`[RELAY-POLLER] Fetched ${events.length} events from ${relayUrl}`);

      for (const event of events) {
        results.totalEvents++;

        // Extract SHA256 from imeta tag
        const sha256 = extractSha256FromImeta(event);
        if (!sha256) {
          console.log(`[RELAY-POLLER] Skipping event ${event.id?.substring(0, 16)}... - no SHA256 in imeta`);
          continue;
        }

        // Check if already moderated
        const existingResult = await env.MODERATION_KV.get(`moderation:${sha256}`);
        if (existingResult) {
          results.alreadyModerated++;
          continue;
        }

        // Check if already failed
        const failedResult = await env.MODERATION_KV.get(`failed:${sha256}`);
        if (failedResult) {
          console.log(`[RELAY-POLLER] Skipping ${sha256.substring(0, 16)}... - previously failed`);
          continue;
        }

        // Reactive moderation: do NOT queue new uploads from the relay.
        // Pre-screening is disabled; moderation runs only when a user reports content.
        // Still record the observation so the cron's poll log stays informative.
        results.events.push({
          sha256: sha256.substring(0, 16) + '...',
          eventId: event.id?.substring(0, 16) + '...',
          pubkey: event.pubkey?.substring(0, 16) + '...',
          status: 'reactive_skip'
        });
      }
    } catch (error) {
      console.error(`[RELAY-POLLER] Failed to poll ${relayUrl}:`, error);
      results.errors.push({
        relay: relayUrl,
        error: error.message
      });
    }
  }

  console.log(`[RELAY-POLLER] Poll complete: ${results.totalEvents} events, ${results.alreadyModerated} already moderated, ${results.queuedForModeration} queued`);

  return results;
}

/**
 * Fetch video events (kind 34236) from a relay
 * @param {string} relayUrl - WebSocket URL of the relay
 * @param {Object} options - Query options
 * @param {number} options.since - Fetch events after this timestamp
 * @param {number} options.limit - Maximum events to fetch
 * @param {Object} env - Environment with CF Access credentials
 * @returns {Promise<Object[]>} Array of Nostr events
 */
async function fetchVideoEventsFromRelay(relayUrl, options, env) {
  const { since, limit } = options;

  return new Promise((resolve, reject) => {
    const events = [];
    let ws;
    const timeout = setTimeout(() => {
      if (ws) ws.close();
      resolve(events); // Return what we have so far
    }, 30000); // 30 second timeout

    try {
      // Create WebSocket with Cloudflare Access headers if available
      const wsOptions = {};
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        // Note: WebSocket in Cloudflare Workers doesn't support custom headers directly
        // The relay should be configured to accept connections from this worker
        console.log(`[RELAY-POLLER] Connecting to ${relayUrl} with CF Access credentials`);
      }

      ws = new WebSocket(relayUrl);
      const subscriptionId = `poll-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      ws.addEventListener('open', () => {
        // Build filter for kind 34236 (video events)
        const filter = {
          kinds: [34236],
          since,
          limit
        };

        const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);
        console.log(`[RELAY-POLLER] Sending REQ to ${relayUrl}: kinds=[34236], since=${since}, limit=${limit}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[1] === subscriptionId) {
            events.push(data[2]);
          }

          if (data[0] === 'EOSE') {
            console.log(`[RELAY-POLLER] EOSE received, got ${events.length} events`);
            clearTimeout(timeout);

            // Close subscription
            ws.send(JSON.stringify(['CLOSE', subscriptionId]));
            ws.close();
            resolve(events);
          }

          if (data[0] === 'CLOSED') {
            console.log(`[RELAY-POLLER] Subscription closed by relay`);
          }

          if (data[0] === 'NOTICE') {
            console.log(`[RELAY-POLLER] Relay notice: ${data[1]}`);
          }
        } catch (parseError) {
          console.error('[RELAY-POLLER] Failed to parse message:', parseError);
        }
      });

      ws.addEventListener('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${error.message || 'Unknown error'}`));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        // Return what we have, even if closed unexpectedly
        resolve(events);
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Extract SHA256 from imeta tag in a Nostr event
 * @param {Object} event - Nostr event
 * @returns {string|null} SHA256 hash or null
 */
export function extractSha256FromImeta(event) {
  if (!event || !event.tags) return null;

  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      // Parse space-separated parameters in imeta tag
      for (let i = 1; i < tag.length; i++) {
        const param = tag[i];
        // Look for "x <sha256>" parameter
        if (param && param.startsWith('x ')) {
          const sha256 = param.substring(2).trim();
          // Validate it looks like a SHA256
          if (/^[0-9a-f]{64}$/i.test(sha256)) {
            return sha256.toLowerCase();
          }
        }
      }
    }

    // Also check for 'x' tag (alternative format)
    if (tag[0] === 'x' && tag[1]) {
      const sha256 = tag[1].trim();
      if (/^[0-9a-f]{64}$/i.test(sha256)) {
        return sha256.toLowerCase();
      }
    }
  }

  return null;
}

/**
 * Extract video URL from event tags
 * @param {Object} event - Nostr event
 * @param {Object} env - Environment with CDN domain
 * @returns {string} Video URL
 */
export function extractVideoUrlFromEvent(event, env) {
  if (!event || !event.tags) {
    return null;
  }

  // Check imeta tag for URL first (most reliable — includes mime type context)
  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      let imetaUrl = null;
      let isVideo = false;
      for (let i = 1; i < tag.length; i++) {
        const param = tag[i];
        if (param && param.startsWith('url ')) {
          imetaUrl = param.substring(4).trim();
        }
        if (param && (param.startsWith('m video/') || param === 'm video/mp4')) {
          isVideo = true;
        }
      }
      // Accept if URL looks like video or mime says video
      if (imetaUrl && (isVideo || imetaUrl.includes('.mp4') || imetaUrl.includes('/video/'))) {
        return imetaUrl;
      }
      // For kind 34236 (video events), accept any imeta URL — it's already a video event
      if (imetaUrl) {
        return imetaUrl;
      }
    }
  }

  // Check 'r' tags for video URL (blossom URLs may not have .mp4 extension)
  for (const tag of event.tags) {
    if (tag[0] === 'r' && tag[1]) {
      const url = tag[1];
      if (url.startsWith('http')) {
        return url;
      }
    }
  }

  // Fallback: construct URL from SHA256
  const sha256 = extractSha256FromImeta(event);
  if (sha256 && env.CDN_DOMAIN) {
    return `https://${env.CDN_DOMAIN}/${sha256}`;
  }

  return null;
}

/**
 * Get the timestamp for the last successful poll
 * @param {Object} env - Environment with KV binding
 * @returns {Promise<number|null>} Unix timestamp in seconds or null
 */
export async function getLastPollTimestamp(env) {
  try {
    const data = await env.MODERATION_KV.get('relay-poller:last-poll');
    if (data) {
      const parsed = JSON.parse(data);
      return parsed.timestamp;
    }
  } catch (error) {
    console.error('[RELAY-POLLER] Failed to get last poll timestamp:', error);
  }
  return null;
}

/**
 * Store the timestamp of the last successful poll
 * @param {Object} env - Environment with KV binding
 * @param {number} timestamp - Unix timestamp in seconds
 * @param {Object} stats - Polling statistics to store
 */
export async function setLastPollTimestamp(env, timestamp, stats = {}) {
  try {
    await env.MODERATION_KV.put('relay-poller:last-poll', JSON.stringify({
      timestamp,
      lastPollAt: new Date().toISOString(),
      ...stats
    }));
  } catch (error) {
    console.error('[RELAY-POLLER] Failed to store last poll timestamp:', error);
  }
}

/**
 * Get relay polling status for admin dashboard
 * @param {Object} env - Environment with KV binding
 * @returns {Promise<Object>} Polling status
 */
export async function getPollingStatus(env) {
  try {
    const data = await env.MODERATION_KV.get('relay-poller:last-poll');
    if (data) {
      return {
        enabled: env.RELAY_POLLING_ENABLED !== 'false',
        ...JSON.parse(data)
      };
    }
  } catch (error) {
    console.error('[RELAY-POLLER] Failed to get polling status:', error);
  }

  return {
    enabled: env.RELAY_POLLING_ENABLED !== 'false',
    timestamp: null,
    lastPollAt: null,
    message: 'No polls completed yet'
  };
}
