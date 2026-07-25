// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared test helpers for creator-delete unit tests — in-memory D1 and KV fakes.
// ABOUTME: makeFakeD1 mirrors production SQL arity (see src/creator-delete/d1.mjs claimRow).

// Test helper: in-memory D1 fake with the same schema as creator_deletions.
export function makeFakeD1() {
  const rows = new Map(); // key: `${kind5_id}:${target_event_id}`
  return {
    rows,
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        async run() {
          if (this._sql.startsWith('INSERT')) {
            const [kind5_id, target_event_id, creator_pubkey, accepted_at] = this._binds;
            const key = `${kind5_id}:${target_event_id}`;
            if (rows.has(key)) {
              return { meta: { changes: 0, rows_written: 0 } };
            }
            rows.set(key, { kind5_id, target_event_id, creator_pubkey, status: 'accepted', accepted_at, retry_count: 0, last_error: null, blob_sha256: null, completed_at: null });
            return { meta: { changes: 1, rows_written: 1 } };
          }
          if (this._sql.startsWith('UPDATE')) {
            // Atomic re-claim: UPDATE ... WHERE kind5_id=? AND target_event_id=? AND accepted_at=?
            // binds: [new_accepted_at, kind5_id, target_event_id, old_accepted_at]
            if (this._sql.includes('AND accepted_at = ?')) {
              const [newAccepted, kind5_id, target_event_id, oldAccepted] = this._binds;
              const target_key = `${kind5_id}:${target_event_id}`;
              const existing = rows.get(target_key);
              if (!existing || existing.accepted_at !== oldAccepted) {
                return { meta: { changes: 0, rows_written: 0 } };
              }
              rows.set(target_key, { ...existing, accepted_at: newAccepted, status: 'accepted' });
              return { meta: { changes: 1, rows_written: 1 } };
            }
            // State-transition UPDATEs: kind5_id and target_event_id are the last two binds.
            const target_key = `${this._binds[this._binds.length - 2]}:${this._binds[this._binds.length - 1]}`;
            const existing = rows.get(target_key);
            if (existing) {
              if (this._sql.includes("SET status = 'success'")) {
                const [blob_sha256, completed_at] = this._binds;
                rows.set(target_key, {
                  ...existing,
                  status: 'success',
                  blob_sha256,
                  completed_at,
                  last_error: null
                });
              } else {
                const [status, last_error] = this._binds;
                rows.set(target_key, {
                  ...existing,
                  status,
                  last_error,
                  retry_count: existing.retry_count + (this._sql.includes('retry_count = retry_count + 1') ? 1 : 0)
                });
              }
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (this._sql.startsWith('SELECT')) {
            const key = `${this._binds[0]}:${this._binds[1]}`;
            return rows.get(key) || null;
          }
          return null;
        },
        async all() {
          if (this._sql.startsWith('SELECT')) {
            // Pattern 1: cron transient-retry sweep
            // SELECT ... WHERE status LIKE 'failed:transient:%' AND retry_count < ?
            if (this._sql.includes("status LIKE 'failed:transient:%'") && this._sql.includes("retry_count <")) {
              const maxRetry = this._binds[0];
              const results = [];
              for (const row of rows.values()) {
                if (!row.status?.startsWith('failed:transient:')) continue;
                if (row.retry_count >= maxRetry) continue;
                results.push(row);
              }
              return { results };
            }
            // Pattern 2 (existing): SELECT ... WHERE kind5_id = ? [AND target_event_id = ?]
            const kind5_id = this._binds[0];
            const results = [];
            for (const row of rows.values()) {
              if (row.kind5_id !== kind5_id) continue;
              // If a second bind (target_event_id) is present, filter by it too.
              if (this._binds.length >= 2 && row.target_event_id !== this._binds[1]) continue;
              results.push(row);
            }
            return { results };
          }
          return { results: [] };
        }
      };
    }
  };
}

// Test helper: in-memory KV fake matching the subset of Cloudflare Workers KV we use.
// Real CF KV accepts a third options arg on put() (e.g. { expirationTtl }); the fake ignores it.
export function makeFakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); }
  };
}
