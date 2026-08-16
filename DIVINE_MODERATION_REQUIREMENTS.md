# Divine Video Moderation Requirements & Implementation

**Last Updated**: 2025-10-23

## Platform Context

- **Format**: 6-second videos (Vine-style)
- **Platform**: Nostr-based decentralized video sharing
- **Value Proposition**: Authentic, human-created content (no AI-generated)
- **Hosting**: cdn.divine.video (Cloudflare R2)

---

## Content Moderation Requirements

### 1. CSAM (Child Sexual Abuse Material)
**Action**: **ABSOLUTE BLOCK** + Legal Reporting
- Zero tolerance policy
- Must detect both known and novel CSAM
- Automatic reporting to NCMEC (National Center for Missing & Exploited Children)
- Cannot be opted into by any user
- Legal requirement, not platform policy

**Implementation**:
- Hash matching against known CSAM database
- AI classifier for novel/unknown CSAM
- Immediate blocking (never show to users)
- Automatic reporting workflow

### 2. Adult Content / Pornography
**Action**: **AGE-GATE with OPT-IN**
- Adult users (18+) can opt-in to view
- Minors completely blocked
- Similar to Twitter/X model
- Not illegal, just age-restricted

**Implementation**:
- Detect adult/sexual content (nudity, sexual activity, etc.)
- Tag video with age restriction flag
- Only show to users who:
  1. Are verified 18+
  2. Have opted into adult content in settings
- Store user preference in profile

### 3. Other Harmful Content
**Action**: **FLAG for Human Review**
- Violence, gore, hate speech, weapons, drugs, etc.
- Not auto-blocked, but flagged for moderator review
- Moderators decide: approve, age-gate, or remove
- Reviewed via faro.nos.social (existing human moderation tool)

**Implementation**:
- AI detection scores content
- High scores → flag for human review
- Moderators review in faro.nos.social
- Manual decision: approve/gate/block

### 4. AI-Generated Content
**Action**: **FLAG for Review** (per "no AI content" policy)
- Brand differentiator for Divine
- Detected via AI/deepfake models
- May allow with disclosure vs hard block (TBD)
- Human review to confirm

**Implementation**:
- Deepfake + AI-generated detection
- Flag videos with high AI scores
- Human verification
- Possible outcome: block or require "AI-generated" label

---

## Moderation Flow

```
Video Upload
    ↓
[1. CSAM Detection] → MATCH? → BLOCK + NCMEC Report
    ↓ PASS
[2. Adult Content Detection] → HIGH SCORE? → Age-gate (opt-in required)
    ↓ PASS / LOW SCORE
[3. Harmful Content Detection] → HIGH SCORE? → Flag for human review
    ↓ PASS / LOW SCORE
[4. AI-Generated Detection] → HIGH SCORE? → Flag for human review
    ↓ PASS
APPROVED - Publish to feed
```

---

## Recommended Provider: Hive Moderation

### Why Hive is Perfect for Divine

**1. CSAM Detection Suite** (Critical Requirement)
- Partnership with Thorn (nonprofit child safety org)
- **57M+ known CSAM hashes** (NCMEC database, regularly updated)
- **AI classifier** for novel CSAM detection
- **Video hash matching** with scene-sensitive video hashing (SSVH)
- **Integrated NCMEC reporting** (manage/review/escalate from one interface)
- **Privacy-first**: Deletes original media after processing (only keeps embeddings)

**2. Visual Moderation API**
- Adult content detection (sexual_activity, sexual_display, nudity levels)
- Violence, gore, weapons, drugs, hate symbols
- AI-generated + deepfake detection
- 97% nudity accuracy, 98% AI detection accuracy

**3. Single Platform Benefits**
- One API for all moderation needs
- Consistent scoring system
- Unified billing
- Battle-tested (Reddit, TikTok, Quora)

### Why NOT AWS Rekognition

AWS documentation explicitly states:
> "Amazon Rekognition's image and video moderation APIs don't detect whether an image includes illegal content, such as CSAM."

AWS cannot fulfill Divine's legal requirements.

### Why NOT Google Video Intelligence

Google has CSAM tools (CSAI Match, Content Safety API) but:
- Separate from general moderation API
- More complex integration (2 different systems)
- Primarily designed for YouTube-scale platforms
- Hive is simpler for Divine's use case

---

## Implementation Architecture

### Dual API Approach with Hive

```javascript
async function moderateVideo(videoUrl, metadata, env) {
  // Step 1: CSAM Detection (CRITICAL - always first)
  const csamResult = await hive.detectCSAM(videoUrl);

  if (csamResult.isCSAM) {
    // IMMEDIATE BLOCK
    await blockVideo(metadata.sha256, 'CSAM_DETECTED');

    // AUTOMATIC NCMEC REPORTING
    await reportToNCMEC(csamResult, metadata);

    return {
      action: 'BLOCKED',
      reason: 'CSAM',
      reportId: csamResult.ncmecReportId
    };
  }

  // Step 2: General Content Moderation
  const moderation = await hive.moderateContent(videoUrl, {
    classes: [
      'yes_sexual_content',
      'yes_sexual_activity',
      'yes_suggestive',
      'yes_ai_generated',
      'yes_deepfake',
      'yes_violence',
      'yes_gore',
      'yes_weapon',
      'yes_drugs',
      'yes_hate_symbols'
    ]
  });

  // Step 3: Classification Logic
  const classification = classifyContent(moderation);

  return classification;
}

function classifyContent(moderation) {
  const scores = extractScores(moderation);

  // Adult content → Age-gate
  if (scores.sexual_activity > 0.8 || scores.sexual_content > 0.8) {
    return {
      action: 'AGE_GATE',
      reason: 'ADULT_CONTENT',
      requiresOptIn: true,
      ageRestriction: 18,
      scores
    };
  }

  // AI-generated → Flag for review
  if (scores.ai_generated > 0.7 || scores.deepfake > 0.7) {
    return {
      action: 'FLAG_FOR_REVIEW',
      reason: 'AI_GENERATED',
      flagType: 'POLICY_VIOLATION',
      scores
    };
  }

  // Other harmful content → Flag for review
  const harmfulScore = Math.max(
    scores.violence,
    scores.gore,
    scores.weapon,
    scores.drugs,
    scores.hate_symbols
  );

  if (harmfulScore > 0.7) {
    return {
      action: 'FLAG_FOR_REVIEW',
      reason: 'HARMFUL_CONTENT',
      flagType: 'SAFETY',
      primaryConcern: getPrimaryConcern(scores),
      scores
    };
  }

  // Safe content
  return {
    action: 'APPROVED',
    scores
  };
}
```

### Database Schema

```sql
CREATE TABLE video_moderation (
  sha256 TEXT PRIMARY KEY,

  -- CSAM Detection
  csam_checked BOOLEAN DEFAULT FALSE,
  csam_detected BOOLEAN DEFAULT FALSE,
  csam_hash_match BOOLEAN DEFAULT FALSE,
  csam_classifier_score REAL,
  ncmec_report_id TEXT,

  -- Content Classification
  moderation_action TEXT, -- BLOCKED, AGE_GATE, FLAG_FOR_REVIEW, APPROVED
  moderation_reason TEXT,

  -- Age Gating
  age_restricted BOOLEAN DEFAULT FALSE,
  minimum_age INTEGER,
  requires_opt_in BOOLEAN DEFAULT FALSE,

  -- Flagging
  flagged_for_review BOOLEAN DEFAULT FALSE,
  flag_type TEXT, -- POLICY_VIOLATION, SAFETY, etc.
  flag_reason TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMP,
  review_decision TEXT,

  -- Scores
  adult_content_score REAL,
  ai_generated_score REAL,
  violence_score REAL,
  harmful_content_score REAL,

  -- Metadata
  moderation_provider TEXT, -- 'hive'
  moderated_at TIMESTAMP,
  raw_result JSONB
);

-- Indexes
CREATE INDEX idx_csam_detected ON video_moderation(csam_detected) WHERE csam_detected = TRUE;
CREATE INDEX idx_flagged ON video_moderation(flagged_for_review) WHERE flagged_for_review = TRUE;
CREATE INDEX idx_age_restricted ON video_moderation(age_restricted) WHERE age_restricted = TRUE;
```

### User Preferences (Adult Content Opt-In)

```sql
CREATE TABLE user_preferences (
  pubkey TEXT PRIMARY KEY, -- Nostr pubkey

  -- Adult Content Settings
  adult_content_enabled BOOLEAN DEFAULT FALSE,
  adult_content_opted_in_at TIMESTAMP,
  age_verified BOOLEAN DEFAULT FALSE,
  age_verification_method TEXT, -- 'self_reported', 'id_verified', etc.
  age_verification_date TIMESTAMP,

  -- Content Filtering
  show_ai_generated BOOLEAN DEFAULT FALSE,
  show_flagged_content BOOLEAN DEFAULT FALSE,

  updated_at TIMESTAMP
);
```

### Nostr Event Tags

Videos should include moderation tags in Nostr events (kind 34236):

```json
{
  "kind": 34236,
  "tags": [
    ["imeta", "url https://cdn.divine.video/{sha256}.mp4", ...],

    // Moderation tags
    ["content-warning", "adult"],  // For age-gated content
    ["L", "content-warning"],      // Label namespace
    ["l", "sexual", "content-warning"],  // Specific warning

    // Age restriction
    ["age-restriction", "18"],

    // AI-generated flag (if allowed with disclosure)
    ["ai-generated", "true"],

    // Optional: Moderation provider attestation
    ["moderation", "hive", "2025-10-23T12:00:00Z", "adult-content"]
  ]
}
```

---

## API Integration Details

### Hive CSAM Detection API

```javascript
// Endpoint
POST https://api.thehive.ai/api/v2/task/sync

// Headers
Authorization: Token {HIVE_CSAM_API_KEY}
Content-Type: application/json

// Request
{
  "url": "https://cdn.divine.video/{sha256}.mp4",
  "detection_type": "csam_combined" // hash + classifier
}

// Response
{
  "status": [{
    "response": {
      "output": [{
        "hash_match": {
          "is_match": false,
          "hash_type": "perceptual" // or "cryptographic"
        },
        "classifier": {
          "csam_score": 0.05, // 0-1 probability
          "is_csam": false    // bool threshold
        }
      }]
    }
  }]
}

// If CSAM detected
{
  "hash_match": {
    "is_match": true,
    "matched_hash": "abc123...",
    "ncmec_reported": true,
    "report_id": "ncmec_12345"
  }
}
```

### Hive Visual Moderation API

```javascript
// Endpoint
POST https://api.thehive.ai/api/v2/task/sync

// Request
{
  "url": "https://cdn.divine.video/{sha256}.mp4",
  "moderation_classes": [
    "yes_sexual_content",
    "yes_sexual_activity",
    "yes_suggestive",
    "yes_ai_generated",
    "yes_deepfake",
    "yes_violence",
    "yes_gore",
    "yes_weapon",
    "yes_drugs",
    "yes_hate_symbols",
    "yes_offensive"
  ]
}

// Response
{
  "status": [{
    "response": {
      "output": [
        {
          "time": 2.0, // seconds into video
          "classes": [
            {
              "class": "yes_sexual_content",
              "score": 0.95
            },
            {
              "class": "yes_ai_generated",
              "score": 0.12
            }
          ]
        }
      ]
    }
  }]
}
```

---

## User Experience Flows

### Flow 1: Age-Gated Adult Content

```
User browses feed
  ↓
Sees blurred thumbnail with "18+ Content" label
  ↓
Clicks to view
  ↓
IF user.age_verified && user.adult_content_enabled:
  → Show video
ELSE IF user.age_verified && !user.adult_content_enabled:
  → Prompt: "This video contains adult content. Enable in settings?"
    → [Go to Settings] [Cancel]
ELSE:
  → Prompt: "This video is restricted to adults 18+. Verify your age?"
    → [Verify Age] [Cancel]
```

### Flow 2: Flagged Content Review

```
AI flags video for review
  ↓
Video hidden from public feed (not published)
  ↓
Moderator notified in faro.nos.social
  ↓
Moderator reviews video + AI scores
  ↓
Decision:
  → APPROVE: Publish to feed
  → AGE-GATE: Publish with 18+ restriction
  → BLOCK: Remove permanently
  → REQUEST MORE INFO: Contact uploader
```

### Flow 3: CSAM Detection

```
Video uploaded
  ↓
CSAM detection API called
  ↓
MATCH DETECTED
  ↓
[AUTOMATIC ACTIONS]
- Video immediately blocked (never shown)
- Upload rejected
- NCMEC report filed automatically
- Account flagged for investigation
- Law enforcement notification (if required)
  ↓
User sees: "Upload failed. Content violates legal requirements."
(No specifics given to avoid evasion tactics)
```

---

## Cost Estimates

### Hive Pricing (Estimated)

**CSAM Detection**:
- Typically enterprise pricing
- May be subsidized for safety (some providers offer reduced/free CSAM detection)
- Contact Hive sales for pricing

**Visual Moderation**:
- ~$1,500-3,000/month for 1000 hours
- 6-second videos = ~$0.015-0.03 per video (estimated)

**Total for 100K videos/month**:
- ~$1,500-3,000 base
- May increase with volume

**Note**: CSAM detection is often priced separately or subsidized as it's a legal/safety requirement.

---

## Legal & Compliance Considerations

### CSAM Reporting Requirements

**United States (NCMEC)**:
- Platforms must report CSAM to NCMEC
- Failure to report is a federal crime
- Hive's integrated reporting helps compliance

**International**:
- EU: Report to national hotlines
- UK: Report to IWF (Internet Watch Foundation)
- Hive supports international reporting workflows

### Age Verification

**Current Approach** (Minimum Viable):
- Self-reported age in profile
- Terms of Service agreement (user attests 18+)

**Future Enhancements**:
- ID verification (passport, driver's license)
- Third-party age verification services
- Credit card verification
- Compliance with UK Online Safety Act (if serving UK users)

### User Privacy

**CSAM Detection**:
- Hive deletes original media after processing
- Only embeddings/hashes retained
- Privacy-preserving approach

**Moderation Logs**:
- Store minimal PII
- Retain for legal compliance period
- Encrypt sensitive data

---

## Migration Timeline

### Phase 1: CSAM Detection (Week 1-2) - HIGHEST PRIORITY
1. Sign up for Hive CSAM Detection API
2. Implement CSAM check in moderation pipeline
3. Test with NCMEC test dataset (if available)
4. Configure automatic reporting workflow
5. Deploy to production (BLOCKING - no videos published without this)

### Phase 2: Adult Content Age-Gating (Week 3-4)
1. Implement Hive Visual Moderation API
2. Build age-gating classification logic
3. Add user preference settings (opt-in/out)
4. Update Nostr event tags (content-warning)
5. Implement blurred thumbnail UI
6. Deploy age verification flow

### Phase 3: Harmful Content Flagging (Week 5-6)
1. Integrate with faro.nos.social (human review tool)
2. Build flagging workflow
3. Moderator dashboard enhancements
4. Notification system for moderators
5. Review and appeal process

### Phase 4: AI-Generated Detection (Week 7-8)
1. Enable AI-generated detection models
2. Define policy (block vs label)
3. Implement flagging/labeling logic
4. User communication about policy
5. Monitor false positive rate

---

## Testing Strategy

### CSAM Detection Testing
⚠️ **NEVER use real CSAM for testing**

**Safe Testing Approaches**:
1. Synthetic test images (if Hive provides)
2. Hash matching test vectors (non-CSAM hashes)
3. Adult content that should NOT match CSAM
4. Borderline content (clothed minors in non-sexual context)

### Adult Content Testing
- Known adult content (should age-gate)
- Suggestive but not explicit (borderline cases)
- Artistic nudity (classical art, medical)
- False positives (beach photos, etc.)

### Integration Testing
- Full pipeline: upload → moderation → classification → action
- User flows: opt-in, age verification, blurred previews
- Moderator flows: review queue, decisions, appeals

---

## Open Questions

1. **Age verification method?**
   - Self-reported sufficient for now?
   - Need robust verification (ID check)?
   - UK/EU users require stricter verification?

2. **AI-generated policy?**
   - Hard block or allow with label?
   - User opt-in to see AI content?
   - Exceptions for artistic use?

3. **Appeal process?**
   - How do users appeal moderation decisions?
   - Who reviews appeals?
   - Timeline for appeals?

4. **CSAM detection threshold?**
   - Zero tolerance (any score > 0)?
   - Use Hive's recommended threshold?
   - Hash match = instant block?

5. **Human moderator capacity?**
   - How many moderators?
   - Response time SLA?
   - 24/7 coverage needed?

---

## Next Steps

**Immediate**:
1. Contact Hive sales for CSAM Detection API access
2. Confirm pricing for CSAM + Visual Moderation
3. Define AI-generated content policy (block vs label)
4. Determine age verification approach

**Ready to Implement**:
- CSAM detection integration (highest priority)
- Adult content age-gating
- Hive Visual Moderation API adapter

Want me to start implementing the Hive CSAM + Visual Moderation integration?
