// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for VLM classification and topic extraction integration in moderation pipeline
// ABOUTME: Verifies that classification runs in parallel with moderation and results flow through

import { describe, it, expect, vi } from 'vitest';
import { classifyVideoOnly, moderateVideo } from './pipeline.mjs';

/** Build a mock VLM chat completion response. */
function mockVLMChatCompletion(content = {}) {
  return {
    id: 'task_123',
    object: 'chat.completion',
    model: 'hive/vision-language-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify({
          topics: ['sports'],
          setting: 'beach outdoor',
          objects: ['surfboard'],
          activities: ['surfing'],
          mood: 'exciting',
          description: 'A person surfing at the beach.',
          ...content
        })
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 1818, completion_tokens: 64, total_tokens: 1882 }
  };
}

// Helper: build a mock fetch that handles both moderation API and VTT requests
function buildMockFetch({ moderationResponse, vttText, vttStatus = 200, classificationResponse }) {
  return vi.fn(async (url, opts) => {
    // VTT transcript request
    if (typeof url === 'string' && url.endsWith('.vtt')) {
      if (vttStatus === 404) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return {
        ok: vttStatus === 200,
        status: vttStatus,
        text: async () => vttText || ''
      };
    }

    // Hive VLM API request (V3 chat/completions - POST with JSON body)
    if (typeof url === 'string' && url.includes('api.thehive.ai') && url.includes('v3') && classificationResponse) {
      return {
        ok: true,
        json: async () => classificationResponse
      };
    }

    // Hive VLM API request (detect by JSON body containing model field)
    if (typeof url === 'string' && url.includes('api.thehive.ai') && classificationResponse) {
      // Check if this is a VLM request by looking at the body
      if (opts?.body) {
        try {
          const body = JSON.parse(opts.body);
          if (body.model === 'hive/vision-language-model') {
            return {
              ok: true,
              json: async () => classificationResponse
            };
          }
        } catch {
          // Not JSON body, not VLM request
        }
      }
    }

    // Default: moderation API (Sightengine fallback)
    return {
      ok: true,
      json: async () => moderationResponse || {
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } },
            { info: { position: 3 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } }
          ]
        }
      }
    };
  });
}

describe('Pipeline Classification Integration', () => {
  const baseEnv = {
    SIGHTENGINE_API_USER: 'test-user',
    SIGHTENGINE_API_SECRET: 'test-secret',
    CDN_DOMAIN: 'cdn.divine.video'
  };

  const sha256 = 'a'.repeat(64);

  describe('classifyVideoOnly', () => {
    it('should skip Hive VLM and return local transcript topics only', async () => {
      const hiveCalls = [];
      const mockFetch = vi.fn(async (url) => {
        const urlString = String(url);
        if (urlString.includes('api.thehive.ai')) {
          hiveCalls.push(urlString);
          throw new Error(`Unexpected Hive call: ${urlString}`);
        }
        if (urlString.endsWith('.vtt')) {
          return {
            ok: true,
            status: 200,
            text: async () => 'WEBVTT\n\n00:00.000 --> 00:01.000\nA guitar tutorial with melody and chords.'
          };
        }
        throw new Error(`Unexpected fetch call: ${urlString}`);
      });

      const result = await classifyVideoOnly(sha256, {
        CDN_DOMAIN: 'cdn.divine.video',
        HIVE_VLM_API_KEY: 'vlm-key'
      }, { fetchFn: mockFetch });

      expect(result.sceneClassification).toBeNull();
      expect(result.topicProfile).not.toBeNull();
      expect(result.topicProfile.primary_topic).toBe('music');
      expect(hiveCalls).toEqual([]);
    });
  });

  describe('sceneClassification field', () => {
    it('should return null sceneClassification when HIVE_VLM_API_KEY not set', async () => {
      const mockFetch = buildMockFetch({ vttStatus: 404 });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.sceneClassification).toBeNull();
      expect(result.action).toBeDefined();
    });

    it('should skip Hive sceneClassification in upload moderation even when HIVE_VLM_API_KEY is set', async () => {
      const classificationResponse = mockVLMChatCompletion({
        topics: ['sports'],
        setting: 'beach outdoor',
        objects: ['person'],
        activities: ['surfing'],
        mood: 'exciting',
        description: 'Surfing at the beach.'
      });

      const mockFetch = buildMockFetch({ vttStatus: 404, classificationResponse });

      const env = {
        ...baseEnv,
        HIVE_VLM_API_KEY: 'test-vlm-key'
      };

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        env,
        mockFetch
      );

      expect(result.action).toBe('REVIEW');
      expect(result.provider).toBe('manual-review');
      expect(result.sceneClassification).toBeNull();

      const hiveCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('api.thehive.ai'));
      expect(hiveCalls).toHaveLength(0);
    });

    it('should not break moderation when scene classification fails', async () => {
      // A fetch that returns errors for VLM API but works for moderation
      const mockFetch = vi.fn(async (url, opts) => {
        if (typeof url === 'string' && url.includes('api.thehive.ai')) {
          return { ok: false, status: 500, text: async () => 'Internal Server Error' };
        }
        if (typeof url === 'string' && url.endsWith('.vtt')) {
          return { ok: false, status: 404 };
        }
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: {
              frames: [
                { info: { position: 0 }, nudity: { raw: 0.1, safe: 0.9 }, violence: { prob: 0.05 } }
              ]
            }
          })
        };
      });

      const env = {
        ...baseEnv,
        HIVE_VLM_API_KEY: 'test-vlm-key'
      };

      // Should NOT throw even though classification fails
      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        env,
        mockFetch
      );

      // Moderation should still succeed
      expect(result.action).toBeDefined();
      expect(result.scores).toBeDefined();
      // Scene classification should be null because it failed
      expect(result.sceneClassification).toBeNull();
    });
  });

  describe('topicProfile field', () => {
    it('should return null topicProfile when no VTT is available', async () => {
      const mockFetch = buildMockFetch({ vttStatus: 404 });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.topicProfile).toBeNull();
    });

    it('should extract topics from VTT transcript text', async () => {
      const vttText = `WEBVTT

00:00:00.000 --> 00:00:05.000
Today I'm going to show you this amazing guitar tutorial

00:00:05.000 --> 00:00:10.000
We'll learn how to play a song on the acoustic guitar with a melody`;

      const mockFetch = buildMockFetch({ vttText });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.topicProfile).not.toBeNull();
      expect(result.topicProfile.topics).toBeDefined();
      expect(Array.isArray(result.topicProfile.topics)).toBe(true);
      expect(result.topicProfile.has_speech).toBe(true);
      // Should detect music topic from guitar/song/melody keywords
      expect(result.topicProfile.primary_topic).toBe('music');
    });

    it('should return null topicProfile for empty VTT transcript', async () => {
      const vttText = `WEBVTT

`;

      const mockFetch = buildMockFetch({ vttText });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      // Empty VTT text means no topic extraction
      expect(result.topicProfile).toBeNull();
    });

    it('should extract education topic from tutorial-style content', async () => {
      const vttText = `WEBVTT

00:00:00.000 --> 00:00:05.000
In this tutorial I'm going to teach you step by step

00:00:05.000 --> 00:00:10.000
how to learn the basics so you can understand this concept`;

      const mockFetch = buildMockFetch({ vttText });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.topicProfile).not.toBeNull();
      expect(result.topicProfile.primary_topic).toBe('education');
    });
  });

  describe('videoseal field', () => {
    it('should attach the interpreted Video Seal signal without changing manual review flow', async () => {
      const payload = `01${'c'.repeat(62)}`;
      const mockFetch = buildMockFetch({ vttStatus: 404 });

      const result = await moderateVideo(
        {
          sha256,
          uploadedAt: Date.now(),
          videoSealPayload: payload,
          videoSealBitAccuracy: 0.9
        },
        baseEnv,
        mockFetch
      );

      expect(result.action).toBe('REVIEW');
      expect(result.provider).toBe('manual-review');
      expect(result.videoseal).toEqual({
        signal: 'videoseal',
        detected: true,
        source: 'divine',
        isAI: false,
        payload,
        confidence: 0.9
      });
    });
  });

  describe('manual review enrichment', () => {
    it('should return local topic and text results while skipping Hive scene classification', async () => {
      const vttText = `WEBVTT

00:00:00.000 --> 00:00:05.000
This is a funny joke about comedy and stand-up`;

      const classificationResponse = mockVLMChatCompletion({
        topics: ['comedy', 'entertainment'],
        setting: 'concert hall',
        objects: ['microphone', 'stage'],
        activities: ['performing', 'stand-up comedy'],
        mood: 'humorous',
        description: 'A comedian performs stand-up comedy on stage.'
      });

      const mockFetch = buildMockFetch({ vttText, classificationResponse });

      const env = {
        ...baseEnv,
        HIVE_VLM_API_KEY: 'test-vlm-key'
      };

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        env,
        mockFetch
      );

      expect(result.action).toBe('REVIEW');
      expect(result.provider).toBe('manual-review');
      expect(result.scores).toEqual({});
      expect(result.sceneClassification).toBeNull();
      expect(result.topicProfile).not.toBeNull();
      expect(result.topicProfile.primary_topic).toBe('comedy');
      expect(result.text_scores).not.toBeNull();

      const hiveCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('api.thehive.ai'));
      expect(hiveCalls).toHaveLength(0);
    });
  });

  describe('manual review moderation result', () => {
    it('should route upload moderation to REVIEW', async () => {
      const mockFetch = buildMockFetch({ vttStatus: 404 });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.action).toBe('REVIEW');
      expect(result.provider).toBe('manual-review');
      expect(result.severity).toBe('medium');
      expect(result.sha256).toBe(sha256);
    });

    it('should leave rawClassifierData null because no provider classifier runs', async () => {
      const mockFetch = buildMockFetch({ vttStatus: 404 });

      const result = await moderateVideo(
        { sha256, uploadedAt: Date.now() },
        baseEnv,
        mockFetch
      );

      expect(result.rawClassifierData).toBeNull();
    });
  });
});
