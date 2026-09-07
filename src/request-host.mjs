// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared request-host checks for development-only behavior
// ABOUTME: Prevents local bypasses from being enabled on deployed hostnames

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

export function isLocalRequest(request) {
  try {
    return isLocalHostname(new URL(request.url).hostname);
  } catch {
    return false;
  }
}
