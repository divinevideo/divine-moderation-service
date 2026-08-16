// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Reality Defender response normalizer
// ABOUTME: Verifies multi-provider score aggregation and consensus logic

import { describe, it, expect } from 'vitest';
import { normalizeRealnessResponse } from './normalizer.mjs';

describe('Reality Defender Normalizer', () => {
  describe('Score Aggregation', () => {
    it('should use max score across providers', () => {
      const job = {
        event_id: 'test-job',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.85 },
          hive: { status: 'complete', score: 0.72 },
          sensity: { status: 'complete', score: 0.23 }
        }
      };

      const result = normalizeRealnessResponse(job);

      // Max score is 0.85 from Reality Defender
      expect(result.scores.ai_generated).toBe(0.85);
    });

    it('should calculate deepfake from specialized providers', () => {
      const job = {
        event_id: 'test-job',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.6 },
          hive: { status: 'complete', score: 0.9 }, // Hive focuses on AI-generated
          sensity: { status: 'complete', score: 0.7 }
        }
      };

      const result = normalizeRealnessResponse(job);

      // ai_generated uses max across all = 0.9
      expect(result.scores.ai_generated).toBe(0.9);
      // deepfake uses max of Reality Defender and Sensity = 0.7
      expect(result.scores.deepfake).toBe(0.7);
    });

    it('should handle partial results', () => {
      const job = {
        event_id: 'test-job',
        status: 'processing',
        results: {
          reality_defender: { status: 'complete', score: 0.5 },
          hive: { status: 'pending' },
          sensity: { status: 'error', error: 'Timeout' }
        }
      };

      const result = normalizeRealnessResponse(job);

      // Only Reality Defender has a score
      expect(result.scores.ai_generated).toBe(0.5);
      expect(result.details.ai_detection.provider_count).toBe(1);
    });

    it('should return zero scores when no results', () => {
      const job = {
        event_id: 'test-job',
        status: 'error',
        error: 'All providers failed'
      };

      const result = normalizeRealnessResponse(job);

      expect(result.scores.ai_generated).toBe(0);
      expect(result.scores.deepfake).toBe(0);
      // Error message is preserved from the job
      expect(result.metadata.error).toBe('All providers failed');
    });
  });

  describe('Consensus Logic', () => {
    it('should identify unanimous AUTHENTIC', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.1 },
          hive: { status: 'complete', score: 0.15 },
          sensity: { status: 'complete', score: 0.2 }
        }
      };

      const result = normalizeRealnessResponse(job);

      expect(result.details.ai_detection.consensus.verdict).toBe('AUTHENTIC');
      expect(result.details.ai_detection.consensus.confidence).toBe('high');
      expect(result.details.ai_detection.consensus.agreement).toBe('unanimous');
    });

    it('should identify unanimous LIKELY_AI', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.85 },
          hive: { status: 'complete', score: 0.9 },
          sensity: { status: 'complete', score: 0.75 }
        }
      };

      const result = normalizeRealnessResponse(job);

      expect(result.details.ai_detection.consensus.verdict).toBe('LIKELY_AI');
      expect(result.details.ai_detection.consensus.confidence).toBe('high');
      expect(result.details.ai_detection.consensus.agreement).toBe('unanimous');
    });

    it('should identify majority agreement', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.8 },
          hive: { status: 'complete', score: 0.75 },
          sensity: { status: 'complete', score: 0.25 } // Disagrees
        }
      };

      const result = normalizeRealnessResponse(job);

      expect(result.details.ai_detection.consensus.verdict).toBe('LIKELY_AI');
      expect(result.details.ai_detection.consensus.confidence).toBe('medium');
      expect(result.details.ai_detection.consensus.agreement).toBe('majority');
    });

    it('should identify split decision', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.2 },  // AUTHENTIC
          hive: { status: 'complete', score: 0.5 },              // UNCERTAIN
          sensity: { status: 'complete', score: 0.8 }            // LIKELY_AI
        }
      };

      const result = normalizeRealnessResponse(job);

      expect(result.details.ai_detection.consensus.verdict).toBe('UNCERTAIN');
      expect(result.details.ai_detection.consensus.confidence).toBe('low');
      expect(result.details.ai_detection.consensus.agreement).toBe('split');
    });
  });

  describe('Provider Details', () => {
    it('should extract per-provider status and verdict', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: {
            status: 'complete',
            score: 0.85,
            verdict: 'LIKELY_AI',
            raw: { result: { details: { face_swap: 0.1 } } }
          },
          hive: {
            status: 'complete',
            score: 0.72,
            raw: { result: { ai_generated_score: 0.72 } }
          },
          sensity: {
            status: 'error',
            error: 'Video too short'
          }
        }
      };

      const result = normalizeRealnessResponse(job);

      const providers = result.details.ai_detection.providers;

      expect(providers.reality_defender.status).toBe('complete');
      expect(providers.reality_defender.verdict).toBe('LIKELY_AI');
      expect(providers.reality_defender.breakdown.face_swap).toBe(0.1);

      expect(providers.hive.status).toBe('complete');
      expect(providers.hive.breakdown.ai_generated_score).toBe(0.72);

      expect(providers.sensity.status).toBe('error');
      expect(providers.sensity.error).toBe('Video too short');
    });
  });

  describe('Content Moderation Scores', () => {
    it('should return zero for all content moderation categories', () => {
      const job = {
        event_id: 'test',
        status: 'complete',
        results: {
          reality_defender: { status: 'complete', score: 0.9 }
        }
      };

      const result = normalizeRealnessResponse(job);

      // Reality Defender only does AI detection, not content moderation
      expect(result.scores.nudity).toBe(0);
      expect(result.scores.violence).toBe(0);
      expect(result.scores.gore).toBe(0);
      expect(result.scores.offensive).toBe(0);
      expect(result.scores.weapons).toBe(0);
      expect(result.scores.drugs).toBe(0);
      expect(result.scores.alcohol).toBe(0);
      expect(result.scores.tobacco).toBe(0);
      expect(result.scores.gambling).toBe(0);
      expect(result.scores.selfHarm).toBe(0);
    });
  });

  describe('Metadata', () => {
    it('should include job metadata', () => {
      const job = {
        event_id: 'event-123',
        media_hash: 'sha256-abc',
        status: 'complete',
        submitted: '2024-01-15T10:00:00Z',
        completed: '2024-01-15T10:00:30Z',
        results: {
          reality_defender: { status: 'complete', score: 0.5 }
        }
      };

      const result = normalizeRealnessResponse(job);

      expect(result.metadata.job_id).toBe('event-123');
      expect(result.metadata.media_hash).toBe('sha256-abc');
      expect(result.metadata.submitted).toBe('2024-01-15T10:00:00Z');
      expect(result.metadata.completed).toBe('2024-01-15T10:00:30Z');
    });
  });
});
