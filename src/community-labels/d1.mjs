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
 */
export async function recordStrike(db, { creatorPubkey, videoEventId, label, now }) {
  await db.prepare(
    `INSERT INTO community_strikes (creator_pubkey, video_event_id, label, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(creator_pubkey, video_event_id, label) DO NOTHING`
  ).bind(creatorPubkey, videoEventId, label, now).run();
}

/** Total strikes recorded against a creator. */
export async function strikeCount(db, creatorPubkey) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM community_strikes WHERE creator_pubkey = ?`
  ).bind(creatorPubkey).first();
  return row?.n ?? 0;
}

/** Whether the warning DM for this strike level was already sent. */
export async function warningSent(db, creatorPubkey, strikeCountValue) {
  const row = await db.prepare(
    `SELECT creator_pubkey FROM community_strike_warnings
     WHERE creator_pubkey = ? AND strike_count = ?`
  ).bind(creatorPubkey, strikeCountValue).first();
  return row !== null;
}

/** Record that the warning DM for this strike level was sent. Idempotent. */
export async function recordWarning(db, { creatorPubkey, strikeCount: strikeCountValue, now }) {
  await db.prepare(
    `INSERT INTO community_strike_warnings (creator_pubkey, strike_count, sent_at)
     VALUES (?, ?, ?)
     ON CONFLICT(creator_pubkey, strike_count) DO NOTHING`
  ).bind(creatorPubkey, strikeCountValue, now).run();
}

/**
 * Creators ranked by strike count (desc) for the admin review feed.
 * Returns [{ creator_pubkey, strikes, last_at }].
 */
export async function listStrikeSummary(db, { limit = 100 } = {}) {
  const { results } = await db.prepare(
    `SELECT creator_pubkey, COUNT(*) AS strikes, MAX(created_at) AS last_at
     FROM community_strikes
     GROUP BY creator_pubkey
     ORDER BY strikes DESC, last_at DESC
     LIMIT ?`
  ).bind(limit).all();
  return results ?? [];
}
