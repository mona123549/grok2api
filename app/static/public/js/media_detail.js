(() => {
  const detailImage = document.getElementById('detailImage');
  const emptyState = document.getElementById('mediaDetailEmpty');

  const imageUrlText = document.getElementById('imageUrlText');
  const imageIdText = document.getElementById('imageIdText');
  const sourceUrlText = document.getElementById('sourceUrlText');
  const promptText = document.getElementById('promptText');

  const backBtn = document.getElementById('backBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyMainBtn = document.getElementById('copyMainBtn');
  const upscaleBtn = document.getElementById('upscaleBtn');

  const copyUrlBtn = document.getElementById('copyUrlBtn');
  const copyIdBtn = document.getElementById('copyIdBtn');
  const copySourceBtn = document.getElementById('copySourceBtn');
  const copyPromptBtn = document.getElementById('copyPromptBtn');

  const SETTINGS_STORAGE_KEY = 'media_settings_v1';
  const UPSCALE_KEY = 'media_detail_upscale_enabled_v1';

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

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const get = (k) => String(params.get(k) || '').trim();
    return {
      imageUrl: get('image_url') || get('url') || '',
      imageId: get('image_id') || get('id') || '',
      prompt: get('prompt') || '',
      sourceImageUrl: get('source_image_url') || get('source') || '',
      cacheKey: get('cache_key') || '',
    };
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

  function showImage(url) {
    const clean = String(url || '').trim();
    if (!detailImage) return;

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

    showImage(rawImageUrl);
    setMeta({ ...data, imageUrl: rawImageUrl });

    bindCopy(copyMainBtn, () => rawImageUrl, '已复制图片地址');
    bindCopy(copyUrlBtn, () => rawImageUrl, '已复制图片地址');
    bindCopy(copyIdBtn, () => data.imageId, '已复制 ID');
    bindCopy(copySourceBtn, () => data.sourceImageUrl, '已复制 sourceImageUrl');
    bindCopy(copyPromptBtn, () => data.prompt, '已复制 Prompt');

    if (downloadBtn) {
      downloadBtn.addEventListener('click', async () => {
        if (!rawImageUrl) {
          toast('图片地址为空', 'warning');
          return;
        }
        try {
          const ext = inferExtFromUrl(rawImageUrl);
          const filename = buildFilename(data.imageId, ext);
          await downloadByUrl(rawImageUrl, filename);
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

    // Initialize upscale state
    setUpscaleEnabled(getUpscaleEnabled());

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