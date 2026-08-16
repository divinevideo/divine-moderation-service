#!/usr/bin/env node
// ABOUTME: Run the KV to D1 migration by calling the Worker endpoint in batches
// ABOUTME: Usage: node scripts/run-migration.mjs [--batch-size=500]

const BASE_URL = 'https://moderation.admin.divine.video';
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '500');

async function runMigration() {
  console.log(`Starting KV to D1 migration...`);
  console.log(`Endpoint: ${BASE_URL}/admin/api/migrate-kv`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  let cursor = null;
  let totalMigrated = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    console.log(`\n--- Batch ${batchNum} ---`);

    const response = await fetch(`${BASE_URL}/admin/api/migrate-kv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, batchSize: BATCH_SIZE })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Error: ${response.status} - ${text}`);

      if (response.status === 401 || response.status === 403) {
        console.error('\nAuthentication required. You need to:');
        console.error('1. Add a bypass policy in Zero Trust for /admin/api/migrate-kv');
        console.error('2. Or run this from the Workers dashboard using a test');
        console.error('3. Or use wrangler tail to watch logs while triggering from browser');
      }
      break;
    }

    const result = await response.json();
    console.log(`Migrated: ${result.migrated} records`);
    totalMigrated += result.migrated;

    if (result.done) {
      console.log(`\n✅ Migration complete!`);
      console.log(`Total migrated: ${totalMigrated} records`);
      break;
    }

    cursor = result.cursor;
    console.log(`Progress: ${totalMigrated} total, continuing...`);

    // Small delay to avoid overwhelming the worker
    await new Promise(r => setTimeout(r, 100));
  }
}

runMigration().catch(console.error);
