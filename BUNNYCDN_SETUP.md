# BunnyCDN Provider Setup Guide

## Quick Start

The BunnyCDN provider uses BunnyCDN Stream's automated content tagging feature to detect adult content, violence, and other categories. Since you're already using BunnyCDN for video hosting, this may be the most cost-effective option.

## Step 1: Enable Content Tagging

1. Go to https://panel.bunny.net/stream
2. Select your video library
3. Click "Settings"
4. Find "Automated Content Tagging" section
5. Enable content tagging (it's FREE during preview)
6. Save settings

**Note**: Content tagging only applies to NEW videos uploaded after enabling. Existing videos won't have tags unless you re-transcode them.

## Step 2: Get API Credentials

You should already have these if you're using BunnyCDN:

1. **API Key**:
   - Go to https://panel.bunny.net/account
   - Copy your API Key (or generate a new one)

2. **Library ID**:
   - Go to https://panel.bunny.net/stream
   - Your library ID is in the URL: `panel.bunny.net/stream/{libraryId}`
   - Or find it in your library settings

## Step 3: Configure Environment

Add to your `.env` file:

```bash
# BunnyCDN Configuration
BUNNY_API_KEY=your-api-key-here
BUNNY_LIBRARY_ID=your-library-id-here

# Set BunnyCDN as primary provider (optional)
PRIMARY_MODERATION_PROVIDER=bunnycdn
```

## Step 4: Test the Provider

Run the test script to verify everything works:

```bash
BUNNY_API_KEY=xxx BUNNY_LIBRARY_ID=xxx node scripts/test-bunnycdn-provider.mjs
```

Or test a specific video:

```bash
BUNNY_API_KEY=xxx BUNNY_LIBRARY_ID=xxx \
  node scripts/test-bunnycdn-provider.mjs \
  https://cdn.divine.video/YOUR_VIDEO_SHA256.mp4
```

The test script will:
1. Call the BunnyCDN API and show the raw response
2. Display normalized scores for all categories
3. Compare with Sightengine (if configured)
4. Identify any disagreements between providers

## Understanding the Results

### What BunnyCDN Detects

Based on their blog post, BunnyCDN's content tagging detects:
- **adult** - Adult/sexual content (maps to our `nudity` category)
- **sports** - Sports content (not used for moderation)
- **people** - People in video (not used for moderation)
- **games** - Gaming content (not used for moderation)
- **movie** - Movie clips (not used for moderation)

**Important**: We primarily care about the "adult" tag for content moderation. Other tags might be useful for discovery/recommendations but don't trigger moderation actions.

### Expected Response Format

The BunnyCDN API returns video metadata including a `metaTags` array:

```json
{
  "videoLibraryId": 12345,
  "guid": "e7e9b99a-ea2a-434a-b200-f6615e7b6abd",
  "title": "Video Title",
  "metaTags": [
    { "property": "contentTag", "value": "adult" },
    { "property": "contentTag", "value": "people" },
    { "property": "customMeta", "value": "something" }
  ],
  "length": 6,
  "status": 4,
  ...
}
```

**Key Discovery**: Content tags are stored in the `metaTags` array with property/value structure, NOT as a separate `tags` or `contentTags` field. Our code extracts entries where `property` matches content tag indicators (contentTag, category, tag, etc.)

## Step 5: Compare Accuracy

Test BunnyCDN against Sightengine with various videos:

1. **Safe content** - Should NOT flag
2. **Adult content** - Should flag as "adult"
3. **Borderline content** - See which is more accurate
4. **Videos Sightengine got wrong** - Test known false positives/negatives

Document your findings:
- False positives (flagged when shouldn't be)
- False negatives (missed actual violations)
- Overall accuracy vs Sightengine

## Step 6: Switch Provider (if BunnyCDN is better)

If BunnyCDN is more accurate than Sightengine:

```bash
# Update .env
PRIMARY_MODERATION_PROVIDER=bunnycdn

# Redeploy
npm run deploy
```

The orchestrator will automatically use BunnyCDN as primary, with Sightengine as fallback.

## Troubleshooting

### "No content tags found" Warning

This means:
1. Content tagging is not enabled in your library settings, OR
2. The video was uploaded before content tagging was enabled, OR
3. The video hasn't finished transcoding yet

**Fix**: Enable content tagging, then upload a NEW test video.

### "Could not determine BunnyCDN video ID"

Our code tries multiple methods to get the video ID:
1. `metadata.bunnyVideoId` - Explicit video ID
2. `metadata.sha256` - SHA256 hash (if that's how you store them)
3. URL parsing - Extract from `cdn.divine.video/{id}.mp4`

**Fix**: Check how your videos are stored in BunnyCDN. You may need to update the `getVideoId()` function in `src/moderation/providers/bunnycdn/client.mjs`.

### BunnyCDN API Returns 404

This means the video ID doesn't exist in your library.

**Fix**: Verify the video is actually in your BunnyCDN library. Check the video ID mapping logic.

### "AccessKey invalid" Error

Your API key is wrong or expired.

**Fix**: Generate a new API key in the BunnyCDN panel.

## Video ID Mapping

**Important**: You need to determine how Divine's video SHA256 maps to BunnyCDN video IDs.

Options:
1. **SHA256 IS the video ID** - If you upload videos using SHA256 as the ID
2. **Store bunnyVideoId in metadata** - If BunnyCDN generates IDs, store them in your database
3. **Maintain a mapping table** - Map SHA256 → BunnyCDN video ID

Check your upload code to see which approach you use.

## Cost Comparison

| Provider | Cost (100K videos/month) | Notes |
|----------|--------------------------|-------|
| **BunnyCDN** | $0 (FREE) | Included with Stream hosting during preview |
| **Sightengine** | $399 | Top tier, but inaccurate |
| **AWS Rekognition** | ~$1,000 | Most accurate, but expensive |

**If BunnyCDN is accurate enough**: Massive cost savings + simplification (one service for hosting + moderation).

## Next Steps After Testing

### If BunnyCDN Works Well:
1. Set `PRIMARY_MODERATION_PROVIDER=bunnycdn`
2. Keep Sightengine as fallback for now
3. Monitor accuracy over time
4. Consider removing Sightengine entirely to save $399/month

### If BunnyCDN Doesn't Work Well:
1. Implement AWS Rekognition authentication (see `AWS_SETUP.md`)
2. Test AWS accuracy
3. Switch to AWS as primary

### If BunnyCDN Doesn't Have the Feature Yet:
1. Email BunnyCDN support (template in `BUNNYCDN_QUESTIONS.md`)
2. Ask about ETA for content tagging feature
3. Use AWS or Sightengine in the meantime

## Support

If you have questions about BunnyCDN's content tagging feature:
- Email: support@bunny.net
- Docs: https://docs.bunny.net/docs/stream
- Blog: https://bunny.net/blog/introducing-bunny-stream-video-content-tagging/
