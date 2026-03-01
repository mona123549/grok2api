"""
Personal Cache Index (local json file).

- Storage: DATA_DIR/personal_cache_index.json
- Lock: reuse get_storage().acquire_lock("personal_cache_index") (best-effort for local single-user usage)
- Dedupe: dedupe_key (default: "{media_type}:pp:{parent_post_id}") keeps only the latest entry

This module is intentionally "local file first" (S1-B) to minimize upstream conflicts.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import aiofiles
import orjson

from app.core.logger import logger
from app.core.storage import DATA_DIR, get_storage

INDEX_VERSION = 1
INDEX_FILE = DATA_DIR / "personal_cache_index.json"
LOCK_NAME = "personal_cache_index"

_ALLOWED_MEDIA_TYPES = {"image", "video"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_loads(raw: bytes) -> Any:
    try:
        return orjson.loads(raw)
    except Exception:
        return None


def _default_index() -> Dict[str, Any]:
    return {"version": INDEX_VERSION, "items": []}


def _ensure_index_shape(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return _default_index()
    version = int(data.get("version") or INDEX_VERSION)
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    cleaned = [i for i in items if isinstance(i, dict)]
    return {"version": version, "items": cleaned}


def _normalize_media_type(value: str) -> str:
    raw = str(value or "").strip().lower()
    if raw in _ALLOWED_MEDIA_TYPES:
        return raw
    # default to image (this index is primarily for /media images)
    return "image"


def _normalize_text(value: Any, limit: int = 4000) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if limit and len(raw) > limit:
        return raw[:limit]
    return raw


def build_dedupe_key(media_type: str, parent_post_id: str) -> str:
    mt = _normalize_media_type(media_type)
    pid = _normalize_text(parent_post_id, limit=128)
    if pid:
        return f"{mt}:pp:{pid}"
    return f"{mt}:id:"


def build_image_file_name(parent_post_id: str, ext: str = "jpg") -> str:
    """
    File name policy for /media final cache:
    - Must be stable and traceable by parent_post_id
    - Must be safe for filesystem
    """
    pid = _normalize_text(parent_post_id, limit=128)
    safe_pid = pid.replace("/", "-").replace("\\", "-").strip() or "image"
    safe_ext = _normalize_text(ext, limit=10).lstrip(".").lower() or "jpg"
    return f"{safe_pid}.{safe_ext}"


def _cache_file_path(media_type: str, file_name: str) -> Path:
    mt = _normalize_media_type(media_type)
    base_dir = DATA_DIR / "tmp" / mt
    safe_name = str(file_name or "").replace("/", "-").replace("\\", "-")
    return base_dir / safe_name


def _sort_items_latest(items: List[dict]) -> List[dict]:
    def key_fn(it: dict) -> int:
        try:
            return int(it.get("updated_at") or it.get("created_at") or 0)
        except Exception:
            return 0

    return sorted(items, key=key_fn, reverse=True)


def _dedupe_latest(items: List[dict]) -> List[dict]:
    """
    Ensure only the latest item for each dedupe_key remains.
    Items should be treated as "latest wins".
    """
    latest: Dict[str, dict] = {}
    for it in _sort_items_latest(items):
        dk = _normalize_text(it.get("dedupe_key"), limit=256)
        if not dk:
            continue
        if dk not in latest:
            latest[dk] = it
    return _sort_items_latest(list(latest.values()))


async def load_index() -> Dict[str, Any]:
    if not INDEX_FILE.exists():
        return _default_index()
    try:
        async with aiofiles.open(INDEX_FILE, "rb") as f:
            raw = await f.read()
        data = _json_loads(raw) if raw else None
        return _ensure_index_shape(data)
    except Exception as e:
        logger.warning(f"CacheIndex: failed to load index: {e}")
        return _default_index()


async def save_index(data: Dict[str, Any]) -> None:
    payload = _ensure_index_shape(data)
    try:
        INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = INDEX_FILE.with_suffix(".tmp")
        raw = orjson.dumps(payload, option=orjson.OPT_INDENT_2)
        async with aiofiles.open(tmp_path, "wb") as f:
            await f.write(raw)
        os.replace(tmp_path, INDEX_FILE)
    except Exception as e:
        logger.error(f"CacheIndex: failed to save index: {e}")
        raise


def normalize_index_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize and sanitize an item. This is NOT strict validation; it keeps best-effort.
    """
    now = _now_ms()

    media_type = _normalize_media_type(item.get("media_type") or "image")
    origin = _normalize_text(item.get("origin") or "", limit=64)
    kind = _normalize_text(item.get("kind") or "", limit=64)

    parent_post_id = _normalize_text(item.get("parent_post_id") or "", limit=128)
    prompt = _normalize_text(item.get("prompt") or "", limit=4000)
    source_image_url = _normalize_text(item.get("source_image_url") or "", limit=4096)

    file_name = _normalize_text(item.get("file_name") or "", limit=512).replace("/", "-").replace("\\", "-")
    view_url = _normalize_text(item.get("view_url") or "", limit=4096)

    created_at = int(item.get("created_at") or 0) or now
    updated_at = int(item.get("updated_at") or 0) or now
    last_seen_at = int(item.get("last_seen_at") or 0) or updated_at

    dedupe_key = _normalize_text(item.get("dedupe_key") or "", limit=256)
    if not dedupe_key:
        dedupe_key = build_dedupe_key(media_type, parent_post_id)

    item_id = _normalize_text(item.get("id") or "", limit=256)
    if not item_id:
        # Use dedupe_key as stable id (good enough for personal mode)
        item_id = dedupe_key

    return {
        "id": item_id,
        "media_type": media_type,
        "origin": origin,
        "kind": kind,
        "parent_post_id": parent_post_id,
        "prompt": prompt,
        "source_image_url": source_image_url,
        "file_name": file_name,
        "view_url": view_url,
        "created_at": created_at,
        "updated_at": updated_at,
        "last_seen_at": last_seen_at,
        "dedupe_key": dedupe_key,
    }


async def upsert_item_by_dedupe_key(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Upsert by dedupe_key. If exists, keep created_at, update updated_at/last_seen_at, and overwrite fields.
    """
    storage = get_storage()
    async with storage.acquire_lock(LOCK_NAME, timeout=10):
        index = await load_index()
        items = index.get("items") if isinstance(index, dict) else None
        items = items if isinstance(items, list) else []

        now = _now_ms()
        normalized = normalize_index_item(item)
        normalized["updated_at"] = now
        normalized["last_seen_at"] = now

        dk = _normalize_text(normalized.get("dedupe_key"), limit=256)
        if not dk:
            dk = build_dedupe_key(normalized.get("media_type", "image"), normalized.get("parent_post_id", ""))
            normalized["dedupe_key"] = dk
            normalized["id"] = normalized.get("id") or dk

        replaced = False
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                continue
            if str(it.get("dedupe_key") or "") == dk:
                # preserve created_at if present
                try:
                    normalized["created_at"] = int(it.get("created_at") or normalized["created_at"])
                except Exception:
                    pass
                items[i] = normalized
                replaced = True
                break

        if not replaced:
            items.append(normalized)

        # enforce "latest one per dedupe_key"
        items = _dedupe_latest([it for it in items if isinstance(it, dict)])

        index = {"version": int(index.get("version") or INDEX_VERSION), "items": items}
        await save_index(index)
        return normalized


async def delete_item(
    *,
    media_type: str = "image",
    parent_post_id: str = "",
    file_name: str = "",
) -> Tuple[bool, Optional[dict]]:
    """
    Delete an item by parent_post_id (preferred) or file_name (fallback).
    Returns (deleted, removed_item).
    """
    mt = _normalize_media_type(media_type)
    pid = _normalize_text(parent_post_id, limit=128)
    fn = _normalize_text(file_name, limit=512).replace("/", "-").replace("\\", "-")

    if not pid and not fn:
        return False, None

    storage = get_storage()
    async with storage.acquire_lock(LOCK_NAME, timeout=10):
        index = await load_index()
        items = index.get("items") if isinstance(index, dict) else None
        items = items if isinstance(items, list) else []

        kept: List[dict] = []
        removed: Optional[dict] = None

        for it in items:
            if not isinstance(it, dict):
                continue
            it_mt = _normalize_media_type(it.get("media_type") or "image")
            it_pid = _normalize_text(it.get("parent_post_id") or "", limit=128)
            it_fn = _normalize_text(it.get("file_name") or "", limit=512).replace("/", "-").replace("\\", "-")

            match = False
            if it_mt == mt:
                if pid and it_pid == pid:
                    match = True
                elif (not pid) and fn and it_fn == fn:
                    match = True

            if match and removed is None:
                removed = it
                continue
            kept.append(it)

        if removed is None:
            return False, None

        index = {"version": int(index.get("version") or INDEX_VERSION), "items": kept}
        await save_index(index)
        return True, removed


async def list_items(
    *,
    media_type: str = "",
    origin: str = "",
    q: str = "",
    page: int = 1,
    page_size: int = 60,
    dedupe: bool = True,
    validate_files: bool = True,
    auto_prune_missing_files: bool = True,
) -> Dict[str, Any]:
    """
    List items with filtering + pagination.
    When validate_files+auto_prune_missing_files is enabled, this function may mutate the index (prune).
    """
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 60)))

    mt_filter = _normalize_text(media_type, limit=16).lower()
    if mt_filter and mt_filter not in _ALLOWED_MEDIA_TYPES:
        mt_filter = ""

    origin_filter = _normalize_text(origin, limit=64)
    keyword = _normalize_text(q, limit=256).lower()

    # If we might prune, take the lock; otherwise read-only without lock is OK.
    storage = get_storage()
    if validate_files and auto_prune_missing_files:
        async with storage.acquire_lock(LOCK_NAME, timeout=10):
            index = await load_index()
            items = index.get("items") if isinstance(index, dict) else None
            items = items if isinstance(items, list) else []

            filtered: List[dict] = []
            pruned = False

            for it in items:
                if not isinstance(it, dict):
                    continue

                it_mt = _normalize_media_type(it.get("media_type") or "image")
                if mt_filter and it_mt != mt_filter:
                    continue

                if origin_filter and str(it.get("origin") or "") != origin_filter:
                    continue

                if keyword:
                    prompt = str(it.get("prompt") or "").lower()
                    pid = str(it.get("parent_post_id") or "").lower()
                    if keyword not in prompt and keyword not in pid:
                        continue

                if validate_files:
                    fn = _normalize_text(it.get("file_name") or "", limit=512)
                    if fn:
                        fp = _cache_file_path(it_mt, fn)
                        if not fp.exists():
                            pruned = True
                            continue

                filtered.append(it)

            if dedupe:
                filtered = _dedupe_latest(filtered)
            else:
                filtered = _sort_items_latest(filtered)

            total = len(filtered)
            start = (page - 1) * page_size
            end = start + page_size
            paged = filtered[start:end]

            if pruned:
                # Only prune missing files from the stored index (not only filtered view)
                kept: List[dict] = []
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    it_mt = _normalize_media_type(it.get("media_type") or "image")
                    fn = _normalize_text(it.get("file_name") or "", limit=512)
                    if not fn:
                        kept.append(it)
                        continue
                    fp = _cache_file_path(it_mt, fn)
                    if fp.exists():
                        kept.append(it)

                index = {"version": int(index.get("version") or INDEX_VERSION), "items": kept}
                await save_index(index)

            return {"total": total, "page": page, "page_size": page_size, "items": paged}

    # Read-only path
    index = await load_index()
    items = index.get("items") if isinstance(index, dict) else None
    items = items if isinstance(items, list) else []

    filtered = []
    for it in items:
        if not isinstance(it, dict):
            continue
        it_mt = _normalize_media_type(it.get("media_type") or "image")
        if mt_filter and it_mt != mt_filter:
            continue
        if origin_filter and str(it.get("origin") or "") != origin_filter:
            continue
        if keyword:
            prompt = str(it.get("prompt") or "").lower()
            pid = str(it.get("parent_post_id") or "").lower()
            if keyword not in prompt and keyword not in pid:
                continue
        filtered.append(it)

    filtered = _dedupe_latest(filtered) if dedupe else _sort_items_latest(filtered)

    total = len(filtered)
    start = (page - 1) * page_size
    end = start + page_size
    paged = filtered[start:end]
    return {"total": total, "page": page, "page_size": page_size, "items": paged}


async def delete_cache_file(*, media_type: str, file_name: str) -> Dict[str, Any]:
    """
    Delete the underlying cached file in DATA_DIR/tmp/<media_type>/<file_name>.
    This does NOT modify the index.
    """
    mt = _normalize_media_type(media_type)
    fn = _normalize_text(file_name, limit=512).replace("/", "-").replace("\\", "-")
    if not fn:
        return {"deleted": False, "reason": "missing_file_name"}

    fp = _cache_file_path(mt, fn)
    if not fp.exists():
        return {"deleted": False, "reason": "not_found"}

    try:
        fp.unlink()
        return {"deleted": True, "path": str(fp)}
    except Exception as e:
        logger.warning(f"CacheIndex: delete file failed: {e}")
        return {"deleted": False, "reason": "unlink_failed"}


__all__ = [
    "INDEX_FILE",
    "INDEX_VERSION",
    "LOCK_NAME",
    "build_dedupe_key",
    "build_image_file_name",
    "load_index",
    "save_index",
    "normalize_index_item",
    "upsert_item_by_dedupe_key",
    "delete_item",
    "list_items",
    "delete_cache_file",
]