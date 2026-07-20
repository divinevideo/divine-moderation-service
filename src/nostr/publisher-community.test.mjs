// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for community-consensus kind 1985 publishing — source
// ABOUTME: passthrough, unverified metadata, and reporter-count content text.

import { describe, it, expect, vi } from 'vitest';
import { publishLabelEvent } from './publisher.mjs';

const baseEnv = () => ({
  NOSTR_PRIVATE_KEY: 'a'.repeat(64),
  NOSTR_RELAY_URL: 'wss://relay.divine.video',
});

function withMockRelay(env) {
  const mockRelay = { publish: vi.fn().mockResolvedValue(undefined) };
  return { mockRelay, env };
}

describe('publishLabelEvent (community source)', () => {
  it('publishes a content-warning label with source=community, unverified', async () => {
    const { mockRelay, env } = withMockRelay(baseEnv());

    const result = await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'gambling',
      status: 'confirmed',
      score: 1,
      source: 'community',
      voteCount: 4,
      nostrEventId: 'd'.repeat(64),
    }, env, mockRelay);

    expect(result.published).toBe(true);
    const event = mockRelay.publish.mock.calls[0][0];
    expect(event.kind).toBe(1985);
    expect(event.tags).toEqual(expect.arrayContaining([
      ['L', 'content-warning'],
      ['e', 'd'.repeat(64)],
      ['x', 'a'.repeat(64)],
    ]));
    const labelTag = event.tags.find((t) => t[0] === 'l' && t[2] === 'content-warning');
    expect(labelTag[1]).toBe('gambling');
    const metadata = JSON.parse(labelTag[3]);
    expect(metadata.source).toBe('community');
    expect(metadata.verified).toBe(false);
  });

  it('describes community consensus with the reporter count in content', async () => {
    const { mockRelay, env } = withMockRelay(baseEnv());

    await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'gambling',
      status: 'confirmed',
      score: 1,
      source: 'community',
      voteCount: 4,
      nostrEventId: 'd'.repeat(64),
    }, env, mockRelay);

    const event = mockRelay.publish.mock.calls[0][0];
    expect(event.content).toContain('Community consensus flagged');
    expect(event.content).toContain('gambling');
    expect(event.content).toContain('4 distinct reporters');
  });

  it('publishes without an x tag when the video has no sha256', async () => {
    // Videos lacking an x/imeta-x tag reach the publisher with sha256=null;
    // the event stays targetable via its e tag.
    const { mockRelay, env } = withMockRelay(baseEnv());

    const result = await publishLabelEvent({
      sha256: null,
      category: 'gambling',
      status: 'confirmed',
      score: 1,
      source: 'community',
      voteCount: 3,
      nostrEventId: 'd'.repeat(64),
    }, env, mockRelay);

    expect(result.published).toBe(true);
    const event = mockRelay.publish.mock.calls[0][0];
    expect(event.tags.some((t) => t[0] === 'x')).toBe(false);
    expect(event.tags).toEqual(expect.arrayContaining([['e', 'd'.repeat(64)]]));
  });

  it('does not change automated-source behavior', async () => {
    const { mockRelay, env } = withMockRelay(baseEnv());

    await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'deepfake',
      status: 'confirmed',
      score: 0.91,
      source: 'automated',
      nostrEventId: 'b'.repeat(64),
    }, env, mockRelay);

    const event = mockRelay.publish.mock.calls[0][0];
    const labelTag = event.tags.find((t) => t[0] === 'l' && t[2] === 'content-warning');
    const metadata = JSON.parse(labelTag[3]);
    expect(metadata.source).toBe('automated');
    expect(event.content).toContain('Automated moderator flagged');
  });
});
