// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from 'vitest';
import dashboardHTML from './dashboard.html';

describe('dashboard provenance UI hooks', () => {
  it('contains creator info modal and provenance helpers', () => {
    expect(dashboardHTML).toContain('Creator Info');
    expect(dashboardHTML).toContain('openCreatorInfo');
    expect(dashboardHTML).toContain('renderProvenanceBadge');
    expect(dashboardHTML).toContain('creator-info-modal');
  });

  it('contains C2PA/ProofMode badge rendering', () => {
    expect(dashboardHTML).toContain('renderC2paBadge');
    expect(dashboardHTML).toContain('formatC2paSupportLine');
    expect(dashboardHTML).toContain('Valid ProofMode');
    expect(dashboardHTML).toContain('Valid C2PA');
    expect(dashboardHTML).toContain('Valid but AI-signed');
    expect(dashboardHTML).toContain('Invalid Proof');
    expect(dashboardHTML).toContain('c2pa-badge');
  });

  it('contains AI detection reporting panel hooks', () => {
    expect(dashboardHTML).toContain('ai-detection-panel');
    expect(dashboardHTML).toContain('/admin/api/ai-detection/stats');
    expect(dashboardHTML).toContain('loadAIDetectionStats');
    expect(dashboardHTML).toContain('AI Detection');
    expect(dashboardHTML).toContain('Estimated spend avoided');
  });

  it('renders poster thumbnails before video playback starts', () => {
    expect(dashboardHTML).toContain('const cardThumbUrl = escapeHtml(video.thumbnailUrl || `https://media.divine.video/${sha256}.jpg`);');
    expect(dashboardHTML).toContain('src="${cardThumbUrl}"');
    expect(dashboardHTML).toContain('openVideoModal');
  });

  it('triage cards carry the lazy Nostr-context hydration hooks', () => {
    // Regression guard: the untriaged list query no longer returns per-row
    // relay context, so triage cards must hydrate it client-side. createTriageCard
    // emits the #nostr-${sha} container (string-concat form, distinct from the
    // moderated grid's template-literal form) and the View link's divine-link id
    // so updateDivineLink can upgrade it; loadTriageVideos drives loadNostrContext.
    expect(dashboardHTML).toContain('<div class="nostr-context" id="nostr-\' + sha256 + \'">');
    expect(dashboardHTML).toContain('id="divine-link-\' + sha256 + \'"');
    expect(dashboardHTML).toContain('loadNostrContext(video.sha256, container)');
    expect(dashboardHTML).toContain('applyNostrMetadataToVideo(sha256, data.metadata)');
    expect(dashboardHTML).toContain('triageVideos.find(v => v.sha256 === sha256)');
    expect(dashboardHTML).toContain('id="event-meta-\' + escapeHtml(video.sha256 || \'\') + \'"');
    expect(dashboardHTML).toContain('uploader-enforcement-slot-\' + sha256 + \'');
    expect(dashboardHTML).toContain('uploader-history-slot-\' + sha256 + \'');
  });
});
