# Creator-delete end-to-end test — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-run Node script that exercises the full creator-delete pipeline end-to-end (sync and cron paths) against real staging relay + prod Blossom + prod mod-service, with active cleanup that returns prod systems to their pre-run state.

**Architecture:** Single-file ESM script in `scripts/e2e-creator-delete.mjs` with injectable side effects (fetch, wrangler shell-out, Blossom notify) so vitest can drive pure and orchestrator-level tests without network. Reuses existing `nostr-tools` (already a dep) for keypair generation, event signing, and WebSocket publishing. Reuses `notifyBlossom` / NIP-98 signing patterns from the live pipeline where practical.

**Tech Stack:** Node 20+, vitest (Workers pool — `nodejs_compat` flag is on so `node:child_process` works), `wrangler` CLI, `nostr-tools` (`pure`, `relay`, `nip19`), `@noble/hashes/sha256`.

**Spec:** `docs/superpowers/specs/2026-04-18-creator-delete-e2e-test-design.md`
**Issue:** [divinevideo/divine-moderation-service#101](https://github.com/divinevideo/divine-moderation-service/issues/101)
**Branch:** `spec/creator-delete-e2e-test` (already created off `main`)

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/e2e-creator-delete.mjs` | new | Orchestrator. CLI, helpers, scenarios, main. ~500 lines. |
| `scripts/e2e-creator-delete.test.mjs` | new | Vitest unit tests for pure helpers + main() via injected deps. |
| `scripts/sign-nip98.mjs` | modify | Factor inline signing into an exported `signNip98Header(sk, url, method)` helper so the e2e script imports rather than duplicates. |

All impure operations live behind injectable functions so tests neither shell out nor hit the network.

---

## Task 1: Refactor sign-nip98.mjs to export a reusable helper

**Files:**
- Modify: `scripts/sign-nip98.mjs`
- Test: `scripts/sign-nip98.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `scripts/sign-nip98.test.mjs`:

```js
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the exported NIP-98 signing helper consumed by e2e and ad-hoc scripts.

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { signNip98Header } from './sign-nip98.mjs';

describe('signNip98Header', () => {
  it('returns a Nostr-scheme Authorization header with a base64-encoded signed kind-27235 event', () => {
    const sk = generateSecretKey();
    const header = signNip98Header(sk, 'https://example/api', 'POST');
    expect(header.startsWith('Nostr ')).toBe(true);
    const eventJson = Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8');
    const event = JSON.parse(eventJson);
    expect(event.kind).toBe(27235);
    expect(event.tags).toEqual(expect.arrayContaining([['u', 'https://example/api'], ['method', 'POST']]));
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(event)).toBe(true);
  });

  it('normalizes method to uppercase', () => {
    const sk = generateSecretKey();
    const header = signNip98Header(sk, 'https://example', 'get');
    const event = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'));
    expect(event.tags).toEqual(expect.arrayContaining([['method', 'GET']]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- scripts/sign-nip98.test.mjs`

Expected: FAIL — `signNip98Header` is not exported.

- [ ] **Step 3: Refactor the CLI script to export the helper**

Replace the body of `scripts/sign-nip98.mjs` with:

```js
#!/usr/bin/env node
// Sign a NIP-98 Authorization header for testing creator-delete endpoints.
// Usage (CLI): node scripts/sign-nip98.mjs --nsec <hex> --url <url> --method <POST|GET>
// Usage (import): import { signNip98Header } from './sign-nip98.mjs'

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils';

/**
 * Sign a NIP-98 Authorization header. Returns the full "Nostr <base64>" header value.
 * Importable from other scripts; see CLI entry point below for standalone use.
 */
export function signNip98Header(sk, url, method) {
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method.toUpperCase()]],
    content: ''
  }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

// CLI entrypoint — skipped when imported by tests.
const isMain = typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const nsecHex = getArg('nsec');
  const sk = nsecHex ? hexToBytes(nsecHex) : generateSecretKey();
  if (!nsecHex) {
    console.error(`No --nsec provided. Generated ephemeral key. Pubkey: ${getPublicKey(sk)}`);
  }

  const url = getArg('url');
  const method = (getArg('method') || 'POST').toUpperCase();

  if (!url) {
    console.error('Usage: node scripts/sign-nip98.mjs --nsec <hex> --url <url> [--method POST]');
    process.exit(1);
  }

  console.log(signNip98Header(sk, url, method));
  console.error(`Pubkey: ${getPublicKey(sk)}`);
  console.error(`URL: ${url}`);
  console.error(`Method: ${method}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/sign-nip98.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/sign-nip98.mjs scripts/sign-nip98.test.mjs
git commit -m "refactor(sign-nip98): export signNip98Header helper for reuse"
```

---

## Task 2: Scaffold the e2e script + parseArgs

**Files:**
- Create: `scripts/e2e-creator-delete.mjs`
- Create: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/e2e-creator-delete.test.mjs`:

```js
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the script with parseArgs**

Create `scripts/e2e-creator-delete.mjs`:

```js
#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: End-to-end test for the creator-delete pipeline (mod-service#101).
// ABOUTME: Operator-run. Exercises sync + cron paths against staging relay + prod Blossom + prod mod-service.

const DEFAULT_STAGING_RELAY = 'wss://relay.staging.divine.video';
const DEFAULT_FUNNELCAKE_API = 'https://funnelcake.staging.dvines.org';
const DEFAULT_BLOSSOM_BASE = 'https://media.divine.video';
const DEFAULT_MOD_SERVICE_BASE = 'https://moderation-api.divine.video';
const DEFAULT_D1_DATABASE = 'blossom-webhook-events';
const DEFAULT_CRON_WAIT_SECONDS = 180;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function getFlag(argv, name) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be positive integer)`);
  }
  return n;
}

export function parseArgs(argv) {
  const rawScenario = getFlag(argv, 'scenario');
  const scenario = rawScenario === null || rawScenario === true ? 'both' : rawScenario;
  if (!['sync', 'cron', 'both'].includes(scenario)) {
    throw new Error(`Invalid scenario: ${scenario} (must be sync|cron|both)`);
  }

  const rawCron = getFlag(argv, 'cron-wait-seconds');
  const cronWaitSeconds = rawCron
    ? validatePositiveInt(rawCron, 'cron-wait-seconds')
    : DEFAULT_CRON_WAIT_SECONDS;

  return {
    scenario,
    stagingRelay: getFlag(argv, 'staging-relay') || DEFAULT_STAGING_RELAY,
    funnelcakeApi: getFlag(argv, 'funnelcake-api') || DEFAULT_FUNNELCAKE_API,
    blossomBase: getFlag(argv, 'blossom-base') || DEFAULT_BLOSSOM_BASE,
    modServiceBase: getFlag(argv, 'mod-service-base') || DEFAULT_MOD_SERVICE_BASE,
    d1Database: getFlag(argv, 'd1-database') || DEFAULT_D1_DATABASE,
    cronWaitSeconds,
    skipCleanup: getFlag(argv, 'skip-cleanup') === true
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): scaffold creator-delete e2e script with parseArgs"
```

---

## Task 3: generateTestKey + generateSyntheticBlob

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
import { generateTestKey, generateSyntheticBlob } from './e2e-creator-delete.mjs';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, sha256 as sha256Hash } from '@noble/hashes/sha256';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

Append to `scripts/e2e-creator-delete.mjs`:

```js
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { sha256 as sha256Hash, bytesToHex } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

export function generateTestKey() {
  const sk = generateSecretKey();
  return { sk, pubkey: getPublicKey(sk) };
}

// Minimal ISO-BMFF ftyp box so the payload at least looks like MP4 to a casual
// inspector. 1024 bytes total: 32-byte header + 992 bytes of random payload so
// each run has a unique sha256.
export function generateSyntheticBlob() {
  const header = new Uint8Array([
    // box size (32 bytes)
    0x00, 0x00, 0x00, 0x20,
    // 'ftyp'
    0x66, 0x74, 0x79, 0x70,
    // major brand 'isom'
    0x69, 0x73, 0x6f, 0x6d,
    // minor version (0x00000200)
    0x00, 0x00, 0x02, 0x00,
    // compatible brands: 'isom', 'iso2', 'avc1', 'mp41'
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31,
    0x6d, 0x70, 0x34, 0x31
  ]);
  const payload = randomBytes(992);
  const bytes = new Uint8Array(1024);
  bytes.set(header, 0);
  bytes.set(payload, 32);
  const sha256 = bytesToHex(sha256Hash(bytes));
  return { bytes, sha256 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): generateTestKey + generateSyntheticBlob (1KB pseudo-mp4)"
```

---

## Task 4: buildKind34236Event (contract-grounded)

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `buildKind34236Event` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
import { finalizeEvent } from 'nostr-tools/pure';

/**
 * Build and sign a kind 34236 event that passes Funnelcake's validation at
 * divine-funnelcake/crates/relay/src/relay.rs:1023-1087.
 *
 * Required: d (unique), title, imeta with url+x+m (each space-delimited item
 * per validate_imeta_format), and a thumb-equivalent. Thumb URL does not need
 * to resolve.
 */
export function buildKind34236Event(sk, sha256, cfg) {
  const blobUrl = `${cfg.blossomBase}/${sha256}`;
  const thumbUrl = `${cfg.blossomBase}/${sha256}.jpg`;
  // Unique d tag per run: timestamp + random suffix ensures no collision across
  // concurrent or rapid-fire test runs with the same key (not our normal case
  // but cheap to defend against).
  const dTag = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return finalizeEvent({
    kind: 34236,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', dTag],
      ['title', 'creator-delete e2e test video'],
      ['imeta', `url ${blobUrl}`, `x ${sha256}`, `m video/mp4`],
      ['thumb', thumbUrl]
    ],
    content: 'Synthetic 1KB test blob published by scripts/e2e-creator-delete.mjs'
  }, sk);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): buildKind34236Event with Funnelcake-contract-grounded tags"
```

---

## Task 5: classifyByteProbeResponse

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `classifyByteProbeResponse` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
/**
 * Classify a GET https://media.divine.video/<sha256> response after the
 * pipeline has completed. 404/410 → bytes physically deleted (ENABLE_PHYSICAL_DELETE
 * was on). 200 → bytes still present (flag was off, soft-delete state). Both
 * are acceptable pass conditions for the script; the kind is recorded in the
 * JSONL output. Anything else is treated as an unexpected state.
 */
export function classifyByteProbeResponse(status) {
  if (status === 404 || status === 410) return { kind: 'bytes_gone', flagStateInferred: 'on' };
  if (status === 200) return { kind: 'bytes_present', flagStateInferred: 'off' };
  return { kind: 'unknown', status };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): classifyByteProbeResponse infers flag state from GET /<sha>"
```

---

## Task 6: Default runner + cleanupD1Row

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `cleanupD1Row` not exported.

- [ ] **Step 3: Implement the runner + cleanup**

Append to `scripts/e2e-creator-delete.mjs`:

```js
/**
 * Default runner used when the script runs as a CLI. Tests inject a fake.
 * Uses spawnSync (args is an array, not a string — no shell interpretation).
 * The node:child_process import is deferred via dynamic import() so the
 * Cloudflare Workers vitest pool does not try to resolve it at module-load
 * time (nodejs_compat does not expose child_process there).
 */
export async function defaultRunner({ command, args }) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? 0 };
}

function validateHex64(value, fieldName) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be 64-char lowercase hex)`);
  }
  return value;
}

export async function cleanupD1Row(kind5_id, target_event_id, cfg, runner = defaultRunner) {
  validateHex64(kind5_id, 'kind5_id');
  validateHex64(target_event_id, 'target_event_id');
  const sql = `DELETE FROM creator_deletions WHERE kind5_id = '${kind5_id}' AND target_event_id = '${target_event_id}';`;
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): defaultRunner + cleanupD1Row with hex validation"
```

---

## Task 7: cleanupBlossomVanish

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `cleanupBlossomVanish` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
/**
 * Fully purge the single blob owned by the test pubkey.
 *
 * Uses POST /admin/api/vanish (verified at divine-blossom/src/main.rs:209 →
 * handle_admin_vanish, src/main.rs:3975 → execute_vanish). For a fresh
 * ephemeral pubkey that owns exactly one blob, this is surgical: full GCS +
 * KV + VCL purge of the test blob and nothing else.
 *
 * Expects a successful vanish to return { vanished: true, fully_deleted, unlinked, errors }.
 * fully_deleted:0 is acceptable (pipeline may have already purged the blob).
 * errors > 0 indicates Blossom couldn't fully process; surface as failure.
 */
export async function cleanupBlossomVanish(testPubkey, cfg, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.blossomBase}/admin/api/vanish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.blossomWebhookSecret}`
    },
    body: JSON.stringify({ pubkey: testPubkey, reason: 'e2e-test cleanup' })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blossom vanish failed: HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  const out = {
    fullyDeleted: body.fully_deleted ?? 0,
    unlinked: body.unlinked ?? 0,
    errors: body.errors ?? 0
  };
  if (out.errors > 0) {
    throw new Error(`Blossom vanish reported errors:${out.errors} fully_deleted:${out.fullyDeleted} unlinked:${out.unlinked}`);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): cleanupBlossomVanish — full GCS+KV+VCL purge for test pubkey"
```

---

## Task 8: uploadToBlossom (BUD-02 with BUD-01 auth)

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

Note: BUD-02 upload endpoint is `PUT /upload` with `Authorization: Nostr <base64>` where the base64-decoded event is a signed kind 24242 "upload" authorization event (BUD-01). The existing `scripts/publish-test-video.mjs` does this; we replicate the pattern.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
/**
 * BUD-01 upload authorization. Signed kind 24242 event with:
 *   - t tag: "upload"
 *   - x tag: sha256 of the payload
 *   - expiration tag: unix timestamp (5 minutes from now)
 */
export function buildBud01UploadAuth(sk, sha256) {
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['x', sha256],
      ['expiration', String(expiration)]
    ],
    content: 'creator-delete e2e test upload'
  }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

export async function uploadToBlossom(bytes, sha256, sk, cfg, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.blossomBase}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: buildBud01UploadAuth(sk, sha256),
      'Content-Type': 'video/mp4',
      'Content-Length': String(bytes.length)
    },
    body: bytes
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blossom upload failed: HTTP ${res.status}: ${text}`);
  }
  const body = await res.json();
  return { url: body.url || `${cfg.blossomBase}/${sha256}`, sha256 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): uploadToBlossom (BUD-02 PUT with BUD-01 auth)"
```

---

## Task 9: WebSocket publishing + Funnelcake indexing poll

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

Note: the actual WebSocket work is side-effecting and awkward to unit-test without a fake. We expose `publishEvent` (low-level WS publish) with an injectable connection factory, plus `waitForIndexing` which is pure-ish (HTTP polling with an injectable fetch).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `waitForIndexing` not exported.

- [ ] **Step 3: Implement waitForIndexing + publish helpers**

Append to `scripts/e2e-creator-delete.mjs`:

```js
/**
 * Poll Funnelcake REST GET /api/event/{id} until 200 or timeout.
 * Catches ClickHouse batch-flush + MergeTree dedup propagation lag.
 */
export async function waitForIndexing(eventId, cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  const url = `${cfg.funnelcakeApi}/api/event/${eventId}`;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.ok) return { polls };
    if (res.status !== 404) {
      const text = await res.text();
      throw new Error(`Funnelcake /api/event/${eventId} HTTP ${res.status}: ${text}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms: event ${eventId} not indexed by Funnelcake`);
}

/**
 * Publish a signed Nostr event to a relay over WebSocket. Resolves with the
 * event id on OK=true; throws on relay rejection or timeout.
 *
 * The WebSocket lives only for the duration of the publish. The ws library
 * is imported dynamically so the Workers test pool doesn't trip on it at
 * module-load time.
 */
export async function publishEvent(event, relayUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const WsCtor = opts.WebSocket || (await import('ws')).WebSocket;
  return await new Promise((resolve, reject) => {
    const ws = new WsCtor(relayUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`publish timeout after ${timeoutMs}ms: ${event.id}`));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg[0] === 'OK' && msg[1] === event.id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg[2] === true) {
          resolve(event.id);
        } else {
          reject(new Error(`relay rejected ${event.id}: ${msg[3] || 'unknown'}`));
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err.message}`));
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): waitForIndexing (Funnelcake poll) + publishEvent (WS)"
```

---

## Task 10: callSyncEndpoint + pollStatus

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
import { signNip98Header } from './sign-nip98.mjs';

export async function callSyncEndpoint(sk, kind5Event, cfg, fetchImpl = fetch) {
  const url = `${cfg.modServiceBase}/api/creator-delete/sync`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: signNip98Header(sk, url, 'POST')
    },
    body: JSON.stringify(kind5Event)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sync endpoint HTTP ${res.status}: ${text}`);
  }
  return await res.json();
}

/**
 * Poll the status endpoint until the row reaches a terminal status
 * (success OR failed:*). Returns the final body so the caller can distinguish.
 *
 * Re-signs NIP-98 per poll so the signature stays fresh and the `u` tag always
 * matches the request URL exactly (see PR #104 URL-normalization fix).
 */
export async function pollStatus(sk, kind5Id, cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const url = `${cfg.modServiceBase}/api/creator-delete/status/${kind5Id}`;
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: signNip98Header(sk, url, 'GET') }
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`status endpoint HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.status === 'success' || (typeof body.status === 'string' && body.status.startsWith('failed:'))) {
      return { ...body, polls };
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timeout after ${timeoutMs}ms: kind5 ${kind5Id} did not reach terminal status. Common cause: CREATOR_DELETE_PIPELINE_ENABLED may be unset on the prod worker.`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): callSyncEndpoint + pollStatus (NIP-98 re-signed per poll)"
```

---

## Task 11: assertD1AndBlossomState

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `assertD1AndBlossomState` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
export async function assertD1AndBlossomState(kind5Id, expectedSha, cfg, deps = {}) {
  validateHex64(kind5Id, 'kind5_id');
  validateHex64(expectedSha, 'expectedSha');

  const runner = deps.runner || defaultRunner;
  const fetchImpl = deps.fetchImpl || fetch;

  // (a) D1 row check
  const sql = `SELECT kind5_id, target_event_id, blob_sha256, status FROM creator_deletions WHERE kind5_id = '${kind5Id}';`;
  const args = ['d1', 'execute', cfg.d1Database, '--remote', '--json', '--command', sql];
  const r = await runner({ command: 'wrangler', args });
  if (r.status !== 0) {
    throw new Error(`wrangler d1 execute failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const parsed = JSON.parse(r.stdout);
  const rows = (parsed?.[0]?.results) || [];
  if (rows.length === 0) {
    throw new Error(`D1 row not found for kind5_id=${kind5Id}`);
  }
  const row = rows[0];
  if (row.status !== 'success') {
    throw new Error(`expected D1 status='success', got status=${row.status}`);
  }
  if (row.blob_sha256 !== expectedSha) {
    throw new Error(`blob_sha256 mismatch: D1 has ${row.blob_sha256}, expected ${expectedSha}`);
  }

  // (b) Blossom byte probe
  const probe = await fetchImpl(`${cfg.blossomBase}/${expectedSha}`, { method: 'GET' });
  const byteProbe = classifyByteProbeResponse(probe.status);
  if (byteProbe.kind === 'unknown') {
    throw new Error(`Blossom byte probe returned unknown status: ${probe.status}`);
  }

  return { d1Status: row.status, byteProbe };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): assertD1AndBlossomState (D1 + byte probe)"
```

---

## Task 12: Scenario functions

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

Scenario functions glue the helpers into a pipeline. They are tested via injected deps for every side effect: `runner` (wrangler), `fetchImpl`, `publishImpl` (for WS), and `notifyImpl` (reserved for future).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
import { runSyncScenario, runCronScenario } from './e2e-creator-delete.mjs';

describe('runSyncScenario', () => {
  const cfg = { ...parseArgs([]), blossomWebhookSecret: 'test-secret' };

  function makeDeps({ uploadResult, publishEventIds, statusBody, d1Row, byteProbeStatus, vanishResult }) {
    const published = [];
    return {
      uploadToBlossom: async () => uploadResult,
      publishEvent: async (event) => {
        published.push(event);
        return publishEventIds.shift() || event.id;
      },
      waitForIndexing: async () => ({ polls: 1 }),
      callSyncEndpoint: async () => ({ accepted: true }),
      pollStatus: async () => statusBody,
      runner: makeFakeRunner((sql) => {
        if (sql.startsWith('SELECT')) {
          return { stdout: JSON.stringify([{ results: [d1Row], success: true, meta: {} }]), stderr: '', status: 0 };
        }
        if (sql.startsWith('DELETE')) {
          return { stdout: JSON.stringify([{ results: [], success: true, meta: {} }]), stderr: '', status: 0 };
        }
        throw new Error('unexpected sql: ' + sql.slice(0, 80));
      }),
      fetchImpl: makeFakeFetch(async ({ url }) => {
        if (url.endsWith('/admin/api/vanish')) {
          return { ok: true, status: 200, json: async () => vanishResult };
        }
        // byte probe
        return { ok: byteProbeStatus === 200, status: byteProbeStatus, text: async () => '' };
      }),
      published
    };
  }

  it('passes end-to-end with flag-on path (byte probe 404)', async () => {
    const SHA = 'a'.repeat(64);
    const deps = makeDeps({
      uploadResult: { sha256: SHA, url: `${cfg.blossomBase}/${SHA}` },
      publishEventIds: [],
      statusBody: { status: 'success', blob_sha256: SHA, polls: 4 },
      d1Row: { kind5_id: '', target_event_id: '', blob_sha256: SHA, status: 'success' },
      byteProbeStatus: 404,
      vanishResult: { vanished: true, fully_deleted: 1, unlinked: 0, errors: 0 }
    });
    const result = await runSyncScenario(cfg, deps);
    expect(result.outcome).toBe('pass');
    expect(result.cleanup.blossom.fullyDeleted).toBe(1);
    expect(result.cleanup.d1.ok).toBe(true);
  });

  it('fails when pollStatus returns a failed:* terminal, but cleanup still runs', async () => {
    const SHA = 'a'.repeat(64);
    const deps = makeDeps({
      uploadResult: { sha256: SHA, url: `${cfg.blossomBase}/${SHA}` },
      publishEventIds: [],
      statusBody: { status: 'failed:permanent:target_not_found' },
      d1Row: { kind5_id: '', target_event_id: '', blob_sha256: SHA, status: 'failed:permanent:target_not_found' },
      byteProbeStatus: 200,
      vanishResult: { vanished: true, fully_deleted: 1, unlinked: 0, errors: 0 }
    });
    const result = await runSyncScenario(cfg, deps);
    expect(result.outcome).toBe('fail');
    expect(result.cleanup.blossom.fullyDeleted).toBe(1);
  });

  it('skips cleanup when cfg.skipCleanup is true', async () => {
    const SHA = 'a'.repeat(64);
    const cfgNoCleanup = { ...cfg, skipCleanup: true };
    const deps = makeDeps({
      uploadResult: { sha256: SHA, url: `${cfg.blossomBase}/${SHA}` },
      publishEventIds: [],
      statusBody: { status: 'success', blob_sha256: SHA },
      d1Row: { kind5_id: '', target_event_id: '', blob_sha256: SHA, status: 'success' },
      byteProbeStatus: 404,
      vanishResult: { vanished: true, fully_deleted: 1, unlinked: 0, errors: 0 }
    });
    const result = await runSyncScenario(cfgNoCleanup, deps);
    expect(result.outcome).toBe('pass');
    expect(result.cleanup).toEqual({ skipped: true });
  });
});

describe('runCronScenario', () => {
  const cfg = { ...parseArgs([]), blossomWebhookSecret: 'test-secret' };

  it('does NOT call the sync endpoint; relies on pollStatus for cron-triggered D1 update', async () => {
    const SHA = 'a'.repeat(64);
    let syncCalls = 0;
    const deps = {
      uploadToBlossom: async () => ({ sha256: SHA, url: `${cfg.blossomBase}/${SHA}` }),
      publishEvent: async (event) => event.id,
      waitForIndexing: async () => ({ polls: 1 }),
      callSyncEndpoint: async () => { syncCalls++; return { accepted: true }; },
      pollStatus: async () => ({ status: 'success', blob_sha256: SHA }),
      runner: makeFakeRunner((sql) => {
        if (sql.startsWith('SELECT')) return { stdout: JSON.stringify([{ results: [{ kind5_id: '', target_event_id: '', blob_sha256: SHA, status: 'success' }], success: true, meta: {} }]), stderr: '', status: 0 };
        return { stdout: JSON.stringify([{ results: [], success: true, meta: {} }]), stderr: '', status: 0 };
      }),
      fetchImpl: makeFakeFetch(async ({ url }) => {
        if (url.endsWith('/admin/api/vanish')) return { ok: true, status: 200, json: async () => ({ vanished: true, fully_deleted: 1, unlinked: 0, errors: 0 }) };
        return { ok: false, status: 404, text: async () => '' };
      })
    };
    const result = await runCronScenario(cfg, deps);
    expect(syncCalls).toBe(0);
    expect(result.outcome).toBe('pass');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `runSyncScenario` / `runCronScenario` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
function nowIso() { return new Date().toISOString(); }

function emit(obj) { console.log(JSON.stringify(obj)); }

async function runScenario(name, cfg, deps, opts) {
  const { sk, pubkey } = (deps.generateTestKey || generateTestKey)();
  const blob = (deps.generateSyntheticBlob || generateSyntheticBlob)();
  const started = Date.now();
  let kind5Id = null;
  let target = null;
  let assertResult = null;
  let outcome = 'pass';
  let failureReason = null;

  try {
    // 1. Upload
    const upload = await (deps.uploadToBlossom || uploadToBlossom)(blob.bytes, blob.sha256, sk, cfg, deps.fetchImpl);
    emit({ ts: nowIso(), scenario: name, step: 'upload', ok: true, sha256: blob.sha256, bytes: blob.bytes.length });

    // 2. Publish kind 34236
    const event = buildKind34236Event(sk, blob.sha256, cfg);
    target = await (deps.publishEvent || publishEvent)(event, cfg.stagingRelay);
    emit({ ts: nowIso(), scenario: name, step: 'publish_kind34236', ok: true, event_id: target });

    // 3. Wait for Funnelcake to index it
    const indexing = await (deps.waitForIndexing || waitForIndexing)(target, cfg, { fetchImpl: deps.fetchImpl });
    emit({ ts: nowIso(), scenario: name, step: 'wait_indexing', ok: true, polls: indexing.polls });

    // 4. Publish kind 5
    const kind5Event = finalizeEvent({
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', target], ['k', '34236'], ['client', 'diVine']],
      content: 'e2e test delete'
    }, sk);
    kind5Id = await (deps.publishEvent || publishEvent)(kind5Event, cfg.stagingRelay);
    emit({ ts: nowIso(), scenario: name, step: 'publish_kind5', ok: true, kind5_id: kind5Id });

    // 5. Sync (sync scenario only)
    if (opts.callSync) {
      await (deps.callSyncEndpoint || callSyncEndpoint)(sk, kind5Event, cfg, deps.fetchImpl);
      emit({ ts: nowIso(), scenario: name, step: 'call_sync', ok: true });
    }

    // 6. Poll status
    const pollOpts = {
      fetchImpl: deps.fetchImpl,
      timeoutMs: opts.statusTimeoutMs,
      pollIntervalMs: opts.statusPollIntervalMs
    };
    const status = await (deps.pollStatus || pollStatus)(sk, kind5Id, cfg, pollOpts);
    emit({ ts: nowIso(), scenario: name, step: 'poll_status', ok: status.status === 'success', terminal_status: status.status, polls: status.polls });
    if (status.status !== 'success') {
      throw new Error(`pipeline failed: ${status.status}`);
    }

    // 7. Assert D1 + Blossom state
    assertResult = await (deps.assertD1AndBlossomState || assertD1AndBlossomState)(kind5Id, blob.sha256, cfg, { runner: deps.runner, fetchImpl: deps.fetchImpl });
    emit({ ts: nowIso(), scenario: name, step: 'assert_d1_and_blossom', ok: true, d1_status: assertResult.d1Status, byte_probe: assertResult.byteProbe.kind });
  } catch (err) {
    outcome = 'fail';
    failureReason = err.message;
    emit({ ts: nowIso(), scenario: name, step: 'failure', ok: false, error: err.message });
  }

  // 8. Cleanup (always, unless --skip-cleanup)
  let cleanup = null;
  if (cfg.skipCleanup) {
    cleanup = { skipped: true };
    emit({ ts: nowIso(), scenario: name, step: 'cleanup', ok: true, skipped: true });
  } else {
    cleanup = { blossom: null, d1: null };
    try {
      cleanup.blossom = await (deps.cleanupBlossomVanish || cleanupBlossomVanish)(pubkey, cfg, deps.fetchImpl);
      emit({ ts: nowIso(), scenario: name, step: 'cleanup_blossom', ok: true, ...cleanup.blossom });
    } catch (err) {
      cleanup.blossom = { ok: false, error: err.message };
      emit({ ts: nowIso(), scenario: name, step: 'cleanup_blossom', ok: false, error: err.message });
    }
    if (kind5Id && target) {
      try {
        await (deps.cleanupD1Row || cleanupD1Row)(kind5Id, target, cfg, deps.runner);
        cleanup.d1 = { ok: true };
        emit({ ts: nowIso(), scenario: name, step: 'cleanup_d1', ok: true });
      } catch (err) {
        cleanup.d1 = { ok: false, error: err.message };
        emit({ ts: nowIso(), scenario: name, step: 'cleanup_d1', ok: false, error: err.message });
      }
    } else {
      cleanup.d1 = { ok: true, skipped: 'no kind5/target' };
    }
  }

  const totalDurationMs = Date.now() - started;
  emit({ ts: nowIso(), scenario: name, outcome, total_duration_ms: totalDurationMs });
  return { outcome, failureReason, cleanup, pubkey, sha256: blob.sha256, kind5Id, target, totalDurationMs };
}

export async function runSyncScenario(cfg, deps = {}) {
  return runScenario('sync', cfg, deps, { callSync: true, statusTimeoutMs: 60000, statusPollIntervalMs: 2000 });
}

export async function runCronScenario(cfg, deps = {}) {
  return runScenario('cron', cfg, deps, { callSync: false, statusTimeoutMs: cfg.cronWaitSeconds * 1000, statusPollIntervalMs: 3000 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): runSyncScenario + runCronScenario (orchestrators with always-cleanup)"
```

---

## Task 13: printSummary + computeExitCode + main()

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`
- Modify: `scripts/e2e-creator-delete.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/e2e-creator-delete.test.mjs`:

```js
import { computeExitCode, main } from './e2e-creator-delete.mjs';

describe('computeExitCode', () => {
  it('0 when all scenarios pass and all cleanups ok', () => {
    expect(computeExitCode([
      { outcome: 'pass', cleanup: { blossom: { errors: 0 }, d1: { ok: true } } },
      { outcome: 'pass', cleanup: { blossom: { errors: 0 }, d1: { ok: true } } }
    ])).toBe(0);
  });

  it('1 when any scenario fails, regardless of cleanup', () => {
    expect(computeExitCode([
      { outcome: 'fail', cleanup: { blossom: { errors: 0 }, d1: { ok: true } } }
    ])).toBe(1);
  });

  it('3 when scenarios pass but a cleanup failed', () => {
    expect(computeExitCode([
      { outcome: 'pass', cleanup: { blossom: { errors: 0 }, d1: { ok: false, error: 'x' } } }
    ])).toBe(3);
  });

  it('1 (takes precedence) when a scenario fails AND cleanup failed', () => {
    expect(computeExitCode([
      { outcome: 'fail', cleanup: { blossom: { ok: false, error: 'x' }, d1: { ok: false, error: 'y' } } }
    ])).toBe(1);
  });

  it('0 when scenarios pass and cleanup was skipped', () => {
    expect(computeExitCode([
      { outcome: 'pass', cleanup: { skipped: true } }
    ])).toBe(0);
  });
});

describe('main (integration)', () => {
  const baseDeps = {
    uploadToBlossom: async () => ({ sha256: 'a'.repeat(64), url: 'u' }),
    publishEvent: async (event) => event.id,
    waitForIndexing: async () => ({ polls: 1 }),
    callSyncEndpoint: async () => ({ accepted: true }),
    pollStatus: async () => ({ status: 'success', blob_sha256: 'a'.repeat(64) }),
    assertD1AndBlossomState: async () => ({ d1Status: 'success', byteProbe: { kind: 'bytes_gone', flagStateInferred: 'on' } }),
    cleanupBlossomVanish: async () => ({ fullyDeleted: 1, unlinked: 0, errors: 0 }),
    cleanupD1Row: async () => {},
    blossomWebhookSecret: 'test-secret'
  };

  it('exits 0 on a passing both-scenarios run', async () => {
    const code = await main(['--scenario=both'], baseDeps);
    expect(code).toBe(0);
  });

  it('exits 1 when pollStatus reports failed:*', async () => {
    const deps = { ...baseDeps, pollStatus: async () => ({ status: 'failed:permanent:target_not_found' }) };
    const code = await main(['--scenario=sync'], deps);
    expect(code).toBe(1);
  });

  it('exits 2 on missing BLOSSOM_WEBHOOK_SECRET', async () => {
    const deps = { ...baseDeps, blossomWebhookSecret: null, env: {} };
    const code = await main(['--scenario=sync'], deps);
    expect(code).toBe(2);
  });

  it('exits 2 on invalid --scenario', async () => {
    const code = await main(['--scenario=invalid'], baseDeps);
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: FAIL — `main` / `computeExitCode` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/e2e-creator-delete.mjs`:

```js
export function computeExitCode(results) {
  const anyFailed = results.some(r => r.outcome === 'fail');
  if (anyFailed) return 1;
  const anyCleanupFailed = results.some(r => {
    if (r.cleanup?.skipped) return false;
    if (r.cleanup?.blossom?.ok === false) return true;
    if (r.cleanup?.blossom?.errors > 0) return true;
    if (r.cleanup?.d1?.ok === false) return true;
    return false;
  });
  if (anyCleanupFailed) return 3;
  return 0;
}

export function printSummary(results) {
  process.stderr.write('\n=== E2E SUMMARY ===\n');
  for (const r of results) {
    const seconds = (r.totalDurationMs / 1000).toFixed(1);
    const label = r.outcome.toUpperCase();
    const detail = r.outcome === 'fail' ? `  (${r.failureReason})` : '';
    process.stderr.write(`Scenario: ${r.scenario.padEnd(6)}${label}  ${seconds}s${detail}\n`);
  }

  const artifacts = results.filter(r => !r.cleanup?.skipped);
  if (artifacts.length > 0) {
    process.stderr.write('\n=== ARTIFACTS (cleaned) ===\n');
    for (const r of artifacts) {
      const blossom = r.cleanup?.blossom?.ok === false
        ? `vanish=FAILED:${r.cleanup.blossom.error}`
        : `vanish=fully_deleted:${r.cleanup.blossom?.fullyDeleted ?? '?'}`;
      const d1 = r.cleanup?.d1?.ok === false ? `d1=FAILED:${r.cleanup.d1.error}` : 'd1=cleaned';
      process.stderr.write(`sha=${r.sha256}  kind5=${r.kind5Id || '-'}  ${blossom}  ${d1}  (${r.scenario})\n`);
    }
  }

  const manual = results.filter(r => {
    if (r.cleanup?.skipped) return false;
    return r.cleanup?.blossom?.ok === false || r.cleanup?.d1?.ok === false;
  });
  process.stderr.write('\n=== MANUAL CLEANUP NEEDED ===\n');
  if (manual.length === 0) {
    process.stderr.write('(none)\n');
  } else {
    for (const r of manual) {
      if (r.cleanup?.blossom?.ok === false) {
        process.stderr.write(`sha=${r.sha256} pubkey=${r.pubkey} (${r.scenario})\n`);
        process.stderr.write(`  curl -X POST -H "Authorization: Bearer $BLOSSOM_WEBHOOK_SECRET" \\\n`);
        process.stderr.write(`       ${DEFAULT_BLOSSOM_BASE}/admin/api/vanish \\\n`);
        process.stderr.write(`       -d '{"pubkey":"${r.pubkey}","reason":"e2e-test manual cleanup"}'\n`);
      }
      if (r.cleanup?.d1?.ok === false) {
        process.stderr.write(`  wrangler d1 execute ${DEFAULT_D1_DATABASE} --remote \\\n`);
        process.stderr.write(`       --command "DELETE FROM creator_deletions WHERE kind5_id='${r.kind5Id}' AND target_event_id='${r.target}';"\n`);
      }
    }
  }

  const code = computeExitCode(results);
  process.stderr.write(`\nExit: ${code}\n`);
}

function readBlossomSecret(deps) {
  if (deps.blossomWebhookSecret) return deps.blossomWebhookSecret;
  const env = deps.env || (typeof process !== 'undefined' ? process.env : {});
  const s = env.BLOSSOM_WEBHOOK_SECRET;
  if (!s) throw new Error('BLOSSOM_WEBHOOK_SECRET env var is required');
  return s;
}

export async function main(argv, deps = {}) {
  let cfg;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`arg error: ${e.message}\n`);
    return 2;
  }

  try {
    cfg.blossomWebhookSecret = readBlossomSecret(deps);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }

  const results = [];
  if (cfg.scenario === 'sync' || cfg.scenario === 'both') {
    const r = await runSyncScenario(cfg, deps);
    results.push({ ...r, scenario: 'sync' });
  }
  if (cfg.scenario === 'cron' || cfg.scenario === 'both') {
    const r = await runCronScenario(cfg, deps);
    results.push({ ...r, scenario: 'cron' });
  }

  printSummary(results);
  return computeExitCode(results);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/e2e-creator-delete.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-creator-delete.mjs scripts/e2e-creator-delete.test.mjs
git commit -m "feat(e2e): main() + printSummary + computeExitCode"
```

---

## Task 14: CLI entrypoint + lint + full test

**Files:**
- Modify: `scripts/e2e-creator-delete.mjs`

- [ ] **Step 1: Add the CLI entrypoint**

Append to `scripts/e2e-creator-delete.mjs`:

```js
// CLI entrypoint — runs only when invoked directly (not when imported by tests).
const isMain = typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`unexpected error: ${err.stack || err.message}\n`);
      process.exit(99);
    }
  );
}
```

- [ ] **Step 2: Sanity check imports work**

Run:

```bash
node -e "import('./scripts/e2e-creator-delete.mjs').then(m => console.log(Object.keys(m).sort().join(',')))"
```

Expected output (order may vary): `assertD1AndBlossomState,buildBud01UploadAuth,buildKind34236Event,callSyncEndpoint,classifyByteProbeResponse,cleanupBlossomVanish,cleanupD1Row,computeExitCode,defaultRunner,generateSyntheticBlob,generateTestKey,main,parseArgs,pollStatus,printSummary,publishEvent,runCronScenario,runSyncScenario,uploadToBlossom,waitForIndexing`

- [ ] **Step 3: Sanity check CLI fails fast on missing env**

Run: `unset BLOSSOM_WEBHOOK_SECRET; node scripts/e2e-creator-delete.mjs --scenario=sync; echo "exit=$?"`

Expected: prints `BLOSSOM_WEBHOOK_SECRET env var is required` and `exit=2`.

- [ ] **Step 4: Sanity check --scenario validation**

Run: `BLOSSOM_WEBHOOK_SECRET=x node scripts/e2e-creator-delete.mjs --scenario=invalid; echo "exit=$?"`

Expected: prints `arg error: Invalid scenario: invalid (must be sync|cron|both)` and `exit=2`.

- [ ] **Step 5: Run lint**

Run: `npm run lint`

Expected: clean.

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: all tests green. ~40 new test cases added across `sign-nip98.test.mjs` + `e2e-creator-delete.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-creator-delete.mjs
git commit -m "feat(e2e): CLI entrypoint + pre-flight arg/env diagnostics"
```

---

## Task 15: Push branch + draft PR

**Files:** none (verification only)

- [ ] **Step 1: Push**

Run: `git push -u origin spec/creator-delete-e2e-test`

- [ ] **Step 2: Open draft PR**

Run:

```bash
gh pr create --draft --title "feat(e2e): creator-delete end-to-end test (mod-service#101)" --body "$(cat <<'EOF'
Closes #101.

Spec: docs/superpowers/specs/2026-04-18-creator-delete-e2e-test-design.md
Plan: docs/superpowers/plans/2026-04-20-creator-delete-e2e-test-plan.md

## Summary

Operator-run script that exercises the full creator-delete pipeline end-to-end:
- Uploads a synthetic 1KB blob to prod Blossom (BUD-02)
- Publishes kind 34236 to staging relay; polls Funnelcake until indexed
- Runs the sync scenario (kind 5 + sync endpoint call) and the cron scenario (kind 5 only) against the prod mod-service worker
- Asserts D1 `creator_deletions` row reached status='success' and Blossom returned either 404 (flag on, bytes gone) or 200 (flag off, soft-delete)
- Cleans up in a \`finally\`: \`/admin/api/vanish\` for the test pubkey (full GCS+KV+VCL purge for the one blob it owns) and a DELETE on the D1 row(s)
- Prints JSONL per step on stdout; summary + manual-cleanup instructions on stderr

Adopts the \`docs/superpowers/\` historical-framing policy from divine-blossom PR #91 as part of this branch.

## Test plan

- [x] ~40 unit tests for pure helpers + main() integration with injected deps
- [x] Lint clean
- [ ] Run the script against staging-relay + prod-blossom + prod-mod-service after merge, during rollout validation

## Notes for reviewers

- WebSocket publish uses \`ws\` (transitive dep via nostr-tools + wrangler). If resolution breaks on a future package bump, add \`ws\` to \`devDependencies\` explicitly.
- Contract grounding: \`buildKind34236Event\` tests are pinned to divine-funnelcake/crates/relay/src/relay.rs:1023-1087 (video tag validation rules). \`cleanupBlossomVanish\` response shape pinned to divine-blossom/src/main.rs:209,3975.
- The script does not pre-flight \`CREATOR_DELETE_PIPELINE_ENABLED\` on the prod worker; on polling timeout it surfaces a hint pointing at that flag as the most likely cause.
EOF
)"
```

- [ ] **Step 3: Check CI**

Run: `gh pr checks <PR-number>`

Expected: all checks pass.

---

## Task 16: Local smoke check (deferred until rollout window)

**Files:** none (operational verification)

This validates the script against real services. Deferred until the upstream creator-delete PRs (blossom #97, mod-service #106) land and a rollout window is scheduled.

- [ ] **Step 1: Export env**

```bash
export BLOSSOM_WEBHOOK_SECRET=<prod-webhook-secret>
wrangler whoami   # confirm prod CF account
```

- [ ] **Step 2: Dry run logic check** — run only the sync scenario with `--skip-cleanup` on a branch where the prod worker's flag is known-on:

```bash
node scripts/e2e-creator-delete.mjs --scenario=sync --skip-cleanup | tee /tmp/e2e-sync.jsonl
```

Expected: exit 0, `assert_d1_and_blossom` step ok, `byte_probe: "bytes_gone"`, artifacts visible in Blossom admin (pubkey owns one blob, status=Deleted). Operator manually runs the printed vanish + wrangler commands to clean up.

- [ ] **Step 3: Full run**

```bash
node scripts/e2e-creator-delete.mjs
```

Expected: both scenarios pass, summary shows cleaned artifacts and `(none)` under manual-cleanup, exit 0. Capture stdout JSONL + stderr summary to a worklog entry as evidence.

- [ ] **Step 4: Worklog entry**

Paste the stderr summary + the final ~10 lines of JSONL into `.context/worklog/YYYY-MM-DD.md` as evidence of a green e2e run.

---

## Self-review notes

**Spec coverage check:**

| Spec section | Implementing task |
|---|---|
| Ephemeral key generation | Task 3 (`generateTestKey`) |
| Synthetic 1KB blob generation | Task 3 (`generateSyntheticBlob`) |
| Kind 34236 event construction (Funnelcake contract) | Task 4 (`buildKind34236Event`) + contract tests |
| Flag-state inference via byte probe | Task 5 (`classifyByteProbeResponse`) |
| Wrangler D1 write for cleanup | Task 6 (`defaultRunner`, `cleanupD1Row`) |
| Blossom vanish cleanup | Task 7 (`cleanupBlossomVanish`) |
| Blossom upload (BUD-02 + BUD-01) | Task 8 (`uploadToBlossom`, `buildBud01UploadAuth`) |
| Funnelcake indexing poll | Task 9 (`waitForIndexing`) |
| WebSocket publish | Task 9 (`publishEvent`) |
| Mod-service sync endpoint call | Task 10 (`callSyncEndpoint`) |
| Mod-service status polling (re-signed NIP-98) | Task 10 (`pollStatus`) |
| D1 + Blossom post-pipeline assertions | Task 11 (`assertD1AndBlossomState`) |
| Sync scenario orchestration | Task 12 (`runSyncScenario`) |
| Cron scenario orchestration (180s default wait) | Task 12 (`runCronScenario`) |
| Per-step JSONL output | Task 12 (`emit` helper) |
| Summary + exit codes + manual-cleanup instructions | Task 13 (`printSummary`, `computeExitCode`) |
| CLI entrypoint + env validation | Task 14 |
| Lint + test + PR | Tasks 14-15 |
| Real-environment smoke check | Task 16 (deferred to rollout) |

All spec sections map to a task. The SIGINT drain described in the spec's error-handling table is intentionally left as "script exits on Ctrl-C, cleanup runs in scenario `finally` blocks to the extent Node runtime permits." No explicit SIGINT handler like sweep's double-Ctrl-C pattern — this script is short-lived enough that an operator Ctrl-C is rare and the finally blocks are sufficient. If ops runs into this, add a handler in a follow-up.

**Placeholder scan:** no TBD/TODO in any task. Every step has exact code or exact commands.

**Type consistency check:**

- `generateTestKey` returns `{sk, pubkey}` — used as `{sk}` or `{sk, pubkey}` consistently in Tasks 4, 5, 7, 8, 10, 11, 12.
- `generateSyntheticBlob` returns `{bytes, sha256}` — used with that shape in Task 8, 12.
- `classifyByteProbeResponse` returns `{kind, flagStateInferred}` or `{kind: 'unknown', status}` — consumed in Task 11 (assert) and Task 12 (JSONL emit).
- `cleanupBlossomVanish` returns `{fullyDeleted, unlinked, errors}` — consumed by `runScenario` cleanup block and `printSummary`.
- `runSyncScenario` / `runCronScenario` return `{outcome, failureReason, cleanup, pubkey, sha256, kind5Id, target, totalDurationMs}` — consumed by `computeExitCode` and `printSummary`. `runScenario` also sets `scenario` downstream in `main()`.
- `runner` signature `{command, args} → {stdout, stderr, status}` — consistent between `defaultRunner`, `cleanupD1Row`, and `assertD1AndBlossomState`.
- `fetchImpl` signature mirrors `fetch` — consistent across Tasks 7, 8, 10, 11, 12.

**SIGINT:** deliberately omitted. See above.

**Known risks:** `ws` as transitive dep (noted in PR description); prod-worker flag pre-flight not possible without a new endpoint (accepted trade-off from brainstorming).
