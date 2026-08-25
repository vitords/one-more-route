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
    PLANNING_WKG_KEY: 'zwift_tracker_planning_wkg',
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

/** Sort keys where missing ZI estimates sort last (asc or desc). */
const ESTIMATED_TIME_SORT_KEYS = new Set([
    'estimatedTime2Wkg',
    'estimatedTime3Wkg',
    'estimatedTime4Wkg',
]);

function getPlanningWkg() {
    try {
        const v = localStorage.getItem(CONFIG.PLANNING_WKG_KEY);
        if (v === '3' || v === '4') return v;
        return '2';
    } catch {
        return '2';
    }
}

function setPlanningWkg(w) {
    try {
        localStorage.setItem(CONFIG.PLANNING_WKG_KEY, w);
    } catch (e) {
        console.warn('Could not persist planning W/kg:', e);
    }
}

/** @param {number} totalMinutes */
function formatMinutesAsDuration(totalMinutes) {
    if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '—';
    const m = Math.round(totalMinutes);
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h <= 0) return `${min}m`;
    return `${h}h ${min.toString().padStart(2, '0')}m`;
}

/** All hours rolled into one count (e.g. 127h 05m), not split by days. */
function formatDurationTotalHoursMinutes(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
    const s = Math.max(0, Math.floor(totalSeconds));
    const totalH = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${totalH}h ${m.toString().padStart(2, '0')}m`;
}

/** Calendar-style: days, hours, minutes within each day. */
function formatDurationDaysHoursMinutes(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
    const s = Math.max(0, Math.floor(totalSeconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m.toString().padStart(2, '0')}m`;
}

function setStatDualDurationFromMinutes(hmEl, dhmEl, totalMinutes, isEmpty) {
    if (!hmEl) return;
    if (isEmpty || !Number.isFinite(totalMinutes) || totalMinutes <= 0) {
        hmEl.textContent = '—';
        if (dhmEl) dhmEl.textContent = '';
        return;
    }
    const sec = Math.round(totalMinutes * 60);
    hmEl.textContent = formatDurationTotalHoursMinutes(sec);
    if (dhmEl) dhmEl.textContent = formatDurationDaysHoursMinutes(sec);
}

function setStatDualDurationFromSeconds(hmEl, dhmEl, totalSeconds, isEmpty) {
    if (!hmEl) return;
    if (isEmpty || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        hmEl.textContent = '—';
        if (dhmEl) dhmEl.textContent = '';
        return;
    }
    const sec = Math.floor(totalSeconds);
    hmEl.textContent = formatDurationTotalHoursMinutes(sec);
    if (dhmEl) dhmEl.textContent = formatDurationDaysHoursMinutes(sec);
}

/** @param {{ timeEstimatesMinutes?: Record<string, number> }} route */
function getZiEstimateMinutes(route, wkg) {
    const t = route.timeEstimatesMinutes;
    if (!t || t[wkg] == null) return null;
    const n = Number(t[wkg]);
    return Number.isFinite(n) ? n : null;
}

/** Format ZI minute estimate for cards (supports fractional minutes from ZIMetrics). */
function formatZiMinutesForCard(minutes) {
    if (minutes == null || !Number.isFinite(minutes)) return '';
    const x = Math.round(minutes * 10) / 10;
    if (Number.isInteger(x) || Math.abs(x - Math.round(x)) < 1e-9) {
        return String(Math.round(x));
    }
    return x.toFixed(1);
}

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
    
    // Check Strava authentication - a stored refresh token is enough to restore the session
    if (readStravaToken(CONFIG.STRAVA_TOKEN_KEY) || readStravaToken(CONFIG.STRAVA_REFRESH_TOKEN_KEY)) {
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
            const gistUpdated = data.lastUpdated || 0;

            // Resolve conflicts with last-write-wins (using lastUpdated timestamps).
            // A union/spread merge can only add keys, so it resurrects deletions
            // (e.g. an unlinked activity or an unchecked route). LWW respects deletions
            // while still adopting changes made on another device.
            const localSaved = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            let gistWasNewer = false;
            if (localSaved) {
                const localData = JSON.parse(localSaved);
                const localUpdated = localData.lastUpdated || 0;

                if (gistUpdated > localUpdated) {
                    // Gist has the most recent change (likely from another device) - adopt it.
                    completedRoutes = gistRoutes;
                    routeActivities = gistActivities;
                    gistWasNewer = true;
                } else {
                    // Local is newer-or-equal - it is authoritative, including deletions.
                    completedRoutes = new Set(localData.completedRoutes || []);
                    routeActivities = localData.activities || {};
                }
            } else {
                completedRoutes = gistRoutes;
                routeActivities = gistActivities;
                gistWasNewer = true;
            }
            
            // Save merged data back to localStorage
            saveCompletedRoutesToLocal();
            
            renderRoutes();
            updateStats();
            updateSyncStatus('synced');

            // Only re-push when the Gist was the newer source. Re-pushing a stale local
            // state here would otherwise clobber a just-made local deletion.
            if (isAuthenticated && gistWasNewer) {
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

// Save completed routes to GitHub Gist (background sync with debouncing).
// Pass { immediate: true } for destructive actions (unlink/uncheck) so the change
// reaches the Gist right away instead of after the 1s debounce, which a quick reload
// could otherwise lose.
async function saveCompletedRoutes({ immediate = false } = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] saveCompletedRoutes: Starting save process${immediate ? ' (immediate)' : ''}`);
    
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
        syncTimeout = null;
        console.log(`[${timestamp}] saveCompletedRoutes: Cleared previous sync timeout`);
    }

    if (immediate) {
        console.log(`[${timestamp}] saveCompletedRoutes: Syncing to Gist immediately`);
        await syncToGist(token);
        return;
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
        activities: routeActivities,
        lastUpdated: Date.now()
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

// ==================== Strava Token Storage ====================

// Strava tokens live in localStorage so that a mobile browser discarding the tab
// doesn't force a re-login. Refresh tokens stay valid until revoked, so a stored
// refresh token is enough to keep the connection alive across visits.
const STRAVA_TOKEN_KEYS = [
    CONFIG.STRAVA_TOKEN_KEY,
    CONFIG.STRAVA_REFRESH_TOKEN_KEY,
    CONFIG.STRAVA_TOKEN_EXPIRES_KEY
];

// Reads a token, migrating it from sessionStorage (legacy) on first access
function readStravaToken(key) {
    let value = localStorage.getItem(key);
    if (value === null) {
        const legacy = sessionStorage.getItem(key);
        if (legacy !== null) {
            localStorage.setItem(key, legacy);
            sessionStorage.removeItem(key);
            value = legacy;
        }
    }
    return value;
}

function storeStravaTokens(data) {
    if (data.access_token) {
        localStorage.setItem(CONFIG.STRAVA_TOKEN_KEY, data.access_token);
    }
    if (data.refresh_token) {
        localStorage.setItem(CONFIG.STRAVA_REFRESH_TOKEN_KEY, data.refresh_token);
    }
    if (data.expires_at) {
        localStorage.setItem(CONFIG.STRAVA_TOKEN_EXPIRES_KEY, data.expires_at.toString());
    }
}

function clearStravaTokens() {
    STRAVA_TOKEN_KEYS.forEach(key => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    });
}

// A 401 only means this access token is dead. Keep the refresh token so the next
// call can silently mint a new one instead of asking the user to reconnect.
function handleStravaUnauthorized() {
    [CONFIG.STRAVA_TOKEN_KEY, CONFIG.STRAVA_TOKEN_EXPIRES_KEY].forEach(key => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    });
    if (!readStravaToken(CONFIG.STRAVA_REFRESH_TOKEN_KEY)) {
        isStravaAuthenticated = false;
        updateStravaAuthUI();
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
        storeStravaTokens(data);
        
        isStravaAuthenticated = true;
        updateStravaAuthUI();
        console.log('Strava authentication successful');
    } catch (error) {
        console.error('Error exchanging Strava token:', error);
        alert(`Failed to authenticate with Strava: ${error.message}`);
    }
}

let stravaRefreshPromise = null;

// Refresh Strava access token using refresh token
async function refreshStravaToken() {
    // Strava rotates refresh tokens, so parallel refreshes would invalidate each other
    if (!stravaRefreshPromise) {
        stravaRefreshPromise = performStravaTokenRefresh().finally(() => {
            stravaRefreshPromise = null;
        });
    }
    return stravaRefreshPromise;
}

async function performStravaTokenRefresh() {
    const refreshToken = readStravaToken(CONFIG.STRAVA_REFRESH_TOKEN_KEY);
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
        storeStravaTokens(data);
        
        console.log('Strava token refreshed successfully');
        return data.access_token;
    } catch (error) {
        console.error('Error refreshing Strava token:', error);
        // If refresh fails, clear tokens and require re-authentication
        clearStravaTokens();
        isStravaAuthenticated = false;
        updateStravaAuthUI();
        return null;
    }
}

// Get Strava access token (with refresh if needed)
async function getStravaToken() {
    let token = readStravaToken(CONFIG.STRAVA_TOKEN_KEY);
    if (!token) {
        // No access token, but a stored refresh token can mint a new one
        return readStravaToken(CONFIG.STRAVA_REFRESH_TOKEN_KEY) ? await refreshStravaToken() : null;
    }
    
    // Check if token is expired or will expire within 1 hour (3600 seconds)
    const expiresAt = readStravaToken(CONFIG.STRAVA_TOKEN_EXPIRES_KEY);
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
                handleStravaUnauthorized();
                throw new Error('Strava authentication expired. Please try again.');
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

function formatCount(n) {
    return Math.round(n).toLocaleString('en-US');
}

/** Description snippet appended when linking a ride on Strava. */
function buildStravaProgressMessage(toolUrl) {
    const totalRoutes = routes.length;
    const completed = completedRoutes.size;
    const percentage = totalRoutes > 0 ? ((completed / totalRoutes) * 100).toFixed(1) : '0.0';

    const activities = Object.values(routeActivities);
    const totalDistanceM = activities.reduce((sum, a) => sum + (a.distance || 0), 0);
    const totalElevation = activities.reduce((sum, a) => sum + (a.totalElevationGain || 0), 0);
    const totalCalories = activities.reduce((sum, a) => sum + (a.calories || 0), 0);
    const distanceKm = (totalDistanceM / 1000).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    });

    const lines = [
        `I'm riding every Zwift route in 2026! So far:`,
        `${percentage}% complete (${completed}/${totalRoutes}).`,
        `Distance: ${distanceKm} km`,
        `Elevation: ${formatElevation(totalElevation)}`
    ];
    if (totalCalories > 0) {
        lines.push(`${formatCount(totalCalories)} kcal`);
    }
    lines.push('', `Full stats: ${toolUrl}`);
    return lines.join('\n');
}

const STRAVA_PROGRESS_MESSAGE_INTRO = "I'm riding every Zwift route in 2026";

/**
 * Drop a progress block appended by any previous version of this tool so it can be
 * rewritten with current stats. The block is always appended last, so everything from
 * its first line onwards is replaceable.
 */
function stripStravaProgressMessage(description, toolUrl) {
    if (!description) return '';
    const lines = description.split('\n');
    const start = lines.findIndex(
        line => line.includes(toolUrl) || line.trimStart().startsWith(STRAVA_PROGRESS_MESSAGE_INTRO)
    );
    if (start === -1) return description.trimEnd();
    return lines.slice(0, start).join('\n').trimEnd();
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
        
        const toolUrl = 'https://vitords.github.io/one-more-route/';
        const message = buildStravaProgressMessage(toolUrl);
        
        // Replace any previous progress block rather than appending a second one, so
        // relinking a ride refreshes stale stats and older message wording.
        const userText = stripStravaProgressMessage(activity.description, toolUrl);
        const newDescription = userText ? `${userText}\n\n${message}` : message;
        
        if (newDescription === (activity.description || '')) {
            console.log(`Activity ${activityId} description already up to date, skipping update`);
            return;
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
                handleStravaUnauthorized();
                throw new Error('Strava authentication expired. Please try again.');
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
                handleStravaUnauthorized();
                throw new Error('Strava authentication expired. Please try again.');
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
        updateStats();

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
    // Flush immediately so the deletion reaches the Gist before any reload.
    saveCompletedRoutes({ immediate: true });
    renderRoutes();
    updateStats();
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
        case 'estimatedTime2Wkg':
            return getZiEstimateMinutes(route, '2');
        case 'estimatedTime3Wkg':
            return getZiEstimateMinutes(route, '3');
        case 'estimatedTime4Wkg':
            return getZiEstimateMinutes(route, '4');
        default:
            return route.length || 0;
    }
}

// Compare two routes for sorting
function compareRoutes(a, b, completionOrderMap) {
    const valA = getRouteSortValue(a, completionOrderMap);
    const valB = getRouteSortValue(b, completionOrderMap);

    if (ESTIMATED_TIME_SORT_KEYS.has(currentSort.by)) {
        const missA = valA == null;
        const missB = valB == null;
        if (missA && missB) return a.route.localeCompare(b.route);
        if (missA) return 1;
        if (missB) return -1;
    }

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

/**
 * Compute per-map time stats:
 * - estTotalMin: total estimated minutes (2 W/kg) across all routes in the map
 * - estCompletedMin: estimated minutes (2 W/kg) for completed routes in the map
 * - actualSeconds: total actual moving time (seconds) from linked Strava activities
 * @param {string} mapName
 */
function computeMapTimeStats(mapName) {
    const routesInMap = routes.filter(r => r.map === mapName);
    let estTotalMin = 0;
    let estCompletedMin = 0;
    let actualSeconds = 0;
    for (const route of routesInMap) {
        const m = getZiEstimateMinutes(route, '2');
        if (m != null) {
            estTotalMin += m;
            if (completedRoutes.has(route.route)) estCompletedMin += m;
        }
        const activity = routeActivities[route.route];
        if (activity && Number.isFinite(activity.movingTime)) {
            actualSeconds += activity.movingTime;
        }
    }
    const estRemainingMin = Math.max(0, estTotalMin - estCompletedMin);
    return { estTotalMin, estCompletedMin, estRemainingMin, actualSeconds };
}

/** Build the map header time-stats markup (estimated + actual times). */
function buildMapTimeStatsHtml(mapName) {
    const { estTotalMin, estCompletedMin, estRemainingMin, actualSeconds } =
        computeMapTimeStats(mapName);
    const stat = (label, value) =>
        `<div class="map-time-stat">
            <span class="map-time-label">${label}</span>
            <span class="map-time-value">${value}</span>
        </div>`;
    return (
        stat('Est. (2 W/kg)', formatMinutesAsDuration(estTotalMin)) +
        stat('Est. done', formatMinutesAsDuration(estCompletedMin)) +
        stat('Est. left', formatMinutesAsDuration(estRemainingMin)) +
        stat('Actual', formatDurationTotalHoursMinutes(actualSeconds))
    );
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
        const allRoutesInThisMap = routes.filter(r => r.map === map);
        const totalRoutesInMap = allRoutesInThisMap.length;
        const completedInMap = allRoutesInThisMap.filter(r => completedRoutes.has(r.route)).length;

        const header = document.createElement('div');
        header.className = 'map-header';
        header.innerHTML = `
            <div class="map-header-left">
                <div class="map-title">${map}</div>
                <div class="map-stats">${completedInMap} / ${totalRoutesInMap} completed</div>
            </div>
            <div class="map-header-right">
                <div class="map-time-stats">${buildMapTimeStatsHtml(map)}</div>
                <span class="collapse-icon">▼</span>
            </div>
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

/** Extra section on route card: Zwift Insider estimates + profile image. */
function buildZwiftInsiderSection(route) {
    const url = route.zwiftInsiderUrl;
    const img = route.elevationProfileUrl;
    const m2 = getZiEstimateMinutes(route, '2');
    const m3 = getZiEstimateMinutes(route, '3');
    const m4 = getZiEstimateMinutes(route, '4');
    const anyTime = m2 != null || m3 != null || m4 != null;
    if (!url && !anyTime && !img) return '';

    const titleInner = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="zi-title-link">Zwift Insider</a>`
        : 'Zwift Insider';

    let bits = '';
    // if (route.timeEstimatesScope) {
    //     bits += `<div class="zi-scope-caption">${escapeHtml(route.timeEstimatesScope)}</div>`;
    // }
    if (anyTime) {
        const cell = (label, m) =>
            `<div class="zi-time-cell">
                <div class="route-detail-label">${label}</div>
                <div class="route-detail-value">${m != null ? `${formatZiMinutesForCard(m)} min` : '—'}</div>
            </div>`;
        bits += `<div class="zi-times-row">${cell('2 W/kg', m2)}${cell('3 W/kg', m3)}${cell('4 W/kg', m4)}</div>`;
    } else if (url || img) {
        bits +=
            '<div class="route-detail zi-no-estimate"><div class="route-detail-value">No ZI time estimate</div></div>';
    }
    if (img) {
        const safeSrc = escapeHtml(img);
        const wrap = url
            ? `<a class="zi-profile-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
            : '';
        const wend = url ? '</a>' : '';
        bits += `<div class="zi-profile-wrap">${wrap}<img class="zi-elevation-img" src="${safeSrc}" alt="Elevation profile by ZwiftHub (via Zwift Insider)" loading="lazy">${wend}</div>`;
    }

    return `
            <div class="route-details-section route-details-section-zi">
                <div class="route-details-section-title">${titleInner}</div>
                ${bits}
            </div>`;
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
            ${buildZwiftInsiderSection(route)}
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
        
        // Sync to Gist in background (don't await - let it happen in background).
        // Unchecking is a deletion, so flush immediately to avoid it being resurrected
        // by a background merge if the page reloads before the debounce fires.
        saveCompletedRoutes({ immediate: !wasChecked });
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
                    <div class="activity-stat-value">${formatDurationTotalHoursMinutes(activity.movingTime)}</div>
                </div>
                <div class="activity-stat">
                    <div class="activity-stat-label">Elapsed Time</div>
                    <div class="activity-stat-value">${formatDurationTotalHoursMinutes(activity.elapsedTime)}</div>
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
        completedDistanceEl.textContent = formatDistance(completedDistance);
        completedDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of completed routes");
    }
    const completedDistancePctEl = document.getElementById('completed-distance-pct');
    if (completedDistancePctEl) {
        completedDistancePctEl.textContent = `(${distanceCompletionPercent}%)`;
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
        completedElevationEl.textContent = formatElevation(completedElevation);
        completedElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of completed routes");
    }
    const completedElevationPctEl = document.getElementById('completed-elevation-pct');
    if (completedElevationPctEl) {
        completedElevationPctEl.textContent = `(${elevationCompletionPercent}%)`;
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
        completedDistanceLeadInEl.textContent = formatDistance(completedDistanceLeadIn);
        completedDistanceLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance of completed routes including lead-in");
    }
    const completedDistanceLeadInPctEl = document.getElementById('completed-distance-leadin-pct');
    if (completedDistanceLeadInPctEl) {
        completedDistanceLeadInPctEl.textContent = `(${distanceCompletionPercentLeadIn}%)`;
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
        completedElevationLeadInEl.textContent = formatElevation(completedElevationLeadIn);
        completedElevationLeadInEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain of completed routes including lead-in");
    }
    const completedElevationLeadInPctEl = document.getElementById('completed-elevation-leadin-pct');
    if (completedElevationLeadInPctEl) {
        completedElevationLeadInPctEl.textContent = `(${elevationCompletionPercentLeadIn}%)`;
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

    // Zwift Insider estimated ride time sums (at selected W/kg; model-based, not your Strava times)
    const planningWkg = getPlanningWkg();
    let ziSumAll = 0;
    let ziSumCompleted = 0;
    let ziSumRemaining = 0;
    let ziCountWithData = 0;
    let ziCountCompletedWithData = 0;
    let ziCountRemainingWithData = 0;
    for (const route of routes) {
        const m = getZiEstimateMinutes(route, planningWkg);
        if (m == null) continue;
        ziCountWithData++;
        ziSumAll += m;
        if (completedRoutes.has(route.route)) {
            ziCountCompletedWithData++;
            ziSumCompleted += m;
        } else {
            ziCountRemainingWithData++;
            ziSumRemaining += m;
        }
    }
    const ziTotalHm = document.getElementById('zi-estimated-total-hm');
    const ziTotalDhm = document.getElementById('zi-estimated-total-dhm');
    const ziCompletedHm = document.getElementById('zi-estimated-completed-hm');
    const ziCompletedDhm = document.getElementById('zi-estimated-completed-dhm');
    const ziRemainingHm = document.getElementById('zi-estimated-remaining-hm');
    const ziRemainingDhm = document.getElementById('zi-estimated-remaining-dhm');
    const ziMetaEl = document.getElementById('zi-estimated-meta');
    const ziFoot = `Zwift Insider model, ${planningWkg} W/kg. Sums include only routes that have an estimate (${ziCountWithData} of ${total}).`;
    setStatDualDurationFromMinutes(ziTotalHm, ziTotalDhm, ziSumAll, ziCountWithData === 0);
    ziTotalHm?.closest('.stat-card-compact')?.setAttribute('data-tooltip', ziFoot);
    setStatDualDurationFromMinutes(
        ziCompletedHm,
        ziCompletedDhm,
        ziSumCompleted,
        ziCountCompletedWithData === 0
    );
    ziCompletedHm?.closest('.stat-card-compact')?.setAttribute('data-tooltip', ziFoot);
    setStatDualDurationFromMinutes(
        ziRemainingHm,
        ziRemainingDhm,
        ziSumRemaining,
        ziCountRemainingWithData === 0
    );
    ziRemainingHm?.closest('.stat-card-compact')?.setAttribute('data-tooltip', ziFoot);
    if (ziMetaEl) {
        ziMetaEl.textContent =
            ziCountWithData > 0
                ? `${ziCountWithData} of ${total} routes have a ${planningWkg} W/kg estimate`
                : 'No ZI time data in catalog';
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
        buildHeartSeriesFromRouteActivities().length > 0 ||
        buildTimingSeriesFromRouteActivities().length > 0
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
            g.classList.remove('strava-trend-marker-group--hover');
        }
        stravaTrendArmedHit = null;
    }
    document.querySelectorAll('.strava-trend-chart-tooltip').forEach(el => {
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

const STRAVA_TIMING_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monFirstWeekdayIndex(date) {
    const d = date.getDay();
    return d === 0 ? 6 : d - 1;
}

/** Linked activities with parsable start time and positive moving time (seconds). */
function buildTimingSeriesFromRouteActivities() {
    const points = [];
    for (const [routeName, activity] of Object.entries(routeActivities)) {
        if (!activity?.startDate) continue;
        const movingTime = Number(activity.movingTime);
        if (!Number.isFinite(movingTime) || movingTime <= 0) continue;
        const date = new Date(activity.startDate);
        if (Number.isNaN(date.getTime())) continue;
        points.push({ routeName, date, movingSec: movingTime });
    }
    points.sort((a, b) => a.date - b.date);
    return points;
}

function aggregateTimingByWeekday(points) {
    const counts = Array(7).fill(0);
    const movingTotals = Array(7).fill(0);
    for (const p of points) {
        const i = monFirstWeekdayIndex(p.date);
        counts[i]++;
        movingTotals[i] += p.movingSec;
    }
    return { counts, movingTotals };
}

function aggregateTimingByStartHour(points) {
    const counts = Array(24).fill(0);
    for (const p of points) {
        counts[p.date.getHours()]++;
    }
    return counts;
}

/** Short label for timing bar charts (e.g. 45m, 2h, 2h 5m / 90s when under 1 min). */
function formatMovingDurationForTimingBar(totalSeconds) {
    if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
    const s = Math.floor(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h <= 0 && m <= 0) return `${s}s`;
    if (h <= 0) return `${m}m`;
    if (m <= 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function renderStravaTimingCharts() {
    const points = buildTimingSeriesFromRouteActivities();
    const weekdayWrap = document.getElementById('strava-timing-weekday-wrap');
    const hourWrap = document.getElementById('strava-timing-hour-wrap');
    const weekdayEl = document.getElementById('strava-timing-weekday-chart');
    const hourEl = document.getElementById('strava-timing-hour-chart');
    if (!weekdayWrap || !hourWrap || !weekdayEl || !hourEl) return;

    if (points.length === 0) {
        weekdayWrap.classList.add('strava-timing-panel--empty');
        hourWrap.classList.add('strava-timing-panel--empty');
        weekdayEl.replaceChildren();
        hourEl.replaceChildren();
        return;
    }

    weekdayWrap.classList.remove('strava-timing-panel--empty');
    hourWrap.classList.remove('strava-timing-panel--empty');

    renderTimingWeekdayBars(weekdayEl, points);
    renderTimingHourHistogram(hourEl, points);
}

/** Horizontal bar list: rides per weekday, with total moving time shown at right. */
function renderTimingWeekdayBars(container, points) {
    const { counts, movingTotals } = aggregateTimingByWeekday(points);
    const maxCount = Math.max(...counts, 1);

    const list = document.createElement('div');
    list.className = 'timing-wd-list';

    for (let i = 0; i < 7; i++) {
        const isPeak = counts[i] > 0 && counts[i] === maxCount;
        const row = document.createElement('div');
        row.className = 'timing-wd-row' + (isPeak ? ' timing-wd-row--peak' : '');
        row.title =
            `${STRAVA_TIMING_WEEKDAY_LABELS[i]}: ${counts[i]} ride(s)` +
            (movingTotals[i] > 0 ? `, ${formatDurationTotalHoursMinutes(movingTotals[i])} moving` : '');

        const day = document.createElement('span');
        day.className = 'timing-wd-day';
        day.textContent = STRAVA_TIMING_WEEKDAY_LABELS[i];

        const track = document.createElement('div');
        track.className = 'timing-wd-track';
        const fill = document.createElement('div');
        fill.className = 'timing-wd-fill';
        if (counts[i] > 0) {
            fill.style.width = `${Math.max((counts[i] / maxCount) * 100, 4)}%`;
        } else {
            fill.style.width = '0%';
            fill.classList.add('timing-wd-fill--empty');
        }
        track.appendChild(fill);

        const count = document.createElement('span');
        count.className = 'timing-wd-count' + (counts[i] === 0 ? ' timing-wd-count--zero' : '');
        count.textContent = String(counts[i]);

        const time = document.createElement('span');
        time.className = 'timing-wd-time';
        time.textContent = movingTotals[i] > 0 ? formatMovingDurationForTimingBar(movingTotals[i]) : '—';

        row.append(day, track, count, time);
        list.appendChild(row);
    }

    container.replaceChildren(list);
}

/** Compact 24-hour histogram of ride start times (local); peak hour highlighted. */
function renderTimingHourHistogram(container, points) {
    const hourCounts = aggregateTimingByStartHour(points);
    const maxHour = Math.max(...hourCounts, 1);

    const wrap = document.createElement('div');
    wrap.className = 'timing-hours';

    const plot = document.createElement('div');
    plot.className = 'timing-hours-plot';

    for (let hour = 0; hour < 24; hour++) {
        const n = hourCounts[hour];
        const isPeak = n > 0 && n === maxHour;
        const hh = String(hour).padStart(2, '0');

        const col = document.createElement('div');
        col.className =
            'timing-hour-col' +
            (n === 0 ? ' timing-hour-col--empty' : '') +
            (isPeak ? ' timing-hour-col--peak' : '');
        col.title = `${hh}:00–${hh}:59 — ${n} ride(s)`;

        const val = document.createElement('span');
        val.className = 'timing-hour-val';
        val.textContent = String(n);
        col.appendChild(val);

        const bar = document.createElement('div');
        bar.className = 'timing-hour-bar';
        if (n > 0) bar.style.height = `${Math.max((n / maxHour) * 100, 4)}%`;
        col.appendChild(bar);

        plot.appendChild(col);
    }

    const axis = document.createElement('div');
    axis.className = 'timing-hours-axis';
    for (let hour = 0; hour < 24; hour++) {
        const tick = document.createElement('span');
        tick.className = 'timing-hour-tick';
        tick.textContent = hour % 3 === 0 ? String(hour) : '';
        axis.appendChild(tick);
    }

    wrap.append(plot, axis);
    container.replaceChildren(wrap);
}

/** Centered moving average over the non-null subsequence of a per-ride series. */
function computeTrendValues(points, getValue) {
    const out = new Array(points.length).fill(null);
    const idx = [];
    const vals = [];
    points.forEach((p, i) => {
        const v = getValue(p);
        if (v != null && Number.isFinite(v)) {
            idx.push(i);
            vals.push(v);
        }
    });
    const m = vals.length;
    if (m === 0) return out;
    const win = Math.min(m, Math.max(3, Math.round(m / 5)));
    const half = Math.floor(win / 2);
    for (let k = 0; k < m; k++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, k - half); j <= Math.min(m - 1, k + half); j++) {
            sum += vals[j];
            count++;
        }
        out[idx[k]] = sum / count;
    }
    return out;
}

/** Smooth (Catmull-Rom → cubic bezier) SVG path through the given {x,y} points. */
function smoothLinePath(pts) {
    if (pts.length === 0) return '';
    if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i - 1] || pts[i];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;
        d += `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
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

/**
 * Modern trend chart: faint per-ride dots + a smooth rolling-average trend line
 * (with a soft gradient area under the primary series). Shared by the power
 * and heart-rate charts. Keeps the window/pan and tap-to-open behavior.
 */
function renderStravaMetricTrend(config) {
    const {
        wrapId,
        wrapEmptyClass,
        svgId,
        gradientIdPrefix,
        buildPoints,
        series,
        primaryIndex = 0,
        yLabel,
        yFloor,
        defaultYMin,
        defaultYMax,
        buildTooltipHtml,
        formatYTick,
        emptyPeriodMsg
    } = config;

    const wrap = document.getElementById(wrapId);
    const svg = document.getElementById(svgId);
    if (!wrap || !svg) return;

    clearStravaTrendArmedState();

    const allPoints = buildPoints();
    const chartInner = svg.parentElement;
    const existingTip = chartInner?.querySelector('.strava-trend-chart-tooltip');
    if (allPoints.length === 0) {
        wrap.classList.add(wrapEmptyClass);
        svg.replaceChildren();
        if (existingTip) existingTip.hidden = true;
        return;
    }
    wrap.classList.remove(wrapEmptyClass);

    initStravaChartsWindowIfNeeded();
    clampStravaChartsWindow();
    const range = getStravaChartsWindowRange();

    // Trend is computed over ALL rides (so window edges reflect neighbours), then
    // both dots and the smoothed line are clipped to the visible window.
    const trends = series.map(s => computeTrendValues(allPoints, s.getValue));
    const points = [];
    const winTrends = series.map(() => []);
    const t0 = range.start.getTime();
    const t1 = range.end.getTime();
    allPoints.forEach((p, i) => {
        const t = p.date.getTime();
        if (t < t0 || t > t1) return;
        points.push(p);
        series.forEach((s, si) => winTrends[si].push(trends[si][i]));
    });

    const ns = 'http://www.w3.org/2000/svg';
    const W = 640;
    const H = 260;
    const pl = 48;
    const pr = 14;
    const pt = 16;
    const pb = 40;
    const plotW = W - pl - pr;
    const plotH = H - pt - pb;
    const baseY = pt + plotH;

    const tMin = range.start.getTime();
    const tMax = range.end.getTime();
    const xSpan = Math.max(tMax - tMin, 1);
    const xAt = t => pl + ((t - tMin) / xSpan) * plotW;

    const values = [];
    points.forEach(p =>
        series.forEach(s => {
            const v = s.getValue(p);
            if (v != null && Number.isFinite(v)) values.push(v);
        })
    );
    let yMin;
    let yMax;
    if (values.length === 0) {
        yMin = defaultYMin;
        yMax = defaultYMax;
    } else {
        yMin = Math.min(...values);
        yMax = Math.max(...values);
        if (yMin === yMax) {
            const bump = Math.max(Math.abs(yMin) * 0.1, 1);
            yMin -= bump;
            yMax += bump;
        } else {
            const pad = (yMax - yMin) * 0.12;
            yMin -= pad;
            yMax += pad;
        }
        if (yFloor != null) yMin = Math.max(yFloor, yMin);
    }
    const ySpan = Math.max(yMax - yMin, 1e-6);
    const yAt = v => pt + plotH - ((v - yMin) / ySpan) * plotH;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.replaceChildren();
    const frag = document.createDocumentFragment();

    const defs = document.createElementNS(ns, 'defs');
    series.forEach((s, si) => {
        const gid = `${gradientIdPrefix}-area-${si}`;
        const grad = document.createElementNS(ns, 'linearGradient');
        grad.setAttribute('id', gid);
        grad.setAttribute('x1', '0');
        grad.setAttribute('y1', '0');
        grad.setAttribute('x2', '0');
        grad.setAttribute('y2', '1');
        const st0 = document.createElementNS(ns, 'stop');
        st0.setAttribute('offset', '0%');
        st0.setAttribute('stop-color', `var(${s.colorVar})`);
        st0.setAttribute('stop-opacity', '0.24');
        const st1 = document.createElementNS(ns, 'stop');
        st1.setAttribute('offset', '100%');
        st1.setAttribute('stop-color', `var(${s.colorVar})`);
        st1.setAttribute('stop-opacity', '0');
        grad.appendChild(st0);
        grad.appendChild(st1);
        defs.appendChild(grad);
        s._gid = gid;
    });
    frag.appendChild(defs);

    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (i / yTicks) * (yMax - yMin);
        const y = yAt(v);
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', pl);
        line.setAttribute('x2', pl + plotW);
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
        line.setAttribute('class', 'strava-trend-grid');
        frag.appendChild(line);
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', pl - 8);
        text.setAttribute('y', y + 4);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('class', 'strava-trend-axis-text');
        text.textContent = formatYTick(v);
        frag.appendChild(text);
    }

    const formatShortDate = d => {
        try {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    };
    const midTime = (tMin + tMax) / 2;
    [
        { x: xAt(tMin), text: formatShortDate(range.start) },
        { x: xAt(midTime), text: formatShortDate(new Date(midTime)) },
        { x: xAt(tMax), text: formatShortDate(range.end) }
    ].forEach(({ x, text }) => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', H - 10);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'strava-trend-axis-text');
        t.textContent = text;
        frag.appendChild(t);
    });

    const yAxis = document.createElementNS(ns, 'text');
    yAxis.setAttribute('x', 12);
    yAxis.setAttribute('y', pt + plotH / 2);
    yAxis.setAttribute('text-anchor', 'middle');
    yAxis.setAttribute('transform', `rotate(-90,12,${pt + plotH / 2})`);
    yAxis.setAttribute('class', 'strava-trend-axis-label');
    yAxis.textContent = yLabel;
    frag.appendChild(yAxis);

    if (points.length === 0) {
        const emptyMsg = document.createElementNS(ns, 'text');
        emptyMsg.setAttribute('x', pl + plotW / 2);
        emptyMsg.setAttribute('y', pt + plotH / 2);
        emptyMsg.setAttribute('text-anchor', 'middle');
        emptyMsg.setAttribute('class', 'strava-chart-period-empty-msg');
        emptyMsg.textContent = emptyPeriodMsg;
        frag.appendChild(emptyMsg);
        svg.appendChild(frag);
        return;
    }

    series.forEach((s, si) => {
        const linePts = [];
        points.forEach((p, k) => {
            const tv = winTrends[si][k];
            if (tv != null && Number.isFinite(tv)) {
                linePts.push({ x: xAt(p.date.getTime()), y: yAt(tv) });
            }
        });
        if (linePts.length === 0) return;
        const linePath = smoothLinePath(linePts);
        if (si === primaryIndex && linePts.length >= 2) {
            const first = linePts[0];
            const last = linePts[linePts.length - 1];
            const area = document.createElementNS(ns, 'path');
            area.setAttribute(
                'd',
                `${linePath}L${last.x.toFixed(1)},${baseY}L${first.x.toFixed(1)},${baseY}Z`
            );
            area.setAttribute('class', 'strava-trend-area');
            area.setAttribute('fill', `url(#${s._gid})`);
            frag.appendChild(area);
        }
        const line = document.createElementNS(ns, 'path');
        line.setAttribute('d', linePath);
        line.setAttribute('class', 'strava-trend-line');
        line.setAttribute('stroke', `var(${s.colorVar})`);
        frag.appendChild(line);
    });

    const tooltip = chartInner
        ? ensureStravaChartTooltip(chartInner, 'strava-trend-chart-tooltip')
        : null;

    points.forEach(p => {
        const cx = xAt(p.date.getTime());
        const ys = [];
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('class', 'strava-trend-marker-group');

        series.forEach(s => {
            const v = s.getValue(p);
            if (v == null || !Number.isFinite(v)) return;
            const cy = yAt(v);
            ys.push(cy);
            const c = document.createElementNS(ns, 'circle');
            c.setAttribute('cx', cx);
            c.setAttribute('cy', cy);
            c.setAttribute('r', 3);
            c.setAttribute('class', 'strava-trend-dot');
            c.setAttribute('fill', `var(${s.colorVar})`);
            g.appendChild(c);
        });
        if (ys.length === 0) return;

        const yTop = Math.min(...ys) - 16;
        const yBot = Math.max(...ys) + 16;
        const hit = document.createElementNS(ns, 'rect');
        hit.setAttribute('x', cx - 16);
        hit.setAttribute('y', yTop);
        hit.setAttribute('width', 32);
        hit.setAttribute('height', Math.max(yBot - yTop, 24));
        hit.setAttribute('fill', 'transparent');
        hit.setAttribute('class', 'strava-trend-hit');
        hit.setAttribute('role', 'button');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('focusable', 'true');
        hit.setAttribute(
            'aria-label',
            `${formatChartTooltipDate(p.date)}: first tap for details, second tap opens the activity`
        );
        g.appendChild(hit);

        attachStravaTrendPointRevealThenOpen(hit, p.routeName, {
            tooltip,
            chartInner,
            buildTooltipHtml: () => buildTooltipHtml(p),
            hoverClass: 'strava-trend-marker-group--hover'
        });

        if (tooltip && chartInner) {
            hit.addEventListener('mouseenter', evt => {
                g.classList.add('strava-trend-marker-group--hover');
                tooltip.innerHTML = buildTooltipHtml(p);
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            });
            hit.addEventListener('mousemove', evt => {
                positionStravaChartTooltip(evt.clientX, evt.clientY, chartInner, tooltip);
            });
            hit.addEventListener('mouseleave', () => {
                g.classList.remove('strava-trend-marker-group--hover');
                if (stravaTrendArmedHit !== hit) tooltip.hidden = true;
            });
        }

        frag.appendChild(g);
    });

    svg.appendChild(frag);
}

function renderStravaPowerTrendChart() {
    renderStravaMetricTrend({
        wrapId: 'strava-power-chart-wrap',
        wrapEmptyClass: 'strava-power-chart-wrap--empty',
        svgId: 'strava-power-chart',
        gradientIdPrefix: 'strava-power',
        buildPoints: buildPowerSeriesFromRouteActivities,
        series: [
            { getValue: p => p.avg, colorVar: '--power-chart-avg' },
            { getValue: p => p.weighted, colorVar: '--power-chart-weighted' }
        ],
        primaryIndex: 0,
        yLabel: 'Watts',
        yFloor: 0,
        defaultYMin: 0,
        defaultYMax: 280,
        buildTooltipHtml: buildPowerTooltipHtml,
        formatYTick: v => String(Math.round(v)),
        emptyPeriodMsg: 'No power data in this period'
    });
}

function renderStravaHeartTrendChart() {
    renderStravaMetricTrend({
        wrapId: 'strava-hr-chart-wrap',
        wrapEmptyClass: 'strava-hr-chart-wrap--empty',
        svgId: 'strava-hr-chart',
        gradientIdPrefix: 'strava-hr',
        buildPoints: buildHeartSeriesFromRouteActivities,
        series: [
            { getValue: p => p.avgHr, colorVar: '--hr-chart-avg' },
            { getValue: p => p.maxHr, colorVar: '--hr-chart-max' }
        ],
        primaryIndex: 0,
        yLabel: 'BPM',
        yFloor: 40,
        defaultYMin: 60,
        defaultYMax: 180,
        buildTooltipHtml: buildHeartTooltipHtml,
        formatYTick: v => String(Math.round(v)),
        emptyPeriodMsg: 'No heart rate data in this period'
    });
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
            handleStravaUnauthorized();
            throw new Error('Strava authentication expired. Please try again.');
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
    const stravaMovingHm = document.getElementById('strava-total-moving-time-hm');
    const stravaMovingDhm = document.getElementById('strava-total-moving-time-dhm');
    const stravaElapsedHm = document.getElementById('strava-total-elapsed-time-hm');
    const stravaElapsedDhm = document.getElementById('strava-total-elapsed-time-dhm');
    const stravaCaloriesEl = document.getElementById('strava-total-calories');
    const noActs = activities.length === 0;

    if (stravaDistanceEl) {
        stravaDistanceEl.textContent = formatDistance(totalDistance / 1000); // Convert meters to km
        stravaDistanceEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total distance from all linked Strava activities");
    }
    if (stravaElevationEl) {
        stravaElevationEl.textContent = formatElevation(totalElevation);
        stravaElevationEl.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elevation gain from all linked Strava activities");
    }
    setStatDualDurationFromSeconds(stravaMovingHm, stravaMovingDhm, totalMovingTime, noActs);
    stravaMovingHm?.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total moving time from all linked Strava activities");
    setStatDualDurationFromSeconds(stravaElapsedHm, stravaElapsedDhm, totalElapsedTime, noActs);
    stravaElapsedHm?.closest('.stat-card-compact')?.setAttribute('data-tooltip', "Total elapsed time from all linked Strava activities");
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
    renderStravaTimingCharts();
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

        const timeStats = mapGroup.querySelector('.map-time-stats');
        if (timeStats) {
            timeStats.innerHTML = buildMapTimeStatsHtml(mapName);
        }
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

function setupPlanningWkgSelect() {
    const sel = document.getElementById('planning-wkg-select');
    if (!sel) return;
    sel.value = getPlanningWkg();
    sel.addEventListener('change', () => {
        setPlanningWkg(sel.value);
        updateStats();
    });
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
    setupPlanningWkgSelect();
    
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
                    clearStravaTokens();
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
    setupPlanningWkgSelect();
    
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

