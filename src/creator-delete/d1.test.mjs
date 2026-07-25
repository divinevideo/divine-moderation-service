// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for D1 helpers — claimRow idempotency + decideAction state machine for all row statuses.
// ABOUTME: Uses an in-memory fake D1 (makeFakeD1) imported from ./test-helpers.mjs.

import { describe, it, expect, beforeEach } from 'vitest';
import { claimRow, readRow, updateToSuccess, updateToFailed, decideAction, IN_PROGRESS_TIMEOUT_MS, MAX_RETRY_COUNT } from './d1.mjs';
import { makeFakeD1 } from './test-helpers.mjs';

describe('claimRow', () => {
  let db;
  beforeEach(() => { db = makeFakeD1(); });

  it('claims a new row and returns claimed: true', async () => {
    const now = new Date().toISOString();
    const result = await claimRow(db, {
      kind5_id: 'k1',
      target_event_id: 't1',
      creator_pubkey: 'pub1',
      accepted_at: now
    });
    expect(result.claimed).toBe(true);
    expect(result.existing).toBeNull();
  });

  it('does not claim when row already exists; returns existing', async () => {
    const now = new Date().toISOString();
    await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: now });
    const second = await claimRow(db, { kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', accepted_at: new Date().toISOString() });
    expect(second.claimed).toBe(false);
    expect(second.existing).toMatchObject({ kind5_id: 'k1', target_event_id: 't1', status: 'accepted' });
  });
});

describe('decideAction', () => {
  it('proceed when no row exists', () => {
    expect(decideAction(null)).toBe('proceed');
  });

  it('skip_success on terminal success', () => {
    expect(decideAction({ status: 'success' })).toBe('skip_success');
  });

  it('skip_permanent_failure on permanent failure', () => {
    expect(decideAction({ status: 'failed:permanent:blossom_400' })).toBe('skip_permanent_failure');
  });

  it('skip_in_progress when accepted and recent', () => {
    const now = Date.now();
    const existing = {
      status: 'accepted',
      accepted_at: new Date(now - 5_000).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('skip_in_progress');
  });

  it('proceed when accepted but stale', () => {
    const now = Date.now();
    const existing = {
      status: 'accepted',
      accepted_at: new Date(now - IN_PROGRESS_TIMEOUT_MS - 1).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('proceed');
  });

  it('skip_in_progress when failed:transient retry backoff has not elapsed', () => {
    const now = Date.now();
    const existing = {
      status: 'failed:transient:blossom_5xx',
      retry_count: 2,
      accepted_at: new Date(now - 119_000).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('skip_in_progress');
  });

  it('proceed when failed:transient retry backoff has elapsed', () => {
    const now = Date.now();
    const existing = {
      status: 'failed:transient:blossom_5xx',
      retry_count: 2,
      accepted_at: new Date(now - 120_001).toISOString()
    };
    expect(decideAction(existing, { now })).toBe('proceed');
  });

  it('skip when failed:transient and retries exhausted', () => {
    expect(decideAction({ status: 'failed:transient:blossom_5xx', retry_count: MAX_RETRY_COUNT })).toBe('skip_permanent_failure');
  });
});
