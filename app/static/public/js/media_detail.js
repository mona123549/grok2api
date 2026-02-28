(() => {
  const detailImage = document.getElementById('detailImage');
  const emptyState = document.getElementById('mediaDetailEmpty');
  const stageVideoWrap = document.getElementById('detailStageVideoWrap');
  const stageVideoFrame = document.getElementById('detailStageVideoFrame');
  const stageVideo = document.getElementById('detailStageVideo');

  const imageUrlText = document.getElementById('imageUrlText');
  const imageIdText = document.getElementById('imageIdText');
  const sourceUrlText = document.getElementById('sourceUrlText');
  const promptText = document.getElementById('promptText');

  const backBtn = document.getElementById('backBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyMainBtn = document.getElementById('copyMainBtn');
  const upscaleBtn = document.getElementById('upscaleBtn');
  const favoriteBtn = document.getElementById('favoriteBtn');
  const editImageBtn = document.getElementById('editImageBtn');

  const copyUrlBtn = document.getElementById('copyUrlBtn');
  const copyIdBtn = document.getElementById('copyIdBtn');
  const copySourceBtn = document.getElementById('copySourceBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');

  // T8: video composer (detail page)
  const detailVideoPromptInput = document.getElementById('detailVideoPromptInput');
  const detailVideoStartBtn = document.getElementById('detailVideoStartBtn');
  const detailVideoStopBtn = document.getElementById('detailVideoStopBtn');
  const detailVideoAdvancedToggle = document.getElementById('detailVideoAdvancedToggle');
  const detailVideoAdvancedPanel = document.getElementById('detailVideoAdvancedPanel');
  const detailVideoAdvancedPopoverRoot = document.getElementById('detailVideoAdvancedPopover');
  const detailVideoStatusText = document.getElementById('detailVideoStatusText');
  const detailVideoEmpty = document.getElementById('detailVideoEmpty');
  const detailVideoResults = document.getElementById('detailVideoResults');
  const detailLeftScrollSensor = document.getElementById('detailLeftScrollSensor');
  const detailVideoClearBtn = document.getElementById('detailVideoClearBtn');

  // T6/T7: clear confirm modal
  const detailVideoClearModal = document.getElementById('detailVideoClearModal');
  const detailVideoClearModalCancel = document.getElementById('detailVideoClearModalCancel');
  const detailVideoClearModalConfirm = document.getElementById('detailVideoClearModalConfirm');

  const detailVideoRatioSelect = document.getElementById('detailVideoRatioSelect');
  const detailVideoParallelSelect = document.getElementById('detailVideoParallelSelect');
  const detailVideoLengthSelect = document.getElementById('detailVideoLengthSelect');
  const detailVideoResolutionSelect = document.getElementById('detailVideoResolutionSelect');
  const detailVideoPresetSelect = document.getElementById('detailVideoPresetSelect');

  const SETTINGS_STORAGE_KEY = 'media_settings_v1';
  const UPSCALE_KEY = 'media_detail_upscale_enabled_v1';

  // Media detail stage video playback preference (muted/volume)
  const STAGE_PLAYBACK_PREF_KEY = 'media_detail_stage_playback_pref_v1';

  const DESKTOP_MQL = (window.matchMedia && typeof window.matchMedia === 'function')
    ? window.matchMedia('(min-width: 1101px)')
    : null;

  function isDesktopLayout() {
    if (DESKTOP_MQL) return Boolean(DESKTOP_MQL.matches);
    return window.innerWidth >= 1101;
  }

  function ensureItemVisibleInScroller(scroller, item, marginPx = 8) {
    if (!scroller || !item) return;
    if (!(scroller instanceof HTMLElement)) return;
    if (!(item instanceof HTMLElement)) return;

    const margin = Math.max(0, Number(marginPx || 0));

    const s = scroller.getBoundingClientRect();
    const r = item.getBoundingClientRect();

    // If item is above visible area
    if (r.top < s.top + margin) {
      const dy = (s.top + margin) - r.top;
      scroller.scrollTop = scroller.scrollTop - dy;
      return;
    }

    // If item is below visible area
    if (r.bottom > s.bottom - margin) {
      const dy = r.bottom - (s.bottom - margin);
      scroller.scrollTop = scroller.scrollTop + dy;
    }
  }

  const videoState = {
    running: false,
    authHeader: '',
    rawPublicKey: '',
    taskIds: [],
    jobs: new Map(), // taskId -> { item, source, buffer, progressBuffer, collecting, done }
  };

  // Video favorites: video_url -> library item id
  const videoFavoriteByUrl = new Map();
  let videoFavoriteIndexLoaded = false;

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function safeParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function clamp01(value) {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function loadStagePlaybackPref() {
    try {
      const raw = localStorage.getItem(STAGE_PLAYBACK_PREF_KEY);
      const parsed = raw ? safeParseJson(raw) : null;
      if (!parsed || typeof parsed !== 'object') return null;

      const muted = Boolean(parsed.muted);
      const volume = clamp01(parsed.volume);

      return { muted, volume };
    } catch (e) {
      return null;
    }
  }

  function persistStagePlaybackPref(pref) {
    try {
      if (!pref || typeof pref !== 'object') return;
      const muted = Boolean(pref.muted);
      const volume = clamp01(pref.volume);
      localStorage.setItem(STAGE_PLAYBACK_PREF_KEY, JSON.stringify({ muted, volume, ts: Date.now() }));
    } catch (e) {
      // ignore
    }
  }

  function applyStagePlaybackPrefToVideo(videoEl) {
    if (!videoEl) return;
    const pref = loadStagePlaybackPref();
    if (!pref) return;

    try {
      videoEl.muted = Boolean(pref.muted);
    } catch (e) {
      // ignore
    }

    try {
      // volume may throw in some edge cases; best-effort
      videoEl.volume = clamp01(pref.volume);
    } catch (e) {
      // ignore
    }
  }

  let stagePrefPersistTimer = 0;
  function schedulePersistStagePlaybackPrefFromVideo(videoEl) {
    if (!videoEl) return;
    if (stagePrefPersistTimer) clearTimeout(stagePrefPersistTimer);

    stagePrefPersistTimer = setTimeout(() => {
      stagePrefPersistTimer = 0;
      persistStagePlaybackPref({
        muted: Boolean(videoEl.muted),
        volume: clamp01(videoEl.volume),
      });
    }, 160);
  }

  function bindStagePlaybackPrefPersistence() {
    if (!stageVideo) return;

    // Apply last known preference once on init so UI starts consistent.
    applyStagePlaybackPrefToVideo(stageVideo);

    stageVideo.addEventListener('volumechange', () => {
      schedulePersistStagePlaybackPrefFromVideo(stageVideo);
    });
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

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const get = (k) => String(params.get(k) || '').trim();
    return {
      imageUrl: get('image_url') || get('url') || '',
      imageId: get('image_id') || get('id') || '',
      prompt: get('prompt') || '',
      sourceImageUrl: get('source_image_url') || get('source') || '',
      cacheKey: get('cache_key') || '',
      focus: get('focus') || '',
    };
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  function buildVideoSseUrl(taskId, rawPublicKey) {
    const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const params = new URLSearchParams();
    params.set('task_id', String(taskId || '').trim());
    params.set('t', String(Date.now()));
    if (rawPublicKey) params.set('public_key', rawPublicKey);
    return `${protocol}://${window.location.host}/v1/public/video/sse?${params.toString()}`;
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

  function setFavoriteUi(on) {
    if (!favoriteBtn) return;
    const isOn = Boolean(on);
    favoriteBtn.classList.toggle('is-favorite-on', isOn);
    favoriteBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    favoriteBtn.textContent = isOn ? '已藏' : '收藏';
    favoriteBtn.title = isOn ? '取消收藏（仍保留记录）' : '收藏入库';
  }

  async function preloadFavoriteIndex() {
    if (favoriteIndexLoaded) return;
    favoriteIndexLoaded = true;

    try {
      const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
      if (authHeader === null) return;

      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('page_size', '200');
      params.set('media_type', 'image');
      params.set('favorite_only', 'true');

      const res = await fetch(`/v1/public/media_library/list?${params.toString()}`, {
        method: 'GET',
        headers: {
          ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
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
    } catch (e) {
      // ignore
    }
  }

  async function favoriteImageItem({ parentPostId, prompt, sourceImageUrl, imageUrl, extra, id }) {
    const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
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
        ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
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
    const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
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
        ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    });

    return res.ok;
  }

  function setVideoStatus(text) {
    if (!detailVideoStatusText) return;
    detailVideoStatusText.textContent = String(text || '').trim() || '未开始';
  }

  function setVideoButtons(running) {
    const on = Boolean(running);
    if (detailVideoStartBtn) {
      detailVideoStartBtn.classList.toggle('hidden', on);
      detailVideoStartBtn.disabled = false;
    }
    if (detailVideoStopBtn) {
      detailVideoStopBtn.classList.toggle('hidden', !on);
      detailVideoStopBtn.disabled = false;
    }
  }

  function bindDetailVideoAdvancedToggle() {
    if (!detailVideoAdvancedToggle || !detailVideoAdvancedPanel || !detailVideoAdvancedPopoverRoot) return;

    let isOpen = false;

    const GAP_PX = 8;
    const PADDING_PX = 10;

    const setOpen = (open) => {
      isOpen = Boolean(open);
      detailVideoAdvancedToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      detailVideoAdvancedPanel.hidden = !isOpen;

      if (!isOpen) {
        detailVideoAdvancedPanel.style.left = '';
        detailVideoAdvancedPanel.style.top = '';
        detailVideoAdvancedPanel.style.width = '';
        detailVideoAdvancedPanel.style.maxWidth = '';
        detailVideoAdvancedPanel.style.maxHeight = '';
        detailVideoAdvancedPanel.style.visibility = '';
      }
    };

    const positionPopover = () => {
      if (!isOpen) return;

      const toggleRect = detailVideoAdvancedToggle.getBoundingClientRect();
      const composerEl = detailVideoAdvancedToggle.closest('.media-detail-composer') || document.querySelector('.media-detail-composer');
      const composerRect = composerEl ? composerEl.getBoundingClientRect() : toggleRect;

      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      // Anchor: right edge of the composer (not the toggle button), so it never covers Stop/Advanced buttons.
      const left = composerRect.right + GAP_PX;
      const availableW = Math.max(0, viewportW - left - PADDING_PX);

      // Make it measurable (without flashing) and apply width constraint before measuring height.
      detailVideoAdvancedPanel.hidden = false;
      detailVideoAdvancedPanel.style.visibility = 'hidden';
      detailVideoAdvancedPanel.style.left = '0px';
      detailVideoAdvancedPanel.style.top = '0px';
      detailVideoAdvancedPanel.style.maxHeight = '';

      const desiredW = 420;
      const effectiveW = Math.max(0, Math.min(desiredW, availableW));
      detailVideoAdvancedPanel.style.width = `${Math.round(effectiveW)}px`;
      detailVideoAdvancedPanel.style.maxWidth = `${Math.round(availableW)}px`;

      const popH = detailVideoAdvancedPanel.offsetHeight || 320;

      // Bottom-align to composer bottom; clamp top and use maxHeight to keep bottom fixed.
      const composerBottom = Math.min(viewportH - PADDING_PX, Math.max(PADDING_PX, composerRect.bottom));

      const desiredTop = composerBottom - popH;
      const maxTop = Math.max(PADDING_PX, composerBottom - PADDING_PX);
      const top = Math.min(Math.max(desiredTop, PADDING_PX), maxTop);

      const maxH = Math.max(0, composerBottom - top);
      detailVideoAdvancedPanel.style.maxHeight = `${Math.round(maxH)}px`;

      detailVideoAdvancedPanel.style.left = `${Math.round(left)}px`;
      detailVideoAdvancedPanel.style.top = `${Math.round(top)}px`;
      detailVideoAdvancedPanel.style.visibility = 'visible';
    };

    const onDocClickCapture = (e) => {
      if (!isOpen) return;
      const target = e && e.target ? e.target : null;
      if (!target) return;

      if (detailVideoAdvancedPanel.contains(target) || detailVideoAdvancedToggle.contains(target)) return;
      setOpen(false);
      unbindGlobalListeners();
    };

    const onKeyDown = (e) => {
      if (!isOpen) return;
      if (!e) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        unbindGlobalListeners();
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

    var unbindGlobalListeners = () => {
      document.removeEventListener('click', onDocClickCapture, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onWindowScroll, true);
    };

    setOpen(false);
    unbindGlobalListeners();

    detailVideoAdvancedToggle.addEventListener('click', () => {
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

  function bindLeftScrollSensorWheel() {
    if (!detailLeftScrollSensor || !detailVideoResults) return;

    const mql = (window.matchMedia && typeof window.matchMedia === 'function')
      ? window.matchMedia('(min-width: 1101px)')
      : null;

    const isDesktop = () => {
      if (mql) return Boolean(mql.matches);
      return window.innerWidth >= 1101;
    };

    detailLeftScrollSensor.addEventListener('wheel', (event) => {
      if (!isDesktop()) return;
      if (!event) return;

      // Avoid interfering with browser zoom gesture (Ctrl+wheel)
      if (event.ctrlKey) return;

      const dxRaw = Number(event.deltaX || 0);
      const dyRaw = Number(event.deltaY || 0);

      // Prefer not hijacking trackpad horizontal scroll
      if (Math.abs(dxRaw) > Math.abs(dyRaw)) return;
      if (!dyRaw) return;

      const scale =
        (event.deltaMode === 1) ? 16 : // lines -> px (best-effort)
          (event.deltaMode === 2) ? Math.max(120, window.innerHeight) : // pages -> px
            1;

      const dy = dyRaw * scale;

      const scroller = detailVideoResults;
      const prev = scroller.scrollTop;

      scroller.scrollTop = prev + dy;

      // Always prevent default to avoid any scroll chaining/overscroll effects.
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });
  }

  function extractParentPostIdFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/^[0-9a-fA-F-]{32,36}$/.test(raw)) return raw;
    const generated = raw.match(/\/generated\/([0-9a-fA-F-]{32,36})(?:\/|$)/);
    if (generated) return generated[1];
    const imaginePublic = raw.match(/\/imagine-public\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/);
    if (imaginePublic) return imaginePublic[1];
    const imagePath = raw.match(/\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/);
    if (imagePath) return imagePath[1];
    const all = raw.match(/([0-9a-fA-F-]{32,36})/g);
    return all && all.length ? all[all.length - 1] : '';
  }

  function normalizeHttpSourceUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('/')) return `${window.location.origin}${raw}`;
    return '';
  }

  function normalizeLocalVideoFileUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    const marker = '/v1/files/video/';

    // Prefer URL parser (handles query/hash reliably)
    try {
      const u = new URL(raw, window.location.origin);
      const idx = u.pathname.indexOf(marker);
      if (idx < 0) return raw;

      let suffix = u.pathname.slice(idx + marker.length);
      suffix = suffix.replace(/^\/+/, '');

      // best-effort decode
      try {
        suffix = decodeURIComponent(suffix);
      } catch (e) {
        // ignore
      }

      // Flatten path segments to match backend cache naming
      suffix = suffix.replace(/[\\/]+/g, '-');

      // Evidence-driven compatibility: some upstream urls end with an extra "I" (e.g. ".mp4I")
      if (/\.mp4i$/i.test(suffix)) {
        suffix = suffix.slice(0, -1);
      }

      // Keep absolute origin if caller provided absolute URL; otherwise keep it relative
      const base = (raw.startsWith('http://') || raw.startsWith('https://')) ? u.origin : '';
      return `${base}${marker}${suffix}`;
    } catch (e) {
      // Fallback: string operations
      const i = raw.indexOf(marker);
      if (i < 0) return raw;

      let suffix = raw.slice(i + marker.length);
      suffix = suffix.split('#')[0].split('?')[0];
      suffix = suffix.replace(/^\/+/, '');

      try {
        suffix = decodeURIComponent(suffix);
      } catch (err) {
        // ignore
      }

      suffix = suffix.replace(/[\\/]+/g, '-');
      if (/\.mp4i$/i.test(suffix)) {
        suffix = suffix.slice(0, -1);
      }

      return `${marker}${suffix}`;
    }
  }

  function buildImaginePublicUrl(parentPostId) {
    const id = String(parentPostId || '').trim();
    if (!id) return '';
    return `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`;
  }

  function resolveVideoSource(data, rawImageUrl) {
    const imageId = String(data && data.imageId ? data.imageId : '').trim();
    const sourceImageUrl = String(data && data.sourceImageUrl ? data.sourceImageUrl : '').trim();
    const imageUrl = String(rawImageUrl || '').trim();

    const parentPostId =
      (imageId && extractParentPostIdFromText(imageId))
      || extractParentPostIdFromText(sourceImageUrl)
      || extractParentPostIdFromText(imageUrl);

    const picked =
      normalizeHttpSourceUrl(sourceImageUrl)
      || normalizeHttpSourceUrl(imageUrl)
      || (parentPostId ? buildImaginePublicUrl(parentPostId) : '');

    return {
      parentPostId: String(parentPostId || '').trim(),
      sourceImageUrl: String(picked || '').trim(),
    };
  }

  function buildImagineWorkbenchUrl({ parentPostId, sourceImageUrl, prompt }) {
    const params = new URLSearchParams();
    const pid = String(parentPostId || '').trim();
    const src = String(sourceImageUrl || '').trim();
    const p = String(prompt || '').trim();

    if (pid) params.set('parent_post_id', pid);
    if (src) params.set('source_image_url', src);
    if (p) params.set('prompt', p);

    const qs = params.toString();
    return qs ? `/imagine-workbench?${qs}` : '/imagine-workbench';
  }

  async function createVideoTask(authHeader, payload) {
    const res = await fetch('/v1/public/video/start', {
      method: 'POST',
      headers: {
        ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      throw new Error(await res.text() || 'video_start_failed');
    }
    return await res.json();
  }

  async function stopVideoTasks(authHeader, taskIds) {
    const normalized = Array.isArray(taskIds)
      ? taskIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    if (!normalized.length) return;
    try {
      await fetch('/v1/public/video/stop', {
        method: 'POST',
        headers: {
          ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task_ids: normalized }),
      });
    } catch (e) {
      // ignore
    }
  }

  function extractVideoInfo(buffer) {
    if (!buffer) return null;
    if (buffer.includes('<video')) {
      const htmlMatches = buffer.match(/<video[\s\S]*?<\/video>/gi);
      if (htmlMatches && htmlMatches.length) {
        return { html: htmlMatches[htmlMatches.length - 1] };
      }
    }
    const mdMatches = buffer.match(/\[video\]\(([^)]+)\)/g);
    if (mdMatches && mdMatches.length) {
      const match = mdMatches[mdMatches.length - 1].match(/\[video\]\(([^)]+)\)/);
      if (match) return { url: match[1] };
    }
    const urlMatches = buffer.match(/https?:\/\/[^\s<)]+/g);
    if (urlMatches && urlMatches.length) {
      return { url: urlMatches[urlMatches.length - 1] };
    }
    return null;
  }

  function setVideoFavoriteUi(item, on) {
    if (!item) return;
    const btn = item.querySelector('[data-role="favorite"]');
    if (!btn) return;
    const isOn = Boolean(on);
    btn.classList.toggle('is-favorite-on', isOn);
    btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    btn.textContent = isOn ? '已藏' : '收藏';
    btn.title = isOn ? '取消收藏（仍保留记录）' : '收藏入库';
  }

  function applyVideoFavoriteStateToItem(item, url) {
    const clean = String(url || '').trim();
    if (!clean || !item) return;
    const libId = String(videoFavoriteByUrl.get(clean) || '').trim();
    if (!libId) return;
    item.dataset.videoLibraryId = libId;
    setVideoFavoriteUi(item, true);
  }

  async function preloadVideoFavoriteIndex(authHeader) {
    if (videoFavoriteIndexLoaded) return;
    videoFavoriteIndexLoaded = true;

    try {
      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('page_size', '200');
      params.set('media_type', 'video');
      params.set('favorite_only', 'true');

      const res = await fetch(`/v1/public/media_library/list?${params.toString()}`, {
        method: 'GET',
        headers: {
          ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
        },
      });
      if (!res.ok) return;

      const data = await res.json();
      const items = Array.isArray(data && data.items) ? data.items : [];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const videoUrl = String(it.video_url || '').trim();
        const id = String(it.id || '').trim();
        if (videoUrl && id) {
          videoFavoriteByUrl.set(videoUrl, id);
        }
      }
    } catch (e) {
      // ignore
    }
  }

  async function favoriteVideoLibraryItem(authHeader, payload) {
    const res = await fetch('/v1/public/media_library/favorite', {
      method: 'POST',
      headers: {
        ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      throw new Error(await res.text() || 'favorite_video_failed');
    }
    const data = await res.json();
    return data && data.item ? data.item : null;
  }

  function bindVideoLinks(item, url) {
    if (!item) return;
    const open = item.querySelector('[data-role="open"]');
    const download = item.querySelector('[data-role="download"]');

    const raw = String(url || '').trim();
    const normalized = normalizeLocalVideoFileUrl(raw);
    const effective = normalized || raw;

    item.dataset.videoUrl = effective;

    if (open) {
      if (effective) {
        open.href = effective;
        open.classList.remove('hidden');
      } else {
        open.classList.add('hidden');
        open.removeAttribute('href');
      }
    }
    if (download) {
      download.disabled = !effective;
      download.dataset.url = effective || '';
    }

    // Keep compatibility for older favorites keyed by raw url
    applyVideoFavoriteStateToItem(item, effective);
    if (raw && raw !== effective) {
      applyVideoFavoriteStateToItem(item, raw);
    }

    // Auto-select the first completed video (best-effort) so stage can preview it.
    if (effective && !currentStageVideoUrl) {
      showStageVideo(effective);
      if (item) {
        const all = document.querySelectorAll('.media-detail-video-item.is-selected');
        all.forEach((el) => el.classList.remove('is-selected'));
        item.classList.add('is-selected');
      }
    }
  }

  function setVideoItemStatus(item, text, cls) {
    if (!item) return;
    const el = item.querySelector('.media-detail-video-item-status');
    if (!el) return;
    el.textContent = String(text || '').trim() || '';
    el.classList.remove('running', 'done', 'error');
    if (cls) el.classList.add(cls);
  }

  function renderVideoHtml(item, html) {
    const body = item && item.querySelector ? item.querySelector('.media-detail-video-item-body') : null;
    if (!body) return;
    body.innerHTML = html;
    const videoEl = body.querySelector('video');
    let url = '';
    if (videoEl) {
      // Keep list preview lightweight; stage will be the main player.
      videoEl.controls = false;
      videoEl.muted = true;
      videoEl.preload = 'metadata';
      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      const source = videoEl.querySelector('source');
      if (source && source.getAttribute('src')) url = source.getAttribute('src');
      else if (videoEl.getAttribute('src')) url = videoEl.getAttribute('src');

      const normalized = normalizeLocalVideoFileUrl(url);
      if (normalized && normalized !== url) {
        if (source && source.getAttribute('src')) source.setAttribute('src', normalized);
        else if (videoEl.getAttribute('src')) videoEl.setAttribute('src', normalized);
        url = normalized;
      }
    }
    bindVideoLinks(item, url);
    setVideoItemStatus(item, '完成', 'done');
  }

  function renderVideoUrl(item, url) {
    const body = item && item.querySelector ? item.querySelector('.media-detail-video-item-body') : null;
    if (!body) return;
    const raw = String(url || '').trim();
    const normalized = normalizeLocalVideoFileUrl(raw);
    const safe = normalized || raw;
    body.innerHTML = `<video preload="metadata" muted playsinline webkit-playsinline><source src="${safe}" type="video/mp4"></video>`;
    bindVideoLinks(item, safe);
    setVideoItemStatus(item, '完成', 'done');
  }

  let currentVideoRunListEl = null;

  function formatRunTime(ts) {
    const t = typeof ts === 'number' ? ts : Date.now();
    try {
      return new Date(t).toLocaleString();
    } catch (e) {
      return String(t);
    }
  }

  function collapseOlderVideoRuns(activeRunEl) {
    if (!detailVideoResults) return;
    const all = detailVideoResults.querySelectorAll('.media-detail-video-run');
    all.forEach((el) => {
      if (el === activeRunEl) return;
      // Only collapse <details> runs.
      if (el instanceof HTMLDetailsElement) {
        el.open = false;
      } else {
        el.classList.add('is-collapsed');
      }
    });
  }

  function createVideoRunGroup({ parallel, prompt }) {
    if (!detailVideoResults) return null;

    const runId = `run_${Date.now()}`;
    const wrap = document.createElement('details');
    wrap.className = 'media-detail-video-run';
    wrap.dataset.runId = runId;
    wrap.open = true;

    const safeParallel = Math.max(1, Math.min(4, parseInt(String(parallel || '1'), 10) || 1));
    const promptText = String(prompt || '').trim();
    const summaryPrompt = promptText ? promptText.slice(0, 60) : '';

    wrap.innerHTML = `
      <summary class="media-detail-video-run-summary">
        <div class="media-detail-video-run-title">本次生成（${safeParallel} 路）</div>
        <div class="media-detail-video-run-meta">${formatRunTime(Date.now())}${summaryPrompt ? ` · ${summaryPrompt}` : ''}</div>
      </summary>
      <div class="media-detail-video-run-body">
        <div class="media-detail-video-run-list"></div>
      </div>
    `;

    // Insert newest run at top; fold older ones to keep list compact.
    detailVideoResults.prepend(wrap);
    collapseOlderVideoRuns(wrap);

    return wrap.querySelector('.media-detail-video-run-list');
  }

  function createVideoCard(index, taskId, containerEl) {
    const container = containerEl || detailVideoResults;
    if (!container) return null;

    const item = document.createElement('div');
    item.className = 'media-detail-video-item';
    item.dataset.taskId = String(taskId || '').trim();

    item.innerHTML = `
      <div class="media-detail-video-item-head">
        <div class="media-detail-video-item-title">任务 ${index}</div>
        <div class="media-detail-video-item-status running">排队中</div>
      </div>
      <div class="media-detail-video-item-body">等待上游返回视频流...</div>
      <div class="media-detail-video-item-actions">
        <a class="geist-button-outline text-xs px-3 hidden" data-role="open" target="_blank" rel="noopener">打开</a>
        <button class="geist-button-outline text-xs px-3" data-role="download" type="button" disabled>下载</button>
        <button class="geist-button-outline text-xs px-3" data-role="favorite" type="button" aria-pressed="false" title="收藏入库">收藏</button>
      </div>
    `;
    container.appendChild(item);
    return item;
  }

  function completeVideoJob(taskId, options) {
    const job = videoState.jobs.get(taskId);
    if (!job || job.done) return;
    job.done = true;

    if (job.source) {
      try {
        job.source.close();
      } catch (e) {
        // ignore
      }
      job.source = null;
    }

    if (options && options.error) {
      setVideoItemStatus(job.item, options.error, 'error');
    } else if (!job.item.dataset.videoUrl) {
      setVideoItemStatus(job.item, '完成（无链接）', 'error');
    } else {
      setVideoItemStatus(job.item, '完成', 'done');
    }

    const allDone = Array.from(videoState.jobs.values()).every((it) => it.done);
    if (allDone) {
      videoState.running = false;
      setVideoButtons(false);
      setVideoStatus('全部完成');
    }
  }

  function handleVideoDelta(taskId, text) {
    if (!text) return;
    const job = videoState.jobs.get(taskId);
    if (!job) return;

    if (text.includes('超分辨率')) {
      setVideoItemStatus(job.item, '超分辨率中', 'running');
      return;
    }

    if (!job.collecting) {
      const mayContainVideo = text.includes('<video') || text.includes('[video](') || text.includes('http://') || text.includes('https://');
      if (mayContainVideo) {
        job.collecting = true;
      }
    }

    if (job.collecting) {
      job.buffer += text;
      const info = extractVideoInfo(job.buffer);
      if (info) {
        if (info.html) renderVideoHtml(job.item, info.html);
        else if (info.url) renderVideoUrl(job.item, info.url);
      }
      return;
    }

    job.progressBuffer += text;
    const matches = [...job.progressBuffer.matchAll(/进度\s*(\d+)%/g)];
    if (matches.length) {
      const value = parseInt(matches[matches.length - 1][1], 10);
      setVideoItemStatus(job.item, `进度 ${value}%`, 'running');
      job.progressBuffer = job.progressBuffer.slice(-160);
    }
  }

  function openVideoStream(taskId, item) {
    const sseUrl = buildVideoSseUrl(taskId, videoState.rawPublicKey);
    const es = new EventSource(sseUrl);

    const job = videoState.jobs.get(taskId);
    if (job) job.source = es;

    es.onopen = () => {
      setVideoItemStatus(item, '生成中', 'running');
    };

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      if (event.data === '[DONE]') {
        completeVideoJob(taskId, null);
        return;
      }

      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (payload && payload.error) {
        completeVideoJob(taskId, { error: '失败' });
        return;
      }

      const choice = payload.choices && payload.choices[0] ? payload.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta : null;

      if (delta && delta.content) {
        handleVideoDelta(taskId, delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        completeVideoJob(taskId, null);
      }
    };

    es.onerror = () => {
      const jobState = videoState.jobs.get(taskId);
      if (!jobState || jobState.done) return;
      completeVideoJob(taskId, { error: '连接异常' });
    };
  }

  async function startDetailVideo(data, rawImageUrl) {
    if (videoState.running) {
      toast('视频任务正在运行中', 'warning');
      return;
    }

    const { parentPostId, sourceImageUrl } = resolveVideoSource(data, rawImageUrl);
    if (!parentPostId) {
      toast('缺少 parentPostId（image_id），无法生成视频', 'error');
      return;
    }

    const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      window.location.href = '/login';
      return;
    }

    // reset run state (do NOT clear history DOM)
    videoState.jobs.clear();
    videoState.taskIds = [];

    videoState.authHeader = authHeader;
    videoState.rawPublicKey = normalizeAuthHeader(authHeader);

    // Preload video favorites so finished cards can auto-highlight.
    preloadVideoFavoriteIndex(authHeader);

    const parallel = Math.max(1, Math.min(4, parseInt(String(detailVideoParallelSelect ? detailVideoParallelSelect.value : '1'), 10) || 1));
    const prompt = String(detailVideoPromptInput ? detailVideoPromptInput.value : '').trim();

    // Reset current run container; create it only after at least one task is created successfully.
    currentVideoRunListEl = null;

    const payload = {
      prompt,
      aspect_ratio: detailVideoRatioSelect ? detailVideoRatioSelect.value : '16:9',
      video_length: parseInt(String(detailVideoLengthSelect ? detailVideoLengthSelect.value : '6'), 10) || 6,
      resolution_name: detailVideoResolutionSelect ? detailVideoResolutionSelect.value : '480p',
      preset: detailVideoPresetSelect ? detailVideoPresetSelect.value : (prompt ? 'custom' : 'spicy'),
      parent_post_id: parentPostId,
      source_image_url: sourceImageUrl || buildImaginePublicUrl(parentPostId),
    };

    const taskIds = [];
    for (let i = 0; i < parallel; i++) {
      try {
        const resp = await createVideoTask(authHeader, payload);
        const taskId = String(resp && resp.task_id ? resp.task_id : '').trim();
        if (!taskId) throw new Error('missing_task_id');
        taskIds.push(taskId);
      } catch (e) {
        toast(`第 ${i + 1} 路视频任务创建失败`, 'error');
        break;
      }
    }

    if (!taskIds.length) {
      setVideoStatus('创建失败');
      setVideoButtons(false);
      return;
    }

    // Create a new run group and append cards into it (newest on top).
    currentVideoRunListEl = createVideoRunGroup({ parallel: taskIds.length, prompt });

    if (detailVideoEmpty) detailVideoEmpty.classList.add('hidden');

    videoState.running = true;
    videoState.taskIds = taskIds.slice();
    setVideoButtons(true);
    setVideoStatus(`运行中（${taskIds.length} 路）`);

    taskIds.forEach((taskId, idx) => {
      const card = createVideoCard(idx + 1, taskId, currentVideoRunListEl);
      if (!card) return;
      videoState.jobs.set(taskId, {
        taskId,
        item: card,
        source: null,
        buffer: '',
        progressBuffer: '',
        collecting: false,
        done: false,
      });
      openVideoStream(taskId, card);
    });
  }

  async function stopDetailVideo(silent) {
    if (!videoState.running && !videoState.taskIds.length) return;

    const runningTaskIds = videoState.taskIds.slice();
    await stopVideoTasks(videoState.authHeader, runningTaskIds);

    videoState.jobs.forEach((job) => {
      if (job.source) {
        try {
          job.source.close();
        } catch (e) {
          // ignore
        }
        job.source = null;
      }
      if (!job.done) {
        job.done = true;
        setVideoItemStatus(job.item, '已中断', 'error');
      }
    });

    videoState.running = false;
    videoState.taskIds = [];
    setVideoButtons(false);
    setVideoStatus('已停止');

    if (!silent) {
      toast('视频任务已中断', 'warning');
    }
  }

  function bindDetailVideoDownloads() {
    if (!detailVideoResults) return;
    detailVideoResults.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const role = target.getAttribute('data-role');

      if (role === 'download') {
        const url = String(target.dataset.url || '').trim();
        if (!url) return;

        try {
          const resp = await fetch(url, { mode: 'cors' });
          if (!resp.ok) throw new Error('download_failed');
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = blobUrl;
          anchor.download = `media_detail_video_${Date.now()}.mp4`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(blobUrl);
        } catch (e) {
          toast('下载失败，请检查链接可访问性', 'error');
        }
        return;
      }

      if (role === 'favorite') {
        const card = target.closest('.media-detail-video-item');
        if (!card) return;

        const url = String(card.dataset.videoUrl || '').trim();
        if (!url) {
          toast('视频尚未生成完成（缺少链接）', 'warning');
          return;
        }

        const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
        if (authHeader === null) {
          toast('请先配置 Public Key', 'error');
          window.location.href = '/login';
          return;
        }

        const currentOn = target.getAttribute('aria-pressed') === 'true';
        target.disabled = true;

        try {
          if (!currentOn) {
            const data = getQueryParams();
            const rawImageUrl = String(data.imageUrl || '').trim();
            const { parentPostId, sourceImageUrl } = resolveVideoSource(data, rawImageUrl);

            const derivedFromId = parentPostId ? `img_${parentPostId}` : '';
            const stableId = `vidu_${hashStringToHex(url)}`;

            const resp = await favoriteVideoLibraryItem(authHeader, {
              id: stableId,
              media_type: 'video',
              prompt: String(detailVideoPromptInput ? detailVideoPromptInput.value : '').trim() || String(data.prompt || '').trim(),
              parent_post_id: String(parentPostId || '').trim(),
              source_image_url: String(sourceImageUrl || '').trim(),
              video_url: url,
              derived_from_id: derivedFromId,
              extra: {
                source: 'media_detail_video',
              },
            });

            const savedId = String(resp && resp.id ? resp.id : stableId).trim();
            if (savedId) {
              card.dataset.videoLibraryId = savedId;
              videoFavoriteByUrl.set(url, savedId);
            }

            setVideoFavoriteUi(card, true);
            toast('视频已收藏', 'success');
          } else {
            const libId = String(card.dataset.videoLibraryId || '').trim() || String(videoFavoriteByUrl.get(url) || '').trim();
            if (!libId) {
              toast('缺少 libraryId，无法取消收藏', 'error');
              return;
            }

            const ok = await unfavoriteLibraryItemById(libId);
            if (!ok) {
              toast('取消收藏失败', 'error');
              return;
            }

            videoFavoriteByUrl.delete(url);
            setVideoFavoriteUi(card, false);
            toast('已取消收藏', 'info');
          }
        } catch (e) {
          toast('收藏操作失败', 'error');
        } finally {
          target.disabled = false;
        }
        return;
      }

      // Select video for stage preview (click anywhere on card except open link)
      const card = target.closest('.media-detail-video-item');
      if (!card) return;
      if (target.closest && (target.closest('[data-role="open"]') || target.closest('a'))) return;

      const url = String(card.dataset.videoUrl || '').trim();
      if (!url) return;

      // Update selected style
      const prev = detailVideoResults.querySelectorAll('.media-detail-video-item.is-selected');
      prev.forEach((el) => el.classList.remove('is-selected'));
      card.classList.add('is-selected');

      // Keep selected item visible in filmstrip scroll container
      // Desktop: only scroll the left scroller to avoid any ancestor scroll/relayout side effects.
      try {
        if (isDesktopLayout() && detailVideoResults) {
          ensureItemVisibleInScroller(detailVideoResults, card, 12);
        } else {
          card.scrollIntoView({ block: 'nearest' });
        }
      } catch (e) {
        // ignore
      }

      showStageVideo(url);
      await attemptStageAutoplayFromUserGesture();
    });
  }

  let clearConfirmResolve = null;
  let clearConfirmOpen = false;
  let clearConfirmLastActive = null;
  let clearConfirmBound = false;

  function setClearConfirmModalOpen(open) {
    if (!detailVideoClearModal) return;
    const on = Boolean(open);
    clearConfirmOpen = on;
    detailVideoClearModal.hidden = !on;
    detailVideoClearModal.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function closeClearConfirmModal(result) {
    if (!clearConfirmOpen) return;
    setClearConfirmModalOpen(false);

    const resolve = clearConfirmResolve;
    clearConfirmResolve = null;

    // Restore focus (best-effort)
    const restoreTarget = clearConfirmLastActive;
    clearConfirmLastActive = null;
    if (restoreTarget && restoreTarget.focus) {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (e) {
        try {
          restoreTarget.focus();
        } catch (err) {
          // ignore
        }
      }
    }

    if (typeof resolve === 'function') resolve(Boolean(result));
  }

  function bindClearConfirmModalOnce() {
    if (clearConfirmBound) return;
    clearConfirmBound = true;

    if (detailVideoClearModalCancel) {
      detailVideoClearModalCancel.addEventListener('click', () => closeClearConfirmModal(false));
    }
    if (detailVideoClearModalConfirm) {
      detailVideoClearModalConfirm.addEventListener('click', () => closeClearConfirmModal(true));
    }

    if (detailVideoClearModal) {
      // Click backdrop to close
      detailVideoClearModal.addEventListener('click', (e) => {
        const target = e && e.target ? e.target : null;
        if (!(target instanceof HTMLElement)) return;
        if (target.getAttribute('data-role') === 'backdrop') {
          closeClearConfirmModal(false);
        }
      });
    }

    // Esc to close
    document.addEventListener('keydown', (e) => {
      if (!clearConfirmOpen) return;
      if (!e) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeClearConfirmModal(false);
      }
    });
  }

  function openClearConfirmModal() {
    bindClearConfirmModalOnce();

    if (!detailVideoClearModal) {
      toast('弹层初始化失败（缺少 modal DOM）', 'error');
      return Promise.resolve(false);
    }

    // If opened again, resolve previous as cancelled.
    if (clearConfirmResolve) {
      try {
        clearConfirmResolve(false);
      } catch (e) {
        // ignore
      }
      clearConfirmResolve = null;
    }

    clearConfirmLastActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setClearConfirmModalOpen(true);

    // Focus cancel by default (or dialog container)
    setTimeout(() => {
      if (detailVideoClearModalCancel && detailVideoClearModalCancel.focus) {
        try {
          detailVideoClearModalCancel.focus({ preventScroll: true });
          return;
        } catch (e) {
          // ignore
        }
        try {
          detailVideoClearModalCancel.focus();
          return;
        } catch (e) {
          // ignore
        }
      }

      const content = detailVideoClearModal.querySelector('.md-modal-content');
      if (content && content instanceof HTMLElement && content.focus) {
        try {
          content.focus({ preventScroll: true });
        } catch (e) {
          try {
            content.focus();
          } catch (err) {
            // ignore
          }
        }
      }
    }, 0);

    return new Promise((resolve) => {
      clearConfirmResolve = resolve;
    });
  }

  function bindDetailVideoClearButton() {
    if (!detailVideoClearBtn) return;

    detailVideoClearBtn.addEventListener('click', async () => {
      const ok = await openClearConfirmModal();
      if (!ok) return;

      // Stop running tasks first (best-effort), then clear UI/state
      await stopDetailVideo(true);

      if (detailVideoResults) detailVideoResults.innerHTML = '';
      if (detailVideoEmpty) detailVideoEmpty.classList.remove('hidden');

      videoState.jobs.clear();
      videoState.taskIds = [];
      videoState.running = false;

      currentVideoRunListEl = null;

      // Clear selection and stage
      clearStageVideo();

      setVideoButtons(false);
      setVideoStatus('未开始');

      toast('已清空视频列表', 'info');
    });
  }

  function formatDisplayValue(value, fallback = '-') {
    const text = String(value || '').trim();
    return text ? text : fallback;
  }

  async function copyText(text) {
    const value = String(text || '').trim();
    if (!value) return false;

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
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

  function buildFilename(imageId, ext) {
    const ts = Date.now();
    const safeId = String(imageId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const suffix = safeId ? `_${safeId}` : '';
    return `media_detail_${ts}${suffix}.${ext || 'jpg'}`;
  }

  async function downloadByUrl(url, filename) {
    const clean = String(url || '').trim();
    if (!clean) throw new Error('empty_url');

    if (clean.startsWith('data:')) {
      const link = document.createElement('a');
      link.href = clean;
      link.download = filename || 'media.png';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    const res = await fetch(clean, { cache: 'no-store' });
    if (!res.ok) throw new Error('download_failed');
    const blob = await res.blob();
    downloadBlob(blob, filename);
  }

  function getUpscaleEnabled() {
    try {
      const legacy = localStorage.getItem(UPSCALE_KEY);
      if (legacy === '1' || legacy === '0') {
        return legacy === '1';
      }
    } catch (e) {
      // ignore
    }

    // Optional: read from media_settings_v1 if present
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const parsed = raw ? safeParseJson(raw) : null;
      if (parsed && typeof parsed.detail_upscale_enabled === 'boolean') {
        return parsed.detail_upscale_enabled;
      }
    } catch (e) {
      // ignore
    }

    return false;
  }

  function setUpscaleEnabled(enabled) {
    const on = Boolean(enabled);

    try {
      localStorage.setItem(UPSCALE_KEY, on ? '1' : '0');
    } catch (e) {
      // ignore
    }

    // Also mirror into media_settings_v1 (best-effort)
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const parsed = raw ? safeParseJson(raw) : null;
      const next = (parsed && typeof parsed === 'object') ? { ...parsed } : { v: 1 };
      next.detail_upscale_enabled = on;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore
    }

    if (upscaleBtn) {
      upscaleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      upscaleBtn.textContent = on ? '超分：开' : '超分：关';
    }
  }

  let currentStageVideoUrl = '';
  let stageAutoplayWarned = false;

  function resetStageAspectRatio() {
    if (!stageVideoFrame) return;
    try {
      stageVideoFrame.style.removeProperty('--md-stage-aspect');
    } catch (e) {
      // ignore
    }
  }

  function applyStageAspectRatioFromVideoMetadata(videoEl) {
    if (!stageVideoFrame || !videoEl) return;
    let w = 0;
    let h = 0;
    try {
      w = Number(videoEl.videoWidth || 0);
      h = Number(videoEl.videoHeight || 0);
    } catch (e) {
      w = 0;
      h = 0;
    }
    if (!(w > 0 && h > 0)) return;

    try {
      stageVideoFrame.style.setProperty('--md-stage-aspect', `${Math.round(w)} / ${Math.round(h)}`);
    } catch (e) {
      // ignore
    }
  }

  function bindStageAspectRatioAuto() {
    if (!stageVideo || !stageVideoFrame) return;

    stageVideo.addEventListener('loadedmetadata', () => {
      applyStageAspectRatioFromVideoMetadata(stageVideo);
    });
  }

  function clearStageVideo() {
    currentStageVideoUrl = '';
    if (stageVideoWrap) stageVideoWrap.hidden = true;

    resetStageAspectRatio();

    if (stageVideo) {
      try {
        stageVideo.pause();
      } catch (e) {
        // ignore
      }
      stageVideo.removeAttribute('src');
      try {
        stageVideo.load();
      } catch (e) {
        // ignore
      }
    }

    // Restore image main visual when closing stage video preview
    if (detailImage && String(detailImage.getAttribute('src') || '').trim()) {
      detailImage.classList.add('is-visible');
    }
  }

  function waitForVideoMetadataOnce(videoEl, timeoutMs = 1200) {
    return new Promise((resolve) => {
      if (!videoEl) return resolve(false);

      // If metadata is already available, no need to wait.
      try {
        if (Number.isFinite(videoEl.duration) && videoEl.readyState >= 1) return resolve(true);
      } catch (e) {
        // ignore
      }

      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(Boolean(ok));
      };

      const onMeta = () => finish(true);
      const onErr = () => finish(false);

      const cleanup = () => {
        try {
          videoEl.removeEventListener('loadedmetadata', onMeta);
          videoEl.removeEventListener('error', onErr);
        } catch (e) {
          // ignore
        }
        clearTimeout(timer);
      };

      videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
      videoEl.addEventListener('error', onErr, { once: true });
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs || 0));
    });
  }

  async function attemptPlayVideoElement(videoEl, { retryOnMetadata = true } = {}) {
    if (!videoEl) return false;
    if (!String(videoEl.getAttribute('src') || '').trim()) return false;

    const playOnce = async () => {
      try {
        const ret = videoEl.play();
        if (ret && typeof ret.then === 'function') {
          await ret;
        }
        return true;
      } catch (e) {
        return false;
      }
    };

    const ok = await playOnce();
    if (ok) return true;

    if (retryOnMetadata) {
      await waitForVideoMetadataOnce(videoEl, 1200);
      return await playOnce();
    }

    return false;
  }

  async function attemptStageAutoplayFromUserGesture() {
    // Called from click handler (user gesture). Browser may still block unmuted autoplay;
    // keep UI working and show a gentle hint once.
    if (!stageVideo) return false;
    const ok = await attemptPlayVideoElement(stageVideo, { retryOnMetadata: true });
    if (!ok && !stageAutoplayWarned) {
      stageAutoplayWarned = true;
      toast('浏览器可能阻止了自动播放，可在舞台手动点击播放', 'info');
    }
    return ok;
  }

  function showStageVideo(url) {
    const clean = String(url || '').trim();
    if (!stageVideo || !stageVideoWrap) return;
    if (!clean) return;

    const normalized = normalizeLocalVideoFileUrl(clean);
    const finalUrl = normalized || clean;

    currentStageVideoUrl = finalUrl;

    // Apply last preference before loading/playing (muted/volume)
    applyStagePlaybackPrefToVideo(stageVideo);

    // Keep image visible behind; stage video is an overlay preview
    stageVideoWrap.hidden = false;

    // Reset aspect while loading; will be updated on loadedmetadata.
    resetStageAspectRatio();

    stageVideo.src = finalUrl;
    try {
      stageVideo.load();
    } catch (e) {
      // ignore
    }
  }

  function showImage(url) {
    const clean = String(url || '').trim();
    if (!detailImage) return;

    // When switching image (or initial load), reset stage video selection
    clearStageVideo();

    if (!clean) {
      detailImage.classList.remove('is-visible');
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    detailImage.src = clean;
    detailImage.classList.add('is-visible');
    if (emptyState) emptyState.style.display = 'none';
  }

  function shortenDataUrlDisplay(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (!raw.startsWith('data:')) return raw;
    const comma = raw.indexOf(',');
    const head = comma >= 0 ? raw.slice(0, comma) : raw.slice(0, 48);
    return `${head},...(base64 已省略；建议使用下载)`;
  }

  function setMeta({ imageUrl, imageId, prompt, sourceImageUrl }) {
    const displayUrl = shortenDataUrlDisplay(imageUrl);
    if (imageUrlText) imageUrlText.textContent = formatDisplayValue(displayUrl);
    if (imageIdText) imageIdText.textContent = formatDisplayValue(imageId);
    if (sourceUrlText) sourceUrlText.textContent = formatDisplayValue(sourceImageUrl);
    if (promptText) promptText.textContent = formatDisplayValue(prompt);
  }

  function bindCopy(btn, getter, successText) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const value = typeof getter === 'function' ? getter() : '';
      if (!String(value || '').trim()) {
        toast('内容为空', 'warning');
        return;
      }
      try {
        const ok = await copyText(value);
        if (!ok) throw new Error('copy_failed');
        toast(successText || '已复制', 'success');
      } catch (e) {
        toast('复制失败', 'error');
      }
    });
  }

  function init() {
    const data = getQueryParams();

    // cache_key fallback for large data URLs (from media.js)
    if (!data.imageUrl && data.cacheKey) {
      try {
        const cached = String(sessionStorage.getItem(data.cacheKey) || '').trim();
        if (cached) {
          data.imageUrl = cached;
        }
      } catch (e) {
        // ignore
      }
    }

    const rawImageUrl = String(data.imageUrl || '').trim();

    // T6: if image_url is missing, fallback to imagine-public derived by image_id
    const fallbackParentPostId = extractParentPostIdFromText(data.imageId);
    const fallbackUrl = (!rawImageUrl && fallbackParentPostId) ? buildImaginePublicUrl(fallbackParentPostId) : '';
    const finalImageUrl = rawImageUrl || fallbackUrl;

    // Also fill sourceImageUrl in meta when missing (so advanced info is not "-")
    const finalSourceImageUrl = String(data.sourceImageUrl || '').trim() || fallbackUrl;

    showImage(finalImageUrl);
    setMeta({ ...data, imageUrl: finalImageUrl, sourceImageUrl: finalSourceImageUrl });

    bindCopy(copyMainBtn, () => finalImageUrl, '已复制图片地址');
    bindCopy(copyUrlBtn, () => finalImageUrl, '已复制图片地址');
    bindCopy(copyIdBtn, () => data.imageId, '已复制 ID');
    bindCopy(copySourceBtn, () => finalSourceImageUrl, '已复制 sourceImageUrl');
    bindCopy(copyPromptBtn, () => data.prompt, '已复制 Prompt');

    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        if (!finalImageUrl) {
          toast('图片地址为空', 'warning');
          return;
        }
        try {
          const ext = inferExtFromUrl(finalImageUrl);
          const filename = buildFilename(data.imageId, ext);
          await downloadByUrl(finalImageUrl, filename);
          toast('已开始下载', 'success');
        } catch (e) {
          toast('下载失败', 'error');
        }
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.href = '/media';
      });
    }

    if (upscaleBtn) {
      upscaleBtn.addEventListener('click', () => {
        const next = !getUpscaleEnabled();
        setUpscaleEnabled(next);
        toast(next ? '已开启超分（仅记录开关）' : '已关闭超分', 'info');
      });
    }

    if (favoriteBtn) {
      favoriteBtn.addEventListener('click', async () => {
        const { parentPostId, sourceImageUrl } = resolveVideoSource(data, finalImageUrl);
        if (!parentPostId) {
          toast('缺少 parentPostId（image_id），无法收藏入库', 'error');
          return;
        }

        const currentOn = favoriteBtn.getAttribute('aria-pressed') === 'true';
        favoriteBtn.disabled = true;

        try {
          if (!currentOn) {
            const stableId = buildStableLibraryIdForImage({ parentPostId, imageUrl: finalImageUrl }) || '';
            const resp = await favoriteImageItem({
              parentPostId,
              prompt: data.prompt,
              sourceImageUrl,
              imageUrl: finalImageUrl,
              id: stableId,
              extra: {
                source: 'media_detail',
              },
            });

            const savedId = String(resp && resp.id ? resp.id : stableId).trim();
            if (savedId) {
              favoriteBtn.dataset.libraryId = savedId;
            }
            favoriteByParentPostId.set(parentPostId, savedId || stableId);

            setFavoriteUi(true);
            toast('已收藏', 'success');
          } else {
            const libraryId =
              String(favoriteBtn.dataset.libraryId || '').trim()
              || String(favoriteByParentPostId.get(parentPostId) || '').trim();

            if (!libraryId) {
              toast('缺少 libraryId，无法取消收藏', 'error');
              return;
            }

            const ok = await unfavoriteLibraryItemById(libraryId);
            if (!ok) {
              toast('取消收藏失败', 'error');
              return;
            }

            setFavoriteUi(false);
            toast('已取消收藏', 'info');
          }
        } catch (e) {
          toast('收藏操作失败', 'error');
        } finally {
          favoriteBtn.disabled = false;
        }
      });
    }

    if (editImageBtn) {
      editImageBtn.addEventListener('click', () => {
        const { parentPostId, sourceImageUrl } = resolveVideoSource(data, finalImageUrl);
        if (!parentPostId) {
          toast('缺少 parentPostId，无法跳转到编辑工作台', 'error');
          return;
        }
        window.location.href = buildImagineWorkbenchUrl({
          parentPostId,
          sourceImageUrl,
          prompt: data.prompt,
        });
      });
    }

    // Initialize favorite state (best-effort preload)
    setFavoriteUi(false);
    preloadFavoriteIndex().then(() => {
      const { parentPostId } = resolveVideoSource(data, finalImageUrl);
      if (!parentPostId) return;
      const libId = String(favoriteByParentPostId.get(parentPostId) || '').trim();
      if (libId) {
        favoriteBtn && (favoriteBtn.dataset.libraryId = libId);
        setFavoriteUi(true);
      }
    });

    // Initialize upscale state
    setUpscaleEnabled(getUpscaleEnabled());

    // Stage playback preference (muted/volume)
    bindStagePlaybackPrefPersistence();

    // T9 (optional): auto aspect-ratio for stage frame based on loadedmetadata
    bindStageAspectRatioAuto();

    // T8 bindings (video composer)
    bindDetailVideoAdvancedToggle();
    bindLeftScrollSensorWheel();
    bindDetailVideoDownloads();
    bindDetailVideoClearButton();
    setVideoButtons(false);
    setVideoStatus('未开始');

    // T10: click backdrop to close stage video preview
    if (stageVideoWrap) {
      stageVideoWrap.addEventListener('click', (event) => {
        const target = event && event.target ? event.target : null;
        if (target !== stageVideoWrap) return;
        clearStageVideo();

        // Clear list selection
        if (detailVideoResults) {
          const selected = detailVideoResults.querySelectorAll('.media-detail-video-item.is-selected');
          selected.forEach((el) => el.classList.remove('is-selected'));
        }
      });
    }

    if (detailVideoStartBtn) {
      detailVideoStartBtn.addEventListener('click', () => {
        startDetailVideo(data, finalImageUrl);
      });
    }
    if (detailVideoStopBtn) {
      detailVideoStopBtn.addEventListener('click', () => {
        stopDetailVideo(false);
      });
    }
    if (detailVideoPromptInput) {
      detailVideoPromptInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          startDetailVideo(data, finalImageUrl);
        }
      });
    }

    // Focus video panel when navigated from /media play button
    if (String(data.focus || '').trim() === 'video') {
      setTimeout(() => {
        const composer = document.querySelector('.media-detail-composer');
        if (composer && composer.scrollIntoView) {
          composer.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
        if (detailVideoPromptInput && detailVideoPromptInput.focus) {
          try {
            detailVideoPromptInput.focus({ preventScroll: true });
          } catch (e) {
            detailVideoPromptInput.focus();
          }
        }
      }, 0);
    }

    window.addEventListener('beforeunload', () => {
      videoState.jobs.forEach((job) => {
        if (job && job.source) {
          try {
            job.source.close();
          } catch (e) {
            // ignore
          }
        }
      });
    });

    // Image load error
    if (detailImage) {
      detailImage.addEventListener('error', () => {
        detailImage.classList.remove('is-visible');
        if (emptyState) emptyState.style.display = 'flex';
        toast('图片加载失败', 'error');
      });
    }
  }

  init();
})();