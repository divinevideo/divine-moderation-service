// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests inbound NIP-56 report parsing and processing
// ABOUTME: Covers kind 1984 target resolution, report type mapping, and idempotence

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractReportTargetEventId,
  extractReportType,
  fetchReportsFromRelay,
  getLastReportPollTimestamp,
  isDivineClientReport,
  pollRelayForReports,
  processReportEvent,
  processedReportKey,
  setLastReportPollTimestamp,
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
const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

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

  it('terminally skips non-kind-1984 events without recording', async () => {
    const kv = createKv();
    const calls = { fetchTargetEvent: 0, recordReport: 0 };

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1,
      pubkey: REPORTER,
      tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
      content: '',
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

    expect(result.status).toBe('skipped_non_report_kind');
    expect(calls).toEqual({ fetchTargetEvent: 0, recordReport: 0 });
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe(processedReportKey(REPORT_EVENT_ID));
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 * 60 * 24 * 90 });
    expect(JSON.parse(kv.store.get(processedReportKey(REPORT_EVENT_ID)))).toMatchObject({
      status: 'skipped_non_report_kind',
      kind: 1,
    });
  });

  it('terminally skips reports with malformed reporter pubkeys without recording', async () => {
    const kv = createKv();
    const calls = { fetchTargetEvent: 0, recordReport: 0 };

    const result = await processReportEvent({
      id: REPORT_EVENT_ID,
      kind: 1984,
      pubkey: '../not-hex',
      tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
      content: '',
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

    expect(result.status).toBe('skipped_invalid_reporter_pubkey');
    expect(calls).toEqual({ fetchTargetEvent: 0, recordReport: 0 });
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].key).toBe(processedReportKey(REPORT_EVENT_ID));
    expect(kv.puts[0].options).toEqual({ expirationTtl: 60 * 60 * 24 * 90 });
    expect(JSON.parse(kv.store.get(processedReportKey(REPORT_EVENT_ID)))).toMatchObject({
      status: 'skipped_invalid_reporter_pubkey',
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

describe('fetchReportsFromRelay', () => {
  it('rejects when the relay closes the active subscription', async () => {
    const sent = [];

    globalThis.WebSocket = class {
      constructor() {
        this.listeners = new Map();
        queueMicrotask(() => this.emit('open', {}));
      }

      addEventListener(type, listener) {
        this.listeners.set(type, listener);
      }

      send(message) {
        sent.push(JSON.parse(message));
        const [, subscriptionId] = JSON.parse(message);
        this.emit('message', {
          data: JSON.stringify(['CLOSED', subscriptionId, 'blocked: auth-required']),
        });
      }

      close() {}

      emit(type, event) {
        this.listeners.get(type)?.(event);
      }
    };

    await expect(fetchReportsFromRelay('wss://relay.example', {
      since: 1778680000,
      limit: 50,
    })).rejects.toThrow('blocked: auth-required');
    expect(sent[0]).toEqual([
      'REQ',
      expect.any(String),
      { kinds: [1984], since: 1778680000, limit: 50 },
    ]);
  });
});

describe('report polling checkpoint', () => {
  it('stores and reads a separate report poll checkpoint', async () => {
    const kv = createKv(new Map([['relay-poller:last-poll', JSON.stringify({ timestamp: 123 })]]));

    await setLastReportPollTimestamp({ MODERATION_KV: kv }, 1778692782, {
      totalReports: 3,
      recorded: 2,
      skipped: 1,
    });

    await expect(getLastReportPollTimestamp({ MODERATION_KV: kv })).resolves.toBe(1778692782);
    expect(JSON.parse(kv.store.get('report-poller:last-poll'))).toMatchObject({
      timestamp: 1778692782,
      totalReports: 3,
      recorded: 2,
      skipped: 1,
    });
    expect(JSON.parse(kv.store.get('relay-poller:last-poll'))).toEqual({ timestamp: 123 });
  });
});

describe('report polling', () => {
  it('processes fetched reports and returns counters', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kv = createKv(new Map([[processedReportKey('b'.repeat(64)), '{"status":"recorded"}']]));
    const db = {};
    const targetUnavailableId = '1'.repeat(64);
    const reports = [
      {
        id: REPORT_EVENT_ID,
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692782,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: 'b'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692783,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: '3'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['client', 'diVine']],
        content: '',
      },
      {
        id: '4'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692785,
        tags: [['e', targetUnavailableId, 'spam'], ['client', 'diVine']],
        content: '',
      },
      {
        id: '5'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692786,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
    ];

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: db,
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 50,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async (relayUrl, query, env) => {
          expect(relayUrl).toBe('wss://relay.divine.video');
          expect(query).toEqual({ since: 1778680000, limit: 50 });
          expect(env.BLOSSOM_DB).toBe(db);
          return reports;
        },
        fetchTargetEvent: async (eventId) => (eventId === targetUnavailableId ? null : TARGET),
        recordReport: async (payload) => {
          if (payload.reportEventId === '5'.repeat(64)) {
            throw new Error('record failed');
          }
          return { success: true, action: 'REVIEW', distinctReporterCount: 1 };
        },
      });

      expect(result).toMatchObject({
        totalReports: 5,
        recorded: 1,
        alreadyProcessed: 1,
        skipped: 1,
        targetUnavailable: 1,
        safeCheckpoint: 1778692784,
        maxTerminalCreatedAt: 1778692784,
      });
      expect(result.reports).toEqual([
        expect.objectContaining({ status: 'recorded' }),
        { status: 'already_processed' },
        { status: 'skipped_missing_target' },
        { status: 'target_unavailable', targetEventId: targetUnavailableId },
      ]);
      expect(result.errors).toEqual([
        { reportId: '5'.repeat(64), error: 'record failed' },
      ]);
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('uses the newest terminal report timestamp as the safe checkpoint when every report is terminal', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv(new Map([[processedReportKey('b'.repeat(64)), '{"status":"recorded"}']]));
    const reports = [
      {
        id: REPORT_EVENT_ID,
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692782,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: 'b'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692783,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: '3'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['client', 'diVine']],
        content: '',
      },
    ];

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 4,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async () => reports,
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(result).toMatchObject({
        totalReports: 3,
        recorded: 1,
        alreadyProcessed: 1,
        skipped: 1,
        targetUnavailable: 0,
        safeCheckpoint: 1778692784,
        maxTerminalCreatedAt: 1778692784,
      });
      expect(result.errors).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('does not expose a safe checkpoint when a relay returns a saturated page', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv();
    const reports = [
      {
        id: REPORT_EVENT_ID,
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692782,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: 'b'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692783,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
    ];

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 2,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async () => reports,
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(result).toMatchObject({
        totalReports: 2,
        recorded: 2,
        saturated: true,
        safeCheckpoint: null,
      });
      expect(result.maxTerminalCreatedAt).toBeNull();
      expect(result.errors).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('drains saturated pages with until and exposes a checkpoint when the final page is not saturated', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv();
    const fetchCalls = [];
    const reportsByUntil = new Map([
      [undefined, [
        {
          id: REPORT_EVENT_ID,
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692784,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
        {
          id: 'b'.repeat(64),
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692783,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
      ]],
      [1778692782, [
        {
          id: '3'.repeat(64),
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692782,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
      ]],
    ]);

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 2,
        maxPages: 5,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async (relayUrl, query) => {
          fetchCalls.push({ relayUrl, query });
          return reportsByUntil.get(query.until);
        },
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(fetchCalls).toEqual([
        { relayUrl: 'wss://relay.divine.video', query: { since: 1778680000, limit: 2 } },
        { relayUrl: 'wss://relay.divine.video', query: { since: 1778680000, limit: 2, until: 1778692782 } },
      ]);
      expect(result).toMatchObject({
        totalReports: 3,
        recorded: 3,
        saturated: false,
        safeCheckpoint: 1778692784,
        maxTerminalCreatedAt: 1778692784,
      });
      expect(result.errors).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('keeps saturation and suppresses checkpoint when max pages are all full', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv();
    const fetchCalls = [];
    const reportsByUntil = new Map([
      [undefined, [
        {
          id: REPORT_EVENT_ID,
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692784,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
        {
          id: 'b'.repeat(64),
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692783,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
      ]],
      [1778692782, [
        {
          id: '3'.repeat(64),
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692782,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
        {
          id: '4'.repeat(64),
          kind: 1984,
          pubkey: REPORTER,
          created_at: 1778692781,
          tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
          content: '',
        },
      ]],
    ]);

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 2,
        maxPages: 2,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async (relayUrl, query) => {
          fetchCalls.push({ relayUrl, query });
          return reportsByUntil.get(query.until);
        },
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[1].query.until).toBe(1778692782);
      expect(result).toMatchObject({
        totalReports: 4,
        recorded: 4,
        saturated: true,
        safeCheckpoint: null,
      });
      expect(result.maxTerminalCreatedAt).toBeNull();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('treats a saturated same-timestamp page as unsafe and does not skip that timestamp boundary', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv();
    const fetchCalls = [];
    const reports = [
      {
        id: REPORT_EVENT_ID,
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: 'b'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
    ];

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 2,
        maxPages: 5,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async (relayUrl, query) => {
          fetchCalls.push({ relayUrl, query });
          return query.until === undefined ? reports : [];
        },
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(fetchCalls).toEqual([
        { relayUrl: 'wss://relay.divine.video', query: { since: 1778680000, limit: 2 } },
      ]);
      expect(result).toMatchObject({
        totalReports: 2,
        recorded: 2,
        saturated: true,
        safeCheckpoint: null,
      });
      expect(result.maxTerminalCreatedAt).toBeNull();
      expect(result.errors).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('treats a saturated page with duplicate lower-boundary timestamps as unsafe', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const kv = createKv();
    const fetchCalls = [];
    const reports = [
      {
        id: REPORT_EVENT_ID,
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692785,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: 'b'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
      {
        id: '1'.repeat(64),
        kind: 1984,
        pubkey: REPORTER,
        created_at: 1778692784,
        tags: [['e', TARGET_EVENT_ID, 'nudity'], ['client', 'diVine']],
        content: '',
      },
    ];

    try {
      const result = await pollRelayForReports({
        BLOSSOM_DB: {},
        MODERATION_KV: kv,
        RELAY_REPORTS_REQUIRE_DIVINE_CLIENT: 'true',
      }, {
        since: 1778680000,
        limit: 3,
        maxPages: 5,
        relays: ['wss://relay.divine.video'],
        fetchReportsFromRelay: async (relayUrl, query) => {
          fetchCalls.push({ relayUrl, query });
          return query.until === undefined ? reports : [];
        },
        fetchTargetEvent: async () => TARGET,
        recordReport: async () => ({ success: true, action: 'REVIEW', distinctReporterCount: 1 }),
      });

      expect(fetchCalls).toEqual([
        { relayUrl: 'wss://relay.divine.video', query: { since: 1778680000, limit: 3 } },
      ]);
      expect(result).toMatchObject({
        totalReports: 3,
        recorded: 3,
        saturated: true,
        safeCheckpoint: null,
      });
      expect(result.maxTerminalCreatedAt).toBeNull();
      expect(result.errors).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });
});
