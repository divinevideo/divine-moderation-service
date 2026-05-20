// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests GET /admin/api/uploader/:pubkey aggregate endpoint used by
// ABOUTME: the admin dashboard to show per-uploader history and stats.

import { describe, expect, it } from 'vitest';
import worker from './index.mjs';

const PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

function sha(n) { return String(n).padStart(64, '0'); }

function createDbMock({ moderationRows = [], dmRows = [], enforcementRows = new Map() } = {}) {
  return {
    prepare(sql) {
      let bindings = [];
      const normalized = sql.replace(/\s+/g, ' ').trim();

      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          // Aggregate totals: COUNT(*), MIN(moderated_at), MAX(moderated_at)
          if (/FROM moderation_results/i.test(normalized)
              && /COUNT\(\*\)/i.test(normalized)
              && /MIN\(moderated_at\)/i.test(normalized)) {
            const pubkey = bindings[0];
            const rows = moderationRows.filter(r => r.uploaded_by === pubkey);
            if (rows.length === 0) {
              return { videos: 0, firstSeen: null, lastSeen: null };
            }
            const times = rows.map(r => r.moderated_at).filter(Boolean).sort();
            return {
              videos: rows.length,
              firstSeen: times[0] || null,
              lastSeen: times[times.length - 1] || null
            };
          }
          // DM count
          if (/FROM dm_log/i.test(normalized) && /COUNT\(\*\)/i.test(normalized)) {
            const pubkey = bindings[0];
            const count = dmRows.filter(
              r => r.sender_pubkey === pubkey || r.recipient_pubkey === pubkey
            ).length;
            return { dmCount: count };
          }
          // AI-flagged count
          if (/FROM moderation_results/i.test(normalized) && /ai_generated|deepfake/i.test(normalized)) {
            const pubkey = bindings[0];
            const count = moderationRows.filter(r => {
              if (r.uploaded_by !== pubkey) return false;
              const cats = r.categories || '[]';
              return /ai_generated|deepfake/i.test(cats);
            }).length;
            return { aiFlaggedCount: count };
          }
          // Uploader enforcement
          if (/FROM uploader_enforcement/i.test(normalized)) {
            return enforcementRows.get(bindings[0]) ?? null;
          }
          return null;
        },
        async all() {
          // Action breakdown: GROUP BY action
          if (/FROM moderation_results/i.test(normalized)
              && /GROUP BY action/i.test(normalized)) {
            const pubkey = bindings[0];
            const rows = moderationRows.filter(r => r.uploaded_by === pubkey);
            const counts = {};
            for (const row of rows) {
              counts[row.action] = (counts[row.action] || 0) + 1;
            }
            return {
              results: Object.entries(counts).map(([action, count]) => ({ action, count }))
            };
          }
          // Recent flagged list
          if (/FROM moderation_results/i.test(normalized)
              && /ORDER BY moderated_at DESC/i.test(normalized)
              && /LIMIT/i.test(normalized)) {
            const pubkey = bindings[0];
            const flaggedActions = ['REVIEW', 'QUARANTINE', 'AGE_RESTRICTED', 'PERMANENT_BAN'];
            const rows = moderationRows
              .filter(r => r.uploaded_by === pubkey && flaggedActions.includes(r.action))
              .sort((a, b) => (b.moderated_at || '').localeCompare(a.moderated_at || ''))
              .slice(0, 10)
              .map(r => ({
                sha256: r.sha256,
                action: r.action,
                moderated_at: r.moderated_at,
                review_notes: r.review_notes || null,
                raw_response: r.raw_response || null
              }));
            return { results: rows };
          }
          return { results: [] };
        }
      };
    },
    async batch() { return []; }
  };
}

function createEnv(overrides = {}) {
  return {
    ALLOW_DEV_ACCESS: 'false',
    SERVICE_API_TOKEN: 'test-service-token',
    CDN_DOMAIN: 'media.divine.video',
    SKIP_PROFILE_RESOLUTION: 'true',
    BLOSSOM_DB: createDbMock(),
    MODERATION_KV: {
      async get() { return null; },
      async put() {},
      async delete() {},
      async list() { return { keys: [], list_complete: true, cursor: null }; }
    },
    MODERATION_QUEUE: { async send() {} },
    ...overrides
  };
}

const AUTH_HEADER = { 'Cf-Access-Authenticated-User-Email': 'mod@divine.video' };

describe('GET /admin/api/uploader/:pubkey', () => {
  it('returns per-uploader aggregates from moderation_results, dm_log, and enforcement', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationRows: [
          { sha256: sha(1), uploaded_by: PUBKEY, action: 'SAFE', moderated_at: '2026-01-01T00:00:00.000Z' },
          { sha256: sha(2), uploaded_by: PUBKEY, action: 'SAFE', moderated_at: '2026-01-02T00:00:00.000Z' },
          { sha256: sha(3), uploaded_by: PUBKEY, action: 'SAFE', moderated_at: '2026-01-03T00:00:00.000Z' },
          { sha256: sha(4), uploaded_by: PUBKEY, action: 'REVIEW', moderated_at: '2026-02-01T00:00:00.000Z', review_notes: 'borderline nudity' },
          { sha256: sha(5), uploaded_by: PUBKEY, action: 'PERMANENT_BAN', moderated_at: '2026-03-01T00:00:00.000Z', review_notes: 'csam' },
          // Different pubkey — must NOT be counted:
          { sha256: sha(6), uploaded_by: OTHER_PUBKEY, action: 'PERMANENT_BAN', moderated_at: '2026-03-05T00:00:00.000Z' }
        ],
        dmRows: [
          { sender_pubkey: 'mod', recipient_pubkey: PUBKEY },
          { sender_pubkey: PUBKEY, recipient_pubkey: 'mod' }
        ],
        enforcementRows: new Map([[PUBKEY, {
          pubkey: PUBKEY,
          approval_required: 1,
          relay_banned: 0,
          notes: 'flagged for manual review'
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}`, {
        headers: AUTH_HEADER
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.pubkey).toBe(PUBKEY);
    expect(body.totals.videos).toBe(5);
    expect(body.totals.firstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(body.totals.lastSeen).toBe('2026-03-01T00:00:00.000Z');
    expect(body.actionBreakdown).toEqual({
      SAFE: 3,
      REVIEW: 1,
      QUARANTINE: 0,
      AGE_RESTRICTED: 0,
      PERMANENT_BAN: 1,
      DELETE: 0
    });
    expect(body.recentFlagged).toHaveLength(2);
    expect(body.recentFlagged[0].action).toBe('PERMANENT_BAN');
    expect(body.recentFlagged[0].sha256).toBe(sha(5));
    expect(body.dmCount).toBe(2);
    expect(body.enforcement).toMatchObject({
      approval_required: true,
      relay_banned: false
    });
  });

  it('handles unknown uploader with zero history gracefully', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}`, {
        headers: AUTH_HEADER
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pubkey).toBe(PUBKEY);
    expect(body.totals.videos).toBe(0);
    expect(body.totals.firstSeen).toBeNull();
    expect(body.totals.lastSeen).toBeNull();
    expect(body.actionBreakdown).toEqual({
      SAFE: 0,
      REVIEW: 0,
      QUARANTINE: 0,
      AGE_RESTRICTED: 0,
      PERMANENT_BAN: 0,
      DELETE: 0
    });
    expect(body.recentFlagged).toEqual([]);
    expect(body.dmCount).toBe(0);
    expect(body.enforcement).toBeNull();
  });

  it('requires Zero Trust authentication', async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}`),
      env
    );
    expect(response.status).toBe(401);
  });

  it('action breakdown matches inserted rows exactly for every action value', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationRows: [
          { sha256: sha(1), uploaded_by: PUBKEY, action: 'SAFE', moderated_at: '2026-01-01T00:00:00.000Z' },
          { sha256: sha(2), uploaded_by: PUBKEY, action: 'REVIEW', moderated_at: '2026-01-02T00:00:00.000Z' },
          { sha256: sha(3), uploaded_by: PUBKEY, action: 'QUARANTINE', moderated_at: '2026-01-03T00:00:00.000Z' },
          { sha256: sha(4), uploaded_by: PUBKEY, action: 'AGE_RESTRICTED', moderated_at: '2026-01-04T00:00:00.000Z' },
          { sha256: sha(5), uploaded_by: PUBKEY, action: 'PERMANENT_BAN', moderated_at: '2026-01-05T00:00:00.000Z' },
          { sha256: sha(6), uploaded_by: PUBKEY, action: 'DELETE', moderated_at: '2026-01-06T00:00:00.000Z' }
        ]
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation.admin.divine.video/admin/api/uploader/${PUBKEY}`, {
        headers: AUTH_HEADER
      }),
      env
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.actionBreakdown).toEqual({
      SAFE: 1,
      REVIEW: 1,
      QUARANTINE: 1,
      AGE_RESTRICTED: 1,
      PERMANENT_BAN: 1,
      DELETE: 1
    });
    expect(body.totals.videos).toBe(6);
  });
});
