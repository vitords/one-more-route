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
    STRAVA_TOKEN_PROXY_URL: 'https://one-more-route.vercel.app/api/strava-token'
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

// DOM Elements
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

// Initialize
async function init() {
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
    
    if (gistId) {
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
    
    // Setup event listeners
    setupEventListeners();
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
    // Save to localStorage immediately for instant feedback
    saveCompletedRoutesToLocal();
    
    if (!isAuthenticated) {
        return; // Don't show alert, just save locally
    }
    
    const token = sessionStorage.getItem(CONFIG.TOKEN_KEY);
    if (!token) {
        return; // Save locally only
    }
    
    // Clear existing timeout
    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }
    
    // Debounce: wait 1 second before syncing to Gist (batch multiple changes)
    syncTimeout = setTimeout(async () => {
        await syncToGist(token);
    }, 1000);
}

// Actually sync to Gist (called after debounce)
async function syncToGist(token) {
    if (isSyncing) {
        return; // Already syncing, skip
    }
    
    isSyncing = true;
    updateSyncStatus('syncing');
    
    const data = {
        completedRoutes: Array.from(completedRoutes),
        activities: routeActivities
    };
    
    try {
        let gist;
        
        // If no Gist ID is set, create a new Gist
        if (!gistId) {
            const response = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    description: 'Zwift Route Tracker - Completed Routes',
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
                throw new Error(error.message || 'Failed to create Gist');
            }
            
            gist = await response.json();
            gistId = gist.id;
            localStorage.setItem(CONFIG.GIST_ID_KEY, gistId);
            if (gistIdInput) {
                gistIdInput.value = gistId;
            }
            console.log('Created new Gist:', gistId);
        } else {
            // Check if Gist exists
            let response = await fetch(`https://api.github.com/gists/${gistId}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (response.status === 404) {
                // Gist doesn't exist, create a new one
                response = await fetch('https://api.github.com/gists', {
                    method: 'POST',
                    headers: {
                        'Authorization': `token ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        description: 'Zwift Route Tracker - Completed Routes',
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
                    throw new Error(error.message || 'Failed to create Gist');
                }
                
                gist = await response.json();
                gistId = gist.id;
                localStorage.setItem(CONFIG.GIST_ID_KEY, gistId);
                if (gistIdInput) {
                    gistIdInput.value = gistId;
                }
                console.log('Created new Gist (old one not found):', gistId);
            } else {
                // Update existing Gist
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.message || 'Failed to update Gist');
                }
                
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
                    throw new Error(error.message || 'Failed to update Gist');
                }
            }
        }
        
        console.log('Progress synced to Gist successfully!');
        updateSyncStatus('synced');
    } catch (error) {
        console.error('Error syncing to Gist:', error);
        updateSyncStatus('error');
        // Don't show alert - just log error, local storage already saved
    } finally {
        isSyncing = false;
    }
}

// Update sync status indicator
function updateSyncStatus(status) {
    if (!authStatus) return;
    
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
        // Clear status after 2 seconds
        setTimeout(() => {
            if (authStatus.textContent === statusText['synced']) {
                authStatus.textContent = isAuthenticated ? '✓ Authenticated' : '';
            }
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
    
    card.innerHTML = `
        <div class="route-header">
            <div class="route-name">${route.route}</div>
            <div class="route-header-actions">
                ${hasActivity ? '<span class="activity-badge" title="Has Strava activity">🏃</span>' : ''}
                <input 
                    type="checkbox" 
                    class="route-checkbox" 
                    ${isCompleted ? 'checked' : ''}
                    ${!isAuthenticated ? 'disabled' : ''}
                    data-route="${route.route}"
                >
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
        ${isCompleted ? `
            <div class="route-activity-section">
                ${hasActivity ? `
                    <div class="activity-header">
                        <button class="btn-activity-toggle" data-route="${route.route}">
                            <span class="activity-toggle-icon">▼</span> Strava Activity
                        </button>
                        <button class="btn-unlink-activity" data-route="${route.route}" title="Unlink activity">✕</button>
                    </div>
                    <div class="activity-details hidden" data-route="${route.route}">
                        ${renderActivityDetails(activity)}
                    </div>
                ` : `
                    <div class="activity-link-section">
                        <button class="btn-link-activity" data-route="${route.route}">
                            ${isStravaAuthenticated ? '🔗 Link Strava Activity' : '🔗 Connect Strava to Link Activity'}
                        </button>
                    </div>
                `}
            </div>
        ` : ''}
    `;
    
    const checkbox = card.querySelector('.route-checkbox');
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
        } else {
            card.classList.remove('completed');
            const routeNameEl = card.querySelector('.route-name');
            if (routeNameEl) {
                routeNameEl.style.textDecoration = 'none';
                routeNameEl.style.opacity = '1';
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
    
    // Activity linking/unlinking handlers
    if (isCompleted) {
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
        
        const toggleBtn = card.querySelector('.btn-activity-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const details = card.querySelector('.activity-details');
                const icon = toggleBtn.querySelector('.activity-toggle-icon');
                details.classList.toggle('hidden');
                icon.textContent = details.classList.contains('hidden') ? '▼' : '▲';
            });
        }
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
    
    return `
        <div class="activity-info">
            <div class="activity-name">
                <a href="${activity.activityUrl}" target="_blank" rel="noopener noreferrer">
                    ${activity.name || 'Strava Activity'}
                </a>
            </div>
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
                    View on Strava →
                </a>
            </div>
        </div>
    `;
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

// Update statistics
function updateStats() {
    const total = routes.length;
    const completed = completedRoutes.size;
    const remaining = total - completed;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    document.getElementById('total-routes').textContent = total;
    document.getElementById('completed-routes').textContent = completed;
    document.getElementById('remaining-routes').textContent = remaining;
    document.getElementById('percentage-complete').textContent = `${percentage}%`;
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

// Initialize on page load
init();

