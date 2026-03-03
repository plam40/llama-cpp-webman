// Initialize Socket.IO
const socket = io();

// App State
const app = {
    config: {},
    models: [],
    running: false,
    logs: [],
    metrics: {},
};

// Utility Functions
function showMessage(elementId, message, type = 'success') {
    const elem = document.getElementById(elementId);
    if (elem) {
        elem.textContent = message;
        elem.className = `message show ${type}`;
        setTimeout(() => {
            elem.classList.remove('show');
        }, 5000);
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

// API Calls
async function apiCall(endpoint, method = 'GET', data = null) {
    try {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (data) {
            options.body = JSON.stringify(data);
        }
        const response = await fetch(endpoint, options);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// Initialization
async function init() {
    // Load configuration
    try {
        app.config = await apiCall('/api/config');
        updateConfigForm();
    } catch (error) {
        console.error('Failed to load config:', error);
    }

    // Load system info
    loadSystemInfo();

    // Load models
    await loadModels();

    // Load services
    loadServices();

    // Setup tab switching
    setupTabs();

    // Setup event listeners
    setupEventListeners();

    // Initial status update
    updateServerStatus();
}

// Tab Switching
function setupTabs() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.getAttribute('data-tab');
            switchTab(tab);
        });
    });
}

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    // Show selected tab
    const tab = document.getElementById(`${tabName}-tab`);
    if (tab) {
        tab.classList.add('active');
    }

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.getAttribute('data-tab') === tabName) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

// Event Listeners
function setupEventListeners() {
    // Server control buttons
    document.getElementById('startBtn').addEventListener('click', startServer);
    document.getElementById('stopBtn').addEventListener('click', stopServer);
    document.getElementById('restartBtn').addEventListener('click', restartServer);

    // Configuration form
    document.getElementById('configForm').addEventListener('submit', saveConfig);

    // Models
    document.getElementById('discoverBtn').addEventListener('click', discoverModels);
    document.getElementById('modelsBtn')?.addEventListener('click', loadModels);

    // Logs
    document.getElementById('clearLogsBtn').addEventListener('click', clearLogs);

    // Auto-scroll checkbox
    document.getElementById('autoScroll').addEventListener('change', (e) => {
        if (e.target.checked) {
            const container = document.getElementById('logsContainer');
            container.scrollTop = container.scrollHeight;
        }
    });
}

// Server Control
async function startServer() {
    try {
        const result = await apiCall('/api/server/start', 'POST', app.config);
        if (result.ok) {
            showMessage('serverMessage', result.msg, 'success');
            updateServerStatus();
        } else {
            showMessage('serverMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('serverMessage', 'Failed to start server', 'error');
    }
}

async function stopServer() {
    try {
        const result = await apiCall('/api/server/stop', 'POST');
        if (result.ok) {
            showMessage('serverMessage', result.msg, 'success');
            updateServerStatus();
        } else {
            showMessage('serverMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('serverMessage', 'Failed to stop server', 'error');
    }
}

async function restartServer() {
    try {
        const result = await apiCall('/api/server/restart', 'POST');
        if (result.ok) {
            showMessage('serverMessage', result.msg, 'success');
            updateServerStatus();
        } else {
            showMessage('serverMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('serverMessage', 'Failed to restart server', 'error');
    }
}

async function updateServerStatus() {
    try {
        const status = await apiCall('/api/server/status');
        app.running = status.running;

        // Update buttons
        document.getElementById('startBtn').disabled = app.running;
        document.getElementById('stopBtn').disabled = !app.running;
        document.getElementById('restartBtn').disabled = !app.running;

        // Update status indicator
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        if (app.running) {
            statusDot.classList.add('online');
            statusText.textContent = `Online (PID ${status.pid})`;
            document.getElementById('uptime').textContent = formatUptime(status.uptime);
        } else {
            statusDot.classList.remove('online');
            statusText.textContent = 'Offline';
            document.getElementById('uptime').textContent = '0s';
        }

        // Update active slots
        if (status.slots) {
            let activeSlots = 0;
            if (Array.isArray(status.slots)) {
                activeSlots = status.slots.filter(s => s.state !== 'idle').length;
            }
            document.getElementById('activeSlots').textContent = activeSlots;
        }

        // Update llama health
        if (status.health) {
            document.getElementById('llamaHealthContainer').innerHTML = `
                <div class="metric-info">
                    <div>Model: ${status.health.model || 'N/A'}</div>
                    <div>Slots: ${status.health.slots_idle || 0} idle</div>
                </div>
            `;
        } else {
            document.getElementById('llamaHealthContainer').innerHTML = '<div class="metric-info">Server offline</div>';
        }
    } catch (error) {
        console.error('Failed to update server status:', error);
    }
}

// Configuration
function updateConfigForm() {
    Object.entries(app.config).forEach(([key, value]) => {
        const elem = document.getElementById(key);
        if (elem) {
            if (elem.type === 'checkbox') {
                elem.checked = value;
            } else {
                elem.value = value;
            }
        }
    });
}

async function saveConfig(e) {
    e.preventDefault();
    try {
        const formData = new FormData(document.getElementById('configForm'));
        const newConfig = {};

        // Get all form values
        document.querySelectorAll('#configForm [id]').forEach(elem => {
            if (elem.type === 'checkbox') {
                newConfig[elem.name || elem.id] = elem.checked;
            } else if (elem.type === 'number') {
                newConfig[elem.name || elem.id] = parseFloat(elem.value) || 0;
            } else if (elem.value) {
                newConfig[elem.name || elem.id] = elem.value;
            }
        });

        const result = await apiCall('/api/config', 'POST', newConfig);
        if (result.ok) {
            app.config = result.config;
            showMessage('configMessage', 'Configuration saved successfully', 'success');
        } else {
            showMessage('configMessage', 'Failed to save configuration', 'error');
        }
    } catch (error) {
        showMessage('configMessage', 'Error saving configuration', 'error');
    }
}

// Models
async function loadModels() {
    try {
        const modelsDir = document.getElementById('models_dir')?.value || '/opt/models';
        app.config.models_dir = modelsDir;

        app.models = await apiCall('/api/models');
        displayModels();
    } catch (error) {
        console.error('Failed to load models:', error);
        document.getElementById('modelsList').innerHTML = '<p>Failed to load models</p>';
    }
}

async function discoverModels() {
    try {
        document.getElementById('discoverBtn').disabled = true;
        showMessage('modelsMessage', 'Discovering models...', 'success');

        const modelsDir = document.getElementById('models_dir')?.value || '/opt/models';
        app.config.models_dir = modelsDir;
        await apiCall('/api/config', 'POST', { models_dir: modelsDir });

        await loadModels();
        showMessage('modelsMessage', `Found ${app.models.length} model(s)`, 'success');
    } catch (error) {
        showMessage('modelsMessage', 'Failed to discover models', 'error');
    } finally {
        document.getElementById('discoverBtn').disabled = false;
    }
}

function displayModels() {
    const container = document.getElementById('modelsList');

    if (app.models.length === 0) {
        container.innerHTML = '<p>No models found. Check the models directory or click Discover.</p>';
        return;
    }

    container.innerHTML = app.models.map(model => `
        <div class="model-item ${app.config.selected_model === model.path ? 'selected' : ''}">
            <div class="model-name">${model.name}</div>
            <div class="model-info">
                <span>${model.size_h}</span>
                <span>${model.mtime}</span>
            </div>
            <button class="btn btn-primary model-button" onclick="selectModel('${model.path.replace(/'/g, "\\'")}')">
                Select Model
            </button>
        </div>
    `).join('');
}

async function selectModel(path) {
    try {
        app.config.selected_model = path;
        await apiCall('/api/config', 'POST', { selected_model: path });
        displayModels();
        showMessage('modelsMessage', 'Model selected', 'success');
    } catch (error) {
        showMessage('modelsMessage', 'Failed to select model', 'error');
    }
}

// Logs
function clearLogs() {
    document.getElementById('logsContainer').innerHTML = '<div class="logs-placeholder">Logs cleared</div>';
    app.logs = [];
}

// Services
async function loadServices() {
    try {
        const services = await apiCall('/api/services');
        displayServices(services);
    } catch (error) {
        console.error('Failed to load services:', error);
    }
}

function displayServices(services) {
    const container = document.getElementById('servicesContainer');
    container.innerHTML = Object.entries(services).map(([name, status]) => `
        <div class="service-card">
            <div class="service-header">
                <div class="service-name">${name}</div>
                <div class="service-status">
                    <span class="status-label ${status.active === 'active' ? 'active' : 'inactive'}">
                        ${status.active}
                    </span>
                    <span class="status-label ${status.enabled === 'enabled' ? 'active' : 'inactive'}">
                        ${status.enabled}
                    </span>
                </div>
            </div>
            ${status.pid ? `<div class="metric-info">PID: ${status.pid}</div>` : ''}
            ${status.since ? `<div class="metric-info">Since: ${status.since}</div>` : ''}
            <div class="service-actions">
                <button class="btn btn-success" onclick="serviceAction('${name}', 'start')">Start</button>
                <button class="btn btn-danger" onclick="serviceAction('${name}', 'stop')">Stop</button>
                <button class="btn btn-warning" onclick="serviceAction('${name}', 'restart')">Restart</button>
                <button class="btn btn-secondary" onclick="serviceAction('${name}', 'enable')">Enable</button>
                <button class="btn btn-secondary" onclick="serviceAction('${name}', 'disable')">Disable</button>
                ${status.exists ? `<button class="btn btn-danger" onclick="serviceRemove('${name}')">Remove</button>` : `<button class="btn btn-primary" onclick="serviceInstall('${name}')">Install</button>`}
            </div>
        </div>
    `).join('');
}

async function serviceAction(name, action) {
    try {
        const result = await apiCall('/api/service/action', 'POST', { service: name, action });
        if (result.ok) {
            showMessage('modelsMessage', `${action} OK`, 'success');
            await loadServices();
        } else {
            showMessage('modelsMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('modelsMessage', `Failed to ${action}`, 'error');
    }
}

async function serviceInstall(name) {
    try {
        const port = name === 'llama-manager' ? 5000 : undefined;
        const result = await apiCall('/api/service/install', 'POST', { service: name, port, boot: true });
        if (result.ok) {
            showMessage('modelsMessage', 'Service installed', 'success');
            await loadServices();
        } else {
            showMessage('modelsMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('modelsMessage', 'Failed to install service', 'error');
    }
}

async function serviceRemove(name) {
    if (!confirm(`Remove ${name} service?`)) return;
    try {
        const result = await apiCall('/api/service/remove', 'POST', { service: name });
        if (result.ok) {
            showMessage('modelsMessage', 'Service removed', 'success');
            await loadServices();
        } else {
            showMessage('modelsMessage', result.msg, 'error');
        }
    } catch (error) {
        showMessage('modelsMessage', 'Failed to remove service', 'error');
    }
}

// System Info
async function loadSystemInfo() {
    try {
        const info = await apiCall('/api/system');
        displaySystemInfo(info);
    } catch (error) {
        console.error('Failed to load system info:', error);
    }
}

function displaySystemInfo(info) {
    const container = document.getElementById('systemInfo');
    container.innerHTML = `
        <div class="info-item">
            <div class="info-label">Platform</div>
            <div class="info-value">${info.platform}</div>
        </div>
        <div class="info-item">
            <div class="info-label">Hostname</div>
            <div class="info-value">${info.hostname}</div>
        </div>
        <div class="info-item">
            <div class="info-label">Python Version</div>
            <div class="info-value">${info.python}</div>
        </div>
        <div class="info-item">
            <div class="info-label">CPU</div>
            <div class="info-value">${info.processor || 'N/A'}</div>
        </div>
        <div class="info-item">
            <div class="info-label">CPU Cores</div>
            <div class="info-value">${info.cores} (${info.cores_phys} physical)</div>
        </div>
        <div class="info-item">
            <div class="info-label">RAM</div>
            <div class="info-value">${formatBytes(info.ram)}</div>
        </div>
        <div class="info-item">
            <div class="info-label">llama-server</div>
            <div class="info-value">${info.binary || 'Not found'}</div>
        </div>
    `;
}

// Metrics Update
function updateMetrics(metrics) {
    if (!metrics) return;

    app.metrics = metrics;

    // CPU
    if (metrics.cpu) {
        document.getElementById('cpuPercent').textContent = Math.round(metrics.cpu.avg) + '%';
        document.getElementById('cpuInfo').textContent = `${metrics.cpu.count} cores`;

        const barsContainer = document.getElementById('cpuBars');
        barsContainer.innerHTML = metrics.cpu.percent.map(pct => `
            <div class="cpu-bar">
                <div class="cpu-bar-fill" style="width: ${pct}%"></div>
            </div>
        `).join('');
    }

    // Memory
    if (metrics.mem) {
        document.getElementById('memPercent').textContent = Math.round(metrics.mem.pct) + '%';
        document.getElementById('memBar').style.width = metrics.mem.pct + '%';
        document.getElementById('memInfo').textContent =
            `${formatBytes(metrics.mem.used)} / ${formatBytes(metrics.mem.total)}`;
    }

    // GPU
    if (metrics.gpus && metrics.gpus.length > 0) {
        const gpuHtml = metrics.gpus.map(gpu => `
            <div style="margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid var(--border);">
                <div style="font-weight: 600; margin-bottom: 8px;">${gpu.name}</div>
                <div style="font-size: 12px; color: var(--text-secondary);">
                    ${gpu.temp ? `Temp: ${gpu.temp}°C | ` : ''}
                    Util: ${gpu.util}% |
                    Mem: ${formatBytes(gpu.mem_used || 0)} / ${formatBytes(gpu.mem_total || 0)}
                </div>
            </div>
        `).join('');
        document.getElementById('gpuContainer').innerHTML = gpuHtml;
    }
}

// WebSocket Events
socket.on('connect', () => {
    console.log('Connected to server');
    socket.emit('get_logs');
});

socket.on('metrics', (data) => {
    updateMetrics(data);
    if (data.running !== app.running) {
        updateServerStatus();
    }
});

socket.on('log_line', (data) => {
    if (data.line) {
        app.logs.push(data.line);
        const container = document.getElementById('logsContainer');

        // Clear placeholder if needed
        if (container.querySelector('.logs-placeholder')) {
            container.innerHTML = '';
        }

        const logLine = document.createElement('div');
        logLine.className = 'log-line';
        logLine.textContent = data.line;
        container.appendChild(logLine);

        // Keep only last 500 lines
        const lines = container.querySelectorAll('.log-line');
        if (lines.length > 500) {
            lines[0].remove();
        }

        // Auto-scroll
        if (document.getElementById('autoScroll').checked) {
            container.scrollTop = container.scrollHeight;
        }
    }
});

socket.on('logs_full', (data) => {
    const container = document.getElementById('logsContainer');
    container.innerHTML = data.lines.map(line => `
        <div class="log-line">${line}</div>
    `).join('');

    if (data.lines.length === 0) {
        container.innerHTML = '<div class="logs-placeholder">No logs yet</div>';
    }
});

socket.on('server_stopped', () => {
    updateServerStatus();
});

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
