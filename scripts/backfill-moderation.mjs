// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Backfill script to moderate existing kind 34236 events from relay
// ABOUTME: Fetches events, extracts SHA256 from imeta tags, and queues for moderation

import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';

const CHECKPOINT_FILE = '.backfill-checkpoint.json';

function getApiToken(options = {}) {
  return options.apiToken || process.env.MODERATION_API_TOKEN || process.env.SERVICE_API_TOKEN || null;
}

/**
 * Load checkpoint from disk
 */
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[CHECKPOINT] Failed to load checkpoint:', error.message);
  }
  return null;
}

/**
 * Save checkpoint to disk
 */
function saveCheckpoint(checkpoint) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    console.log(`[CHECKPOINT] Saved progress: until=${new Date(checkpoint.currentUntil * 1000).toISOString()}, processed=${checkpoint.stats.totalVideos}`);
  } catch (error) {
    console.error('[CHECKPOINT] Failed to save checkpoint:', error.message);
  }
}

/**
 * Delete checkpoint file
 */
function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
      console.log('[CHECKPOINT] Cleared checkpoint file');
    }
  } catch (error) {
    console.error('[CHECKPOINT] Failed to clear checkpoint:', error.message);
  }
}

/**
 * Extract SHA256 from imeta tag parameters
 */
function extractSha256FromImeta(event) {
  if (!event || !event.tags) return null;

  for (const tag of event.tags) {
    if (tag[0] === 'imeta') {
      for (let i = 1; i < tag.length; i++) {
        const param = tag[i];
        if (param && param.startsWith('x ')) {
          return param.substring(2).trim();
        }
      }
    }
  }

  return null;
}

/**
 * Fetch kind 34236 events from relay with pagination support
 */
async function fetchEventsFromRelay(relayUrl, options = {}) {
  const { limit = 100, since = null, until = null } = options;

  return new Promise((resolve, reject) => {
    const events = [];
    let ws;

    const timeout = setTimeout(() => {
      if (ws) ws.close();
      reject(new Error('WebSocket timeout'));
    }, 30000);

    try {
      ws = new WebSocket(relayUrl);

      ws.on('open', () => {
        const subscriptionId = Math.random().toString(36).substring(7);
        const filter = {
          kinds: [34236],
          limit
        };

        // Add time filters if provided
        if (since !== null) filter.since = since;
        if (until !== null) filter.until = until;

        const reqMessage = JSON.stringify(['REQ', subscriptionId, filter]);

        const timeRange = since || until
          ? ` (${since ? `since=${new Date(since * 1000).toISOString()}` : ''} ${until ? `until=${new Date(until * 1000).toISOString()}` : ''})`
          : '';
        console.log(`[BACKFILL] Requesting ${limit} kind 34236 events from ${relayUrl}${timeRange}`);
        ws.send(reqMessage);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg[0] === 'EVENT') {
            const event = msg[2];
            events.push(event);
          }

          if (msg[0] === 'EOSE') {
            console.log(`[BACKFILL] Received ${events.length} events`);
            clearTimeout(timeout);
            ws.close();
            resolve(events);
          }
        } catch (err) {
          console.error('[BACKFILL] Failed to parse message:', err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

/**
 * Check if video has been moderated
 */
async function checkModerated(sha256, workerUrl) {
  const response = await fetch(`${workerUrl}/check-result/${sha256}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.moderated === true;
}

/**
 * Queue video for moderation
 */
async function queueModeration(sha256, workerUrl, apiToken) {
  if (!apiToken) {
    throw new Error('Missing API token. Set SERVICE_API_TOKEN or pass --token before queueing moderation.');
  }

  const response = await fetch(`${workerUrl}/test-moderate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    body: JSON.stringify({ sha256 })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Main backfill function with pagination support
 */
async function backfillModeration(options = {}) {
  const {
    relayUrl = 'wss://relay.divine.video',
    workerUrl = 'https://moderation-api.divine.video',
    batchSize = 100,
    maxTotal = null,
    since = null,
    until = null,
    dryRun = false,
    resume = true,
    countOnly = false
  } = options;
  const apiToken = getApiToken(options);

  if (!dryRun && !countOnly && !apiToken) {
    throw new Error('Missing API token. Set SERVICE_API_TOKEN or MODERATION_API_TOKEN, or pass --token.');
  }

  // Try to load checkpoint
  let checkpoint = null;
  if (resume) {
    checkpoint = loadCheckpoint();
    if (checkpoint) {
      console.log('[CHECKPOINT] Found existing checkpoint, resuming from previous run');
      console.log(`[CHECKPOINT] Previous progress: ${checkpoint.stats.totalVideos} videos processed`);
      console.log(`[CHECKPOINT] Resuming from: ${new Date(checkpoint.currentUntil * 1000).toISOString()}`);
      console.log('');
    }
  }

  console.log(`[BACKFILL] Starting backfill (batch: ${batchSize}, max: ${maxTotal || 'unlimited'}, dry-run: ${dryRun})`);
  console.log(`[BACKFILL] Relay: ${relayUrl}`);
  console.log(`[BACKFILL] Worker: ${workerUrl}`);
  if (since) console.log(`[BACKFILL] Since: ${new Date(since * 1000).toISOString()}`);
  if (until) console.log(`[BACKFILL] Until: ${new Date(until * 1000).toISOString()}`);
  console.log('');

  const globalStats = checkpoint ? checkpoint.stats : {
    totalEvents: 0,
    totalVideos: 0,
    alreadyModerated: 0,
    needsModeration: 0,
    queued: 0,
    failed: 0,
    batches: 0
  };

  let currentUntil = checkpoint ? checkpoint.currentUntil : until;
  let hasMore = true;

  // Paginate through events
  while (hasMore) {
    globalStats.batches++;
    console.log(`[BACKFILL] === Batch ${globalStats.batches} ===`);

    // Step 1: Fetch batch of events from relay
    const events = await fetchEventsFromRelay(relayUrl, {
      limit: batchSize,
      since,
      until: currentUntil
    });

    if (events.length === 0) {
      console.log('[BACKFILL] No more events found');
      hasMore = false;
      break;
    }

    globalStats.totalEvents += events.length;

    // Step 2: Extract SHA256s
    const videoData = [];
    for (const event of events) {
      const sha256 = extractSha256FromImeta(event);

      if (!sha256) {
        console.log(`[BACKFILL] ⚠️  Event ${event.id} has no SHA256 in imeta tag`);
        continue;
      }

      videoData.push({
        eventId: event.id,
        sha256,
        createdAt: event.created_at,
        event
      });
    }

    globalStats.totalVideos += videoData.length;
    console.log(`[BACKFILL] Extracted ${videoData.length} videos with SHA256 from ${events.length} events`);

    // Step 3: Process videos (skip if count-only mode)
    if (!countOnly) {
      for (const video of videoData) {
        try {
          const isModerated = await checkModerated(video.sha256, workerUrl);

          if (isModerated) {
            globalStats.alreadyModerated++;
            console.log(`[BACKFILL] ✓ ${video.sha256.substring(0, 16)}... already moderated`);
          } else {
            globalStats.needsModeration++;

            if (!dryRun) {
              await queueModeration(video.sha256, workerUrl, apiToken);
              globalStats.queued++;
              console.log(`[BACKFILL] ⏩ ${video.sha256.substring(0, 16)}... queued for moderation`);

              // Rate limit: 1 request per second
              await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
              console.log(`[BACKFILL] 🔍 ${video.sha256.substring(0, 16)}... needs moderation (dry-run, not queued)`);
            }
          }
        } catch (error) {
          globalStats.failed++;
          console.error(`[BACKFILL] ✗ ${video.sha256.substring(0, 16)}... error: ${error.message}`);
        }
      }
    } else {
      console.log(`[BACKFILL] 📊 Count-only mode: skipping moderation check`);
    }

    // Step 4: Check if we should continue
    if (maxTotal && globalStats.totalVideos >= maxTotal) {
      console.log(`[BACKFILL] Reached max total (${maxTotal})`);
      hasMore = false;
      break;
    }

    // Step 5: Update cursor for next batch (use oldest event's timestamp)
    if (videoData.length > 0) {
      const oldestTimestamp = Math.min(...videoData.map(v => v.createdAt));
      currentUntil = oldestTimestamp - 1; // Move cursor to just before oldest event
      console.log(`[BACKFILL] Next batch will fetch events until ${new Date(currentUntil * 1000).toISOString()}`);

      // Save checkpoint after each batch
      saveCheckpoint({
        currentUntil,
        stats: globalStats,
        timestamp: Date.now()
      });
    }

    // If we got fewer events than requested, we've reached the end
    if (events.length < batchSize) {
      console.log('[BACKFILL] Received fewer events than batch size, reached end');
      hasMore = false;
    }

    console.log('');
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('[BACKFILL] Final Summary:');
  console.log(`  Batches processed:     ${globalStats.batches}`);
  console.log(`  Total events:          ${globalStats.totalEvents}`);
  console.log(`  Total videos:          ${globalStats.totalVideos}`);
  console.log(`  Already moderated:     ${globalStats.alreadyModerated}`);
  console.log(`  Needs moderation:      ${globalStats.needsModeration}`);
  console.log(`  Queued for moderation: ${globalStats.queued}`);
  console.log(`  Failed:                ${globalStats.failed}`);
  console.log('='.repeat(60));

  // Cost estimate (HiveAI primary, Sightengine fallback)
  const moderatedCount = globalStats.queued;
  if (moderatedCount > 0) {
    console.log('');
    console.log('[COST] Moderation Cost Estimate:');
    console.log(`  Provider: HiveAI (primary), Sightengine (fallback)`);
    console.log(`  ${moderatedCount} videos queued for moderation`);
    console.log('');
    console.log('  HiveAI Cost:');
    console.log(`    - See https://thehive.ai/pricing for current rates`);
    console.log(`    - ${moderatedCount} videos queued`);
    console.log('');
    console.log('  Sightengine Cost (fallback only):');
    console.log(`    - Only charged if HiveAI fails`);
    console.log(`    - Fallback rate: ~1-5% of requests`);
    console.log(`    - Estimated Sightengine calls: ${Math.ceil(moderatedCount * 0.03)} (3% fallback estimate)`);
    console.log('='.repeat(60));
  }

  // Clear checkpoint on successful completion
  if (hasMore === false) {
    clearCheckpoint();
  }

  return globalStats;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--max-total' && args[i + 1]) {
      options.maxTotal = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--since' && args[i + 1]) {
      // Accept either unix timestamp or ISO date string
      const val = args[i + 1];
      options.since = val.includes('-') ? Math.floor(new Date(val).getTime() / 1000) : parseInt(val, 10);
      i++;
    } else if (args[i] === '--until' && args[i + 1]) {
      // Accept either unix timestamp or ISO date string
      const val = args[i + 1];
      options.until = val.includes('-') ? Math.floor(new Date(val).getTime() / 1000) : parseInt(val, 10);
      i++;
    } else if (args[i] === '--relay' && args[i + 1]) {
      options.relayUrl = args[i + 1];
      i++;
    } else if (args[i] === '--worker' && args[i + 1]) {
      options.workerUrl = args[i + 1];
      i++;
    } else if (args[i] === '--token' && args[i + 1]) {
      options.apiToken = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--count-only') {
      options.countOnly = true;
    } else if (args[i] === '--no-resume') {
      options.resume = false;
    } else if (args[i] === '--clear-checkpoint') {
      clearCheckpoint();
      console.log('Checkpoint cleared. Run again to start fresh.');
      process.exit(0);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/backfill-moderation.mjs [OPTIONS]

Options:
  --batch-size <n>      Number of events to fetch per batch (default: 100)
  --max-total <n>       Maximum total videos to process (default: unlimited)
  --since <timestamp>   Unix timestamp (exact seconds) - only fetch events after this time
  --until <timestamp>   Unix timestamp (exact seconds) - only fetch events before this time
  --relay <url>         Nostr relay URL (default: wss://relay.divine.video)
  --worker <url>        API URL (default: https://moderation-api.divine.video)
  --token <token>       Bearer token for authenticated API endpoints
  --dry-run             Check what would be moderated without actually queuing
  --count-only          Just count total videos, skip moderation checks (fast)
  --no-resume           Start from beginning, ignore saved checkpoint
  --clear-checkpoint    Delete checkpoint file and exit
  --help, -h            Show this help message

Checkpoint/Resume:
  The script automatically saves progress after each batch to .backfill-checkpoint.json
  If interrupted (Ctrl-C), you can resume by running the same command again.
  Use --no-resume to start fresh, or --clear-checkpoint to delete saved progress.

Examples:
  # Count total videos without checking moderation status (fast)
  node scripts/backfill-moderation.mjs --count-only

  # Dry-run first 500 videos
  node scripts/backfill-moderation.mjs --max-total 500 --dry-run

  # Process all videos (will auto-resume if interrupted)
  SERVICE_API_TOKEN=... node scripts/backfill-moderation.mjs

  # Process from specific timestamp (e.g., Dec 1, 2024 = 1733011200)
  node scripts/backfill-moderation.mjs --since 1733011200

  # Process 1000 videos in batches of 50
  node scripts/backfill-moderation.mjs --batch-size 50 --max-total 1000

  # Start fresh (ignore checkpoint)
  node scripts/backfill-moderation.mjs --no-resume

  # Clear saved progress
  node scripts/backfill-moderation.mjs --clear-checkpoint
      `);
      process.exit(0);
    }
  }

  backfillModeration(options)
    .then(() => {
      console.log('[BACKFILL] Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[BACKFILL] Fatal error:', error);
      process.exit(1);
    });
}

export { backfillModeration, fetchEventsFromRelay, extractSha256FromImeta };
