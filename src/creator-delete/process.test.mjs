// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for processKind5 — happy path, multi-target, error categorization, idempotent skip.
// ABOUTME: Uses makeFakeD1 from ./test-helpers.mjs; callBlossomDelete and fetchTargetEvent are vi.fn mocks.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processKind5, MAX_TARGETS_PER_KIND5 } from './process.mjs';
import { MAX_RETRY_COUNT } from './d1.mjs';
import { makeFakeD1 } from './test-helpers.mjs';

describe('processKind5', () => {
  let db, fetchTargetEvent, callBlossomDelete;

  beforeEach(() => {
    db = makeFakeD1();
    fetchTargetEvent = vi.fn();
    callBlossomDelete = vi.fn();
  });

  const SHA_C = 'c'.repeat(64); // 64-char hex fixture (extractSha256 requires exactly 64 hex chars)

  it('happy path: claim, fetch target, extract sha256, call Blossom, mark success', async () => {
    const kind5 = {
      id: 'k1',
      pubkey: 'pub1',
      tags: [['e', 't1']]
    };
    fetchTargetEvent.mockResolvedValueOnce({
      id: 't1',
      pubkey: 'pub1',
      tags: [['imeta', `url https://media.divine.video/${SHA_C}.mp4`, `x ${SHA_C}`]]
    });
    callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });

    const result = await processKind5(kind5, {
      db,
      fetchTargetEvent,
      callBlossomDelete
    });

    expect(result.targets).toEqual([{ target_event_id: 't1', status: 'success', blob_sha256: SHA_C }]);
    expect(callBlossomDelete).toHaveBeenCalledWith(SHA_C);
  });

  it('multi-target kind 5: processes each independently', async () => {
    const kind5 = {
      id: 'k1',
      pubkey: 'pub1',
      tags: [['e', 't1'], ['e', 't2']]
    };
    fetchTargetEvent
      .mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', 'x aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']] })
      .mockResolvedValueOnce({ id: 't2', pubkey: 'pub1', tags: [['imeta', 'x bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']] });
    callBlossomDelete.mockResolvedValue({ success: true, status: 200 });

    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets).toHaveLength(2);
    expect(result.targets.map(t => t.status)).toEqual(['success', 'success']);
  });

  it('target_unresolved when Funnelcake returns null', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce(null);
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:permanent:target_unresolved');
    expect(callBlossomDelete).not.toHaveBeenCalled();
  });

  it('no_sha256 when target event has no imeta', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [] });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:permanent:no_sha256');
  });

  it('transient failure on Blossom 503', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    callBlossomDelete.mockResolvedValueOnce({ success: false, status: 503, error: 'HTTP 503: service unavailable' });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:transient:blossom_5xx');
  });

  it('permanent failure on Blossom 400', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    callBlossomDelete.mockResolvedValueOnce({ success: false, status: 400, error: 'HTTP 400: bad request' });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:permanent:blossom_400');
  });

  it('transient failure on network error', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce({ id: 't1', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    callBlossomDelete.mockResolvedValueOnce({ success: false, error: 'connection reset', networkError: true });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:transient:network');
  });

  it('skips when existing row is success (idempotent)', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    // Pre-seed D1 directly — bypass the fake's INSERT path, which is tailored to
    // claimRow's 4-arg bind with an inlined 'accepted' status literal. A direct
    // rows.set() lets this test simulate a pre-existing terminal row.
    db.rows.set('k1:t1', {
      kind5_id: 'k1',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      status: 'success',
      accepted_at: new Date().toISOString(),
      blob_sha256: SHA_C,
      retry_count: 0,
      last_error: null,
      completed_at: new Date().toISOString()
    });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('success');
    expect(result.targets[0].skipped).toBe(true);
    expect(callBlossomDelete).not.toHaveBeenCalled();
    expect(fetchTargetEvent).not.toHaveBeenCalled();
  });

  it('caps processing at MAX_TARGETS_PER_KIND5 when given more e-tags', async () => {
    // Build a kind 5 with N+5 e-tags. Only the first MAX should be processed.
    const overflow = 5;
    const eTags = [];
    for (let i = 0; i < MAX_TARGETS_PER_KIND5 + overflow; i++) {
      eTags.push(['e', `t${i.toString().padStart(3, '0')}`]);
    }
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: eTags };
    fetchTargetEvent.mockResolvedValue({ id: 't', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    callBlossomDelete.mockResolvedValue({ success: true, status: 200 });

    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });

    expect(result.targets).toHaveLength(MAX_TARGETS_PER_KIND5);
    expect(callBlossomDelete).toHaveBeenCalledTimes(MAX_TARGETS_PER_KIND5);
  });

  it('author_mismatch when kind5 pubkey differs from target pubkey', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockResolvedValueOnce({
      id: 't1',
      pubkey: 'different_pub',
      tags: [['imeta', `x ${SHA_C}`]]
    });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:permanent:author_mismatch');
    expect(callBlossomDelete).not.toHaveBeenCalled();
  });

  it('transient fetch error records failed:transient:target_fetch', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    fetchTargetEvent.mockRejectedValueOnce(new Error('All 1 relay(s) returned transient errors'));
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:transient:target_fetch');
    expect(callBlossomDelete).not.toHaveBeenCalled();
  });

  it('transient fetch promotes to permanent after max retries', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1']] };
    db.rows.set('k1:t1', {
      kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1',
      status: 'failed:transient:target_fetch',
      accepted_at: new Date(Date.now() - 300_000).toISOString(),
      blob_sha256: null, retry_count: MAX_RETRY_COUNT - 1,
      last_error: 'prior transient', completed_at: null
    });
    fetchTargetEvent.mockRejectedValueOnce(new Error('All relays transient'));
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:permanent:max_retries_exceeded');
  });

  it('multi-target: transient fetch on first, success on second', async () => {
    const kind5 = { id: 'k1', pubkey: 'pub1', tags: [['e', 't1'], ['e', 't2']] };
    fetchTargetEvent
      .mockRejectedValueOnce(new Error('relay transient'))
      .mockResolvedValueOnce({ id: 't2', pubkey: 'pub1', tags: [['imeta', `x ${SHA_C}`]] });
    callBlossomDelete.mockResolvedValueOnce({ success: true, status: 200 });
    const result = await processKind5(kind5, { db, fetchTargetEvent, callBlossomDelete });
    expect(result.targets[0].status).toBe('failed:transient:target_fetch');
    expect(result.targets[1].status).toBe('success');
  });
});
