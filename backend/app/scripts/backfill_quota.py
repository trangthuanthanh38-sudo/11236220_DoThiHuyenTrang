"""Bổ sung số liệu Hạn mức / Admin Console (UC-32 → UC-37) cho dữ liệu có TRƯỚC khi nhóm Quản trị được triển khai.

Chạy:  python -m app.scripts.backfill_quota        (an toàn chạy lại nhiều lần — chỉ ghi phần còn thiếu)

1. Tệp: `content_sha256` của PDF + tệp đính kèm chat (lọc "Tệp trùng"), `process_status` của PDF theo số chunk đã embed.
2. Lượt AI: dựng lại `ai_usage_events` (status='ok') từ lịch sử thật — câu trả lời chat Gemini, bộ ôn tập/đề thi, bộ thẻ,
   sơ đồ, lượt tạo tóm tắt, nhận xét AI. Chỉ thêm các bản ghi CŨ HƠN sự kiện sớm nhất đã có của cùng người + tính năng
   (sự kiện mới hơn đã được ghi thật lúc gọi AI). Token/chi phí của lịch sử không còn → để 0.
3. Mức dung lượng: `quota.refresh_level()` cho mọi người học (cột "Đã nhắc", tab Theo tài khoản).
"""
import hashlib
import os

from sqlalchemy import func, select, text

from app.database import SessionLocal
from app.models import AiUsageEvent, ChatAttachment, PdfDocument, User
from app.services import quota
from app.services.stats import utc_to_local

# (tính năng, SQL trả (user_id, thời điểm, model), thời điểm lưu theo UTC của DB?)
_SOURCES = [
    ("qa", """SELECT cs.user_id, m.created_at, m.model_name FROM chat_messages m JOIN chat_sessions cs ON cs.id = m.session_id
              WHERE m.role = 'assistant' AND m.model_name IS NOT NULL""", True),
    ("quiz", "SELECT user_id, created_at, model_name FROM quiz_sets WHERE model_name IS NOT NULL AND status = 'ready'", True),
    ("fc", "SELECT user_id, created_at, model_name FROM flashcard_sets WHERE model_name IS NOT NULL AND status = 'ready'", True),
    ("mind", "SELECT user_id, created_at, model_name FROM mindmaps WHERE model_name IS NOT NULL AND status = 'ready'", True),
    ("sum", "SELECT user_id, created_at, model_name FROM summary_generations WHERE user_id IS NOT NULL", True),
    ("review", "SELECT user_id, ai_at, model_name FROM stat_snapshots WHERE kind = 'ai' AND model_name IS NOT NULL AND ai_at IS NOT NULL", False),
]


def _sha(path: str | None) -> str | None:
    if not path or not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def backfill_files(db) -> dict:
    n_pdf = n_chat = n_status = 0
    for d in db.scalars(select(PdfDocument).where(PdfDocument.content_sha256.is_(None))):
        if (h := _sha(d.file_path)):
            d.content_sha256, n_pdf = h, n_pdf + 1
    for a in db.scalars(select(ChatAttachment).where(ChatAttachment.kind == "file", ChatAttachment.content_sha256.is_(None))):
        if (h := _sha(a.file_path)):
            a.content_sha256, n_chat = h, n_chat + 1
    # PDF còn "processing" (tải lên trước khi pipeline ghi trạng thái): có chunk -> ready, không -> empty
    chunks = dict(db.execute(text("SELECT document_id, COUNT(*) FROM embedding_chunks WHERE document_id IS NOT NULL GROUP BY document_id")).all())
    for d in db.scalars(select(PdfDocument).where(PdfDocument.process_status == "processing")):
        d.process_status, n_status = ("ready" if chunks.get(d.id) else "empty"), n_status + 1
    return {"pdf_sha": n_pdf, "chat_sha": n_chat, "pdf_status": n_status}


def backfill_usage(db) -> dict:
    first = {(u, f): t for u, f, t in db.execute(
        select(AiUsageEvent.user_id, AiUsageEvent.feature, func.min(AiUsageEvent.created_at))
        .group_by(AiUsageEvent.user_id, AiUsageEvent.feature))}
    added = {}
    for feature, sql, is_utc in _SOURCES:
        n = 0
        for uid, ts, model in db.execute(text(sql)):
            local = utc_to_local(ts) if is_utc else ts
            cut = first.get((uid, feature))
            if cut is not None and local >= cut:
                continue
            db.add(AiUsageEvent(user_id=uid, feature=feature, status="ok", model_name=model, created_at=local))
            n += 1
        added[feature] = n
    return added


def main() -> None:
    db = SessionLocal()
    try:
        files = backfill_files(db)
        usage = backfill_usage(db)
        db.flush()
        n_users = 0
        for uid in db.scalars(select(User.id).where(User.role == "learner")):
            quota.refresh_level(db, uid)
            n_users += 1
        db.commit()
        print("Tệp:", files)
        print("Lượt AI thêm từ lịch sử:", usage, "· tổng", sum(usage.values()))
        print("Đã tính lại mức dung lượng cho", n_users, "người học")
    finally:
        db.close()


if __name__ == "__main__":
    main()
