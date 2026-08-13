// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for Nostr event publishing to faro.nos.social
// ABOUTME: Verifies NIP-56 (kind 1984) reporting events are created correctly

import { describe, it, expect, vi } from 'vitest';
import { publishToFaro, publishLabelEvent, publishDmInboxRelayList } from './publisher.mjs';

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
          ['p', expect.any(String)],  // Reported content (video hash as pseudo-pubkey)
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

  it('should throw error if FARO_RELAY_URL not configured', async () => {
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64)
    };

    await expect(
      publishToFaro({
        type: 'review',
        sha256: 'h'.repeat(64),
        scores: { nudity: 0.6, violence: 0.4 }
      }, env)
    ).rejects.toThrow('FARO_RELAY_URL not configured');
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

describe('publishLabelEvent (automated source)', () => {
  // The relay's content_labels_mv only ingests kind 1985 events from pubkeys in
  // nostr.trusted_labelers. The nsfw_labeled_events_set MV then picks up anything
  // in the 'content-warning' namespace. So an automated kind 1985 with the right
  // namespace is the canonical signal we want to emit at QUARANTINE time.
  const baseEnv = () => ({
    NOSTR_PRIVATE_KEY: 'a'.repeat(64),
    NOSTR_RELAY_URL: 'wss://relay.divine.video',
  });

  function withMockRelay(env) {
    const mockRelay = { publish: vi.fn().mockResolvedValue(undefined) };
    return { mockRelay, env };
  }

  it('publishes a kind-1985 content-warning label when source=automated', async () => {
    const { mockRelay, env } = withMockRelay(baseEnv());

    const result = await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'ai_generated',
      status: 'confirmed',
      score: 0.97,
      source: 'automated',
      nostrEventId: 'd'.repeat(64),
    }, env, mockRelay);

    expect(result.published).toBe(true);
    const event = mockRelay.publish.mock.calls[0][0];
    expect(event.kind).toBe(1985);
    // Namespace declaration for content-warning
    expect(event.tags).toEqual(expect.arrayContaining([
      ['L', 'content-warning'],
    ]));
    // Label tag in the content-warning namespace
    const labelTag = event.tags.find((t) => t[0] === 'l' && t[2] === 'content-warning');
    expect(labelTag).toBeDefined();
    expect(labelTag[1]).toBe('ai-generated');
    // References the relay event id
    expect(event.tags).toEqual(expect.arrayContaining([
      ['e', 'd'.repeat(64)],
    ]));
  });

  it('marks automated labels as unverified in tag metadata', async () => {
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
    expect(labelTag).toBeDefined();
    const metadata = JSON.parse(labelTag[3]);
    expect(metadata.source).toBe('automated');
    expect(metadata.verified).toBe(false);
    expect(metadata.confidence).toBe(0.91);
  });

  it('defaults to human-moderator when source is omitted (no regression)', async () => {
    const { mockRelay, env } = withMockRelay(baseEnv());

    await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'nudity',
      status: 'confirmed',
      score: 0.8,
    }, env, mockRelay);

    const event = mockRelay.publish.mock.calls[0][0];
    const labelTag = event.tags.find((t) => t[0] === 'l' && t[2] === 'content-warning');
    const metadata = JSON.parse(labelTag[3]);
    expect(metadata.source).toBe('human-moderator');
    expect(metadata.verified).toBe(true);
  });

  it('uses a provided createdAt so the same crossing rebuilds the same event id', async () => {
    // The community sweep freezes created_at in its claim row and replays it
    // on every retry so the label event id is stable and the relay dedups by
    // id — no duplicate authoritative label can land after a partial failure.
    const labelData = {
      sha256: 'a'.repeat(64),
      category: 'nudity',
      status: 'confirmed',
      score: 1,
      source: 'community',
      voteCount: 3,
      nostrEventId: 'd'.repeat(64),
      createdAt: 1700000000,
    };

    const first = withMockRelay(baseEnv());
    await publishLabelEvent(labelData, first.env, first.mockRelay);
    const eventA = first.mockRelay.publish.mock.calls[0][0];

    const second = withMockRelay(baseEnv());
    await publishLabelEvent(labelData, second.env, second.mockRelay);
    const eventB = second.mockRelay.publish.mock.calls[0][0];

    expect(eventA.created_at).toBe(1700000000);
    expect(eventA.id).toBe(eventB.id);
  });

  it('a different createdAt yields a different event id (created_at drives dedup)', async () => {
    const base = {
      sha256: 'a'.repeat(64),
      category: 'nudity',
      status: 'confirmed',
      score: 1,
      source: 'community',
      voteCount: 3,
      nostrEventId: 'd'.repeat(64),
    };

    const first = withMockRelay(baseEnv());
    await publishLabelEvent({ ...base, createdAt: 1700000000 }, first.env, first.mockRelay);
    const eventA = first.mockRelay.publish.mock.calls[0][0];

    const second = withMockRelay(baseEnv());
    await publishLabelEvent({ ...base, createdAt: 1700000300 }, second.env, second.mockRelay);
    const eventB = second.mockRelay.publish.mock.calls[0][0];

    expect(eventA.id).not.toBe(eventB.id);
  });

  it('automated rejected labels are still emitted as not-{label}', async () => {
    // Mirrors the human-moderator rejection shape — keeps the existing relay path
    // for "this is NOT category X" intact when an automated source disagrees.
    const { mockRelay, env } = withMockRelay(baseEnv());

    await publishLabelEvent({
      sha256: 'a'.repeat(64),
      category: 'ai_generated',
      status: 'rejected',
      score: 0.04,
      source: 'automated',
      nostrEventId: 'c'.repeat(64),
    }, env, mockRelay);

    const event = mockRelay.publish.mock.calls[0][0];
    const labelTag = event.tags.find((t) => t[0] === 'l' && t[2] === 'content-warning');
    expect(labelTag[1]).toBe('not-ai-generated');
    const metadata = JSON.parse(labelTag[3]);
    expect(metadata.source).toBe('automated');
    expect(metadata.rejected).toBe(true);
  });
});

describe('DM inbox relay list (kind 10050)', () => {
  function createConnect() {
    const publishes = new Map();
    const connect = vi.fn(async (url) => {
      const publish = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      publishes.set(url, publish);
      return { publish, close };
    });
    return { connect, publishes };
  }

  it('publishes a signed kind-10050 listing only the home relay as inbox', async () => {
    const { connect, publishes } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'wss://relay.divine.video',
      DM_INBOX_DISCOVERY_RELAYS: 'wss://relay.divine.video'
    };

    const result = await publishDmInboxRelayList(env, { connect });

    expect(connect).toHaveBeenCalledWith('wss://relay.divine.video');
    expect(publishes.get('wss://relay.divine.video')).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 10050,
        content: '',
        tags: [['relay', 'wss://relay.divine.video']]
      })
    );

    const event = publishes.get('wss://relay.divine.video').mock.calls[0][0];
    expect(event.id).toEqual(expect.any(String));
    expect(event.sig).toEqual(expect.any(String));
    expect(event.pubkey).toEqual(expect.any(String));
    expect(result.published).toBe(true);
    expect(result.homeRelayPublished).toBe(true);
    expect(result.relays).toEqual(['wss://relay.divine.video']);
  });

  it('never lists discovery relays as inbox tags', async () => {
    const { connect, publishes } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'wss://relay.divine.video',
      DM_INBOX_DISCOVERY_RELAYS: 'wss://purplepag.es,wss://relay.nostr.band'
    };

    await publishDmInboxRelayList(env, { connect });

    expect(connect).toHaveBeenCalledTimes(3);
    const event = publishes.get('wss://purplepag.es').mock.calls[0][0];
    const inboxRelays = event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]);
    expect(inboxRelays).toEqual(['wss://relay.divine.video']);
  });

  it.each([
    ['null', null],
    ['explicit undefined', undefined],
    ['a TOML array, which wrangler accepts in vars', ['ws://127.0.0.1:4444']],
    ['a number', 4444],
    ['whitespace only', '   '],
    ['separators only', ' , , '],
    ['an empty string', ''],
  ])('treats a present-but-unusable DM_RELAY_URLS as contained: %s', async (_name, value) => {
    // The DM path refuses to send on these values. If this path disagreed and
    // took the production branch, the exact misconfiguration the refusal exists
    // to catch would announce moderation@'s DM inbox to purplepag.es,
    // relay.nostr.band and relay.damus.io, overwriting the real record there.
    //
    // Present-and-unparseable means refuse, never "carry on as production".
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'ws://127.0.0.1:4444',
      DM_RELAY_URLS: value,
    };

    await publishDmInboxRelayList(env, { connect });

    // An unusable override means nothing is allowed, so nothing is announced.
    // Asserting only that the aggregators are absent is what hid a home relay
    // pointing at production.
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses when the home relay is not in the override, even though it is set', async () => {
    // The guard used to ask whether RELAY_POLLING_RELAY_URL was UNSET. wrangler.toml
    // sets it to wss://relay.divine.video in the single shared [vars] block, so it
    // is set in every deploy and every `wrangler dev` -- the guard never fired in
    // any configuration this repo ships, and a contained run published a signed,
    // replaceable kind-10050 to the production relay.
    //
    // Containment is a property of the TARGET, not of which variables happen to be
    // defined. This fixture is deliberately the one no other test here uses: a home
    // relay that is NOT the override value.
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'wss://relay.divine.video',
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    const result = await publishDmInboxRelayList(env, { connect });

    expect(connect).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
  });

  it('announces when the home relay IS in the override', async () => {
    // The pair: a genuinely contained run still gets its announcement, to its own
    // relay only. Without this the guard could be satisfied by refusing always.
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'ws://127.0.0.1:4444',
      DM_RELAY_URLS: 'ws://127.0.0.1:4444,ws://127.0.0.1:5555',
    };

    const result = await publishDmInboxRelayList(env, { connect });

    expect(connect.mock.calls.map((c) => c[0])).toEqual(['ws://127.0.0.1:4444']);
    expect(result.published).toBe(true);
  });

  it('refuses to announce at all when contained without an explicit home relay', async () => {
    // homeRelay falls back to the production relay and is unconditionally a
    // target, so suppressing the discovery relays alone does not contain this
    // path: a run declared contained still publishes a freshly-signed,
    // REPLACEABLE kind-10050 to relay.divine.video with the real key.
    //
    // Containment must not depend on remembering a second, undocumented variable.
    // With no explicit home relay there is nothing safe to announce, so it skips.
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    const result = await publishDmInboxRelayList(env, { connect });

    expect(connect).not.toHaveBeenCalled();
    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/DM_RELAY_URLS/);
  });

  it('does not announce to public relays when DM_RELAY_URLS contains the run', async () => {
    // DM_RELAY_URLS says "this run must not reach outside these relays". This is
    // the second path that publishes with the signing key, and its discovery
    // fallback is three public relays plus the production one.
    //
    // Uncontained, a local run announces "moderation@'s DM inbox is
    // ws://127.0.0.1:4444" to purplepag.es, relay.nostr.band and relay.damus.io,
    // overwriting the real kind-10050 there. Strict NIP-17 clients then cannot
    // deliver DMs to the moderation account until it is republished.
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'ws://127.0.0.1:4444',
      DM_RELAY_URLS: 'ws://127.0.0.1:4444',
    };

    await publishDmInboxRelayList(env, { connect });

    const targets = connect.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(['ws://127.0.0.1:4444']);
    expect(targets).not.toContain('wss://purplepag.es');
    expect(targets).not.toContain('wss://relay.divine.video');
  });

  it('still announces to the public discovery relays in production', async () => {
    // The pair to the above: unset DM_RELAY_URLS is production, where announcing
    // widely is the entire point of a kind-10050.
    const { connect } = createConnect();
    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'wss://relay.divine.video',
    };

    await publishDmInboxRelayList(env, { connect });

    const targets = connect.mock.calls.map((c) => c[0]);
    expect(targets).toContain('wss://purplepag.es');
  });

  it('returns {published:false} when no signing key is configured', async () => {
    const result = await publishDmInboxRelayList({});
    expect(result.published).toBe(false);
  });

  it('does not advance the throttle when the home relay rejects but discovery succeeds', async () => {
    // Multi-relay path: home relay rejects (the pre-#536 state), discovery accepts.
    // Inject the connector so per-relay outcomes are deterministic and never hit the
    // network. A module-level mock of the transport does not reliably isolate under the
    // single-worker pool, which let this test fall through to the real network (green
    // locally with egress, red in CI without it).
    const connect = (url) => Promise.resolve({
      publish: url === 'wss://relay.divine.video'
        ? vi.fn().mockRejectedValue(new Error('kind 10050 not in allowed_kinds'))
        : vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    });

    const env = {
      NOSTR_PRIVATE_KEY: 'a'.repeat(64),
      RELAY_POLLING_RELAY_URL: 'wss://relay.divine.video',
      DM_INBOX_DISCOVERY_RELAYS: 'wss://purplepag.es'
    };

    const result = await publishDmInboxRelayList(env, { connect });

    // published is true (discovery succeeded) but homeRelayPublished is false, so the caller
    // must keep retrying the home relay rather than throttling for 24h.
    expect(result.published).toBe(true);
    expect(result.homeRelayPublished).toBe(false);
    expect(result.relays).toEqual(['wss://purplepag.es']);
    expect(result.failed.map((f) => f.relay)).toContain('wss://relay.divine.video');
  });
});
