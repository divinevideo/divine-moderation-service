// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for runBackfill — KV-mutex'd cron worker that fills legacy
// ABOUTME: moderation_results lookup columns from funnelcake.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runBackfill } from './backfill-lookup-columns.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function seedTable() {
  await env.BLOSSOM_DB.prepare(`CREATE TABLE IF NOT EXISTS moderation_results (
    sha256 TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    moderated_at TEXT,
    event_id TEXT,
    title TEXT,
    author TEXT,
    content_url TEXT,
    published_at TEXT,
    lookup_attempted_at TEXT
  )`).run();
  await env.BLOSSOM_DB.prepare(`DELETE FROM moderation_results`).run();
}

beforeEach(async () => {
  await seedTable();
  await env.MODERATION_KV.delete('backfill:lock');
});

async function insertLegacy(sha256, override = {}) {
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO moderation_results (sha256, action, moderated_at, event_id, title, author, content_url, published_at, lookup_attempted_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    sha256,
    'REVIEW',
    override.moderated_at || '2024-01-01T00:00:00Z',
    override.event_id || null,
    override.title || null,
    override.author || null,
    override.content_url || null,
    override.published_at || null,
    override.lookup_attempted_at || null,
  ).run();
}

const FUNNEL_HIT = {
  eventId: 'e'.repeat(64),
  videoUrl: 'https://media.divine.video/v.mp4',
  uploadedBy: 'p'.repeat(64),
  nostrContext: {
    title: 'Hi',
    author: 'Alice',
    publishedAt: 1700000000,
    url: 'https://media.divine.video/v.mp4',
  },
};

describe('runBackfill', () => {
  it('returns skipped when BACKFILL_ENABLED is not "true"', async () => {
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'false' },
      { fetchLookup: () => null },
    );
    expect(result).toEqual({ skipped: 'disabled' });
  });

  it('updates a legacy row using the funnelcake lookup shape', async () => {
    await insertLegacy(SHA_A);
    const fetchLookup = vi.fn().mockResolvedValue(FUNNEL_HIT);
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup, concurrency: 1 },
    );
    expect(result).toMatchObject({ picked: 1, updated: 1, missing: 0, errored: 0 });
    const row = await env.BLOSSOM_DB.prepare(
      'SELECT event_id, title, author, content_url, published_at, lookup_attempted_at FROM moderation_results WHERE sha256 = ?',
    ).bind(SHA_A).first();
    expect(row.event_id).toBe(FUNNEL_HIT.eventId);
    expect(row.title).toBe('Hi');
    expect(row.author).toBe('Alice');
    expect(row.content_url).toBe('https://media.divine.video/v.mp4');
    expect(row.published_at).toBe('1700000000');
    expect(row.lookup_attempted_at).not.toBeNull();
  });

  it('idempotent: a second run on the same row is a no-op (event_id already set)', async () => {
    await insertLegacy(SHA_A);
    const fetchLookup = vi.fn().mockResolvedValue(FUNNEL_HIT);
    await runBackfill({ ...env, BACKFILL_ENABLED: 'true' }, { fetchLookup });
    fetchLookup.mockClear();
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup },
    );
    // No more rows match `event_id IS NULL`, so picked = 0.
    expect(result.picked).toBe(0);
    expect(fetchLookup).not.toHaveBeenCalled();
  });

  it('on funnelcake 404 (null), sets lookup_attempted_at only', async () => {
    await insertLegacy(SHA_A);
    const fetchLookup = vi.fn().mockResolvedValue(null);
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup },
    );
    expect(result).toMatchObject({ picked: 1, updated: 0, missing: 1 });
    const row = await env.BLOSSOM_DB.prepare(
      'SELECT event_id, lookup_attempted_at FROM moderation_results WHERE sha256 = ?',
    ).bind(SHA_A).first();
    expect(row.event_id).toBeNull();
    expect(row.lookup_attempted_at).not.toBeNull();
  });

  it('on fetch error, leaves the row unchanged', async () => {
    await insertLegacy(SHA_A);
    const fetchLookup = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup },
    );
    expect(result).toMatchObject({ picked: 1, updated: 0, missing: 0, errored: 1 });
    const row = await env.BLOSSOM_DB.prepare(
      'SELECT event_id, lookup_attempted_at FROM moderation_results WHERE sha256 = ?',
    ).bind(SHA_A).first();
    expect(row.event_id).toBeNull();
    expect(row.lookup_attempted_at).toBeNull();
  });

  it('honors limit option', async () => {
    await insertLegacy(SHA_A);
    await insertLegacy(SHA_B);
    const fetchLookup = vi.fn().mockResolvedValue(null);
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup, limit: 1 },
    );
    expect(result.picked).toBe(1);
  });

  it('mutex: a second run while the lock is held returns skipped:locked', async () => {
    await insertLegacy(SHA_A);
    // Pre-set the lock to simulate an in-flight call.
    await env.MODERATION_KV.put('backfill:lock', String(Date.now()), { expirationTtl: 300 });
    const fetchLookup = vi.fn().mockResolvedValue(FUNNEL_HIT);
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup },
    );
    expect(result).toEqual({ skipped: 'locked' });
    expect(fetchLookup).not.toHaveBeenCalled();
  });

  it('skips rows with a recent lookup_attempted_at (within 7 days)', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await insertLegacy(SHA_A, { lookup_attempted_at: yesterday });
    const fetchLookup = vi.fn().mockResolvedValue(null);
    const result = await runBackfill(
      { ...env, BACKFILL_ENABLED: 'true' },
      { fetchLookup },
    );
    expect(result.picked).toBe(0);
    expect(fetchLookup).not.toHaveBeenCalled();
  });

  it('throws if fetchLookup is not provided', async () => {
    await expect(
      runBackfill({ ...env, BACKFILL_ENABLED: 'true' }, {}),
    ).rejects.toThrow('fetchLookup is required');
  });
});
