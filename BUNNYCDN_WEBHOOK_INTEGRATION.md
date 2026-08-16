# BunnyCDN Webhook Integration Report

## Executive Summary

**Problem**: Videos are being uploaded to BunnyCDN and tagged for content, but they're **not appearing in the moderation dashboard** because they're never being sent to the moderation queue.

**Root Cause**: Missing integration between BunnyCDN Stream and the Divine moderation service.

**Solution**: Implement a webhook endpoint that receives notifications from BunnyCDN when videos finish encoding, then queues them for moderation.

---

## What's Happening Now (BROKEN)

```
User uploads video
    ↓
BunnyCDN Stream receives video ✅
    ↓
BunnyCDN encodes & tags video ✅
    ↓
??? NOTHING HAPPENS ❌
    ↓
Moderation queue: EMPTY ❌
    ↓
Dashboard: NO VIDEOS ❌
```

---

## What Should Happen (FIXED)

```
User uploads video
    ↓
BunnyCDN Stream receives video ✅
    ↓
BunnyCDN encodes & tags video ✅
    ↓
BunnyCDN sends webhook to your endpoint ✅
    ↓
Your webhook handler queues video for moderation ✅
    ↓
Moderation worker processes video ✅
    ↓
Results stored in KV ✅
    ↓
Dashboard shows videos ✅
```

---

## BunnyCDN Webhook Details

### Webhook Configuration

1. Go to https://panel.bunny.net/stream
2. Select your video library (ID: 515420)
3. Click "Settings" → "Webhooks"
4. Set webhook URL to: `https://divine-moderation-service.protestnet.workers.dev/webhook/bunnycdn`

### Webhook Payload

When a video status changes, BunnyCDN sends a POST request:

```json
{
  "VideoLibraryId": 515420,
  "VideoGuid": "657bb740-a71b-4529-a012-528021c31a92",
  "Status": 3
}
```

### Status Codes (Events)

| Status | Event | Action Needed? |
|--------|-------|----------------|
| 0 | Queued for encoding | No |
| 1 | Processing preview | No |
| 2 | Actively encoding | No |
| **3** | **Encoding complete** | **YES - Queue for moderation** |
| 4 | Single resolution finished | Maybe (video is playable) |
| 5 | Encoding failed | No (log error) |
| 6 | Pre-signed upload initiated | No |
| 7 | Pre-signed upload completed | No |
| 8 | Pre-signed upload failed | No |
| 9 | Auto captions generated | No |
| 10 | Auto title/description generated | No |

**Key Event**: Status `3` (Encoding complete) - This is when content tags are finalized and video is ready for moderation.

---

## Required Implementation

### 1. Add Webhook Endpoint to Moderation Service

**File**: `src/index.mjs`

Add this webhook handler:

```javascript
// In the fetch() handler, add:
if (url.pathname === '/webhook/bunnycdn' && request.method === 'POST') {
  return handleBunnyCDNWebhook(request, env);
}

/**
 * Handle BunnyCDN webhook for video encoding completion
 */
async function handleBunnyCDNWebhook(request, env) {
  try {
    const payload = await request.json();
    const { VideoLibraryId, VideoGuid, Status } = payload;

    console.log(`[WEBHOOK] BunnyCDN event: Library=${VideoLibraryId}, Video=${VideoGuid}, Status=${Status}`);

    // Only process "encoding complete" events
    if (Status !== 3 && Status !== 4) {
      console.log(`[WEBHOOK] Ignoring status ${Status} (not encoding complete)`);
      return new Response(JSON.stringify({ received: true, action: 'ignored' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch video metadata from BunnyCDN to get SHA256
    const videoMetadata = await fetchBunnyVideoMetadata(VideoGuid, env);

    if (!videoMetadata || !videoMetadata.sha256) {
      console.error(`[WEBHOOK] Could not determine SHA256 for video ${VideoGuid}`);
      return new Response(JSON.stringify({
        error: 'Missing SHA256 in video metadata',
        videoGuid: VideoGuid
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const sha256 = videoMetadata.sha256;

    // Check if already moderated (avoid duplicates)
    const existingResult = await env.MODERATION_KV.get(`moderation:${sha256}`);
    if (existingResult) {
      console.log(`[WEBHOOK] Video ${sha256} already moderated, skipping`);
      return new Response(JSON.stringify({
        received: true,
        action: 'already_moderated',
        sha256
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Queue for moderation
    await env.MODERATION_QUEUE.send({
      sha256,
      r2Key: `blobs/${sha256}`, // Blossom format
      uploadedAt: Date.now(),
      metadata: {
        bunnyVideoId: VideoGuid,
        bunnyLibraryId: VideoLibraryId,
        source: 'bunnycdn_webhook'
      }
    });

    console.log(`[WEBHOOK] Queued ${sha256} for moderation`);

    return new Response(JSON.stringify({
      received: true,
      action: 'queued',
      sha256,
      videoGuid: VideoGuid
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[WEBHOOK] Error processing BunnyCDN webhook:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Fetch video metadata from BunnyCDN to extract SHA256
 */
async function fetchBunnyVideoMetadata(videoGuid, env) {
  const response = await fetch(
    `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${videoGuid}`,
    {
      headers: {
        'AccessKey': env.BUNNY_API_KEY,
        'Accept': 'application/json'
      }
    }
  );

  if (!response.ok) {
    console.error(`[WEBHOOK] BunnyCDN API error: ${response.status} ${response.statusText}`);
    return null;
  }

  const video = await response.json();

  // Extract SHA256 from video metadata
  // You need to determine where SHA256 is stored in BunnyCDN metadata
  // Options:
  // 1. In video.title (if you upload with SHA256 as title)
  // 2. In video.guid (if guid IS the SHA256)
  // 3. In custom metadata tags

  // For now, assume guid IS the SHA256 (verify this!)
  return {
    sha256: video.guid,
    videoGuid: video.guid,
    title: video.title,
    length: video.length
  };
}
```

### 2. Add Required Environment Variables

**File**: `wrangler.toml`

Ensure these are configured:

```toml
[vars]
BUNNY_LIBRARY_ID = "515420"  # Your BunnyCDN library ID

# Secrets (set with: wrangler secret put <NAME>)
# BUNNY_API_KEY - Already configured
```

---

## Critical Question: SHA256 Mapping

**IMPORTANT**: You need to determine how BunnyCDN video GUIDs map to SHA256 hashes.

### Option 1: GUID IS the SHA256 (Simplest)
If you upload videos to BunnyCDN using SHA256 as the video ID, then:
```javascript
const sha256 = VideoGuid; // Direct mapping
```

### Option 2: SHA256 in Title
If you upload with SHA256 in the title:
```javascript
const sha256 = video.title; // Assuming title = SHA256
```

### Option 3: SHA256 in Custom Metadata
If you store SHA256 in metaTags:
```javascript
const sha256Tag = video.metaTags.find(tag =>
  tag.property === 'sha256' || tag.property === 'hash'
);
const sha256 = sha256Tag ? sha256Tag.value : null;
```

### Option 4: External Mapping Table
If BunnyCDN generates its own GUIDs, you need a KV mapping:
```javascript
// During upload: Store mapping
await env.MODERATION_KV.put(`bunny-guid:${bunnyGuid}`, sha256);

// During webhook: Retrieve mapping
const sha256 = await env.MODERATION_KV.get(`bunny-guid:${VideoGuid}`);
```

**Action Required**: Check your upload service code to determine which option you're using.

---

## Testing the Webhook

### 1. Deploy Updated Service

```bash
npm run deploy
```

### 2. Configure Webhook in BunnyCDN

1. Go to https://panel.bunny.net/stream
2. Select library 515420
3. Settings → Webhooks
4. Set URL: `https://divine-moderation-service.protestnet.workers.dev/webhook/bunnycdn`
5. Save

### 3. Test with New Upload

Upload a test video to BunnyCDN and watch the logs:

```bash
npx wrangler tail
```

Expected log sequence:
```
[WEBHOOK] BunnyCDN event: Library=515420, Video=xxx, Status=3
[WEBHOOK] Queued abc123... for moderation
[MODERATION] Processing batch of 1 videos
[MODERATION] ✅ COMPLETED abc123... in 650ms - SAFE
```

### 4. Verify in Dashboard

Visit: https://divine-moderation-service.protestnet.workers.dev/admin/dashboard

You should now see the video with moderation results.

---

## Backfilling Existing Videos

Since 157K videos were uploaded BEFORE webhook integration, use the backfill script:

```bash
# Test with 10 videos first (dry-run)
node scripts/backfill-moderation.mjs --max-total 10 --dry-run

# Process all videos (resume-able if interrupted)
node scripts/backfill-moderation.mjs
```

This will:
1. Fetch kind 34236 Nostr events from relay
2. Extract SHA256 from imeta tags
3. Queue each video for moderation
4. Update dashboard as they're processed

**Note**: The backfill script uses Nostr events, not BunnyCDN's API. This works if you publish Nostr events when uploading videos.

---

## Alternative: Pull-Based Integration (If Webhooks Don't Work)

If BunnyCDN webhooks are unavailable or unreliable, implement a scheduled worker:

```javascript
// In wrangler.toml
[triggers]
crons = ["*/5 * * * *"]  // Every 5 minutes

// In src/index.mjs
export default {
  async scheduled(event, env, ctx) {
    // List recent videos from BunnyCDN
    const response = await fetch(
      `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos?page=1&itemsPerPage=100&orderBy=date`,
      {
        headers: { 'AccessKey': env.BUNNY_API_KEY }
      }
    );

    const videos = await response.json();

    // Queue unmoderated videos
    for (const video of videos.items) {
      const sha256 = determineSha256(video); // Your mapping logic
      const existingResult = await env.MODERATION_KV.get(`moderation:${sha256}`);

      if (!existingResult) {
        await env.MODERATION_QUEUE.send({
          sha256,
          r2Key: `blobs/${sha256}`,
          uploadedAt: Date.now(),
          metadata: { bunnyVideoId: video.guid }
        });
      }
    }
  }
}
```

This approach polls BunnyCDN every 5 minutes for new videos.

---

## Summary

### Immediate Actions

1. **Determine SHA256 mapping**: Check how BunnyCDN video GUIDs map to SHA256 hashes
2. **Implement webhook endpoint**: Add `/webhook/bunnycdn` handler to `src/index.mjs`
3. **Configure webhook in BunnyCDN**: Point to your worker URL
4. **Deploy**: `npm run deploy`
5. **Test**: Upload new video and verify it appears in dashboard
6. **Backfill**: Run backfill script to process existing 157K videos

### Long-term

- Monitor webhook reliability
- Set up alerting if webhooks fail
- Consider webhook signature verification for security
- Implement retry logic if moderation queue fails

---

## Questions for You, Rabble

1. **How are you uploading videos to BunnyCDN?** (Direct API, Blossom server, other?)
2. **What is the mapping between BunnyCDN video GUIDs and SHA256 hashes?** (Are they the same? Stored separately?)
3. **Do you publish Nostr events when uploading videos?** (If yes, backfill script will work)
4. **Should we use webhooks or scheduled polling?** (Webhooks are faster, polling is more reliable)

Let me know and I can implement the webhook handler with the correct SHA256 mapping logic.
