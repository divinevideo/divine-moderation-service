// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: D1 helpers for community label decisions, creator strikes, and
// ABOUTME: warning send-once accounting. All inserts are idempotent via PKs.

/**
 * Whether a CONFIRMED authoritative label was already published for
 * (video, label). A still-pending claim (publish in flight, or a publish that
 * landed while the confirm write failed) is deliberately NOT a decision: the
 * publish-once guard keys on 'confirmed' so a partial failure is retried and
 * re-confirmed, not skipped.
 */
export async function hasDecision(db, videoEventId, label) {
  const row = await db.prepare(
    `SELECT video_event_id FROM community_label_decisions
     WHERE video_event_id = ? AND label = ? AND status = 'confirmed'`
  ).bind(videoEventId, label).first();
  return row !== null;
}

/**
 * Claim (video, label) for publishing by persisting a PENDING row BEFORE the
 * label event is sent, storing the EXACT signed event bytes in the claim.
 * INSERT OR IGNORE means the first tick creates the claim and every retry reads
 * back the SAME stored event — so the caller republishes byte-identical event
 * bytes, the relay dedups by id, and no duplicate authoritative label can land
 * even if the event-building code or signing key changed between publishes.
 *
 * `preparedEvent` is the signed event object; it is serialized on write and
 * returned parsed. `createdAt`/`voteCount` are still returned for audit.
 *
 * @returns {Promise<{createdAt: number, voteCount: number, preparedEvent: Object}>}
 */
export async function claimDecision(db, {
  videoEventId, label, voteCount, videoSha256, creatorPubkey, preparedEvent, now,
}) {
  await db.prepare(
    `INSERT INTO community_label_decisions
      (video_event_id, label, vote_count, published_event_id, video_sha256, creator_pubkey, prepared_event, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(video_event_id, label) DO NOTHING`
  ).bind(videoEventId, label, voteCount, '', videoSha256, creatorPubkey, JSON.stringify(preparedEvent), now).run();

  const row = await db.prepare(
    `SELECT vote_count, created_at, prepared_event FROM community_label_decisions
     WHERE video_event_id = ? AND label = ?`
  ).bind(videoEventId, label).first();
  // A claim always writes prepared_event, so a null here means a pre-column
  // legacy row (or manual insert). Fail loudly rather than publish a null event
  // — the caller holds the cursor and retries instead of wedging silently.
  if (row.prepared_event == null) {
    throw new Error(`claimDecision: missing prepared_event for ${videoEventId}/${label}`);
  }
  return {
    createdAt: row.created_at,
    voteCount: row.vote_count,
    preparedEvent: JSON.parse(row.prepared_event),
  };
}

/**
 * Mark a claimed (video, label) CONFIRMED and record the published event id
 * for audit. Only flips a still-pending row, so a re-confirm on a later tick
 * cannot rewrite the original published id.
 */
export async function confirmDecision(db, { videoEventId, label, publishedEventId }) {
  await db.prepare(
    `UPDATE community_label_decisions
     SET status = 'confirmed', published_event_id = ?
     WHERE video_event_id = ? AND label = ? AND status = 'pending'`
  ).bind(publishedEventId, videoEventId, label).run();
}

/**
 * Record a strike against a creator for one (video, label). Idempotent.
 * Returns true when a new row was inserted, false when it already existed —
 * so the sweep can re-ensure strikes every tick without over-counting.
 */
export async function recordStrike(db, { creatorPubkey, videoEventId, label, now }) {
  const result = await db.prepare(
    `INSERT INTO community_strikes (creator_pubkey, video_event_id, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(creator_pubkey, video_event_id, label) DO NOTHING`
  ).bind(creatorPubkey, videoEventId, label, now).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/** Total strikes recorded against a creator. */
export async function strikeCount(db, creatorPubkey) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM community_strikes WHERE creator_pubkey = ?`
  ).bind(creatorPubkey).first();
  return row?.n ?? 0;
}

/**
 * Claim the warning DM for this escalation level by persisting a PENDING row
 * BEFORE the DM is sent. Returns true only when THIS call created the claim;
 * false when a claim already exists (pending OR sent). A pending-or-sent claim
 * must block a resend — so the caller only sends when this returns true. That
 * trades a rare missed warning (crash between claim and send) for never
 * double-DMing the creator.
 */
export async function claimWarning(db, { creatorPubkey, warningLevel, now }) {
  const result = await db.prepare(
    `INSERT INTO community_strike_warnings (creator_pubkey, warning_level, sent_at, status)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT(creator_pubkey, warning_level) DO NOTHING`
  ).bind(creatorPubkey, warningLevel, now).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Mark a claimed warning as sent (audit). Only flips a still-pending row.
 * Correctness of the no-duplicate guard rests on the claim, not this flip;
 * this records that the DM actually went out.
 */
export async function confirmWarning(db, { creatorPubkey, warningLevel }) {
  await db.prepare(
    `UPDATE community_strike_warnings
     SET status = 'sent'
     WHERE creator_pubkey = ? AND warning_level = ? AND status = 'pending'`
  ).bind(creatorPubkey, warningLevel).run();
}

/**
 * Release a claimed-but-not-sent warning so a later tick can retry it. Called
 * only on a DEFINITIVE pre-send failure (rate limit, bad input, key/relay-
 * discovery failure) where we KNOW no gift-wrap was published, so re-sending is
 * not a duplicate. Deletes only a still-`pending` row, so a claim orphaned by a
 * crash after a successful send (never released) still blocks a resend. An
 * AMBIGUOUS failure (publish attempted, OK not seen) must NOT be released.
 */
export async function releaseWarning(db, { creatorPubkey, warningLevel }) {
  await db.prepare(
    `DELETE FROM community_strike_warnings
     WHERE creator_pubkey = ? AND warning_level = ? AND status = 'pending'`
  ).bind(creatorPubkey, warningLevel).run();
}

/**
 * One page of a single creator's strike rows, newest first, for the admin
 * drill-down behind the summary's per-creator evidence cap. Pages entirely in
 * SQL (bound LIMIT/OFFSET) so a creator with hundreds of strikes never
 * over-fetches. Returns [{ video_event_id, label, created_at }].
 */
export async function listStrikesForCreator(db, { creatorPubkey, limit, offset }) {
  const { results } = await db.prepare(
    `SELECT video_event_id, label, created_at
     FROM community_strikes
     WHERE creator_pubkey = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(creatorPubkey, limit, offset).all();
  return results ?? [];
}

/**
 * The individual strike rows behind a set of creators, newest first, capped
 * per creator. Returns a Map<creator_pubkey, [{ video_event_id, label,
 * created_at }]>. One query for the whole page rather than N per-creator ones.
 */
const D1_MAX_BOUND_PARAMETERS = 100;

async function listStrikeDetails(db, { creatorPubkeys, perCreatorLimit }) {
  const byCreator = new Map();
  if (!Array.isArray(creatorPubkeys) || creatorPubkeys.length === 0) return byCreator;

  for (let i = 0; i < creatorPubkeys.length; i += D1_MAX_BOUND_PARAMETERS) {
    const chunk = creatorPubkeys.slice(i, i + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(
      `SELECT creator_pubkey, video_event_id, label, created_at
       FROM community_strikes
       WHERE creator_pubkey IN (${placeholders})
       ORDER BY created_at DESC`
    ).bind(...chunk).all();

    for (const row of results ?? []) {
      const rows = byCreator.get(row.creator_pubkey) ?? [];
      if (rows.length < perCreatorLimit) {
        rows.push({
          video_event_id: row.video_event_id,
          label: row.label,
          created_at: row.created_at,
        });
      }
      byCreator.set(row.creator_pubkey, rows);
    }
  }
  return byCreator;
}

/**
 * Creators ranked by strike count (desc) for the admin review feed, each with
 * the strike rows behind the count so moderators can see the evidence (which
 * video, which label, when) without a second request. Returns
 * [{ creator_pubkey, strikes, last_at, recent: [{ video_event_id, label,
 * created_at }] }]. `recent` is capped at `detailPerCreator` rows; `strikes`
 * is always the true total.
 */
export async function listStrikeSummary(db, { limit = 100, detailPerCreator = 20 } = {}) {
  const { results } = await db.prepare(
    `SELECT creator_pubkey, COUNT(*) AS strikes, MAX(created_at) AS last_at
     FROM community_strikes
     GROUP BY creator_pubkey
     ORDER BY strikes DESC, last_at DESC
     LIMIT ?`
  ).bind(limit).all();
  const creators = results ?? [];
  if (creators.length === 0) return [];

  const detail = await listStrikeDetails(db, {
    creatorPubkeys: creators.map((row) => row.creator_pubkey),
    perCreatorLimit: detailPerCreator,
  });
  return creators.map((row) => ({
    ...row,
    recent: detail.get(row.creator_pubkey) ?? [],
  }));
}
