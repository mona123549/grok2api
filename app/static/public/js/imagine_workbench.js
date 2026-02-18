(() => {
  const seedImageInput = document.getElementById('seedImageInput');
  const selectSeedBtn = document.getElementById('selectSeedBtn');
  const seedFileName = document.getElementById('seedFileName');
  const parentPostInput = document.getElementById('parentPostInput');
  const applyParentBtn = document.getElementById('applyParentBtn');
  const previewShell = document.getElementById('previewShell');
  const currentImage = document.getElementById('currentImage');
  const previewEmpty = document.getElementById('previewEmpty');
  const currentParentId = document.getElementById('currentParentId');
  const currentMode = document.getElementById('currentMode');
  const editPromptInput = document.getElementById('editPromptInput');
  const submitEditBtn = document.getElementById('submitEditBtn');
  const resetCycleBtn = document.getElementById('resetCycleBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const editStatusText = document.getElementById('editStatusText');
  const historyCount = document.getElementById('historyCount');
  const historyEmpty = document.getElementById('historyEmpty');
  const historyList = document.getElementById('historyList');
  const editProgressWrap = document.getElementById('editProgressWrap');
  const editProgressBar = document.getElementById('editProgressBar');
  const editProgressText = document.getElementById('editProgressText');

  const state = {
    editing: false,
    seedImageBase64: '',
    seedFileName: '',
    currentImageUrl: '',
    currentParentPostId: '',
    currentSourceImageUrl: '',
    currentModeValue: 'upload',
    history: [],
    editRound: 0,
  };
  let workbenchEditAbortController = null;
  let editProgressTimer = null;
  let editProgressHideTimer = null;
  let editProgressValue = 0;
  let dragCounter = 0;

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function getParentMemoryApi() {
    return window.ParentPostMemory || null;
  }

  function rememberParentPost(entry) {
    const api = getParentMemoryApi();
    if (!api || !entry) return;
    try {
      api.remember(entry);
    } catch (e) {
      // ignore
    }
  }

  async function copyText(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  }

  function shortId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    if (raw.length <= 14) return raw;
    return `${raw.slice(0, 7)}...${raw.slice(-7)}`;
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString('zh-CN', {
        hour12: false,
      });
    } catch (e) {
      return '-';
    }
  }

  function maskPrompt(prompt) {
    const raw = String(prompt || '').trim();
    if (!raw) return '-';
    return raw;
  }

  function buildImaginePublicUrl(parentPostId) {
    return `https://imagine-public.x.ai/imagine-public/images/${parentPostId}.jpg`;
  }

  function normalizeHttpSourceUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw;
    }
    if (raw.startsWith('/')) {
      return `${window.location.origin}${raw}`;
    }
    return '';
  }

  function pickSourceImageUrl(hit, parentPostId, fallbackValue = '') {
    const candidates = [
      hit && hit.current_source_image_url,
      hit && hit.currentSourceImageUrl,
      hit && hit.source_image_url,
      hit && hit.sourceImageUrl,
      hit && hit.image_url,
      hit && hit.imageUrl,
      fallbackValue,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeHttpSourceUrl(candidate);
      if (normalized) return normalized;
    }
    return parentPostId ? buildImaginePublicUrl(parentPostId) : '';
  }

  function pickPreviewUrl(hit, parentPostId) {
    const candidates = [
      hit && hit.imageUrl,
      hit && hit.image_url,
      hit && hit.url,
      hit && hit.sourceImageUrl,
      hit && hit.source_image_url,
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || '').trim();
      if (raw) return raw;
    }
    const source = pickSourceImageUrl(hit, parentPostId);
    return source || (parentPostId ? buildImaginePublicUrl(parentPostId) : '');
  }

  function extractParentPostId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const direct = raw.match(/^[0-9a-fA-F-]{32,36}$/);
    if (direct) return direct[0];
    const generated = raw.match(/\/generated\/([0-9a-fA-F-]{32,36})(?:\/|$)/);
    if (generated) return generated[1];
    const imaginePublic = raw.match(/\/imagine-public\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/);
    if (imaginePublic) return imaginePublic[1];
    const imagePath = raw.match(/\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/);
    if (imagePath) return imagePath[1];
    const all = raw.match(/([0-9a-fA-F-]{32,36})/g);
    return all && all.length ? all[all.length - 1] : '';
  }

  function resolveParentMemoryByText(text) {
    const input = String(text || '').trim();
    if (!input) return null;
    const api = getParentMemoryApi();
    if (api && typeof api.resolveByText === 'function') {
      try {
        const hit = api.resolveByText(input);
        if (hit && hit.parentPostId) {
          const parentPostId = String(hit.parentPostId || '').trim();
          return {
            ...hit,
            parentPostId,
          };
        }
        return hit;
      } catch (e) {
        // ignore
      }
    }
    const parentPostId = extractParentPostId(input);
    if (!parentPostId) return null;
    return {
      parentPostId,
      sourceImageUrl: buildImaginePublicUrl(parentPostId),
      imageUrl: buildImaginePublicUrl(parentPostId),
      origin: 'fallback',
    };
  }

  function applyParentPostFromText(text, options = {}) {
    const silent = Boolean(options.silent);
    const hit = resolveParentMemoryByText(text);
    if (!hit || !hit.parentPostId) {
      if (!silent) {
        toast('未识别到有效 parentPostId', 'warning');
      }
      return false;
    }
    const parentPostId = String(hit.parentPostId || '').trim();
    const sourceImageUrl = pickSourceImageUrl(hit, parentPostId);
    const previewUrl = pickPreviewUrl(hit, parentPostId);

    state.currentParentPostId = parentPostId;
    state.currentSourceImageUrl = sourceImageUrl;
    state.currentModeValue = 'parent_post';
    setPreview(previewUrl);
    updateMeta();
    setStatus('done', `已加载 parentPostId：${shortId(parentPostId)}`);
    if (parentPostInput) {
      parentPostInput.value = parentPostId;
    }
    rememberParentPost({
      parentPostId,
      sourceImageUrl,
      imageUrl: previewUrl,
      origin: 'workbench_paste_apply',
    });
    if (!silent) {
      toast('已载入 parentPostId，可直接继续编辑', 'success');
    }
    return true;
  }

  function setStatus(stateName, text) {
    if (!editStatusText) return;
    editStatusText.textContent = text;
    editStatusText.classList.remove('running', 'done', 'error');
    if (stateName) {
      editStatusText.classList.add(stateName);
    }
  }

  function clearEditProgressTimer() {
    if (editProgressTimer) {
      clearInterval(editProgressTimer);
      editProgressTimer = null;
    }
    if (editProgressHideTimer) {
      clearTimeout(editProgressHideTimer);
      editProgressHideTimer = null;
    }
  }

  function setEditProgress(value, text) {
    const safe = Math.max(0, Math.min(100, Math.round(value || 0)));
    editProgressValue = safe;
    if (editProgressBar) {
      editProgressBar.style.width = `${safe}%`;
    }
    if (editProgressText) {
      editProgressText.textContent = text || `编辑中 ${safe}%`;
    }
  }

  function showEditProgress() {
    if (editProgressWrap) {
      editProgressWrap.classList.add('active');
      editProgressWrap.classList.remove('is-success', 'is-error');
    }
    if (editProgressText) {
      editProgressText.classList.add('active');
    }
    setEditProgress(4, '编辑中 4%');
  }

  function hideEditProgress() {
    clearEditProgressTimer();
    if (editProgressWrap) {
      editProgressWrap.classList.remove('active', 'is-success', 'is-error');
    }
    if (editProgressText) {
      editProgressText.classList.remove('active');
      editProgressText.textContent = '编辑中 0%';
    }
    if (editProgressBar) {
      editProgressBar.style.width = '0%';
    }
    editProgressValue = 0;
  }

  function startEditProgress() {
    clearEditProgressTimer();
    showEditProgress();
  }

  function finishEditProgress(success, text) {
    clearEditProgressTimer();
    if (!editProgressWrap) return;
    editProgressWrap.classList.add('active');
    editProgressWrap.classList.remove('is-success', 'is-error');
    editProgressWrap.classList.add(success ? 'is-success' : 'is-error');
    if (editProgressText) {
      editProgressText.classList.add('active');
    }
    setEditProgress(100, text || (success ? '编辑完成 100%' : '编辑失败'));
    editProgressHideTimer = setTimeout(() => {
      hideEditProgress();
      editProgressHideTimer = null;
    }, 900);
  }

  async function readFileAsDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function applySeedImageFile(file, source) {
    if (!file) return;
    if (state.editing) {
      toast('编辑进行中，暂时不能替换首图', 'warning');
      return;
    }
    const mimeType = String(file.type || '');
    if (mimeType && !mimeType.startsWith('image/')) {
      toast('仅支持图片文件', 'warning');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    if (!dataUrl.startsWith('data:image/')) {
      throw new Error('图片格式不受支持');
    }

    state.seedImageBase64 = dataUrl;
    state.seedFileName = file.name || source || '未命名图片';
    clearHistory();
    resetCycle(true);
    setStatus('', '已载入首图，可开始编辑');
    updateMeta();
    toast(`${source || '图片'}已载入，链路已重置`, 'success');
  }

  function setDragActive(active) {
    if (!previewShell) return;
    previewShell.classList.toggle('dragover', Boolean(active));
  }

  function pickImageFileFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return null;
    if (dataTransfer.files && dataTransfer.files.length) {
      for (const file of dataTransfer.files) {
        if (file && String(file.type || '').startsWith('image/')) {
          return file;
        }
      }
    }
    if (dataTransfer.items && dataTransfer.items.length) {
      for (const item of dataTransfer.items) {
        if (!item) continue;
        if (item.kind === 'file') {
          const file = item.getAsFile ? item.getAsFile() : null;
          if (file && String(file.type || '').startsWith('image/')) {
            return file;
          }
        }
      }
    }
    return null;
  }

  function hasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    const types = dataTransfer.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  function updateMeta() {
    if (currentParentId) {
      currentParentId.textContent = state.currentParentPostId || '-';
    }
    if (currentMode) {
      currentMode.textContent = state.currentModeValue || '-';
    }
    if (seedFileName) {
      seedFileName.textContent = state.seedFileName || '未选择文件';
    }
  }

  function setPreview(url) {
    const displayUrl = String(url || '').trim();
    state.currentImageUrl = displayUrl;
    if (!currentImage || !previewEmpty) return;
    if (!displayUrl) {
      currentImage.src = '';
      currentImage.classList.add('hidden');
      previewEmpty.classList.remove('hidden');
      return;
    }
    currentImage.src = displayUrl;
    currentImage.classList.remove('hidden');
    previewEmpty.classList.add('hidden');
  }

  function setEditing(loading) {
    state.editing = Boolean(loading);
    if (submitEditBtn) {
      submitEditBtn.disabled = false;
      submitEditBtn.dataset.running = state.editing ? '1' : '0';
      submitEditBtn.textContent = state.editing ? '中止' : '执行编辑';
      submitEditBtn.classList.toggle('is-editing', state.editing);
      submitEditBtn.removeAttribute('aria-disabled');
    }
    if (selectSeedBtn) selectSeedBtn.disabled = state.editing;
    if (resetCycleBtn) resetCycleBtn.disabled = state.editing;
    if (clearHistoryBtn) clearHistoryBtn.disabled = state.editing;
    if (editPromptInput) editPromptInput.disabled = state.editing;

    if (state.editing) {
      setStatus('running', '编辑中...');
    }
  }

  function forceSubmitButtonAbortClickable() {
    if (!submitEditBtn) return;
    if (!state.editing) return;
    submitEditBtn.disabled = false;
    submitEditBtn.dataset.running = '1';
    submitEditBtn.textContent = '中止';
    submitEditBtn.classList.add('is-editing');
    submitEditBtn.removeAttribute('aria-disabled');
  }

  function setCurrentFromEntry(entry) {
    if (!entry) return;
    state.currentParentPostId = String(entry.parentPostId || '').trim();
    state.currentSourceImageUrl = String(entry.sourceImageUrl || '').trim();
    state.currentModeValue = String(entry.mode || '').trim() || 'parent_post';
    if (parentPostInput) {
      parentPostInput.value = state.currentParentPostId;
    }
    setPreview(entry.imageUrl || '');
    rememberParentPost({
      parentPostId: state.currentParentPostId,
      sourceImageUrl: state.currentSourceImageUrl,
      imageUrl: entry.imageUrl || '',
      origin: 'workbench_history_apply',
    });
    updateMeta();
    setStatus('done', `已切换到历史版本 #${entry.round}`);
  }

  function renderHistory() {
    if (!historyList || !historyEmpty || !historyCount) return;
    historyList.innerHTML = '';
    historyCount.textContent = `${state.history.length} 条`;

    if (!state.history.length) {
      historyEmpty.classList.remove('hidden');
      return;
    }
    historyEmpty.classList.add('hidden');

    state.history.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const thumb = document.createElement('img');
      thumb.className = 'history-thumb';
      thumb.src = entry.imageUrl || '';
      thumb.alt = `history-${entry.round}`;
      thumb.loading = 'lazy';
      thumb.decoding = 'async';

      const main = document.createElement('div');
      main.className = 'history-main';

      const line1 = document.createElement('div');
      line1.className = 'history-line';
      line1.innerHTML = `<strong>#${entry.round}</strong> 路 ${formatTime(entry.createdAt)} 路 ${entry.elapsedMs}ms`;

      const line2 = document.createElement('div');
      line2.className = 'history-line';
      line2.innerHTML = `mode=<strong>${entry.mode}</strong> 路 parentPostId=<strong>${shortId(entry.parentPostId)}</strong>`;

      const prompt = document.createElement('div');
      prompt.className = 'history-prompt';
      prompt.textContent = maskPrompt(entry.prompt);

      const actions = document.createElement('div');
      actions.className = 'history-actions';

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'geist-button-outline';
      applyBtn.textContent = '设为当前';
      applyBtn.addEventListener('click', () => {
        setCurrentFromEntry(entry);
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'geist-button-outline';
      copyBtn.textContent = '复制ID';
      copyBtn.addEventListener('click', async () => {
        try {
          if (!entry.parentPostId) {
            toast('当前记录没有 parentPostId', 'warning');
            return;
          }
          const copied = await copyText(entry.parentPostId);
          if (!copied) {
            throw new Error('copy_failed');
          }
          toast('已复制 parentPostId', 'success');
        } catch (e) {
          toast('复制失败', 'error');
        }
      });

      actions.appendChild(applyBtn);
      actions.appendChild(copyBtn);

      main.appendChild(line1);
      main.appendChild(line2);
      main.appendChild(prompt);
      main.appendChild(actions);

      item.appendChild(thumb);
      item.appendChild(main);
      historyList.appendChild(item);
    });
  }

  function resetCycle(keepSeedPreview = true) {
    state.currentParentPostId = '';
    state.currentSourceImageUrl = '';
    state.currentModeValue = 'upload';
    if (parentPostInput) {
      parentPostInput.value = '';
    }
    updateMeta();

    if (keepSeedPreview && state.seedImageBase64) {
      setPreview(state.seedImageBase64);
    } else {
      setPreview('');
    }
    setStatus('', '未开始');
  }

  function clearHistory() {
    state.history = [];
    state.editRound = 0;
    renderHistory();
  }

  async function parseErrorText(res) {
    const text = await res.text();
    if (!text) return `请求失败：HTTP ${res.status}`;
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && data.detail) {
        return String(data.detail);
      }
    } catch (e) {
      // ignore
    }
    return text;
  }

  async function requestWorkbenchEditStream(authHeader, body, onProgress, signal) {
    const payload = {
      ...body,
      stream: true,
    };
    const res = await fetch('/v1/public/imagine/workbench/edit', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      throw new Error(await parseErrorText(res));
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
      return await res.json();
    }

    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      throw new Error('stream_not_supported');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalResult = null;
    let finalError = '';

    function handleChunk(chunkText) {
      let eventName = 'message';
      const dataLines = [];
      const lines = String(chunkText || '').split('\n');
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (!dataLines.length) return;
      let eventPayload = null;
      try {
        eventPayload = JSON.parse(dataLines.join('\n'));
      } catch (e) {
        return;
      }
      if (eventName === 'progress') {
        if (onProgress && typeof onProgress === 'function') {
          onProgress(eventPayload || {});
        }
      } else if (eventName === 'result') {
        finalResult = eventPayload || {};
      } else if (eventName === 'error') {
        finalError = String((eventPayload && eventPayload.message) || 'workbench_edit_failed');
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleChunk(block);
      }
    }

    if (buffer.trim()) {
      handleChunk(buffer);
      buffer = '';
    }

    if (finalError) {
      throw new Error(finalError);
    }
    if (finalResult) {
      return finalResult;
    }
    throw new Error('workbench_edit_stream_empty_result');
  }

  async function ensurePublicAuth() {
    if (typeof ensurePublicKey !== 'function') {
      throw new Error('鉴权脚本未加载');
    }
    const authHeader = await ensurePublicKey();
    if (authHeader === null) {
      throw new Error('请先登录公开页面');
    }
    return authHeader;
  }

  async function runEdit() {
    if (state.editing) {
      if (workbenchEditAbortController) {
        workbenchEditAbortController.abort();
      }
      return;
    }

    const prompt = String(editPromptInput ? editPromptInput.value : '').trim();
    if (!prompt) {
      toast('请输入编辑提示词', 'warning');
      return;
    }

    if (!state.currentParentPostId && !state.seedImageBase64) {
      toast('请先上传首图', 'warning');
      return;
    }

    let authHeader = '';
    try {
      authHeader = await ensurePublicAuth();
    } catch (e) {
      toast(String(e.message || e), 'error');
      if (String(e.message || '').includes('登录')) {
        window.location.href = '/login';
      }
      return;
    }

    const body = {
      prompt,
    };

    if (state.currentParentPostId) {
      body.parent_post_id = state.currentParentPostId;
      if (state.currentSourceImageUrl) {
        body.source_image_url = state.currentSourceImageUrl;
      }
    } else {
      body.image_base64 = state.seedImageBase64;
    }

    setEditing(true);
    forceSubmitButtonAbortClickable();
    startEditProgress();
    workbenchEditAbortController = new AbortController();

    try {
      const payload = await requestWorkbenchEditStream(authHeader, body, (evt) => {
        forceSubmitButtonAbortClickable();
        const next = Number(evt && evt.progress ? evt.progress : 0);
        const message = String((evt && evt.message) || '').trim();
        if (Number.isFinite(next) && next > 0) {
          const safe = Math.max(editProgressValue, Math.min(99, next));
          setEditProgress(safe, message ? `${message} · ${safe}%` : `编辑中 ${safe}%`);
          setStatus('running', message || `编辑中 ${safe}%`);
        } else if (message) {
          setEditProgress(editProgressValue, message);
          setStatus('running', message);
        }
      }, workbenchEditAbortController ? workbenchEditAbortController.signal : undefined);
      const imageUrl = String(payload?.data?.[0]?.url || '').trim();
      if (!imageUrl) {
        throw new Error('返回结果缺少图片 URL');
      }

      const previousParentPostId = state.currentParentPostId;
      const generatedParent = String(
        payload.current_parent_post_id
        || payload.generated_parent_post_id
        || payload.input_parent_post_id
        || extractParentPostId(imageUrl)
      ).trim();
      const resolvedParentPostId = generatedParent || previousParentPostId;

      const sourceImageUrl = pickSourceImageUrl(
        {
          current_source_image_url: payload.current_source_image_url,
          source_image_url: payload.source_image_url,
          imageUrl,
        },
        resolvedParentPostId,
        state.currentSourceImageUrl
      );

      const mode = String(payload.mode || (state.currentParentPostId ? 'parent_post' : 'upload')).trim();
      const elapsedMs = Number(payload.elapsed_ms || 0);

      state.currentParentPostId = resolvedParentPostId;
      state.currentSourceImageUrl = sourceImageUrl;
      state.currentModeValue = mode || 'parent_post';
      if (parentPostInput) {
        parentPostInput.value = state.currentParentPostId || '';
      }
      setPreview(imageUrl);
      updateMeta();

      state.editRound += 1;
      const entry = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        round: state.editRound,
        prompt,
        mode: state.currentModeValue,
        imageUrl,
        parentPostId: resolvedParentPostId,
        sourceImageUrl,
        elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
        createdAt: Date.now(),
      };
      state.history.unshift(entry);
      renderHistory();
      rememberParentPost({
        parentPostId: resolvedParentPostId,
        sourceImageUrl,
        imageUrl,
        origin: 'workbench_edit',
      });

      finishEditProgress(true, '编辑完成 100%');
      setStatus('done', `编辑完成 · round #${entry.round}`);
      toast('编辑成功，已更新当前画面', 'success');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        finishEditProgress(false, '已中止');
        setStatus('error', '已中止');
        toast('已中止编辑', 'warning');
      } else {
        finishEditProgress(false, '编辑失败');
        setStatus('error', '编辑失败');
        toast(String(e.message || e), 'error');
      }
    } finally {
      workbenchEditAbortController = null;
      setEditing(false);
    }
  }

  function bindEvents() {
    if (selectSeedBtn && seedImageInput) {
      selectSeedBtn.addEventListener('click', () => {
        seedImageInput.click();
      });

      seedImageInput.addEventListener('change', async (event) => {
        const file = event.target && event.target.files ? event.target.files[0] : null;
        if (!file) return;

        try {
          await applySeedImageFile(file, '本地图像');
        } catch (e) {
          toast(String(e.message || e), 'error');
        } finally {
          seedImageInput.value = '';
        }
      });
    }

    if (submitEditBtn) {
      submitEditBtn.addEventListener('click', runEdit);
    }

    if (applyParentBtn) {
      applyParentBtn.addEventListener('click', () => {
        applyParentPostFromText(parentPostInput ? parentPostInput.value : '');
      });
    }

    if (parentPostInput) {
      parentPostInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          applyParentPostFromText(parentPostInput.value);
        }
      });
      parentPostInput.addEventListener('input', () => {
        const raw = parentPostInput.value.trim();
        if (!raw) return;
        applyParentPostFromText(raw, { silent: true });
      });
      parentPostInput.addEventListener('paste', (event) => {
        const text = String(event.clipboardData ? event.clipboardData.getData('text') || '' : '').trim();
        if (!text) return;
        event.preventDefault();
        parentPostInput.value = text;
        applyParentPostFromText(text, { silent: true });
      });
    }

    if (editPromptInput) {
      editPromptInput.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          runEdit();
        }
      });
    }

    if (resetCycleBtn) {
      resetCycleBtn.addEventListener('click', () => {
        resetCycle(true);
        toast('已重置编辑链路', 'success');
      });
    }

    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => {
        clearHistory();
        toast('历史记录已清空', 'success');
      });
    }

    document.addEventListener('paste', async (event) => {
      const dataTransfer = event.clipboardData;
      const file = pickImageFileFromDataTransfer(dataTransfer);
      if (file) {
        event.preventDefault();
        try {
          await applySeedImageFile(file, '粘贴图片');
        } catch (e) {
          toast(String(e.message || e), 'error');
        }
        return;
      }
      const text = dataTransfer ? String(dataTransfer.getData('text') || '').trim() : '';
      if (!text) return;
      const target = event.target;
      const isTypingInPrompt = target === editPromptInput;
      const isTypingInParentInput = target === parentPostInput;
      if (isTypingInPrompt) return;
      if (!isTypingInParentInput && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        return;
      }
      const ok = applyParentPostFromText(text, { silent: true });
      if (ok) {
        event.preventDefault();
      }
    });

    if (previewShell) {
      previewShell.addEventListener('dragenter', (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragCounter += 1;
        setDragActive(true);
      });

      previewShell.addEventListener('dragover', (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
        setDragActive(true);
      });

      previewShell.addEventListener('dragleave', (event) => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) {
          setDragActive(false);
        }
      });

      previewShell.addEventListener('drop', async (event) => {
        event.preventDefault();
        dragCounter = 0;
        setDragActive(false);
        const file = pickImageFileFromDataTransfer(event.dataTransfer);
        if (!file) {
          toast('未检测到可用图片文件', 'warning');
          return;
        }
        try {
          await applySeedImageFile(file, '拖拽图片');
        } catch (e) {
          toast(String(e.message || e), 'error');
        }
      });
    }

    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
    });

    window.addEventListener('drop', (event) => {
      if (!hasFiles(event.dataTransfer)) return;
      if (previewShell && previewShell.contains(event.target)) {
        return;
      }
      event.preventDefault();
      setDragActive(false);
      dragCounter = 0;
    });
  }

  function mountInlineSubmitButton() {
    if (!editPromptInput || !submitEditBtn) return false;
    const promptWrap = editPromptInput.closest('.prompt-enhance-wrap');
    if (!promptWrap) return false;
    if (!promptWrap.contains(submitEditBtn)) {
      const actionRow = submitEditBtn.parentElement;
      promptWrap.appendChild(submitEditBtn);
      if (actionRow && actionRow.classList && actionRow.classList.contains('action-row')) {
        actionRow.classList.add('action-row-inline');
      }
    }
    submitEditBtn.classList.add('inline-submit-btn');
    return true;
  }

  function ensureInlineSubmitButton(attempt = 0) {
    if (mountInlineSubmitButton()) return;
    if (attempt >= 20) return;
    setTimeout(() => ensureInlineSubmitButton(attempt + 1), 50);
  }

  function init() {
    ensureInlineSubmitButton();
    bindEvents();
    renderHistory();
    resetCycle(false);
    updateMeta();
  }

  init();
})();



