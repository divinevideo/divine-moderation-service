#!/usr/bin/env node
// ABOUTME: Run EXPLAIN QUERY PLAN on the dashboard's hot queries and
// fail if any of them regress (temp B-tree sort, correlated subquery,
// missing index). Run after applying migration 009.
//
// Usage: node scripts/verify-query-plans.mjs [--remote|--local]
// Default: --remote.

import { execSync } from 'node:child_process';

const DB = 'blossom-webhook-events';
const flag = process.argv.includes('--local') ? '--local' : '--remote';

const QUERIES = [
  {
    name: 'list-by-action',
    sql: `EXPLAIN QUERY PLAN SELECT sha256 FROM moderation_results WHERE action='REVIEW' ORDER BY moderated_at DESC LIMIT 50`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_action_date'],
  },
  {
    name: 'flagged-count',
    sql: `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM moderation_results WHERE action='REVIEW' AND reviewed_by IS NULL`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_unreviewed'],
  },
  {
    name: 'uploader-history',
    sql: `EXPLAIN QUERY PLAN SELECT sha256 FROM moderation_results WHERE uploaded_by='abc' ORDER BY moderated_at DESC LIMIT 10`,
    forbid: ['TEMP B-TREE'],
    require: ['idx_moderation_uploaded_by_date'],
  },
  {
    name: 'latest-bunny-event-per-sha',
    sql: `EXPLAIN QUERY PLAN WITH ranked AS (
      SELECT sha256, received_at, ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC) AS rn
      FROM bunny_webhook_events
      WHERE sha256 IS NOT NULL AND status_name NOT IN ('error','deleted')
    ) SELECT sha256 FROM ranked WHERE rn = 1 ORDER BY received_at DESC LIMIT 50`,
    forbid: ['CORRELATED'],
    require: ['idx_bunny_events_sha256_received'],
  },
];

let failed = 0;
for (const q of QUERIES) {
  const out = execSync(
    `wrangler d1 execute ${DB} ${flag} --command ${JSON.stringify(q.sql)}`,
    { encoding: 'utf8' },
  );
  const missingForbid = q.forbid.filter((bad) => out.includes(bad));
  const missingRequire = q.require.filter((needle) => !out.includes(needle));
  const ok = missingForbid.length === 0 && missingRequire.length === 0;
  console.log(`${ok ? '✓' : '✗'} ${q.name}`);
  if (!ok) {
    if (missingForbid.length) console.log(`    forbidden phrases present: ${missingForbid.join(', ')}`);
    if (missingRequire.length) console.log(`    required phrases absent:   ${missingRequire.join(', ')}`);
    console.log(out.split('\n').filter((l) => l.includes('detail')).map((l) => `    ${l.trim()}`).join('\n'));
    failed++;
  }
}
process.exit(failed ? 1 : 0);
