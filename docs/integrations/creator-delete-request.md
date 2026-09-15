# Immediate creator deletion

`POST /api/delete/{kind5_id}` accepts the client's signed Nostr kind-5 event directly. This avoids fetching a just-published event before the relay has made it queryable. The client still publishes the event to its relays, then requests cleanup.

Send `Content-Type: application/json` and the following JSON shape (placeholders shown):

```json
{
  "event": {
    "id": "<64-character event ID matching the URL>",
    "pubkey": "<author public key>",
    "created_at": 1789430400,
    "kind": 5,
    "tags": [["e", "<64-character target event ID>"]],
    "content": "",
    "sig": "<event signature>"
  }
}
```

Use `Authorization: Nostr <base64-encoded signed kind-27235 event>`. Its `u` and `method` tags name the request URL and `POST`; its `payload` tag must contain the lowercase SHA-256 hex digest of the exact UTF-8 bytes posted. Encode the body once, then hash and send those same bytes. The auth event must be within 60 seconds of server time and signed by the deletion event's author.

The body is limited to 64 KiB, including whitespace. The service verifies the supplied event's signature, ID, kind, and nonempty `e` tags containing valid event IDs. It then uses the existing processor to retrieve each target, check target ownership, and derive the blob to delete. The body does not supply a blob hash or bypass target authorization. Existing target limits, idempotency, response shapes, and status polling are unchanged.

| Status | Meaning |
| --- | --- |
| 200 | Processing finished; inspect `status` and `targets` for success or failure |
| 202 | Processing continues; use `poll_url` with a fresh NIP-98 GET authorization |
| 400 | Malformed body, invalid signed event, ID mismatch, or invalid/missing target IDs |
| 401 | Invalid NIP-98 authorization or missing/mismatched body hash |
| 403 | Authenticated caller differs from deletion event author |
| 413 | Request body exceeds 64 KiB |
| 429 | Existing IP or author rate limit exceeded |

Invalid nonempty bodies fail immediately; they never trigger a relay lookup fallback. Requests with an empty body retain the legacy relay lookup/retry behavior, including 404 when the kind-5 event remains unavailable. Existing clients therefore remain compatible.

Deploy this service change before releasing the client that supplies signed events. Older service versions ignore the optional body and continue their existing lookup path. This change removes kind-5 lookup and retry latency for updated clients; target lookups and blob deletion can still require time. Confirm production outcomes and latency after both service deployment and app release.

Regression coverage: `src/creator-delete/supplied-event.test.mjs`, `nip98.test.mjs`, and `sync-endpoint.test.mjs`.
