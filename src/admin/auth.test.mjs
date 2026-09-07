// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests verified Cloudflare Access authentication for admin requests
// ABOUTME: Ensures asserted headers cannot replace JWT-derived identity

import { describe, it, expect, vi } from 'vitest';
import { getAuthenticatedUser, requireAuth } from './auth.mjs';

const verifiedAdmin = {
  verify: vi.fn(async () => ({
    valid: true,
    email: 'verified@divine.video',
    payload: { email: 'verified@divine.video' }
  }))
};

describe('Admin Auth', () => {
  it('allows local development access when explicitly enabled', async () => {
    const request = new Request('http://localhost/admin');

    expect(await requireAuth(request, { ALLOW_DEV_ACCESS: 'true' }, verifiedAdmin)).toBeNull();
    expect(getAuthenticatedUser(request)).toBe('dev@localhost');
  });

  it('does not allow the development bypass on a deployed hostname', async () => {
    const request = new Request('https://moderation.admin.divine.video/admin');
    const rejectingVerifier = {
      verify: vi.fn(async () => ({ valid: false, error: 'Missing JWT token' }))
    };

    const result = await requireAuth(request, { ALLOW_DEV_ACCESS: 'true' }, rejectingVerifier);

    expect(result.status).toBe(401);
    expect(rejectingVerifier.verify).toHaveBeenCalledWith(null);
  });

  it('returns the existing JSON 401 shape when the token is missing', async () => {
    const request = new Request('https://moderation.admin.divine.video/admin');
    const verifier = { verify: vi.fn(async () => ({ valid: false, error: 'Missing JWT token' })) };

    const result = await requireAuth(request, {}, verifier);

    expect(result.status).toBe(401);
    expect(result.headers.get('Content-Type')).toBe('application/json');
    await expect(result.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['malformed', 'Invalid token'],
    ['expired', 'JWT expired'],
    ['wrong issuer', 'unexpected iss value'],
    ['wrong audience', 'unexpected aud value']
  ])('returns 401 for a %s token', async (_name, error) => {
    const request = new Request('https://moderation.admin.divine.video/admin', {
      headers: { 'cf-access-jwt-assertion': 'rejected-token' }
    });
    const verifier = { verify: vi.fn(async () => ({ valid: false, error })) };

    const result = await requireAuth(request, {}, verifier);

    expect(result.status).toBe(401);
  });

  it('requires a user email in the verified payload', async () => {
    const request = new Request('https://moderation.admin.divine.video/admin', {
      headers: { 'cf-access-jwt-assertion': 'service-token' }
    });
    const verifier = { verify: vi.fn(async () => ({ valid: true, payload: { sub: 'service' } })) };

    const result = await requireAuth(request, {}, verifier);

    expect(result.status).toBe(401);
    expect(getAuthenticatedUser(request)).toBeNull();
  });

  it('uses the verified identity instead of a conflicting asserted email header', async () => {
    const request = new Request('https://moderation.admin.divine.video/admin', {
      headers: {
        'cf-access-jwt-assertion': 'valid-token',
        'Cf-Access-Authenticated-User-Email': 'asserted@invalid.example'
      }
    });

    expect(await requireAuth(request, {}, verifiedAdmin)).toBeNull();
    expect(getAuthenticatedUser(request)).toBe('verified@divine.video');
  });

  it('fails closed when verifier configuration is missing', async () => {
    const request = new Request('https://moderation.admin.divine.video/admin', {
      headers: { 'cf-access-jwt-assertion': 'valid-token' }
    });
    const verifier = { verify: vi.fn(async () => { throw new Error('POLICY_AUD not configured'); }) };

    const result = await requireAuth(request, {}, verifier);

    expect(result.status).toBe(401);
  });
});
