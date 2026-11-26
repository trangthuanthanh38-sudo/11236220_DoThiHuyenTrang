"""Mật khẩu Chương (thẻ Review ▸ Password, theo OneNote) — khoá mở tạm thời.

Mở khoá đúng mật khẩu -> máy chủ phát "khoá mở" `<hạn>.<chữ ký>` (HMAC-SHA256 theo JWT_SECRET, id Chương, hạn và
password_hash hiện tại). Client gửi lại trong header `X-Chapter-Key` khi đọc / ghi Chương đó. Đổi hoặc gỡ mật khẩu làm
password_hash đổi -> mọi khoá cũ tự hết hiệu lực. Khoá chỉ nằm trong bộ nhớ trang (F5 / "Lock All" = phải nhập lại).
"""
import hashlib
import hmac
import time

from app.config import settings
from app.models import Chapter

KEY_TTL_SECONDS = 8 * 3600


def _sig(chapter: Chapter, exp: int) -> str:
    msg = f"{chapter.id}.{exp}.{chapter.password_hash}".encode()
    return hmac.new(settings.JWT_SECRET.encode(), msg, hashlib.sha256).hexdigest()[:48]


def make_key(chapter: Chapter) -> str:
    exp = int(time.time()) + KEY_TTL_SECONDS
    return f"{exp}.{_sig(chapter, exp)}"


def is_protected(chapter: Chapter | None) -> bool:
    return bool(chapter is not None and chapter.password_hash)


def is_unlocked(chapter: Chapter, key: str | None) -> bool:
    """Chương không có mật khẩu luôn mở; có mật khẩu thì cần khoá mở còn hạn và đúng chữ ký."""
    if not is_protected(chapter):
        return True
    if not key or "." not in key:
        return False
    exp_s, sig = key.split(".", 1)
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    return exp >= time.time() and hmac.compare_digest(sig, _sig(chapter, exp))
