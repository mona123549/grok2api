import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import orjson
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.auth import verify_public_key
from app.core.logger import logger
from app.core.storage import StorageError, get_storage

router = APIRouter()

_MEDIA_TYPE_ALLOWED = {"image", "video"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _validate_media_type(value: str) -> str:
    raw = str(value or "").strip().lower()
    if raw not in _MEDIA_TYPE_ALLOWED:
        raise HTTPException(status_code=400, detail="media_type must be image or video")
    return raw


def _validate_parent_post_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", raw):
        raise HTTPException(status_code=400, detail="parent_post_id format is invalid")
    return raw


def _normalize_url(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    # 允许 data: / http(s) / 相对路径（例如 /v1/files/...）
    if raw.startswith("data:"):
        return raw
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.startswith("/"):
        return raw
    return raw


def _normalize_prompt(value: Optional[str], limit: int = 4000) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if len(raw) > limit:
        return raw[:limit]
    return raw


def _normalize_extra(value: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    raise HTTPException(status_code=400, detail="extra must be an object")


def _load_items_from_library(library: Any) -> List[dict]:
    if not isinstance(library, dict):
        return []
    items = library.get("items")
    if isinstance(items, list):
        return [i for i in items if isinstance(i, dict)]
    return []


def _build_library(items: List[dict]) -> Dict[str, Any]:
    return {"version": 1, "items": items}


def _find_item(items: List[dict], item_id: str) -> Tuple[int, Optional[dict]]:
    target = str(item_id or "").strip()
    if not target:
        return -1, None
    for idx, item in enumerate(items):
        if str(item.get("id") or "") == target:
            return idx, item
    return -1, None


def _best_identity_key(item: dict) -> str:
    """
    用于尽量避免重复收藏。
    优先：media_type + parent_post_id（图片链路）/ video_url（视频链路）/ image_url。
    """
    media_type = str(item.get("media_type") or "")
    parent_post_id = str(item.get("parent_post_id") or "")
    video_url = str(item.get("video_url") or "")
    image_url = str(item.get("image_url") or "")
    if parent_post_id:
        return f"{media_type}:pp:{parent_post_id}"
    if media_type == "video" and video_url:
        return f"{media_type}:v:{video_url}"
    if image_url:
        return f"{media_type}:i:{image_url}"
    return f"{media_type}:id:{str(item.get('id') or '')}"


def _dedupe_index(items: List[dict]) -> Dict[str, str]:
    index: Dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        key = _best_identity_key(item)
        item_id = str(item.get("id") or "").strip()
        if key and item_id and key not in index:
            index[key] = item_id
    return index


class MediaLibraryItem(BaseModel):
    id: str
    media_type: str = Field(..., description="image|video")
    created_at: int
    updated_at: int
    favorite: bool = True

    prompt: str = ""
    parent_post_id: str = ""
    source_image_url: str = ""

    image_url: str = ""
    video_url: str = ""

    derived_from_id: str = ""
    extra: Dict[str, Any] = Field(default_factory=dict)


class MediaLibraryFavoriteRequest(BaseModel):
    id: Optional[str] = None
    media_type: str = "image"
    prompt: Optional[str] = ""
    parent_post_id: Optional[str] = ""
    source_image_url: Optional[str] = ""
    image_url: Optional[str] = ""
    video_url: Optional[str] = ""
    derived_from_id: Optional[str] = ""
    extra: Optional[Dict[str, Any]] = None


class MediaLibraryUnfavoriteRequest(BaseModel):
    id: str


def _normalize_item_from_request(data: MediaLibraryFavoriteRequest) -> dict:
    media_type = _validate_media_type(data.media_type)
    parent_post_id = _validate_parent_post_id(data.parent_post_id or "")
    image_url = _normalize_url(data.image_url)
    video_url = _normalize_url(data.video_url)
    source_image_url = _normalize_url(data.source_image_url)
    prompt = _normalize_prompt(data.prompt)

    if media_type == "image" and not (parent_post_id or image_url):
        raise HTTPException(
            status_code=400,
            detail="image favorite requires parent_post_id or image_url",
        )
    if media_type == "video" and not video_url:
        # 视频也可能来自外部，但必须有展示 URL
        raise HTTPException(
            status_code=400,
            detail="video favorite requires video_url",
        )

    derived_from_id = str(data.derived_from_id or "").strip()
    extra = _normalize_extra(data.extra)

    now_ms = _now_ms()
    item_id = str(data.id or "").strip() or uuid.uuid4().hex

    return {
        "id": item_id,
        "media_type": media_type,
        "created_at": now_ms,
        "updated_at": now_ms,
        "favorite": True,
        "prompt": prompt,
        "parent_post_id": parent_post_id,
        "source_image_url": source_image_url,
        "image_url": image_url,
        "video_url": video_url,
        "derived_from_id": derived_from_id,
        "extra": extra,
    }


@router.post("/media_library/favorite", dependencies=[Depends(verify_public_key)])
async def public_media_library_favorite(data: MediaLibraryFavoriteRequest):
    storage = get_storage()
    item = _normalize_item_from_request(data)

    async with storage.acquire_lock("media_library", timeout=10):
        library = await storage.load_media_library()
        items = _load_items_from_library(library)
        dedupe = _dedupe_index(items)
        key = _best_identity_key(item)
        existing_id = dedupe.get(key, "")

        if existing_id and existing_id != item["id"]:
            idx, existing = _find_item(items, existing_id)
            if idx >= 0 and isinstance(existing, dict):
                existing["favorite"] = True
                existing["updated_at"] = _now_ms()
                if item.get("prompt") and not str(existing.get("prompt") or "").strip():
                    existing["prompt"] = item.get("prompt")
                if item.get("source_image_url") and not str(
                    existing.get("source_image_url") or ""
                ).strip():
                    existing["source_image_url"] = item.get("source_image_url")
                if item.get("derived_from_id") and not str(
                    existing.get("derived_from_id") or ""
                ).strip():
                    existing["derived_from_id"] = item.get("derived_from_id")
                if isinstance(item.get("extra"), dict) and item["extra"]:
                    merged = dict(existing.get("extra") or {})
                    merged.update(item["extra"])
                    existing["extra"] = merged

                await storage.save_media_library(_build_library(items))
                return {"status": "success", "item": existing, "deduped": True}

        idx, existing = _find_item(items, item["id"])
        if idx >= 0 and isinstance(existing, dict):
            # 视为更新 & 重新收藏
            existing.update(
                {
                    "media_type": item["media_type"],
                    "favorite": True,
                    "updated_at": _now_ms(),
                    "prompt": item.get("prompt", existing.get("prompt", "")),
                    "parent_post_id": item.get("parent_post_id", existing.get("parent_post_id", "")),
                    "source_image_url": item.get("source_image_url", existing.get("source_image_url", "")),
                    "image_url": item.get("image_url", existing.get("image_url", "")),
                    "video_url": item.get("video_url", existing.get("video_url", "")),
                    "derived_from_id": item.get("derived_from_id", existing.get("derived_from_id", "")),
                    "extra": item.get("extra", existing.get("extra", {})),
                }
            )
            await storage.save_media_library(_build_library(items))
            return {"status": "success", "item": existing, "updated": True}

        items.append(item)
        await storage.save_media_library(_build_library(items))
        return {"status": "success", "item": item}


@router.post("/media_library/unfavorite", dependencies=[Depends(verify_public_key)])
async def public_media_library_unfavorite(data: MediaLibraryUnfavoriteRequest):
    storage = get_storage()
    item_id = str(data.id or "").strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="id is required")

    async with storage.acquire_lock("media_library", timeout=10):
        library = await storage.load_media_library()
        items = _load_items_from_library(library)
        idx, item = _find_item(items, item_id)
        if idx < 0 or not item:
            raise HTTPException(status_code=404, detail="Item not found")

        item["favorite"] = False
        item["updated_at"] = _now_ms()
        await storage.save_media_library(_build_library(items))
        return {"status": "success", "item": item}


@router.get("/media_library/get", dependencies=[Depends(verify_public_key)])
async def public_media_library_get(id: str = Query("")):
    storage = get_storage()
    item_id = str(id or "").strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="id is required")

    library = await storage.load_media_library()
    items = _load_items_from_library(library)
    _, item = _find_item(items, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"status": "success", "item": item}


@router.delete("/media_library/delete", dependencies=[Depends(verify_public_key)])
async def public_media_library_delete(id: str = Query("")):
    storage = get_storage()
    item_id = str(id or "").strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="id is required")

    async with storage.acquire_lock("media_library", timeout=10):
        library = await storage.load_media_library()
        items = _load_items_from_library(library)
        idx, _ = _find_item(items, item_id)
        if idx < 0:
            raise HTTPException(status_code=404, detail="Item not found")
        removed = items.pop(idx)
        await storage.save_media_library(_build_library(items))
        return {"status": "success", "removed": removed}


@router.get("/media_library/list", dependencies=[Depends(verify_public_key)])
async def public_media_library_list(
    page: int = 1,
    page_size: int = 60,
    media_type: str = Query("", description="image|video, empty means all"),
    favorite_only: bool = True,
    q: str = Query("", description="optional prompt search keyword"),
):
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 60)))

    media_type_filter = str(media_type or "").strip().lower()
    if media_type_filter:
        media_type_filter = _validate_media_type(media_type_filter)

    keyword = str(q or "").strip().lower()

    storage = get_storage()
    library = await storage.load_media_library()
    items = _load_items_from_library(library)

    filtered: List[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if media_type_filter and str(item.get("media_type") or "") != media_type_filter:
            continue
        if favorite_only and not bool(item.get("favorite")):
            continue
        if keyword:
            prompt = str(item.get("prompt") or "").lower()
            if keyword not in prompt:
                continue
        filtered.append(item)

    # created_at desc
    filtered.sort(key=lambda x: int(x.get("created_at") or 0), reverse=True)

    total = len(filtered)
    start = (page - 1) * page_size
    end = start + page_size
    paged = filtered[start:end]

    return {
        "status": "success",
        "page": page,
        "page_size": page_size,
        "total": total,
        "items": paged,
    }


__all__ = ["router"]