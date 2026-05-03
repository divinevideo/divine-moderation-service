# Manual Review Default Design

## Goal

Stop sending new video uploads, moderation analysis, and content classification to Hive. Every newly queued video should enter the existing human review workflow and remain publicly playable while the team decides the final moderation action.

## Decisions

- New queue moderation results default to `REVIEW`.
- `REVIEW` remains playable: no `quarantine:*`, `age-restricted:*`, or `permanent-ban:*` KV key is written for the initial result.
- The provider recorded for the initial result is `manual-review`.
- Hive moderation, Sightengine fallback, Reality Defender submission, and Hive VLM scene classification are skipped from the normal upload moderation path.
- `classifyVideoOnly()`, `/api/v1/classify`, and the direct `classifyVideo()` pipeline skip Hive VLM by default.
- Local, low-cost enrichment can still run:
  - Nostr event context lookup.
  - C2PA / ProofMode lookup through `divine-inquisitor`.
  - VTT transcript text classification and local topic extraction when a transcript exists.

## Architecture

`src/moderation/pipeline.mjs` remains the queue-facing orchestration point. After resolving video URL, Nostr context, C2PA, and optional transcript data, the pipeline builds a manual review moderation result instead of calling `moderateWithFallback()`, `classifyModerationResult()`, `classifyVideo()`, or Reality Defender. The standalone `src/classification/pipeline.mjs` entry point also returns a skipped result so a direct call cannot accidentally send video to Hive VLM.

The returned object keeps the same shape consumers already expect: `action`, `severity`, `category`, `reason`, `scores`, `provider`, `cdnUrl`, `nostrContext`, `policyContext`, `downstreamSignals`, `rawClassifierData`, `sceneClassification`, `topicProfile`, and `c2pa`. This preserves D1 storage, admin APIs, review filters, and classifier KV storage.

`valid_ai_signed` C2PA previously short-circuited to `QUARANTINE`. Under this design it goes to `REVIEW`, because the product decision is that the team reviews each video and pending review is playable.

## Data Flow

1. Queue worker validates the upload message and skips already moderated videos as today.
2. `moderateVideo()` resolves the media URL and Nostr metadata.
3. `moderateVideo()` verifies C2PA / ProofMode if available.
4. `moderateVideo()` fetches VTT, classifies text locally, and extracts local topics if possible.
5. `moderateVideo()` returns a `REVIEW` result with provider `manual-review`, no Hive raw classifier data, and no Hive scene classification.
6. Queue worker stores the result in D1 and classifier KV as today.
7. Existing admin review endpoints move the video to `SAFE`, `AGE_RESTRICTED`, `PERMANENT_BAN`, or another supported action.

## Error Handling

- C2PA failures remain non-fatal and produce `unchecked`.
- Missing or pending VTT remains non-fatal.
- Hive credentials may still exist in the environment, but the upload moderation and classification entry points must not call `api.thehive.ai`.
- Because manual review is the default result, lack of external moderation credentials must not fail queue processing.

## Testing

- Add a pipeline regression that provides Hive credentials and asserts no request is made to `api.thehive.ai`.
- Assert the result is `REVIEW`, `provider === "manual-review"`, `sceneClassification === null`, `rawClassifierData === null`, and pending review stays playable by relying on existing `REVIEW` semantics.
- Assert local VTT topic extraction still runs without Hive.
- Add classification regressions that provide `HIVE_VLM_API_KEY` and assert no request is made to Hive VLM.
- Update older pipeline expectations that assumed Hive, Sightengine, or automated actions in the normal path.
