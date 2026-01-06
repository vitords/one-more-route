# Strava Token Exchange Proxy

This directory contains serverless function implementations to securely handle Strava OAuth token exchange.

## Why This Is Needed

The Strava Client Secret must **never** be in client-side code. This serverless function acts as a secure proxy that:
- Receives the OAuth code from the client
- Exchanges it for an access token using the Client Secret (stored securely server-side)
- Returns only the access token to the client

## Deployment Options

### Vercel (Recommended)

1. Install Vercel CLI: `npm i -g vercel`
2. Deploy: `vercel`
3. Set environment variable:
   ```bash
   vercel env add STRAVA_CLIENT_SECRET
   ```
4. Your function will be at: `https://your-app.vercel.app/api/strava-token`

### Netlify Functions

1. Create `netlify/functions/strava-token.js` (copy from `api/netlify-function.js`)
2. Deploy to Netlify
3. In Netlify dashboard: Site settings > Environment variables
4. Add `STRAVA_CLIENT_SECRET`
5. Your function will be at: `https://your-site.netlify.app/.netlify/functions/strava-token`

### Cloudflare Workers

1. Install Wrangler: `npm i -g wrangler`
2. Create `wrangler.toml`:
   ```toml
   name = "strava-token-proxy"
   main = "api/cloudflare-worker.js"
   ```
3. Deploy: `wrangler publish`
4. Set secret: `wrangler secret put STRAVA_CLIENT_SECRET`
5. Your worker URL will be shown after deployment

## Security

- ✅ Client Secret stored in environment variables (never in code)
- ✅ Only the access token is returned to the client
- ✅ Server-side validation and error handling
- ✅ HTTPS required for all communications

## Testing

Test the function with:
```bash
curl -X POST https://your-function-url/api/strava-token \
  -H "Content-Type: application/json" \
  -d '{"code":"test_code","client_id":"your_client_id","redirect_uri":"your_redirect_uri"}'
```

Note: This will fail with a real test code, but verifies the function is accessible.

