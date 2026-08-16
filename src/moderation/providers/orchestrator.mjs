// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Provider orchestration for selecting and executing moderation providers
// ABOUTME: Handles provider selection, fallback chains, and parallel execution

import { AWSRekognitionProvider } from './aws-rekognition/adapter.mjs';
import { SightengineProvider } from './sightengine/adapter.mjs';
import { BunnyCDNProvider } from './bunnycdn/adapter.mjs';
import { HiveAIProvider } from './hiveai/adapter.mjs';
import { RealityDefenderProvider } from './reality-defender/adapter.mjs';

/**
 * Provider registry
 *
 * Content Moderation Providers:
 * - hiveai: Primary content moderation + AI detection
 * - sightengine: Legacy fallback for content moderation
 * - bunnycdn: CDN-integrated moderation
 * - aws-rekognition: AWS-based content moderation
 *
 * AI Detection Providers:
 * - reality-defender: Multi-provider AI detection (Reality Defender + Hive + Sensity)
 */
const PROVIDERS = {
  'aws-rekognition': new AWSRekognitionProvider(),
  'sightengine': new SightengineProvider(),
  'bunnycdn': new BunnyCDNProvider(),
  'hiveai': new HiveAIProvider(),
  'reality-defender': new RealityDefenderProvider()
};

/**
 * Get provider by name
 * @param {string} name - Provider name
 * @returns {BaseModerationProvider}
 */
export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

/**
 * Get all configured providers
 * @param {Object} env - Environment variables
 * @returns {Array<BaseModerationProvider>}
 */
export function getConfiguredProviders(env) {
  return Object.values(PROVIDERS).filter(p => p.isConfigured(env));
}

/**
 * Select provider based on strategy
 * @param {Object} env - Environment variables
 * @param {string|Object} strategy - Selection strategy
 * @returns {BaseModerationProvider}
 */
export function selectProvider(env, strategy = 'default') {
  const configured = getConfiguredProviders(env);

  if (configured.length === 0) {
    throw new Error('No moderation providers configured. Please configure AWS_* or SIGHTENGINE_* credentials.');
  }

  // Default: use PRIMARY_MODERATION_PROVIDER env var or first configured
  if (strategy === 'default' || typeof strategy === 'string') {
    const primaryName = env.PRIMARY_MODERATION_PROVIDER || 'hiveai';
    const primary = configured.find(p => p.name === primaryName);

    if (primary) {
      console.log(`[Orchestrator] Selected primary provider: ${primary.name}`);
      return primary;
    }

    console.log(`[Orchestrator] Primary provider ${primaryName} not configured, using: ${configured[0].name}`);
    return configured[0];
  }

  // Capability-based selection
  if (strategy.capabilities) {
    const matching = configured.find(p =>
      Object.keys(strategy.capabilities).every(cap =>
        p.capabilities[cap] === strategy.capabilities[cap]
      )
    );

    if (matching) {
      console.log(`[Orchestrator] Selected by capabilities: ${matching.name}`);
      return matching;
    }

    console.log(`[Orchestrator] No provider matches capabilities, using: ${configured[0].name}`);
    return configured[0];
  }

  return configured[0];
}

/**
 * Moderate with fallback chain
 * @param {string} videoUrl - Public URL to video
 * @param {Object} metadata - Video metadata
 * @param {Object} env - Environment variables
 * @param {Object} options - Options (providers, fetchFn, etc)
 * @returns {Promise<NormalizedModerationResult>}
 */
export async function moderateWithFallback(videoUrl, metadata, env, options = {}) {
  // Determine provider chain
  const providerNames = options.providers || [
    env.PRIMARY_MODERATION_PROVIDER || 'hiveai',
    'sightengine' // Always fallback to Sightengine if configured
  ];

  const errors = [];

  for (const providerName of providerNames) {
    try {
      const provider = getProvider(providerName);

      if (!provider.isConfigured(env)) {
        console.log(`[Orchestrator] Provider ${providerName} not configured, skipping`);
        continue;
      }

      console.log(`[Orchestrator] Attempting moderation with ${providerName}`);
      const result = await provider.moderate(videoUrl, metadata, env, options);
      console.log(`[Orchestrator] Success with ${providerName}`);

      return result;

    } catch (error) {
      console.error(`[Orchestrator] Provider ${providerName} failed:`, error.message);
      errors.push({ provider: providerName, error: error.message });
    }
  }

  // All providers failed
  throw new Error(
    `All providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`
  );
}

/**
 * Moderate with multiple providers in parallel (for comparison/validation)
 * @param {string} videoUrl - Public URL to video
 * @param {Object} metadata - Video metadata
 * @param {Object} env - Environment variables
 * @param {Array<string>} providerNames - Provider names to use
 * @param {Object} options - Options (fetchFn, etc)
 * @returns {Promise<Object>} Results from all providers
 */
export async function moderateWithMultiple(videoUrl, metadata, env, providerNames, options = {}) {
  const providers = providerNames
    .map(name => {
      try {
        return getProvider(name);
      } catch {
        return null;
      }
    })
    .filter(p => p && p.isConfigured(env));

  if (providers.length === 0) {
    throw new Error('No configured providers specified for parallel moderation');
  }

  console.log(`[Orchestrator] Running ${providers.length} providers in parallel`);

  const results = await Promise.allSettled(
    providers.map(p => p.moderate(videoUrl, metadata, env, options))
  );

  return {
    results: results.map((r, i) => ({
      provider: providers[i].name,
      status: r.status,
      result: r.status === 'fulfilled' ? r.value : null,
      error: r.status === 'rejected' ? r.reason.message : null
    }))
  };
}
