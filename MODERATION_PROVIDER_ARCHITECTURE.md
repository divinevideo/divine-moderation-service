# Pluggable Video Moderation Provider Architecture

## Design Goals

1. **Provider Independence**: Easy to add/remove/swap moderation providers
2. **Normalized Interface**: Consistent internal API regardless of provider
3. **Fallback Support**: Graceful degradation when primary provider fails
4. **Parallel Processing**: Run multiple providers for validation/comparison
5. **Configuration-Driven**: Select provider per-video or globally via config
6. **Backward Compatible**: Existing code continues to work unchanged

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Moderation Pipeline                          │
│                    (pipeline.mjs)                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Provider Orchestrator                           │
│              (providers/orchestrator.mjs)                        │
│                                                                  │
│  • Provider selection logic                                      │
│  • Fallback chains                                               │
│  • Parallel execution                                            │
│  • Response normalization                                        │
└─────┬──────────┬──────────┬──────────┬─────────────────────────┘
      │          │          │          │
      ▼          ▼          ▼          ▼
┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
│Sightengine│ │   AWS   │ │ Google │ │  Hive  │
│ Provider │ │Provider │ │Provider│ │Provider│
│  Adapter │ │ Adapter │ │ Adapter│ │ Adapter│
└──────────┘ └─────────┘ └────────┘ └────────┘
      │          │          │          │
      ▼          ▼          ▼          ▼
┌──────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
│Sightengine│ │   AWS   │ │ Google │ │  Hive  │
│    API    │ │   API   │ │  API   │ │  API   │
└──────────┘ └─────────┘ └────────┘ └────────┘
```

---

## Core Interfaces

### 1. Provider Adapter Interface

Every provider adapter implements:

```javascript
/**
 * @typedef {Object} ModerationProvider
 * @property {string} name - Provider identifier (e.g., 'sightengine', 'aws-rekognition')
 * @property {Function} moderate - Main moderation function
 * @property {Function} isConfigured - Check if provider credentials are available
 * @property {Object} capabilities - What this provider can detect
 */

/**
 * Standard moderation function signature for all providers
 * @param {string} videoUrl - Public URL to video file
 * @param {Object} metadata - Video metadata (sha256, etc)
 * @param {Object} env - Environment variables with API credentials
 * @param {Object} options - Provider-specific options
 * @returns {Promise<NormalizedModerationResult>}
 */
async function moderate(videoUrl, metadata, env, options = {}) {
  // Provider-specific implementation
}

/**
 * Check if provider is configured with necessary credentials
 * @param {Object} env - Environment variables
 * @returns {boolean}
 */
function isConfigured(env) {
  // Check for required env vars
}

/**
 * Provider capabilities
 */
const capabilities = {
  deepfake: true/false,
  qrCode: true/false,
  customModels: true/false,
  liveStream: true/false,
  // ... etc
};
```

### 2. Normalized Response Format

All providers return this standardized format:

```javascript
/**
 * @typedef {Object} NormalizedModerationResult
 */
{
  // Provider metadata
  provider: 'sightengine',
  processingTime: 1234, // milliseconds

  // Normalized category scores (0.0 - 1.0)
  scores: {
    nudity: 0.85,
    violence: 0.12,
    gore: 0.05,
    offensive: 0.01,
    weapons: 0.0,
    drugs: 0.0,
    alcohol: 0.0,
    tobacco: 0.0,
    gambling: 0.0,
    selfHarm: 0.0,
    aiGenerated: 0.45,
    deepfake: 0.02,
    // ... all standard categories
  },

  // Detailed subcategories (provider-specific, normalized names)
  details: {
    nudity: {
      sexualActivity: 0.85,
      sexualDisplay: 0.12,
      erotica: 0.45,
      // ...
    },
    violence: {
      physicalViolence: 0.12,
      firearmThreat: 0.0,
      // ...
    },
    // ...
  },

  // Flagged frames/timestamps
  flaggedFrames: [
    {
      position: 2.5, // seconds
      primaryConcern: 'nudity',
      primaryScore: 0.85,
      scores: { /* all scores for this frame */ },
      details: { /* detailed breakdown */ }
    }
  ],

  // Provider-specific raw data (for debugging/auditing)
  raw: {
    // Original provider response
  }
}
```

---

## File Structure

```
src/
  moderation/
    pipeline.mjs              # Main orchestration (existing)
    classifier.mjs            # Classification logic (existing)

    providers/
      index.mjs               # Provider registry and exports
      orchestrator.mjs        # Provider selection and execution logic
      base-provider.mjs       # Base class/interface for providers

      sightengine/
        adapter.mjs           # Sightengine provider adapter
        normalizer.mjs        # Response normalization
        client.mjs            # API client (refactored from existing sightengine.mjs)

      aws-rekognition/
        adapter.mjs           # AWS Rekognition adapter
        normalizer.mjs        # Response normalization
        client.mjs            # AWS SDK wrapper

      google-video-ai/
        adapter.mjs           # Google Video AI adapter
        normalizer.mjs        # Response normalization
        client.mjs            # Google SDK wrapper

      hive/
        adapter.mjs           # Hive adapter
        normalizer.mjs        # Response normalization
        client.mjs            # API client
```

---

## Implementation Example

### Base Provider Interface

```javascript
// src/moderation/providers/base-provider.mjs

/**
 * Base provider class that all adapters extend
 */
export class BaseModerationProvider {
  constructor(name, capabilities) {
    this.name = name;
    this.capabilities = capabilities;
  }

  /**
   * Check if provider is configured
   * @param {Object} env
   * @returns {boolean}
   */
  isConfigured(env) {
    throw new Error('isConfigured() must be implemented by provider');
  }

  /**
   * Moderate video
   * @param {string} videoUrl
   * @param {Object} metadata
   * @param {Object} env
   * @param {Object} options
   * @returns {Promise<NormalizedModerationResult>}
   */
  async moderate(videoUrl, metadata, env, options = {}) {
    throw new Error('moderate() must be implemented by provider');
  }

  /**
   * Get provider info
   * @returns {Object}
   */
  getInfo() {
    return {
      name: this.name,
      capabilities: this.capabilities
    };
  }
}

/**
 * Standard capabilities template
 */
export const STANDARD_CAPABILITIES = {
  // Detection capabilities
  nudity: true,
  violence: true,
  gore: true,
  offensive: true,
  weapons: true,
  drugs: true,
  alcohol: true,
  tobacco: true,
  gambling: true,
  selfHarm: true,
  aiGenerated: false,
  deepfake: false,
  textOcr: false,
  qrCode: false,

  // Technical capabilities
  customModels: false,
  liveStream: false,
  humanReview: false,
  asyncProcessing: false,

  // Supported input
  maxFileSizeMB: null,
  maxDurationMinutes: null,
  supportedFormats: ['mp4', 'mov', 'avi', 'webm']
};
```

### Sightengine Adapter

```javascript
// src/moderation/providers/sightengine/adapter.mjs

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithSightengine } from './client.mjs';
import { normalizeSightengineResponse } from './normalizer.mjs';

export class SightengineProvider extends BaseModerationProvider {
  constructor() {
    super('sightengine', {
      ...STANDARD_CAPABILITIES,
      aiGenerated: true,
      deepfake: true,
      textOcr: true,
      qrCode: true,
      liveStream: true
    });
  }

  isConfigured(env) {
    return !!(env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET);
  }

  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      // Call existing Sightengine client
      const rawResult = await moderateVideoWithSightengine(
        videoUrl,
        metadata,
        env,
        options.fetchFn
      );

      // Normalize to standard format
      const normalized = normalizeSightengineResponse(rawResult);

      return {
        ...normalized,
        provider: this.name,
        processingTime: Date.now() - startTime,
        raw: rawResult
      };

    } catch (error) {
      throw new Error(`Sightengine moderation failed: ${error.message}`);
    }
  }
}
```

### AWS Rekognition Adapter

```javascript
// src/moderation/providers/aws-rekognition/adapter.mjs

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';
import { moderateVideoWithRekognition } from './client.mjs';
import { normalizeRekognitionResponse } from './normalizer.mjs';

export class AWSRekognitionProvider extends BaseModerationProvider {
  constructor() {
    super('aws-rekognition', {
      ...STANDARD_CAPABILITIES,
      customModels: true,
      humanReview: true,
      asyncProcessing: true,
      maxFileSizeMB: 10240, // 10GB
      maxDurationMinutes: 360 // 6 hours
    });
  }

  isConfigured(env) {
    return !!(
      env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY &&
      env.AWS_REGION
    );
  }

  async moderate(videoUrl, metadata, env, options = {}) {
    const startTime = Date.now();

    try {
      // Call AWS Rekognition (async pattern)
      const rawResult = await moderateVideoWithRekognition(
        videoUrl,
        metadata,
        env,
        options
      );

      // Normalize to standard format
      const normalized = normalizeRekognitionResponse(rawResult);

      return {
        ...normalized,
        provider: this.name,
        processingTime: Date.now() - startTime,
        raw: rawResult
      };

    } catch (error) {
      throw new Error(`AWS Rekognition moderation failed: ${error.message}`);
    }
  }
}
```

### Provider Orchestrator

```javascript
// src/moderation/providers/orchestrator.mjs

import { SightengineProvider } from './sightengine/adapter.mjs';
import { AWSRekognitionProvider } from './aws-rekognition/adapter.mjs';
// ... other providers

/**
 * Provider registry
 */
const PROVIDERS = {
  sightengine: new SightengineProvider(),
  'aws-rekognition': new AWSRekognitionProvider(),
  // ... register other providers
};

/**
 * Get provider by name
 */
export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

/**
 * Get all configured providers
 */
export function getConfiguredProviders(env) {
  return Object.values(PROVIDERS).filter(p => p.isConfigured(env));
}

/**
 * Select provider based on strategy
 */
export function selectProvider(env, strategy = 'default') {
  const configured = getConfiguredProviders(env);

  if (configured.length === 0) {
    throw new Error('No moderation providers configured');
  }

  // Default: use PRIMARY_MODERATION_PROVIDER env var or first configured
  if (strategy === 'default') {
    const primaryName = env.PRIMARY_MODERATION_PROVIDER || 'sightengine';
    const primary = configured.find(p => p.name === primaryName);
    return primary || configured[0];
  }

  // Cheapest: select based on volume
  if (strategy === 'cheapest') {
    // Logic to select cheapest based on estimated volume
    // For now, simple heuristic
    return configured.find(p => p.name === 'sightengine') || configured[0];
  }

  // Custom capability requirements
  if (strategy.capabilities) {
    return configured.find(p =>
      Object.keys(strategy.capabilities).every(cap =>
        p.capabilities[cap] === strategy.capabilities[cap]
      )
    ) || configured[0];
  }

  return configured[0];
}

/**
 * Moderate with fallback chain
 */
export async function moderateWithFallback(videoUrl, metadata, env, options = {}) {
  const providers = options.providers || [
    env.PRIMARY_MODERATION_PROVIDER || 'sightengine',
    'aws-rekognition' // fallback
  ];

  const errors = [];

  for (const providerName of providers) {
    try {
      const provider = getProvider(providerName);

      if (!provider.isConfigured(env)) {
        console.log(`[MODERATION] Provider ${providerName} not configured, skipping`);
        continue;
      }

      console.log(`[MODERATION] Attempting moderation with ${providerName}`);
      const result = await provider.moderate(videoUrl, metadata, env, options);
      console.log(`[MODERATION] Success with ${providerName}`);

      return result;

    } catch (error) {
      console.error(`[MODERATION] Provider ${providerName} failed:`, error);
      errors.push({ provider: providerName, error: error.message });
    }
  }

  throw new Error(
    `All providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`
  );
}

/**
 * Moderate with multiple providers in parallel (for comparison/validation)
 */
export async function moderateWithMultiple(videoUrl, metadata, env, providerNames = []) {
  const providers = providerNames.map(name => getProvider(name))
    .filter(p => p.isConfigured(env));

  if (providers.length === 0) {
    throw new Error('No configured providers specified for parallel moderation');
  }

  const results = await Promise.allSettled(
    providers.map(p => p.moderate(videoUrl, metadata, env))
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
```

### Updated Pipeline

```javascript
// src/moderation/pipeline.mjs

import { classifyModerationResult } from './classifier.mjs';
import { fetchNostrEventBySha256, parseVideoEventMetadata } from '../nostr/relay-client.mjs';
import { moderateWithFallback } from './providers/orchestrator.mjs';

/**
 * Run full moderation pipeline on a video
 */
export async function moderateVideo(videoData, env, fetchFn = fetch) {
  const { sha256, uploadedBy, uploadedAt, metadata } = videoData;

  if (!env.CDN_DOMAIN) {
    throw new Error('CDN_DOMAIN not configured');
  }

  // Step 1: Fetch Nostr event context
  let nostrContext = null;
  let videoUrl = `https://${env.CDN_DOMAIN}/${sha256}.mp4`;

  try {
    const relays = env.NOSTR_RELAY_URL ? [env.NOSTR_RELAY_URL] : ['wss://relay3.openvine.co'];
    const event = await fetchNostrEventBySha256(sha256, relays);
    if (event) {
      nostrContext = parseVideoEventMetadata(event);
      if (nostrContext.url) {
        videoUrl = nostrContext.url;
      }
    }
  } catch (error) {
    console.error(`[MODERATION] Failed to fetch Nostr context:`, error);
  }

  // Step 2: Moderate with automatic provider selection and fallback
  const moderationResult = await moderateWithFallback(
    videoUrl,
    { sha256 },
    env,
    { fetchFn }
  );

  // Step 3: Classify result (now provider-agnostic)
  const classification = classifyModerationResult({
    maxNudityScore: moderationResult.scores.nudity,
    maxViolenceScore: moderationResult.scores.violence,
    maxAiGeneratedScore: moderationResult.scores.aiGenerated,
    maxScores: moderationResult.scores,
    flaggedFrames: moderationResult.flaggedFrames
  }, env);

  // Step 4: Return complete result
  return {
    ...classification,

    provider: moderationResult.provider,
    detailedCategories: moderationResult.details,

    sha256,
    uploadedBy,
    uploadedAt,
    metadata,
    cdnUrl: videoUrl,
    nostrContext,

    // Raw provider data (for debugging)
    providerRaw: moderationResult.raw
  };
}
```

---

## Configuration

### Environment Variables

```bash
# Provider selection
PRIMARY_MODERATION_PROVIDER=sightengine  # or aws-rekognition, google-video-ai, etc
FALLBACK_MODERATION_PROVIDERS=aws-rekognition,google-video-ai  # comma-separated

# Sightengine
SIGHTENGINE_API_USER=your-user
SIGHTENGINE_API_SECRET=your-secret

# AWS Rekognition
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1

# Google Cloud
GOOGLE_CLOUD_PROJECT=your-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json

# Hive
HIVE_API_KEY=your-key
```

### Per-Video Provider Selection

```javascript
// In queue message or metadata
{
  sha256: 'abc123',
  moderationOptions: {
    provider: 'aws-rekognition',  // override default
    // or
    providers: ['sightengine', 'aws-rekognition'],  // fallback chain
    // or
    parallel: ['sightengine', 'aws-rekognition']  // compare results
  }
}
```

---

## Migration Path

### Phase 1: Refactor Existing Code
1. Create base provider interface
2. Wrap existing Sightengine code in adapter
3. No behavior change, just structure

### Phase 2: Add Orchestrator
1. Implement provider registry
2. Add selection logic
3. Still only Sightengine, but through orchestrator

### Phase 3: Add Second Provider
1. Implement AWS Rekognition adapter
2. Add as fallback option
3. Test in parallel mode

### Phase 4: Production Rollout
1. Monitor both providers in parallel
2. Compare accuracy and reliability
3. Gradually shift traffic based on results

### Phase 5: Additional Providers
1. Add Google, Hive, etc as needed
2. Optimize provider selection strategy
3. Implement cost optimization logic

---

## Testing Strategy

### Unit Tests
- Each adapter tested independently
- Mock provider APIs
- Test normalization logic

### Integration Tests
- Test orchestrator selection logic
- Test fallback chains
- Test parallel execution

### Comparison Tests
- Run same video through multiple providers
- Compare normalized results
- Log discrepancies for analysis

### End-to-End Tests
- Test full pipeline with each provider
- Ensure classifier works with all normalized formats
- Verify database storage compatibility

---

## Monitoring and Observability

### Metrics to Track
- Provider selection frequency
- Provider success/failure rates
- Processing times per provider
- Cost per video by provider
- Accuracy comparisons (when running parallel)
- Fallback trigger frequency

### Logging
```javascript
{
  event: 'moderation_complete',
  sha256: 'abc123',
  provider: 'sightengine',
  processingTime: 1234,
  fallbackUsed: false,
  classification: 'APPROVED',
  scores: { /* ... */ }
}

{
  event: 'moderation_fallback',
  sha256: 'abc123',
  primaryProvider: 'sightengine',
  fallbackProvider: 'aws-rekognition',
  primaryError: 'API timeout',
  fallbackSuccess: true
}
```

---

## Future Enhancements

1. **Smart Provider Selection**
   - ML model to select best provider per video type
   - Cost optimization based on volume predictions
   - Capability-based routing (deepfake → Sightengine)

2. **Consensus Moderation**
   - Run multiple providers, require agreement
   - Reduce false positives/negatives
   - Human review for disagreements

3. **Caching Layer**
   - Cache results by video hash
   - Avoid re-processing same content

4. **Custom Model Training**
   - Use AWS custom adapters for Divine-specific content
   - Feedback loop from human reviews

5. **Real-Time Switching**
   - Monitor provider performance
   - Automatic failover on degradation
   - Cost-based dynamic routing
