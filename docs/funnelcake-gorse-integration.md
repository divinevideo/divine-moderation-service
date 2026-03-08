# Divine Moderation Service — Integration Report for Funnelcake & Gorse Teams

**Date:** 2026-02-27
**Service:** `divine-moderation-service` (Cloudflare Worker)
**Base URL:** `https://moderation-api.divine.video`

---

## 1. API Endpoints

### 1.1 `GET /api/v1/classifier/{sha256}` — Raw Classifier Data

**Purpose:** Returns full Hive AI classifier data for a video — all 75+ moderation classes with per-frame confidence scores, scene classification (IAB categories), and VTT topic extraction.

**Authentication:** `Authorization: Bearer $SERVICE_API_TOKEN`. Requests forwarded through Cloudflare Access may also use `cf-access-jwt-assertion`. In dev, set `ALLOW_DEV_ACCESS=true`.

```bash
# Production
curl -H "Authorization: Bearer $SERVICE_API_TOKEN" \
     "https://moderation-api.divine.video/api/v1/classifier/abc123def456..."

# Development
curl "http://localhost:8787/api/v1/classifier/abc123def456..."
```

**Response (200):**

```json
{
  "sha256": "abc123def456...",
  "provider": "hiveai",
  "rawClassifierData": {
    "moderation": {
      "frames": [
        {
          "timestamp": 0,
          "source": "moderation",
          "scores": {
            "general_nsfw": 0.0012,
            "yes_female_nudity": 0.005,
            "yes_violence": 0.001,
            "yes_alcohol": 0.85
          }
        }
      ],
      "allClassMaxScores": {
        "general_nsfw": 0.015,
        "yes_alcohol": 0.92
      }
    },
    "aiDetection": {
      "frames": [...],
      "allClassMaxScores": {
        "ai_detection:ai_generated": 0.03,
        "ai_detection:deepfake": 0.002
      }
    },
    "allClassMaxScores": {
      "general_nsfw": 0.015,
      "yes_alcohol": 0.92,
      "ai_detection:ai_generated": 0.03
    },
    "extractedAt": "2026-02-27T10:30:00.000Z"
  },
  "sceneClassification": {
    "labels": [
      { "label": "sports", "namespace": "iab", "score": 0.95 },
      { "label": "beach_outdoor", "namespace": "setting", "score": 0.90 },
      { "label": "person", "namespace": "object", "score": 1.0 }
    ],
    "topCategories": [{ "category": "sports", "score": 0.95 }],
    "topSettings": [{ "setting": "beach_outdoor", "score": 0.90 }],
    "topObjects": [{ "object": "person", "score": 1.0 }]
  },
  "topicProfile": {
    "topics": [
      { "category": "sports", "confidence": 0.87, "keywords_matched": ["game", "score", "team"] },
      { "category": "fitness", "confidence": 0.45, "keywords_matched": ["workout"] }
    ],
    "primary_topic": "sports",
    "has_speech": true,
    "language_hint": "en",
    "word_count": 42
  },
  "moderatedAt": "2026-02-27T10:30:00.000Z"
}
```

### 1.2 `GET /api/v1/classifier/{sha256}/recommendations` — Pre-formatted for Gorse

**Purpose:** Returns classification data pre-formatted for recommendation systems.

```bash
curl -H "Authorization: Bearer $SERVICE_API_TOKEN" \
     "https://moderation-api.divine.video/api/v1/classifier/abc123.../recommendations"
```

**Response (200):**

```json
{
  "sha256": "abc123def456...",
  "gorse": {
    "labels": ["iab:sports", "setting:beach_outdoor", "object:person", "topic:sports", "topic:fitness"],
    "features": {
      "iab:sports": 0.95,
      "setting:beach_outdoor": 0.90,
      "object:person": 1.0,
      "topic:sports": 0.87,
      "topic:fitness": 0.45,
      "safety:nudity": 0.01,
      "safety:violence": 0.003
    }
  },
  "primary_topic": "sports",
  "has_speech": true,
  "is_safe": true,
  "action": "SAFE"
}
```

### 1.3 `GET /check-result/{sha256}` — Moderation Decision (Public)

**Purpose:** Returns the moderation action and safety scores. No auth required.

```bash
curl "https://moderation-api.divine.video/check-result/abc123def456..."
```

**Response (200):**

```json
{
  "sha256": "abc123def456...",
  "status": "safe",
  "moderated": true,
  "blocked": false,
  "age_restricted": false,
  "needs_review": false,
  "action": "SAFE",
  "scores": {
    "nudity": 0.012,
    "violence": 0.003,
    "gore": 0.0,
    "offensive": 0.001,
    "weapons": 0.0,
    "drugs": 0.0,
    "alcohol": 0.92,
    "ai_generated": 0.03,
    "deepfake": 0.002
  },
  "categories": ["alcohol"],
  "moderated_at": "2026-02-27T10:30:00.000Z"
}
```

---

## 2. Three Classification Layers

### Layer 1: Raw Hive Moderation Scores (FREE — already paying)

75+ safety-focused classes with per-frame confidence scores. Best for:
- Content filtering (NSFW, violence, weapons)
- Age-gating decisions
- AI-generated content detection

**Namespace:** No prefix (raw class names like `yes_female_nudity`, `yes_violence`)
**AI detection classes:** Prefixed with `ai_detection:` (e.g., `ai_detection:midjourney`)

### Layer 2: Hive Scene Classification (~$0.01/Vine)

IAB Content Taxonomy 3.0 categories. Best for:
- "What is this video about?" — topic categorization
- Category pages and feeds
- Content-based similarity

**Namespaces:**
| Prefix | Meaning | Examples |
|--------|---------|---------|
| `iab:` | IAB Content Taxonomy category | `iab:sports`, `iab:food_and_drink`, `iab:music` |
| `setting:` | Physical environment | `setting:beach_outdoor`, `setting:kitchen`, `setting:stadium` |
| `subject:` | Event type | `subject:cooking`, `subject:sports_event`, `subject:wedding` |
| `object:` | Detected object | `object:food`, `object:motor_vehicle`, `object:dog` |

**Available IAB Tier-1 categories:**
Automotive, Books & Literature, Business & Finance, Education, Attractions & Events, Personal Celebrations, Fine Art & Entertainment, Food & Drink, Health & Fitness, Home & Garden, Medical Health, Movies, Music & Audio, Politics, Pets, Real Estate, Religion & Spirituality, Science, Shopping, Sports, Style & Fashion, Personal Care, Technology & Computing, Travel, Video Gaming, Sensitive Topics

### Layer 3: VTT Transcript Topic Extraction (FREE — no API)

Keyword-based topic detection from video transcripts. Best for:
- Speech-heavy content (tutorials, vlogs, commentary)
- Complementing visual classification with audio signals
- Language detection

**Namespace:** `topic:` prefix (e.g., `topic:music`, `topic:comedy`, `topic:food`)

**Categories:** music, comedy, dance, sports, food, animals, fashion, art, education, gaming, nature, technology, travel, fitness, news

---

## 3. Recommended Gorse Item Schema

```json
{
  "ItemId": "sha256:a1b2c3d4e5f6...64chars",
  "IsHidden": false,
  "Categories": ["Sports", "Attractions & Events"],
  "Timestamp": "2026-02-27T10:30:00Z",
  "Labels": [
    "iab:sports",
    "iab:attractions_and_events",
    "setting:arena_or_stadium",
    "subject:sports_event",
    "object:sports_equipment",
    "topic:sports",
    "topic:fitness"
  ],
  "Comment": "Classified by divine-moderation-service"
}
```

### Mapping Guide

| Gorse field | Source | Notes |
|-------------|--------|-------|
| `ItemId` | `sha256` | Prefix with `sha256:` |
| `IsHidden` | `blocked` or `needs_review` from `/check-result` | Hide banned/unreviewed |
| `Categories` | `topCategories[].category` from scene classification | Map to display names |
| `Timestamp` | `moderatedAt` from classifier endpoint | RFC 3339 |
| `Labels` | `/recommendations` endpoint `gorse.labels` | Merged from all 3 layers |

### Feature Vector (for content-based similarity)

Use the `/recommendations` endpoint `gorse.features` map. All values 0.0-1.0:

```json
{
  "iab:sports": 0.97,
  "setting:arena_or_stadium": 0.94,
  "topic:sports": 0.93,
  "topic:fitness": 0.35,
  "safety:nudity": 0.01,
  "safety:violence": 0.15,
  "safety:ai_generated": 0.02
}
```

---

## 4. Safety Signal Mapping

| Action | Gorse `IsHidden` | Funnelcake behavior |
|--------|-------------------|---------------------|
| `SAFE` | `false` | Show everywhere |
| `REVIEW` | `true` until reviewed | Exclude from feeds |
| `AGE_RESTRICTED` | `false` + `label: "age_restricted"` | Gate behind age verification |
| `PERMANENT_BAN` | `true` permanently | Never show |

---

## 5. Edge Cases

### Scene classification not configured
No IAB categories returned. `sceneClassification` is `null`. Use VTT topic labels as sole content signal.

### No VTT transcript
`topicProfile` is `null`. Rely on scene classification for topic signals.

### Visual-only video (no speech)
`has_speech: false`, `topics: []`. Scene classification handles these well (dance, scenery, sports).

### Multiple topics with similar confidence
All topics above threshold are returned, sorted by confidence. Use `primary_topic` for dominant category.

### Video flagged as unsafe
Classification data is still stored. A human reviewer may change action to `SAFE`, at which point labels become active. Store but don't surface until safe.

---

## 6. Polling Strategy

### Current pipeline flow
```
Every 5 min (cron) → Relay poller → Cloudflare Queue → Moderate → Store in KV/D1
```

### Recommended approach
1. When you learn about a new video from the Nostr relay, check `/check-result/{sha256}`
2. If `moderated: false`, retry after 5-10 minutes
3. If `moderated: true`, fetch `/api/v1/classifier/{sha256}/recommendations`
4. Retry up to 3x with exponential backoff

### Future options
- **Batch endpoint**: `GET /api/v1/moderated-since?since=<timestamp>&limit=100` (not yet built)
- **Queue fan-out**: Second Cloudflare Queue for recommendation system consumption
- **Nostr subscription**: Subscribe to NIP-32 label events on `wss://relay.divine.video`

---

## 7. Re-moderation

When a human moderator changes a video's action:
- D1 row updated with new action + `reviewed_by` + `reviewed_at`
- Raw classifier data in KV is NOT updated (scores don't change)
- Gorse/funnelcake should periodically re-check items in `REVIEW` state
