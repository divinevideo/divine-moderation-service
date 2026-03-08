# Divine Moderation Service — Trust & Safety Report

**Date:** 2026-02-27
**Service:** `divine-moderation-service`
**Dashboard:** `https://moderation.admin.divine.video`
**Status:** Deployed and live

---

## What's New

The moderation service has been upgraded with three new classification capabilities that significantly expand what we know about each video. These are **additive** — the existing safety moderation pipeline is unchanged and continues to work as before.

### New: Full Raw Hive AI Scores (all 75+ classes)

Previously, the moderation pipeline mapped ~40 Hive AI classes down to our 18 safety categories and discarded the rest. Now we store **every class and score** that Hive returns, per-frame with timestamps.

**What this means for T&S:**
- You can now see granular sub-classifications instead of just the top-level category
- Per-frame temporal data shows exactly *when* in a video concerning content appears (e.g., "violence spikes at frame 3.5s then drops")
- All "negative" class scores are preserved (e.g., `no_nudity: 0.98` alongside `yes_female_nudity: 0.02`) — useful for understanding classifier confidence
- AI detection source attribution is preserved (individual scores for DALL-E, Midjourney, Stable Diffusion, etc.)

### New: Hive VLM Video Descriptions

Each video now gets analyzed by Hive's Vision Language Model, which produces:
- **Natural language description** — "A person dances energetically in a studio while music plays"
- **Topic tags** — music, comedy, sports, food, etc.
- **Setting** — indoor studio, beach, kitchen, etc.
- **Objects detected** — microphone, skateboard, dog, etc.
- **Activities** — dancing, cooking, skateboarding, etc.
- **Mood** — energetic, calm, funny, dramatic, etc.

**What this means for T&S:**
- Human moderators get a text description before watching the video — faster triage
- The `description` field can surface context that pure safety classifiers miss
- Topics and activities provide better context for borderline cases (e.g., a violence score of 0.65 in a "sports" context vs a "domestic" context)

### New: VTT Transcript Topic Analysis

On top of the existing safety text analysis (hate speech, threats, harassment, grooming), we now extract content topics from video transcripts.

**What this means for T&S:**
- Speech detection flag (`has_speech: true/false`) helps identify which videos have spoken content vs visual-only
- Language detection helps route content to appropriate reviewers
- Topic categories provide additional context for moderation decisions

---

## Complete Moderation Pipeline

### How Videos Enter the System

```
wss://relay.divine.video (polled every 5 min)
         │
         ▼
  Extract SHA256 from kind 34236 video events
         │
         ▼
  Cloudflare Queue (batch: 10, timeout: 30s, 3 retries)
         │
         ▼
  ┌──────────────────────────────────────┐
  │  Run in parallel:                    │
  │  • Hive AI V2 Moderation             │
  │  • Hive AI V2 AI/Deepfake Detection  │
  │  • Hive VLM Topic Classification     │
  │  • VTT Transcript Fetch + Analysis   │
  └──────────────────────────────────────┘
         │
         ▼
  Classify → Store in KV + D1 → Publish NIP-56 report
```

### Safety Categories & Thresholds

#### Visual Analysis (Hive AI)

| Category | PERMANENT_BAN | AGE_RESTRICTED | QUARANTINE | REVIEW |
|---|---|---|---|---|
| **Self-harm** | >= 0.7 | — | — | >= 0.5 |
| **Offensive/Hate imagery** | >= 0.8 | — | — | >= 0.6 |
| **Gore** | >= 0.95 | >= 0.8 | >= 0.7 | >= 0.6 |
| **AI-generated** | >= 0.8 | — | — | >= 0.6 |
| **Deepfake** | >= 0.95 | — | >= 0.8 | — |
| **Nudity/NSFW** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Violence** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Weapons** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Drugs** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Alcohol** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Tobacco** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Gambling** | — | >= 0.8 | >= 0.7 | >= 0.6 |
| **Destruction** | — | >= 0.8 | >= 0.7 | >= 0.6 |

#### Transcript Analysis (VTT Text)

| Category | PERMANENT_BAN | REVIEW | What It Detects |
|---|---|---|---|
| **Hate speech** | >= 0.7 | — | Racial slurs, anti-LGBTQ slurs, white supremacy phrases, religious hate |
| **Threats** | >= 0.7 | — | Kill/murder threats, bomb threats, school shooting references, swatting |
| **Harassment** | — | — | "Kill yourself", gendered slurs, "go die" (flagged but no automatic action) |
| **Grooming** | — | — | Secrecy demands, soliciting images, inappropriate age comments (flagged) |
| **Self-harm** | — | — | Cutting references, suicidal ideation, overdose (flagged) |
| **Profanity** | — | >= 0.5 | Common profanity (informational, triggers review only) |

### Action Priority (highest wins)

1. **PERMANENT_BAN** — Content removed, never shown. Triggers: self-harm, offensive/hate, extreme gore, AI-generated, deepfake, transcript hate speech/threats.
2. **AGE_RESTRICTED** — Gated behind age verification. Triggers: nudity, violence, gore, weapons, drugs, alcohol, tobacco, gambling, destruction at high confidence.
3. **QUARANTINE** — Hidden from regular users, visible to moderators. Triggers: any category 0.7-0.8 (medium-high confidence but below ban/restrict threshold).
4. **REVIEW** — Flagged for human review. Triggers: any category 0.6-0.7, transcript profanity.
5. **SAFE** — No concerns detected.

---

## Repeat Offender Tracking

Per-uploader (Nostr pubkey) statistics are tracked in D1:

| Metric | Tracked |
|---|---|
| Total videos scanned | Yes |
| Flagged count (non-safe) | Yes |
| Banned count | Yes |
| Restricted count | Yes |
| Review count | Yes |
| Last flagged timestamp | Yes |

### Risk Level Escalation

| Risk Level | Trigger | Implication |
|---|---|---|
| **high** | Any PERMANENT_BAN, or 5+ AGE_RESTRICTED | Uploader has pattern of harmful content |
| **elevated** | 3+ AGE_RESTRICTED | Uploader showing concerning pattern |
| **normal** | Default | No pattern detected |

Risk level is recomputed after every moderation event for the uploader.

---

## Nostr Protocol Integration

### NIP-56 Reports (kind 1984) — Automated

Published automatically for every non-SAFE moderation result to:
- `faro.nos.social` (Faro moderation relay)
- `relay.divine.video` (content relay, to stop serving flagged content)

Report labels:
- `NS` — Not Safe (nudity/NSFW primary concern)
- `VI` — Violence (violence/gore/weapons primary concern)
- `AI` — AI-generated (ai_generated/deepfake primary concern)

Includes: MOD namespace label, scores JSON, reason text, CDN URL reference.

### NIP-32 Labels (kind 1985) — Human-Verified

Published when a human moderator confirms or rejects an AI classification:
- **Confirmed**: Label is the category name (e.g., `nudity`, `violence`, `ai-generated`)
- **Rejected**: Label is `not-{category}` (e.g., `not-nudity`) — explicitly marking false positives
- Includes confidence score, `verified: true`, `source: human-moderator`

This creates an auditable record of human moderation decisions on the Nostr protocol.

---

## Admin Dashboard

**URL:** `https://moderation.admin.divine.video/admin`
**Auth:** Cloudflare Zero Trust (organization members only)

### Dashboard Stats
- **Needs Triage** — unmoderated videos awaiting review
- **AI Flagged** — videos flagged by AI classifiers
- **Total Moderated / Safe / Review / Quarantined** — counts by action

### Per-Video View
- Embedded video player (bypasses quarantine for moderator viewing)
- Score bars for all detected categories with confidence percentages
- Subcategory drill-down (e.g., within nudity: female_nudity, male_nudity, swimwear, etc.)
- AI detection alert showing confidence %, detected source (DALL-E, Midjourney, etc.), frames analyzed
- **NEW:** VLM description of the video (natural language summary)
- Nostr metadata: author pubkey, title/content, platform, engagement metrics
- Moderation timeline: AI classification event → human override event

### Moderator Actions
- **Approve** (mark SAFE)
- **Age-Restrict** (AGE_RESTRICTED)
- **Ban** (PERMANENT_BAN)
- **Edit Scores** (manual score adjustment)
- **Per-category verification**: Confirm (AI was correct) or Reject (false positive)
  - Confirmed: publishes NIP-32 label event
  - Rejected: publishes NIP-32 `not-{category}` label event

### Triage Queue
- Videos that haven't been moderated yet
- Two actions: "Send to Hive AI" (queue for automated analysis) or "Safe" (manual clearance)

### Swipe Review
- Mobile-friendly review interface at `/admin/review`
- Swipe-based approve/reject workflow for high-volume moderation

---

## Data Storage & Retention

| Store | Data | Retention |
|---|---|---|
| **KV** `moderation:{sha256}` | Full moderation result (action, scores, flags, provider, timestamps, overrides) | 90 days |
| **KV** `classifier:{sha256}` | Raw classifier data (all 75+ Hive classes per frame, VLM classification, VTT topics) | 180 days |
| **KV** `quarantine:{sha256}` | Quarantine flag with reason and moderator info | 90 days |
| **D1** `moderation_results` | Action, provider, scores JSON, categories, raw response, timestamps, reviewer info | Permanent |
| **D1** `uploader_stats` | Per-pubkey counters and risk level | Permanent |
| **D1** `user_reports` | User-submitted reports with auto-escalation | Permanent |
| **Blossom** `media.divine.video` | Source video files | Permanent |

---

## New API Endpoints for Classification Data

### `GET /api/v1/classifier/{sha256}` (authenticated)
Full raw classifier data from all three layers. Useful for deep investigation of specific videos.

### `GET /api/v1/classifier/{sha256}/recommendations` (authenticated)
Pre-formatted classification data for recommendation systems. Includes:
- Topic labels and confidence scores
- VLM-generated video description
- Safety action and scores
- Speech detection and language hint

### `GET /api/v1/decisions?since={ISO}&limit={n}` (authenticated)
Paginated list of moderation decisions. Useful for bulk audit/export.

### `GET /check-result/{sha256}` (public)
Quick safety check — returns action, scores, and moderation status from `https://moderation-api.divine.video/check-result/{sha256}`.

---

## What Hive AI Detects (75+ Classes)

The full raw Hive response includes far more granularity than our 18 top-level categories. Examples of sub-classes now preserved:

**Nudity sub-classes:** `yes_female_nudity`, `yes_male_nudity`, `yes_sexual_activity`, `yes_female_swimwear`, `yes_male_swimwear`, `yes_underwear`, `yes_cleavage`, `animated_explicit_sexual_content`, `general_nsfw`, `general_suggestive`

**Violence sub-classes:** `yes_violence`, `yes_blood_shed`, `yes_corpse`, `yes_emaciated_body`, `yes_self_harm`, `physical_fight`, `animal_abuse`

**Hate symbol detection:** Nazi symbols, ISIS imagery, KKK imagery, Confederate flags, middle finger gestures

**Object detection:** Guns (in hand vs not), knives (culinary vs weapon), pills (medical vs illicit), smoking, alcohol (drinking vs possession vs animated)

**Content type:** Natural photo, animated, hybrid, drawing, text overlay, QR code

**AI source detection:** DALL-E, Midjourney, Stable Diffusion, Firefly, and others — with individual confidence scores per source.

---

## Cost

| Component | Per Video | Monthly (10K videos) |
|---|---|---|
| Hive V2 Moderation | ~$0.018 | ~$180 |
| Hive V2 AI/Deepfake Detection | ~$0.018 | ~$180 |
| Hive V3 VLM Classification (NEW) | ~$0.001 | ~$10 |
| VTT Topic Extraction (NEW) | $0 | $0 |
| Cloudflare Workers/KV/D1 | Included | ~$5 |
| **Total** | **~$0.037** | **~$375** |
