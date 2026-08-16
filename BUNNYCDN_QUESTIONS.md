# BunnyCDN Content Moderation Questions

## Email Template for BunnyCDN Support

**To**: support@bunny.net
**Subject**: Video Content Moderation API - Divine.video

---

Hi BunnyCDN Team,

We're currently using Bunny Stream for video hosting on Divine.video (6-second videos, similar to Vine). We're implementing content moderation and would like to know if BunnyCDN offers video content moderation features.

**Our Requirements**:
- Adult content detection (nudity, sexual content)
- Violence/gore detection
- Weapons, drugs, hate symbols detection
- Ideally: CSAM detection (if available)

**Questions**:

1. **Does BunnyCDN offer automated video content moderation or tagging?**
   - If yes, what categories can you detect?
   - What's the API endpoint and authentication method?

2. **Is this feature included in Bunny Stream pricing or is it extra?**
   - If extra, what's the pricing structure?
   - Per-video, per-minute, or volume tiers?

3. **What's the accuracy/reliability compared to services like AWS Rekognition or Sightengine?**
   - Do you have benchmark data?
   - Can we test it on sample videos?

4. **Do you offer CSAM (child safety) detection?**
   - Hash matching against known databases?
   - AI-based novel CSAM detection?
   - NCMEC reporting integration?

5. **Technical details**:
   - Request/response format?
   - Synchronous or asynchronous API?
   - What video formats are supported?
   - Any file size or duration limits?

6. **What's the ETA for Bunny Shield's CSAM detection?**
   - I saw it was announced as "coming soon" in August 2025
   - Is it available now? If not, when?

**Context**: We're currently evaluating AWS Rekognition and Sightengine, but since we're already using BunnyCDN for hosting, integrating moderation with you would be simpler and potentially more cost-effective.

Looking forward to hearing from you!

Best regards,
[Your Name]
Divine.video

---

## What to Do with Their Response

### If BunnyCDN Has Moderation:

1. **Get API Documentation**
   - Endpoint URLs
   - Authentication (API keys)
   - Request/response formats
   - Available categories

2. **Update the BunnyCDN Provider**
   - `src/moderation/providers/bunnycdn/client.mjs` - Add actual API calls
   - `src/moderation/providers/bunnycdn/normalizer.mjs` - Map their categories
   - `src/moderation/providers/bunnycdn/adapter.mjs` - Update capabilities

3. **Test It**
   ```bash
   # .env
   BUNNY_API_KEY=your-key
   BUNNY_LIBRARY_ID=your-library
   PRIMARY_MODERATION_PROVIDER=bunnycdn
   ```

4. **Compare with AWS/Sightengine**
   ```javascript
   const results = await moderateWithMultiple(
     videoUrl,
     metadata,
     env,
     ['bunnycdn', 'aws-rekognition', 'sightengine']
   );
   // See which is most accurate
   ```

### If BunnyCDN Doesn't Have Moderation:

1. **Use AWS Rekognition**
   - Most accurate self-serve option
   - $0.10/min = ~$0.01 per 6-second video

2. **Keep BunnyCDN for Hosting Only**
   - Videos stay on BunnyCDN
   - AWS reads from BunnyCDN URLs for moderation

3. **Consider Hybrid Approach**
   - BunnyCDN: Video hosting + delivery
   - AWS: Content moderation
   - Two services, but integrated

### If BunnyCDN CSAM is Coming Soon:

**Ask**:
- Specific ETA (weeks? months?)
- Beta access availability
- Pricing when released

**Decision**:
- **If < 4 weeks**: Wait for it, use Sightengine temporarily
- **If > 4 weeks**: Start with AWS, switch to BunnyCDN when ready

---

## Cost Comparison (Estimated)

**Scenario**: 100K videos/month (6 seconds each)

| Provider | Cost Estimate | Notes |
|----------|---------------|-------|
| **BunnyCDN** | $0 - $500? | Unknown, possibly included in Stream pricing |
| **AWS Rekognition** | ~$1,000 | $0.10/min × 10K minutes |
| **Sightengine** | $399 | Top tier, but inaccurate |

**If BunnyCDN includes moderation**: Huge savings + simplification

---

## Next Steps After Response

1. ✅ Email BunnyCDN (use template above)
2. ⏰ Wait for response (usually 24-48 hours)
3. **If YES**:
   - Get API docs
   - Implement BunnyCDN provider
   - Test accuracy
   - Switch if good
4. **If NO**:
   - Implement AWS authentication
   - Deploy AWS provider
   - Monitor accuracy

---

## Current Provider Status

| Provider | Status | Action Needed |
|----------|--------|---------------|
| **AWS Rekognition** | ⚠️ Code ready, needs auth | Implement AWS SigV4 authentication |
| **Sightengine** | ✅ Working but inaccurate | Keep as fallback only |
| **BunnyCDN** | ❓ Unknown capabilities | Email support (see template above) |

---

## I Can Help With

Once you get BunnyCDN's response, I can:
- Implement their API in the BunnyCDN provider
- Map their categories to our standard format
- Test and compare accuracy with AWS
- Help decide which provider to use

Or if BunnyCDN doesn't have it:
- Implement AWS SigV4 authentication
- Get AWS provider working end-to-end
- Help with AWS setup (S3, IAM, etc.)
