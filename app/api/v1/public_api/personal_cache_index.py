from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import verify_public_key, verify_personal_key
from app.services.grok.utils.cache_index import (
    delete_cache_file,
    delete_item,
    list_items,
)

router = APIRouter()


def _normalize_media_type(value: str) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"image", "video", ""}:
        return raw
    raise HTTPException(status_code=400, detail="media_type must be image or video")


class PersonalCacheIndexDeleteRequest(BaseModel):
    media_type: str = "image"
    parent_post_id: str = ""
    file_name: str = ""


@router.get(
    "/personal/cache_index/list",
    dependencies=[Depends(verify_public_key), Depends(verify_personal_key)],
)
async def personal_cache_index_list(
    page: int = 1,
    page_size: int = 60,
    media_type: str = Query(default="image", description="image|video"),
    origin: str = Query(default="media", description="origin filter, default=media"),
    q: str = Query(default="", description="optional prompt/parent_post_id search keyword"),
):
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 60)))

    mt = _normalize_media_type(media_type)
    if not mt:
        mt = "image"

    data = await list_items(
        media_type=mt,
        origin=str(origin or "").strip(),
        q=str(q or "").strip(),
        page=page,
        page_size=page_size,
        dedupe=True,
        validate_files=True,
        auto_prune_missing_files=True,
    )

    items = data.get("items") if isinstance(data, dict) else None
    if isinstance(items, list):
        # ensure view_url exists (backward-compatible)
        for it in items:
            if not isinstance(it, dict):
                continue
            if str(it.get("view_url") or "").strip():
                continue
            fn = str(it.get("file_name") or "").strip()
            it_mt = str(it.get("media_type") or mt).strip() or mt
            if fn:
                it["view_url"] = f"/v1/files/{it_mt}/{fn}"

    return {"status": "success", **data}


@router.post(
    "/personal/cache_index/item/delete",
    dependencies=[Depends(verify_public_key), Depends(verify_personal_key)],
)
async def personal_cache_index_item_delete(data: PersonalCacheIndexDeleteRequest):
    mt = _normalize_media_type(data.media_type) or "image"
    parent_post_id = str(data.parent_post_id or "").strip()
    file_name = str(data.file_name or "").strip()

    if not parent_post_id and not file_name:
        raise HTTPException(status_code=400, detail="parent_post_id or file_name is required")

    deleted, removed = await delete_item(
        media_type=mt,
        parent_post_id=parent_post_id,
        file_name=file_name,
    )

    file_deleted = {"deleted": False, "reason": "skipped"}
    if deleted and isinstance(removed, dict):
        fn = str(removed.get("file_name") or "").strip() or file_name
        if fn:
            file_deleted = await delete_cache_file(media_type=mt, file_name=fn)
        else:
            file_deleted = {"deleted": False, "reason": "missing_file_name"}

    return {
        "status": "success",
        "deleted": bool(deleted),
        "removed": removed,
        "file": file_deleted,
        "media_type": mt,
    }


__all__ = ["router"]