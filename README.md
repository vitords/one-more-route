# One More Route

A web application to track progress completing all Zwift routes. Hosted on GitHub Pages with multi-device sync via GitHub Gist and Strava integration.

## Features

- View all 223 Zwift routes organized by map
- Mark routes as completed (authenticated editing)
- Track progress with comprehensive statistics
- Filter and search routes
- Link Strava activities to completed routes
- View detailed activity stats (power, heart rate, speed, etc.)
- Public showcase page and private edit page

## Quick Setup

### 1. GitHub Pages

1. Repository Settings → Pages
2. Source: `main` branch, `/ (root)` folder
3. Site: `https://[username].github.io/[repository-name]`

### 2. Configure Gist ID

Edit `app.js` and set your Gist ID:

```javascript
SHOWCASE_GIST_ID: 'your-gist-id-here'
```

The app will use this Gist for both viewing and editing across all devices.

### 3. GitHub Authentication

1. Create a [Personal Access Token](https://github.com/settings/tokens) with `gist` scope
2. On the edit page, click "Login to Edit" and paste your token

### 4. Strava Integration (Optional)

1. Create a [Strava API app](https://www.strava.com/settings/api)
2. Set `STRAVA_CLIENT_ID` in `app.js`
3. Deploy the serverless function:

**Vercel (Recommended)**
```bash
npm i -g vercel
vercel
vercel env add STRAVA_CLIENT_SECRET
vercel --prod
```

4. Update `STRAVA_TOKEN_PROXY_URL` in `app.js` with your Vercel function URL

See `VERCEL_DEPLOY.md` for detailed deployment instructions.

## File Structure

```
/
├── index.html          # Showcase page (public viewing)
├── edit.html           # Edit page (authenticated editing)
├── app.js              # Application logic
├── styles.css          # Styling
├── routes.json         # Route data (includes Zwift Insider fields when scraped)
├── scripts/            # Maintainer tooling
│   ├── fetch-zwift-insider.mjs   # Scrape ZI for time estimates + profile images
│   └── route-name-overrides.json # App route name → ZI URL when names differ
├── api/
│   └── strava-token.js # Serverless function for Strava OAuth
└── package.json        # Node.js config for Vercel
```

## How It Works

- **Route Data**: Loaded from `routes.json`

### Refreshing Zwift Insider data (time estimates + elevation profiles)

Time estimates and profile image URLs are **scraped offline** from [Zwift Insider](https://zwiftinsider.com/routes/) (ZIMetrics; profile art credited to **ZwiftHub** on their pages). This avoids browser CORS and keeps the site fast.

1. `npm install` (installs the `cheerio` dev dependency)
2. `npm run scrape:zwift-insider` (takes several minutes; be respectful of their servers)
3. Commit the updated `routes.json` (and adjust `scripts/route-name-overrides.json` if a route fails to match)

If a route name in this app does not match Zwift Insider’s master list, add an entry to `scripts/route-name-overrides.json` mapping the exact `route` string from `routes.json` to a full ZI route URL or slug.
- **Progress Storage**: GitHub Gist (public, synced across devices)
- **Authentication**: GitHub Personal Access Token for editing
- **Strava**: OAuth via serverless function proxy (keeps Client Secret secure)

## Configuration

Edit `app.js` to configure:

- `SHOWCASE_GIST_ID`: Your Gist ID (required)
- `STRAVA_CLIENT_ID`: Your Strava Client ID (optional)
- `STRAVA_TOKEN_PROXY_URL`: Your serverless function URL (optional)

## Security

- Tokens stored in `sessionStorage` (cleared on browser close)
- Strava Client Secret stored in Vercel environment variables (never in code)
- Gist is public (progress visible to anyone with the link)

## Troubleshooting

**Routes not loading**: Ensure `routes.json` exists in the repository root.

**Gist sync issues**: Verify your token has `gist` scope and `SHOWCASE_GIST_ID` is correct.

**Strava integration**: Check that `STRAVA_CLIENT_SECRET` is set in Vercel environment variables and the function URL is correct.
