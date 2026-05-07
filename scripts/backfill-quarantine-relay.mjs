// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: One-shot backfill — pushes existing QUARANTINE moderation_results rows
// ABOUTME: into funnelcake's quarantined_events_set so the relay matches Blossom.
//
// Usage:
//   FUNNELCAKE_ADMIN_URL=https://relay.divine.video \
//   NOSTR_PRIVATE_KEY=<hex> \
//   node scripts/backfill-quarantine-relay.mjs [--dry-run] [--limit N] [--concurrency 5]
//
// Reads QUARANTINE rows from prod D1 via `wrangler d1 execute --remote`, then
// uses the same notifyRelay() helper as the worker to POST a NIP-98-signed
// add to /api/moderation/quarantine for each row that has an event_id.
//
// Resumable: writes scripts/.backfill-quarantine-relay.checkpoint with the
// list of sha256s already processed; rerun skips them.

import { notifyRelay } from '../src/relay-notifier.mjs';

const D1_DATABASE = 'blossom-webhook-events';

export function parseArgs(argv) {
  const out = { dryRun: false, limit: null, concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
  }
  return out;
}

async function loadCheckpoint(checkpointPath) {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(checkpointPath)) return new Set();
  return new Set(
    readFileSync(checkpointPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function appendCheckpoint(checkpointPath, sha256) {
  const { writeFileSync, existsSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  if (!existsSync(dirname(checkpointPath))) {
    mkdirSync(dirname(checkpointPath), { recursive: true });
  }
  writeFileSync(checkpointPath, `${sha256}\n`, { flag: 'a' });
}

async function fetchQuarantineRows() {
  const { execFileSync } = await import('node:child_process');
  const sql =
    "SELECT sha256, event_id FROM moderation_results " +
    "WHERE action = 'QUARANTINE' AND event_id IS NOT NULL AND event_id != ''";
  const stdout = execFileSync(
    'npx',
    ['--yes', 'wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json', `--command=${sql}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const parsed = JSON.parse(stdout);
  const results = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  if (!Array.isArray(results)) {
    throw new Error('Unexpected wrangler d1 output shape');
  }
  return results;
}

export async function processChunk(rows, env, dryRun, notify = notifyRelay) {
  return Promise.all(
    rows.map(async (row) => {
      if (dryRun) {
        return { row, result: { success: true, skipped: true, reason: 'dry-run' } };
      }
      const result = await notify(row.sha256, row.event_id, 'QUARANTINE', env);
      return { row, result };
    }),
  );
}

async function main() {
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __filename = fileURLToPath(import.meta.url);
  const checkpointPath = join(dirname(__filename), '.backfill-quarantine-relay.checkpoint');

  const args = parseArgs(process.argv.slice(2));
  const env = {
    FUNNELCAKE_ADMIN_URL: process.env.FUNNELCAKE_ADMIN_URL,
    NOSTR_PRIVATE_KEY: process.env.NOSTR_PRIVATE_KEY,
  };

  if (!env.FUNNELCAKE_ADMIN_URL) {
    console.error('Missing FUNNELCAKE_ADMIN_URL env var.');
    process.exit(1);
  }
  if (!env.NOSTR_PRIVATE_KEY && !args.dryRun) {
    console.error('Missing NOSTR_PRIVATE_KEY env var (required unless --dry-run).');
    process.exit(1);
  }

  console.log('[BACKFILL] Quarantine relay sync');
  console.log(`[BACKFILL] Admin URL: ${env.FUNNELCAKE_ADMIN_URL}`);
  console.log(`[BACKFILL] Dry-run: ${args.dryRun}`);
  console.log(`[BACKFILL] Concurrency: ${args.concurrency}`);
  console.log('');

  console.log('[BACKFILL] Fetching QUARANTINE rows from D1...');
  const all = await fetchQuarantineRows();
  console.log(`[BACKFILL] Total candidates: ${all.length}`);

  const done = await loadCheckpoint(checkpointPath);
  const todo = all.filter((row) => !done.has(row.sha256));
  console.log(`[BACKFILL] Already processed (checkpoint): ${done.size}`);
  console.log(`[BACKFILL] Remaining: ${todo.length}`);
  if (args.limit) {
    console.log(`[BACKFILL] Capping run at --limit ${args.limit}`);
  }
  const work = args.limit ? todo.slice(0, args.limit) : todo;
  console.log('');

  if (work.length === 0) {
    console.log('[BACKFILL] Nothing to do.');
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < work.length; i += args.concurrency) {
    const chunk = work.slice(i, i + args.concurrency);
    const results = await processChunk(chunk, env, args.dryRun);

    for (const { row, result } of results) {
      const short = row.sha256.substring(0, 16);
      if (result.success && !result.skipped) {
        ok++;
        if (!args.dryRun) await appendCheckpoint(checkpointPath, row.sha256);
        console.log(`  [OK]   ${short}... event=${row.event_id.substring(0, 16)}...`);
      } else if (result.success && result.skipped) {
        skipped++;
        if (!args.dryRun) await appendCheckpoint(checkpointPath, row.sha256);
        console.log(`  [SKIP] ${short}... ${result.reason || ''}`);
      } else {
        failed++;
        failures.push({ sha256: row.sha256, error: result.error });
        console.error(`  [FAIL] ${short}... ${result.error}`);
      }
    }

    // Light rate-limiting between chunks (funnelcake has its own limits).
    if (!args.dryRun && i + args.concurrency < work.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('[BACKFILL] Summary:');
  console.log(`  Processed:  ${work.length}`);
  console.log(`  Quarantined: ${ok}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log('');
    console.log('[BACKFILL] Failures (re-run to retry — successes are checkpointed):');
    for (const f of failures.slice(0, 25)) {
      console.log(`  ${f.sha256} - ${f.error}`);
    }
    if (failures.length > 25) {
      console.log(`  ... and ${failures.length - 25} more.`);
    }
    process.exit(1);
  }
}

// Only run main() when invoked directly, not when imported by tests.
async function isDirectInvocation() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  try {
    const { fileURLToPath } = await import('node:url');
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (await isDirectInvocation()) {
  main().catch((err) => {
    console.error('[BACKFILL] Fatal:', err);
    process.exit(1);
  });
}
