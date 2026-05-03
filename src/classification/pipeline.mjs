// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Classification pipeline for video topic/category detection
// ABOUTME: Keeps Hive VLM classification disabled unless an explicit future integration is restored

/**
 * Run the VLM classification pipeline on a video.
 *
 * Hive VLM classification is intentionally disabled. The service now keeps
 * uploads playable in team review and uses local transcript topic extraction
 * in `src/moderation/pipeline.mjs` for low-cost review context.
 *
 * @param {string} videoUrl - Public URL to the video
 * @param {Object} env - Environment variables
 * @param {Object} options - Pipeline options
 * @param {string} [options.sha256] - Video hash (for logging / correlation)
 * @param {Function} [options.fetchFn] - Custom fetch (for testing)
 * @param {number} [options.maxLabels=50] - Maximum labels to return
 * @returns {Promise<Object>} Classification result
 */
export async function classifyVideo(videoUrl, env, options = {}) {
  const sha256 = options.sha256 || 'unknown';

  console.warn(`[Classification] Hive VLM classification disabled for ${sha256}; skipping external classification`);
  return {
    provider: null,
    sha256,
    skipped: true,
    reason: 'Hive VLM classification disabled; team review uses local transcript topics only',
    labels: [],
    topics: [],
    setting: '',
    objects: [],
    activities: [],
    mood: '',
    description: '',
    topCategories: [],
    topSettings: [],
    topObjects: []
  };
}

/**
 * Format classification result for storage in KV.
 *
 * Strips the raw provider response to keep the stored payload compact.
 * Includes the VLM description (valuable for search and human review).
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {Object|null} Compact representation for KV storage
 */
export function formatForStorage(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return null;
  }

  return {
    provider: classificationResult.provider,
    sha256: classificationResult.sha256,
    processingTime: classificationResult.processingTime,
    labels: classificationResult.labels,
    topics: classificationResult.topics,
    setting: classificationResult.setting,
    objects: classificationResult.objects,
    activities: classificationResult.activities,
    mood: classificationResult.mood,
    description: classificationResult.description,
    topCategories: classificationResult.topCategories,
    topSettings: classificationResult.topSettings,
    topObjects: classificationResult.topObjects,
    classesDetected: classificationResult.classesDetected,
    extractedAt: classificationResult.extractedAt
  };
}

/**
 * Format classification labels into the gorse item-labels payload.
 *
 * Gorse expects item labels as an array of strings.  We prefix each
 * label with its namespace so topics from different axes don't collide:
 *
 *   topic:music, setting:indoor-studio, object:microphone
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {string[]} Array of namespaced label strings for gorse
 */
export function formatForGorse(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return [];
  }

  return (classificationResult.labels || []).map(
    ({ label, namespace }) => `${namespace}:${label}`
  );
}

/**
 * Format classification result into the funnelcake topics payload.
 *
 * Funnelcake expects a map of topic -> weight (0-1).
 *
 * @param {Object} classificationResult - Output of classifyVideo
 * @returns {Object} Map of topic string to weight
 */
export function formatForFunnelcake(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return {};
  }

  const topics = {};
  for (const { label, namespace, score } of (classificationResult.labels || [])) {
    topics[`${namespace}:${label}`] = score;
  }
  return topics;
}
