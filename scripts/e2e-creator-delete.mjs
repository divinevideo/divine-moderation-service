#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: End-to-end test for the creator-delete pipeline (mod-service#101).
// ABOUTME: Operator-run. Exercises sync + cron paths against staging relay + prod Blossom + prod mod-service.

const DEFAULT_STAGING_RELAY = 'wss://relay.staging.divine.video';
const DEFAULT_FUNNELCAKE_API = 'https://funnelcake.staging.dvines.org';
const DEFAULT_BLOSSOM_BASE = 'https://media.divine.video';
const DEFAULT_MOD_SERVICE_BASE = 'https://moderation-api.divine.video';
const DEFAULT_D1_DATABASE = 'blossom-webhook-events';
const DEFAULT_CRON_WAIT_SECONDS = 180;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function getFlag(argv, name) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

function requireValue(raw, fieldName) {
  if (raw === true) throw new Error(`--${fieldName} requires a value (use --${fieldName}=<value>)`);
  return raw;
}

function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be positive integer)`);
  }
  return n;
}

export function parseArgs(argv) {
  const rawScenario = getFlag(argv, 'scenario');
  const scenario = rawScenario === null ? 'both' : requireValue(rawScenario, 'scenario');
  if (!['sync', 'cron', 'both'].includes(scenario)) {
    throw new Error(`Invalid scenario: ${scenario} (must be sync|cron|both)`);
  }

  const rawCron = getFlag(argv, 'cron-wait-seconds');
  const cronWaitSeconds = rawCron
    ? validatePositiveInt(requireValue(rawCron, 'cron-wait-seconds'), 'cron-wait-seconds')
    : DEFAULT_CRON_WAIT_SECONDS;

  const stagingRelay = getFlag(argv, 'staging-relay');
  const funnelcakeApi = getFlag(argv, 'funnelcake-api');
  const blossomBase = getFlag(argv, 'blossom-base');
  const modServiceBase = getFlag(argv, 'mod-service-base');
  const d1Database = getFlag(argv, 'd1-database');

  return {
    scenario,
    stagingRelay: stagingRelay ? requireValue(stagingRelay, 'staging-relay') : DEFAULT_STAGING_RELAY,
    funnelcakeApi: funnelcakeApi ? requireValue(funnelcakeApi, 'funnelcake-api') : DEFAULT_FUNNELCAKE_API,
    blossomBase: blossomBase ? requireValue(blossomBase, 'blossom-base') : DEFAULT_BLOSSOM_BASE,
    modServiceBase: modServiceBase ? requireValue(modServiceBase, 'mod-service-base') : DEFAULT_MOD_SERVICE_BASE,
    d1Database: d1Database ? requireValue(d1Database, 'd1-database') : DEFAULT_D1_DATABASE,
    cronWaitSeconds,
    skipCleanup: getFlag(argv, 'skip-cleanup') === true
  };
}

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

export function generateTestKey() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

// Minimal ISO-BMFF ftyp box so the payload at least looks like MP4 to a casual
// inspector. 1024 bytes total: 32-byte header + 992 bytes of random payload so
// each run has a unique sha256.
export function generateSyntheticBlob() {
  const header = new Uint8Array([
    // box size (32 bytes)
    0x00, 0x00, 0x00, 0x20,
    // 'ftyp'
    0x66, 0x74, 0x79, 0x70,
    // major brand 'isom'
    0x69, 0x73, 0x6f, 0x6d,
    // minor version (0x00000200)
    0x00, 0x00, 0x02, 0x00,
    // compatible brands: 'isom', 'iso2', 'avc1', 'mp41'
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31,
    0x6d, 0x70, 0x34, 0x31
  ]);
  const payload = randomBytes(992);
  const bytes = new Uint8Array(1024);
  bytes.set(header, 0);
  bytes.set(payload, 32);
  const sha256 = bytesToHex(sha256Hash(bytes));
  return { bytes, sha256 };
}

/**
 * Build and sign a kind 34236 event that passes Funnelcake's validation at
 * divine-funnelcake/crates/relay/src/relay.rs:1023-1087.
 *
 * Required: d (unique), title, imeta with url+x+m (each space-delimited item
 * per validate_imeta_format), and a thumb-equivalent. Thumb URL does not need
 * to resolve.
 */
export function buildKind34236Event(sk, sha256, cfg) {
  const blobUrl = `${cfg.blossomBase}/${sha256}`;
  const thumbUrl = `${cfg.blossomBase}/${sha256}.jpg`;
  // Unique d tag per run: timestamp + random suffix ensures no collision across
  // concurrent or rapid-fire test runs with the same key (not our normal case
  // but cheap to defend against).
  const dTag = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return finalizeEvent({
    kind: 34236,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', dTag],
      ['title', 'creator-delete e2e test video'],
      ['imeta', `url ${blobUrl}`, `x ${sha256}`, `m video/mp4`],
      ['thumb', thumbUrl]
    ],
    content: 'Synthetic 1KB test blob published by scripts/e2e-creator-delete.mjs'
  }, sk);
}

/**
 * Classify a GET https://media.divine.video/<sha256> response after the
 * pipeline has completed. 404/410 → bytes physically deleted (ENABLE_PHYSICAL_DELETE
 * was on). 200 → bytes still present (flag was off, soft-delete state). Both
 * are acceptable pass conditions for the script; the kind is recorded in the
 * JSONL output. Anything else is treated as an unexpected state.
 */
export function classifyByteProbeResponse(status) {
  if (status === 404 || status === 410) return { kind: 'bytes_gone', flagStateInferred: 'on' };
  if (status === 200) return { kind: 'bytes_present', flagStateInferred: 'off' };
  return { kind: 'unknown', status };
}

/**
 * Default runner used when the script runs as a CLI. Tests inject a fake.
 * Uses spawnSync (args is an array, not a string — no shell interpretation).
 * The node:child_process import is deferred via dynamic import() so the
 * Cloudflare Workers vitest pool does not try to resolve it at module-load
 * time (nodejs_compat does not expose child_process there).
 */
export async function defaultRunner({ command, args }) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 0 };
}

function validateHex64(value, fieldName) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be 64-char lowercase hex)`);
  }
  return value;
}

export async function cleanupD1Row(kind5_id, target_event_id, cfg, runner = defaultRunner) {
  validateHex64(kind5_id, 'kind5_id');
  validateHex64(target_event_id, 'target_event_id');
  const sql = `DELETE FROM creator_deletions WHERE kind5_id = '${kind5_id}' AND target_event_id = '${target_event_id}';`;
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

/**
 * Fully purge the single blob owned by the test pubkey.
 *
 * Uses POST /admin/api/vanish (verified at divine-blossom/src/main.rs:209 →
 * handle_admin_vanish, src/main.rs:3975 → execute_vanish). For a fresh
 * ephemeral pubkey that owns exactly one blob, this is surgical: full GCS +
 * KV + VCL purge of the test blob and nothing else.
 *
 * Expects a successful vanish to return { vanished: true, fully_deleted, unlinked, errors }.
 * fully_deleted:0 is acceptable (pipeline may have already purged the blob).
 * errors > 0 indicates Blossom couldn't fully process; surface as failure.
 */
export async function cleanupBlossomVanish(testPubkey, cfg, fetchImpl = fetch) {
  if (!cfg.blossomWebhookSecret) {
    throw new Error('cleanupBlossomVanish: cfg.blossomWebhookSecret is required');
  }
  const res = await fetchImpl(`${cfg.blossomBase}/admin/api/vanish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.blossomWebhookSecret}`
    },
    body: JSON.stringify({ pubkey: testPubkey, reason: 'e2e-test cleanup' })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blossom vanish failed: HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  const out = {
    fullyDeleted: body.fully_deleted ?? 0,
    unlinked: body.unlinked ?? 0,
    errors: body.errors ?? 0
  };
  if (out.errors > 0) {
    throw new Error(`Blossom vanish reported errors:${out.errors} fully_deleted:${out.fullyDeleted} unlinked:${out.unlinked}`);
  }
  return out;
}

/**
 * BUD-01 upload authorization. Signed kind 24242 event with:
 *   - t tag: "upload"
 *   - x tag: sha256 of the payload
 *   - expiration tag: unix timestamp (5 minutes from now)
 */
export function buildBud01UploadAuth(sk, sha256) {
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['x', sha256],
      ['expiration', String(expiration)]
    ],
    content: 'creator-delete e2e test upload'
  }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

export async function uploadToBlossom(bytes, sha256, sk, cfg, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.blossomBase}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: buildBud01UploadAuth(sk, sha256),
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.length)
    },
    body: bytes
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blossom upload failed: HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  // Return the server-confirmed sha, not the caller-provided value.
  // Any mismatch between them means either our local hash is wrong or
  // Blossom rehashed the bytes under a different content type; either
  // case should surface loudly rather than silently propagate the
  // caller's claim through the rest of the pipeline. A missing
  // body.sha256 is also a contract break worth raising here.
  if (!body.sha256 || typeof body.sha256 !== 'string') {
    throw new Error(`Blossom upload response missing sha256 field: ${JSON.stringify(body)}`);
  }
  return { url: body.url || `${cfg.blossomBase}/${body.sha256}`, sha256: body.sha256 };
}

/**
 * Poll Funnelcake REST GET /api/event/{id} until 200 or timeout.
 * Catches ClickHouse batch-flush + MergeTree dedup propagation lag.
 */
export async function waitForIndexing(eventId, cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  const url = `${cfg.funnelcakeApi}/api/event/${eventId}`;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.ok) return { polls };
    if (res.status !== 404) {
      const text = await res.text();
      throw new Error(`Funnelcake /api/event/${eventId} HTTP ${res.status}: ${text}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms: event ${eventId} not indexed by Funnelcake`);
}

/**
 * Publish a signed Nostr event to a relay over WebSocket. Resolves with the
 * event id on OK=true; throws on relay rejection or timeout.
 *
 * The WebSocket lives only for the duration of the publish. The ws library
 * is imported dynamically so the Workers test pool doesn't trip on it at
 * module-load time.
 */
export async function publishEvent(event, relayUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const WsCtor = opts.WebSocket || (await import('ws')).WebSocket;
  return await new Promise((resolve, reject) => {
    const ws = new WsCtor(relayUrl);
    let settled = false;

    // Centralize socket teardown and promise settlement so every exit
    // path (OK=true, OK=false, error, close, timeout) releases the
    // socket exactly once and no later handlers mutate the outcome.
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new Error(`publish timeout after ${timeoutMs}ms: ${event.id}`)));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg[0] === 'OK' && msg[1] === event.id) {
        if (msg[2] === true) {
          done(() => resolve(event.id));
        } else {
          done(() => reject(new Error(`relay rejected ${event.id}: ${msg[3] || 'unknown'}`)));
        }
      }
    });
    ws.on('error', (err) => {
      done(() => reject(new Error(`WebSocket error: ${err.message}`)));
    });
    // Early-close handler: if the relay disconnects before sending OK,
    // surface a concrete publish failure instead of waiting for the
    // generic timeout. If we already resolved/rejected, this is a no-op.
    ws.on('close', (code, reason) => {
      done(() => reject(new Error(`WebSocket closed before OK for ${event.id} (code=${code}${reason ? `, reason=${reason}` : ''})`)));
    });
  });
}

import { signNip98Header } from './sign-nip98.mjs';

export async function callSyncEndpoint(sk, kind5Event, cfg, fetchImpl = fetch) {
  const url = `${cfg.modServiceBase}/api/creator-delete/sync`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: signNip98Header(sk, url, 'POST')
    },
    body: JSON.stringify(kind5Event)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sync endpoint HTTP ${res.status}: ${text}`);
  }
  return await res.json();
}

/**
 * Poll the status endpoint until the row reaches a terminal status
 * (success OR failed:*). Returns the final body so the caller can distinguish.
 *
 * Re-signs NIP-98 per poll so the signature stays fresh and the `u` tag always
 * matches the request URL exactly (see PR #104 URL-normalization fix).
 */
export async function pollStatus(sk, kind5Id, cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const url = `${cfg.modServiceBase}/api/creator-delete/status/${kind5Id}`;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: signNip98Header(sk, url, 'GET') }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`status endpoint HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.status === 'success' || (typeof body.status === 'string' && body.status.startsWith('failed:'))) {
      return { ...body, polls };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms: kind5 ${kind5Id} did not reach terminal status. Common cause: CREATOR_DELETE_PIPELINE_ENABLED may be unset on the prod worker.`);
}

/**
 * Verify that the pipeline completed successfully:
 * - D1 row exists with status='success'
 * - blob_sha256 matches the expected value
 * - Blossom byte probe indicates the final state (bytes_gone or bytes_present)
 *
 * Returns { d1Status, byteProbe } for caller to record in JSONL output.
 * byteProbe.kind is 'bytes_gone' (flag was on) or 'bytes_present' (flag was off).
 * Both are acceptable final states; the test records which one actually occurred.
 */
export async function assertD1AndBlossomState(kind5Id, expectedSha, cfg, deps = {}) {
  validateHex64(kind5Id, 'kind5_id');
  validateHex64(expectedSha, 'expectedSha');

  const runner = deps.runner || defaultRunner;
  const fetchImpl = deps.fetchImpl || fetch;

  // (a) D1 row check
  const sql = `SELECT kind5_id, target_event_id, blob_sha256, status FROM creator_deletions WHERE kind5_id = '${kind5Id}';`;
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const parsed = JSON.parse(r.stdout);
  const rows = (parsed?.[0]?.results) || [];
  if (rows.length === 0) {
    throw new Error(`D1 row not found for kind5_id=${kind5Id}`);
  }
  const row = rows[0];
  if (row.status !== 'success') {
    throw new Error(`expected D1 status='success', got status=${row.status}`);
  }
  if (row.blob_sha256 !== expectedSha) {
    throw new Error(`blob_sha256 mismatch: D1 has ${row.blob_sha256}, expected ${expectedSha}`);
  }

  // (b) Blossom byte probe
  const probe = await fetchImpl(`${cfg.blossomBase}/${expectedSha}`, { method: 'GET' });
  const byteProbe = classifyByteProbeResponse(probe.status);
  if (byteProbe.kind === 'unknown') {
    throw new Error(`Blossom byte probe returned unknown status: ${probe.status}`);
  }

  return { d1Status: row.status, byteProbe };
}

function nowIso() { return new Date().toISOString(); }

function emit(obj) { console.log(JSON.stringify(obj)); }

async function runScenario(name, cfg, deps, opts) {
  const { sk, pubkey } = (deps.generateTestKey || generateTestKey)();
  const blob = (deps.generateSyntheticBlob || generateSyntheticBlob)();
  const started = Date.now();
  let kind5Id = null;
  let target = null;
  let assertResult = null;
  let outcome = 'pass';
  let failureReason = null;
  // Hoisted so it is accessible in cleanup and return after the try block.
  // Upload.sha256 (server-confirmed) is the canonical sha; falls back to blob.sha256
  // if upload hasn't run yet (shouldn't happen in normal flow).
  let blobSha256 = blob.sha256;

  try {
    // 1. Upload
    const upload = await (deps.uploadToBlossom || uploadToBlossom)(blob.bytes, blob.sha256, sk, cfg, deps.fetchImpl);
    // Use upload.sha256 (server-confirmed) as the canonical sha for all downstream assertions.
    // This ensures injected uploadToBlossom can control which sha flows through the scenario.
    blobSha256 = upload.sha256;
    emit({ ts: nowIso(), scenario: name, step: 'upload', ok: true, sha256: blobSha256, bytes: blob.bytes.length });

    // 2. Publish kind 34236
    const event = buildKind34236Event(sk, blobSha256, cfg);
    target = await (deps.publishEvent || publishEvent)(event, cfg.stagingRelay);
    emit({ ts: nowIso(), scenario: name, step: 'publish_kind34236', ok: true, event_id: target });

    // 3. Wait for Funnelcake to index it
    const indexing = await (deps.waitForIndexing || waitForIndexing)(target, cfg, { fetchImpl: deps.fetchImpl });
    emit({ ts: nowIso(), scenario: name, step: 'wait_indexing', ok: true, polls: indexing.polls });

    // 4. Publish kind 5
    const kind5Event = finalizeEvent({
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', target], ['k', '34236'], ['client', 'diVine']],
      content: 'e2e test delete'
    }, sk);
    kind5Id = await (deps.publishEvent || publishEvent)(kind5Event, cfg.stagingRelay);
    emit({ ts: nowIso(), scenario: name, step: 'publish_kind5', ok: true, kind5_id: kind5Id });

    // 5. Sync (sync scenario only)
    if (opts.callSync) {
      await (deps.callSyncEndpoint || callSyncEndpoint)(sk, kind5Event, cfg, deps.fetchImpl);
      emit({ ts: nowIso(), scenario: name, step: 'call_sync', ok: true });
    }

    // 6. Poll status
    const pollOpts = {
      fetchImpl: deps.fetchImpl,
      timeoutMs: opts.statusTimeoutMs,
      pollIntervalMs: opts.statusPollIntervalMs
    };
    const status = await (deps.pollStatus || pollStatus)(sk, kind5Id, cfg, pollOpts);
    emit({ ts: nowIso(), scenario: name, step: 'poll_status', ok: status.status === 'success', terminal_status: status.status, polls: status.polls });
    if (status.status !== 'success') {
      throw new Error(`pipeline failed: ${status.status}`);
    }

    // 7. Assert D1 + Blossom state
    assertResult = await (deps.assertD1AndBlossomState || assertD1AndBlossomState)(kind5Id, blobSha256, cfg, { runner: deps.runner, fetchImpl: deps.fetchImpl });
    emit({ ts: nowIso(), scenario: name, step: 'assert_d1_and_blossom', ok: true, d1_status: assertResult.d1Status, byte_probe: assertResult.byteProbe.kind });
  } catch (err) {
    outcome = 'fail';
    failureReason = err.message;
    emit({ ts: nowIso(), scenario: name, step: 'failure', ok: false, error: err.message });
  }

  // 8. Cleanup (always, unless --skip-cleanup)
  let cleanup = null;
  if (cfg.skipCleanup) {
    cleanup = { skipped: true };
    emit({ ts: nowIso(), scenario: name, step: 'cleanup', ok: true, skipped: true });
  } else {
    cleanup = { blossom: null, d1: null };
    try {
      cleanup.blossom = await (deps.cleanupBlossomVanish || cleanupBlossomVanish)(pubkey, cfg, deps.fetchImpl);
      emit({ ts: nowIso(), scenario: name, step: 'cleanup_blossom', ok: true, ...cleanup.blossom });
    } catch (err) {
      cleanup.blossom = { ok: false, error: err.message };
      emit({ ts: nowIso(), scenario: name, step: 'cleanup_blossom', ok: false, error: err.message });
    }
    if (kind5Id && target) {
      try {
        await (deps.cleanupD1Row || cleanupD1Row)(kind5Id, target, cfg, deps.runner);
        cleanup.d1 = { ok: true };
        emit({ ts: nowIso(), scenario: name, step: 'cleanup_d1', ok: true });
      } catch (err) {
        cleanup.d1 = { ok: false, error: err.message };
        emit({ ts: nowIso(), scenario: name, step: 'cleanup_d1', ok: false, error: err.message });
      }
    } else {
      cleanup.d1 = { ok: true, skipped: 'no kind5/target' };
    }
  }

  const totalDurationMs = Date.now() - started;
  emit({ ts: nowIso(), scenario: name, outcome, total_duration_ms: totalDurationMs });
  return { outcome, failureReason, cleanup, pubkey, sha256: blobSha256, kind5Id, target, totalDurationMs };
}

export async function runSyncScenario(cfg, deps = {}) {
  return runScenario('sync', cfg, deps, { callSync: true, statusTimeoutMs: 60000, statusPollIntervalMs: 2000 });
}

export async function runCronScenario(cfg, deps = {}) {
  return runScenario('cron', cfg, deps, { callSync: false, statusTimeoutMs: cfg.cronWaitSeconds * 1000, statusPollIntervalMs: 3000 });
}

export function computeExitCode(results) {
  const anyFailed = results.some(r => r.outcome === 'fail');
  if (anyFailed) return 1;
  const anyCleanupFailed = results.some(r => {
    if (r.cleanup?.skipped) return false;
    if (r.cleanup?.blossom?.ok === false) return true;
    if (r.cleanup?.blossom?.errors > 0) return true;
    if (r.cleanup?.d1?.ok === false) return true;
    return false;
  });
  if (anyCleanupFailed) return 3;
  return 0;
}

export function printSummary(results, cfg = {}) {
  // Fall back to defaults only when cfg is absent (e.g. older callers).
  // The live main() flow always passes cfg so the manual-cleanup
  // commands render against the target the script actually ran against.
  const blossomBase = cfg.blossomBase || DEFAULT_BLOSSOM_BASE;
  const d1Database = cfg.d1Database || DEFAULT_D1_DATABASE;
  console.error('\n=== E2E SUMMARY ===');
  for (const r of results) {
    const seconds = (r.totalDurationMs / 1000).toFixed(1);
    const label = r.outcome.toUpperCase();
    const detail = r.outcome === 'fail' ? `  (${r.failureReason})` : '';
    console.error(`Scenario: ${r.scenario.padEnd(6)}${label}  ${seconds}s${detail}`);
  }

  const artifacts = results.filter(r => !r.cleanup?.skipped);
  if (artifacts.length > 0) {
    console.error('\n=== ARTIFACTS (cleaned) ===');
    for (const r of artifacts) {
      const blossom = r.cleanup?.blossom?.ok === false
        ? `vanish=FAILED:${r.cleanup.blossom.error}`
        : `vanish=fully_deleted:${r.cleanup.blossom?.fullyDeleted ?? '?'}`;
      const d1 = r.cleanup?.d1?.ok === false ? `d1=FAILED:${r.cleanup.d1.error}` : 'd1=cleaned';
      console.error(`sha=${r.sha256}  kind5=${r.kind5Id || '-'}  ${blossom}  ${d1}  (${r.scenario})`);
    }
  }

  const manual = results.filter(r => {
    if (r.cleanup?.skipped) return false;
    return r.cleanup?.blossom?.ok === false || r.cleanup?.d1?.ok === false;
  });
  console.error('\n=== MANUAL CLEANUP NEEDED ===');
  if (manual.length === 0) {
    console.error('(none)');
  } else {
    for (const r of manual) {
      if (r.cleanup?.blossom?.ok === false) {
        console.error(`sha=${r.sha256} pubkey=${r.pubkey} (${r.scenario})`);
        console.error(`  curl -X POST -H "Authorization: Bearer $BLOSSOM_WEBHOOK_SECRET" \\`);
        console.error(`       ${blossomBase}/admin/api/vanish \\`);
        console.error(`       -d '{"pubkey":"${r.pubkey}","reason":"e2e-test manual cleanup"}'`);
      }
      if (r.cleanup?.d1?.ok === false) {
        console.error(`  wrangler d1 execute ${d1Database} --remote \\`);
        console.error(`       --command "DELETE FROM creator_deletions WHERE kind5_id='${r.kind5Id}' AND target_event_id='${r.target}';"`);
      }
    }
  }

  const code = computeExitCode(results);
  console.error(`\nExit: ${code}`);
}

function readBlossomSecret(deps) {
  if (deps.blossomWebhookSecret) return deps.blossomWebhookSecret;
  const env = deps.env || (typeof process !== 'undefined' ? process.env : {});
  const s = env.BLOSSOM_WEBHOOK_SECRET;
  if (!s) throw new Error('BLOSSOM_WEBHOOK_SECRET env var is required');
  return s;
}

export async function main(argv, deps = {}) {
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    console.error(`arg error: ${e.message}`);
    return 2;
  }

  // BLOSSOM_WEBHOOK_SECRET only gates /admin/api/vanish cleanup. The
  // documented --skip-cleanup inspection mode intentionally leaves
  // artifacts in place, so requiring the secret there made the
  // no-cleanup path depend on a prod admin credential it never used.
  if (!cfg.skipCleanup) {
    try {
      cfg.blossomWebhookSecret = readBlossomSecret(deps);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
  }

  const results = [];
  if (cfg.scenario === 'sync' || cfg.scenario === 'both') {
    const r = await runSyncScenario(cfg, deps);
    results.push({ ...r, scenario: 'sync' });
  }
  if (cfg.scenario === 'cron' || cfg.scenario === 'both') {
    const r = await runCronScenario(cfg, deps);
    results.push({ ...r, scenario: 'cron' });
  }

  printSummary(results, cfg);
  return computeExitCode(results);
}

// CLI entrypoint — runs only when invoked directly (not when imported by tests).
const isMain = typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`unexpected error: ${err.stack || err.message}\n`);
      process.exit(99);
    }
  );
}
