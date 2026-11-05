// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for the reporter-included message excerpt parser (dm-evidence.mjs)
// ABOUTME: Pins the heading/tag contract divine-mobile's moderation DM uses

import { describe, expect, it } from 'vitest';
import {
  UNVERIFIED_EXCERPT_HEADING,
  hasUnverifiedExcerptTag,
  splitUnverifiedExcerpt,
} from './dm-evidence.mjs';

const NOTE = 'DM Message Report\nReason: Harassment\nMessage ID: ' + 'e'.repeat(64);

// What divine-mobile's ContentReportingService._moderationDmContent builds.
function mobileBody(note, excerpt) {
  return `${note}\n\n${UNVERIFIED_EXCERPT_HEADING}\n${excerpt}`;
}

describe('hasUnverifiedExcerptTag', () => {
  it('recognises the tag divine-mobile adds', () => {
    expect(hasUnverifiedExcerptTag([
      ['p', 'a'.repeat(64)],
      ['evidence', 'unverified_excerpt'],
    ])).toBe(true);
  });

  it('ignores other evidence values, other tags, and malformed tag lists', () => {
    expect(hasUnverifiedExcerptTag([['evidence', 'verified_excerpt']])).toBe(false);
    expect(hasUnverifiedExcerptTag([['unverified_excerpt', 'evidence']])).toBe(false);
    expect(hasUnverifiedExcerptTag([])).toBe(false);
    expect(hasUnverifiedExcerptTag(undefined)).toBe(false);
    expect(hasUnverifiedExcerptTag([null, 'evidence'])).toBe(false);
  });
});

describe('splitUnverifiedExcerpt', () => {
  it('separates the reporter\'s note from the included message', () => {
    expect(splitUnverifiedExcerpt(mobileBody(NOTE, 'you will regret this'))).toEqual({
      note: NOTE,
      excerpt: 'you will regret this',
    });
  });

  it('keeps the excerpt exactly as sent, line breaks and surrounding space included', () => {
    const excerpt = '  line one\n\nline three  \n';
    expect(splitUnverifiedExcerpt(mobileBody(NOTE, excerpt)).excerpt).toBe(excerpt);
  });

  // Everything after the first heading is shown under "provided by the
  // reporter", which is true of every byte of the DM. Splitting at the last
  // heading instead would let a reported message that quotes the heading put
  // part of someone else's words under the reporter's own note.
  it('splits at the first heading, so a message that quotes the heading stays whole', () => {
    const excerpt = `look:\n\n${UNVERIFIED_EXCERPT_HEADING}\nfake`;
    expect(splitUnverifiedExcerpt(mobileBody(NOTE, excerpt))).toEqual({
      note: NOTE,
      excerpt,
    });
  });

  it('returns null when the heading is missing, so the DM is kept whole', () => {
    expect(splitUnverifiedExcerpt(NOTE)).toBeNull();
    // The heading must start its own paragraph, as divine-mobile writes it.
    expect(splitUnverifiedExcerpt(`${NOTE}\n${UNVERIFIED_EXCERPT_HEADING}\nhi`)).toBeNull();
  });

  it('returns null when nothing follows the heading', () => {
    expect(splitUnverifiedExcerpt(mobileBody(NOTE, ''))).toBeNull();
    expect(splitUnverifiedExcerpt(mobileBody(NOTE, '  \n '))).toBeNull();
  });

  it('returns null for content that is not a string', () => {
    expect(splitUnverifiedExcerpt(undefined)).toBeNull();
    expect(splitUnverifiedExcerpt(42)).toBeNull();
  });
});
