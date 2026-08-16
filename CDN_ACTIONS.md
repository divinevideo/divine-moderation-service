# ABOUTME: CDN Integration - Content Actions and Authentication
# ABOUTME: Explains how to handle moderation actions in the CDN with Nostr auth

## Content Actions

The moderation service returns one of 4 actions:

### 1. SAFE
- **Meaning**: Content is safe for all audiences
- **CDN Behavior**: Serve without restrictions
- **KV Key**: Only in `moderation:{sha256}`

### 2. REVIEW
- **Meaning**: Flagged for human review, uncertain classification
- **CDN Behavior**: Serve normally, but log for manual review
- **KV Key**: Only in `moderation:{sha256}`
- **Note**: Human moderators can upgrade to AGE_RESTRICTED or PERMANENT_BAN

### 3. AGE_RESTRICTED
- **Meaning**: Adult content (nudity, violence, gore, drugs, etc.) - requires age verification
- **CDN Behavior**:
  - Without auth: Return 403 + error message explaining age verification needed
  - With valid Nostr auth: Serve content (user takes responsibility)
- **KV Keys**:
  - `moderation:{sha256}` → Full result with `action: "AGE_RESTRICTED"`
  - `age-restricted:{sha256}` → Quick lookup flag

### 4. PERMANENT_BAN
- **Meaning**: Illegal/dangerous content (self-harm, hate speech, extreme gore)
- **CDN Behavior**: NEVER serve to anyone except admin dashboard
- **KV Keys**:
  - `moderation:{sha256}` → Full result with `action: "PERMANENT_BAN"`
  - `permanent-ban:{sha256}` → Quick lookup flag

## CDN Implementation

```javascript
// src/handlers/serve-video.mjs
export async function serveVideo(request, env) {
  const url = new URL(request.url);
  const sha256 = extractSha256(url.pathname);

  // Step 1: Check PERMANENT_BAN (NEVER serve)
  const permanentBan = await env.MODERATION_KV.get(`permanent-ban:${sha256}`);
  if (permanentBan) {
    console.log(`[CDN] BLOCKED permanent ban: ${sha256}`);
    return new Response('Content unavailable - removed for policy violation', {
      status: 451,  // Unavailable For Legal Reasons
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Step 2: Check AGE_RESTRICTED
  const ageRestricted = await env.MODERATION_KV.get(`age-restricted:${sha256}`);
  if (ageRestricted) {
    // Check for Nostr auth header
    const authHeader = request.headers.get('Authorization');

    if (!authHeader) {
      console.log(`[CDN] Age-restricted content requested without auth: ${sha256}`);
      return new Response(JSON.stringify({
        error: 'age_restricted',
        message: 'This content requires age verification via Nostr authentication',
        sha256,
        category: JSON.parse(ageRestricted).category
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Verify Nostr auth (NIP-98)
    const authValid = await verifyNostrAuth(authHeader, request, env);

    if (!authValid) {
      console.log(`[CDN] Invalid Nostr auth for age-restricted: ${sha256}`);
      return new Response(JSON.stringify({
        error: 'invalid_auth',
        message: 'Invalid Nostr authentication'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`[CDN] Serving age-restricted with valid auth: ${sha256}`);
    // Fall through to serve content
  }

  // Step 3: Serve from R2
  const r2Key = `blobs/${sha256}`;  // Blossom format
  const object = await env.R2_VIDEOS.get(r2Key);

  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata.contentType || 'video/mp4',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': object.httpEtag,
      'X-Content-Rating': ageRestricted ? 'age-restricted' : 'safe'
    }
  });
}

/**
 * Extract SHA256 from URL path
 */
function extractSha256(pathname) {
  // Handle both /blobs/{sha256} and /{sha256}.mp4
  const match = pathname.match(/([a-f0-9]{64})/i);
  return match ? match[1].toLowerCase() : null;
}
```

## Nostr Authentication (NIP-98)

For age-restricted content, clients must provide Nostr authentication:

### Client-Side (JavaScript)

```javascript
// User wants to view age-restricted video
async function fetchAgeRestrictedVideo(sha256, nostrPrivateKey) {
  const url = `https://cdn.divine.video/blobs/${sha256}`;

  // Create NIP-98 auth event
  const authEvent = {
    kind: 27235,  // HTTP Auth
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', url],
      ['method', 'GET']
    ],
    content: ''
  };

  // Sign with Nostr private key (using nostr-tools or similar)
  const signedEvent = await signEvent(authEvent, nostrPrivateKey);

  // Encode as base64
  const authHeader = `Nostr ${btoa(JSON.stringify(signedEvent))}`;

  // Fetch video with auth
  const response = await fetch(url, {
    headers: {
      'Authorization': authHeader
    }
  });

  if (response.status === 403) {
    const error = await response.json();
    console.log('Age verification required:', error.category);
    // Show age verification UI
  }

  return response;
}
```

### Server-Side Verification

```javascript
// src/utils/nostr-auth.mjs
import { verifySignature, getEventHash } from 'nostr-tools';

/**
 * Verify NIP-98 Nostr authentication
 * @param {string} authHeader - Authorization header value
 * @param {Request} request - Original request
 * @param {Object} env - Environment bindings
 * @returns {Promise<boolean>} True if auth is valid
 */
export async function verifyNostrAuth(authHeader, request, env) {
  try {
    // Parse "Nostr <base64-event>"
    if (!authHeader.startsWith('Nostr ')) {
      return false;
    }

    const base64Event = authHeader.substring(6);
    const eventJson = atob(base64Event);
    const event = JSON.parse(eventJson);

    // Verify event structure
    if (event.kind !== 27235) {
      console.log('[AUTH] Invalid kind, expected 27235');
      return false;
    }

    // Verify event hash
    const calculatedId = getEventHash(event);
    if (calculatedId !== event.id) {
      console.log('[AUTH] Event hash mismatch');
      return false;
    }

    // Verify signature
    const validSignature = verifySignature(event);
    if (!validSignature) {
      console.log('[AUTH] Invalid signature');
      return false;
    }

    // Verify URL matches
    const urlTag = event.tags.find(t => t[0] === 'u');
    const requestUrl = new URL(request.url);
    if (!urlTag || urlTag[1] !== requestUrl.href) {
      console.log('[AUTH] URL mismatch');
      return false;
    }

    // Verify method matches
    const methodTag = event.tags.find(t => t[0] === 'method');
    if (!methodTag || methodTag[1] !== request.method) {
      console.log('[AUTH] Method mismatch');
      return false;
    }

    // Check timestamp (not older than 60 seconds)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - event.created_at) > 60) {
      console.log('[AUTH] Event too old or in future');
      return false;
    }

    console.log(`[AUTH] Valid auth from pubkey: ${event.pubkey}`);
    return true;

  } catch (error) {
    console.error('[AUTH] Verification error:', error);
    return false;
  }
}
```

## Admin Dashboard Actions

The admin dashboard at `/admin/dashboard` should allow moderators to:

### 1. View All Content
- See SAFE, REVIEW, AGE_RESTRICTED, and PERMANENT_BAN content
- Filter by action type
- Sort by scores

### 2. Change Classifications
- **REVIEW → SAFE**: Mark as false positive
- **REVIEW → AGE_RESTRICTED**: Requires age verification
- **REVIEW → PERMANENT_BAN**: Escalate to removal
- **AGE_RESTRICTED → SAFE**: Downgrade if misclassified
- **AGE_RESTRICTED → PERMANENT_BAN**: Escalate to removal

### 3. Take Down Content
- **Soft Take Down**: Change to AGE_RESTRICTED (still accessible with auth)
- **Hard Take Down**: Change to PERMANENT_BAN (completely removed)

### Implementation

```javascript
// Add to src/index.mjs admin API

// POST /admin/api/moderate/{sha256}
if (url.pathname.startsWith('/admin/api/moderate/') && request.method === 'POST') {
  const authError = await requireAuth(request, env);
  if (authError) return authError;

  const sha256 = url.pathname.split('/')[4];
  const { action, reason } = await request.json();

  // Validate action
  if (!['SAFE', 'REVIEW', 'AGE_RESTRICTED', 'PERMANENT_BAN'].includes(action)) {
    return new Response('Invalid action', { status: 400 });
  }

  // Get existing moderation result
  const existingData = await env.MODERATION_KV.get(`moderation:${sha256}`);
  if (!existingData) {
    return new Response('Not found', { status: 404 });
  }

  const existing = JSON.parse(existingData);

  // Update moderation result
  const updated = {
    ...existing,
    action,
    reason: reason || `Manual override by moderator`,
    manualOverride: true,
    overriddenBy: 'admin',  // Could get from auth token
    overriddenAt: Date.now()
  };

  // Write updated result
  await env.MODERATION_KV.put(
    `moderation:${sha256}`,
    JSON.stringify(updated)
  );

  // Update action-specific keys
  await Promise.all([
    // Clear old keys
    env.MODERATION_KV.delete(`age-restricted:${sha256}`),
    env.MODERATION_KV.delete(`permanent-ban:${sha256}`),
    env.MODERATION_KV.delete(`quarantine:${sha256}`)  // Legacy
  ]);

  // Set new key based on action
  if (action === 'AGE_RESTRICTED') {
    await env.MODERATION_KV.put(
      `age-restricted:${sha256}`,
      JSON.stringify({
        category: updated.category,
        reason: updated.reason,
        timestamp: Date.now(),
        manualOverride: true
      })
    );
  } else if (action === 'PERMANENT_BAN') {
    await env.MODERATION_KV.put(
      `permanent-ban:${sha256}`,
      JSON.stringify({
        category: updated.category,
        reason: updated.reason,
        timestamp: Date.now(),
        manualOverride: true
      })
    );
  }

  return new Response(JSON.stringify({
    success: true,
    sha256,
    action,
    message: `Content updated to ${action}`
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## Summary

### Content Access Rules

| Action | No Auth | With Nostr Auth | Admin |
|--------|---------|-----------------|-------|
| SAFE | ✅ Serve | ✅ Serve | ✅ Serve |
| REVIEW | ✅ Serve | ✅ Serve | ✅ Serve |
| AGE_RESTRICTED | ❌ 403 | ✅ Serve | ✅ Serve |
| PERMANENT_BAN | ❌ 451 | ❌ 451 | ✅ Serve (view only) |

### KV Keys Used

- `moderation:{sha256}` - Full moderation result (all actions)
- `age-restricted:{sha256}` - Quick flag for age-restricted content
- `permanent-ban:{sha256}` - Quick flag for banned content
- `quarantine:{sha256}` - **DEPRECATED** (use permanent-ban instead)

### CDN Flow

1. Check `permanent-ban:{sha256}` → If exists, return 451
2. Check `age-restricted:{sha256}` → If exists:
   - Check Authorization header
   - If missing → return 403 with error
   - If invalid → return 401
   - If valid → serve content
3. Serve content from R2

### Next Steps

1. ✅ Update CDN to check `permanent-ban` and `age-restricted` keys
2. ✅ Implement NIP-98 Nostr auth verification
3. ✅ Add admin dashboard action buttons
4. ✅ Test age-restricted flow with Nostr clients
5. ✅ Update CDN_INTEGRATION.md with correct terminology
