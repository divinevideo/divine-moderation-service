// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: D1 helpers for community label decisions, creator strikes, and
// ABOUTME: warning send-once accounting. All inserts are idempotent via PKs.

/**
 * Whether an authoritative label was already published for (video, label).
 */
export async function hasDecision(db, videoEventId, label) {
  const row = await db.prepare(
    `SELECT video_event_id FROM community_label_decisions
     WHERE video_event_id = ? AND label = ?`
  ).bind(videoEventId, label).first();
  return row !== null;
}

/**
 * Record a published authoritative label. INSERT OR IGNORE: re-recording an
 * existing (video, label) is a no-op, preserving the original vote count.
 */
export async function recordDecision(db, {
  videoEventId, label, voteCount, publishedEventId, videoSha256, creatorPubkey, now,
}) {
  await db.prepare(
    `INSERT INTO community_label_decisions
      (video_event_id, label, vote_count, published_event_id, video_sha256, creator_pubkey, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_event_id, label) DO NOTHING`
  ).bind(videoEventId, label, voteCount, publishedEventId, videoSha256, creatorPubkey, now).run();
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

/** Whether the warning DM for this escalation level was already sent. */
export async function warningSent(db, creatorPubkey, warningLevel) {
  const row = await db.prepare(
    `SELECT creator_pubkey FROM community_strike_warnings
     WHERE creator_pubkey = ? AND warning_level = ?`
  ).bind(creatorPubkey, warningLevel).first();
  return row !== null;
}

/** Record that the warning DM for this escalation level was sent. Idempotent. */
export async function recordWarning(db, { creatorPubkey, warningLevel, now }) {
  await db.prepare(
    `INSERT INTO community_strike_warnings (creator_pubkey, warning_level, sent_at)
     VALUES (?, ?, ?)
     ON CONFLICT(creator_pubkey, warning_level) DO NOTHING`
  ).bind(creatorPubkey, warningLevel, now).run();
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
