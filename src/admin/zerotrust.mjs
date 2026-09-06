// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Cloudflare Zero Trust JWT verification using jose library
// ABOUTME: Verifies cf-access-jwt-assertion tokens against Cloudflare's JWKS

import { jwtVerify, createRemoteJWKSet } from 'jose';

const verifierCache = new Map();

/**
 * Verify a Cloudflare Zero Trust JWT token
 * @param {string|null} token - The JWT from cf-access-jwt-assertion header
 * @param {Object} env - Environment with TEAM_DOMAIN and POLICY_AUD
 * @returns {Promise<Object>} Result with valid, email, payload, or error
 */
export async function verifyZeroTrustJWT(token, env) {
  // Validate environment configuration
  if (!env.TEAM_DOMAIN) {
    return { valid: false, error: 'TEAM_DOMAIN not configured' };
  }

  if (!env.POLICY_AUD) {
    return { valid: false, error: 'POLICY_AUD not configured' };
  }

  // Validate token presence
  if (!token || token === '') {
    return { valid: false, error: 'Missing JWT token' };
  }

  try {
    // Create JWKS from Cloudflare's certs endpoint
    const jwksUrl = new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const JWKS = createRemoteJWKSet(jwksUrl);

    // Verify the JWT
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD
    });

    // Return verification result
    return {
      valid: true,
      email: payload.email,
      isServiceToken: !payload.email,
      payload
    };
  } catch (error) {
    return {
      valid: false,
      error: `Invalid token: ${error.message}`
    };
  }
}

/**
 * Create a reusable Zero Trust JWT verifier
 * @param {Object} env - Environment with TEAM_DOMAIN and POLICY_AUD
 * @param {Object} options - Options including mockPayload for testing
 * @returns {Object} Verifier with verify method and config properties
 */
export function createZeroTrustVerifier(env, options = {}) {
  // Validate environment configuration
  if (!env.TEAM_DOMAIN) {
    throw new Error('TEAM_DOMAIN not configured');
  }

  if (!env.POLICY_AUD) {
    throw new Error('POLICY_AUD not configured');
  }

  const jwksUrl = `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`;

  // Create the verifier object
  const verifier = {
    jwksUrl,
    issuer: env.TEAM_DOMAIN,
    audience: env.POLICY_AUD,

    /**
     * Verify a JWT token
     * @param {string} token - The JWT to verify
     * @returns {Promise<Object>} Verification result
     */
    async verify(token) {
      // Test mode - return mock payload without verification
      if (options.mockPayload) {
        return {
          valid: true,
          email: options.mockPayload.email,
          isServiceToken: !options.mockPayload.email,
          payload: options.mockPayload
        };
      }

      // Production mode - use full verification
      return verifyZeroTrustJWT(token, env);
    }
  };

  return verifier;
}

/**
 * Reuse the remote JWKS resolver across requests for the same Access policy.
 * createRemoteJWKSet caches keys on the resolver instance, so recreating the
 * verifier for every request would discard that cache.
 */
export function getZeroTrustVerifier(env) {
  const cacheKey = `${env.TEAM_DOMAIN || ''}\u0000${env.POLICY_AUD || ''}`;
  let verifier = verifierCache.get(cacheKey);
  if (!verifier) {
    verifier = createZeroTrustVerifier(env);
    verifierCache.set(cacheKey, verifier);
  }
  return verifier;
}
