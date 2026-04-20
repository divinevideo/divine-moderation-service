// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Tests for scripts/e2e-creator-delete.mjs — pure helpers + main() with injected deps.
// ABOUTME: Vitest runs under @cloudflare/vitest-pool-workers; nodejs_compat is on.

import { describe, it, expect } from 'vitest';
import { parseArgs } from './e2e-creator-delete.mjs';

describe('parseArgs', () => {
  it('returns defaults when no flags given', () => {
    const cfg = parseArgs([]);
    expect(cfg).toEqual({
      scenario: 'both',
      stagingRelay: 'wss://relay.staging.divine.video',
      funnelcakeApi: 'https://funnelcake.staging.dvines.org',
      blossomBase: 'https://media.divine.video',
      modServiceBase: 'https://moderation-api.divine.video',
      d1Database: 'blossom-webhook-events',
      cronWaitSeconds: 180,
      skipCleanup: false
    });
  });

  it('parses --scenario=sync', () => {
    expect(parseArgs(['--scenario=sync']).scenario).toBe('sync');
  });

  it('parses --scenario=cron', () => {
    expect(parseArgs(['--scenario=cron']).scenario).toBe('cron');
  });

  it('rejects unknown scenario', () => {
    expect(() => parseArgs(['--scenario=foo'])).toThrow(/scenario/i);
  });

  it('parses --skip-cleanup as boolean', () => {
    expect(parseArgs(['--skip-cleanup']).skipCleanup).toBe(true);
  });

  it('parses --cron-wait-seconds as positive integer', () => {
    expect(parseArgs(['--cron-wait-seconds=240']).cronWaitSeconds).toBe(240);
  });

  it('rejects --cron-wait-seconds=0', () => {
    expect(() => parseArgs(['--cron-wait-seconds=0'])).toThrow(/cron-wait/i);
  });

  it('parses URL overrides', () => {
    const cfg = parseArgs([
      '--staging-relay=wss://localhost:7777',
      '--funnelcake-api=http://localhost:8080',
      '--blossom-base=http://localhost:7676',
      '--mod-service-base=http://localhost:8787'
    ]);
    expect(cfg.stagingRelay).toBe('wss://localhost:7777');
    expect(cfg.funnelcakeApi).toBe('http://localhost:8080');
    expect(cfg.blossomBase).toBe('http://localhost:7676');
    expect(cfg.modServiceBase).toBe('http://localhost:8787');
  });
});
