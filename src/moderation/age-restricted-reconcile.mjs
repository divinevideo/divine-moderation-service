// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Helpers for age-restricted moderation ↔ Blossom reconciliation
// ABOUTME: Candidate paging, Blossom status inspection, classification, preview shaping, and apply revalidation

const DEFAULT_LIMIT = 100;
const SAMPLE_BUCKETS = ['skip_deleted', 'skip_missing', 'unexpected_state', 'read_failed'];
const ALL_BUCKETS = ['aligned', 'repairable_mismatch', ...SAMPLE_BUCKETS];
const SAMPLE_SIZE = 5;

/**
 * Page moderation_results rows with action='AGE_RESTRICTED' ordered by sha256 ASC.
 * Uses keyset pagination: fetches limit+1 rows to compute an exact nextCursor.
 *
 * @param {D1Database} db
 * @param {{ cursorSha?: string|null, limit?: number }} options
 * @returns {Promise<{ rows: Array<{sha256: string, action: string}>, nextCursor: string|null }>}
 */
export async function listAgeRestrictedCandidates(db, { cursorSha = null, limit = DEFAULT_LIMIT } = {}) {
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const fetchCount = effectiveLimit + 1;

  let statement;
  if (cursorSha) {
    statement = db.prepare(
      "SELECT sha256, action FROM moderation_results WHERE action = 'AGE_RESTRICTED' AND sha256 > ? ORDER BY sha256 ASC LIMIT ?"
    ).bind(cursorSha, fetchCount);
  } else {
    statement = db.prepare(
      "SELECT sha256, action FROM moderation_results WHERE action = 'AGE_RESTRICTED' ORDER BY sha256 ASC LIMIT ?"
    ).bind(fetchCount);
  }

  const result = await statement.all();
  const fetched = (result && result.results) ? result.results : [];

  let nextCursor = null;
  let rows = fetched;
  if (fetched.length > effectiveLimit) {
    rows = fetched.slice(0, effectiveLimit);
    nextCursor = rows[rows.length - 1].sha256;
  }

  return { rows, nextCursor };
}

/**
 * Fetch Blossom blob detail via admin API.
 *
 * @param {string} sha256
 * @param {{ CDN_DOMAIN: string, BLOSSOM_WEBHOOK_SECRET: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ status: number, body?: any }>}
 */
export async function fetchBlossomBlobDetail(sha256, env, fetchImpl = fetch) {
  const url = `https://${env.CDN_DOMAIN}/admin/api/blob/${sha256}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.BLOSSOM_WEBHOOK_SECRET}`,
      Accept: 'application/json'
    }
  });

  if (response.status === 404) {
    return { status: 404 };
  }

  if (response.status >= 200 && response.status < 300) {
    let body = null;
    try {
      body = await response.json();
    } catch (err) {
      const parseError = new Error(`Failed to parse Blossom blob detail JSON for ${sha256}: ${err.message}`);
      parseError.cause = err;
      throw parseError;
    }
    return { status: response.status, body };
  }

  const text = await response.text().catch(() => '');
  const error = new Error(`Blossom blob detail returned ${response.status} for ${sha256}${text ? `: ${text}` : ''}`);
  error.status = response.status;
  throw error;
}

/**
 * Classify a single AGE_RESTRICTED candidate against live Blossom state.
 *
 * @param {{ sha256: string, blossomDetail?: { status: number, body?: any }, blossomError?: Error|null }}
 * @returns {{ sha256: string, category: string, blossomStatus: string|null, error: string|null }}
 */
export function classifyAgeRestrictedCandidate({ sha256, blossomDetail = null, blossomError = null }) {
  if (blossomError) {
    return {
      sha256,
      category: 'read_failed',
      blossomStatus: null,
      error: blossomError.message || String(blossomError)
    };
  }

  if (!blossomDetail) {
    return {
      sha256,
      category: 'read_failed',
      blossomStatus: null,
      error: 'no blossom detail'
    };
  }

  if (blossomDetail.status === 404) {
    return {
      sha256,
      category: 'skip_missing',
      blossomStatus: null,
      error: null
    };
  }

  const status = blossomDetail.body && typeof blossomDetail.body.status === 'string'
    ? blossomDetail.body.status.toLowerCase()
    : null;

  if (status === 'age_restricted') {
    return { sha256, category: 'aligned', blossomStatus: status, error: null };
  }
  if (status === 'restricted') {
    return { sha256, category: 'repairable_mismatch', blossomStatus: status, error: null };
  }
  if (status === 'deleted') {
    return { sha256, category: 'skip_deleted', blossomStatus: status, error: null };
  }

  return {
    sha256,
    category: 'unexpected_state',
    blossomStatus: status,
    error: null
  };
}

/**
 * Build the preview response payload from classifications.
 *
 * @param {{ rows: Array, classifications: Array, limit: number, nextCursor: string|null }}
 * @returns {{
 *   success: boolean,
 *   limit: number,
 *   nextCursor: string|null,
 *   counts: Record<string, number>,
 *   repairableShas: string[],
 *   samples: Record<string, Array>
 * }}
 */
export function buildPreviewResponse({ rows, classifications, limit, nextCursor }) {
  const counts = Object.fromEntries(ALL_BUCKETS.map((bucket) => [bucket, 0]));
  const repairableShas = [];
  const samples = Object.fromEntries(SAMPLE_BUCKETS.map((bucket) => [bucket, []]));

  for (const entry of classifications) {
    if (!counts.hasOwnProperty(entry.category)) {
      counts[entry.category] = 0;
    }
    counts[entry.category] += 1;

    if (entry.category === 'repairable_mismatch') {
      repairableShas.push(entry.sha256);
    }

    if (SAMPLE_BUCKETS.includes(entry.category) && samples[entry.category].length < SAMPLE_SIZE) {
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
    nextCursor: nextCursor || null,
    counts,
    repairableShas,
    samples
  };
}

/**
 * Apply repairs to confirmed repairable SHAs. Revalidates each SHA immediately
 * before replaying the webhook to avoid overwriting state that changed after preview.
 *
 * NOTE: stub for Chunk 3 — fully implemented in a later chunk.
 *
 * @param {{ shas: string[], env: object, fetchBlossomBlobDetail: Function, notifyBlossom: Function }} args
 * @returns {Promise<{ success: boolean, applied: string[], skipped: Array, failed: Array }>}
 */
export async function applyAgeRestrictedRepairs(/* { shas, env, fetchBlossomBlobDetail, notifyBlossom } */) {
  throw new Error('applyAgeRestrictedRepairs not implemented yet');
}
