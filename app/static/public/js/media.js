(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const promptInput = document.getElementById('promptInput');

  const ratioSelect = document.getElementById('ratioSelect');
  const concurrentSelect = document.getElementById('concurrentSelect');
  const nsfwSelect = document.getElementById('nsfwSelect');

  const statusText = document.getElementById('statusText');
  const countValue = document.getElementById('countValue');
  const activeValue = document.getElementById('activeValue');

  const waterfall = document.getElementById('waterfall');
  const emptyState = document.getElementById('emptyState');

  const modeButtons = document.querySelectorAll('.mode-btn');

  const advancedToggle = document.getElementById('advancedToggle');
  const advancedPanel = document.getElementById('advancedPanel');

  let wsConnections = [];
  let sseConnections = [];
  let imageCount = 0;

  let lastRunId = '';
  let isRunning = false;
  let connectionMode = 'ws';
  let modePreference = 'auto';
  const MODE_STORAGE_KEY = 'media_mode';
  let pendingFallbackTimer = null;
  let currentTaskIds = [];
  let streamSequence = 0;
  const streamImageMap = new Map();

  let finalMinBytesDefault = 100000;

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
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

  function updateCount(value) {
    if (!countValue) return;
    countValue.textContent = String(value);
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
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    if (persist) {
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
      if (nsfwSelect && typeof data.nsfw === 'boolean') {
        nsfwSelect.value = data.nsfw ? 'true' : 'false';
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

  function buildFilename(meta, sequence, extFallback) {
    const ts = Date.now();
    const seq = meta && meta.sequence ? meta.sequence : sequence;
    const ext = extFallback || 'jpg';
    return `media_${ts}_${seq}.${ext}`;
  }

  function renderOrUpdateItem({ imageId, dataUrl, meta, isFinal }) {
    ensureWaterfallExists();

    if (isFinal) {
      const bytes = estimateBase64Bytes(dataUrl || '');
      const minBytes = getFinalMinBytes();
      if (bytes !== null && bytes < minBytes) {
        const existing = imageId ? streamImageMap.get(imageId) : null;
        if (existing) {
          existing.remove();
          streamImageMap.delete(imageId);
          if (imageCount > 0) {
            imageCount -= 1;
            updateCount(imageCount);
          }
        }
        return;
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

      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.className = 'media-download-btn';
      downloadBtn.textContent = '下载';
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

      item.appendChild(downloadBtn);
      item.appendChild(img);
      item.appendChild(metaBar);

      waterfall.appendChild(item);

      if (imageId) {
        streamImageMap.set(imageId, item);
      }

      imageCount += 1;
      updateCount(imageCount);
    } else {
      const img = item.querySelector('img');
      if (img) {
        img.src = dataUrl;
      }
      item.dataset.imageUrl = dataUrl || '';

      const right = item.querySelector('.media-item-meta span');
      if (right && meta && meta.elapsed_ms) {
        right.textContent = `${meta.elapsed_ms}ms`;
      }
    }

    return { item, isNew };
  }

  function upsertStreamImage(raw, meta, imageId, isFinal) {
    if (!raw) return;

    const isDataUrl = typeof raw === 'string' && raw.startsWith('data:');
    const looksLikeBase64 = typeof raw === 'string' && isLikelyBase64(raw);
    const isHttpUrl = typeof raw === 'string' && (raw.startsWith('http://') || raw.startsWith('https://') || (raw.startsWith('/') && !looksLikeBase64));
    const mime = isDataUrl || isHttpUrl ? '' : inferMime(raw);
    const dataUrl = isDataUrl || isHttpUrl ? raw : `data:${mime};base64,${raw}`;

    renderOrUpdateItem({
      imageId,
      dataUrl,
      meta,
      isFinal: Boolean(isFinal),
    });
  }

  function appendImage(base64, meta) {
    if (!base64) return;
    const mime = inferMime(base64);
    const dataUrl = `data:${mime};base64,${base64}`;
    renderOrUpdateItem({
      imageId: String((meta && (meta.image_id || meta.imageId || meta.parent_post_id || meta.parentPostId)) || '').trim() || '',
      dataUrl,
      meta,
      isFinal: true,
    });
  }

  function handleMessage(raw) {
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'image_generation.partial_image' || data.type === 'image_generation.completed') {
      const imageId = data.image_id || data.imageId;
      const payload = data.b64_json || data.url || data.image;
      if (!payload || !imageId) {
        return;
      }
      const isFinal = data.type === 'image_generation.completed' || data.stage === 'final';
      upsertStreamImage(payload, data, imageId, isFinal);
    } else if (data.type === 'image') {
      appendImage(data.b64_json, data);
    } else if (data.type === 'status') {
      if (data.status === 'running') {
        setStatus('connected', '生成中');
        lastRunId = data.run_id || '';
      } else if (data.status === 'stopped') {
        if (data.run_id && lastRunId && data.run_id !== lastRunId) {
          return;
        }
        setStatus('', '已停止');
      }
    } else if (data.type === 'error' || data.error) {
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
    const rawPublicKey = normalizeAuthHeader(authHeader);

    const concurrent = concurrentSelect ? parseInt(concurrentSelect.value, 10) : 1;
    const ratio = ratioSelect ? ratioSelect.value : '2:3';
    const nsfwEnabled = nsfwSelect ? nsfwSelect.value === 'true' : true;

    if (isRunning) {
      toast('已在运行中', 'warning');
      return;
    }

    isRunning = true;
    setStatus('connecting', '连接中');
    if (startBtn) startBtn.disabled = true;

    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    let taskIds = [];
    try {
      taskIds = await createImagineTasks(prompt, ratio, concurrent, authHeader, nsfwEnabled);
    } catch (e) {
      setStatus('error', '创建任务失败');
      if (startBtn) startBtn.disabled = false;
      isRunning = false;
      return;
    }
    currentTaskIds = taskIds;

    if (modePreference === 'sse') {
      startSSE(taskIds, rawPublicKey);
      return;
    }

    connectionMode = 'ws';
    stopAllConnections();

    let opened = 0;
    let fallbackDone = false;
    let fallbackTimer = null;

    if (modePreference === 'auto') {
      fallbackTimer = setTimeout(() => {
        if (!fallbackDone && opened === 0) {
          fallbackDone = true;
          startSSE(taskIds, rawPublicKey);
        }
      }, 1500);
    }
    pendingFallbackTimer = fallbackTimer;

    wsConnections = [];

    for (let i = 0; i < taskIds.length; i++) {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({ task_id: taskIds[i] });
      if (rawPublicKey) {
        params.set('public_key', rawPublicKey);
      }
      const wsUrl = `${protocol}://${window.location.host}/v1/public/imagine/ws?${params.toString()}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        opened += 1;
        updateActive();
        if (i === 0) {
          setStatus('connected', '生成中');
          setButtons(true);
          toast(`已启动 ${concurrent} 个并发任务`, 'success');
        }
        sendStart(prompt, ws);
      };

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = () => {
        updateActive();
        if (connectionMode !== 'ws') {
          return;
        }
        const remaining = wsConnections.filter(w => w && w.readyState === WebSocket.OPEN).length;
        if (remaining === 0 && !fallbackDone) {
          setStatus('', '未连接');
          setButtons(false);
          isRunning = false;
        }
      };

      ws.onerror = () => {
        updateActive();
        if (modePreference === 'auto' && opened === 0 && !fallbackDone) {
          fallbackDone = true;
          if (fallbackTimer) {
            clearTimeout(fallbackTimer);
          }
          startSSE(taskIds, rawPublicKey);
          return;
        }
        if (i === 0 && wsConnections.filter(w => w && w.readyState === WebSocket.OPEN).length === 0) {
          setStatus('error', '连接错误');
          if (startBtn) startBtn.disabled = false;
          isRunning = false;
        }
      };

      wsConnections.push(ws);
    }
  }

  async function stopConnection() {
    if (pendingFallbackTimer) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }

    const authHeader = await ensurePublicKey();
    if (authHeader !== null && currentTaskIds.length > 0) {
      await stopImagineTasks(currentTaskIds, authHeader);
    }

    stopAllConnections();
    currentTaskIds = [];
    isRunning = false;
    updateActive();
    setButtons(false);
    setStatus('', '未连接');
  }

  function clearImages() {
    if (waterfall) {
      waterfall.innerHTML = '';
    }
    streamImageMap.clear();
    streamSequence = 0;
    imageCount = 0;
    updateCount(imageCount);
    if (emptyState) {
      emptyState.style.display = 'flex';
    }
  }

  function bindAdvancedToggle() {
    if (!advancedToggle || !advancedPanel) return;
    const setOpen = (open) => {
      const isOpen = Boolean(open);
      advancedToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      advancedPanel.hidden = !isOpen;
    };
    setOpen(false);
    advancedToggle.addEventListener('click', () => {
      const expanded = advancedToggle.getAttribute('aria-expanded') === 'true';
      setOpen(!expanded);
    });
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
      if (!isRunning) return;
      if (connectionMode === 'sse') {
        stopConnection().then(() => {
          setTimeout(() => startConnection(), 50);
        });
        return;
      }
      wsConnections.forEach(ws => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendStart(null, ws);
        }
      });
    };
    if (ratioSelect) ratioSelect.addEventListener('change', onChange);
    if (nsfwSelect) nsfwSelect.addEventListener('change', onChange);
  }

  function bindConcurrentChangeRestart() {
    if (!concurrentSelect) return;
    concurrentSelect.addEventListener('change', () => {
      if (!isRunning) return;
      stopConnection().then(() => {
        setTimeout(() => startConnection(), 50);
      });
    });
  }

  if (modeButtons.length > 0) {
    const saved = (() => {
      try {
        return localStorage.getItem(MODE_STORAGE_KEY);
      } catch (e) {
        return null;
      }
    })();
    if (saved) {
      setModePreference(saved, false);
    } else {
      setModePreference('auto', false);
    }

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

  bindAdvancedToggle();
  bindSettingsChangeRestart();
  bindConcurrentChangeRestart();

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