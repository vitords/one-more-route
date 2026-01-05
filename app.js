// Configuration
const CONFIG = {
    GIST_ID_KEY: 'zwift_tracker_gist_id',
    TOKEN_KEY: 'zwift_tracker_token',
    GIST_FILENAME: 'zwift_routes.json',
    LOCAL_STORAGE_KEY: 'zwift_tracker_completed_routes'
};

// State
let routes = [];
let completedRoutes = new Set();
let filteredRoutes = [];
let currentFilter = 'all';
let searchQuery = '';
let isAuthenticated = false;
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
    // Load saved Gist ID and token from localStorage
    gistId = localStorage.getItem(CONFIG.GIST_ID_KEY);
    const savedToken = sessionStorage.getItem(CONFIG.TOKEN_KEY);
    
    if (savedToken) {
        isAuthenticated = true;
        updateAuthUI();
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
            
            // Merge with local storage (local takes precedence for conflicts)
            const localSaved = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (localSaved) {
                const localData = JSON.parse(localSaved);
                const localRoutes = new Set(localData.completedRoutes || []);
                // Merge: union of both sets (if local has it, keep it; if gist has it, add it)
                completedRoutes = new Set([...localRoutes, ...gistRoutes]);
            } else {
                completedRoutes = gistRoutes;
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
        completedRoutes: Array.from(completedRoutes)
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
    
    card.innerHTML = `
        <div class="route-header">
            <div class="route-name">${route.route}</div>
            <input 
                type="checkbox" 
                class="route-checkbox" 
                ${isCompleted ? 'checked' : ''}
                ${!isAuthenticated ? 'disabled' : ''}
                data-route="${route.route}"
            >
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
    
    return card;
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
}

// Initialize on page load
init();

