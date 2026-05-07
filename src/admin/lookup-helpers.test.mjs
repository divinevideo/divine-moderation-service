// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for buildAdminVideoFromRow — pure row→admin-shape mapper.

import { describe, it, expect } from 'vitest';
import { buildAdminVideoFromRow, ADMIN_VIDEO_COLUMNS } from './lookup-helpers.mjs';

const FULL_ROW = {
  sha256: 'a'.repeat(64),
  action: 'REVIEW',
  provider: 'manual-review',
  scores: '{"nsfw":0.2}',
  categories: '["nsfw"]',
  moderated_at: '2026-05-05T00:00:00Z',
  reviewed_by: null,
  reviewed_at: null,
  uploaded_by: 'b'.repeat(64),
  event_id: 'c'.repeat(64),
  title: 'Test Video',
  author: 'Alice',
  content_url: 'https://example.com/v.mp4',
  published_at: '1717200000',
};

describe('ADMIN_VIDEO_COLUMNS', () => {
  it('includes the previously-missing metadata columns', () => {
    expect(ADMIN_VIDEO_COLUMNS).toContain('event_id');
    expect(ADMIN_VIDEO_COLUMNS).toContain('title');
    expect(ADMIN_VIDEO_COLUMNS).toContain('author');
    expect(ADMIN_VIDEO_COLUMNS).toContain('content_url');
    expect(ADMIN_VIDEO_COLUMNS).toContain('published_at');
  });
});

describe('buildAdminVideoFromRow', () => {
  it('produces a complete video shape from a fully-populated row', () => {
    const out = buildAdminVideoFromRow(FULL_ROW, { cdnDomain: 'media.divine.video' });
    expect(out).toMatchObject({
      sha256: FULL_ROW.sha256,
      action: 'REVIEW',
      provider: 'manual-review',
      eventId: FULL_ROW.event_id,
      divineUrl: `https://divine.video/video/${FULL_ROW.event_id}`,
      cdnUrl: `https://media.divine.video/${FULL_ROW.sha256}`,
      uploaded_by: FULL_ROW.uploaded_by,
      moderated_at: '2026-05-05T00:00:00Z',
      reviewed_by: null,
      reviewed_at: null,
    });
    expect(out.scores).toEqual({ nsfw: 0.2 });
    expect(out.categories).toEqual(['nsfw']);
    expect(typeof out.processedAt).toBe('number');
  });

  it('mirrors buildStoredLookupMetadata.nostrContext exactly', () => {
    const out = buildAdminVideoFromRow(FULL_ROW, { cdnDomain: 'media.divine.video' });
    expect(out.nostrContext).toEqual({
      title: 'Test Video',
      author: 'Alice',
      client: null,
      content: null,
      url: 'https://example.com/v.mp4',
      publishedAt: 1717200000,
      pubkey: `${FULL_ROW.uploaded_by.substring(0, 16)}...`,
      eventId: FULL_ROW.event_id,
      platform: null,
    });
  });

  it('returns null eventId/divineUrl/nostrContext when row has no metadata', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      moderated_at: '2026-05-05T00:00:00Z',
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out.eventId).toBeNull();
    expect(out.divineUrl).toBeNull();
    expect(out.nostrContext).toBeNull();
  });

  it('handles partial population (uploaded_by alone is enough for context)', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      uploaded_by: 'b'.repeat(64),
      moderated_at: '2026-05-05T00:00:00Z',
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out.nostrContext).not.toBeNull();
    expect(out.nostrContext.title).toBeNull();
    expect(out.nostrContext.pubkey).toBe(`${row.uploaded_by.substring(0, 16)}...`);
  });

  it('handles a row with event_id but no title/author (post-backfill 404 partial)', () => {
    // Backfill records lookup_attempted_at on a 404; legacy rows that
    // funnelcake doesn't know about end up with event_id still null
    // but lookup_attempted_at set. Conversely, some rows may have
    // event_id stored from a recent moderation but title/author null.
    // Confirm the helper produces null nostrContext fields rather than
    // pulling stale or undefined values from elsewhere.
    const row = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      moderated_at: '2026-05-05T00:00:00Z',
      uploaded_by: 'b'.repeat(64),
      event_id: 'c'.repeat(64),
      title: null,
      author: null,
      content_url: null,
      published_at: null,
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out.eventId).toBe(row.event_id);
    expect(out.divineUrl).toBe(`https://divine.video/video/${row.event_id}`);
    expect(out.nostrContext).not.toBeNull();
    expect(out.nostrContext.title).toBeNull();
    expect(out.nostrContext.author).toBeNull();
    expect(out.nostrContext.url).toBeNull();
    expect(out.nostrContext.publishedAt).toBeNull();
    expect(out.nostrContext.eventId).toBe(row.event_id);
  });

  it('handles JSON columns gracefully when malformed', () => {
    const row = {
      sha256: 'a'.repeat(64),
      action: 'SAFE',
      scores: 'not json',
      categories: '{not array}',
      moderated_at: '2026-05-05T00:00:00Z',
    };
    const out = buildAdminVideoFromRow(row, { cdnDomain: 'media.divine.video' });
    expect(out.scores).toEqual({});
    expect(out.categories).toEqual([]);
  });
});
