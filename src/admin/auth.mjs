// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Admin authentication middleware using Cloudflare Zero Trust
// ABOUTME: Verifies Cloudflare Access JWTs and exposes their authenticated identity

import { getZeroTrustVerifier } from './zerotrust.mjs';
import { isLocalRequest } from '../request-host.mjs';

const authenticatedRequests = new WeakMap();

/**
 * Get the verified user email after requireAuth has authenticated this request.
 */
export function getAuthenticatedUser(request) {
  return authenticatedRequests.get(request)?.email || null;
}

/**
 * Middleware to check authentication via Cloudflare Zero Trust
 * Returns null if authenticated, Response if not authenticated
 *
 * The verifier parameter is injectable so route tests can isolate auth from
 * remote JWKS transport. Production callers use the cached Access verifier.
 */
export async function requireAuth(request, env, verifier = null) {
  if (env.ALLOW_DEV_ACCESS === 'true' && isLocalRequest(request)) {
    console.log('[AUTH] Development mode - bypassing Zero Trust check');
    authenticatedRequests.set(request, { email: 'dev@localhost' });
    return null;
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  let verification;
  try {
    verification = await (verifier || getZeroTrustVerifier(env)).verify(token);
  } catch (error) {
    verification = { valid: false, error: error.message };
  }

  if (!verification.valid || !verification.email) {
    console.log(`[AUTH] Cloudflare Access JWT rejected: ${verification.error || 'missing user email'}`);
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  authenticatedRequests.set(request, verification);
  console.log(`[AUTH] Authenticated user: ${verification.email}`);
  return null;
}

// Legacy exports for backwards compatibility during transition
// These can be removed once login UI is removed
export async function verifyPassword() { return false; }
export async function createSession() { return null; }
export async function verifySession() { return false; }
export async function deleteSession() {}
export function getTokenFromCookie() { return null; }
