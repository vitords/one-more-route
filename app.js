// Configuration
const CONFIG = {
    GIST_ID_KEY: 'zwift_tracker_gist_id',
    TOKEN_KEY: 'zwift_tracker_token',
    GIST_FILENAME: 'zwift_routes.json',
    LOCAL_STORAGE_KEY: 'zwift_tracker_completed_routes',
    STRAVA_TOKEN_KEY: 'zwift_tracker_strava_token',
    STRAVA_REFRESH_TOKEN_KEY: 'zwift_tracker_strava_refresh_token',
    STRAVA_TOKEN_EXPIRES_KEY: 'zwift_tracker_strava_token_expires',
    STRAVA_ACTIVITIES_CACHE_KEY: 'zwift_tracker_strava_activities_cache',
    SORT_KEY: 'zwift_tracker_sort',
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
let currentSort = { by: 'routeDistance', dir: 'asc' };
let isAuthenticated = false;
let isStravaAuthenticated = false;
let gistId = null;
let syncTimeout = null;
let isSyncing = false;

const STRAVA_CHART_WINDOW_DAYS = 30;
const STRAVA_CHART_SWIPE_DRAG_THRESHOLD_PX = 4;
let stravaChartsWindowStartMs = null;
let stravaChartsPanPreviewOffsetMs = 0;
let stravaChartsSwipeState = null;
let stravaChartsSwipeRaf = null;
let stravaChartsSwipeDocMove = null;
let stravaChartsSwipeDocEnd = null;
let stravaChartsSwipeDocTouchMove = null;
let stravaChartsSwipeDocTouchEnd = null;
let stravaChartsInteractionListenersBound = false;
let stravaTrendArmedHit = null;
let stravaTrendOutsideDismissInstalled = false;

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
    // Restore sort preference from localStorage
    try {
        const saved = localStorage.getItem(CONFIG.SORT_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.by && parsed.dir) {
                currentSort = parsed;
            }
        }
    } catch (e) {
        console.warn('Could not restore sort preference:', e);
    }

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
    
    // Always use SHOWCASE_GIST_ID in edit mode for consistency across devices
    gistId = CONFIG.SHOWCASE_GIST_ID || localStorage.getItem(CONFIG.GIST_ID_KEY);
    // Migrate token from sessionStorage (legacy) to localStorage for cross-session persistence
    let savedToken = localStorage.getItem(CONFIG.TOKEN_KEY);
    if (!savedToken) {
        const legacyToken = sessionStorage.getItem(CONFIG.TOKEN_KEY);
        if (legacyToken) {
            localStorage.setItem(CONFIG.TOKEN_KEY, legacyToken);
            sessionStorage.removeItem(CONFIG.TOKEN_KEY);
            savedToken = legacyToken;
        }
    }
    
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

            // Sync merged state to Gist when authenticated (pushes any local-only changes from other sessions/devices)
            if (isAuthenticated) {
                saveCompletedRoutes();
            }
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
    
    const token = localStorage.getItem(CONFIG.TOKEN_KEY);
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
        
        // Always use SHOWCASE_GIST_ID if set, otherwise use current gistId
        const targetGistId = CONFIG.SHOWCASE_GIST_ID || gistId;
        
        // If no Gist ID is set, create a new Gist
        if (!targetGistId) {
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
            // Don't save to localStorage - always use SHOWCASE_GIST_ID if set
            if (gistIdInput) {
                gistIdInput.value = gistId;
            }
            console.log(`[${timestamp}] syncToGist: ✓ Created new Gist: ${gistId}`);
            console.warn(`[${timestamp}] syncToGist: ⚠ Warning: Created new Gist instead of using SHOWCASE_GIST_ID. Please set CONFIG.SHOWCASE_GIST_ID in app.js`);
        } else {
            // Use the target Gist ID (SHOWCASE_GIST_ID or existing gistId)
            gistId = targetGistId;
            console.log(`[${timestamp}] syncToGist: Using Gist ID: ${gistId}${CONFIG.SHOWCASE_GIST_ID ? ' (SHOWCASE_GIST_ID)' : ''}`);
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
                // Note: GitHub will assign a new ID, but we'll continue using SHOWCASE_GIST_ID for future operations
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
                const newGistId = gist.id;
                // If we were trying to use SHOWCASE_GIST_ID but it didn't exist, warn the user
                if (CONFIG.SHOWCASE_GIST_ID && gistId === CONFIG.SHOWCASE_GIST_ID) {
                    console.warn(`[${timestamp}] syncToGist: ⚠ SHOWCASE_GIST_ID (${gistId}) didn't exist, created new Gist: ${newGistId}`);
                    console.warn(`[${timestamp}] syncToGist: ⚠ Please update CONFIG.SHOWCASE_GIST_ID to ${newGistId} if you want to use this Gist`);
                }
                // Keep using the original gistId (SHOWCASE_GIST_ID) for consistency
                // Don't update gistId or localStorage - continue using SHOWCASE_GIST_ID
                if (gistIdInput) {
                    gistIdInput.value = gistId;
                }
                console.log(`[${timestamp}] syncToGist: ✓ Created new Gist: ${newGistId} (but continuing to use ${gistId} for future operations)`);
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
    
    const scope = 'activity:read,activity:read_all,activity:write';
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
        if (data.expires_at) {
            sessionStorage.setItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY, data.expires_at.toString());
        }
        
        isStravaAuthenticated = true;
        updateStravaAuthUI();
        console.log('Strava authentication successful');
    } catch (error) {
        console.error('Error exchanging Strava token:', error);
        alert(`Failed to authenticate with Strava: ${error.message}`);
    }
}

// Refresh Strava access token using refresh token
async function refreshStravaToken() {
    const refreshToken = sessionStorage.getItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY);
    if (!refreshToken) {
        return null;
    }
    
    if (!CONFIG.STRAVA_TOKEN_PROXY_URL) {
        console.error('Strava token proxy URL not configured');
        return null;
    }
    
    try {
        // Call our secure serverless function to refresh the token
        const response = await fetch(CONFIG.STRAVA_TOKEN_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                refresh_token: refreshToken,
                client_id: CONFIG.STRAVA_CLIENT_ID,
                grant_type: 'refresh_token'
            })
        });
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to refresh token' }));
            throw new Error(error.message || 'Failed to refresh token');
        }
        
        const data = await response.json();
        sessionStorage.setItem(CONFIG.STRAVA_TOKEN_KEY, data.access_token);
        if (data.refresh_token) {
            sessionStorage.setItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY, data.refresh_token);
        }
        if (data.expires_at) {
            sessionStorage.setItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY, data.expires_at.toString());
        }
        
        console.log('Strava token refreshed successfully');
        return data.access_token;
    } catch (error) {
        console.error('Error refreshing Strava token:', error);
        // If refresh fails, clear tokens and require re-authentication
        sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
        sessionStorage.removeItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY);
        sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY);
        isStravaAuthenticated = false;
        updateStravaAuthUI();
        return null;
    }
}

// Get Strava access token (with refresh if needed)
async function getStravaToken() {
    let token = sessionStorage.getItem(CONFIG.STRAVA_TOKEN_KEY);
    if (!token) {
        return null;
    }
    
    // Check if token is expired or will expire within 1 hour (3600 seconds)
    const expiresAt = sessionStorage.getItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY);
    if (expiresAt) {
        const expiresTimestamp = parseInt(expiresAt, 10);
        const now = Math.floor(Date.now() / 1000);
        const oneHourFromNow = now + 3600;
        
        // If token is expired or will expire within 1 hour, refresh it
        if (expiresTimestamp <= oneHourFromNow) {
            console.log('Strava token expired or expiring soon, refreshing...');
            token = await refreshStravaToken();
        }
    }
    
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

// Update Strava activity description
async function updateStravaActivityDescription(activityId, activityData = null, tokenToUse = null) {
    // Use provided token or get fresh token
    let token = tokenToUse || await getStravaToken();
    if (!token) {
        throw new Error('Not authenticated with Strava');
    }
    
    try {
        // Use provided activity data or fetch it fresh (bypassing cache to validate token)
        let activity = activityData;
        if (!activity || activity.description === undefined) {
            // Always fetch fresh to validate token is still good
            // Invalidate cache first to force fresh fetch
            const cacheKey = `strava_activity_${activityId}`;
            localStorage.removeItem(cacheKey);
            activity = await fetchStravaActivity(activityId);
            // Get the token that was just successfully used
            token = await getStravaToken();
        }
        
        // Check if description already contains the URL to avoid duplicates
        const toolUrl = 'https://vitords.github.io/one-more-route/';
        if (activity.description && activity.description.includes(toolUrl)) {
            console.log(`Activity ${activityId} already has tool link in description, skipping update`);
            return;
        }
        
        // Format the message to append
        const message = `${toolUrl}\nI'm riding every Zwift route in 2026 and made a tool to keep track of the progress! Check it out to see how I'm doing.`;
        
        // Format the new description
        let newDescription;
        if (!activity.description || activity.description.trim() === '') {
            // If description is empty, append message directly (no newline separator)
            newDescription = message;
        } else {
            // If description exists, append newline separator + message
            newDescription = `${activity.description}\n${message}`;
        }
        
        // Ensure we have a valid token
        if (!token) {
            token = await getStravaToken();
            if (!token) {
                throw new Error('Not authenticated with Strava');
            }
        }
        
        // Make PUT request to update activity description immediately after successful GET
        const response = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                description: newDescription
            })
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                // Token expired, need to re-authenticate
                sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
                isStravaAuthenticated = false;
                updateStravaAuthUI();
                throw new Error('Strava authentication expired. Please reconnect.');
            }
            throw new Error(`Failed to update activity description: ${response.statusText}`);
        }
        
        // Invalidate cache for this activity
        const cacheKey = `strava_activity_${activityId}`;
        localStorage.removeItem(cacheKey);
        
        console.log(`Successfully updated description for activity ${activityId}`);
    } catch (error) {
        console.error('Error updating Strava activity description:', error);
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
        
        // Update activity description (don't fail linking if this fails)
        // Pass the already-fetched activity data and token to avoid redundant API call
        // Get token that was just successfully used in fetchStravaActivity
        const token = await getStravaToken();
        try {
            await updateStravaActivityDescription(activity.id, activity, token);
        } catch (error) {
            console.warn('Failed to update activity description, but activity was linked successfully:', error);
        }
        
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

// Get sort value for a route based on currentSort
function getRouteSortValue(route, completionOrderMap) {
    switch (currentSort.by) {
        case 'routeDistance':
            return route.length || 0;
        case 'totalDistance':
            return route.totalDistance ?? (route.length || 0) + (route.leadIn || 0);
        case 'routeElevation':
            return route.elevation || 0;
        case 'totalElevation':
            return route.totalElevation ?? (route.elevation || 0) + (route.leadInElevation || 0);
        case 'completionOrder': {
            const order = completionOrderMap[route.route];
            if (order != null) return order;
            return currentSort.dir === 'asc' ? Infinity : -1;
        }
        default:
            return route.length || 0;
    }
}

// Compare two routes for sorting
function compareRoutes(a, b, completionOrderMap) {
    const valA = getRouteSortValue(a, completionOrderMap);
    const valB = getRouteSortValue(b, completionOrderMap);
    let cmp = valA - valB;
    if (currentSort.by === 'completionOrder' && currentSort.dir === 'desc') {
        cmp = -cmp;
    } else if (currentSort.dir === 'desc') {
        cmp = -cmp;
    }
    if (cmp !== 0) return cmp;
    return a.route.localeCompare(b.route);
}

// Get completion order map for routes with Strava activities
function getCompletionOrderMap() {
    const orderMap = {};
    
    // Get all completed routes that have linked Strava activities with valid startDate
    const routesWithActivities = [];
    
    for (const routeName of completedRoutes) {
        const activity = routeActivities[routeName];
        if (activity && activity.startDate) {
            routesWithActivities.push({
                routeName: routeName,
                startDate: activity.startDate
            });
        }
    }
    
    // Sort by startDate (earliest first), with route name as secondary sort for consistent ordering
    routesWithActivities.sort((a, b) => {
        const dateA = new Date(a.startDate).getTime();
        const dateB = new Date(b.startDate).getTime();
        if (dateA !== dateB) {
            return dateA - dateB;
        }
        // If timestamps are equal, sort by route name for consistent ordering
        return a.routeName.localeCompare(b.routeName);
    });
    
    // Create mapping of route name -> completion order number (1-based)
    routesWithActivities.forEach((item, index) => {
        orderMap[item.routeName] = index + 1;
    });
    
    return orderMap;
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
    
    const completionOrderMap = getCompletionOrderMap();

    Object.keys(grouped).sort().forEach(map => {
        const mapGroup = document.createElement('div');
        mapGroup.className = 'map-group';
        
        // Sort routes within each map by current sort option
        const routesInMap = grouped[map].sort((a, b) => compareRoutes(a, b, completionOrderMap));
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
            const card = createRouteCard(route, completionOrderMap);
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
function createRouteCard(route, completionOrderMap = {}) {
    const card = document.createElement('div');
    card.className = `route-card ${completedRoutes.has(route.route) ? 'completed' : ''}`;
    
    const isCompleted = completedRoutes.has(route.route);
    const activity = routeActivities[route.route];
    const hasActivity = !!activity;
    
    // Get completion order number if route is completed and has activity
    const completionNumber = (isCompleted && hasActivity) ? completionOrderMap[route.route] : null;
    const routeNameDisplay = completionNumber ? `#${completionNumber} ${route.route}` : route.route;
    
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
            <div class="route-name">${routeNameDisplay}</div>
            <div class="route-header-actions">
                ${checkboxHTML}
            </div>
        </div>
        <div class="route-details">
            <div class="route-details-section">
                <div class="route-details-section-title">Route</div>
                <div class="route-detail">
                    <div class="route-detail-label">Distance</div>
                    <div class="route-detail-value">${route.length} km</div>
                </div>
                <div class="route-detail">
                    <div class="route-detail-label">Elevation</div>
                    <div class="route-detail-value">${route.elevation} m</div>
                </div>
            </div>
            <div class="route-details-section">
                <div class="route-details-section-title">Lead-In</div>
                <div class="route-detail">
                    <div class="route-detail-label">Distance</div>
                    <div class="route-detail-value">${route.leadIn} km</div>
                </div>
                <div class="route-detail">
                    <div class="route-detail-label">Elevation</div>
                    <div class="route-detail-value">${route.leadInElevation || 0} m</div>
                </div>
            </div>
            <div class="route-details-section">
                <div class="route-details-section-title">Total</div>
                <div class="route-detail">
                    <div class="route-detail-label">Distance</div>
                    <div class="route-detail-value">${route.totalDistance || (route.length + route.leadIn).toFixed(1)} km</div>
                </div>
                <div class="route-detail">
                    <div class="route-detail-label">Elevation</div>
                    <div class="route-detail-value">${route.totalElevation || (route.elevation + (route.leadInElevation || 0))} m</div>
                </div>
            </div>
            <div class="route-details-section">
                <div class="route-details-section-title">Stats</div>
                <div class="route-detail">
                    <div class="route-detail-label">Climb Rate</div>
                    <div class="route-detail-value">${route.climbRate || 0} m/km</div>
                </div>
                <div class="route-detail">
                    <div class="route-detail-label">Difficulty</div>
                    <div class="route-detail-value">${formatDifficulty(route.difficulty)}</div>
                </div>
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
                ${(() => {
                    const hr = getActivityHeartRates(activity);
                    let html = '';
                    if (hr.avgHr != null) {
                        html += `
                <div class="activity-stat">
                    <div class="activity-stat-label">Avg Heart Rate</div>
                    <div class="activity-stat-value">${formatAvgHeartRateForDisplay(hr.avgHr)}</div>
                </div>`;
                    }
                    if (hr.maxHr != null) {
                        html += `
                <div class="activity-stat">
                    <div class="activity-stat-label">Max Heart Rate</div>
                    <div class="activity-stat-value">${formatMaxHeartRateForDisplay(hr.maxHr)}</div>
                </div>`;
                    }
                    return html;
                })()}
                ${activity.calories ? `
                <div class="activity-stat">
                    <div class="activity-stat-label">Calories</div>
                    <div class="activity-stat-value">${activity.calories}</div>
                </div>
                ` : ''}
            </div>
            ${activity.activityId ? `
            <div class="activity-power-stream-block">
                <h4 class="activity-stream-heading">Power curve</h4>
                <p class="activity-stream-hint">Second-by-second power from Strava. Not saved to your synced progress.</p>
                <button type="button" class="btn btn-secondary btn-small activity-load-power-curve-btn">Load power curve</button>
                <div class="activity-power-stream-chart-inner" hidden>
                    <svg class="activity-power-stream-svg" role="img" aria-label="Power in watts over time during this activity"></svg>
                </div>
                <p class="activity-power-stream-msg" aria-live="polite"></p>
            </div>
            ` : ''}
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

    const loadCurveBtn = content.querySelector('.activity-load-power-curve-btn');
    const streamChartInner = content.querySelector('.activity-power-stream-chart-inner');
    const streamSvg = content.querySelector('.activity-power-stream-svg');
    const streamMsg = content.querySelector('.activity-power-stream-msg');
    if (loadCurveBtn && streamChartInner && streamSvg && streamMsg) {
        loadCurveBtn.addEventListener('click', async () => {
            if (!isStravaAuthenticated) {
                connectStrava();
                streamMsg.textContent = 'Connect Strava to load the power stream.';
                return;
            }
            streamMsg.textContent = 'Loading…';
            loadCurveBtn.disabled = true;
            try {
                const { times, watts } = await fetchStravaActivityStreams(activity.activityId);
                renderActivityPowerStreamSvg(streamSvg, times, watts);
                streamChartInner.hidden = false;
                streamMsg.textContent = '';
            } catch (err) {
                console.error('Power stream:', err);
                streamMsg.textContent = err.message || 'Could not load power curve.';
                streamChartInner.hidden = true;
            } finally {
                loadCurveBtn.disabled = false;
            }
        });
    }
    
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

// Format difficulty as visual circles (5 circles, filled based on difficulty)
function formatDifficulty(difficulty) {
    if (!difficulty) return '<div class="difficulty-circles"></div>';
    
    // Parse difficulty string like "2 / 5" or "3.5 / 5"
    const match = difficulty.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    if (!match) {
        return `<div class="difficulty-circles"><span class="difficulty-text">${difficulty}</span></div>`;
    }
    
    const level = parseFloat(match[1]);
    const filled = Math.round(level); // Round to nearest integer for filled circles
    
    let circlesHTML = '<div class="difficulty-circles">';
    for (let i = 1; i <= 5; i++) {
        const isFilled = i <= filled;
        circlesHTML += `<span class="difficulty-circle ${isFilled ? 'filled' : ''}"></span>`;
    }
    circlesHTML += '</div>';
    
    return circlesHTML;
}

// Format completed date from Strava activity start date
function formatCompletedDate(dateString) {
    if (!dateString) return '';
    
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        
        // Format as "15 January 2026 at 2:30 PM" (day before month)
        const day = date.getDate();
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        const month = monthNames[date.getMonth()];
        const year = date.getFullYear();
        
        // Format time in 24-hour format
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        
        return `${day} ${month} ${year} at ${hours}:${minutes}`;
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
    const percentage = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';
    
    // Calculate distances (route only)
    const totalDistance = routes.reduce((sum, route) => sum + (route.length || 0), 0);
    const completedDistance = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.length || 0), 0);
    const remainingDistance = totalDistance - completedDistance;
    
    // Calculate distances (with lead-in)
    const totalDistanceLeadIn = routes.reduce((sum, route) => sum + (route.length || 0) + (route.leadIn || 0), 0);
    const completedDistanceLeadIn = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.length || 0) + (route.leadIn || 0), 0);
    const remainingDistanceLeadIn = totalDistanceLeadIn - completedDistanceLeadIn;
    
    // Calculate elevations (route only)
    const totalElevation = routes.reduce((sum, route) => sum + (route.elevation || 0), 0);
    const completedElevation = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.elevation || 0), 0);
    const remainingElevation = totalElevation - completedElevation;
    
    // Calculate elevations (with lead-in)
    const totalElevationLeadIn = routes.reduce((sum, route) => sum + (route.elevation || 0) + (route.leadInElevation || 0), 0);
    const completedElevationLeadIn = routes
        .filter(route => completedRoutes.has(route.route))
        .reduce((sum, route) => sum + (route.elevation || 0) + (route.leadInElevation || 0), 0);
    const remainingElevationLeadIn = totalElevationLeadIn - completedElevationLeadIn;
    
    // Calculate averages (route only)
    const avgDistanceAll = total > 0 ? totalDistance / total : 0;
    const avgDistanceCompleted = completed > 0 ? completedDistance / completed : 0;
    const avgDistanceRemaining = remaining > 0 ? remainingDistance / remaining : 0;
    
    const avgElevationAll = total > 0 ? totalElevation / total : 0;
    const avgElevationCompleted = completed > 0 ? completedElevation / completed : 0;
    const avgElevationRemaining = remaining > 0 ? remainingElevation / remaining : 0;
    
    // Calculate averages (with lead-in)
    const avgDistanceAllLeadIn = total > 0 ? totalDistanceLeadIn / total : 0;
    const avgDistanceCompletedLeadIn = completed > 0 ? completedDistanceLeadIn / completed : 0;
    const avgDistanceRemainingLeadIn = remaining > 0 ? remainingDistanceLeadIn / remaining : 0;
    
    const avgElevationAllLeadIn = total > 0 ? totalElevationLeadIn / total : 0;
    const avgElevationCompletedLeadIn = completed > 0 ? completedElevationLeadIn / completed : 0;
    const avgElevationRemainingLeadIn = remaining > 0 ? remainingElevationLeadIn / remaining : 0;
    
    // Update route count stats with tooltips
    const totalRoutesEl = document.getElementById('total-routes');
    const completedRoutesEl = document.getElementById('completed-routes');
    const remainingRoutesEl = document.getElementById('remaining-routes');
    const percentageCompleteEl = document.getElementById('percentage-complete');
    
    if (totalRoutesEl) {
        totalRoutesEl.textContent = total;
        totalRoutesEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total number of Zwift routes");
    }
    if (completedRoutesEl) {
        completedRoutesEl.textContent = completed;
        completedRoutesEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Number of routes you've completed");
    }
    if (remainingRoutesEl) {
        remainingRoutesEl.textContent = remaining;
        remainingRoutesEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Number of routes still to complete");
    }
    if (percentageCompleteEl) {
        percentageCompleteEl.textContent = `${percentage}%`;
        percentageCompleteEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Percentage of routes completed");
    }
    
    // Calculate completion percentages
    const distanceCompletionPercent = totalDistance > 0 ? ((completedDistance / totalDistance) * 100).toFixed(1) : '0.0';
    const elevationCompletionPercent = totalElevation > 0 ? ((completedElevation / totalElevation) * 100).toFixed(1) : '0.0';
    
    // Update distance stats (without lead-in) with tooltips
    const totalDistanceEl = document.getElementById('total-distance');
    const completedDistanceEl = document.getElementById('completed-distance');
    const remainingDistanceEl = document.getElementById('remaining-distance');
    const avgDistanceAllEl = document.getElementById('avg-distance-all');
    const avgDistanceCompletedEl = document.getElementById('avg-distance-completed');
    const avgDistanceRemainingEl = document.getElementById('avg-distance-remaining');
    
    if (totalDistanceEl) {
        totalDistanceEl.textContent = formatDistance(totalDistance);
        totalDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of all routes");
    }
    if (completedDistanceEl) {
        completedDistanceEl.textContent = `${formatDistance(completedDistance)} (${distanceCompletionPercent}%)`;
        completedDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of completed routes");
    }
    if (remainingDistanceEl) {
        remainingDistanceEl.textContent = formatDistance(remainingDistance);
        remainingDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of remaining routes");
    }
    if (avgDistanceAllEl) {
        avgDistanceAllEl.textContent = formatDistance(avgDistanceAll);
        avgDistanceAllEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route (all routes)");
    }
    if (avgDistanceCompletedEl) {
        avgDistanceCompletedEl.textContent = formatDistance(avgDistanceCompleted);
        avgDistanceCompletedEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route (completed routes)");
    }
    if (avgDistanceRemainingEl) {
        avgDistanceRemainingEl.textContent = formatDistance(avgDistanceRemaining);
        avgDistanceRemainingEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route (remaining routes)");
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
        totalElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of all routes");
    }
    if (completedElevationEl) {
        completedElevationEl.textContent = `${formatElevation(completedElevation)} (${elevationCompletionPercent}%)`;
        completedElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of completed routes");
    }
    if (remainingElevationEl) {
        remainingElevationEl.textContent = formatElevation(remainingElevation);
        remainingElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of remaining routes");
    }
    if (avgElevationAllEl) {
        avgElevationAllEl.textContent = formatElevation(avgElevationAll);
        avgElevationAllEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route (all routes)");
    }
    if (avgElevationCompletedEl) {
        avgElevationCompletedEl.textContent = formatElevation(avgElevationCompleted);
        avgElevationCompletedEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route (completed routes)");
    }
    if (avgElevationRemainingEl) {
        avgElevationRemainingEl.textContent = formatElevation(avgElevationRemaining);
        avgElevationRemainingEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route (remaining routes)");
    }
    
    // Calculate completion percentages for lead-in
    const distanceCompletionPercentLeadIn = totalDistanceLeadIn > 0 ? ((completedDistanceLeadIn / totalDistanceLeadIn) * 100).toFixed(1) : '0.0';
    const elevationCompletionPercentLeadIn = totalElevationLeadIn > 0 ? ((completedElevationLeadIn / totalElevationLeadIn) * 100).toFixed(1) : '0.0';
    
    // Update distance stats (with lead-in) with tooltips
    const totalDistanceLeadInEl = document.getElementById('total-distance-leadin');
    const completedDistanceLeadInEl = document.getElementById('completed-distance-leadin');
    const remainingDistanceLeadInEl = document.getElementById('remaining-distance-leadin');
    const avgDistanceAllLeadInEl = document.getElementById('avg-distance-all-leadin');
    const avgDistanceCompletedLeadInEl = document.getElementById('avg-distance-completed-leadin');
    const avgDistanceRemainingLeadInEl = document.getElementById('avg-distance-remaining-leadin');
    
    if (totalDistanceLeadInEl) {
        totalDistanceLeadInEl.textContent = formatDistance(totalDistanceLeadIn);
        totalDistanceLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of all routes including lead-in");
    }
    if (completedDistanceLeadInEl) {
        completedDistanceLeadInEl.textContent = `${formatDistance(completedDistanceLeadIn)} (${distanceCompletionPercentLeadIn}%)`;
        completedDistanceLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of completed routes including lead-in");
    }
    if (remainingDistanceLeadInEl) {
        remainingDistanceLeadInEl.textContent = formatDistance(remainingDistanceLeadIn);
        remainingDistanceLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of remaining routes including lead-in");
    }
    if (avgDistanceAllLeadInEl) {
        avgDistanceAllLeadInEl.textContent = formatDistance(avgDistanceAllLeadIn);
        avgDistanceAllLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route including lead-in (all routes)");
    }
    if (avgDistanceCompletedLeadInEl) {
        avgDistanceCompletedLeadInEl.textContent = formatDistance(avgDistanceCompletedLeadIn);
        avgDistanceCompletedLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route including lead-in (completed routes)");
    }
    if (avgDistanceRemainingLeadInEl) {
        avgDistanceRemainingLeadInEl.textContent = formatDistance(avgDistanceRemainingLeadIn);
        avgDistanceRemainingLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average distance per route including lead-in (remaining routes)");
    }
    
    // Update elevation stats (with lead-in) with tooltips
    const totalElevationLeadInEl = document.getElementById('total-elevation-leadin');
    const completedElevationLeadInEl = document.getElementById('completed-elevation-leadin');
    const remainingElevationLeadInEl = document.getElementById('remaining-elevation-leadin');
    const avgElevationAllLeadInEl = document.getElementById('avg-elevation-all-leadin');
    const avgElevationCompletedLeadInEl = document.getElementById('avg-elevation-completed-leadin');
    const avgElevationRemainingLeadInEl = document.getElementById('avg-elevation-remaining-leadin');
    
    if (totalElevationLeadInEl) {
        totalElevationLeadInEl.textContent = formatElevation(totalElevationLeadIn);
        totalElevationLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of all routes including lead-in");
    }
    if (completedElevationLeadInEl) {
        completedElevationLeadInEl.textContent = `${formatElevation(completedElevationLeadIn)} (${elevationCompletionPercentLeadIn}%)`;
        completedElevationLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of completed routes including lead-in");
    }
    if (remainingElevationLeadInEl) {
        remainingElevationLeadInEl.textContent = formatElevation(remainingElevationLeadIn);
        remainingElevationLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of remaining routes including lead-in");
    }
    if (avgElevationAllLeadInEl) {
        avgElevationAllLeadInEl.textContent = formatElevation(avgElevationAllLeadIn);
        avgElevationAllLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route including lead-in (all routes)");
    }
    if (avgElevationCompletedLeadInEl) {
        avgElevationCompletedLeadInEl.textContent = formatElevation(avgElevationCompletedLeadIn);
        avgElevationCompletedLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route including lead-in (completed routes)");
    }
    if (avgElevationRemainingLeadInEl) {
        avgElevationRemainingLeadInEl.textContent = formatElevation(avgElevationRemainingLeadIn);
        avgElevationRemainingLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Average elevation gain per route including lead-in (remaining routes)");
    }
    
    // Update Strava activity stats
    updateStravaStats();
}

// ==================== Strava power visualizations ====================

function parseStoredMetricNumber(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Avg / max HR from linked activity (camelCase from our save, or snake_case if present). */
function getActivityHeartRates(activity) {
    if (!activity) return { avgHr: null, maxHr: null };
    const avgHr = parseStoredMetricNumber(
        activity.averageHeartrate ?? activity.average_heartrate
    );
    const maxHr = parseStoredMetricNumber(activity.maxHeartrate ?? activity.max_heartrate);
    return { avgHr, maxHr };
}

function formatAvgHeartRateForDisplay(bpm) {
    if (bpm == null || !Number.isFinite(bpm)) return '';
    return `${(Math.round(bpm * 10) / 10).toFixed(1)} bpm`;
}

function formatMaxHeartRateForDisplay(bpm) {
    if (bpm == null || !Number.isFinite(bpm)) return '';
    return `${Math.round(bpm)} bpm`;
}

function startOfLocalDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getLatestActivityDate() {
    let latest = null;
    Object.values(routeActivities).forEach(a => {
        if (!a?.startDate) return;
        const t = new Date(a.startDate).getTime();
        if (!Number.isNaN(t) && (latest == null || t > latest)) latest = t;
    });
    return latest == null ? null : new Date(latest);
}

function computeDefaultStravaChartsWindowStart() {
    const latest = getLatestActivityDate();
    const anchor = latest ? startOfLocalDay(latest) : startOfLocalDay(new Date());
    const start = new Date(anchor);
    start.setDate(start.getDate() - (STRAVA_CHART_WINDOW_DAYS - 1));
    return startOfLocalDay(start).getTime();
}

function initStravaChartsWindowIfNeeded() {
    if (stravaChartsWindowStartMs == null) {
        stravaChartsWindowStartMs = computeDefaultStravaChartsWindowStart();
    }
}

function getStravaChartsWindowRange() {
    const baseStart = stravaChartsWindowStartMs ?? computeDefaultStravaChartsWindowStart();
    const startNorm = startOfLocalDay(new Date(baseStart));
    const offset = stravaChartsPanPreviewOffsetMs || 0;
    const rangeStart = new Date(startNorm.getTime() + offset);
    const end = new Date(startNorm);
    end.setDate(end.getDate() + (STRAVA_CHART_WINDOW_DAYS - 1));
    end.setHours(23, 59, 59, 999);
    const rangeEnd = new Date(end.getTime() + offset);
    return { start: rangeStart, end: rangeEnd };
}

function getMaxStravaChartsWindowStartMs() {
    const today = startOfLocalDay(new Date());
    const maxStart = new Date(today);
    maxStart.setDate(maxStart.getDate() - (STRAVA_CHART_WINDOW_DAYS - 1));
    return maxStart.getTime();
}

function clampStravaChartsWindow() {
    if (stravaChartsWindowStartMs == null) return;
    const maxStart = getMaxStravaChartsWindowStartMs();
    if (stravaChartsWindowStartMs > maxStart) stravaChartsWindowStartMs = maxStart;
}

function shiftStravaChartsWindow(deltaDays) {
    stravaChartsPanPreviewOffsetMs = 0;
    initStravaChartsWindowIfNeeded();
    const d = new Date(stravaChartsWindowStartMs);
    d.setDate(d.getDate() + deltaDays);
    stravaChartsWindowStartMs = startOfLocalDay(d).getTime();
    clampStravaChartsWindow();
}

function getStravaChartsSwipePlotWidth() {
    const row = document.getElementById('strava-charts-row');
    const svg =
        row?.querySelector('.strava-power-chart') || row?.querySelector('.strava-hr-chart');
    const w = svg?.getBoundingClientRect().width;
    return w && w > 0 ? w : 320;
}

function clampStravaChartsPanPreviewOffset() {
    const base = stravaChartsWindowStartMs ?? computeDefaultStravaChartsWindowStart();
    const startNorm = startOfLocalDay(new Date(base));
    const maxStart = getMaxStravaChartsWindowStartMs();
    const maxOffset = maxStart - startNorm.getTime();
    if (stravaChartsPanPreviewOffsetMs > maxOffset) {
        stravaChartsPanPreviewOffsetMs = maxOffset;
    }
}

function commitStravaChartsPanPreview() {
    if (!stravaChartsPanPreviewOffsetMs) return;
    initStravaChartsWindowIfNeeded();
    const base = stravaChartsWindowStartMs;
    const startNorm = startOfLocalDay(new Date(base));
    const finalMs = startNorm.getTime() + stravaChartsPanPreviewOffsetMs;
    stravaChartsWindowStartMs = startOfLocalDay(new Date(finalMs)).getTime();
    stravaChartsPanPreviewOffsetMs = 0;
    clampStravaChartsWindow();
}

function cancelStravaChartsSwipeRaf() {
    if (stravaChartsSwipeRaf != null) {
        cancelAnimationFrame(stravaChartsSwipeRaf);
        stravaChartsSwipeRaf = null;
    }
}

function requestStravaChartsSwipeFrame() {
    if (stravaChartsSwipeRaf != null) {
        cancelAnimationFrame(stravaChartsSwipeRaf);
    }
    stravaChartsSwipeRaf = requestAnimationFrame(() => {
        stravaChartsSwipeRaf = null;
        renderStravaPowerTrendChart();
        renderStravaHeartTrendChart();
        updateStravaChartsNavUI();
    });
}

function removeStravaChartsSwipeDocumentListeners() {
    if (stravaChartsSwipeDocMove) {
        window.removeEventListener('pointermove', stravaChartsSwipeDocMove, {
            capture: true,
            passive: false
        });
        window.removeEventListener('pointerup', stravaChartsSwipeDocEnd, { capture: true });
        window.removeEventListener('pointercancel', stravaChartsSwipeDocEnd, { capture: true });
        stravaChartsSwipeDocMove = null;
        stravaChartsSwipeDocEnd = null;
    }
    if (stravaChartsSwipeDocTouchMove) {
        window.removeEventListener('touchmove', stravaChartsSwipeDocTouchMove, {
            capture: true,
            passive: false
        });
        window.removeEventListener('touchend', stravaChartsSwipeDocTouchEnd, { capture: true });
        window.removeEventListener('touchcancel', stravaChartsSwipeDocTouchEnd, { capture: true });
        stravaChartsSwipeDocTouchMove = null;
        stravaChartsSwipeDocTouchEnd = null;
    }
}

function stravaChartsSwipeFindTouch(ev, touchId) {
    for (let i = 0; i < ev.touches.length; i++) {
        if (ev.touches[i].identifier === touchId) return ev.touches[i];
    }
    return null;
}

function stravaChartsSwipeTryBeginDrag(st, clientX, clientY, row) {
    const dx = clientX - st.originX;
    const dy = clientY - st.originY;
    if (st.dragging) return true;
    if (dx * dx + dy * dy < STRAVA_CHART_SWIPE_DRAG_THRESHOLD_PX ** 2) return false;
    st.dragging = true;
    st.plotWCached = Math.max(getStravaChartsSwipePlotWidth(), 120);
    row.classList.add('strava-charts-row--panning');
    if (st.pointerId != null) {
        try {
            row.setPointerCapture(st.pointerId);
        } catch {
            /* ignore */
        }
    }
    return true;
}

function stravaChartsSwipeApplyClientX(st, clientX) {
    initStravaChartsWindowIfNeeded();
    const plotW = st.plotWCached || Math.max(getStravaChartsSwipePlotWidth(), 120);
    const dx = clientX - st.originX;
    const windowMs = STRAVA_CHART_WINDOW_DAYS * 86400000;
    stravaChartsPanPreviewOffsetMs = (-dx / plotW) * windowMs;
    clampStravaChartsPanPreviewOffset();
    requestStravaChartsSwipeFrame();
}

function stravaChartsSwipeFinish(row, st, cancelled, swallowSyntheticClick) {
    stravaChartsSwipeState = null;
    removeStravaChartsSwipeDocumentListeners();
    row.classList.remove('strava-charts-row--panning');
    cancelStravaChartsSwipeRaf();
    if (st.pointerId != null) {
        try {
            row.releasePointerCapture(st.pointerId);
        } catch {
            /* ignore */
        }
    }

    if (st.dragging) {
        if (cancelled) {
            stravaChartsPanPreviewOffsetMs = 0;
        } else {
            commitStravaChartsPanPreview();
            if (swallowSyntheticClick) {
                const swallowClick = ce => {
                    ce.preventDefault();
                    ce.stopPropagation();
                    ce.stopImmediatePropagation();
                    document.removeEventListener('click', swallowClick, true);
                };
                document.addEventListener('click', swallowClick, true);
                setTimeout(() => {
                    document.removeEventListener('click', swallowClick, true);
                }, 800);
            }
        }
        renderStravaPowerTrendChart();
        renderStravaHeartTrendChart();
        updateStravaChartsNavUI();
    } else {
        stravaChartsPanPreviewOffsetMs = 0;
    }
}

function setupStravaChartsSwipeListeners() {
    const row = document.getElementById('strava-charts-row');
    if (!row) return;

    // Touch (required on iOS WebKit — Firefox on iOS, Safari; pointer move/up often unreliable)
    row.addEventListener(
        'touchstart',
        e => {
            if (!hasAnyStravaTrendChartData()) return;
            if (e.touches.length !== 1) return;

            removeStravaChartsSwipeDocumentListeners();
            cancelStravaChartsSwipeRaf();

            const t = e.touches[0];
            stravaChartsSwipeState = {
                source: 'touch',
                touchId: t.identifier,
                pointerId: null,
                originX: t.clientX,
                originY: t.clientY,
                dragging: false,
                plotWCached: null
            };

            stravaChartsSwipeDocTouchMove = ev => {
                const st = stravaChartsSwipeState;
                if (!st || st.source !== 'touch') return;
                const touch = stravaChartsSwipeFindTouch(ev, st.touchId);
                if (!touch) return;

                if (!stravaChartsSwipeTryBeginDrag(st, touch.clientX, touch.clientY, row)) return;
                stravaChartsSwipeApplyClientX(st, touch.clientX);
                ev.preventDefault();
            };

            stravaChartsSwipeDocTouchEnd = ev => {
                const st = stravaChartsSwipeState;
                if (!st || st.source !== 'touch') return;
                let ended = false;
                for (let i = 0; i < ev.changedTouches.length; i++) {
                    if (ev.changedTouches[i].identifier === st.touchId) {
                        ended = true;
                        break;
                    }
                }
                if (!ended) return;

                const cancelled = ev.type === 'touchcancel';
                stravaChartsSwipeFinish(row, st, cancelled, true);
            };

            window.addEventListener('touchmove', stravaChartsSwipeDocTouchMove, {
                capture: true,
                passive: false
            });
            window.addEventListener('touchend', stravaChartsSwipeDocTouchEnd, { capture: true });
            window.addEventListener('touchcancel', stravaChartsSwipeDocTouchEnd, { capture: true });
        },
        { capture: true, passive: false }
    );

    // Mouse / pen / touch: pointer events (some mobile browsers only emit pointer for touch)
    row.addEventListener('pointerdown', e => {
        if (!hasAnyStravaTrendChartData()) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;

        removeStravaChartsSwipeDocumentListeners();
        cancelStravaChartsSwipeRaf();

        stravaChartsSwipeState = {
            source: 'pointer',
            pointerId: e.pointerId,
            originX: e.clientX,
            originY: e.clientY,
            dragging: false,
            plotWCached: null
        };

        stravaChartsSwipeDocMove = ev => {
            const st = stravaChartsSwipeState;
            if (!st || st.source !== 'pointer' || ev.pointerId !== st.pointerId) return;

            if (!stravaChartsSwipeTryBeginDrag(st, ev.clientX, ev.clientY, row)) return;
            stravaChartsSwipeApplyClientX(st, ev.clientX);
            ev.preventDefault();
        };

        stravaChartsSwipeDocEnd = ev => {
            const st = stravaChartsSwipeState;
            if (!st || st.source !== 'pointer' || ev.pointerId !== st.pointerId) return;

            const cancelled = ev.type === 'pointercancel';
            stravaChartsSwipeFinish(row, st, cancelled, true);
        };

        window.addEventListener('pointermove', stravaChartsSwipeDocMove, {
            capture: true,
            passive: false
        });
        window.addEventListener('pointerup', stravaChartsSwipeDocEnd, { capture: true });
        window.addEventListener('pointercancel', stravaChartsSwipeDocEnd, { capture: true });
    }, { capture: true });
}

function filterChartPointsByWindow(points, rangeStart, rangeEnd) {
    const t0 = rangeStart.getTime();
    const t1 = rangeEnd.getTime();
    return points.filter(p => {
        const t = p.date.getTime();
        return t >= t0 && t <= t1;
    });
}

function formatStravaChartsNavLabel(range) {
    try {
        const a = range.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const b = range.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        return `${a} – ${b}`;
    } catch {
        return '';
    }
}

function hasAnyStravaTrendChartData() {
    return (
        buildPowerSeriesFromRouteActivities().length > 0 ||
        buildHeartSeriesFromRouteActivities().length > 0
    );
}

function updateStravaChartsNavUI() {
    const nav = document.getElementById('strava-charts-nav');
    const label = document.getElementById('strava-charts-nav-label');
    const nextBtn = document.getElementById('strava-charts-nav-next');
    if (!nav || !label) return;
    if (!hasAnyStravaTrendChartData()) {
        nav.hidden = true;
        return;
    }
    nav.hidden = false;
    initStravaChartsWindowIfNeeded();
    clampStravaChartsWindow();
    const range = getStravaChartsWindowRange();
    label.textContent = formatStravaChartsNavLabel(range);
    if (nextBtn) {
        const maxStart = getMaxStravaChartsWindowStartMs();
        const tentativeStart = startOfLocalDay(range.start).getTime();
        nextBtn.disabled = tentativeStart >= maxStart;
    }
}

function removeStravaTrendOutsideDismissListener() {
    if (!stravaTrendOutsideDismissInstalled) return;
    stravaTrendOutsideDismissInstalled = false;
    document.removeEventListener('pointerdown', stravaTrendOutsideDismissPointerDown, true);
}

function stravaTrendOutsideDismissPointerDown(ev) {
    if (!stravaTrendArmedHit) return;
    if (ev.target === stravaTrendArmedHit) return;
    clearStravaTrendArmedState();
}

function installStravaTrendOutsideDismissListener() {
    if (stravaTrendOutsideDismissInstalled) return;
    stravaTrendOutsideDismissInstalled = true;
    document.addEventListener('pointerdown', stravaTrendOutsideDismissPointerDown, true);
}

function clearStravaTrendArmedState() {
    removeStravaTrendOutsideDismissListener();
    if (stravaTrendArmedHit) {
        const g = stravaTrendArmedHit.parentElement;
        if (g) {
            g.classList.remove('strava-power-marker-group--hover', 'strava-hr-marker-group--hover');
        }
        stravaTrendArmedHit = null;
    }
    document.querySelectorAll('.strava-power-chart-tooltip, .strava-hr-chart-tooltip').forEach(el => {
        el.hidden = true;
    });
}

/** First click/tap: show ride summary tooltip; second on same point: activity modal. */
function attachStravaTrendPointRevealThenOpen(hit, routeName, opts) {
    const { tooltip, chartInner, buildTooltipHtml, hoverClass } = opts;
    const g = hit.parentElement;

    hit.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        const act = routeActivities[routeName];
        if (!act) return;

        if (stravaTrendArmedHit === hit) {
            clearStravaTrendArmedState();
            showActivityDetailsModal(act, routeName);
            return;
        }

        clearStravaTrendArmedState();
        stravaTrendArmedHit = hit;
        if (g) g.classList.add(hoverClass);
        if (tooltip && chartInner) {
            tooltip.innerHTML = buildTooltipHtml();
            positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
        }
        installStravaTrendOutsideDismissListener();
    });

    hit.addEventListener('keydown', evt => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        evt.preventDefault();
        evt.stopPropagation();
        const act = routeActivities[routeName];
        if (!act) return;

        if (stravaTrendArmedHit === hit) {
            clearStravaTrendArmedState();
            showActivityDetailsModal(act, routeName);
            return;
        }

        clearStravaTrendArmedState();
        stravaTrendArmedHit = hit;
        if (g) g.classList.add(hoverClass);
        if (tooltip && chartInner) {
            tooltip.innerHTML = buildTooltipHtml();
            const r = hit.getBoundingClientRect();
            positionStravaChartTooltip(r.left + r.width / 2, r.top + r.height / 2, chartInner, tooltip);
        }
        installStravaTrendOutsideDismissListener();
    });
}

function setupStravaChartsInteractionListeners() {
    if (stravaChartsInteractionListenersBound) return;
    stravaChartsInteractionListenersBound = true;
    const prev = document.getElementById('strava-charts-nav-prev');
    const next = document.getElementById('strava-charts-nav-next');
    prev?.addEventListener('click', () => {
        shiftStravaChartsWindow(-STRAVA_CHART_WINDOW_DAYS);
        renderStravaPowerTrendChart();
        renderStravaHeartTrendChart();
        updateStravaChartsNavUI();
    });
    next?.addEventListener('click', () => {
        shiftStravaChartsWindow(STRAVA_CHART_WINDOW_DAYS);
        renderStravaPowerTrendChart();
        renderStravaHeartTrendChart();
        updateStravaChartsNavUI();
    });
    setupStravaChartsSwipeListeners();
}

function buildPowerSeriesFromRouteActivities() {
    const points = [];
    for (const [routeName, activity] of Object.entries(routeActivities)) {
        if (!activity || !activity.startDate) continue;
        const avg = activity.averageWatts;
        const weighted = activity.weightedAverageWatts;
        if (avg == null && weighted == null) continue;
        const date = new Date(activity.startDate);
        if (Number.isNaN(date.getTime())) continue;
        points.push({
            routeName,
            date,
            avg: avg != null ? Number(avg) : null,
            weighted: weighted != null ? Number(weighted) : null
        });
    }
    points.sort((a, b) => a.date - b.date);
    return points;
}

function buildHeartSeriesFromRouteActivities() {
    const points = [];
    for (const [routeName, activity] of Object.entries(routeActivities)) {
        if (!activity || !activity.startDate) continue;
        const { avgHr, maxHr } = getActivityHeartRates(activity);
        if (avgHr == null && maxHr == null) continue;
        const date = new Date(activity.startDate);
        if (Number.isNaN(date.getTime())) continue;
        points.push({
            routeName,
            date,
            avgHr,
            maxHr
        });
    }
    points.sort((a, b) => a.date - b.date);
    return points;
}

function ensureStravaChartTooltip(chartInner, tooltipClassName) {
    let tip = chartInner.querySelector(`.${tooltipClassName}`);
    if (!tip) {
        tip = document.createElement('div');
        tip.className = tooltipClassName;
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        chartInner.appendChild(tip);
    }
    return tip;
}

function formatChartTooltipDate(d) {
    try {
        return d.toLocaleDateString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch {
        return '';
    }
}

function positionStravaChartTooltip(clientX, clientY, chartInner, tooltip) {
    const innerRect = chartInner.getBoundingClientRect();
    tooltip.hidden = false;
    const margin = 10;
    const offset = 14;
    let left = clientX - innerRect.left + offset;
    let top = clientY - innerRect.top - offset;

    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    if (left + tw > innerRect.width - margin) {
        left = clientX - innerRect.left - tw - offset;
    }
    if (left < margin) left = margin;
    if (top < margin) {
        top = clientY - innerRect.top + offset;
    }
    if (top + th > innerRect.height - margin) {
        top = innerRect.height - th - margin;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}

function buildPowerTooltipHtml(p) {
    const avgLine =
        p.avg != null && !Number.isNaN(p.avg)
            ? `<div class="strava-power-tooltip-row"><span class="strava-power-tooltip-label strava-power-tooltip-label--avg">Avg power</span><span class="strava-power-tooltip-value">${Math.round(p.avg)} W</span></div>`
            : '';
    const wLine =
        p.weighted != null && !Number.isNaN(p.weighted)
            ? `<div class="strava-power-tooltip-row"><span class="strava-power-tooltip-label strava-power-tooltip-label--weighted">Weighted</span><span class="strava-power-tooltip-value">${Math.round(p.weighted)} W</span></div>`
            : '';
    return `
        <div class="strava-power-tooltip-title">${escapeHtml(p.routeName)}</div>
        <div class="strava-power-tooltip-date">${escapeHtml(formatChartTooltipDate(p.date))}</div>
        ${avgLine}${wLine}
    `;
}

function buildHeartTooltipHtml(p) {
    const avgLine =
        p.avgHr != null && !Number.isNaN(p.avgHr)
            ? `<div class="strava-power-tooltip-row"><span class="strava-power-tooltip-label strava-hr-tooltip-label--avg">Avg HR</span><span class="strava-power-tooltip-value">${formatAvgHeartRateForDisplay(p.avgHr)}</span></div>`
            : '';
    const maxLine =
        p.maxHr != null && !Number.isNaN(p.maxHr)
            ? `<div class="strava-power-tooltip-row"><span class="strava-power-tooltip-label strava-hr-tooltip-label--max">Max HR</span><span class="strava-power-tooltip-value">${formatMaxHeartRateForDisplay(p.maxHr)}</span></div>`
            : '';
    return `
        <div class="strava-power-tooltip-title">${escapeHtml(p.routeName)}</div>
        <div class="strava-power-tooltip-date">${escapeHtml(formatChartTooltipDate(p.date))}</div>
        ${avgLine}${maxLine}
    `;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderStravaPowerTrendChart() {
    const wrap = document.getElementById('strava-power-chart-wrap');
    const svg = document.getElementById('strava-power-chart');
    if (!wrap || !svg) return;

    clearStravaTrendArmedState();

    const allPoints = buildPowerSeriesFromRouteActivities();
    const chartInner = svg.parentElement;
    const existingTip = chartInner?.querySelector('.strava-power-chart-tooltip');
    if (allPoints.length === 0) {
        wrap.classList.add('strava-power-chart-wrap--empty');
        svg.replaceChildren();
        if (existingTip) existingTip.hidden = true;
        return;
    }

    wrap.classList.remove('strava-power-chart-wrap--empty');
    initStravaChartsWindowIfNeeded();
    clampStravaChartsWindow();
    const range = getStravaChartsWindowRange();
    const points = filterChartPointsByWindow(allPoints, range.start, range.end);

    const W = 640;
    const H = 260;
    const pl = 48;
    const pr = 14;
    const pt = 14;
    const pb = 40;
    const plotW = W - pl - pr;
    const plotH = H - pt - pb;

    const tMin = range.start.getTime();
    const tMax = range.end.getTime();
    const xSpan = Math.max(tMax - tMin, 1);
    const xAt = t => pl + ((t - tMin) / xSpan) * plotW;

    const values = [];
    points.forEach(p => {
        if (p.avg != null && !Number.isNaN(p.avg)) values.push(p.avg);
        if (p.weighted != null && !Number.isNaN(p.weighted)) values.push(p.weighted);
    });
    let yMin;
    let yMax;
    if (values.length === 0) {
        yMin = 0;
        yMax = 280;
    } else {
        yMin = Math.min(...values);
        yMax = Math.max(...values);
        if (yMin === yMax) {
            yMin = Math.max(0, yMin - 25);
            yMax = yMax + 25;
        } else {
            const pad = (yMax - yMin) * 0.08;
            yMin = Math.max(0, yMin - pad);
            yMax = yMax + pad;
        }
    }
    const ySpan = Math.max(yMax - yMin, 1);
    const yAt = watts => pt + plotH - ((watts - yMin) / ySpan) * plotH;

    function pathFor(getter) {
        let d = '';
        let penUp = true;
        for (const p of points) {
            const v = getter(p);
            if (v == null || Number.isNaN(v)) {
                penUp = true;
                continue;
            }
            const x = xAt(p.date.getTime());
            const y = yAt(v);
            d += penUp ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
            penUp = false;
        }
        return d;
    }

    const avgPath = pathFor(p => p.avg);
    const weightedPath = pathFor(p => p.weighted);

    const yTicks = 4;
    const tickLabels = [];
    for (let i = 0; i <= yTicks; i++) {
        const w = yMin + (i / yTicks) * (yMax - yMin);
        const y = yAt(w);
        tickLabels.push({ w: Math.round(w), y });
    }

    const formatShortDate = d => {
        try {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    };
    const midTime = (tMin + tMax) / 2;
    const midDate = new Date(midTime);
    const xLabelCandidates = [
        { x: xAt(tMin), text: formatShortDate(range.start) },
        { x: xAt(midTime), text: formatShortDate(midDate) },
        { x: xAt(tMax), text: formatShortDate(range.end) }
    ];

    const ns = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.replaceChildren();

    const frag = document.createDocumentFragment();

    const border = document.createElementNS(ns, 'rect');
    border.setAttribute('x', pl);
    border.setAttribute('y', pt);
    border.setAttribute('width', plotW);
    border.setAttribute('height', plotH);
    border.setAttribute('fill', 'none');
    border.setAttribute('class', 'strava-power-chart-plot-border');
    frag.appendChild(border);

    tickLabels.forEach(({ w, y }) => {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', pl);
        line.setAttribute('x2', pl + plotW);
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
        line.setAttribute('class', 'strava-power-chart-grid');
        frag.appendChild(line);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', pl - 8);
        text.setAttribute('y', y + 4);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('class', 'strava-power-chart-axis-text');
        text.textContent = String(w);
        frag.appendChild(text);
    });

    xLabelCandidates.forEach(({ x, text }) => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', H - 10);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'strava-power-chart-axis-text');
        t.textContent = text;
        frag.appendChild(t);
    });

    const yAxis = document.createElementNS(ns, 'text');
    yAxis.setAttribute('x', 12);
    yAxis.setAttribute('y', pt + plotH / 2);
    yAxis.setAttribute('text-anchor', 'middle');
    yAxis.setAttribute('transform', `rotate(-90,12,${pt + plotH / 2})`);
    yAxis.setAttribute('class', 'strava-power-chart-axis-label');
    yAxis.textContent = 'Watts';
    frag.appendChild(yAxis);

    if (weightedPath) {
        const pEl = document.createElementNS(ns, 'path');
        pEl.setAttribute('d', weightedPath);
        pEl.setAttribute('fill', 'none');
        pEl.setAttribute('class', 'strava-power-line strava-power-line--weighted');
        frag.appendChild(pEl);
    }
    if (avgPath) {
        const pEl = document.createElementNS(ns, 'path');
        pEl.setAttribute('d', avgPath);
        pEl.setAttribute('fill', 'none');
        pEl.setAttribute('class', 'strava-power-line strava-power-line--avg');
        frag.appendChild(pEl);
    }

    if (points.length === 0) {
        const emptyMsg = document.createElementNS(ns, 'text');
        emptyMsg.setAttribute('x', pl + plotW / 2);
        emptyMsg.setAttribute('y', pt + plotH / 2);
        emptyMsg.setAttribute('text-anchor', 'middle');
        emptyMsg.setAttribute('class', 'strava-chart-period-empty-msg');
        emptyMsg.textContent = 'No power data in this period';
        frag.appendChild(emptyMsg);
    }

    const tooltip = chartInner ? ensureStravaChartTooltip(chartInner, 'strava-power-chart-tooltip') : null;

    points.forEach(p => {
        const cx = xAt(p.date.getTime());
        const ys = [];
        if (p.avg != null && !Number.isNaN(p.avg)) ys.push(yAt(p.avg));
        if (p.weighted != null && !Number.isNaN(p.weighted)) ys.push(yAt(p.weighted));
        if (ys.length === 0) return;

        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'strava-power-marker-group');

        if (p.avg != null && !Number.isNaN(p.avg)) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx);
            c.setAttribute('cy', yAt(p.avg));
            c.setAttribute('r', 4);
            c.setAttribute('class', 'strava-power-dot strava-power-dot--avg');
            g.appendChild(c);
        }
        if (p.weighted != null && !Number.isNaN(p.weighted)) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx);
            c.setAttribute('cy', yAt(p.weighted));
            c.setAttribute('r', 4);
            c.setAttribute('class', 'strava-power-dot strava-power-dot--weighted');
            g.appendChild(c);
        }

        const yTop = Math.min(...ys) - 18;
        const yBot = Math.max(...ys) + 18;
        const hit = document.createElementNS(ns, 'rect');
        hit.setAttribute('x', cx - 18);
        hit.setAttribute('y', yTop);
        hit.setAttribute('width', 36);
        hit.setAttribute('height', Math.max(yBot - yTop, 24));
        hit.setAttribute('fill', 'transparent');
        hit.setAttribute('class', 'strava-power-hit');
        hit.setAttribute('role', 'button');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('focusable', 'true');
        hit.setAttribute(
            'aria-label',
            `${p.routeName}: first tap for summary, second tap for full activity`
        );
        g.appendChild(hit);

        attachStravaTrendPointRevealThenOpen(hit, p.routeName, {
            tooltip,
            chartInner,
            buildTooltipHtml: () => buildPowerTooltipHtml(p),
            hoverClass: 'strava-power-marker-group--hover'
        });

        if (tooltip && chartInner) {
            const onEnterMove = evt => {
                g.classList.add('strava-power-marker-group--hover');
                tooltip.innerHTML = buildPowerTooltipHtml(p);
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            };
            const onLeave = () => {
                g.classList.remove('strava-power-marker-group--hover');
                if (stravaTrendArmedHit !== hit) tooltip.hidden = true;
            };
            hit.addEventListener('mouseenter', onEnterMove);
            hit.addEventListener('mousemove', evt => {
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            });
            hit.addEventListener('mouseleave', onLeave);
        }

        frag.appendChild(g);
    });

    svg.appendChild(frag);
}

function renderStravaHeartTrendChart() {
    const wrap = document.getElementById('strava-hr-chart-wrap');
    const svg = document.getElementById('strava-hr-chart');
    if (!wrap || !svg) return;

    clearStravaTrendArmedState();

    const allPoints = buildHeartSeriesFromRouteActivities();
    const chartInner = svg.parentElement;
    const existingTip = chartInner?.querySelector('.strava-hr-chart-tooltip');
    if (allPoints.length === 0) {
        wrap.classList.add('strava-hr-chart-wrap--empty');
        svg.replaceChildren();
        if (existingTip) existingTip.hidden = true;
        return;
    }

    wrap.classList.remove('strava-hr-chart-wrap--empty');
    initStravaChartsWindowIfNeeded();
    clampStravaChartsWindow();
    const range = getStravaChartsWindowRange();
    const points = filterChartPointsByWindow(allPoints, range.start, range.end);

    const W = 640;
    const H = 260;
    const pl = 48;
    const pr = 14;
    const pt = 14;
    const pb = 40;
    const plotW = W - pl - pr;
    const plotH = H - pt - pb;

    const tMin = range.start.getTime();
    const tMax = range.end.getTime();
    const xSpan = Math.max(tMax - tMin, 1);
    const xAt = t => pl + ((t - tMin) / xSpan) * plotW;

    const values = [];
    points.forEach(p => {
        if (p.avgHr != null && !Number.isNaN(p.avgHr)) values.push(p.avgHr);
        if (p.maxHr != null && !Number.isNaN(p.maxHr)) values.push(p.maxHr);
    });
    let yMin;
    let yMax;
    if (values.length === 0) {
        yMin = 60;
        yMax = 180;
    } else {
        yMin = Math.min(...values);
        yMax = Math.max(...values);
        if (yMin === yMax) {
            yMin = Math.max(40, yMin - 8);
            yMax = yMax + 8;
        } else {
            const pad = (yMax - yMin) * 0.08;
            yMin = Math.max(40, Math.floor(yMin - pad));
            yMax = Math.ceil(yMax + pad);
        }
    }
    const ySpan = Math.max(yMax - yMin, 1);
    const yAt = bpm => pt + plotH - ((bpm - yMin) / ySpan) * plotH;

    function pathFor(getter) {
        let d = '';
        let penUp = true;
        for (const p of points) {
            const v = getter(p);
            if (v == null || Number.isNaN(v)) {
                penUp = true;
                continue;
            }
            const x = xAt(p.date.getTime());
            const y = yAt(v);
            d += penUp ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
            penUp = false;
        }
        return d;
    }

    const avgPath = pathFor(p => p.avgHr);
    const maxPath = pathFor(p => p.maxHr);

    const yTicks = 4;
    const tickLabels = [];
    for (let i = 0; i <= yTicks; i++) {
        const bpm = yMin + (i / yTicks) * (yMax - yMin);
        const y = yAt(bpm);
        tickLabels.push({ w: Math.round(bpm), y });
    }

    const formatShortDate = d => {
        try {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    };
    const midTime = (tMin + tMax) / 2;
    const midDate = new Date(midTime);
    const xLabelCandidates = [
        { x: xAt(tMin), text: formatShortDate(range.start) },
        { x: xAt(midTime), text: formatShortDate(midDate) },
        { x: xAt(tMax), text: formatShortDate(range.end) }
    ];

    const ns = 'http://www.w3.org/2000/svg';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.replaceChildren();

    const frag = document.createDocumentFragment();

    const border = document.createElementNS(ns, 'rect');
    border.setAttribute('x', pl);
    border.setAttribute('y', pt);
    border.setAttribute('width', plotW);
    border.setAttribute('height', plotH);
    border.setAttribute('fill', 'none');
    border.setAttribute('class', 'strava-hr-chart-plot-border');
    frag.appendChild(border);

    tickLabels.forEach(({ w, y }) => {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', pl);
        line.setAttribute('x2', pl + plotW);
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
        line.setAttribute('class', 'strava-hr-chart-grid');
        frag.appendChild(line);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', pl - 8);
        text.setAttribute('y', y + 4);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('class', 'strava-hr-chart-axis-text');
        text.textContent = String(w);
        frag.appendChild(text);
    });

    xLabelCandidates.forEach(({ x, text }) => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', H - 10);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'strava-hr-chart-axis-text');
        t.textContent = text;
        frag.appendChild(t);
    });

    const yAxis = document.createElementNS(ns, 'text');
    yAxis.setAttribute('x', 12);
    yAxis.setAttribute('y', pt + plotH / 2);
    yAxis.setAttribute('text-anchor', 'middle');
    yAxis.setAttribute('transform', `rotate(-90,12,${pt + plotH / 2})`);
    yAxis.setAttribute('class', 'strava-hr-chart-axis-label');
    yAxis.textContent = 'bpm';
    frag.appendChild(yAxis);

    if (maxPath) {
        const pEl = document.createElementNS(ns, 'path');
        pEl.setAttribute('d', maxPath);
        pEl.setAttribute('fill', 'none');
        pEl.setAttribute('class', 'strava-hr-line strava-hr-line--max');
        frag.appendChild(pEl);
    }
    if (avgPath) {
        const pEl = document.createElementNS(ns, 'path');
        pEl.setAttribute('d', avgPath);
        pEl.setAttribute('fill', 'none');
        pEl.setAttribute('class', 'strava-hr-line strava-hr-line--avg');
        frag.appendChild(pEl);
    }

    if (points.length === 0) {
        const emptyMsg = document.createElementNS(ns, 'text');
        emptyMsg.setAttribute('x', pl + plotW / 2);
        emptyMsg.setAttribute('y', pt + plotH / 2);
        emptyMsg.setAttribute('text-anchor', 'middle');
        emptyMsg.setAttribute('class', 'strava-chart-period-empty-msg');
        emptyMsg.textContent = 'No heart rate data in this period';
        frag.appendChild(emptyMsg);
    }

    const tooltip = chartInner ? ensureStravaChartTooltip(chartInner, 'strava-hr-chart-tooltip') : null;

    points.forEach(p => {
        const cx = xAt(p.date.getTime());
        const ys = [];
        if (p.avgHr != null && !Number.isNaN(p.avgHr)) ys.push(yAt(p.avgHr));
        if (p.maxHr != null && !Number.isNaN(p.maxHr)) ys.push(yAt(p.maxHr));
        if (ys.length === 0) return;

        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'strava-hr-marker-group');

        if (p.avgHr != null && !Number.isNaN(p.avgHr)) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx);
            c.setAttribute('cy', yAt(p.avgHr));
            c.setAttribute('r', 4);
            c.setAttribute('class', 'strava-hr-dot strava-hr-dot--avg');
            g.appendChild(c);
        }
        if (p.maxHr != null && !Number.isNaN(p.maxHr)) {
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx);
            c.setAttribute('cy', yAt(p.maxHr));
            c.setAttribute('r', 4);
            c.setAttribute('class', 'strava-hr-dot strava-hr-dot--max');
            g.appendChild(c);
        }

        const yTop = Math.min(...ys) - 18;
        const yBot = Math.max(...ys) + 18;
        const hit = document.createElementNS(ns, 'rect');
        hit.setAttribute('x', cx - 18);
        hit.setAttribute('y', yTop);
        hit.setAttribute('width', 36);
        hit.setAttribute('height', Math.max(yBot - yTop, 24));
        hit.setAttribute('fill', 'transparent');
        hit.setAttribute('class', 'strava-hr-hit');
        hit.setAttribute('role', 'button');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('focusable', 'true');
        hit.setAttribute(
            'aria-label',
            `${p.routeName}: first tap for summary, second tap for full activity`
        );
        g.appendChild(hit);

        attachStravaTrendPointRevealThenOpen(hit, p.routeName, {
            tooltip,
            chartInner,
            buildTooltipHtml: () => buildHeartTooltipHtml(p),
            hoverClass: 'strava-hr-marker-group--hover'
        });

        if (tooltip && chartInner) {
            const onEnterMove = evt => {
                g.classList.add('strava-hr-marker-group--hover');
                tooltip.innerHTML = buildHeartTooltipHtml(p);
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            };
            const onLeave = () => {
                g.classList.remove('strava-hr-marker-group--hover');
                if (stravaTrendArmedHit !== hit) tooltip.hidden = true;
            };
            hit.addEventListener('mouseenter', onEnterMove);
            hit.addEventListener('mousemove', evt => {
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            });
            hit.addEventListener('mouseleave', onLeave);
        }

        frag.appendChild(g);
    });

    svg.appendChild(frag);
}

function downsamplePairs(times, watts, maxPoints) {
    const n = times.length;
    if (n <= maxPoints) return { times, watts };
    const step = Math.ceil(n / maxPoints);
    const tOut = [];
    const wOut = [];
    for (let i = 0; i < n; i += step) {
        tOut.push(times[i]);
        wOut.push(watts[i]);
    }
    if (tOut[tOut.length - 1] !== times[n - 1]) {
        tOut.push(times[n - 1]);
        wOut.push(watts[n - 1]);
    }
    return { times: tOut, watts: wOut };
}

function renderActivityPowerStreamSvg(svg, times, watts) {
    const ns = 'http://www.w3.org/2000/svg';
    const W = 600;
    const H = 200;
    const pl = 44;
    const pr = 10;
    const pt = 10;
    const pb = 28;
    const plotW = W - pl - pr;
    const plotH = H - pt - pb;

    const wMin = Math.min(...watts);
    const wMax = Math.max(...watts);
    const yLo = wMin === wMax ? Math.max(0, wMin - 20) : wMin - (wMax - wMin) * 0.05;
    const yHi = wMin === wMax ? wMax + 20 : wMax + (wMax - wMin) * 0.05;

    const t0 = times[0];
    const t1 = times[times.length - 1];
    const span = Math.max(t1 - t0, 1e-6);

    const xAt = (t) => pl + ((t - t0) / span) * plotW;
    const yAt = (w) => pt + plotH - ((w - yLo) / (yHi - yLo)) * plotH;

    let d = `M${xAt(times[0]).toFixed(1)},${yAt(watts[0]).toFixed(1)}`;
    for (let i = 1; i < times.length; i++) {
        d += `L${xAt(times[i]).toFixed(1)},${yAt(watts[i]).toFixed(1)}`;
    }

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.replaceChildren();

    const border = document.createElementNS(ns, 'rect');
    border.setAttribute('x', pl);
    border.setAttribute('y', pt);
    border.setAttribute('width', plotW);
    border.setAttribute('height', plotH);
    border.setAttribute('fill', 'none');
    border.setAttribute('class', 'strava-power-chart-plot-border');
    svg.appendChild(border);

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('class', 'strava-power-line strava-power-line--stream');
    svg.appendChild(path);

    const formatElapsed = (sec) => {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    [0, 0.5, 1].forEach(fraction => {
        const sec = t0 + fraction * span;
        const x = xAt(sec);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', H - 6);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'strava-power-chart-axis-text');
        text.textContent = formatElapsed(sec - t0);
        svg.appendChild(text);
    });

    const yTicks = 3;
    for (let i = 0; i <= yTicks; i++) {
        const w = yLo + (i / yTicks) * (yHi - yLo);
        const y = yAt(w);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', pl - 6);
        text.setAttribute('y', y + 4);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('class', 'strava-power-chart-axis-text');
        text.textContent = String(Math.round(w));
        svg.appendChild(text);
    }
}

async function fetchStravaActivityStreams(activityId) {
    const token = await getStravaToken();
    if (!token) {
        throw new Error('Not authenticated with Strava');
    }

    const url = `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=time,watts&key_by_type=true`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
        if (response.status === 401) {
            sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_KEY);
            isStravaAuthenticated = false;
            updateStravaAuthUI();
            throw new Error('Strava authentication expired. Please reconnect.');
        }
        throw new Error('Could not load activity streams from Strava.');
    }

    const body = await response.json();
    let timeStream;
    let wattsStream;

    if (Array.isArray(body)) {
        timeStream = body.find(s => s.type === 'time');
        wattsStream = body.find(s => s.type === 'watts');
    } else if (body && typeof body === 'object') {
        timeStream = body.time;
        wattsStream = body.watts;
    }

    if (!wattsStream || !Array.isArray(wattsStream.data) || wattsStream.data.length === 0) {
        throw new Error('No power stream for this activity (no power meter or data unavailable).');
    }

    const watts = wattsStream.data.map(n => (n == null ? 0 : Number(n)));
    let times;
    if (timeStream && Array.isArray(timeStream.data) && timeStream.data.length === watts.length) {
        times = timeStream.data.map(n => Number(n));
    } else {
        times = watts.map((_, i) => i);
    }

    return downsamplePairs(times, watts, 900);
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
    if (activities.length === 0) {
        stravaChartsWindowStartMs = null;
        stravaChartsPanPreviewOffsetMs = 0;
        stravaChartsSwipeState = null;
    } else {
        initStravaChartsWindowIfNeeded();
        clampStravaChartsWindow();
    }

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
        stravaDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance from all linked Strava activities");
    }
    if (stravaElevationEl) {
        stravaElevationEl.textContent = formatElevation(totalElevation);
        stravaElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain from all linked Strava activities");
    }
    if (stravaMovingTimeEl) {
        stravaMovingTimeEl.textContent = formatTime(totalMovingTime);
        stravaMovingTimeEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total moving time from all linked Strava activities");
    }
    if (stravaElapsedTimeEl) {
        stravaElapsedTimeEl.textContent = formatTime(totalElapsedTime);
        stravaElapsedTimeEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elapsed time from all linked Strava activities");
    }
    if (stravaCaloriesEl) {
        stravaCaloriesEl.textContent = totalCalories.toLocaleString();
        stravaCaloriesEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total calories burned from all linked Strava activities");
    }

    const withAvgHr = activities.filter(a => getActivityHeartRates(a).avgHr != null);
    const withAvg = activities.filter(a => a.averageWatts != null);
    const withWeighted = activities.filter(a => a.weightedAverageWatts != null);

    const avgHrMean =
        withAvgHr.length > 0
            ? withAvgHr.reduce((s, a) => s + getActivityHeartRates(a).avgHr, 0) / withAvgHr.length
            : null;
    const avgPowerMean =
        withAvg.length > 0
            ? Math.round(withAvg.reduce((s, a) => s + Number(a.averageWatts), 0) / withAvg.length)
            : null;
    const weightedMean =
        withWeighted.length > 0
            ? Math.round(
                  withWeighted.reduce((s, a) => s + Number(a.weightedAverageWatts), 0) /
                      withWeighted.length
              )
            : null;

    const avgHrEl = document.getElementById('strava-avg-heartrate');
    const avgPowerEl = document.getElementById('strava-avg-power');
    const avgWeightedEl = document.getElementById('strava-avg-weighted-power');

    if (avgHrEl) {
        avgHrEl.textContent =
            avgHrMean != null ? formatAvgHeartRateForDisplay(avgHrMean) : '—';
        avgHrEl
            .closest('.stat-card-compact')
            ?.setAttribute(
                'data-tooltip',
                'Mean of average heart rate across linked activities that report it'
            );
    }
    if (avgPowerEl) {
        avgPowerEl.textContent = avgPowerMean != null ? `${avgPowerMean} W` : '—';
        avgPowerEl
            .closest('.stat-card-compact')
            ?.setAttribute(
                'data-tooltip',
                'Mean of average power across linked activities that report it'
            );
    }
    if (avgWeightedEl) {
        avgWeightedEl.textContent = weightedMean != null ? `${weightedMean} W` : '—';
        avgWeightedEl
            .closest('.stat-card-compact')
            ?.setAttribute(
                'data-tooltip',
                'Mean of weighted average power across linked activities that report it'
            );
    }

    renderStravaPowerTrendChart();
    renderStravaHeartTrendChart();
    updateStravaChartsNavUI();
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

// Sync sort dropdown and direction button with currentSort state
function updateSortSelectUI() {
    const sortSelect = document.getElementById('sort-select');
    const directionBtn = document.getElementById('sort-direction-btn');
    if (!sortSelect) return;
    if (sortSelect.value !== currentSort.by) {
        sortSelect.value = currentSort.by;
    }
    if (directionBtn) {
        directionBtn.setAttribute('title', currentSort.dir === 'asc' ? 'Ascending – click for descending' : 'Descending – click for ascending');
        directionBtn.setAttribute('aria-label', currentSort.dir === 'asc' ? 'Sort ascending – click to switch to descending' : 'Sort descending – click to switch to ascending');
        directionBtn.classList.toggle('sort-desc', currentSort.dir === 'desc');
    }
}

function persistSortPreference() {
    try {
        localStorage.setItem(CONFIG.SORT_KEY, JSON.stringify(currentSort));
    } catch (err) {
        console.warn('Could not persist sort preference:', err);
    }
}

// Setup sort dropdown and direction toggle (shared by edit and showcase)
function setupSortSelect() {
    const sortSelect = document.getElementById('sort-select');
    const directionBtn = document.getElementById('sort-direction-btn');
    if (!sortSelect) return;
    updateSortSelectUI();
    sortSelect.addEventListener('change', (e) => {
        currentSort = { ...currentSort, by: e.target.value };
        persistSortPreference();
        updateSortSelectUI();
        renderRoutes();
    });
    if (directionBtn) {
        directionBtn.addEventListener('click', () => {
            currentSort = { ...currentSort, dir: currentSort.dir === 'asc' ? 'desc' : 'asc' };
            persistSortPreference();
            updateSortSelectUI();
            renderRoutes();
        });
    }
}

// Setup event listeners
function setupEventListeners() {
    // Auth button
    authBtn.addEventListener('click', () => {
        if (isAuthenticated) {
            localStorage.removeItem(CONFIG.TOKEN_KEY);
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
            
            localStorage.setItem(CONFIG.TOKEN_KEY, token);
            isAuthenticated = true;
            updateAuthUI();
            tokenInput.value = '';
            
            // Close modal - Gist ID is always set to SHOWCASE_GIST_ID in edit mode
            authModal.style.display = 'none';
        } catch (error) {
            alert('Invalid token. Please check your GitHub Personal Access Token.');
        }
    });
    
    // Gist ID submit (optional override - normally uses SHOWCASE_GIST_ID)
    gistSubmit.addEventListener('click', () => {
        const newGistId = gistIdInput.value.trim();
        if (newGistId) {
            // Allow manual override, but warn if it's different from SHOWCASE_GIST_ID
            if (CONFIG.SHOWCASE_GIST_ID && newGistId !== CONFIG.SHOWCASE_GIST_ID) {
                if (!confirm(`You're setting a different Gist ID than SHOWCASE_GIST_ID (${CONFIG.SHOWCASE_GIST_ID}). This will only affect this browser session. Continue?`)) {
                    return;
                }
            }
            gistId = newGistId;
            // Don't save to localStorage - always use SHOWCASE_GIST_ID on next load
            loadCompletedRoutes();
            alert('Gist ID saved for this session! (Note: Will reset to SHOWCASE_GIST_ID on next page load)');
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
    
    // Sort dropdown
    setupSortSelect();
    
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
                    sessionStorage.removeItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY);
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

    setupStravaChartsInteractionListeners();
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
    
    // Sort dropdown
    setupSortSelect();
    
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

    setupStravaChartsInteractionListeners();
}

// Initialize on page load
init();

