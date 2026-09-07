// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for API authentication functions
// ABOUTME: Covers bearer token validation, JWT auth, and legacy auth helpers

import { describe, expect, it } from 'vitest';
import {
  getConfiguredBearerTokens,
  authenticateApiRequest,
  apiUnauthorizedResponse,
  authSourceFromVerification,
  verifyLegacyBearerAuth,
} from './auth-api.mjs';

function makeRequest(headers = {}) {
  return new Request('https://example.com/api/test', {
    headers: new Headers(headers),
  });
}

describe('getConfiguredBearerTokens', () => {
  it('returns all configured tokens', () => {
    const env = {
      SERVICE_API_TOKEN: 'token-a',
      API_BEARER_TOKEN: 'token-b',
      MODERATION_API_KEY: 'token-c',
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['token-a', 'token-b', 'token-c']);
  });

  it('filters empty strings', () => {
    const env = {
      SERVICE_API_TOKEN: 'token-a',
      API_BEARER_TOKEN: '',
      MODERATION_API_KEY: 'token-c',
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['token-a', 'token-c']);
  });

  it('deduplicates identical tokens', () => {
    const env = {
      SERVICE_API_TOKEN: 'same-token',
      API_BEARER_TOKEN: 'same-token',
      MODERATION_API_KEY: 'same-token',
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['same-token']);
  });

  it('returns empty array when nothing configured', () => {
    const env = {};
    expect(getConfiguredBearerTokens(env)).toEqual([]);
  });

  it('filters undefined values', () => {
    const env = {
      SERVICE_API_TOKEN: undefined,
      API_BEARER_TOKEN: 'token-b',
      MODERATION_API_KEY: undefined,
    };
    expect(getConfiguredBearerTokens(env)).toEqual(['token-b']);
  });
});

describe('authenticateApiRequest', () => {
  it('allows dev access when ALLOW_DEV_ACCESS is true', async () => {
    const request = new Request('http://localhost/api/test');
    const env = { ALLOW_DEV_ACCESS: 'true' };
    const result = await authenticateApiRequest(request, env);
    expect(result).toEqual({ valid: true, email: 'dev@localhost', isServiceToken: false });
  });

  it('does not allow dev access on a deployed hostname', async () => {
    const request = makeRequest();
    const env = { ALLOW_DEV_ACCESS: 'true', SERVICE_API_TOKEN: 'configured-token' };

    const result = await authenticateApiRequest(request, env);

    expect(result.valid).toBe(false);
  });

  it('validates correct bearer token with isServiceToken true', async () => {
    const request = makeRequest({ Authorization: 'Bearer my-secret-token' });
    const env = { SERVICE_API_TOKEN: 'my-secret-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result).toEqual({ valid: true, email: 'service@internal', isServiceToken: true });
  });

  it('rejects wrong bearer token', async () => {
    const request = makeRequest({ Authorization: 'Bearer wrong-token' });
    const env = { SERVICE_API_TOKEN: 'correct-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result).toEqual({ valid: false, error: 'Missing bearer token or Cloudflare Access JWT' });
  });

  it('rejects missing auth', async () => {
    const request = makeRequest();
    const env = { SERVICE_API_TOKEN: 'some-token' };
    const result = await authenticateApiRequest(request, env);
    expect(result).toEqual({ valid: false, error: 'Missing bearer token or Cloudflare Access JWT' });
  });

  it('rejects with config error when no tokens configured', async () => {
    const request = makeRequest();
    const env = {};
    const result = await authenticateApiRequest(request, env);
    expect(result).toEqual({
      valid: false,
      error: 'No bearer token configured (SERVICE_API_TOKEN/API_BEARER_TOKEN/MODERATION_API_KEY)',
    });
  });
});

describe('verifyLegacyBearerAuth', () => {
  it('returns null for valid token', () => {
    const request = makeRequest({ Authorization: 'Bearer valid-token' });
    const env = { SERVICE_API_TOKEN: 'valid-token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result).toBeNull();
  });

  it('returns 401 for missing header', async () => {
    const request = makeRequest();
    const env = { SERVICE_API_TOKEN: 'valid-token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(401);
    const body = await result.json();
    expect(body.error).toMatch(/Missing Authorization/);
  });

  it('returns 403 for invalid token', async () => {
    const request = makeRequest({ Authorization: 'Bearer bad-token' });
    const env = { SERVICE_API_TOKEN: 'valid-token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(403);
    const body = await result.json();
    expect(body.error).toBe('Invalid token');
  });

  it('returns 500 when no tokens configured', async () => {
    const request = makeRequest({ Authorization: 'Bearer any-token' });
    const env = {};
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(500);
    const body = await result.json();
    expect(body.error).toMatch(/misconfigured/);
  });

  it('rejects non-Bearer schemes', async () => {
    const request = makeRequest({ Authorization: 'Basic dXNlcjpwYXNz' });
    const env = { SERVICE_API_TOKEN: 'valid-token' };
    const result = verifyLegacyBearerAuth(request, env);
    expect(result.status).toBe(401);
    const body = await result.json();
    expect(body.error).toMatch(/Missing Authorization/);
  });
});

describe('apiUnauthorizedResponse', () => {
  it('returns 401 with error message', async () => {
    const verification = { valid: false, error: 'Token expired' };
    const response = apiUnauthorizedResponse(verification);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Unauthorized - Token expired');
  });
});

describe('authSourceFromVerification', () => {
  it('returns user email when present', () => {
    const verification = { email: 'alice@example.com' };
    expect(authSourceFromVerification(verification)).toBe('user:alice@example.com');
  });

  it('returns service token sub when present', () => {
    const verification = { payload: { sub: 'svc-abc123' } };
    expect(authSourceFromVerification(verification)).toBe('service-token:svc-abc123');
  });

  it('returns unknown when no email or sub', () => {
    const verification = {};
    expect(authSourceFromVerification(verification)).toBe('service-token:unknown');
  });
});
