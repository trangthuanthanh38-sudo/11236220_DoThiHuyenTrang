"""Xác minh đăng nhập Google (UC-01/UC-02 luồng 3a).

Frontend (js/google-login.js) giữ nút "Tiếp tục với Google" tự thiết kế, bấm vào mở popup chọn tài khoản của Google
Identity Services (token client) -> nhận ACCESS TOKEN (scope openid email profile) rồi gửi lên POST /auth/google.
Backend KHÔNG tin dữ liệu client gửi, tự hỏi Google:
  1. tokeninfo: token còn hạn và được cấp cho ĐÚNG ứng dụng này (`aud`/`azp` == settings.GOOGLE_CLIENT_ID) — chặn việc
     dùng token của app khác để đăng nhập vào đây.
  2. userinfo: sub (định danh bất biến, BR-02), email + email_verified, tên, ảnh.
Cấu hình: chỉ cần GOOGLE_CLIENT_ID (OAuth client loại "Web application", không cần Client Secret).
"""
import requests

from app.config import settings

_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
_TIMEOUT = 10


class GoogleAuthError(Exception):
    """Token không hợp lệ / hết hạn / không cấp cho app này (UC-01 E5)."""


class GoogleUnavailable(Exception):
    """Không gọi được máy chủ Google (mạng)."""


def is_configured() -> bool:
    return bool(settings.GOOGLE_CLIENT_ID.strip())


def verify_access_token(access_token: str) -> dict:
    """Trả {sub, email, email_verified, name, picture} sau khi đã kiểm aud với Google."""
    client_id = settings.GOOGLE_CLIENT_ID.strip()
    try:
        info = requests.get(_TOKENINFO_URL, params={"access_token": access_token}, timeout=_TIMEOUT)
        if info.status_code != 200:
            raise GoogleAuthError("tokeninfo từ chối token")
        ti = info.json()
        if client_id not in (ti.get("aud"), ti.get("azp")):
            raise GoogleAuthError("token không được cấp cho ứng dụng này")
        ui = requests.get(_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}, timeout=_TIMEOUT)
        if ui.status_code != 200:
            raise GoogleAuthError("userinfo từ chối token")
        u = ui.json()
    except requests.RequestException as exc:
        raise GoogleUnavailable(str(exc)) from exc
    if not u.get("sub") or u.get("sub") != ti.get("sub"):
        raise GoogleAuthError("sub không khớp")
    verified = u.get("email_verified")
    return {
        "sub": u["sub"],
        "email": u.get("email"),
        "email_verified": verified is True or str(verified).lower() == "true",
        "name": (u.get("name") or "").strip(),
        "picture": u.get("picture"),
    }
