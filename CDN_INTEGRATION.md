# CDN Integration Guide

## Overview

This document explains how the main CDN/upload service integrates with the Divine moderation service. The moderation system operates asynchronously via Cloudflare Queues, allowing uploads to complete immediately while moderation happens in the background.

## Architecture

```
┌─────────────────┐
│   CDN Service   │
│  (Your Worker)  │
└────────┬────────┘
         │
         │ 1. Upload video to Blossom
         │ 2. Return success to client
         │ 3. Send to moderation queue
         │
         ▼
┌─────────────────┐
│ Cloudflare Queue│
│ (non-blocking)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Moderation    │
│     Worker      │
│ (This Service)  │
└────────┬────────┘
         │
         │ Writes results to KV:
         │ • moderation:{sha256}
         │ • quarantine:{sha256} (if harmful)
         │
         ▼
┌─────────────────┐
│ MODERATION_KV   │
│ (Shared Access) │
└─────────────────┘
         ▲
         │
         │ CDN reads before serving
         │
┌─────────────────┐
│  CDN Service    │
│  GET endpoint   │
└─────────────────┘
```

## Integration Points

### 1. After Successful Upload (CDN → Moderation)

When your CDN service successfully uploads a video to Blossom, send it to the moderation queue:

```javascript
// In your CDN upload handler (e.g., handlers/blossom.mjs or handlers/upload.mjs)
async function handleVideoUpload(request, env) {
  // ... your upload logic ...

  // After successful Blossom upload
  const sha256 = videoHash; // Your computed SHA256

  // Send to moderation queue (non-blocking)
  // Use waitUntil to ensure it sends but don't wait for completion
  env.ctx.waitUntil(
    env.MODERATION_QUEUE.send({
      sha256: sha256,
      r2Key: r2Key,
      uploadedBy: userPubkey || undefined, // Optional: nostr pubkey (64 hex chars)
      uploadedAt: Date.now(),
      metadata: {  // Optional but recommended
        fileSize: videoBlob.size,
        contentType: 'video/mp4',
        duration: 6  // or detected duration
      }
    })
  );

  // Return immediately to client - don't wait for moderation
  return new Response(JSON.stringify({
    sha256: sha256,
    url: `https://cdn.divine.video/${sha256}.mp4`,
    message: 'Upload successful'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

#### Queue Message Schema

The moderation service expects messages with this structure:

```typescript
{
  sha256: string,          // Required: 64 hex characters
  uploadedBy?: string,     // Optional: Nostr pubkey (64 hex chars)
  uploadedAt: number,      // Required: Unix timestamp in milliseconds
  metadata?: {             // Optional metadata
    fileSize?: number,     // Bytes
    contentType?: string,  // MIME type
    duration?: number      // Seconds
  }
}
```

**Important Notes:**
- `uploadedBy` is optional but MUST be exactly 64 hexadecimal characters if provided (Nostr pubkey format)
- `sha256` MUST be exactly 64 hexadecimal characters
- The moderation worker will construct the CDN URL as: `https://${CDN_DOMAIN}/${sha256}.mp4`

### 2. Before Serving Content (CDN → KV Check)

Before serving a video, check if it's been quarantined:

```javascript
// In your CDN GET handler
async function handleVideoRequest(request, env) {
  const url = new URL(request.url);
  const sha256 = url.pathname.split('/').pop().replace('.mp4', '');

  // CRITICAL: Check quarantine status before serving
  const quarantine = await env.MODERATION_KV.get(`quarantine:${sha256}`);

  if (quarantine) {
    // Content has been quarantined - do NOT serve it
    return new Response('Content unavailable due to moderation', {
      status: 451,  // HTTP 451: Unavailable For Legal Reasons
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }

  // Optional: Check if moderation is complete
  const moderationResult = await env.MODERATION_KV.get(`moderation:${sha256}`);

  if (moderationResult) {
    const result = JSON.parse(moderationResult);
    // You can log or track moderation status: result.action, result.severity
    // Actions: 'SAFE', 'REVIEW', 'QUARANTINE'
  }

  // Serve the video from Blossom
  const blossomUrl = `https://${env.CDN_DOMAIN}/${sha256}`;
  const response = await fetch(blossomUrl);

  if (!response.ok) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(response.body, {
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}
```

## KV Key Patterns

The moderation service writes to these KV keys (all in `MODERATION_KV` namespace):

### 1. `moderation:{sha256}`

Complete moderation result for every analyzed video.

**Structure:**
```json
{
  "action": "SAFE|REVIEW|QUARANTINE",
  "severity": "low|medium|high",
  "scores": {
    "nudity": 0.05,
    "violence": 0.01,
    "ai_generated": 0.03
  },
  "reason": "Low risk content, approved automatically",
  "primaryConcern": "nudity|violence|ai_generated|none",
  "flaggedFrames": [
    {
      "frameIndex": 2,
      "timestamp": 2.5,
      "scores": { "nudity": 0.05, "violence": 0.01, "ai_generated": 0.03 }
    }
  ],
  "sha256": "abc123...",
  "uploadedBy": "user_pubkey...",
  "uploadedAt": 1704067200000,
  "cdnUrl": "https://media.divine.video/abc123.mp4",
  "processedAt": 1704067205000,
  "processingTimeMs": 5432
}
```

**TTL:** 90 days

**Use Cases:**
- Audit trail
- Analytics on moderation decisions
- Debugging false positives/negatives

### 2. `quarantine:{sha256}`

Present ONLY if content is quarantined (action = 'QUARANTINE').

**Structure:**
```json
{
  "reason": "High nudity detected in multiple frames",
  "scores": {
    "nudity": 0.92,
    "violence": 0.01,
    "ai_generated": 0.05
  },
  "timestamp": 1704067205000,
  "severity": "high"
}
```

**TTL:** Indefinite (until manually removed)

**Use Cases:**
- **Primary check for serving**: If this key exists, DO NOT serve the content
- Return HTTP 451 (Unavailable For Legal Reasons)

### 3. `failed:{sha256}`

Present if moderation pipeline failed (after 3 retry attempts).

**Structure:**
```json
{
  "error": "Sightengine API timeout",
  "stack": "Error: timeout...",
  "message": { /* original queue message */ },
  "attempts": 3,
  "timestamp": 1704067205000
}
```

**Use Cases:**
- Operational monitoring
- Retry failed moderations manually
- Debug integration issues

## Configuration

### Required Bindings in Your CDN Worker

Add these to your CDN worker's `wrangler.toml`:

```toml
# Queue producer (to send videos for moderation)
[[queues.producers]]
binding = "MODERATION_QUEUE"
queue = "video-moderation-queue"

# KV namespace (to check moderation results)
[[kv_namespaces]]
binding = "MODERATION_KV"
id = "eee0689974834390acd39d543002cac3"  # Use the same ID as moderation service

# Variables
[vars]
CDN_DOMAIN = "media.divine.video"  # Your Blossom server domain
```

### Queue Configuration

The queue is configured in the moderation service but you need producer access:

```bash
# Already created by moderation service, just verify it exists
wrangler queues list

# Should show:
# video-moderation-queue
#   - consumers: divine-moderation-service
#   - max_batch_size: 10
#   - max_batch_timeout: 30s
```

## Complete Example: CDN Worker with Moderation

```javascript
// src/index.mjs - Your CDN worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Upload endpoint
    if (request.method === 'POST' && url.pathname === '/upload') {
      return handleUpload(request, env, ctx);
    }

    // Serve endpoint
    if (request.method === 'GET' && url.pathname.endsWith('.mp4')) {
      return handleServe(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleUpload(request, env, ctx) {
  const formData = await request.formData();
  const videoFile = formData.get('video');

  if (!videoFile) {
    return new Response('No video file provided', { status: 400 });
  }

  // Compute SHA256
  const buffer = await videoFile.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Upload to Blossom server (handled by divine-blossom)

  // Queue for moderation (non-blocking)
  ctx.waitUntil(
    env.MODERATION_QUEUE.send({
      sha256,
      uploadedAt: Date.now(),
      metadata: {
        fileSize: buffer.byteLength,
        contentType: 'video/mp4'
      }
    })
  );

  return new Response(JSON.stringify({
    sha256,
    url: `https://${env.CDN_DOMAIN}/${sha256}.mp4`,
    status: 'uploaded'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleServe(request, env) {
  const url = new URL(request.url);
  const sha256 = url.pathname.replace('/', '').replace('.mp4', '');

  // Check quarantine
  const quarantine = await env.MODERATION_KV.get(`quarantine:${sha256}`);
  if (quarantine) {
    return new Response('Content unavailable', {
      status: 451,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Serve from Blossom
  const blossomUrl = `https://${env.CDN_DOMAIN}/${sha256}`;
  const blossomResp = await fetch(blossomUrl);

  if (!blossomResp.ok) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(blossomResp.body, {
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}
```

## Moderation Timeline

Understanding when content becomes available and when moderation completes:

1. **T+0s**: User uploads video
2. **T+0s**: Blossom stores video, returns success to user
3. **T+0s**: Message sent to moderation queue
4. **T+1-10s**: Moderation worker picks up message from queue
5. **T+5-15s**: Sightengine analyzes video (3-4 frames)
6. **T+5-15s**: Results classified and stored in KV
7. **T+5-15s**: If QUARANTINE, `quarantine:{sha256}` key written

**Important:** Content is accessible immediately after upload. Quarantine happens within ~5-15 seconds if harmful content is detected.

## Monitoring Integration Health

### Check Queue Status

```bash
# View queue metrics
wrangler queues list

# Check queue depth (should stay near 0 under normal operation)
```

### Check Moderation Results

```bash
# Check if a specific video has been moderated
wrangler kv:key get --namespace-id=eee0689974834390acd39d543002cac3 "moderation:abc123..."

# List quarantined content
wrangler kv:key list --namespace-id=eee0689974834390acd39d543002cac3 --prefix="quarantine:"

# Check failed moderations
wrangler kv:key list --namespace-id=eee0689974834390acd39d543002cac3 --prefix="failed:"
```

### CDN-Side Logging

Add logging to track moderation integration:

```javascript
async function handleServe(request, env) {
  const sha256 = extractSha256(request);

  const quarantine = await env.MODERATION_KV.get(`quarantine:${sha256}`);
  if (quarantine) {
    console.log(`[CDN] Blocked quarantined content: ${sha256}`);
    return new Response('Content unavailable', { status: 451 });
  }

  const moderation = await env.MODERATION_KV.get(`moderation:${sha256}`);
  if (!moderation) {
    console.log(`[CDN] Serving content pending moderation: ${sha256}`);
  } else {
    const result = JSON.parse(moderation);
    console.log(`[CDN] Serving moderated content: ${sha256} (${result.action})`);
  }

  // ... serve content ...
}
```

## Error Handling

### What if the queue fails?

The moderation system is fail-safe:
- If queue send fails, upload still succeeds
- Content remains accessible (better than blocking legitimate uploads)
- Failed sends are logged for retry

```javascript
ctx.waitUntil(
  env.MODERATION_QUEUE.send(message)
    .catch(err => {
      console.error('[CDN] Failed to queue for moderation:', err);
      // Could implement retry logic or alerting here
    })
);
```

### What if moderation never completes?

- After 3 retry attempts, moderation worker writes to `failed:{sha256}`
- Content remains accessible (fail-safe approach)
- Monitor `failed:*` keys and retry manually or alert operations

### What if KV read fails during serving?

```javascript
async function handleServe(request, env) {
  const sha256 = extractSha256(request);

  let quarantine = null;
  try {
    quarantine = await env.MODERATION_KV.get(`quarantine:${sha256}`);
  } catch (err) {
    console.error('[CDN] KV read failed, serving content (fail-open):', err);
    // Fail open: serve content if we can't check moderation
    // Alternative: Fail closed - return 503 if moderation unavailable
  }

  if (quarantine) {
    return new Response('Content unavailable', { status: 451 });
  }

  // ... serve content ...
}
```

## Testing Integration

### 1. Test Upload Flow

```bash
# Upload a video
curl -X POST https://your-cdn.workers.dev/upload \
  -F "video=@test.mp4"

# Response:
# {"sha256":"abc123...","url":"https://cdn.divine.video/abc123.mp4","status":"uploaded"}
```

### 2. Verify Queue Message

```bash
# Check moderation service logs
wrangler tail divine-moderation-service

# Should see:
# [MODERATION] Processing batch of 1 videos
# [MODERATION] ✅ COMPLETED abc123... in 5432ms - SAFE
```

### 3. Check KV Result

```bash
# Check moderation result
curl https://moderation-api.divine.video/check-result/abc123...

# Or use wrangler
wrangler kv:key get --namespace-id=eee0... "moderation:abc123..."
```

### 4. Test Quarantine

```bash
# Get a quarantined SHA256 from test data
curl https://your-cdn.workers.dev/abc123quarantined.mp4

# Should return:
# HTTP 451 Unavailable For Legal Reasons
# Content unavailable
```

## Frequently Asked Questions

### Q: Should I wait for moderation to complete before returning success to the user?

**No.** The system is designed to be non-blocking. Return success immediately after Blossom upload. Moderation happens in the background within 5-15 seconds.

### Q: What if a user tries to view content before moderation completes?

Content is served. The system is fail-safe: better to show content pending review than to block legitimate content. Harmful content is quarantined within seconds.

### Q: Do I need to delete quarantined content from Blossom?

No. The moderation service only sets the quarantine flag in KV. Blossom checks this flag and blocks serving. The webhook notification tells Blossom to enforce the block.

### Q: Can I customize moderation thresholds?

Yes, but they're configured in the moderation service's `wrangler.toml`, not in the CDN:
- `NSFW_THRESHOLD_HIGH` / `NSFW_THRESHOLD_MEDIUM`
- `VIOLENCE_THRESHOLD_HIGH` / `VIOLENCE_THRESHOLD_MEDIUM`
- `AI_GENERATED_THRESHOLD_HIGH` / `AI_GENERATED_THRESHOLD_MEDIUM`

### Q: What's the cost impact?

Minimal:
- Queue operations: Free (< 1M ops/month)
- KV reads: Free (< 10M reads/month)
- KV writes: $0.50 per million operations
- Sightengine: ~$0.003 per 6-second video

### Q: Can I use this with multiple CDN workers?

Yes. Multiple workers can share the same `MODERATION_QUEUE` (producers) and `MODERATION_KV` (readers). Only one worker should be the queue consumer (the moderation service).

## Summary

**Upload Flow:**
1. Upload video to Blossom server
2. Send to `MODERATION_QUEUE` (non-blocking)
3. Return success immediately

**Serve Flow:**
1. Blossom checks moderation status
2. If blocked → return 404
3. If allowed → serve video

**Required Bindings:**
- `MODERATION_QUEUE` (producer)
- `MODERATION_KV` (reader)

That's it! The moderation service handles everything else asynchronously.
