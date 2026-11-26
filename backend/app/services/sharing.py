"""Quyền truy cập Môn / Chương / tệp PDF khi có CHIA SẺ (database/sharing_schema.sql) — chỗ DUY NHẤT tính quyền.

Quyền: 'owner' (chủ Môn) > 'editor' (Có thể chỉnh sửa) > 'viewer' (Có thể xem) > None (không thấy gì).
  - Môn: owner hoặc quyền chia sẻ cả Môn.
  - Chương: owner hoặc CAO NHẤT của (quyền cả Môn, quyền riêng Chương).
  - Tệp PDF: owner hoặc quyền cả Môn (PDF không chia sẻ riêng).
Không có quyền -> 404 như BR-05 (không lộ tài nguyên tồn tại); có quyền nhưng thiếu (viewer muốn sửa) -> 403.
API AI Studio KHÔNG dùng module này — vẫn chỉ chủ sở hữu (người dùng chốt: nội dung được chia sẻ không làm nguồn AI).
"""
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Chapter, PdfDocument, Share, Subject, User

RANK = {None: 0, "viewer": 1, "editor": 2, "owner": 3}
_NOT_FOUND = {"subject": "Không tìm thấy môn học.", "chapter": "Không tìm thấy chương.", "pdf": "Không tìm thấy tệp PDF."}


def best(*roles: str | None) -> str | None:
    return max(roles, key=lambda r: RANK[r]) if roles else None


def grant_role(db: Session, user_id: str, target_type: str, target_id: str) -> str | None:
    return db.scalar(
        select(Share.role).where(Share.grantee_id == user_id, Share.target_type == target_type, Share.target_id == target_id)
    )


def subject_role(db: Session, subject: Subject, user: User) -> str | None:
    if subject.owner_id == user.id:
        return "owner"
    return grant_role(db, user.id, "subject", subject.id)


def chapter_role(db: Session, chapter: Chapter, user: User) -> str | None:
    if chapter.subject.owner_id == user.id:
        return "owner"
    return best(grant_role(db, user.id, "subject", chapter.subject_id), grant_role(db, user.id, "chapter", chapter.id))


def pdf_role(db: Session, doc: PdfDocument, user: User) -> str | None:
    if doc.subject.owner_id == user.id:
        return "owner"
    return grant_role(db, user.id, "subject", doc.subject_id)


def _check(role: str | None, need: str, kind: str) -> None:
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND[kind])
    if RANK[role] < RANK[need]:
        msg = "Chỉ chủ sở hữu mới làm được thao tác này." if need == "owner" else "Bạn chỉ có quyền xem nội dung này."
        raise HTTPException(status.HTTP_403_FORBIDDEN, msg)


def get_subject(db: Session, subject_id: str, user: User, need: str = "viewer") -> tuple[Subject, str]:
    subject = db.get(Subject, subject_id)
    role = subject_role(db, subject, user) if subject else None
    _check(role, need, "subject")
    return subject, role


def get_chapter(db: Session, chapter_id: str, user: User, need: str = "viewer") -> tuple[Chapter, str]:
    chapter = db.get(Chapter, chapter_id)
    role = chapter_role(db, chapter, user) if chapter else None
    _check(role, need, "chapter")
    return chapter, role


def get_pdf(db: Session, document_id: str, user: User, need: str = "viewer") -> tuple[PdfDocument, str]:
    doc = db.get(PdfDocument, document_id)
    role = pdf_role(db, doc, user) if doc else None
    _check(role, need, "pdf")
    return doc, role


def person(user: User | None, with_contact: bool = False) -> dict:
    """Thông tin hiển thị 1 tài khoản trong hộp chia sẻ. SĐT bị che giữa (chỉ chủ sở hữu thấy contact)."""
    if user is None:
        return {"id": "", "name": "Tài khoản đã xoá", "avatar": None, "contact": None}
    contact = None
    if with_contact:
        if user.auth_provider == "google":
            contact = user.google_email
        elif user.phone_number:
            p = "0" + user.phone_number[3:] if user.phone_number.startswith("+84") else user.phone_number
            contact = p[:4] + "•••" + p[-3:]
    return {"id": user.id, "name": user.display_name, "avatar": user.avatar_url, "contact": contact}
