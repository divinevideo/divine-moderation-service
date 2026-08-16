# Divine Video Moderation Service - Project Notes

## Video Content Location

**CRITICAL**: All videos are hosted on **cdn.divine.video**, NOT r2.divine.video.

## Video URL Resolution

When fetching videos for moderation:

1. **ALWAYS** use the URL from the `imeta` tag in the Nostr event (kind 34236) if available
2. The `imeta` tag contains the actual video file URL (e.g., `https://cdn.divine.video/{sha256}.mp4`)
3. The `r` tag contains the ORIGINAL source URL (e.g., vine.co) - DO NOT USE THIS for Sightengine
4. If no Nostr event exists, fall back to `https://cdn.divine.video/{sha256}.mp4`

## Nostr Event Structure (kind 34236)

```json
{
  "tags": [
    ["imeta", "url https://cdn.divine.video/{sha256}.mp4", "m video/mp4", "x {sha256}", ...],
    ["r", "https://vine.co/v/{original_id}"],  // Original source - DO NOT USE
    ...
  ]
}
```

## Important Notes

- Never use the `r` tag URL for video processing - it's the original source (often dead links like vine.co)
- Always prefer the `imeta` tag URL which points to our CDN
- The Sightengine API requires publicly accessible video URLs
- Videos are stored in R2 under `blobs/{sha256}` or `videos/{sha256}.mp4` but accessed via CDN
