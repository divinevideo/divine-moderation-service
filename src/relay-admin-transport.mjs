// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Shared request plumbing for calls to divine-relay-manager's admin API
// ABOUTME: Base URL, CF Access fallback headers, and the shared-key secret resolver

// api-relay-prod.divine.video targets divine-relay-admin-api-prod which has the
// NOSTR_NSEC Secrets Store binding required by handleModerate -> getSecretKey.
// relay.admin.divine.video routes to a stale divine-relay-admin-api deployment
// that lacks the binding and crashes with "Cannot read properties of undefined
// (reading 'get')" / Cloudflare Error 1101 on every moderate call. Override
// via env.RELAY_ADMIN_URL if needed for staging or rollback.
export const DEFAULT_RELAY_ADMIN_URL = 'https://api-relay-prod.divine.video';

export function getRelayAdminUrl(env) {
  return env.RELAY_ADMIN_URL || DEFAULT_RELAY_ADMIN_URL;
}

// Headers for the public-edge fallback, which goes through Cloudflare Access.
// The RELAY_ADMIN service binding skips Access and authenticates with the
// shared X-Admin-Key instead.
export function getRelayAdminHeaders(env) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}

// Resolve a secret that may be either a plain string (wrangler secret / [vars])
// or a Cloudflare Secrets Store binding (async .get()). Mirrors the relay-admin
// worker's resolveSecret so the shared key works regardless of how it is bound.
export async function resolveSecret(binding) {
  if (!binding) return null;
  return typeof binding === 'string' ? binding : await binding.get();
}
