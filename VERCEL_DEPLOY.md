# Vercel Deployment Guide

Quick guide to deploy the Strava token exchange function to Vercel.

## Prerequisites

- Node.js installed
- Vercel account (free tier works)
- Strava API app created with Client ID and Client Secret

## Step-by-Step Deployment

### 1. Install Vercel CLI

```bash
npm i -g vercel
```

### 2. Login to Vercel

```bash
vercel login
```

Follow the prompts to authenticate.

### 3. Deploy the Project

From your project directory:

```bash
vercel
```

You'll be prompted with:
- **Set up and deploy?** → Yes
- **Which scope?** → Select your account/team
- **Link to existing project?** → No (first time) or Yes (if redeploying)
- **Project name?** → Press Enter for default or enter a custom name
- **Directory?** → Press Enter (current directory)
- **Override settings?** → No

### 4. Set Environment Variable

After the first deployment, set your Strava Client Secret:

```bash
vercel env add STRAVA_CLIENT_SECRET
```

When prompted:
- **What's the value of STRAVA_CLIENT_SECRET?** → Paste your Strava Client Secret
- **Which Environments should it be available for?** → Select "Production" (or all)

### 5. Redeploy with Environment Variable

```bash
vercel --prod
```

This redeploys to production with the environment variable set.

### 6. Get Your Function URL

After deployment, Vercel will show you URLs like:
- `https://your-project-name.vercel.app` (production)
- `https://your-project-name-git-main-your-username.vercel.app` (preview)

Your function will be at:
```
https://your-project-name.vercel.app/api/strava-token
```

### 7. Update app.js

Open `app.js` and update:

```javascript
STRAVA_CLIENT_ID: 'your_client_id_here',
STRAVA_TOKEN_PROXY_URL: 'https://your-project-name.vercel.app/api/strava-token'
```

### 8. Test the Function

You can test if the function is working (it will fail without a real code, but confirms it's accessible):

```bash
curl -X POST https://your-project-name.vercel.app/api/strava-token \
  -H "Content-Type: application/json" \
  -d '{"code":"test","client_id":"test","redirect_uri":"test"}'
```

You should get an error response (not a 404), which means the function is deployed correctly.

## Updating the Function

If you make changes to `api/strava-token.js`:

```bash
vercel --prod
```

## Viewing Logs

To see function logs:

```bash
vercel logs
```

Or view them in the Vercel dashboard under your project > Functions.

## Troubleshooting

### Function returns 500 error
- Check that `STRAVA_CLIENT_SECRET` is set: `vercel env ls`
- Verify the secret value is correct
- Check function logs: `vercel logs` or in dashboard

### Function not found (404)
- Make sure `api/strava-token.js` exists
- Verify the file is in the `api/` directory
- Check that `vercel.json` is in the root directory

### CORS errors
- Vercel functions handle CORS automatically
- If issues persist, check that your GitHub Pages URL matches the redirect URI in your Strava app

## Security Notes

✅ Client Secret is stored securely in Vercel's environment variables  
✅ Never commit the Client Secret to git  
✅ The function only returns access tokens, never the Client Secret  
✅ All communication is over HTTPS

