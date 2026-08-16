# Video Analysis for Discovery & Recommendation

## Overview

While moderating videos, we can extract valuable metadata for discovery algorithms at minimal additional cost. This includes:

1. **Audio fingerprinting** - Detect videos using the same/similar audio (like TikTok's "original audio")
2. **Content labels** - Tag videos with objects, scenes, activities for search/discovery
3. **Scene detection** - Break videos into segments for clip-based features
4. **Visual similarity** - Find related/remix videos

---

## Feature 1: Audio Fingerprinting (Most Requested)

**Use Case**: "Find all videos using this audio" - enables TikTok-style audio reuse discovery

### How It Works
1. Extract audio fingerprint from each video during moderation
2. Store fingerprint in database with video metadata
3. When new video uploaded, check if fingerprint matches existing videos
4. Tag videos with:
   - `originalAudio: true` (first video with this audio)
   - `audioSourceSha256: abc123` (links to original)
   - `audioRemixCount: 42` (how many videos use this audio)

### Recommended Service: **AcoustID / Chromaprint**

**Why:**
- Open source, self-hosted (no per-video API costs!)
- Battle-tested (used by MusicBrainz, millions of tracks)
- Fast fingerprint generation (< 1 second per video)
- Robust to quality differences (compression, trimming)

**Implementation:**
```bash
# Install Chromaprint
npm install chromaprint-js

# Or use WASM version for Cloudflare Workers
```

```javascript
// Generate fingerprint
import { Chromaprint } from 'chromaprint-js';

async function generateAudioFingerprint(videoUrl) {
  // Extract audio from video (ffmpeg or similar)
  const audioBuffer = await extractAudio(videoUrl);

  // Generate fingerprint
  const fingerprint = await Chromaprint.fingerprint(audioBuffer);

  return {
    fingerprint: fingerprint.data,  // Raw fingerprint
    duration: fingerprint.duration
  };
}

// Store in database
await db.videos.update(sha256, {
  audioFingerprint: fingerprint.data,
  audioDuration: fingerprint.duration
});

// Find matching videos
const matches = await db.videos.findByAudioFingerprint(fingerprint);
if (matches.length > 0) {
  // This audio has been used before!
  const original = matches[0];  // First upload

  await db.videos.update(sha256, {
    originalAudio: false,
    audioSourceSha256: original.sha256,
    audioSourceNostrId: original.nostrEventId
  });

  // Update remix count on original
  await db.videos.increment(original.sha256, 'audioRemixCount');
}
```

**Alternative: Commercial API**
If self-hosting is too complex, use **Emysound API**:
- REST API for audio fingerprinting
- Handles video directly
- Returns match results
- Paid service (pricing TBD)

---

## Feature 2: Content Labels for Discovery

**Use Case**: Tag videos with what's in them - "beach", "sunset", "dog", "cooking" - enables content-based search and recommendation

### Recommended Service: **Google Video Intelligence API**

**Why:**
- Best-in-class label detection
- Three levels: frame, shot, segment
- Google Knowledge Graph integration
- Same $0.10/min pricing as moderation
- Can run in parallel with Hive moderation

**Labels Detected:**
- **Objects**: dog, cat, car, phone, food, etc.
- **Scenes**: beach, sunset, city, forest, etc.
- **Activities**: cooking, dancing, sports, gaming, etc.
- **Animals**: specific species (golden retriever, not just "dog")
- **Products**: brands, items
- **Locations**: landmarks, buildings

**Example Output:**
```json
{
  "labels": [
    {
      "description": "Beach",
      "confidence": 0.95,
      "segments": [
        {"start": 0, "end": 10}
      ]
    },
    {
      "description": "Sunset",
      "confidence": 0.89,
      "segments": [
        {"start": 5, "end": 15}
      ]
    },
    {
      "description": "Golden Retriever",
      "confidence": 0.87,
      "segments": [
        {"start": 0, "end": 6}
      ]
    }
  ]
}
```

**Discovery Use Cases:**
- Search: "Show me videos with dogs on the beach"
- Recommendations: "You watched beach videos, here are more"
- Trending: "What objects/scenes are trending this week?"
- Auto-tagging: No manual tagging needed

**Implementation:**
```javascript
// Run in parallel with moderation
const [moderationResult, labelsResult] = await Promise.all([
  moderateWithHive(videoUrl, metadata, env),
  detectLabelsWithGoogle(videoUrl, metadata, env)
]);

// Store labels for discovery
await db.videos.update(sha256, {
  contentLabels: labelsResult.labels.map(l => ({
    label: l.description,
    confidence: l.confidence,
    category: l.category  // e.g., 'object', 'scene', 'activity'
  }))
});

// Enable search
await searchIndex.index({
  sha256,
  labels: labelsResult.labels.map(l => l.description)
});
```

---

## Feature 3: Logo Detection (Hive)

**Use Case**: Detect brands/logos in videos - useful for sponsored content, brand safety, trending brands

**Service**: Hive Logo Detection API

**Capabilities:**
- 11,000+ logos recognized
- Location/size/clarity of each logo
- What object the logo is on (clothing, product, sign, etc.)

**Example Output:**
```json
{
  "logos": [
    {
      "class": "Nike",
      "score": 0.95,
      "location": {"x": 100, "y": 200, "width": 50, "height": 30},
      "on_object": "shirt",
      "time": 2.5
    }
  ]
}
```

**Discovery Use Cases:**
- Find videos featuring specific brands
- Brand trend analysis
- Sponsored content detection
- User interest inference (likes Nike → recommend athletic content)

---

## Feature 4: Scene/Shot Detection

**Use Case**: Break videos into scenes for clip-based features, auto-highlights, scene search

**Service**: Google Video Intelligence (included in label detection)

**How It Works:**
- Automatically detects scene changes (shot boundaries)
- Labels each scene independently
- Enables scene-level search and navigation

**Example:**
```json
{
  "shots": [
    {
      "start": 0,
      "end": 5.2,
      "labels": ["Beach", "Sunset"]
    },
    {
      "start": 5.2,
      "end": 10.8,
      "labels": ["Dog", "Playing"]
    }
  ]
}
```

**Discovery Use Cases:**
- "Jump to the beach scene"
- Auto-generate highlights (best scenes)
- Scene-based recommendations
- Clip extraction for sharing

---

## Recommended Multi-Provider Architecture

### Primary Setup: Hive (Moderation) + Google (Discovery)

```javascript
async function analyzeVideo(videoUrl, metadata, env) {
  // Run in parallel for efficiency
  const [moderation, discovery] = await Promise.all([
    // Hive: Moderation (nudity, violence, AI-gen)
    moderateWithHive(videoUrl, metadata, env),

    // Google: Labels, scenes, objects
    analyzeWithGoogle(videoUrl, metadata, env)
  ]);

  // Audio fingerprinting (async, can run after)
  const audioFingerprint = await generateAudioFingerprint(videoUrl);
  const audioMatches = await findAudioMatches(audioFingerprint);

  return {
    // Moderation
    classification: moderation.classification,
    scores: moderation.scores,

    // Discovery
    contentLabels: discovery.labels,
    scenes: discovery.shots,
    logos: discovery.logos,

    // Audio
    audioFingerprint: audioFingerprint.data,
    audioMatches: audioMatches.map(m => ({
      sha256: m.sha256,
      similarity: m.score
    })),
    originalAudio: audioMatches.length === 0
  };
}
```

### Cost Analysis

For 1000 hours of video per month:

| Service | Purpose | Cost |
|---------|---------|------|
| Hive | Moderation | ~$1,500-3,000/mo |
| Google Video Intelligence | Labels + Scenes | ~$6,000/mo |
| AcoustID (self-hosted) | Audio fingerprinting | ~$0/mo (compute only) |
| **Total** | | **~$7,500-9,000/mo** |

**Alternative (cheaper):** Only use Google when needed
- Moderate all videos with Hive
- Only run Google labels on videos that pass moderation
- Reduces Google costs by ~50-70% (filtering out rejected videos)

---

## Implementation Priorities

### Phase 1: Audio Fingerprinting (Highest Value)
- Unique feature for Divine (like Vine/TikTok)
- Self-hosted = low ongoing cost
- Enables viral audio discovery
- **Timeline: 1-2 weeks**

### Phase 2: Content Labels (Medium Value)
- Add Google Video Intelligence alongside Hive
- Store labels in database
- Build basic search/filter
- **Timeline: 2-3 weeks**

### Phase 3: Logo Detection (Lower Priority)
- Add if brand analysis is important
- Can be done later
- **Timeline: 1 week (after Phase 2)**

### Phase 4: Advanced Discovery
- Build recommendation algorithm using labels
- Trending content by labels/audio
- User interest profiles
- **Timeline: Ongoing**

---

## Database Schema Updates

```sql
-- Add discovery columns to videos table
ALTER TABLE videos ADD COLUMN audio_fingerprint TEXT;
ALTER TABLE videos ADD COLUMN audio_duration REAL;
ALTER TABLE videos ADD COLUMN original_audio BOOLEAN DEFAULT TRUE;
ALTER TABLE videos ADD COLUMN audio_source_sha256 TEXT;
ALTER TABLE videos ADD COLUMN audio_remix_count INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN content_labels JSONB;  -- Array of {label, confidence, category}
ALTER TABLE videos ADD COLUMN scenes JSONB;  -- Array of {start, end, labels[]}
ALTER TABLE videos ADD COLUMN detected_logos JSONB;  -- Array of {brand, confidence, location}

-- Indexes for discovery
CREATE INDEX idx_audio_fingerprint ON videos(audio_fingerprint);
CREATE INDEX idx_audio_source ON videos(audio_source_sha256);
CREATE INDEX idx_content_labels ON videos USING GIN(content_labels);

-- Audio matches table (for fuzzy matching)
CREATE TABLE audio_matches (
  video1_sha256 TEXT,
  video2_sha256 TEXT,
  similarity REAL,
  PRIMARY KEY (video1_sha256, video2_sha256)
);
```

---

## API Endpoints for Discovery

```javascript
// Find videos with same audio
GET /api/videos/{sha256}/audio-remixes
→ Returns videos using same audio

// Search by labels
GET /api/videos/search?labels=beach,sunset,dog
→ Returns videos matching labels

// Trending audio
GET /api/trending/audio?period=24h
→ Returns most-used audio tracks

// Trending content
GET /api/trending/labels?period=7d
→ Returns most popular content types

// Related videos (by labels)
GET /api/videos/{sha256}/related
→ Returns videos with similar labels
```

---

## Example: Audio Reuse Discovery Flow

```
User uploads video with audio:
  1. Extract audio fingerprint → "fp_abc123"
  2. Check database for matching fingerprints
  3. Match found! → Video X uploaded 2 days ago
  4. Tag new video:
     - originalAudio: false
     - audioSourceSha256: "video_x_sha256"
  5. Increment remix count on Video X
  6. Nostr event includes audio source tag:
     ["audio_source", "video_x_sha256", "wss://relay.openvine.co"]

User browses Video X:
  - Shows "42 videos use this audio"
  - Click to see all remixes
  - Auto-play remix feed

Discovery algorithm:
  - "Videos with popular audio" trending section
  - Recommend other videos with same audio
  - User interest: likes beach + sunset → find more beach/sunset videos
```

---

## Next Steps

1. **Decision**: Which features are highest priority?
   - Audio fingerprinting? (my recommendation - unique value)
   - Content labels?
   - Both?

2. **Implementation Order**:
   - Migrate to Hive for moderation first (fix accuracy)
   - Add audio fingerprinting (unique feature, low cost)
   - Add Google labels if budget allows (discovery++)

3. **Timeline**:
   - Week 1-2: Hive migration
   - Week 3-4: Audio fingerprinting MVP
   - Week 5+: Content labels (optional)

Want me to start implementing audio fingerprinting? It's the highest ROI feature IMO.
