// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the community-label sweep orchestrator — publish-once,
// ABOUTME: cursor semantics, strike/warning accounting, batch cap, resilience.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runCommunityLabelSweep } from './sweep.mjs';
import { hasDecision, recordStrike } from './d1.mjs';
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

// Mirrors the real publisher: a deterministic id derived from the frozen
// inputs, so a rebuild with the SAME inputs yields the SAME id and a rebuild
// after the clock advances yields a different one — letting tests prove the
// STORED event is replayed, not a fresh rebuild.
function fakeLabelEvent({ videoEventId, sha256, label, voteCount, createdAt }) {
  return {
    id: `${videoEventId.slice(0, 8)}:${label}:${voteCount}:${createdAt}`,
    pubkey: MODERATION,
    kind: 1985,
    created_at: createdAt,
    tags: [
      ['L', 'content-warning'],
      ['l', label, 'content-warning'],
      ['e', videoEventId],
      ['x', sha256],
    ],
    content: `Community consensus flagged: ${label} (${voteCount})`,
    sig: 's'.repeat(128),
  };
}

function makeDeps({
  votes = [labelVote(ALICE, 'gambling'), labelVote(BOB, 'gambling'), labelVote(CAROL, 'gambling')],
  video = videoEvent(),
  divine = true,
  publishResult = { published: true },
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
    buildLabelEvent: vi.fn(async (args) => fakeLabelEvent(args)),
    publishLabel: vi.fn(async ({ event }) => ({
      published: publishResult.published,
      eventId: publishResult.published ? event.id : undefined,
    })),
    sendWarningDm: vi.fn().mockResolvedValue({ sent: true }),
    moderationPubkey: MODERATION,
  };
}

// Make the first community_strikes INSERT throw, then behave normally — the
// "decision recorded but strike failed" partial-failure B5 must recover from.
function failStrikeInsertOnce(db) {
  let failed = false;
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (sql.includes('INSERT') && sql.includes('community_strikes')) {
      const realRun = stmt.run.bind(stmt);
      stmt.run = async () => {
        if (!failed) {
          failed = true;
          throw new Error('strike insert failed');
        }
        return realRun();
      };
    }
    return stmt;
  };
  return db;
}

// One-shot failure of the FIRST community_label_decisions write that runs
// after a successful publish — the post-publish bookkeeping write. Pins the
// "publish landed, decision write failed" partial failure regardless of
// whether that write is a single insert or a claim-then-confirm pair.
function failDecisionWriteAfterPublish(deps) {
  let failed = false;
  let sawPublish = false;
  const realPublish = deps.publishLabel;
  deps.publishLabel = vi.fn(async (args) => {
    const result = await realPublish(args);
    if (result?.published) sawPublish = true;
    return result;
  });
  const realPrepare = deps.db.prepare.bind(deps.db);
  deps.db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (sql.includes('community_label_decisions') && (sql.includes('INSERT') || sql.includes('UPDATE'))) {
      const realRun = stmt.run.bind(stmt);
      stmt.run = async () => {
        if (!failed && sawPublish) { failed = true; throw new Error('decision write failed'); }
        return realRun();
      };
    }
    return stmt;
  };
}

// One-shot failure of the FIRST community_strike_warnings write that runs
// after a warning DM is sent — the post-send bookkeeping write. Reproduces
// the "DM sent, record failed" partial failure for both the single-insert
// and claim-then-confirm shapes, so the test pins the invariant.
function failWarningWriteAfterSend(deps) {
  let failed = false;
  let sawSend = false;
  const realSend = deps.sendWarningDm;
  deps.sendWarningDm = vi.fn(async (...args) => {
    const result = await realSend(...args);
    if (result?.sent) sawSend = true;
    return result;
  });
  const realPrepare = deps.db.prepare.bind(deps.db);
  deps.db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (sql.includes('community_strike_warnings') && (sql.includes('INSERT') || sql.includes('UPDATE'))) {
      const realRun = stmt.run.bind(stmt);
      stmt.run = async () => {
        if (!failed && sawSend) { failed = true; throw new Error('warning write failed'); }
        return realRun();
      };
    }
    return stmt;
  };
}

describe('runCommunityLabelSweep', () => {
  let deps;
  beforeEach(() => { deps = makeDeps(); });

  it('publishes once when a label crosses the threshold and records the decision', async () => {
    const result = await runCommunityLabelSweep(deps);

    expect(deps.buildLabelEvent).toHaveBeenCalledTimes(1);
    expect(deps.buildLabelEvent).toHaveBeenCalledWith(expect.objectContaining({
      videoEventId: VIDEO_ID,
      sha256: SHA,
      label: 'gambling',
      voteCount: 3,
      createdAt: NOW_SECONDS,
    }));
    expect(deps.publishLabel).toHaveBeenCalledTimes(1);
    expect(deps.publishLabel).toHaveBeenCalledWith({
      event: expect.objectContaining({
        id: `${VIDEO_ID.slice(0, 8)}:gambling:3:${NOW_SECONDS}`,
        kind: 1985,
      }),
    });
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

  it('leaves only a pending claim (never a confirmed decision) and holds the watermark when publish fails', async () => {
    deps = makeDeps({ publishResult: { published: false } });

    const result = await runCommunityLabelSweep(deps);

    // The pre-publish claim persists so a retry replays the same frozen event,
    // but it is never confirmed — no authoritative label was published.
    expect(await hasDecision(deps.db, VIDEO_ID, 'gambling')).toBe(false);
    const decision = [...deps.db.decisions.values()][0];
    expect(decision.status).toBe('pending');
    expect(decision.published_event_id).toBe('');
    expect(result.published).toBe(0);
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

  it('recovers a strike on a later tick when it failed after the decision was recorded', async () => {
    // Partial failure: publish + decision confirm succeed, recordStrike throws.
    // The strike must be ensured independently on a later tick even though the
    // decision already exists, instead of being lost forever behind the
    // publish-once dedup.
    deps = makeDeps();
    failStrikeInsertOnce(deps.db);

    const tick1 = await runCommunityLabelSweep(deps);
    expect(deps.db.decisions.size).toBe(1);
    expect(deps.db.strikes.size).toBe(0);
    expect(tick1.cursorAdvanced).toBe(false);

    deps.publishLabel.mockClear();
    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });

    expect(deps.publishLabel).not.toHaveBeenCalled();
    expect(deps.db.strikes.size).toBe(1);
    expect(tick2.strikes).toBe(1);
  });

  it('warns once per escalation level, not per raw strike count', async () => {
    // Self-labeled video: the crossing publishes but produces no strike, so
    // the creator's strike total is exactly what we seed — isolating the
    // warning-level gate from the sweep's own strike creation.
    deps = makeDeps({
      votes: [labelVote(ALICE, 'nudity'), labelVote(BOB, 'nudity'), labelVote(CAROL, 'nudity')],
      video: videoEvent({ selfLabels: ['nudity'] }),
    });

    // warningCount defaults to 3, so level = floor(strikes / 3).
    async function seedStrikes(count) {
      deps.db.strikes.clear();
      for (let i = 0; i < count; i += 1) {
        await recordStrike(deps.db, {
          creatorPubkey: CREATOR,
          videoEventId: `${i}`.padEnd(64, 'd'),
          label: 'seed',
          now: 1,
        });
      }
    }

    await seedStrikes(3); // level 1 — first warning
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS });
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);

    await seedStrikes(4); // still level 1 — no new warning
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);

    await seedStrikes(5); // still level 1 — no new warning
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 600 });
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);

    await seedStrikes(6); // level 2 — second warning
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 900 });
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(2);
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

  it('holds the watermark when a Divine-identity lookup throws (transient)', async () => {
    // isDivine is wired with throwOnTransient: true, so a transient name-server
    // failure throws into the per-video try/catch and holds the cursor for
    // retry rather than silently counting the author as not-Divine.
    deps.isDivine.mockRejectedValue(new Error('names 503'));

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

  it('skips a fetched event that is not a Divine video (wrong kind) without holding the cursor', async () => {
    // A forged vote's `e` can point at a non-video event (e.g. a kind 1 note).
    // That is a genuine non-target, not a transient failure, so sweep it and
    // let the cursor advance rather than labeling arbitrary events.
    deps.fetchVideoEvent.mockResolvedValue({
      id: VIDEO_ID,
      pubkey: CREATOR,
      kind: 1,
      tags: [],
    });

    const result = await runCommunityLabelSweep(deps);

    expect(deps.publishLabel).not.toHaveBeenCalled();
    expect(deps.fetchLabelsForVideo).not.toHaveBeenCalled();
    expect(result.cursorAdvanced).toBe(true);
  });

  it('tallies via the addressable id derived from the fetched video, not the vote a tag', async () => {
    // Attack: a forged vote pairs the victim's `e` with another video's
    // already-crossed `a` to borrow its consensus. The tally must query the
    // address DERIVED from the fetched victim video's own `d` tag, never the
    // attacker-controlled `a`.
    const attackerAddress = `34236:${'e'.repeat(64)}:borrowed-consensus`;
    const forgedVotes = [ALICE, BOB, CAROL].map((author) => ({
      id: `${author.slice(0, 8)}gam`.padEnd(64, '0').slice(0, 64),
      pubkey: author,
      kind: 1985,
      created_at: NOW_SECONDS - 60,
      tags: [
        ['L', 'content-warning'],
        ['l', 'gambling', 'content-warning'],
        ['e', VIDEO_ID],
        ['a', attackerAddress],
      ],
    }));
    const videoWithDTag = {
      id: VIDEO_ID,
      pubkey: CREATOR,
      kind: 34236,
      tags: [['d', 'real-vine-id'], ['x', SHA]],
    };
    deps = makeDeps({ votes: forgedVotes, video: videoWithDTag });

    await runCommunityLabelSweep(deps);

    expect(deps.fetchLabelsForVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: VIDEO_ID,
        addressableId: `34236:${CREATOR}:real-vine-id`,
      }),
    );
    const passedAddresses = deps.fetchLabelsForVideo.mock.calls.map((call) => call[0].addressableId);
    expect(passedAddresses).not.toContain(attackerAddress);
  });

  it('tallies with a null address when the fetched video has no d tag', async () => {
    // A non-addressable / d-less video yields no derived address; the tally
    // then queries by `e` alone (fetchLabelsForVideo skips the #a query).
    deps = makeDeps({
      video: { id: VIDEO_ID, pubkey: CREATOR, kind: 34236, tags: [['x', SHA]] },
    });

    await runCommunityLabelSweep(deps);

    expect(deps.fetchLabelsForVideo).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: VIDEO_ID, addressableId: null }),
    );
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

  it('holds and freezes the cursor when the since-poll page is full (possible truncation)', async () => {
    // Funnelcake truncates newest-first (ORDER BY created_at DESC LIMIT), so
    // a full page has dropped the OLDEST votes. Advancing the watermark at
    // all would skip those unseen older votes, so the sweep still processes
    // what it saw but holds — and freezes the first-run sliding cursor at
    // its current value so the trailing edge stops moving.
    const result = await runCommunityLabelSweep({ ...deps, sincePollLimit: 3 });

    expect(result.published).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    // Frozen at the first-run default (now - 24h), not advanced to now.
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 24 * 60 * 60),
    );
  });

  it('a frozen first-run cursor does not slide on the next full-page tick', async () => {
    // Cold start: without the freeze, getCursor keeps returning a sliding
    // now-24h and a trailing-edge vote ages out. After a full-page tick
    // freezes it, the next tick reads the frozen value, not a new slide.
    await runCommunityLabelSweep({ ...deps, sincePollLimit: 3 });
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300, sincePollLimit: 3 });

    // Still the tick-1 freeze value, not a fresh (now+300)-24h slide (and
    // not unpersisted, which is what the pre-freeze code left it at).
    expect(deps.kv.store.get('community_labels_cursor')).toBe(
      String(NOW_SECONDS - 24 * 60 * 60),
    );
  });

  it('persists the cold-start cursor when the earliest failing vote sits at the lookback boundary', async () => {
    // First-run cursor is now-24h (unpersisted). A vote exactly at that
    // boundary that fails to publish yields a held watermark <= cursor, which
    // the old write logic left unpersisted — so the next tick's fresh now-24h
    // slide aged the failed vote out. The held value must be persisted instead.
    const boundary = NOW_SECONDS - 24 * 60 * 60;
    deps = makeDeps({
      votes: [
        labelVote(ALICE, 'gambling', { createdAt: boundary }),
        labelVote(BOB, 'gambling', { createdAt: boundary }),
        labelVote(CAROL, 'gambling', { createdAt: boundary }),
      ],
      publishResult: { published: false },
    });

    const result = await runCommunityLabelSweep(deps);

    expect(result.cursorAdvanced).toBe(false);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(String(boundary));
  });

  it('advances the cursor on an empty poll', async () => {
    deps = makeDeps({ votes: [] });

    const result = await runCommunityLabelSweep(deps);

    expect(result.cursorAdvanced).toBe(true);
    expect(deps.kv.store.get('community_labels_cursor')).toBe(String(NOW_SECONDS));
  });

  it('replays the exact stored event on retry after a partial failure, confirming exactly once', async () => {
    // Publish lands but the post-publish confirm write fails on tick 1. The
    // cursor holds; tick 2 must republish the SAME stored event the relay
    // dedups by id, and confirm the decision exactly once — never a duplicate
    // authoritative label. The tick-2 rebuild would use the advanced clock
    // (NOW_SECONDS + 300) and produce a different id, so replaying the stored
    // event, not the rebuild, is what keeps the id stable.
    deps = makeDeps();
    failDecisionWriteAfterPublish(deps);

    const tick1 = await runCommunityLabelSweep(deps);
    expect(deps.publishLabel).toHaveBeenCalledTimes(1);
    expect(tick1.published).toBe(0);
    expect(tick1.cursorAdvanced).toBe(false);

    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });

    expect(deps.publishLabel).toHaveBeenCalledTimes(2);
    const [call1, call2] = deps.publishLabel.mock.calls;
    const expectedId = `${VIDEO_ID.slice(0, 8)}:gambling:3:${NOW_SECONDS}`;
    expect(call1[0].event.id).toBe(expectedId);
    expect(call2[0].event.id).toBe(expectedId);
    expect(call2[0].event.created_at).toBe(NOW_SECONDS);

    expect(tick2.published).toBe(1);
    expect(deps.db.decisions.size).toBe(1);
    const decision = [...deps.db.decisions.values()][0];
    expect(decision.status).toBe('confirmed');
    expect(decision.published_event_id).toBe(expectedId);
  });

  it('republishes the stored event, not a fresh rebuild, after a code or key change', async () => {
    // A publish/confirm split can straddle a redeploy or key rotation, so the
    // tick-2 rebuild can differ from the tick-1 event even with identical
    // inputs. The claim persists the exact tick-1 bytes, so both publishes use
    // that stored event — the relay dedups it and no second label id is minted.
    deps = makeDeps();
    let build = 0;
    deps.buildLabelEvent = vi.fn(async ({ videoEventId, label }) => {
      build += 1;
      return {
        id: `${label}-build-${build}`,
        pubkey: MODERATION,
        kind: 1985,
        created_at: NOW_SECONDS,
        tags: [['e', videoEventId]],
        content: '',
        sig: 's'.repeat(128),
      };
    });
    failDecisionWriteAfterPublish(deps);

    await runCommunityLabelSweep(deps);
    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });

    // Fresh build each tick (tick 1 -> build-1, tick 2 -> build-2)...
    expect(deps.buildLabelEvent).toHaveBeenCalledTimes(2);
    // ...but both publishes replay tick-1's stored event, never build-2.
    const [call1, call2] = deps.publishLabel.mock.calls;
    expect(call1[0].event.id).toBe('gambling-build-1');
    expect(call2[0].event.id).toBe('gambling-build-1');

    expect(tick2.published).toBe(1);
    const decision = [...deps.db.decisions.values()][0];
    expect(decision.published_event_id).toBe('gambling-build-1');
  });

  it('does not re-send the warning DM after a post-send bookkeeping failure', async () => {
    // Warning DM sends, but recording it fails on tick 1. The claim-before-send
    // pending row must block a second DM on the retry — trading a rare missed
    // warning for never double-DMing the creator.
    deps = makeDeps({ kvEntries: { strike_warning_count: '1' } });
    failWarningWriteAfterSend(deps);

    await runCommunityLabelSweep(deps);
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);

    deps.sendWarningDm.mockClear();
    await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(deps.sendWarningDm).not.toHaveBeenCalled();
  });

  it('retains the claim and never resends the warning after an ambiguous send failure', async () => {
    // {sent:false, definitive:false} — a relay may have accepted the gift-wrap
    // while its OK was lost, so we can't prove no DM went out. The claim is
    // retained and the next tick does NOT re-send, so a possibly-delivered
    // warning is never duplicated (gift-wraps have random ids, so the relay
    // can't dedup a resend for us).
    deps = makeDeps({ kvEntries: { strike_warning_count: '1' } });
    deps.sendWarningDm.mockResolvedValueOnce({
      sent: false,
      definitive: false,
      reason: 'All relay publishes failed',
    });

    const tick1 = await runCommunityLabelSweep(deps);
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);
    expect(tick1.warned).toBe(0);

    deps.sendWarningDm.mockClear();
    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(deps.sendWarningDm).not.toHaveBeenCalled();
    expect(tick2.warned).toBe(0);
  });

  it('releases the claim and retries the warning after a definitive pre-send failure', async () => {
    // {sent:false, definitive:true} — the DM failed before any publish (e.g.
    // rate limited), so no gift-wrap went out. Exercises the claim state
    // machine: the claim is released, so a later sweep re-claims and re-sends
    // (here the fake fetch re-surfaces the same votes); on success the warning
    // is confirmed exactly once. (Production retry is opportunistic — it needs a
    // fresh vote to re-enter the window — but that watermark flow is out of
    // scope for this unit test.)
    deps = makeDeps({ kvEntries: { strike_warning_count: '1' } });
    deps.sendWarningDm.mockResolvedValueOnce({
      sent: false,
      definitive: true,
      reason: 'Rate limited',
    });

    const tick1 = await runCommunityLabelSweep(deps);
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(1);
    expect(tick1.warned).toBe(0);

    const tick2 = await runCommunityLabelSweep({ ...deps, now: NOW_SECONDS + 300 });
    expect(deps.sendWarningDm).toHaveBeenCalledTimes(2);
    expect(tick2.warned).toBe(1);
  });
});
