// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: POST /api/delete/{kind5_id} — synchronous creator-delete handler.
// ABOUTME: NIP-98 author-only auth; accepts signed kind 5 or legacy relay lookup; runs processKind5 within budget.

import { validateNip98Header } from './nip98.mjs';
import { processKind5 } from './process.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { readDeleteBody, parseSignedDeleteEvent } from './request-event.mjs';

export const PER_PUBKEY_LIMIT = 5;
export const PER_IP_LIMIT = 30;
export const RATE_WINDOW_SECONDS = 60;

function logRequest(t0, kind5_id, status_code, extra = {}) {
  console.log(JSON.stringify({
    event: 'creator_delete.sync.request',
    status_code,
    latency_ms: Date.now() - t0,
    kind5_id: kind5_id || null,
    ...extra
  }));
}

export async function handleSyncDelete(request, deps) {
  const t0 = Date.now();
  const { db, kv, ctx, fetchKind5WithRetry, fetchTargetEvent, callBlossomDelete, budgetMs = 8000 } = deps;

  const url = new URL(request.url);
  const kind5_id = url.pathname.split('/').pop();

  if (!kind5_id || !/^[a-f0-9]{64}$/i.test(kind5_id)) {
    logRequest(t0, kind5_id, 400);
    return jsonResponse(400, { error: 'Invalid kind5_id' });
  }

  // IP rate limit BEFORE NIP-98 validation — limits crypto work from unauthenticated callers
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipCheck = await checkRateLimit(kv, { key: `ip:${clientIp}`, limit: PER_IP_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
  if (!ipCheck.allowed) {
    logRequest(t0, kind5_id, 429);
    return jsonResponse(429, {
      error: 'Rate limit exceeded',
      retry_after_seconds: ipCheck.retryAfterSeconds || 0
    });
  }

  let bodyBytes;
  try {
    bodyBytes = await readDeleteBody(request);
  } catch (error) {
    const status = error.status === 413 ? 413 : 400;
    logRequest(t0, kind5_id, status);
    return jsonResponse(status, { error: status === 413 ? 'Deletion request body exceeds 64 KiB' : 'Unable to read deletion request body' });
  }

  const auth = await validateNip98Header(request.headers.get('Authorization'), url.toString(), 'POST', bodyBytes);
  if (!auth.valid) {
    logRequest(t0, kind5_id, 401);
    return jsonResponse(401, { error: `NIP-98 validation failed: ${auth.error}` });
  }

  // Per-pubkey rate limit AFTER NIP-98 (pubkey only known after validation)
  const pubkeyCheck = await checkRateLimit(kv, { key: `pubkey:${auth.pubkey}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS });
  if (!pubkeyCheck.allowed) {
    logRequest(t0, kind5_id, 429);
    return jsonResponse(429, {
      error: 'Rate limit exceeded',
      retry_after_seconds: pubkeyCheck.retryAfterSeconds || 0
    });
  }

  // The publishing client already holds the signed event. Validate it directly
  // to avoid waiting for relay database visibility after publication succeeds.
  const supplied = bodyBytes.byteLength > 0;
  const kind5 = supplied
    ? parseSignedDeleteEvent(bodyBytes, kind5_id)
    : await fetchKind5WithRetry(kind5_id);
  if (supplied && !kind5) {
    logRequest(t0, kind5_id, 400);
    return jsonResponse(400, { error: 'Body must contain a valid signed kind 5 event matching the URL, with valid e-tags' });
  }
  if (!kind5) {
    logRequest(t0, kind5_id, 404);
    return jsonResponse(404, { error: 'Kind 5 not found on Funnelcake after retries' });
  }

  if (kind5.pubkey !== auth.pubkey) {
    logRequest(t0, kind5_id, 403);
    return jsonResponse(403, { error: 'Caller pubkey does not match kind 5 author' });
  }

  // Reject kind 5 with no e-tags upfront: produces no targets, would otherwise 200 with empty list
  const hasETag = (kind5.tags || []).some(t => t[0] === 'e' && t[1]);
  if (!hasETag) {
    logRequest(t0, kind5_id, 400, { reason: 'no_e_tags' });
    return jsonResponse(400, { error: 'Kind 5 event has no e-tags; nothing to delete' });
  }

  const processing = processKind5(kind5, {
    db,
    fetchTargetEvent,
    callBlossomDelete,
    triggerLabel: 'sync'
  });

  // When the budget elapses we return 202 and let processKind5 keep running.
  // ctx.waitUntil keeps the Worker alive past the Response; without it the
  // runtime cancels the promise mid-Blossom-call and recovery waits on the
  // next cron tick (~1 min latency).
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(processing.catch(err => {
      console.error(JSON.stringify({
        event: 'creator_delete.sync.waituntil_error',
        kind5_id,
        error: err?.message
      }));
    }));
  }

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ budgetExceeded: true }), budgetMs));
  const raceResult = await Promise.race([processing, timeoutPromise]);

  if (raceResult.budgetExceeded) {
    logRequest(t0, kind5_id, 202);
    return jsonResponse(202, {
      kind5_id,
      status: 'in_progress',
      poll_url: `/api/delete-status/${kind5_id}`
    });
  }

  const anyFailed = raceResult.targets.some(t => t.status.startsWith('failed:'));
  const anyInProgress = raceResult.targets.some(t => t.status === 'in_progress');

  if (anyInProgress) {
    logRequest(t0, kind5_id, 202);
    return jsonResponse(202, {
      kind5_id,
      status: 'in_progress',
      poll_url: `/api/delete-status/${kind5_id}`
    });
  }

  logRequest(t0, kind5_id, 200);
  return jsonResponse(200, {
    kind5_id,
    status: anyFailed ? 'failed' : 'success',
    targets: raceResult.targets
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
