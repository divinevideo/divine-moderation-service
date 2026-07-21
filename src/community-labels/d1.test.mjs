// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for community-label D1 helpers — decision/strike/warning
// ABOUTME: idempotency and the strike summary ranking. Uses makeFakeCommunityD1.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasDecision,
  recordDecision,
  recordStrike,
  strikeCount,
  warningSent,
  recordWarning,
  listStrikeSummary,
} from './d1.mjs';
import { makeFakeCommunityD1 } from './test-helpers.mjs';

const VIDEO_A = 'a'.repeat(64);
const VIDEO_B = 'b'.repeat(64);
const CREATOR_1 = 'c1'.padEnd(64, '0');
const CREATOR_2 = 'c2'.padEnd(64, '0');
const PUBLISHED = 'e'.repeat(64);
const SHA = 'f'.repeat(64);

describe('decisions', () => {
  let db;
  beforeEach(() => { db = makeFakeCommunityD1(); });

  it('hasDecision is false before recording and true after', async () => {
    expect(await hasDecision(db, VIDEO_A, 'gambling')).toBe(false);
    await recordDecision(db, {
      videoEventId: VIDEO_A,
      label: 'gambling',
      voteCount: 3,
      publishedEventId: PUBLISHED,
      videoSha256: SHA,
      creatorPubkey: CREATOR_1,
      now: 1700000000,
    });
    expect(await hasDecision(db, VIDEO_A, 'gambling')).toBe(true);
  });

  it('recording the same (video,label) twice is a no-op', async () => {
    const row = {
      videoEventId: VIDEO_A,
      label: 'gambling',
      voteCount: 3,
      publishedEventId: PUBLISHED,
      videoSha256: SHA,
      creatorPubkey: CREATOR_1,
      now: 1700000000,
    };
    await recordDecision(db, row);
    await recordDecision(db, { ...row, voteCount: 9 });
    expect(db.decisions.size).toBe(1);
    expect([...db.decisions.values()][0].vote_count).toBe(3);
  });

  it('different labels on the same video are separate decisions', async () => {
    const base = {
      videoEventId: VIDEO_A,
      voteCount: 3,
      publishedEventId: PUBLISHED,
      videoSha256: SHA,
      creatorPubkey: CREATOR_1,
      now: 1700000000,
    };
    await recordDecision(db, { ...base, label: 'gambling' });
    await recordDecision(db, { ...base, label: 'violence' });
    expect(db.decisions.size).toBe(2);
  });
});

describe('strikes and warnings', () => {
  let db;
  beforeEach(() => { db = makeFakeCommunityD1(); });

  it('strikeCount counts distinct strikes per creator', async () => {
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_A, label: 'gambling', now: 1 });
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_B, label: 'violence', now: 2 });
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_A, label: 'gambling', now: 3 });
    expect(await strikeCount(db, CREATOR_1)).toBe(2);
    expect(await strikeCount(db, CREATOR_2)).toBe(1);
  });

  it('duplicate strike insert is a no-op', async () => {
    const strike = { creatorPubkey: CREATOR_1, videoEventId: VIDEO_A, label: 'gambling', now: 1 };
    await recordStrike(db, strike);
    await recordStrike(db, { ...strike, now: 99 });
    expect(await strikeCount(db, CREATOR_1)).toBe(1);
  });

  it('warningSent is false until recorded, then true for that level only', async () => {
    expect(await warningSent(db, CREATOR_1, 1)).toBe(false);
    await recordWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 1, now: 5 });
    expect(await warningSent(db, CREATOR_1, 1)).toBe(true);
    expect(await warningSent(db, CREATOR_1, 2)).toBe(false);
  });

  it('listStrikeSummary ranks creators by strike count desc', async () => {
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_A, label: 'gambling', now: 1 });
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_A, label: 'gambling', now: 2 });
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_B, label: 'violence', now: 3 });
    const summary = await listStrikeSummary(db, { limit: 10 });
    expect(summary[0]).toMatchObject({ creator_pubkey: CREATOR_2, strikes: 2 });
    expect(summary[1]).toMatchObject({ creator_pubkey: CREATOR_1, strikes: 1 });
  });

  it('listStrikeSummary attaches the strike rows behind each creator', async () => {
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_A, label: 'gambling', now: 10 });
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_B, label: 'violence', now: 20 });

    const summary = await listStrikeSummary(db, { limit: 10 });
    const creator = summary.find((row) => row.creator_pubkey === CREATOR_1);

    expect(creator.strikes).toBe(2);
    expect(creator.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ video_event_id: VIDEO_A, label: 'gambling', created_at: 10 }),
      expect.objectContaining({ video_event_id: VIDEO_B, label: 'violence', created_at: 20 }),
    ]));
    expect(creator.recent).toHaveLength(2);
  });

  it('caps the per-creator evidence rows while keeping the true total count', async () => {
    for (let i = 0; i < 25; i += 1) {
      await recordStrike(db, {
        creatorPubkey: CREATOR_1,
        videoEventId: `${i}`.padEnd(64, 'a'),
        label: 'gambling',
        now: i,
      });
    }

    const summary = await listStrikeSummary(db, { limit: 10, detailPerCreator: 20 });
    const creator = summary.find((row) => row.creator_pubkey === CREATOR_1);

    expect(creator.strikes).toBe(25);
    expect(creator.recent).toHaveLength(20);
  });
});
