"""Nhắc học — thông báo máy chủ tự sinh từ dữ liệu học tập, hiện chung chuông với nhắc lịch (UC-31).

Gọi trong mỗi lượt quét của `schedule_notifier.run_due()` (vòng nền 30 giây + quét "lười" khi mở chuông). Ghi vào
bảng `notifications` với `kind` khác 'schedule' (database/schedule_schema_v3.sql), chỉ kênh 'app' (không gửi email):
  flashcard — bộ thẻ có thẻ đã ôn tới hạn ôn lại (bấm nhắc chỉ ôn các thẻ đó, Khó trước); tối đa 1 nhắc/bộ/ngày, chỉ trong khung REMIND_HOURS giờ địa phương.
  exam      — đề thi thử đang làm, còn giờ, không thao tác EXAM_IDLE (đang làm bài thì không kêu); 1 nhắc/lượt thi.
  practice  — bài ôn tập chưa nộp, không thao tác PRACTICE_IDLE; tối đa 1 nhắc/lượt làm/ngày.
Chống trùng bằng `dedupe_key` + UNIQUE(user_id, dedupe_key): kiểm tồn tại trước, INSERT trong savepoint — 2 lượt quét
chạy cùng lúc thì lượt sau đụng UNIQUE và bỏ qua, không làm hỏng cả lượt.

Mốc thời gian: `flashcards.due_at`, `quiz_attempts.*`, `quiz_attempt_answers.updated_at` lưu theo GIỜ DB (UTC) nên so
với NOW() của MySQL; ngày / khung giờ nhắc tính theo giờ địa phương (`local_now`).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Flashcard,
    FlashcardSet,
    Notification,
    NotificationDelivery,
    QuizAttempt,
    QuizAttemptAnswer,
    QuizSet,
)

REMIND_HOURS = (7, 22)                   # nhắc ôn thẻ từ 07:00 tới trước 22:00
EXAM_IDLE = timedelta(minutes=5)
PRACTICE_IDLE = timedelta(minutes=60)


def _mmss(seconds: int) -> str:
    m = max(0, seconds) // 60
    return f"{m // 60} giờ {m % 60} phút" if m >= 60 else f"{m} phút"


def _add(db: Session, user_id: str, kind: str, ref_id: str, title: str, detail: str, key: str, now: datetime) -> bool:
    if db.scalar(select(Notification.id).where(Notification.user_id == user_id, Notification.dedupe_key == key)):
        return False
    n = Notification(
        user_id=user_id, kind=kind, ref_id=ref_id, title=title[:200], detail=detail[:255], dedupe_key=key, fire_at=now
    )
    n.deliveries.append(NotificationDelivery(channel="app", status="sent", attempts=1, sent_at=now))
    try:
        with db.begin_nested():
            db.add(n)
    except IntegrityError:               # lượt quét khác vừa tạo cùng key
        return False
    return True


def _flashcards(db: Session, now: datetime, db_now: datetime, user_id: str | None) -> int:
    if not (REMIND_HOURS[0] <= now.hour < REMIND_HOURS[1]):
        return 0
    q = (
        select(
            FlashcardSet.user_id, FlashcardSet.id, FlashcardSet.title, func.count(),
            func.sum(case((Flashcard.last_rating == "hard", 1), else_=0)),
        )
        .join(Flashcard, Flashcard.flashcard_set_id == FlashcardSet.id)
        .where(FlashcardSet.status == "ready", Flashcard.review_count > 0, Flashcard.due_at <= db_now)
        .group_by(FlashcardSet.user_id, FlashcardSet.id, FlashcardSet.title)
    )
    if user_id is not None:
        q = q.where(FlashcardSet.user_id == user_id)
    day = now.date().isoformat()
    made = 0
    for uid, set_id, title, count, hard in db.execute(q).all():
        hard = int(hard or 0)
        # Bấm nhắc chỉ ôn đúng các thẻ đến hạn (Flashcard.openSet), thẻ Khó trước — dòng phụ nói rõ có bao nhiêu thẻ Khó
        detail = (f"{count} thẻ khó cần ôn lại" if hard == count
                  else f"{count} thẻ đến hạn ôn ({hard} thẻ khó)" if hard else f"{count} thẻ đến hạn ôn")
        made += _add(db, uid, "flashcard", set_id, title, detail, f"fc:{set_id}:{day}", now)
    return made


def _open_attempts(db: Session, db_now: datetime, user_id: str | None):
    """Lượt làm dở + thời điểm thao tác gần nhất (lưu đáp án gần nhất, chưa có thì lúc bắt đầu) + số câu đã làm."""
    last = (
        select(
            QuizAttemptAnswer.attempt_id.label("aid"),
            func.max(QuizAttemptAnswer.updated_at).label("last_at"),
            func.count().label("answered"),
        )
        .group_by(QuizAttemptAnswer.attempt_id)
        .subquery()
    )
    q = (
        select(QuizAttempt, QuizSet.title, last.c.last_at, last.c.answered)
        .join(QuizSet, QuizSet.id == QuizAttempt.quiz_set_id)
        .outerjoin(last, last.c.aid == QuizAttempt.id)
        .where(
            QuizAttempt.finished_at.is_(None),
            (QuizAttempt.deadline_at.is_(None)) | (QuizAttempt.deadline_at > db_now),
        )
    )
    if user_id is not None:
        q = q.where(QuizAttempt.user_id == user_id)
    for att, title, last_at, answered in db.execute(q).all():
        yield att, title, max(att.started_at, last_at) if last_at else att.started_at, answered or 0


def _attempts(db: Session, now: datetime, db_now: datetime, user_id: str | None) -> int:
    made = 0
    day = now.date().isoformat()
    for att, title, last_at, answered in _open_attempts(db, db_now, user_id):
        idle = db_now - last_at
        done = f"Đã làm {answered}/{att.total_questions} câu"
        if att.mode == "exam":
            if idle < EXAM_IDLE:
                continue
            left = int((att.deadline_at - db_now).total_seconds())
            made += _add(db, att.user_id, "exam", att.quiz_set_id, title, f"{done} · còn {_mmss(left)}", f"ex:{att.id}", now)
        else:
            if idle < PRACTICE_IDLE:
                continue
            made += _add(db, att.user_id, "practice", att.quiz_set_id, title, done, f"pr:{att.id}:{day}", now)
    return made


def create_study_reminders(db: Session, now: datetime, user_id: str | None = None) -> int:
    """`now` = giờ địa phương (fire_at, ngày, khung giờ). Trả số thông báo vừa tạo."""
    db_now = db.scalar(select(func.now()))
    made = _flashcards(db, now, db_now, user_id) + _attempts(db, now, db_now, user_id)
    db.commit()
    return made
