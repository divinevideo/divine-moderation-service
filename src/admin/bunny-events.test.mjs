// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for latestBunnyEventBySha — window-function CTE
// ABOUTME: replacing four hand-rolled correlated subqueries.

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  latestBunnyEventBySha,
  latestBunnyEventForSha,
  countLatestBunnyEvents,
} from './bunny-events.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

async function seed() {
  // Ensure table exists (migrations may or may not have created it depending on test boot).
  await env.BLOSSOM_DB.prepare(`CREATE TABLE IF NOT EXISTS bunny_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT,
    video_guid TEXT,
    hls_url TEXT,
    mp4_url TEXT,
    thumbnail_url TEXT,
    status TEXT,
    status_name TEXT,
    timestamp INTEGER,
    received_at INTEGER
  )`).run();
  await env.BLOSSOM_DB.prepare('DELETE FROM bunny_webhook_events').run();

  // SHA_A: three events, latest at received_at=300 with hls_url='C'
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_A, 'g-a-1', 'A', 'finished', 100).run();
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_A, 'g-a-2', 'B', 'finished', 200).run();
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_A, 'g-a-3', 'C', 'finished', 300).run();

  // SHA_B: latest is at 250
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_B, 'g-b-1', 'X', 'finished', 150).run();
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_B, 'g-b-2', 'Y', 'finished', 250).run();

  // SHA_C: only event is status_name='deleted' — should be excluded.
  await env.BLOSSOM_DB.prepare(
    `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
  ).bind(SHA_C, 'g-c-1', 'Z', 'deleted', 400).run();
}

beforeEach(seed);

describe('latestBunnyEventBySha', () => {
  it('returns one row per sha with the LATEST hls_url (deterministic)', async () => {
    const rows = await latestBunnyEventBySha(env);
    const a = rows.find((r) => r.sha256 === SHA_A);
    const b = rows.find((r) => r.sha256 === SHA_B);
    expect(a.hls_url).toBe('C');
    expect(a.received_at).toBe(300);
    expect(b.hls_url).toBe('Y');
    expect(b.received_at).toBe(250);
  });

  it('orders results by received_at DESC across distinct shas', async () => {
    const rows = await latestBunnyEventBySha(env);
    expect(rows.map((r) => r.sha256)).toEqual([SHA_A, SHA_B]);
  });

  it('excludes shas whose latest status is deleted/error', async () => {
    const rows = await latestBunnyEventBySha(env);
    expect(rows.find((r) => r.sha256 === SHA_C)).toBeUndefined();
  });

  it('honors LIMIT and OFFSET', async () => {
    const first = await latestBunnyEventBySha(env, { limit: 1, offset: 0 });
    const second = await latestBunnyEventBySha(env, { limit: 1, offset: 1 });
    expect(first[0].sha256).toBe(SHA_A);
    expect(second[0].sha256).toBe(SHA_B);
  });
});

describe('countLatestBunnyEvents', () => {
  it('counts distinct shas excluding deleted/error', async () => {
    expect(await countLatestBunnyEvents(env)).toBe(2);
  });
});

describe('latestBunnyEventForSha', () => {
  it('returns the latest event for the sha', async () => {
    const row = await latestBunnyEventForSha(env, SHA_A);
    expect(row.hls_url).toBe('C');
  });
  it('returns null for unknown sha', async () => {
    const row = await latestBunnyEventForSha(env, 'f'.repeat(64));
    expect(row).toBeNull();
  });
});
