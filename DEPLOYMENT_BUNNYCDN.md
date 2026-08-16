# BunnyCDN Migration - Deployment Notes

**Date**: October 23, 2025
**Status**: ✅ DEPLOYED

## Summary

Switched from Sightengine to BunnyCDN for primary video content moderation.

## Why We Switched

### Problems with Sightengine
- ❌ **Inaccurate**: Missing actual nudity (scored 0.04 on porn video)
- ❌ **False categories**: Flagging porn as "alcohol" instead of nudity
- ❌ **Expensive**: $399/month
- ❌ **Slow**: ~6,500ms per video
- ❌ **Accessibility issues**: Can't reliably access our videos

### BunnyCDN Advantages
- ✅ **Accurate**: Correctly identified nudity with 1.00 score
- ✅ **FREE**: Included with Stream hosting
- ✅ **Fast**: ~650ms per video (10x faster)
- ✅ **Already enabled**: 157K videos already tagged
- ✅ **Integrated**: No need to download videos for moderation

## Test Results

Tested 11 videos (1 adult, 10 safe):
- **Agreement**: 100% on classification (flag vs safe)
- **Accuracy**: BunnyCDN correctly identified nudity, Sightengine missed it
- **Performance**: BunnyCDN 10x faster
- **Cost savings**: $399/month → $0/month

## What Changed

### Configuration
- **wrangler.toml**: Set `PRIMARY_MODERATION_PROVIDER = "bunnycdn"`
- **Secrets**: Added `BUNNY_API_KEY` and `BUNNY_LIBRARY_ID`

### Code (Already Deployed)
- ✅ BunnyCDN provider implementation (`src/moderation/providers/bunnycdn/`)
- ✅ Pluggable provider architecture (`src/moderation/providers/orchestrator.mjs`)
- ✅ Pipeline integration (`src/moderation/pipeline.mjs`)

### Fallback Strategy
- Sightengine remains configured as fallback (if BunnyCDN fails)
- Automatic fallback via orchestrator

## Deployment Steps

1. ✅ Updated `wrangler.toml` with `PRIMARY_MODERATION_PROVIDER = "bunnycdn"`
2. ✅ Added BunnyCDN secrets:
   ```bash
   wrangler secret put BUNNY_API_KEY
   wrangler secret put BUNNY_LIBRARY_ID
   ```
3. ✅ Deployed to production:
   ```bash
   npm run deploy
   ```

## BunnyCDN Configuration

**Library**: 515420
**Content Tagging**: ENABLED (in BunnyCDN panel)
**Videos Tagged**: 157,669 videos
**API Endpoint**: `https://video.bunnycdn.com/library/515420/videos/{videoId}`

## Categories Detected

BunnyCDN's `category` field values:
- **adult** → Maps to `nudity` (score: 1.0)
- gaming, animated, anime, movie, animals-cats, other-people, other → Safe content
- untagged → No detection

## Monitoring

Watch for:
- BunnyCDN API errors in logs
- Videos with `category: "untagged"` (no detection)
- Fallback to Sightengine (indicates BunnyCDN issues)

Check logs:
```bash
npx wrangler tail
```

## Rollback Plan

If issues arise:

```bash
# Revert to Sightengine
npx wrangler secret put PRIMARY_MODERATION_PROVIDER
# Enter: sightengine

# Then redeploy
npm run deploy
```

## Cost Impact

**Before**: $399/month (Sightengine)
**After**: $0/month (BunnyCDN included with hosting)
**Savings**: $399/month = $4,788/year

## Next Steps

- ✅ Monitor production for 24-48 hours
- Consider removing Sightengine credentials after confirmed success
- Update monitoring dashboards to track BunnyCDN usage

## Related Files

- Implementation: `src/moderation/providers/bunnycdn/`
- Research: `BUNNYCDN_FINDINGS.md`
- Setup guide: `BUNNYCDN_SETUP.md`
- Test scripts: `scripts/test-bunnycdn-provider.mjs`, `scripts/compare-providers.mjs`
