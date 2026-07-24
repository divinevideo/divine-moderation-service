// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron work for creator-delete pipeline — pulls kind 5 from Funnelcake, retries transient failures.
// ABOUTME: Runs every minute via wrangler.toml [triggers] crons entry; dispatched in scheduled(event, env, ctx).

import { processKind5 } from './process.mjs';
import { MAX_RETRY_COUNT } from './d1.mjs';

const LAST_POLL_KEY = 'creator-delete-cron:last-poll';
const DEFAULT_LOOKBACK_SECONDS = 3600; // first run
const POLL_OVERLAP_SECONDS = 300;

function countProcessedTargets(result) {
  return (result.targets || []).filter(target => !target.skipped).length;
}

export async function runCreatorDeleteCron(deps) {
  const { db, kv, queryKind5Since, fetchTargetEvent, callBlossomDelete, now = () => Date.now() } = deps;
  const nowMs = now();

  const lastPollRaw = await kv.get(LAST_POLL_KEY);
  const sinceMs = lastPollRaw
    ? Number(lastPollRaw) - (POLL_OVERLAP_SECONDS * 1000)
    : nowMs - (DEFAULT_LOOKBACK_SECONDS * 1000);
  const sinceSeconds = Math.floor(sinceMs / 1000);

  let processed = 0;
  const errors = [];

  const transientRows = await db.prepare(
    `SELECT kind5_id, target_event_id, creator_pubkey, status, retry_count, accepted_at
     FROM creator_deletions
     WHERE status LIKE 'failed:transient:%' AND retry_count < ?`
  ).bind(MAX_RETRY_COUNT).all();

  let querySucceeded = false;
  try {
    const events = await queryKind5Since(sinceSeconds);
    querySucceeded = true;
    for (const kind5 of events) {
      try {
        const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now, triggerLabel: 'cron' });
        const processedTargets = countProcessedTargets(result);
        if (processedTargets === 0) continue;
        const lagSeconds = Math.max(0, Math.floor(now() / 1000) - (kind5.created_at || 0));
        console.log(JSON.stringify({
          event: 'creator_delete.cron.kind5_lag',
          kind5_id: kind5.id,
          lag_seconds: lagSeconds
        }));
        processed += processedTargets;
      } catch (e) {
        errors.push({ kind5_id: kind5.id, error: e.message });
      }
    }
  } catch (e) {
    errors.push({ stage: 'query', error: e.message });
  }

  // Retry failed:transient rows. decideAction enforces the per-target
  // exponential backoff when processKind5 attempts to reclaim each row.
  for (const row of (transientRows.results || [])) {
    try {
      const kind5 = { id: row.kind5_id, pubkey: row.creator_pubkey, tags: [['e', row.target_event_id]] };
      const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now, triggerLabel: 'cron' });
      processed += countProcessedTargets(result);
    } catch (e) {
      errors.push({ kind5_id: row.kind5_id, stage: 'retry', error: e.message });
    }
  }

  // Only advance the poll timestamp if the relay query succeeded.
  // On failure, next tick retries from the same window.
  if (querySucceeded) {
    await kv.put(LAST_POLL_KEY, String(nowMs));
  }

  return { processed, errors };
}

export { LAST_POLL_KEY, POLL_OVERLAP_SECONDS };
