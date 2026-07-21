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
  claimDecision,
  confirmDecision,
  recordStrike,
  strikeCount,
  claimWarning,
  confirmWarning,
} from './d1.mjs';
import { VIDEO_KINDS } from '../nostr/video-kinds.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

// Touched-video detection keys on the vote's `e` (event id) target only. The
// vote's `a` tag is deliberately ignored here: it is attacker-controlled, so
// the per-video tally derives the addressable id from the fetched video event
// itself (see addressableIdOf) rather than trusting the vote.
function eventIdOf(labelEvent) {
  for (const tag of labelEvent.tags ?? []) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === 'e' && HEX64.test(tag[1] ?? '')) return tag[1];
  }
  return null;
}

// The NIP-01 addressable coordinate (`kind:pubkey:dTag`) built from the fetched
// video's own tags. Null when the video carries no usable `d` tag.
function addressableIdOf(videoEvent) {
  for (const tag of videoEvent.tags ?? []) {
    if (Array.isArray(tag) && tag[0] === 'd' && typeof tag[1] === 'string' && tag[1] !== '') {
      return `${videoEvent.kind}:${videoEvent.pubkey}:${tag[1]}`;
    }
  }
  return null;
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
  // is complete, not incremental. The whole downstream is event-id-keyed
  // (fetchVideoEvent by id, decision PK on video_event_id), so a vote with no
  // `e` has no concrete event to label; the mobile client always co-tags
  // `e`+`a`, so real votes carry an `e`.
  const touched = new Map(); // eventId -> { eventId, earliestVoteAt }
  for (const vote of newVotes) {
    if (vote?.pubkey === moderationPubkey) continue;
    const eventId = eventIdOf(vote);
    if (eventId === null) continue;
    const createdAt = Number.isInteger(vote?.created_at) ? vote.created_at : now;
    const existing = touched.get(eventId) ?? { eventId, earliestVoteAt: createdAt };
    existing.earliestVoteAt = Math.min(existing.earliestVoteAt, createdAt);
    touched.set(eventId, existing);
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

      // Trust boundary: the vote's `e` is attacker-controlled, so confirm the
      // fetched event is actually a Divine video before labeling it. A wrong
      // kind is a genuine non-target (not a transient failure): sweep it
      // without holding the cursor.
      if (!VIDEO_KINDS.has(videoEvent.kind)) {
        summary.swept += 1;
        continue;
      }

      // Derive the addressable id from the fetched video's OWN tags, never the
      // vote's attacker-controlled `a` tag — otherwise a forged vote could pair
      // a victim's `e` with another video's already-crossed `a` and borrow its
      // consensus into the victim's tally.
      const allVotes = (await fetchLabelsForVideo({
        eventId: target.eventId,
        addressableId: addressableIdOf(videoEvent),
      })) ?? [];
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
        // Publish once: skip when a CONFIRMED authoritative label already
        // exists. But the strike (and warning below) are ensured independently
        // every sweep — a strike that failed to land after its decision was
        // recorded must be recoverable, not lost forever behind this dedup.
        if (!(await hasDecision(db, target.eventId, crossing.label))) {
          // Claim before send: persist a pending row with a frozen created_at
          // and vote count BEFORE publishing, then publish deterministically
          // from those frozen fields. A retry after a partial failure rebuilds
          // the SAME event id, so the relay dedups it — no duplicate label.
          const claim = await claimDecision(db, {
            videoEventId: target.eventId,
            label: crossing.label,
            voteCount: crossing.voteCount,
            videoSha256: sha256,
            creatorPubkey: videoEvent.pubkey,
            now,
          });
          const publishResult = await publishLabel({
            videoEventId: target.eventId,
            sha256,
            label: crossing.label,
            voteCount: claim.voteCount,
            createdAt: claim.createdAt,
          });
          if (!publishResult?.published) {
            videoClean = false;
            continue;
          }

          await confirmDecision(db, {
            videoEventId: target.eventId,
            label: crossing.label,
            publishedEventId: publishResult.eventId ?? '',
          });
          summary.published += 1;
        }

        // Ensure the strike idempotently regardless of whether the decision was
        // recorded this tick or a prior one. The (creator,video,label) PK makes
        // re-insertion a no-op, so this can't double-count; a failure holds the
        // cursor so the next tick retries.
        if (strikesFor([crossing], selfLabels).length > 0) {
          try {
            const inserted = await recordStrike(db, {
              creatorPubkey: videoEvent.pubkey,
              videoEventId: target.eventId,
              label: crossing.label,
              now,
            });
            if (inserted) summary.strikes += 1;
          } catch (error) {
            console.log(`[COMMUNITY-LABELS] strike ensure failed for ${target.eventId}/${crossing.label}: ${error?.message ?? error}`);
            videoClean = false;
          }
        }
      }

      const strikes = await strikeCount(db, videoEvent.pubkey);
      // Warn once per escalation LEVEL (every `warningCount` strikes), not per
      // exact count — otherwise a threshold-3 creator is warned at 3,4,5,…
      // instead of 3,6,9,…
      const warningLevel = Math.floor(strikes / warningCount);
      if (warningLevel >= 1) {
        // Claim before send: only the tick that first creates the pending
        // claim sends the DM. A pending-or-sent claim blocks a resend, so a
        // crash or record failure after sending never double-DMs the creator.
        const claimed = await claimWarning(db, {
          creatorPubkey: videoEvent.pubkey,
          warningLevel,
          now,
        });
        if (claimed) {
          const dmResult = await sendWarningDm({
            creatorPubkey: videoEvent.pubkey,
            strikeCount: strikes,
            videoSha256: sha256,
          });
          if (dmResult?.sent) {
            await confirmWarning(db, { creatorPubkey: videoEvent.pubkey, warningLevel });
            summary.warned += 1;
          } else {
            // {sent:false} is ambiguous: a relay can accept the gift-wrap
            // while its OK is lost, so we cannot prove no DM went out. Retain
            // the claim (do not resend) so a possibly-delivered warning is
            // never duplicated; a genuinely-missed one is caught by the
            // human ban-review backstop. (Gift-wraps have random ids, so —
            // unlike the label — the relay can't dedup a resend for us.)
            console.log(`[COMMUNITY-LABELS] warning DM unconfirmed for ${videoEvent.pubkey} level ${warningLevel}; claim retained, no resend`);
          }
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

  // Always persist the resolved watermark. An advance moves it forward; a hold
  // (full page OR per-video failure) freezes it at `cursor`. Persisting even a
  // non-advancing hold is what stops a first-run failure from sliding the
  // unpersisted `now - lookback` default past the vote that failed — a held
  // watermark below the default cursor would otherwise be dropped on the wire.
  await setCursor(kv, Math.max(watermark, cursor));
  summary.cursorAdvanced = unprocessedAt.length === 0 && watermarkCeiling === now;

  if (unprocessedAt.length > 0) {
    // Observability: a watermark that stays old across ticks means a video
    // is wedging the sweep (or sustained deferral) and deserves a look.
    console.log(`[COMMUNITY-LABELS] watermark held at ${watermark} (age ${now - watermark}s) by ${unprocessedAt.length} unprocessed video(s)`);
  }

  return summary;
}
