from collections.abc import Generator

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User
from app.security import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Dependency bảo vệ route — dùng để chứng minh JWT phát ra ở UC-01 dùng được thật.

    Không thuộc UC-01->05 nhưng cần thiết để bạn test "đăng nhập xong có vào được
    trang cần đăng nhập không" thay vì chỉ nhận được chuỗi token rồi bỏ đó.
    """
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Thiếu access token.")
    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Access token đã hết hạn.")
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Access token không hợp lệ.")

    user = db.get(User, payload["sub"])
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Tài khoản không tồn tại.")
    # UC-32 E2: khoá / vô hiệu hoá / buộc đặt lại mật khẩu có hiệu lực NGAY ở lần gọi API kế tiếp, kể cả khi
    # access token (24h) vẫn còn hạn — refresh token đã bị thu hồi lúc admin thao tác.
    if user.status in ("locked", "disabled"):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            {"message": "Tài khoản đã bị khoá. Vui lòng liên hệ hỗ trợ.", "code": "account_locked"},
        )
    if user.must_reset_password:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            {"message": "Quản trị viên yêu cầu bạn đặt lại mật khẩu.", "code": "must_reset_password"},
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    """BR-13: mọi endpoint /admin/* chỉ dành cho role='admin'."""
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Chỉ quản trị viên mới dùng được chức năng này.")
    return user
