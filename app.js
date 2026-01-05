// Configuration
const CONFIG = {
    GIST_ID_KEY: 'zwift_tracker_gist_id',
    TOKEN_KEY: 'zwift_tracker_token',
    GIST_FILENAME: 'zwift_routes.json'
};

// State
let routes = [];
let completedRoutes = new Set();
let filteredRoutes = [];
let currentFilter = 'all';
let searchQuery = '';
let isAuthenticated = false;
let gistId = null;

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
    
    // Load completed routes from Gist
    if (gistId) {
        await loadCompletedRoutes();
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

// Load completed routes from GitHub Gist
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
            completedRoutes = new Set(data.completedRoutes || []);
            renderRoutes();
            updateStats();
        }
    } catch (error) {
        console.error('Error loading completed routes:', error);
    }
}

// Save completed routes to GitHub Gist
async function saveCompletedRoutes() {
    if (!isAuthenticated) {
        alert('Please authenticate first to save changes.');
        return;
    }
    
    const token = sessionStorage.getItem(CONFIG.TOKEN_KEY);
    if (!token) {
        alert('Authentication token not found. Please login again.');
        return;
    }
    
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
        
        console.log('Progress saved successfully!');
    } catch (error) {
        console.error('Error saving completed routes:', error);
        alert(`Error saving progress: ${error.message}`);
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
        if (e.target.checked) {
            completedRoutes.add(route.route);
        } else {
            completedRoutes.delete(route.route);
        }
        renderRoutes();
        updateStats();
        // Save progress (works for both checking and unchecking)
        await saveCompletedRoutes();
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

// Update authentication UI
function updateAuthUI() {
    if (isAuthenticated) {
        authBtn.textContent = 'Logout';
        authStatus.textContent = '✓ Authenticated';
        authStatus.style.color = 'var(--completed)';
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

