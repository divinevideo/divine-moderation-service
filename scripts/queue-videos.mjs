#!/usr/bin/env node
// ABOUTME: Queue videos for moderation by fetching from Nostr relay
// ABOUTME: Supports filtering by client type (vine-archaeologist for old vines, openvine for new)

import { WebSocket } from 'ws';

const WORKER_URL = process.env.WORKER_URL || 'https://divine-moderation-service.protestnet.workers.dev';
const RELAY_URL = process.env.RELAY_URL || 'wss://relay.divine.video';
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);

// Parse arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const clientFilter = args.find(a => a.startsWith('--client='))?.split('=')[1] || null;
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

console.log('='.repeat(60));
console.log('Queue Videos for Moderation');
console.log('='.repeat(60));
console.log(`Relay: ${RELAY_URL}`);
console.log(`Worker: ${WORKER_URL}`);
console.log(`Client filter: ${clientFilter || 'all'}`);
console.log(`Limit: ${LIMIT || 'unlimited'}`);
console.log(`Dry run: ${DRY_RUN}`);
console.log('');

/**
 * Fetch kind 34236 events from relay
 */
async function fetchEventsFromRelay(limit = 1000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let ws;

    const timeout = setTimeout(() => {
      if (ws) ws.close();
      reject(new Error('WebSocket timeout'));
    }, 60000);

    try {
      ws = new WebSocket(RELAY_URL);

      ws.on('open', () => {
        const subscriptionId = Math.random().toString(36).substring(7);
        const reqMessage = JSON.stringify(['REQ', subscriptionId, { kinds: [34236], limit }]);
        console.log(`[RELAY] Requesting ${limit} events...`);
        ws.send(reqMessage);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg[0] === 'EVENT') {
            events.push(msg[2]);
          }
          if (msg[0] === 'EOSE') {
            console.log(`[RELAY] Received ${events.length} events`);
            clearTimeout(timeout);
            ws.close();
            resolve(events);
          }
        } catch (err) {
          console.error('[RELAY] Parse error:', err);
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
 * Extract video info from event
 */
function extractVideoInfo(event) {
  let sha256 = null;
  let client = null;
  let platform = null;
  let vineHashId = null;
  let publishedAt = null;

  for (const tag of event.tags) {
    const [key, value] = tag;
    switch (key) {
      case 'client':
        client = value;
        break;
      case 'platform':
        platform = value;
        break;
      case 'vine_hash_id':
        vineHashId = value;
        break;
      case 'published_at':
        publishedAt = parseInt(value, 10);
        break;
      case 'imeta':
        for (let i = 1; i < tag.length; i++) {
          const param = tag[i];
          if (param && param.startsWith('x ')) {
            sha256 = param.substring(2).trim();
          }
        }
        break;
    }
  }

  const isOriginalVine = platform === 'vine' || client === 'vine-archaeologist' || vineHashId || (publishedAt && publishedAt < 1514764800);

  return { sha256, client, platform, isOriginalVine, publishedAt, eventId: event.id };
}

/**
 * Check if video is already moderated
 */
async function checkModerated(sha256) {
  try {
    const response = await fetch(`${WORKER_URL}/check-result/${sha256}`);
    if (!response.ok) return false;
    const data = await response.json();
    return data.moderation !== null;
  } catch {
    return false;
  }
}

/**
 * Queue video for moderation
 */
async function queueModeration(sha256) {
  const response = await fetch(`${WORKER_URL}/test-moderate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256 })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

async function main() {
  // Fetch events
  const events = await fetchEventsFromRelay(2000);

  // Extract video info and filter
  const videos = events.map(extractVideoInfo).filter(v => v.sha256);
  console.log(`[INFO] Found ${videos.length} videos with SHA256`);

  // Filter by client if specified
  let filtered = videos;
  if (clientFilter) {
    filtered = videos.filter(v => v.client === clientFilter);
    console.log(`[INFO] Filtered to ${filtered.length} videos with client=${clientFilter}`);
  }

  // Apply limit
  if (LIMIT) {
    filtered = filtered.slice(0, LIMIT);
    console.log(`[INFO] Limited to ${filtered.length} videos`);
  }

  // Show breakdown
  const oldVines = filtered.filter(v => v.isOriginalVine).length;
  const newContent = filtered.length - oldVines;
  console.log(`[INFO] Old Vines: ${oldVines}, New content: ${newContent}`);
  console.log('');

  // Process
  const stats = { total: filtered.length, queued: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < filtered.length; i++) {
    const video = filtered[i];
    const progress = `[${i + 1}/${filtered.length}]`;
    const type = video.isOriginalVine ? '🍇 OLD' : '✨ NEW';

    try {
      const alreadyModerated = await checkModerated(video.sha256);

      if (alreadyModerated) {
        stats.skipped++;
        console.log(`${progress} ${type} ${video.sha256.substring(0, 16)}... SKIPPED (already moderated)`);
      } else if (DRY_RUN) {
        console.log(`${progress} ${type} ${video.sha256.substring(0, 16)}... WOULD QUEUE`);
      } else {
        await queueModeration(video.sha256);
        stats.queued++;
        console.log(`${progress} ${type} ${video.sha256.substring(0, 16)}... QUEUED`);
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    } catch (error) {
      stats.errors++;
      console.error(`${progress} ${type} ${video.sha256.substring(0, 16)}... ERROR: ${error.message}`);
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  Total videos: ${stats.total}`);
  console.log(`  Queued: ${stats.queued}`);
  console.log(`  Skipped (already moderated): ${stats.skipped}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
