// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Unit tests for the helpers exported by backfill-quarantine-relay.mjs.
// ABOUTME: notifyRelay() itself is covered by relay-notifier.test.mjs; here we
// ABOUTME: just check argv parsing and chunk dispatch shape.

import { describe, it, expect, vi } from 'vitest';
import { parseArgs, processChunk } from './backfill-quarantine-relay.mjs';

describe('parseArgs', () => {
  it('defaults to live run with concurrency 5 and no limit', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null, concurrency: 5 });
  });

  it('reads --dry-run, --limit, --concurrency', () => {
    expect(parseArgs(['--dry-run', '--limit', '50', '--concurrency', '8'])).toEqual({
      dryRun: true,
      limit: 50,
      concurrency: 8,
    });
  });

  it('ignores unknown args', () => {
    expect(parseArgs(['--frobnicate', '--limit', '10'])).toEqual({
      dryRun: false,
      limit: 10,
      concurrency: 5,
    });
  });
});

describe('processChunk', () => {
  it('does not call notify when dryRun is true', async () => {
    const notify = vi.fn();
    const rows = [
      { sha256: 'a'.repeat(64), event_id: 'b'.repeat(64) },
      { sha256: 'c'.repeat(64), event_id: 'd'.repeat(64) },
    ];
    const out = await processChunk(rows, {}, true, notify);
    expect(notify).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.result).toEqual({ success: true, skipped: true, reason: 'dry-run' });
    }
  });

  it('calls notify with QUARANTINE for each row in live mode', async () => {
    const notify = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'boom' });
    const rows = [
      { sha256: 'a'.repeat(64), event_id: 'b'.repeat(64) },
      { sha256: 'c'.repeat(64), event_id: 'd'.repeat(64) },
    ];
    const out = await processChunk(rows, { FUNNELCAKE_ADMIN_URL: 'x' }, false, notify);
    expect(notify).toHaveBeenCalledTimes(2);
    for (const call of notify.mock.calls) {
      expect(call[2]).toBe('QUARANTINE');
    }
    expect(out[0].result.success).toBe(true);
    expect(out[1].result.success).toBe(false);
  });
});
