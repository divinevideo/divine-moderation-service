// ABOUTME: Re-queue failed moderation attempts to retry with updated provider
// ABOUTME: Reads failed:* keys from KV and re-queues videos for moderation

const WORKER_URL = process.env.WORKER_URL || 'https://divine-moderation-service.protestnet.workers.dev';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10)
  : null;

async function getFailedKeys() {
  // Use wrangler to list failed keys
  const { execSync } = await import('child_process');

  console.log('[REQUEUE] Fetching failed moderation keys from KV...');

  const result = execSync(
    'npx wrangler kv key list --binding MODERATION_KV --remote --prefix "failed:"',
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  const keys = JSON.parse(result);
  console.log(`[REQUEUE] Found ${keys.length} failed moderation keys`);

  return keys.map(k => k.name);
}

async function queueModeration(sha256) {
  const response = await fetch(`${WORKER_URL}/test-moderate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256 })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

async function deleteFailedKey(sha256) {
  const { execSync } = await import('child_process');

  execSync(
    `npx wrangler kv key delete --binding MODERATION_KV --remote "failed:${sha256}"`,
    { encoding: 'utf8' }
  );
}

async function main() {
  console.log('[REQUEUE] Re-queue Failed Moderations Script');
  console.log(`[REQUEUE] Worker URL: ${WORKER_URL}`);
  console.log(`[REQUEUE] Batch size: ${BATCH_SIZE}`);
  console.log(`[REQUEUE] Delay between requests: ${DELAY_MS}ms`);
  console.log(`[REQUEUE] Dry run: ${DRY_RUN}`);
  if (LIMIT) console.log(`[REQUEUE] Limit: ${LIMIT}`);
  console.log('');

  const failedKeys = await getFailedKeys();

  const toProcess = LIMIT ? failedKeys.slice(0, LIMIT) : failedKeys;
  console.log(`[REQUEUE] Will process ${toProcess.length} failed videos`);
  console.log('');

  const stats = {
    total: toProcess.length,
    queued: 0,
    errors: 0
  };

  for (let i = 0; i < toProcess.length; i++) {
    const key = toProcess[i];
    const sha256 = key.replace('failed:', '');

    try {
      if (DRY_RUN) {
        console.log(`[REQUEUE] [DRY-RUN] Would queue: ${sha256.substring(0, 16)}...`);
      } else {
        await queueModeration(sha256);
        console.log(`[REQUEUE] [${i + 1}/${toProcess.length}] Queued: ${sha256.substring(0, 16)}...`);
        stats.queued++;

        // Wait between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    } catch (error) {
      console.error(`[REQUEUE] [${i + 1}/${toProcess.length}] Error: ${sha256.substring(0, 16)}... - ${error.message}`);
      stats.errors++;
    }

    // Progress update every 100
    if ((i + 1) % 100 === 0) {
      console.log(`[REQUEUE] Progress: ${i + 1}/${toProcess.length} (${stats.queued} queued, ${stats.errors} errors)`);
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('[REQUEUE] Summary:');
  console.log(`  Total failed videos: ${stats.total}`);
  console.log(`  Successfully queued: ${stats.queued}`);
  console.log(`  Errors: ${stats.errors}`);
  console.log('='.repeat(60));

  if (!DRY_RUN && stats.queued > 0) {
    console.log('');
    console.log('[REQUEUE] Note: Failed keys will be cleaned up automatically when');
    console.log('[REQUEUE] moderation succeeds. If it fails again, a new failed:');
    console.log('[REQUEUE] key will be created.');
  }
}

main().catch(error => {
  console.error('[REQUEUE] Fatal error:', error);
  process.exit(1);
});
