// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, vi } from 'vitest';
import {
  isEnrichmentEnabled,
  nsfwEnvelopeToScores,
  enrichWithAiDetector,
  AI_DETECTOR_SOURCE,
} from './ai-detector-enrichment.mjs';

const ON = { AI_DETECTOR_ENRICHMENT_ENABLED: 'true', AI_DETECTOR_BASE_URL: 'https://detector' };

describe('isEnrichmentEnabled', () => {
  it('is off by default so merging cannot change behaviour', () => {
    expect(isEnrichmentEnabled({})).toBe(false);
    expect(isEnrichmentEnabled({ AI_DETECTOR_BASE_URL: 'https://detector' })).toBe(false);
  });

  it('requires both the flag and a base URL', () => {
    expect(isEnrichmentEnabled({ AI_DETECTOR_ENRICHMENT_ENABLED: 'true' })).toBe(false);
    expect(isEnrichmentEnabled(ON)).toBe(true);
  });
});

describe('nsfwEnvelopeToScores', () => {
  it('maps flagging classes onto canonical categories', () => {
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'porn', confidence: 0.91 }))
      .toEqual({ porn: 0.91 });
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'sexy', confidence: 0.7 }))
      .toEqual({ sexual: 0.7 });
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'hentai', confidence: 0.8 }))
      .toEqual({ sexual: 0.8 });
  });

  it('never labels the model\'s negative classes', () => {
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'neutral', confidence: 0.99 })).toEqual({});
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'drawings', confidence: 0.99 })).toEqual({});
  });

  it('writes nothing for absent, skipped, error or missing envelopes', () => {
    for (const state of ['absent', 'skipped', 'error']) {
      expect(nsfwEnvelopeToScores({ state, class: 'porn', confidence: 0.9 })).toEqual({});
    }
    expect(nsfwEnvelopeToScores(null)).toEqual({});
    expect(nsfwEnvelopeToScores(undefined)).toEqual({});
  });

  it('ignores a detected envelope with no usable confidence', () => {
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'porn', confidence: 0 })).toEqual({});
    expect(nsfwEnvelopeToScores({ state: 'detected', class: 'porn' })).toEqual({});
  });
});

describe('enrichWithAiDetector', () => {
  it('does nothing when disabled', async () => {
    const detect = vi.fn();
    const res = await enrichWithAiDetector('sha', 'https://v/1.mp4', {}, { detect });
    expect(res.skipped).toBe(true);
    expect(detect).not.toHaveBeenCalled();
  });

  it('skips without a video URL', async () => {
    const detect = vi.fn();
    const res = await enrichWithAiDetector('sha', '', ON, { detect });
    expect(res.skipped).toBe(true);
    expect(detect).not.toHaveBeenCalled();
  });

  it('requests only the nsfw signal', async () => {
    const detect = vi.fn().mockResolvedValue({ signals: { nsfw: { state: 'absent' } } });
    await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels: vi.fn() });
    expect(detect).toHaveBeenCalledWith(
      { url: 'https://v/1.mp4', sha256: 'sha', signals: ['nsfw'] },
      ON
    );
  });

  it('writes a label for a detected verdict, attributed to the detector', async () => {
    const detect = vi.fn().mockResolvedValue({
      signals: { nsfw: { state: 'detected', class: 'porn', confidence: 0.93, frames_flagged: 5, total_frames: 8 } },
    });
    const writeLabels = vi.fn().mockResolvedValue(undefined);
    const res = await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels });

    expect(res.labelsWritten).toBe(1);
    const [sha, classification, , source] = writeLabels.mock.calls[0];
    expect(sha).toBe('sha');
    expect(classification.scores).toEqual({ porn: 0.93 });
    expect(source).toEqual(AI_DETECTOR_SOURCE);
    expect(source.sourceId).toBe('divine-ai-detector');
  });

  it('never emits an enforcement action', async () => {
    const detect = vi.fn().mockResolvedValue({
      signals: { nsfw: { state: 'detected', class: 'porn', confidence: 0.93 } },
    });
    const writeLabels = vi.fn().mockResolvedValue(undefined);
    await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels });
    expect(writeLabels.mock.calls[0][1].action).toBe('');
  });

  it('writes nothing when the model found nothing', async () => {
    const detect = vi.fn().mockResolvedValue({ signals: { nsfw: { state: 'absent' } } });
    const writeLabels = vi.fn();
    const res = await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels });
    expect(res.labelsWritten).toBe(0);
    expect(writeLabels).not.toHaveBeenCalled();
  });

  it('survives a detector transport failure', async () => {
    const detect = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels: vi.fn() });
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain('boom');
  });

  it('survives a ClickHouse write failure without throwing', async () => {
    const detect = vi.fn().mockResolvedValue({
      signals: { nsfw: { state: 'detected', class: 'porn', confidence: 0.93 } },
    });
    const writeLabels = vi.fn().mockRejectedValue(new Error('clickhouse down'));
    const res = await enrichWithAiDetector('sha', 'https://v/1.mp4', ON, { detect, writeLabels });
    expect(res.labelsWritten).toBe(0);
  });
});
