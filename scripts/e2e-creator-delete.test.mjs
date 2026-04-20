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

import { uploadToBlossom, buildBud01UploadAuth } from './e2e-creator-delete.mjs';

describe('buildBud01UploadAuth', () => {
  const SHA = 'a'.repeat(64);
  it('returns a Nostr-scheme header with kind 24242 event containing t=upload and x=sha', () => {
    const { sk } = generateTestKey();
    const header = buildBud01UploadAuth(sk, SHA);
    expect(header.startsWith('Nostr ')).toBe(true);
    const eventJson = Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
    const event = JSON.parse(eventJson);
    expect(event.kind).toBe(24242);
    expect(event.tags).toEqual(expect.arrayContaining([['t', 'upload'], ['x', SHA]]));
  });
});

describe('uploadToBlossom', () => {
  const cfg = parseArgs([]);
  const SHA = 'a'.repeat(64);

  it('PUTs the bytes to /upload with BUD-01 auth and returns the parsed response', async () => {
    const fetchImpl = makeFakeFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ url: `${cfg.blossomBase}/${SHA}`, sha256: SHA, size: 1024 })
    }));
    const { sk } = generateTestKey();
    const bytes = new Uint8Array(1024);
    const out = await uploadToBlossom(bytes, SHA, sk, cfg, fetchImpl);
    expect(fetchImpl.calls.length).toBe(1);
    expect(fetchImpl.calls[0].url).toBe(`${cfg.blossomBase}/upload`);
    expect(fetchImpl.calls[0].init.method).toBe('PUT');
    expect(fetchImpl.calls[0].init.headers.Authorization.startsWith('Nostr ')).toBe(true);
    expect(fetchImpl.calls[0].init.body).toBe(bytes);
    expect(out).toEqual({ url: `${cfg.blossomBase}/${SHA}`, sha256: SHA });
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 413, text: async () => 'too large' }));
    const { sk } = generateTestKey();
    await expect(uploadToBlossom(new Uint8Array(1), SHA, sk, cfg, fetchImpl)).rejects.toThrow(/413/);
  });
});

import { waitForIndexing } from './e2e-creator-delete.mjs';

describe('waitForIndexing', () => {
  const cfg = parseArgs([]);
  const EVENT_ID = 'a'.repeat(64);

  it('resolves immediately when fetch returns 200 on first attempt', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ id: EVENT_ID }) };
    };
    await waitForIndexing(EVENT_ID, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 });
    expect(calls).toBe(1);
  });

  it('polls until 200, tolerates 404 during indexing lag', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, json: async () => ({ id: EVENT_ID }) };
    };
    await waitForIndexing(EVENT_ID, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 });
    expect(calls).toBe(3);
  });

  it('throws after timeout', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'not found' });
    await expect(
      waitForIndexing(EVENT_ID, cfg, { fetchImpl, timeoutMs: 50, pollIntervalMs: 10 })
    ).rejects.toThrow(/timeout|not indexed/i);
  });

  it('throws immediately on non-404 HTTP error', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'server error' });
    await expect(
      waitForIndexing(EVENT_ID, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 })
    ).rejects.toThrow(/500/);
  });
});

import { callSyncEndpoint, pollStatus } from './e2e-creator-delete.mjs';

describe('callSyncEndpoint', () => {
  const cfg = parseArgs([]);

  it('POSTs to /api/creator-delete/sync with NIP-98 Authorization + kind 5 body', async () => {
    const fetchImpl = makeFakeFetch(async () => ({ ok: true, status: 202, json: async () => ({ accepted: true }) }));
    const { sk } = generateTestKey();
    const kind5 = { id: 'a'.repeat(64), kind: 5, pubkey: 'f'.repeat(64), tags: [], content: '', created_at: 0, sig: '00' };
    await callSyncEndpoint(sk, kind5, cfg, fetchImpl);
    expect(fetchImpl.calls.length).toBe(1);
    const call = fetchImpl.calls[0];
    expect(call.url).toBe(`${cfg.modServiceBase}/api/creator-delete/sync`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization.startsWith('Nostr ')).toBe(true);
    expect(JSON.parse(call.init.body)).toEqual(kind5);
  });

  it('throws on 4xx/5xx', async () => {
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 400, text: async () => 'bad request' }));
    const { sk } = generateTestKey();
    const kind5 = { id: 'a'.repeat(64), kind: 5, pubkey: 'f'.repeat(64), tags: [], content: '', created_at: 0, sig: '00' };
    await expect(callSyncEndpoint(sk, kind5, cfg, fetchImpl)).rejects.toThrow(/400/);
  });
});

describe('pollStatus', () => {
  const cfg = parseArgs([]);
  const KIND5 = 'a'.repeat(64);

  it('resolves with the terminal success body', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) return { ok: true, status: 200, json: async () => ({ status: 'accepted' }) };
      return { ok: true, status: 200, json: async () => ({ status: 'success', blob_sha256: 'a'.repeat(64) }) };
    };
    const { sk } = generateTestKey();
    const out = await pollStatus(sk, KIND5, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 });
    expect(out.status).toBe('success');
    expect(calls).toBe(3);
  });

  it('resolves when status reaches a failed:* terminal (returns the body for caller to assert on)', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 'failed:permanent:target_not_found' }) });
    const { sk } = generateTestKey();
    const out = await pollStatus(sk, KIND5, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 });
    expect(out.status).toBe('failed:permanent:target_not_found');
  });

  it('throws on timeout if no terminal status is reached', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 'accepted' }) });
    const { sk } = generateTestKey();
    await expect(
      pollStatus(sk, KIND5, cfg, { fetchImpl, timeoutMs: 40, pollIntervalMs: 10 })
    ).rejects.toThrow(/timeout/i);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    const { sk } = generateTestKey();
    await expect(
      pollStatus(sk, KIND5, cfg, { fetchImpl, timeoutMs: 5000, pollIntervalMs: 10 })
    ).rejects.toThrow(/401/);
  });
});

import { assertD1AndBlossomState } from './e2e-creator-delete.mjs';

describe('assertD1AndBlossomState', () => {
  const cfg = parseArgs([]);
  const KIND5 = 'a'.repeat(64);
  const TARGET = 'b'.repeat(64);
  const SHA = 'c'.repeat(64);

  const makeD1Row = (overrides) => JSON.stringify([{
    results: [{ kind5_id: KIND5, target_event_id: TARGET, blob_sha256: SHA, status: 'success', ...overrides }],
    success: true, meta: {}
  }]);

  it('passes when D1 row status=success and Blossom returns 404 (bytes gone)', async () => {
    const runner = makeFakeRunner(() => ({ stdout: makeD1Row(), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 404, text: async () => 'not found' }));
    const out = await assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl });
    expect(out.d1Status).toBe('success');
    expect(out.byteProbe).toMatchObject({ kind: 'bytes_gone', flagStateInferred: 'on' });
  });

  it('passes when D1 row status=success and Blossom returns 200 (bytes present, flag off)', async () => {
    const runner = makeFakeRunner(() => ({ stdout: makeD1Row(), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: true, status: 200, text: async () => 'bytes' }));
    const out = await assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl });
    expect(out.byteProbe).toMatchObject({ kind: 'bytes_present', flagStateInferred: 'off' });
  });

  it('fails when D1 row is missing', async () => {
    const runner = makeFakeRunner(() => ({ stdout: JSON.stringify([{ results: [], success: true, meta: {} }]), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
    await expect(assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl })).rejects.toThrow(/D1 row not found/i);
  });

  it('fails when D1 row status is not success', async () => {
    const runner = makeFakeRunner(() => ({ stdout: makeD1Row({ status: 'failed:transient:timeout' }), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
    await expect(assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl })).rejects.toThrow(/status=failed:transient:timeout/i);
  });

  it('fails when byte probe returns unknown status', async () => {
    const runner = makeFakeRunner(() => ({ stdout: makeD1Row(), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 500, text: async () => 'server error' }));
    await expect(assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl })).rejects.toThrow(/byte probe returned unknown/i);
  });

  it('fails when sha256 on the D1 row does not match the expected sha', async () => {
    const wrongSha = 'e'.repeat(64);
    const runner = makeFakeRunner(() => ({ stdout: makeD1Row({ blob_sha256: wrongSha }), stderr: '', status: 0 }));
    const fetchImpl = makeFakeFetch(async () => ({ ok: false, status: 404, text: async () => '' }));
    await expect(assertD1AndBlossomState(KIND5, SHA, cfg, { runner, fetchImpl })).rejects.toThrow(/blob_sha256 mismatch/i);
  });
});
