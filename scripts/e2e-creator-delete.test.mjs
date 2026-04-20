// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/e2e-creator-delete.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-pool-workers; nodejs_compat is on.

import { describe, it, expect } from 'vitest';
import { parseArgs } from './e2e-creator-delete.mjs';

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const cfg = parseArgs([]);
    expect(cfg).toEqual({
      scenario: 'both',
      stagingRelay: 'wss://relay.staging.divine.video',
      funnelcakeApi: 'https://funnelcake.staging.dvines.org',
      blossomBase: 'https://media.divine.video',
      modServiceBase: 'https://moderation-api.divine.video',
      d1Database: 'blossom-webhook-events',
      cronWaitSeconds: 180,
      skipCleanup: false
    });
  });

  it('parses --scenario=sync', () => {
    expect(parseArgs(['--scenario=sync']).scenario).toBe('sync');
  });

  it('parses --scenario=cron', () => {
    expect(parseArgs(['--scenario=cron']).scenario).toBe('cron');
  });

  it('rejects unknown scenario', () => {
    expect(() => parseArgs(['--scenario=foo'])).toThrow(/scenario/i);
  });

  it('parses --skip-cleanup as boolean', () => {
    expect(parseArgs(['--skip-cleanup']).skipCleanup).toBe(true);
  });

  it('parses --cron-wait-seconds as positive integer', () => {
    expect(parseArgs(['--cron-wait-seconds=240']).cronWaitSeconds).toBe(240);
  });

  it('rejects --cron-wait-seconds=0', () => {
    expect(() => parseArgs(['--cron-wait-seconds=0'])).toThrow(/cron-wait/i);
  });

  it('parses URL overrides', () => {
    const cfg = parseArgs([
      '--staging-relay=wss://localhost:7777',
      '--funnelcake-api=http://localhost:8080',
      '--blossom-base=http://localhost:7676',
      '--mod-service-base=http://localhost:8787'
    ]);
    expect(cfg.stagingRelay).toBe('wss://localhost:7777');
    expect(cfg.funnelcakeApi).toBe('http://localhost:8080');
    expect(cfg.blossomBase).toBe('http://localhost:7676');
    expect(cfg.modServiceBase).toBe('http://localhost:8787');
  });

  it('rejects --cron-wait-seconds=abc (non-numeric)', () => {
    expect(() => parseArgs(['--cron-wait-seconds=abc'])).toThrow(/cron-wait/i);
  });

  it('rejects --cron-wait-seconds=-10 (negative)', () => {
    expect(() => parseArgs(['--cron-wait-seconds=-10'])).toThrow(/cron-wait/i);
  });

  it('rejects --cron-wait-seconds=1.5 (non-integer)', () => {
    expect(() => parseArgs(['--cron-wait-seconds=1.5'])).toThrow(/cron-wait/i);
  });

  it('rejects flags that expect a value but are passed without = (e.g., --cron-wait-seconds)', () => {
    expect(() => parseArgs(['--cron-wait-seconds'])).toThrow(/requires a value/i);
  });

  it('rejects --staging-relay without a value', () => {
    expect(() => parseArgs(['--staging-relay'])).toThrow(/requires a value/i);
  });
});

import { generateTestKey, generateSyntheticBlob } from './e2e-creator-delete.mjs';
import { getPublicKey } from 'nostr-tools/pure';
import { sha256 as sha256Hash } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

describe('generateTestKey', () => {
  it('returns a fresh nsec + hex pubkey each call', () => {
    const a = generateTestKey();
    const b = generateTestKey();
    expect(a.sk).not.toEqual(b.sk);
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.pubkey).toBe(getPublicKey(a.sk));
  });
});

describe('generateSyntheticBlob', () => {
  it('returns exactly 1024 bytes', () => {
    const { bytes } = generateSyntheticBlob();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(1024);
  });

  it('returns a sha256 that matches the bytes', () => {
    const { bytes, sha256 } = generateSyntheticBlob();
    const computed = bytesToHex(sha256Hash(bytes));
    expect(sha256).toBe(computed);
  });

  it('produces a different sha256 on each call', () => {
    const a = generateSyntheticBlob();
    const b = generateSyntheticBlob();
    expect(a.sha256).not.toBe(b.sha256);
  });
});

import { buildKind34236Event } from './e2e-creator-delete.mjs';
import { verifyEvent } from 'nostr-tools/pure';

describe('buildKind34236Event', () => {
  const cfg = parseArgs([]);
  const SHA = 'a'.repeat(64);

  it('returns a signed kind 34236 event with all required tags', () => {
    const { sk } = generateTestKey();
    const event = buildKind34236Event(sk, SHA, cfg);
    expect(event.kind).toBe(34236);
    expect(verifyEvent(event)).toBe(true);

    const tagNames = event.tags.map(t => t[0]);
    expect(tagNames).toContain('d');
    expect(tagNames).toContain('title');
    expect(tagNames).toContain('imeta');
    expect(tagNames).toContain('thumb');
  });

  it('imeta tag contains space-delimited url/x/m items (Funnelcake contract)', () => {
    const { sk } = generateTestKey();
    const event = buildKind34236Event(sk, SHA, cfg);
    const imeta = event.tags.find(t => t[0] === 'imeta');
    expect(imeta).toBeDefined();

    // validate_imeta_format: each non-first item must contain a space
    for (const item of imeta.slice(1)) {
      expect(item).toMatch(/\s/);
    }

    // Required keys for our test blob
    const itemsByKey = Object.fromEntries(
      imeta.slice(1).map(item => {
        const idx = item.indexOf(' ');
        return [item.slice(0, idx), item.slice(idx + 1)];
      })
    );
    expect(itemsByKey.url).toMatch(/^https?:\/\//);
    expect(itemsByKey.x).toBe(SHA);
    expect(itemsByKey.m).toBe('video/mp4');
  });

  it('d tag is unique across calls (prevents addressable-event collision)', () => {
    const { sk: sk1 } = generateTestKey();
    const { sk: sk2 } = generateTestKey();
    const e1 = buildKind34236Event(sk1, SHA, cfg);
    const e2 = buildKind34236Event(sk2, SHA, cfg);
    const d1 = e1.tags.find(t => t[0] === 'd')[1];
    const d2 = e2.tags.find(t => t[0] === 'd')[1];
    expect(d1).not.toBe(d2);
  });
});

import { classifyByteProbeResponse } from './e2e-creator-delete.mjs';

describe('classifyByteProbeResponse', () => {
  it('404 → bytes_gone (flag was on)', () => {
    expect(classifyByteProbeResponse(404)).toEqual({
      kind: 'bytes_gone',
      flagStateInferred: 'on'
    });
  });

  it('200 → bytes_present (flag was off)', () => {
    expect(classifyByteProbeResponse(200)).toEqual({
      kind: 'bytes_present',
      flagStateInferred: 'off'
    });
  });

  it('410 also counts as bytes_gone (some CDNs serve 410 for deleted)', () => {
    expect(classifyByteProbeResponse(410)).toEqual({
      kind: 'bytes_gone',
      flagStateInferred: 'on'
    });
  });

  it('other statuses → unknown (assertion failure)', () => {
    expect(classifyByteProbeResponse(500).kind).toBe('unknown');
    expect(classifyByteProbeResponse(403).kind).toBe('unknown');
    expect(classifyByteProbeResponse(0).kind).toBe('unknown');
  });
});

import { cleanupD1Row } from './e2e-creator-delete.mjs';

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

const WRANGLER_OK = JSON.stringify([{ results: [], success: true, meta: {} }]);

describe('cleanupD1Row', () => {
  const cfg = parseArgs([]);
  const KIND5 = 'a'.repeat(64);
  const TARGET = 'b'.repeat(64);

  it('runs wrangler d1 execute with a DELETE matching the composite primary key', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_OK, stderr: '', status: 0 }));
    await cleanupD1Row(KIND5, TARGET, cfg, runner);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0].args.slice(0, 5)).toEqual(['d1', 'execute', cfg.d1Database, '--remote', '--json']);
    const sql = runner.calls[0].args[runner.calls[0].args.indexOf('--command') + 1];
    expect(sql).toContain('DELETE FROM creator_deletions');
    expect(sql).toContain(`kind5_id = '${KIND5}'`);
    expect(sql).toContain(`target_event_id = '${TARGET}'`);
  });

  it('throws when wrangler exits non-zero', async () => {
    const runner = makeFakeRunner(() => ({ stdout: '', stderr: 'd1 unreachable', status: 1 }));
    await expect(cleanupD1Row(KIND5, TARGET, cfg, runner)).rejects.toThrow(/d1 unreachable/i);
  });

  it('rejects kind5 or target that is not 64-char hex (prevents SQL interpolation risk)', async () => {
    const runner = makeFakeRunner(() => ({ stdout: WRANGLER_OK, stderr: '', status: 0 }));
    await expect(cleanupD1Row('not-hex', TARGET, cfg, runner)).rejects.toThrow(/kind5_id/i);
    await expect(cleanupD1Row(KIND5, 'not-hex', cfg, runner)).rejects.toThrow(/target_event_id/i);
    expect(runner.calls.length).toBe(0);
  });
});

import { cleanupBlossomVanish } from './e2e-creator-delete.mjs';

function makeFakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl({ url, init });
  };
  fn.calls = calls;
  return fn;
}

describe('cleanupBlossomVanish', () => {
  const cfg = { ...parseArgs([]), blossomWebhookSecret: 'test-secret' };
  const PUBKEY = 'f'.repeat(64);

  it('POSTs to /admin/api/vanish with bearer auth and pubkey+reason body', async () => {
    const fetchImpl = makeFakeFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ vanished: true, pubkey: PUBKEY, reason: 'e2e-test cleanup', fully_deleted: 1, unlinked: 0, errors: 0 })
    }));
    const out = await cleanupBlossomVanish(PUBKEY, cfg, fetchImpl);
    expect(fetchImpl.calls.length).toBe(1);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe(`${cfg.blossomBase}/admin/api/vanish`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer test-secret');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.init.body);
    expect(body.pubkey).toBe(PUBKEY);
    expect(body.reason).toBe('e2e-test cleanup');
    expect(out).toEqual({ fullyDeleted: 1, unlinked: 0, errors: 0 });
  });

  it('throws on HTTP 4xx/5xx', async () => {
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 500, text: async () => 'bad gateway' }));
    await expect(cleanupBlossomVanish(PUBKEY, cfg, fetchImpl)).rejects.toThrow(/500/);
  });

  it('throws when vanish body reports errors > 0', async () => {
    const fetchImpl = makeFakeFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ vanished: true, pubkey: PUBKEY, fully_deleted: 0, unlinked: 0, errors: 1 })
    }));
    await expect(cleanupBlossomVanish(PUBKEY, cfg, fetchImpl)).rejects.toThrow(/errors/);
  });

  it('tolerates fully_deleted:0 unlinked:0 (blob already gone from a previous cleanup)', async () => {
    const fetchImpl = makeFakeFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ vanished: true, pubkey: PUBKEY, fully_deleted: 0, unlinked: 0, errors: 0 })
    }));
    const out = await cleanupBlossomVanish(PUBKEY, cfg, fetchImpl);
    expect(out).toEqual({ fullyDeleted: 0, unlinked: 0, errors: 0 });
  });

  it('throws when cfg.blossomWebhookSecret is missing', async () => {
    const fetchImpl = makeFakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ fully_deleted: 1, unlinked: 0, errors: 0 }) }));
    const cfgNoSecret = { ...parseArgs([]) };
    await expect(cleanupBlossomVanish(PUBKEY, cfgNoSecret, fetchImpl)).rejects.toThrow(/blossomWebhookSecret/);
    expect(fetchImpl.calls.length).toBe(0);
  });
});
