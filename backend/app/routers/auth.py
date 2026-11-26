"""Endpoint UC-01 -> UC-05 (nhóm Xác thực & Truy cập).

Nhánh SĐT (local) + nhánh Google (luồng 3a của UC-01/UC-02, POST /auth/google): token Google được xác minh
với chính Google (services/google_auth.py); `google_sub` chưa có thì tự tạo tài khoản rồi đăng nhập luôn (không
báo "tài khoản không tồn tại"), tài khoản Google coi như đã xác thực (BR-04), không có mật khẩu.
"""
import re

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.services import google_auth
from app.models import LoginAuditLog, PasswordResetToken, PhoneVerificationToken, RefreshToken, User, UserSettings
from app.schemas import (
    ForgotPasswordRequest,
    GoogleConfigOut,
    GoogleLoginRequest,
    GoogleLoginResponse,
    LoginRequest,
    LoginResponse,
    LogoutRequest,
    RegisterRequest,
    RegisterResponse,
    ResendOtpRequest,
    ResetPasswordRequest,
    SimpleMessageResponse,
    UserPublic,
    VerifyOtpRequest,
)
from app.security import (
    ValidationError,
    create_access_token,
    generate_otp,
    generate_refresh_token,
    hash_password,
    hash_token,
    normalize_phone,
    utcnow,
    validate_password_strength,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_NAME_FORBIDDEN = re.compile(r'[<>{}\\/"|]')   # cùng bộ ký tự UC-06 E2 chặn ở Hồ sơ


def _start_session(db: Session, user: User, client_ip: str | None, user_agent: str | None) -> tuple[str, str]:
    """Phát refresh token (lưu hash) + access token JWT (BR-03). Người gọi tự commit."""
    now = utcnow()
    raw_refresh = generate_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw_refresh),
            device_info=user_agent,
            ip_address=client_ip,
            issued_at=now,
            expires_at=now + timedelta(days=settings.JWT_REFRESH_EXPIRE_DAYS),
        )
    )
    return create_access_token(user.id, user.role), raw_refresh


def _public(user: User) -> UserPublic:
    return UserPublic(
        id=user.id, phone_number=user.phone_number, display_name=user.display_name, role=user.role, status=user.status,
    )


def _mock_send_sms(phone: str, otp_code: str, purpose: str) -> None:
    """Giả lập gửi SMS — chưa nối tổng đài thật, chỉ log ra console.

    Thay hàm này bằng tích hợp nhà cung cấp SMS thật (Twilio/eSMS/Speedsms...)
    khi triển khai production. KHÔNG bao giờ log OTP ra console ở production.
    """
    print(f"[MOCK SMS] Gửi OTP '{otp_code}' tới {phone} (mục đích: {purpose})")


# ---------------------------------------------------------------------------
# UC-02 — Đăng ký (nhánh SĐT)
# ---------------------------------------------------------------------------
@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    if payload.password != payload.confirm_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu xác nhận không khớp.")

    try:
        validate_password_strength(payload.password)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    # E2: SĐT đã tồn tại -> gợi ý đăng nhập
    existing = db.scalar(select(User).where(User.phone_number == phone))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Số điện thoại đã được đăng ký, vui lòng đăng nhập.")

    user = User(
        phone_number=phone,
        auth_provider="local",
        password_hash=hash_password(payload.password),
        display_name=payload.display_name.strip(),
        role="learner",
        status="pending_verification",
    )
    db.add(user)
    db.flush()  # để lấy user.id trước khi tạo token

    # UC-02 bước 4: "khởi tạo PROGRESS + USER_SETTINGS mặc định" (PROGRESS thuộc nhóm
    # UC-10/11, chưa triển khai — chỉ khởi tạo USER_SETTINGS ở đây).
    db.add(UserSettings(user_id=user.id))

    otp_code = generate_otp()
    token = PhoneVerificationToken(
        user_id=user.id,
        purpose="register",
        otp_code=otp_code,
        expires_at=utcnow() + timedelta(minutes=settings.OTP_EXPIRE_MINUTES),
        created_at=utcnow(),
    )
    db.add(token)
    db.commit()

    _mock_send_sms(phone, otp_code, "register")

    return RegisterResponse(
        message="Đăng ký thành công. Vui lòng nhập mã OTP đã gửi tới SĐT để kích hoạt tài khoản.",
        user_id=user.id,
        phone_number=phone,
        dev_otp=otp_code if settings.DEV_MODE else None,
    )


# ---------------------------------------------------------------------------
# UC-03 — Xác thực SĐT qua OTP
# ---------------------------------------------------------------------------
@router.post("/verify-otp", response_model=SimpleMessageResponse)
def verify_otp(payload: VerifyOtpRequest, db: Session = Depends(get_db)):
    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    user = db.scalar(select(User).where(User.phone_number == phone, User.auth_provider == "local"))
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tài khoản với số điện thoại này.")

    if user.status == "active":
        return SimpleMessageResponse(message="Tài khoản đã được kích hoạt từ trước.")

    token = db.scalar(
        select(PhoneVerificationToken)
        .where(
            PhoneVerificationToken.user_id == user.id,
            PhoneVerificationToken.purpose == "register",
            PhoneVerificationToken.consumed_at.is_(None),
        )
        .order_by(PhoneVerificationToken.created_at.desc())
    )
    if token is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không có mã OTP nào đang chờ xác thực. Vui lòng gửi lại mã.")

    now = utcnow()
    if token.locked_until and token.locked_until > now:
        remaining = int((token.locked_until - now).total_seconds() // 60) + 1
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Nhập sai quá nhiều lần, thử lại sau {remaining} phút.")

    if token.expires_at < now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mã OTP đã hết hạn. Vui lòng gửi lại mã mới.")

    if token.otp_code != payload.otp_code:
        token.attempt_count += 1
        if token.attempt_count >= settings.OTP_MAX_ATTEMPTS:
            token.locked_until = now + timedelta(minutes=settings.OTP_LOCK_MINUTES)
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mã OTP không đúng.")

    token.consumed_at = now
    user.status = "active"
    user.phone_verified_at = now
    db.commit()

    return SimpleMessageResponse(message="Xác thực số điện thoại thành công. Bạn có thể đăng nhập.")


@router.post("/resend-otp", response_model=SimpleMessageResponse)
def resend_otp(payload: ResendOtpRequest, db: Session = Depends(get_db)):
    """UC-03 E1: cho gửi lại, tối đa 3 lần/giờ."""
    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    user = db.scalar(select(User).where(User.phone_number == phone, User.auth_provider == "local"))
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tài khoản với số điện thoại này.")
    if user.status == "active":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản đã được xác thực, không cần gửi lại mã.")

    one_hour_ago = utcnow() - timedelta(hours=1)
    recent_count = db.scalar(
        select(func.count())
        .select_from(PhoneVerificationToken)
        .where(
            PhoneVerificationToken.user_id == user.id,
            PhoneVerificationToken.purpose == "register",
            PhoneVerificationToken.created_at >= one_hour_ago,
        )
    )
    if recent_count and recent_count >= settings.OTP_MAX_RESEND_PER_HOUR:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Đã gửi lại quá số lần cho phép (tối đa {settings.OTP_MAX_RESEND_PER_HOUR} lần/giờ). Vui lòng thử lại sau.",
        )

    otp_code = generate_otp()
    db.add(
        PhoneVerificationToken(
            user_id=user.id,
            purpose="register",
            otp_code=otp_code,
            expires_at=utcnow() + timedelta(minutes=settings.OTP_EXPIRE_MINUTES),
            created_at=utcnow(),
        )
    )
    db.commit()
    _mock_send_sms(phone, otp_code, "register-resend")

    return SimpleMessageResponse(
        message="Đã gửi lại mã OTP.",
        dev_otp=otp_code if settings.DEV_MODE else None,
    )


# ---------------------------------------------------------------------------
# UC-01 — Đăng nhập
# ---------------------------------------------------------------------------
@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    def _log(user_id: str | None, phone_attempt: str, success: bool) -> None:
        db.add(
            LoginAuditLog(
                user_id=user_id,
                phone_attempt=phone_attempt,
                auth_provider="local",
                success=success,
                ip_address=client_ip,
                user_agent=user_agent,
                created_at=utcnow(),
            )
        )

    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError:
        # E1: không tiết lộ trường sai -> coi định dạng sai cũng là sai thông tin đăng nhập
        _log(None, payload.phone_number, False)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Số điện thoại hoặc mật khẩu không đúng.")

    user = db.scalar(select(User).where(User.phone_number == phone, User.auth_provider == "local"))
    if user is None:
        _log(None, phone, False)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Số điện thoại hoặc mật khẩu không đúng.")

    now = utcnow()

    # E4: đang trong thời gian khoá tạm do đăng nhập sai nhiều lần
    if user.locked_until and user.locked_until > now:
        remaining = int((user.locked_until - now).total_seconds() // 60) + 1
        _log(user.id, phone, False)
        db.commit()
        raise HTTPException(status.HTTP_423_LOCKED, f"Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau {remaining} phút.")

    # E3: tài khoản bị khoá / vô hiệu hoá bởi admin (UC-32)
    if user.status in ("locked", "disabled"):
        _log(user.id, phone, False)
        db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Tài khoản đã bị khoá. Vui lòng liên hệ hỗ trợ.")

    if not user.password_hash or not verify_password(payload.password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= settings.MAX_FAILED_LOGIN:
            user.locked_until = now + timedelta(minutes=settings.LOGIN_LOCK_MINUTES)
            user.failed_login_attempts = 0
        _log(user.id, phone, False)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Số điện thoại hoặc mật khẩu không đúng.")

    # E2: chưa xác thực OTP (mật khẩu đúng nhưng chưa kích hoạt)
    if user.status == "pending_verification":
        _log(user.id, phone, False)
        db.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Tài khoản chưa xác thực SĐT. Vui lòng xác thực OTP trước khi đăng nhập.")

    # UC-32 "Buộc đặt lại mật khẩu": mật khẩu cũ đúng vẫn không vào được — phải qua UC-04 (OTP)
    if user.must_reset_password:
        _log(user.id, phone, False)
        db.commit()
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {"message": "Quản trị viên yêu cầu bạn đặt lại mật khẩu. Hãy dùng \"Quên mật khẩu\" để xác minh OTP và đặt mật khẩu mới.",
             "code": "must_reset_password"},
        )

    # Thành công
    user.failed_login_attempts = 0
    access_token, raw_refresh = _start_session(db, user, client_ip, user_agent)
    _log(user.id, phone, True)
    db.commit()
    return LoginResponse(access_token=access_token, refresh_token=raw_refresh, user=_public(user))


# ---------------------------------------------------------------------------
# UC-01 / UC-02 luồng 3a — Đăng nhập / đăng ký bằng Google
# ---------------------------------------------------------------------------
@router.get("/google/config", response_model=GoogleConfigOut)
def google_config():
    """Frontend hỏi Client ID để khởi tạo popup Google; chưa cấu hình thì nút Google bị khoá."""
    if not google_auth.is_configured():
        return GoogleConfigOut(enabled=False)
    return GoogleConfigOut(enabled=True, client_id=settings.GOOGLE_CLIENT_ID.strip())


@router.post("/google", response_model=GoogleLoginResponse)
def login_google(payload: GoogleLoginRequest, request: Request, db: Session = Depends(get_db)):
    client_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")
    if not google_auth.is_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Máy chủ chưa cấu hình đăng nhập Google (GOOGLE_CLIENT_ID).")
    try:
        g = google_auth.verify_access_token(payload.access_token)
    except google_auth.GoogleUnavailable:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Không kết nối được tới Google, vui lòng thử lại.")
    except google_auth.GoogleAuthError:
        # E5: token không hợp lệ / hết hạn / cấp cho ứng dụng khác
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập Google lại.")
    if not g["email"] or not g["email_verified"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản Google chưa có email đã xác minh.")

    def _log(user_id: str | None, success: bool) -> None:
        db.add(LoginAuditLog(user_id=user_id, phone_attempt=None, auth_provider="google", success=success,
                             ip_address=client_ip, user_agent=user_agent, created_at=utcnow()))

    user = db.scalar(select(User).where(User.google_sub == g["sub"]))
    is_new = user is None
    name = (_NAME_FORBIDDEN.sub("", g["name"]).strip() or g["email"].split("@")[0])[:100]
    if is_new:
        # Nhánh Google của UC-02: tạo tài khoản, coi như đã xác thực ngay (BR-04)
        user = User(
            google_sub=g["sub"],
            google_email=g["email"],
            google_name=name,
            auth_provider="google",
            password_hash=None,
            display_name=name,
            avatar_url=g["picture"] if (g["picture"] or "").startswith("https://") else None,
            role="learner",
            status="active",
            phone_verified_at=utcnow(),
        )
        db.add(user)
        db.flush()
        db.add(UserSettings(user_id=user.id))   # UC-02 bước 4: USER_SETTINGS mặc định
    else:
        if user.status in ("locked", "disabled"):   # E3: bị khoá / vô hiệu hoá bởi quản trị (UC-32)
            _log(user.id, False)
            db.commit()
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Tài khoản đã bị khoá. Vui lòng liên hệ hỗ trợ.")
        user.google_email = g["email"]   # đổi Gmail chính ở phía Google -> nhắc lịch gửi tới địa chỉ mới
        # Tên: chưa tự đổi ở Hồ sơ (vẫn trùng tên Google cũ) -> theo tên Google mới; đã tự đổi thì giữ nguyên
        if user.google_name is not None and user.display_name == user.google_name:
            user.display_name = name
        user.google_name = name
        if not user.avatar_url and (g["picture"] or "").startswith("https://"):
            user.avatar_url = g["picture"]

    access_token, raw_refresh = _start_session(db, user, client_ip, user_agent)
    _log(user.id, True)
    db.commit()
    return GoogleLoginResponse(access_token=access_token, refresh_token=raw_refresh, user=_public(user), is_new=is_new)


# ---------------------------------------------------------------------------
# UC-05 — Đăng xuất
# ---------------------------------------------------------------------------
@router.post("/logout", response_model=SimpleMessageResponse)
def logout(payload: LogoutRequest, db: Session = Depends(get_db)):
    token_hash = hash_token(payload.refresh_token)
    token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    if token is not None and token.revoked_at is None:
        token.revoked_at = utcnow()
        db.commit()
    # E1: refresh token hết hạn/không hợp lệ -> vẫn coi như đăng xuất thành công
    return SimpleMessageResponse(message="Đã đăng xuất.")


# ---------------------------------------------------------------------------
# UC-04 — Khôi phục mật khẩu (chỉ auth_provider='local')
# ---------------------------------------------------------------------------
@router.post("/forgot-password", response_model=SimpleMessageResponse)
def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    generic_message = "Nếu số điện thoại tồn tại trong hệ thống, mã OTP đặt lại mật khẩu đã được gửi."

    user = db.scalar(select(User).where(User.phone_number == phone, User.auth_provider == "local"))
    if user is None:
        # E1: không tiết lộ SĐT có tồn tại hay không
        return SimpleMessageResponse(message=generic_message)

    otp_code = generate_otp()
    db.add(
        PasswordResetToken(
            user_id=user.id,
            otp_code=otp_code,
            expires_at=utcnow() + timedelta(minutes=settings.OTP_EXPIRE_MINUTES),
            created_at=utcnow(),
        )
    )
    db.commit()
    _mock_send_sms(phone, otp_code, "reset-password")

    return SimpleMessageResponse(
        message=generic_message,
        # dev_otp chỉ để bạn test cục bộ không cần SMS thật — KHÔNG làm vậy ở production
        # (sẽ lộ ngược việc SĐT có tồn tại, phá vỡ đúng mục đích chống dò của E1).
        dev_otp=otp_code if settings.DEV_MODE else None,
    )


@router.post("/reset-password", response_model=SimpleMessageResponse)
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(get_db)):
    try:
        phone = normalize_phone(payload.phone_number)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    user = db.scalar(select(User).where(User.phone_number == phone, User.auth_provider == "local"))
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Số điện thoại hoặc mã OTP không đúng.")
    # Lưu ý: với schema hiện tại, tài khoản 'google' KHÔNG BAO GIỜ có phone_number
    # (ràng buộc CHECK ở database/auth_schema.sql) nên nhánh E4 "SĐT thuộc tài khoản
    # Google" không thể xảy ra ở đây — được loại trừ ngay từ thiết kế dữ liệu.

    token = db.scalar(
        select(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.consumed_at.is_(None))
        .order_by(PasswordResetToken.created_at.desc())
    )
    now = utcnow()
    if token is None or token.expires_at < now or token.otp_code != payload.otp_code:
        if token is not None and token.otp_code != payload.otp_code:
            token.attempt_count += 1
            db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mã OTP không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu gửi lại.")

    if payload.new_password != payload.confirm_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mật khẩu xác nhận không khớp.")
    try:
        validate_password_strength(payload.new_password)
    except ValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))

    user.password_hash = hash_password(payload.new_password)
    user.must_reset_password = False   # UC-32 "Buộc đặt lại mật khẩu" hoàn tất
    token.consumed_at = now

    # Thu hồi toàn bộ refresh token cũ -> đăng xuất mọi thiết bị
    active_tokens = db.scalars(
        select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
    )
    for rt in active_tokens:
        rt.revoked_at = now

    db.commit()
    return SimpleMessageResponse(message="Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.")


# ---------------------------------------------------------------------------
# Tiện ích test: xác nhận JWT phát ra ở UC-01 dùng để gọi API bảo vệ được thật
# ---------------------------------------------------------------------------
@router.get("/me", response_model=UserPublic)
def me(current_user: User = Depends(get_current_user)):
    return UserPublic(
        id=current_user.id,
        phone_number=current_user.phone_number,
        display_name=current_user.display_name,
        role=current_user.role,
        status=current_user.status,
    )
