# Cloudflare Access Setup

`moderation.admin.divine.video` is protected by the shared Cloudflare Access
application named `admin-tools`. That application covers
`*.admin.divine.video/*`, so this service must use its existing Application
Audience (AUD) tag rather than create a hostname-specific application.

## Verify The Shared Application

### 1. Get Your Cloudflare Account ID

```bash
# Find it in the Cloudflare dashboard URL when viewing Workers & Pages
# https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages
```

### 2. Create an API Token

Go to: https://dash.cloudflare.com/profile/api-tokens

**Required permissions:**
- Account > Zero Trust > Read

### 3. Inspect The Existing Application

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
export CLOUDFLARE_API_TOKEN="your-api-token-here"

curl -s \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result[] | select(.name == "admin-tools") | {name, domain, aud}'
```

Confirm that the result covers `*.admin.divine.video/*`. Do not create a
separate application for `moderation.admin.divine.video`: Cloudflare assigns
each application its own AUD, and a second application would make the Worker
reject tokens from the shared application.

## Repository Configuration

`wrangler.toml` commits both values used for Worker-side JWT verification:

- `TEAM_DOMAIN` is the Cloudflare Access issuer.
- `POLICY_AUD` is the `admin-tools` application's AUD.

If the shared application's AUD changes, update `POLICY_AUD` in a reviewed
commit. Do not create or replace Access applications from this repository.

## Access Configuration

### Configure Identity Provider (One-Time)

The shared application needs at least one identity provider for authentication:

1. Go to: Zero Trust → Settings → Authentication
2. Add a provider (easiest: **One-time PIN**)
   - Sends a verification code to the user's email
   - No extra configuration needed

Or add:
- Google Workspace
- GitHub
- Azure AD
- etc.

### DNS

Point `moderation.admin.divine.video` to this Worker:

```bash
# If using Cloudflare Workers:
# Add a route/CNAME for moderation.admin.divine.video to this Worker

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

Only the admin hostname is protected for this service. Related public domains remain publicly accessible:
- `moderation-api.divine.video` - Public and service-facing moderation API
- `cdn.divine.video` - Public video CDN

## Worker Verification

Cloudflare Access remains the edge authorization layer, and the Worker independently verifies its signed JWT as defence in depth. Keep `TEAM_DOMAIN` and `POLICY_AUD` (both committed `[vars]` in `wrangler.toml`) matching the admin Access application; `POLICY_AUD` is the app's Application Audience (AUD) tag. Do not replace Worker verification with a check for the asserted email header.

**Available headers in your Worker:**
```javascript
// After Cloudflare Access authenticates, verify this token before trusting claims:
const token = request.headers.get('cf-access-jwt-assertion');
```

## Troubleshooting

**"Access denied" even with @divine.video email:**
- Make sure you've configured at least one identity provider
- Check the Access logs: Zero Trust → Logs → Access

**Application query fails with an API error:**
- Verify your API token has "Account > Zero Trust > Read" permission
- Check that CLOUDFLARE_ACCOUNT_ID is correct

**Need to change the shared application:**

Coordinate the change with the Platform team because it affects every
`*.admin.divine.video` service. After an AUD change, update `POLICY_AUD` in
`wrangler.toml` in the same rollout.

To inspect the current configuration:

```bash
# List applications
curl -X GET "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
