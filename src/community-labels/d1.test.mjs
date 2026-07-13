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
    expect(await warningSent(db, CREATOR_1, 3)).toBe(false);
    await recordWarning(db, { creatorPubkey: CREATOR_1, strikeCount: 3, now: 5 });
    expect(await warningSent(db, CREATOR_1, 3)).toBe(true);
    expect(await warningSent(db, CREATOR_1, 6)).toBe(false);
  });

  it('listStrikeSummary ranks creators by strike count desc', async () => {
    await recordStrike(db, { creatorPubkey: CREATOR_1, videoEventId: VIDEO_A, label: 'gambling', now: 1 });
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_A, label: 'gambling', now: 2 });
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_B, label: 'violence', now: 3 });
    const summary = await listStrikeSummary(db, { limit: 10 });
    expect(summary[0]).toMatchObject({ creator_pubkey: CREATOR_2, strikes: 2 });
    expect(summary[1]).toMatchObject({ creator_pubkey: CREATOR_1, strikes: 1 });
  });
});
