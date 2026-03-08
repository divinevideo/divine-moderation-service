# Funnelcake Integration Briefing: divine-moderation-service Classification Data

**Date:** 2026-02-27
**Service:** `divine-moderation-service` (Cloudflare Worker, deployed)
**Base URL:** `https://moderation-api.divine.video`

---

## What Changed

The divine-moderation-service now produces three layers of classification data for every video it moderates. This data is designed to feed into funnelcake and gorse as item features for recommendations.

---

## API Endpoints You Need

### 1. `GET /api/v1/classifier/{sha256}/recommendations` (PRIMARY — use this)

Pre-formatted for gorse/funnelcake. Returns labels, features, description, and safety info in one call.

**Auth:** `Authorization: Bearer $SERVICE_API_TOKEN`. Requests forwarded through Cloudflare Access may also use `cf-access-jwt-assertion`. For local dev, set `ALLOW_DEV_ACCESS=true`.

**Response:**
```json
{
  "sha256": "a1b2c3d4e5f6...",
  "gorse": {
    "labels": [
      "topic:music",
      "topic:dance",
      "setting:indoor-studio",
      "object:microphone",
      "object:speakers",
      "activity:dancing",
      "activity:singing",
      "mood:energetic"
    ],
    "features": {
      "topic:music": 1.0,
      "topic:dance": 1.0,
      "setting:indoor-studio": 1.0,
      "object:microphone": 1.0,
      "activity:dancing": 1.0,
      "mood:energetic": 1.0,
      "topic:music": 0.87,
      "topic:comedy": 0.45
    }
  },
  "description": "A person dances energetically in a studio while music plays and they sing into a microphone.",
  "primary_topic": "music",
  "has_speech": true,
  "is_safe": true,
  "action": "SAFE"
}
```

### 2. `GET /check-result/{sha256}` (safety check — no auth required)

**Response:**
```json
{
  "sha256": "a1b2c3d4e5f6...",
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
    "alcohol": 0.0,
    "ai_generated": 0.03,
    "deepfake": 0.002
  },
  "moderated_at": "2026-02-27T10:30:00.000Z"
}
```

### 3. `GET /api/v1/classifier/{sha256}` (full raw data — if you need everything)

Returns all three classification layers with full detail. Large payload, use `/recommendations` instead unless you need per-frame data.

### 4. `GET /api/v1/decisions?since={ISO8601}&limit={n}&offset={n}` (batch discovery)

Paginated list of moderation decisions. Use `since` parameter to find newly-moderated videos.

**Response:**
```json
{
  "decisions": [
    {
      "sha256": "...",
      "action": "SAFE",
      "provider": "hiveai",
      "scores": { "nudity": 0.01, ... },
      "moderated_at": "2026-02-27T10:30:00.000Z"
    }
  ],
  "pagination": { "total": 1234, "limit": 50, "offset": 0, "has_more": true }
}
```

---

## Three Classification Layers

### Layer 1: Hive VLM Topic Classification (~$0.001/video)

Hive's Vision Language Model analyzes the video visually and returns structured JSON:

- **topics**: Content categories (music, comedy, dance, sports, food, animals, fashion, etc.)
- **setting**: Physical environment (beach, kitchen, studio, outdoors, etc.)
- **objects**: Notable objects visible (microphone, skateboard, dog, food, etc.)
- **activities**: What's happening (dancing, cooking, skateboarding, talking, etc.)
- **mood**: Overall tone (energetic, calm, funny, dramatic, etc.)
- **description**: Natural language 1-2 sentence description of the video (searchable!)

**Label namespace prefixes:** `topic:`, `setting:`, `object:`, `activity:`, `mood:`

### Layer 2: VTT Transcript Topic Extraction (FREE)

Keyword-based topic detection from video transcripts. 15 categories:
music, comedy, dance, sports, food, animals, fashion, art, education, gaming, nature, technology, travel, fitness, news

**Label namespace prefix:** `topic:` (with confidence 0.0-1.0, unlike VLM which is binary 1.0)

Note: VLM topics and VTT topics use the same `topic:` prefix. The `/recommendations` endpoint deduplicates them. When both detect the same topic, gorse gets a single label. The `features` map may have both — VLM at 1.0 and VTT at a confidence score. The higher value wins if keys collide.

### Layer 3: Raw Hive Moderation Scores (FREE — already paying)

75+ safety-focused class scores. Not topic labels, but useful as features for:
- Content filtering (NSFW, violence, weapons)
- Safety-based recommendation suppression
- Age-gating signals

---

## How to Map to Gorse Items

```json
{
  "ItemId": "sha256:a1b2c3d4e5f6...",
  "IsHidden": false,
  "Categories": ["music", "dance"],
  "Timestamp": "2026-02-27T10:30:00Z",
  "Labels": ["topic:music", "topic:dance", "setting:indoor-studio", "object:microphone", "activity:dancing", "mood:energetic"],
  "Comment": "A person dances energetically in a studio while music plays."
}
```

**Mapping from `/recommendations` response:**

| Gorse field | Source | Notes |
|---|---|---|
| `ItemId` | `sha256` | Prefix with `sha256:` |
| `IsHidden` | `!is_safe` or `action !== "SAFE"` | Hide unsafe/unreviewed content |
| `Categories` | `gorse.labels` filtered to `topic:*` | Strip prefix, use as primary categories |
| `Timestamp` | Fetch from `/check-result` → `moderated_at` | RFC 3339 |
| `Labels` | `gorse.labels` | Use directly, already namespaced |
| `Comment` | `description` | VLM-generated video description |

---

## Safety Action Handling

| Action | Meaning | Gorse `IsHidden` | Funnelcake behavior |
|---|---|---|---|
| `SAFE` | No concerns | `false` | Show everywhere |
| `REVIEW` | Needs human review | `true` until reviewed | Exclude from feeds |
| `AGE_RESTRICTED` | Adult-ish content | `false` + `label: "age-restricted"` | Gate behind age check |
| `PERMANENT_BAN` | Banned content | `true` permanently | Never show |
| `QUARANTINE` | Quarantined by moderator | `true` | Exclude from feeds |

---

## Discovery: How to Find Newly-Classified Videos

### Option A: Poll `/api/v1/decisions` (recommended now)

```
GET /api/v1/decisions?since=2026-02-27T00:00:00Z&limit=100
```

Returns paginated list of all moderation decisions since a timestamp. For each decision, call `/api/v1/classifier/{sha256}/recommendations` to get classification data.

### Option B: Poll per-video after Nostr relay event

When funnelcake sees a new kind 34236 video event on `wss://relay.divine.video`:
1. Extract sha256 from `imeta` tag
2. Call `/check-result/{sha256}` — if `moderated: false`, wait 5-10 min and retry
3. Once `moderated: true`, call `/api/v1/classifier/{sha256}/recommendations`

### Pipeline timing

- Cron runs every 5 minutes to poll relay for new videos
- Queue processes up to 10 videos per batch
- Moderation + VLM classification run in parallel (~5-15 seconds per video)
- VTT topic extraction is instant (local computation)
- Results available in KV immediately after processing

---

## Edge Cases to Handle

1. **No VLM classification** — If `HIVE_VLM_API_KEY` is not set or VLM fails, `sceneClassification` is `null` in the classifier response. The `/recommendations` endpoint still works — it just has fewer labels (only VTT topics + moderation scores).

2. **No VTT transcript** — If no `.vtt` file exists for a video, `topicProfile` is `null`. VLM classification still works (it's visual). `has_speech` will be `false`.

3. **Video not yet moderated** — `/check-result/{sha256}` returns `{ moderated: false }`. `/api/v1/classifier/{sha256}` returns 404. Retry after 5-10 minutes.

4. **Re-moderation** — When a human moderator changes a decision via the admin dashboard, the `action` field in D1 changes but classifier data in KV stays the same (scores don't change). Re-poll `/check-result` for updated action.

5. **VLM returns no topics** — Some videos (black screen, very short, abstract art) may return empty topics. The `description` field should still have something useful.

---

## Authentication

All `/api/v1/*` endpoints (except `/check-result`) require a bearer token or a Cloudflare Access JWT.

For service-to-service auth, use the worker's bearer token:
```bash
curl -H "Authorization: Bearer $SERVICE_API_TOKEN" \
     "https://moderation-api.divine.video/api/v1/classifier/{sha256}/recommendations"
```

For local development with `ALLOW_DEV_ACCESS=true`:
```bash
curl "http://localhost:8787/api/v1/classifier/{sha256}/recommendations"
```

---

## The `description` Field

The VLM generates a 1-2 sentence natural language description of each video. This is valuable for:
- **Search** — full-text search over video descriptions
- **Human review** — admin dashboard can show descriptions
- **Gorse `Comment`** — store as item comment for debugging/transparency
- **Content understanding** — richer than tags alone

Example descriptions:
- "A person dances energetically in a studio while music plays."
- "A cat chases a laser pointer across a living room floor."
- "Someone demonstrates how to make a latte with foam art in a coffee shop kitchen."

---

## Cost Summary

| Layer | Per Video | Monthly (10K videos) |
|---|---|---|
| Hive moderation (existing) | ~$0.018 | ~$180 |
| Hive VLM classification | ~$0.001 | ~$10 |
| VTT topic extraction | $0 | $0 |
| **Total for classification** | **~$0.001** | **~$10** |
