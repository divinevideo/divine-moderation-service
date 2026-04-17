// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Helpers for the age-restricted Blossom reconciliation workflow.
// ABOUTME: Pages D1 candidates, inspects Blossom state, classifies drift, and shapes preview payloads.

/**
 * Page D1 `moderation_results` rows with `action = 'AGE_RESTRICTED'` using
 * keyset pagination ordered by `sha256 ASC`.
 *
 * Fetches `limit + 1` rows internally so `nextCursor` can be computed exactly
 * without an extra count query.
 *
 * @param {object} db - D1 database (`env.BLOSSOM_DB`).
 * @param {object} opts
 * @param {string|null} [opts.cursorSha=null] - Last sha256 from previous page. `null` starts from the beginning.
 * @param {number} [opts.limit=100] - Caller-facing page size.
 * @returns {Promise<{ rows: Array<{ sha256: string }>, nextCursor: string|null }>}
 */
export async function listAgeRestrictedCandidates(db, { cursorSha = null, limit = 100 } = {}) {
  const fetchLimit = limit + 1;

  let stmt;
  if (cursorSha) {
    stmt = db
      .prepare(
        `SELECT sha256
         FROM moderation_results
         WHERE action = 'AGE_RESTRICTED'
           AND sha256 > ?
         ORDER BY sha256 ASC
         LIMIT ?`
      )
      .bind(cursorSha, fetchLimit);
  } else {
    stmt = db
      .prepare(
        `SELECT sha256
         FROM moderation_results
         WHERE action = 'AGE_RESTRICTED'
         ORDER BY sha256 ASC
         LIMIT ?`
      )
      .bind(fetchLimit);
  }

  const { results = [] } = await stmt.all();

  let nextCursor = null;
  let rows = results;
  if (results.length > limit) {
    rows = results.slice(0, limit);
    nextCursor = rows[rows.length - 1].sha256;
  }

  return { rows, nextCursor };
}

/**
 * Fetch current Blossom blob detail via the authenticated admin endpoint.
 *
 * @param {string} sha256
 * @param {object} env - Worker env providing `CDN_DOMAIN` and `BLOSSOM_WEBHOOK_SECRET`.
 * @param {Function} [fetchImpl=fetch] - Injectable fetch for tests.
 * @returns {Promise<{ status: number, body?: any }>} `{status:404}` for missing blobs, `{status,body}` for 2xx.
 * @throws {Error} For non-2xx/404 responses, network failures, or JSON parse failures.
 */
export async function fetchBlossomBlobDetail(sha256, env, fetchImpl = fetch) {
  const domain = env.CDN_DOMAIN || 'media.divine.video';
  const url = `https://${domain}/admin/api/blob/${sha256}`;
  const headers = { Accept: 'application/json' };
  if (env.BLOSSOM_WEBHOOK_SECRET) {
    headers.Authorization = `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`;
  }

  const response = await fetchImpl(url, { method: 'GET', headers });

  if (response.status === 404) {
    return { status: 404 };
  }

  if (!response.ok) {
    let errText = '';
    try {
      errText = await response.text();
    } catch (_err) {
      // ignore
    }
    throw new Error(
      `Blossom detail fetch failed for ${sha256}: HTTP ${response.status} ${errText.slice(0, 200)}`
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Blossom detail parse failed for ${sha256}: ${err.message}`);
  }
  return { status: response.status, body };
}

/**
 * Place a single candidate into exactly one classification bucket based on the
 * live Blossom detail (or the error encountered while reading it).
 *
 * Buckets:
 *   - `aligned` - Blossom already reports `age_restricted`.
 *   - `repairable_mismatch` - Blossom still reports `restricted`; eligible for apply.
 *   - `skip_deleted` - Blossom reports `deleted`; must not be rewritten.
 *   - `skip_missing` - Blossom returned 404 / no metadata.
 *   - `unexpected_state` - Blossom reports `active`/`pending`/`banned`/other.
 *   - `read_failed` - Blossom read threw (auth/network/5xx/parse).
 *
 * @param {object} params
 * @param {string} params.sha256
 * @param {{ status: number, body?: any }|null} params.blossomDetail - `null` means 404.
 * @param {Error|null} [params.blossomError] - Non-null means the read failed.
 * @returns {{ sha256: string, category: string, blossomStatus: string|null, error: string|null }}
 */
export function classifyAgeRestrictedCandidate({ sha256, blossomDetail, blossomError = null }) {
  if (blossomError) {
    return {
      sha256,
      category: 'read_failed',
      blossomStatus: null,
      error: blossomError.message || String(blossomError)
    };
  }

  if (blossomDetail === null || blossomDetail === undefined || blossomDetail.status === 404) {
    return { sha256, category: 'skip_missing', blossomStatus: null, error: null };
  }

  const rawStatus = blossomDetail.body?.status;
  const blossomStatus = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : null;

  let category;
  switch (blossomStatus) {
    case 'age_restricted':
      category = 'aligned';
      break;
    case 'restricted':
      category = 'repairable_mismatch';
      break;
    case 'deleted':
      category = 'skip_deleted';
      break;
    default:
      category = 'unexpected_state';
      break;
  }

  return { sha256, category, blossomStatus, error: null };
}

const PREVIEW_BUCKETS = [
  'aligned',
  'repairable_mismatch',
  'skip_deleted',
  'skip_missing',
  'unexpected_state',
  'read_failed'
];

const SAMPLE_BUCKETS = ['skip_deleted', 'skip_missing', 'unexpected_state', 'read_failed'];

const SAMPLE_CAP = 5;

/**
 * Shape a non-mutating preview response for `POST /admin/api/reconcile/age-restricted/preview`.
 *
 * @param {object} params
 * @param {Array} params.rows - Rows returned from `listAgeRestrictedCandidates`.
 * @param {Array} params.classifications - Per-sha `classifyAgeRestrictedCandidate` results.
 * @param {number} params.limit - Echo of the caller-supplied limit.
 * @param {string|null} params.nextCursor - Keyset cursor for the next page.
 * @returns {object} Preview response body (see plan Chunk 2).
 */
export function buildPreviewResponse({ rows, classifications, limit, nextCursor }) {
  const counts = {};
  for (const bucket of PREVIEW_BUCKETS) counts[bucket] = 0;

  const samples = {};
  for (const bucket of SAMPLE_BUCKETS) samples[bucket] = [];

  const repairableShas = [];

  for (const entry of classifications) {
    if (Object.prototype.hasOwnProperty.call(counts, entry.category)) {
      counts[entry.category] += 1;
    }
    if (entry.category === 'repairable_mismatch') {
      repairableShas.push(entry.sha256);
    }
    if (SAMPLE_BUCKETS.includes(entry.category) && samples[entry.category].length < SAMPLE_CAP) {
      // Include blossomStatus + error for operator sanity-checking per plan line 269
      samples[entry.category].push({
        sha256: entry.sha256,
        blossomStatus: entry.blossomStatus,
        error: entry.error
      });
    }
  }

  return {
    success: true,
    limit,
    nextCursor: nextCursor ?? null,
    counts,
    repairableShas,
    samples,
    // `rows` is referenced in the signature to keep call sites explicit and to
    // allow future enrichments. Intentionally not included in the response.
    scanned: rows.length
  };
}

/**
 * Apply age-restricted repairs for an explicit SHA list.
 *
 * For each SHA, re-fetches Blossom detail at apply time and only replays
 * `notifyBlossom(sha, 'AGE_RESTRICTED', env)` when live state is still
 * `restricted`. Other states are classified into the skip buckets. Read and
 * notify failures are counted separately with their stage preserved.
 *
 * @param {object} params
 * @param {string[]} params.shas
 * @param {object} params.env
 * @param {Function} params.fetchBlossomBlobDetail - async (sha, env) -> { status, body } | { status: 404 } | throws
 * @param {Function} params.notifyBlossom - async (sha, action, env) -> { success, error? }
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

    if (!detail || detail.status === 404) {
      result.skipped.skip_missing += 1;
      continue;
    }

    const moderationStatus = String(detail.body?.status ?? '').toLowerCase();
    if (moderationStatus === 'age_restricted') {
      result.skipped.aligned += 1;
      continue;
    }
    if (moderationStatus === 'deleted') {
      result.skipped.skip_deleted += 1;
      continue;
    }
    if (moderationStatus !== 'restricted') {
      result.skipped.unexpected_state += 1;
      continue;
    }

    // Live state is still 'restricted' — replay the AGE_RESTRICTED webhook
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
