// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Nostr event publishing to faro.nos.social
// ABOUTME: Verifies NIP-56 (kind 1984) reporting events are created correctly

import { describe, it, expect, vi } from 'vitest';
import { publishToFaro } from './publisher.mjs';

describe('Nostr Event Publisher', () => {
  it('should create a kind 1984 report event for QUARANTINE', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'quarantine',
      sha256: 'b'.repeat(64),
      scores: { nudity: 0.95, violence: 0.1 },
      reason: 'High nudity detected',
      severity: 'high'
    }, env, mockRelay);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 1984,
        content: expect.stringContaining('High nudity detected'),
        tags: expect.arrayContaining([
          ['x', 'b'.repeat(64)], // Target by content hash
          ['L', 'MOD'],
          ['l', 'NS', 'MOD']
        ])
      })
    );
  });

  it('should create a kind 1984 report event for REVIEW', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'review',
      sha256: 'c'.repeat(64),
      scores: { nudity: 0.65, violence: 0.3 },
      reason: 'Potential nudity, requires review',
      frames: [{ position: 3, nudityScore: 0.65 }]
    }, env, mockRelay);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 1984,
        content: expect.stringContaining('requires review'),
        tags: expect.arrayContaining([
          ['L', 'MOD']
        ])
      })
    );
  });

  it('should include video metadata in tags', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'quarantine',
      sha256: 'd'.repeat(64),
      cdnUrl: 'https://cdn.divine.video/dddd.mp4',
      scores: { nudity: 0.95, violence: 0.1 },
      reason: 'High nudity detected'
    }, env, mockRelay);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining([
          ['r', 'https://cdn.divine.video/dddd.mp4']
        ])
      })
    );
  });

  it('should include scores in event content as JSON', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'quarantine',
      sha256: 'e'.repeat(64),
      scores: { nudity: 0.85, violence: 0.72 },
      reason: 'Multiple violations'
    }, env, mockRelay);

    const publishedEvent = mockRelay.publish.mock.calls[0][0];
    expect(publishedEvent.content).toContain('0.85');
    expect(publishedEvent.content).toContain('0.72');
  });

  it('should sign the event with private key', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const privateKey = 'a'.repeat(64);
    const env = {
      NOSTR_PRIVATE_KEY: privateKey,
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'review',
      sha256: 'f'.repeat(64),
      scores: { nudity: 0.6, violence: 0.4 },
      reason: 'Needs review'
    }, env, mockRelay);

    const publishedEvent = mockRelay.publish.mock.calls[0][0];
    expect(publishedEvent.sig).toBeDefined();
    expect(publishedEvent.pubkey).toBeDefined();
    expect(publishedEvent.id).toBeDefined();
  });

  it('should throw error if NOSTR_PRIVATE_KEY not configured', async () => {
    const env = {
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await expect(
      publishToFaro({
        type: 'review',
        sha256: 'g'.repeat(64),
        scores: { nudity: 0.6, violence: 0.4 }
      }, env)
    ).rejects.toThrow('NOSTR_PRIVATE_KEY not configured');
  });

  it('should throw error if relay URL not configured', async () => {
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64)
    };

    await expect(
      publishToFaro({
        type: 'review',
        sha256: 'h'.repeat(64),
        scores: { nudity: 0.6, violence: 0.4 }
      }, env)
    ).rejects.toThrow('No relay URL configured');
  });

  it('should use appropriate label for severity', async () => {
    const mockRelay = {
      publish: vi.fn().mockResolvedValue(undefined)
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    // NSFW content
    await publishToFaro({
      type: 'quarantine',
      sha256: 'i'.repeat(64),
      scores: { nudity: 0.95, violence: 0.1 },
      reason: 'NSFW'
    }, env, mockRelay);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining([
          ['l', 'NS', 'MOD']  // Not Safe for work
        ])
      })
    );

    // Violence content
    mockRelay.publish.mockClear();
    await publishToFaro({
      type: 'quarantine',
      sha256: 'j'.repeat(64),
      scores: { nudity: 0.1, violence: 0.95 },
      reason: 'Violence'
    }, env, mockRelay);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining([
          ['l', 'VI', 'MOD']  // Violence
        ])
      })
    );
  });

  it('should not publish for SAFE content', async () => {
    const mockRelay = {
      publish: vi.fn()
    };

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      FARO_RELAY_URL: 'wss://relay.faro.nos.social'
    };

    await publishToFaro({
      type: 'safe',
      sha256: 'k'.repeat(64),
      scores: { nudity: 0.1, violence: 0.1 }
    }, env, mockRelay);

    expect(mockRelay.publish).not.toHaveBeenCalled();
  });
});
