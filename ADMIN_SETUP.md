# Admin Dashboard Setup

## Overview

The moderation service includes a password-protected admin dashboard for reviewing moderated content. The dashboard allows you to:

- View all moderated videos with visual previews
- Sort by nudity, violence, or AI-generated scores
- Filter by action (SAFE, REVIEW, QUARANTINE)
- Set minimum score thresholds
- See real-time stats

## Setting Up Password Authentication

### Step 1: Generate Password Hash

The admin password is stored as a SHA-256 hash. Generate it using this Node.js script:

```javascript
// generate-hash.js
const crypto = require('crypto');

const password = 'your-secure-password-here';
const hash = crypto.createHash('sha256').update(password).digest('hex');

console.log('Password hash:', hash);
console.log('\nSet it with:');
console.log(`wrangler secret put ADMIN_PASSWORD_HASH`);
console.log('Then paste the hash above when prompted');
```

Run it:

```bash
node generate-hash.js
```

Or use this one-liner:

```bash
echo -n "your-secure-password-here" | shasum -a 256
```

### Step 2: Set the Secret

Copy the hash and set it as a Wrangler secret:

```bash
wrangler secret put ADMIN_PASSWORD_HASH
# Paste the hash when prompted (NOT the plain password)
```

**Example:**
- Password: `mySecurePass123!`
- Hash: `9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0`

You would set the hash (not the password) as the secret.

### Step 3: Deploy

```bash
wrangler deploy
```

## Accessing the Dashboard

Once deployed, access the dashboard at:

```
https://moderation.admin.divine.video/admin
```

For local development, use your Wrangler dev URL instead.

### Login

1. Navigate to `/admin` (redirects to `/admin/login`)
2. Enter the password (NOT the hash - the actual password you hashed)
3. Click "Login"

The session lasts 24 hours and is stored securely with HttpOnly cookies.

### Logout

Click "Logout" in the top-right corner or navigate to `/admin/logout`.

## Dashboard Features

### Stats Overview

At the top of the dashboard, you'll see:
- **Total Videos**: All moderated content
- **Safe**: Automatically approved (green)
- **Review**: Flagged for human review (yellow)
- **Quarantined**: Blocked content (red)

### Sorting Options

Sort videos by:
- **Recent First**: Most recently moderated (default)
- **Nudity (High → Low)**: Highest nudity scores first
- **Nudity (Low → High)**: Lowest nudity scores first
- **Violence (High → Low)**: Highest violence scores first
- **Violence (Low → High)**: Lowest violence scores first
- **AI-Generated (High → Low)**: Highest AI scores first
- **AI-Generated (Low → High)**: Lowest AI scores first

### Filtering

Filter by:
- **Action**: All / Safe / Review / Quarantined
- **Min Score Threshold**: Show only videos with any score above threshold (0.0 - 1.0)

### Video Cards

Each video card shows:
- **Video preview**: Hover to play
- **Action badge**: SAFE (green), REVIEW (yellow), QUARANTINE (red)
- **SHA256 hash**: First 16 characters
- **Score bars**: Visual representation of nudity, violence, and AI scores
- **Reason**: Why the video was classified this way
- **Timestamp**: When moderation completed

## API Endpoints

The dashboard uses these authenticated API endpoints:

### POST `/admin/login`

Authenticate and create session.

**Request:**
```json
{
  "password": "your-password"
}
```

**Response (success):**
```json
{
  "success": true
}
```

Sets `admin_token` cookie.

**Response (failure):**
```json
{
  "success": false,
  "error": "Invalid password"
}
```

### GET `/admin/dashboard`

Returns the dashboard HTML. Requires authentication (redirects to login if not authenticated).

### GET `/admin/api/videos`

Returns all moderation results as JSON. Requires authentication.

**Response:**
```json
{
  "videos": [
    {
      "action": "SAFE",
      "severity": "low",
      "scores": {
        "nudity": 0.05,
        "violence": 0.01,
        "ai_generated": 0.03
      },
      "reason": "Low risk content, approved automatically",
      "sha256": "abc123...",
      "cdnUrl": "https://r2.divine.video/abc123.mp4",
      "processedAt": 1704067205000,
      "processingTimeMs": 5432
    }
  ]
}
```

### GET `/admin/logout`

Invalidate session and clear cookie.

## Security Considerations

### Password Storage

- Passwords are NEVER stored in plain text
- Only SHA-256 hashes are stored as Wrangler secrets
- Secrets are encrypted at rest by Cloudflare

### Session Management

- Sessions expire after 24 hours
- Session tokens are 32-byte cryptographically secure random values
- Tokens are stored in KV with automatic expiration
- Cookies use `HttpOnly`, `Secure`, and `SameSite=Strict` flags

### HTTPS Only

- The `Secure` cookie flag ensures cookies only transmit over HTTPS
- Cloudflare Workers automatically provide HTTPS

### Best Practices

1. **Use a strong password**: At least 16 characters, mix of letters, numbers, symbols
2. **Rotate password regularly**: Update the hash secret every 90 days
3. **Limit access**: Only share credentials with trusted moderators
4. **Monitor access**: Check logs for unauthorized access attempts
5. **Use custom domain**: Don't expose `workers.dev` subdomain publicly

## Troubleshooting

### "Invalid password" error

- Verify you set the hash correctly: `wrangler secret list` should show `ADMIN_PASSWORD_HASH`
- Regenerate the hash and ensure you're entering the plain password, not the hash
- Deploy after setting the secret: `wrangler deploy`

### Dashboard shows no videos

- Verify moderation results exist: `wrangler kv:key list --namespace-id=eee0689974834390acd39d543002cac3 --prefix="moderation:"`
- Check that videos have been processed (queue consumer running)
- Look for errors in logs: `wrangler tail`

### Session expires immediately

- Ensure `MODERATION_KV` binding is configured in `wrangler.toml`
- Check KV write permissions
- Verify clock skew isn't affecting expiration timestamps

### Videos won't play

- Ensure `CDN_DOMAIN` is correctly configured in `wrangler.toml`
- Check that video URLs are publicly accessible on Blossom

## Changing the Password

To change the admin password:

1. Generate a new hash:
   ```bash
   echo -n "new-password-here" | shasum -a 256
   ```

2. Update the secret:
   ```bash
   wrangler secret put ADMIN_PASSWORD_HASH
   # Paste new hash
   ```

3. Deploy:
   ```bash
   wrangler deploy
   ```

All existing sessions will remain valid until they expire (24 hours). To immediately invalidate all sessions, you could:

```bash
# Clear all session keys from KV (optional)
wrangler kv:key list --namespace-id=eee0... --prefix="session:" | \
  jq -r '.[].name' | \
  xargs -I {} wrangler kv:key delete --namespace-id=eee0... "{}"
```

## Development

For local development:

```bash
# Set local secret (stored in .dev.vars)
echo "ADMIN_PASSWORD_HASH=9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0" > .dev.vars

# Run locally
wrangler dev

# Access at http://localhost:8787/admin
```

**Note:** Never commit `.dev.vars` to version control.

## Production Checklist

- [ ] Set strong admin password (16+ characters)
- [ ] Generate and set `ADMIN_PASSWORD_HASH` secret
- [ ] Deploy with `wrangler deploy`
- [ ] Test login at `/admin`
- [ ] Verify videos load correctly
- [ ] Set up custom domain (optional but recommended)
- [ ] Document password recovery procedure
- [ ] Share credentials securely with moderators
- [ ] Set up monitoring/alerting for admin access

## Future Enhancements

Potential additions to the dashboard:

- [ ] Multi-user support with role-based access
- [ ] Manual review actions (approve/quarantine override)
- [ ] Export moderation reports (CSV/JSON)
- [ ] Real-time updates via WebSockets
- [ ] Bulk actions (quarantine multiple videos)
- [ ] Appeal management for false positives
- [ ] Detailed frame-by-frame analysis view
- [ ] Integration with Nostr moderation events
- [ ] Moderation statistics and trends
- [ ] Audit log for admin actions
