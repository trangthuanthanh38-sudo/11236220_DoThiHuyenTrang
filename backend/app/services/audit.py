"""UC-34 Nhật ký quản trị — ghi 1 dòng admin_audit_logs cho MỌI thao tác thay đổi dữ liệu của quản trị viên.

Bảng chỉ INSERT (trigger DB chặn UPDATE/DELETE, BR-18). `object_sub` dùng `user_key()` (SĐT / Gmail đầy đủ).
Không commit: đi chung transaction với
thao tác được ghi, thao tác lỗi thì log cũng không còn.
"""
from sqlalchemy.orm import Session

from app.models import AdminAuditLog, User
from app.services.schedule_notifier import local_now

SYSTEM_LABEL = "Hệ thống"


def local_phone(phone: str | None) -> str:
    """'+84912345678' (dạng lưu trong DB) -> '0912345678' (dạng người Việt quen nhìn/gõ)."""
    p = "".join(ch for ch in (phone or "") if ch.isdigit())
    return "0" + p[2:] if p.startswith("84") else p


def mask_phone(phone: str | None) -> str:
    p = local_phone(phone)
    return f"{p[:2]}xx xxx {p[-3:]}" if len(p) >= 6 else "—"


def mask_mail(mail: str | None) -> str:
    if not mail or "@" not in mail:
        return "—"
    a, d = mail.split("@", 1)
    return a[: max(1, min(len(a) - 1, 9))] + "***@" + d


def show_phone(phone: str | None) -> str:
    """'+84912345678' -> '0912 345 678' (SĐT đầy đủ, chia nhóm cho dễ đọc / đối chiếu khi admin tìm kiếm)."""
    p = local_phone(phone)
    return f"{p[:4]} {p[4:7]} {p[7:]}" if len(p) == 10 else (p or "—")


def user_key(user: User) -> str:
    """Định danh hiển thị cho admin: SĐT hoặc Gmail ĐẦY ĐỦ (người dùng chốt — để tìm kiếm / liên hệ)."""
    return (user.google_email or "—") if user.auth_provider == "google" else show_phone(user.phone_number)


def log(db: Session, admin: User | None, category: str, action: str, obj: str, sub: str | None = None,
        from_value: str = "—", to_value: str = "—", negative: bool = False) -> None:
    db.add(AdminAuditLog(
        admin_id=admin.id if admin else None,
        admin_label=(admin.display_name if admin else SYSTEM_LABEL)[:100],
        category=category, action=action[:100], object_label=(obj or "—")[:255],
        object_sub=(sub or None) and sub[:255], from_value=(from_value or "—")[:255], to_value=(to_value or "—")[:255],
        is_negative=negative, created_at=local_now(),
    ))
