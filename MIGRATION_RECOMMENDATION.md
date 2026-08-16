# Migration from Sightengine - Recommendation

## Problem Statement

Sightengine is **mostly wrong** on:
1. **Nudity detection** - Critical for content moderation
2. **AI-generated content detection** - Important for authenticity

These are core moderation categories. Accuracy is more important than cost.

---

## Recommended Solution: **Hive Moderation API**

### Why Hive?

**Best-in-class accuracy for your problem areas:**
- **Nudity detection: 97% accuracy** (vs Sightengine's poor performance)
- **AI-generated content: 98%+ accuracy** (vs Sightengine's poor performance)
- **Deepfake video detection** with confidence scoring
- Error rate **6-12x lower** than major cloud providers (AWS, Google)

**Technical advantages:**
- Built specifically for content moderation (not general video AI)
- Fast response times (under 200ms)
- Multi-modal: images, videos, GIFs, live streams
- Used in production by Reddit, Quora, TikTok, Chatroulette
- U.S. Department of Defense invested $2.4M in their tech

**API simplicity:**
- Synchronous API like Sightengine (easier migration)
- Similar request/response pattern
- RESTful design

### Hive API Example

```javascript
// Hive Visual Moderation API
POST https://api.thehive.ai/api/v2/task/sync

{
  "url": "https://cdn.divine.video/abc123.mp4",
  "moderation_classes": [
    "yes_sexual_content",
    "yes_sexual_activity",
    "yes_suggestive",
    "yes_deepfake",
    "yes_ai_generated",
    "yes_violence",
    "yes_gore",
    // ... etc
  ]
}

// Response format (simplified)
{
  "status": [{
    "response": {
      "output": [
        {
          "time": 2.5,  // seconds into video
          "classes": [
            {
              "class": "yes_sexual_content",
              "score": 0.95  // confidence
            },
            {
              "class": "yes_deepfake",
              "score": 0.02
            }
          ]
        }
      ]
    }
  }]
}
```

---

## Alternative/Complementary Solution: Specialized AI Detection

If you want **best-in-class AI detection** as a separate service:

### Option A: **Hive AI Deepfake Detection** (included in their API)
- Face detection + deepfake classification
- "yes_deepfake" / "no_deepfake" with confidence
- Already integrated with nudity/violence detection

### Option B: **Reality Defender** (dedicated AI detection)
- Multi-model deepfake detection platform
- Real-time analysis
- API + web interface
- Handles video, images, audio, text
- Could run in parallel with Hive for validation

### Option C: **Sensity AI**
- 95-98% accuracy
- Comprehensive (video, images, audio, text)
- API + cloud-based or on-premise
- Enterprise-focused

### Option D: **MediaFirewall**
- Specialized in AI-generated content filtering
- Detects GAN videos, deepfakes, stylized fabrications
- SDK/API integration (< 48 hours)
- Good for detecting fully synthetic videos (not just face swaps)

---

## Recommended Architecture

### Single Provider (Simplest)
```
Divine Video → Hive API → Moderation Result
```
- Use Hive for everything (nudity, violence, gore, AI detection, deepfakes)
- Simplest migration
- Best overall accuracy

### Dual Provider (Belt & Suspenders for AI Detection)
```
Divine Video → Hive API → Nudity, Violence, Gore, etc.
            ↘ Reality Defender / Sensity → AI/Deepfake detection
```
- Use Hive for general moderation (97% nudity accuracy)
- Use specialized service for AI detection (96-98% accuracy)
- Higher confidence in AI detection results
- More complex integration, higher cost

### Recommended: **Start with Hive alone**
- Covers both your problem areas well
- Simpler migration
- Can add specialized AI detection later if needed

---

## Migration Plan

### Phase 1: Parallel Testing (Week 1-2)
1. Sign up for Hive API (free trial available)
2. Implement Hive adapter using pluggable architecture
3. Run Sightengine + Hive in parallel on sample videos
4. Log both results, compare accuracy
5. **Validate that Hive fixes your nudity/AI detection issues**

### Phase 2: Gradual Rollout (Week 3-4)
1. Switch to Hive as primary, keep Sightengine as fallback
2. Monitor accuracy, false positive/negative rates
3. Gather feedback from any manual review process
4. Fine-tune confidence thresholds

### Phase 3: Full Cutover (Week 5)
1. Switch entirely to Hive
2. Cancel Sightengine subscription
3. Remove Sightengine code (keep in git history)

### Phase 4: Optional Enhancement (Week 6+)
1. If AI detection still needs improvement, add Reality Defender or Sensity
2. Run both Hive + specialized detector, require agreement on AI-generated flags
3. Reduce false positives/negatives further

---

## Cost Comparison (Estimated)

| Provider | Model | Estimated Cost (1000 hrs/mo) | Notes |
|----------|-------|------------------------------|-------|
| Sightengine | Tier-based | ~$399/mo | Cheap but inaccurate for nudity/AI |
| Hive | Volume-based | $1,000-3,000/mo (est) | Need to contact for pricing |
| AWS Rekognition | Pay-per-use | ~$6,000/mo | Good but no AI detection |
| Reality Defender | Enterprise | Unknown | Likely higher, specialized service |

**Key insight:** Hive will likely cost 3-8x more than Sightengine, but if you're getting mostly wrong results on your core categories, the current setup has no value regardless of cost.

---

## Implementation Code Changes

Using the pluggable architecture from `MODERATION_PROVIDER_ARCHITECTURE.md`:

### 1. Create Hive Adapter

```javascript
// src/moderation/providers/hive/adapter.mjs

import { BaseModerationProvider, STANDARD_CAPABILITIES } from '../base-provider.mjs';

export class HiveProvider extends BaseModerationProvider {
  constructor() {
    super('hive', {
      ...STANDARD_CAPABILITIES,
      aiGenerated: true,
      deepfake: true,
      textOcr: true,
      liveStream: true
    });
  }

  isConfigured(env) {
    return !!env.HIVE_API_KEY;
  }

  async moderate(videoUrl, metadata, env, options = {}) {
    const response = await fetch('https://api.thehive.ai/api/v2/task/sync', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${env.HIVE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: videoUrl,
        moderation_classes: [
          'yes_sexual_content',
          'yes_sexual_activity',
          'yes_suggestive',
          'yes_deepfake',
          'yes_ai_generated',
          'yes_violence',
          'yes_gore',
          'yes_offensive',
          'yes_weapon',
          'yes_drugs',
          'yes_alcohol',
          'yes_gambling',
          'yes_self_harm'
        ]
      })
    });

    const data = await response.json();

    // Normalize Hive response to standard format
    return this.normalizeResponse(data, metadata);
  }

  normalizeResponse(hiveData, metadata) {
    // Parse Hive response and convert to standard format
    const frames = hiveData.status[0].response.output || [];

    // Extract max scores across all frames
    const maxScores = {
      nudity: 0,
      violence: 0,
      gore: 0,
      offensive: 0,
      weapons: 0,
      drugs: 0,
      alcohol: 0,
      gambling: 0,
      selfHarm: 0,
      aiGenerated: 0,
      deepfake: 0
    };

    const flaggedFrames = [];

    for (const frame of frames) {
      const frameScores = {
        nudity: Math.max(
          this.getScore(frame, 'yes_sexual_content'),
          this.getScore(frame, 'yes_sexual_activity'),
          this.getScore(frame, 'yes_suggestive')
        ),
        violence: this.getScore(frame, 'yes_violence'),
        gore: this.getScore(frame, 'yes_gore'),
        offensive: this.getScore(frame, 'yes_offensive'),
        weapons: this.getScore(frame, 'yes_weapon'),
        drugs: this.getScore(frame, 'yes_drugs'),
        alcohol: this.getScore(frame, 'yes_alcohol'),
        gambling: this.getScore(frame, 'yes_gambling'),
        selfHarm: this.getScore(frame, 'yes_self_harm'),
        aiGenerated: this.getScore(frame, 'yes_ai_generated'),
        deepfake: this.getScore(frame, 'yes_deepfake')
      };

      // Update max scores
      for (const [key, score] of Object.entries(frameScores)) {
        maxScores[key] = Math.max(maxScores[key], score);
      }

      // Flag frames with high scores
      if (Object.values(frameScores).some(s => s >= 0.7)) {
        flaggedFrames.push({
          position: frame.time,
          ...frameScores
        });
      }
    }

    return {
      provider: this.name,
      scores: maxScores,
      details: {}, // Hive has less granular subcategories
      flaggedFrames,
      raw: hiveData
    };
  }

  getScore(frame, className) {
    const classResult = frame.classes?.find(c => c.class === className);
    return classResult ? classResult.score : 0;
  }
}
```

### 2. Update Environment Variables

```bash
# .env or wrangler.toml
HIVE_API_KEY=your-hive-api-key
PRIMARY_MODERATION_PROVIDER=hive
FALLBACK_MODERATION_PROVIDERS=sightengine  # Keep as fallback during transition
```

### 3. Register Provider

```javascript
// src/moderation/providers/index.mjs

import { SightengineProvider } from './sightengine/adapter.mjs';
import { HiveProvider } from './hive/adapter.mjs';

export const PROVIDERS = {
  sightengine: new SightengineProvider(),
  hive: new HiveProvider()
};
```

**No changes needed to pipeline.mjs** - it already uses the orchestrator!

---

## Testing Strategy

### 1. Create Test Dataset
- Collect 50-100 videos with known ground truth:
  - Clear nudity (should flag)
  - Suggestive but not nude (borderline)
  - Safe content (should not flag)
  - AI-generated videos (should flag)
  - Real videos (should not flag AI)

### 2. Run Comparison
```javascript
// scripts/compare-providers.mjs
const results = await moderateWithMultiple(videoUrl, metadata, env, [
  'sightengine',
  'hive'
]);

// Log differences
console.log('Sightengine nudity:', results.sightengine.scores.nudity);
console.log('Hive nudity:', results.hive.scores.nudity);
console.log('Ground truth: NUDE');
```

### 3. Measure Accuracy
- False positive rate (flagged safe content)
- False negative rate (missed unsafe content)
- Precision/recall for each category

### 4. Validate Improvement
- Document cases where Hive is correct and Sightengine is wrong
- Share results with me to confirm migration is worth it

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Hive costs too much | Run cost analysis with actual volume, negotiate pricing |
| Hive API different than expected | Implement adapter with proper error handling |
| Hive still inaccurate | Have fallback to try Reality Defender for AI detection |
| Migration breaks production | Use parallel testing, gradual rollout with fallback |
| Lose Sightengine's unique features | Evaluate if QR code, text OCR actually used/needed |

---

## Decision Points

Before proceeding, answer these questions:

1. **What's your current false positive/negative rate with Sightengine?**
   - Do you have ground truth data to measure?
   - Is manual review catching lots of Sightengine errors?

2. **Which category is more critical: nudity or AI detection?**
   - If nudity: Hive alone is great
   - If AI: Consider Hive + Reality Defender

3. **What's your monthly video volume?**
   - Need to estimate Hive costs
   - May affect which provider is best

4. **Do you have a budget for moderation?**
   - Willing to pay 3-8x more for accuracy?
   - Or need to stay cheap and accept lower accuracy?

5. **Timeline urgency?**
   - Can do proper parallel testing? (recommended)
   - Or need to switch ASAP?

---

## My Recommendation

**Go with Hive immediately.**

Reasons:
1. Solves both your problems (97% nudity, 98% AI detection)
2. Battle-tested (Reddit, TikTok use it)
3. Similar API to Sightengine (easy migration)
4. Worth paying more for accuracy on core features

**Migration timeline: 2-4 weeks**

1. Week 1: Sign up, implement adapter, parallel test
2. Week 2: Validate accuracy improvement, adjust thresholds
3. Week 3: Switch to Hive primary with Sightengine fallback
4. Week 4: Full cutover, remove Sightengine

Want me to start implementing the Hive adapter?
