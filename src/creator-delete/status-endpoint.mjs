// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: GET /api/delete-status/{kind5_id} — NIP-98 author-only status query.
// ABOUTME: Reads creator_deletions D1 rows for the kind5_id, enforces caller matches the rows' creator_pubkey.

import { validateNip98Header } from './nip98.mjs';
import { readAllTargetsForKind5 } from './d1.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { measureDeletePhase, responsePerformance } from './performance.mjs';

const PER_PUBKEY_LIMIT = 120; // 2/sec average
const PER_IP_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

function measureStatusPhase(phase, run, classify) {
  return measureDeletePhase(phase, run, classify, { operation: 'delete_status' });
}

export async function handleStatusQuery(request, deps) {
  return measureStatusPhase('request', () => runStatusQuery(request, deps), responsePerformance);
}

async function runStatusQuery(request, deps) {
  const { db, kv } = deps;
  const url = new URL(request.url);
  const kind5_id = url.pathname.split('/').pop();

  if (!kind5_id || !/^[a-f0-9]{64}$/i.test(kind5_id)) {
    return jsonResponse(400, { error: 'Invalid kind5_id' });
  }

  // IP rate limit BEFORE NIP-98 validation to limit unauthenticated crypto work.
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipCheck = await measureStatusPhase('ip_rate_limit',
    () => checkRateLimit(kv, { key: `status-ip:${clientIp}`, limit: PER_IP_LIMIT, windowSeconds: RATE_WINDOW_SECONDS }),
    result => ({ outcome: result.allowed ? 'allowed' : 'limited' }));
  if (!ipCheck.allowed) {
    return jsonResponse(429, { error: 'Rate limit exceeded', retry_after_seconds: ipCheck.retryAfterSeconds || 0 });
  }

  const auth = await measureStatusPhase('auth',
    () => validateNip98Header(request.headers.get('Authorization'), url.toString(), 'GET'),
    result => ({ outcome: result.valid ? 'valid' : 'invalid' }));
  if (!auth.valid) {
    return jsonResponse(401, { error: `NIP-98 validation failed: ${auth.error}` });
  }

  const pubkeyCheck = await measureStatusPhase('pubkey_rate_limit',
    () => checkRateLimit(kv, { key: `status:${auth.pubkey}`, limit: PER_PUBKEY_LIMIT, windowSeconds: RATE_WINDOW_SECONDS }),
    result => ({ outcome: result.allowed ? 'allowed' : 'limited' }));
  if (!pubkeyCheck.allowed) {
    return jsonResponse(429, { error: 'Rate limit exceeded', retry_after_seconds: pubkeyCheck.retryAfterSeconds });
  }

  const rows = await measureStatusPhase('status_read', () => readAllTargetsForKind5(db, { kind5_id }),
    result => ({ outcome: result.length ? 'found' : 'missing' }));
  if (rows.length === 0) {
    return jsonResponse(404, { error: 'No processing record for this kind5_id' });
  }

  const notAuthoredByCaller = rows.find(r => r.creator_pubkey !== auth.pubkey);
  if (notAuthoredByCaller) {
    return jsonResponse(403, { error: 'Caller pubkey does not match kind 5 author' });
  }

  return measureStatusPhase('status_result', () => jsonResponse(200, {
    kind5_id,
    targets: rows.map(r => ({
      target_event_id: r.target_event_id,
      blob_sha256: r.blob_sha256,
      status: r.status,
      accepted_at: r.accepted_at,
      completed_at: r.completed_at,
      last_error: r.last_error
    }))
  }), () => ({
    outcome: rows.some(row => row.status.startsWith('failed:')) ? 'failed'
      : rows.every(row => row.status === 'success') ? 'success' : 'in_progress'
  }));
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
