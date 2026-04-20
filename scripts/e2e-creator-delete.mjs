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
  return { url: body.url || `${cfg.blossomBase}/${sha256}`, sha256 };
}
