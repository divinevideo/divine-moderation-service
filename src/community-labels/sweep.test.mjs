// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the community-label sweep orchestrator — publish-once,
// ABOUTME: cursor semantics, strike/warning accounting, batch cap, resilience.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runCommunityLabelSweep } from './sweep.mjs';
import { makeFakeCommunityD1 } from './test-helpers.mjs';

const MODERATION = 'f0'.padEnd(64, '0');
const CREATOR = 'c0'.padEnd(64, '0');
const VIDEO_ID = 'a0'.padEnd(64, '0');
const SHA = 'b0'.padEnd(64, '0');
const ALICE = 'a1'.padEnd(64, '0');
const BOB = 'b2'.padEnd(64, '0');
const CAROL = 'c3'.padEnd(64, '0');
const NOW_SECONDS = 1_700_000_000;

function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

function labelVote(
  author,
  label,
  { videoId = VIDEO_ID, createdAt = NOW_SECONDS - 60 } = {},
) {
  return {
    id: `${author.slice(0, 8)}${label}`.padEnd(64, '0').slice(0, 64),
    pubkey: author,
    kind: 1985,
    created_at: createdAt,
    tags: [
      ['L', 'content-warning'],
      ['l', label, 'content-warning'],
      ['e', videoId],
    ],
  };
}

function videoEvent({ selfLabels = [] } = {}) {
  return {
    id: VIDEO_ID,
    pubkey: CREATOR,
    kind: 34236,
    tags: [
      ['x', SHA],
      ...selfLabels.map((label) => ['l', label, 'content-warning']),
    ],
  };
}

function makeDeps({
  votes = [labelVote(ALICE, 'gambling'), labelVote(BOB, 'gambling'), labelVote(CAROL, 'gambling')],
  video = videoEvent(),
  divine = true,
  publishResult = { published: true, eventId: 'e'.repeat(64) },
  kvEntries = {},
} = {}) {
  const db = makeFakeCommunityD1();
  const kv = makeKv(kvEntries);
  return {
    db,
    kv,
    now: NOW_SECONDS,
    fetchLabelsSince: vi.fn().mockResolvedValue(votes),
    fetchLabelsForVideo: vi.fn().mockResolvedValue(votes),
    fetchVideoEvent: vi.fn().mockResolvedValue(video),
    isDivine: vi.fn().mockResolvedValue(divine),
    publishLabel: vi.fn().mockResolvedValue(publishResult),
    sendWarningDm: vi.fn().mockResolvedValue({ sent: true }),
    moderationPubkey: MODERATION,
  };
}

describe('runCommunityLabelSweep', () => {
  let deps;
  beforeEach(() => { deps = makeDeps(); });

  it('publishes once when a label crosses the threshold and records the decision', async () => {
    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).toHaveBeenCalledTimes(1);
    expect(deps.publishLabel).toHaveBeenCalledWith(expect.objectContaining({
      videoEventId: VIDEO_ID,
      sha256: SHA,
      label: 'gambling',
      voteCount: 3,
    }));
    expect(deps.db.decisions.size).toBe(1);
    expect(result.published).toBe(1);
    expect(result.cursorAdvanced).toBe(true);
  });

  it('does not republish on a re-sweep of the same votes', async () => {
    await runCommunityLabelSweep(deps);
    deps.publishLabel.mockClear();

    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });

    expect(deps.publishLabel).not.toHaveBeenCalled();
  });

  it('does not publish below the threshold', async () => {
    deps = makeDeps({ votes: [labelVote(ALICE, 'gambling'), labelVote(BOB, 'gambling')] });

    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(result.cursorAdvanced).toBe(true);
  });

  it('non-Divine voters do not count toward the threshold', async () => {
    deps = makeDeps({ divine: false });

    await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).not.toHaveBeenCalled();
  });

  it('leaves no decision row and holds the watermark when publish fails', async () => {
    deps = makeDeps({ publishResult: { published: false } });

    const result = await runCommunityLabelSweep(deps);

    expect(deps.db.decisions.size).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
    // The watermark persists just before the failed video's earliest vote,
    // so a fresh deploy cannot age its votes out of the default lookback.
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 61),
    );
  });

  it('records a strike when the creator did not self-label', async () => {
    const result = await runCommunityLabelSweep(deps);

    expect(deps.db.strikes.size).toBe(1);
    expect(result.strikes).toBe(1);
  });

  it('records no strike when the creator self-labeled (alias form counts)', async () => {
    deps = makeDeps({
      votes: [labelVote(ALICE, 'nudity'), labelVote(BOB, 'nudity'), labelVote(CAROL, 'nudity')],
      video: videoEvent({ selfLabels: ['NSFW'] }),
    });

    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).toHaveBeenCalledTimes(1);
    expect(deps.db.strikes.size).toBe(0);
    expect(result.strikes).toBe(0);
  });

  it('sends the warning DM exactly once per escalation level', async () => {
    // Warning threshold of 1 so a single strike triggers it.
    deps = makeDeps({ kvEntries: { strike_warning_count: '1' } });

    await runCommunityLabelSweep(deps);
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);
    expect(deps.sendWarningDm).toHaveBeenCalledWith(expect.objectContaining({
      creatorPubkey: CREATOR,
      strikeCount: 1,
    }));

    // Re-sweep: same strike level, warning already recorded.
    deps.sendWarningDm.mockClear();
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(deps.sendWarningDm).not.toHaveBeenCalled();
  });

  it('holds the watermark when fetching the video event throws', async () => {
    // Transient relay failures must throw (throwOnTransient wiring) so the
    // sweep retries next tick instead of advancing past the votes.
    deps.fetchVideoEvent.mockRejectedValue(new Error('relay 503'));

    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).not.toHaveBeenCalled();
    expect(result.cursorAdvanced).toBe(false);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 61),
    );
  });

  it('skips a video whose event cannot be fetched without wedging the sweep', async () => {
    deps.fetchVideoEvent.mockResolvedValue(null);

    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).not.toHaveBeenCalled();
    expect(result.cursorAdvanced).toBe(true);
  });

  it('drains deferred videos across ticks under the batch cap, oldest first', async () => {
    const videoB = 'b1'.padEnd(64, '0');
    const votes = [
      labelVote(ALICE, 'gambling', { createdAt: NOW_SECONDS - 120 }),
      labelVote(BOB, 'gambling', { createdAt: NOW_SECONDS - 110 }),
      labelVote(CAROL, 'gambling', { createdAt: NOW_SECONDS - 100 }),
      labelVote(ALICE, 'violence', { videoId: videoB, createdAt: NOW_SECONDS - 60 }),
      labelVote(BOB, 'violence', { videoId: videoB, createdAt: NOW_SECONDS - 50 }),
      labelVote(CAROL, 'violence', { videoId: videoB, createdAt: NOW_SECONDS - 40 }),
    ];
    deps = makeDeps({ votes, kvEntries: { community_sweep_batch_limit: '1' } });
    deps.fetchLabelsSince.mockImplementation(
      async (since) => votes.filter((v) => v.created_at >= since),
    );
    deps.fetchLabelsForVideo.mockImplementation(
      async ({ eventId }) => votes.filter(
        (v) => v.tags.some((t) => t[0] === 'e' && t[1] === eventId),
      ),
    );
    deps.fetchVideoEvent.mockImplementation(
      async (eventId) => ({ ...videoEvent(), id: eventId }),
    );

    const tick1 = await runCommunityLabelSweep(deps);
    // Oldest video processes first; the deferred one holds the watermark
    // just before its earliest vote instead of being starved.
    expect(tick1.published).toBe(1);
    expect(tick1.cursorAdvanced).toBe(false);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 61),
    );

    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(tick2.published).toBe(1);
    expect(tick2.cursorAdvanced).toBe(true);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS + 300),
    );
  });

  it('caps the watermark at the newest seen vote when the since-poll page is full', async () => {
    // Default deps carry 3 votes; a limit of 3 makes the page "full" and
    // possibly truncated, so the watermark must not pass the newest vote.
    const result = await runCommunityLabelSweep({ ...deps, sincePollLimit: 3 });

    expect(result.published).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 60),
    );
  });

  it('advances the cursor on an empty poll', async () => {
    deps = makeDeps({ votes: [] });

    const result = await runCommunityLabelSweep(deps);

    expect(result.cursorAdvanced).toBe(true);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(String(NOW_SECONDS));
  });
});
