// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: KV-backed settings for community label aggregation with code
// ABOUTME: defaults. The enabled flag doubles as the Osprey cutover lever.

const ENABLED_KEY = 'community_labels_enabled';
const THRESHOLD_KEY = 'community_label_threshold';
const WARNING_COUNT_KEY = 'strike_warning_count';
const BATCH_LIMIT_KEY = 'community_sweep_batch_limit';
const CURSOR_KEY = 'community_labels_cursor';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WARNING_COUNT = 3;
const DEFAULT_BATCH_LIMIT = 50;
const FIRST_RUN_LOOKBACK_SECONDS = 24 * 60 * 60;

async function positiveIntSetting(kv, key, fallback) {
  const raw = await kv.get(key);
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Kill switch: only the exact string 'true' enables the pipeline. */
export async function isEnabled(kv) {
  return (await kv.get(ENABLED_KEY)) === 'true';
}

/** Distinct Divine-identity authors required to auto-apply a label. */
export function getThreshold(kv) {
  return positiveIntSetting(kv, THRESHOLD_KEY, DEFAULT_THRESHOLD);
}

/** Strike count at which the creator gets a warning DM. */
export function getWarningCount(kv) {
  return positiveIntSetting(kv, WARNING_COUNT_KEY, DEFAULT_WARNING_COUNT);
}

/** Maximum videos evaluated per sweep tick; excess rolls to the next tick. */
export function getBatchLimit(kv) {
  return positiveIntSetting(kv, BATCH_LIMIT_KEY, DEFAULT_BATCH_LIMIT);
}

/**
 * Poll cursor (unix seconds). First run looks back 24h rather than
 * replaying all history.
 */
export async function getCursor(kv, nowSeconds) {
  const raw = await kv.get(CURSOR_KEY);
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return nowSeconds - FIRST_RUN_LOOKBACK_SECONDS;
}

/** Advance the poll cursor after a fully successful sweep. */
export async function setCursor(kv, seconds) {
  await kv.put(CURSOR_KEY, String(seconds));
}
