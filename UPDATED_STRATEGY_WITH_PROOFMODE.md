# Divine Moderation Strategy with ProofMode

**Last Updated**: 2025-10-23

## The ProofMode Advantage

Divine's ProofMode provides **cryptographic authenticity** - a much stronger approach than trying to detect AI-generated content through visual analysis.

### Why ProofMode > AI Detection

**AI Detection (traditional approach)**:
- ❌ Arms race you can't win (AI improves, artifacts vanish)
- ❌ False positives (real videos flagged as AI)
- ❌ False negatives (good AI slips through)
- ❌ "Real things that look like AI" problem

**ProofMode (cryptographic approach)**:
- ✅ Cryptographically proves video came from real device camera
- ✅ Hardware attestation (not spoofable)
- ✅ Not an arms race - either has proof or doesn't
- ✅ Handles edge cases gracefully (real → AI-looking content)

---

## Tiered Moderation Strategy

### Tier 1: Videos WITH ProofMode ✅

**Verification Levels**:
1. **Verified Mobile** (Highest) - Full hardware attestation + PGP signature
2. **Verified Web** (Medium) - PGP signature, no hardware attestation
3. **Basic Proof** (Low) - PGP signature only, no capture guarantee

**Moderation Flow**:
```
ProofMode Video Upload
    ↓
[Verify cryptographic proof]
    ↓
VALID PROOF?
    ↓ YES
[1. CSAM Check] → MATCH? → BLOCK + NCMEC Report
    ↓ PASS
[2. Adult Content] → HIGH? → Age-gate
    ↓ PASS
[3. Harmful Content] → HIGH? → Flag for review
    ↓ PASS
✅ APPROVED - Publish with verification badge
```

**Trust Model**:
- ProofMode proves video is **real camera capture** (not AI-generated)
- Still need CSAM detection (real devices can capture CSAM)
- Still need adult content detection (real cameras can film porn)
- Still need harmful content detection (real cameras can film violence)

**AI Detection**: NOT NEEDED - cryptographic proof handles this

---

### Tier 2: Videos WITHOUT ProofMode ⚠️

**No cryptographic authenticity guarantee**

**Moderation Flow**:
```
Non-ProofMode Video Upload
    ↓
[1. CSAM Check] → MATCH? → BLOCK + NCMEC Report
    ↓ PASS
[2. AI-Generated Detection] → HIGH? → FLAG or BLOCK
    ↓ PASS
[3. Adult Content] → HIGH? → Age-gate
    ↓ PASS
[4. Harmful Content] → HIGH? → Flag for review
    ↓ PASS
⚠️ APPROVED - Publish without verification badge
```

**Additional Check**: AI-generated detection
- Use Hive's AI detection API
- **Policy options**:
  - **Option A**: Hard block (align with "no AI content" policy)
  - **Option B**: Allow but require label: "AI-generated or unverified"
  - **Option C**: Flag for human review

**User Incentive**: Encourage ProofMode adoption
- Videos WITH ProofMode get verification badge → more trust → more views
- Videos WITHOUT ProofMode marked "Unverified" → less trust
- Natural incentive to use ProofMode-enabled apps

---

## Moderation Provider Recommendations

### For CSAM Detection: **Hive** (Required)

**Why**:
- ✅ 57M+ known CSAM hash database (NCMEC)
- ✅ AI classifier for novel CSAM
- ✅ Video support (scene-sensitive hashing)
- ✅ Integrated NCMEC reporting (legal compliance)
- ✅ Privacy-first (deletes originals)

**BunnyCDN Alternative**: Not ready yet
- ⏰ CSAM detection announced but not available
- ❓ Contact BunnyCDN to ask ETA
- 💡 Could migrate to BunnyCDN later if pricing better

### For Adult Content / Harmful Content: **Hive or BunnyCDN**

**Hive Visual Moderation API**:
- ✅ Adult content detection (97% accuracy)
- ✅ Violence, gore, weapons, drugs, hate symbols
- ✅ Same platform as CSAM detection (unified)

**BunnyCDN Automated Content Tagging** (alternative):
- ✅ Already using BunnyCDN for hosting
- ✅ Edge-based (fast, integrated)
- ❓ Unknown accuracy vs Hive
- 💰 May be included in existing BunnyCDN costs

**Recommendation**:
- **Start with Hive** (proven, comprehensive, same platform as CSAM)
- **Test BunnyCDN content tagging** in parallel if already paying for it
- **Switch to BunnyCDN** if accuracy comparable and cost savings significant

### For AI-Generated Detection: **Only for Non-ProofMode Videos**

**Hive AI Detection**:
- ✅ 98%+ accuracy
- ✅ Deepfake detection included
- ✅ Same platform as CSAM + adult content

**Important**: Only run for videos WITHOUT ProofMode
- ProofMode videos don't need AI detection (cryptographically verified)
- Saves API costs (skip this check for ProofMode videos)

---

## Implementation Architecture

### Moderation Pipeline with ProofMode

```javascript
async function moderateVideo(videoData, env) {
  const { sha256, nostrEvent } = videoData;

  // Step 0: Check ProofMode status
  const proofMode = await verifyProofMode(nostrEvent);
  const hasValidProof = proofMode.verified && proofMode.level !== 'unverified';

  // Step 1: CSAM Detection (ALWAYS - even for ProofMode videos)
  const csamResult = await hive.detectCSAM(videoUrl);

  if (csamResult.isCSAM) {
    await blockVideo(sha256, 'CSAM_DETECTED');
    await reportToNCMEC(csamResult);
    return { action: 'BLOCKED', reason: 'CSAM' };
  }

  // Step 2: AI-Generated Detection (SKIP for ProofMode videos)
  if (!hasValidProof) {
    const aiResult = await hive.detectAIGenerated(videoUrl);

    if (aiResult.score > 0.7) {
      // Policy decision point
      if (env.AI_CONTENT_POLICY === 'BLOCK') {
        await blockVideo(sha256, 'AI_GENERATED');
        return { action: 'BLOCKED', reason: 'AI_GENERATED' };
      } else if (env.AI_CONTENT_POLICY === 'FLAG') {
        await flagForReview(sha256, 'AI_GENERATED', aiResult.score);
      }
      // If ALLOW_WITH_LABEL, continue but mark video
    }
  }

  // Step 3: Adult Content Detection
  const moderation = await hive.moderateContent(videoUrl);
  const classification = classifyContent(moderation);

  return {
    ...classification,
    proofMode: proofMode.level,
    verificationBadge: hasValidProof
  };
}
```

### ProofMode Verification

```javascript
async function verifyProofMode(nostrEvent) {
  // Extract ProofMode tags from Nostr event
  const proofVersion = getTag(nostrEvent, 'proof-version');
  const verificationLevel = getTag(nostrEvent, 'verification-level');
  const manifest = getTag(nostrEvent, 'proof-manifest');
  const deviceAttestation = getTag(nostrEvent, 'device-attestation');
  const pgpPubkey = getTag(nostrEvent, 'pgp-pubkey');
  const pgpFingerprint = getTag(nostrEvent, 'pgp-fingerprint');

  if (!proofVersion) {
    return { verified: false, level: 'unverified' };
  }

  // Verify PGP signature
  const signatureValid = await verifyPGPSignature(manifest, pgpPubkey);

  if (!signatureValid) {
    return { verified: false, level: 'unverified' };
  }

  // Verify device attestation (if present)
  if (verificationLevel === 'verified_mobile' && deviceAttestation) {
    const attestationValid = await verifyDeviceAttestation(
      deviceAttestation,
      manifest
    );

    if (!attestationValid) {
      return { verified: false, level: 'unverified' };
    }
  }

  return {
    verified: true,
    level: verificationLevel, // verified_mobile, verified_web, basic_proof
    pgpFingerprint,
    captureTime: extractCaptureTime(manifest),
    deviceInfo: extractDeviceInfo(manifest)
  };
}
```

### Cost Optimization

**ProofMode videos** (estimated 80% of uploads with good adoption):
- ✅ CSAM check: ~$X per video
- ✅ Adult/harmful content check: ~$Y per video
- ❌ **Skip AI detection**: Save ~$Z per video

**Non-ProofMode videos** (estimated 20%):
- ✅ CSAM check: ~$X per video
- ✅ AI detection: ~$Z per video
- ✅ Adult/harmful content check: ~$Y per video

**Total savings**: ~$Z × 80% = significant cost reduction by skipping AI detection for ProofMode videos

---

## Database Schema Updates

```sql
-- Add ProofMode columns
ALTER TABLE video_moderation ADD COLUMN proofmode_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE video_moderation ADD COLUMN proofmode_level TEXT; -- verified_mobile, verified_web, basic_proof, unverified
ALTER TABLE video_moderation ADD COLUMN proofmode_pgp_fingerprint TEXT;
ALTER TABLE video_moderation ADD COLUMN proofmode_capture_time TIMESTAMP;

-- AI detection only for non-ProofMode videos
ALTER TABLE video_moderation ADD COLUMN ai_detection_skipped BOOLEAN DEFAULT FALSE;
ALTER TABLE video_moderation ADD COLUMN ai_detection_skip_reason TEXT; -- 'proofmode_verified', null

-- Update indexes
CREATE INDEX idx_proofmode_verified ON video_moderation(proofmode_verified);
CREATE INDEX idx_proofmode_level ON video_moderation(proofmode_level);
```

---

## User Experience

### Feed Display

**ProofMode Video**:
```
┌─────────────────────────────┐
│         [VIDEO]             │
│                             │
│  ✅ Verified Mobile         │
│  6 seconds                  │
│  @username                  │
│  "Cool sunset at beach"     │
└─────────────────────────────┘
```

**Non-ProofMode Video**:
```
┌─────────────────────────────┐
│         [VIDEO]             │
│                             │
│  ⚠️ Unverified              │
│  6 seconds                  │
│  @username                  │
│  "Cool sunset at beach"     │
└─────────────────────────────┘
```

**Age-Gated Video** (regardless of ProofMode):
```
┌─────────────────────────────┐
│    [BLURRED THUMBNAIL]      │
│                             │
│  🔞 18+ Content             │
│  Tap to enable adult        │
│  content in settings        │
└─────────────────────────────┘
```

### Verification Badge Click

Shows detailed proof information:
```
✅ Verified Mobile Capture

This video has cryptographic proof it was
captured by a real device camera.

Verification Level: Verified Mobile
Captured: Oct 23, 2025 at 2:30 PM
Device: iPhone 15 Pro (iOS 18.1)
PGP Fingerprint: AB12 CD34 EF56...

This proves the video is a genuine camera
capture, not AI-generated or heavily edited.

[Learn More About ProofMode]
```

---

## Policy Decisions Needed

### 1. AI-Generated Content Policy (Non-ProofMode videos)

**Option A: Hard Block** (Strictest)
- Aligns with "no AI content" brand promise
- Clear, simple policy
- Risk: False positives block real content
- Recommendation: **Only if false positive rate very low (<1%)**

**Option B: Flag for Human Review** (Moderate)
- Humans decide on borderline cases
- Lower risk of false positives
- Requires moderator capacity
- Recommendation: **Best balance**

**Option C: Allow with Label** (Permissive)
- Videos marked "AI-generated or unverified"
- Users decide if they trust it
- Softer enforcement
- Recommendation: **Only if moderation capacity limited**

**My Recommendation**: Start with **Option B** (flag for review), evaluate false positive rate, potentially move to Option A if rate is low.

### 2. ProofMode Adoption Strategy

**Incentive Structure**:
- ✅ ProofMode videos: Verification badge → more trust → better engagement
- ⚠️ Non-ProofMode videos: "Unverified" label → less trust
- 🎯 Goal: 80%+ ProofMode adoption within 6 months

**Strategies**:
1. **Default to ProofMode** in official Divine mobile apps
2. **Educate users** about verification benefits
3. **Surface ProofMode videos** more in algorithm (higher trust)
4. **Allow non-ProofMode** uploads but deprioritize

### 3. BunnyCDN vs Hive for Content Moderation

**Test BunnyCDN Content Tagging**:
- Already using BunnyCDN for video hosting
- May be included in costs or cheaper
- Unknown accuracy vs Hive

**Action**:
1. Contact BunnyCDN about:
   - CSAM detection ETA
   - Content tagging accuracy data
   - Pricing if not included
2. Run parallel test: BunnyCDN vs Hive on same videos
3. Compare accuracy + cost
4. Decide: Hive (proven) vs BunnyCDN (integrated)

---

## Migration Timeline (Updated)

### Phase 1: CSAM Detection (Week 1-2) - CRITICAL
1. Sign up for Hive CSAM Detection API
2. Implement CSAM check (all videos, including ProofMode)
3. Test with safe test dataset
4. Configure NCMEC reporting
5. **BLOCKING** - deploy before any videos published

### Phase 2: ProofMode Verification (Week 2-3)
1. Implement ProofMode tag parsing
2. Build PGP signature verification
3. Integrate device attestation validation
4. Add verification badges to UI
5. Deploy ProofMode support

### Phase 3: Conditional AI Detection (Week 3-4)
1. Implement Hive AI detection API
2. Add logic: Skip AI detection if ProofMode verified
3. Define policy (block/flag/label)
4. Deploy with monitoring

### Phase 4: Adult Content Age-Gating (Week 4-5)
1. Implement Hive Visual Moderation OR BunnyCDN content tagging
2. Build age-gating UI (blurred thumbnails)
3. User preference system (opt-in)
4. Add content-warning tags to Nostr events
5. Deploy

### Phase 5: Harmful Content Flagging (Week 5-6)
1. Integrate with faro.nos.social
2. Build flagging workflow
3. Moderator notifications
4. Review and appeal process

### Phase 6: Optimization (Week 7+)
1. Monitor ProofMode adoption rate
2. Evaluate false positive/negative rates
3. Test BunnyCDN content tagging (if available)
4. Cost optimization
5. Policy adjustments based on data

---

## Cost Estimates (Updated)

### With 80% ProofMode Adoption (100K videos/month)

**ProofMode videos (80K)**:
- CSAM detection: 80K × $X
- Adult/harmful content: 80K × $Y
- AI detection: **$0** (skipped)

**Non-ProofMode videos (20K)**:
- CSAM detection: 20K × $X
- AI detection: 20K × $Z
- Adult/harmful content: 20K × $Y

**Total**: Much lower than 100% AI detection

**Savings from ProofMode**: 80K × $Z = significant

---

## Open Questions

1. **BunnyCDN CSAM detection ETA?**
   - Contact BunnyCDN sales
   - If available soon, may save costs

2. **BunnyCDN content tagging accuracy?**
   - Test against Hive on same videos
   - May be "good enough" if cheaper

3. **AI-generated content policy?**
   - Hard block, flag for review, or allow with label?
   - Depends on false positive rate

4. **ProofMode adoption expectations?**
   - What % of users will use ProofMode apps?
   - Affects cost calculations

5. **Age verification approach?**
   - Self-reported sufficient for now?
   - Need ID verification?

---

## Next Steps

**Immediate**:
1. **Contact BunnyCDN**: Ask about CSAM detection availability + content tagging accuracy
2. **Contact Hive**: Get pricing for CSAM + Visual Moderation APIs
3. **Define AI policy**: Block, flag, or label?
4. **Test ProofMode verification**: Build verification logic

**Ready to Implement**:
1. Hive CSAM Detection integration
2. ProofMode verification logic
3. Conditional AI detection (skip for ProofMode)
4. Hive Visual Moderation for adult/harmful content

Want me to:
- **A)** Start implementing Hive CSAM + ProofMode verification?
- **B)** Build comparison test for BunnyCDN vs Hive content tagging?
- **C)** Create detailed API integration code for the moderation pipeline?
