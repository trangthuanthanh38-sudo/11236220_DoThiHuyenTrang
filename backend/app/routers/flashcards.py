"""UC-23 Tạo Flashcard theo chương (xem .claude/rules/08-ai-studio.md). Frontend:
frontend/js/ghichu_flashcard.js (khuôn request/response ghi ở đầu file đó). Sinh thẻ thật do
app/services/flashcard_generation.py làm (1 lượt gọi Gemini/bộ, chuỗi model QUIZ_MODEL) — router chỉ
kiểm tra quyền + điều kiện nghiệp vụ TRƯỚC khi tốn lượt gọi AI (dùng chung _validate_sources của
quiz.py):
  - BR-05: Môn học + từng nguồn (Chương/PDF) phải thuộc người dùng -> 404
  - mọi nguồn phải thuộc đúng `subject_id` (xoá Môn -> xoá bộ thẻ) -> 400
  - BR-07 / UC-19 E1: nguồn phải có ít nhất 1 đoạn đã xử lý cho AI -> 400
  - BR-08: hạn mức lượt AI/ngày RIÊNG của tính năng 'fc' (services/quota.py) -> 429
Bộ sinh lỗi bị XOÁ luôn và trả 502 kèm lý do (giống quiz.py).

Ôn thẻ (UC-23 bước 5): kết quả chỉ ghi khi ôn XONG cả phiên — POST /flashcards/sets/{id}/sessions
(1 transaction: xếp lịch từng thẻ Dễ/Khó theo flashcard_generation.schedule_next, Bỏ qua giữ nguyên
lịch, tạo 1 dòng flashcard_sessions = "Lần ôn thứ N"). Tab "Đã tạo": GET /flashcards/sets (+ lịch sử
GET /flashcards/sets/{id}/sessions). Mọi mốc thời gian so sánh bằng giờ DB (NOW()) và trả về dạng
khoảng TƯƠNG ĐỐI (giây) vì DATETIME không kèm múi giờ.
PUT /flashcards/cards/{id}/review (chấm lẻ từng thẻ, trước v2) vẫn giữ cho tương thích.
"""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, case, func, literal_column, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import Flashcard, FlashcardReview, FlashcardSession, FlashcardSet, FlashcardSetSource, Subject, User
from app.routers.quiz import _validate_sources
from app.schemas import (
    FlashcardCitationOut,
    FlashcardIntervalsOut,
    FlashcardOut,
    FlashcardReviewOut,
    FlashcardReviewRequest,
    FlashcardSessionCardOut,
    FlashcardSessionCreate,
    FlashcardSessionOut,
    FlashcardSetCreateRequest,
    FlashcardSetOut,
    FlashcardSetSummaryOut,
    SimpleMessageResponse,
)
from app.services import flashcard_generation, quota

router = APIRouter(prefix="/flashcards", tags=["AI Studio — Tạo Flashcard (UC-23)"])


def _intervals(card: Flashcard) -> FlashcardIntervalsOut:
    return FlashcardIntervalsOut(**flashcard_generation.preview_intervals(card))


def _card_out(card: Flashcard, now: datetime | None = None) -> FlashcardOut:
    return FlashcardOut(
        id=card.id,
        position=card.position,
        card_type=card.card_type,
        front=card.front,
        back=card.back,
        citation=FlashcardCitationOut(
            source_type=card.source_type,
            source_label=card.source_label,
            page_number=card.page_number,
            quote=card.quote,
            chapter_id=card.chapter_id,
            document_id=card.document_id,
        ),
        due_at=card.due_at,
        review_count=card.review_count,
        last_rating=card.last_rating,
        is_due=bool(now and card.review_count > 0 and card.due_at is not None and card.due_at <= now),
        next_intervals=_intervals(card),
    )


def _set_out(db: Session, fset: FlashcardSet, cards: list[Flashcard], user: User) -> FlashcardSetOut:
    now: datetime = db.scalar(select(func.now()))   # giờ DB — cùng mốc với due_at (is_due của từng thẻ)
    return FlashcardSetOut(
        id=fset.id,
        title=fset.title,
        subject_id=fset.subject_id,
        count_mode=fset.count_mode,
        requested_count=fset.requested_count,
        card_count=fset.card_count,
        cards=[_card_out(c, now) for c in cards],
        streak_days=flashcard_generation.streak_days(db, user.id),
        shuffle=fset.shuffle_cards,
        show_citation=fset.show_citation,
        session_count=len(fset.sessions),
    )


def _session_out(s: FlashcardSession, seconds_ago: int = 0, **extra) -> FlashcardSessionOut:
    return FlashcardSessionOut(
        id=s.id,
        session_no=s.session_no,
        kind=s.kind,
        card_total=s.card_total,
        easy_count=s.easy_count,
        hard_count=s.hard_count,
        skip_count=s.skip_count,
        duration_seconds=s.duration_seconds,
        finished_seconds_ago=max(0, seconds_ago),
        **extra,
    )


def _get_owned_set(db: Session, set_id: str, user: User) -> FlashcardSet:
    fset = db.get(FlashcardSet, set_id)
    if fset is None or fset.user_id != user.id or fset.status != "ready":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy bộ flashcard.")
    return fset


@router.post("/sets", response_model=FlashcardSetOut, status_code=status.HTTP_201_CREATED)
def create_flashcard_set(
    payload: FlashcardSetCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject, sources = _validate_sources(db, current_user, payload.subject_id, payload.sources, what="bộ thẻ")
    tracker = quota.start(db, current_user, "fc")

    fset = flashcard_generation.generate_flashcard_set(
        db, current_user, subject, sources, payload.title, tuple(payload.type_counts),
        payload.shuffle, payload.show_citation,
    )
    if fset.status != "ready":
        quota.failed(tracker, model=fset.model_name)
        message = fset.error_message or "Không tạo được bộ flashcard."
        db.delete(fset)
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, message)
    quota.done(tracker, fset.model_name)
    db.refresh(fset)
    return _set_out(db, fset, list(fset.cards), current_user)


@router.get("/sets", response_model=list[FlashcardSetSummaryOut])
def list_flashcard_sets(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tab "Đã tạo": mới nhất lên đầu. "Ôn lại vào" = thẻ sớm đến hạn nhất (thẻ mới coi như đến hạn
    ngay -> 0 giây); "Lần ôn" / "Lần gần nhất" lấy từ flashcard_sessions."""
    now = func.now()
    reviewed = Flashcard.review_count > 0
    rows = db.execute(
        select(
            FlashcardSet,
            Subject.name,
            func.count(Flashcard.id),
            func.coalesce(func.sum(case((and_(reviewed, Flashcard.due_at <= now), 1), else_=0)), 0),
            func.coalesce(func.sum(case((Flashcard.review_count == 0, 1), else_=0)), 0),
            func.min(case((reviewed, func.timestampdiff(literal_column("SECOND"), now, Flashcard.due_at)))),
            func.max(Flashcard.last_reviewed_at),
        )
        .join(Subject, Subject.id == FlashcardSet.subject_id)
        .outerjoin(Flashcard, Flashcard.flashcard_set_id == FlashcardSet.id)
        .where(FlashcardSet.user_id == current_user.id, FlashcardSet.status == "ready")
        .group_by(FlashcardSet.id, Subject.name)
        .order_by(FlashcardSet.created_at.desc())
    ).all()
    set_ids = [r[0].id for r in rows]
    labels: dict[str, list[str]] = {}
    sessions: dict[str, tuple[int, FlashcardSession, int]] = {}  # id -> (số lần, phiên gần nhất, giây trước)
    if set_ids:
        for set_id, label in db.execute(
            select(FlashcardSetSource.flashcard_set_id, FlashcardSetSource.source_label)
            .where(FlashcardSetSource.flashcard_set_id.in_(set_ids))
            .order_by(FlashcardSetSource.id)
        ):
            labels.setdefault(set_id, []).append(label)
        for sess, ago in db.execute(
            select(FlashcardSession, func.timestampdiff(literal_column("SECOND"), FlashcardSession.finished_at, now))
            .where(FlashcardSession.flashcard_set_id.in_(set_ids))
            .order_by(FlashcardSession.session_no)
        ):
            sessions[sess.flashcard_set_id] = (sess.session_no, sess, int(ago))
    today = db.scalar(select(func.curdate()))
    out = []
    for fset, subject_name, card_count, due_count, new_count, next_due, last in rows:
        n, last_sess, ago = sessions.get(fset.id, (0, None, None))
        if new_count:
            next_due = 0
        out.append(FlashcardSetSummaryOut(
            id=fset.id,
            title=fset.title,
            subject_id=fset.subject_id,
            subject_name=subject_name,
            card_count=card_count,
            due_count=int(due_count),
            new_count=int(new_count),
            next_due_in_seconds=next_due,
            last_reviewed_days_ago=(today - last.date()).days if last else None,
            created_at=fset.created_at,
            source_labels=labels.get(fset.id, []),
            session_count=n,
            last_hard_count=last_sess.hard_count if last_sess else None,
            last_session_seconds_ago=ago,
        ))
    return out


@router.get("/sets/{set_id}", response_model=FlashcardSetOut)
def get_flashcard_set(
    set_id: str,
    scope: Literal["due", "all"] = Query("all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mở 1 bộ để ôn. `all` (giao diện dùng) = toàn bộ theo thứ tự gốc; `due` = thẻ đã đến hạn
    (sớm nhất trước) rồi tới thẻ mới."""
    fset = _get_owned_set(db, set_id, current_user)
    if scope == "all":
        cards = list(fset.cards)
    else:
        now: datetime = db.scalar(select(func.now()))
        due = sorted((c for c in fset.cards if c.review_count > 0 and c.due_at <= now), key=lambda c: c.due_at)
        cards = due + [c for c in fset.cards if c.review_count == 0]
    return _set_out(db, fset, cards, current_user)


@router.delete("/sets/{set_id}", response_model=SimpleMessageResponse)
def delete_flashcard_set(set_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    fset = _get_owned_set(db, set_id, current_user)
    db.delete(fset)  # thẻ / nguồn / phiên / lịch sử ôn xoá theo FK ON DELETE CASCADE
    db.commit()
    return SimpleMessageResponse(message="Đã xoá bộ flashcard.")


@router.post("/sets/{set_id}/sessions", response_model=FlashcardSessionOut, status_code=status.HTTP_201_CREATED)
def create_session(
    set_id: str,
    payload: FlashcardSessionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Ghi kết quả 1 phiên ôn trọn vẹn (Dễ/Khó/Bỏ qua từng thẻ) — xem đầu file."""
    fset = _get_owned_set(db, set_id, current_user)
    ids = {c.id for c in fset.cards}
    if any(r.card_id not in ids for r in payload.ratings):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Có thẻ không thuộc bộ flashcard này.")
    session, results = flashcard_generation.save_session(
        db, fset, current_user, payload.kind, payload.duration_seconds,
        [(r.card_id, r.rating) for r in payload.ratings],
    )
    return _session_out(
        session,
        cards=[
            FlashcardSessionCardOut(card_id=c.id, rating=rating, interval_seconds=interval, next_intervals=_intervals(c))
            for c, rating, interval in results
        ],
        streak_days=flashcard_generation.streak_days(db, current_user.id),
    )


@router.get("/sets/{set_id}/sessions", response_model=list[FlashcardSessionOut])
def list_sessions(set_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Lịch sử các lần ôn của 1 bộ, mới nhất trước (tab "Đã tạo" -> bấm dòng / "Lịch sử")."""
    fset = _get_owned_set(db, set_id, current_user)
    rows = db.execute(
        select(FlashcardSession, func.timestampdiff(literal_column("SECOND"), FlashcardSession.finished_at, func.now()))
        .where(FlashcardSession.flashcard_set_id == fset.id)
        .order_by(FlashcardSession.session_no.desc())
    ).all()
    return [_session_out(s, int(ago)) for s, ago in rows]


@router.put("/cards/{card_id}/review", response_model=FlashcardReviewOut)
def review_card(
    card_id: str,
    payload: FlashcardReviewRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    card = db.get(Flashcard, card_id)
    if card is None or card.flashcard_set.user_id != current_user.id or card.flashcard_set.status != "ready":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy thẻ.")
    now: datetime = db.scalar(select(func.now()))
    interval = flashcard_generation.schedule_next(card, payload.rating, now)
    db.add(FlashcardReview(flashcard_id=card.id, user_id=current_user.id, rating=payload.rating, interval_seconds=interval))
    db.commit()
    return FlashcardReviewOut(
        card_id=card.id,
        due_at=card.due_at,
        interval_seconds=interval,
        next_intervals=_intervals(card),
        streak_days=flashcard_generation.streak_days(db, current_user.id),
    )
