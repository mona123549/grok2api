(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const promptInput = document.getElementById('promptInput');

  const ratioSelect = document.getElementById('ratioSelect');
  const concurrentSelect = document.getElementById('concurrentSelect');
  const nsfwSelect = document.getElementById('nsfwSelect');

  const maxImagesInput = document.getElementById('maxImagesInput');
  const stopStrategySelect = document.getElementById('stopStrategySelect');
  const softStopTimeoutInput = document.getElementById('softStopTimeoutInput');
  const softStopGraceInput = document.getElementById('softStopGraceInput');

  // T6 toggles (common switches)
  const autoFollowToggle = document.getElementById('autoFollowToggle');
  const reverseInsertToggle = document.getElementById('reverseInsertToggle');
  const autoFilterToggle = document.getElementById('autoFilterToggle');
  const autoSaveToggle = document.getElementById('autoSaveToggle');
  const selectSaveFolderBtn = document.getElementById('selectSaveFolderBtn');
  const saveFolderPath = document.getElementById('saveFolderPath');
  const saveFolderHint = document.getElementById('saveFolderHint');

  // T10 batch download
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const libraryBtn = document.getElementById('libraryBtn');
  const selectionToolbar = document.getElementById('selectionToolbar');
  const toggleSelectAllBtn = document.getElementById('toggleSelectAllBtn');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const exitSelectionModeBtn = document.getElementById('exitSelectionModeBtn');

  const statusText = document.getElementById('statusText');
  const countValue = document.getElementById('countValue');
  const activeValue = document.getElementById('activeValue');

  const waterfall = document.getElementById('waterfall');
  const emptyState = document.getElementById('emptyState');

  const modeButtons = document.querySelectorAll('.mode-btn');

  const advancedToggle = document.getElementById('advancedToggle');
  const advancedPanel = document.getElementById('advancedPanel');
  const advancedPopoverRoot = document.getElementById('advancedPopover');

  let wsConnections = [];
  let sseConnections = [];
  let imageCount = 0; // displayed item count (includes partial)

  // T10 selection mode (batch download)
  let isSelectionMode = false;
  let selectedImages = new Set(); // Set<HTMLElement>

  let lastRunId = '';
  let isRunning = false;
  let connectionMode = 'ws';
  let modePreference = 'auto';

  // Backward compatible key (older versions stored mode only)
  const MODE_STORAGE_KEY = 'media_mode';

  // Unified settings storage (v1)
  const SETTINGS_STORAGE_KEY = 'media_settings_v1';

  // T6: keep recent waterfall items in sessionStorage so "Back" doesn't lose images
  const WATERFALL_SESSION_KEY = 'media_waterfall_session_v1';
  const WATERFALL_SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6h

  const DEFAULT_SETTINGS = {
    v: 1,
    ratio: '2:3',
    concurrent: 1,
    nsfw: true,
    mode_preference: 'auto',
    max_images_per_run: 6,
    stop_strategy: 'soft_timeout', // immediate | soft | soft_timeout
    soft_stop_timeout_sec: 12,
    soft_stop_grace_ms: 800,

    // T6 common switches
    auto_follow: false,
    reverse_insert: false,
    auto_filter: false,
    auto_save: false,
    auto_save_use_fs: false,
    // Display label only (FS handle cannot be persisted); when not selected, fallback to browser download.
    auto_save_folder_label: '未选择（将使用浏览器下载）',
  };

  let mediaSettings = { ...DEFAULT_SETTINGS };
  let settingsLoadedFromStorage = false;
  let nsfwLoadedFromStorage = false;

  // Run control (per "Start" click)
  let runNonce = 0;
  let runFinalCount = 0;
  let runTargetFinal = 6;
  let desiredConcurrent = 1;
  let inFlightTasks = 0;
  let stopRequested = false; // soft stop requested (do not create new tasks)
  let softStopForceTimer = null;
  let softStopGraceTimer = null;
  let launchInProgress = false;

  const taskStateById = new Map(); // taskId -> { done:boolean, failed:boolean }

  let pendingFallbackTimer = null;
  let currentTaskIds = [];
  let streamSequence = 0;
  const streamImageMap = new Map();

  // T6 session persistence (throttled)
  let persistWaterfallTimer = null;

  // Stream activity tracking (for soft-stop idle wait)
  let lastStreamEventAt = 0;
  let softStopIdleTimer = null;
  const SOFT_STOP_IDLE_MS = 2500;

  let finalMinBytesDefault = 100000;

  // Auto-save (File System Access API)
  let directoryHandle = null;
  let useFileSystemAPI = false;

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function clampInt(value, min, max, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    if (typeof min === 'number' && n < min) return min;
    if (typeof max === 'number' && n > max) return max;
    return n;
  }

  function safeParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function hashStringToHex(text) {
    // Deterministic small hash for stable ids (not for security)
    const str = String(text || '');
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(16);
  }

  function loadMediaSettings() {
    const merged = { ...DEFAULT_SETTINGS };
    settingsLoadedFromStorage = false;
    nsfwLoadedFromStorage = false;

    // 1) new key
    const raw = (() => {
      try {
        return localStorage.getItem(SETTINGS_STORAGE_KEY);
      } catch (e) {
        return null;
      }
    })();

    if (raw) {
      settingsLoadedFromStorage = true;
      const parsed = safeParseJson(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.ratio === 'string') merged.ratio = parsed.ratio;
        if (Number.isFinite(parsed.concurrent)) merged.concurrent = clampInt(parsed.concurrent, 1, 99, 1);
        if (typeof parsed.nsfw === 'boolean') {
          merged.nsfw = parsed.nsfw;
          nsfwLoadedFromStorage = true;
        }
        if (typeof parsed.mode_preference === 'string') merged.mode_preference = parsed.mode_preference;

        if (Number.isFinite(parsed.max_images_per_run)) merged.max_images_per_run = clampInt(parsed.max_images_per_run, 1, 99, 6);
        if (typeof parsed.stop_strategy === 'string') merged.stop_strategy = parsed.stop_strategy;
        if (Number.isFinite(parsed.soft_stop_timeout_sec)) merged.soft_stop_timeout_sec = clampInt(parsed.soft_stop_timeout_sec, 1, 120, 12);
        if (Number.isFinite(parsed.soft_stop_grace_ms)) merged.soft_stop_grace_ms = clampInt(parsed.soft_stop_grace_ms, 0, 10000, 800);

        // T6 switches
        if (typeof parsed.auto_follow === 'boolean') merged.auto_follow = parsed.auto_follow;
        if (typeof parsed.reverse_insert === 'boolean') merged.reverse_insert = parsed.reverse_insert;
        if (typeof parsed.auto_filter === 'boolean') merged.auto_filter = parsed.auto_filter;
        if (typeof parsed.auto_save === 'boolean') merged.auto_save = parsed.auto_save;
        if (typeof parsed.auto_save_use_fs === 'boolean') merged.auto_save_use_fs = parsed.auto_save_use_fs;
        if (typeof parsed.auto_save_folder_label === 'string') merged.auto_save_folder_label = parsed.auto_save_folder_label;
      }
    }

    // 2) old key (mode only) as fallback
    if (!raw) {
      const legacyMode = (() => {
        try {
          return localStorage.getItem(MODE_STORAGE_KEY);
        } catch (e) {
          return null;
        }
      })();
      if (legacyMode && ['auto', 'ws', 'sse'].includes(legacyMode)) {
        merged.mode_preference = legacyMode;
      }
    }

    // normalize values
    if (!['auto', 'ws', 'sse'].includes(merged.mode_preference)) merged.mode_preference = 'auto';
    if (!['immediate', 'soft', 'soft_timeout'].includes(merged.stop_strategy)) merged.stop_strategy = 'soft_timeout';

    return merged;
  }

  function persistMediaSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(mediaSettings));
    } catch (e) {
      // ignore
    }
  }

  function applyMediaSettingsToControls() {
    if (ratioSelect && mediaSettings.ratio) {
      ratioSelect.value = mediaSettings.ratio;
    }
    if (concurrentSelect && Number.isFinite(mediaSettings.concurrent)) {
      const value = String(mediaSettings.concurrent);
      if ([...concurrentSelect.options].some(opt => opt.value === value)) {
        concurrentSelect.value = value;
      }
    }
    if (nsfwSelect && typeof mediaSettings.nsfw === 'boolean') {
      nsfwSelect.value = mediaSettings.nsfw ? 'true' : 'false';
    }

    if (maxImagesInput) {
      maxImagesInput.value = String(clampInt(mediaSettings.max_images_per_run, 1, 99, 6));
    }
    if (stopStrategySelect && typeof mediaSettings.stop_strategy === 'string') {
      stopStrategySelect.value = mediaSettings.stop_strategy;
    }
    if (softStopTimeoutInput) {
      softStopTimeoutInput.value = String(clampInt(mediaSettings.soft_stop_timeout_sec, 1, 120, 12));
    }
    if (softStopGraceInput) {
      softStopGraceInput.value = String(clampInt(mediaSettings.soft_stop_grace_ms, 0, 10000, 800));
    }

    // T6 switches
    if (autoFollowToggle) autoFollowToggle.checked = Boolean(mediaSettings.auto_follow);
    if (reverseInsertToggle) reverseInsertToggle.checked = Boolean(mediaSettings.reverse_insert);
    if (autoFilterToggle) autoFilterToggle.checked = Boolean(mediaSettings.auto_filter);
    if (autoSaveToggle) autoSaveToggle.checked = Boolean(mediaSettings.auto_save);

    // Refresh auto-save folder UI (avoid misleading "default browser location" wording)
    updateAutoSaveUiState();
  }

  function refreshMediaSettingsFromControls() {
    if (ratioSelect) {
      mediaSettings.ratio = ratioSelect.value || DEFAULT_SETTINGS.ratio;
    }
    if (concurrentSelect) {
      mediaSettings.concurrent = clampInt(concurrentSelect.value, 1, 99, DEFAULT_SETTINGS.concurrent);
    }
    if (nsfwSelect) {
      mediaSettings.nsfw = nsfwSelect.value === 'true';
    }

    if (maxImagesInput) {
      mediaSettings.max_images_per_run = clampInt(maxImagesInput.value, 1, 99, DEFAULT_SETTINGS.max_images_per_run);
    }
    if (stopStrategySelect) {
      const v = stopStrategySelect.value;
      mediaSettings.stop_strategy = ['immediate', 'soft', 'soft_timeout'].includes(v) ? v : DEFAULT_SETTINGS.stop_strategy;
    }
    if (softStopTimeoutInput) {
      mediaSettings.soft_stop_timeout_sec = clampInt(softStopTimeoutInput.value, 1, 120, DEFAULT_SETTINGS.soft_stop_timeout_sec);
    }
    if (softStopGraceInput) {
      mediaSettings.soft_stop_grace_ms = clampInt(softStopGraceInput.value, 0, 10000, DEFAULT_SETTINGS.soft_stop_grace_ms);
    }

    // T6 switches
    if (autoFollowToggle) mediaSettings.auto_follow = Boolean(autoFollowToggle.checked);
    if (reverseInsertToggle) mediaSettings.reverse_insert = Boolean(reverseInsertToggle.checked);
    if (autoFilterToggle) mediaSettings.auto_filter = Boolean(autoFilterToggle.checked);
    if (autoSaveToggle) mediaSettings.auto_save = Boolean(autoSaveToggle.checked);

    // Auto-save folder state is derived from runtime capability + current (non-persistable) handle.
    if (!mediaSettings.auto_save) {
      mediaSettings.auto_save_use_fs = false;
      mediaSettings.auto_save_folder_label = '未启用';
    } else if (useFileSystemAPI && directoryHandle) {
      mediaSettings.auto_save_use_fs = true;
      mediaSettings.auto_save_folder_label = String(directoryHandle && directoryHandle.name ? directoryHandle.name : '已选择目录');
    } else {
      mediaSettings.auto_save_use_fs = false;
      mediaSettings.auto_save_folder_label = DEFAULT_SETTINGS.auto_save_folder_label;
    }
  }

  function setStatus(state, text) {
    if (!statusText) return;
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(connected) {
    if (!startBtn || !stopBtn) return;
    if (connected) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      startBtn.disabled = false;
    }
  }

  const STOP_BTN_DEFAULT_TEXT = stopBtn ? (String(stopBtn.textContent || '').trim() || '停止') : '停止';

  function setStopButtonStopping(stopping, label) {
    if (!stopBtn) return;
    const isStopping = Boolean(stopping);
    stopBtn.disabled = isStopping;
    stopBtn.textContent = isStopping ? (String(label || '').trim() || '停止中...') : STOP_BTN_DEFAULT_TEXT;
  }

  function updateCount(value) {
    if (!countValue) return;
    countValue.textContent = String(value);
  }

  function clearSoftStopTimers() {
    if (softStopForceTimer) {
      clearTimeout(softStopForceTimer);
      softStopForceTimer = null;
    }
    if (softStopGraceTimer) {
      clearTimeout(softStopGraceTimer);
      softStopGraceTimer = null;
    }
    if (softStopIdleTimer) {
      clearTimeout(softStopIdleTimer);
      softStopIdleTimer = null;
    }
  }

  function touchStreamActivity() {
    lastStreamEventAt = Date.now();
  }

  function scheduleSoftStopIdleClose() {
    if (!stopRequested) return;

    setStatus('connecting', '软停止：等待输出完成');

    // Poll until the stream has been idle for a while, so partial cards have time to turn final.
    const tick = () => {
      if (!stopRequested) return;

      const now = Date.now();
      const sinceLast = lastStreamEventAt > 0 ? (now - lastStreamEventAt) : Number.POSITIVE_INFINITY;

      if (sinceLast >= SOFT_STOP_IDLE_MS) {
        toast('软停止结束：已空闲，已关闭连接', 'info');
        finalizeStopUi();
        return;
      }

      softStopIdleTimer = setTimeout(tick, 250);
    };

    if (softStopIdleTimer) {
      clearTimeout(softStopIdleTimer);
      softStopIdleTimer = null;
    }
    softStopIdleTimer = setTimeout(tick, 250);
  }

  function clearNonFinalItems() {
    if (!waterfall) return;
    const items = waterfall.querySelectorAll('.media-item');
    items.forEach((item) => {
      const isFinal = String(item.dataset.isFinal || '0') === '1';
      if (isFinal) return;
      item.remove();
      const imageId = String(item.dataset.imageId || '').trim();
      if (imageId && streamImageMap.get(imageId) === item) {
        streamImageMap.delete(imageId);
      }
      if (imageCount > 0) {
        imageCount -= 1;
      }
    });
  }

  function resetRunStateForNewRun() {
    runFinalCount = 0;
    updateCount(0);
    inFlightTasks = 0;
    stopRequested = false;
    taskStateById.clear();
    currentTaskIds = [];
    clearSoftStopTimers();
    launchInProgress = false;
  }

  function markTaskDone(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return false;
    const prev = taskStateById.get(id);
    if (prev && prev.done) return false;
    taskStateById.set(id, { done: true, failed: false });
    if (inFlightTasks > 0) inFlightTasks -= 1;
    return true;
  }

  function markTaskFailed(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return false;
    const prev = taskStateById.get(id);
    if (prev && prev.done) return false;
    taskStateById.set(id, { done: true, failed: true });
    if (inFlightTasks > 0) inFlightTasks -= 1;
    return true;
  }

  function shouldLaunchMoreTasks() {
    if (!isRunning) return false;
    if (stopRequested) return false;
    if (inFlightTasks >= desiredConcurrent) return false;
    // avoid overshoot: final + in-flight must be < target
    if ((runFinalCount + inFlightTasks) >= runTargetFinal) return false;
    return true;
  }

  function finalizeStopUi() {
    clearSoftStopTimers();
    stopAllConnections();
    isRunning = false;
    updateActive();
    setButtons(false);
    setStopButtonStopping(false);
    setStatus('', '未连接');
  }

  async function forceStopNow({ reason, clearPartials }) {
    clearSoftStopTimers();
    stopRequested = true;

    const authHeader = await ensurePublicKey();
    if (authHeader !== null && currentTaskIds.length > 0) {
      await stopImagineTasks(currentTaskIds, authHeader);
    }

    stopAllConnections();
    taskStateById.clear();
    currentTaskIds = [];
    inFlightTasks = 0;

    isRunning = false;
    updateActive();
    setButtons(false);
    setStopButtonStopping(false);
    setStatus('', '未连接');

    if (clearPartials) {
      clearNonFinalItems();
    }

    if (reason === 'max_reached') {
      toast(`已达到本轮上限：${runTargetFinal} 张`, 'success');
    }
  }

  async function requestSoftStop({ reason, withTimeout }) {
    clearSoftStopTimers();
    stopRequested = true;

    // Keep streaming for a while so partial cards can turn final; close only after idle or timeout.
    touchStreamActivity();
    setStatus('connecting', reason === 'max_reached' ? '达到上限，软停止等待中' : '软停止等待中');

    const graceMs = clampInt(mediaSettings.soft_stop_grace_ms, 0, 10000, 800);
    softStopGraceTimer = setTimeout(() => {
      softStopGraceTimer = null;
      scheduleSoftStopIdleClose();
    }, graceMs);

    if (withTimeout) {
      const sec = clampInt(mediaSettings.soft_stop_timeout_sec, 1, 120, 12);
      softStopForceTimer = setTimeout(() => {
        softStopForceTimer = null;
        setStatus('error', '软停超时，强制停止');
        toast('软停超时：已强制停止并清理未完成图片', 'warning');
        forceStopNow({ reason: reason || 'soft_timeout', clearPartials: true });
      }, sec * 1000);
    }
  }

  async function launchOneTask(authHeader, rawPublicKey) {
    const prompt = promptInput ? promptInput.value.trim() : '';
    const ratio = ratioSelect ? ratioSelect.value : '2:3';
    const nsfwEnabled = nsfwSelect ? nsfwSelect.value === 'true' : true;

    const taskId = await createImagineTask(prompt, ratio, authHeader, nsfwEnabled);
    if (!taskId) {
      throw new Error('Missing task id');
    }

    currentTaskIds.push(taskId);
    taskStateById.set(taskId, { done: false, failed: false });
    inFlightTasks += 1;

    if (connectionMode === 'sse') {
      const url = buildSseUrl(taskId, sseConnections.length, rawPublicKey);
      const es = new EventSource(url);

      es.onopen = () => updateActive();
      es.onmessage = (event) => handleMessage(event.data, { runNonce, taskId });
      es.onerror = () => {
        updateActive();
        const progressed = markTaskFailed(taskId);
        if (progressed) ensureDesiredTasks();
      };

      sseConnections.push(es);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ task_id: taskId });
    if (rawPublicKey) {
      params.set('public_key', rawPublicKey);
    }
    const wsUrl = `${protocol}://${window.location.host}/v1/public/imagine/ws?${params.toString()}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      updateActive();
      sendStart(prompt, ws);
    };

    ws.onmessage = (event) => {
      handleMessage(event.data, { runNonce, taskId });
    };

    ws.onclose = () => {
      updateActive();
      const state = taskStateById.get(taskId);
      if (!state || !state.done) {
        const progressed = markTaskFailed(taskId);
        if (progressed) ensureDesiredTasks();
      } else if (stopRequested && inFlightTasks <= 0) {
        scheduleSoftStopIdleClose();
      }
    };

    ws.onerror = () => {
      updateActive();
    };

    wsConnections.push(ws);
  }

  async function ensureDesiredTasks() {
    if (launchInProgress) return;
    if (!shouldLaunchMoreTasks()) {
      if (stopRequested && inFlightTasks <= 0) {
        scheduleSoftStopIdleClose();
      }
      return;
    }

    launchInProgress = true;
    try {
      const authHeader = await ensurePublicKey();
      if (authHeader === null) {
        await forceStopNow({ reason: 'missing_key', clearPartials: false });
        return;
      }
      const rawPublicKey = normalizeAuthHeader(authHeader);

      while (shouldLaunchMoreTasks()) {
        await launchOneTask(authHeader, rawPublicKey);
      }
    } catch (e) {
      setStatus('error', '创建任务失败');
      isRunning = false;
      setButtons(false);
      if (startBtn) startBtn.disabled = false;
    } finally {
      launchInProgress = false;
    }
  }

  function updateActive() {
    if (!activeValue) return;
    if (connectionMode === 'sse') {
      const active = sseConnections.filter(es => es && es.readyState === EventSource.OPEN).length;
      activeValue.textContent = String(active);
      return;
    }
    const active = wsConnections.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;
    activeValue.textContent = String(active);
  }

  function setModePreference(mode, persist = true) {
    if (!['auto', 'ws', 'sse'].includes(mode)) return;
    modePreference = mode;
    modeButtons.forEach(btn => {
      const active = btn.dataset.mode === mode;
      if (active) {
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-pressed', 'false');
      }
    });
    if (persist) {
      mediaSettings.mode_preference = mode;
      persistMediaSettings();
      try {
        localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch (e) {
        // ignore
      }
    }
  }

  function isLikelyBase64(raw) {
    if (!raw) return false;
    if (raw.startsWith('data:')) return true;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return false;
    const head = raw.slice(0, 16);
    if (head.startsWith('/9j/') || head.startsWith('iVBOR') || head.startsWith('R0lGOD')) return true;
    return /^[A-Za-z0-9+/=\s]+$/.test(raw);
  }

  function inferMime(base64) {
    if (!base64) return 'image/jpeg';
    if (base64.startsWith('iVBOR')) return 'image/png';
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    return 'image/jpeg';
  }

  function estimateBase64Bytes(raw) {
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return null;
    }
    if (raw.startsWith('/') && !isLikelyBase64(raw)) {
      return null;
    }
    let base64 = raw;
    if (raw.startsWith('data:')) {
      const comma = raw.indexOf(',');
      base64 = comma >= 0 ? raw.slice(comma + 1) : '';
    }
    base64 = base64.replace(/\s/g, '');
    if (!base64) return 0;
    let padding = 0;
    if (base64.endsWith('==')) padding = 2;
    else if (base64.endsWith('=')) padding = 1;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  }

  function getFinalMinBytes() {
    return Number.isFinite(finalMinBytesDefault) && finalMinBytesDefault >= 0 ? finalMinBytesDefault : 100000;
  }

  function toDisplayImageUrl(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.startsWith('data:')) return text;
    if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('/')) {
      return text;
    }
    if (isLikelyBase64(text)) {
      return `data:${inferMime(text)};base64,${text}`;
    }
    return text;
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  async function loadFilterDefaults() {
    try {
      const res = await fetch('/v1/public/imagine/config', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const value = parseInt(data && data.final_min_bytes, 10);
      if (Number.isFinite(value) && value >= 0) {
        finalMinBytesDefault = value;
      }
      // Only apply server defaults when user didn't persist a preference yet
      if (nsfwSelect && typeof data.nsfw === 'boolean' && !nsfwLoadedFromStorage) {
        nsfwSelect.value = data.nsfw ? 'true' : 'false';
        mediaSettings.nsfw = Boolean(data.nsfw);
        persistMediaSettings();
      }
    } catch (e) {
      // ignore
    }
  }

  async function createImagineTask(prompt, ratio, authHeader, nsfwEnabled) {
    const res = await fetch('/v1/public/imagine/start', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, aspect_ratio: ratio, nsfw: nsfwEnabled })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to create task');
    }
    const data = await res.json();
    return data && data.task_id ? String(data.task_id) : '';
  }

  async function createImagineTasks(prompt, ratio, concurrent, authHeader, nsfwEnabled) {
    const tasks = [];
    for (let i = 0; i < concurrent; i++) {
      const taskId = await createImagineTask(prompt, ratio, authHeader, nsfwEnabled);
      if (!taskId) throw new Error('Missing task id');
      tasks.push(taskId);
    }
    return tasks;
  }

  async function stopImagineTasks(taskIds, authHeader) {
    if (!taskIds || taskIds.length === 0) return;
    try {
      await fetch('/v1/public/imagine/stop', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(authHeader),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task_ids: taskIds })
      });
    } catch (e) {
      // ignore
    }
  }

  function stopAllConnections() {
    wsConnections.forEach(ws => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'stop' }));
        } catch (e) {
          // ignore
        }
      }
      try {
        ws.close(1000, 'client stop');
      } catch (e) {
        // ignore
      }
    });
    wsConnections = [];

    sseConnections.forEach(es => {
      try {
        es.close();
      } catch (e) {
        // ignore
      }
    });
    sseConnections = [];
    updateActive();
  }

  function buildSseUrl(taskId, index, rawPublicKey) {
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = `${httpProtocol}://${window.location.host}/v1/public/imagine/sse`;
    const params = new URLSearchParams();
    params.set('task_id', taskId);
    params.set('t', String(Date.now()));
    if (typeof index === 'number') {
      params.set('conn', String(index));
    }
    if (rawPublicKey) {
      params.set('public_key', rawPublicKey);
    }
    return `${base}?${params.toString()}`;
  }

  function ensureWaterfallExists() {
    if (!waterfall) {
      throw new Error('waterfall_not_found');
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename || 'media.png';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function downloadByUrl(url, filename) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('download_failed');
    const blob = await res.blob();
    downloadBlob(blob, filename);
  }

  function downloadDataUrl(dataUrl, filename) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename || 'media.png';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl || '').split(',');
    if (parts.length < 2) return null;
    const header = parts[0];
    const b64 = parts.slice(1).join(',');
    const match = header.match(/data:(.*?);base64/i);
    const mime = match ? match[1] : 'application/octet-stream';
    try {
      const byteString = atob(b64);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      return new Blob([ab], { type: mime });
    } catch (e) {
      return null;
    }
  }

  function inferExtFromUrl(url) {
    const text = String(url || '').toLowerCase();
    if (text.startsWith('data:image/png')) return 'png';
    if (text.startsWith('data:image/webp')) return 'webp';
    if (text.startsWith('data:image/jpeg')) return 'jpg';
    if (text.startsWith('data:image/jpg')) return 'jpg';
    if (text.endsWith('.png')) return 'png';
    if (text.endsWith('.webp')) return 'webp';
    if (text.endsWith('.jpg') || text.endsWith('.jpeg')) return 'jpg';
    return 'jpg';
  }

  async function getBlobFromUrl(url) {
    const u = String(url || '').trim();
    if (!u) throw new Error('empty_url');
    const res = await fetch(u, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch_failed');
    return await res.blob();
  }

  async function saveBlobToFileSystem(blob, filename) {
    if (!directoryHandle) return false;
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }

  async function autoSaveImageUrl(url, filename) {
    const clean = String(url || '').trim();
    if (!clean) return;

    // Prefer FS API when enabled+selected
    if (useFileSystemAPI && directoryHandle) {
      const blob = await getBlobFromUrl(clean);
      await saveBlobToFileSystem(blob, filename);
      return;
    }

    // Fallback: browser download
    if (clean.startsWith('data:')) {
      downloadDataUrl(clean, filename);
      return;
    }
    await downloadByUrl(clean, filename);
  }

  function buildFilename(meta, sequence, extFallback) {
    const ts = Date.now();
    const seq = meta && meta.sequence ? meta.sequence : sequence;
    const ext = extFallback || 'jpg';
    return `media_${ts}_${seq}.${ext}`;
  }

  function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('/')) return `${window.location.origin}${raw}`;
    return '';
  }

  function pickSourceImageUrl(meta, fallbackUrl) {
    const candidates = [
      meta && (meta.current_source_image_url || meta.source_image_url || meta.sourceImageUrl),
      meta && (meta.sourceImage || meta.source_image),
      fallbackUrl,
    ];
    for (const it of candidates) {
      const u = normalizeHttpUrl(it);
      if (u) return u;
    }
    return '';
  }

  // --- Media library (favorite) ---
  let favoriteIndexLoaded = false;
  const favoriteByParentPostId = new Map(); // parent_post_id -> library item id

  function isSafeMediaLibraryImageUrl(url) {
    const u = String(url || '').trim();
    if (!u) return false;
    if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('/')) return true;
    // Allow small data: URLs only to avoid bloating requests/storage
    if (u.startsWith('data:') && u.length <= 1800) return true;
    return false;
  }

  function buildStableLibraryIdForImage({ parentPostId, imageUrl }) {
    const pid = String(parentPostId || '').trim();
    if (pid) return `img_${pid}`;
    const u = String(imageUrl || '').trim();
    if (u) return `imgu_${hashStringToHex(u)}`;
    return '';
  }

  function buildHeartSvg({ filled }) {
    const isFilled = Boolean(filled);
    const fill = isFilled ? 'currentColor' : 'none';
    const stroke = 'currentColor';
    return `
      <svg class="media-fav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
          fill="${fill}"
          stroke="${stroke}"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
    `.trim();
  }

  function buildPlaySvg() {
    return `
      <svg class="media-play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M9 7l10 5-10 5V7z" fill="currentColor"></path>
      </svg>
    `.trim();
  }

  function buildDownloadSvg() {
    return `
      <svg class="media-download-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <path d="M8.5 10.5L12 13.9l3.5-3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5 15v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `.trim();
  }

  function setFavUi(btn, on) {
    if (!btn) return;
    const isOn = Boolean(on);
    btn.classList.toggle('is-on', isOn);
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    btn.setAttribute('aria-label', isOn ? '取消收藏（仍保留记录）' : '收藏入库');
    btn.title = isOn ? '取消收藏（仍保留记录）' : '收藏入库';
    btn.innerHTML = buildHeartSvg({ filled: isOn });
  }

  function refreshFavoriteUiForExistingWaterfallItems() {
    if (!waterfall) return;
    const items = Array.from(waterfall.querySelectorAll('.media-item'));
    for (const item of items) {
      if (!item || !item.dataset) continue;
      const pid = String(item.dataset.imageId || '').trim();
      if (!pid) continue;

      const libId = String(favoriteByParentPostId.get(pid) || '').trim();
      if (!libId) continue;

      // Mark dataset and update button UI
      item.dataset.favorite = '1';
      item.dataset.libraryId = libId;

      const favBtn = item.querySelector('.media-fav-btn');
      if (favBtn) {
        setFavUi(favBtn, true);
      }
    }
  }

  async function preloadFavoriteIndex() {
    if (favoriteIndexLoaded) return;
    favoriteIndexLoaded = true;

    try {
      const authHeader = await ensurePublicKey();
      if (authHeader === null) return;

      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('page_size', '200');
      params.set('media_type', 'image');
      params.set('favorite_only', 'true');

      const res = await fetch(`/v1/public/media_library/list?${params.toString()}`, {
        method: 'GET',
        headers: {
          ...buildAuthHeaders(authHeader),
        },
      });
      if (!res.ok) return;

      const data = await res.json();
      const items = Array.isArray(data && data.items) ? data.items : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const pid = String(it.parent_post_id || '').trim();
        const id = String(it.id || '').trim();
        if (pid && id) {
          favoriteByParentPostId.set(pid, id);
        }
      }

      // After index is loaded, refresh already-rendered cards (fix late-highlight issue).
      refreshFavoriteUiForExistingWaterfallItems();
    } catch (e) {
      // ignore
    }
  }

  async function favoriteImageItem({ parentPostId, prompt, sourceImageUrl, imageUrl, extra, id }) {
    const authHeader = await ensurePublicKey();
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      window.location.href = '/login';
      return null;
    }

    const payload = {
      id: String(id || '').trim() || undefined,
      media_type: 'image',
      prompt: String(prompt || '').trim(),
      parent_post_id: String(parentPostId || '').trim(),
      source_image_url: String(sourceImageUrl || '').trim(),
      image_url: isSafeMediaLibraryImageUrl(imageUrl) ? String(imageUrl || '').trim() : '',
      extra: (extra && typeof extra === 'object') ? extra : {},
    };

    const res = await fetch('/v1/public/media_library/favorite', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await res.text() || 'favorite_failed');
    }
    const data = await res.json();
    return data && data.item ? data.item : null;
  }

  async function unfavoriteLibraryItemById(libraryId) {
    const authHeader = await ensurePublicKey();
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      window.location.href = '/login';
      return false;
    }

    const id = String(libraryId || '').trim();
    if (!id) return false;

    const res = await fetch('/v1/public/media_library/unfavorite', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  }

  async function toggleFavoriteForWaterfallItem(item, favBtn) {
    if (!item || !item.dataset) return;

    const parentPostId = String(item.dataset.imageId || '').trim();
    const prompt = String(item.dataset.prompt || '').trim();
    const sourceImageUrl = String(item.dataset.sourceImageUrl || '').trim();
    const imageUrl = String(item.dataset.imageUrl || '').trim();
    const sequence = clampInt(item.dataset.sequence, 1, 999999, 0);

    const currentOn = String(item.dataset.favorite || '0') === '1';
    favBtn.disabled = true;

    try {
      if (!currentOn) {
        const stableId = buildStableLibraryIdForImage({ parentPostId, imageUrl }) || '';
        const resp = await favoriteImageItem({
          parentPostId,
          prompt,
          sourceImageUrl,
          imageUrl,
          id: stableId,
          extra: {
            source: 'media',
            sequence,
          },
        });

        const savedId = String(resp && resp.id ? resp.id : stableId).trim();
        if (parentPostId && savedId) {
          favoriteByParentPostId.set(parentPostId, savedId);
        }

        item.dataset.favorite = '1';
        if (savedId) item.dataset.libraryId = savedId;
        setFavUi(favBtn, true);
        toast('已收藏', 'success');
        return;
      }

      const libraryId =
        String(item.dataset.libraryId || '').trim()
        || (parentPostId ? String(favoriteByParentPostId.get(parentPostId) || '').trim() : '');

      if (!libraryId) {
        toast('缺少 libraryId，无法取消收藏', 'error');
        return;
      }

      const ok = await unfavoriteLibraryItemById(libraryId);
      if (!ok) {
        toast('取消收藏失败', 'error');
        return;
      }

      item.dataset.favorite = '0';
      // Keep dataset.libraryId for possible future re-favorite, but remove from global index to avoid false "on" for new cards.
      if (parentPostId) {
        favoriteByParentPostId.delete(parentPostId);
      }

      setFavUi(favBtn, false);
      toast('已取消收藏', 'info');
    } catch (e) {
      toast('收藏操作失败', 'error');
    } finally {
      favBtn.disabled = false;
    }
  }

  function tryCacheDataUrlForDetail(dataUrl, cacheKey) {
    const key = String(cacheKey || '').trim();
    const value = String(dataUrl || '').trim();
    if (!key || !value) return '';
    try {
      sessionStorage.setItem(key, value);
      return key;
    } catch (e) {
      return '';
    }
  }

  function tryCacheDataUrlForWaterfall(dataUrl, cacheKey) {
    const key = String(cacheKey || '').trim();
    const value = String(dataUrl || '').trim();
    if (!key || !value) return '';
    try {
      sessionStorage.setItem(key, value);
      return key;
    } catch (e) {
      return '';
    }
  }

  function readWaterfallCachedDataUrl(cacheKey) {
    const key = String(cacheKey || '').trim();
    if (!key) return '';
    try {
      return String(sessionStorage.getItem(key) || '');
    } catch (e) {
      return '';
    }
  }

  function clearWaterfallSession() {
    try {
      const raw = sessionStorage.getItem(WATERFALL_SESSION_KEY);
      const data = raw ? safeParseJson(raw) : null;
      if (data && typeof data === 'object' && Array.isArray(data.items)) {
        data.items.forEach((it) => {
          const ck = it && typeof it === 'object' ? String(it.cache_key || '').trim() : '';
          if (ck) {
            try {
              sessionStorage.removeItem(ck);
            } catch (e) {
              // ignore
            }
          }
        });
      }
    } catch (e) {
      // ignore
    }
    try {
      sessionStorage.removeItem(WATERFALL_SESSION_KEY);
    } catch (e) {
      // ignore
    }
  }

  function persistWaterfallSession() {
    if (!waterfall) return;

    const all = Array.from(waterfall.querySelectorAll('.media-item'));
    const maxItems = 120;

    const reverse = Boolean(reverseInsertToggle && reverseInsertToggle.checked);
    const items = reverse ? all.slice(0, maxItems) : all.slice(Math.max(0, all.length - maxItems));

    const payload = {
      v: 1,
      ts: Date.now(),
      scroll_y: Number.isFinite(window.scrollY) ? window.scrollY : 0,
      reverse_insert: reverse,
      items: [],
    };

    for (const el of items) {
      if (!el || !el.dataset) continue;

      const imageId = String(el.dataset.imageId || '').trim();
      const url = String(el.dataset.imageUrl || '').trim();
      const prompt = String(el.dataset.prompt || '').trim();
      const sourceImageUrl = String(el.dataset.sourceImageUrl || '').trim();
      const isFinal = String(el.dataset.isFinal || '0') === '1';
      const sequence = clampInt(el.dataset.sequence, 1, 999999, 0);

      let imageUrl = url;
      let cacheKey = '';

      // Avoid storing huge data URLs in the JSON payload
      if (imageUrl.startsWith('data:') && imageUrl.length > 1800) {
        const keyBase = imageId ? `media_waterfall_cache_${imageId}` : `media_waterfall_cache_seq_${sequence || Date.now()}`;
        const key = `${keyBase}_${Date.now()}`;
        const cached = tryCacheDataUrlForWaterfall(imageUrl, key);
        if (cached) {
          cacheKey = cached;
          imageUrl = '';
        }
      }

      payload.items.push({
        image_id: imageId,
        image_url: imageUrl,
        cache_key: cacheKey,
        prompt,
        source_image_url: sourceImageUrl,
        is_final: isFinal,
        sequence,
        favorite: String(el.dataset.favorite || '0') === '1',
        library_id: String(el.dataset.libraryId || '').trim(),
      });
    }

    try {
      sessionStorage.setItem(WATERFALL_SESSION_KEY, JSON.stringify(payload));
    } catch (e) {
      // ignore
    }
  }

  function schedulePersistWaterfallSession() {
    if (persistWaterfallTimer) {
      clearTimeout(persistWaterfallTimer);
      persistWaterfallTimer = null;
    }
    persistWaterfallTimer = setTimeout(() => {
      persistWaterfallTimer = null;
      persistWaterfallSession();
    }, 250);
  }

  function renderRestoredItem({ imageId, dataUrl, prompt, sourceImageUrl, isFinal, sequence, favorite, libraryId }) {
    ensureWaterfallExists();

    const seq = clampInt(sequence, 1, 999999, 0) || (streamSequence + 1);

    const item = document.createElement('div');
    item.className = 'media-item';
    item.dataset.imageId = String(imageId || '').trim();
    item.dataset.imageUrl = String(dataUrl || '').trim();
    item.dataset.isFinal = Boolean(isFinal) ? '1' : '0';
    item.dataset.sequence = String(seq);

    if (Boolean(favorite)) {
      item.dataset.favorite = '1';
    }
    const lid = String(libraryId || '').trim();
    if (lid) {
      item.dataset.libraryId = lid;
    }

    const checkbox = document.createElement('div');
    checkbox.className = 'media-checkbox';
    checkbox.setAttribute('aria-hidden', 'true');

    const p = String(prompt || '').trim();
    const src = String(sourceImageUrl || '').trim();
    if (p) item.dataset.prompt = p;
    if (src) item.dataset.sourceImageUrl = src;

    item.addEventListener('click', (e) => {
      const target = e && e.target ? e.target : null;
      if (target && target.closest && (target.closest('.media-download-btn') || target.closest('.media-fav-btn') || target.closest('.media-play-btn'))) return;

      if (isSelectionMode) {
        e.preventDefault();
        e.stopPropagation();
        toggleImageSelection(item);
        return;
      }

      // Ensure session is persisted before navigation (for reliable "Back" restore)
      persistWaterfallSession();

      const url = String(item.dataset.imageUrl || '').trim();
      const id = String(item.dataset.imageId || '').trim();
      const pp = String(item.dataset.prompt || '').trim();
      const ss = String(item.dataset.sourceImageUrl || '').trim();

      window.location.href = buildMediaDetailUrl({
        imageUrl: url,
        imageId: id,
        prompt: pp,
        sourceImageUrl: ss,
        sequence: seq,
      });
    });

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'media-fav-btn';
    setFavUi(favBtn, false);
    favBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await toggleFavoriteForWaterfallItem(item, favBtn);
    });

    // Apply favorite state: prefer session payload, then fallback to preloaded index
    const restoredPid = String(item.dataset.imageId || '').trim();
    const hasSessionFavorite = String(item.dataset.favorite || '0') === '1';
    if (!hasSessionFavorite) {
      const restoredLibId = restoredPid ? String(favoriteByParentPostId.get(restoredPid) || '').trim() : '';
      if (restoredLibId) {
        item.dataset.favorite = '1';
        item.dataset.libraryId = restoredLibId;
      }
    } else if (!String(item.dataset.libraryId || '').trim()) {
      const restoredLibId = restoredPid ? String(favoriteByParentPostId.get(restoredPid) || '').trim() : '';
      if (restoredLibId) {
        item.dataset.libraryId = restoredLibId;
      }
    }
    setFavUi(favBtn, String(item.dataset.favorite || '0') === '1');

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'media-play-btn';
    playBtn.setAttribute('aria-label', '播放 / 生成视频');
    playBtn.title = '播放 / 生成视频';
    playBtn.innerHTML = buildPlaySvg();
    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isSelectionMode) return;

      persistWaterfallSession();

      const url = String(item.dataset.imageUrl || '').trim();
      const id = String(item.dataset.imageId || '').trim();
      const pp = String(item.dataset.prompt || '').trim();
      const ss = String(item.dataset.sourceImageUrl || '').trim();

      window.location.href = buildMediaDetailUrl({
        imageUrl: url,
        imageId: id,
        prompt: pp,
        sourceImageUrl: ss,
        sequence: seq,
        focus: 'video',
      });
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'media-download-btn';
    downloadBtn.setAttribute('aria-label', '下载');
    downloadBtn.title = '下载';
    downloadBtn.innerHTML = buildDownloadSvg();
    downloadBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = String(item.dataset.imageUrl || '').trim();
      if (!url) {
        toast('图片地址为空', 'warning');
        return;
      }
      try {
        const ext = url.startsWith('data:image/png') ? 'png' : 'jpg';
        const filename = buildFilename({ sequence: seq }, seq, ext);
        if (url.startsWith('data:')) {
          downloadDataUrl(url, filename);
        } else {
          await downloadByUrl(url, filename);
        }
        toast('已开始下载', 'success');
      } catch (err) {
        toast('下载失败', 'error');
      }
    });

    const img = document.createElement('img');
    img.className = 'media-item-img';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = imageId ? `image-${imageId}` : `image-${seq}`;
    img.src = dataUrl;

    const metaBar = document.createElement('div');
    metaBar.className = 'media-item-meta';

    const left = document.createElement('div');
    left.textContent = `#${seq}`;

    const right = document.createElement('span');
    right.textContent = '';

    metaBar.appendChild(left);
    metaBar.appendChild(right);

    item.appendChild(checkbox);
    item.appendChild(favBtn);
    item.appendChild(playBtn);
    item.appendChild(downloadBtn);
    item.appendChild(img);
    item.appendChild(metaBar);

    waterfall.appendChild(item);

    if (item.dataset.imageId) {
      streamImageMap.set(item.dataset.imageId, item);
    }

    imageCount += 1;
    if (Boolean(isFinal)) {
      runFinalCount += 1;
    }

    return item;
  }

  function restoreWaterfallSession() {
    if (!waterfall) return false;
    if (waterfall.children && waterfall.children.length > 0) return false;

    let raw = '';
    try {
      raw = String(sessionStorage.getItem(WATERFALL_SESSION_KEY) || '');
    } catch (e) {
      return false;
    }
    if (!raw) return false;

    const data = safeParseJson(raw);
    if (!data || typeof data !== 'object') return false;
    if (data.v !== 1 || !Array.isArray(data.items)) return false;

    const ts = Number(data.ts);
    if (!Number.isFinite(ts) || (Date.now() - ts) > WATERFALL_SESSION_TTL_MS) {
      return false;
    }

    // Reset counters but don't clear the saved session
    exitSelectionMode();
    waterfall.innerHTML = '';
    streamImageMap.clear();
    imageCount = 0;
    runFinalCount = 0;

    let maxSeq = 0;
    for (const it of data.items) {
      if (!it || typeof it !== 'object') continue;
      const seq = clampInt(it.sequence, 1, 999999, 0);
      const imageId = String(it.image_id || '').trim();
      const prompt = String(it.prompt || '').trim();
      const sourceImageUrl = String(it.source_image_url || '').trim();
      const isFinal = Boolean(it.is_final);
      const favorite = Boolean(it.favorite);
      const libraryId = String(it.library_id || '').trim();

      let url = String(it.image_url || '').trim();
      if (!url) {
        const cached = readWaterfallCachedDataUrl(it.cache_key);
        if (cached) url = cached;
      }
      if (!url) continue;

      renderRestoredItem({
        imageId,
        dataUrl: url,
        prompt,
        sourceImageUrl,
        isFinal,
        sequence: seq,
        favorite,
        libraryId,
      });

      if (seq > maxSeq) maxSeq = seq;
    }

    streamSequence = Math.max(streamSequence, maxSeq);
    updateCount(runFinalCount);

    if (emptyState) {
      emptyState.style.display = imageCount > 0 ? 'none' : 'flex';
    }

    const scrollY = clampInt(data.scroll_y, 0, 10_000_000, 0);
    setTimeout(() => {
      window.scrollTo({ top: scrollY, behavior: 'auto' });
    }, 0);

    return imageCount > 0;
  }

  function buildMediaDetailUrl({ imageUrl, imageId, prompt, sourceImageUrl, sequence, focus }) {
    const params = new URLSearchParams();
    const id = String(imageId || '').trim();
    const url = String(imageUrl || '').trim();
    const p = String(prompt || '').trim();
    const src = String(sourceImageUrl || '').trim();
    const seq = Number.isFinite(Number(sequence)) ? String(sequence) : '';
    const f = String(focus || '').trim();

    if (id) params.set('image_id', id);
    if (p) params.set('prompt', p);
    if (src) params.set('source_image_url', src);
    if (f) params.set('focus', f);

    // Prevent querystring explosion for large data URLs
    const isData = url.startsWith('data:');
    if (!isData) {
      if (url) params.set('image_url', url);
      return `/media/detail?${params.toString()}`;
    }

    const keyBase = id ? `media_detail_cache_${id}` : `media_detail_cache_seq_${seq || Date.now()}`;
    const cacheKey = `${keyBase}_${Date.now()}`;
    const cachedKey = tryCacheDataUrlForDetail(url, cacheKey);
    if (cachedKey) {
      params.set('cache_key', cachedKey);
    } else if (url && url.length <= 1800) {
      // last resort: only pass if small enough
      params.set('image_url', url);
    }

    return `/media/detail?${params.toString()}`;
  }

  function renderOrUpdateItem({ imageId, dataUrl, meta, isFinal }) {
    ensureWaterfallExists();

    if (isFinal && autoFilterToggle && autoFilterToggle.checked) {
      const bytes = estimateBase64Bytes(dataUrl || '');
      const minBytes = getFinalMinBytes();
      if (bytes !== null && bytes < minBytes) {
        const existing = imageId ? streamImageMap.get(imageId) : null;
        if (existing) {
          if (selectedImages && selectedImages.has(existing)) {
            selectedImages.delete(existing);
            updateSelectedCount();
          }
          existing.remove();
          streamImageMap.delete(imageId);
          if (imageCount > 0) {
            imageCount -= 1;
          }
        }
        return null;
      }
    }

    if (emptyState) {
      emptyState.style.display = 'none';
    }

    let item = imageId ? streamImageMap.get(imageId) : null;
    let isNew = false;

    if (!item) {
      isNew = true;
      streamSequence += 1;
      const sequence = streamSequence;

      item = document.createElement('div');
      item.className = 'media-item';
      item.dataset.imageId = imageId || '';
      item.dataset.imageUrl = dataUrl || '';
      item.dataset.isFinal = isFinal ? '1' : '0';
      item.dataset.sequence = String(sequence);

      const checkbox = document.createElement('div');
      checkbox.className = 'media-checkbox';
      checkbox.setAttribute('aria-hidden', 'true');

      const prompt = String((meta && meta.prompt) || (promptInput ? promptInput.value.trim() : '') || '').trim();
      const sourceImageUrl = pickSourceImageUrl(meta, dataUrl);
      if (prompt) item.dataset.prompt = prompt;
      if (sourceImageUrl) item.dataset.sourceImageUrl = sourceImageUrl;

      if (isSelectionMode) {
        item.classList.add('selection-mode');
      }

      item.addEventListener('click', (e) => {
        const target = e && e.target ? e.target : null;
        if (target && target.closest && (target.closest('.media-download-btn') || target.closest('.media-fav-btn') || target.closest('.media-play-btn'))) return;

        if (isSelectionMode) {
          e.preventDefault();
          e.stopPropagation();
          toggleImageSelection(item);
          return;
        }

        // Ensure session is persisted before navigation (for reliable "Back" restore)
        persistWaterfallSession();

        const url = String(item.dataset.imageUrl || '').trim();
        const id = String(item.dataset.imageId || '').trim();
        const p = String(item.dataset.prompt || '').trim();
        const src = String(item.dataset.sourceImageUrl || '').trim();
        window.location.href = buildMediaDetailUrl({
          imageUrl: url,
          imageId: id,
          prompt: p,
          sourceImageUrl: src,
          sequence,
        });
      });

      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'media-fav-btn';
      setFavUi(favBtn, false);
      favBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await toggleFavoriteForWaterfallItem(item, favBtn);
      });

      // Apply preloaded favorite state (best-effort)
      const pid = String(item.dataset.imageId || '').trim();
      const libId = pid ? String(favoriteByParentPostId.get(pid) || '').trim() : '';
      if (libId) {
        item.dataset.favorite = '1';
        item.dataset.libraryId = libId;
      }
      setFavUi(favBtn, String(item.dataset.favorite || '0') === '1');

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'media-play-btn';
      playBtn.setAttribute('aria-label', '播放 / 生成视频');
      playBtn.title = '播放 / 生成视频';
      playBtn.innerHTML = buildPlaySvg();
      playBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (isSelectionMode) return;

        persistWaterfallSession();

        const url = String(item.dataset.imageUrl || '').trim();
        const id = String(item.dataset.imageId || '').trim();
        const p = String(item.dataset.prompt || '').trim();
        const src = String(item.dataset.sourceImageUrl || '').trim();
        window.location.href = buildMediaDetailUrl({
          imageUrl: url,
          imageId: id,
          prompt: p,
          sourceImageUrl: src,
          sequence,
          focus: 'video',
        });
      });

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'media-download-btn';
      downloadBtn.setAttribute('aria-label', '下载');
      downloadBtn.title = '下载';
      downloadBtn.innerHTML = buildDownloadSvg();
      downloadBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = String(item.dataset.imageUrl || '').trim();
        if (!url) {
          toast('图片地址为空', 'warning');
          return;
        }
        try {
          const ext = url.startsWith('data:image/png') ? 'png' : 'jpg';
          const filename = buildFilename(meta, sequence, ext);
          if (url.startsWith('data:')) {
            downloadDataUrl(url, filename);
          } else {
            await downloadByUrl(url, filename);
          }
          toast('已开始下载', 'success');
        } catch (err) {
          toast('下载失败', 'error');
        }
      });

      const img = document.createElement('img');
      img.className = 'media-item-img';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = imageId ? `image-${imageId}` : `image-${sequence}`;
      img.src = dataUrl;

      const metaBar = document.createElement('div');
      metaBar.className = 'media-item-meta';

      const left = document.createElement('div');
      left.textContent = `#${sequence}`;

      const right = document.createElement('span');
      right.textContent = meta && meta.elapsed_ms ? `${meta.elapsed_ms}ms` : '';

      metaBar.appendChild(left);
      metaBar.appendChild(right);

      item.appendChild(checkbox);
      item.appendChild(favBtn);
      item.appendChild(playBtn);
      item.appendChild(downloadBtn);
      item.appendChild(img);
      item.appendChild(metaBar);

      if (reverseInsertToggle && reverseInsertToggle.checked) {
        waterfall.prepend(item);
      } else {
        waterfall.appendChild(item);
      }

      if (autoFollowToggle && autoFollowToggle.checked) {
        if (reverseInsertToggle && reverseInsertToggle.checked) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        }
      }

      if (imageId) {
        streamImageMap.set(imageId, item);
      }

      imageCount += 1;
    } else {
      const img = item.querySelector('img');
      if (img) {
        img.src = dataUrl;
      }
      item.dataset.imageUrl = dataUrl || '';
      if (isFinal) {
        item.dataset.isFinal = '1';
      }

      if (meta && meta.prompt) {
        item.dataset.prompt = String(meta.prompt || '').trim();
      }
      const sourceImageUrl = pickSourceImageUrl(meta, dataUrl);
      if (sourceImageUrl) {
        item.dataset.sourceImageUrl = sourceImageUrl;
      }

      const right = item.querySelector('.media-item-meta span');
      if (right && meta && meta.elapsed_ms) {
        right.textContent = `${meta.elapsed_ms}ms`;
      }
    }

    // Auto-save feature removed (disabled due to runaway downloads / browser freeze reports).
    // Keep this block empty intentionally to prevent regressions.

    schedulePersistWaterfallSession();
    return { item, isNew };
  }

  function upsertStreamImage(raw, meta, imageId, isFinal) {
    if (!raw) return false;

    const isDataUrl = typeof raw === 'string' && raw.startsWith('data:');
    const looksLikeBase64 = typeof raw === 'string' && isLikelyBase64(raw);
    const isHttpUrl = typeof raw === 'string' && (raw.startsWith('http://') || raw.startsWith('https://') || (raw.startsWith('/') && !looksLikeBase64));
    const mime = isDataUrl || isHttpUrl ? '' : inferMime(raw);
    const dataUrl = isDataUrl || isHttpUrl ? raw : `data:${mime};base64,${raw}`;

    const rendered = renderOrUpdateItem({
      imageId,
      dataUrl,
      meta,
      isFinal: Boolean(isFinal),
    });

    return Boolean(rendered);
  }

  function appendImage(base64, meta) {
    if (!base64) return false;
    const mime = inferMime(base64);
    const dataUrl = `data:${mime};base64,${base64}`;
    const rendered = renderOrUpdateItem({
      imageId: String((meta && (meta.image_id || meta.imageId || meta.parent_post_id || meta.parentPostId)) || '').trim() || '',
      dataUrl,
      meta,
      isFinal: true,
    });
    return Boolean(rendered);
  }

  function handleMessage(raw, context) {
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    const ctx = context || null;
    if (ctx && typeof ctx.runNonce === 'number' && ctx.runNonce !== runNonce) {
      return;
    }

    if (data.type === 'image_generation.partial_image' || data.type === 'image_generation.completed') {
      touchStreamActivity();
      const imageId = data.image_id || data.imageId;
      const payload = data.b64_json || data.url || data.image;
      if (!payload || !imageId) {
        return;
      }
      const isFinal = data.type === 'image_generation.completed' || data.stage === 'final';
      const kept = upsertStreamImage(payload, data, imageId, isFinal);

      if (isFinal && ctx && ctx.taskId) {
        const progressed = markTaskDone(ctx.taskId);

        // final 被过滤（太小）时，不计数但补任务直到凑够 N 张
        if (progressed && kept) {
          runFinalCount += 1;
          updateCount(runFinalCount);
        }

        if (runFinalCount >= runTargetFinal) {
          const strategy = String(mediaSettings.stop_strategy || 'soft_timeout');
          if (strategy === 'immediate') {
            forceStopNow({ reason: 'max_reached', clearPartials: true });
          } else if (strategy === 'soft') {
            requestSoftStop({ reason: 'max_reached', withTimeout: false });
          } else {
            requestSoftStop({ reason: 'max_reached', withTimeout: true });
          }
          return;
        }

        if (progressed) {
          ensureDesiredTasks();
        }
      }
      return;
    }

    if (data.type === 'image') {
      touchStreamActivity();
      const kept = appendImage(data.b64_json, data);
      if (ctx && ctx.taskId) {
        const progressed = markTaskDone(ctx.taskId);
        if (progressed && kept) {
          runFinalCount += 1;
          updateCount(runFinalCount);
        }
        if (runFinalCount >= runTargetFinal) {
          const strategy = String(mediaSettings.stop_strategy || 'soft_timeout');
          if (strategy === 'immediate') {
            forceStopNow({ reason: 'max_reached', clearPartials: true });
          } else if (strategy === 'soft') {
            requestSoftStop({ reason: 'max_reached', withTimeout: false });
          } else {
            requestSoftStop({ reason: 'max_reached', withTimeout: true });
          }
          return;
        }
        if (progressed) ensureDesiredTasks();
      }
      return;
    }

    if (data.type === 'status') {
      touchStreamActivity();
      if (data.status === 'running') {
        setStatus('connected', connectionMode === 'sse' ? '生成中 (SSE)' : '生成中');
        lastRunId = data.run_id || '';
      } else if (data.status === 'stopped') {
        if (data.run_id && lastRunId && data.run_id !== lastRunId) {
          return;
        }
        setStatus('', '已停止');
      }
      return;
    }

    if (data.type === 'error' || data.error) {
      const message = data.message || (data.error && data.error.message) || '生成失败';
      toast(message, 'error');
    }
  }

  function sendStart(promptOverride, targetWs) {
    const ws = targetWs || wsConnections[0];
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const prompt = promptOverride || (promptInput ? promptInput.value.trim() : '');
    const ratio = ratioSelect ? ratioSelect.value : '2:3';
    const nsfwEnabled = nsfwSelect ? nsfwSelect.value === 'true' : true;

    const payload = {
      type: 'start',
      prompt,
      aspect_ratio: ratio,
      nsfw: nsfwEnabled
    };
    ws.send(JSON.stringify(payload));
  }

  function startSSE(taskIds, rawPublicKey) {
    connectionMode = 'sse';
    stopAllConnections();

    setStatus('connected', '生成中 (SSE)');
    setButtons(true);
    toast(`已启动 ${taskIds.length} 个并发任务 (SSE)`, 'success');

    for (let i = 0; i < taskIds.length; i++) {
      const url = buildSseUrl(taskIds[i], i, rawPublicKey);
      const es = new EventSource(url);

      es.onopen = () => {
        updateActive();
      };

      es.onmessage = (event) => {
        handleMessage(event.data);
      };

      es.onerror = () => {
        updateActive();
        const remaining = sseConnections.filter(e => e && e.readyState === EventSource.OPEN).length;
        if (remaining === 0) {
          setStatus('error', '连接错误');
          setButtons(false);
          isRunning = false;
          if (startBtn) startBtn.disabled = false;
        }
      };

      sseConnections.push(es);
    }
  }

  async function startConnection() {
    const prompt = promptInput ? promptInput.value.trim() : '';
    if (!prompt) {
      toast('请输入提示词', 'error');
      return;
    }

    const authHeader = await ensurePublicKey();
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      window.location.href = '/login';
      return;
    }

    refreshMediaSettingsFromControls();
    persistMediaSettings();

    desiredConcurrent = clampInt(mediaSettings.concurrent, 1, 99, 1);
    runTargetFinal = clampInt(mediaSettings.max_images_per_run, 1, 99, 6);

    if (isRunning) {
      toast('已在运行中', 'warning');
      return;
    }

    runNonce += 1;
    resetRunStateForNewRun();
    clearImages();

    isRunning = true;
    setStatus('connecting', '连接中');
    if (startBtn) startBtn.disabled = true;
    setButtons(true);

    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    stopAllConnections();
    wsConnections = [];
    sseConnections = [];

    connectionMode = (modePreference === 'sse') ? 'sse' : 'ws';
    setStatus('connected', connectionMode === 'sse' ? '生成中 (SSE)' : '生成中');

    // Auto fallback: if no WS opens, stop current tasks and restart in SSE
    if (modePreference === 'auto') {
      pendingFallbackTimer = setTimeout(async () => {
        if (!isRunning) return;
        if (connectionMode !== 'ws') return;
        const active = wsConnections.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;
        if (active > 0) return;

        // stop current tasks and switch to SSE
        stopRequested = true;
        try {
          await stopImagineTasks(currentTaskIds, authHeader);
        } catch (e) {
          // ignore
        }
        stopAllConnections();
        taskStateById.clear();
        currentTaskIds = [];
        inFlightTasks = 0;
        stopRequested = false;

        connectionMode = 'sse';
        setStatus('connected', '生成中 (SSE)');
        ensureDesiredTasks();
      }, 1500);
    }

    ensureDesiredTasks();
    toast(`本轮最多 ${runTargetFinal} 张 · 并发 ${desiredConcurrent}`, 'info');
  }

  async function stopConnection() {
    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    if (stopRequested) {
      toast('正在停止中...', 'info');
      return;
    }

    refreshMediaSettingsFromControls();
    persistMediaSettings();

    // Immediate UI feedback (even for soft stop)
    setStopButtonStopping(true, '停止中...');

    const strategy = String(mediaSettings.stop_strategy || 'soft_timeout');
    if (strategy === 'immediate') {
      toast('已请求停止（强停）', 'info');
      await forceStopNow({ reason: 'user', clearPartials: true });
      return;
    }

    if (strategy === 'soft') {
      toast('已请求停止（软停）', 'info');
      await requestSoftStop({ reason: 'user', withTimeout: false });
      return;
    }

    toast('已请求停止（软停）', 'info');
    await requestSoftStop({ reason: 'user', withTimeout: true });
  }

  function clearImages() {
    exitSelectionMode();
    if (waterfall) {
      waterfall.innerHTML = '';
    }
    streamImageMap.clear();
    streamSequence = 0;
    imageCount = 0;
    runFinalCount = 0;
    updateCount(0);
    if (emptyState) {
      emptyState.style.display = 'flex';
    }
    clearWaterfallSession();
  }

  function bindAdvancedToggle() {
    if (!advancedToggle || !advancedPanel || !advancedPopoverRoot) return;

    let isOpen = false;

    const GAP_PX = 8;
    const PADDING_PX = 10;

    const setOpen = (open) => {
      isOpen = Boolean(open);
      advancedToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      advancedPanel.hidden = !isOpen;

      if (!isOpen) {
        advancedPanel.style.left = '';
        advancedPanel.style.top = '';
        advancedPanel.style.width = '';
        advancedPanel.style.maxWidth = '';
        advancedPanel.style.visibility = '';
      }
    };

    const positionPopover = () => {
      if (!isOpen) return;

      const toggleRect = advancedToggle.getBoundingClientRect();
      const composerEl = advancedToggle.closest('.media-composer') || document.querySelector('.media-composer');
      const composerRect = composerEl ? composerEl.getBoundingClientRect() : toggleRect;

      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      // Anchor: right edge of the composer (not the toggle button), so it never covers Stop/Advanced buttons.
      const left = composerRect.right + GAP_PX;
      const availableW = Math.max(0, viewportW - left - PADDING_PX);

      // Make it measurable (without flashing) and apply width constraint before measuring height.
      advancedPanel.hidden = false;
      advancedPanel.style.visibility = 'hidden';
      advancedPanel.style.left = '0px';
      advancedPanel.style.top = '0px';

      const desiredW = 420;
      const effectiveW = Math.max(0, Math.min(desiredW, availableW));
      advancedPanel.style.width = `${Math.round(effectiveW)}px`;
      advancedPanel.style.maxWidth = `${Math.round(availableW)}px`;

      const popH = advancedPanel.offsetHeight || 320;

      // Try align to toggle top; clamp to keep it visible
      let top = toggleRect.top;
      top = Math.min(top, viewportH - popH - PADDING_PX);
      top = Math.max(PADDING_PX, top);

      advancedPanel.style.left = `${Math.round(left)}px`;
      advancedPanel.style.top = `${Math.round(top)}px`;
      advancedPanel.style.visibility = 'visible';
    };

    const onDocClickCapture = (e) => {
      if (!isOpen) return;
      const target = e && e.target ? e.target : null;
      if (!target) return;

      // Ignore clicks inside popover or on the toggle button
      if (advancedPanel.contains(target) || advancedToggle.contains(target)) return;

      setOpen(false);
    };

    const onKeyDown = (e) => {
      if (!isOpen) return;
      if (!e) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };

    const onWindowResize = () => positionPopover();
    const onWindowScroll = () => positionPopover();

    const bindGlobalListeners = () => {
      document.addEventListener('click', onDocClickCapture, true);
      document.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('scroll', onWindowScroll, true);
    };

    const unbindGlobalListeners = () => {
      document.removeEventListener('click', onDocClickCapture, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onWindowScroll, true);
    };

    // Initial state
    setOpen(false);
    unbindGlobalListeners();

    advancedToggle.addEventListener('click', () => {
      const next = !isOpen;
      setOpen(next);
      if (next) {
        bindGlobalListeners();
        positionPopover();
      } else {
        unbindGlobalListeners();
      }
    });
  }

  // T10 Batch download (selection mode + zip)
  function getSelectableItems() {
    if (!waterfall) return [];
    return Array.from(waterfall.querySelectorAll('.media-item')).filter((item) => {
      const isFinal = String(item.dataset.isFinal || '0') === '1';
      const url = String(item.dataset.imageUrl || '').trim();
      return isFinal && Boolean(url);
    });
  }

  function enterSelectionMode() {
    isSelectionMode = true;
    selectedImages.clear();
    if (selectionToolbar) selectionToolbar.classList.remove('hidden');
    if (batchDownloadBtn) batchDownloadBtn.textContent = '取消';

    if (waterfall) {
      const items = waterfall.querySelectorAll('.media-item');
      items.forEach((item) => item.classList.add('selection-mode'));
    }
    updateSelectedCount();
  }

  function exitSelectionMode() {
    isSelectionMode = false;
    selectedImages.clear();
    if (selectionToolbar) selectionToolbar.classList.add('hidden');
    if (batchDownloadBtn) batchDownloadBtn.textContent = '批量';

    if (waterfall) {
      const items = waterfall.querySelectorAll('.media-item');
      items.forEach((item) => item.classList.remove('selection-mode', 'selected'));
    }
    updateSelectedCount();
  }

  function toggleSelectionMode() {
    if (isSelectionMode) exitSelectionMode();
    else enterSelectionMode();
  }

  function toggleImageSelection(item) {
    if (!isSelectionMode) return;
    if (!item) return;

    const isFinal = String(item.dataset.isFinal || '0') === '1';
    if (!isFinal) {
      toast('仅支持选择 final 图片', 'warning');
      return;
    }

    if (item.classList.contains('selected')) {
      item.classList.remove('selected');
      selectedImages.delete(item);
    } else {
      item.classList.add('selected');
      selectedImages.add(item);
    }
    updateSelectedCount();
  }

  function updateSelectedCount() {
    const countSpan = document.getElementById('selectedCount');
    if (countSpan) {
      countSpan.textContent = String(selectedImages.size);
    }
    if (downloadSelectedBtn) {
      downloadSelectedBtn.disabled = selectedImages.size === 0;
    }
    if (toggleSelectAllBtn) {
      const items = getSelectableItems();
      const allSelected = items.length > 0 && selectedImages.size === items.length;
      toggleSelectAllBtn.textContent = allSelected ? '取消全选' : '全选';
    }
  }

  function toggleSelectAll() {
    const items = getSelectableItems();
    const allSelected = items.length > 0 && selectedImages.size === items.length;

    if (allSelected) {
      items.forEach((item) => item.classList.remove('selected'));
      selectedImages.clear();
    } else {
      items.forEach((item) => {
        item.classList.add('selected');
        selectedImages.add(item);
      });
    }
    updateSelectedCount();
  }

  async function downloadSelectedImages() {
    if (selectedImages.size === 0) {
      toast('请先选择要下载的图片', 'warning');
      return;
    }

    if (typeof JSZip === 'undefined') {
      toast('JSZip 库加载失败，请刷新页面重试', 'error');
      return;
    }

    toast(`正在打包 ${selectedImages.size} 张图片...`, 'info');
    if (downloadSelectedBtn) {
      downloadSelectedBtn.disabled = true;
      downloadSelectedBtn.textContent = '打包中...';
    }

    const zip = new JSZip();
    const imgFolder = zip.folder('images');
    let processed = 0;

    try {
      for (const item of selectedImages) {
        const url = String(item && item.dataset ? item.dataset.imageUrl : '').trim();
        const prompt = String(item && item.dataset ? (item.dataset.prompt || '') : '').trim();
        const sequence = String(item && item.dataset ? (item.dataset.sequence || '') : '').trim();

        try {
          let blob = null;
          if (url.startsWith('data:')) {
            blob = dataUrlToBlob(url);
          } else if (url) {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error('fetch_failed');
            blob = await response.blob();
          }
          if (!blob) {
            throw new Error('empty_blob');
          }

          const safePrompt = (prompt || 'image')
            .slice(0, 30)
            .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') || 'image';
          const ext = inferExtFromUrl(url);
          const nameSeq = sequence || String(processed + 1);
          const filename = `${safePrompt}_${nameSeq}.${ext}`;

          if (imgFolder) {
            imgFolder.file(filename, blob);
          } else {
            zip.file(filename, blob);
          }
          processed += 1;

          if (downloadSelectedBtn) {
            downloadSelectedBtn.innerHTML = `打包中... (${processed}/${selectedImages.size})`;
          }
        } catch (error) {
          // ignore per item
          console.error('Failed to fetch image:', error);
        }
      }

      if (processed === 0) {
        toast('没有成功获取任何图片', 'error');
        return;
      }

      if (downloadSelectedBtn) {
        downloadSelectedBtn.textContent = '生成压缩包...';
      }
      const content = await zip.generateAsync({ type: 'blob' });

      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `media_${new Date().toISOString().slice(0, 10)}_${Date.now()}.zip`;
      link.click();
      URL.revokeObjectURL(link.href);

      toast(`成功打包 ${processed} 张图片`, 'success');
      exitSelectionMode();
    } catch (error) {
      console.error('Download failed:', error);
      toast('打包失败，请重试', 'error');
    } finally {
      if (downloadSelectedBtn) {
        downloadSelectedBtn.disabled = false;
        downloadSelectedBtn.innerHTML = `下载 <span id="selectedCount" class="media-selected-count">${selectedImages.size}</span>`;
      }
      updateSelectedCount();
    }
  }

  if (batchDownloadBtn) {
    batchDownloadBtn.addEventListener('click', toggleSelectionMode);
  }
  if (libraryBtn) {
    libraryBtn.addEventListener('click', () => {
      // Ensure session is persisted before navigation (so Back restore still works)
      persistWaterfallSession();
      window.location.href = '/media/library';
    });
  }
  if (toggleSelectAllBtn) {
    toggleSelectAllBtn.addEventListener('click', toggleSelectAll);
  }
  if (downloadSelectedBtn) {
    downloadSelectedBtn.addEventListener('click', downloadSelectedImages);
  }
  if (exitSelectionModeBtn) {
    exitSelectionModeBtn.addEventListener('click', exitSelectionMode);
  }

  // Bindings
  if (startBtn) {
    startBtn.addEventListener('click', () => startConnection());
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => stopConnection());
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
    });
  }

  // When advanced settings change, mimic imagine behavior:
  // - SSE: restart
  // - WS: send start payload to open connections
  function bindSettingsChangeRestart() {
    const onChange = () => {
      refreshMediaSettingsFromControls();
      persistMediaSettings();

      if (!isRunning) return;

      // restart should be deterministic: use immediate stop, then restart
      forceStopNow({ reason: 'settings_change', clearPartials: false }).then(() => {
        setTimeout(() => startConnection(), 50);
      });
    };
    if (ratioSelect) ratioSelect.addEventListener('change', onChange);
    if (nsfwSelect) nsfwSelect.addEventListener('change', onChange);
  }

  function bindConcurrentChangeRestart() {
    if (!concurrentSelect) return;
    concurrentSelect.addEventListener('change', () => {
      refreshMediaSettingsFromControls();
      persistMediaSettings();

      if (!isRunning) return;
      forceStopNow({ reason: 'settings_change', clearPartials: false }).then(() => {
        setTimeout(() => startConnection(), 50);
      });
    });
  }

  function bindRunSettingsPersistence() {
    const onPersist = () => {
      refreshMediaSettingsFromControls();
      persistMediaSettings();
    };

    if (maxImagesInput) maxImagesInput.addEventListener('change', onPersist);
    if (stopStrategySelect) stopStrategySelect.addEventListener('change', onPersist);
    if (softStopTimeoutInput) softStopTimeoutInput.addEventListener('change', onPersist);
    if (softStopGraceInput) softStopGraceInput.addEventListener('change', onPersist);

    if (autoFollowToggle) autoFollowToggle.addEventListener('change', onPersist);
    if (reverseInsertToggle) reverseInsertToggle.addEventListener('change', onPersist);
    if (autoFilterToggle) autoFilterToggle.addEventListener('change', onPersist);
    if (autoSaveToggle) {
      autoSaveToggle.addEventListener('change', () => {
        onPersist();
        updateAutoSaveUiState();
      });
    }
  }

  // Load & apply persisted settings before binding events
  mediaSettings = loadMediaSettings();

  // Hard-disable auto-save even if older localStorage has it enabled.
  // Reason: auto-save may trigger continuous downloads and freeze the browser.
  if (mediaSettings && typeof mediaSettings === 'object') {
    const wasEnabled = Boolean(mediaSettings.auto_save);
    if (wasEnabled) {
      mediaSettings.auto_save = false;
      mediaSettings.auto_save_use_fs = false;
      mediaSettings.auto_save_folder_label = '未启用';
      directoryHandle = null;
      useFileSystemAPI = false;
      persistMediaSettings();
    }
  }

  applyMediaSettingsToControls();
  updateAutoSaveUiState();

  // T6: restore waterfall session if available (e.g., browser Back from detail page)
  restoreWaterfallSession();

  window.addEventListener('pagehide', () => {
    persistWaterfallSession();
  });

  window.addEventListener('pageshow', () => {
    // Some browsers may not keep the page in BFCache; restore if empty
    restoreWaterfallSession();
  });

  if (modeButtons.length > 0) {
    setModePreference(mediaSettings.mode_preference || 'auto', false);

    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        setModePreference(mode);
        if (isRunning) {
          stopConnection().then(() => {
            setTimeout(() => startConnection(), 50);
          });
        }
      });
    });
  }

  function updateAutoSaveUiState() {
    const supported = 'showDirectoryPicker' in window;
    const enabled = Boolean(autoSaveToggle && autoSaveToggle.checked);
    const hasHandle = Boolean(useFileSystemAPI && directoryHandle && directoryHandle.name);

    if (saveFolderPath) {
      if (!enabled) {
        saveFolderPath.textContent = '未启用';
      } else if (hasHandle) {
        saveFolderPath.textContent = String(directoryHandle.name);
      } else {
        saveFolderPath.textContent = DEFAULT_SETTINGS.auto_save_folder_label;
      }
    }

    if (saveFolderHint) {
      if (!enabled) {
        saveFolderHint.textContent = '开启“生成后自动保存”后，可选择保存目录（可选）。';
      } else if (!supported) {
        saveFolderHint.textContent = '当前浏览器不支持目录写入，将使用浏览器下载（不会修改默认下载路径）。';
      } else if (hasHandle) {
        saveFolderHint.textContent = '已启用目录写入（仅本浏览器本次会话有效）；不会修改浏览器默认下载路径。';
      } else {
        saveFolderHint.textContent = '可选：选择保存目录（仅部分浏览器支持）；未选择则使用浏览器下载。';
      }
    }

    if (!selectSaveFolderBtn) return;

    if (!enabled) {
      selectSaveFolderBtn.disabled = true;
      selectSaveFolderBtn.title = '开启自动保存后可选';
      return;
    }

    if (!supported) {
      selectSaveFolderBtn.disabled = true;
      selectSaveFolderBtn.title = '当前浏览器不支持目录写入';
      return;
    }

    selectSaveFolderBtn.disabled = false;
    selectSaveFolderBtn.title = '选择一个目录用于写入文件（不会修改默认下载路径）';
  }

  function bindAutoSaveFolderSelection() {
    if (!selectSaveFolderBtn) return;
    updateAutoSaveUiState();

    if (!('showDirectoryPicker' in window)) {
      return;
    }

    selectSaveFolderBtn.addEventListener('click', async () => {
      try {
        directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        useFileSystemAPI = true;

        updateAutoSaveUiState();
        refreshMediaSettingsFromControls();
        persistMediaSettings();

        toast(`已选择保存目录：${directoryHandle && directoryHandle.name ? directoryHandle.name : '已选择目录'}`, 'success');
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        toast('选择保存目录失败', 'error');
      }
    });
  }

  bindAdvancedToggle();
  bindSettingsChangeRestart();
  bindConcurrentChangeRestart();
  bindRunSettingsPersistence();
  bindAutoSaveFolderSelection();

  preloadFavoriteIndex();
  loadFilterDefaults();
  setButtons(false);
  setStatus('', '未连接');

  // Convenience: clear waterfall on double click status
  if (statusText) {
    statusText.addEventListener('dblclick', () => {
      clearImages();
      toast('已清空瀑布流', 'info');
    });
  }
})();