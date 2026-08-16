// ABOUTME: User guide for the pluggable moderation provider system
// ABOUTME: Configuration, usage, and provider switching documentation

# Pluggable Moderation System Guide

## Overview

The Divine moderation service uses a pluggable architecture that allows you to:
- Switch between moderation providers (AWS Rekognition, Sightengine, etc.)
- Configure fallback chains (primary → backup)
- Run multiple providers in parallel for comparison
- Add new providers without changing existing code

---

## Quick Start

### 1. Configure Environment Variables

```bash
# Copy example
cp .env.example .env

# Edit .env and set:
PRIMARY_MODERATION_PROVIDER=aws-rekognition

# AWS credentials
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
AWS_S3_BUCKET=divine-moderation-videos
```

### 2. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 3. Use in Your Code

```javascript
import { moderateVideo } from './src/moderation/pipeline.mjs';

const result = await moderateVideo({
  sha256: 'video-hash',
  uploadedBy: 'nostr-pubkey',
  uploadedAt: Date.now()
}, env);

console.log('Provider used:', result.provider);
console.log('Classification:', result.classification);
console.log('Scores:', result.detailedCategories);
```

---

## Available Providers

### AWS Rekognition
**Status**: ✅ Implemented
**Configuration**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`

**Pros**:
- Self-serve, transparent pricing
- 68% lower false positive rate (vs older version)
- 36% lower false negative rate
- Custom model training available
- Proven at scale

**Cons**:
- Async processing (2-5 seconds per video)
- Requires S3 upload
- No AI-generated detection

**Cost**: ~$0.10/minute = ~$0.01 per 6-second video

### Sightengine
**Status**: ✅ Implemented (legacy)
**Configuration**: `SIGHTENGINE_API_USER`, `SIGHTENGINE_API_SECRET`

**Pros**:
- Synchronous API (faster integration)
- AI-generated + deepfake detection
- Text OCR, QR code detection
- Cheaper ($29-$399/mo)

**Cons**:
- Poor accuracy reported for nudity/adult content
- High false positive and false negative rates

**Cost**: $29-$399/month (volume tiers)

---

## Configuration Options

### Provider Selection

#### Option 1: Primary Provider (Default)
```bash
PRIMARY_MODERATION_PROVIDER=aws-rekognition
```

Uses specified provider, falls back to first configured if primary unavailable.

#### Option 2: Fallback Chain
```bash
PRIMARY_MODERATION_PROVIDER=aws-rekognition
FALLBACK_MODERATION_PROVIDERS=sightengine
```

Tries AWS first, falls back to Sightengine on error.

#### Option 3: Per-Video Provider Selection
```javascript
await moderateVideo(videoData, env, {
  providers: ['aws-rekognition']  // Override default
});
```

### Thresholds

```bash
NUDITY_THRESHOLD=0.7
VIOLENCE_THRESHOLD=0.7
AI_GENERATED_THRESHOLD=0.7
```

Scores above threshold trigger flagging/age-gating.

---

## Advanced Usage

### Parallel Comparison

Run multiple providers to compare results:

```javascript
import { moderateWithMultiple } from './src/moderation/providers/index.mjs';

const results = await moderateWithMultiple(
  videoUrl,
  { sha256 },
  env,
  ['aws-rekognition', 'sightengine']
);

console.log('AWS:', results.results[0].result.scores);
console.log('Sightengine:', results.results[1].result.scores);
```

### Provider-Specific Options

```javascript
await moderateVideo(videoData, env, {
  minConfidence: 80,  // AWS: Raise threshold
  maxWaitMs: 60000    // AWS: Reduce timeout
});
```

### Capability-Based Selection

```javascript
import { selectProvider } from './src/moderation/providers/index.mjs';

const provider = selectProvider(env, {
  capabilities: {
    aiGenerated: true,  // Needs AI detection
    deepfake: true
  }
});

// Would select Sightengine (only provider with these capabilities)
```

---

## Response Format

All providers return a normalized format:

```javascript
{
  // Provider metadata
  provider: 'aws-rekognition',
  processingTime: 2500,

  // Normalized scores (0.0-1.0)
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
    aiGenerated: 0.0,  // AWS doesn't detect
    deepfake: 0.0       // AWS doesn't detect
  },

  // Detailed subcategories
  details: {
    nudity: {
      explicitNudity: 0.85,
      suggestive: 0.45,
      // ...
    },
    violence: {
      physicalViolence: 0.12,
      // ...
    }
  },

  // Flagged frames/timestamps
  flaggedFrames: [
    {
      position: 2.5,  // seconds
      primaryConcern: 'nudity',
      primaryScore: 0.85,
      scores: { nudity: 0.85, violence: 0.0, ... }
    }
  ],

  // Original provider response
  raw: { /* AWS/Sightengine original data */ }
}
```

---

## Switching Providers

### From Sightengine to AWS

1. **Sign up for AWS**: https://aws.amazon.com/
2. **Enable Rekognition**: In AWS Console
3. **Create S3 bucket**: `divine-moderation-videos`
4. **Create IAM user**: With Rekognition + S3 permissions
5. **Update .env**:
```bash
PRIMARY_MODERATION_PROVIDER=aws-rekognition
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=divine-moderation-videos

# Keep Sightengine as fallback
FALLBACK_MODERATION_PROVIDERS=sightengine
```

6. **Deploy**: Provider automatically switches

### Testing Before Cutover

```javascript
// Test AWS without switching primary
const results = await moderateWithMultiple(
  videoUrl,
  metadata,
  env,
  ['aws-rekognition', 'sightengine']
);

// Compare accuracy
console.log('AWS nudity:', results.results[0].result.scores.nudity);
console.log('Sightengine nudity:', results.results[1].result.scores.nudity);
```

---

## Adding a New Provider

### 1. Create Adapter

```javascript
// src/moderation/providers/newprovider/adapter.mjs
import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';

export class NewProviderAdapter extends BaseModerationProvider {
  constructor() {
    super('newprovider', {
      ...STANDARD_CAPABILITIES,
      // Override capabilities
      aiGenerated: true,
      deepfake: false
    });
  }

  isConfigured(env) {
    return !!env.NEWPROVIDER_API_KEY;
  }

  async moderate(videoUrl, metadata, env, options = {}) {
    // Call provider API
    const rawResult = await callNewProviderAPI(videoUrl, env);

    // Normalize to standard format
    return {
      scores: { nudity: rawResult.nudityScore, ... },
      details: { ... },
      flaggedFrames: [ ... ]
    };
  }
}
```

### 2. Register in Orchestrator

```javascript
// src/moderation/providers/orchestrator.mjs
import { NewProviderAdapter } from './newprovider/adapter.mjs';

const PROVIDERS = {
  'aws-rekognition': new AWSRekognitionProvider(),
  'sightengine': new SightengineProvider(),
  'newprovider': new NewProviderAdapter()  // Add here
};
```

### 3. Use It

```bash
PRIMARY_MODERATION_PROVIDER=newprovider
NEWPROVIDER_API_KEY=your-key
```

---

## Troubleshooting

### "No moderation providers configured"

**Cause**: No provider credentials set in environment

**Fix**: Add `AWS_*` or `SIGHTENGINE_*` credentials to `.env`

### "Provider aws-rekognition not configured"

**Cause**: Missing AWS credentials or S3 bucket

**Fix**: Ensure all of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET` are set

### "AWS Rekognition moderation failed"

**Causes**:
- Video URL not accessible
- S3 upload permissions issue
- Video format not supported
- Timeout (video too long)

**Fix**: Check CloudWatch logs, verify S3 permissions, ensure video is mp4/webm

### "All providers failed"

**Cause**: Both primary and fallback providers errored

**Fix**: Check logs for specific errors, verify both providers' credentials

---

## Cost Optimization

### Strategy 1: Use Cheaper Provider for Pre-Screening

```javascript
// Run cheap provider first
const quick = await moderateWithFallback(videoUrl, metadata, env, {
  providers: ['sightengine']
});

// Only run expensive provider if needed
if (quick.scores.nudity > 0.5) {
  const detailed = await moderateWithFallback(videoUrl, metadata, env, {
    providers: ['aws-rekognition']
  });
}
```

### Strategy 2: Skip AI Detection for ProofMode Videos

```javascript
// Check ProofMode status
const hasProofMode = checkProofMode(nostrEvent);

// Skip AI detection if cryptographically verified
if (hasProofMode) {
  // AWS doesn't do AI detection anyway, so no savings
  // But could skip Sightengine's AI models
}
```

### Strategy 3: Batch Processing

For AWS, group videos and process in batches to reduce API overhead.

---

## Monitoring

### Log Provider Usage

```javascript
const result = await moderateVideo(videoData, env);

console.log(`[METRICS] Provider: ${result.provider}`);
console.log(`[METRICS] Processing time: ${result.processingTime}ms`);
console.log(`[METRICS] Classification: ${result.classification}`);
```

### Track Provider Success Rates

```javascript
let awsSuccess = 0;
let awsFailed = 0;
let sightengineSuccess = 0;
let sightengineFailed = 0;

// Track in your monitoring system
```

### Cost Tracking

```javascript
const COST_PER_PROVIDER = {
  'aws-rekognition': 0.01,  // per video
  'sightengine': 0.003       // estimated
};

const cost = COST_PER_PROVIDER[result.provider];
console.log(`[COST] ${result.provider}: $${cost}`);
```

---

## Best Practices

1. **Always configure a fallback**: Don't rely on single provider
2. **Test in parallel before switching**: Compare accuracy on your content
3. **Monitor both providers**: Track success rates, costs, processing times
4. **Adjust thresholds per provider**: AWS and Sightengine may need different thresholds
5. **Keep raw responses**: Store `providerRaw` for debugging
6. **Use ProofMode**: Skip unnecessary checks when videos are cryptographically verified

---

## FAQ

**Q: Can I use multiple providers simultaneously?**
A: Yes! Use `moderateWithMultiple()` for parallel execution.

**Q: Will switching providers break existing code?**
A: No - the normalized response format is the same for all providers.

**Q: Can I switch providers per video?**
A: Yes - pass `providers` option to `moderateVideo()`.

**Q: Does AWS detect AI-generated content?**
A: No - use Sightengine for AI/deepfake detection.

**Q: How do I know which provider was used?**
A: Check `result.provider` field.

**Q: Can I add my own custom provider?**
A: Yes - implement `BaseModerationProvider` interface and register in orchestrator.

---

## Next Steps

1. ✅ Configure AWS Rekognition or Sightengine
2. ✅ Test with sample videos
3. ✅ Compare providers if using multiple
4. ✅ Adjust thresholds based on results
5. ✅ Monitor provider performance
6. ✅ Optimize costs based on usage patterns
