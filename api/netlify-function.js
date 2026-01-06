// Netlify Functions version
// Place this file at: netlify/functions/strava-token.js
// Set STRAVA_CLIENT_SECRET in Netlify dashboard: Site settings > Build & deploy > Environment variables

exports.handler = async (event, context) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    const { code, client_id, redirect_uri } = JSON.parse(event.body || '{}');

    if (!code || !client_id || !redirect_uri) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Missing required parameters' })
        };
    }

    // Get Client Secret from environment variable (never in code!)
    const client_secret = process.env.STRAVA_CLIENT_SECRET;
    if (!client_secret) {
        console.error('STRAVA_CLIENT_SECRET environment variable not set');
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error' })
        };
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
            return {
                statusCode: response.status,
                body: JSON.stringify({ 
                    error: error.message || 'Failed to exchange token' 
                })
            };
        }

        const data = await response.json();
        
        // Return only the tokens to the client (never the Client Secret)
        return {
            statusCode: 200,
            body: JSON.stringify({
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: data.expires_at
            })
        };
    } catch (error) {
        console.error('Error exchanging Strava token:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};

