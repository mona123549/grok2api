(() => {
  const backToMediaBtn = document.getElementById('backToMediaBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  const typeSelect = document.getElementById('typeSelect');
  const favoriteOnlyToggle = document.getElementById('favoriteOnlyToggle');
  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');

  const statusText = document.getElementById('statusText');
  const totalText = document.getElementById('totalText');
  const shownText = document.getElementById('shownText');

  const emptyState = document.getElementById('emptyState');
  const grid = document.getElementById('grid');
  const loadMoreBtn = document.getElementById('loadMoreBtn');

  const state = {
    loading: false,
    page: 1,
    pageSize: 60,
    total: 0,
    shown: 0,
    authHeader: '',
    rawPublicKey: '',
    hasMore: true,
  };

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function setStatus(text, cls) {
    if (!statusText) return;
    statusText.textContent = String(text || '').trim() || '-';
    statusText.classList.remove('connected', 'connecting', 'error');
    if (cls) statusText.classList.add(cls);
  }

  function setCounts(total, shown) {
    if (totalText) totalText.textContent = String(Number(total || 0));
    if (shownText) shownText.textContent = String(Number(shown || 0));
  }

  function normalizeAuthHeader(authHeader) {
    const raw = String(authHeader || '').trim();
    if (!raw) return '';
    if (raw.startsWith('Bearer ')) return raw.slice(7).trim();
    return raw;
  }

  function buildImaginePublicUrl(parentPostId) {
    const id = String(parentPostId || '').trim();
    if (!id) return '';
    return `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`;
  }

  function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('/')) return `${window.location.origin}${raw}`;
    return '';
  }

  function pickBestImageUrl(item) {
    if (!item || typeof item !== 'object') return '';
    const imageUrl = String(item.image_url || '').trim();
    const sourceImageUrl = String(item.source_image_url || '').trim();
    const parentPostId = String(item.parent_post_id || '').trim();

    const candidates = [
      normalizeHttpUrl(imageUrl),
      normalizeHttpUrl(sourceImageUrl),
      parentPostId ? buildImaginePublicUrl(parentPostId) : '',
      imageUrl.startsWith('data:') ? imageUrl : '',
    ];
    for (const it of candidates) {
      const v = String(it || '').trim();
      if (v) return v;
    }
    return '';
  }

  function getParentPostIdForItem(item) {
    if (!item || typeof item !== 'object') return '';
    const direct = String(item.parent_post_id || '').trim();
    if (direct) return direct;

    const derived = String(item.derived_from_id || '').trim();
    if (derived.startsWith('img_') && derived.length > 4) {
      return derived.slice(4).trim();
    }
    return '';
  }

  function buildMediaDetailUrl(item) {
    const params = new URLSearchParams();

    const prompt = String(item && item.prompt ? item.prompt : '').trim();
    const parentPostId = getParentPostIdForItem(item);
    const sourceImageUrl = String(item && item.source_image_url ? item.source_image_url : '').trim();
    const imageUrl = pickBestImageUrl(item);

    if (parentPostId) params.set('image_id', parentPostId);
    if (prompt) params.set('prompt', prompt);
    if (sourceImageUrl) params.set('source_image_url', sourceImageUrl);
    if (imageUrl) params.set('image_url', imageUrl);

    const qs = params.toString();
    return qs ? `/media/detail?${qs}` : '/media/detail';
  }

  function buildImagineWorkbenchUrl(item) {
    const params = new URLSearchParams();
    const parentPostId = getParentPostIdForItem(item);
    const sourceImageUrl = String(item && item.source_image_url ? item.source_image_url : '').trim();
    const prompt = String(item && item.prompt ? item.prompt : '').trim();

    if (parentPostId) params.set('parent_post_id', parentPostId);
    if (sourceImageUrl) params.set('source_image_url', sourceImageUrl);
    if (prompt) params.set('prompt', prompt);

    const qs = params.toString();
    return qs ? `/imagine-workbench?${qs}` : '/imagine-workbench';
  }

  function formatTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderEmptyIfNeeded() {
    if (!emptyState || !grid) return;
    const has = grid.children && grid.children.length > 0;
    emptyState.style.display = has ? 'none' : 'block';
  }

  function getFilters() {
    const mediaType = typeSelect ? String(typeSelect.value || '').trim() : '';
    const favoriteOnly = Boolean(favoriteOnlyToggle && favoriteOnlyToggle.checked);
    const q = searchInput ? String(searchInput.value || '').trim() : '';
    return { mediaType, favoriteOnly, q };
  }

  async function ensureAuth() {
    if (state.authHeader) return state.authHeader;

    const authHeader = typeof ensurePublicKey === 'function' ? await ensurePublicKey() : null;
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      window.location.href = '/login';
      return null;
    }

    state.authHeader = String(authHeader || '');
    state.rawPublicKey = normalizeAuthHeader(state.authHeader);
    return state.authHeader;
  }

  async function apiFetchJson(url, options) {
    const authHeader = await ensureAuth();
    if (authHeader === null) return null;

    const res = await fetch(url, {
      ...(options || {}),
      headers: {
        ...(typeof buildAuthHeaders === 'function' ? buildAuthHeaders(authHeader) : {}),
        ...((options && options.headers) ? options.headers : {}),
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'request_failed');
    }

    return await res.json();
  }

  function createCard(item) {
    const mediaType = String(item && item.media_type ? item.media_type : '').trim() || '-';
    const isFavorite = Boolean(item && item.favorite);
    const createdAt = formatTime(item && item.created_at ? item.created_at : 0);
    const prompt = String(item && item.prompt ? item.prompt : '').trim();

    const card = document.createElement('div');
    card.className = 'mlib-card';
    card.dataset.id = String(item && item.id ? item.id : '').trim();
    card.dataset.mediaType = mediaType;

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = `mlib-fav-btn${isFavorite ? ' is-on' : ''}`;
    favBtn.textContent = isFavorite ? '已收藏' : '收藏';
    favBtn.title = isFavorite ? '取消收藏（仍保留记录）' : '收藏入库';
    favBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await toggleFavorite(item, favBtn, !Boolean(item.favorite));
    });

    card.appendChild(favBtn);

    if (mediaType === 'video') {
      const videoUrl = String(item && item.video_url ? item.video_url : '').trim();
      const video = document.createElement('video');
      video.className = 'mlib-thumb';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'metadata';
      if (videoUrl) {
        const source = document.createElement('source');
        source.src = videoUrl;
        source.type = 'video/mp4';
        video.appendChild(source);
      }
      card.appendChild(video);
    } else {
      const thumbUrl = pickBestImageUrl(item);
      const img = document.createElement('img');
      img.className = 'mlib-thumb';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = (item && item.parent_post_id) ? String(item.parent_post_id) : 'media';
      img.src = thumbUrl;
      card.appendChild(img);
    }

    const meta = document.createElement('div');
    meta.className = 'mlib-card-meta';

    const title = document.createElement('div');
    title.className = 'mlib-card-title';

    const left = document.createElement('div');
    left.textContent = mediaType === 'video' ? '视频' : '图片';

    const tag = document.createElement('span');
    tag.className = 'mlib-tag';
    tag.textContent = createdAt;

    title.appendChild(left);
    title.appendChild(tag);

    const sub = document.createElement('div');
    sub.className = 'mlib-card-sub';
    sub.textContent = prompt ? prompt : '（无 prompt）';

    const actions = document.createElement('div');
    actions.className = 'mlib-card-actions';

    if (mediaType === 'video') {
      const open = document.createElement('a');
      open.className = 'geist-button-outline mlib-mini-btn';
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = '打开视频';
      const url = String(item && item.video_url ? item.video_url : '').trim();
      if (url) open.href = url;
      else {
        open.href = '#';
        open.addEventListener('click', (e) => {
          e.preventDefault();
          toast('缺少 video_url', 'error');
        });
      }
      actions.appendChild(open);

      const pid = getParentPostIdForItem(item);
      if (pid) {
        const trace = document.createElement('button');
        trace.type = 'button';
        trace.className = 'geist-button mlib-mini-btn';
        trace.textContent = '溯源';
        trace.title = '打开源图片详情（可继续编辑/生成视频）';
        trace.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.location.href = buildMediaDetailUrl(item);
        });
        actions.appendChild(trace);
      }
    } else {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'geist-button mlib-mini-btn';
      view.textContent = '打开详情';
      view.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = buildMediaDetailUrl(item);
      });
      actions.appendChild(view);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'geist-button-outline mlib-mini-btn';
      edit.textContent = '编辑';
      edit.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const parentPostId = getParentPostIdForItem(item);
        if (!parentPostId) {
          toast('缺少 parent_post_id，无法进入编辑工作台', 'error');
          return;
        }
        window.location.href = buildImagineWorkbenchUrl(item);
      });
      actions.appendChild(edit);
    }

    meta.appendChild(title);
    meta.appendChild(sub);
    meta.appendChild(actions);

    card.appendChild(meta);

    card.addEventListener('click', () => {
      if (mediaType === 'video') {
        const url = String(item && item.video_url ? item.video_url : '').trim();
        if (url) {
          window.open(url, '_blank', 'noopener');
        } else {
          toast('缺少 video_url', 'error');
        }
        return;
      }
      window.location.href = buildMediaDetailUrl(item);
    });

    return card;
  }

  function renderItems(items, append) {
    if (!grid) return;
    if (!append) {
      grid.innerHTML = '';
      state.shown = 0;
    }

    const list = Array.isArray(items) ? items : [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const card = createCard(it);
      grid.appendChild(card);
      state.shown += 1;
    }

    renderEmptyIfNeeded();
    setCounts(state.total, state.shown);

    if (loadMoreBtn) {
      loadMoreBtn.disabled = state.loading || !state.hasMore;
      loadMoreBtn.textContent = state.hasMore ? '加载更多' : '没有更多了';
    }
  }

  async function loadPage(page, append) {
    if (state.loading) return;
    state.loading = true;

    setStatus('加载中...', 'connecting');
    if (loadMoreBtn) {
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = '加载中...';
    }

    try {
      const { mediaType, favoriteOnly, q } = getFilters();

      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('page_size', String(state.pageSize));
      if (mediaType) params.set('media_type', mediaType);
      if (q) params.set('q', q);
      params.set('favorite_only', favoriteOnly ? 'true' : 'false');

      const data = await apiFetchJson(`/v1/public/media_library/list?${params.toString()}`, {
        method: 'GET',
      });
      if (!data) return;

      const items = Array.isArray(data.items) ? data.items : [];
      const total = Number(data.total || 0);
      state.total = Number.isFinite(total) ? total : items.length;

      const loaded = items.length;
      state.page = page;
      state.hasMore = (state.shown + loaded) < state.total && loaded > 0;

      renderItems(items, append);
      setStatus('已加载', 'connected');
    } catch (e) {
      setStatus('加载失败', 'error');
      toast('加载失败', 'error');
      if (loadMoreBtn) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = '重试加载更多';
      }
    } finally {
      state.loading = false;
      if (loadMoreBtn) {
        loadMoreBtn.disabled = state.loading || !state.hasMore;
        loadMoreBtn.textContent = state.hasMore ? '加载更多' : '没有更多了';
      }
    }
  }

  async function toggleFavorite(item, btn, turnOn) {
    if (!item || typeof item !== 'object') return;
    if (!btn) return;

    const id = String(item.id || '').trim();
    const mediaType = String(item.media_type || '').trim();

    btn.disabled = true;

    try {
      if (turnOn) {
        const payload = {
          id,
          media_type: mediaType,
          prompt: item.prompt || '',
          parent_post_id: item.parent_post_id || '',
          source_image_url: item.source_image_url || '',
          image_url: item.image_url || '',
          video_url: item.video_url || '',
          derived_from_id: item.derived_from_id || '',
          extra: item.extra || {},
        };

        const resp = await apiFetchJson('/v1/public/media_library/favorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const updated = resp && resp.item ? resp.item : null;
        if (updated && typeof updated === 'object') {
          Object.assign(item, updated);
        } else {
          item.favorite = true;
        }

        btn.classList.add('is-on');
        btn.textContent = '已收藏';
        btn.title = '取消收藏（仍保留记录）';
        toast('已收藏', 'success');
      } else {
        await apiFetchJson('/v1/public/media_library/unfavorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });

        item.favorite = false;
        btn.classList.remove('is-on');
        btn.textContent = '收藏';
        btn.title = '收藏入库';
        toast('已取消收藏', 'info');

        // If we are in "favorite only" mode, remove it from view.
        if (favoriteOnlyToggle && favoriteOnlyToggle.checked) {
          const card = btn.closest('.mlib-card');
          if (card) {
            try {
              card.remove();
              state.shown = Math.max(0, state.shown - 1);
              setCounts(state.total, state.shown);
              renderEmptyIfNeeded();
            } catch (e) {
              // ignore
            }
          }
        }
      }
    } catch (e) {
      toast('操作失败', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function bindEvents() {
    if (backToMediaBtn) {
      backToMediaBtn.addEventListener('click', () => {
        window.location.href = '/media';
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        state.page = 1;
        state.total = 0;
        state.shown = 0;
        state.hasMore = true;
        loadPage(1, false);
      });
    }
    if (searchBtn) {
      searchBtn.addEventListener('click', () => {
        state.page = 1;
        state.total = 0;
        state.shown = 0;
        state.hasMore = true;
        loadPage(1, false);
      });
    }
    if (searchInput) {
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          state.page = 1;
          state.total = 0;
          state.shown = 0;
          state.hasMore = true;
          loadPage(1, false);
        }
      });
    }
    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        state.page = 1;
        state.total = 0;
        state.shown = 0;
        state.hasMore = true;
        loadPage(1, false);
      });
    }
    if (favoriteOnlyToggle) {
      favoriteOnlyToggle.addEventListener('change', () => {
        state.page = 1;
        state.total = 0;
        state.shown = 0;
        state.hasMore = true;
        loadPage(1, false);
      });
    }
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        if (!state.hasMore) return;
        loadPage(state.page + 1, true);
      });
    }
  }

  async function init() {
    bindEvents();
    setCounts(0, 0);
    renderEmptyIfNeeded();

    const auth = await ensureAuth();
    if (auth === null) return;

    await loadPage(1, false);
  }

  init();
})();