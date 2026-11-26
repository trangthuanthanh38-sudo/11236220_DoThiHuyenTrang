"""Endpoint UC-06 -> UC-09 (nhóm Hồ sơ & Cài đặt cá nhân).

Xem .claude/rules/05-profile-settings.md. Dùng chung bảng `users` +
`refresh_tokens` + `phone_verification_tokens` (database/auth_schema.sql) và
`user_settings` + `account_security_logs` (database/profile_settings_schema.sql).

Ghi chú thiết kế quan trọng:
  - "Ảnh đại diện" (UC-06) là một ĐƯỜNG DẪN (URL), không phải upload file thô —
    cột `users.avatar_url` chỉ VARCHAR(500) và hệ thống chưa có tầng lưu trữ
    file (STORAGE_FILE thuộc nhóm UC-36, chưa triển khai). Validate ở đây tương
    đương tinh thần BR-14 (giới hạn "định dạng/dung lượng") bằng cách giới hạn
    độ dài URL và bắt buộc bắt đầu http(s).
  - UC-07 hiện tại chỉ còn nhánh "đổi SĐT" (BR-02 đã bỏ Email thủ công) —
    tái dùng `phone_verification_tokens(purpose='change_phone')` đã có sẵn từ
    auth_schema.sql, không tạo bảng token riêng.
  - UC-07/UC-08 chỉ áp dụng cho tài khoản `auth_provider='local'` (có SĐT +
    mật khẩu cục bộ).
"""
import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.models import AccountSecurityLog, PhoneVerificationToken, RefreshToken, User, UserSettings
from app.schemas import (
    ChangePasswordRequest,
    ConfirmPhoneChangeRequest,
    ProfileResponse,
    RequestPhoneChangeRequest,
    SimpleMessageResponse,
    UpdateProfileRequest,
    UpdateThemeRequest,
)
from app.security import (
    ValidationError,
    generate_otp,
    hash_password,
    hash_token,
    normalize_phone,
    utcnow,
    validate_password_strength,
    verify_password,
)

router = APIRouter(prefix="/users/me", tags=["profile"])

# E2 (UC-06): chặn ký tự thường gây lỗi hiển thị/HTML injection trong tên hiển thị.
# Không giới hạn về chữ Việt có dấu — chỉ loại các ký tự markup/định dạng đặc biệt.
DISPLAY_NAME_FORBIDDEN_RE = re.compile(r'[<>{}\\/"|]')
AVATAR_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _mock_send_sms(phone: str, otp_code: str, purpose: str) -> None:
    print(f"[MOCK SMS] Gửi OTP '{otp_code}' tới {phone} (mục đích: {purpose})")


def _get_or_create_settings(db: Session, user_id: str) -> UserSettings:
    row = db.get(UserSettings, user_id)
    if row is None:
        row = UserSettings(user_id=user_id)
        db.add(row)
        db.flush()
    return row


def _to_profile(user: User, us: UserSettings) -> ProfileResponse:
    return ProfileResponse(
        id=user.id,
        phone_number=user.phone_number,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        role=user.role,
        status=user.status,
        auth_provider=user.auth_provider,
        school_name=us.school_name,
        class_name=us.class_name,
        theme=us.theme,
        google_email=user.google_email,
        google_name=user.google_name,
        notify_email=us.notify_email,
        effective_email=user.google_email if user.auth_provider == "google" else us.notify_email,
    )


# ---------------------------------------------------------------------------
# UC-06 — Cập nhật thông tin cá nhân
# ---------------------------------------------------------------------------
@router.get("/profile", response_model=ProfileResponse)
def get_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    us = _get_or_create_settings(db, current_user.id)
    db.commit()
    return _to_profile(current_user, us)


@router.put("/profile", response_model=ProfileResponse)
def update_profile(
    payload: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    name = payload.display_name.strip()
    if not name and current_user.auth_provider == "google":
        name = current_user.google_name or current_user.display_name   # để trống -> quay về tên Google
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên hiển thị không được để trống.")
    if DISPLAY_NAME_FORBIDDEN_RE.search(name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên hiển thị chứa ký tự không hợp lệ.")  # E2

    avatar = (payload.avatar_url or "").strip() or None
    if avatar and not AVATAR_URL_RE.match(avatar):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Ảnh đại diện phải là một đường dẫn URL bắt đầu bằng http:// hoặc https://.",
        )  # E1 (tinh thần BR-14: giới hạn định dạng — ở đây là định dạng đường dẫn)

    current_user.display_name = name
    current_user.avatar_url = avatar

    us = _get_or_create_settings(db, current_user.id)
    us.school_name = (payload.school_name or "").strip() or None
    us.class_name = (payload.class_name or "").strip() or None
    # Email nhận nhắc lịch: tài khoản Google luôn nhận ở Gmail đã đăng nhập (ô bị khoá ở Hồ sơ) -> bỏ qua giá trị gửi lên
    us.notify_email = None if current_user.auth_provider == "google" else payload.notify_email

    db.commit()
    return _to_profile(current_user, us)


# ---------------------------------------------------------------------------
# UC-09 — Đổi giao diện sáng-tối
# ---------------------------------------------------------------------------
@router.put("/theme", response_model=ProfileResponse)
def update_theme(
    payload: UpdateThemeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    us = _get_or_create_settings(db, current_user.id)
    us.theme = payload.theme
    db.commit()
    return _to_profile(current_user, us)


# ---------------------------------------------------------------------------
# UC-08 — Đổi mật khẩu (chỉ auth_provider='local')
# ---------------------------------------------------------------------------
@router.post("/password", response_model=SimpleMessageResponse)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.auth_provider != "local" or not current_user.password_hash:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản đăng nhập bằng Google không có mật khẩu để đổi.")

    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu hiện tại không đúng.")  # E1

    if payload.new_password != payload.confirm_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu xác nhận không khớp.")

    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu mới không được trùng mật khẩu cũ.")  # E2

    try:
        validate_password_strength(payload.new_password)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))  # E3

    now = utcnow()
    current_user.password_hash = hash_password(payload.new_password)

    # Thu hồi các refresh token khác, giữ phiên hiện tại (nếu client gửi kèm).
    keep_hash = hash_token(payload.current_refresh_token) if payload.current_refresh_token else None
    active_tokens = db.scalars(
        select(RefreshToken).where(RefreshToken.user_id == current_user.id, RefreshToken.revoked_at.is_(None))
    )
    for rt in active_tokens:
        if keep_hash and rt.token_hash == keep_hash:
            continue
        rt.revoked_at = now

    db.add(
        AccountSecurityLog(
            user_id=current_user.id,
            event_type="password_changed",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            created_at=now,
        )
    )
    db.commit()
    return SimpleMessageResponse(message="Đổi mật khẩu thành công.")


# ---------------------------------------------------------------------------
# UC-07 — Đổi SĐT (2 bước: gửi OTP tới SĐT mới -> xác nhận)
# ---------------------------------------------------------------------------
@router.post("/phone/request-otp", response_model=SimpleMessageResponse)
def request_phone_change(
    payload: RequestPhoneChangeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if current_user.auth_provider != "local":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản Google không dùng SĐT để đăng nhập.")

    if not verify_password(payload.current_password, current_user.password_hash or ""):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu xác nhận không đúng.")  # E1

    try:
        new_phone = normalize_phone(payload.new_phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    if new_phone == current_user.phone_number:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Số điện thoại mới giống số hiện tại.")

    existing = db.scalar(select(User).where(User.phone_number == new_phone))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Số điện thoại mới đã được dùng cho tài khoản khác.")  # E2

    otp_code = generate_otp()
    db.add(
        PhoneVerificationToken(
            user_id=current_user.id,
            purpose="change_phone",
            new_phone_number=new_phone,
            otp_code=otp_code,
            expires_at=utcnow() + timedelta(minutes=settings.OTP_EXPIRE_MINUTES),
            created_at=utcnow(),
        )
    )
    db.commit()
    _mock_send_sms(new_phone, otp_code, "change_phone")

    return SimpleMessageResponse(
        message="Đã gửi mã OTP tới số điện thoại mới.",
        dev_otp=otp_code if settings.DEV_MODE else None,
    )


@router.post("/phone/confirm", response_model=ProfileResponse)
def confirm_phone_change(
    payload: ConfirmPhoneChangeRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    token = db.scalar(
        select(PhoneVerificationToken)
        .where(
            PhoneVerificationToken.user_id == current_user.id,
            PhoneVerificationToken.purpose == "change_phone",
            PhoneVerificationToken.consumed_at.is_(None),
        )
        .order_by(PhoneVerificationToken.created_at.desc())
    )
    if token is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không có yêu cầu đổi SĐT nào đang chờ xác nhận.")

    now = utcnow()
    if token.locked_until and token.locked_until > now:
        remaining = int((token.locked_until - now).total_seconds() // 60) + 1
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Nhập sai quá nhiều lần, thử lại sau {remaining} phút.")

    if token.expires_at < now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mã OTP đã hết hạn. Vui lòng yêu cầu gửi lại.")  # E3

    if token.otp_code != payload.otp_code:
        token.attempt_count += 1
        if token.attempt_count >= settings.OTP_MAX_ATTEMPTS:
            token.locked_until = now + timedelta(minutes=settings.OTP_LOCK_MINUTES)
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mã OTP không đúng.")

    old_phone = current_user.phone_number
    current_user.phone_number = token.new_phone_number
    token.consumed_at = now

    db.add(
        AccountSecurityLog(
            user_id=current_user.id,
            event_type="phone_changed",
            old_phone_number=old_phone,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            created_at=now,
        )
    )
    db.commit()

    us = _get_or_create_settings(db, current_user.id)
    db.commit()
    return _to_profile(current_user, us)
