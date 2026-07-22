// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for KV-backed community-label settings — defaults when keys
// ABOUTME: are absent, parsing, garbage fallback, and exact-'true' enablement.

import { describe, it, expect } from 'vitest';
import {
  isEnabled,
  getThreshold,
  getWarningCount,
  getBatchLimit,
  getCursor,
  setCursor,
} from './config.mjs';

function makeKv(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

describe('isEnabled', () => {
  it('is false when the key is absent (deploy != activate)', async () => {
    expect(await isEnabled(makeKv())).toBe(false);
  });

  it("is true only on exactly 'true'", async () => {
    expect(await isEnabled(makeKv({ community_labels_enabled: 'true' }))).toBe(true);
    expect(await isEnabled(makeKv({ community_labels_enabled: 'TRUE' }))).toBe(false);
    expect(await isEnabled(makeKv({ community_labels_enabled: '1' }))).toBe(false);
  });
});

describe('numeric settings', () => {
  it('returns code defaults when keys are absent', async () => {
    const kv = makeKv();
    expect(await getThreshold(kv)).toBe(3);
    expect(await getWarningCount(kv)).toBe(3);
    expect(await getBatchLimit(kv)).toBe(50);
  });

  it('parses stored integer values', async () => {
    const kv = makeKv({
      community_label_threshold: '5',
      strike_warning_count: '2',
      community_sweep_batch_limit: '10',
    });
    expect(await getThreshold(kv)).toBe(5);
    expect(await getWarningCount(kv)).toBe(2);
    expect(await getBatchLimit(kv)).toBe(10);
  });

  it('falls back to defaults on garbage or non-positive values', async () => {
    expect(await getThreshold(makeKv({ community_label_threshold: 'banana' }))).toBe(3);
    expect(await getThreshold(makeKv({ community_label_threshold: '0' }))).toBe(3);
    expect(await getThreshold(makeKv({ community_label_threshold: '-2' }))).toBe(3);
  });
});

describe('cursor', () => {
  it('defaults to now minus 24h on first run', async () => {
    const now = 1_700_000_000;
    expect(await getCursor(makeKv(), now)).toBe(now - 24 * 60 * 60);
  });

  it('round-trips through setCursor', async () => {
    const kv = makeKv();
    await setCursor(kv, 1_700_000_123);
    expect(await getCursor(kv, 1_800_000_000)).toBe(1_700_000_123);
  });

  it('ignores a corrupt stored cursor', async () => {
    const now = 1_700_000_000;
    expect(await getCursor(makeKv({ community_labels_cursor: 'junk' }), now))
      .toBe(now - 24 * 60 * 60);
  });
});
