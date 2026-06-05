// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the latest-event-per-sha lookup helpers over
// ABOUTME: bunny_webhook_events (single-sha lookup + untriaged anti-join).

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  latestBunnyEventForSha,
  latestUntriagedBunnyEvents,
  countUntriagedBunnyEvents,
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

describe('latestUntriagedBunnyEvents / countUntriagedBunnyEvents', () => {
  // SHA_A gets a moderation_results row (= has a verdict). SHA_B does not
  // (= needs triage). SHA_C's latest event is deleted (excluded regardless).
  beforeEach(async () => {
    await env.BLOSSOM_DB.prepare(`CREATE TABLE IF NOT EXISTS moderation_results (
      sha256 TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      moderated_at TEXT
    )`).run();
    await env.BLOSSOM_DB.prepare('DELETE FROM moderation_results').run();
    await env.BLOSSOM_DB.prepare(
      `INSERT INTO moderation_results (sha256, action) VALUES (?, 'SAFE')`,
    ).bind(SHA_A).run();
  });

  it('returns only videos with no moderation_results row', async () => {
    const rows = await latestUntriagedBunnyEvents(env);
    expect(rows.map((r) => r.sha256)).toEqual([SHA_B]);
  });

  it('counts only untriaged videos', async () => {
    expect(await countUntriagedBunnyEvents(env)).toBe(1);
  });

  it('excludes a sha once it gains a moderation_results row', async () => {
    await env.BLOSSOM_DB.prepare(
      `INSERT INTO moderation_results (sha256, action) VALUES (?, 'REVIEW')`,
    ).bind(SHA_B).run();
    expect(await countUntriagedBunnyEvents(env)).toBe(0);
    expect(await latestUntriagedBunnyEvents(env)).toEqual([]);
  });

  it('excludes a sha that finished then was deleted (rank-then-filter regression)', async () => {
    // The anti-join shares the rank-ALL-then-filter-the-winner semantic:
    // a sha with finished@100 and deleted@200 must stay excluded. Filtering
    // status_name before ROW_NUMBER would resurrect the older finished row
    // as the "latest" and leak a deleted sha into the untriaged queue. This
    // SHA_D has no moderation_results row, so only the status filter can
    // exclude it.
    const SHA_D = 'd'.repeat(64);
    await env.BLOSSOM_DB.prepare(
      `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
    ).bind(SHA_D, 'g-d-1', 'D-finished', 'finished', 100).run();
    await env.BLOSSOM_DB.prepare(
      `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
    ).bind(SHA_D, 'g-d-2', 'D-deleted', 'deleted', 200).run();

    const rows = await latestUntriagedBunnyEvents(env);
    expect(rows.find((r) => r.sha256 === SHA_D)).toBeUndefined();
    // Only SHA_B is untriaged-and-not-deleted; SHA_A has a verdict, C and D are deleted.
    expect(await countUntriagedBunnyEvents(env)).toBe(1);
  });

  it('honors LIMIT and OFFSET, ordered by received_at DESC', async () => {
    // Add a second untriaged sha newer than SHA_B (received_at 250) so the
    // anti-join returns two rows to page through: [SHA_E@500, SHA_B@250].
    const SHA_E = 'e'.repeat(64);
    await env.BLOSSOM_DB.prepare(
      `INSERT INTO bunny_webhook_events (sha256, video_guid, hls_url, status_name, received_at) VALUES (?,?,?,?,?)`,
    ).bind(SHA_E, 'g-e-1', 'E', 'finished', 500).run();

    expect(await countUntriagedBunnyEvents(env)).toBe(2);
    const first = await latestUntriagedBunnyEvents(env, { limit: 1, offset: 0 });
    const second = await latestUntriagedBunnyEvents(env, { limit: 1, offset: 1 });
    expect(first.map((r) => r.sha256)).toEqual([SHA_E]);
    expect(second.map((r) => r.sha256)).toEqual([SHA_B]);
  });
});
