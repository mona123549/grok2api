"""
API 认证模块
"""

from typing import Optional
from fastapi import HTTPException, status, Security, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.core.config import get_config

DEFAULT_API_KEY = ""
DEFAULT_APP_KEY = "grok2api"
DEFAULT_PUBLIC_KEY = ""
DEFAULT_PUBLIC_ENABLED = False

DEFAULT_PERSONAL_MODE_ENABLED = False
DEFAULT_PERSONAL_MODE_KEY = ""

# 定义 Bearer Scheme
security = HTTPBearer(
    auto_error=False,
    scheme_name="API Key",
    description="Enter your API Key in the format: Bearer <key>",
)


def get_admin_api_key() -> str:
    """
    获取后台 API Key。

    为空时表示不启用后台接口认证。
    """
    api_key = get_config("app.api_key", DEFAULT_API_KEY)
    return api_key or ""

def get_app_key() -> str:
    """
    获取 App Key（后台管理密码）。
    """
    app_key = get_config("app.app_key", DEFAULT_APP_KEY)
    return app_key or ""

def get_public_api_key() -> str:
    """
    获取 Public API Key。

    为空时表示不启用 public 接口认证。
    """
    public_key = get_config("app.public_key", DEFAULT_PUBLIC_KEY)
    return public_key or ""


def is_public_enabled() -> bool:
    """
    是否开启 public 功能入口。
    """
    return bool(get_config("app.public_enabled", DEFAULT_PUBLIC_ENABLED))


def is_personal_mode_enabled() -> bool:
    """
    是否开启 Personal Mode（个人模式）。
    """
    return bool(get_config("app.personal_mode_enabled", DEFAULT_PERSONAL_MODE_ENABLED))


def get_personal_mode_key() -> str:
    """
    获取 Personal Mode Key（个人模式密码）。
    """
    key = get_config("app.personal_mode_key", DEFAULT_PERSONAL_MODE_KEY)
    return key or ""


async def verify_api_key(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> Optional[str]:
    """
    验证 Bearer Token

    如果 config.toml 中未配置 api_key，则不启用认证。
    """
    api_key = get_admin_api_key()
    if not api_key:
        return None

    if not auth:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth.credentials != api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return auth.credentials


async def verify_app_key(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> Optional[str]:
    """
    验证后台登录密钥（app_key）。

    app_key 必须配置，否则拒绝登录。
    """
    app_key = get_app_key()

    if not app_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="App key is not configured",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not auth:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth.credentials != app_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return auth.credentials


async def verify_public_key(
    auth: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> Optional[str]:
    """
    验证 Public Key（public 接口使用）。

    默认不公开，需配置 public_key 才能访问；若开启 public_enabled 且未配置 public_key，则放开访问。
    """
    public_key = get_public_api_key()
    public_enabled = is_public_enabled()

    if not public_key:
        if public_enabled:
            return None
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Public access is disabled",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not auth:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if auth.credentials != public_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return auth.credentials


async def verify_personal_key(
    x_personal_key: Optional[str] = Header(default=None, alias="X-Personal-Key"),
) -> Optional[str]:
    """
    验证 Personal Mode Key（个人模式密码）。

    - 使用请求头：X-Personal-Key: <key>
    - 当 personal_mode_enabled=false 时，默认返回 404（减少探测面）。
    """
    if not is_personal_mode_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    expected = get_personal_mode_key()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Personal mode key is not configured",
        )

    provided = str(x_personal_key or "").strip()
    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing personal mode key",
        )

    if provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid personal mode key",
        )

    return provided
