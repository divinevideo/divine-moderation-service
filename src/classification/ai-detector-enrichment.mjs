// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Enrichment path that calls divine-ai-detector and writes its verdicts to ClickHouse
// ABOUTME: Gated off by default; produces review evidence, never enforcement actions

import { detectSignals } from '../moderation/ai-detector-client.mjs';
import { writeModerationLabels } from '../moderation/label-writer.mjs';

/**
 * nsfw model classes -> classifier categories understood by
 * classifierCategoryToLabels(). `neutral` and `drawings` never map: they are
 * the model's negative classes and must not produce a label.
 */
const NSFW_CLASS_TO_CATEGORY = {
  porn: 'porn',
  sexy: 'sexual',
  hentai: 'sexual',
};

export const AI_DETECTOR_SOURCE = {
  sourceId: 'divine-ai-detector',
  sourceOwner: 'divine',
  sourceType: 'machine-labeler',
  transport: 'ai-detector-enrichment',
  operation: 'apply',
};

/**
 * Is the enrichment path switched on?
 *
 * Defaults to off. Merging this must not change behaviour: turning it on is a
 * deliberate act, because proactive classification was deliberately retired in
 * the May 2026 pivot to report-driven review.
 *
 * @param {Object} env
 * @returns {boolean}
 */
export function isEnrichmentEnabled(env = {}) {
  return env.AI_DETECTOR_ENRICHMENT_ENABLED === 'true'
    && !!(env.AI_DETECTOR_BASE_URL || env.SCENE_CLASSIFICATION_BASE_URL);
}

/**
 * Convert a `/detect` nsfw envelope into the score map writeModerationLabels
 * expects.
 *
 * Only a `detected` envelope yields a score. `absent` means the model ran and
 * found nothing; `skipped` means it never ran; `error` means it failed. None of
 * those are evidence of anything and must not be written — an absent result
 * that became a zero-scored label would be indistinguishable downstream from a
 * model that was never configured.
 *
 * @param {Object} envelope - one signal envelope from detectSignals()
 * @returns {Object} category -> confidence, possibly empty
 */
export function nsfwEnvelopeToScores(envelope) {
  if (!envelope || envelope.state !== 'detected') return {};
  const category = NSFW_CLASS_TO_CATEGORY[envelope.class];
  if (!category) return {};
  const confidence = typeof envelope.confidence === 'number' ? envelope.confidence : 0;
  if (!(confidence > 0)) return {};
  return { [category]: confidence };
}

/**
 * Run divine-ai-detector over one video and write any verdicts to ClickHouse.
 *
 * Never throws: enrichment is best-effort and must not fail the caller's
 * classification. Returns a small summary for logging.
 *
 * @param {string} sha256
 * @param {string} videoUrl
 * @param {Object} env
 * @param {Object} [opts]
 * @param {Function} [opts.detect] - injectable detectSignals, for tests
 * @param {Function} [opts.writeLabels] - injectable writer, for tests
 * @returns {Promise<{skipped: boolean, reason?: string, labelsWritten: number, signals?: Object}>}
 */
export async function enrichWithAiDetector(sha256, videoUrl, env = {}, opts = {}) {
  if (!isEnrichmentEnabled(env)) {
    return { skipped: true, reason: 'AI_DETECTOR_ENRICHMENT_ENABLED is not true', labelsWritten: 0 };
  }
  if (!videoUrl) {
    return { skipped: true, reason: 'no video URL', labelsWritten: 0 };
  }

  const detect = opts.detect || detectSignals;
  const writeLabels = opts.writeLabels || writeModerationLabels;

  let response;
  try {
    response = await detect({ url: videoUrl, sha256, signals: ['nsfw'] }, env);
  } catch (error) {
    console.warn(`[AI-DETECTOR] detect failed for ${sha256}: ${error.message}`);
    return { skipped: true, reason: `detect failed: ${error.message}`, labelsWritten: 0 };
  }

  const nsfw = response?.signals?.nsfw;
  const scores = nsfwEnvelopeToScores(nsfw);
  const states = { nsfw: nsfw?.state || 'missing' };

  if (Object.keys(scores).length === 0) {
    console.log(`[AI-DETECTOR] ${sha256}: nsfw=${states.nsfw}, no labels`);
    return { skipped: false, labelsWritten: 0, signals: states };
  }

  // action stays empty: this is review evidence, not an enforcement decision.
  const classification = {
    action: '',
    provider: 'divine-ai-detector',
    scores,
  };

  try {
    await writeLabels(sha256, classification, env, AI_DETECTOR_SOURCE);
  } catch (error) {
    console.warn(`[AI-DETECTOR] label write failed for ${sha256}: ${error.message}`);
    return { skipped: false, labelsWritten: 0, signals: states };
  }

  const written = Object.keys(scores).length;
  console.log(
    `[AI-DETECTOR] ${sha256}: nsfw=${nsfw.class} ${nsfw.confidence?.toFixed?.(3)} `
    + `(${nsfw.frames_flagged}/${nsfw.total_frames} frames) -> ${written} label(s)`
  );
  return { skipped: false, labelsWritten: written, signals: states };
}
