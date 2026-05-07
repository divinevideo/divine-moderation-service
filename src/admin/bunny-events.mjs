// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Latest-event-per-sha lookup helpers for bunny_webhook_events.
// ABOUTME: Replaces four hand-rolled correlated subqueries that scanned
// ABOUTME: the table once per outer row.

const DEFAULT_EXCLUDE_STATUS = ['error', 'deleted'];

/**
 * Page through the latest event per sha, ordered most-recent-first.
 * Window-function CTE so each sha appears exactly once and the
 * non-aggregate columns (hls_url, mp4_url, etc.) come from the row
 * with the largest received_at — deterministic, unlike GROUP BY +
 * bare columns.
 */
export async function latestBunnyEventBySha(env, options = {}) {
  const {
    limit = 50,
    offset = 0,
    excludeStatusNames = DEFAULT_EXCLUDE_STATUS,
  } = options;
  const placeholders = excludeStatusNames.map(() => '?').join(',');
  // CRITICAL: rank ALL rows first, then filter by status_name on the
  // winner. Filtering inside the CTE (before ROW_NUMBER) silently
  // resurrects deleted shas — if a sha has finished@100 and deleted@200,
  // dropping the deleted row from the CTE makes finished@100 the
  // "latest". The old correlated subquery used MAX() over the full
  // table and then required the latest row's status_name to be ok;
  // this query mirrors that semantic.
  const sql = `
    WITH ranked AS (
      SELECT
        sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name,
        ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC) AS rn
      FROM bunny_webhook_events
      WHERE sha256 IS NOT NULL
    )
    SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name
    FROM ranked
    WHERE rn = 1
      AND status_name NOT IN (${placeholders})
    ORDER BY received_at DESC
    LIMIT ? OFFSET ?
  `;
  const result = await env.BLOSSOM_DB.prepare(sql)
    .bind(...excludeStatusNames, limit, offset)
    .all();
  return result.results || [];
}

/**
 * Total distinct shas whose LATEST event is not in the exclude list —
 * matches the semantic of latestBunnyEventBySha. A sha whose latest
 * event is `deleted` must NOT be counted, even if it has older
 * `finished` events.
 */
export async function countLatestBunnyEvents(env, options = {}) {
  const { excludeStatusNames = DEFAULT_EXCLUDE_STATUS } = options;
  const placeholders = excludeStatusNames.map(() => '?').join(',');
  const sql = `
    WITH ranked AS (
      SELECT
        sha256, status_name,
        ROW_NUMBER() OVER (PARTITION BY sha256 ORDER BY received_at DESC) AS rn
      FROM bunny_webhook_events
      WHERE sha256 IS NOT NULL
    )
    SELECT COUNT(*) AS total
    FROM ranked
    WHERE rn = 1
      AND status_name NOT IN (${placeholders})
  `;
  const row = await env.BLOSSOM_DB.prepare(sql).bind(...excludeStatusNames).first();
  return row?.total || 0;
}

/**
 * Latest event for a single sha. Used by getAdminLookupVideo and
 * getStoredAdminPlaybackCandidates (replaces hand-rolled correlated
 * subqueries that did MAX(received_at) WHERE sha256 = ? once per call).
 */
export async function latestBunnyEventForSha(env, sha256) {
  const row = await env.BLOSSOM_DB.prepare(`
    SELECT sha256, video_guid, hls_url, mp4_url, thumbnail_url, received_at, status_name
    FROM bunny_webhook_events
    WHERE sha256 = ?
    ORDER BY received_at DESC
    LIMIT 1
  `).bind(sha256).first();
  return row || null;
}
