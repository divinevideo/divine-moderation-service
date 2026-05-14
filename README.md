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
- **Late Transcript Reprocessing**: Tracks `202 Pending` transcript runs and reprocesses them on cron when transcripts are ready
- **Nostr Integration**: Publishes and ingests NIP-56 (kind 1984) report events for human moderation
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
  └─> Nostr Events (human review reports)
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
TRANSCRIPT_REPROCESS_BATCH_SIZE = "20" # Pending transcript rows to reprocess each cron tick
TRANSCRIPT_REPROCESS_MAX_AGE_DAYS = "7" # Abandon transcript pending rows older than this many days
LABEL_WRITE_DEDUPE_ENABLED = "true"    # Set "false" to bypass ClickHouse pre-insert dedupe checks

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

### Inbound relay reports

The Worker also ingests public NIP-56 reports from Nostr. On the five-minute cron,
the report poller reads kind `1984` events from `REPORT_POLLING_RELAY_URL`
(`wss://relay.divine.video` in production). By default, accepted inbound reports
must come from the diVine client: `RELAY_REPORTS_REQUIRE_DIVINE_CLIENT=true`
requires a `client` tag value of `divine`.

Accepted reports are resolved through their target `e` tag. The poller fetches
that target event, extracts the reported media SHA, and records the same
`user_reports` and `moderation_results` review rows used by authenticated
`POST /api/v1/report` submissions. Relay-originated reports are review-only:
they do not auto-escalate to `AGE_RESTRICTED` because relay client tags and
reporter pubkeys are public, self-asserted signals.

Operational KV keys:

- `report-poller:last-poll`: checkpoint timestamp for the next bounded relay query
- `report-poller:last-run`: summary of the most recent report polling cron run
- `report-poller:last-error`: most recent report polling cron error
- `report-poller:processed:<event_id>`: idempotence marker for a processed or terminally skipped report event

Checkpointing is conservative. The Worker advances `report-poller:last-poll`
only to safe terminal report timestamps. Retryable failures do not advance the
checkpoint. Saturated relay pages record a `resumeUntil` boundary in
`report-poller:last-run`, so the next cron can continue paging older reports
without pretending the whole window is safely checkpointed.

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

### Moderation label dedupe verification
- Canonical dedupe key:
  - `sha256`, `label`, `source_id`, `source_owner`, `source_type`, `transport`, `operation`, `review_state`, `action`
- Writer logs include per-call counters:
  - `[LABELS] attempted=... deduped=... inserted=...`
- Query duplicate keys for a specific content hash:

```sql
SELECT
  sha256,
  label,
  source_id,
  source_owner,
  source_type,
  transport,
  operation,
  review_state,
  action,
  count() AS rows_per_key
FROM moderation_labels
WHERE sha256 = '...'
GROUP BY
  sha256, label, source_id, source_owner, source_type, transport, operation, review_state, action
HAVING rows_per_key > 1;
```

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
