# Divine Video Moderation Service

Content moderation service for Divine 6-second videos using Sightengine API and Nostr-based human review workflow.

## Features

- **Automated Analysis**: Uses Sightengine to analyze video content for NSFW and violence
- **Queue-Based**: Non-blocking moderation via Cloudflare Queues
- **Three-Tier Classification**:
  - **SAFE**: Low risk content, approved automatically
  - **REVIEW**: Borderline content flagged for human review
  - **QUARANTINE**: High risk content, blocked immediately
- **AI-Generated Content Detection**: Identifies AI-generated videos to maintain authentic content policy
- **Nostr Integration**: Publishes NIP-56 (kind 1984) events for human moderation
- **Cost Optimized**: ~$0.003 per 6-second video
- **Full Test Coverage**: 40 tests covering all components

## Architecture

```
Video Upload (Main Service)
  ↓
Cloudflare Queue
  ↓
Moderation Worker
  ├─> Sightengine API (3-4 frames analyzed)
  ├─> Detection (NSFW, Violence, AI-Generated)
  ├─> Classification (SAFE/REVIEW/QUARANTINE)
  ├─> KV Storage (results + quarantine flags)
  └─> Nostr Events (relay3.openvine.co for human review)
```

## Quick Start

### Prerequisites

- Cloudflare Workers account
- [Sightengine API account](https://sightengine.com)
- Nostr private key for signing events
- Cloudflare Access service token for relay.divine.video
- Access to faro.nos.social relay

### Installation

```bash
# Install dependencies
npm install

# Create KV namespace
wrangler kv:namespace create MODERATION_KV

# Create queue
wrangler queues create video-moderation-queue

# Set secrets
wrangler secret put SERVICE_API_TOKEN         # Bearer token for moderation-api.divine.video
wrangler secret put CF_ACCESS_CLIENT_ID        # Cloudflare Access service token ID
wrangler secret put CF_ACCESS_CLIENT_SECRET    # Cloudflare Access service token secret
wrangler secret put SIGHTENGINE_API_USER
wrangler secret put SIGHTENGINE_API_SECRET
wrangler secret put NOSTR_PRIVATE_KEY
wrangler secret put FARO_RELAY_URL

# Update wrangler.toml with your KV namespace ID

# Deploy
wrangler deploy
```

Production hostnames:
- `https://moderation-api.divine.video` for public and service-facing API routes
- `https://moderation.admin.divine.video` for the admin dashboard behind Cloudflare Access

### Configuration

Edit `wrangler.toml`:

```toml
[vars]
CDN_DOMAIN = "cdn.divine.video"  # Your CDN domain

# Adjust thresholds as needed (0.0 - 1.0)
NSFW_THRESHOLD_HIGH = "0.8"           # Auto-quarantine threshold
NSFW_THRESHOLD_MEDIUM = "0.6"         # Human review threshold
VIOLENCE_THRESHOLD_HIGH = "0.8"
VIOLENCE_THRESHOLD_MEDIUM = "0.6"
AI_GENERATED_THRESHOLD_HIGH = "0.8"   # Auto-quarantine AI content
AI_GENERATED_THRESHOLD_MEDIUM = "0.6" # Flag AI content for review

[[kv_namespaces]]
binding = "MODERATION_KV"
id = "your_kv_namespace_id"  # From kv:namespace create command
```

## Integration

### Sending Videos for Moderation

From your main service, send messages to the queue after successful upload:

```javascript
await env.MODERATION_QUEUE.send({
  sha256: videoHash,
  r2Key: `videos/${videoHash}.mp4`,
  uploadedBy: userPubkey,  // optional (must be 64 hex chars if provided)
  uploadedAt: Date.now(),
  metadata: {  // optional
    fileSize: 128000,
    contentType: 'video/mp4',
    duration: 6
  }
});
```

### Checking Moderation Results

```javascript
// Check if video is quarantined
const quarantine = await env.MODERATION_KV.get(`quarantine:${sha256}`);

if (quarantine) {
  return new Response('Content unavailable', { status: 451 });
}

// Get full moderation result
const result = await env.MODERATION_KV.get(`moderation:${sha256}`);
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test src/moderation/pipeline.test.mjs

# Watch mode
npm run test:watch
```

### Local Development

```bash
# Start dev server
npm run dev

# Tail production logs
wrangler tail
```

## Testing Strategy

This project follows TDD (Test-Driven Development):

1. **Schema Validation** (`src/schemas/queue-message.test.mjs`)
   - Queue message structure validation
   - Input sanitization

2. **Sightengine Integration** (`src/moderation/sightengine.test.mjs`)
   - API calls and error handling
   - Score extraction from frames
   - Flagged frame detection

3. **Classification Logic** (`src/moderation/classifier.test.mjs`)
   - Threshold-based severity classification
   - Configurable thresholds
   - Primary concern identification

4. **Nostr Publishing** (`src/nostr/publisher.test.mjs`)
   - NIP-56 event creation
   - Event signing
   - Relay publishing

5. **Pipeline Integration** (`src/moderation/pipeline.test.mjs`)
   - End-to-end flow
   - Error handling
   - Result aggregation

## Project Structure

```
src/
├── index.mjs                    # Queue consumer entry point
├── schemas/
│   ├── queue-message.mjs        # Message validation
│   └── queue-message.test.mjs
├── moderation/
│   ├── sightengine.mjs          # Sightengine API client
│   ├── sightengine.test.mjs
│   ├── classifier.mjs           # Severity classification
│   ├── classifier.test.mjs
│   ├── pipeline.mjs             # Full moderation pipeline
│   └── pipeline.test.mjs
└── nostr/
    ├── publisher.mjs            # Nostr event publishing
    └── publisher.test.mjs
```

## Moderation Flow

### 1. Analysis
- Sightengine extracts 3-4 evenly-distributed frames from 6-second video
- Analyzes each frame for:
  - Nudity (raw, partial nudity)
  - Violence (physical violence, weapons, gore)
  - AI-generated content
- Returns scores (0.0 - 1.0) for each category per frame

### 2. Classification
- Calculate max score across all frames
- Compare against thresholds:
  - `< MEDIUM`: SAFE
  - `>= MEDIUM && < HIGH`: REVIEW
  - `>= HIGH`: QUARANTINE

### 3. Action
- **SAFE**: Store result, no further action
- **REVIEW**: Store result + publish Nostr event to faro.nos.social
- **QUARANTINE**: Store quarantine flag + publish Nostr event + block access

### 4. Storage
- `moderation:{sha256}`: Complete result with scores and metadata
- `quarantine:{sha256}`: Present only if video is quarantined
- `failed:{sha256}`: Logged on errors for debugging

## Nostr Events

Published as NIP-56 (kind 1984) reporting events:

```json
{
  "kind": 1984,
  "tags": [
    ["L", "MOD"],              // Namespace: Moderation
    ["l", "NS", "MOD"],        // Label: NS=NSFW, VI=Violence, AI=AI-Generated
    ["p", "video_sha256"],     // Reported content
    ["r", "video_cdn_url"]     // Reference URL
  ],
  "content": "{\"reason\":\"High nudity detected\",\"scores\":{\"nudity\":0.81,\"violence\":0.001,\"ai_generated\":0.01}}"
}
```

**Note**: Nostr kind 1984 events are currently blocked by relay3.openvine.co. Core moderation continues to function; human review notifications temporarily unavailable until relay configuration is updated.

## Cost Breakdown

For 1,000 videos per day (6 seconds each):

| Service | Cost |
|---------|------|
| Sightengine (3 frames/video) | $3.00/day |
| Cloudflare Workers | Free (included) |
| Cloudflare Queue | Free (< 1M ops) |
| Cloudflare KV | Free (< 10M reads) |
| **Total** | **~$3.00/day** |

## Monitoring

```bash
# View queue metrics
wrangler queues list

# Tail worker logs
wrangler tail divine-moderation-service

# Check failed moderations
wrangler kv:key list --namespace-id=YOUR_KV_ID --prefix="failed:"

# View specific result
wrangler kv:key get --namespace-id=YOUR_KV_ID "moderation:abc123..."
```

## Troubleshooting

### Videos stuck in pending
- Check queue has consumer: `wrangler queues list`
- Verify worker is deployed: `wrangler deployments list`
- Check logs: `wrangler tail`

### High false positive rate
- Adjust `NSFW_THRESHOLD_HIGH` and `VIOLENCE_THRESHOLD_HIGH` upward
- Review flagged videos in faro.nos.social
- Iterate on thresholds based on human review feedback

### Sightengine API errors
- Verify credentials are set correctly
- Check API quota and rate limits
- Ensure videos are publicly accessible at CDN URL

## Known Issues

- **Nostr Event Publishing**: Kind 1984 events currently blocked by relay3.openvine.co
  - Core moderation continues to work
  - Quarantine and KV storage unaffected
  - Human review notifications temporarily unavailable

## Future Enhancements

- [ ] Configure relay to accept kind 1984 events for human review workflow
- [ ] Add hash-based checking against known bad content databases
- [ ] Integrate CSAM detection (PhotoDNA/NCMEC) when approved
- [ ] Add audio analysis for harmful audio content
- [ ] Implement feedback loop from human review to improve thresholds
- [ ] Add metrics dashboard for moderation statistics
- [ ] Support for longer videos with adaptive frame sampling

## License

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

## Contributing

1. Follow TDD: write tests first
2. Run `npm test` before committing
3. Keep test coverage at 100%
4. Follow existing code style
