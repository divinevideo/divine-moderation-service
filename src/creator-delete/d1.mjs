// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Race-safe D1 helpers for creator_deletions audit table.
// ABOUTME: claimRow implements INSERT ... ON CONFLICT DO NOTHING then SELECT to read canonical state.

const MAX_RETRY_COUNT = 5;
const TRANSIENT_RETRY_BASE_MS = 30_000;
const TRANSIENT_RETRY_MAX_MS = 300_000;
// Must exceed the sync endpoint's waitUntil work window. A stale accepted row
// may be re-claimed after this; Blossom DELETE must remain idempotent.
const IN_PROGRESS_TIMEOUT_MS = 120_000;

/**
 * Attempt to claim a row for processing. Returns { claimed, existing }.
 * If claimed, this worker owns the row. If not, inspect existing.status and decide.
 */
export async function claimRow(db, { kind5_id, target_event_id, creator_pubkey, accepted_at }) {
  const insertResult = await db.prepare(
    `INSERT INTO creator_deletions
      (kind5_id, target_event_id, creator_pubkey, status, accepted_at)
     VALUES (?, ?, ?, 'accepted', ?)
     ON CONFLICT(kind5_id, target_event_id) DO NOTHING`
  ).bind(kind5_id, target_event_id, creator_pubkey, accepted_at).run();

  const inserted = insertResult.meta.changes === 1 || insertResult.meta.rows_written === 1;

  if (inserted) {
    return { claimed: true, existing: null };
  }

  const existing = await readRow(db, { kind5_id, target_event_id });
  return { claimed: false, existing };
}

export async function readRow(db, { kind5_id, target_event_id }) {
  return db.prepare(
    `SELECT kind5_id, target_event_id, creator_pubkey, blob_sha256, status, accepted_at, completed_at, retry_count, last_error
     FROM creator_deletions WHERE kind5_id = ? AND target_event_id = ?`
  ).bind(kind5_id, target_event_id).first();
}

export async function readAllTargetsForKind5(db, { kind5_id }) {
  const result = await db.prepare(
    `SELECT kind5_id, target_event_id, creator_pubkey, blob_sha256, status, accepted_at, completed_at, retry_count, last_error
     FROM creator_deletions WHERE kind5_id = ?`
  ).bind(kind5_id).all();
  return result.results || [];
}

export async function updateToSuccess(db, { kind5_id, target_event_id, blob_sha256, completed_at }) {
  await db.prepare(
    `UPDATE creator_deletions
     SET status = 'success', blob_sha256 = ?, completed_at = ?, last_error = NULL
     WHERE kind5_id = ? AND target_event_id = ?`
  ).bind(blob_sha256, completed_at, kind5_id, target_event_id).run();
}

export async function updateToFailed(db, { kind5_id, target_event_id, status, last_error, increment_retry = false }) {
  if (increment_retry) {
    await db.prepare(
      `UPDATE creator_deletions
       SET status = ?, last_error = ?, retry_count = retry_count + 1
       WHERE kind5_id = ? AND target_event_id = ?`
    ).bind(status, last_error, kind5_id, target_event_id).run();
  } else {
    await db.prepare(
      `UPDATE creator_deletions
       SET status = ?, last_error = ?
       WHERE kind5_id = ? AND target_event_id = ?`
    ).bind(status, last_error, kind5_id, target_event_id).run();
  }
}

/**
 * Decide what to do with an existing row given the claim result.
 * Returns one of: 'proceed' (caller should re-try processing), 'skip_success',
 * 'skip_permanent_failure', 'skip_in_progress'.
 */
export function decideAction(existing, { now = Date.now() } = {}) {
  if (!existing) return 'proceed';
  if (existing.status === 'success') return 'skip_success';
  if (existing.status.startsWith('failed:permanent:')) return 'skip_permanent_failure';
  if (existing.status === 'accepted') {
    const acceptedMs = Date.parse(existing.accepted_at);
    if (now - acceptedMs < IN_PROGRESS_TIMEOUT_MS) return 'skip_in_progress';
    return 'proceed';
  }
  if (existing.status.startsWith('failed:transient:')) {
    if (existing.retry_count >= MAX_RETRY_COUNT) return 'skip_permanent_failure';
    const acceptedMs = Date.parse(existing.accepted_at);
    const backoffMs = Math.min(TRANSIENT_RETRY_BASE_MS * Math.pow(2, existing.retry_count), TRANSIENT_RETRY_MAX_MS);
    if (now - acceptedMs < backoffMs) return 'skip_in_progress';
    return 'proceed';
  }
  return 'proceed';
}

export { MAX_RETRY_COUNT, IN_PROGRESS_TIMEOUT_MS, TRANSIENT_RETRY_BASE_MS, TRANSIENT_RETRY_MAX_MS };
