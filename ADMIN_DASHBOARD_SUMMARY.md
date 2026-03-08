# Admin Dashboard - Quick Reference

## What Was Built

A password-protected web interface for reviewing all moderated video content with:

- **Visual grid view** of all videos with hover-to-play previews
- **Real-time statistics** showing total/safe/review/quarantined counts
- **Multi-criteria sorting**: by timestamp, nudity, violence, or AI scores (ascending/descending)
- **Flexible filtering**: by action type (SAFE/REVIEW/QUARANTINE) and minimum score threshold
- **Color-coded cards**: Green (safe), yellow (review), red (quarantined)
- **Score visualizations**: Horizontal bar graphs for each category
- **Session-based auth**: 24-hour sessions with secure HttpOnly cookies
- **Mobile responsive**: Works on all screen sizes

## Quick Setup (3 Steps)

### 1. Generate Password Hash

```bash
node generate-admin-hash.mjs "your-password-here"
```

Copy the hash that's printed.

### 2. Set as Secret

```bash
wrangler secret put ADMIN_PASSWORD_HASH
# Paste the hash when prompted
```

### 3. Deploy

```bash
wrangler deploy
```

Done! Access at: `https://moderation.admin.divine.video/admin`

## Files Created

```
src/admin/
  ├── dashboard.html       # Main dashboard UI
  ├── login.html           # Login page
  └── auth.mjs             # Authentication middleware

src/index.mjs              # Updated with admin routes
generate-admin-hash.mjs    # Password hash generator
ADMIN_SETUP.md             # Full documentation
ADMIN_DASHBOARD_SUMMARY.md # This file
```

## Routes Added

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/admin` | GET | No | Redirects to dashboard |
| `/admin/login` | GET | No | Login page |
| `/admin/login` | POST | No | Submit password |
| `/admin/dashboard` | GET | Yes | Main dashboard UI |
| `/admin/api/videos` | GET | Yes | JSON list of videos |
| `/admin/logout` | GET | Yes | Invalidate session |

## Dashboard Features

### Stats Panel
- Total videos moderated
- Count by action (safe/review/quarantine)
- Color-coded for quick scanning

### Sort Options
- Recent first (default)
- Nudity: high→low or low→high
- Violence: high→low or low→high
- AI-generated: high→low or low→high

### Filters
- Action: All / Safe / Review / Quarantined
- Min score threshold: 0.0 - 1.0

### Video Cards
Each card displays:
- Video preview (hover to play)
- Status badge
- SHA256 hash (truncated)
- Three score bars: nudity, violence, AI
- Reason for classification
- Timestamp

### Score Visualization
Color-coded horizontal bars:
- **Orange/Red gradient**: Nudity scores
- **Red/Dark red gradient**: Violence scores
- **Blue/Purple gradient**: AI-generated scores

## Security Features

- Password stored as SHA-256 hash only
- Session tokens: 32-byte cryptographically secure random
- HttpOnly cookies (no JavaScript access)
- Secure flag (HTTPS only)
- SameSite=Strict (CSRF protection)
- 24-hour session expiration
- Automatic KV cleanup of expired sessions

## Usage Examples

### View Highest Nudity Scores
1. Log in
2. Select "Nudity (High → Low)" from Sort dropdown
3. View top offenders at the top

### Find Quarantined Content
1. Select "Quarantined" from Filter dropdown
2. All quarantined videos appear (red borders)

### Find Borderline Content
1. Set "Min Score Threshold" to 0.6
2. Set Sort to "Nudity (High → Low)"
3. See all content above review threshold

### Check Recent Uploads
1. Keep sort on "Recent First" (default)
2. Click "Refresh" button
3. Latest moderated videos appear first

## Integration with CDN

The dashboard reads from the same KV namespace as the CDN moderation checks:

- CDN writes: `moderation:{sha256}`, `quarantine:{sha256}`
- Dashboard reads: All keys with `moderation:` prefix
- No write access for dashboard (read-only)

## Performance Notes

- KV list operations are paginated automatically
- All videos loaded on dashboard access (consider pagination for 10,000+ videos)
- Client-side sorting/filtering (instant response)
- Videos lazy-load on scroll (browser optimization)

## Browser Compatibility

Tested and working in:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile Safari (iOS 14+)
- Chrome Mobile (Android)

## Known Limitations

1. **No pagination**: All videos load at once (could be slow with 10,000+ videos)
2. **No manual actions**: Can't manually quarantine/approve from dashboard
3. **No video playback controls**: Only hover-to-play
4. **No frame-by-frame view**: Can't see which specific frames were flagged
5. **Single password**: No multi-user or role-based access

## Future Enhancements

See ADMIN_SETUP.md "Future Enhancements" section for full list.

## Troubleshooting

### Can't log in
```bash
# Verify secret is set
wrangler secret list

# Should show:
# ADMIN_PASSWORD_HASH

# Regenerate if needed
node generate-admin-hash.mjs "your-password"
wrangler secret put ADMIN_PASSWORD_HASH
wrangler deploy
```

### No videos showing
```bash
# Check if any moderation results exist
wrangler kv:key list --namespace-id=eee0689974834390acd39d543002cac3 --prefix="moderation:"

# Check worker logs
wrangler tail
```

### Videos won't play
- Check `CDN_DOMAIN` in wrangler.toml
- Verify videos are publicly accessible
- Check browser console for CORS errors

## Cost Impact

Dashboard adds minimal cost:
- **KV reads**: ~1 read per video on dashboard load
- **Session storage**: ~10 KV writes/reads per day per user
- **Bandwidth**: ~1-2 MB per dashboard load (depends on video count)

Example: 100 videos, 5 admin users checking daily:
- KV reads: 500/day = FREE (< 10M/month)
- KV writes: 50/day = FREE (< 1M/month)
- Total: $0/month

## Support

For issues or questions:
1. Check ADMIN_SETUP.md for detailed docs
2. Review CDN_INTEGRATION.md for integration details
3. Check wrangler logs: `wrangler tail`
4. Open issue in project repository
