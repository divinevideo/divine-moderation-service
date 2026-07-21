// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: In-memory D1 fake for community-label tests, mirroring the
// ABOUTME: production SQL arity in src/community-labels/d1.mjs.

// Mirrors migrations/010-community-labels.sql: three tables keyed by their
// primary keys. SQL is matched on shape, same approach as the
// creator-delete makeFakeD1 helper.
const D1_MAX_BOUND_PARAMETERS = 100;

export function makeFakeCommunityD1() {
  const decisions = new Map(); // `${video_event_id}:${label}`
  const strikes = new Map(); // `${creator_pubkey}:${video_event_id}:${label}`
  const warnings = new Map(); // `${creator_pubkey}:${warning_level}`

  return {
    decisions,
    strikes,
    warnings,
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...args) {
          if (args.length > D1_MAX_BOUND_PARAMETERS) {
            throw new Error(`too many SQL variables: ${args.length}`);
          }
          this._binds = args;
          return this;
        },
        async run() {
          if (this._sql.includes('UPDATE') && this._sql.includes('community_label_decisions')) {
            const [published_event_id, video_event_id, label] = this._binds;
            const row = decisions.get(`${video_event_id}:${label}`);
            if (row && row.status === 'pending') {
              row.status = 'confirmed';
              row.published_event_id = published_event_id;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (this._sql.includes('UPDATE') && this._sql.includes('community_strike_warnings')) {
            const [creator_pubkey, warning_level] = this._binds;
            const row = warnings.get(`${creator_pubkey}:${warning_level}`);
            if (row && row.status === 'pending') {
              row.status = 'sent';
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (this._sql.includes('INSERT') && this._sql.includes('community_label_decisions')) {
            const [video_event_id, label, vote_count, published_event_id, video_sha256, creator_pubkey, prepared_event, created_at] = this._binds;
            const key = `${video_event_id}:${label}`;
            if (decisions.has(key)) return { meta: { changes: 0 } };
            decisions.set(key, { video_event_id, label, vote_count, published_event_id, video_sha256, creator_pubkey, prepared_event, created_at, status: 'pending' });
            return { meta: { changes: 1 } };
          }
          if (this._sql.includes('INSERT') && this._sql.includes('community_strikes')) {
            const [creator_pubkey, video_event_id, label, created_at] = this._binds;
            const key = `${creator_pubkey}:${video_event_id}:${label}`;
            if (strikes.has(key)) return { meta: { changes: 0 } };
            strikes.set(key, { creator_pubkey, video_event_id, label, created_at });
            return { meta: { changes: 1 } };
          }
          if (this._sql.includes('INSERT') && this._sql.includes('community_strike_warnings')) {
            const [creator_pubkey, warning_level, sent_at] = this._binds;
            const key = `${creator_pubkey}:${warning_level}`;
            if (warnings.has(key)) return { meta: { changes: 0 } };
            warnings.set(key, { creator_pubkey, warning_level, sent_at, status: 'pending' });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (this._sql.includes('community_label_decisions')) {
            const [video_event_id, label] = this._binds;
            const row = decisions.get(`${video_event_id}:${label}`) || null;
            if (row && this._sql.includes("status = 'confirmed'") && row.status !== 'confirmed') {
              return null;
            }
            return row;
          }
          if (this._sql.includes('COUNT(*)') && this._sql.includes('community_strikes')) {
            const [creator_pubkey] = this._binds;
            let n = 0;
            for (const row of strikes.values()) {
              if (row.creator_pubkey === creator_pubkey) n += 1;
            }
            return { n };
          }
          if (this._sql.includes('community_strike_warnings')) {
            const [creator_pubkey, warning_level] = this._binds;
            return warnings.get(`${creator_pubkey}:${warning_level}`) || null;
          }
          return null;
        },
        async all() {
          if (this._sql.includes('community_strikes') && this._sql.includes('OFFSET ?')) {
            const [creator_pubkey, limit, offset] = this._binds;
            const results = [...strikes.values()]
              .filter((row) => row.creator_pubkey === creator_pubkey)
              .sort((a, b) => b.created_at - a.created_at)
              .slice(offset, offset + limit)
              .map((row) => ({
                video_event_id: row.video_event_id,
                label: row.label,
                created_at: row.created_at,
              }));
            return { results };
          }
          if (this._sql.includes('GROUP BY creator_pubkey')) {
            const [limit] = this._binds;
            const byCreator = new Map();
            for (const row of strikes.values()) {
              const entry = byCreator.get(row.creator_pubkey) || { creator_pubkey: row.creator_pubkey, strikes: 0, last_at: 0 };
              entry.strikes += 1;
              entry.last_at = Math.max(entry.last_at, row.created_at);
              byCreator.set(row.creator_pubkey, entry);
            }
            const results = [...byCreator.values()]
              .sort((a, b) => b.strikes - a.strikes || b.last_at - a.last_at)
              .slice(0, limit);
            return { results };
          }
          if (this._sql.includes('community_strikes') && this._sql.includes(' IN (')) {
            const wanted = new Set(this._binds);
            const results = [...strikes.values()]
              .filter((row) => wanted.has(row.creator_pubkey))
              .sort((a, b) => b.created_at - a.created_at)
              .map((row) => ({
                creator_pubkey: row.creator_pubkey,
                video_event_id: row.video_event_id,
                label: row.label,
                created_at: row.created_at,
              }));
            return { results };
          }
          return { results: [] };
        },
      };
    },
  };
}
