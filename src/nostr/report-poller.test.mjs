// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests inbound NIP-56 report parsing and processing
// ABOUTME: Covers kind 1984 target resolution, report type mapping, and idempotence

import { describe, expect, it } from 'vitest';
import {
  extractReportTargetEventId,
  extractReportType,
  isDivineClientReport,
  shouldAcceptReportTarget,
} from './report-poller.mjs';

const TARGET_EVENT_ID = 'a'.repeat(64);

describe('kind 1984 parsing', () => {
  it('extracts target event id from the first valid e tag', () => {
    expect(extractReportTargetEventId({
      kind: 1984,
      tags: [
        ['e', '../not-hex', 'spam'],
        ['e', TARGET_EVENT_ID, 'nudity'],
        ['e', 'b'.repeat(64), 'violence'],
      ],
    })).toBe(TARGET_EVENT_ID);
  });

  it('ignores malformed e tag ids', () => {
    expect(extractReportTargetEventId({
      kind: 1984,
      tags: [['e', '../not-hex', 'nudity']],
    })).toBeNull();
  });

  it('uses NIP-56 e-tag marker as report type', () => {
    expect(extractReportType({
      kind: 1984,
      tags: [['e', TARGET_EVENT_ID, 'nudity']],
      content: '',
    })).toBe('nudity');
  });

  it('maps diVine aiGenerated label to ai_generated', () => {
    expect(extractReportType({
      kind: 1984,
      tags: [
        ['e', TARGET_EVENT_ID, 'other'],
        ['L', 'social.nos.ontology'],
        ['l', 'NS-aiGenerated', 'social.nos.ontology'],
      ],
      content: 'CONTENT REPORT - NIP-56\nReason: aiGenerated\nDetails: AI-Generated Content',
    })).toBe('ai_generated');
  });

  it('detects reports from the diVine client tag', () => {
    expect(isDivineClientReport({
      kind: 1984,
      tags: [['client', 'diVine']],
    })).toBe(true);
  });

  it('rejects non-diVine client reports when the client tag is absent', () => {
    expect(isDivineClientReport({
      kind: 1984,
      tags: [['client', 'Amethyst']],
    })).toBe(false);

    expect(isDivineClientReport({
      kind: 1984,
      tags: [],
    })).toBe(false);
  });

  it('accepts only video target events with a media sha', () => {
    expect(shouldAcceptReportTarget({
      kind: 34236,
      tags: [['d', 'b'.repeat(64)], ['imeta', `x ${'b'.repeat(64)}`, 'm video/mp4']],
    })).toBe(true);

    expect(shouldAcceptReportTarget({
      kind: 34235,
      tags: [['x', 'c'.repeat(64)]],
    })).toBe(true);
  });

  it('rejects non-video target events', () => {
    expect(shouldAcceptReportTarget({
      kind: 1,
      tags: [['e', TARGET_EVENT_ID]],
    })).toBe(false);
  });
});
