"""Endpoint UC-12 -> UC-18 (nhóm Quản lý Tri thức & Nội dung) + chức năng "tải PDF
lên trong cột 1 - Notebook" (mở rộng UC-16, xem comment đầu
database/knowledge_content_schema.sql).

Xem .claude/rules/07-knowledge-content.md. Frontend hiện tại (frontend/js/ghichu.js)
có cây 2 tầng Môn học -> {Chương, File PDF} — Chương và File PDF là 2 loại item ĐỘC
LẬP, ngang hàng nhau dưới 1 Môn học (không có node "Bài ghi chú" riêng, và PDF không
nằm trong 1 Chương cụ thể nào — xem khối "CẬP NHẬT TIẾP" đầu file .sql). Bảng `notes`
(đặc tả 3 tầng chính thức) vẫn CHƯA có model/route ở đây.

Ghi chú thiết kế quan trọng:
  - BR-05: mọi endpoint đều lọc theo owner_id = current_user.id (qua chuỗi quan hệ
    Subject -> {Chapter | PdfDocument -> PdfAnnotation}); không tìm thấy hoặc không
    phải chủ sở hữu đều trả 404 như nhau (không tiết lộ tài nguyên tồn tại).
  - BR-10: xoá Subject dựa vào ON DELETE CASCADE của DB (qua cascade="all,
    delete-orphan" ở models.py) để dọn luôn Chapter/PdfDocument/PdfAnnotation con —
    chỉ cần tự dọn thêm file PDF vật lý trên đĩa (DB không biết).
  - BR-14: chỉ nhận đúng .pdf/application/pdf, giới hạn dung lượng theo
    hạn mức UC-33 (services/quota.check_upload: kích thước tệp, số tệp/môn, dung lượng/người). File gốc lưu trên đĩa (settings.PDF_UPLOAD_DIR), DB chỉ giữ
    metadata (pdf_documents) — KHÔNG có cột BLOB nào.
  - 1 Môn học có thể có NHIỀU File PDF (khác với thiết kế cũ "1 Chương 1 PDF thay thế
    khi tải lại") — mỗi lần tải lên tạo 1 pdf_documents mới, xếp cuối danh sách
    (sort_order); đổi tên/xoá/kéo-thả sang Môn học khác dùng PUT/DELETE riêng.
  - page_count: PDF.js parse được số trang ngay khi mở tệp phía client (chưa cần công
    parse PDF ở backend), nên upload xong để NULL rồi frontend gọi PATCH
    /pdf/{id}/page-count điền vào — tránh thêm một dependency parse PDF chỉ cho việc
    này (xem comment `pdf_documents.page_count` trong file .sql).
  - pdf_annotations hỗ trợ UPDATE tại chỗ (PUT /pdf/annotations/{id}) để kéo-thả di
    chuyển/textbox và sửa lại nội dung textbox mà không tạo dòng mới — đúng nguyên tắc
    "mỗi annotation 1 dòng, sửa thì UPDATE" đã ghi trong file .sql.
"""
import hashlib
import json
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Header, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.models import Chapter, ChapterPresence, EmbeddingChunk, PdfAnnotation, PdfDocument, Share, ShareLink, Subject, User
from app.security import hash_password, verify_password
from app.services import chapter_lock, embeddings, quota, sharing, text_extraction
from app.services.schedule_notifier import local_now
from app.schemas import (
    ChapterCreateRequest,
    ChapterDetailOut,
    ChapterDrawingRequest,
    ChapterListItemOut,
    ChapterPasswordRequest,
    ChapterUnlockOut,
    ChapterUnlockRequest,
    ChapterSyncOut,
    ChapterUpdateRequest,
    PdfAnnotationCreateRequest,
    PdfAnnotationOut,
    PdfAnnotationUpdateRequest,
    PdfDocumentOut,
    PdfUpdateRequest,
    ReorderRequest,
    SimpleMessageResponse,
    SubjectCreateRequest,
    SubjectOut,
    SubjectUpdateRequest,
    UpdatePdfPageCountRequest,
)

router = APIRouter(tags=["knowledge"])

def _strip_html(html: str) -> str:
    """Bản plain-text từ content_json (HTML CKEditor) cho FULLTEXT INDEX (UC-18) + nguồn chunk
    RAG — không phải nguồn sự thật của nội dung. Xem text_extraction.html_to_text()."""
    return text_extraction.html_to_text(html)


# ---------------------------------------------------------------------------
# Tra cứu có kiểm tra quyền sở hữu (BR-05) — dùng chung cho mọi endpoint bên dưới
# ---------------------------------------------------------------------------
def _get_owned_subject(db: Session, subject_id: str, user: User) -> Subject:
    subject = db.get(Subject, subject_id)
    if subject is None or subject.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy môn học.")
    return subject


def _get_owned_chapter(db: Session, chapter_id: str, user: User) -> Chapter:
    chapter = db.get(Chapter, chapter_id)
    if chapter is None or chapter.subject.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy chương.")
    return chapter


def _get_owned_pdf(db: Session, document_id: str, user: User) -> PdfDocument:
    doc = db.get(PdfDocument, document_id)
    if doc is None or doc.subject.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tệp PDF.")
    return doc


# ---------------------------------------------------------------------------
# Lưu trữ file PDF vật lý trên đĩa (KHÔNG có cột BLOB trong DB — xem comment đầu
# bảng pdf_documents trong database/knowledge_content_schema.sql)
# ---------------------------------------------------------------------------
def _ensure_upload_dir() -> Path:
    upload_dir = Path(settings.PDF_UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def _delete_pdf_file(rel_path: str) -> None:
    try:
        Path(rel_path).unlink(missing_ok=True)
    except OSError:
        pass  # dọn dẹp best-effort — không chặn thao tác DB vì lỗi filesystem


# ---------------------------------------------------------------------------
# Chuyển ORM -> schema response
# ---------------------------------------------------------------------------
def _to_pdf_out(doc: PdfDocument) -> PdfDocumentOut:
    return PdfDocumentOut(
        id=doc.id,
        subject_id=doc.subject_id,
        original_name=doc.original_name,
        file_size_bytes=doc.file_size_bytes,
        page_count=doc.page_count,
        mime_type=doc.mime_type,
        sort_order=doc.sort_order,
    )


def _to_annotation_out(a: PdfAnnotation) -> PdfAnnotationOut:
    return PdfAnnotationOut(
        id=a.id, document_id=a.document_id, page_number=a.page_number, annotation_type=a.annotation_type, data=a.data
    )


def _to_chapter_list_out(chapter: Chapter, shared: set[str] | None = None) -> ChapterListItemOut:
    return ChapterListItemOut(
        id=chapter.id, name=chapter.name, sort_order=chapter.sort_order, shared=bool(shared and chapter.id in shared),
        protected=chapter_lock.is_protected(chapter),
    )


def _edit_info(db: Session, chapter: Chapter) -> tuple[str | None, int | None]:
    """"Sửa lần cuối bởi …" — giờ DB (cột DATETIME không kèm múi giờ, so với NOW() của chính DB)."""
    if not chapter.content_updated_at:
        return None, None
    editor = db.get(User, chapter.content_updated_by) if chapter.content_updated_by else None
    ago = int((db.scalar(select(func.now())) - chapter.content_updated_at).total_seconds())
    return (editor.display_name if editor else None), max(0, ago)


def _to_chapter_detail_out(db: Session, chapter: Chapter, role: str = "owner", unlocked: bool = True) -> ChapterDetailOut:
    by, ago = _edit_info(db, chapter)
    protected = chapter_lock.is_protected(chapter)
    if protected and not unlocked:
        # Review > Password: chưa mở khoá -> không trả nội dung / nét vẽ, chỉ đủ để vẽ màn "Chương đã khoá".
        return ChapterDetailOut(
            id=chapter.id, name=chapter.name, sort_order=chapter.sort_order, protected=True, locked=True,
            password_hint=chapter.password_hint, content_version=chapter.content_version or 0, role=role,
        )
    return ChapterDetailOut(
        id=chapter.id,
        name=chapter.name,
        sort_order=chapter.sort_order,
        protected=protected,
        password_hint=chapter.password_hint if protected else None,
        content_json=chapter.content_json,
        content_text=chapter.content_text,
        content_version=chapter.content_version or 0,
        role=role,
        updated_by_name=by,
        updated_seconds_ago=ago,
        drawing_json=chapter.drawing_json,
    )


def _to_subject_out(subject: Subject, shared: set[str] | None = None) -> SubjectOut:
    return SubjectOut(
        id=subject.id,
        name=subject.name,
        description=subject.description,
        color=subject.color,
        icon=subject.icon,
        sort_order=subject.sort_order,
        chapters=[_to_chapter_list_out(c, shared) for c in subject.chapters],
        pdfs=[_to_pdf_out(p) for p in subject.pdf_documents],
        shared=bool(shared and subject.id in shared),
    )


def _shared_targets(db: Session, owner_id: str) -> set[str]:
    """Id các Môn / Chương chủ sở hữu đã chia sẻ (có người được mời hoặc đang bật liên kết) — biểu tượng ở cây."""
    a = db.scalars(select(Share.target_id).where(Share.owner_id == owner_id)).all()
    b = db.scalars(select(ShareLink.target_id).where(ShareLink.owner_id == owner_id)).all()
    return set(a) | set(b)


# ---------------------------------------------------------------------------
# UC-12 — Tạo Môn học · UC-13 — Sửa/Xoá Môn học
# ---------------------------------------------------------------------------
@router.get("/subjects", response_model=list[SubjectOut])
def list_subjects(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    subjects = db.scalars(
        select(Subject).where(Subject.owner_id == current_user.id).order_by(Subject.sort_order)
    ).all()
    shared = _shared_targets(db, current_user.id)
    return [_to_subject_out(s, shared) for s in subjects]


@router.post("/subjects", response_model=SubjectOut, status_code=status.HTTP_201_CREATED)
def create_subject(
    payload: SubjectCreateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên môn học không được để trống.")

    max_order = db.scalar(select(func.max(Subject.sort_order)).where(Subject.owner_id == current_user.id))
    subject = Subject(
        owner_id=current_user.id,
        name=name,
        description=(payload.description or "").strip() or None,
        color=payload.color,
        icon=payload.icon,
        sort_order=(max_order if max_order is not None else -1) + 1,
    )
    db.add(subject)
    db.commit()
    db.refresh(subject)
    return _to_subject_out(subject)


@router.put("/subjects/{subject_id}", response_model=SubjectOut)
def update_subject(
    subject_id: str,
    payload: SubjectUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject = _get_owned_subject(db, subject_id, current_user)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên môn học không được để trống.")
        subject.name = name
    if payload.description is not None:
        subject.description = payload.description.strip() or None
    if payload.color is not None:
        subject.color = payload.color
    if payload.icon is not None:
        subject.icon = payload.icon
    db.commit()
    db.refresh(subject)
    return _to_subject_out(subject)


@router.put("/subjects/reorder", response_model=SimpleMessageResponse)
def reorder_subjects(
    payload: ReorderRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    subjects = {s.id: s for s in db.scalars(select(Subject).where(Subject.owner_id == current_user.id))}
    for index, subject_id in enumerate(payload.ordered_ids):
        if subject_id in subjects:
            subjects[subject_id].sort_order = index
    db.commit()
    return SimpleMessageResponse(message="Đã cập nhật thứ tự môn học.")


@router.delete("/subjects/{subject_id}", response_model=SimpleMessageResponse)
def delete_subject(
    subject_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    subject = _get_owned_subject(db, subject_id, current_user)
    for doc in subject.pdf_documents:
        _delete_pdf_file(doc.file_path)
    db.delete(subject)  # BR-10: cascade xuống chapters/pdf_documents/pdf_annotations (DB FK)
    db.flush()
    quota.refresh_level(db, current_user.id)
    db.commit()
    return SimpleMessageResponse(message="Đã xoá môn học.")


# ---------------------------------------------------------------------------
# UC-14 — Tạo Chương · UC-15 — Sửa/Xoá Chương · UC-16 — Lưu nội dung soạn thảo
# ---------------------------------------------------------------------------
@router.post("/subjects/{subject_id}/chapters", response_model=ChapterListItemOut, status_code=status.HTTP_201_CREATED)
def create_chapter(
    subject_id: str,
    payload: ChapterCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Người được chia sẻ CẢ Môn với quyền chỉnh sửa cũng thêm được Chương (như thêm trang vào sổ OneNote dùng chung)
    subject, _role = sharing.get_subject(db, subject_id, current_user, "editor")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên chương không được để trống.")  # E1

    max_order = db.scalar(select(func.max(Chapter.sort_order)).where(Chapter.subject_id == subject.id))
    chapter = Chapter(subject_id=subject.id, name=name, sort_order=(max_order if max_order is not None else -1) + 1)
    db.add(chapter)
    db.commit()
    db.refresh(chapter)
    return _to_chapter_list_out(chapter)


@router.get("/chapters/{chapter_id}", response_model=ChapterDetailOut)
def get_chapter(
    chapter_id: str,
    x_chapter_key: str | None = Header(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter, role = sharing.get_chapter(db, chapter_id, current_user)
    return _to_chapter_detail_out(db, chapter, role, chapter_lock.is_unlocked(chapter, x_chapter_key))


def _require_unlocked(chapter: Chapter, key: str | None) -> None:
    if not chapter_lock.is_unlocked(chapter, key):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {
            "message": "Chương này đang được khoá bằng mật khẩu — mở khoá rồi thử lại.", "code": "chapter_locked",
        })


# ---- Review > Password (theo OneNote "Password Protection"): mở khoá / đặt / đổi / gỡ mật khẩu Chương ----
@router.post("/chapters/{chapter_id}/unlock", response_model=ChapterUnlockOut)
def unlock_chapter(
    chapter_id: str,
    payload: ChapterUnlockRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter, role = sharing.get_chapter(db, chapter_id, current_user)
    if chapter_lock.is_protected(chapter) and not verify_password(payload.password, chapter.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"message": "Mật khẩu không đúng.", "code": "wrong_password"})
    key = chapter_lock.make_key(chapter) if chapter_lock.is_protected(chapter) else ""
    return ChapterUnlockOut(key=key, chapter=_to_chapter_detail_out(db, chapter, role, True))


@router.put("/chapters/{chapter_id}/password", response_model=ChapterUnlockOut)
def set_chapter_password(
    chapter_id: str,
    payload: ChapterPasswordRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter, role = sharing.get_chapter(db, chapter_id, current_user)
    if role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Chỉ chủ sở hữu mới đặt được mật khẩu cho chương này.")
    was = chapter_lock.is_protected(chapter)
    if was and not verify_password(payload.current_password or "", chapter.password_hash):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"message": "Mật khẩu hiện tại không đúng.", "code": "wrong_password"})
    if payload.new_password is None:
        if not was:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chương này chưa có mật khẩu.")
        chapter.password_hash = None
        chapter.password_hint = None
    else:
        chapter.password_hash = hash_password(payload.new_password)
        chapter.password_hint = (payload.hint or "").strip() or None
        # Như OneNote: nội dung có mật khẩu không được AI Studio / tìm kiếm ngữ nghĩa đọc -> bỏ chỉ mục RAG.
        db.query(EmbeddingChunk).filter(
            EmbeddingChunk.chapter_id == chapter.id, EmbeddingChunk.source_type == "CHAPTER"
        ).delete(synchronize_session=False)
    db.commit()
    db.refresh(chapter)
    if was and payload.new_password is None:
        background_tasks.add_task(embeddings.reembed_chapter_background, chapter.id)
    key = chapter_lock.make_key(chapter) if chapter_lock.is_protected(chapter) else ""
    return ChapterUnlockOut(key=key, chapter=_to_chapter_detail_out(db, chapter, role, True))


@router.put("/chapters/{chapter_id}", response_model=ChapterDetailOut)
def update_chapter(
    chapter_id: str,
    payload: ChapterUpdateRequest,
    background_tasks: BackgroundTasks,
    x_chapter_key: str | None = Header(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter, role = sharing.get_chapter(db, chapter_id, current_user, "editor")
    if payload.content_json is not None:
        _require_unlocked(chapter, x_chapter_key)
        db.refresh(chapter, with_for_update=True)   # khoá dòng: 2 người lưu cùng lúc không cùng qua được kiểm version
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên chương không được để trống.")
        chapter.name = name
    needs_reembed = False
    if payload.content_json is not None:
        # Chia sẻ — khoá lạc quan: người khác đã lưu bản mới hơn bản client đang sửa -> 409 kèm bản mới nhất, KHÔNG
        # ghi đè (client cho chọn "Xem bản mới nhất" / "Giữ bản của tôi" = gửi lại không kèm base_version).
        if payload.base_version is not None and payload.base_version != (chapter.content_version or 0):
            current = _to_chapter_detail_out(db, chapter, role).model_dump()
            db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, {
                "message": (current["updated_by_name"] or "Người khác") + " vừa sửa chương này trong lúc bạn đang soạn.",
                "current": current,
            })
        changed = payload.content_json != (chapter.content_json or "")
        old_text = chapter.content_text or ""
        chapter.content_json = payload.content_json
        chapter.content_text = _strip_html(payload.content_json)
        if changed:
            chapter.content_version = (chapter.content_version or 0) + 1
            chapter.content_updated_by = current_user.id
            chapter.content_updated_at = db.scalar(select(func.now()))
        # Autosave (1.2s) gửi PUT cả khi chỉ đổi định dạng (in đậm, màu...) — văn bản thuần
        # không đổi thì embedding cũng y hệt, bỏ qua để không tốn quota. Vẫn embed nếu Chương
        # chưa có chunk nào của model hiện tại (dữ liệu cũ trước Bước 3, hoặc lần trước lỗi API).
        needs_reembed = (chapter.content_text or "") != old_text or not db.scalar(
            select(func.count())
            .select_from(EmbeddingChunk)
            .where(
                EmbeddingChunk.chapter_id == chapter.id,
                EmbeddingChunk.source_type == "CHAPTER",
                EmbeddingChunk.embedding_model == settings.EMBEDDING_MODEL,
            )
        )
    db.commit()
    db.refresh(chapter)
    if needs_reembed and not chapter_lock.is_protected(chapter):   # Chương có mật khẩu: AI không đọc (không embed)
        # Bước 3 lộ trình RAG: re-embed lại nội dung Chương sau khi lưu (xem
        # app/services/embeddings.py) — chạy NỀN sau khi đã trả response, autosave không phải
        # chờ embedding API. Lỗi embedding (chưa có key, lỗi mạng...) không raise và giữ
        # nguyên chunk cũ — cùng triết lý "không raise" đã dùng cho OCR.
        background_tasks.add_task(embeddings.reembed_chapter_background, chapter.id)
    return _to_chapter_detail_out(db, chapter, role)


# Thẻ Draw — lưu lớp vẽ (nét bút / hình khối / nền trang) của Chương. Tách khỏi PUT /chapters/{id}: không đụng nội dung chữ,
# không re-embed, không tăng content_version (khoá lạc quan chỉ dành cho chữ); người có quyền sửa mới lưu được.
_DRAWING_MAX_BYTES = 4 * 1024 * 1024
_DRAWING_MAX_ITEMS = 5000


@router.put("/chapters/{chapter_id}/drawing", response_model=SimpleMessageResponse)
def update_chapter_drawing(
    chapter_id: str,
    payload: ChapterDrawingRequest,
    x_chapter_key: str | None = Header(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter, _role = sharing.get_chapter(db, chapter_id, current_user, "editor")
    _require_unlocked(chapter, x_chapter_key)
    data = payload.drawing or None
    if data is not None:
        items = data.get("items")
        if items is not None and (not isinstance(items, list) or len(items) > _DRAWING_MAX_ITEMS):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Dữ liệu nét vẽ không hợp lệ.")
        if len(json.dumps(data)) > _DRAWING_MAX_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Trang có quá nhiều nét vẽ (tối đa 4 MB).")
        page = data.get("page")   # Page Color (thẻ View): "#rrggbb" hoặc null
        if page is not None and not (isinstance(page, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", page)):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Màu trang không hợp lệ.")
        if not data.get("items") and (data.get("bg") or {}).get("kind", "none") == "none" and not page:
            data = None
    chapter.drawing_json = data
    db.commit()
    return SimpleMessageResponse(message="Đã lưu nét vẽ.")


@router.get("/chapters/{chapter_id}/sync", response_model=ChapterSyncOut)
def sync_chapter(chapter_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Nhịp ~10 giây khi đang mở 1 Chương ĐANG ĐƯỢC CHIA SẺ: ghi "đang xem" + trả version (người khác vừa lưu thì
    client tải bản mới) + người đang mở cùng lúc (avatar cạnh nút Chia sẻ, như Word / OneNote)."""
    chapter, role = sharing.get_chapter(db, chapter_id, current_user)
    now = db.scalar(select(func.now()))
    pres = db.get(ChapterPresence, (chapter.id, current_user.id))
    if pres is None:
        db.add(ChapterPresence(chapter_id=chapter.id, user_id=current_user.id, last_seen=now))
    else:
        pres.last_seen = now
    db.commit()
    rows = db.scalars(
        select(User)
        .join(ChapterPresence, ChapterPresence.user_id == User.id)
        .where(
            ChapterPresence.chapter_id == chapter.id,
            ChapterPresence.user_id != current_user.id,
            ChapterPresence.last_seen >= func.date_sub(func.now(), text("INTERVAL 35 SECOND")),
        )
    ).all()
    by, ago = _edit_info(db, chapter)
    return ChapterSyncOut(
        version=chapter.content_version or 0, role=role, updated_by_name=by, updated_seconds_ago=ago,
        viewers=[sharing.person(u) for u in rows],
    )


@router.put("/subjects/{subject_id}/chapters/reorder", response_model=SimpleMessageResponse)
def reorder_chapters(
    subject_id: str,
    payload: ReorderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject = _get_owned_subject(db, subject_id, current_user)
    chapters = {c.id: c for c in subject.chapters}
    for index, chapter_id in enumerate(payload.ordered_ids):
        if chapter_id in chapters:
            chapters[chapter_id].sort_order = index
    db.commit()
    return SimpleMessageResponse(message="Đã cập nhật thứ tự chương.")


@router.delete("/chapters/{chapter_id}", response_model=SimpleMessageResponse)
def delete_chapter(chapter_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chapter = _get_owned_chapter(db, chapter_id, current_user)
    db.delete(chapter)  # BR-10: chapters không còn giữ PDF nào — chỉ cascade xuống chính nó
    db.commit()
    return SimpleMessageResponse(message="Đã xoá chương.")


# ---------------------------------------------------------------------------
# File PDF — item độc lập, cùng cấp với Chương dưới 1 Môn học (mở rộng UC-16,
# luồng thay thế 2a). Tải lên/đổi tên/xoá/kéo-thả giữa các Môn tương tự Chương.
# ---------------------------------------------------------------------------
@router.post("/subjects/{subject_id}/pdf", response_model=PdfDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_subject_pdf(
    subject_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject = _get_owned_subject(db, subject_id, current_user)

    is_pdf = file.content_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf")
    if not is_pdf:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chỉ nhận tệp PDF (.pdf).")  # BR-14

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tệp PDF rỗng.")
    quota.check_upload(db, current_user, len(content), subject.id)  # BR-14 / UC-33: 413 / 409 kèm code

    upload_dir = _ensure_upload_dir()
    stored_name = f"{uuid.uuid4()}.pdf"
    disk_path = upload_dir / stored_name
    disk_path.write_bytes(content)
    rel_path = str(Path(settings.PDF_UPLOAD_DIR) / stored_name).replace("\\", "/")

    max_order = db.scalar(select(func.max(PdfDocument.sort_order)).where(PdfDocument.subject_id == subject.id))
    doc = PdfDocument(
        subject_id=subject.id,
        original_name=file.filename or "tai-lieu.pdf",
        file_path=rel_path,
        file_size_bytes=len(content),
        mime_type="application/pdf",
        content_sha256=hashlib.sha256(content).hexdigest(),
        last_opened_at=local_now(),
        process_status="processing",
        sort_order=(max_order if max_order is not None else -1) + 1,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    background_tasks.add_task(quota.refresh_after_change, current_user.id)   # nhắc chạm ngưỡng dung lượng
    # Bước 3 lộ trình RAG: chunk + embed (kèm OCR nếu là PDF scan) nội dung PDF vừa tải lên
    # (xem app/services/embeddings.py) — chạy NỀN sau khi đã trả response. Lỗi embedding KHÔNG
    # làm hỏng việc tải PDF lên.
    background_tasks.add_task(embeddings.reembed_pdf_background, doc.id)
    return _to_pdf_out(doc)


@router.put("/pdf/{document_id}", response_model=PdfDocumentOut)
def update_pdf(
    document_id: str,
    payload: PdfUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = _get_owned_pdf(db, document_id, current_user)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên tệp PDF không được để trống.")
        doc.original_name = name
    if payload.subject_id is not None and payload.subject_id != doc.subject_id:
        # Kéo-thả chuyển File PDF sang Môn học khác — Môn đích cũng phải thuộc sở hữu
        # người dùng hiện tại (BR-05), xếp cuối danh sách PDF của Môn đích.
        target_subject = _get_owned_subject(db, payload.subject_id, current_user)
        limit = quota.get_settings(db)["storage.subject_files"]
        if len(target_subject.pdf_documents) >= limit:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                {"message": f"Môn đích đã đủ {limit} tệp.", "code": "subject_full", "limit": limit})
        max_order = db.scalar(select(func.max(PdfDocument.sort_order)).where(PdfDocument.subject_id == target_subject.id))
        doc.subject_id = target_subject.id
        doc.sort_order = (max_order if max_order is not None else -1) + 1
        # Bước 3 lộ trình RAG: subject_id ở embedding_chunks là bản denormalize cho UC-19
        # lọc nhanh theo phạm vi — phải đồng bộ theo khi kéo-thả PDF sang Môn học khác,
        # nếu không lọc phạm vi (Bước 5) sẽ trả nhầm chunk thuộc Môn học cũ.
        db.execute(
            update(EmbeddingChunk)
            .where(EmbeddingChunk.document_id == doc.id)
            .values(subject_id=target_subject.id)
        )
    db.commit()
    db.refresh(doc)
    return _to_pdf_out(doc)


@router.put("/subjects/{subject_id}/pdfs/reorder", response_model=SimpleMessageResponse)
def reorder_pdfs(
    subject_id: str,
    payload: ReorderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject = _get_owned_subject(db, subject_id, current_user)
    docs = {d.id: d for d in subject.pdf_documents}
    for index, document_id in enumerate(payload.ordered_ids):
        if document_id in docs:
            docs[document_id].sort_order = index
    db.commit()
    return SimpleMessageResponse(message="Đã cập nhật thứ tự tệp PDF.")


@router.get("/pdf/{document_id}/file")
def download_pdf_file(document_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    doc, _role = sharing.get_pdf(db, document_id, current_user)
    disk_path = Path(doc.file_path)
    if not disk_path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tệp PDF không còn trên server.")
    if _role == "owner":   # Dọn dung lượng UC-33: lọc "Chưa mở 30 ngày"
        doc.last_opened_at = local_now()
        db.commit()
    return FileResponse(disk_path, media_type="application/pdf", filename=doc.original_name)


@router.patch("/pdf/{document_id}/page-count", response_model=PdfDocumentOut)
def update_pdf_page_count(
    document_id: str,
    payload: UpdatePdfPageCountRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc, _role = sharing.get_pdf(db, document_id, current_user)
    doc.page_count = payload.page_count
    db.commit()
    db.refresh(doc)
    return _to_pdf_out(doc)


@router.delete("/pdf/{document_id}", response_model=SimpleMessageResponse)
def delete_pdf(document_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    doc = _get_owned_pdf(db, document_id, current_user)
    _delete_pdf_file(doc.file_path)
    db.delete(doc)
    quota.refresh_level(db, current_user.id)
    db.commit()
    return SimpleMessageResponse(message="Đã xoá tệp PDF.")


# ---------------------------------------------------------------------------
# Chú thích trên PDF (overlay, KHÔNG sửa file gốc) — xem khối "NGUYÊN TẮC HIỂN THỊ"
# và "HỆ TOẠ ĐỘ ANNOTATION" ở database/knowledge_content_schema.sql.
# ---------------------------------------------------------------------------
@router.get("/pdf/{document_id}/annotations", response_model=list[PdfAnnotationOut])
def list_annotations(document_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    doc, _role = sharing.get_pdf(db, document_id, current_user)
    return [_to_annotation_out(a) for a in doc.annotations]


@router.post("/pdf/{document_id}/annotations", response_model=PdfAnnotationOut, status_code=status.HTTP_201_CREATED)
def create_annotation(
    document_id: str,
    payload: PdfAnnotationCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc, _role = sharing.get_pdf(db, document_id, current_user, "editor")
    annotation = PdfAnnotation(
        document_id=doc.id,
        created_by=current_user.id,
        page_number=payload.page_number,
        annotation_type=payload.annotation_type,
        data=payload.data,
    )
    db.add(annotation)
    db.commit()
    db.refresh(annotation)
    return _to_annotation_out(annotation)


def _get_owned_annotation(db: Session, annotation_id: str, user: User) -> PdfAnnotation:
    """Sửa / xoá chú thích: chủ sở hữu hoặc người được chia sẻ cả Môn để chỉnh sửa."""
    annotation = db.get(PdfAnnotation, annotation_id)
    if annotation is None or sharing.pdf_role(db, annotation.document, user) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy chú thích.")
    sharing.get_pdf(db, annotation.document_id, user, "editor")
    return annotation


@router.put("/pdf/annotations/{annotation_id}", response_model=PdfAnnotationOut)
def update_annotation(
    annotation_id: str,
    payload: PdfAnnotationUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    annotation = _get_owned_annotation(db, annotation_id, current_user)
    if payload.page_number is not None:
        annotation.page_number = payload.page_number
    if payload.data is not None:
        annotation.data = payload.data
    db.commit()
    db.refresh(annotation)
    return _to_annotation_out(annotation)


@router.delete("/pdf/annotations/{annotation_id}", response_model=SimpleMessageResponse)
def delete_annotation(
    annotation_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    annotation = _get_owned_annotation(db, annotation_id, current_user)
    db.delete(annotation)
    db.commit()
    return SimpleMessageResponse(message="Đã xoá chú thích.")
