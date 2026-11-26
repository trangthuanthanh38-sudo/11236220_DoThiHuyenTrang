"""BR-13: tạo / gỡ quyền quản trị viên (thay trang "Phân quyền RBAC" đã bỏ — UC-33 cũ).

    python -m app.scripts.make_admin 0912345678            # tài khoản SĐT -> admin
    python -m app.scripts.make_admin ten@gmail.com         # tài khoản Google -> admin
    python -m app.scripts.make_admin 0912345678 --revoke   # về learner (chặn nếu là admin cuối cùng, BR-15)

Tài khoản phải đã đăng ký và đang hoạt động. Đăng nhập lại để JWT mang role mới; trang đăng nhập tự đưa admin
sang admin.html.
"""
import sys

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import User
from app.security import ValidationError, normalize_phone


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    ident, revoke = argv[0].strip(), "--revoke" in argv
    with SessionLocal() as db:
        if "@" in ident:
            user = db.scalar(select(User).where(func.lower(User.google_email) == ident.lower()))
        else:
            try:
                phone = normalize_phone(ident)
            except ValidationError:
                print("SĐT không hợp lệ:", ident)
                return 1
            user = db.scalar(select(User).where(User.phone_number == phone))
        if user is None:
            print("Không tìm thấy tài khoản:", ident)
            return 1
        if revoke:
            admins = db.scalar(select(func.count()).select_from(User).where(User.role == "admin")) or 0
            if user.role == "admin" and admins <= 1:
                print("Không thể gỡ quyền admin cuối cùng của hệ thống (BR-15).")
                return 1
            user.role = "learner"
        else:
            if user.status != "active":
                print("Tài khoản chưa hoạt động (trạng thái:", user.status + ").")
                return 1
            user.role = "admin"
        db.commit()
        print(f"{user.display_name}: role = {user.role}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
