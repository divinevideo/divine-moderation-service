// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Normalizes multi-provider AI detection results to Divine's standard format
// ABOUTME: Aggregates scores from Reality Defender, HiveAI, and Sensity

/**
 * Provider Details and Response Formats
 * =====================================
 *
 * REALITY DEFENDER (api.prd.realitydefender.xyz)
 * -----------------------------------------------
 * Enterprise deepfake detection focused on video authenticity.
 * Specializes in face manipulation, voice cloning, and synthetic media.
 *
 * Raw webhook response:
 * {
 *   status: "complete" | "error",
 *   result: {
 *     score: 0.85,           // AI probability 0-1
 *     confidence: 0.92,      // Detection confidence
 *     details: {
 *       face_swap: 0.12,     // Face manipulation score
 *       lip_sync: 0.05,      // Lip-sync deepfake score
 *       voice_clone: 0.02,   // Voice cloning score
 *       full_synthetic: 0.85 // Fully AI-generated score
 *     }
 *   },
 *   ai_probability: 0.85     // Alternative location for score
 * }
 *
 * Verdict thresholds: <0.3 AUTHENTIC, 0.3-0.7 UNCERTAIN, >=0.7 LIKELY_AI
 *
 *
 * HIVE AI (api.thehive.ai)
 * -------------------------
 * Multi-model AI detection platform. The realness service uses their
 * AI-generated content detection model (separate from content moderation).
 *
 * Raw webhook response:
 * {
 *   status: "complete",
 *   result: {
 *     deepfake_score: 0.15,       // Deepfake probability
 *     ai_generated_score: 0.72,  // AI-generated content score
 *     synthetic_score: 0.68      // Synthetic media score
 *   }
 * }
 *
 * The realness service takes the MAX of these scores as the primary score.
 * This captures the most concerning detection signal.
 *
 *
 * SENSITY (api.sensity.ai)
 * -------------------------
 * Specialized deepfake detection with forensic analysis.
 * Strong at detecting face swaps and GAN-generated faces.
 *
 * Raw webhook response:
 * {
 *   status: "done",
 *   analysis: {
 *     deepfake_probability: 0.23,  // Primary deepfake score
 *     detection_score: 0.25,       // Alternative score field
 *     confidence: 0.88,            // Detection confidence
 *     techniques_detected: [       // Specific manipulations found
 *       "face_swap",
 *       "expression_manipulation"
 *     ]
 *   }
 * }
 *
 *
 * AGGREGATED JOB RESPONSE (from realness.divine.video)
 * -----------------------------------------------------
 * {
 *   event_id: "abc123...",
 *   media_hash: "sha256...",
 *   video_url: "https://cdn.divine.video/...",
 *   status: "complete",
 *   submitted: "2024-01-15T10:30:00Z",
 *   completed: "2024-01-15T10:30:45Z",
 *   results: {
 *     reality_defender: {
 *       provider: "reality_defender",
 *       status: "complete",
 *       score: 0.85,
 *       verdict: "LIKELY_AI",
 *       raw: { ... full response ... },
 *       error: null
 *     },
 *     hive: {
 *       provider: "hive",
 *       status: "complete",
 *       score: 0.72,
 *       verdict: "LIKELY_AI",
 *       raw: { ... },
 *       error: null
 *     },
 *     sensity: {
 *       provider: "sensity",
 *       status: "complete",
 *       score: 0.23,
 *       verdict: "AUTHENTIC",
 *       raw: { ... },
 *       error: null
 *     }
 *   }
 * }
 */

/**
 * Normalize multi-provider AI detection results to Divine's standard format
 *
 * Aggregation strategy:
 * - ai_generated: Maximum score across all providers (most conservative)
 * - deepfake: Maximum deepfake-specific score
 * - Individual provider scores preserved in details
 *
 * @param {Object} realnessJob - Complete job response from realness.divine.video
 * @returns {Object} Normalized result matching Divine's NormalizedModerationResult
 */
export function normalizeRealnessResponse(realnessJob) {
  // Initialize standard scores (AI detection focused)
  const scores = {
    // Content moderation scores (not provided by this service)
    nudity: 0,
    violence: 0,
    gore: 0,
    offensive: 0,
    weapons: 0,
    drugs: 0,
    alcohol: 0,
    tobacco: 0,
    gambling: 0,
    selfHarm: 0,

    // AI detection scores (primary purpose of this provider)
    ai_generated: 0,
    deepfake: 0
  };

  const details = {
    ai_detection: {
      consensus: null,
      providers: {},
      aggregation_method: 'max_score'
    }
  };

  const flaggedFrames = [];

  // Handle missing or error state
  if (!realnessJob || !realnessJob.results) {
    return {
      scores,
      details,
      flaggedFrames,
      metadata: {
        job_status: realnessJob?.status || 'error',
        job_id: realnessJob?.event_id || null,
        error: realnessJob?.error || 'No results available'
      }
    };
  }

  const results = realnessJob.results;

  // Extract and normalize each provider's result
  const providerScores = [];

  // Reality Defender
  if (results.reality_defender) {
    const rd = results.reality_defender;
    const rdScore = extractScore(rd);

    details.ai_detection.providers.reality_defender = {
      status: rd.status,
      score: rdScore,
      verdict: rd.verdict || verdictFromScore(rdScore),
      error: rd.error || null,
      // Extract detailed breakdown if available
      breakdown: extractRealityDefenderBreakdown(rd.raw)
    };

    if (rd.status === 'complete' && rdScore !== null) {
      providerScores.push({ provider: 'reality_defender', score: rdScore, weight: 1.0 });
    }
  }

  // Hive AI
  if (results.hive) {
    const hive = results.hive;
    const hiveScore = extractScore(hive);

    details.ai_detection.providers.hive = {
      status: hive.status,
      score: hiveScore,
      verdict: hive.verdict || verdictFromScore(hiveScore),
      error: hive.error || null,
      breakdown: extractHiveBreakdown(hive.raw)
    };

    if (hive.status === 'complete' && hiveScore !== null) {
      providerScores.push({ provider: 'hive', score: hiveScore, weight: 1.0 });
    }
  }

  // Sensity
  if (results.sensity) {
    const sensity = results.sensity;
    const sensityScore = extractScore(sensity);

    details.ai_detection.providers.sensity = {
      status: sensity.status,
      score: sensityScore,
      verdict: sensity.verdict || verdictFromScore(sensityScore),
      error: sensity.error || null,
      breakdown: extractSensityBreakdown(sensity.raw)
    };

    if (sensity.status === 'complete' && sensityScore !== null) {
      providerScores.push({ provider: 'sensity', score: sensityScore, weight: 1.0 });
    }
  }

  // Aggregate scores
  if (providerScores.length > 0) {
    // Use maximum score (most conservative - if ANY provider flags it, we flag it)
    const maxScore = Math.max(...providerScores.map(p => p.score));
    scores.ai_generated = maxScore;

    // Calculate weighted average for secondary reference
    const avgScore = providerScores.reduce((sum, p) => sum + p.score, 0) / providerScores.length;

    // Deepfake is a subset - use max of providers that specifically detect deepfakes
    // Reality Defender and Sensity specialize in deepfakes
    const deepfakeProviders = providerScores.filter(p =>
      p.provider === 'reality_defender' || p.provider === 'sensity'
    );
    scores.deepfake = deepfakeProviders.length > 0
      ? Math.max(...deepfakeProviders.map(p => p.score))
      : maxScore;

    // Determine consensus
    const verdicts = providerScores.map(p => verdictFromScore(p.score));
    details.ai_detection.consensus = determineConsensus(verdicts, providerScores);
    details.ai_detection.average_score = avgScore;
    details.ai_detection.max_score = maxScore;
    details.ai_detection.provider_count = providerScores.length;
  }

  return {
    scores,
    details,
    flaggedFrames,
    metadata: {
      job_status: realnessJob.status,
      job_id: realnessJob.event_id,
      media_hash: realnessJob.media_hash,
      submitted: realnessJob.submitted,
      completed: realnessJob.completed
    }
  };
}

/**
 * Extract score from provider result
 * Handles different response formats
 */
function extractScore(providerResult) {
  if (providerResult.score !== undefined && providerResult.score !== null) {
    return providerResult.score;
  }
  // Fallback to raw response fields
  if (providerResult.raw) {
    return providerResult.raw.ai_probability
      || providerResult.raw.result?.score
      || providerResult.raw.analysis?.deepfake_probability
      || null;
  }
  return null;
}

/**
 * Convert score to verdict string
 */
function verdictFromScore(score) {
  if (score === null || score === undefined) return null;
  if (score < 0.3) return 'AUTHENTIC';
  if (score < 0.7) return 'UNCERTAIN';
  return 'LIKELY_AI';
}

/**
 * Determine consensus from multiple provider verdicts
 */
function determineConsensus(verdicts, providerScores) {
  const validVerdicts = verdicts.filter(v => v !== null);
  if (validVerdicts.length === 0) return null;

  // Count verdicts
  const counts = {
    AUTHENTIC: 0,
    UNCERTAIN: 0,
    LIKELY_AI: 0
  };

  validVerdicts.forEach(v => counts[v]++);

  // Unanimous agreement
  if (counts.AUTHENTIC === validVerdicts.length) {
    return { verdict: 'AUTHENTIC', confidence: 'high', agreement: 'unanimous' };
  }
  if (counts.LIKELY_AI === validVerdicts.length) {
    return { verdict: 'LIKELY_AI', confidence: 'high', agreement: 'unanimous' };
  }

  // Majority agreement (2 of 3)
  if (validVerdicts.length >= 2) {
    if (counts.AUTHENTIC >= 2) {
      return { verdict: 'AUTHENTIC', confidence: 'medium', agreement: 'majority' };
    }
    if (counts.LIKELY_AI >= 2) {
      return { verdict: 'LIKELY_AI', confidence: 'medium', agreement: 'majority' };
    }
  }

  // Mixed results or all uncertain
  return { verdict: 'UNCERTAIN', confidence: 'low', agreement: 'split' };
}

/**
 * Extract detailed breakdown from Reality Defender raw response
 */
function extractRealityDefenderBreakdown(raw) {
  if (!raw) return null;

  const result = raw.result || {};
  return {
    face_swap: result.details?.face_swap || null,
    lip_sync: result.details?.lip_sync || null,
    voice_clone: result.details?.voice_clone || null,
    full_synthetic: result.details?.full_synthetic || null,
    confidence: result.confidence || null
  };
}

/**
 * Extract detailed breakdown from Hive raw response
 */
function extractHiveBreakdown(raw) {
  if (!raw) return null;

  const result = raw.result || raw;
  return {
    deepfake_score: result.deepfake_score || null,
    ai_generated_score: result.ai_generated_score || null,
    synthetic_score: result.synthetic_score || null
  };
}

/**
 * Extract detailed breakdown from Sensity raw response
 */
function extractSensityBreakdown(raw) {
  if (!raw) return null;

  const analysis = raw.analysis || {};
  return {
    deepfake_probability: analysis.deepfake_probability || null,
    detection_score: analysis.detection_score || null,
    confidence: analysis.confidence || null,
    techniques_detected: analysis.techniques_detected || []
  };
}
