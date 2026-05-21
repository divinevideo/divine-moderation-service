// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared kind 5 processing function used by both sync endpoint and cron.
// ABOUTME: Race-safe via D1 INSERT-OR-IGNORE claim, handles multi-target kind 5 per NIP-09.

import { claimRow, updateToSuccess, updateToFailed, decideAction, MAX_RETRY_COUNT } from './d1.mjs';

// Cap per NIP-09 kind 5. One kind 5 with 1000 e-tags would blow past the
// sync-endpoint budget and burn Funnelcake/Blossom call budget. 50 is well
// above real-world deletes (single video, or a thread of ~handful).
export const MAX_TARGETS_PER_KIND5 = 50;

/**
 * Extract the main blob sha256 from a kind 34236 video event.
 * Looks at imeta tags for x=<sha256> or parses url for the sha256 segment.
 */
export function extractSha256(targetEvent) {
  for (const tag of targetEvent.tags || []) {
    if (tag[0] !== 'imeta') continue;
    for (const part of tag.slice(1)) {
      if (typeof part !== 'string') continue;
      const xMatch = part.match(/^x\s+([a-f0-9]{64})$/i);
      if (xMatch) return xMatch[1].toLowerCase();
      const urlMatch = part.match(/^url\s+\S*\/([a-f0-9]{64})(?:\.\w+)?(?:\?|$)/i);
      if (urlMatch) return urlMatch[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Process a kind 5 event. Processes each e-tag target independently.
 * Returns { targets: [{ target_event_id, status, blob_sha256?, last_error? }] }
 */
export async function processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete, now = () => Date.now(), triggerLabel = 'unknown' }) {
  const allTargetIds = (kind5.tags || [])
    .filter(t => t[0] === 'e' && t[1])
    .map(t => t[1]);
  const targetIds = allTargetIds.slice(0, MAX_TARGETS_PER_KIND5);

  if (allTargetIds.length > MAX_TARGETS_PER_KIND5) {
    console.log(JSON.stringify({
      event: 'creator_delete.target_cap_applied',
      kind5_id: kind5.id,
      total_targets: allTargetIds.length,
      processed_targets: targetIds.length,
      trigger: triggerLabel
    }));
  }

  const resultTargets = [];

  for (const target_event_id of targetIds) {
    const acceptedIso = new Date(now()).toISOString();
    const claim = await claimRow(db, {
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      accepted_at: acceptedIso
    });

    const action = claim.claimed ? 'proceed' : decideAction(claim.existing, { now: now() });

    if (action === 'skip_success') {
      resultTargets.push({ target_event_id, status: 'success', blob_sha256: claim.existing.blob_sha256 });
      continue;
    }
    if (action === 'skip_permanent_failure') {
      resultTargets.push({ target_event_id, status: claim.existing.status, last_error: claim.existing.last_error });
      continue;
    }
    if (action === 'skip_in_progress') {
      resultTargets.push({ target_event_id, status: 'in_progress' });
      continue;
    }

    // action === 'proceed'. If we didn't claim (row existed, stale/retryable),
    // conditionally re-claim: UPDATE only succeeds if accepted_at still matches
    // the value we observed, so two racing workers can't both reclaim.
    if (!claim.claimed) {
      const reclaim = await db.prepare(
        `UPDATE creator_deletions
         SET accepted_at = ?, status = 'accepted'
         WHERE kind5_id = ? AND target_event_id = ? AND accepted_at = ?`
      ).bind(acceptedIso, kind5.id, target_event_id, claim.existing.accepted_at).run();
      const reclaimed = reclaim.meta.changes === 1 || reclaim.meta.rows_written === 1;
      if (!reclaimed) {
        // Another worker won the re-claim race. Report in_progress and let them finish.
        resultTargets.push({ target_event_id, status: 'in_progress' });
        continue;
      }
    }
    console.log(JSON.stringify({
      event: 'creator_delete.accepted',
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      accepted_at: acceptedIso,
      trigger: triggerLabel
    }));

    const priorRetryCount = (claim.existing && claim.existing.retry_count) || 0;

    let target;
    try {
      target = await fetchTargetEvent(target_event_id);
    } catch (fetchErr) {
      const retryCountAfter = priorRetryCount + 1;
      const status = retryCountAfter >= MAX_RETRY_COUNT
        ? 'failed:permanent:max_retries_exceeded'
        : 'failed:transient:target_fetch';
      const lastError = fetchErr.message || 'Transient relay error fetching target event';
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status,
        last_error: lastError,
        increment_retry: true
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        status,
        last_error: lastError,
        retry_count_after: retryCountAfter,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status, last_error: lastError });
      continue;
    }

    if (!target) {
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status: 'failed:permanent:target_unresolved',
        last_error: 'Target event not found on Funnelcake'
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        status: 'failed:permanent:target_unresolved',
        last_error: 'Target event not found on Funnelcake',
        retry_count_after: priorRetryCount,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'failed:permanent:target_unresolved' });
      continue;
    }

    if (target.pubkey !== kind5.pubkey) {
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status: 'failed:permanent:author_mismatch',
        last_error: `Kind 5 author ${kind5.pubkey} does not match target author ${target.pubkey}`
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        target_pubkey: target.pubkey,
        status: 'failed:permanent:author_mismatch',
        retry_count_after: priorRetryCount,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'failed:permanent:author_mismatch' });
      continue;
    }

    const sha256 = extractSha256(target);
    if (!sha256) {
      await updateToFailed(db, {
        kind5_id: kind5.id,
        target_event_id,
        status: 'failed:permanent:no_sha256',
        last_error: 'No sha256 in target event imeta/url'
      });
      console.log(JSON.stringify({
        event: 'creator_delete.failed',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        status: 'failed:permanent:no_sha256',
        last_error: 'No sha256 in target event imeta/url',
        retry_count_after: priorRetryCount,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'failed:permanent:no_sha256' });
      continue;
    }

    const blossomResult = await callBlossomDelete(sha256);
    if (blossomResult.success && !blossomResult.skipped) {
      const completedIso = new Date(now()).toISOString();
      await updateToSuccess(db, {
        kind5_id: kind5.id,
        target_event_id,
        blob_sha256: sha256,
        completed_at: completedIso
      });
      console.log(JSON.stringify({
        event: 'creator_delete.success',
        kind5_id: kind5.id,
        target_event_id,
        creator_pubkey: kind5.pubkey,
        blob_sha256: sha256,
        completed_at: completedIso,
        trigger: triggerLabel
      }));
      resultTargets.push({ target_event_id, status: 'success', blob_sha256: sha256 });
      continue;
    }

    // Blossom failed or skipped
    const status = blossomResult.status;
    const isTransient = blossomResult.networkError || (status !== undefined && (status >= 500 || status === 429));
    const category = isTransient
      ? (blossomResult.networkError ? 'failed:transient:network' : `failed:transient:blossom_${status === 429 ? '429' : '5xx'}`)
      : (status !== undefined ? `failed:permanent:blossom_${status}` : 'failed:permanent:blossom_skipped');

    const lastError = blossomResult.error || `Blossom returned ${blossomResult.status}`;
    const retryCountAfter = isTransient ? priorRetryCount + 1 : priorRetryCount;

    // Promote to permanent if retries exhausted
    const finalStatus = (isTransient && retryCountAfter >= MAX_RETRY_COUNT)
      ? 'failed:permanent:max_retries_exceeded'
      : category;

    await updateToFailed(db, {
      kind5_id: kind5.id,
      target_event_id,
      status: finalStatus,
      last_error: lastError,
      increment_retry: isTransient
    });
    console.log(JSON.stringify({
      event: 'creator_delete.failed',
      kind5_id: kind5.id,
      target_event_id,
      creator_pubkey: kind5.pubkey,
      status: finalStatus,
      last_error: lastError,
      retry_count_after: retryCountAfter,
      trigger: triggerLabel
    }));
    resultTargets.push({ target_event_id, status: finalStatus, last_error: blossomResult.error, blob_sha256: sha256 });
  }

  return { targets: resultTargets };
}
