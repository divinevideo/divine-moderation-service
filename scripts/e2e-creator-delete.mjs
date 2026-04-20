#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: End-to-end test for the creator-delete pipeline (mod-service#101).
// ABOUTME: Operator-run. Exercises sync + cron paths against staging relay + prod Blossom + prod mod-service.

const DEFAULT_STAGING_RELAY = 'wss://relay.staging.divine.video';
const DEFAULT_FUNNELCAKE_API = 'https://funnelcake.staging.dvines.org';
const DEFAULT_BLOSSOM_BASE = 'https://media.divine.video';
const DEFAULT_MOD_SERVICE_BASE = 'https://moderation-api.divine.video';
const DEFAULT_D1_DATABASE = 'blossom-webhook-events';
const DEFAULT_CRON_WAIT_SECONDS = 180;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function getFlag(argv, name) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a === `--${name}`) return true;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value} (must be positive integer)`);
  }
  return n;
}

export function parseArgs(argv) {
  const rawScenario = getFlag(argv, 'scenario');
  const scenario = rawScenario === null || rawScenario === true ? 'both' : rawScenario;
  if (!['sync', 'cron', 'both'].includes(scenario)) {
    throw new Error(`Invalid scenario: ${scenario} (must be sync|cron|both)`);
  }

  const rawCron = getFlag(argv, 'cron-wait-seconds');
  const cronWaitSeconds = rawCron
    ? validatePositiveInt(rawCron, 'cron-wait-seconds')
    : DEFAULT_CRON_WAIT_SECONDS;

  return {
    scenario,
    stagingRelay: getFlag(argv, 'staging-relay') || DEFAULT_STAGING_RELAY,
    funnelcakeApi: getFlag(argv, 'funnelcake-api') || DEFAULT_FUNNELCAKE_API,
    blossomBase: getFlag(argv, 'blossom-base') || DEFAULT_BLOSSOM_BASE,
    modServiceBase: getFlag(argv, 'mod-service-base') || DEFAULT_MOD_SERVICE_BASE,
    d1Database: getFlag(argv, 'd1-database') || DEFAULT_D1_DATABASE,
    cronWaitSeconds,
    skipCleanup: getFlag(argv, 'skip-cleanup') === true
  };
}
