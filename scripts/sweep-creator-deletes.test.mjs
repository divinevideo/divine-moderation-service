// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/sweep-creator-deletes.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-plugin; nodejs_compat is on, but it does not provide node:child_process, so defaultRunner imports it lazily.

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  buildSelectCandidatesSql,
  buildSelectUnprocessableSql,
  buildSelectPermanentFailuresSql,
  buildUpdateStampSql,
  validateSha256
} from './sweep-creator-deletes.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const cfg = parseArgs([]);
    expect(cfg).toEqual({
      dryRun: false,
      local: false,
      since: null,
      until: null,
      concurrency: 5,
      limit: null,
      blossomWebhookUrl: 'https://media.divine.video/admin/moderate',
      d1Database: 'blossom-webhook-events'
    });
  });

  it('parses --dry-run as boolean', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --local as boolean', () => {
    expect(parseArgs(['--local']).local).toBe(true);
  });

  it('parses --since and --until as ISO strings via Date round-trip', () => {
    const cfg = parseArgs(['--since=2026-04-01T00:00:00.000Z', '--until=2026-04-17T00:00:00.000Z']);
    expect(cfg.since).toBe('2026-04-01T00:00:00.000Z');
    expect(cfg.until).toBe('2026-04-17T00:00:00.000Z');
  });

  it('rejects an unparseable --since', () => {
    expect(() => parseArgs(['--since=not-a-date'])).toThrow(/since/i);
  });

  it('parses --concurrency as positive integer', () => {
    expect(parseArgs(['--concurrency=10']).concurrency).toBe(10);
  });

  it('rejects --concurrency=0', () => {
    expect(() => parseArgs(['--concurrency=0'])).toThrow(/concurrency/i);
  });

  it('rejects --concurrency=-1', () => {
    expect(() => parseArgs(['--concurrency=-1'])).toThrow(/concurrency/i);
  });

  it('parses --limit as non-negative integer', () => {
    expect(parseArgs(['--limit=100']).limit).toBe(100);
  });

  it('rejects --limit=foo', () => {
    expect(() => parseArgs(['--limit=foo'])).toThrow(/limit/i);
  });

  it('parses --blossom-webhook-url and --d1-database overrides', () => {
    const cfg = parseArgs(['--blossom-webhook-url=http://localhost:7676/admin/moderate', '--d1-database=test-db']);
    expect(cfg.blossomWebhookUrl).toBe('http://localhost:7676/admin/moderate');
    expect(cfg.d1Database).toBe('test-db');
  });
});

describe('validateSha256', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(validateSha256(SHA_A)).toBe(SHA_A);
  });
  it('rejects uppercase', () => {
    expect(() => validateSha256(SHA_A.toUpperCase())).toThrow(/sha256/i);
  });
  it('rejects shorter than 64', () => {
    expect(() => validateSha256('a'.repeat(63))).toThrow(/sha256/i);
  });
  it('rejects non-hex characters', () => {
    expect(() => validateSha256('z'.repeat(64))).toThrow(/sha256/i);
  });
  it('rejects null/undefined', () => {
    expect(() => validateSha256(null)).toThrow(/sha256/i);
    expect(() => validateSha256(undefined)).toThrow(/sha256/i);
  });
});

describe('buildSelectCandidatesSql', () => {
  it('builds the base select with no optional filters', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: null });
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND physical_deleted_at IS NULL');
    expect(sql).toContain('AND blob_sha256 IS NOT NULL');
    expect(sql).not.toContain('completed_at >=');
    expect(sql).not.toContain('completed_at <');
    expect(sql).not.toContain('LIMIT');
  });

  it('includes since when provided', () => {
    const sql = buildSelectCandidatesSql({ since: '2026-04-01T00:00:00.000Z', until: null, limit: null });
    expect(sql).toContain("AND completed_at >= '2026-04-01T00:00:00.000Z'");
  });

  it('includes until when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: '2026-04-17T00:00:00.000Z', limit: null });
    expect(sql).toContain("AND completed_at < '2026-04-17T00:00:00.000Z'");
  });

  it('includes LIMIT when provided', () => {
    const sql = buildSelectCandidatesSql({ since: null, until: null, limit: 50 });
    expect(sql).toMatch(/LIMIT 50\b/);
  });
});

describe('buildSelectUnprocessableSql', () => {
  it('builds select for status=success rows with NULL sha', () => {
    const sql = buildSelectUnprocessableSql();
    expect(sql).toContain("WHERE status = 'success'");
    expect(sql).toContain('AND blob_sha256 IS NULL');
  });
});

describe('buildSelectPermanentFailuresSql', () => {
  it('builds select for status LIKE failed:permanent:*', () => {
    const sql = buildSelectPermanentFailuresSql();
    expect(sql).toContain("WHERE status LIKE 'failed:permanent:%'");
  });
});

describe('buildUpdateStampSql', () => {
  it('builds an UPDATE with IN-list and NULL guard', () => {
    const sql = buildUpdateStampSql([SHA_A, SHA_B], '2026-04-17T20:00:00.000Z');
    expect(sql).toContain("SET physical_deleted_at = '2026-04-17T20:00:00.000Z'");
    expect(sql).toContain(`WHERE blob_sha256 IN ('${SHA_A}', '${SHA_B}')`);
    expect(sql).toContain('AND physical_deleted_at IS NULL');
  });

  it('rejects an empty sha list (caller bug)', () => {
    expect(() => buildUpdateStampSql([], '2026-04-17T20:00:00.000Z')).toThrow(/empty/i);
  });

  it('rejects when any sha fails validation', () => {
    expect(() => buildUpdateStampSql([SHA_A, 'not-hex'], '2026-04-17T20:00:00.000Z')).toThrow(/sha256/i);
  });

  it('rejects an invalid timestamp', () => {
    expect(() => buildUpdateStampSql([SHA_A], 'not-iso')).toThrow(/timestamp/i);
  });
});

import { runWithConcurrency } from './sweep-creator-deletes.mjs';

describe('runWithConcurrency', () => {
  it('runs all items and returns one result per input', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 2, async x => x * 10);
    expect(results.length).toBe(5);
    expect(results.map(r => r.value).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it('respects concurrency cap (never more than N in flight)', async () => {
    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    };
    await runWithConcurrency(new Array(20).fill(0), 3, work);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('isolates per-item errors — one failure does not poison the rest', async () => {
    const items = [1, 2, 3];
    const results = await runWithConcurrency(items, 2, async x => {
      if (x === 2) throw new Error('boom');
      return x;
    });
    expect(results.length).toBe(3);
    const byInput = Object.fromEntries(results.map(r => [r.input, r]));
    expect(byInput[1].value).toBe(1);
    expect(byInput[2].error.message).toBe('boom');
    expect(byInput[3].value).toBe(3);
  });

  it('returns immediately on empty input', async () => {
    const results = await runWithConcurrency([], 5, async () => { throw new Error('should not run'); });
    expect(results).toEqual([]);
  });

  it('honors drainCheck — stops pulling new items once it returns true', async () => {
    // 20 items, cap at 2, drain after 3 complete. Remaining items must not run.
    const processed = [];
    let drain = false;
    const fn = async (x) => {
      processed.push(x);
      if (processed.length >= 3) drain = true;
      return x;
    };
    const results = await runWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      fn,
      () => drain
    );
    // We don't know the exact count (concurrency race + post-flag workers finishing
    // their current item), but it must be bounded well below 20 and the returned
    // results should correspond to items that actually ran.
    expect(processed.length).toBeLessThan(20);
    expect(results.length).toBe(processed.length);
    for (const r of results) expect(r.value).toBe(r.input);
  });
});

import { callBlossomDelete, classifyDeleteResult } from './sweep-creator-deletes.mjs';

const SHA_C = 'c'.repeat(64);

function makeFakeNotify(impl) {
  const calls = [];
  const fn = async (sha256, action, env) => {
    calls.push({ sha256, action, env });
    return impl({ sha256, action, env });
  };
  fn.calls = calls;
  return fn;
}

describe('callBlossomDelete', () => {
  it('passes sha + DELETE + env to notifyBlossom and returns a normalized result', async () => {
    const notify = makeFakeNotify(() => ({
      success: true,
      status: 200,
      result: { success: true, physical_deleted: true, physical_delete_skipped: false }
    }));
    const cfg = {
      blossomWebhookUrl: 'https://example/admin/moderate',
      blossomWebhookSecret: 'secret-xyz'
    };
    const r = await callBlossomDelete(SHA_C, cfg, notify);
    expect(notify.calls).toEqual([{
      sha256: SHA_C,
      action: 'DELETE',
      env: { BLOSSOM_WEBHOOK_URL: cfg.blossomWebhookUrl, BLOSSOM_WEBHOOK_SECRET: cfg.blossomWebhookSecret }
    }]);
    expect(r.ok).toBe(true);
    expect(r.body.physical_deleted).toBe(true);
  });

  it('surfaces network error from notifyBlossom', async () => {
    const notify = makeFakeNotify(() => ({ success: false, networkError: true, error: 'ECONNRESET' }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.networkError).toBe(true);
  });

  it('surfaces 5xx HTTP error', async () => {
    const notify = makeFakeNotify(() => ({ success: false, error: 'HTTP 502: bad', status: 502 }));
    const r = await callBlossomDelete(SHA_C, { blossomWebhookUrl: 'u', blossomWebhookSecret: 's' }, notify);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
  });
});

describe('classifyDeleteResult', () => {
  it('success when ok && body.status==="success" && body.physical_deleted===true', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { success: true, physical_deleted: true, physical_delete_skipped: false }
    })).toEqual({ kind: 'success' });
  });

  it('flag-off pre-flight signal when physical_delete_skipped===true', () => {
    expect(classifyDeleteResult({
      ok: true, status: 200,
      body: { success: true, physical_deleted: false, physical_delete_skipped: true }
    })).toEqual({ kind: 'flag-off' });
  });

  it('failure when 200 but physical_deleted===false (and flag was on)', () => {
    // success:true but physical_deleted:false with skip:false means Blossom
    // accepted the call but the byte-delete did not complete. Treat as failure.
    const out = classifyDeleteResult({
      ok: true, status: 200,
      body: { success: true, physical_deleted: false, physical_delete_skipped: false }
    });
    expect(out.kind).toBe('failure');
    expect(out.reason).toMatch(/unexpected Blossom response/);
  });

  it('failure when 200 with an unexpected body shape', () => {
    const out = classifyDeleteResult({
      ok: true, status: 200,
      body: { success: false, error: 'gcs delete failed' }
    });
    expect(out.kind).toBe('failure');
    expect(out.reason).toMatch(/unexpected Blossom response/);
  });

  it('auth-failure on 401/403', () => {
    expect(classifyDeleteResult({ ok: false, status: 401 })).toEqual({ kind: 'auth-failure' });
    expect(classifyDeleteResult({ ok: false, status: 403 })).toEqual({ kind: 'auth-failure' });
  });

  it('unreachable on 5xx', () => {
    expect(classifyDeleteResult({ ok: false, status: 502 }).kind).toBe('unreachable');
  });

  it('unreachable on networkError', () => {
    expect(classifyDeleteResult({ ok: false, networkError: true, error: 'ECONNRESET' }).kind).toBe('unreachable');
  });
});

import {
  fetchCandidates,
  fetchUnprocessable,
  fetchPermanentFailures,
  flushDeletedAt
} from './sweep-creator-deletes.mjs';

function makeFakeRunner(responseFor) {
  const calls = [];
  const fn = async ({ command, args }) => {
    calls.push({ command, args });
    const sql = args[args.indexOf('--command') + 1];
    return responseFor(sql);
  };
  fn.calls = calls;
  return fn;
}

const WRANGLER_RESULT_ENVELOPE = (rows) => JSON.stringify([{ results: rows, success: true, meta: {} }]);

describe('fetchCandidates', () => {
  it('shells wrangler with the right command, db, and SQL; parses results', async () => {
    const runner = makeFakeRunner(() => ({
      stdout: WRANGLER_RESULT_ENVELOPE([
        { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' }
      ]),
      stderr: '',
      status: 0
    }));
    const cfg = parseArgs([]);
    const rows = await fetchCandidates(cfg, runner);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0].command).toBe('wrangler');
    expect(runner.calls[0].args.slice(0, 5)).toEqual(['d1', 'execute', cfg.d1Database, '--remote', '--json']);
    expect(runner.calls[0].args[5]).toBe('--command');
    expect(runner.calls[0].args[6]).toContain("WHERE status = 'success'");
    expect(rows).toEqual([
      { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' }
    ]);
  });

  it('returns empty array when wrangler result envelope has zero rows', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    const rows = await fetchCandidates(parseArgs([]), runner);
    expect(rows).toEqual([]);
  });

  it('passes --local to wrangler when cfg.local is true', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await fetchCandidates(parseArgs(['--local']), runner);
    expect(runner.calls[0].args).toContain('--local');
    expect(runner.calls[0].args).not.toContain('--remote');
  });

  it('throws when wrangler exits non-zero', async () => {
    const runner = makeFakeRunner(() => ({ stdout: '', stderr: 'auth required', status: 1 }));
    await expect(fetchCandidates(parseArgs([]), runner)).rejects.toThrow(/auth required/i);
  });

  it('throws when wrangler stdout is not parseable JSON', async () => {
    const runner = makeFakeRunner(() => ({ stdout: 'not json', stderr: '', status: 0 }));
    await expect(fetchCandidates(parseArgs([]), runner)).rejects.toThrow(/parse/i);
  });
});

describe('fetchUnprocessable', () => {
  it('queries for status=success AND blob_sha256 IS NULL', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await fetchUnprocessable(parseArgs([]), runner);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain('blob_sha256 IS NULL');
  });
});

describe('fetchPermanentFailures', () => {
  it("queries for status LIKE 'failed:permanent:%'", async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await fetchPermanentFailures(parseArgs([]), runner);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain("'failed:permanent:%'");
  });
});

describe('flushDeletedAt', () => {
  it('builds and runs UPDATE with the supplied shas + timestamp', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    const ts = '2026-04-17T20:00:00.000Z';
    await flushDeletedAt(['a'.repeat(64), 'b'.repeat(64)], parseArgs([]), runner, ts);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain(`SET physical_deleted_at = '${ts}'`);
    expect(sql).toContain(`'${'a'.repeat(64)}'`);
    expect(sql).toContain(`'${'b'.repeat(64)}'`);
  });

  it('is a no-op on empty sha list', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }));
    await flushDeletedAt([], parseArgs([]), runner, '2026-04-17T20:00:00.000Z');
    expect(runner.calls.length).toBe(0);
  });

  it('throws when wrangler exits non-zero', async () => {
    const runner = makeFakeRunner(() => ({ stdout: '', stderr: 'd1 unreachable', status: 1 }));
    await expect(flushDeletedAt(['a'.repeat(64)], parseArgs([]), runner, '2026-04-17T20:00:00.000Z'))
      .rejects.toThrow(/d1 unreachable/i);
  });
});

import { runPreflight, PreflightAbort } from './sweep-creator-deletes.mjs';

describe('runPreflight', () => {
  const SHA = 'd'.repeat(64);
  const cfg = parseArgs([]);

  it('returns success for the first row when Blossom returns physical_deleted=true', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: true, physical_deleted: true, physical_delete_skipped: false }
    }));
    const out = await runPreflight(SHA, cfg, notify);
    expect(out).toEqual({ kind: 'success' });
    expect(notify.calls.length).toBe(1);
  });

  it('throws PreflightAbort with reason="flag-off" when physical_delete_skipped is true', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: true, physical_deleted: false, physical_delete_skipped: true }
    }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'flag-off'
    });
  });

  it('throws PreflightAbort with reason="auth-failure" on 401', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 401, error: 'unauthorized' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'auth-failure'
    });
  });

  it('throws PreflightAbort with reason="unreachable" on 502', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 502, error: 'bad gateway' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'unreachable'
    });
  });

  it('throws PreflightAbort with reason="unreachable" on network error', async () => {
    const notify = makeFakeNotify(() => ({ success: false, networkError: true, error: 'ECONNRESET' }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'unreachable'
    });
  });

  it('throws PreflightAbort with reason="failure" when Blossom returns 200 with an unexpected body', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: false, error: 'gcs delete failed' }
    }));
    await expect(runPreflight(SHA, cfg, notify)).rejects.toMatchObject({
      name: 'PreflightAbort',
      reason: 'failure'
    });
  });
});

import { sweepCandidates, summarize, computeExitCode, D1WriteAbort, MidRunFlagOff } from './sweep-creator-deletes.mjs';

describe('sweepCandidates', () => {
  const cfg = parseArgs(['--concurrency=2']);
  const rowFor = (sha) => ({ kind5_id: `k-${sha.slice(0,4)}`, target_event_id: `t-${sha.slice(0,4)}`, blob_sha256: sha, completed_at: '2026-04-15T00:00:00Z' });

  it('stamps shas where Blossom returned physical_deleted=true', async () => {
    const okBody = { success: true, physical_deleted: true, physical_delete_skipped: false };
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    const out = await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(out.successes.length).toBe(3);
    expect(out.failures.length).toBe(0);
    expect(flushed.sort()).toEqual(candidates.map(r => r.blob_sha256).sort());
  });

  it('does NOT stamp shas when physical_deleted=false (even on HTTP 200)', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: true, physical_deleted: false, physical_delete_skipped: false }
    }));
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const out = await sweepCandidates([rowFor('e'.repeat(64))], cfg, notify, flushImpl);
    expect(out.successes.length).toBe(0);
    expect(out.failures.length).toBe(1);
    expect(flushed).toEqual([]);
  });

  it('isolates per-row failures — successful rows still stamp', async () => {
    const notify = makeFakeNotify(({ sha256 }) => {
      if (sha256.startsWith('b')) return { success: false, status: 502, error: 'bad gateway' };
      return { success: true, status: 200, result: { success: true, physical_deleted: true, physical_delete_skipped: false } };
    });
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    const out = await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(out.successes.length).toBe(2);
    expect(out.failures.length).toBe(1);
    expect(flushed.sort()).toEqual([candidates[0].blob_sha256, candidates[2].blob_sha256].sort());
  });

  it('throws MidRunFlagOff when a row reports physical_delete_skipped=true mid-sweep', async () => {
    // Simulates: operator toggles ENABLE_PHYSICAL_DELETE off between pre-flight
    // and mid-sweep. First row succeeds; second row reports skip=true; sweep
    // must abort loudly rather than silently log per-row failures.
    const notify = makeFakeNotify(({ sha256 }) => {
      if (sha256.startsWith('b')) {
        return { success: true, status: 200, result: { success: true, physical_deleted: false, physical_delete_skipped: true } };
      }
      return { success: true, status: 200, result: { success: true, physical_deleted: true, physical_delete_skipped: false } };
    });
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    let caught;
    try {
      await sweepCandidates(candidates, parseArgs(['--concurrency=1']), notify, flushImpl);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MidRunFlagOff);
    // Pre-flag-off rows that succeeded must already be flushed (so bytes
    // destroyed earlier are recorded as stamped).
    expect(flushed).toContain(candidates[0].blob_sha256);
  });

  it('throws D1WriteAbort with unflushed shas when flush fails mid-sweep', async () => {
    const okBody = { success: true, physical_deleted: true, physical_delete_skipped: false };
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const flushImpl = async () => { throw new Error('d1 unreachable'); };
    const candidates = ['a','b','c'].map(c => rowFor(c.repeat(64)));
    let caught;
    try {
      await sweepCandidates(candidates, cfg, notify, flushImpl);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(D1WriteAbort);
    expect(caught.unflushedShas.sort()).toEqual(candidates.map(r => r.blob_sha256).sort());
    expect(caught.originalError.message).toBe('d1 unreachable');
  });

  it('flushes in batches of FLUSH_BATCH_SIZE (default 100)', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: true, physical_deleted: true, physical_delete_skipped: false }
    }));
    const batches = [];
    const flushImpl = async (shas) => { batches.push(shas.length); };
    const candidates = Array.from({ length: 250 }, (_, i) => rowFor(i.toString(16).padStart(64, '0')));
    await sweepCandidates(candidates, cfg, notify, flushImpl);
    expect(batches).toEqual([100, 100, 50]);
  });

  it('preserves completed successes after SIGINT drain flips mid-run', async () => {
    // Regression for Liz's #106 review: the previous code broke out of the
    // result-consumption loop as soon as `isDraining()` returned true, so
    // any successes that completed between the first SIGINT and the
    // scheduler returning were dropped from `pending` and never flushed
    // or summarized. The drain check now lives only in
    // runWithConcurrency; the consumption loop must process everything
    // the scheduler returns.
    //
    // This test simulates: 20 candidates, concurrency 1 (deterministic
    // ordering), drain flipped ON after 5 complete. The scheduler
    // returns 5 results (drain stops it from pulling items 6-20); all 5
    // must land in successes and get flushed.
    let completedCount = 0;
    let draining = false;
    const isDrainingImpl = () => draining;
    const notify = makeFakeNotify(() => {
      completedCount++;
      // Flip the drain flag after 5 successful completions. The
      // scheduler will stop dequeueing new items; the in-flight batch
      // has already drained since concurrency=1.
      if (completedCount === 5) draining = true;
      return {
        success: true,
        status: 200,
        result: { success: true, physical_deleted: true, physical_delete_skipped: false },
      };
    });
    const flushed = [];
    const flushImpl = async (shas) => { flushed.push(...shas); };
    const candidates = Array.from({ length: 20 }, (_, i) =>
      rowFor(i.toString(16).padStart(64, '0')),
    );

    const out = await sweepCandidates(
      candidates,
      parseArgs(['--concurrency=1']),
      notify,
      flushImpl,
      isDrainingImpl,
    );

    // All 5 that completed before drain fully took effect must be
    // preserved in the result and flushed.
    expect(out.successes.length).toBe(5);
    expect(out.failures.length).toBe(0);
    expect(flushed.length).toBe(5);
    // The remaining 15 candidates were never dequeued (drain stopped them).
    expect(completedCount).toBe(5);
  });
});

describe('summarize', () => {
  it('aggregates counts and lists for printing', () => {
    const result = summarize({
      candidates: [{ blob_sha256: 'a'.repeat(64) }],
      successes: [{ blob_sha256: 'a'.repeat(64) }],
      failures: [],
      unprocessable: [{ kind5_id: 'k1' }],
      permanentFailures: []
    });
    expect(result).toMatchObject({
      total: 1,
      stamped: 1,
      failed: 0,
      unprocessableCount: 1,
      permanentFailureCount: 0
    });
  });
});

describe('computeExitCode', () => {
  it('returns 0 when nothing failed and no unprocessable / perm-failures', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 0, permanentFailureCount: 0 })).toBe(0);
  });
  it('returns 1 when failures exist', () => {
    expect(computeExitCode({ failed: 1, unprocessableCount: 0, permanentFailureCount: 0 })).toBe(1);
  });
  it('returns 1 when unprocessable rows exist', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 1, permanentFailureCount: 0 })).toBe(1);
  });
  it('returns 1 when permanent failures exist', () => {
    expect(computeExitCode({ failed: 0, unprocessableCount: 0, permanentFailureCount: 1 })).toBe(1);
  });
  it('returns 1 when the sweep was clean but the surfacing queries failed', () => {
    // Regression for Liz's #106 review: a silent degradation to exit 0 when
    // the final unprocessable/permanent-failure readback fails makes the run
    // look fully successful while operator visibility is actually gone.
    expect(computeExitCode({ failed: 0, unprocessableCount: 0, permanentFailureCount: 0, surfacingFailed: true })).toBe(1);
  });
});

import { main } from './sweep-creator-deletes.mjs';

describe('main (integration)', () => {
  const candidateRow = { kind5_id: 'k1', target_event_id: 't1', blob_sha256: 'a'.repeat(64), completed_at: '2026-04-15T00:00:00Z' };
  const okBody = { success: true, physical_deleted: true, physical_delete_skipped: false };

  function makeRunnerForResults({ candidates = [], unprocessable = [], permanentFailures = [], updates = () => ({stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0}) } = {}) {
    return async ({ command, args }) => {
      const sql = args[args.indexOf('--command') + 1];
      if (sql.startsWith('SELECT kind5_id, target_event_id, blob_sha256')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(candidates), stderr: '', status: 0 };
      }
      if (sql.includes('blob_sha256 IS NULL')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(unprocessable), stderr: '', status: 0 };
      }
      if (sql.includes("'failed:permanent:%'")) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(permanentFailures), stderr: '', status: 0 };
      }
      if (sql.startsWith('UPDATE creator_deletions')) {
        return updates(sql);
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    };
  }

  it('dry-run: prints candidates, makes zero notify or D1-write calls', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called in dry-run'); });
    let updateCalls = 0;
    const runner = makeRunnerForResults({
      candidates: [candidateRow],
      updates: () => { updateCalls++; return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }; }
    });
    const code = await main(['--dry-run'], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(0);
    expect(updateCalls).toBe(0);
    expect(code).toBe(0);
  });

  it('pre-flight flag-off: aborts with exit 2 and zero D1 writes', async () => {
    const notify = makeFakeNotify(() => ({
      success: true, status: 200,
      result: { success: true, physical_deleted: false, physical_delete_skipped: true }
    }));
    let updateCalls = 0;
    const runner = makeRunnerForResults({
      candidates: [candidateRow],
      updates: () => { updateCalls++; return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 }; }
    });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(1);
    expect(updateCalls).toBe(0);
    expect(code).toBe(2);
  });

  it('pre-flight 401: aborts with exit 2', async () => {
    const notify = makeFakeNotify(() => ({ success: false, status: 401, error: 'unauthorized' }));
    const runner = makeRunnerForResults({ candidates: [candidateRow] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(2);
  });

  it('successful sweep: stamps all rows, exit 0', async () => {
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const runner = makeRunnerForResults({ candidates: [candidateRow] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(0);
  });

  it('per-row failure: continues sweep, exit 1', async () => {
    const candidates = ['a', 'b'].map(c => ({ ...candidateRow, blob_sha256: c.repeat(64), kind5_id: `k-${c}`, target_event_id: `t-${c}` }));
    const notify = makeFakeNotify(({ sha256 }) => {
      if (sha256.startsWith('b')) return { success: false, status: 502, error: 'bad gateway' };
      return { success: true, status: 200, result: okBody };
    });
    const runner = makeRunnerForResults({ candidates });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(1);
  });

  it('empty-candidates short-circuit: still surfaces unprocessable + perm-failures', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called'); });
    const runner = makeRunnerForResults({
      candidates: [],
      unprocessable: [{ kind5_id: 'k1', target_event_id: 't1', creator_pubkey: 'pub1', completed_at: '2026-04-15T00:00:00Z' }],
      permanentFailures: []
    });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(notify.calls.length).toBe(0);
    expect(code).toBe(1);
  });

  it('D1 flush failure mid-sweep: exit 4', async () => {
    const candidates = ['a', 'b'].map(c => ({ ...candidateRow, blob_sha256: c.repeat(64), kind5_id: `k-${c}`, target_event_id: `t-${c}` }));
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const runner = async ({ args }) => {
      const sql = args[args.indexOf('--command') + 1];
      if (sql.startsWith('SELECT kind5_id, target_event_id, blob_sha256')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE(candidates), stderr: '', status: 0 };
      }
      if (sql.includes('blob_sha256 IS NULL')) return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 };
      if (sql.includes("'failed:permanent:%'")) return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 };
      if (sql.startsWith('UPDATE creator_deletions')) {
        return { stdout: '', stderr: 'd1 unreachable', status: 1 };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    };
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(4);
  });

  it('empty everywhere: exit 0', async () => {
    const notify = makeFakeNotify(() => { throw new Error('should not be called'); });
    const runner = makeRunnerForResults({ candidates: [], unprocessable: [], permanentFailures: [] });
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(0);
  });

  it('surfacing query failure: exits non-zero even when the sweep itself was clean', async () => {
    // Regression for Liz's #106 review. The sweep succeeds on the sole
    // candidate, but the final unprocessable/permanent-failure readback
    // fails. Previously the code logged a warning and still returned 0
    // (both lists were empty). Now it must exit non-zero so the run
    // does not silently look fully successful when operator visibility
    // into unprocessable / permanent-failure rows has been lost.
    const notify = makeFakeNotify(() => ({ success: true, status: 200, result: okBody }));
    const runner = async ({ args }) => {
      const sql = args[args.indexOf('--command') + 1];
      if (sql.startsWith('SELECT kind5_id, target_event_id, blob_sha256')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE([candidateRow]), stderr: '', status: 0 };
      }
      if (sql.includes('blob_sha256 IS NULL')) {
        // Simulate a transient D1 failure on the unprocessable readback.
        return { stdout: '', stderr: 'd1 surfacing query exploded', status: 1 };
      }
      if (sql.includes("'failed:permanent:%'")) {
        return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 };
      }
      if (sql.startsWith('UPDATE creator_deletions')) {
        return { stdout: WRANGLER_RESULT_ENVELOPE([]), stderr: '', status: 0 };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
    };
    const code = await main([], { runner, notify, blossomWebhookSecret: 'test-secret' });
    expect(code).toBe(1);
  });
});
