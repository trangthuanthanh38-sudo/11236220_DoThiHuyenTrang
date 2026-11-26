"""Hàm tiện ích bảo mật: hash mật khẩu, JWT, sinh OTP, chuẩn hoá SĐT.

Tách riêng khỏi routers/auth.py để dễ viết unit test độc lập sau này.
"""
import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings

PHONE_RE = re.compile(r"^(0\d{9}|\+84\d{9})$")


class ValidationError(Exception):
    """Lỗi dữ liệu đầu vào không hợp lệ (UC-02 E1, UC-04 E3...)."""


def normalize_phone(raw: str) -> str:
    """Chuẩn hoá SĐT Việt Nam về dạng +84xxxxxxxxx (E.164).

    Chấp nhận input dạng 0xxxxxxxxx (10 số) hoặc +84xxxxxxxxx.
    """
    cleaned = raw.strip().replace(" ", "").replace("-", "")
    if not PHONE_RE.match(cleaned):
        raise ValidationError("Số điện thoại không hợp lệ. Dùng dạng 0xxxxxxxxx hoặc +84xxxxxxxxx.")
    if cleaned.startswith("0"):
        return "+84" + cleaned[1:]
    return cleaned


def validate_password_strength(password: str) -> None:
    """BR-01: tối thiểu 8 ký tự, có chữ hoa, chữ thường và số."""
    if len(password) < settings.PASSWORD_MIN_LENGTH:
        raise ValidationError(f"Mật khẩu phải có tối thiểu {settings.PASSWORD_MIN_LENGTH} ký tự.")
    if not re.search(r"[A-Z]", password):
        raise ValidationError("Mật khẩu phải có ít nhất 1 chữ hoa.")
    if not re.search(r"[a-z]", password):
        raise ValidationError("Mật khẩu phải có ít nhất 1 chữ thường.")
    if not re.search(r"\d", password):
        raise ValidationError("Mật khẩu phải có ít nhất 1 chữ số.")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # password_hash lưu sai định dạng — coi như không khớp thay vì crash 500
        return False


def generate_otp() -> str:
    """OTP 6 số — dùng secrets thay vì random để đủ an toàn (UC-03)."""
    return "".join(secrets.choice("0123456789") for _ in range(6))


def hash_token(raw_token: str) -> str:
    """SHA-256 hex digest — dùng để lưu refresh token trong DB (không lưu token thô)."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def create_access_token(user_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_ACCESS_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])


def utcnow() -> datetime:
    # Cột DATETIME trong MySQL không lưu timezone -> dùng giờ UTC "naive" xuyên suốt
    # để so sánh nhất quán với giá trị đọc ra từ DB.
    return datetime.utcnow()
