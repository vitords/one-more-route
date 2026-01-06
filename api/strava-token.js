// Serverless function to securely exchange Strava OAuth code for token
// Deploy this to Vercel, Netlify Functions, or Cloudflare Workers
// Set STRAVA_CLIENT_SECRET as an environment variable in your hosting platform

// CORS headers helper
function setCorsHeaders(res, origin) {
    // Only allow requests from the GitHub Pages domain
    const allowedOrigin = 'https://vitords.github.io';
    
    // Check if the origin matches (or allow if no origin for same-origin requests)
    if (origin === allowedOrigin || !origin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
    return res;
}

export default async function handler(req, res) {
    const origin = req.headers.origin || req.headers.referer;
    
    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
        setCorsHeaders(res, origin);
        return res.status(200).end();
    }
    
    // Only allow POST requests
    if (req.method !== 'POST') {
        setCorsHeaders(res, origin);
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, client_id, redirect_uri } = req.body;

    if (!code || !client_id || !redirect_uri) {
        setCorsHeaders(res, origin);
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get Client Secret from environment variable (never in code!)
    const client_secret = process.env.STRAVA_CLIENT_SECRET;
    if (!client_secret) {
        console.error('STRAVA_CLIENT_SECRET environment variable not set');
        setCorsHeaders(res, origin);
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        // Exchange code for token on server-side (Client Secret stays secure)
        const response = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                client_id,
                client_secret,
                code,
                grant_type: 'authorization_code'
            })
        });

        if (!response.ok) {
            const error = await response.json();
            setCorsHeaders(res, origin);
            return res.status(response.status).json({ 
                error: error.message || 'Failed to exchange token' 
            });
        }

        const data = await response.json();
        
        // Return only the tokens to the client (never the Client Secret)
        setCorsHeaders(res, origin);
        return res.status(200).json({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at
        });
    } catch (error) {
        console.error('Error exchanging Strava token:', error);
        setCorsHeaders(res, origin);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

