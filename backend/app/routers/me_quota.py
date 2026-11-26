"""UC-33 — Hạn mức phía người học (màn tham chiếu: han-muc-nguoi-hoc.html, gắn vào ghichu.html).

  - GET  /me/quota         thanh Dung lượng + dải nhắc 3 mức + "Còn x / y lượt hôm nay" của từng thẻ Studio
  - GET  /me/files         bảng "Dọn dung lượng": PDF + tệp đính kèm chat + ảnh góp ý, lớn nhất trước; lọc
                           all | dup (cùng nội dung SHA-256, giữ bản cũ nhất làm gốc) | old (chưa mở ≥ 30 ngày) |
                           err (lỗi OCR / tệp trống) | subject (PDF của 1 Môn)
  - POST /me/files/delete  xoá thật — frontend chỉ gọi khi hết 6 giây "Hoàn tác" (cùng cách Tóm tắt / cardlist)

`cited` = số trích dẫn AI đang trỏ tới tệp (câu trả lời chat, câu hỏi, thẻ, node sơ đồ, ý tóm tắt) — các trích dẫn
này giữ snapshot nên xoá tệp chỉ khiến chúng hiện "Nguồn đã bị xoá". Mọi số liệu tính theo hạn mức hiện hành
(services/quota.py); xoá xong tính lại mức nhắc (refresh_level).
"""
import hashlib
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import (
    ChatAttachment,
    ChatMessageCitation,
    EmbeddingChunk,
    Feedback,
    Flashcard,
    MindmapNode,
    PdfDocument,
    QuizQuestionCitation,
    Subject,
    SummaryPoint,
    User,
)
from app.schemas import MyFileOut, MyFilesDeleteOut, MyFilesDeleteRequest, MyQuotaOut
from app.services import quota
from app.services.schedule_notifier import local_now

router = APIRouter(prefix="/me", tags=["Hạn mức (UC-33)"])

OLD_DAYS = 30


@router.get("/quota", response_model=MyQuotaOut)
def my_quota(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    u = quota.usage(db, current_user.id)
    cfg = u["cfg"]
    names = dict(db.execute(select(Subject.id, Subject.name).where(Subject.owner_id == current_user.id)).all())
    uses = quota.uses_today(db, current_user.id)
    fb_used = quota.feedback_today(db, current_user.id)
    return {
        "storage": {
            "used_bytes": u["used"], "limit_bytes": u["limit"], "free_bytes": max(0, u["limit"] - u["used"]),
            "pct": round(u["storage_pct"], 1), "level": u["level"], "by_type": u["by_type"],
            "avg_pdf_bytes": quota._avg_pdf_bytes(db, current_user.id),
            "file_limit_mb": cfg["storage.file_mb"], "subject_files_limit": cfg["storage.subject_files"],
            "subjects": [{"id": sid, "name": names.get(sid, ""), "count": n} for sid, n in u["subject_counts"].items()],
        },
        "ai": [
            # Hỏi đáp (PER_SESSION): hạn mức theo từng cuộc hội thoại — lượt còn lại của phiên trả ở ChatSessionOut
            {"feature": f, "name": name, "used": uses[f], "limit": cfg[key], "per_session": f in quota.PER_SESSION,
             "remaining": cfg[key] if f in quota.PER_SESSION else max(0, cfg[key] - uses[f])}
            for f, (key, name, _) in quota.FEATURES.items()
        ],
        "feedback": {"feature": "feedback", "name": quota.FEEDBACK[1], "used": fb_used, "limit": cfg["feedback"],
                     "remaining": max(0, cfg["feedback"] - fb_used)},
        "warn": {"w1": cfg["warn.w1"], "w2": cfg["warn.w2"], "ai": cfg["warn.ai"]},
        "reset_in_seconds": quota.seconds_to_midnight(),
    }


@router.get("/quota/changes/{change_id}")
def quota_change_detail(change_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Chi tiết 1 lần đổi hạn mức (bấm thông báo kind quota_change): lý do, từng thay đổi cũ -> mới, tạm thời tới đâu.
    Hạn mức là cấu hình chung nên mọi người dùng đã đăng nhập đều xem được."""
    from app.models import QuotaChangeEvent

    e = db.get(QuotaChangeEvent, change_id)
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy lần thay đổi hạn mức này.")
    return {"id": e.id, "kind": e.kind, "reason": e.reason, "changes": e.changes,
            "expires_at": e.expires_at.isoformat(timespec="minutes") if e.expires_at else None,
            "created_at": e.created_at.isoformat(timespec="minutes"),
            "active_until": {k: t["expires_at"].isoformat(timespec="minutes") for k, t in quota.temporary(db).items()}}


def _cited_counts(db: Session, doc_ids: list[str]) -> dict[str, int]:
    """Số trích dẫn AI trỏ tới từng PDF (qua chunk đang có + các bảng snapshot giữ document_id)."""
    if not doc_ids:
        return {}
    out: dict[str, int] = {}

    def add(rows):
        for did, n in rows:
            if did:
                out[did] = out.get(did, 0) + n

    by_chunk = lambda model: db.execute(  # noqa: E731 — bảng chỉ giữ embedding_chunk_id
        select(EmbeddingChunk.document_id, func.count())
        .join(model, model.embedding_chunk_id == EmbeddingChunk.id)
        .where(EmbeddingChunk.document_id.in_(doc_ids)).group_by(EmbeddingChunk.document_id)
    ).all()
    add(by_chunk(ChatMessageCitation))
    add(by_chunk(SummaryPoint))
    for model in (QuizQuestionCitation, Flashcard, MindmapNode):
        add(db.execute(
            select(model.document_id, func.count()).where(model.document_id.in_(doc_ids)).group_by(model.document_id)
        ).all())
    return out


def _days(dt: datetime | None, now: datetime) -> int | None:
    return max(0, (now.date() - dt.date()).days) if dt else None


def _ensure_hash(doc: PdfDocument) -> None:
    """PDF tải lên trước khi có cột content_sha256 → tính bù 1 lần (đọc tệp trên đĩa)."""
    if doc.content_sha256 is None:
        try:
            doc.content_sha256 = hashlib.sha256(Path(doc.file_path).read_bytes()).hexdigest()
        except OSError:
            doc.content_sha256 = "missing:" + doc.id[:55]


@router.get("/files", response_model=list[MyFileOut])
def my_files(
    filter: str = Query("all", pattern="^(all|dup|old|err|subject)$"),
    subject_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = local_now()
    docs = db.execute(
        select(PdfDocument, Subject.name).join(Subject, Subject.id == PdfDocument.subject_id)
        .where(Subject.owner_id == current_user.id)
    ).all()
    for d, _ in docs:
        _ensure_hash(d)
    db.commit()
    chats = db.scalars(
        select(ChatAttachment).where(ChatAttachment.user_id == current_user.id, ChatAttachment.kind == "file")
    ).all()
    fbs = db.scalars(
        select(Feedback).where(Feedback.user_id == current_user.id, Feedback.image_path.is_not(None))
    ).all()
    cited = _cited_counts(db, [d.id for d, _ in docs])

    items: list[dict] = []
    for d, sname in docs:
        items.append({"type": "pdf", "id": d.id, "name": d.original_name, "subject_id": d.subject_id,
                      "subject_name": sname, "size_bytes": d.file_size_bytes,
                      "opened_days_ago": _days(d.last_opened_at or d.created_at, now),
                      "status": d.process_status, "cited": cited.get(d.id, 0),
                      "_hash": d.content_sha256, "_at": d.created_at})
    for c in chats:
        items.append({"type": "chat", "id": c.id, "name": c.original_name or c.label, "size_bytes": c.file_size_bytes or 0,
                      "opened_days_ago": _days(c.created_at, now), "status": "none",
                      "_hash": c.content_sha256, "_at": c.created_at})
    for f in fbs:
        items.append({"type": "fb", "id": str(f.id), "name": f.image_name or "anh-gop-y", "size_bytes": f.image_bytes or 0,
                      "opened_days_ago": _days(f.created_at, now), "status": "none", "_hash": None, "_at": f.created_at})

    # Tệp trùng: cùng hash -> bản tải lên sớm nhất là gốc, các bản sau ghi dup_of = tên bản gốc
    first: dict[str, dict] = {}
    for it in sorted(items, key=lambda x: x["_at"] or now):
        h = it["_hash"]
        if not h:
            continue
        if h in first:
            it["dup_of"] = first[h]["name"]
        else:
            first[h] = it

    if filter == "dup":
        items = [i for i in items if i.get("dup_of")]
    elif filter == "old":
        items = [i for i in items if (i["opened_days_ago"] or 0) >= OLD_DAYS]
    elif filter == "err":
        items = [i for i in items if i["status"] in ("ocr_error", "empty")]
    elif filter == "subject":
        items = [i for i in items if i["type"] == "pdf" and (subject_id is None or i["subject_id"] == subject_id)]
    items.sort(key=lambda i: i["size_bytes"], reverse=True)
    for i in items:
        i.pop("_hash"), i.pop("_at")
    return items


def _unlink(path: str | None) -> None:
    if path:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


@router.post("/files/delete", response_model=MyFilesDeleteOut)
def delete_my_files(
    payload: MyFilesDeleteRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Xoá nhiều tệp một lúc (chỉ tệp của chính mình — id lạ / của người khác bị bỏ qua, không lỗi)."""
    deleted = freed = 0
    if payload.pdf_ids:
        for d in db.scalars(
            select(PdfDocument).join(Subject, Subject.id == PdfDocument.subject_id)
            .where(PdfDocument.id.in_(payload.pdf_ids), Subject.owner_id == current_user.id)
        ).all():
            _unlink(d.file_path)
            freed += d.file_size_bytes
            deleted += 1
            db.delete(d)
    if payload.attachment_ids:
        for c in db.scalars(
            select(ChatAttachment).where(ChatAttachment.id.in_(payload.attachment_ids),
                                         ChatAttachment.user_id == current_user.id, ChatAttachment.kind == "file")
        ).all():
            _unlink(c.file_path)
            freed += c.file_size_bytes or 0
            deleted += 1
            db.delete(c)
    if payload.feedback_ids:
        for f in db.scalars(
            select(Feedback).where(Feedback.id.in_(payload.feedback_ids), Feedback.user_id == current_user.id,
                                   Feedback.image_path.is_not(None))
        ).all():
            _unlink(f.image_path)
            freed += f.image_bytes or 0
            deleted += 1
            f.image_path = f.image_name = f.image_bytes = None
    db.flush()
    level = quota.refresh_level(db, current_user.id)
    db.commit()
    return {"deleted": deleted, "freed_bytes": freed, "level": level}
