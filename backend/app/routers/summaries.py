"""UC-24 Tạo bản tóm tắt theo chương (xem .claude/rules/08-ai-studio.md). Frontend: frontend/js/ghichu_tomtat.js
(khuôn request/response ghi ở đầu file đó). Sinh nội dung do app/services/summary_generation.py làm (1 lượt gọi
Gemini/bản, chuỗi model QUIZ_MODEL) — router kiểm quyền + điều kiện nghiệp vụ TRƯỚC khi tốn lượt gọi AI:
  - BR-05: Môn + nguồn (Chương/PDF) thuộc người dùng -> 404; nguồn phải thuộc đúng `subject_id` -> 400
    (dùng chung _validate_sources của quiz.py)
  - BR-07 / UC-19 E1: nguồn phải có ít nhất 1 đoạn đã xử lý cho AI -> 400
  - UC-24 E1: nguồn dưới MIN_WORDS từ -> 400 (không đủ để tóm tắt có ý nghĩa)
  - BR-08: hạn mức lượt AI/ngày RIÊNG của tính năng 'sum' (services/quota.py; tạo và tạo lại đều tính 1 lượt) -> 429
AI lỗi -> 502 kèm lý do: lúc TẠO thì không ghi dòng nào; lúc TẠO LẠI thì giữ nguyên bản cũ (ghi đè tại chỗ chỉ khi
đã có kết quả mới). Mốc thời gian trả khoảng TƯƠNG ĐỐI `updated_seconds_ago` theo giờ DB.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, literal_column, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import Chapter, PdfDocument, Summary, SummaryPoint, SummarySection, User
from app.routers.knowledge import _get_owned_chapter, _get_owned_pdf
from app.routers.quiz import _validate_sources
from app.schemas import (
    QuizSourceIn,
    SimpleMessageResponse,
    SummaryCreateRequest,
    SummaryListItemOut,
    SummaryOut,
    SummaryPointOut,
    SummarySavedOut,
    SummarySectionOut,
    SummaryUpdateRequest,
)
from app.services import quota, summary_generation
from app.services.quiz_generation import _source_label

router = APIRouter(prefix="/summaries", tags=["AI Studio — Tóm tắt (UC-24)"])
_SECOND = literal_column("SECOND")   # đơn vị của TIMESTAMPDIFF (MySQL)


def _seconds_ago(db: Session, summary_id: str) -> int:
    value = db.scalar(
        select(func.timestampdiff(_SECOND, Summary.updated_at, func.now())).where(Summary.id == summary_id)
    )
    return max(0, int(value or 0))


def _get_owned_summary(db: Session, summary_id: str, user: User) -> Summary:
    s = db.get(Summary, summary_id)
    if s is None or s.user_id != user.id or s.status != "ready":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy bản tóm tắt.")
    return s


def _is_stale(s: Summary, chapter_text: dict[str, str | None]) -> bool:
    """Nội dung gốc đã đổi sau lần tạo? Chỉ Chương (PDF không sửa được); nguồn đã xoá thì không tính."""
    if s.source_type != "CHAPTER" or not s.chapter_id or s.chapter_id not in chapter_text or not s.source_text_hash:
        return False
    return summary_generation.hash_text(chapter_text[s.chapter_id]) != s.source_text_hash


def _chapter_texts(db: Session, ids: list[str]) -> dict[str, str | None]:
    if not ids:
        return {}
    return {cid: txt for cid, txt in db.execute(select(Chapter.id, Chapter.content_text).where(Chapter.id.in_(ids))).all()}


def _list_item(s: Summary, ago: int, stale: bool) -> dict:
    return dict(
        id=s.id, title=s.title, subject_id=s.subject_id, source_type=s.source_type, chapter_id=s.chapter_id,
        document_id=s.document_id, source_label=s.source_label, length=s.length, format=s.format,
        is_stale=stale, updated_seconds_ago=max(0, int(ago or 0)),
    )


def _full_out(db: Session, s: Summary) -> SummaryOut:
    sections = db.scalars(
        select(SummarySection).where(SummarySection.summary_id == s.id).order_by(SummarySection.position)
    ).all()
    points: dict[int, list[SummaryPoint]] = {}
    for p in db.scalars(
        select(SummaryPoint).where(SummaryPoint.summary_id == s.id).order_by(SummaryPoint.section_id, SummaryPoint.position)
    ).all():
        points.setdefault(p.section_id, []).append(p)
    stale = _is_stale(s, _chapter_texts(db, [s.chapter_id] if s.chapter_id else []))
    return SummaryOut(
        **_list_item(s, _seconds_ago(db, s.id), stale),
        keep_definitions=s.keep_definitions, keep_numbers=s.keep_numbers, keep_examples=s.keep_examples,
        source_word_count=s.source_word_count,
        sections=[
            SummarySectionOut(
                position=sec.position, heading=sec.heading, kind=sec.kind,
                points=[SummaryPointOut(position=p.position, content=p.content, page_number=p.page_number, quote=p.quote)
                        for p in points.get(sec.id, [])],
            )
            for sec in sections
        ],
    )


def _check_length(db: Session, source: Chapter | PdfDocument) -> None:
    """UC-24 E1 — nguồn quá ngắn thì báo + gợi ý bổ sung nội dung, không tốn lượt gọi AI."""
    words = summary_generation.word_count(db, source)
    what = "Chương này" if isinstance(source, Chapter) else "Tệp PDF này"
    if words == 0:   # BR-07
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{what} chưa có nội dung nào sẵn sàng cho AI (chưa lưu nội dung, hoặc tệp không trích được chữ).",
        )
    if words < summary_generation.MIN_WORDS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{what} chỉ có khoảng {words} từ, chưa đủ để tóm tắt (cần ít nhất {summary_generation.MIN_WORDS} từ). "
            "Hãy bổ sung nội dung rồi thử lại.",
        )


@router.post("", response_model=SummaryOut, status_code=status.HTTP_201_CREATED)
def create_summary(
    payload: SummaryCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject, sources = _validate_sources(
        db, current_user, payload.subject_id,
        [QuizSourceIn(source_type=payload.source_type, id=payload.source_id)], what="bản tóm tắt",
    )
    source = sources[0]
    _check_length(db, source)
    tracker = quota.start(db, current_user, "sum")

    result, error = summary_generation.run(
        db, source, payload.length, payload.keep_definitions, payload.keep_numbers, payload.keep_examples
    )
    if result is None:
        quota.failed(tracker)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, error or "Không tạo được bản tóm tắt.")
    s = Summary(
        user_id=current_user.id, subject_id=subject.id,
        source_type="CHAPTER" if isinstance(source, Chapter) else "PDF",
        chapter_id=source.id if isinstance(source, Chapter) else None,
        document_id=source.id if isinstance(source, PdfDocument) else None,
        source_label=_source_label(source)[:255], title=payload.title[:200],
        length=payload.length, format=payload.format, keep_definitions=payload.keep_definitions,
        keep_numbers=payload.keep_numbers, keep_examples=payload.keep_examples,
    )
    db.add(s)
    db.flush()
    summary_generation.save(db, s, source, result, "create")
    quota.done(tracker, result.model or None)
    db.refresh(s)
    return _full_out(db, s)


@router.get("", response_model=list[SummaryListItemOut])
def list_summaries(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tab "Đã tạo": mới cập nhật lên đầu. `is_stale` so mã băm với nội dung Chương hiện tại (1 truy vấn gom)."""
    rows = db.execute(
        select(Summary, func.timestampdiff(_SECOND, Summary.updated_at, func.now()))
        .where(Summary.user_id == current_user.id, Summary.status == "ready")
        .order_by(Summary.updated_at.desc(), Summary.created_at.desc())
    ).all()
    texts = _chapter_texts(db, list({s.chapter_id for s, _ in rows if s.chapter_id}))
    # Thẻ ở tab "Đã tạo": số ý chính + số đoạn nguồn được trích (trùng câu trích thì tính 1) — 1 truy vấn gom
    counts = {
        sid: (int(n), int(q))
        for sid, n, q in db.execute(
            select(SummaryPoint.summary_id, func.count(), func.count(func.distinct(SummaryPoint.quote)))
            .where(SummaryPoint.summary_id.in_([s.id for s, _ in rows]))
            .group_by(SummaryPoint.summary_id)
        )
    } if rows else {}
    return [
        SummaryListItemOut(**_list_item(s, ago, _is_stale(s, texts)), point_count=counts.get(s.id, (0, 0))[0],
                           citation_count=counts.get(s.id, (0, 0))[1])
        for s, ago in rows
    ]


@router.get("/{summary_id}", response_model=SummaryOut)
def get_summary(summary_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _full_out(db, _get_owned_summary(db, summary_id, current_user))


@router.patch("/{summary_id}", response_model=SummarySavedOut)
def rename_summary(
    summary_id: str,
    payload: SummaryUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = _get_owned_summary(db, summary_id, current_user)
    s.title = payload.title[:200]
    s.updated_at = func.now()   # chạm cả khi tên không đổi -> "Đã lưu lúc" luôn mới
    db.commit()
    return SummarySavedOut(updated_seconds_ago=_seconds_ago(db, s.id))


@router.delete("/{summary_id}", response_model=SimpleMessageResponse)
def delete_summary(summary_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = _get_owned_summary(db, summary_id, current_user)
    db.delete(s)   # mục / ý xoá theo FK CASCADE; summary_generations giữ lại (SET NULL) để BR-08 vẫn đếm
    db.commit()
    return SimpleMessageResponse(message="Đã xoá bản tóm tắt.")


@router.post("/{summary_id}/regenerate", response_model=SummaryOut)
def regenerate_summary(summary_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """"Tạo lại" theo nội dung gốc mới nhất với đúng tham số cũ — ghi đè tại chỗ (giữ id/tên). AI lỗi -> 502, bản cũ
    giữ nguyên."""
    s = _get_owned_summary(db, summary_id, current_user)
    if s.chapter_id:
        source: Chapter | PdfDocument = _get_owned_chapter(db, s.chapter_id, current_user)
    elif s.document_id:
        source = _get_owned_pdf(db, s.document_id, current_user)
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nguồn của bản tóm tắt này đã bị xoá nên không tạo lại được.")
    _check_length(db, source)   # gồm cả BR-07 (0 từ = chưa có đoạn nào cho AI)
    tracker = quota.start(db, current_user, "sum")
    result, error = summary_generation.run(db, source, s.length, s.keep_definitions, s.keep_numbers, s.keep_examples)
    if result is None:
        quota.failed(tracker)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, (error or "Không tạo lại được bản tóm tắt.") + " Bản cũ được giữ nguyên.")
    s.source_label = _source_label(source)[:255]
    summary_generation.save(db, s, source, result, "regenerate")
    quota.done(tracker, result.model or None)
    db.refresh(s)
    return _full_out(db, s)
