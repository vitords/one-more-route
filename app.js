// Configuration
const CONFIG = {
    GIST_ID_KEY: 'zwift_tracker_gist_id',
    TOKEN_KEY: 'zwift_tracker_token',
    GIST_FILENAME: 'zwift_routes.json',
    LOCAL_STORAGE_KEY: 'zwift_tracker_completed_routes',
    STRAVA_TOKEN_KEY: 'zwift_tracker_strava_token',
    STRAVA_REFRESH_TOKEN_KEY: 'zwift_tracker_strava_refresh_token',
    STRAVA_ACTIVITIES_CACHE_KEY: 'zwift_tracker_strava_activities_cache',
    // Strava OAuth
    STRAVA_CLIENT_ID: '194117',
    STRAVA_REDIRECT_URI: window.location.origin + window.location.pathname,
    // Token exchange endpoint - must be a serverless function that keeps Client Secret secure
    STRAVA_TOKEN_PROXY_URL: 'https://one-more-route.vercel.app/api/strava-token',
    // Showcase Gist ID - for public viewing (set this to your Gist ID)
    SHOWCASE_GIST_ID: '5a5c3c849409700679ee32ae772c137e' // Set this to your Gist ID for public showcase
};

// State
let routes = [];
let completedRoutes = new Set();
let routeActivities = {}; // Map of route name -> activity data
let filteredRoutes = [];
let currentFilter = 'all';
let searchQuery = '';
let isAuthenticated = false;
let isStravaAuthenticated = false;
let gistId = null;
let syncTimeout = null;
let isSyncing = false;

// Route detection - determine if we're in edit mode
const isEditMode = (() => {
    const pathname = window.location.pathname;
    const search = window.location.search;
    return pathname.includes('/edit') || 
           pathname.endsWith('edit.html') ||
           search.includes('edit=true');
})();

// DOM Elements (may be null in showcase mode)
const routesContainer = document.getElementById('routes-container');
const authBtn = document.getElementById('auth-btn');
const authStatus = document.getElementById('auth-status');
const authModal = document.getElementById('auth-modal');
const tokenInput = document.getElementById('token-input');
const tokenSubmit = document.getElementById('token-submit');
const gistIdInput = document.getElementById('gist-id-input');
const gistSubmit = document.getElementById('gist-submit');
const gistSetup = document.getElementById('gist-setup');
const searchInput = document.getElementById('search-input');
const filterBtns = document.querySelectorAll('.filter-btn');

// Initialize based on mode
async function init() {
    if (isEditMode) {
        await initEdit();
    } else {
        await initShowcase();
    }
}

// Initialize showcase mode (public viewing)
async function initShowcase() {
    // Hide edit-related UI
    hideEditUI();
    
    // Show navigation to edit page
    showNavigation();
    
    // Load routes
    await loadRoutes();
    
    // Load data from public Gist (no auth required)
    const showcaseGistId = CONFIG.SHOWCASE_GIST_ID || getGistIdFromURL();
    if (showcaseGistId) {
        await loadShowcaseData(showcaseGistId);
    } else {
        if (routesContainer) {
            routesContainer.innerHTML = '<div class="loading">Showcase Gist ID not configured. Please set CONFIG.SHOWCASE_GIST_ID in app.js or add ?gist=YOUR_GIST_ID to the URL</div>';
        }
        return;
    }
    
    // Render routes (read-only)
    renderRoutes();
    updateStats();
    
    // Setup event listeners (only for showcase features)
    setupShowcaseEventListeners();
}

// Initialize edit mode (authenticated editing)
async function initEdit() {
    // Show edit-related UI
    showEditUI();
    
    // Show navigation to showcase
    showNavigation();
    
    // Check for Strava OAuth callback
    handleStravaCallback();
    
    // Load saved Gist ID and token from localStorage
    gistId = localStorage.getItem(CONFIG.GIST_ID_KEY);
    const savedToken = sessionStorage.getItem(CONFIG.TOKEN_KEY);
    
    if (savedToken) {
        isAuthenticated = true;
        updateAuthUI();
    }
    
    // Check Strava authentication
    const stravaToken = sessionStorage.getItem(CONFIG.STRAVA_TOKEN_KEY);
    if (stravaToken) {
        isStravaAuthenticated = true;
        updateStravaAuthUI();
    }
    
    if (gistId && gistIdInput) {
        gistIdInput.value = gistId;
    }

    // Load routes
    await loadRoutes();
    
    // Load completed routes (localStorage first for instant load, then sync from Gist)
    loadCompletedRoutesFromLocal();
    
    // Load completed routes from Gist in background (for multi-device sync)
    if (gistId) {
        loadCompletedRoutes(); // Don't await - load in background
    }
    
    // Render routes
    renderRoutes();
    updateStats();
    
    // Setup event listeners (full functionality)
    setupEventListeners();
}

// Get Gist ID from URL parameter (optional)
function getGistIdFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('gist');
}

// Load showcase data from public Gist (no authentication required)
async function loadShowcaseData(gistId) {
    if (!gistId) {
        console.error('No Gist ID provided for showcase');
        if (routesContainer) {
            routesContainer.innerHTML = '<div class="loading">No Gist ID provided.</div>';
        }
        return;
    }
    
    try {
        const response = await fetch(`https://api.github.com/gists/${gistId}`);
        if (!response.ok) {
            if (response.status === 404) {
                if (routesContainer) {
                    routesContainer.innerHTML = '<div class="loading">Gist not found. Please check the Gist ID.</div>';
                }
                return;
            }
            throw new Error('Failed to load Gist');
        }
        
        const gist = await response.json();
        const file = gist.files[CONFIG.GIST_FILENAME];
        
        if (file && file.content) {
            const data = JSON.parse(file.content);
            completedRoutes = new Set(data.completedRoutes || []);
            routeActivities = data.activities || {};
            
            renderRoutes();
            updateStats();
        } else {
            if (routesContainer) {
                routesContainer.innerHTML = '<div class="loading">No route data found in Gist.</div>';
            }
        }
    } catch (error) {
        console.error('Error loading showcase data:', error);
        if (routesContainer) {
            routesContainer.innerHTML = '<div class="loading">Error loading showcase data. Please refresh the page.</div>';
        }
    }
}

// Load routes from JSON file
async function loadRoutes() {
    try {
        const response = await fetch('routes.json');
        if (!response.ok) throw new Error('Failed to load routes');
        routes = await response.json();
        filteredRoutes = routes;
    } catch (error) {
        console.error('Error loading routes:', error);
        routesContainer.innerHTML = '<div class="loading">Error loading routes. Please refresh the page.</div>';
    }
}

// Load completed routes from localStorage (instant)
function loadCompletedRoutesFromLocal() {
    try {
        const saved = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            completedRoutes = new Set(data.completedRoutes || []);
            routeActivities = data.activities || {};
            renderRoutes();
            updateStats();
        }
    } catch (error) {
        console.error('Error loading from localStorage:', error);
    }
}

// Load completed routes from GitHub Gist (background sync)
async function loadCompletedRoutes() {
    if (!gistId) return;
    
    try {
        const response = await fetch(`https://api.github.com/gists/${gistId}`);
        if (!response.ok) {
            if (response.status === 404) {
                console.log('Gist not found, will create new one on first save');
                return;
            }
            throw new Error('Failed to load Gist');
        }
        
        const gist = await response.json();
        const file = gist.files[CONFIG.GIST_FILENAME];
        
        if (file && file.content) {
            const data = JSON.parse(file.content);
            const gistRoutes = new Set(data.completedRoutes || []);
            const gistActivities = data.activities || {};
            
            // Merge with local storage (local takes precedence for conflicts)
            const localSaved = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (localSaved) {
                const localData = JSON.parse(localSaved);
                const localRoutes = new Set(localData.completedRoutes || []);
                // Merge: union of both sets (if local has it, keep it; if gist has it, add it)
                completedRoutes = new Set([...localRoutes, ...gistRoutes]);
                // Merge activities (local takes precedence)
                routeActivities = { ...gistActivities, ...(localData.activities || {}) };
            } else {
                completedRoutes = gistRoutes;
                routeActivities = gistActivities;
            }
            
            // Save merged data back to localStorage
            saveCompletedRoutesToLocal();
            
            renderRoutes();
            updateStats();
            updateSyncStatus('synced');
        }
    } catch (error) {
        console.error('Error loading completed routes from Gist:', error);
        updateSyncStatus('error');
    }
}

// Save completed routes to localStorage (instant)
function saveCompletedRoutesToLocal() {
    try {
        const data = {
            completedRoutes: Array.from(completedRoutes),
            activities: routeActivities,
            lastUpdated: Date.now()
        };
        localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        console.error('Error saving to localStorage:', error);
    }
}

// Save completed routes to GitHub Gist (background sync with debouncing)
async function saveCompletedRoutes() {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] saveCompletedRoutes: Starting save process`);
    
    // Save to localStorage immediately for instant feedback
    saveCompletedRoutesToLocal();
    console.log(`[${timestamp}] saveCompletedRoutes: Saved to localStorage`);
    
    if (!isAuthenticated) {
        console.log(`[${timestamp}] saveCompletedRoutes: Not authenticated, skipping Gist sync`);
        return; // Don't show alert, just save locally
    }
    
    const token = sessionStorage.getItem(CONFIG.TOKEN_KEY);
    if (!token) {
        console.log(`[${timestamp}] saveCompletedRoutes: No token found, skipping Gist sync`);
        return; // Save locally only
    }
    
    // Clear existing timeout
    if (syncTimeout) {
        clearTimeout(syncTimeout);
        console.log(`[${timestamp}] saveCompletedRoutes: Cleared previous sync timeout`);
    }
    
    // Debounce: wait 1 second before syncing to Gist (batch multiple changes)
    console.log(`[${timestamp}] saveCompletedRoutes: Scheduling Gist sync in 1 second (debounce)`);
    syncTimeout = setTimeout(async () => {
        await syncToGist(token);
    }, 1000);
}

// Actually sync to Gist (called after debounce)
async function syncToGist(token) {
    const timestamp = new Date().toISOString();
    
    if (isSyncing) {
        console.log(`[${timestamp}] syncToGist: Already syncing, skipping duplicate request`);
        return; // Already syncing, skip
    }
    
    isSyncing = true;
    updateSyncStatus('syncing');
    console.log(`[${timestamp}] syncToGist: Starting sync to Gist`);
    console.log(`[${timestamp}] syncToGist: Completed routes: ${completedRoutes.size}, Activities: ${Object.keys(routeActivities).length}`);
    
    const data = {
        completedRoutes: Array.from(completedRoutes),
        activities: routeActivities
    };
    
    try {
        let gist;
        
        // If no Gist ID is set, create a new Gist
        if (!gistId) {
            console.log(`[${timestamp}] syncToGist: No Gist ID, creating new Gist`);
            const response = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    description: 'One More Route - Completed Routes',
                    public: true,
                    files: {
                        [CONFIG.GIST_FILENAME]: {
                            content: JSON.stringify(data, null, 2)
                        }
                    }
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                console.error(`[${timestamp}] syncToGist: Failed to create Gist - Status: ${response.status}`, error);
                throw new Error(error.message || 'Failed to create Gist');
            }
            
            gist = await response.json();
            gistId = gist.id;
            localStorage.setItem(CONFIG.GIST_ID_KEY, gistId);
            if (gistIdInput) {
                gistIdInput.value = gistId;
            }
            console.log(`[${timestamp}] syncToGist: ✓ Created new Gist: ${gistId}`);
        } else {
            console.log(`[${timestamp}] syncToGist: Gist ID exists (${gistId}), checking if it exists`);
            // Check if Gist exists
            let response = await fetch(`https://api.github.com/gists/${gistId}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (response.status === 404) {
                console.log(`[${timestamp}] syncToGist: Gist not found (404), creating new one`);
                // Gist doesn't exist, create a new one
                response = await fetch('https://api.github.com/gists', {
                    method: 'POST',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        description: 'One More Route - Completed Routes',
                        public: true,
                        files: {
                            [CONFIG.GIST_FILENAME]: {
                                content: JSON.stringify(data, null, 2)
                            }
                        }
                    })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    console.error(`[${timestamp}] syncToGist: Failed to create replacement Gist - Status: ${response.status}`, error);
                    throw new Error(error.message || 'Failed to create Gist');
                }
                
                gist = await response.json();
                gistId = gist.id;
                localStorage.setItem(CONFIG.GIST_ID_KEY, gistId);
                if (gistIdInput) {
                    gistIdInput.value = gistId;
                }
                console.log(`[${timestamp}] syncToGist: ✓ Created replacement Gist: ${gistId}`);
            } else {
                // Update existing Gist
                if (!response.ok) {
                    const error = await response.json();
                    console.error(`[${timestamp}] syncToGist: Failed to check Gist - Status: ${response.status}`, error);
                    throw new Error(error.message || 'Failed to update Gist');
                }
                
                console.log(`[${timestamp}] syncToGist: Gist exists, updating with PATCH request`);
                response = await fetch(`https://api.github.com/gists/${gistId}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        files: {
                            [CONFIG.GIST_FILENAME]: {
                                content: JSON.stringify(data, null, 2)
                            }
                        }
                    })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    console.error(`[${timestamp}] syncToGist: Failed to update Gist - Status: ${response.status}`, error);
                    throw new Error(error.message || 'Failed to update Gist');
                }
                
                console.log(`[${timestamp}] syncToGist: ✓ Successfully updated Gist: ${gistId}`);
            }
        }
        
        const endTimestamp = new Date().toISOString();
        console.log(`[${endTimestamp}] syncToGist: ✓ Sync completed successfully`);
        updateSyncStatus('synced');
    } catch (error) {
        const errorTimestamp = new Date().toISOString();
        console.error(`[${errorTimestamp}] syncToGist: ✗ Error syncing to Gist:`, error);
        console.error(`[${errorTimestamp}] syncToGist: Error details:`, {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        updateSyncStatus('error');
        // Don't show alert - just log error, local storage already saved
    } finally {
        isSyncing = false;
        const finalTimestamp = new Date().toISOString();
        console.log(`[${finalTimestamp}] syncToGist: Sync process finished, isSyncing = false`);
    }
}

// Update sync status indicator
let syncStatusTimeout = null;

function updateSyncStatus(status) {
    if (!authStatus) return;
    
    // Clear any existing timeout
    if (syncStatusTimeout) {
        clearTimeout(syncStatusTimeout);
        syncStatusTimeout = null;
    }
    
    const statusText = {
        'syncing': '⏳ Syncing...',
        'synced': '✓ Synced',
        'error': '⚠ Sync failed (saved locally)'
    };
    
    const statusColor = {
        'syncing': 'var(--text-secondary)',
        'synced': 'var(--completed)',
        'error': '#f85149'
    };
    
    if (status === 'synced') {
        authStatus.textContent = statusText['synced'];
        authStatus.style.color = statusColor['synced'];
        
        // Clear status after 2 seconds
        syncStatusTimeout = setTimeout(() => {
            if (authStatus && authStatus.textContent === statusText['synced']) {
                authStatus.textContent = isAuthenticated ? '✓ Authenticated' : '';
                authStatus.style.color = isAuthenticated ? 'var(--completed)' : '';
            }
            syncStatusTimeout = null;
        }, 2000);
    } else {
        authStatus.textContent = statusText[status] || '';
        authStatus.style.color = statusColor[status] || 'var(--text-secondary)';
    }
}

// ==================== Strava OAuth Functions ====================

// Handle Strava OAuth callback
function handleStravaCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const error = urlParams.get('error');
    
    if (error) {
        console.error('Strava OAuth error:', error);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
    }
    
    if (code) {
        // Exchange code for token
        exchangeStravaToken(code);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// Initiate Strava OAuth flow
function connectStrava() {
    if (!CONFIG.STRAVA_CLIENT_ID) {
        alert('Strava Client ID not configured. Please set CONFIG.STRAVA_CLIENT_ID in app.js');
        return;
    }
    
    const scope = 'activity:read,activity:read_all';
    const redirectUri = encodeURIComponent(CONFIG.STRAVA_REDIRECT_URI);
    const clientId = CONFIG.STRAVA_CLIENT_ID;
    const responseType = 'code';
    const approvalPrompt = 'force';
    
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=${responseType}&scope=${scope}&approval_prompt=${approvalPrompt}`;
    
    window.location.href = authUrl;
}

// Exchange authorization code for access token via secure proxy
async function exchangeStravaToken(code) {
    if (!CONFIG.STRAVA_CLIENT_ID) {
        alert('Strava Client ID not configured. Please set CONFIG.STRAVA_CLIENT_ID in app.js');
        return;
    }
    
    if (!CONFIG.STRAVA_TOKEN_PROXY_URL) {
        alert('Strava token proxy URL not configured. Please set up a serverless function and set CONFIG.STRAVA_TOKEN_PROXY_URL in app.js');
        return;
    }
    
    try {
        // Call our secure serverless function proxy instead of Strava directly
        // The proxy will handle the Client Secret securely server-side
        const response = await fetch(CONFIG.STRAVA_TOKEN_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: code,
                client_id: CONFIG.STRAVA_CLIENT_ID,
                redirect_uri: CONFIG.STRAVA_REDIRECT_URI
            })
        });
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to exchange token' }));
            throw new Error(error.message || 'Failed to exchange token');
        }
        
        const data = await response.json();
        sessionStorage.setItem(CONFIG.STRAVA_TOKEN_KEY, data.access_token);
        if (data.refresh_token) {
            sessionStorage.setItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY, data.refresh_token);
        }
        
        isStravaAuthenticated = true;
        updateStravaAuthUI();
        console.log('Strava authentication successful');
    } catch (error) {
        console.error('Error exchanging Strava token:', error);
        alert(`Failed to authenticate with Strava: ${error.message}`);
    }
}

// Get Strava access token (with refresh if needed)
async function getStravaToken() {
    let token = sessionStorage.getItem(CONFIG.STRAVA_TOKEN_KEY);
    if (!token) {
        return null;
    }
    
    // TODO: Check token expiration and refresh if needed
    // For now, just return the token
    return token;
}

// ==================== Strava API Client Functions ====================

// Fetch activity details from Strava API
async function fetchStravaActivity(activityId) {
    const token = await getStravaToken();
    if (!token) {
        throw new Error('Not authenticated with Strava');
    }
    
    // Check cache first
    const cacheKey = `strava_activity_${activityId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        const cachedData = JSON.parse(cached);
        // Use cache if less than 1 hour old
        if (Date.now() - cachedData.timestamp < 3600000) {
            return cachedData.data;
        }
    }
    
    try {
        const response = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, need to re-authenticate
                sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
                isStravaAuthenticated = false;
                updateStravaAuthUI();
                throw new Error('Strava authentication expired. Please reconnect.');
            }
            throw new Error(`Failed to fetch activity: ${response.statusText}`);
        }
        
        const activity = await response.json();
        
        // Cache the activity
        localStorage.setItem(cacheKey, JSON.stringify({
            data: activity,
            timestamp: Date.now()
        }));
        
        return activity;
    } catch (error) {
        console.error('Error fetching Strava activity:', error);
        throw error;
    }
}

// Fetch recent activities from Strava
async function fetchRecentStravaActivities(perPage = 30) {
    const token = await getStravaToken();
    if (!token) {
        throw new Error('Not authenticated with Strava');
    }
    
    try {
        const response = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
                isStravaAuthenticated = false;
                updateStravaAuthUI();
                throw new Error('Strava authentication expired. Please reconnect.');
            }
            throw new Error(`Failed to fetch activities: ${response.statusText}`);
        }
        
        const activities = await response.json();
        return activities;
    } catch (error) {
        console.error('Error fetching Strava activities:', error);
        throw error;
    }
}

// Extract activity ID from Strava URL
function extractActivityId(urlOrId) {
    if (!urlOrId) return null;
    
    // If it's just a number, return it
    if (/^\d+$/.test(urlOrId)) {
        return urlOrId;
    }
    
    // Extract from URL
    const match = urlOrId.match(/activities\/(\d+)/);
    return match ? match[1] : null;
}

// Link activity to route
async function linkActivityToRoute(routeName, activityIdOrUrl) {
    const activityId = extractActivityId(activityIdOrUrl);
    if (!activityId) {
        throw new Error('Invalid activity ID or URL');
    }
    
    try {
        // Fetch activity details
        const activity = await fetchStravaActivity(activityId);
        
        // Store activity data
        routeActivities[routeName] = {
            activityId: activity.id,
            activityUrl: `https://www.strava.com/activities/${activity.id}`,
            name: activity.name,
            distance: activity.distance,
            movingTime: activity.moving_time,
            elapsedTime: activity.elapsed_time,
            totalElevationGain: activity.total_elevation_gain,
            averageSpeed: activity.average_speed,
            maxSpeed: activity.max_speed,
            averageWatts: activity.average_watts,
            weightedAverageWatts: activity.weighted_average_watts,
            averageHeartrate: activity.average_heartrate,
            maxHeartrate: activity.max_heartrate,
            calories: activity.calories,
            startDate: activity.start_date,
            fetchedAt: new Date().toISOString()
        };
        
        // Save immediately
        saveCompletedRoutesToLocal();
        await saveCompletedRoutes();
        
        // Re-render to show activity
        renderRoutes();
        
        return routeActivities[routeName];
    } catch (error) {
        console.error('Error linking activity:', error);
        throw error;
    }
}

// Unlink activity from route
function unlinkActivityFromRoute(routeName) {
    delete routeActivities[routeName];
    saveCompletedRoutesToLocal();
    saveCompletedRoutes();
    renderRoutes();
}

// Update Strava auth UI
function updateStravaAuthUI() {
    const stravaBtn = document.getElementById('strava-connect-btn');
    const stravaStatus = document.getElementById('strava-status');
    
    if (stravaBtn && stravaStatus) {
        if (isStravaAuthenticated) {
            stravaBtn.textContent = 'Disconnect Strava';
            stravaStatus.textContent = '✓ Connected';
            stravaStatus.style.color = 'var(--completed)';
        } else {
            stravaBtn.textContent = 'Connect Strava';
            stravaStatus.textContent = '';
        }
    }
}

// Render routes grouped by map
function renderRoutes() {
    // Filter routes based on current filter and search
    filteredRoutes = routes.filter(route => {
        const matchesFilter = currentFilter === 'all' ||
            (currentFilter === 'completed' && completedRoutes.has(route.route)) ||
            (currentFilter === 'remaining' && !completedRoutes.has(route.route));
        
        const matchesSearch = !searchQuery || 
            route.route.toLowerCase().includes(searchQuery.toLowerCase()) ||
            route.map.toLowerCase().includes(searchQuery.toLowerCase());
        
        return matchesFilter && matchesSearch;
    });
    
    // Group by map
    const grouped = filteredRoutes.reduce((acc, route) => {
        if (!acc[route.map]) {
            acc[route.map] = [];
        }
        acc[route.map].push(route);
        return acc;
    }, {});
    
    // Render
    routesContainer.innerHTML = '';
    
    if (filteredRoutes.length === 0) {
        routesContainer.innerHTML = '<div class="loading">No routes match your filters.</div>';
        return;
    }
    
    Object.keys(grouped).sort().forEach(map => {
        const mapGroup = document.createElement('div');
        mapGroup.className = 'map-group';
        
        const routesInMap = grouped[map];
        const completedInMap = routesInMap.filter(r => completedRoutes.has(r.route)).length;
        
        const header = document.createElement('div');
        header.className = 'map-header';
        header.innerHTML = `
            <div>
                <div class="map-title">${map}</div>
                <div class="map-stats">${completedInMap} / ${routesInMap.length} completed</div>
            </div>
            <span class="collapse-icon">▼</span>
        `;
        
        const content = document.createElement('div');
        content.className = 'map-content';
        
        routesInMap.forEach(route => {
            const card = createRouteCard(route);
            content.appendChild(card);
        });
        
        header.addEventListener('click', () => {
            content.classList.toggle('collapsed');
            const icon = header.querySelector('.collapse-icon');
            icon.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
        });
        
        mapGroup.appendChild(header);
        mapGroup.appendChild(content);
        routesContainer.appendChild(mapGroup);
    });
}

// Create a route card element
function createRouteCard(route) {
    const card = document.createElement('div');
    card.className = `route-card ${completedRoutes.has(route.route) ? 'completed' : ''}`;
    
    const isCompleted = completedRoutes.has(route.route);
    const activity = routeActivities[route.route];
    const hasActivity = !!activity;
    
    // Add tooltip for completed routes with activities
    if (hasActivity && activity.startDate) {
        const completedDate = formatCompletedDate(activity.startDate);
        if (completedDate) {
            card.setAttribute('title', `Completed on ${completedDate}`);
        }
    }
    
    // Show checkbox only in edit mode
    const checkboxHTML = isEditMode ? `
        <input 
            type="checkbox" 
            class="route-checkbox" 
            ${isCompleted ? 'checked' : ''}
            ${!isAuthenticated ? 'disabled' : ''}
            data-route="${route.route}"
        >
    ` : '';
    
    card.innerHTML = `
        <div class="route-header">
            <div class="route-name">${route.route}</div>
            <div class="route-header-actions">
                ${checkboxHTML}
            </div>
        </div>
        <div class="route-details">
            <div class="route-detail">
                <div class="route-detail-label">Length</div>
                <div class="route-detail-value">${route.length} km</div>
            </div>
            <div class="route-detail">
                <div class="route-detail-label">Elevation</div>
                <div class="route-detail-value">${route.elevation} m</div>
            </div>
            <div class="route-detail">
                <div class="route-detail-label">Lead-In</div>
                <div class="route-detail-value">${route.leadIn} km</div>
            </div>
        </div>
        ${hasActivity ? `
            <div class="route-activity-section">
                <div class="activity-header">
                    <button class="btn-view-activity" data-route="${route.route}">
                        <img src="https://d3nn82uaxijpm6.cloudfront.net/assets/website_v2/svgs/strava-orange-b3599d0edada6b7203f021e9c1e34a63.svg" alt="Strava" class="strava-logo-inline">
                        <span>View activity</span>
                    </button>
                    ${isEditMode ? `<button class="btn-unlink-activity" data-route="${route.route}" title="Unlink activity">✕</button>` : ''}
                </div>
            </div>
        ` : isCompleted && isEditMode ? `
            <div class="route-activity-section">
                <div class="activity-link-section">
                    <button class="btn-link-activity" data-route="${route.route}">
                        ${isStravaAuthenticated ? '🔗 Link Strava Activity' : '🔗 Connect Strava to Link Activity'}
                    </button>
                </div>
            </div>
        ` : ''}
    `;
    
    // Only attach checkbox event listener in edit mode
    const checkbox = card.querySelector('.route-checkbox');
    if (checkbox && isEditMode) {
        checkbox.addEventListener('change', async (e) => {
        const wasChecked = e.target.checked;
        const routeName = route.route;
        
        // Update the set first
        if (wasChecked) {
            completedRoutes.add(routeName);
        } else {
            completedRoutes.delete(routeName);
        }
        
        // Update the current card's visual state immediately
        if (wasChecked) {
            card.classList.add('completed');
            const routeNameEl = card.querySelector('.route-name');
            if (routeNameEl) {
                routeNameEl.style.textDecoration = 'line-through';
                routeNameEl.style.opacity = '0.7';
            }
            
            // Immediately show activity link section if it doesn't exist
            let activitySection = card.querySelector('.route-activity-section');
            if (!activitySection) {
                activitySection = document.createElement('div');
                activitySection.className = 'route-activity-section';
                
                const activity = routeActivities[routeName];
                const hasActivity = !!activity;
                
                if (hasActivity) {
                    activitySection.innerHTML = `
                        <div class="activity-header">
                            <button class="btn-view-activity" data-route="${routeName}">
                                <img src="https://d3nn82uaxijpm6.cloudfront.net/assets/website_v2/svgs/strava-orange-b3599d0edada6b7203f021e9c1e34a63.svg" alt="Strava" class="strava-logo-inline">
                                <span>View activity</span>
                            </button>
                            ${isEditMode ? `<button class="btn-unlink-activity" data-route="${routeName}" title="Unlink activity">✕</button>` : ''}
                        </div>
                    `;
                } else {
                    activitySection.innerHTML = `
                        <div class="activity-link-section">
                            <button class="btn-link-activity" data-route="${routeName}">
                                ${isStravaAuthenticated ? '🔗 Link Strava Activity' : '🔗 Connect Strava to Link Activity'}
                            </button>
                        </div>
                    `;
                }
                
                // Insert after route-details
                const routeDetails = card.querySelector('.route-details');
                if (routeDetails) {
                    routeDetails.insertAdjacentElement('afterend', activitySection);
                } else {
                    card.appendChild(activitySection);
                }
                
                // Attach event listeners to the new elements
                if (isEditMode) {
                    const linkBtn = activitySection.querySelector('.btn-link-activity');
                    if (linkBtn) {
                        linkBtn.addEventListener('click', () => {
                            if (!isStravaAuthenticated) {
                                connectStrava();
                            } else {
                                openActivityModal(routeName);
                            }
                        });
                    }
                    
                    const unlinkBtn = activitySection.querySelector('.btn-unlink-activity');
                    if (unlinkBtn) {
                        unlinkBtn.addEventListener('click', () => {
                            if (confirm('Unlink this Strava activity?')) {
                                unlinkActivityFromRoute(routeName);
                            }
                        });
                    }
                    
                    const viewBtn = activitySection.querySelector('.btn-view-activity');
                    if (viewBtn) {
                        viewBtn.addEventListener('click', () => {
                            const activity = routeActivities[routeName];
                            if (activity) {
                                showActivityDetailsModal(activity, routeName);
                            }
                        });
                    }
                }
            }
        } else {
            card.classList.remove('completed');
            const routeNameEl = card.querySelector('.route-name');
            if (routeNameEl) {
                routeNameEl.style.textDecoration = 'none';
                routeNameEl.style.opacity = '1';
            }
            
            // Remove activity section if route is unchecked
            const activitySection = card.querySelector('.route-activity-section');
            if (activitySection) {
                activitySection.remove();
            }
        }
        
        // Update stats immediately
        updateStats();
        
        // Update map stats in the header
        updateMapStats();
        
        // Save to localStorage immediately
        saveCompletedRoutesToLocal();
        
        // Re-render only if we're in a filtered view (completed/remaining)
        // This ensures routes appear/disappear correctly in filtered views
        if (currentFilter !== 'all') {
            // Use setTimeout to ensure the DOM update happens after the checkbox state is set
            setTimeout(() => {
                renderRoutes();
            }, 0);
        }
        
        // Sync to Gist in background (don't await - let it happen in background)
        saveCompletedRoutes();
        });
    }
    
    // Activity linking/unlinking handlers (only in edit mode)
    if (isCompleted && isEditMode) {
        const linkBtn = card.querySelector('.btn-link-activity');
        if (linkBtn) {
            linkBtn.addEventListener('click', () => {
                if (!isStravaAuthenticated) {
                    connectStrava();
                } else {
                    openActivityModal(route.route);
                }
            });
        }
        
        const unlinkBtn = card.querySelector('.btn-unlink-activity');
        if (unlinkBtn) {
            unlinkBtn.addEventListener('click', () => {
                if (confirm('Unlink this Strava activity?')) {
                    unlinkActivityFromRoute(route.route);
                }
            });
        }
    }
    
    // View activity button (works in both modes - opens modal)
    const viewBtn = card.querySelector('.btn-view-activity');
    if (viewBtn) {
        viewBtn.addEventListener('click', () => {
            const routeName = viewBtn.getAttribute('data-route');
            const activity = routeActivities[routeName];
            if (activity) {
                showActivityDetailsModal(activity, routeName);
            }
        });
    }
    
    return card;
}

// Render activity details HTML
function renderActivityDetails(activity) {
    const formatTime = (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        if (hours > 0) {
            return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    const formatDistance = (meters) => {
        return (meters / 1000).toFixed(2) + ' km';
    };
    
    const formatSpeed = (mps) => {
        return (mps * 3.6).toFixed(1) + ' km/h';
    };
    
    const completedDate = activity.startDate ? formatCompletedDate(activity.startDate) : '';
    
    return `
        <div class="activity-info">
            <div class="activity-name">
                <a href="${activity.activityUrl}" target="_blank" rel="noopener noreferrer">
                    ${activity.name || 'Strava Activity'}
                </a>
            </div>
            ${completedDate ? `
            <div class="activity-completed-date">
                Completed on ${completedDate}
            </div>
            ` : ''}
            <div class="activity-stats-grid">
                <div class="activity-stat">
                    <div class="activity-stat-label">Distance</div>
                    <div class="activity-stat-value">${formatDistance(activity.distance)}</div>
                </div>
                <div class="activity-stat">
                    <div class="activity-stat-label">Moving Time</div>
                    <div class="activity-stat-value">${formatTime(activity.movingTime)}</div>
                </div>
                <div class="activity-stat">
                    <div class="activity-stat-label">Elapsed Time</div>
                    <div class="activity-stat-value">${formatTime(activity.elapsedTime)}</div>
                </div>
                ${activity.totalElevationGain ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Elevation Gain</div>
                    <div class="activity-stat-value">${Math.round(activity.totalElevationGain)} m</div>
                </div>
                ` : ''}
                ${activity.averageSpeed ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Avg Speed</div>
                    <div class="activity-stat-value">${formatSpeed(activity.averageSpeed)}</div>
                </div>
                ` : ''}
                ${activity.maxSpeed ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Max Speed</div>
                    <div class="activity-stat-value">${formatSpeed(activity.maxSpeed)}</div>
                </div>
                ` : ''}
                ${activity.averageWatts ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Avg Power</div>
                    <div class="activity-stat-value">${Math.round(activity.averageWatts)} W</div>
                </div>
                ` : ''}
                ${activity.weightedAverageWatts ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Weighted Avg Power</div>
                    <div class="activity-stat-value">${Math.round(activity.weightedAverageWatts)} W</div>
                </div>
                ` : ''}
                ${activity.averageHeartrate ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Avg Heart Rate</div>
                    <div class="activity-stat-value">${activity.averageHeartrate} bpm</div>
                </div>
                ` : ''}
                ${activity.maxHeartrate ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Max Heart Rate</div>
                    <div class="activity-stat-value">${activity.maxHeartrate} bpm</div>
                </div>
                ` : ''}
                ${activity.calories ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Calories</div>
                    <div class="activity-stat-value">${activity.calories}</div>
                </div>
                ` : ''}
            </div>
            <div class="activity-footer">
                <a href="${activity.activityUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-strava btn-small">
                    <img src="https://d3nn82uaxijpm6.cloudfront.net/assets/website_v2/svgs/strava-orange-b3599d0edada6b7203f021e9c1e34a63.svg" alt="Strava" class="strava-logo-inline">
                    <span>View on Strava</span>
                    <span>→</span>
                </a>
            </div>
        </div>
    `;
}

// Show activity details in modal
function showActivityDetailsModal(activity, routeName) {
    const modal = document.getElementById('activity-details-modal');
    const title = document.getElementById('activity-details-title');
    const content = document.getElementById('activity-details-content');
    
    if (!modal || !title || !content) return;
    
    // Find route details for the modal title
    const route = routes.find(r => r.route === routeName);
    const routeDetails = route ? `${route.length} km • ${route.elevation} m` : '';
    
    title.innerHTML = `
        <span class="modal-title-text">
            <span class="modal-title-route">${routeName}</span>
            ${routeDetails ? `<span class="modal-title-details">${routeDetails}</span>` : ''}
        </span>
    `;
    content.innerHTML = renderActivityDetails(activity);
    
    // Ensure close button works (set up event listener if not already set)
    const closeBtn = modal.querySelector('.close-activity-details');
    if (closeBtn) {
        // Remove any existing listeners by cloning and replacing
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        
        newCloseBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }
    
    // Close on outside click
    const handleOutsideClick = (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
            modal.removeEventListener('click', handleOutsideClick);
        }
    };
    modal.addEventListener('click', handleOutsideClick);
    
    modal.style.display = 'block';
}

// Open activity linking modal
function openActivityModal(routeName) {
    const modal = document.getElementById('activity-modal');
    const routeNameEl = modal.querySelector('h2');
    if (routeNameEl) {
        routeNameEl.textContent = `Link Strava Activity - ${routeName}`;
    }
    modal.dataset.route = routeName;
    modal.style.display = 'block';
    
    // Clear previous input
    const activityInput = document.getElementById('activity-input');
    if (activityInput) {
        activityInput.value = '';
    }
    
    // Clear status
    const statusEl = document.getElementById('activity-linking-status');
    if (statusEl) {
        statusEl.textContent = '';
    }
    
    // Show/hide recent activities option based on Strava auth
    const recentActivitiesOption = document.getElementById('recent-activities-option');
    if (recentActivitiesOption) {
        recentActivitiesOption.style.display = isStravaAuthenticated ? 'block' : 'none';
    }
    
    // Clear recent activities list
    const activitiesList = document.getElementById('recent-activities-list');
    if (activitiesList) {
        activitiesList.innerHTML = '';
    }
}

// Format distance in km with one decimal place
function formatDistance(km) {
    return km.toFixed(1) + ' km';
}

// Format elevation in meters
function formatElevation(meters) {
    return Math.round(meters) + ' m';
}

// Format completed date from Strava activity start date
function formatCompletedDate(dateString) {
    if (!dateString) return '';
    
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        
        // Format as "January 15, 2026 at 2:30 PM"
        const options = {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        };
        
        return date.toLocaleDateString('en-US', options);
    } catch (e) {
        console.error('Error formatting date:', e);
        return '';
    }
}

// Update statistics
function updateStats() {
    const total = routes.length;
    const completed = completedRoutes.size;
    const remaining = total - completed;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    // Calculate distances
    const totalDistance = routes.reduce((sum, route) => sum + (route.length || 0), 0);
    const completedDistance = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.length || 0), 0);
    const remainingDistance = totalDistance - completedDistance;
    
    // Calculate elevations
    const totalElevation = routes.reduce((sum, route) => sum + (route.elevation || 0), 0);
    const completedElevation = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.elevation || 0), 0);
    const remainingElevation = totalElevation - completedElevation;
    
    // Calculate averages
    const avgDistanceAll = total > 0 ? totalDistance / total : 0;
    const avgDistanceCompleted = completed > 0 ? completedDistance / completed : 0;
    const avgDistanceRemaining = remaining > 0 ? remainingDistance / remaining : 0;
    
    const avgElevationAll = total > 0 ? totalElevation / total : 0;
    const avgElevationCompleted = completed > 0 ? completedElevation / completed : 0;
    const avgElevationRemaining = remaining > 0 ? remainingElevation / remaining : 0;
    
    // Update route count stats with tooltips
    const totalRoutesEl = document.getElementById('total-routes');
    const completedRoutesEl = document.getElementById('completed-routes');
    const remainingRoutesEl = document.getElementById('remaining-routes');
    const percentageCompleteEl = document.getElementById('percentage-complete');
    
    if (totalRoutesEl) {
        totalRoutesEl.textContent = total;
        totalRoutesEl.closest('.stat-card-compact').title = "Total number of Zwift routes";
    }
    if (completedRoutesEl) {
        completedRoutesEl.textContent = completed;
        completedRoutesEl.closest('.stat-card-compact').title = "Number of routes you've completed";
    }
    if (remainingRoutesEl) {
        remainingRoutesEl.textContent = remaining;
        remainingRoutesEl.closest('.stat-card-compact').title = "Number of routes still to complete";
    }
    if (percentageCompleteEl) {
        percentageCompleteEl.textContent = `${percentage}%`;
        percentageCompleteEl.closest('.stat-card-compact').title = "Percentage of routes completed";
    }
    
    // Calculate completion percentages
    const distanceCompletionPercent = totalDistance > 0 ? Math.round((completedDistance / totalDistance) * 100) : 0;
    const elevationCompletionPercent = totalElevation > 0 ? Math.round((completedElevation / totalElevation) * 100) : 0;
    
    // Update distance stats (without lead-in) with tooltips
    const totalDistanceEl = document.getElementById('total-distance');
    const completedDistanceEl = document.getElementById('completed-distance');
    const remainingDistanceEl = document.getElementById('remaining-distance');
    const avgDistanceAllEl = document.getElementById('avg-distance-all');
    const avgDistanceCompletedEl = document.getElementById('avg-distance-completed');
    const avgDistanceRemainingEl = document.getElementById('avg-distance-remaining');
    
    if (totalDistanceEl) {
        totalDistanceEl.textContent = formatDistance(totalDistance);
        totalDistanceEl.closest('.stat-card-compact').title = "Total distance of all routes";
    }
    if (completedDistanceEl) {
        completedDistanceEl.textContent = `${formatDistance(completedDistance)} (${distanceCompletionPercent}%)`;
        completedDistanceEl.closest('.stat-card-compact').title = "Total distance of completed routes";
    }
    if (remainingDistanceEl) {
        remainingDistanceEl.textContent = formatDistance(remainingDistance);
        remainingDistanceEl.closest('.stat-card-compact').title = "Total distance of remaining routes";
    }
    if (avgDistanceAllEl) {
        avgDistanceAllEl.textContent = formatDistance(avgDistanceAll);
        avgDistanceAllEl.closest('.stat-card-compact').title = "Average distance per route (all routes)";
    }
    if (avgDistanceCompletedEl) {
        avgDistanceCompletedEl.textContent = formatDistance(avgDistanceCompleted);
        avgDistanceCompletedEl.closest('.stat-card-compact').title = "Average distance per route (completed routes)";
    }
    if (avgDistanceRemainingEl) {
        avgDistanceRemainingEl.textContent = formatDistance(avgDistanceRemaining);
        avgDistanceRemainingEl.closest('.stat-card-compact').title = "Average distance per route (remaining routes)";
    }
    
    // Update elevation stats with tooltips
    const totalElevationEl = document.getElementById('total-elevation');
    const completedElevationEl = document.getElementById('completed-elevation');
    const remainingElevationEl = document.getElementById('remaining-elevation');
    const avgElevationAllEl = document.getElementById('avg-elevation-all');
    const avgElevationCompletedEl = document.getElementById('avg-elevation-completed');
    const avgElevationRemainingEl = document.getElementById('avg-elevation-remaining');
    
    if (totalElevationEl) {
        totalElevationEl.textContent = formatElevation(totalElevation);
        totalElevationEl.closest('.stat-card-compact').title = "Total elevation gain of all routes";
    }
    if (completedElevationEl) {
        completedElevationEl.textContent = `${formatElevation(completedElevation)} (${elevationCompletionPercent}%)`;
        completedElevationEl.closest('.stat-card-compact').title = "Total elevation gain of completed routes";
    }
    if (remainingElevationEl) {
        remainingElevationEl.textContent = formatElevation(remainingElevation);
        remainingElevationEl.closest('.stat-card-compact').title = "Total elevation gain of remaining routes";
    }
    if (avgElevationAllEl) {
        avgElevationAllEl.textContent = formatElevation(avgElevationAll);
        avgElevationAllEl.closest('.stat-card-compact').title = "Average elevation gain per route (all routes)";
    }
    if (avgElevationCompletedEl) {
        avgElevationCompletedEl.textContent = formatElevation(avgElevationCompleted);
        avgElevationCompletedEl.closest('.stat-card-compact').title = "Average elevation gain per route (completed routes)";
    }
    if (avgElevationRemainingEl) {
        avgElevationRemainingEl.textContent = formatElevation(avgElevationRemaining);
        avgElevationRemainingEl.closest('.stat-card-compact').title = "Average elevation gain per route (remaining routes)";
    }
    
    // Update Strava activity stats
    updateStravaStats();
}

// Format time in seconds to readable format
function formatTime(seconds) {
    if (!seconds || seconds === 0) return '0:00';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    } else if (hours > 0) {
        return `${hours}h ${mins}m`;
    } else {
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

// Update Strava activity-based statistics
function updateStravaStats() {
    const activities = Object.values(routeActivities);
    
    // Calculate totals from all linked activities
    const totalDistance = activities.reduce((sum, activity) => sum + (activity.distance || 0), 0);
    const totalElevation = activities.reduce((sum, activity) => sum + (activity.totalElevationGain || 0), 0);
    const totalMovingTime = activities.reduce((sum, activity) => sum + (activity.movingTime || 0), 0);
    const totalElapsedTime = activities.reduce((sum, activity) => sum + (activity.elapsedTime || 0), 0);
    const totalCalories = activities.reduce((sum, activity) => sum + (activity.calories || 0), 0);
    
    // Update Strava stat elements with tooltips
    const stravaDistanceEl = document.getElementById('strava-total-distance');
    const stravaElevationEl = document.getElementById('strava-total-elevation');
    const stravaMovingTimeEl = document.getElementById('strava-total-moving-time');
    const stravaElapsedTimeEl = document.getElementById('strava-total-elapsed-time');
    const stravaCaloriesEl = document.getElementById('strava-total-calories');
    
    if (stravaDistanceEl) {
        stravaDistanceEl.textContent = formatDistance(totalDistance / 1000); // Convert meters to km
        stravaDistanceEl.closest('.stat-card-compact').title = "Total distance from all linked Strava activities";
    }
    if (stravaElevationEl) {
        stravaElevationEl.textContent = formatElevation(totalElevation);
        stravaElevationEl.closest('.stat-card-compact').title = "Total elevation gain from all linked Strava activities";
    }
    if (stravaMovingTimeEl) {
        stravaMovingTimeEl.textContent = formatTime(totalMovingTime);
        stravaMovingTimeEl.closest('.stat-card-compact').title = "Total moving time from all linked Strava activities";
    }
    if (stravaElapsedTimeEl) {
        stravaElapsedTimeEl.textContent = formatTime(totalElapsedTime);
        stravaElapsedTimeEl.closest('.stat-card-compact').title = "Total elapsed time from all linked Strava activities";
    }
    if (stravaCaloriesEl) {
        stravaCaloriesEl.textContent = totalCalories.toLocaleString();
        stravaCaloriesEl.closest('.stat-card-compact').title = "Total calories burned from all linked Strava activities";
    }
}

// Update map stats in headers without full re-render
function updateMapStats() {
    const mapHeaders = document.querySelectorAll('.map-stats');
    mapHeaders.forEach(header => {
        const mapGroup = header.closest('.map-group');
        if (!mapGroup) return;
        
        const mapTitle = mapGroup.querySelector('.map-title');
        if (!mapTitle) return;
        
        const mapName = mapTitle.textContent;
        const routesInMap = routes.filter(r => r.map === mapName);
        const completedInMap = routesInMap.filter(r => completedRoutes.has(r.route)).length;
        
        header.textContent = `${completedInMap} / ${routesInMap.length} completed`;
    });
}

// Update authentication UI
function updateAuthUI() {
    if (isAuthenticated) {
        authBtn.textContent = 'Logout';
        // Only update status if not currently showing sync status
        if (!authStatus.textContent.includes('Syncing') && !authStatus.textContent.includes('Sync')) {
            authStatus.textContent = '✓ Authenticated';
            authStatus.style.color = 'var(--completed)';
        }
    } else {
        authBtn.textContent = 'Login to Edit';
        authStatus.textContent = '';
    }
    
    // Update all checkboxes
    document.querySelectorAll('.route-checkbox').forEach(checkbox => {
        checkbox.disabled = !isAuthenticated;
    });
}

// Setup event listeners
function setupEventListeners() {
    // Auth button
    authBtn.addEventListener('click', () => {
        if (isAuthenticated) {
            sessionStorage.removeItem(CONFIG.TOKEN_KEY);
            isAuthenticated = false;
            updateAuthUI();
        } else {
            authModal.style.display = 'block';
        }
    });
    
    // Modal close
    document.querySelector('.close').addEventListener('click', () => {
        authModal.style.display = 'none';
    });
    
    window.addEventListener('click', (e) => {
        if (e.target === authModal) {
            authModal.style.display = 'none';
        }
    });
    
    // Token submit
    tokenSubmit.addEventListener('click', async () => {
        const token = tokenInput.value.trim();
        if (!token) {
            alert('Please enter a GitHub token');
            return;
        }
        
        // Verify token by making a test API call
        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (!response.ok) {
                throw new Error('Invalid token');
            }
            
            sessionStorage.setItem(CONFIG.TOKEN_KEY, token);
            isAuthenticated = true;
            updateAuthUI();
            tokenInput.value = '';
            
            // Show Gist setup if Gist ID not set, otherwise close modal
            if (!gistId) {
                gistSetup.style.display = 'block';
                // Keep modal open so user can optionally enter existing Gist ID
            } else {
                authModal.style.display = 'none';
            }
        } catch (error) {
            alert('Invalid token. Please check your GitHub Personal Access Token.');
        }
    });
    
    // Gist ID submit
    gistSubmit.addEventListener('click', () => {
        const newGistId = gistIdInput.value.trim();
        if (newGistId) {
            gistId = newGistId;
            localStorage.setItem(CONFIG.GIST_ID_KEY, gistId);
            loadCompletedRoutes();
            alert('Gist ID saved!');
        } else {
            alert('Please enter a Gist ID');
        }
    });
    
    // Filter buttons
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderRoutes();
        });
    });
    
    // Search input
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderRoutes();
    });
    
    // Strava connect button
    const stravaBtn = document.getElementById('strava-connect-btn');
    if (stravaBtn) {
        stravaBtn.addEventListener('click', () => {
            if (isStravaAuthenticated) {
                if (confirm('Disconnect Strava?')) {
                    sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
                    sessionStorage.removeItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY);
                    isStravaAuthenticated = false;
                    updateStravaAuthUI();
                }
            } else {
                connectStrava();
            }
        });
    }
    
    // Activity modal close
    const activityModal = document.getElementById('activity-modal');
    const closeActivity = document.querySelector('.close-activity');
    if (closeActivity && activityModal) {
        closeActivity.addEventListener('click', () => {
            activityModal.style.display = 'none';
        });
        
        window.addEventListener('click', (e) => {
            if (e.target === activityModal) {
                activityModal.style.display = 'none';
            }
        });
    }
    
    // Activity details modal close
    const activityDetailsModal = document.getElementById('activity-details-modal');
    const closeActivityDetails = document.querySelector('.close-activity-details');
    if (closeActivityDetails && activityDetailsModal) {
        closeActivityDetails.addEventListener('click', () => {
            activityDetailsModal.style.display = 'none';
        });
        
        window.addEventListener('click', (e) => {
            if (e.target === activityDetailsModal) {
                activityDetailsModal.style.display = 'none';
            }
        });
    }
    
    // Activity link button
    const activityLinkBtn = document.getElementById('activity-link-btn');
    if (activityLinkBtn) {
        activityLinkBtn.addEventListener('click', async () => {
            const routeName = activityModal?.dataset.route;
            const activityInput = document.getElementById('activity-input');
            const statusEl = document.getElementById('activity-linking-status');
            
            if (!routeName) {
                alert('No route selected');
                return;
            }
            
            const activityIdOrUrl = activityInput?.value.trim();
            if (!activityIdOrUrl) {
                alert('Please enter an activity URL or ID');
                return;
            }
            
            if (statusEl) {
                statusEl.textContent = 'Linking activity...';
                statusEl.style.color = 'var(--text-secondary)';
            }
            
            try {
                await linkActivityToRoute(routeName, activityIdOrUrl);
                if (statusEl) {
                    statusEl.textContent = '✓ Activity linked successfully!';
                    statusEl.style.color = 'var(--completed)';
                }
                setTimeout(() => {
                    activityModal.style.display = 'none';
                }, 1500);
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = `✗ Error: ${error.message}`;
                    statusEl.style.color = '#f85149';
                }
            }
        });
    }
    
    // Load recent activities button
    const loadActivitiesBtn = document.getElementById('load-activities-btn');
    if (loadActivitiesBtn) {
        loadActivitiesBtn.addEventListener('click', async () => {
            const listEl = document.getElementById('recent-activities-list');
            const statusEl = document.getElementById('activity-linking-status');
            
            if (!isStravaAuthenticated) {
                alert('Please connect Strava first');
                return;
            }
            
            if (statusEl) {
                statusEl.textContent = 'Loading activities...';
                statusEl.style.color = 'var(--text-secondary)';
            }
            
            try {
                const activities = await fetchRecentStravaActivities(30);
                if (listEl) {
                    listEl.innerHTML = '';
                    if (activities.length === 0) {
                        listEl.innerHTML = '<p>No recent activities found.</p>';
                    } else {
                        activities.forEach(activity => {
                            const item = document.createElement('div');
                            item.className = 'activity-item';
                            const date = new Date(activity.start_date);
                            item.innerHTML = `
                                <div class="activity-item-info">
                                    <strong>${activity.name || 'Untitled'}</strong>
                                    <div class="activity-item-meta">
                                        ${(activity.distance / 1000).toFixed(2)} km • 
                                        ${new Date(activity.moving_time * 1000).toISOString().substr(11, 8)} • 
                                        ${date.toLocaleDateString()}
                                    </div>
                                </div>
                                <button class="btn btn-small btn-primary" data-activity-id="${activity.id}">
                                    Link
                                </button>
                            `;
                            const linkBtn = item.querySelector('button');
                            linkBtn.addEventListener('click', async () => {
                                const routeName = activityModal?.dataset.route;
                                if (routeName) {
                                    try {
                                        await linkActivityToRoute(routeName, activity.id.toString());
                                        activityModal.style.display = 'none';
                                    } catch (error) {
                                        alert(`Error linking activity: ${error.message}`);
                                    }
                                }
                            });
                            listEl.appendChild(item);
                        });
                    }
                }
                if (statusEl) {
                    statusEl.textContent = '';
                }
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = `✗ Error: ${error.message}`;
                    statusEl.style.color = '#f85149';
                }
            }
        });
    }
}

// UI Visibility Functions
function hideEditUI() {
    // Hide auth section
    const authSection = document.querySelector('.auth-section');
    if (authSection) {
        authSection.style.display = 'none';
    }
    
    // Hide auth modal
    if (authModal) {
        authModal.style.display = 'none';
    }
    
    // Hide activity modal
    const activityModal = document.getElementById('activity-modal');
    if (activityModal) {
        activityModal.style.display = 'none';
    }
}

function showEditUI() {
    // Show auth section
    const authSection = document.querySelector('.auth-section');
    if (authSection) {
        authSection.style.display = 'flex';
    }
}

function showNavigation() {
    const header = document.querySelector('header');
    if (!header) return;
    
    // Find or create navigation container
    let navContainer = header.querySelector('.navigation-links');
    if (!navContainer) {
        // If navigation-links doesn't exist, find header-bottom and create it there
        const headerBottom = header.querySelector('.header-bottom');
        if (headerBottom) {
            navContainer = headerBottom.querySelector('.navigation-links');
        }
    }
    
    if (!navContainer) return;
    
    // Check if navigation already exists
    if (document.getElementById('nav-edit-link') || document.getElementById('nav-showcase-link')) {
        return;
    }
    
    if (isEditMode) {
        // Show link to showcase
        const showcaseLink = document.createElement('a');
        showcaseLink.id = 'nav-showcase-link';
        // Calculate showcase URL - go back to root
        const currentPath = window.location.pathname;
        let showcasePath = '/';
        if (currentPath.includes('/edit')) {
            showcasePath = currentPath.replace('/edit', '');
        } else if (currentPath.includes('edit.html')) {
            showcasePath = currentPath.replace('edit.html', 'index.html');
        }
        if (!showcasePath || showcasePath === '/edit') {
            showcasePath = '/';
        }
        showcaseLink.href = showcasePath;
        showcaseLink.className = 'btn btn-secondary';
        showcaseLink.textContent = '← View Showcase';
        navContainer.appendChild(showcaseLink);
    } else {
        // Show link to edit page
        const editLink = document.createElement('a');
        editLink.id = 'nav-edit-link';
        const currentPath = window.location.pathname;
        let editPath = '/edit';
        if (currentPath.endsWith('/') || currentPath.endsWith('index.html')) {
            editPath = currentPath.replace('index.html', '').replace(/\/$/, '') + '/edit';
        } else {
            editPath = currentPath.replace(/\/[^/]*$/, '') + '/edit';
        }
        editLink.href = editPath;
        editLink.className = 'btn btn-primary';
        editLink.textContent = 'Edit Progress →';
        navContainer.appendChild(editLink);
        
        // Add scroll detection for mobile bottom button
        setupScrollDetection();
    }
}

// Setup scroll detection to show/hide Edit Progress button at bottom on mobile
function setupScrollDetection() {
    const editLink = document.getElementById('nav-edit-link');
    if (!editLink) return;
    
    // Prevent duplicate setup
    if (editLink.dataset.scrollSetup === 'true') return;
    editLink.dataset.scrollSetup = 'true';
    
    let ticking = false;
    
    function checkScrollPosition() {
        // Only check on mobile
        const isMobile = window.innerWidth <= 768;
        if (!isMobile) {
            editLink.classList.remove('show-at-bottom');
            return;
        }
        
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;
        
        // Show button when within 100px of bottom
        const threshold = 100;
        const isAtBottom = scrollTop + windowHeight >= documentHeight - threshold;
        
        if (isAtBottom) {
            editLink.classList.add('show-at-bottom');
        } else {
            editLink.classList.remove('show-at-bottom');
        }
        
        ticking = false;
    }
    
    function onScroll() {
        if (!ticking) {
            window.requestAnimationFrame(checkScrollPosition);
            ticking = true;
        }
    }
    
    function onResize() {
        checkScrollPosition();
    }
    
    // Add listeners
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    
    // Check initial position and after a short delay (to account for content loading)
    checkScrollPosition();
    setTimeout(checkScrollPosition, 500);
}

// Setup event listeners for showcase mode (limited functionality)
function setupShowcaseEventListeners() {
    // Filter buttons
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderRoutes();
        });
    });
    
    // Search input
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            renderRoutes();
        });
    }
    
    // Activity details modal close (for showcase mode)
    const activityDetailsModal = document.getElementById('activity-details-modal');
    const closeActivityDetails = document.querySelector('.close-activity-details');
    if (closeActivityDetails && activityDetailsModal) {
        closeActivityDetails.addEventListener('click', () => {
            activityDetailsModal.style.display = 'none';
        });
        
        window.addEventListener('click', (e) => {
            if (e.target === activityDetailsModal) {
                activityDetailsModal.style.display = 'none';
            }
        });
    }
}

// Initialize on page load
init();

