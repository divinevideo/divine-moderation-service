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

  // Keep known transient targets on the backoff-controlled retry path below.
  // Overlapping relay polls may return the same kind 5 every minute.
  const transientRows = await db.prepare(
    `SELECT kind5_id, target_event_id, creator_pubkey, status, retry_count, accepted_at
     FROM creator_deletions
     WHERE status LIKE 'failed:transient:%' AND retry_count < ?`
  ).bind(MAX_RETRY_COUNT).all();
  const transientKind5Ids = new Set(
    (transientRows.results || []).map(row => row.kind5_id)
  );

  let querySucceeded = false;
  try {
    const events = await queryKind5Since(sinceSeconds);
    querySucceeded = true;
    for (const kind5 of events) {
      try {
        if (transientKind5Ids.has(kind5.id)) continue;

        const lagSeconds = Math.max(0, Math.floor(now() / 1000) - (kind5.created_at || 0));
        console.log(JSON.stringify({
          event: 'creator_delete.cron.kind5_lag',
          kind5_id: kind5.id,
          lag_seconds: lagSeconds
        }));
        await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now, triggerLabel: 'cron' });
        processed++;
      } catch (e) {
        errors.push({ kind5_id: kind5.id, error: e.message });
      }
    }
  } catch (e) {
    errors.push({ stage: 'query', error: e.message });
  }

  // Retry failed:transient rows with exponential backoff:
  // Only retry rows where enough time has elapsed since accepted_at (30s * 2^retry_count, capped at 300s).
  const nowSeconds = Math.floor(nowMs / 1000);
  for (const row of (transientRows.results || [])) {
    const backoffSeconds = Math.min(30 * Math.pow(2, row.retry_count), 300);
    const acceptedSeconds = Math.floor(Date.parse(row.accepted_at) / 1000);
    if (nowSeconds - acceptedSeconds < backoffSeconds) continue;

    try {
      const kind5 = { id: row.kind5_id, pubkey: row.creator_pubkey, tags: [['e', row.target_event_id]] };
      await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now, triggerLabel: 'cron' });
      processed++;
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

export { LAST_POLL_KEY };
