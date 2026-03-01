from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.auth import verify_public_key
from app.services.grok.utils.cache import CacheService

# NOTE:
# - public 侧仍要求 public_key（verify_public_key）
# - Personal Mode 额外要求 X-Personal-Key（verify_personal_key）
#   verify_personal_key 将在后续提交中加入到 app/core/auth.py
from app.core.auth import verify_personal_key  # noqa: E402


router = APIRouter()


def _normalize_cache_type(value: str) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"image", "video", "all", ""}:
        return raw or "all"
    raise HTTPException(status_code=400, detail="type must be image, video or all")


def _list_all_files(svc: CacheService):
    """
    以“全局 mtime desc”的方式列出 image+video 两类缓存文件。
    注意：CacheService.list_files() 目前是按单类型分页；这里为了支持 type=all，
    直接扫描两类目录并统一排序分页（与 CacheService.list_files() 的行为保持一致的字段集合）。
    """
    items = []

    for media_type in ("image", "video"):
        cache_dir = svc._cache_dir(media_type)  # noqa: SLF001
        if not cache_dir.exists():
            continue

        allowed = svc._allowed_exts(media_type)  # noqa: SLF001
        for f in cache_dir.glob("*"):
            try:
                if not f.is_file():
                    continue
                if f.suffix.lower() not in allowed:
                    continue
                stat = f.stat()
                items.append(
                    {
                        "media_type": media_type,
                        "name": f.name,
                        "size_bytes": stat.st_size,
                        "mtime_ms": int(stat.st_mtime * 1000),
                        "view_url": f"/v1/files/{media_type}/{f.name}",
                    }
                )
            except Exception:
                continue

    items.sort(key=lambda x: x["mtime_ms"], reverse=True)
    return items


class PersonalCacheDeleteRequest(BaseModel):
    type: str = "image"
    name: str


@router.get("/personal/verify", dependencies=[Depends(verify_public_key), Depends(verify_personal_key)])
async def personal_verify_api():
    """用于前端验证个人模式密码是否有效。"""
    return {"status": "success"}


@router.get("/personal/cache/stats", dependencies=[Depends(verify_public_key), Depends(verify_personal_key)])
async def personal_cache_stats():
    """获取本地缓存统计（仅 image/video 维度）。"""
    svc = CacheService()
    return {
        "status": "success",
        "local_image": svc.get_stats("image"),
        "local_video": svc.get_stats("video"),
    }


@router.get(
    "/personal/cache/list",
    dependencies=[Depends(verify_public_key), Depends(verify_personal_key)],
)
async def personal_cache_list(
    type_: str = Query(default="all", alias="type"),
    page: int = 1,
    page_size: int = 60,
):
    """列出本地缓存文件（tmp）。支持 type=image|video|all。"""
    cache_type = _normalize_cache_type(type_)
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 60)))

    svc = CacheService()

    if cache_type == "all":
        items = _list_all_files(svc)
        total = len(items)
        start = max(0, (page - 1) * page_size)
        paged = items[start : start + page_size]
        return {
            "status": "success",
            "type": "all",
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": paged,
        }

    result = svc.list_files(cache_type, page, page_size)
    # 为单类型补一个 media_type 字段，便于前端统一处理
    items = result.get("items") if isinstance(result, dict) else None
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict) and "media_type" not in it:
                it["media_type"] = cache_type
    return {"status": "success", **result, "type": cache_type}


@router.post("/personal/cache/item/delete", dependencies=[Depends(verify_public_key), Depends(verify_personal_key)])
async def personal_cache_item_delete(data: PersonalCacheDeleteRequest):
    """删除单个本地缓存文件（tmp）。"""
    cache_type = _normalize_cache_type(data.type)
    name = str(data.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Missing file name")

    svc = CacheService()
    result = svc.delete_file(cache_type, name)
    return {"status": "success", "result": result, "type": cache_type, "name": name}


__all__ = ["router"]