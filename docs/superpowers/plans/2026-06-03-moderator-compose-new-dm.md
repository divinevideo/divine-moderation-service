# Moderator-initiated DM compose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a moderator start a brand-new DM from the Messages inbox by addressing a recipient via pasted npub/hex or a verified nip-05, optionally pre-filling an existing template, with new/empty threads rendering cleanly.

**Architecture:** All recipient resolution happens **server-side** in one new endpoint (`GET /admin/api/recipient/resolve`). It decodes a bare hex pubkey or an `npub` deterministically (reusing the worker's existing `nostr-tools`, so no new dependency and no browser bech32 lib), and resolves a `user@domain` nip-05 against the domain's `.well-known/nostr.json` for an authoritative pubkey. The send path, NIP-17 wrapping, relay discovery, and `dm_log` storage are unchanged. Templates reuse the existing `dm-sender.mjs` functions, exposed for manual selection. One bugfix: the thread GET returns `200 {messages:[]}` instead of `404` for never-messaged users.

> **Deviation from spec (intentional):** the design doc described decoding npub/hex client-side "with no network call." `messages.html` has no client-side nostr-tools/bech32 library and the design forbids new dependencies, so npub/hex decode is done server-side in the same resolve endpoint as nip-05. User-facing behavior is identical (deterministic decode for keys, verification for nip-05); only the decode location moved.

**Tech Stack:** Cloudflare Workers (ESM `.mjs`), `nostr-tools` (`nip19` for npub decode), Vitest, Cloudflare KV (`MODERATION_KV`), static admin HTML with inline JS.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/nostr/nip05.mjs` | **New.** `parseNip05()` + `resolveNip05()` — verify a `user@domain` against `.well-known/nostr.json`, KV-cached. |
| `src/nostr/nip05.test.mjs` | **New.** Unit tests for the resolver (mocked `fetch` + mock KV). |
| `src/nostr/dm-sender.mjs` | **Modify.** Add `COMPOSE_TEMPLATES` + `renderComposeTemplate()`, reusing existing `TEMPLATES`/`selectTemplate`. |
| `src/nostr/dm-sender.test.mjs` | **Modify.** Add tests for the two new exports. |
| `src/index.mjs` | **Modify.** Import `nip19.decode`; add `GET /admin/api/recipient/resolve`; add `GET /admin/api/dm-templates`; change empty-thread `GET /admin/api/messages/{pubkey}` from 404 to `200 {messages:[]}`. |
| `src/index.test.mjs` | **Modify.** Add route tests for the two new endpoints + the 404→200 change. |
| `src/admin/messages.html` | **Modify.** "New Message" button, recipient bar (calls resolve endpoint), confirmation line, template dropdown, friendlier empty-thread copy. |
| `src/admin/messages-ui.test.mjs` | **New.** `toContain` assertions for the new UI hooks (mirrors `swipe-review-ui.test.mjs`). |

Shared test fixtures used below:
- `RECIPIENT_HEX = '00000000000000000000000000000000000000000000000000000000000000ab'`
- `RECIPIENT_NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz4s0z660k'` (decodes to `RECIPIENT_HEX`)

---

## Task 1: nip-05 resolver module

**Files:**
- Create: `src/nostr/nip05.mjs`
- Test: `src/nostr/nip05.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/nostr/nip05.test.mjs`:

```js
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for resolveNip05 / parseNip05 — well-known verification + KV cache.
// ABOUTME: Mocks global fetch; no real network.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseNip05, resolveNip05 } from './nip05.mjs';
import { createMockKV } from '../test/helpers.mjs';

const HEX = '00000000000000000000000000000000000000000000000000000000000000ab';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseNip05', () => {
  it('splits a valid address', () => {
    expect(parseNip05('alice@divine.video')).toEqual({ name: 'alice', domain: 'divine.video' });
  });
  it('rejects input without @', () => {
    expect(parseNip05('alice')).toBeNull();
  });
  it('rejects bad local-part chars', () => {
    expect(parseNip05('al ice@divine.video')).toBeNull();
  });
  it('rejects non-string', () => {
    expect(parseNip05(null)).toBeNull();
  });
});

describe('resolveNip05', () => {
  it('returns the authoritative pubkey when names[name] is valid hex', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ names: { alice: HEX } }),
    }));
    const env = { MODERATION_KV: createMockKV() };
    const result = await resolveNip05('alice@divine.video', env);
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video' });
    expect(fetch).toHaveBeenCalledWith(
      'https://divine.video/.well-known/nostr.json?name=alice',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('returns null when the name is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: {} }) }));
    const result = await resolveNip05('ghost@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
  });

  it('returns null on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
  });

  it('returns null for malformed address and never fetches', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await resolveNip05('not-an-address', { MODERATION_KV: createMockKV() });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves a cached positive result without fetching again', async () => {
    const kv = createMockKV({ 'nip05:alice@divine.video': JSON.stringify({ pubkey: HEX }) });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await resolveNip05('alice@divine.video', { MODERATION_KV: kv });
    expect(result).toEqual({ pubkey: HEX, address: 'alice@divine.video', domain: 'divine.video' });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/nostr/nip05.test.mjs`
Expected: FAIL — `Failed to resolve import "./nip05.mjs"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/nostr/nip05.mjs`:

```js
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Resolves a nip-05 "user@domain" to an authoritative hex pubkey via the
// ABOUTME: domain's .well-known/nostr.json. KV-cached (1h). null on any failure.

const NIP05_CACHE_TTL = 3600; // 1 hour
const FETCH_TIMEOUT_MS = 5000;

const LOCAL_PART_RE = /^[a-z0-9._-]+$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Parse "user@domain" into { name, domain } or null if malformed.
 * @param {string} address
 * @returns {{name: string, domain: string} | null}
 */
export function parseNip05(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const name = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!LOCAL_PART_RE.test(name) || !DOMAIN_RE.test(domain)) return null;
  return { name, domain };
}

/**
 * Resolve a nip-05 address to an authoritative hex pubkey.
 * Returns { pubkey, address, domain } or null.
 * @param {string} address - "user@domain"
 * @param {Object} env - Cloudflare env (uses MODERATION_KV for caching)
 */
export async function resolveNip05(address, env) {
  const parsed = parseNip05(address);
  if (!parsed) return null;
  const { name, domain } = parsed;
  const canonical = `${name}@${domain}`;
  const cacheKey = `nip05:${canonical.toLowerCase()}`;

  if (env?.MODERATION_KV) {
    try {
      const cached = await env.MODERATION_KV.get(cacheKey);
      if (cached !== null) {
        const { pubkey } = JSON.parse(cached);
        return pubkey ? { pubkey, address: canonical, domain } : null;
      }
    } catch { /* ignore cache read errors */ }
  }

  let pubkey = null;
  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const json = await res.json();
      const found = json?.names?.[name];
      if (typeof found === 'string' && HEX64_RE.test(found)) {
        pubkey = found.toLowerCase();
      }
    }
  } catch (err) {
    console.error('[NIP05] resolve failed:', err.message);
  }

  if (env?.MODERATION_KV) {
    try {
      await env.MODERATION_KV.put(cacheKey, JSON.stringify({ pubkey: pubkey || null }), {
        expirationTtl: NIP05_CACHE_TTL,
      });
    } catch { /* ignore cache write errors */ }
  }

  return pubkey ? { pubkey, address: canonical, domain } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/nostr/nip05.test.mjs`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/nostr/nip05.mjs src/nostr/nip05.test.mjs
git commit -m "feat(dm): add verified nip-05 resolver (.well-known/nostr.json)"
```

---

## Task 2: Recipient resolve endpoint

**Files:**
- Modify: `src/index.mjs` (add import near line 17; add route alongside the other `/admin/api/messages` routes, ~line 3490)
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.mjs` (inside the top-level `describe`, after an existing block). Reuse the file's local `createEnv`; bypass auth with `ALLOW_DEV_ACCESS: 'true'`:

```js
describe('GET /admin/api/recipient/resolve', () => {
  const HEX = '00000000000000000000000000000000000000000000000000000000000000ab';
  const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqz4s0z660k';

  it('resolves a bare hex pubkey', async () => {
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve?input=' + HEX),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pubkey: HEX, source: 'hex' });
  });

  it('decodes an npub', async () => {
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve?input=' + NPUB),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pubkey: HEX, source: 'npub' });
  });

  it('400s an invalid npub', async () => {
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve?input=npub1notreal'),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(400);
  });

  it('verifies a nip-05 via well-known', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: { alice: HEX } }) }));
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve?input=alice@divine.video'),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pubkey: HEX, source: 'nip05', address: 'alice@divine.video' });
    vi.unstubAllGlobals();
  });

  it('404s an unknown nip-05', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ names: {} }) }));
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve?input=ghost@divine.video'),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(404);
    vi.unstubAllGlobals();
  });

  it('400s empty input', async () => {
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/recipient/resolve'),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(400);
  });
});
```

Ensure `vi` is imported at the top of `src/index.test.mjs` (it imports from `vitest`; add `vi` to the import list if absent).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs -t "recipient/resolve"`
Expected: FAIL — hex case returns 404 (route not found) instead of 200.

- [ ] **Step 3a: Add the nip19 import**

In `src/index.mjs`, near the existing `import { getPublicKey } from 'nostr-tools/pure';` (line 17), add:

```js
import { decode as decodeNip19 } from 'nostr-tools/nip19';
```

- [ ] **Step 3b: Add the route**

In `src/index.mjs`, immediately after the `POST /admin/api/messages/{pubkey}` route block (the one that calls `sendModeratorReply`, ~line 3493), add:

```js
    // Admin API: Resolve a recipient (hex / npub / verified nip-05) to a hex pubkey.
    // Display-name lookup is intentionally NOT supported — see
    // docs/superpowers/specs/2026-06-03-moderator-compose-new-dm-design.md (Non-goals).
    if (url.pathname === '/admin/api/recipient/resolve' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const input = (url.searchParams.get('input') || '').trim();
      if (!input) {
        return new Response(JSON.stringify({ error: 'input is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      // 1. Bare hex pubkey
      if (/^[0-9a-f]{64}$/i.test(input)) {
        return new Response(JSON.stringify({ pubkey: input.toLowerCase(), source: 'hex' }), { headers: { 'Content-Type': 'application/json' } });
      }
      // 2. npub (deterministic decode)
      if (input.startsWith('npub1')) {
        try {
          const decoded = decodeNip19(input);
          if (decoded.type === 'npub' && typeof decoded.data === 'string') {
            return new Response(JSON.stringify({ pubkey: decoded.data, source: 'npub' }), { headers: { 'Content-Type': 'application/json' } });
          }
        } catch { /* fall through to 400 */ }
        return new Response(JSON.stringify({ error: 'invalid npub' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      // 3. nip-05 (verified against the domain's well-known)
      if (input.includes('@')) {
        const { resolveNip05 } = await import('./nostr/nip05.mjs');
        const resolved = await resolveNip05(input, env);
        if (!resolved) {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ pubkey: resolved.pubkey, address: resolved.address, domain: resolved.domain, source: 'nip05' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'invalid input' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs -t "recipient/resolve"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat(dm): add /admin/api/recipient/resolve (hex/npub/verified nip-05)"
```

---

## Task 3: Compose templates (reuse existing templates)

**Files:**
- Modify: `src/nostr/dm-sender.mjs` (add exports after `getReportOutcomeMessage`, ~line 188)
- Test: `src/nostr/dm-sender.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `src/nostr/dm-sender.test.mjs`:

```js
import { COMPOSE_TEMPLATES, renderComposeTemplate } from './dm-sender.mjs';

describe('COMPOSE_TEMPLATES / renderComposeTemplate', () => {
  it('exposes the four creator-facing templates and excludes report-outcome', () => {
    const keys = COMPOSE_TEMPLATES.map(t => t.key);
    expect(keys).toEqual(['PERMANENT_BAN', 'AGE_RESTRICTED', 'QUARANTINE', 'ACCOUNT_SUSPENDED']);
    expect(keys).not.toContain('REPORT_OUTCOME_ACTION');
    COMPOSE_TEMPLATES.forEach(t => expect(typeof t.label).toBe('string'));
  });

  it('renders without a video (null-safe) using the generic subject', () => {
    const body = renderComposeTemplate('PERMANENT_BAN');
    expect(body).toContain('Your content');
    expect(body).not.toContain('divine.video/video/'); // no content link when sha256 is null
  });

  it('renders ACCOUNT_SUSPENDED with no args', () => {
    const body = renderComposeTemplate('ACCOUNT_SUSPENDED');
    expect(body).toContain('account has been suspended');
  });

  it('category specialization matches selectTemplate output', () => {
    const sha = '11'.repeat(32);
    expect(renderComposeTemplate('PERMANENT_BAN', { category: 'nudity', sha256: sha }))
      .toBe(selectTemplate('PERMANENT_BAN', null, 'nudity', sha));
  });

  it('returns null for an unknown key', () => {
    expect(renderComposeTemplate('NOPE')).toBeNull();
  });
});
```

If `selectTemplate` is not already imported in this test file, add it to the existing `import { ... } from './dm-sender.mjs';` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/nostr/dm-sender.test.mjs -t "COMPOSE_TEMPLATES"`
Expected: FAIL — `COMPOSE_TEMPLATES`/`renderComposeTemplate` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/nostr/dm-sender.mjs`, after `getReportOutcomeMessage` (~line 188), add:

```js
// --- Manual compose templates ---
// Creator-facing templates a moderator may pre-fill when composing by hand.
// Excludes REPORT_OUTCOME_* (reporter-facing auto-sends with a different signature).
// Single source of truth: these reuse TEMPLATES/selectTemplate verbatim.
export const COMPOSE_TEMPLATES = [
  { key: 'PERMANENT_BAN', label: 'Content removed' },
  { key: 'AGE_RESTRICTED', label: 'Content age-restricted' },
  { key: 'QUARANTINE', label: 'Content under review' },
  { key: 'ACCOUNT_SUSPENDED', label: 'Account suspended' },
];

/**
 * Render a compose template to editable text. Null-safe for compose with no video.
 * @param {string} key - one of COMPOSE_TEMPLATES[].key
 * @param {{category?: string|null, sha256?: string|null, title?: string|null, publishedAt?: string|null}} [opts]
 * @returns {string|null} rendered body, or null for an unknown key
 */
export function renderComposeTemplate(key, opts = {}) {
  const { category = null, sha256 = null, title = null, publishedAt = null } = opts;
  if (!TEMPLATES[key]) return null;
  return selectTemplate(key, null, category, sha256, title, publishedAt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/nostr/dm-sender.test.mjs -t "COMPOSE_TEMPLATES"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/nostr/dm-sender.mjs src/nostr/dm-sender.test.mjs
git commit -m "feat(dm): expose creator-facing templates for manual compose"
```

---

## Task 4: dm-templates endpoint

**Files:**
- Modify: `src/index.mjs` (add route after the recipient/resolve route)
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.mjs`:

```js
describe('GET /admin/api/dm-templates', () => {
  it('returns the creator-facing templates with rendered bodies', async () => {
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/dm-templates'),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(200);
    const templates = await res.json();
    expect(templates.map(t => t.key)).toEqual(['PERMANENT_BAN', 'AGE_RESTRICTED', 'QUARANTINE', 'ACCOUNT_SUSPENDED']);
    templates.forEach(t => {
      expect(typeof t.label).toBe('string');
      expect(typeof t.body).toBe('string');
      expect(t.body.length).toBeGreaterThan(0);
    });
  });

  it('threads video context into the body when sha256 is given', async () => {
    const sha = '22'.repeat(32);
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/dm-templates?sha256=' + sha),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    const templates = await res.json();
    const ban = templates.find(t => t.key === 'PERMANENT_BAN');
    expect(ban.body).toContain('divine.video/video/' + sha);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs -t "dm-templates"`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Write minimal implementation**

In `src/index.mjs`, immediately after the `recipient/resolve` route block, add:

```js
    // Admin API: List creator-facing DM templates (rendered, optionally with video context).
    if (url.pathname === '/admin/api/dm-templates' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) return authError;

      const sha256 = url.searchParams.get('sha256') || null;
      const title = url.searchParams.get('title') || null;
      const publishedAt = url.searchParams.get('publishedAt') || null;
      const category = url.searchParams.get('category') || null;
      const { COMPOSE_TEMPLATES, renderComposeTemplate } = await import('./nostr/dm-sender.mjs');
      const templates = COMPOSE_TEMPLATES.map(t => ({
        key: t.key,
        label: t.label,
        body: renderComposeTemplate(t.key, { category, sha256, title, publishedAt }),
      }));
      return new Response(JSON.stringify(templates), { headers: { 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs -t "dm-templates"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "feat(dm): add /admin/api/dm-templates endpoint"
```

---

## Task 5: Empty-thread 404 → 200 fix

**Files:**
- Modify: `src/index.mjs` (the `GET /admin/api/messages/{pubkey}` block, ~line 3467-3477)
- Test: `src/index.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.mjs`. `createDbMock()` (already defined in the file) returns no conversation for an arbitrary pubkey, so `getConversationByPubkey` yields null:

```js
describe('GET /admin/api/messages/{pubkey} for an unknown pubkey', () => {
  it('returns 200 with an empty messages array (not 404)', async () => {
    const HEX = '00000000000000000000000000000000000000000000000000000000000000ab';
    const res = await worker.fetch(
      new Request('https://moderation.admin.divine.video/admin/api/messages/' + HEX),
      createEnv({ ALLOW_DEV_ACCESS: 'true' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index.test.mjs -t "unknown pubkey"`
Expected: FAIL — currently returns 404 `{error:'No conversation found'}`.

- [ ] **Step 3: Write minimal implementation**

In `src/index.mjs`, in the `GET /admin/api/messages/{pubkey}` block, replace:

```js
      if (!messages) {
        return new Response(JSON.stringify({ error: 'No conversation found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
```

with:

```js
      if (!messages) {
        // Never-messaged recipient: return an empty thread (200) so the compose UI
        // can render for new conversations instead of showing a load error.
        return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index.test.mjs -t "unknown pubkey"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs src/index.test.mjs
git commit -m "fix(dm): return empty thread (200) for never-messaged recipients"
```

---

## Task 6: Messages UI — New Message, recipient bar, templates, empty copy

**Files:**
- Modify: `src/admin/messages.html`
- Test: `src/admin/messages-ui.test.mjs` (new)

This task is split into small steps. The inline JS reuses the existing `selectConversation(pubkey)`, `profileCache`, and `escapeHtml`. Manual validation at the end covers behavior that the string-level UI test cannot.

- [ ] **Step 1: Write the failing UI test**

Create `src/admin/messages-ui.test.mjs` (mirrors `swipe-review-ui.test.mjs`):

```js
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import messagesHTML from './messages.html';

describe('messages UI — new message compose hooks', () => {
  it('has a New Message button and recipient bar', () => {
    expect(messagesHTML).toContain('New Message');
    expect(messagesHTML).toContain('openNewMessage');
    expect(messagesHTML).toContain('recipient-input');
    expect(messagesHTML).toContain('resolveRecipient');
  });

  it('calls the recipient resolve endpoint', () => {
    expect(messagesHTML).toContain('/admin/api/recipient/resolve?input=');
  });

  it('has a template picker wired to the templates endpoint', () => {
    expect(messagesHTML).toContain('template-select');
    expect(messagesHTML).toContain('/admin/api/dm-templates');
    expect(messagesHTML).toContain('loadTemplates');
  });

  it('uses the friendlier empty-thread copy', () => {
    expect(messagesHTML).toContain('No messages yet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/messages-ui.test.mjs`
Expected: FAIL — none of the strings exist yet.

- [ ] **Step 3: Add the "New Message" button + recipient bar markup**

In `src/admin/messages.html`, replace the header-actions block:

```html
    <div class="header-actions">
      <a href="/admin/dashboard">Back to Dashboard</a>
      <button class="btn-primary" onclick="refreshAll()">Refresh</button>
    </div>
```

with:

```html
    <div class="header-actions">
      <a href="/admin/dashboard">Back to Dashboard</a>
      <button class="btn-primary" onclick="openNewMessage()">New Message</button>
      <button class="btn-primary" onclick="refreshAll()">Refresh</button>
    </div>
```

Then add a recipient bar just inside the thread panel — replace:

```html
      <div class="empty-state" id="thread-placeholder">
        Select a conversation to view messages
      </div>
```

with:

```html
      <div class="empty-state" id="thread-placeholder">
        Select a conversation, or start a New Message
      </div>
      <div id="new-recipient-bar" style="display:none; padding:12px; border-bottom:1px solid #333;">
        <input type="text" id="recipient-input" placeholder="npub, hex pubkey, or user@domain (nip-05)"
          style="width:60%;" onkeydown="if(event.key==='Enter'){event.preventDefault();resolveRecipient();}">
        <button class="btn-primary" onclick="resolveRecipient()">Start</button>
        <span id="recipient-status" style="margin-left:10px; font-size:13px;"></span>
      </div>
```

- [ ] **Step 4: Add the template picker markup**

In `src/admin/messages.html`, in the `compose-extras` block, replace:

```html
          <div class="compose-extras">
            <label>Link video:</label>
            <input type="text" id="compose-sha256" placeholder="sha256 (optional)">
          </div>
```

with:

```html
          <div class="compose-extras">
            <label>Template:</label>
            <select id="template-select" onchange="applyTemplate(this.value)">
              <option value="">— none —</option>
            </select>
            <label>Link video:</label>
            <input type="text" id="compose-sha256" placeholder="sha256 (optional)">
          </div>
```

- [ ] **Step 5: Add the JS — New Message flow, recipient resolution, templates**

In `src/admin/messages.html`, inside the `<script>` block (after the existing `selectConversation` function), add:

```js
    // --- New Message compose ---

    function openNewMessage() {
      const bar = document.getElementById('new-recipient-bar');
      bar.style.display = 'block';
      document.getElementById('recipient-status').textContent = '';
      const input = document.getElementById('recipient-input');
      input.value = '';
      input.focus();
    }

    async function resolveRecipient() {
      const input = document.getElementById('recipient-input').value.trim();
      const status = document.getElementById('recipient-status');
      if (!input) return;
      status.style.color = '#888';
      status.textContent = 'Resolving…';
      try {
        const res = await fetch('/admin/api/recipient/resolve?input=' + encodeURIComponent(input));
        if (!res.ok) {
          status.style.color = '#e66';
          status.textContent = res.status === 404
            ? "Couldn't verify that nip-05. If you have their npub or pubkey, paste it instead."
            : 'Invalid recipient. Paste an npub, hex pubkey, or user@domain.';
          return;
        }
        const data = await res.json();
        const label = data.source === 'nip05'
          ? '✓ ' + escapeHtml(data.address) + ' (verified via ' + escapeHtml(data.domain) + ')'
          : '✓ ' + truncatePubkey(data.pubkey);
        status.style.color = '#6c6';
        status.innerHTML = label;
        document.getElementById('new-recipient-bar').style.display = 'none';
        await fetchProfiles([data.pubkey]);
        await selectConversation(data.pubkey);
      } catch (err) {
        status.style.color = '#e66';
        status.textContent = 'Resolution failed. Try again.';
        console.error('resolveRecipient error:', err);
      }
    }

    // --- Templates ---

    let templateCache = [];

    async function loadTemplates() {
      const sha = document.getElementById('compose-sha256')?.value?.trim();
      const qs = sha ? '?sha256=' + encodeURIComponent(sha) : '';
      try {
        const res = await fetch('/admin/api/dm-templates' + qs);
        if (!res.ok) return;
        templateCache = await res.json();
        const select = document.getElementById('template-select');
        select.innerHTML = '<option value="">— none —</option>'
          + templateCache.map((t, i) => '<option value="' + i + '">' + escapeHtml(t.label) + '</option>').join('');
      } catch (err) {
        console.error('loadTemplates error:', err);
      }
    }

    function applyTemplate(index) {
      if (index === '') return;
      const tpl = templateCache[Number(index)];
      if (tpl && tpl.body) {
        document.getElementById('compose-input').value = tpl.body;
      }
    }
```

- [ ] **Step 6: Call loadTemplates at init and fix the empty-thread copy**

In `src/admin/messages.html`, in the `init()` function (near the bottom, where `fetchConversations()` and the `preselectedPubkey` handling live), add a `loadTemplates();` call. For example change:

```js
      async function init() {
        await fetchConversations();
        if (preselectedPubkey) {
```

to:

```js
      async function init() {
        await fetchConversations();
        loadTemplates();
        if (preselectedPubkey) {
```

(If the init structure differs, just ensure `loadTemplates()` runs once on load.)

Then update the empty-thread copy in `renderThread()` — replace:

```js
        el.textContent = 'No messages in this conversation';
```

with:

```js
        el.textContent = 'No messages yet — start the conversation';
```

- [ ] **Step 7: Run the UI test to verify it passes**

Run: `npx vitest run src/admin/messages-ui.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 8: Manual validation (wrangler dev)**

```bash
ALLOW_DEV_ACCESS=true npm run dev
```

Open `http://localhost:8787/admin/messages` and verify:
- "New Message" button reveals the recipient bar.
- Paste the test hex `00000000000000000000000000000000000000000000000000000000000000ab` → shows ✓ + opens an empty thread with "No messages yet — start the conversation"; compose box is usable.
- Paste an invalid string (e.g. `nope`) → red error pointing to npub/pubkey.
- Type a known good nip-05 (e.g. a real `user@divine.video`) → ✓ verified line; an unknown one → the "Couldn't verify…" message.
- Template dropdown lists the four templates; selecting one fills the compose box with editable text; "— none —" leaves it as-is.
- Sending to a freshly-resolved recipient posts and the message appears in the thread.

- [ ] **Step 9: Commit**

```bash
git add src/admin/messages.html src/admin/messages-ui.test.mjs
git commit -m "feat(dm): New Message compose with verified recipient + template picker"
```

---

## Task 7: Full suite + lint

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (including the new files).

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: clean. Fix any issues the linter flags in the changed files only.

- [ ] **Step 3: Commit any lint fixes (if needed)**

```bash
git add -A
git commit -m "chore(dm): lint fixes for compose feature"
```

---

## Self-Review notes

- **Spec coverage:** recipient picker (Tasks 1-2), templates reuse (Tasks 3-4), 404→200 fix (Task 5), UI incl. context deep-links preserved + friendly empty state (Task 6). Attribution/non-goals are documentation, already in the committed spec.
- **No display-name search:** enforced by design — the only resolve paths are hex, npub, and verified nip-05. A code comment on the route points back to the spec's Non-goals.
- **Type/name consistency:** `resolveNip05`/`parseNip05`, `COMPOSE_TEMPLATES`/`renderComposeTemplate`, route paths `/admin/api/recipient/resolve` and `/admin/api/dm-templates`, and the response field `source` are used identically across tasks and tests.
- **No new dependencies** (`nostr-tools` already present); **no schema/migration** changes.
