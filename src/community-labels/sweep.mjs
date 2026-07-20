// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron orchestrator for community content-warning aggregation:
// ABOUTME: poll votes since the watermark, decide via the pure module, act.

import {
  getThreshold,
  getWarningCount,
  getBatchLimit,
  getCursor,
  setCursor,
  SINCE_POLL_LIMIT,
} from './config.mjs';
import {
  extractVotes,
  decideCrossings,
  creatorSelfLabels,
  strikesFor,
} from './decision.mjs';
import {
  hasDecision,
  recordDecision,
  recordStrike,
  strikeCount,
  warningSent,
  recordWarning,
} from './d1.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

function targetsOf(labelEvent) {
  let eventId = null;
  let addressableId = null;
  for (const tag of labelEvent.tags ?? []) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === 'e' && HEX64.test(tag[1] ?? '')) eventId = tag[1];
    if (tag[0] === 'a' && typeof tag[1] === 'string' && tag[1].includes(':')) {
      addressableId = tag[1];
    }
  }
  return { eventId, addressableId };
}

function sha256Of(videoEvent) {
  for (const tag of videoEvent.tags ?? []) {
    if (Array.isArray(tag) && tag[0] === 'x' && HEX64.test(tag[1] ?? '')) return tag[1];
  }
  // imeta fallback: ["imeta", "url ...", "x <sha256>", ...]
  for (const tag of videoEvent.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== 'imeta') continue;
    for (const entry of tag.slice(1)) {
      const match = /^x ([0-9a-f]{64})$/.exec(entry ?? '');
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * One aggregation sweep. The cursor is a watermark: videos are processed
 * oldest-first by their earliest new vote, and the watermark advances to
 * just before the earliest vote of any video that was deferred (batch cap)
 * or failed (transient error), so no vote is ever left behind it
 * unprocessed. A fully clean tick advances the watermark to `now`; on a
 * full (possibly truncated) page it holds — and freezes the cursor at its
 * current value — so the oldest un-returned votes are re-polled next tick
 * rather than skipped. The watermark persists every tick, so a fresh
 * deploy cannot age deferred votes out of the default lookback window.
 * All steps are idempotent, so re-processing retried videos is harmless.
 *
 * Dependencies are injected (same shape as runCreatorDeleteCron) so the
 * orchestration is unit-testable without a relay, name server, or signer.
 */
export async function runCommunityLabelSweep({
  db,
  kv,
  now,
  fetchLabelsSince,
  fetchLabelsForVideo,
  fetchVideoEvent,
  isDivine,
  publishLabel,
  sendWarningDm,
  moderationPubkey,
  sincePollLimit = SINCE_POLL_LIMIT,
}) {
  const threshold = await getThreshold(kv);
  const warningCount = await getWarningCount(kv);
  const batchLimit = await getBatchLimit(kv);
  const cursor = await getCursor(kv, now);

  const summary = { swept: 0, published: 0, strikes: 0, warned: 0, cursorAdvanced: false };

  const newVotes = (await fetchLabelsSince(cursor)) ?? [];

  // A full page means the relay may have truncated the result. Funnelcake
  // truncates newest-first (ORDER BY created_at DESC LIMIT), so the dropped
  // votes are the OLDEST in the window — advancing the watermark at all
  // would skip them. Hold the watermark at the cursor for this tick: the
  // videos we did see are still processed (idempotently), and the next tick
  // re-polls the same window. Sustained >limit volume wedges here (observable
  // via the held-watermark-age log below); the scale fix is to page the
  // window backward with `until`, deferred as a documented fast-follow.
  const pageFull = newVotes.length >= sincePollLimit;
  const watermarkCeiling = pageFull ? cursor : now;
  if (pageFull) {
    console.log(`[COMMUNITY-LABELS] since-poll page full (${newVotes.length} >= ${sincePollLimit}); holding cursor to avoid skipping truncated older votes`);
  }

  // Group new votes by target video with each video's earliest new vote;
  // the tally itself is recomputed from a full per-video fetch below so it
  // is complete, not incremental.
  const touched = new Map(); // eventId -> { eventId, addressableId, earliestVoteAt }
  for (const vote of newVotes) {
    if (vote?.pubkey === moderationPubkey) continue;
    const target = targetsOf(vote);
    // Touched-video detection keys on the `e` (event id) target only,
    // though the per-video tally below fetches both `e` and `a`. The whole
    // downstream is event-id-keyed (fetchVideoEvent by id, decision PK on
    // video_event_id), so an `a`-only vote has no concrete event to label;
    // the mobile client always co-tags `e`+`a`, so real votes carry an `e`.
    if (target.eventId === null) continue;
    const createdAt = Number.isInteger(vote?.created_at) ? vote.created_at : now;
    const existing = touched.get(target.eventId)
      ?? { eventId: target.eventId, addressableId: null, earliestVoteAt: createdAt };
    existing.addressableId ??= target.addressableId;
    existing.earliestVoteAt = Math.min(existing.earliestVoteAt, createdAt);
    touched.set(target.eventId, existing);
  }

  const targets = [...touched.values()].sort((a, b) => a.earliestVoteAt - b.earliestVoteAt);
  const batch = targets.slice(0, batchLimit);
  // Earliest vote of every video the watermark must not pass: batch-cap
  // deferrals up front, per-video failures appended below.
  const unprocessedAt = targets.slice(batchLimit).map((target) => target.earliestVoteAt);

  for (const target of batch) {
    let videoClean = true;
    try {
      const videoEvent = await fetchVideoEvent(target.eventId);
      if (!videoEvent) {
        // Video not on the relay (deleted or never stored): nothing to label.
        summary.swept += 1;
        continue;
      }

      const allVotes = (await fetchLabelsForVideo(target)) ?? [];
      const votesByLabel = extractVotes(allVotes, {
        moderationPubkey,
        creatorPubkey: videoEvent.pubkey,
      });

      const authors = new Set();
      for (const authorSet of votesByLabel.values()) {
        for (const author of authorSet) authors.add(author);
      }
      const divineByAuthor = new Map();
      for (const author of authors) {
        divineByAuthor.set(author, await isDivine(author));
      }

      const crossings = decideCrossings(votesByLabel, divineByAuthor, threshold);
      const selfLabels = creatorSelfLabels(videoEvent);
      const sha256 = sha256Of(videoEvent);

      for (const crossing of crossings) {
        if (await hasDecision(db, target.eventId, crossing.label)) continue;

        const publishResult = await publishLabel({
          videoEventId: target.eventId,
          sha256,
          label: crossing.label,
          voteCount: crossing.voteCount,
        });
        if (!publishResult?.published) {
          videoClean = false;
          continue;
        }

        await recordDecision(db, {
          videoEventId: target.eventId,
          label: crossing.label,
          voteCount: crossing.voteCount,
          publishedEventId: publishResult.eventId ?? '',
          videoSha256: sha256,
          creatorPubkey: videoEvent.pubkey,
          now,
        });
        summary.published += 1;

        if (strikesFor([crossing], selfLabels).length > 0) {
          await recordStrike(db, {
            creatorPubkey: videoEvent.pubkey,
            videoEventId: target.eventId,
            label: crossing.label,
            now,
          });
          summary.strikes += 1;
        }
      }

      const strikes = await strikeCount(db, videoEvent.pubkey);
      if (strikes >= warningCount && !(await warningSent(db, videoEvent.pubkey, strikes))) {
        const dmResult = await sendWarningDm({
          creatorPubkey: videoEvent.pubkey,
          strikeCount: strikes,
          videoSha256: sha256,
        });
        if (dmResult?.sent) {
          await recordWarning(db, { creatorPubkey: videoEvent.pubkey, strikeCount: strikes, now });
          summary.warned += 1;
        } else {
          videoClean = false;
        }
      }

      summary.swept += 1;
    } catch (error) {
      // Failure on this video: hold the watermark at its earliest vote so
      // the next tick retries; idempotent PKs make re-processing harmless.
      console.log(`[COMMUNITY-LABELS] sweep error for ${target.eventId}: ${error?.message ?? error}`);
      videoClean = false;
    }
    if (!videoClean) unprocessedAt.push(target.earliestVoteAt);
  }

  const watermark = unprocessedAt.length === 0
    ? watermarkCeiling
    : Math.min(Math.min(...unprocessedAt) - 1, watermarkCeiling);

  if (watermark > cursor) {
    await setCursor(kv, watermark);
  } else if (pageFull) {
    // Freeze the cursor on a full-page hold. On first run the cursor is an
    // unpersisted sliding `now - lookback`; without this, a vote near the
    // trailing edge that never makes the truncated newest-N page falls
    // behind the sliding window and is dropped. Persisting the current
    // value pins the window so those older votes are retained until volume
    // drops below the page limit and they surface. No-op in steady state
    // (rewrites the already-persisted value).
    await setCursor(kv, cursor);
  }
  summary.cursorAdvanced = unprocessedAt.length === 0 && watermarkCeiling === now;

  if (unprocessedAt.length > 0) {
    // Observability: a watermark that stays old across ticks means a video
    // is wedging the sweep (or sustained deferral) and deserves a look.
    console.log(`[COMMUNITY-LABELS] watermark held at ${watermark} (age ${now - watermark}s) by ${unprocessedAt.length} unprocessed video(s)`);
  }

  return summary;
}
