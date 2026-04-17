// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Age-restricted Blossom reconciliation helpers (paging, classification, apply)
// ABOUTME: Used by /admin/api/reconcile/age-restricted/{preview,apply} admin endpoints
//
// NOTE: This module currently ships a FULL implementation of `applyAgeRestrictedRepairs`
// (used by the apply endpoint on branch feat/ar-chunk3-apply). The remaining
// exports (`listAgeRestrictedCandidates`, `fetchBlossomBlobDetail`,
// `classifyAgeRestrictedCandidate`, `buildPreviewResponse`) are defined as stubs
// to be fleshed out by the sibling helper branch (feat/ar-chunk1-helper) before
// the preview endpoint lands. The apply endpoint does NOT depend on the stubs;
// it calls `fetchBlossomBlobDetail` via a dependency injected by the route so
// tests can replace it.

/**
 * List AGE_RESTRICTED moderation_results rows paged by sha256.
 * Stub: real implementation arrives in chunk 1. Returns empty page.
 */
export async function listAgeRestrictedCandidates(_db, { cursorSha = null, limit = 100 } = {}) {
  return { rows: [], nextCursor: null, limit };
}

/**
 * Fetch Blossom admin blob detail for a SHA.
 *
 * Minimal working implementation for the apply endpoint:
 * - GETs `${BLOSSOM_ADMIN_URL}/admin/api/blob/{sha}` with Bearer auth
 * - 404 → returns null (caller treats as skip_missing)
 * - 2xx JSON → returns parsed detail
 * - anything else → throws (caller treats as read failure)
 *
 * The sibling branch feat/ar-chunk1-helper will harden this (retries,
 * structured errors, etc.) but the shape `{ status, ... }` must remain stable.
 */
export async function fetchBlossomBlobDetail(sha256, env, fetchImpl = fetch) {
  const baseUrl = env?.BLOSSOM_ADMIN_URL || env?.BLOSSOM_API_URL;
  if (!baseUrl) {
    throw new Error('BLOSSOM_ADMIN_URL is not configured');
  }
  const token = env?.BLOSSOM_ADMIN_TOKEN || env?.BLOSSOM_WEBHOOK_SECRET;
  const headers = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${normalizedBase}/admin/api/blob/${sha256}`, {
    method: 'GET',
    headers
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Blossom admin GET failed: HTTP ${response.status} ${text}`.trim());
  }
  return response.json();
}

/**
 * Classify a single candidate based on Blossom detail / error.
 * Stub: real implementation arrives in chunk 1.
 */
export function classifyAgeRestrictedCandidate({ sha256, blossomDetail = null, blossomError = null }) {
  return {
    sha256,
    category: 'unexpected_state',
    blossomStatus: blossomDetail?.status ?? null,
    error: blossomError ? String(blossomError.message ?? blossomError) : null
  };
}

/**
 * Build the preview HTTP response payload from classifications.
 * Stub: real implementation arrives in chunk 2.
 */
export function buildPreviewResponse({ rows = [], classifications = [], limit = 50, nextCursor = null } = {}) {
  return {
    success: true,
    limit,
    nextCursor,
    counts: {
      aligned: 0,
      repairable_mismatch: 0,
      skip_deleted: 0,
      skip_missing: 0,
      unexpected_state: 0,
      read_failed: 0
    },
    repairableShas: [],
    samples: {
      skip_deleted: [],
      skip_missing: [],
      unexpected_state: [],
      read_failed: []
    },
    _rows: rows.length,
    _classifications: classifications.length
  };
}

/**
 * Apply moderation repair to each SHA, re-reading live Blossom state first.
 *
 * For each SHA in `shas`:
 * 1. Fetch Blossom detail via `fetchBlossomBlobDetail(sha, env)`.
 *    - If the read throws → failure with stage `'read'`.
 *    - If detail is null/undefined (treated as 404/missing) → skip `skip_missing`.
 * 2. Inspect `detail.status`:
 *    - `'restricted'` → call `notifyBlossom(sha, 'AGE_RESTRICTED', env)`.
 *        • webhook success → count as `notified`.
 *        • webhook failure → failure with stage `'notify'`.
 *    - `'age_restricted'` → skip, counted as `aligned`.
 *    - `'deleted'` → skip, counted as `skip_deleted`.
 *    - anything else (including `'active'`) → skip, counted as `unexpected_state`.
 *
 * Execution is sequential. Failed SHAs are preserved explicitly so the operator
 * can retry the exact list.
 *
 * @param {Object} opts
 * @param {string[]} opts.shas - Batch of SHA-256 hex strings
 * @param {Object} opts.env - Worker env (passed through to fetch helpers)
 * @param {Function} opts.fetchBlossomBlobDetail - async (sha, env) -> detail|null|throws
 * @param {Function} opts.notifyBlossom - async (sha, action, env) -> { success, error? }
 * @returns {Promise<{
 *   success: boolean,
 *   attempted: number,
 *   notified: number,
 *   failed: number,
 *   skipped: { aligned: number, skip_deleted: number, skip_missing: number, unexpected_state: number, read_failed: number },
 *   failures: Array<{ sha256: string, error: string, stage: 'read'|'notify' }>
 * }>}
 */
export async function applyAgeRestrictedRepairs({ shas, env, fetchBlossomBlobDetail, notifyBlossom }) {
  const result = {
    success: true,
    attempted: Array.isArray(shas) ? shas.length : 0,
    notified: 0,
    failed: 0,
    skipped: {
      aligned: 0,
      skip_deleted: 0,
      skip_missing: 0,
      unexpected_state: 0,
      read_failed: 0
    },
    failures: []
  };

  if (!Array.isArray(shas) || shas.length === 0) {
    return result;
  }

  for (const sha256 of shas) {
    let detail;
    try {
      detail = await fetchBlossomBlobDetail(sha256, env);
    } catch (error) {
      result.failed += 1;
      result.skipped.read_failed += 1;
      result.failures.push({
        sha256,
        error: String(error?.message ?? error),
        stage: 'read'
      });
      continue;
    }

    if (!detail) {
      result.skipped.skip_missing += 1;
      continue;
    }

    const status = detail.status;
    if (status === 'age_restricted') {
      result.skipped.aligned += 1;
      continue;
    }
    if (status === 'deleted') {
      result.skipped.skip_deleted += 1;
      continue;
    }
    if (status !== 'restricted') {
      // 'active' or any other state we did not expect
      result.skipped.unexpected_state += 1;
      continue;
    }

    // status === 'restricted' → replay the AGE_RESTRICTED webhook
    let notifyResult;
    try {
      notifyResult = await notifyBlossom(sha256, 'AGE_RESTRICTED', env);
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        sha256,
        error: String(error?.message ?? error),
        stage: 'notify'
      });
      continue;
    }

    if (notifyResult && notifyResult.success) {
      result.notified += 1;
    } else {
      result.failed += 1;
      result.failures.push({
        sha256,
        error: String(notifyResult?.error ?? 'notifyBlossom reported failure'),
        stage: 'notify'
      });
    }
  }

  result.success = result.failed === 0;
  return result;
}
