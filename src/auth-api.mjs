// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: API authentication functions for bearer token and JWT validation
// ABOUTME: Extracted from index.mjs for testability and separation of concerns

import { getZeroTrustVerifier } from './admin/zerotrust.mjs';
import { isLocalRequest } from './request-host.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: JSON_HEADERS
  });
}

function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

export function getConfiguredBearerTokens(env) {
  return [env.SERVICE_API_TOKEN, env.API_BEARER_TOKEN, env.MODERATION_API_KEY]
    .filter((value, index, all) => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);
}

export async function authenticateApiRequest(request, env, verifier = null) {
  if (env.ALLOW_DEV_ACCESS === 'true' && isLocalRequest(request)) {
    return { valid: true, email: 'dev@localhost', isServiceToken: false };
  }

  const authHeader = request.headers.get('Authorization');
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const configuredTokens = getConfiguredBearerTokens(env);
  if (bearerToken && configuredTokens.includes(bearerToken)) {
    return { valid: true, email: 'service@internal', isServiceToken: true };
  }

  const jwtToken = request.headers.get('cf-access-jwt-assertion');
  if (jwtToken) {
    try {
      return await (verifier || getZeroTrustVerifier(env)).verify(jwtToken);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  if (configuredTokens.length === 0) {
    return { valid: false, error: 'No bearer token configured (SERVICE_API_TOKEN/API_BEARER_TOKEN/MODERATION_API_KEY)' };
  }

  return { valid: false, error: 'Missing bearer token or Cloudflare Access JWT' };
}

export function apiUnauthorizedResponse(verification) {
  return jsonError(`Unauthorized - ${verification.error}`, 401);
}

export function authSourceFromVerification(verification) {
  return verification.email
    ? `user:${verification.email}`
    : `service-token:${verification.payload?.sub || 'unknown'}`;
}

export function verifyLegacyBearerAuth(request, env) {
  const configuredTokens = getConfiguredBearerTokens(env);
  if (configuredTokens.length === 0) {
    console.error('[AUTH] No legacy bearer token configured');
    return jsonResponse(500, { error: 'Server misconfigured — no auth token set' });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization: Bearer <token>' });
  }

  const token = authHeader.slice(7);
  if (!configuredTokens.includes(token)) {
    return jsonResponse(403, { error: 'Invalid token' });
  }

  return null;
}
