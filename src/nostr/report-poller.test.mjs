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
  processReportEvent,
  processedReportKey,
  shouldAcceptReportTarget,
} from './report-poller.mjs';

const TARGET_EVENT_ID = 'a'.repeat(64);
const REPORT_EVENT_ID = 'c'.repeat(64);
const REPORTER = 'd'.repeat(64);
const SHA = 'e'.repeat(64);
const UPLOADER = 'f'.repeat(64);
const TARGET = {
  id: TARGET_EVENT_ID,
  kind: 34236,
  pubkey: UPLOADER,
  tags: [['d', SHA], ['imeta', `x ${SHA}`, 'm video/mp4']],
};

function createKv(existing = new Map()) {
  const store = new Map(existing);
  const puts = [];
  return {
    store,
    puts,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
}

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

describe('processReportEvent', () => {
  it('resolves a diVine report target and records it for review', async () => {
    const kv = createKv();
    const recorded = [];

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1984,
      pubkey: REPORTER,
      created_at: 1778692782,
      tags: [
        ['e', TARGET_EVENT_ID, 'other'],
        ['client', 'diVine'],
        ['l', 'NS-aiGenerated', 'social.nos.ontology'],
      ],
      content: 'Reason: aiGenerated',
    }, {
      kv,
      requireDivineClient: true,
      fetchTargetEvent: async (eventId) => (eventId === TARGET_EVENT_ID ? TARGET : null),
      recordReport: async (payload) => {
        recorded.push(payload);
        return { action: 'REVIEW', distinctReporterCount: 1 };
      },
    });

    expect(result).toMatchObject({
      status: 'recorded',
      sha256: SHA,
      reportType: 'ai_generated',
      targetEventId: TARGET_EVENT_ID,
      action: 'REVIEW',
      distinctReporterCount: 1,
    });
    expect(recorded).toEqual([{
      sha256: SHA,
      reporterPubkey: REPORTER,
      reportType: 'ai_generated',
      reason: 'Reason: aiGenerated',
      source: 'relay-report',
      reportedAt: '2026-05-13T17:19:42.000Z',
      reportEventId: REPORT_EVENT_ID,
      targetEventId: TARGET_EVENT_ID,
      uploadedBy: UPLOADER,
    }]);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe(processedReportKey(REPORT_EVENT_ID));
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 * 60 * 24 * 180 });
    expect(JSON.parse(kv.store.get(processedReportKey(REPORT_EVENT_ID)))).toMatchObject({
      status: 'recorded',
      sha256: SHA,
      reportType: 'ai_generated',
      action: 'REVIEW',
    });
  });

  it('skips an already processed report without recording again', async () => {
    const kv = createKv(new Map([[processedReportKey(REPORT_EVENT_ID), '{"status":"recorded"}']]));
    const calls = { fetchTargetEvent: 0, recordReport: 0 };

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1984,
      pubkey: REPORTER,
      created_at: 1778692782,
      tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
    }, {
      kv,
      requireDivineClient: true,
      fetchTargetEvent: async () => {
        calls.fetchTargetEvent++;
        return TARGET;
      },
      recordReport: async () => {
        calls.recordReport++;
        return { action: 'REVIEW', distinctReporterCount: 1 };
      },
    });

    expect(result.status).toBe('already_processed');
    expect(calls).toEqual({ fetchTargetEvent: 0, recordReport: 0 });
    expect(kv.puts).toHaveLength(0);
  });

  it('skips non-diVine client reports when configured', async () => {
    const kv = createKv();
    const recorded = [];

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1984,
      pubkey: REPORTER,
      tags: [['e', TARGET_EVENT_ID, 'spam'], ['client', 'Amethyst']],
    }, {
      kv,
      requireDivineClient: true,
      fetchTargetEvent: async () => TARGET,
      recordReport: async (payload) => {
        recorded.push(payload);
        return { action: 'REVIEW', distinctReporterCount: 1 };
      },
    });

    expect(result.status).toBe('skipped_non_divine_client');
    expect(recorded).toHaveLength(0);
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe(processedReportKey(REPORT_EVENT_ID));
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 * 60 * 24 * 90 });
    expect(JSON.parse(kv.store.get(processedReportKey(REPORT_EVENT_ID)))).toMatchObject({
      status: 'skipped_non_divine_client',
    });
  });

  it('does not mark a report processed when the target event cannot be fetched', async () => {
    const kv = createKv();
    const recorded = [];

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1984,
      pubkey: REPORTER,
      tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
    }, {
      kv,
      requireDivineClient: true,
      fetchTargetEvent: async () => null,
      recordReport: async (payload) => {
        recorded.push(payload);
        return { action: 'REVIEW', distinctReporterCount: 1 };
      },
    });

    expect(result).toEqual({ status: 'target_unavailable', targetEventId: TARGET_EVENT_ID });
    expect(recorded).toHaveLength(0);
    expect(kv.store.has(processedReportKey(REPORT_EVENT_ID))).toBe(false);
    expect(kv.puts).toHaveLength(0);
  });
});
