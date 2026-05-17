// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import swipeReviewHTML from './swipe-review.html';

describe('swipe review provenance UI hooks', () => {
  it('contains creator info modal and provenance helpers', () => {
    expect(swipeReviewHTML).toContain('Creator Info');
    expect(swipeReviewHTML).toContain('openCreatorInfo');
    expect(swipeReviewHTML).toContain('renderProvenanceBadge');
    expect(swipeReviewHTML).toContain('creator-info-modal');
  });

  it('contains C2PA/ProofMode badge rendering', () => {
    expect(swipeReviewHTML).toContain('renderC2paBadge');
    expect(swipeReviewHTML).toContain('formatC2paSupportLine');
    expect(swipeReviewHTML).toContain('Valid ProofMode');
    expect(swipeReviewHTML).toContain('Valid C2PA');
    expect(swipeReviewHTML).toContain('Valid but AI-signed');
    expect(swipeReviewHTML).toContain('Invalid Proof');
    expect(swipeReviewHTML).toContain('c2pa-badge');
  });

  it('renders poster thumbnails before video playback starts', () => {
    expect(swipeReviewHTML).toContain('const posterUrl = escapeHtml(video.thumbnailUrl || \'\');');
    expect(swipeReviewHTML).toContain('poster="${posterUrl}"');
  });
});
