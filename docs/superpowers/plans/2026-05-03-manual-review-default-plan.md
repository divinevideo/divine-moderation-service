# Manual Review Default Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every new uploaded video enter playable team review without calling Hive moderation, Hive VLM classification, or Sightengine.

**Architecture:** Keep `src/moderation/pipeline.mjs` as the orchestration boundary, but replace the external moderation/classification branch with a manual review result builder. Preserve local Nostr, C2PA, transcript text, and topic enrichment so admin review still has context.

**Tech Stack:** Cloudflare Workers, Vitest, D1/KV payloads, existing moderation pipeline modules.

---

## Chunk 1: Pipeline Behavior

### Task 1: Add Manual Review Pipeline Regression

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`

- [x] **Step 1: Write the failing test**
- [x] **Step 2: Run test to verify it fails**
- [x] **Step 3: Implement manual review result builder**
- [x] **Step 4: Run focused test to verify it passes**

### Task 2: Preserve Local Enrichment

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`
- Modify: `src/moderation/pipeline-classification.test.mjs`
- Modify: `src/classification/pipeline.mjs`
- Modify: `src/classification/pipeline.test.mjs`

- [x] **Step 1: Add transcript topic extraction regression**
- [x] **Step 2: Add classify-only no-Hive regression**
- [x] **Step 3: Disable Hive VLM in `classifyVideoOnly()` and `classifyVideo()`**
- [x] **Step 4: Run focused tests**

## Chunk 2: Existing Tests and Config

### Task 3: Update Pipeline Tests For New Default

**Files:**
- Modify: `src/moderation/pipeline.test.mjs`
- Modify: `src/moderation/pipeline-classification.test.mjs`

- [x] **Step 1: Run affected suites**
- [x] **Step 2: Update tests that described the old automated upload moderation path**
- [x] **Step 3: Re-run affected suites**

### Task 4: Update Production Config and Docs

**Files:**
- Modify: `wrangler.toml`
- Modify: `README.md`

- [x] **Step 1: Set `PRIMARY_MODERATION_PROVIDER = "manual-review"`**
- [x] **Step 2: Document that upload and classification paths do not call Hive**
- [x] **Step 3: Run config/doc-adjacent tests**

## Chunk 3: Final Verification

### Task 5: Full Verification

**Files:**
- No new files.

- [x] **Step 1: Run lint**
- [x] **Step 2: Run all tests**
- [x] **Step 3: Commit**
