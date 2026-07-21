// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for community-label D1 helpers — decision/strike/warning
// ABOUTME: idempotency and the strike summary ranking. Uses makeFakeCommunityD1.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  hasDecision,
  claimDecision,
  confirmDecision,
  recordStrike,
  strikeCount,
  claimWarning,
  confirmWarning,
  listStrikeSummary,
  listStrikesForCreator,
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

  const claim = (overrides = {}) => claimDecision(db, {
    videoEventId: VIDEO_A,
    label: 'gambling',
    voteCount: 3,
    videoSha256: SHA,
    creatorPubkey: CREATOR_1,
    preparedEvent: { id: 'evt-first', kind: 1985 },
    now: 1700000000,
    ...overrides,
  });

  it('hasDecision is false while pending and true only after confirm', async () => {
    expect(await hasDecision(db, VIDEO_A, 'gambling')).toBe(false);
    await claim();
    // A pending claim is not yet a decision — the publish-once guard must not
    // treat it as one, or a crashed-mid-publish label would never be retried.
    expect(await hasDecision(db, VIDEO_A, 'gambling')).toBe(false);
    await confirmDecision(db, { videoEventId: VIDEO_A, label: 'gambling', publishedEventId: PUBLISHED });
    expect(await hasDecision(db, VIDEO_A, 'gambling')).toBe(true);
  });

  it('claimDecision freezes the stored event and vote count across retries', async () => {
    const first = await claim();
    expect(first).toEqual({
      createdAt: 1700000000,
      voteCount: 3,
      preparedEvent: { id: 'evt-first', kind: 1985 },
    });
    // A later tick with a higher vote count, a new clock, AND a differently-
    // built event must read back the ORIGINAL stored event so the replayed
    // label id is identical — a redeploy or key rotation between publishes
    // cannot mint a second authoritative label.
    const second = await claim({
      voteCount: 9,
      now: 1700000999,
      preparedEvent: { id: 'evt-second', kind: 1985 },
    });
    expect(second).toEqual({
      createdAt: 1700000000,
      voteCount: 3,
      preparedEvent: { id: 'evt-first', kind: 1985 },
    });
    expect(db.decisions.size).toBe(1);
  });

  it('confirmDecision records the published id once and does not rewrite it', async () => {
    await claim();
    await confirmDecision(db, { videoEventId: VIDEO_A, label: 'gambling', publishedEventId: PUBLISHED });
    // A re-confirm (e.g. a spurious later tick) must not overwrite the original
    // published id — the UPDATE only flips a still-pending row.
    await confirmDecision(db, { videoEventId: VIDEO_A, label: 'gambling', publishedEventId: 'd'.repeat(64) });
    const decision = [...db.decisions.values()][0];
    expect(decision.status).toBe('confirmed');
    expect(decision.published_event_id).toBe(PUBLISHED);
  });

  it('different labels on the same video are separate decisions', async () => {
    await claim({ label: 'gambling' });
    await claim({ label: 'violence' });
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

  it('claimWarning is granted once per level and blocks resends; confirmWarning marks it sent', async () => {
    // First claim is granted (fresh); a second claim for the same level is
    // refused — that refusal is what blocks a duplicate DM on a retry.
    expect(await claimWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 1, now: 5 })).toBe(true);
    expect(await claimWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 1, now: 6 })).toBe(false);
    // A different escalation level is independently claimable.
    expect(await claimWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 2, now: 7 })).toBe(true);

    await confirmWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 1 });
    expect(db.warnings.get(`${CREATOR_1}:1`).status).toBe('sent');
    // A sent claim still refuses a re-send.
    expect(await claimWarning(db, { creatorPubkey: CREATOR_1, warningLevel: 1, now: 8 })).toBe(false);
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

  it('listStrikesForCreator pages a single creator in SQL, newest first, covering every row', async () => {
    for (let i = 0; i < 25; i += 1) {
      await recordStrike(db, {
        creatorPubkey: CREATOR_1,
        videoEventId: `${i}`.padEnd(64, 'a'),
        label: 'gambling',
        now: i,
      });
    }
    // A second creator's strike must never leak into the drill-down.
    await recordStrike(db, { creatorPubkey: CREATOR_2, videoEventId: VIDEO_B, label: 'violence', now: 999 });

    const page1 = await listStrikesForCreator(db, { creatorPubkey: CREATOR_1, limit: 10, offset: 0 });
    const page2 = await listStrikesForCreator(db, { creatorPubkey: CREATOR_1, limit: 10, offset: 10 });
    const page3 = await listStrikesForCreator(db, { creatorPubkey: CREATOR_1, limit: 10, offset: 20 });

    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    expect(page3).toHaveLength(5);

    // Newest first: created_at descending, so the highest now (24) leads.
    expect(page1[0]).toMatchObject({ video_event_id: '24'.padEnd(64, 'a'), label: 'gambling', created_at: 24 });

    // The three pages together cover all 25 of this creator's rows with no
    // gaps, no duplicates, and no other creator's rows.
    const all = [...page1, ...page2, ...page3];
    expect(new Set(all.map((row) => row.video_event_id)).size).toBe(25);
    expect(all.every((row) => row.label === 'gambling')).toBe(true);
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

  it('chunks detail lookups so high-limit admin pages stay under D1 bind limits', async () => {
    for (let i = 0; i < 125; i += 1) {
      const creatorPubkey = `${i.toString(16)}`.padStart(64, '0');
      await recordStrike(db, {
        creatorPubkey,
        videoEventId: `${i}`.padEnd(64, 'a'),
        label: 'gambling',
        now: i,
      });
    }

    const summary = await listStrikeSummary(db, { limit: 125 });

    expect(summary).toHaveLength(125);
    expect(summary.every((row) => row.recent.length === 1)).toBe(true);
  });
});
