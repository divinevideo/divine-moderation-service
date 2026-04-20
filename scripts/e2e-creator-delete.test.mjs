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
