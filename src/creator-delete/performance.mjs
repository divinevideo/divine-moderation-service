// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Best-effort structured timings for the creator deletion user journey.
// ABOUTME: Only bounded labels and numeric measurements enter these events; never request or event data.

const PHASES = new Set([
  'request', 'ip_rate_limit', 'auth', 'pubkey_rate_limit', 'kind5_lookup',
  'kind5_retries', 'kind5_attempt', 'relay_lookup', 'target_lookup',
  'blob_delete', 'processing', 'status_read', 'status_result'
]);
const OUTCOMES = new Set([
  'completed', 'allowed', 'limited', 'valid', 'invalid', 'found', 'missing',
  'unresolved', 'transient', 'transport_error', 'success', 'failed', 'skipped',
  'in_progress', 'rejected', 'error'
]);

export function startDeletePhase(phase, fields = {}) {
  let started;
  try { started = Date.now(); } catch { return () => {}; }
  return (result = {}) => {
    // Monitoring must neither throw into the user path nor copy arbitrary
    // dependency fields (which can contain IDs, URLs, credentials or bodies).
    try {
      if (!PHASES.has(phase)) return;
      const data = { ...fields, ...result };
      const entry = {
        event: 'creator_delete.performance',
        operation: fields.operation === 'delete_status' ? 'delete_status' : 'delete',
        phase,
        duration_ms: Math.max(0, Date.now() - started),
        outcome: OUTCOMES.has(data.outcome) ? data.outcome : 'error'
      };
      for (const key of ['attempt', 'attempts', 'retry_delay_ms']) {
        if (Number.isInteger(data[key]) && data[key] >= 0) entry[key] = data[key];
      }
      if (Number.isInteger(data.status_code) && data.status_code >= 100 && data.status_code <= 599) {
        entry.status_code = data.status_code;
      }
      console.log(entry);
    } catch {
      // Best effort: a logging failure must not change deletion semantics.
    }
  };
}

export async function measureDeletePhase(phase, run, classify = () => ({ outcome: 'completed' }), fields = {}) {
  const finish = startDeletePhase(phase, fields);
  let result;
  try {
    result = await run();
  } catch (error) {
    finish({ outcome: 'error' });
    throw error;
  }
  // Classification is telemetry too; preserve the dependency result if it fails.
  try { finish(classify(result)); } catch {}
  return result;
}

export function responsePerformance(response) {
  return {
    status_code: response.status,
    outcome: response.status === 202 ? 'in_progress' : response.status >= 400 ? 'rejected' : 'completed'
  };
}
