// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the private DM report intake table and its relay-manager handoff
// ABOUTME: Pins the Leg 2 request body, delivery ordering, retry/backoff and retention

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
  PRIVATE_REPORT_INTAKE_PATH,
  canonicalPrivateReportType,
  deliverPendingPrivateReports,
  initPrivateReportIntakeTable,
  parseReportedPubkeyTag,
  privateReportRetryDelayMs,
  prunePrivateReportIntake,
  recordPrivateReportIntake,
  resolvePrivateReportId,
} from './private-report-intake.mjs';

const REPORTER = 'a'.repeat(63) + '1';
const SECOND_REPORTER = 'a'.repeat(63) + '2';
const REPORTED = 'b'.repeat(63) + '1';
const GIFT_WRAP = 'c'.repeat(63) + '1';
const REPORT_ID = '3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b';
const ADMIN_KEY = 'test-relay-admin-key';
const NOW_MS = Date.parse('2026-11-07T12:00:00.000Z');

function giftWrapId(n) {
  return 'c'.repeat(62) + String(n).padStart(2, '0');
}

function reportId(n) {
  return `3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a${String(n).padStart(2, '0')}`;
}

function intakeRow(overrides = {}) {
  return {
    reportId: REPORT_ID,
    reporterPubkey: REPORTER,
    reportedPubkey: REPORTED,
    reportType: 'harassment',
    giftWrapId: GIFT_WRAP,
    hasExcerpt: false,
    reportedAt: '2026-11-07T11:00:00.000Z',
    ...overrides,
  };
}

function okResponse(body = { success: true, outcome: 'queued_in_coop', duplicate: false }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusResponse(status, body = { success: false, error: `status ${status}` }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('private report intake', () => {
  const db = env.BLOSSOM_DB;

  beforeEach(async () => {
    await db.prepare('DROP TABLE IF EXISTS private_report_intake').run();
    await initPrivateReportIntakeTable(db);
  });

  async function rows() {
    return (await db.prepare('SELECT * FROM private_report_intake ORDER BY id').all()).results;
  }

  describe('resolvePrivateReportId', () => {
    it('uses the batch tag when it is a UUID, lowercased', () => {
      expect(resolvePrivateReportId([['batch', REPORT_ID.toUpperCase()]], GIFT_WRAP)).toBe(REPORT_ID);
    });

    it('uses the batch tag when it is 64 hex, lowercased', () => {
      const token = 'E'.repeat(64);
      expect(resolvePrivateReportId([['batch', token]], GIFT_WRAP)).toBe('e'.repeat(64));
    });

    it('falls back to the gift wrap id for a missing or malformed batch tag', () => {
      expect(resolvePrivateReportId([], GIFT_WRAP)).toBe(GIFT_WRAP);
      expect(resolvePrivateReportId([['batch', 'not-a-report-id']], GIFT_WRAP)).toBe(GIFT_WRAP);
      expect(resolvePrivateReportId([['batch', '']], GIFT_WRAP)).toBe(GIFT_WRAP);
      expect(resolvePrivateReportId([['batch', 42]], GIFT_WRAP)).toBe(GIFT_WRAP);
    });
  });

  describe('parseReportedPubkeyTag', () => {
    it('returns the lowercased pubkey of a 64-hex tag', () => {
      expect(parseReportedPubkeyTag([['reported_pubkey', REPORTED.toUpperCase()]]))
        .toEqual({ present: true, pubkey: REPORTED });
    });

    it('flags a malformed tag as present with no pubkey', () => {
      expect(parseReportedPubkeyTag([['reported_pubkey', 'npub1notahexkey']]))
        .toEqual({ present: true, pubkey: null });
      expect(parseReportedPubkeyTag([['reported_pubkey', REPORTED.slice(0, 63)]]))
        .toEqual({ present: true, pubkey: null });
      expect(parseReportedPubkeyTag([['reported_pubkey']]))
        .toEqual({ present: true, pubkey: null });
    });

    it('reports an absent tag as absent', () => {
      expect(parseReportedPubkeyTag([['p', REPORTED]])).toEqual({ present: false, pubkey: null });
      expect(parseReportedPubkeyTag(undefined)).toEqual({ present: false, pubkey: null });
    });
  });

  describe('canonicalPrivateReportType', () => {
    it('keeps every canonical type as is', () => {
      for (const type of [
        'spam', 'harassment', 'violence', 'sexual_content', 'copyright',
        'false_information', 'child_safety', 'csam', 'underage_user',
        'ai_generated', 'other',
      ]) {
        expect(canonicalPrivateReportType(type)).toBe(type);
      }
    });

    it('maps a non-canonical type into the contract vocabulary', () => {
      expect(canonicalPrivateReportType('nudity')).toBe('sexual_content');
      expect(canonicalPrivateReportType('deepfake')).toBe('ai_generated');
      expect(canonicalPrivateReportType('profanity')).toBe('other');
      expect(canonicalPrivateReportType(null)).toBe('other');
    });
  });

  describe('recordPrivateReportIntake', () => {
    it('records one pending row', async () => {
      expect(await recordPrivateReportIntake(db, intakeRow({ hasExcerpt: true }))).toEqual({ inserted: true });

      const [row] = await rows();
      expect(row).toMatchObject({
        report_id: REPORT_ID,
        reporter_pubkey: REPORTER,
        reported_pubkey: REPORTED,
        report_type: 'harassment',
        gift_wrap_id: GIFT_WRAP,
        has_excerpt: 1,
        reported_at: '2026-11-07T11:00:00.000Z',
        status: 'pending',
        outcome: null,
        attempts: 0,
        last_attempt_at: null,
        next_attempt_at: null,
        last_error: null,
        delivered_at: null,
      });
      // gift_wrap_id links the row to its dm_log row; nothing else is kept.
      expect(row).not.toHaveProperty('conversation_id');
    });

    it('ignores the same report id from the same reporter, from any gift wrap', async () => {
      await recordPrivateReportIntake(db, intakeRow());
      expect(await recordPrivateReportIntake(db, intakeRow({ giftWrapId: giftWrapId(2) })))
        .toEqual({ inserted: false });

      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0].gift_wrap_id).toBe(GIFT_WRAP);
    });

    it('keeps the same report id from two different reporters apart', async () => {
      await recordPrivateReportIntake(db, intakeRow());
      await recordPrivateReportIntake(db, intakeRow({ reporterPubkey: SECOND_REPORTER, giftWrapId: giftWrapId(2) }));

      expect(await rows()).toHaveLength(2);
    });
  });

  describe('deliverPendingPrivateReports', () => {
    let fetchCalls;
    let relayAdmin;
    let originalFetch;

    beforeEach(() => {
      fetchCalls = [];
      relayAdmin = {
        fetch: vi.fn(async (url, init) => {
          fetchCalls.push({ url, init, body: JSON.parse(init.body) });
          return okResponse();
        }),
      };
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    function deliveryEnv(overrides = {}) {
      return {
        BLOSSOM_DB: db,
        RELAY_ADMIN: relayAdmin,
        RELAY_ADMIN_API_KEY: ADMIN_KEY,
        ...overrides,
      };
    }

    it('posts exactly the Leg 2 body over the service binding and marks the row delivered', async () => {
      await recordPrivateReportIntake(db, intakeRow({ hasExcerpt: true }));

      const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      expect(summary).toMatchObject({ attempted: 1, delivered: 1, rejected: 0, retrying: 0 });
      expect(relayAdmin.fetch).toHaveBeenCalledTimes(1);
      const [{ url, init, body }] = fetchCalls;
      expect(new URL(url).pathname).toBe(PRIVATE_REPORT_INTAKE_PATH);
      expect(PRIVATE_REPORT_INTAKE_PATH).toBe('/api/internal/private-reports');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY });
      // Exactly these keys: no excerpt, no note.
      expect(body).toEqual({
        reportId: REPORT_ID,
        reportedPubkey: REPORTED,
        reporterPubkey: REPORTER,
        reportType: 'harassment',
        reportedAt: '2026-11-07T11:00:00.000Z',
        hasExcerpt: true,
        giftWrapId: GIFT_WRAP,
      });

      const [row] = await rows();
      expect(row).toMatchObject({
        status: 'delivered',
        outcome: 'queued_in_coop',
        attempts: 1,
        last_attempt_at: new Date(NOW_MS).toISOString(),
        delivered_at: new Date(NOW_MS).toISOString(),
        last_error: null,
        next_attempt_at: null,
      });
    });

    it('treats a duplicate:true answer as delivered with the stored outcome', async () => {
      relayAdmin.fetch.mockImplementation(async () => okResponse({
        success: true, outcome: 'age_review_exists', duplicate: true,
      }));
      await recordPrivateReportIntake(db, intakeRow({ reportType: 'underage_user' }));

      await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      const [row] = await rows();
      expect(row.status).toBe('delivered');
      expect(row.outcome).toBe('age_review_exists');
    });

    it('does not deliver a delivered row again', async () => {
      await recordPrivateReportIntake(db, intakeRow());
      await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });
      await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS + 3_600_000 });

      expect(relayAdmin.fetch).toHaveBeenCalledTimes(1);
    });

    it('delivers csam, child_safety and underage_user first, then oldest first', async () => {
      const inserts = [
        { type: 'spam', at: '2026-11-07T08:00:00.000Z' },
        { type: 'underage_user', at: '2026-11-07T10:00:00.000Z' },
        { type: 'harassment', at: '2026-11-07T07:00:00.000Z' },
        { type: 'child_safety', at: '2026-11-07T11:00:00.000Z' },
        { type: 'csam', at: '2026-11-07T11:30:00.000Z' },
        { type: 'other', at: '2026-11-07T09:00:00.000Z' },
      ];
      for (const [i, { type, at }] of inserts.entries()) {
        await recordPrivateReportIntake(db, intakeRow({
          reportId: reportId(i), giftWrapId: giftWrapId(i), reportType: type, reportedAt: at,
        }));
      }

      await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      expect(fetchCalls.map(({ body }) => body.reportType)).toEqual([
        'csam', 'child_safety', 'underage_user', 'harassment', 'spam', 'other',
      ]);
    });

    it('bounds each run to the batch limit, highest priority first', async () => {
      for (let i = 0; i < 5; i++) {
        await recordPrivateReportIntake(db, intakeRow({
          reportId: reportId(i), giftWrapId: giftWrapId(i), reportType: i === 4 ? 'csam' : 'spam',
        }));
      }

      const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS, limit: 2 });

      expect(summary.attempted).toBe(2);
      expect(fetchCalls.map(({ body }) => body.reportType)).toEqual(['csam', 'spam']);
      const pending = (await rows()).filter((row) => row.status === 'pending');
      expect(pending).toHaveLength(3);
    });

    it('marks a 400 rejected, logs it loudly, and never retries it', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      relayAdmin.fetch.mockImplementation(async () => statusResponse(400, { success: false, error: 'reportedPubkey must be 64 hex' }));
      await recordPrivateReportIntake(db, intakeRow());

      const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      expect(summary).toMatchObject({ attempted: 1, delivered: 0, rejected: 1, retrying: 0 });
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'rejected', attempts: 1, delivered_at: null, next_attempt_at: null });
      expect(row.last_error).toContain('400');
      expect(row.last_error).toContain('reportedPubkey must be 64 hex');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(REPORT_ID));

      await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS + 86_400_000 });
      expect(relayAdmin.fetch).toHaveBeenCalledTimes(1);
    });

    for (const [label, respond] of [
      ['401', async () => statusResponse(401)],
      ['403', async () => statusResponse(403)],
      ['503', async () => statusResponse(503, { success: false, error: 'Coop not configured' })],
      ['404', async () => statusResponse(404)],
      ['a 200 without success:true', async () => okResponse({ success: false, error: 'odd' })],
      ['a network error', async () => { throw new Error('Network connection lost'); }],
    ]) {
      it(`keeps a row pending with attempts, last_error and backoff on ${label}`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        relayAdmin.fetch.mockImplementation(respond);
        await recordPrivateReportIntake(db, intakeRow());

        const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

        expect(summary).toMatchObject({ attempted: 1, delivered: 0, rejected: 0, retrying: 1 });
        const [row] = await rows();
        expect(row.status).toBe('pending');
        expect(row.attempts).toBe(1);
        expect(row.last_error).toBeTruthy();
        expect(row.last_attempt_at).toBe(new Date(NOW_MS).toISOString());
        expect(Date.parse(row.next_attempt_at)).toBe(NOW_MS + privateReportRetryDelayMs(1));

        // Not retried before its backoff expires...
        await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS + privateReportRetryDelayMs(1) - 1 });
        expect(relayAdmin.fetch).toHaveBeenCalledTimes(1);

        // ...and retried, and delivered, once it does.
        relayAdmin.fetch.mockImplementation(async () => okResponse());
        await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS + privateReportRetryDelayMs(1) });
        expect(relayAdmin.fetch).toHaveBeenCalledTimes(2);
        const [retried] = await rows();
        expect(retried).toMatchObject({ status: 'delivered', attempts: 2, last_error: null, next_attempt_at: null });
      });
    }

    it('grows the backoff with each attempt, up to a cap', () => {
      expect(privateReportRetryDelayMs(1)).toBe(5 * 60 * 1000);
      expect(privateReportRetryDelayMs(2)).toBe(10 * 60 * 1000);
      expect(privateReportRetryDelayMs(3)).toBe(20 * 60 * 1000);
      expect(privateReportRetryDelayMs(50)).toBe(60 * 60 * 1000);
    });

    it('stops the run on an auth or transport failure, which every call would hit', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      relayAdmin.fetch.mockImplementation(async () => statusResponse(401));
      for (let i = 0; i < 3; i++) {
        await recordPrivateReportIntake(db, intakeRow({ reportId: reportId(i), giftWrapId: giftWrapId(i) }));
      }

      const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      expect(relayAdmin.fetch).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ attempted: 1, retrying: 1, stoppedEarly: true });
      const attempts = (await rows()).map((row) => row.attempts);
      expect(attempts).toEqual([1, 0, 0]);
    });

    it('carries on past a 503 for one report, which may be specific to its route', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      relayAdmin.fetch.mockImplementation(async (url, init) => (
        JSON.parse(init.body).reportType === 'csam'
          ? statusResponse(503, { success: false, error: 'Coop returned 500' })
          : okResponse({ success: true, outcome: 'age_review_opened', duplicate: false })
      ));
      await recordPrivateReportIntake(db, intakeRow({ reportId: reportId(1), giftWrapId: giftWrapId(1), reportType: 'csam' }));
      await recordPrivateReportIntake(db, intakeRow({ reportId: reportId(2), giftWrapId: giftWrapId(2), reportType: 'underage_user' }));

      const summary = await deliverPendingPrivateReports(deliveryEnv(), { nowMs: NOW_MS });

      expect(summary).toMatchObject({ attempted: 2, delivered: 1, retrying: 1, stoppedEarly: false });
    });

    it('falls back to RELAY_ADMIN_URL with the CF Access headers when there is no binding', async () => {
      globalThis.fetch = vi.fn(async (url, init) => {
        fetchCalls.push({ url, init, body: JSON.parse(init.body) });
        return okResponse();
      });
      await recordPrivateReportIntake(db, intakeRow());

      await deliverPendingPrivateReports(deliveryEnv({
        RELAY_ADMIN: undefined,
        RELAY_ADMIN_URL: 'https://relay-admin.example.test',
        CF_ACCESS_CLIENT_ID: 'access-id',
        CF_ACCESS_CLIENT_SECRET: 'access-secret',
      }), { nowMs: NOW_MS });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [{ url, init }] = fetchCalls;
      expect(url).toBe('https://relay-admin.example.test/api/internal/private-reports');
      expect(init.redirect).toBe('manual');
      // Same as callRelayAdminAction: the shared key only travels over the
      // service binding, never across the public edge.
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        'CF-Access-Client-Id': 'access-id',
        'CF-Access-Client-Secret': 'access-secret',
      });
      expect((await rows())[0].status).toBe('delivered');
    });

    it('resolves a Secrets Store key binding', async () => {
      await recordPrivateReportIntake(db, intakeRow());

      await deliverPendingPrivateReports(deliveryEnv({
        RELAY_ADMIN_API_KEY: { get: async () => 'secret-from-store' },
      }), { nowMs: NOW_MS });

      expect(fetchCalls[0].init.headers['X-Admin-Key']).toBe('secret-from-store');
    });

    it('never throws, even when the database itself fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const brokenDb = {
        prepare() { throw new Error('D1_ERROR: Network connection lost'); },
      };

      await expect(deliverPendingPrivateReports(deliveryEnv({ BLOSSOM_DB: brokenDb }), { nowMs: NOW_MS }))
        .resolves.toMatchObject({ attempted: 0, error: expect.stringContaining('Network connection lost') });
    });

    it('does nothing without a database', async () => {
      await expect(deliverPendingPrivateReports({ RELAY_ADMIN: relayAdmin }, { nowMs: NOW_MS }))
        .resolves.toMatchObject({ attempted: 0 });
      expect(relayAdmin.fetch).not.toHaveBeenCalled();
    });
  });

  describe('prunePrivateReportIntake', () => {
    it('deletes settled rows older than a year and keeps pending and recent ones', async () => {
      for (let i = 0; i < 4; i++) {
        await recordPrivateReportIntake(db, intakeRow({ reportId: reportId(i), giftWrapId: giftWrapId(i) }));
      }
      const [oldDelivered, oldRejected, oldPending, recentDelivered] = await rows();
      const setRow = (id, status, createdAt) => db.prepare(
        'UPDATE private_report_intake SET status = ?, created_at = ? WHERE id = ?'
      ).bind(status, createdAt, id).run();
      await setRow(oldDelivered.id, 'delivered', '2025-01-01 00:00:00');
      await setRow(oldRejected.id, 'rejected', '2025-01-01 00:00:00');
      await setRow(oldPending.id, 'pending', '2025-01-01 00:00:00');
      await db.prepare(
        "UPDATE private_report_intake SET status = 'delivered' WHERE id = ?"
      ).bind(recentDelivered.id).run();

      expect(await prunePrivateReportIntake(db)).toEqual({ deleted: 2 });

      expect((await rows()).map((row) => row.id)).toEqual([oldPending.id, recentDelivered.id]);
    });
  });
});
