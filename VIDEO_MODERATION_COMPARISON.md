# Video Moderation Services Comparison (2025)

## Executive Summary

Research into alternatives to Sightengine for video content moderation. All major cloud providers offer competitive services with similar pricing (~$0.10/min). **AWS Rekognition** appears to be the strongest alternative with custom model training capabilities.

## Current: Sightengine

**Pricing**: $29-$399/month (volume-based tiers)

**Strengths**:
- Extremely detailed subcategories (18+ primary categories, dozens of subcategories)
- Highly customizable thresholds and models
- Comprehensive model selection:
  - nudity-2.1 (sexual_activity, sexual_display, erotica, suggestive variations)
  - violence (physical_violence, firearm_threat, combat_sport)
  - gore-2.0 (bloody, body_organ, serious_injury, corpse)
  - offensive-2.0 (nazi, supremacist, terrorist, middle_finger)
  - genai + deepfake detection
  - weapons, drugs (recreational_drug, medical), alcohol, tobacco
  - gambling, money, self-harm, destruction, military
  - text-content (OCR with profanity detection)
  - qr-content (QR code scanning and validation)
- Frame-by-frame analysis with detailed scoring
- Synchronous API (simpler integration)

**Weaknesses**:
- Smaller company (potential reliability/scale concerns)
- Limited ecosystem integration
- Fixed pricing tiers vs pay-per-use

**API Pattern**: Synchronous GET request with stream_url parameter

---

## Alternative 1: AWS Rekognition Video

**Pricing**: $0.10/minute
- 60 free minutes/month for first 12 months
- $6 for a 1-hour video
- Volume discounts available

**Strengths**:
- **Custom Moderation Adapters** - Train custom models on your own labeled data!
- 10 major categories, 25 secondary categories
- Claims 95% accuracy for unsafe content flagging
- Max file size 10GB, max duration 6 hours
- Amazon A2I integration for human-in-the-loop review
- Deep AWS ecosystem integration (S3, Lambda, EventBridge)
- Enterprise-grade reliability and scale
- Minimum confidence thresholds (0-100)

**Weaknesses**:
- Fewer subcategories than Sightengine
- Requires AWS account and S3 storage
- Asynchronous API (more complex integration)
- Less granular control than Sightengine

**Categories**:
Major: Explicit Nudity, Suggestive, Violence, Visually Disturbing, Rude Gestures, Drugs, Tobacco, Alcohol, Gambling, Hate Symbols

**API Pattern**: Asynchronous (StartContentModeration → GetContentModeration polling)

**Best For**:
- Teams already on AWS
- Need for custom model training
- Large-scale operations requiring enterprise reliability
- Human review workflows

---

## Alternative 2: Google Cloud Video Intelligence API

**Pricing**: $0.10/minute
- First 1,000 minutes free per month
- Volume discounts for >100K minutes/month

**Strengths**:
- Part of Google Cloud AI suite
- Good general video analysis (labels, objects, text detection)
- Shot detection and object tracking
- Enterprise reliability

**Weaknesses**:
- Less specialized for content moderation vs competitors
- Celebrity recognition deprecated (Sept 2025)
- Fewer moderation-specific categories
- Limited subcategory detail

**API Pattern**: Both sync and async options available

**Best For**:
- Teams already on Google Cloud
- Need general video analysis + basic moderation
- Shot detection and object tracking important

---

## Alternative 3: Azure Video Indexer

**Pricing**: Not clearly disclosed (paid account required, no free tier mentioned)

**Strengths**:
- 30+ AI models in one service
- Visual + textual content moderation
- Audio transcript analysis for explicit text
- Broad video analysis capabilities

**Weaknesses**:
- Less detailed pricing information
- Requires paid Azure account (no trial)
- Less granular moderation categories than Sightengine
- Fewer documented moderation-specific features

**Categories**:
- Adult/racy visual content
- Explicit text in audio transcripts

**Best For**:
- Teams already on Azure
- Need comprehensive video analytics beyond moderation

---

## Alternative 4: Hive Moderation

**Pricing**: Not disclosed (enterprise/volume-based)

**Strengths**:
- Built for high-volume scale
- Pre-trained models ready out-of-the-box
- Multi-modal (images, videos, GIFs, live streams)
- Fast processing
- Developer-friendly API

**Weaknesses**:
- Less customization than Sightengine
- Pricing not transparent
- Less granular threshold control

**Best For**:
- High-volume platforms
- Teams prioritizing speed and scale over customization
- Need live stream moderation

---

## Comparison Matrix

| Feature | Sightengine | AWS Rekognition | Google Video AI | Azure Video Indexer | Hive |
|---------|-------------|-----------------|-----------------|---------------------|------|
| **Pricing Model** | Tiered ($29-$399/mo) | Pay-per-use ($0.10/min) | Pay-per-use ($0.10/min) | Undisclosed | Undisclosed |
| **Free Tier** | Limited trial | 60 min/mo (12mo) | 1000 min/mo | None | Unknown |
| **Custom Models** | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Subcategory Detail** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **Threshold Control** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **API Complexity** | Synchronous (simple) | Async (complex) | Both | Both | Synchronous |
| **Deepfake Detection** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Text OCR Moderation** | ✅ | ❌ | ✅ (general) | ✅ | ✅ |
| **QR Code Detection** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Live Stream Support** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Human Review Integration** | ❌ | ✅ (A2I) | ❌ | ❌ | ✅ (optional) |

---

## Recommendations

### Short Term: Stay with Sightengine
**Rationale**:
- Already integrated and working
- Superior granularity for fine-tuned moderation
- Deepfake + QR code detection unique to Sightengine/Hive
- Synchronous API is simpler for current architecture

### Mid-Term: Add AWS Rekognition as Option
**Rationale**:
- Custom model training could improve accuracy for Divine-specific content
- Better pricing model for high-volume scenarios
- Enterprise reliability and scale
- Enables A/B testing between providers

### Architecture: Pluggable Provider System
Implement abstraction layer allowing:
1. **Configuration-driven provider selection**
2. **Parallel processing** (run multiple providers, compare results)
3. **Fallback chains** (Sightengine → AWS fallback on error)
4. **Provider-specific optimizations** (leverage unique features)
5. **Normalized response format** (abstract provider differences)

---

## Implementation Considerations

### Response Normalization Challenges
Each provider has different:
- Category names/taxonomies
- Score ranges and confidence formats
- Subcategory granularity
- Async vs sync patterns

### Migration Strategy
1. Create provider abstraction interface
2. Implement Sightengine adapter (wrap existing code)
3. Implement AWS Rekognition adapter
4. Add provider configuration (env vars, per-video selection)
5. Build comparison/validation mode (run both, log differences)
6. Gradual rollout with monitoring

### Cost Analysis Example (1000 hours/month processing)
- **Sightengine**: $399/month (highest tier) = $0.0066/min
- **AWS Rekognition**: 60,000 min × $0.10 = $6,000/month
- **Google**: First 1,000 min free, then 59,000 × $0.10 = $5,900/month

*Note: Sightengine is significantly cheaper at scale! AWS/Google better for bursty/low-volume workloads.*

---

## Open Questions

1. What is our expected video processing volume?
2. Do we need custom model training for Divine-specific content?
3. Are there specific categories where current accuracy is lacking?
4. Do we need human review workflows?
5. How important is deepfake detection vs other categories?
6. Should we process videos through multiple providers for validation?

