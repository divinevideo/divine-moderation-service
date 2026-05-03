// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for full moderation pipeline orchestration
// ABOUTME: Verifies end-to-end flow from video URL to classified result

import { afterEach, describe, it, expect, vi } from 'vitest';
import { moderateVideo } from './pipeline.mjs';

const OriginalWebSocket = globalThis.WebSocket;

function createNostrLookupWebSocket(event) {
  return class FakeWebSocket {
    constructor() {
      this.listeners = {};
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    }

    send(message) {
      const [, subscriptionId] = JSON.parse(message);
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify(['EVENT', subscriptionId, event]) });
        this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
      });
    }

    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }

    emit(type, payload = {}) {
      for (const handler of this.listeners[type] || []) {
        handler(payload);
      }
    }
  };
}

function createEmptyNostrLookupWebSocket() {
  return class FakeWebSocket {
    constructor() {
      this.listeners = {};
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }

    addEventListener(type, handler) {
      if (!this.listeners[type]) {
        this.listeners[type] = [];
      }
      this.listeners[type].push(handler);
    }

    send(message) {
      const [, subscriptionId] = JSON.parse(message);
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify(['EOSE', subscriptionId]) });
      });
    }

    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }

    emit(type, payload = {}) {
      for (const handler of this.listeners[type] || []) {
        handler(payload);
      }
    }
  };
}

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('Moderation Pipeline', () => {
  it('defaults new videos to playable manual review without calling Hive', async () => {
    const hiveCalls = [];
    const mockFetch = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes('api.thehive.ai')) {
        hiveCalls.push(urlString);
        throw new Error(`Unexpected Hive call: ${urlString}`);
      }
      if (urlString.endsWith('.vtt')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      throw new Error(`Unexpected fetch call: ${urlString}`);
    });

    const env = {
      CDN_DOMAIN: 'cdn.divine.video',
      HIVE_MODERATION_API_KEY: 'mod-key',
      HIVE_API_KEY: 'ai-key',
      HIVE_VLM_API_KEY: 'vlm-key'
    };

    const result = await moderateVideo({
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.reason).toContain('Team review required');
    expect(result.rawClassifierData).toBeNull();
    expect(result.sceneClassification).toBeNull();
    expect(result.scores).toEqual({});
    expect(hiveCalls).toEqual([]);
  });

  it('keeps local transcript topic extraction in manual review mode', async () => {
    const mockFetch = vi.fn(async (url) => {
      const urlString = String(url);
      if (urlString.includes('api.thehive.ai')) {
        throw new Error(`Unexpected Hive call: ${urlString}`);
      }
      if (urlString.endsWith('.vtt')) {
        return {
          ok: true,
          status: 200,
          text: async () => 'WEBVTT\n\n00:00.000 --> 00:01.000\nSkateboarding downtown with music.'
        };
      }
      throw new Error(`Unexpected fetch call: ${urlString}`);
    });

    const result = await moderateVideo({
      sha256: 'b'.repeat(64),
      uploadedAt: Date.now()
    }, { CDN_DOMAIN: 'cdn.divine.video', HIVE_VLM_API_KEY: 'vlm-key' }, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.topicProfile).not.toBeNull();
    expect(result.topicProfile.has_speech).toBe(true);
    expect(result.sceneClassification).toBeNull();
  });

  it('returns playable manual review for new uploads even when Sightengine is configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.1 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.03 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'a'.repeat(64),
      r2Key: 'videos/test.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.severity).toBe('medium');
    expect(result.scores).toEqual({});
    expect(result.sceneClassification).toBeNull();
    expect(result.rawClassifierData).toBeNull();
  });

  it('skips transcript analysis while Blossom reports VTT generation is pending', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: true,
          status: 202,
          headers: {
            get(name) {
              return name === 'Retry-After' ? '12' : null;
            }
          },
          text: async () => '{"status":"processing"}'
        };
      }

      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.05 } }
            ]
          }
        })
      };
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'c'.repeat(64),
      r2Key: 'videos/pending-transcript.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.text_scores).toBeNull();
    expect(result.topicProfile).toBeNull();
  });

  it('does not call Hive for benign nudity signals that used to be provider-scored', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: false,
          status: 404,
          text: async () => ''
        };
      }

      if (typeof url === 'string' && url.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [
                      { class: 'yes_male_nudity', score: 0.91 },
                      { class: 'yes_male_swimwear', score: 0.88 },
                      { class: 'yes_male_underwear', score: 0.83 }
                    ]
                  }
                ]
              }
            }]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    });

    const env = {
      HIVE_MODERATION_API_KEY: 'mod-key',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'b'.repeat(64),
      r2Key: 'videos/shirtless.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.provider).toBe('manual-review');
    expect(result.action).toBe('REVIEW');
    expect(result.scores).toEqual({});
    expect(result.downstreamSignals?.hasSignals).toBe(false);
  });

  it('does not call Hive for sexual-content signals that now require team review', async () => {
    const mockFetch = vi.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: false,
          status: 404,
          text: async () => ''
        };
      }

      if (typeof url === 'string' && url.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [
                      { class: 'yes_sexual_display', score: 0.9 },
                      { class: 'yes_sex_toy', score: 0.82 }
                    ]
                  }
                ]
              }
            }]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    });

    const env = {
      HIVE_MODERATION_API_KEY: 'mod-key',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'n'.repeat(64),
      r2Key: 'videos/sexual-display.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.provider).toBe('manual-review');
    expect(result.action).toBe('REVIEW');
    expect(result.category).toBe('manual_review');
    expect(result.scores).toEqual({});
  });

  it('should detect borderline violence and return REVIEW', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.65 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.55 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.6 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'c'.repeat(64),
      r2Key: 'videos/borderline.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.severity).toBe('medium');
    expect(result.provider).toBe('manual-review');
    expect(result.downstreamSignals?.primaryConcern).toBeNull();
  });

  it('routes high-violence provider scenarios to playable team review', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          frames: [
            { info: { position: 0 }, nudity: { raw: 0.1, partial: 0.05, safe: 0.85 }, violence: { prob: 0.82 } },
            { info: { position: 3 }, nudity: { raw: 0.15, partial: 0.1, safe: 0.75 }, violence: { prob: 0.75 } },
            { info: { position: 6 }, nudity: { raw: 0.05, partial: 0.03, safe: 0.92 }, violence: { prob: 0.78 } }
          ]
        }
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'v'.repeat(64),
      r2Key: 'videos/violent.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.severity).toBe('medium');
    expect(result.category).toBe('manual_review');
  });

  it('should construct correct CDN URL from sha256', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { frames: [
          { info: { position: 0 }, nudity: { raw: 0.1, safe: 0.9 }, violence: { prob: 0.05 } }
        ]}
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const sha256 = 'd'.repeat(64);
    const result = await moderateVideo({
      sha256,
      r2Key: 'videos/test.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.cdnUrl).toBe(`https://cdn.divine.video/${sha256}`);
  });

  it('should include metadata in result', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { frames: [
          { info: { position: 0 }, nudity: { raw: 0.1, safe: 0.9 }, violence: { prob: 0.05 } }
        ]}
      })
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const uploadedAt = Date.now();
    const result = await moderateVideo({
      sha256: 'e'.repeat(64),
      r2Key: 'videos/test.mp4',
      uploadedBy: 'f'.repeat(64),
      uploadedAt,
      metadata: { fileSize: 1024000 }
    }, env, mockFetch);

    expect(result.sha256).toBe('e'.repeat(64));
    expect(result.uploadedBy).toBe('f'.repeat(64));
    expect(result.uploadedAt).toBe(uploadedAt);
  });

  it('does not fail upload moderation when external provider-style fetches fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256: 'g'.repeat(64),
      r2Key: 'videos/test.mp4',
      uploadedAt: Date.now()
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
  });

  it('should require CDN_DOMAIN configuration', async () => {
    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret'
    };

    await expect(
      moderateVideo({
        sha256: 'h'.repeat(64),
        r2Key: 'videos/test.mp4',
        uploadedAt: Date.now()
      }, env)
    ).rejects.toThrow('CDN_DOMAIN not configured');
  });

  it('keeps imported original Vine context while routing to team review', async () => {
    const sha256 = 'c'.repeat(64);
    globalThis.WebSocket = createNostrLookupWebSocket({
      id: 'evt-original-vine',
      content: 'classic archive vine',
      created_at: 1700000000,
      tags: [
        ['d', sha256],
        ['platform', 'vine'],
        ['r', 'https://vine.co/v/abc123']
      ]
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              {
                info: { position: 0 },
                nudity: { raw: 0.05, partial: 0.03, safe: 0.92 },
                violence: { prob: 0.02 },
                type: { ai_generated: 0.96 }
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => ''
      });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256,
      uploadedAt: Date.now(),
      metadata: { videoUrl: 'https://archive.example.com/original-vine.mp4' }
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.policyContext?.originalVine).toBe(true);
    expect(result.policyContext?.enforcementOverridden).toBe(false);
    expect(result.scores).toEqual({});
    expect(result.downstreamSignals?.hasSignals).toBe(false);
  });

  it('does not call Hive when legacy queue metadata identifies an original Vine', async () => {
    const sha256 = 'k'.repeat(64);
    globalThis.WebSocket = createEmptyNostrLookupWebSocket();

    const hiveAuthCalls = [];
    const mockFetch = vi.fn(async (url, options = {}) => {
      if (typeof url === 'string' && url.endsWith('.vtt')) {
        return {
          ok: false,
          status: 404,
          text: async () => ''
        };
      }

      if (typeof url === 'string' && url.includes('api.thehive.ai')) {
        hiveAuthCalls.push(options.headers?.authorization || null);
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [{
                  time: 0,
                  classes: [
                    { class: 'general_nsfw', score: 0.05 },
                    { class: 'ai_generated', score: 0.96 }
                  ]
                }]
              }
            }]
          })
        };
      }

      throw new Error(`Unexpected fetch call: ${String(url)}`);
    });

    const env = {
      CDN_DOMAIN: 'cdn.divine.video',
      HIVE_MODERATION_API_KEY: 'mod-key',
      HIVE_AI_DETECTION_API_KEY: 'ai-key'
    };

    const result = await moderateVideo({
      sha256,
      uploadedAt: Date.now(),
      metadata: {
        source: 'archive-export',
        videoUrl: 'https://archive.example.com/original-vine.mp4',
        platform: 'vine',
        source_url: 'https://vine.co/v/abc123',
        published_at: 1389756506
      }
    }, env, mockFetch);

    expect(hiveAuthCalls).toEqual([]);
    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.policyContext?.originalVine).toBe(true);
  });

  it('keeps original Vine policy context without provider downstream signals', async () => {
    const sha256 = 'd'.repeat(64);
    globalThis.WebSocket = createNostrLookupWebSocket({
      id: 'evt-original-vine-signals',
      content: 'classic archive vine',
      created_at: 1700000000,
      tags: [
        ['d', sha256],
        ['platform', 'vine']
      ]
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            frames: [
              {
                info: { position: 0 },
                nudity: { raw: 0.86, partial: 0.2, safe: 0.1 },
                violence: { prob: 0.15 },
                type: { ai_generated: 0.82 }
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        status: 404,
        ok: false,
        text: async () => ''
      });

    const env = {
      SIGHTENGINE_API_USER: 'test-user',
      SIGHTENGINE_API_SECRET: 'test-secret',
      CDN_DOMAIN: 'cdn.divine.video'
    };

    const result = await moderateVideo({
      sha256,
      uploadedAt: Date.now(),
      metadata: { videoUrl: 'https://archive.example.com/original-vine-nudity.mp4' }
    }, env, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.policyContext?.originalVine).toBe(true);
    expect(result.scores).toEqual({});
    expect(result.downstreamSignals?.hasSignals).toBe(false);
    expect(result.downstreamSignals?.primaryConcern).toBeNull();
  });
});

describe('Moderation Pipeline — C2PA / ProofMode review context', () => {
  function buildMockFetch({ inquisitor, hive = null, vtt404 = true }) {
    return vi.fn(async (url) => {
      const urlStr = String(url);

      if (urlStr.includes('inquisitor.divine.video/verify')) {
        return {
          ok: true,
          json: async () => inquisitor,
          text: async () => JSON.stringify(inquisitor),
        };
      }

      if (vtt404 && urlStr.endsWith('.vtt')) {
        return { ok: false, status: 404, text: async () => '' };
      }

      if (urlStr.includes('api.thehive.ai') && hive) {
        return {
          ok: true,
          json: async () => hive,
        };
      }

      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });
  }

  const baseEnv = {
    HIVE_MODERATION_API_KEY: 'mod-key',
    HIVE_AI_DETECTION_API_KEY: 'ai-key',
    CDN_DOMAIN: 'cdn.divine.video',
    INQUISITOR_BASE_URL: 'https://inquisitor.divine.video',
  };

  it('routes valid_ai_signed content to playable team review and never calls Hive', async () => {
    const mockFetch = buildMockFetch({
      inquisitor: {
        has_c2pa: true,
        valid: true,
        validation_state: 'valid',
        is_proofmode: false,
        claim_generator: 'Adobe Firefly 2.0',
        assertions: ['c2pa.hash.data'],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      },
    });

    const result = await moderateVideo({
      sha256: 'a'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.category).toBe('manual_review');
    expect(result.provider).toBe('manual-review');
    expect(result.reason).toContain('Team review required');
    expect(result.requiresSecondaryVerification).toBe(false);
    expect(result.c2pa?.state).toBe('valid_ai_signed');
    expect(result.c2pa?.claimGenerator).toContain('Adobe Firefly');
    expect(result.policyContext?.overrideReason).toBeNull();

    const hiveCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('api.thehive.ai'));
    expect(hiveCalls).toHaveLength(0);
  });

  it('keeps valid_proofmode context and skips Hive entirely', async () => {
    const hiveAuthCalls = [];
    const mockFetch = vi.fn(async (url, options = {}) => {
      const urlStr = String(url);

      if (urlStr.includes('inquisitor.divine.video/verify')) {
        return {
          ok: true,
          json: async () => ({
            has_c2pa: true,
            valid: true,
            validation_state: 'valid',
            is_proofmode: true,
            claim_generator: 'ProofMode/1.1.9 Android/14',
            assertions: [],
            actions: [],
            ingredients: [],
            verified_at: '2026-04-17T10:00:00Z',
          }),
        };
      }

      if (urlStr.endsWith('.vtt')) {
        return { ok: false, status: 404, text: async () => '' };
      }

      if (urlStr.includes('api.thehive.ai')) {
        hiveAuthCalls.push(options.headers?.authorization || null);
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [
                      { class: 'general_nsfw', score: 0.05 },
                      { class: 'ai_generated', score: 0.98 },
                    ],
                  },
                ],
              },
            }],
          }),
        };
      }

      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });

    const result = await moderateVideo({
      sha256: '9'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('valid_proofmode');
    expect(result.scores).toEqual({});
    expect(hiveAuthCalls).toEqual([]);
  });

  it('keeps reported valid_proofmode content in team review without forcing Hive AI detection', async () => {
    const mockFetch = buildMockFetch({
      inquisitor: {
        has_c2pa: true,
        valid: true,
        validation_state: 'valid',
        is_proofmode: true,
        claim_generator: 'ProofMode/1.1.9 Android/14',
        capture_device: 'Google Pixel 8 Pro',
        capture_time: '2024:07:22 14:33:51',
        assertions: ['stds.exif', 'org.proofmode.location'],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      },
      hive: {
        status: [{
          response: {
            output: [
              {
                time: 0,
                classes: [
                  { class: 'ai_generated', score: 0.92 },
                ],
              },
            ],
          },
        }],
      },
    });

    const result = await moderateVideo({
      sha256: 'b'.repeat(64),
      uploadedAt: Date.now(),
      metadata: { forceAIDetection: true, source: 'ai-report' },
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.policyContext?.originalAction).toBe('REVIEW');
    expect(result.policyContext?.overrideReason).toBeNull();
    expect(result.reason).toContain('Team review required');
    expect(result.c2pa?.state).toBe('valid_proofmode');

    const hiveCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('api.thehive.ai'));
    expect(hiveCalls).toHaveLength(0);
  });

  it('routes valid_proofmode content to review even when Hive fixtures would not flag AI', async () => {
    const mockFetch = buildMockFetch({
      inquisitor: {
        has_c2pa: true,
        valid: true,
        validation_state: 'valid',
        is_proofmode: true,
        claim_generator: 'ProofMode/1.1.9 Android/14',
        assertions: [],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      },
      hive: {
        status: [{
          response: {
            output: [
              {
                time: 0,
                classes: [
                  { class: 'ai_generated', score: 0.1 },
                  { class: 'general_nsfw', score: 0.05 },
                ],
              },
            ],
          },
        }],
      },
    });

    const result = await moderateVideo({
      sha256: 'c'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('valid_proofmode');
    expect(result.policyContext?.overrideReason).toBeNull();
  });

  it('routes valid_c2pa content to review without using Hive AI flags', async () => {
    const mockFetch = buildMockFetch({
      inquisitor: {
        has_c2pa: true,
        valid: true,
        validation_state: 'valid',
        is_proofmode: false,
        claim_generator: 'Adobe Photoshop 24.0',
        assertions: ['c2pa.hash.data'],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      },
      hive: {
        status: [{
          response: {
            output: [
              {
                time: 0,
                classes: [
                  { class: 'ai_generated', score: 0.92 },
                ],
              },
            ],
          },
        }],
      },
    });

    const result = await moderateVideo({
      sha256: 'd'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('valid_c2pa');
  });

  it('routes to review when inquisitor returns unchecked from timeout', async () => {
    const mockFetch = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('inquisitor.divine.video/verify')) {
        throw new Error('ECONNREFUSED');
      }
      if (urlStr.endsWith('.vtt')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      if (urlStr.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{
              response: {
                output: [
                  {
                    time: 0,
                    classes: [{ class: 'ai_generated', score: 0.92 }],
                  },
                ],
              },
            }],
          }),
        };
      }
      throw new Error(`Unexpected fetch call: ${urlStr}`);
    });

    const result = await moderateVideo({
      sha256: 'e'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('unchecked');
  });

  it('routes absent C2PA content to review without using Hive AI flags', async () => {
    const mockFetch = buildMockFetch({
      inquisitor: {
        has_c2pa: false,
        valid: false,
        validation_state: 'unknown',
        is_proofmode: false,
        assertions: [],
        actions: [],
        ingredients: [],
        verified_at: '2026-04-17T10:00:00Z',
      },
      hive: {
        status: [{
          response: {
            output: [
              {
                time: 0,
                classes: [{ class: 'ai_generated', score: 0.92 }],
              },
            ],
          },
        }],
      },
    });

    const result = await moderateVideo({
      sha256: 'f'.repeat(64),
      uploadedAt: Date.now(),
    }, baseEnv, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('absent');
  });

  it('skips inquisitor and routes to review when INQUISITOR_BASE_URL is not set', async () => {
    const envWithoutInquisitor = { ...baseEnv };
    delete envWithoutInquisitor.INQUISITOR_BASE_URL;

    const mockFetch = vi.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('inquisitor.divine.video')) {
        throw new Error('inquisitor must not be called when INQUISITOR_BASE_URL missing');
      }
      if (urlStr.endsWith('.vtt')) {
        return { ok: false, status: 404, text: async () => '' };
      }
      if (urlStr.includes('api.thehive.ai')) {
        return {
          ok: true,
          json: async () => ({
            status: [{ response: { output: [{ time: 0, classes: [{ class: 'general_nsfw', score: 0.1 }] }] } }],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const result = await moderateVideo({
      sha256: '1'.repeat(64),
      uploadedAt: Date.now(),
    }, envWithoutInquisitor, mockFetch);

    expect(result.action).toBe('REVIEW');
    expect(result.provider).toBe('manual-review');
    expect(result.c2pa?.state).toBe('unchecked');

    const inquisitorCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('inquisitor.divine.video'));
    expect(inquisitorCalls).toHaveLength(0);
  });
});
