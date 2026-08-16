// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Client for realness.divine.video multi-provider AI detection API
// ABOUTME: Submits videos for analysis by Reality Defender, Hive, and Sensity

/**
 * realness.divine.video API endpoints
 * This service aggregates results from 3 AI detection providers:
 * - Reality Defender: Enterprise deepfake detection (api.prd.realitydefender.xyz)
 * - HiveAI: AI-generated content detection (api.thehive.ai)
 * - Sensity: Deepfake video analysis (api.sensity.ai)
 */
const REALNESS_API_BASE = 'https://realness.divine.video';

/**
 * Detection verdicts based on AI probability score
 * - AUTHENTIC: score < 0.3 (likely real/human-created content)
 * - UNCERTAIN: 0.3 <= score < 0.7 (needs human review)
 * - LIKELY_AI: score >= 0.7 (high probability of AI generation)
 */
export const VERDICT_THRESHOLDS = {
  AUTHENTIC: 0.3,
  LIKELY_AI: 0.7
};

/**
 * Submit a video for multi-provider AI detection analysis
 *
 * The realness.divine.video service:
 * 1. Receives video URL and optional Nostr event ID
 * 2. Submits to Reality Defender, Hive, and Sensity in parallel
 * 3. Stores results in Durable Object for consistency
 * 4. Returns job ID for polling
 *
 * @param {string} videoUrl - CDN URL to video (must be publicly accessible)
 * @param {Object} metadata - Video metadata
 * @param {string} metadata.sha256 - SHA256 hash of video content
 * @param {string} [metadata.eventId] - Nostr event ID if available
 * @param {Object} env - Environment variables
 * @param {Object} options - Request options
 * @param {Function} [options.fetchFn] - Custom fetch function for testing
 * @returns {Promise<Object>} Job creation response with jobId
 */
export async function submitVideoForAnalysis(videoUrl, metadata, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  const requestBody = {
    videoUrl: videoUrl,
    mediaHash: metadata.sha256
  };

  // Include event ID if available (for Nostr integration)
  if (metadata.eventId) {
    requestBody.eventId = metadata.eventId;
  }

  console.log(`[RealityDefender] Submitting to realness.divine.video: ${metadata.sha256}`);

  const response = await fetchFn(`${REALNESS_API_BASE}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Realness API error ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  console.log(`[RealityDefender] Job created: ${result.jobId || result.event_id}`);

  return result;
}

/**
 * Get analysis job results from realness.divine.video
 *
 * Job response structure:
 * {
 *   event_id: string,        // Nostr event ID or generated ID
 *   media_hash: string,      // SHA256 of video
 *   video_url: string,       // CDN URL
 *   status: string,          // "pending" | "processing" | "complete" | "error"
 *   submitted: ISO8601,      // When job was created
 *   completed: ISO8601,      // When all providers finished (null if pending)
 *   results: {               // Per-provider results
 *     reality_defender: DetectionResult,
 *     hive: DetectionResult,
 *     sensity: DetectionResult
 *   },
 *   error: string | null
 * }
 *
 * DetectionResult structure:
 * {
 *   provider: string,        // "reality_defender" | "hive" | "sensity"
 *   status: string,          // "pending" | "processing" | "complete" | "error"
 *   score: number | null,    // 0-1 AI probability (null if pending/error)
 *   verdict: string | null,  // "AUTHENTIC" | "UNCERTAIN" | "LIKELY_AI"
 *   raw: object | null,      // Full provider response for debugging
 *   error: string | null     // Error message if status is "error"
 * }
 *
 * @param {string} jobId - Job ID (event_id or media_hash)
 * @param {Object} env - Environment variables
 * @param {Object} options - Request options
 * @param {Function} [options.fetchFn] - Custom fetch function for testing
 * @returns {Promise<Object>} Job status and results
 */
export async function getJobResults(jobId, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;

  const response = await fetchFn(`${REALNESS_API_BASE}/api/jobs/${jobId}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const errorText = await response.text();
    throw new Error(`Realness API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Submit video and poll until complete or timeout
 *
 * This is the main entry point for synchronous-style usage.
 * It handles the async nature of the multi-provider analysis.
 *
 * Provider processing times (typical):
 * - Reality Defender: 10-30 seconds
 * - HiveAI: 5-15 seconds
 * - Sensity: 15-45 seconds
 *
 * @param {string} videoUrl - CDN URL to video
 * @param {Object} metadata - Video metadata with sha256
 * @param {Object} env - Environment variables
 * @param {Object} options - Request options
 * @param {number} [options.maxWaitMs=60000] - Maximum time to wait for results
 * @param {number} [options.pollIntervalMs=3000] - Interval between status checks
 * @param {Function} [options.fetchFn] - Custom fetch function
 * @returns {Promise<Object>} Complete job results from all providers
 */
export async function analyzeVideoWithRealness(videoUrl, metadata, env, options = {}) {
  const maxWaitMs = options.maxWaitMs || 60000;
  const pollIntervalMs = options.pollIntervalMs || 3000;
  const fetchFn = options.fetchFn || fetch;

  // Submit for analysis
  const submitResult = await submitVideoForAnalysis(videoUrl, metadata, env, { fetchFn });
  const jobId = submitResult.jobId || submitResult.event_id || metadata.sha256;

  // If already complete (cached/dedup), return immediately
  if (submitResult.status === 'complete' && submitResult.results) {
    console.log(`[RealityDefender] Job already complete (cached): ${jobId}`);
    return submitResult;
  }

  // Poll for results
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollIntervalMs);

    const job = await getJobResults(jobId, env, { fetchFn });
    console.log(`[RealityDefender] Job ${jobId} status: ${job.status}`);

    if (job.status === 'complete' || job.status === 'error') {
      return job;
    }

    // Log individual provider progress
    if (job.results) {
      const providers = Object.keys(job.results);
      const complete = providers.filter(p =>
        job.results[p]?.status === 'complete' || job.results[p]?.status === 'error'
      );
      console.log(`[RealityDefender] Progress: ${complete.length}/${providers.length} providers complete`);
    }
  }

  // Timeout - return partial results
  const finalJob = await getJobResults(jobId, env, { fetchFn });
  console.warn(`[RealityDefender] Timeout after ${maxWaitMs}ms, returning partial results`);
  return finalJob;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
