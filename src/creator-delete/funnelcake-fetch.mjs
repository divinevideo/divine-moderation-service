// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Funnelcake kind 5 fetch with read-after-write retry.
// ABOUTME: Handles the window between Funnelcake accept (NIP-01 OK) and async ClickHouse write.

import { startDeletePhase } from './performance.mjs';

const DEFAULT_RETRY_DELAYS_MS = [0, 100, 500, 1000, 2000];

export async function fetchKind5WithRetry(kind5_id, { fetchEventById, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS } = {}) {
  const finish = startDeletePhase('kind5_retries');
  let attempts = 0;
  let outcome = 'unresolved';
  try {
    for (const delay of retryDelaysMs) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      attempts++;
      const finishAttempt = startDeletePhase('kind5_attempt', { attempt: attempts, retry_delay_ms: delay });
      let event;
      try {
        event = await fetchEventById(kind5_id);
      } catch (error) {
        finishAttempt({ outcome: 'error' });
        throw error;
      }
      finishAttempt({ outcome: event ? 'found' : 'unresolved' });
      if (event) {
        outcome = 'found';
        return event;
      }
    }
    return null;
  } catch (error) {
    outcome = 'error';
    throw error;
  } finally {
    finish({ attempts, outcome });
  }
}
