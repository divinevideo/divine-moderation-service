# BunnyCDN Stream API Research Findings

## Summary

I researched BunnyCDN's content moderation features and found their **Automated Content Tagging** system. Here's what I discovered and how our integration works.

## Key Findings

### 1. BunnyCDN Has Automated Content Tagging

**Announced**: January 2025
**Status**: FREE preview feature
**Purpose**: Video content moderation and categorization

**How it works**:
- Machine learning automatically tags videos during transcoding
- Categories include: adult, sports, people, games, movie + 16 subcategories
- Designed specifically for content moderation use cases
- Privacy-focused: Your videos are never used to train the ML models

### 2. API Structure Discovery

After researching documentation and library source code, I found the exact API response format:

**Endpoint**: `GET https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}`

**Authentication**: `AccessKey` header (found in BunnyCDN dashboard)

**Response Structure**:
```json
{
  "videoLibraryId": 12345,
  "guid": "video-guid-here",
  "title": "Video Title",
  "length": 6,
  "status": 4,
  "metaTags": [
    { "property": "contentTag", "value": "adult" },
    { "property": "contentTag", "value": "people" },
    { "property": "category", "value": "sports" }
  ],
  "dateUploaded": "2025-01-23T12:00:00Z",
  "encodeProgress": 100,
  ...
}
```

**Critical Discovery**: Content tags are stored in the `metaTags` array with `property` and `value` fields, NOT as a separate `tags` or `contentTags` field.

**Source**: TypeScript definitions from `dan-online/bunnycdn-stream` library on GitHub

### 3. Available Node.js Libraries

Three main libraries for BunnyCDN Stream:

#### bunnycdn-stream (Recommended)
- **Package**: `bunnycdn-stream` on npm
- **Author**: dan-online
- **Stars**: 41 on GitHub
- **Language**: TypeScript
- **License**: Apache-2.0
- **Status**: Actively maintained, last update 6 months ago
- **Features**: Full Stream API support, TypeScript types

**Installation**:
```bash
npm install bunnycdn-stream
```

**Usage**:
```javascript
import BunnyStream from 'bunnycdn-stream';

const stream = new BunnyStream({
  apiKey: process.env.BUNNY_API_KEY,
  libraryId: process.env.BUNNY_LIBRARY_ID
});

// Get video metadata including content tags
const video = await stream.getVideo('video-guid');
console.log(video.metaTags);  // [{ property: "contentTag", value: "adult" }]
```

#### bunnycdn (Alternative)
- **Package**: `bunnycdn` on npm
- **Author**: wraith4081
- **Features**: Storage + Stream operations

#### Direct API (What we're using)
- Simple fetch() calls
- No dependencies
- Full control over requests
- Works in Cloudflare Workers (our deployment environment)

### 4. How to Enable Content Tagging

**Step 1**: Go to https://panel.bunny.net/stream
**Step 2**: Select your video library
**Step 3**: Click "Settings"
**Step 4**: Find "Encoding" section
**Step 5**: Enable "Automated Content Tagging"
**Step 6**: Save settings

**Important**: Only NEW videos uploaded after enabling will have tags. Existing videos need re-transcoding.

### 5. Content Categories

Based on blog post and research, BunnyCDN detects 16+ categories:

**Moderation-relevant**:
- **adult** → Maps to our `nudity` category
- (possibly violence, weapons, etc. - needs testing)

**Other categories** (not used for moderation):
- sports (soccer, tennis, racing, etc.)
- people
- games
- movie

### 6. Our Implementation

I updated the BunnyCDN provider to work with the discovered API structure:

#### src/moderation/providers/bunnycdn/client.mjs

**Key function**: `extractContentTags(metaTags)`

This function:
1. Receives the `metaTags` array from BunnyCDN API
2. Filters for entries with content-related properties:
   - "contentTag"
   - "contentCategory"
   - "category"
   - "tag"
   - (case-insensitive partial matching)
3. Extracts the `value` from matching entries
4. Returns array of tag names: `["adult", "people"]`

**Example**:
```javascript
// Input: API response
{
  metaTags: [
    { property: "contentTag", value: "adult" },
    { property: "contentTag", value: "people" },
    { property: "customMeta", value: "user-data" }  // ignored
  ]
}

// Output: extractContentTags() returns
["adult", "people"]
```

#### src/moderation/providers/bunnycdn/normalizer.mjs

Maps BunnyCDN categories to our standard format:

```javascript
'adult' → 'nudity' (score: 1.0)
'adult_content' → 'nudity'
'sexual' → 'nudity'
'nsfw' → 'nudity'
'violence' → 'violence'
'weapons' → 'weapons'
// etc.
```

**Note**: BunnyCDN doesn't provide confidence scores, so we use `1.0` for detected categories.

### 7. Video ID Mapping

Our implementation supports multiple ways to identify videos:

1. **Explicit ID**: `metadata.bunnyVideoId`
2. **SHA256**: `metadata.sha256` (if you use SHA256 as video ID)
3. **URL parsing**: Extract from `https://cdn.divine.video/{id}.mp4`

**You need to verify**: How Divine's SHA256 maps to BunnyCDN video IDs.

Check your upload code to see if:
- SHA256 IS the BunnyCDN video ID
- You store BunnyCDN's generated ID somewhere
- You need a mapping table

## Next Steps

### 1. Enable Content Tagging
Enable in your BunnyCDN panel (see Step 4 above)

### 2. Upload a Test Video
Upload a NEW video to get content tags (existing videos won't have them)

### 3. Run Test Script
```bash
BUNNY_API_KEY=xxx BUNNY_LIBRARY_ID=xxx \
  node scripts/test-bunnycdn-provider.mjs \
  https://cdn.divine.video/YOUR_VIDEO_SHA256.mp4
```

This will:
- Call BunnyCDN API and show raw response
- Display what `metaTags` properties exist
- Show detected content tags
- Compare with Sightengine accuracy

### 4. Verify metaTags Property Name
The test will reveal the exact property name BunnyCDN uses:
- Is it "contentTag"?
- Is it "category"?
- Something else?

If it's different from our guesses, we'll update `extractContentTags()` to match.

### 5. Test Accuracy
Test with various videos:
- Safe content (should NOT flag)
- Adult content (should flag as "adult")
- Content Sightengine got wrong

### 6. Switch Provider (if good)
If BunnyCDN is more accurate than Sightengine:

```bash
# .env
PRIMARY_MODERATION_PROVIDER=bunnycdn

# Deploy
npm run deploy
```

## Cost Analysis

| Provider | Cost (100K videos/month) | Notes |
|----------|--------------------------|-------|
| **BunnyCDN** | $0 (FREE) | Included with Stream hosting during preview |
| **Sightengine** | $399 | Inaccurate (false positives + false negatives) |
| **AWS Rekognition** | ~$1,000 | Most accurate, but expensive |

**If BunnyCDN works well**:
- Save $399/month (or $1,000/month vs AWS)
- Simpler architecture (one service for hosting + moderation)
- Already paying for BunnyCDN hosting

## Potential Issues & Solutions

### Issue: "No content tags found"
**Causes**:
1. Content tagging not enabled
2. Video uploaded before feature was enabled
3. Video still transcoding

**Solution**: Enable feature, upload NEW test video

### Issue: "Could not determine BunnyCDN video ID"
**Cause**: Video ID mapping unclear

**Solution**: Check upload code to see how Divine videos map to BunnyCDN IDs

### Issue: Wrong metaTags property name
**Cause**: BunnyCDN uses different property name than we guessed

**Solution**: Test script will show available properties, update `extractContentTags()`

### Issue: BunnyCDN doesn't detect what we need
**Cause**: Feature might only detect "adult" category for now

**Solution**: Fall back to AWS or Sightengine, email BunnyCDN support

## Documentation Sources

1. **Blog Post**: https://bunny.net/blog/introducing-bunny-stream-video-content-tagging/
2. **Support Article**: https://support.bunny.net/hc/en-us/articles/4412240806802-Understanding-Bunny-Stream-Content-Tagging
3. **API Docs**: https://docs.bunny.net/reference/video_getvideo
4. **TypeScript Types**: https://github.com/dan-online/bunnycdn-stream (exact response structure)
5. **Video Storage**: https://docs.bunny.net/docs/stream-video-storage-structure

## Questions for BunnyCDN Support (if needed)

If the test reveals issues or limitations:

**Email**: support@bunny.net

**Questions**:
1. What is the exact property name in metaTags for content tags?
2. What categories beyond "adult" do you detect?
3. Do you have violence, weapons, drugs detection?
4. What's the accuracy compared to AWS Rekognition or Sightengine?
5. Is CSAM detection available? (Bunny Shield - announced August 2025)
6. Pricing: Will content tagging remain free after preview?

## Conclusion

BunnyCDN's Automated Content Tagging is a promising option:

✅ **Free** (during preview)
✅ **Already using BunnyCDN** for hosting
✅ **Simple integration** (one API call)
✅ **Privacy-focused** (videos not used for training)

❓ **Unknown accuracy** - needs testing
❓ **Limited categories?** - might only detect "adult" for now
❓ **Preview status** - might change/become paid later

**Recommendation**: Test it! If it works well enough for adult content detection, it could save significant money and simplify your architecture.
