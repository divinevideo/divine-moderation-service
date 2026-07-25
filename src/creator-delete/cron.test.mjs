// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for runCreatorDeleteCron — happy-path query and transient-retry sweep.
// ABOUTME: Uses makeFakeD1/makeFakeKV; seeds transient rows via rows.set() (fake INSERT is 4-arg only).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POLL_OVERLAP_SECONDS, runCreatorDeleteCron } from './cron.mjs';
import { MAX_RETRY_COUNT } from './d1.mjs';
import { makeFakeD1, makeFakeKV } from './test-helpers.mjs';

const SHA_C = 'c'.repeat(64); // 64-char hex fixture (extractSha256 requires)

describe('runCreatorDeleteCron', () => {
  let deps;
  beforeEach(() => {
    deps = {
      db: makeFakeD1(),
      kv: makeFakeKV(),
      queryKind5Since: vi.fn(),
      fetchTargetEvent: vi.fn(),
      callBlossomDelete: vi.fn(),
      now: () => 1700000000000
    };
  });

  it('queries Funnelcake from last poll, processes each event, updates last poll', async () => {
    await deps.kv.put('creator-delete-cron:last-poll', String(1700000000000 - 60_000));
    deps.queryKind5Since.mockResolvedValueOnce([
      { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] }
    ]);
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await runCreatorDeleteCron(deps);
    expect(deps.queryKind5Since).toHaveBeenCalled();
    expect(result.processed).toBe(1);
    const lastPoll = await deps.kv.get('creator-delete-cron:last-poll');
    expect(Number(lastPoll)).toBe(1700000000000);
  });

  it('recovers a delayed kind 5 within the poll overlap without repeating Blossom DELETE', async () => {
    let nowMs = 1700000000000;
    let visible = false;
    const kind5 = {
      id: 'delayed-k5',
      pubkey: 'pub1',
      created_at: 1699999970,
      tags: [['e', 't1']]
    };

    deps.now = () => nowMs;
    deps.queryKind5Since.mockImplementation(async (sinceSeconds) => (
      visible && kind5.created_at >= sinceSeconds ? [kind5] : []
    ));
    deps.fetchTargetEvent.mockResolvedValue({
      id: 't1',
      pubkey: 'pub1',
      tags: [['imeta', `x ${SHA_C}`]]
    });
    deps.callBlossomDelete.mockResolvedValue({ success: true, status: 200 });

    const firstPoll = await runCreatorDeleteCron(deps);
    nowMs += 60_000;
    const secondPoll = await runCreatorDeleteCron(deps);

    visible = true;
    nowMs += 60_000;
    const recoveryPoll = await runCreatorDeleteCron(deps);

    nowMs += 60_000;
    const replayPoll = await runCreatorDeleteCron(deps);

    expect([
      firstPoll.processed,
      secondPoll.processed,
      recoveryPoll.processed,
      replayPoll.processed
    ]).toEqual([0, 0, 1, 0]);
    expect(deps.db.rows.get('delayed-k5:t1')).toMatchObject({
      status: 'success',
      blob_sha256: SHA_C
    });
    expect(deps.fetchTargetEvent).toHaveBeenCalledTimes(1);
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(1);
    expect(deps.queryKind5Since.mock.calls.map(([sinceSeconds]) => sinceSeconds)).toEqual([
      1699996400,
      1700000000 - POLL_OVERLAP_SECONDS,
      1700000060 - POLL_OVERLAP_SECONDS,
      1700000120 - POLL_OVERLAP_SECONDS
    ]);
  });

  it('keeps overlap replays from bypassing transient retry backoff', async () => {
    let nowMs = 1700000000000;
    const kind5 = {
      id: 'retry-k5',
      pubkey: 'pub1',
      created_at: 1699999970,
      tags: [['e', 't1']]
    };

    deps.now = () => nowMs;
    deps.queryKind5Since.mockImplementation(async (sinceSeconds) => (
      kind5.created_at >= sinceSeconds ? [kind5] : []
    ));
    deps.fetchTargetEvent.mockResolvedValue({
      id: 't1',
      pubkey: 'pub1',
      tags: [['imeta', `x ${SHA_C}`]]
    });
    deps.callBlossomDelete
      .mockResolvedValueOnce({ success: false, status: 503, error: 'HTTP 503: unavailable' })
      .mockResolvedValueOnce({ success: true, status: 200 });

    const firstPoll = await runCreatorDeleteCron(deps);
    expect(firstPoll.processed).toBe(1);
    expect(deps.db.rows.get('retry-k5:t1')).toMatchObject({
      status: 'failed:transient:blossom_5xx',
      retry_count: 1
    });
    expect(deps.fetchTargetEvent).toHaveBeenCalledTimes(1);
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    const earlyReplay = await runCreatorDeleteCron(deps);
    expect(earlyReplay.processed).toBe(0);
    expect(deps.fetchTargetEvent).toHaveBeenCalledTimes(1);
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    const dueRetry = await runCreatorDeleteCron(deps);
    expect(dueRetry.processed).toBe(1);
    expect(deps.db.rows.get('retry-k5:t1')).toMatchObject({
      status: 'success',
      retry_count: 1
    });
    expect(deps.fetchTargetEvent).toHaveBeenCalledTimes(2);
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(2);
  });

  it('processes non-transient sibling targets when another target is still in backoff', async () => {
    let nowMs = 1700000000000;
    const kind5 = {
      id: 'partial-k5',
      pubkey: 'pub1',
      created_at: 1699999970,
      tags: [['e', 't1'], ['e', 't2']]
    };
    deps.db.rows.set('partial-k5:t1', {
      kind5_id: 'partial-k5',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      status: 'failed:transient:blossom_5xx',
      accepted_at: new Date(nowMs - 30_000).toISOString(),
      blob_sha256: null,
      retry_count: 1,
      last_error: 'HTTP 503: prior attempt',
      completed_at: null
    });

    deps.now = () => nowMs;
    deps.queryKind5Since.mockResolvedValueOnce([kind5]);
    deps.fetchTargetEvent.mockResolvedValueOnce({
      id: 't2',
      pubkey: 'pub1',
      tags: [['imeta', `x ${SHA_C}`]]
    });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await runCreatorDeleteCron(deps);

    expect(result.processed).toBe(1);
    expect(deps.fetchTargetEvent).toHaveBeenCalledTimes(1);
    expect(deps.fetchTargetEvent).toHaveBeenCalledWith('t2');
    expect(deps.callBlossomDelete).toHaveBeenCalledTimes(1);
    expect(deps.db.rows.get('partial-k5:t1')).toMatchObject({
      status: 'failed:transient:blossom_5xx',
      retry_count: 1
    });
    expect(deps.db.rows.get('partial-k5:t2')).toMatchObject({
      status: 'success',
      blob_sha256: SHA_C
    });
  });

  it('retries failed:transient rows with retry_count below MAX_RETRY_COUNT', async () => {
    // Seed D1 directly — the fake's INSERT path is tailored to claimRow's
    // 4-arg bind with 'accepted' status literal, so it can't represent a
    // pre-existing failed:transient row. Direct rows.set() bypasses it.
    deps.db.rows.set('k1:t1', {
      kind5_id: 'k1',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      status: 'failed:transient:blossom_5xx',
      accepted_at: new Date(1700000000000 - 300_000).toISOString(),
      blob_sha256: null,
      retry_count: MAX_RETRY_COUNT - 3,
      last_error: 'HTTP 503: prior attempt',
      completed_at: null
    });

    await deps.kv.put('creator-delete-cron:last-poll', String(Date.now() - 30_000));
    deps.queryKind5Since.mockResolvedValueOnce([]); // no new events
    deps.fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    deps.callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await runCreatorDeleteCron(deps);
    expect(deps.callBlossomDelete).toHaveBeenCalledWith(SHA_C);
    expect(result.processed).toBeGreaterThanOrEqual(1);
  });
});
