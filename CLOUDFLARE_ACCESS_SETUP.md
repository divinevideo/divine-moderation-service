# Cloudflare Access Setup

This protects `moderation.admin.divine.video` with Cloudflare Access, allowing only `@divine.video` email addresses.

## Quick Setup

### 1. Get Your Cloudflare Account ID

```bash
# Find it in the Cloudflare dashboard URL when viewing Workers & Pages
# https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages
```

### 2. Create an API Token

Go to: https://dash.cloudflare.com/profile/api-tokens

**Required permissions:**
- Account > Zero Trust > Edit

### 3. Run the Setup Script

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export CLOUDFLARE_API_TOKEN="your-api-token-here"

./scripts/setup-cloudflare-access.sh
```

## What This Does

1. **Creates an Access Application** for `moderation.admin.divine.video`
2. **Creates an Access Policy** that allows all `@divine.video` email addresses
3. Configures 24-hour session duration

**Protected domain:**
- `https://moderation.admin.divine.video`

## After Running the Script

### Configure Identity Provider (One-Time)

You need at least one identity provider for authentication:

1. Go to: Zero Trust → Settings → Authentication
2. Add a provider (easiest: **One-time PIN**)
   - Sends a verification code to the user's email
   - No extra configuration needed

Or add:
- Google Workspace
- GitHub
- Azure AD
- etc.

### Set Up DNS

Point `moderation.admin.divine.video` to your admin application:

```bash
# If using Cloudflare Workers:
# Add a route/CNAME for moderation.admin.divine.video to this worker

# Or if using a custom origin server:
# Add an A/AAAA record pointing to your server
```

### Test It

1. Visit: https://moderation.admin.divine.video/admin
2. You'll be redirected to Cloudflare Access login
3. Enter your `@divine.video` email
4. Verify with the code sent to your email
5. Access granted!

## Other Domains (Not Protected)

Only `moderation.admin.divine.video` is protected. Your other services remain publicly accessible:
- `moderation-api.divine.video` - Public and service-facing moderation API
- `cdn.divine.video` - Public video CDN

## Worker Verification

Cloudflare Access remains the edge authorization layer, and the Worker independently verifies its signed JWT as defence in depth. Keep `TEAM_DOMAIN` and the `POLICY_AUD` secret configured for the admin Access application. Do not replace Worker verification with a check for the asserted email header.

**Available headers in your Worker:**
```javascript
// After Cloudflare Access authenticates, verify this token before trusting claims:
const token = request.headers.get('cf-access-jwt-assertion');
```

## Troubleshooting

**"Access denied" even with @divine.video email:**
- Make sure you've configured at least one identity provider
- Check the Access logs: Zero Trust → Logs → Access

**Script fails with API error:**
- Verify your API token has "Account > Zero Trust > Edit" permissions
- Check that CLOUDFLARE_ACCOUNT_ID is correct

**Need to update the policy:**
```bash
# List applications
curl -X GET "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Update via dashboard or API
```
