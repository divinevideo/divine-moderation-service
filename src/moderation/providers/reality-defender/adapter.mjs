// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Reality Defender provider adapter for multi-provider AI detection
// ABOUTME: Connects to realness.divine.video for Reality Defender, Hive, and Sensity analysis

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { analyzeVideoWithRealness } from './client.mjs';
import { normalizeRealnessResponse } from './normalizer.mjs';

/**
 * Reality Defender Provider
 *
 * This provider integrates with the realness.divine.video service which
 * aggregates AI detection results from three industry-leading providers:
 *
 * 1. REALITY DEFENDER (realitydefender.xyz)
 *    - Enterprise deepfake detection
 *    - Specializes in: face swaps, lip-sync deepfakes, voice cloning
 *    - Used by: news organizations, financial institutions
 *    - Processing time: 10-30 seconds
 *
 * 2. HIVE AI (thehive.ai)
 *    - Multi-purpose AI content detection
 *    - Detects: AI-generated images/video, synthetic media
 *    - Also offers: content moderation (separate API)
 *    - Processing time: 5-15 seconds
 *
 * 3. SENSITY (sensity.ai)
 *    - Forensic deepfake analysis
 *    - Strong at: GAN-generated faces, expression manipulation
 *    - Provides: technique identification
 *    - Processing time: 15-45 seconds
 *
 * WHY MULTI-PROVIDER?
 * -------------------
 * No single AI detection system is perfect. Different providers excel at
 * different types of synthetic media:
 * - Reality Defender is strongest on face-swapped video
 * - Hive excels at fully AI-generated content (SORA, Runway, etc.)
 * - Sensity provides forensic detail on manipulation techniques
 *
 * By combining all three, we get:
 * - Higher detection accuracy through consensus
 * - Reduced false positives (require agreement)
 * - Better coverage across AI generation techniques
 *
 * VERDICT INTERPRETATION
 * ----------------------
 * The service normalizes scores to 0-1 and assigns verdicts:
 *
 * - AUTHENTIC (score < 0.3)
 *   Content appears to be genuine human-created media.
 *   Low probability of AI manipulation or generation.
 *
 * - UNCERTAIN (0.3 <= score < 0.7)
 *   Ambiguous results. May contain minor edits or
 *   characteristics that confuse detectors.
 *   Recommend human review.
 *
 * - LIKELY_AI (score >= 0.7)
 *   High probability of AI-generated or manipulated content.
 *   At least one detector flagged significant synthetic signals.
 *
 * CONSENSUS LOGIC
 * ---------------
 * - Unanimous: All providers agree (high confidence)
 * - Majority: 2 of 3 providers agree (medium confidence)
 * - Split: No agreement (low confidence, defaults to UNCERTAIN)
 */
export class RealityDefenderProvider extends BaseModerationProvider {
  constructor() {
    super('reality-defender', {
      ...STANDARD_CAPABILITIES,

      // This provider focuses on AI detection, NOT content moderation
      nudity: false,
      violence: false,
      gore: false,
      offensive: false,
      weapons: false,
      drugs: false,
      alcohol: false,
      tobacco: false,
      gambling: false,
      selfHarm: false,

      // Primary capabilities: AI/deepfake detection
      aiGenerated: true,
      deepfake: true,

      // Technical capabilities
      textOcr: false,
      qrCode: false,
      asyncProcessing: true,  // Uses webhook-based async processing
      liveStream: false,
      customModels: false,

      // Multi-provider aggregation
      multiProvider: true,
      providersIncluded: ['reality_defender', 'hive', 'sensity'],

      // Input constraints
      maxFileSizeMB: 500,        // CDN handles large files
      maxDurationMinutes: 30,    // Reasonable video length
      supportedFormats: ['mp4', 'webm', 'mov', 'avi']
    });
  }

  /**
   * Check if Reality Defender integration is enabled
   *
   * This provider uses the realness.divine.video service which
   * manages its own API keys. We just need the service URL configured.
   *
   * @param {Object} env - Environment variables
   * @returns {boolean}
   */
  isConfigured(env) {
    // The realness service is always available at realness.divine.video
    // Optionally allow override via environment variable
    return env.REALNESS_API_ENABLED !== 'false';
  }

  /**
   * Analyze video for AI-generated content using multi-provider detection
   *
   * This calls the realness.divine.video service which:
   * 1. Submits the video to Reality Defender, Hive, and Sensity in parallel
   * 2. Collects results via webhooks
   * 3. Returns aggregated scores and consensus verdict
   *
   * @param {string} videoUrl - Public CDN URL to video
   * @param {Object} metadata - Video metadata
   * @param {string} metadata.sha256 - SHA256 hash of video
   * @param {string} [metadata.eventId] - Nostr event ID if available
   * @param {Object} env - Environment variables
   * @param {Object} options - Provider options
   * @param {number} [options.maxWaitMs=60000] - Max time to wait for results
   * @param {boolean} [options.skipAIDetection] - Skip if true (for original Vines)
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    // Skip AI detection for original Vines (pre-2018 content predates modern AI)
    if (options.skipAIDetection) {
      console.log(`[RealityDefender] Skipping for original Vine: ${metadata.sha256}`);
      return {
        provider: this.name,
        processingTime: Date.now() - startTime,
        scores: {
          ai_generated: 0,
          deepfake: 0,
          // No content moderation from this provider
          nudity: 0, violence: 0, gore: 0, offensive: 0,
          weapons: 0, drugs: 0, alcohol: 0, tobacco: 0,
          gambling: 0, selfHarm: 0
        },
        details: {
          skipped: true,
          reason: 'original_vine',
          message: 'Original Vine content predates AI generation technology'
        },
        flaggedFrames: [],
        raw: null
      };
    }

    try {
      console.log(`[RealityDefender] Starting multi-provider AI detection for ${metadata.sha256}`);

      // Call realness.divine.video API and wait for results
      const realnessJob = await analyzeVideoWithRealness(
        videoUrl,
        metadata,
        env,
        {
          maxWaitMs: options.maxWaitMs || 60000,
          pollIntervalMs: options.pollIntervalMs || 3000,
          fetchFn: options.fetchFn
        }
      );

      // Normalize multi-provider results to standard format
      const normalized = normalizeRealnessResponse(realnessJob);

      const processingTime = Date.now() - startTime;
      console.log(`[RealityDefender] Completed in ${processingTime}ms`);

      // Log consensus for visibility
      const consensus = normalized.details?.ai_detection?.consensus;
      if (consensus) {
        console.log(`[RealityDefender] Consensus: ${consensus.verdict} (${consensus.confidence} confidence, ${consensus.agreement})`);
      }

      return {
        ...normalized,
        provider: this.name,
        processingTime,
        raw: realnessJob
      };

    } catch (error) {
      console.error(`[RealityDefender] Analysis failed:`, error.message);
      throw new Error(`Reality Defender analysis failed: ${error.message}`);
    }
  }

  /**
   * Get provider information with multi-provider details
   */
  getInfo() {
    return {
      name: this.name,
      displayName: 'Reality Defender (Multi-Provider)',
      description: 'Aggregated AI detection from Reality Defender, HiveAI, and Sensity',
      capabilities: this.capabilities,
      providers: [
        {
          name: 'reality_defender',
          displayName: 'Reality Defender',
          specialty: 'Face swaps, lip-sync deepfakes, voice cloning',
          website: 'https://realitydefender.xyz'
        },
        {
          name: 'hive',
          displayName: 'Hive AI',
          specialty: 'AI-generated content, synthetic media detection',
          website: 'https://thehive.ai'
        },
        {
          name: 'sensity',
          displayName: 'Sensity',
          specialty: 'Forensic deepfake analysis, technique identification',
          website: 'https://sensity.ai'
        }
      ],
      verdictThresholds: {
        AUTHENTIC: 'score < 0.3',
        UNCERTAIN: '0.3 <= score < 0.7',
        LIKELY_AI: 'score >= 0.7'
      },
      aggregationMethod: 'Maximum score across providers (conservative)'
    };
  }
}
