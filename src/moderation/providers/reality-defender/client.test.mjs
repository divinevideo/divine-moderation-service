// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Reality Defender client (realness.divine.video API)
// ABOUTME: Verifies job submission, polling, and result retrieval

import { describe, it, expect, vi } from 'vitest';
import {
  submitVideoForAnalysis,
  getJobResults,
  analyzeVideoWithRealness
} from './client.mjs';

describe('Reality Defender Client', () => {
  describe('submitVideoForAnalysis', () => {
    it('should submit video to realness API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          jobId: 'job-123',
          status: 'pending'
        })
      });

      const result = await submitVideoForAnalysis(
        'https://cdn.divine.video/abc123.mp4',
        { sha256: 'abc123', eventId: 'event-456' },
        {},
        { fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://realness.divine.video/analyze',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoUrl: 'https://cdn.divine.video/abc123.mp4',
            mediaHash: 'abc123',
            eventId: 'event-456'
          })
        })
      );

      expect(result.jobId).toBe('job-123');
    });

    it('should throw on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      });

      await expect(
        submitVideoForAnalysis(
          'https://cdn.divine.video/abc.mp4',
          { sha256: 'abc' },
          {},
          { fetchFn: mockFetch }
        )
      ).rejects.toThrow('Realness API error 500');
    });
  });

  describe('getJobResults', () => {
    it('should fetch job results by ID', async () => {
      const mockJob = {
        event_id: 'job-123',
        status: 'complete',
        results: {
          reality_defender: { score: 0.85, verdict: 'LIKELY_AI' },
          hive: { score: 0.72, verdict: 'LIKELY_AI' },
          sensity: { score: 0.23, verdict: 'AUTHENTIC' }
        }
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockJob)
      });

      const result = await getJobResults('job-123', {}, { fetchFn: mockFetch });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://realness.divine.video/api/jobs/job-123',
        expect.objectContaining({
          method: 'GET'
        })
      );

      expect(result.status).toBe('complete');
      expect(result.results.reality_defender.score).toBe(0.85);
    });

    it('should throw on 404', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found')
      });

      await expect(
        getJobResults('nonexistent', {}, { fetchFn: mockFetch })
      ).rejects.toThrow('Job not found: nonexistent');
    });
  });

  describe('analyzeVideoWithRealness', () => {
    it('should return immediately if job already complete', async () => {
      const completeJob = {
        jobId: 'cached-job',
        status: 'complete',
        results: {
          reality_defender: { score: 0.1, verdict: 'AUTHENTIC' },
          hive: { score: 0.15, verdict: 'AUTHENTIC' },
          sensity: { score: 0.08, verdict: 'AUTHENTIC' }
        }
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(completeJob)
      });

      const result = await analyzeVideoWithRealness(
        'https://cdn.divine.video/cached.mp4',
        { sha256: 'cached' },
        {},
        { fetchFn: mockFetch, maxWaitMs: 5000 }
      );

      // Should only call submit, not poll
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('complete');
    });

    it('should poll until complete', async () => {
      const pendingJob = { event_id: 'poll-job', status: 'pending', results: {} };
      const processingJob = { event_id: 'poll-job', status: 'processing', results: {} };
      const completeJob = {
        event_id: 'poll-job',
        status: 'complete',
        results: {
          reality_defender: { score: 0.5, verdict: 'UNCERTAIN' }
        }
      };

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url) => {
        callCount++;
        // First call: submit
        if (url.includes('/analyze')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ jobId: 'poll-job', status: 'pending' })
          });
        }
        // Subsequent calls: poll
        if (callCount === 2) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(pendingJob)
          });
        }
        if (callCount === 3) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(processingJob)
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(completeJob)
        });
      });

      const result = await analyzeVideoWithRealness(
        'https://cdn.divine.video/poll.mp4',
        { sha256: 'poll' },
        {},
        { fetchFn: mockFetch, maxWaitMs: 30000, pollIntervalMs: 10 }
      );

      expect(result.status).toBe('complete');
      expect(callCount).toBeGreaterThan(1);
    });
  });
});
