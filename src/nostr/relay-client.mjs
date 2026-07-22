// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Nostr relay WebSocket client for fetching event context
// ABOUTME: Connects to relay.divine.video to get kind 34236 video events by SHA256

import { verifyEvent } from 'nostr-tools/pure';
import { extractMediaShaFromEvent } from '../validation.mjs';

const HEX64_RE = /^[0-9a-f]{64}$/;

// A 2xx body is only the definitive answer if it is the exact signed event we
// asked for. The relay's claimed `id` field is untrusted, so verifyEvent()
// recomputes the canonical hash and, together with the requested-id match,
// cryptographically binds the returned pubkey/tags/content to eventId — plus
// it validates the signature (authentic author). Anything else (wrong event,
// tampered, malformed, bad signature) is routed through the transient path so
// callers hold rather than act on an event they didn't ask for — never
// labeling/striking/reporting one event based on another.
function isRequestedSignedEvent(event, eventId) {
  return (
    event &&
    typeof event === 'object' &&
    event.id === eventId &&
    typeof event.pubkey === 'string' &&
    HEX64_RE.test(event.pubkey) &&
    typeof event.kind === 'number' &&
    Number.isInteger(event.created_at) &&
    Array.isArray(event.tags) &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string' &&
    verifyEvent(event)
  );
}

const DEFAULT_SHA_BATCH_CHUNK_SIZE = 25;
const MAX_SHA_BATCH_CHUNK_SIZE = 100;
const DEFAULT_SHA_BATCH_CONCURRENCY = 3;
const MAX_SHA_BATCH_CONCURRENCY = 8;
const DEFAULT_SHA_BATCH_QUERY_LIMIT = 100;
const MAX_SHA_BATCH_QUERY_LIMIT = 500;
export const LABEL_EVENTS_FOR_VIDEO_LIMIT = 5000;

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function hasUnresolvedEvent(eventsBySha) {
  for (const value of eventsBySha.values()) {
    if (!value) return true;
  }
  return false;
}

async function runWithConcurrency(items, concurrency, worker) {
  let currentIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (currentIndex < items.length) {
      const itemIndex = currentIndex;
      currentIndex += 1;
      await worker(items[itemIndex], itemIndex);
    }
  });

  await Promise.all(workers);
}

async function queryRelay(relayUrl, filter, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let subscriptionId = null;
    let eoseReceived = false;
    const collectAll = Boolean(options.collectAll);
    // When set (opt-in), a socket close before EOSE rejects instead of
    // resolving with a partial result — so a truncated/dropped stream becomes
    // a transient failure the caller can retry, not a silent below-threshold
    // read. Only meaningful with collectAll.
    const rejectOnPrematureClose = Boolean(options.rejectOnPrematureClose);
    const events = [];
    let firstEvent = null;
    const timeout = setTimeout(() => {
      try {
        if (ws) ws.close();
      } catch {}
      finish(new Error('WebSocket timeout'));
    }, 5000); // 5 second timeout - should be fast with direct query

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
      // Cloudflare Workers' WebSocket constructor only accepts a subprotocol
      // string/array as the second argument; passing an options object fails
      // with "The protocol header token is invalid" and silently breaks the
      // cron. relay.divine.video is a public Nostr relay that does not require
      // CF Access, so we don't need to forward those headers here. If we ever
      // point at a CF-Access-protected relay, switch to the fetch({ Upgrade })
      // pattern and use the returned response.webSocket.
      ws = new WebSocket(relayUrl);

      ws.addEventListener('open', () => {
        subscriptionId = Math.random().toString(36).substring(7);
        const reqMessage = JSON.stringify([
          'REQ',
          subscriptionId,
          filter
        ]);

        console.log(`[NOSTR] Querying ${relayUrl}: ${JSON.stringify(filter)}`);
        ws.send(reqMessage);
      });

      ws.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(msg.data);

          if (data[0] === 'EVENT' && data[1] === subscriptionId) {
            const event = data[2];
            if (collectAll) {
              if (event?.id && !events.some((existing) => existing.id === event.id)) {
                events.push(event);
              }
            } else if (!firstEvent) {
              firstEvent = event;
              try {
                ws.close();
              } catch {}
              finish(event);
            }
          }

          if (data[0] === 'EOSE' && data[1] === subscriptionId) {
            eoseReceived = true;
            try {
              ws.close();
            } catch {}
            finish(collectAll ? events : firstEvent);
          }
        } catch (err) {
          console.error('[NOSTR] Failed to parse message:', err);
        }
      });

      ws.addEventListener('error', (err) => {
        finish(err instanceof Error ? err : new Error('WebSocket error'));
      });

      ws.addEventListener('close', () => {
        if (collectAll && rejectOnPrematureClose && !eoseReceived) {
          finish(new Error('WebSocket closed before EOSE'));
          return;
        }
        finish(collectAll ? events : firstEvent);
      });

    } catch (error) {
      finish(error instanceof Error ? error : new Error('WebSocket setup failed'));
    }
  });
}

/**
 * Fetch Nostr events for many media SHA256 values in relay-friendly batches.
 *
 * @param {string[]} sha256s - Video hashes
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables
 * @param {Object} options - Batch lookup options
 * @returns {Promise<Map<string, Object|null>>} Map of sha256 -> matching event or null
 */
export async function fetchNostrEventsBySha256Batch(sha256s, relays = ['wss://relay.divine.video'], env = {}, options = {}) {
  const normalizedShas = [...new Set(
    (Array.isArray(sha256s) ? sha256s : [])
      .map((sha) => (typeof sha === 'string' ? sha.toLowerCase() : null))
      .filter(Boolean)
  )];
  const eventsBySha = new Map(normalizedShas.map((sha) => [sha, null]));

  if (normalizedShas.length === 0) {
    return eventsBySha;
  }

  const chunkSize = parseBoundedInteger(
    options.chunkSize,
    DEFAULT_SHA_BATCH_CHUNK_SIZE,
    1,
    MAX_SHA_BATCH_CHUNK_SIZE
  );
  const concurrency = parseBoundedInteger(
    options.concurrency,
    DEFAULT_SHA_BATCH_CONCURRENCY,
    1,
    MAX_SHA_BATCH_CONCURRENCY
  );
  const queryLimit = parseBoundedInteger(
    options.limit,
    Math.min(Math.max(chunkSize * 4, 20), DEFAULT_SHA_BATCH_QUERY_LIMIT),
    1,
    MAX_SHA_BATCH_QUERY_LIMIT
  );
  const shaChunks = chunkArray(normalizedShas, chunkSize);

  for (const relay of relays) {
    await runWithConcurrency(shaChunks, concurrency, async (chunk) => {
      const unresolvedShas = chunk.filter((sha) => !eventsBySha.get(sha));
      if (unresolvedShas.length === 0) {
        return;
      }

      try {
        const xTagMatches = await queryRelay(relay, {
          kinds: [34235, 34236],
          '#x': unresolvedShas,
          limit: queryLimit
        }, env, { collectAll: true });

        for (const event of xTagMatches) {
          const mediaSha = extractMediaShaFromEvent(event);
          if (mediaSha && eventsBySha.has(mediaSha) && !eventsBySha.get(mediaSha)) {
            eventsBySha.set(mediaSha, event);
          }
        }

        const unresolvedAfterX = unresolvedShas.filter((sha) => !eventsBySha.get(sha));
        if (unresolvedAfterX.length === 0) {
          return;
        }

        const dTagMatches = await queryRelay(relay, {
          kinds: [34235, 34236],
          '#d': unresolvedAfterX,
          limit: queryLimit
        }, env, { collectAll: true });

        for (const event of dTagMatches) {
          const mediaSha = extractMediaShaFromEvent(event);
          if (mediaSha && eventsBySha.has(mediaSha) && !eventsBySha.get(mediaSha)) {
            eventsBySha.set(mediaSha, event);
          }
        }
      } catch (error) {
        console.error(`[NOSTR] Failed batch fetch from ${relay}:`, error);
      }
    });

    if (!hasUnresolvedEvent(eventsBySha)) {
      break;
    }
  }

  return eventsBySha;
}

/**
 * Fetch Nostr event for a video SHA256 from relay.
 * Legacy Vine imports use d=vine_id and expose the media hash via x/imeta x,
 * while newer content may still use d=sha256.
 *
 * @param {string} sha256 - Video hash
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables (for Cloudflare Access tokens)
 * @returns {Promise<Object|null>} Nostr event or null if not found
 */
export async function fetchNostrEventBySha256(sha256, relays = ['wss://relay.divine.video'], env = {}) {
  const normalizedSha256 = typeof sha256 === 'string' ? sha256.toLowerCase() : sha256;
  if (!normalizedSha256) {
    return null;
  }

  const eventsBySha = await fetchNostrEventsBySha256Batch([normalizedSha256], relays, env, {
    chunkSize: 1,
    concurrency: 1,
    limit: 10
  });
  return eventsBySha.get(normalizedSha256) || null;
}

/**
 * Fetch all addressable video event versions for a d-tag / SHA256.
 *
 * @param {string} dTag - Addressable event d-tag, which for Divine videos is the media SHA256
 * @param {string[]} relays - Relay URLs to query
 * @param {Object} env - Environment variables (for Cloudflare Access tokens)
 * @param {Object} options - Query options
 * @returns {Promise<Object[]>} Matching video events
 */
export async function fetchNostrVideoEventsByDTag(dTag, relays = ['wss://relay.divine.video'], env = {}, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;

  for (const relay of relays) {
    try {
      const events = await queryRelay(relay, {
        kinds: [34235, 34236],
        '#d': [dTag],
        limit
      }, env, { collectAll: true });
      if (events.length > 0) {
        return events;
      }
    } catch (error) {
      console.error(`[NOSTR] Failed to fetch versions from ${relay}:`, error);
    }
  }

  return [];
}
/**
 * Extract metadata from kind 34236 event tags
 */
export function parseVideoEventMetadata(event) {
  if (!event || !event.tags) {
    return null;
  }

  const metadata = {
    title: null,
    author: null,
    summary: null,
    platform: null,
    client: null,
    loops: null,
    likes: null,
    comments: null,
    url: null,
    sourceUrl: null,
    publishedAt: null,
    archivedAt: null,
    importedAt: null,
    vineHashId: null,
    vineUserId: null,
    proofmode: null,
    stableId: null
  };

  for (const tag of event.tags) {
    const [key, value] = tag;

    switch (key) {
      case 'title':
        metadata.title = value;
        break;
      case 'author':
        metadata.author = value;
        break;
      case 'summary':
        metadata.summary = value;
        break;
      case 'platform':
        metadata.platform = value;
        break;
      case 'client':
        metadata.client = value;
        break;
      case 'loops':
        metadata.loops = parseInt(value, 10);
        break;
      case 'likes':
        metadata.likes = parseInt(value, 10);
        break;
      case 'comments':
        metadata.comments = parseInt(value, 10);
        break;
      case 'r':
        // Store original source URL (e.g., vine.co URL)
        metadata.sourceUrl = value;
        // Only use 'r' tag URL if we don't already have one from imeta
        if (!metadata.url) {
          metadata.url = value;
        }
        break;
      case 'published_at':
        metadata.publishedAt = parseInt(value, 10);
        break;
      case 'archived_at':
        metadata.archivedAt = value;
        break;
      case 'imported_at':
        metadata.importedAt = parseInt(value, 10);
        break;
      case 'vine_hash_id':
        metadata.vineHashId = value;
        break;
      case 'vine_user_id':
        metadata.vineUserId = value;
        break;
      case 'proofmode': {
        const proofmode = {
          createdAt: null,
          device: null,
          proof: null,
          raw: tag.slice(1)
        };

        for (let i = 1; i < tag.length; i++) {
          const entry = tag[i];
          if (!entry || typeof entry !== 'string') {
            continue;
          }

          if (entry.startsWith('created_at ')) {
            const parsed = parseInt(entry.substring('created_at '.length), 10);
            proofmode.createdAt = Number.isNaN(parsed) ? null : parsed;
          } else if (entry.startsWith('device ')) {
            proofmode.device = entry.substring('device '.length).trim() || null;
          } else if (entry.startsWith('proof ')) {
            proofmode.proof = entry.substring('proof '.length).trim() || null;
          }
        }

        metadata.proofmode = proofmode;
        break;
      }
      case 'd':
        metadata.stableId = value;
        break;
      case 'imeta':
        // Extract URL from imeta tag - format: "url https://..."
        // Blossom URLs use content-addressed hashes without file extensions
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('url ') && param.length > 4) {
            metadata.url = param.substring(4).trim();
            break;
          }
        }
        break;
    }
  }

  metadata.content = event.content || metadata.summary;
  metadata.eventId = event.id;
  metadata.createdAt = event.created_at;

  return metadata;
}

/**
 * Check if a video is an original Vine (should skip AI detection)
 * Original Vines are from 2013-2017 and predate AI video generation
 */
export function isOriginalVine(nostrContext) {
  if (!nostrContext) return false;

  if (hasStrongOriginalVineEvidence(nostrContext)) return true;

  // Check if published_at is before 2018 (Vine shut down Jan 2017)
  // Timestamp 1514764800 = Jan 1, 2018
  if (nostrContext.publishedAt && nostrContext.publishedAt < 1514764800) return true;

  return false;
}

export function hasStrongOriginalVineEvidence(nostrContext) {
  if (!nostrContext) return false;

  // Direct indicators of original Vine content
  if (nostrContext.platform === 'vine') return true;
  if (nostrContext.client && /vine-(archive-importer|archaeologist)/.test(nostrContext.client)) return true;
  if (nostrContext.vineHashId) return true;
  if (nostrContext.sourceUrl && nostrContext.sourceUrl.includes('vine.co')) return true;

  return false;
}

export async function fetchKind5EventsSince(sinceSeconds, relayUrl = 'wss://relay.divine.video', env = {}) {
  return queryRelay(relayUrl, { kinds: [5], since: sinceSeconds }, env, { collectAll: true });
}

/**
 * Fetch kind 1985 (NIP-32 label) events created since a cursor. Callers
 * filter by namespace in code; relays are not assumed to index #L.
 */
export async function fetchLabelEventsSince(sinceSeconds, relayUrl = 'wss://relay.divine.video', env = {}, { limit } = {}) {
  const filter = { kinds: [1985], since: sinceSeconds };
  if (Number.isInteger(limit) && limit > 0) filter.limit = limit;
  // Strict: a close before EOSE is a truncated poll, not a complete window.
  // Rejecting holds the sweep cursor rather than advancing past unseen votes.
  return queryRelay(relayUrl, filter, env, { collectAll: true, rejectOnPrematureClose: true });
}

/**
 * Fetch every kind 1985 label event targeting a video, via its #e tag and —
 * when the video is addressable — its #a tag, deduped by event id.
 */
export async function fetchLabelEventsForVideo({ eventId, addressableId }, relayUrl = 'wss://relay.divine.video', env = {}, { limit = LABEL_EVENTS_FOR_VIDEO_LIMIT } = {}) {
  const byId = new Map();
  // Strict: a truncated per-video tally must fail (and hold the cursor), not
  // silently under-count and let a below-threshold read advance the watermark.
  const viaE = await queryRelay(relayUrl, { kinds: [1985], '#e': [eventId], limit }, env, { collectAll: true, rejectOnPrematureClose: true });
  if (viaE.length >= limit) {
    throw new Error(`per-video label tally reached relay page limit (${limit}) for #e ${eventId}`);
  }
  for (const event of viaE) byId.set(event.id, event);
  if (addressableId) {
    const viaA = await queryRelay(relayUrl, { kinds: [1985], '#a': [addressableId], limit }, env, { collectAll: true, rejectOnPrematureClose: true });
    if (viaA.length >= limit) {
      throw new Error(`per-video label tally reached relay page limit (${limit}) for #a ${addressableId}`);
    }
    for (const event of viaA) byId.set(event.id, event);
  }
  return [...byId.values()];
}

export async function fetchNostrEventById(eventId, relays = ['wss://relay.divine.video'], env = {}, options = {}) {
  // Reject non-hex IDs to prevent path-traversal via attacker-controlled kind 5 e-tags
  if (!eventId || !/^[a-f0-9]{64}$/i.test(eventId)) return null;

  let anyDefinitiveResponse = false;
  let relaysAttempted = 0;

  for (const relayUrl of relays) {
    // Use Funnelcake's REST API (GET /api/event/{id}) instead of WebSocket REQ.
    // Faster (no upgrade handshake), works in local dev (Miniflare), and the
    // endpoint returns a raw Nostr event: { id, pubkey, created_at, kind, tags, content, sig }.
    const apiBaseUrl = relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
    relaysAttempted++;
    try {
      const headers = { 'Accept': 'application/json' };
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
        headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
      }
      const response = await fetch(`${apiBaseUrl}/api/event/${eventId}`, { headers });
      if (!response.ok) {
        // Only a genuine 404 is a definitive "not found". 401/403 (auth
        // blips), 5xx, and 429 are transient and must be retried, not read
        // as "event absent" — otherwise the sweep advances its watermark
        // past votes it never actually resolved.
        if (response.status === 404) anyDefinitiveResponse = true;
        continue;
      }
      // A 2xx counts as definitive only once we have the exact requested
      // signed event. Invalid JSON throws into the catch below (transient);
      // a wrong-id, malformed, or signature-invalid body fails the validator
      // and falls through to `continue` (transient). Neither is treated as
      // "event absent" — the caller must not act on an event it didn't ask for.
      const event = await response.json();
      if (isRequestedSignedEvent(event, eventId)) {
        anyDefinitiveResponse = true;
        return event;
      }
    } catch {
      continue;
    }
  }

  if (options.throwOnTransient && relaysAttempted > 0 && !anyDefinitiveResponse) {
    throw new Error(`All ${relaysAttempted} relay(s) returned transient errors for event ${eventId}`);
  }
  return null;
}
