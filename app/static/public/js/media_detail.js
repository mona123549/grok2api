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
  const detailVideoScrollbar = document.getElementById('detailVideoScrollbar');
  const detailVideoScrollbarThumb = detailVideoScrollbar ? detailVideoScrollbar.querySelector('.md-video-scrollbar-thumb') : null;
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

  // Build tag (for verifying frontend update on server)
  const BUILD_TAG = '0018';

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

  function ensureBuildTagVisible() {
    if (!detailVideoStatusText) return;

    const meta = detailVideoStatusText.parentElement;
    if (!meta) return;

    // Avoid duplicates (in case init runs again via BFCache)
    if (meta.querySelector('[data-role="build-tag"]')) return;

    const tag = document.createElement('span');
    tag.setAttribute('data-role', 'build-tag');
    tag.textContent = BUILD_TAG;

    // Inline styles: keep this self-contained so it's obvious even if CSS is cached elsewhere.
    tag.style.marginLeft = '8px';
    tag.style.padding = '2px 8px';
    tag.style.borderRadius = '999px';
    tag.style.border = '1px solid var(--border)';
    tag.style.background = 'var(--md-surface)';
    tag.style.color = 'var(--accents-4)';
    tag.style.fontSize = '11px';
    tag.style.fontWeight = '700';
    tag.style.fontFamily = "'Geist Mono', ui-monospace, monospace";
    tag.style.lineHeight = '1.4';
    tag.title = `build ${BUILD_TAG}`;

    meta.appendChild(tag);
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


  function bindCustomVideoScrollbar() {
    if (!detailVideoResults || !detailVideoScrollbar || !detailVideoScrollbarThumb) return;

    let dragging = false;
    let dragStartY = 0;
    let dragStartThumbTop = 0;
    let activePointerId = null;

    const TRACK_PADDING = 10; // must match CSS top/bottom padding in ::before

    const getMetrics = () => {
      const scrollEl = detailVideoResults;
      const scrollH = Math.max(0, scrollEl.scrollHeight || 0);
      const clientH = Math.max(1, scrollEl.clientHeight || 1);

      const trackRect = detailVideoScrollbar.getBoundingClientRect();
      const trackH = Math.max(0, trackRect.height - (TRACK_PADDING * 2));

      return { scrollH, clientH, trackH, trackRect };
    };

    const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

    const getCurrentThumbTop = () => {
      // Thumb top relative to scrollable track area (excluding padding)
      const styleTop = parseFloat(String(detailVideoScrollbarThumb.style.top || ''));
      if (Number.isFinite(styleTop)) {
        return Math.max(0, styleTop - TRACK_PADDING);
      }

      // Fallback: measure DOM
      const { trackRect } = getMetrics();
      const thumbRect = detailVideoScrollbarThumb.getBoundingClientRect();
      return Math.max(0, (thumbRect.top - trackRect.top) - TRACK_PADDING);
    };

    const updateThumb = () => {
      const { scrollH, clientH, trackH } = getMetrics();
      const maxScroll = Math.max(0, scrollH - clientH);

      // Hide thumb if not scrollable
      if (maxScroll <= 0 || trackH <= 0) {
        detailVideoScrollbarThumb.style.display = 'none';
        return;
      }
      detailVideoScrollbarThumb.style.display = '';

      const ratioVisible = clamp(clientH / scrollH, 0, 1);
      const thumbH = Math.max(24, Math.round(trackH * ratioVisible));
      const maxThumbTop = Math.max(0, trackH - thumbH);

      const scrollTop = Math.max(0, Number(detailVideoResults.scrollTop || 0));
      const t = maxScroll > 0 ? (scrollTop / maxScroll) : 0;
      const thumbTop = Math.round(maxThumbTop * t);

      detailVideoScrollbarThumb.style.height = `${thumbH}px`;
      detailVideoScrollbarThumb.style.top = `${TRACK_PADDING + thumbTop}px`;
    };

    const scrollToThumbPosition = (thumbTopPx, { snap = false } = {}) => {
      const { scrollH, clientH, trackH } = getMetrics();
      const maxScroll = Math.max(0, scrollH - clientH);
      if (maxScroll <= 0 || trackH <= 0) return;

      const thumbH = Math.max(24, detailVideoScrollbarThumb.offsetHeight || 24);
      const maxThumbTop = Math.max(0, trackH - thumbH);

      const thumbTop = clamp(thumbTopPx, 0, maxThumbTop);
      const t = maxThumbTop > 0 ? (thumbTop / maxThumbTop) : 0;

      const nextScrollTop = Math.round(maxScroll * t);
      if (snap) {
        detailVideoResults.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
      } else {
        detailVideoResults.scrollTop = nextScrollTop;
      }
    };

    // Sync on scroll
    detailVideoResults.addEventListener('scroll', () => {
      if (dragging) return;
      updateThumb();
    });

    // Drag thumb (during dragging, we must ALSO move the thumb itself; scroll handler is suppressed)
    const onPointerMove = (e) => {
      if (!dragging) return;

      const { trackH } = getMetrics();
      const thumbH = Math.max(24, detailVideoScrollbarThumb.offsetHeight || 24);
      const maxThumbTop = Math.max(0, trackH - thumbH);

      const dy = (e.clientY - dragStartY);
      const desiredTop = dragStartThumbTop + dy;
      const nextThumbTop = clamp(desiredTop, 0, maxThumbTop);

      // Move thumb visually
      detailVideoScrollbarThumb.style.top = `${TRACK_PADDING + Math.round(nextThumbTop)}px`;

      // Scroll content accordingly
      scrollToThumbPosition(nextThumbTop, { snap: false });

      e.preventDefault();
    };

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;

      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', stopDrag);
      document.removeEventListener('pointercancel', stopDrag);

      // best-effort release pointer capture
      try {
        if (typeof activePointerId === 'number') {
          detailVideoScrollbarThumb.releasePointerCapture(activePointerId);
        }
      } catch (err) {
        // ignore
      }

      activePointerId = null;

      // Re-sync thumb with scrollTop
      updateThumb();
    };

    detailVideoScrollbarThumb.addEventListener('pointerdown', (e) => {
      dragging = true;
      activePointerId = e.pointerId;
      dragStartY = e.clientY;

      // Ensure thumb is up-to-date before reading position
      updateThumb();
      dragStartThumbTop = getCurrentThumbTop();

      try {
        detailVideoScrollbarThumb.setPointerCapture(e.pointerId);
      } catch (err) {
        // ignore
      }
      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', stopDrag);
      document.addEventListener('pointercancel', stopDrag);
      e.preventDefault();
      e.stopPropagation();
    });

    // Click track to jump (center thumb on click)
    detailVideoScrollbar.addEventListener('click', (e) => {
      if (dragging) return;

      const target = e.target;
      if (target === detailVideoScrollbarThumb) return;

      const rect = detailVideoScrollbar.getBoundingClientRect();
      const rawY = e.clientY - rect.top - TRACK_PADDING;

      const thumbH = Math.max(24, detailVideoScrollbarThumb.offsetHeight || 24);
      const desiredTop = rawY - (thumbH / 2);

      scrollToThumbPosition(desiredTop, { snap: true });
    });

    // Recalc on resize
    window.addEventListener('resize', () => updateThumb());

    // Observe content changes
    try {
      const ro = new ResizeObserver(() => updateThumb());
      ro.observe(detailVideoResults);
    } catch (e) {
      // ignore
    }

    // Initial
    updateThumb();
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

    // Extract url from the returned HTML without keeping an embedded <video> in the list.
    let url = '';
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = String(html || '');
      const videoEl = tmp.querySelector('video');
      if (videoEl) {
        const source = videoEl.querySelector('source');
        if (source && source.getAttribute('src')) url = source.getAttribute('src');
        else if (videoEl.getAttribute('src')) url = videoEl.getAttribute('src');
      }
    } catch (e) {
      url = '';
    }

    const normalized = normalizeLocalVideoFileUrl(url);
    const finalUrl = normalized || url;

    // Keep the static thumb; only update overlay text.
    setVideoThumbOverlay(item, finalUrl ? '点击播放' : '完成');

    bindVideoLinks(item, finalUrl);
    setVideoItemStatus(item, '完成', 'done');
  }

  function renderVideoUrl(item, url) {
    const body = item && item.querySelector ? item.querySelector('.media-detail-video-item-body') : null;
    if (!body) return;

    const raw = String(url || '').trim();
    const normalized = normalizeLocalVideoFileUrl(raw);
    const safe = normalized || raw;

    setVideoThumbOverlay(item, safe ? '点击播放' : '完成');

    bindVideoLinks(item, safe);
    setVideoItemStatus(item, '完成', 'done');
  }

  let currentVideoRunListEl = null;

  // Use the current image as the lightweight thumbnail for all video task cards.
  // This avoids embedding <video> in the left list (performance + layout stability).
  let currentVideoThumbUrl = '';

  function setVideoThumbUrl(url) {
    currentVideoThumbUrl = String(url || '').trim();
  }

  function setVideoThumbOverlay(item, text) {
    if (!item || !item.querySelector) return;
    const el = item.querySelector('.media-detail-video-thumb-overlay');
    if (!el) return;
    el.textContent = String(text || '').trim();
  }

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
    // Kept for backward compatibility, but current UI no longer groups by "runs".
    // (Users found "本次生成（X 路）" unnecessary and visually noisy.)
    if (!detailVideoResults) return null;

    const runId = `run_${Date.now()}`;
    const wrap = document.createElement('details');
    wrap.className = 'media-detail-video-run';
    wrap.dataset.runId = runId;
    wrap.open = true;

    const promptText = String(prompt || '').trim();
    const summaryPrompt = promptText ? promptText.slice(0, 60) : '';

    wrap.innerHTML = `
      <summary class="media-detail-video-run-summary">
        <div class="media-detail-video-run-title">视频结果</div>
        <div class="media-detail-video-run-meta">${formatRunTime(Date.now())}${summaryPrompt ? ` · ${summaryPrompt}` : ''}</div>
      </summary>
      <div class="media-detail-video-run-body">
        <div class="media-detail-video-run-list"></div>
      </div>
    `;

    detailVideoResults.prepend(wrap);
    collapseOlderVideoRuns(wrap);

    return wrap.querySelector('.media-detail-video-run-list');
  }

  function createVideoCard(index, taskId, containerEl, thumbUrl) {
    const container = containerEl || detailVideoResults;
    if (!container) return null;

    const item = document.createElement('div');
    item.className = 'media-detail-video-item';
    item.dataset.taskId = String(taskId || '').trim();

    // Requirement: video thumbnail cards must be stable and must NOT show hover popovers/actions.
    item.innerHTML = `
      <div class="media-detail-video-item-head">
        <div class="media-detail-video-item-status running">排队中</div>
      </div>
      <div class="media-detail-video-item-body">
        <div class="media-detail-video-thumb" aria-hidden="true">
          <img class="media-detail-video-thumb-img" alt="" loading="lazy" decoding="async">
          <div class="media-detail-video-thumb-overlay">生成中</div>
        </div>
      </div>
    `;

    const img = item.querySelector('.media-detail-video-thumb-img');
    if (img && thumbUrl) {
      try {
        img.src = String(thumbUrl || '').trim();
      } catch (e) {
        // ignore
      }
    }

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

    const rawParallel = parseInt(String(detailVideoParallelSelect ? detailVideoParallelSelect.value : '1'), 10);
    const requestedParallel = Number.isFinite(rawParallel) ? rawParallel : 1;

    const maxParallelFromAttr = parseInt(String(detailVideoParallelSelect && detailVideoParallelSelect.getAttribute ? (detailVideoParallelSelect.getAttribute('max') || '') : ''), 10);
    const maxParallel = (Number.isFinite(maxParallelFromAttr) && maxParallelFromAttr > 0) ? maxParallelFromAttr : 8;

    const parallel = Math.max(1, Math.min(maxParallel, requestedParallel || 1));

    // Keep UI value consistent after clamping (best-effort)
    if (detailVideoParallelSelect) {
      try {
        detailVideoParallelSelect.value = String(parallel);
      } catch (e) {
        // ignore
      }
    }

    if (requestedParallel > maxParallel) {
      toast(`并发过高，已限制为 ${maxParallel}`, 'warning');
    }

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

    let taskIds = [];
    try {
      const resp = await createVideoTask(authHeader, { ...payload, concurrent: parallel });

      const list = (resp && Array.isArray(resp.task_ids)) ? resp.task_ids : [];
      const single = String(resp && resp.task_id ? resp.task_id : '').trim();

      taskIds = (list && list.length ? list : (single ? [single] : []))
        .map((id) => String(id || '').trim())
        .filter(Boolean);
    } catch (e) {
      taskIds = [];
    }

    if (!taskIds.length) {
      setVideoStatus('创建失败');
      setVideoButtons(false);
      toast('视频任务创建失败', 'error');
      return;
    }

    // No run grouping: cards are appended directly into the left list (cleaner UI).
    currentVideoRunListEl = detailVideoResults;

    if (detailVideoEmpty) detailVideoEmpty.classList.add('hidden');

    videoState.running = true;
    videoState.taskIds = taskIds.slice();
    setVideoButtons(true);
    setVideoStatus('运行中');

    if (taskIds.length < parallel) {
      toast(`仅创建了 ${taskIds.length}/${parallel} 个任务`, 'warning');
    }

    taskIds.forEach((taskId, idx) => {
      const card = createVideoCard(idx + 1, taskId, currentVideoRunListEl, currentVideoThumbUrl);
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

    // Requirement: left video list is for selection + preview only.
    // No hover popovers, and no per-card download/favorite actions here.
    detailVideoResults.addEventListener('click', async (event) => {
      const target = event && event.target ? event.target : null;
      if (!(target instanceof HTMLElement)) return;

      const card = target.closest('.media-detail-video-item');
      if (!card) return;

      const url = String(card.dataset.videoUrl || '').trim();
      if (!url) return;

      // Update selected style
      const prev = detailVideoResults.querySelectorAll('.media-detail-video-item.is-selected');
      prev.forEach((el) => el.classList.remove('is-selected'));
      card.classList.add('is-selected');

      // Keep selected item visible in filmstrip scroll container
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

    // Restore image as stage main content (replace mode)
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

    // Replace stage content: hide image, show video
    if (detailImage) {
      detailImage.classList.remove('is-visible');
    }
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

  function syncComposerFootprintVar(composerEl) {
    const el = composerEl || document.querySelector('.media-detail-composer');
    if (!(el instanceof HTMLElement)) return;

    const rect = el.getBoundingClientRect();
    const h = Math.max(0, rect && rect.height ? rect.height : (el.offsetHeight || 0));

    let bottom = 0;
    try {
      const cs = window.getComputedStyle ? getComputedStyle(el) : null;
      bottom = cs ? parseFloat(String(cs.bottom || '0')) : 0;
      if (!Number.isFinite(bottom)) bottom = 0;
    } catch (e) {
      bottom = 0;
    }

    // Safety padding: avoid "composer overlaps stage" when zoom/font makes composer taller.
    const footprint = Math.ceil(h + Math.max(0, bottom) + 8);
    if (footprint > 0) {
      document.documentElement.style.setProperty('--md-composer-footprint', `${footprint}px`);
    }
  }

  function bindComposerFootprintObserver() {
    const composer = document.querySelector('.media-detail-composer');
    if (!(composer instanceof HTMLElement)) return;

    const update = () => syncComposerFootprintVar(composer);
    update();

    window.addEventListener('resize', update);

    try {
      const ro = new ResizeObserver(() => update());
      ro.observe(composer);
    } catch (e) {
      // ignore
    }
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

    // Use the same image as the lightweight thumb for video task cards.
    setVideoThumbUrl(finalImageUrl);
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
    bindDetailVideoDownloads();
    bindDetailVideoClearButton();
    bindCustomVideoScrollbar();
    setVideoButtons(false);
    setVideoStatus('未开始');
    ensureBuildTagVisible();
    bindComposerFootprintObserver();

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