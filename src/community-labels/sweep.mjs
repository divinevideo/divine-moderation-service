// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cron orchestrator for community content-warning aggregation:
// ABOUTME: poll votes since cursor, decide via the pure module, act, advance.

import {
  getThreshold,
  getWarningCount,
  getBatchLimit,
  getCursor,
  setCursor,
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
import { resolveDivineAuthors } from './identity.mjs';

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
 * One aggregation sweep. All steps are idempotent; the cursor advances only
 * when every touched video was processed without a transient failure, so a
 * failed tick is simply retried by the next one.
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
}) {
  const threshold = await getThreshold(kv);
  const warningCount = await getWarningCount(kv);
  const batchLimit = await getBatchLimit(kv);
  const cursor = await getCursor(kv, now);

  const summary = { swept: 0, published: 0, strikes: 0, warned: 0, cursorAdvanced: false };

  const newVotes = (await fetchLabelsSince(cursor)) ?? [];

  // Group new votes by target video; the tally itself is recomputed from a
  // full per-video fetch below so it is complete, not incremental.
  const touched = new Map(); // eventId -> { eventId, addressableId }
  for (const vote of newVotes) {
    if (vote?.pubkey === moderationPubkey) continue;
    const target = targetsOf(vote);
    if (target.eventId === null) continue;
    const existing = touched.get(target.eventId) ?? { eventId: target.eventId, addressableId: null };
    existing.addressableId ??= target.addressableId;
    touched.set(target.eventId, existing);
  }

  const targets = [...touched.values()];
  const batch = targets.slice(0, batchLimit);
  const deferred = targets.length - batch.length;
  let cleanSweep = true;

  for (const target of batch) {
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
          cleanSweep = false;
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
          cleanSweep = false;
        }
      }

      summary.swept += 1;
    } catch (error) {
      // Transient failure on this video: keep the cursor so the next tick
      // retries; idempotent PKs make re-processing harmless.
      console.log(`[COMMUNITY-LABELS] sweep error for ${target.eventId}: ${error?.message ?? error}`);
      cleanSweep = false;
    }
  }

  if (cleanSweep && deferred === 0) {
    await setCursor(kv, now);
    summary.cursorAdvanced = true;
  } else if (deferred > 0) {
    console.log(`[COMMUNITY-LABELS] batch cap deferred ${deferred} video(s) to the next tick`);
  }

  return summary;
}
