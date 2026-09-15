// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Bounded request-body reading and signed kind-5 validation for immediate deletion.
// ABOUTME: Supplied events never depend on the relay indexing a just-published event.

import { verifyEvent } from 'nostr-tools/pure';

const MAX_BODY_BYTES = 64 * 1024;
const EVENT_ID = /^[a-f0-9]{64}$/;

export async function readDeleteBody(request) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_BODY_BYTES) {
        // Cancellation is cleanup: a broken or stalled source must not delay
        // the size-limit response or replace it with a cancellation error.
        void reader.cancel().catch(() => {});
        const error = new Error('Deletion request body exceeds 64 KiB');
        error.status = 413;
        throw error;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, length);
}

// Parsing from JSON prevents callers from supplying nostr-tools' in-memory
// signature-verification cache symbol. Verify the received signed event itself.
export function parseSignedDeleteEvent(bytes, expectedId) {
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const event = body?.event;
    if (!event || event.kind !== 5 || event.id !== expectedId ||
        !Number.isInteger(event.created_at) || !verifyEvent(event)) return null;
    const targets = event.tags.filter(tag => tag[0] === 'e');
    if (targets.length === 0 || targets.some(tag => typeof tag[1] !== 'string' || !EVENT_ID.test(tag[1]))) return null;
    return event;
  } catch {
    return null;
  }
}
