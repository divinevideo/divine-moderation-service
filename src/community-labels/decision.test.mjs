// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the pure community-label decision module — vote
// ABOUTME: extraction, threshold crossings, self-label strike determination.

import { describe, it, expect } from 'vitest';
import {
  normalizeLabel,
  extractVotes,
  decideCrossings,
  creatorSelfLabels,
  strikesFor,
} from './decision.mjs';

const CREATOR = 'c0'.padEnd(64, '0');
const MODERATION = 'd0'.padEnd(64, '0');
const ALICE = 'a1'.padEnd(64, '0');
const BOB = 'b2'.padEnd(64, '0');
const CAROL = 'c3'.padEnd(64, '0');

function vote(author, labels, { namespace = 'content-warning' } = {}) {
  return {
    id: Math.random().toString(16).slice(2).padEnd(64, '0'),
    pubkey: author,
    kind: 1985,
    tags: [
      ['L', namespace],
      ...labels.map((value) => ['l', value, namespace]),
      ['e', 'f'.repeat(64)],
    ],
  };
}

describe('normalizeLabel', () => {
  it('passes canonical values through', () => {
    expect(normalizeLabel('gambling')).toBe('gambling');
    expect(normalizeLabel('violence')).toBe('violence');
  });

  it('resolves known aliases', () => {
    expect(normalizeLabel('NSFW')).toBe('nudity');
    expect(normalizeLabel('gore')).toBe('graphic-media');
    expect(normalizeLabel('pornography')).toBe('porn');
    expect(normalizeLabel('hate speech')).toBe('hate');
    expect(normalizeLabel('sexual_content')).toBe('sexual');
    expect(normalizeLabel('weapon')).toBe('violence');
  });

  it('rejects unknown values', () => {
    expect(normalizeLabel('banana')).toBeNull();
    expect(normalizeLabel('')).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
  });
});

describe('extractVotes', () => {
  const exclusions = { moderationPubkey: MODERATION, creatorPubkey: CREATOR };

  it('groups distinct authors per normalized label', () => {
    const votes = extractVotes(
      [vote(ALICE, ['gambling']), vote(BOB, ['NSFW']), vote(CAROL, ['gambling'])],
      exclusions,
    );
    expect([...votes.get('gambling')]).toEqual(expect.arrayContaining([ALICE, CAROL]));
    expect([...votes.get('nudity')]).toEqual([BOB]);
  });

  it('counts a repeated author once per label', () => {
    const votes = extractVotes(
      [vote(ALICE, ['gambling']), vote(ALICE, ['gambling'])],
      exclusions,
    );
    expect(votes.get('gambling').size).toBe(1);
  });

  it('excludes the creator and the moderation account', () => {
    const votes = extractVotes(
      [vote(CREATOR, ['gambling']), vote(MODERATION, ['gambling']), vote(ALICE, ['gambling'])],
      exclusions,
    );
    expect(votes.get('gambling').size).toBe(1);
  });

  it('ignores labels outside the content-warning namespace', () => {
    const votes = extractVotes(
      [vote(ALICE, ['gambling'], { namespace: 'other.ns' })],
      exclusions,
    );
    expect(votes.size).toBe(0);
  });

  it('ignores unknown label values and malformed tags', () => {
    const malformed = {
      id: '1'.repeat(64),
      pubkey: ALICE,
      kind: 1985,
      tags: [['L', 'content-warning'], ['l'], ['l', 'banana', 'content-warning']],
    };
    const votes = extractVotes([malformed], exclusions);
    expect(votes.size).toBe(0);
  });
});

describe('decideCrossings', () => {
  it('crosses at exactly the threshold of distinct Divine authors', () => {
    const votesByLabel = new Map([['gambling', new Set([ALICE, BOB, CAROL])]]);
    const divine = new Map([[ALICE, true], [BOB, true], [CAROL, true]]);
    expect(decideCrossings(votesByLabel, divine, 3)).toEqual([
      { label: 'gambling', voteCount: 3 },
    ]);
  });

  it('does not cross below the threshold', () => {
    const votesByLabel = new Map([['gambling', new Set([ALICE, BOB])]]);
    const divine = new Map([[ALICE, true], [BOB, true]]);
    expect(decideCrossings(votesByLabel, divine, 3)).toEqual([]);
  });

  it('non-Divine authors do not count', () => {
    const votesByLabel = new Map([['gambling', new Set([ALICE, BOB, CAROL])]]);
    const divine = new Map([[ALICE, true], [BOB, true], [CAROL, false]]);
    expect(decideCrossings(votesByLabel, divine, 3)).toEqual([]);
  });

  it('evaluates each label independently', () => {
    const votesByLabel = new Map([
      ['gambling', new Set([ALICE, BOB, CAROL])],
      ['violence', new Set([ALICE])],
    ]);
    const divine = new Map([[ALICE, true], [BOB, true], [CAROL, true]]);
    expect(decideCrossings(votesByLabel, divine, 3)).toEqual([
      { label: 'gambling', voteCount: 3 },
    ]);
  });
});

describe('creatorSelfLabels', () => {
  it('reads content-warning l tags off the video event, normalized', () => {
    const video = {
      id: 'f'.repeat(64),
      pubkey: CREATOR,
      kind: 34236,
      tags: [
        ['l', 'NSFW', 'content-warning'],
        ['l', 'gambling', 'content-warning'],
        ['t', 'fun'],
      ],
    };
    expect(creatorSelfLabels(video)).toEqual(new Set(['nudity', 'gambling']));
  });

  it('reads bare content-warning tags too', () => {
    const video = {
      id: 'f'.repeat(64),
      pubkey: CREATOR,
      kind: 34236,
      tags: [['content-warning', 'violence']],
    };
    expect(creatorSelfLabels(video)).toEqual(new Set(['violence']));
  });

  it('is empty for an unlabeled video', () => {
    expect(creatorSelfLabels({ tags: [] })).toEqual(new Set());
  });
});

describe('strikesFor', () => {
  it('strikes when the crossed label was not self-applied', () => {
    expect(strikesFor([{ label: 'gambling', voteCount: 3 }], new Set())).toEqual([
      { label: 'gambling' },
    ]);
  });

  it('does not strike when the creator self-applied the label', () => {
    expect(
      strikesFor([{ label: 'gambling', voteCount: 3 }], new Set(['gambling'])),
    ).toEqual([]);
  });

  it('handles alias-form self-labels via normalization upstream', () => {
    // creatorSelfLabels normalizes, so 'NSFW' self-label blocks a 'nudity' strike.
    expect(
      strikesFor([{ label: 'nudity', voteCount: 3 }], new Set(['nudity'])),
    ).toEqual([]);
  });
});
