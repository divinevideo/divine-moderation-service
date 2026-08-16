#!/usr/bin/env node
// ABOUTME: Migration script to move moderation results from KV to D1
// ABOUTME: Run with: node scripts/migrate-kv-to-d1.mjs

import { execSync } from 'child_process';

const BATCH_SIZE = 100;

async function runD1Command(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const result = execSync(
    `wrangler d1 execute blossom-webhook-events --remote --command "${escaped}" --json`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(result);
}

async function listKVKeys(prefix, cursor = null) {
  let cmd = `wrangler kv key list --namespace-id=10af689fc82140ed9159eef3c1c47079 --prefix="${prefix}"`;
  if (cursor) {
    cmd += ` --cursor="${cursor}"`;
  }
  const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(result);
}

async function getKVValue(key) {
  try {
    const result = execSync(
      `wrangler kv key get --namespace-id=10af689fc82140ed9159eef3c1c47079 "${key}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return result;
  } catch (e) {
    return null;
  }
}

async function migrate() {
  console.log('Starting KV to D1 migration...\n');

  // Get all moderation keys
  console.log('Fetching moderation keys from KV...');
  let allKeys = [];
  let cursor = null;
  let page = 0;

  do {
    const keys = await listKVKeys('moderation:', cursor);
    if (Array.isArray(keys)) {
      allKeys = allKeys.concat(keys);
      console.log(`  Page ${++page}: ${keys.length} keys (total: ${allKeys.length})`);
      break; // No cursor in simple list
    } else if (keys.result) {
      allKeys = allKeys.concat(keys.result);
      cursor = keys.cursor;
      console.log(`  Page ${++page}: ${keys.result.length} keys (total: ${allKeys.length})`);
    }
  } while (cursor);

  console.log(`\nFound ${allKeys.length} moderation results to migrate\n`);

  // Also get action-specific keys to determine current state
  console.log('Fetching action flags...');
  const reviewKeys = await listKVKeys('review:');
  const ageRestrictedKeys = await listKVKeys('age-restricted:');
  const permanentBanKeys = await listKVKeys('permanent-ban:');

  const reviewSet = new Set((Array.isArray(reviewKeys) ? reviewKeys : reviewKeys.result || []).map(k => k.name.replace('review:', '')));
  const ageRestrictedSet = new Set((Array.isArray(ageRestrictedKeys) ? ageRestrictedKeys : ageRestrictedKeys.result || []).map(k => k.name.replace('age-restricted:', '')));
  const permanentBanSet = new Set((Array.isArray(permanentBanKeys) ? permanentBanKeys : permanentBanKeys.result || []).map(k => k.name.replace('permanent-ban:', '')));

  console.log(`  Review flags: ${reviewSet.size}`);
  console.log(`  Age-restricted flags: ${ageRestrictedSet.size}`);
  console.log(`  Permanent-ban flags: ${permanentBanSet.size}`);

  // Migrate in batches
  let migrated = 0;
  let errors = 0;

  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    const values = [];

    for (const keyObj of batch) {
      const key = keyObj.name || keyObj;
      const sha256 = key.replace('moderation:', '');

      try {
        const valueStr = await getKVValue(key);
        if (!valueStr) continue;

        const value = JSON.parse(valueStr);

        // Determine current action from flags
        let action = value.action || 'SAFE';
        if (permanentBanSet.has(sha256)) action = 'PERMANENT_BAN';
        else if (ageRestrictedSet.has(sha256)) action = 'AGE_RESTRICTED';
        else if (reviewSet.has(sha256)) action = 'REVIEW';

        values.push({
          sha256,
          action,
          provider: value.provider || 'sightengine',
          scores: JSON.stringify(value.scores || {}),
          categories: JSON.stringify(value.categories || []),
          raw_response: JSON.stringify(value.rawResponse || value.raw || {}),
          moderated_at: value.moderatedAt || value.timestamp || new Date().toISOString()
        });
      } catch (e) {
        console.error(`  Error processing ${key}:`, e.message);
        errors++;
      }
    }

    if (values.length > 0) {
      // Build INSERT statement
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = values.flatMap(v => [
        v.sha256, v.action, v.provider, v.scores, v.categories, v.raw_response, v.moderated_at
      ]);

      // Use INSERT OR REPLACE to handle duplicates
      const sql = `INSERT OR REPLACE INTO moderation_results (sha256, action, provider, scores, categories, raw_response, moderated_at) VALUES ${values.map(v =>
        `('${v.sha256}', '${v.action}', '${v.provider}', '${v.scores.replace(/'/g, "''")}', '${v.categories.replace(/'/g, "''")}', '${v.raw_response.replace(/'/g, "''")}', '${v.moderated_at}')`
      ).join(', ')}`;

      try {
        await runD1Command(sql);
        migrated += values.length;
      } catch (e) {
        console.error(`  Batch insert error:`, e.message);
        errors += values.length;
      }
    }

    console.log(`Progress: ${Math.min(i + BATCH_SIZE, allKeys.length)}/${allKeys.length} (migrated: ${migrated}, errors: ${errors})`);
  }

  console.log(`\n✅ Migration complete!`);
  console.log(`   Migrated: ${migrated}`);
  console.log(`   Errors: ${errors}`);

  // Verify
  const countResult = await runD1Command('SELECT COUNT(*) as count FROM moderation_results');
  console.log(`   D1 row count: ${countResult[0]?.results?.[0]?.count || 'unknown'}`);
}

migrate().catch(console.error);
