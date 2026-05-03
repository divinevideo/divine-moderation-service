// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the classification pipeline
// ABOUTME: Validates Hive-disabled classification behavior and output formatters

import { describe, it, expect, vi } from 'vitest';
import { classifyVideo, formatForStorage, formatForGorse, formatForFunnelcake } from './pipeline.mjs';

describe('classifyVideo', () => {
  it('should return skipped result when HIVE_VLM_API_KEY is not set', async () => {
    const result = await classifyVideo('https://media.divine.video/test.mp4', {});
    expect(result.skipped).toBe(true);
    expect(result.labels).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.description).toBe('');
    expect(result.provider).toBeNull();
  });

  it('should skip Hive VLM even when HIVE_VLM_API_KEY and HIVE_VLM_ENABLED are set', async () => {
    const mockFetch = vi.fn();

    const result = await classifyVideo(
      'https://media.divine.video/test.mp4',
      { HIVE_VLM_API_KEY: 'vlm-key', HIVE_VLM_ENABLED: 'true' },
      { sha256: 'abc123', fetchFn: mockFetch }
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('disabled');
    expect(result.sha256).toBe('abc123');
    expect(result.provider).toBeNull();
    expect(result.topics).toEqual([]);
    expect(result.labels).toEqual([]);
    expect(result.description).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('formatForStorage', () => {
  it('should return null for skipped result', () => {
    expect(formatForStorage({ skipped: true })).toBeNull();
    expect(formatForStorage(null)).toBeNull();
  });

  it('should strip raw data but keep description', () => {
    const result = {
      provider: 'hiveai-vlm',
      sha256: 'abc123',
      processingTime: 1500,
      labels: [{ label: 'sports', namespace: 'topic', score: 1.0 }],
      topics: ['sports'],
      setting: 'beach',
      objects: ['surfboard'],
      activities: ['surfing'],
      mood: 'exciting',
      description: 'Surfing at the beach.',
      topCategories: [{ category: 'sports', score: 1.0 }],
      topSettings: [{ setting: 'beach', score: 1.0 }],
      topObjects: [{ object: 'surfboard', score: 1.0 }],
      classesDetected: 4,
      extractedAt: '2025-01-01T00:00:00.000Z',
      raw: { big: 'object' },
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    };

    const stored = formatForStorage(result);
    expect(stored.raw).toBeUndefined();
    expect(stored.usage).toBeUndefined();
    expect(stored.provider).toBe('hiveai-vlm');
    expect(stored.labels).toHaveLength(1);
    expect(stored.description).toBe('Surfing at the beach.');
    expect(stored.topics).toEqual(['sports']);
    expect(stored.setting).toBe('beach');
    expect(stored.activities).toEqual(['surfing']);
    expect(stored.mood).toBe('exciting');
  });
});

describe('formatForGorse', () => {
  it('should return empty array for skipped result', () => {
    expect(formatForGorse({ skipped: true })).toEqual([]);
    expect(formatForGorse(null)).toEqual([]);
  });

  it('should return namespaced label strings', () => {
    const result = {
      labels: [
        { label: 'sports', namespace: 'topic', score: 1.0 },
        { label: 'beach-outdoor', namespace: 'setting', score: 1.0 },
        { label: 'surfboard', namespace: 'object', score: 1.0 },
        { label: 'surfing', namespace: 'activity', score: 1.0 },
        { label: 'exciting', namespace: 'mood', score: 1.0 }
      ]
    };

    const gorseLabels = formatForGorse(result);
    expect(gorseLabels).toEqual([
      'topic:sports',
      'setting:beach-outdoor',
      'object:surfboard',
      'activity:surfing',
      'mood:exciting'
    ]);
  });
});

describe('formatForFunnelcake', () => {
  it('should return empty object for skipped result', () => {
    expect(formatForFunnelcake({ skipped: true })).toEqual({});
    expect(formatForFunnelcake(null)).toEqual({});
  });

  it('should return topic-weight map', () => {
    const result = {
      labels: [
        { label: 'sports', namespace: 'topic', score: 1.0 },
        { label: 'beach-outdoor', namespace: 'setting', score: 1.0 }
      ]
    };

    const topics = formatForFunnelcake(result);
    expect(topics).toEqual({
      'topic:sports': 1.0,
      'setting:beach-outdoor': 1.0
    });
  });
});
