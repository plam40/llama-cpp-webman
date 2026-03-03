/* ==========================================================================
   LlamaServer Manager - Frontend Application
   ========================================================================== */

(function () {
    'use strict';

    // ======================================================================
    // State
    // ======================================================================

    const state = {
        config: {},
        paramInfo: {},
        params: {},
        // paramEnabled tracks whether each parameter is included in the CLI command.
        // Essential params (model, host, port, ctx_size, threads, etc.) default to
        // enabled; optional flags default based on their typical use.
        paramEnabled: {},
        models: [],
        selectedModel: null,
        serverRunning: false,
        chatMessages: [],
        chatGenerating: false,
        socket: null,
        theme: localStorage.getItem('theme') || 'dark',
        logAutoScroll: true,
        debugMode: localStorage.getItem('debugMode') === 'true',
        metricsReceived: 0,
        lastMetricsTimestamp: 0,
    };

    // Params that are always included in the command (cannot be disabled).
    const ESSENTIAL_PARAMS = new Set([
        'host', 'port', 'ctx_size', 'threads', 'threads_batch',
        'batch_size', 'ubatch_size', 'n_predict', 'parallel', 'n_gpu_layers',
        'cache_type_k', 'cache_type_v',
    ]);

    // ======================================================================
    // DOM Helpers
    // ======================================================================

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'className') e.className = v;
            else if (k === 'textContent') e.textContent = v;
            else if (k === 'innerHTML') e.innerHTML = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else e.setAttribute(k, v);
        }
        for (const c of children) {
            if (typeof c === 'string') e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        }
        return e;
    }

    // ======================================================================
    // API Helpers
    // ======================================================================

    async function api(endpoint, method = 'GET', body = null) {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        try {
            const res = await fetch(`/api${endpoint}`, opts);
            const data = await res.json();
            return { ok: res.ok, data };
        } catch (err) {
            return { ok: false, data: { error: err.message } };
        }
    }

    // ======================================================================
    // Toast Notifications
    // ======================================================================

    function toast(message, type = 'info', duration = 4000) {
        const container = $('#toastContainer');
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

        const t = el('div', { className: `toast toast-${type}` }, [
            el('span', { className: 'toast-icon', textContent: icons[type] || icons.info }),
            el('span', { className: 'toast-content', textContent: message }),
            el('button', {
                className: 'toast-close',
                textContent: '×',
                onClick: () => removeToast(t),
            }),
        ]);

        container.appendChild(t);

        if (duration > 0) {
            setTimeout(() => removeToast(t), duration);
        }
    }

    function removeToast(t) {
        t.classList.add('removing');
        setTimeout(() => t.remove(), 300);
    }

    // ======================================================================
    // Modal
    // ======================================================================

    let modalResolve = null;

    function showModal(title, body, confirmText = 'Confirm') {
        return new Promise((resolve) => {
            modalResolve = resolve;
            $('#modalTitle').textContent = title;
            $('#modalBody').innerHTML = body;
            $('#modalConfirm').textContent = confirmText;
            $('#modalOverlay').style.display = 'flex';
        });
    }

    function closeModal(result) {
        $('#modalOverlay').style.display = 'none';
        if (modalResolve) {
            modalResolve(result);
            modalResolve = null;
        }
    }

    // ======================================================================
    // Theme
    // ======================================================================

    function setTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        $('#themeIcon').textContent = theme === 'dark' ? '🌙' : '☀️';
    }

    // ======================================================================
    // Tabs
    // ======================================================================

    function initTabs() {
        $$('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                $$('.tab-btn').forEach((b) => b.classList.remove('active'));
                $$('.tab-content').forEach((c) => c.classList.remove('active'));
                btn.classList.add('active');
                $(`#tab-${tab}`).classList.add('active');

                if (tab === 'logs') refreshLogs();
                if (tab === 'service') refreshServiceStatus();
                if (tab === 'server') refreshModels();
            });
        });
    }

    // ======================================================================
    // Gauge Helper
    // ======================================================================

    function setGauge(id, percent) {
        const circle = $(`#${id}`);
        if (!circle) return;
        const circumference = 326.73;
        const offset = circumference - (percent / 100) * circumference;
        circle.style.strokeDashoffset = Math.max(0, offset);
    }

    // ======================================================================
    // System Metrics Update
    // ======================================================================

    function updateSystemMetrics(data) {
        if (!data) {
            if (state.debugMode) console.warn('[DEBUG] updateSystemMetrics called with null/undefined data');
            return;
        }

        state.metricsReceived++;
        state.lastMetricsTimestamp = Date.now();

        const sys = data.system || {};
        const cpu = sys.cpu || {};
        const mem = sys.memory || {};
        const gpu = sys.gpu || {};
        const disk = sys.disk || {};
        const server = data.server || {};
        const llama = data.llama || {};
        const health = data.health || {};

        if (state.debugMode && state.metricsReceived <= 3) {
            console.log('[DEBUG] metrics_update #' + state.metricsReceived, {
                hasCpu: !!cpu.percent,
                hasMem: !!mem.percent,
                hasGpu: !!gpu.name,
                hasDisk: !!disk.total_gb,
                serverRunning: server.running,
                keys: Object.keys(sys),
            });
        }

        updateDebugPanel(data);

        // Helper: display a number or '--' if null/undefined (handles 0 correctly)
        const num = (v, suffix = '') => v != null ? `${v}${suffix}` : '--';

        // -- CPU --
        const cpuPct = cpu.percent ?? 0;
        setGauge('gaugeCpu', cpuPct);
        $('#gaugeCpuText').textContent = `${Math.round(cpuPct)}%`;
        $('#gaugeCpuSub').textContent = cpu.freq_current != null ? `${cpu.freq_current} MHz` : '-- MHz';
        $('#cpuFreq').textContent = `${num(cpu.freq_current)} / ${num(cpu.freq_max)} MHz`;
        $('#cpuTemp').textContent = cpu.temperature != null ? `${cpu.temperature} °C` : 'N/A';
        $('#cpuLoad').textContent = `${cpu.load_1m ?? '--'} / ${cpu.load_5m ?? '--'} / ${cpu.load_15m ?? '--'}`;
        $('#cpuCores').textContent = `${num(cpu.core_count)} / ${num(cpu.thread_count)}`;

        // Per-core bars
        const coreBars = $('#cpuCoreBars');
        if (cpu.per_core && cpu.per_core.length > 0) {
            if (coreBars.children.length !== cpu.per_core.length) {
                coreBars.innerHTML = '';
                cpu.per_core.forEach(() => {
                    coreBars.appendChild(el('div', { className: 'core-bar' }));
                });
            }
            cpu.per_core.forEach((pct, i) => {
                if (coreBars.children[i]) {
                    coreBars.children[i].style.height = `${Math.max(2, pct)}%`;
                    const hue = 240 - (pct / 100) * 120; // blue -> red
                    coreBars.children[i].style.background =
                        `hsl(${hue}, 70%, 60%)`;
                }
            });
        }

        // -- Memory --
        const memPct = mem.percent ?? 0;
        setGauge('gaugeMem', memPct);
        $('#gaugeMemText').textContent = `${Math.round(memPct)}%`;
        const memUsedGB = mem.used_mb != null ? (mem.used_mb / 1024).toFixed(1) : '--';
        const memTotalGB = mem.total_mb != null ? (mem.total_mb / 1024).toFixed(1) : '--';
        $('#gaugeMemSub').textContent = `${memUsedGB}/${memTotalGB} GB`;
        $('#memUsed').textContent = num(mem.used_mb, ' MB');
        $('#memAvailable').textContent = num(mem.available_mb, ' MB');
        $('#memTotal').textContent = num(mem.total_mb, ' MB');
        $('#memSwap').textContent = `${mem.swap_used_mb ?? 0} / ${mem.swap_total_mb ?? 0} MB`;
        $('#memBar').style.width = `${memPct}%`;
        $('#swapBar').style.width = `${mem.swap_percent ?? 0}%`;

        // -- GPU --
        const gpuCard = $('#gpuCard');
        if (gpu && gpu.name) {
            gpuCard.style.display = '';
            const gpuPct = gpu.gpu_util ?? 0;
            setGauge('gaugeGpu', gpuPct);
            $('#gaugeGpuText').textContent = `${Math.round(gpuPct)}%`;
            $('#gaugeGpuSub').textContent = 'Utilization';
            $('#gpuName').textContent = gpu.name;
            $('#gpuMemUsed').textContent = num(gpu.mem_used_mb, ' MB');
            $('#gpuMemTotal').textContent = num(gpu.mem_total_mb, ' MB');
            $('#gpuTemp').textContent = num(gpu.temperature, ' °C');
            $('#gpuPower').textContent = `${num(gpu.power_draw_w)} / ${num(gpu.power_limit_w)} W`;
            $('#gpuFan').textContent = gpu.fan_speed != null && gpu.fan_speed >= 0 ? `${gpu.fan_speed}%` : 'N/A';
            $('#gpuClock').textContent = `${num(gpu.clock_gpu_mhz)} / ${num(gpu.clock_mem_mhz)} MHz`;

            $('#gpuUtilBar').style.width = `${gpuPct}%`;
            const vramPct = gpu.mem_total_mb ? (gpu.mem_used_mb / gpu.mem_total_mb) * 100 : 0;
            $('#gpuMemBar').style.width = `${vramPct}%`;
        } else {
            // Show N/A for GPU
            setGauge('gaugeGpu', 0);
            $('#gaugeGpuText').textContent = 'N/A';
            $('#gaugeGpuSub').textContent = 'No GPU';
            $('#gpuName').textContent = 'Not detected';
        }

        // -- Disk --
        $('#diskUsed').textContent = num(disk.used_gb, ' GB');
        $('#diskFree').textContent = num(disk.free_gb, ' GB');
        $('#diskTotal').textContent = num(disk.total_gb, ' GB');
        $('#diskBar').style.width = `${disk.percent ?? 0}%`;
        $('#diskPercent').textContent = `${disk.percent ?? 0}%`;

        // -- Server Status --
        updateServerIndicator(server, health);
        updateLlamaStats(server, llama, health);
    }

    function updateServerIndicator(server, health) {
        const ind = $('#serverIndicator');
        const indText = ind.querySelector('.indicator-text');
        const modeBadge = $('#serverModeBadge');
        const uptimeDisp = $('#uptimeDisplay');
        const uptimeText = $('#uptimeText');
        const toggleBtn = $('#btnToggleServer');
        const toggleLabel = $('#toggleServerLabel');
        const toggleIcon = $('#toggleServerIcon');
        const restartBtn = $('#btnHeaderRestart');

        const isRunning = server.running === true;
        const isExternal = server.external === true;
        const isManaged = server.managed === true;
        state.serverRunning = isRunning;

        ind.classList.remove('running', 'stopped', 'loading', 'external');

        if (isRunning) {
            const hStatus = (health && health.status) || 'unknown';
            if (hStatus === 'ok' || hStatus === 'no slot available') {
                ind.classList.add('running');
                indText.textContent = 'Running';
            } else if (hStatus === 'loading model') {
                ind.classList.add('loading');
                indText.textContent = 'Loading...';
            } else {
                ind.classList.add('running');
                indText.textContent = `Running (${hStatus})`;
            }

            // Show managed/external badge
            if (modeBadge) {
                if (isExternal) {
                    ind.classList.add('external');
                    modeBadge.textContent = 'external';
                    modeBadge.className = 'indicator-badge badge-external';
                    modeBadge.style.display = '';
                } else if (isManaged) {
                    modeBadge.textContent = 'managed';
                    modeBadge.className = 'indicator-badge badge-managed';
                    modeBadge.style.display = '';
                } else {
                    modeBadge.style.display = 'none';
                }
            }

            uptimeDisp.style.display = '';
            uptimeText.textContent = server.uptime || '--:--:--';

            // Toggle button → Stop mode
            if (toggleBtn) {
                toggleBtn.classList.add('btn-header-danger');
                toggleBtn.classList.remove('btn-header-success');
                toggleBtn.title = isExternal ? 'Stop External Server' : 'Stop Server';
            }
            if (toggleLabel) toggleLabel.textContent = 'Stop';
            if (toggleIcon) toggleIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="1"></rect>';
            if (restartBtn) restartBtn.disabled = false;

            // Apply & Restart mode on params tab
            const applyLabel = $('#applyParamsLabel');
            if (applyLabel) applyLabel.textContent = 'Apply & Restart';
        } else {
            ind.classList.add('stopped');
            indText.textContent = 'Stopped';
            if (modeBadge) modeBadge.style.display = 'none';
            uptimeDisp.style.display = 'none';

            // Toggle button → Start mode
            if (toggleBtn) {
                toggleBtn.classList.remove('btn-header-danger');
                toggleBtn.classList.add('btn-header-success');
                toggleBtn.title = 'Start Server';
            }
            if (toggleLabel) toggleLabel.textContent = 'Start';
            if (toggleIcon) toggleIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
            if (restartBtn) restartBtn.disabled = true;

            // Start Server mode on params tab
            const applyLabel = $('#applyParamsLabel');
            if (applyLabel) applyLabel.textContent = 'Start Server';
        }

        // Server control tab status
        const srvState = $('#srvState');
        if (srvState) {
            let stateText = isRunning ? 'Running' : 'Stopped';
            if (isRunning && isExternal) stateText = 'Running (External)';
            srvState.textContent = stateText;
            srvState.className = `status-table-value ${isRunning ? 'text-success' : 'text-danger'}`;
        }
        const srvHealth = $('#srvHealth');
        if (srvHealth) {
            const h = (health && health.status) || (isRunning ? 'checking...' : '--');
            srvHealth.textContent = h;
            srvHealth.className = `status-table-value ${h === 'ok' ? 'text-success' : ''}`;
        }
        if ($('#srvModel')) $('#srvModel').textContent = server.model_name || '--';
        if ($('#srvUptime')) $('#srvUptime').textContent = server.uptime || '--';
        if ($('#srvPid')) $('#srvPid').textContent = (server.process && server.process.pid) || '--';
        if ($('#srvMem')) {
            const rss = server.process && server.process.rss_mb;
            $('#srvMem').textContent = rss ? `${rss} MB` : '--';
        }
    }

    function updateLlamaStats(server, llama, health) {
        const isRunning = server.running === true;

        $('#statStatus').textContent = isRunning
            ? (health && health.status) || 'running'
            : 'stopped';
        $('#statStatus').className = `stat-value ${isRunning ? 'text-success' : 'text-danger'}`;

        $('#statModel').textContent = server.model_name || '--';
        $('#statPid').textContent = (server.process && server.process.pid) || '--';
        $('#statRss').textContent = server.process && server.process.rss_mb
            ? `${server.process.rss_mb} MB` : '--';
        $('#statCpuPercent').textContent = server.process && server.process.cpu_percent != null
            ? `${server.process.cpu_percent.toFixed(1)}%` : '--';
        $('#statThreads').textContent = (server.process && server.process.threads) || '--';

        // Prometheus metrics
        if (llama && Object.keys(llama).length > 0) {
            const v = (key) => {
                const val = llama[key];
                return val != null ? val : null;
            };

            const promptTokens = v('llamacpp_prompt_tokens_total') ?? v('llama_prompt_tokens_total');
            const genTokens = v('llamacpp_tokens_predicted_total') ?? v('llama_tokens_predicted_total');
            const promptSec = v('llamacpp_prompt_tokens_seconds') ?? v('llama_prompt_tokens_seconds');
            const genSec = v('llamacpp_tokens_predicted_seconds') ?? v('llama_tokens_predicted_seconds');
            const kvUsed = v('llamacpp_kv_cache_usage_ratio') ?? v('llama_kv_cache_usage_ratio');
            const reqCount = v('llamacpp_requests_processing') ?? v('llama_requests_processing');

            $('#statPromptTokens').textContent = promptTokens != null ? Math.round(promptTokens) : '--';
            $('#statGenTokens').textContent = genTokens != null ? Math.round(genTokens) : '--';

            if (promptTokens != null && promptSec != null && promptSec > 0) {
                $('#statPromptTps').textContent = `${(promptTokens / promptSec).toFixed(1)} t/s`;
            } else {
                $('#statPromptTps').textContent = '--';
            }

            if (genTokens != null && genSec != null && genSec > 0) {
                $('#statGenTps').textContent = `${(genTokens / genSec).toFixed(1)} t/s`;
            } else {
                $('#statGenTps').textContent = '--';
            }

            $('#statKvUsed').textContent = kvUsed != null ? `${(kvUsed * 100).toFixed(1)}%` : '--';
            $('#statRequests').textContent = reqCount != null ? Math.round(reqCount) : '--';
        } else if (!isRunning) {
            ['statPromptTokens', 'statGenTokens', 'statPromptTps', 'statGenTps', 'statKvUsed', 'statRequests']
                .forEach((id) => { $(`#${id}`).textContent = '--'; });
        }
    }

    // ======================================================================
    // Models
    // ======================================================================

    // ======================================================================
    // Wheel-Select (custom dropdown: plain text + mouse wheel)
    // ======================================================================

    /**
     * Initialise a wheel-select element.
     * items: [{value, label}]
     * onChange: callback(item)
     */
    function initWheelSelect(container, items, onChange) {
        // Abort previous listeners when re-initialising the same container
        if (container._wsAbort) container._wsAbort.abort();
        const ac = new AbortController();
        container._wsAbort = ac;

        container._wsItems = items;
        container._wsIndex = 0;
        container._wsOnChange = onChange;
        _wsRender(container);

        // Mouse wheel
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const dir = e.deltaY > 0 ? 1 : -1;
            _wsMove(container, dir);
        }, { passive: false, signal: ac.signal });

        // Arrow buttons – one step per click (no wrapping)
        container.querySelectorAll('.wheel-select-arrow').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = btn.dataset.dir === 'next' ? 1 : -1;
                _wsMove(container, dir);
            }, { signal: ac.signal });
        });

        // Keyboard
        container.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); _wsMove(container, -1); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); _wsMove(container, 1); }
        }, { signal: ac.signal });
    }

    function _wsMove(container, dir) {
        const items = container._wsItems;
        if (!items || items.length === 0) return;
        let idx = container._wsIndex + dir;
        if (idx < 0) idx = 0;
        if (idx >= items.length) idx = items.length - 1;
        if (idx === container._wsIndex) return;
        container._wsIndex = idx;
        _wsRender(container);
        if (container._wsOnChange) container._wsOnChange(items[idx]);
    }

    function _wsSetIndex(container, idx) {
        if (!container._wsItems) return;
        if (idx < 0 || idx >= container._wsItems.length) return;
        container._wsIndex = idx;
        _wsRender(container);
    }

    function _wsRender(container) {
        const textEl = container.querySelector('.wheel-select-text');
        const items = container._wsItems || [];
        if (items.length === 0) {
            textEl.textContent = 'No items';
            return;
        }
        const item = items[container._wsIndex];
        textEl.textContent = item.label;
        // Show/hide arrows at boundaries
        const prev = container.querySelector('.wheel-select-prev');
        const next = container.querySelector('.wheel-select-next');
        if (prev) prev.style.opacity = container._wsIndex > 0 ? '1' : '0.2';
        if (next) next.style.opacity = container._wsIndex < items.length - 1 ? '1' : '0.2';
    }

    async function refreshModels() {
        const res = await api('/models');
        if (!res.ok) {
            toast('Failed to load models', 'error');
            return;
        }

        state.models = res.data.models || [];
        const container = $('#modelSelect');
        const modelsDirPath = $('#modelsDirPath');
        if (modelsDirPath) modelsDirPath.textContent = res.data.models_dir || '/opt/models';

        if (state.models.length === 0) {
            initWheelSelect(container, [{ value: '', label: 'No .gguf models found' }], () => {});
            state.selectedModel = null;
        } else {
            const items = [
                { value: '', label: `Select a model (${state.models.length} found)` },
                ...state.models.map((m) => ({
                    value: m.path,
                    label: m.directory
                        ? `${m.directory}/${m.name} (${m.size_gb} GB)`
                        : `${m.name} (${m.size_gb} GB)`,
                })),
            ];
            initWheelSelect(container, items, (item) => {
                state.selectedModel = state.models.find((m) => m.path === item.value) || null;
                showModelInfo(state.selectedModel);
                updateCommandPreview();
            });

            // Pre-select last used model
            if (state.config.last_model) {
                const idx = items.findIndex((it) => it.value === state.config.last_model);
                if (idx >= 0) {
                    _wsSetIndex(container, idx);
                    state.selectedModel = state.models.find((m) => m.path === state.config.last_model) || null;
                    showModelInfo(state.selectedModel);
                }
            }
        }

        updateCommandPreview();
    }

    function showModelInfo(model) {
        const infoDiv = $('#modelInfo');
        if (!model) {
            infoDiv.style.display = 'none';
            return;
        }
        infoDiv.style.display = '';
        $('#modelInfoName').textContent = model.name;
        $('#modelInfoSize').textContent = `${model.size_gb} GB (${(model.size_bytes / (1024 * 1024)).toFixed(0)} MB)`;
        $('#modelInfoPath').textContent = model.path;
        $('#modelInfoModified').textContent = new Date(model.modified).toLocaleString();
    }

    // ======================================================================
    // Parameters
    // ======================================================================

    async function loadParamInfo() {
        const res = await api('/params/info');
        if (res.ok) {
            state.paramInfo = res.data;
        }
    }

    function buildParamsUI() {
        const container = $('#paramsContainer');
        container.innerHTML = '';

        const params = state.params;
        const info = state.paramInfo;

        const order = [
            'ctx_size', 'threads', 'threads_batch', 'n_gpu_layers',
            'batch_size', 'ubatch_size', 'n_predict', 'parallel',
            'flash_attn', 'mlock', 'mmap', 'cont_batching',
            'cache_type_k', 'cache_type_v',
            'temp', 'top_k', 'top_p', 'repeat_penalty',
            'host', 'port', 'verbose',
        ];

        // Initialise enable state for any param that hasn't been set yet.
        // Essential params are always enabled; optional ones default to true
        // except flash_attn (off by default until user explicitly enables it).
        order.forEach((key) => {
            if (!(key in state.paramEnabled)) {
                if (key === 'flash_attn') {
                    state.paramEnabled[key] = false;
                } else {
                    state.paramEnabled[key] = true;
                }
            }
        });

        order.forEach((key) => {
            const pi = info[key];
            if (!pi) return;

            const currentVal = params[key] ?? pi.default;
            const card = buildParamCard(key, pi, currentVal);
            container.appendChild(card);
        });
    }

    function buildParamCard(key, pi, currentVal) {
        const isEssential = ESSENTIAL_PARAMS.has(key);
        const isEnabled = isEssential ? true : (state.paramEnabled[key] !== false);

        const card = el('div', {
            className: `param-card${isEnabled ? '' : ' param-disabled'}`,
            'data-category': pi.category || 'other',
        });

        // Header row
        const header = el('div', { className: 'param-card-header' });

        const left = el('div', { className: 'param-card-left' }, [
            el('span', {
                className: `param-category-badge cat-${pi.category || 'other'}`,
                textContent: pi.category || 'other',
            }),
            el('div', {}, [
                el('div', { className: 'param-name', textContent: pi.label }),
                el('div', { className: 'param-description', textContent: pi.description }),
            ]),
        ]);

        const right = el('div', { className: 'param-card-right' });

        // Enable/Disable toggle (shown for non-essential params)
        if (!isEssential) {
            const enableWrap = el('div', { className: 'param-enable-wrap', title: isEnabled ? 'Disable this parameter' : 'Enable this parameter' });
            const enableLabel = el('label', { className: 'toggle-switch param-enable-toggle' });
            const enableCb = el('input', { type: 'checkbox' });
            enableCb.checked = isEnabled;
            enableCb.addEventListener('change', (ev) => {
                ev.stopPropagation();
                state.paramEnabled[key] = enableCb.checked;
                card.classList.toggle('param-disabled', !enableCb.checked);
                // Grey out the value inputs (including wheel-selects)
                card.querySelectorAll('.param-input, .param-input-select, input[data-param]').forEach((inp) => {
                    inp.disabled = !enableCb.checked;
                });
                card.querySelectorAll('.wheel-select').forEach((ws) => {
                    ws.style.pointerEvents = enableCb.checked ? '' : 'none';
                    ws.style.opacity = enableCb.checked ? '' : '0.4';
                });
                updateCommandPreview();
            });
            enableLabel.appendChild(enableCb);
            enableLabel.appendChild(el('span', { className: 'toggle-slider' }));
            enableWrap.appendChild(enableLabel);
            right.appendChild(enableWrap);
        }

        const inputInline = el('div', { className: 'param-input-inline' });

        // Build input based on type
        if (pi.type === 'boolean') {
            const toggle = el('label', { className: 'toggle-switch' });
            const checkbox = el('input', {
                type: 'checkbox',
                'data-param': key,
            });
            checkbox.checked = !!currentVal;
            checkbox.addEventListener('change', () => {
                state.params[key] = checkbox.checked;
                updateCommandPreview();
            });
            toggle.appendChild(checkbox);
            toggle.appendChild(el('span', { className: 'toggle-slider' }));
            inputInline.appendChild(toggle);
        } else if (pi.type === 'select') {
            const wsDiv = el('div', {
                className: 'wheel-select wheel-select-inline',
                tabIndex: '0',
                'data-param': key,
            });
            const prevArrow = el('span', { className: 'wheel-select-arrow wheel-select-prev', 'data-dir': 'prev' });
            prevArrow.innerHTML = '&#9650;';
            const textSpan = el('span', { className: 'wheel-select-text' });
            const nextArrow = el('span', { className: 'wheel-select-arrow wheel-select-next', 'data-dir': 'next' });
            nextArrow.innerHTML = '&#9660;';
            wsDiv.appendChild(prevArrow);
            wsDiv.appendChild(textSpan);
            wsDiv.appendChild(nextArrow);
            inputInline.appendChild(wsDiv);

            const options = (pi.options || []).map((opt) => ({ value: opt, label: opt }));
            initWheelSelect(wsDiv, options, (item) => {
                state.params[key] = item.value;
                updateCommandPreview();
            });
            // Set initial value
            const initIdx = options.findIndex((o) => o.value === currentVal);
            if (initIdx >= 0) _wsSetIndex(wsDiv, initIdx);
        } else if (pi.type === 'float') {
            const input = el('input', {
                type: 'number',
                className: 'param-input',
                'data-param': key,
                value: currentVal,
                step: pi.step || 0.05,
                min: pi.min ?? '',
                max: pi.max ?? '',
            });
            input.addEventListener('change', () => {
                state.params[key] = parseFloat(input.value) || pi.default;
                updateSliderFromInput(key, input.value);
                updateCommandPreview();
            });
            inputInline.appendChild(input);
        } else if (pi.type === 'number') {
            const input = el('input', {
                type: 'number',
                className: 'param-input',
                'data-param': key,
                value: currentVal,
                step: pi.step || 1,
                min: pi.min ?? '',
                max: pi.max ?? '',
            });
            input.addEventListener('change', () => {
                state.params[key] = parseInt(input.value, 10);
                if (isNaN(state.params[key])) state.params[key] = pi.default;
                updateSliderFromInput(key, input.value);
                updateCommandPreview();
            });
            inputInline.appendChild(input);
            if (pi.unit) {
                inputInline.appendChild(el('span', { className: 'param-unit', textContent: pi.unit }));
            }
        } else {
            // text
            const input = el('input', {
                type: 'text',
                className: 'param-input',
                'data-param': key,
                value: currentVal,
                style: { width: '160px' },
            });
            input.addEventListener('change', () => {
                state.params[key] = input.value;
                updateCommandPreview();
            });
            inputInline.appendChild(input);
        }

        // Disable value inputs when the param is disabled
        if (!isEnabled) {
            inputInline.querySelectorAll('input, select').forEach((inp) => {
                inp.disabled = true;
            });
            inputInline.querySelectorAll('.wheel-select').forEach((ws) => {
                ws.style.pointerEvents = 'none';
                ws.style.opacity = '0.4';
            });
        }

        right.appendChild(inputInline);

        const expandIcon = el('span', { className: 'param-expand-icon', textContent: '▼' });
        right.appendChild(expandIcon);

        header.appendChild(left);
        header.appendChild(right);

        // Click header to expand (but not when clicking input or wheel-select)
        header.addEventListener('click', (e) => {
            if (e.target.closest('input, select, label, .toggle-switch, .wheel-select')) return;
            card.classList.toggle('expanded');
        });

        card.appendChild(header);

        // Detail section
        const detail = el('div', { className: 'param-detail' });

        detail.appendChild(el('div', {
            className: 'param-detail-text',
            textContent: pi.detail,
        }));

        if (pi.increase_effect || pi.decrease_effect) {
            const effects = el('div', { className: 'param-effects' });

            if (pi.increase_effect && pi.increase_effect !== 'N/A') {
                effects.appendChild(el('div', { className: 'param-effect param-effect-increase' }, [
                    el('div', { className: 'param-effect-title', textContent: '↑ Increase Effect' }),
                    el('div', { textContent: pi.increase_effect }),
                ]));
            }
            if (pi.decrease_effect && pi.decrease_effect !== 'N/A') {
                effects.appendChild(el('div', { className: 'param-effect param-effect-decrease' }, [
                    el('div', { className: 'param-effect-title', textContent: '↓ Decrease Effect' }),
                    el('div', { textContent: pi.decrease_effect }),
                ]));
            }

            detail.appendChild(effects);
        }

        // Slider for numeric types
        if ((pi.type === 'number' || pi.type === 'float') && pi.min != null && pi.max != null) {
            const sliderRow = el('div', { className: 'param-slider-row' });

            sliderRow.appendChild(el('span', {
                className: 'param-slider-min',
                textContent: pi.min,
            }));

            const slider = el('input', {
                type: 'range',
                className: 'param-slider',
                'data-param-slider': key,
                min: pi.min,
                max: pi.max,
                step: pi.step || 1,
                value: currentVal,
            });

            slider.addEventListener('input', () => {
                const val = pi.type === 'float' ? parseFloat(slider.value) : parseInt(slider.value, 10);
                state.params[key] = val;
                // Update the text input
                const inp = card.querySelector(`[data-param="${key}"]`);
                if (inp) inp.value = val;
                updateCommandPreview();
            });

            sliderRow.appendChild(slider);

            sliderRow.appendChild(el('span', {
                className: 'param-slider-max',
                textContent: pi.max,
            }));

            detail.appendChild(sliderRow);
        }

        card.appendChild(detail);

        return card;
    }

    function updateSliderFromInput(key, value) {
        const slider = $(`[data-param-slider="${key}"]`);
        if (slider) slider.value = value;
    }

    function filterParams(category) {
        $$('.param-card').forEach((card) => {
            if (category === 'all' || card.dataset.category === category) {
                card.style.display = '';
            } else {
                card.style.display = 'none';
            }
        });
    }

    // ======================================================================
    // Command Preview
    // ======================================================================

    // Returns the active (enabled) params to send to the server.
    function getActiveParams() {
        const active = {};
        for (const [key, val] of Object.entries(state.params)) {
            if (ESSENTIAL_PARAMS.has(key) || state.paramEnabled[key] !== false) {
                active[key] = val;
            }
        }
        return active;
    }

    function updateCommandPreview() {
        const previewDiv = $('#commandPreview');
        const previewText = $('#commandPreviewText');

        const modelPath = state.selectedModel ? state.selectedModel.path : '<model_path>';
        const serverPath = state.config.llama_server_path || 'llama-server';
        const params = state.params;
        const enabled = (key) => ESSENTIAL_PARAMS.has(key) || state.paramEnabled[key] !== false;

        let cmd = serverPath;
        cmd += ` \\\n  --model ${modelPath}`;
        cmd += ` \\\n  --host ${params.host ?? '0.0.0.0'}`;
        cmd += ` \\\n  --port ${params.port ?? 8080}`;
        cmd += ` \\\n  --ctx-size ${params.ctx_size ?? 4096}`;
        cmd += ` \\\n  --threads ${params.threads ?? 4}`;
        cmd += ` \\\n  --threads-batch ${params.threads_batch ?? 4}`;
        cmd += ` \\\n  --batch-size ${params.batch_size ?? 2048}`;
        cmd += ` \\\n  --ubatch-size ${params.ubatch_size ?? 512}`;
        cmd += ` \\\n  --n-predict ${params.n_predict ?? -1}`;
        cmd += ` \\\n  --parallel ${params.parallel ?? 1}`;
        cmd += ` \\\n  --n-gpu-layers ${params.n_gpu_layers ?? 0}`;
        cmd += ` \\\n  --cache-type-k ${params.cache_type_k ?? 'f16'}`;
        cmd += ` \\\n  --cache-type-v ${params.cache_type_v ?? 'f16'}`;

        // flash_attn requires an explicit "on" or "off" value
        if (enabled('flash_attn') && params.flash_attn) {
            cmd += ` \\\n  --flash-attn ${params.flash_attn}`;
        }
        if (enabled('mlock') && params.mlock) cmd += ` \\\n  --mlock`;
        if (enabled('mmap')) {
            if (params.mmap !== false) cmd += ` \\\n  --mmap`;
            else cmd += ` \\\n  --no-mmap`;
        }
        if (enabled('cont_batching') && params.cont_batching) cmd += ` \\\n  --cont-batching`;
        if (enabled('verbose') && params.verbose) cmd += ` \\\n  --verbose`;

        if (enabled('temp')) cmd += ` \\\n  --temp ${params.temp ?? 0.7}`;
        if (enabled('top_k')) cmd += ` \\\n  --top-k ${params.top_k ?? 40}`;
        if (enabled('top_p')) cmd += ` \\\n  --top-p ${params.top_p ?? 0.95}`;
        if (enabled('repeat_penalty')) cmd += ` \\\n  --repeat-penalty ${params.repeat_penalty ?? 1.1}`;

        previewText.textContent = cmd;
        previewDiv.style.display = '';
    }

    // ======================================================================
    // Server Control
    // ======================================================================

    async function startServer() {
        if (!state.selectedModel) {
            toast('Please select a model first', 'warning');
            return;
        }

        const toggleBtn = $('#btnToggleServer');
        if (toggleBtn) toggleBtn.disabled = true;
        toast('Starting server...', 'info');

        const res = await api('/server/start', 'POST', {
            model_path: state.selectedModel.path,
            params: getActiveParams(),
        });

        if (res.ok && res.data.ok) {
            toast('Server starting!', 'success');
        } else {
            toast(`Failed to start: ${res.data.error || res.data.message}`, 'error');
        }
        if (toggleBtn) toggleBtn.disabled = false;
    }

    async function stopServer() {
        const confirmed = await showModal(
            'Stop Server',
            'Are you sure you want to stop the llama-server?',
            'Stop'
        );
        if (!confirmed) return;

        const toggleBtn = $('#btnToggleServer');
        if (toggleBtn) toggleBtn.disabled = true;
        toast('Stopping server...', 'info');

        const res = await api('/server/stop', 'POST');
        if (res.ok && res.data.ok) {
            toast(res.data.message || 'Server stopped', 'success');
        } else {
            toast(`Failed to stop: ${res.data.error || res.data.message}`, 'error');
        }
        if (toggleBtn) toggleBtn.disabled = false;
    }

    async function restartServer() {
        const confirmed = await showModal(
            'Restart Server',
            'Are you sure you want to restart the llama-server with current parameters?',
            'Restart'
        );
        if (!confirmed) return;

        toast('Restarting server...', 'info');

        const body = {
            params: getActiveParams(),
        };
        if (state.selectedModel) {
            body.model_path = state.selectedModel.path;
        }

        const res = await api('/server/restart', 'POST', body);
        if (res.ok && res.data.ok) {
            toast('Server restarting!', 'success');
        } else {
            toast(`Failed to restart: ${res.data.error || res.data.message}`, 'error');
        }
    }

    // ======================================================================
    // Chat
    // ======================================================================

    function addChatMessage(role, content) {
        const msgDiv = el('div', { className: `chat-message ${role}` }, [
            el('div', { className: 'chat-avatar', textContent: role === 'user' ? '👤' : '🦙' }),
            el('div', { className: 'chat-bubble', textContent: content }),
        ]);

        const container = $('#chatMessages');
        // Remove welcome message if present
        const welcome = container.querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        container.appendChild(msgDiv);
        container.scrollTop = container.scrollHeight;

        state.chatMessages.push({ role, content });
        return msgDiv;
    }

    function addTypingIndicator() {
        const typing = el('div', { className: 'chat-message assistant', id: 'typingIndicator' }, [
            el('div', { className: 'chat-avatar', textContent: '🦙' }),
            el('div', { className: 'chat-bubble' }, [
                el('div', { className: 'chat-typing' }, [
                    el('span'), el('span'), el('span'),
                ]),
            ]),
        ]);

        const container = $('#chatMessages');
        container.appendChild(typing);
        container.scrollTop = container.scrollHeight;
        return typing;
    }

    function removeTypingIndicator() {
        const t = $('#typingIndicator');
        if (t) t.remove();
    }

    async function sendChatMessage() {
        const input = $('#chatInput');
        const message = input.value.trim();
        if (!message || state.chatGenerating) return;

        if (!state.serverRunning) {
            toast('Server is not running. Start it first.', 'warning');
            return;
        }

        addChatMessage('user', message);
        input.value = '';
        input.style.height = 'auto';

        state.chatGenerating = true;
        $('#chatStatus').textContent = 'Generating...';
        $('#btnSendChat').disabled = true;

        addTypingIndicator();

        // Build messages array for API
        const messages = state.chatMessages.map((m) => ({
            role: m.role,
            content: m.content,
        }));

        try {
            const res = await api('/chat', 'POST', {
                model: 'local-model',
                messages: messages,
                temperature: state.params.temp ?? 0.7,
                top_p: state.params.top_p ?? 0.95,
                max_tokens: state.params.n_predict > 0 ? state.params.n_predict : 2048,
                stream: false,
            });

            removeTypingIndicator();

            if (res.ok && res.data.choices && res.data.choices.length > 0) {
                const reply = res.data.choices[0].message.content;
                addChatMessage('assistant', reply);

                // Token info
                if (res.data.usage) {
                    const u = res.data.usage;
                    $('#chatTokenInfo').textContent =
                        `Prompt: ${u.prompt_tokens || 0} | Generated: ${u.completion_tokens || 0} | Total: ${u.total_tokens || 0}`;
                }
            } else {
                const errMsg = res.data.error || 'Unknown error';
                addChatMessage('assistant', `⚠️ Error: ${typeof errMsg === 'object' ? errMsg.message || JSON.stringify(errMsg) : errMsg}`);
            }
        } catch (err) {
            removeTypingIndicator();
            addChatMessage('assistant', `⚠️ Error: ${err.message}`);
        }

        state.chatGenerating = false;
        $('#chatStatus').textContent = 'Ready';
        $('#btnSendChat').disabled = false;
        input.focus();
    }

    function clearChat() {
        state.chatMessages = [];
        const container = $('#chatMessages');
        container.innerHTML = '';
        container.appendChild(el('div', { className: 'chat-welcome' }, [
            el('div', { className: 'chat-welcome-icon', textContent: '🦙' }),
            el('div', { className: 'chat-welcome-text', innerHTML: 'Start a conversation with your LLM.<br><span class="chat-welcome-sub">Make sure the server is running first.</span>' }),
        ]));
        $('#chatTokenInfo').textContent = '';
    }

    // ======================================================================
    // Logs
    // ======================================================================

    async function refreshLogs() {
        const res = await api('/server/logs?n=500');
        if (res.ok) {
            const logContent = $('#logContent');
            logContent.textContent = (res.data.logs || []).join('\n') || 'No logs yet...';
            if (state.logAutoScroll) {
                const container = $('#logContainer');
                container.scrollTop = container.scrollHeight;
            }
        }
    }

    function appendLogLine(line) {
        const logContent = $('#logContent');
        if (logContent.textContent === 'Waiting for logs...' || logContent.textContent === 'No logs yet...') {
            logContent.textContent = '';
        }
        logContent.textContent += line + '\n';
        if (state.logAutoScroll) {
            const container = $('#logContainer');
            container.scrollTop = container.scrollHeight;
        }
    }

    // ======================================================================
    // Service Management
    // ======================================================================

    async function refreshServiceStatus() {
        const res = await api('/service/status');
        if (!res.ok) return;

        const services = res.data;

        const setVal = (id, val) => {
            const elem = $(`#${id}`);
            if (!elem) return;
            elem.textContent = val ? 'Yes' : 'No';
            elem.className = `service-status-value ${val ? 'yes' : 'no'}`;
        };

        if (services['llama-server']) {
            setVal('svcLlamaInstalled', services['llama-server'].installed);
            setVal('svcLlamaEnabled', services['llama-server'].enabled);
            setVal('svcLlamaActive', services['llama-server'].active);
        }

        if (services['llama-manager']) {
            setVal('svcManagerInstalled', services['llama-manager'].installed);
            setVal('svcManagerEnabled', services['llama-manager'].enabled);
            setVal('svcManagerActive', services['llama-manager'].active);
        }
    }

    async function serviceAction(service, action) {
        toast(`${action}ing ${service}...`, 'info');
        const res = await api('/service/action', 'POST', { service, action });
        if (res.ok && res.data.ok) {
            toast(res.data.message, 'success');
        } else {
            toast(res.data.error || res.data.message || 'Failed', 'error');
        }
        setTimeout(refreshServiceStatus, 1000);
    }

    async function installService() {
        if (!state.selectedModel) {
            toast('Please select a model first (Server Control tab)', 'warning');
            return;
        }

        const confirmed = await showModal(
            'Install / Update Service',
            `<p>This will write the llama-server systemd service file with:</p>
             <ul style="margin:10px 0;padding-left:20px;">
               <li>Model: <strong>${state.selectedModel.name}</strong></li>
               <li>All current parameters from the Parameters tab</li>
             </ul>
             <p>The service can then be started/stopped via systemctl and enabled for boot.</p>`,
            'Install'
        );
        if (!confirmed) return;

        const res = await api('/service/install', 'POST', {
            model_path: state.selectedModel.path,
            params: getActiveParams(),
        });

        if (res.ok && res.data.ok) {
            toast('Service installed/updated successfully!', 'success');
            refreshServiceStatus();
        } else {
            toast(res.data.error || res.data.message || 'Failed to install service', 'error');
        }
    }

    async function installManagerService() {
        const confirmed = await showModal(
            'Install / Update Manager Service',
            '<p>This will write the llama-manager systemd service file so the web UI can be managed via systemctl and enabled for boot.</p>',
            'Install'
        );
        if (!confirmed) return;

        const res = await api('/service/install-manager', 'POST');
        if (res.ok && res.data.ok) {
            toast('Manager service installed successfully!', 'success');
            refreshServiceStatus();
        } else {
            toast(res.data.error || res.data.message || 'Failed to install manager service', 'error');
        }
    }

    async function removeService(service) {
        const label = service === 'llama-server' ? 'llama-server' : 'llama-manager';
        const confirmed = await showModal(
            `Remove ${label} Service`,
            `<p>This will stop, disable, and remove the <strong>${label}</strong> systemd service file.</p><p>This action cannot be undone.</p>`,
            'Remove'
        );
        if (!confirmed) return;

        const res = await api('/service/remove', 'POST', { service });
        if (res.ok && res.data.ok) {
            toast(res.data.message || `${label} service removed`, 'success');
            refreshServiceStatus();
        } else {
            toast(res.data.error || res.data.message || `Failed to remove ${label} service`, 'error');
        }
    }

    // ======================================================================
    // WebSocket
    // ======================================================================

    function initSocket() {
        if (typeof io === 'undefined') {
            console.error('[CRITICAL] Socket.IO library not loaded – falling back to HTTP polling');
            toast('WebSocket library failed to load – using HTTP polling', 'warning', 6000);
            startMetricsPolling();
            return;
        }

        const socket = io({ transports: ['websocket', 'polling'] });
        state.socket = socket;

        socket.on('connect', () => {
            console.log('[WS] Connected (id=' + socket.id + ')');
            socket.emit('request_metrics');
        });

        socket.on('disconnect', (reason) => {
            console.warn('[WS] Disconnected: ' + reason);
        });

        socket.on('connect_error', (err) => {
            console.error('[WS] Connection error:', err.message);
            if (state.debugMode) toast('WebSocket error: ' + err.message, 'warning', 5000);
        });

        socket.on('metrics_update', (data) => {
            updateSystemMetrics(data);
        });

        socket.on('log_line', (data) => {
            if (data && data.line) {
                appendLogLine(data.line);
            }
        });

        socket.on('connected', () => {
            console.log('[WS] Server acknowledged connection');
            socket.emit('request_metrics');
        });

        // HTTP polling fallback: if the socket doesn't deliver data within 5 s,
        // fall back to polling the REST endpoint every 3 s.
        let _wsReceived = false;
        socket.on('metrics_update', () => { _wsReceived = true; });

        setTimeout(() => {
            if (!_wsReceived) {
                console.warn('[WS] No metrics received via WebSocket after 5s – starting HTTP polling fallback');
                startMetricsPolling();
            }
        }, 5000);
    }

    let _pollingInterval = null;
    function startMetricsPolling() {
        if (_pollingInterval) return; // already polling
        _pollingInterval = setInterval(async () => {
            try {
                const [sysRes, srvRes] = await Promise.all([
                    api('/system/metrics'),
                    api('/server/status'),
                ]);
                if (sysRes.ok && srvRes.ok) {
                    updateSystemMetrics({
                        system: sysRes.data,
                        server: srvRes.data.status || {},
                        llama: {},
                        health: srvRes.data.health || {},
                    });
                }
            } catch (_) { /* ignore */ }
        }, 3000);
    }

    // ======================================================================
    // Debug Panel
    // ======================================================================

    function toggleDebugMode() {
        state.debugMode = !state.debugMode;
        localStorage.setItem('debugMode', state.debugMode);
        const panel = $('#debugPanel');
        if (panel) panel.style.display = state.debugMode ? 'block' : 'none';
        toast(state.debugMode ? 'Debug mode enabled – check browser console & debug panel' : 'Debug mode disabled', 'info', 3000);
        if (state.debugMode) fetchDebugDiagnostics();
    }

    async function fetchDebugDiagnostics() {
        const res = await api('/debug');
        if (!res.ok) {
            console.error('[DEBUG] Failed to fetch /api/debug', res);
            return;
        }
        console.log('[DEBUG] Server diagnostics:', res.data);
        const panel = $('#debugContent');
        if (panel) {
            panel.textContent = JSON.stringify(res.data, null, 2);
        }
    }

    function updateDebugPanel(data) {
        if (!state.debugMode) return;
        const el = $('#debugLive');
        if (!el) return;
        const sys = data.system || {};
        el.textContent =
            `Updates: ${state.metricsReceived} | ` +
            `CPU: ${(sys.cpu || {}).percent ?? 'N/A'}% | ` +
            `MEM: ${(sys.memory || {}).percent ?? 'N/A'}% | ` +
            `GPU: ${(sys.gpu || {}).name ?? 'none'} | ` +
            `Server: ${(data.server || {}).running ? 'running' : 'stopped'} | ` +
            `WS: ${state.socket ? (state.socket.connected ? 'connected' : 'disconnected') : 'no socket'}`;
    }

    // ======================================================================
    // Event Bindings
    // ======================================================================

    function initEvents() {
        // Theme
        $('#btnThemeToggle').addEventListener('click', () => {
            setTheme(state.theme === 'dark' ? 'light' : 'dark');
        });

        // Modal
        $('#modalConfirm').addEventListener('click', () => closeModal(true));
        $('#modalCancel').addEventListener('click', () => closeModal(false));
        $('#modalClose').addEventListener('click', () => closeModal(false));
        $('#modalOverlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal(false);
        });

        // Model select (wheel-select is initialised in refreshModels)
        $('#btnRefreshModels').addEventListener('click', refreshModels);

        // Header server toggle (Start/Stop single button)
        $('#btnToggleServer').addEventListener('click', () => {
            if (state.serverRunning) {
                stopServer();
            } else {
                startServer();
            }
        });

        // Header restart button
        $('#btnHeaderRestart').addEventListener('click', restartServer);

        // Debug toggle
        $('#btnDebugToggle').addEventListener('click', toggleDebugMode);

        // Copy command
        $('#btnCopyCommand').addEventListener('click', () => {
            const text = $('#commandPreviewText').textContent;
            navigator.clipboard.writeText(text.replace(/\\\n\s+/g, ' ')).then(() => {
                toast('Command copied to clipboard', 'success', 2000);
            });
        });

        // Parameters
        $$('.param-cat-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                $$('.param-cat-btn').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                filterParams(btn.dataset.cat);
            });
        });

        $('#btnResetParams').addEventListener('click', async () => {
            const confirmed = await showModal(
                'Reset Parameters',
                'Reset all parameters to their default values?',
                'Reset'
            );
            if (!confirmed) return;

            const info = state.paramInfo;
            const defaults = {};
            Object.entries(info).forEach(([key, pi]) => {
                defaults[key] = pi.default;
            });
            state.params = defaults;
            // Also reset enabled state so flash_attn goes back to off-by-default
            state.paramEnabled = {};
            buildParamsUI();
            updateCommandPreview();
            toast('Parameters reset to defaults', 'success');
        });

        $('#btnApplyParams').addEventListener('click', async () => {
            if (!state.serverRunning) {
                // Server is stopped – act as a Start button
                startServer();
                return;
            }
            const confirmed = await showModal(
                'Apply & Restart',
                'This will restart the server with the current parameters. Continue?',
                'Apply & Restart'
            );
            if (!confirmed) return;
            restartServer();
        });

        // Chat
        $('#btnSendChat').addEventListener('click', sendChatMessage);
        $('#chatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });

        // Auto-resize textarea
        $('#chatInput').addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 150) + 'px';
        });

        $('#btnClearChat').addEventListener('click', clearChat);

        // Logs
        $('#logAutoScroll').addEventListener('change', (e) => {
            state.logAutoScroll = e.target.checked;
        });
        $('#btnClearLogs').addEventListener('click', () => {
            $('#logContent').textContent = '';
        });
        $('#btnRefreshLogs').addEventListener('click', refreshLogs);

        // Service actions - llama-server
        $('#btnSvcLlamaInstall').addEventListener('click', installService);
        $('#btnSvcLlamaRemove').addEventListener('click', () => removeService('llama-server'));
        $('#btnSvcLlamaEnable').addEventListener('click', () => serviceAction('llama-server', 'enable'));
        $('#btnSvcLlamaDisable').addEventListener('click', () => serviceAction('llama-server', 'disable'));
        $('#btnSvcLlamaStart').addEventListener('click', () => serviceAction('llama-server', 'start'));
        $('#btnSvcLlamaStop').addEventListener('click', () => serviceAction('llama-server', 'stop'));
        $('#btnSvcLlamaRestart').addEventListener('click', () => serviceAction('llama-server', 'restart'));
        // Service actions - llama-manager
        $('#btnSvcManagerInstall').addEventListener('click', installManagerService);
        $('#btnSvcManagerRemove').addEventListener('click', () => removeService('llama-manager'));
        $('#btnSvcManagerEnable').addEventListener('click', () => serviceAction('llama-manager', 'enable'));
        $('#btnSvcManagerDisable').addEventListener('click', () => serviceAction('llama-manager', 'disable'));
    }

    // ======================================================================
    // Initialization
    // ======================================================================

    async function init() {
        console.log('LlamaServer Manager initializing...');

        // Set theme
        setTheme(state.theme);

        // Init tabs
        initTabs();

        // Load config
        const cfgRes = await api('/config');
        if (cfgRes.ok) {
            state.config = cfgRes.data;
            state.params = { ...(cfgRes.data.default_params || {}) };
        } else {
            console.error('[INIT] Failed to load config:', cfgRes.data);
        }

        // Load param info & build UI
        await loadParamInfo();
        buildParamsUI();

        // Load models
        await refreshModels();

        // Init events
        initEvents();

        // Load initial status & populate dashboard immediately via REST
        try {
            const [statusRes, sysRes] = await Promise.all([
                api('/server/status'),
                api('/system/metrics'),
            ]);
            if (statusRes.ok) {
                const s = statusRes.data.status || {};
                state.serverRunning = s.running || false;
                if (s.running && s.params) {
                    state.params = { ...state.params, ...s.params };
                    buildParamsUI();
                }
            }
            // Populate dashboard immediately so it's not blank
            if (sysRes.ok || statusRes.ok) {
                updateSystemMetrics({
                    system: sysRes.ok ? sysRes.data : {},
                    server: statusRes.ok ? (statusRes.data.status || {}) : {},
                    llama: {},
                    health: statusRes.ok ? (statusRes.data.health || {}) : {},
                });
                console.log('[INIT] Dashboard populated via REST API');
            }
        } catch (err) {
            console.error('[INIT] Failed to load initial status:', err);
        }

        // Update command preview
        updateCommandPreview();

        // Load service status
        refreshServiceStatus();

        // Load logs
        refreshLogs();

        // Init WebSocket
        initSocket();

        // Show debug panel if debug mode was previously enabled
        if (state.debugMode) {
            const panel = $('#debugPanel');
            if (panel) panel.style.display = 'block';
            fetchDebugDiagnostics();
        }

        console.log('LlamaServer Manager ready!');
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();