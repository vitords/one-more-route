// Cloudflare Workers version
// Deploy this as a Cloudflare Worker
// Set STRAVA_CLIENT_SECRET in Cloudflare dashboard: Workers & Pages > Your Worker > Settings > Variables

export default {
    async fetch(request, env) {
        // Only allow POST requests
        if (request.method !== 'POST') {
            return new Response(
                JSON.stringify({ error: 'Method not allowed' }),
                { status: 405, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const { code, client_id, redirect_uri } = await request.json();

        if (!code || !client_id || !redirect_uri) {
            return new Response(
                JSON.stringify({ error: 'Missing required parameters' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Get Client Secret from environment variable (never in code!)
        const client_secret = env.STRAVA_CLIENT_SECRET;
        if (!client_secret) {
            console.error('STRAVA_CLIENT_SECRET environment variable not set');
            return new Response(
                JSON.stringify({ error: 'Server configuration error' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
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
                return new Response(
                    JSON.stringify({ 
                        error: error.message || 'Failed to exchange token' 
                    }),
                    { 
                        status: response.status, 
                        headers: { 'Content-Type': 'application/json' } 
                    }
                );
            }

            const data = await response.json();
            
            // Return only the tokens to the client (never the Client Secret)
            return new Response(
                JSON.stringify({
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_at: data.expires_at
                }),
                { 
                    status: 200, 
                    headers: { 'Content-Type': 'application/json' } 
                }
            );
        } catch (error) {
            console.error('Error exchanging Strava token:', error);
            return new Response(
                JSON.stringify({ error: 'Internal server error' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    }
};

