// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Reality Defender provider adapter
// ABOUTME: Verifies provider configuration, moderation flow, and skip logic

import { describe, it, expect, vi } from 'vitest';
import { RealityDefenderProvider } from './adapter.mjs';

describe('Reality Defender Provider', () => {
  describe('Configuration', () => {
    it('should have correct provider name', () => {
      const provider = new RealityDefenderProvider();
      expect(provider.name).toBe('reality-defender');
    });

    it('should be configured by default', () => {
      const provider = new RealityDefenderProvider();
      expect(provider.isConfigured({})).toBe(true);
    });

    it('should be disabled when REALNESS_API_ENABLED is false', () => {
      const provider = new RealityDefenderProvider();
      expect(provider.isConfigured({ REALNESS_API_ENABLED: 'false' })).toBe(false);
    });

    it('should declare AI detection capabilities', () => {
      const provider = new RealityDefenderProvider();

      expect(provider.capabilities.aiGenerated).toBe(true);
      expect(provider.capabilities.deepfake).toBe(true);
      expect(provider.capabilities.multiProvider).toBe(true);
    });

    it('should NOT declare content moderation capabilities', () => {
      const provider = new RealityDefenderProvider();

      expect(provider.capabilities.nudity).toBe(false);
      expect(provider.capabilities.violence).toBe(false);
      expect(provider.capabilities.gore).toBe(false);
    });
  });

  describe('Moderation', () => {
    it('should return results from realness API', async () => {
      const provider = new RealityDefenderProvider();

      const mockJob = {
        event_id: 'test-123',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.85, verdict: 'LIKELY_AI' },
          hive: { status: 'complete', score: 0.72, verdict: 'LIKELY_AI' },
          sensity: { status: 'complete', score: 0.23, verdict: 'AUTHENTIC' }
        }
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockJob)
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/video.mp4',
        { sha256: 'abc123' },
        {},
        { fetchFn: mockFetch }
      );

      expect(result.provider).toBe('reality-defender');
      expect(result.scores.ai_generated).toBe(0.85);
      expect(result.processingTime).toBeGreaterThan(0);
    });

    it('should skip AI detection for original Vines', async () => {
      const provider = new RealityDefenderProvider();

      const result = await provider.moderate(
        'https://cdn.divine.video/vine.mp4',
        { sha256: 'vine123' },
        {},
        { skipAIDetection: true }
      );

      expect(result.scores.ai_generated).toBe(0);
      expect(result.scores.deepfake).toBe(0);
      expect(result.details.skipped).toBe(true);
      expect(result.details.reason).toBe('original_vine');
    });

    it('should include consensus in results', async () => {
      const provider = new RealityDefenderProvider();

      const mockJob = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.1 },
          hive: { status: 'complete', score: 0.15 },
          sensity: { status: 'complete', score: 0.08 }
        }
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockJob)
      });

      const result = await provider.moderate(
        'https://cdn.divine.video/authentic.mp4',
        { sha256: 'auth' },
        {},
        { fetchFn: mockFetch }
      );

      expect(result.details.ai_detection.consensus.verdict).toBe('AUTHENTIC');
      expect(result.details.ai_detection.consensus.confidence).toBe('high');
    });

    it('should throw on API failure', async () => {
      const provider = new RealityDefenderProvider();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server Error')
      });

      await expect(
        provider.moderate(
          'https://cdn.divine.video/fail.mp4',
          { sha256: 'fail' },
          {},
          { fetchFn: mockFetch }
        )
      ).rejects.toThrow('Reality Defender analysis failed');
    });
  });

  describe('Provider Info', () => {
    it('should return detailed provider information', () => {
      const provider = new RealityDefenderProvider();
      const info = provider.getInfo();

      expect(info.name).toBe('reality-defender');
      expect(info.displayName).toBe('Reality Defender (Multi-Provider)');
      expect(info.providers).toHaveLength(3);

      const providerNames = info.providers.map(p => p.name);
      expect(providerNames).toContain('reality_defender');
      expect(providerNames).toContain('hive');
      expect(providerNames).toContain('sensity');
    });

    it('should document verdict thresholds', () => {
      const provider = new RealityDefenderProvider();
      const info = provider.getInfo();

      expect(info.verdictThresholds.AUTHENTIC).toBe('score < 0.3');
      expect(info.verdictThresholds.UNCERTAIN).toBe('0.3 <= score < 0.7');
      expect(info.verdictThresholds.LIKELY_AI).toBe('score >= 0.7');
    });
  });
});
