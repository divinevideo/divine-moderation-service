// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pure helpers that turn a moderation_results row into the shape
// ABOUTME: the admin dashboard expects. No side effects, no DB, no fetch.

/**
 * Columns that must be selected from `moderation_results` for the admin
 * dashboard's list endpoints to render without a follow-up funnelcake call.
 *
 * Migration 004-content-metadata.sql added `event_id, title, author,
 * content_url, published_at` to the table; before this helper landed, the
 * dashboard's SELECTs omitted them, which forced enrichAdminLookupVideo()
 * to fall through to fetchFunnelcakeLookupVideo() for every card on every
 * page render. Including them here lets the response come straight from D1.
 */
export const ADMIN_VIDEO_COLUMNS = [
  'sha256',
  'action',
  'provider',
  'scores',
  'categories',
  'moderated_at',
  'reviewed_by',
  'reviewed_at',
  'uploaded_by',
  'event_id',
  'title',
  'author',
  'content_url',
  'published_at',
];

function safeParseJSON(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Build the admin-video shape the dashboard JS consumes from a single
 * moderation_results row. Mirrors buildStoredLookupMetadata's nostrContext
 * exactly (src/index.mjs ~line 251) so response keys match before/after
 * the fan-out removal.
 *
 * `client` and `content` are not stored in moderation_results; the
 * single-video lookup endpoint (/admin/api/video/:id) still calls
 * funnelcake on demand to fill them when a moderator opens the detail
 * view. List cards do not surface those fields.
 *
 * @param {object} row - row from `moderation_results`
 * @param {{cdnDomain: string}} options
 * @returns {object}
 */
export function buildAdminVideoFromRow(row, { cdnDomain }) {
  const eventId = row.event_id || null;
  const publishedAt = row.published_at ? Number.parseInt(row.published_at, 10) : null;
  const hasContext = Boolean(
    row.title || row.author || row.content_url || eventId || row.uploaded_by || publishedAt,
  );

  return {
    sha256: row.sha256,
    action: row.action,
    provider: row.provider || null,
    scores: safeParseJSON(row.scores, {}),
    categories: safeParseJSON(row.categories, []),
    processedAt: row.moderated_at ? new Date(row.moderated_at).getTime() : null,
    moderated_at: row.moderated_at,
    reviewed_by: row.reviewed_by || null,
    reviewed_at: row.reviewed_at || null,
    uploaded_by: row.uploaded_by || null,
    eventId,
    divineUrl: eventId ? `https://divine.video/video/${encodeURIComponent(eventId)}` : null,
    cdnUrl: `https://${cdnDomain}/${row.sha256}`,
    nostrContext: hasContext ? {
      title: row.title || null,
      author: row.author || null,
      client: null,
      content: null,
      url: row.content_url || null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      pubkey: row.uploaded_by ? `${row.uploaded_by.substring(0, 16)}...` : null,
      eventId,
      platform: null,
    } : null,
  };
}
