// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Cloudflare Zero Trust JWT verification
// ABOUTME: Validates cf-access-jwt-assertion tokens using jose library

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyZeroTrustJWT, createZeroTrustVerifier, getZeroTrustVerifier } from './zerotrust.mjs';

describe('Zero Trust JWT Verification', () => {
  const mockEnv = {
    TEAM_DOMAIN: 'https://divine.cloudflareaccess.com',
    POLICY_AUD: 'test-audience-12345'
  };

  describe('verifyZeroTrustJWT', () => {
    it('should reject when TEAM_DOMAIN is not configured', async () => {
      const result = await verifyZeroTrustJWT('some-token', {
        POLICY_AUD: 'test-aud'
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('TEAM_DOMAIN not configured');
    });

    it('should reject when POLICY_AUD is not configured', async () => {
      const result = await verifyZeroTrustJWT('some-token', {
        TEAM_DOMAIN: 'https://divine.cloudflareaccess.com'
      });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('POLICY_AUD not configured');
    });

    it('should reject when token is missing', async () => {
      const result = await verifyZeroTrustJWT(null, mockEnv);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing JWT token');
    });

    it('should reject when token is empty string', async () => {
      const result = await verifyZeroTrustJWT('', mockEnv);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Missing JWT token');
    });

    it('should reject invalid JWT format', async () => {
      const result = await verifyZeroTrustJWT('not-a-valid-jwt', mockEnv);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid token');
    });

    it('should return email from valid token payload', async () => {
      // This test requires a mock JWKS - we'll use a custom verifier
      const mockPayload = {
        email: 'test@divine.video',
        sub: 'user-123',
        aud: ['test-audience-12345'],
        iss: 'https://divine.cloudflareaccess.com'
      };

      // Create a verifier with mocked JWKS verification
      const verifier = createZeroTrustVerifier(mockEnv, {
        mockPayload // Test mode - returns this payload without verification
      });

      const result = await verifier.verify('mock-token');

      expect(result.valid).toBe(true);
      expect(result.email).toBe('test@divine.video');
      expect(result.payload.sub).toBe('user-123');
    });

    it('should identify service token (no email in payload)', async () => {
      const mockPayload = {
        sub: 'service-token-id',
        aud: ['test-audience-12345'],
        iss: 'https://divine.cloudflareaccess.com'
        // No email field for service tokens
      };

      const verifier = createZeroTrustVerifier(mockEnv, {
        mockPayload
      });

      const result = await verifier.verify('mock-token');

      expect(result.valid).toBe(true);
      expect(result.email).toBeUndefined();
      expect(result.isServiceToken).toBe(true);
    });
  });

  describe('createZeroTrustVerifier', () => {
    it('should create verifier with correct JWKS URL', () => {
      const verifier = createZeroTrustVerifier(mockEnv);

      expect(verifier.jwksUrl).toBe('https://divine.cloudflareaccess.com/cdn-cgi/access/certs');
      expect(verifier.issuer).toBe('https://divine.cloudflareaccess.com');
      expect(verifier.audience).toBe('test-audience-12345');
    });

    it('should throw if env is missing required fields', () => {
      expect(() => createZeroTrustVerifier({})).toThrow('TEAM_DOMAIN not configured');
      expect(() => createZeroTrustVerifier({ TEAM_DOMAIN: 'https://test.com' }))
        .toThrow('POLICY_AUD not configured');
    });
  });

  describe('getZeroTrustVerifier', () => {
    it('reuses the verifier for the same issuer and audience', () => {
      expect(getZeroTrustVerifier(mockEnv)).toBe(getZeroTrustVerifier({ ...mockEnv }));
    });

    it('keeps policies with different audiences isolated', () => {
      expect(getZeroTrustVerifier(mockEnv)).not.toBe(getZeroTrustVerifier({
        ...mockEnv,
        POLICY_AUD: 'different-audience'
      }));
    });
  });
});
