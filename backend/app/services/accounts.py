"""UC-32 — thao tác trên tài khoản dùng chung cho trang Người dùng của admin và vòng nền tự xoá tài khoản
vô hiệu hoá quá 30 ngày (schedule_notifier).
"""
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import ChatAttachment, PdfDocument, RefreshToken, Subject, User
from app.services import audit
from app.services.schedule_notifier import local_now

DISABLED_KEEP_DAYS = 30


def revoke_sessions(db: Session, user_id: str) -> int:
    """Thu hồi mọi refresh token còn hiệu lực (khoá / vô hiệu hoá / buộc đặt lại mật khẩu). Trả số phiên."""
    result = db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=local_now())
    )
    return result.rowcount or 0


def _unlink(path: str | None) -> None:
    if not path:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass   # dọn file best-effort, không chặn việc xoá tài khoản


def delete_user(db: Session, user: User) -> dict:
    """Xoá vĩnh viễn: tệp trên đĩa (PDF, đính kèm chat) rồi dòng users — FK CASCADE dọn môn học, ghi chú, Quiz,
    Flashcard...; góp ý (feedback.user_id SET NULL) và nhật ký đăng nhập giữ ở dạng ẩn danh. Không commit."""
    pdfs = db.scalars(
        select(PdfDocument.file_path).join(Subject, Subject.id == PdfDocument.subject_id).where(Subject.owner_id == user.id)
    ).all()
    chats = db.scalars(
        select(ChatAttachment.file_path).where(ChatAttachment.user_id == user.id, ChatAttachment.kind == "file")
    ).all()
    subjects = db.scalar(select(Subject.id).where(Subject.owner_id == user.id).limit(1))
    for p in [*pdfs, *chats]:
        _unlink(p)
    db.delete(user)
    return {"files": len(pdfs) + len(chats), "had_subjects": subjects is not None}


def purge_disabled(db: Session) -> int:
    """Tự xoá tài khoản 'disabled' quá 30 ngày (UC-32). Ghi nhật ký với quản trị viên = "Hệ thống"."""
    cutoff = local_now() - timedelta(days=DISABLED_KEEP_DAYS)
    users = db.scalars(select(User).where(User.status == "disabled", User.disabled_at <= cutoff)).all()
    for u in users:
        audit.log(db, None, "acc", "Tự xoá tài khoản vô hiệu hoá", "Người dùng đã xoá",
                  "Ảnh chụp: " + audit.user_key(u), "Vô hiệu hoá", "Đã xoá", negative=True)
        delete_user(db, u)
    db.commit()
    return len(users)
