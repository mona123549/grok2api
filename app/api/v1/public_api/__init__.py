"""Public API router (public_key protected)."""

from fastapi import APIRouter

from app.api.v1.public_api.imagine import router as imagine_router
from app.api.v1.public_api.media_library import router as media_library_router
from app.api.v1.public_api.personal_cache import router as personal_cache_router
from app.api.v1.public_api.prompt import router as prompt_router
from app.api.v1.public_api.video import router as video_router
from app.api.v1.public_api.voice import router as voice_router

router = APIRouter()

router.include_router(imagine_router)
router.include_router(media_library_router)
router.include_router(personal_cache_router)
router.include_router(prompt_router)
router.include_router(video_router)
router.include_router(voice_router)

__all__ = ["router"]
