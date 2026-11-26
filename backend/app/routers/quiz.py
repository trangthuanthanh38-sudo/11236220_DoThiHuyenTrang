"""UC-21 Tạo bộ câu hỏi — Chế độ ôn tập, + UC-22 Chế độ thi thử ở khối cuối file (xem
.claude/rules/08-ai-studio.md). Frontend:
frontend/js/ghichu_ontap.js (khuôn request/response ghi ở đầu file đó). Sinh câu hỏi thật do
app/services/quiz_generation.py làm (1 lượt gọi Gemini/bộ, model riêng QUIZ_MODEL) — router chỉ
kiểm tra quyền + điều kiện nghiệp vụ TRƯỚC khi tốn lượt gọi AI:
  - BR-05: Môn học + từng nguồn (Chương/PDF) phải thuộc người dùng -> 404
  - mọi nguồn phải thuộc đúng `subject_id` (quiz_sets.subject_id, xoá Môn -> xoá bộ) -> 400
  - BR-07 / UC-19 E1: nguồn phải có ít nhất 1 đoạn đã xử lý cho AI -> 400
  - BR-08: hạn mức lượt AI/ngày RIÊNG của tính năng 'quiz' (Ôn tập + Thi thử, services/quota.py) -> 429
Bộ câu hỏi sinh lỗi (AI quá tải, không ra câu hợp lệ...) bị XOÁ luôn thay vì để lại dòng
status='failed' trong DB, và trả 502 kèm lý do để frontend hiển thị.

Lần làm bài (UC-21 bước 5-6, bảng quiz_attempts/quiz_attempt_answers): mỗi lần "Làm bài"/"Làm lại"
tạo 1 attempt; mỗi câu được CHỐT 1 lần (chấm đúng/sai ở server, lưu cố định); "Nộp" tính điểm.
"Lần làm"/"Điểm cao nhất" = COUNT/MAX các lần ĐÃ nộp. Mỗi bộ có tối đa 1 lần làm dở (bắt đầu lần
mới thì lần dở cũ bị bỏ) — lần dở đó trả ra qua `open_attempt` để frontend "Làm tiếp" sau F5.
"""
import random

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, delete, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import (
    Chapter,
    EmbeddingChunk,
    QuizAttempt,
    QuizAttemptAnswer,
    QuizQuestion,
    QuizQuestionCitation,
    QuizQuestionOption,
    QuizSet,
    QuizSetSource,
    User,
)
from app.routers.knowledge import _get_owned_chapter, _get_owned_pdf, _get_owned_subject
from app.schemas import (
    ExamAnswerRequest,
    ExamAnswerStateOut,
    ExamAttemptOut,
    ExamCreateRequest,
    ExamOptionOut,
    ExamOut,
    ExamQuestionOut,
    ExamResultOut,
    ExamResultQuestionOut,
    ExamSubmitRequest,
    ExamSummaryOut,
    QuizAnswerOut,
    QuizAnswerRequest,
    QuizAttemptHistoryOut,
    QuizAttemptOut,
    QuizCitationOut,
    QuizFinishOut,
    QuizOptionOut,
    QuizQuestionOut,
    QuizSetCreateRequest,
    QuizSetOut,
    QuizSetSummaryOut,
    QuizSourceStatsOut,
    QuizSourceStatsRequest,
    SimpleMessageResponse,
)
from app.services import quiz_generation, quota

router = APIRouter(prefix="/quiz", tags=["AI Studio — Tạo bộ câu hỏi (UC-21 ôn tập, UC-22 thi thử)"])


def _to_quiz_set_out(quiz: QuizSet) -> QuizSetOut:
    return QuizSetOut(
        id=quiz.id,
        subject_id=quiz.subject_id,
        title=quiz.title,
        mode=quiz.mode,
        status=quiz.status,
        error_message=quiz.error_message,
        requested_count=quiz.requested_count,
        question_count=quiz.question_count,
        difficulty=quiz.difficulty,
        question_type=quiz.question_type,
        show_answer=quiz.show_answer,
        show_explanation=quiz.show_explanation,
        show_citation=quiz.show_citation,
        model_name=quiz.model_name,
        questions=[
            QuizQuestionOut(
                id=q.id,
                position=q.position,
                question_type=q.question_type,
                difficulty=q.difficulty,
                question_text=q.question_text,
                short_text=q.short_text,
                explanation=q.explanation,
                options=[QuizOptionOut(position=o.position, content=o.content, is_correct=o.is_correct) for o in q.options],
                citations=[
                    QuizCitationOut(
                        source_type=c.source_type,
                        source_label=c.source_label,
                        page_number=c.page_number,
                        quote=c.quote,
                        chapter_id=c.chapter_id,
                        document_id=c.document_id,
                    )
                    for c in q.citations
                ],
            )
            for q in quiz.questions
        ],
    )


@router.post("/sets", response_model=QuizSetOut, status_code=status.HTTP_201_CREATED)
def create_quiz_set(
    payload: QuizSetCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject, sources = _validate_sources(db, current_user, payload.subject_id, payload.sources)
    tracker = quota.start(db, current_user, "quiz")

    quiz = quiz_generation.generate_quiz_set(
        db,
        current_user,
        subject,
        sources,
        payload.requested_count,
        payload.difficulty,
        payload.question_type,
        title=payload.title,
        quotas=tuple(payload.difficulty_counts) if payload.difficulty_counts else None,
        show_answer=payload.show_answer,
        show_explanation=payload.show_explanation,
        show_citation=payload.show_citation,
    )
    if quiz.status != "ready":
        quota.failed(tracker, model=quiz.model_name)
        message = quiz.error_message or "Không tạo được bộ câu hỏi."
        db.delete(quiz)
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, message)
    quota.done(tracker, quiz.model_name)
    db.refresh(quiz)
    return _full_out(db, quiz, current_user)


@router.post("/source-stats", response_model=QuizSourceStatsOut)
def quiz_source_stats(
    payload: QuizSourceStatsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Độ dài nội dung của các nguồn đang tick ở màn Tạo câu hỏi ôn tập -> "n nguồn · x từ", "Gợi ý:
    a–b câu", "chỉ đủ tối đa N câu". Kiểm BR-05 + cùng Môn như lúc tạo, nhưng nguồn chưa có nội
    dung KHÔNG báo lỗi (trả max_questions=0 để giao diện tự báo). Không gọi AI, không tính BR-08."""
    _get_owned_subject(db, payload.subject_id, current_user)
    sources = []
    for src in payload.sources:
        item = (
            _get_owned_chapter(db, src.id, current_user)
            if src.source_type == "CHAPTER"
            else _get_owned_pdf(db, src.id, current_user)
        )
        if item.subject_id != payload.subject_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Các nguồn của 1 bộ câu hỏi phải cùng 1 Môn học.")
        sources.append(item)
    return QuizSourceStatsOut(**quiz_generation.source_stats(db, sources, payload.mode))


def _validate_sources(db: Session, user: User, subject_id: str, payload_sources, what: str = "bộ câu hỏi") -> tuple:
    """Kiểm tra dùng chung cho ôn tập + thi thử (và Flashcard — routers/flashcards.py, `what="bộ thẻ"`),
    TRƯỚC khi tốn lượt gọi AI: BR-05 (Môn + từng nguồn thuộc người dùng -> 404), mọi nguồn cùng 1 Môn
    -> 400, BR-07 (nguồn có chunk đã embed) -> 400. Trả (subject, [Chapter | PdfDocument])."""
    subject = _get_owned_subject(db, subject_id, user)

    sources, seen = [], set()
    for src in payload_sources:
        if (src.source_type, src.id) in seen:
            continue
        seen.add((src.source_type, src.id))
        item = (
            _get_owned_chapter(db, src.id, user)
            if src.source_type == "CHAPTER"
            else _get_owned_pdf(db, src.id, user)
        )
        if item.subject_id != subject.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Các nguồn của 1 {what} phải cùng 1 Môn học.")
        sources.append(item)

    chapter_ids = [s.id for s in sources if isinstance(s, Chapter)]
    document_ids = [s.id for s in sources if not isinstance(s, Chapter)]
    conds = []
    if chapter_ids:
        conds.append(EmbeddingChunk.chapter_id.in_(chapter_ids))
    if document_ids:
        conds.append(EmbeddingChunk.document_id.in_(document_ids))
    has_content = db.scalar(select(func.count()).select_from(EmbeddingChunk).where(or_(*conds)))
    if not has_content:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Các nguồn đã chọn chưa có nội dung nào sẵn sàng cho AI (Chương chưa có nội dung, hoặc "
            "tệp PDF không trích được chữ). Hãy chọn nguồn khác hoặc thêm nội dung trước.",
        )
    return subject, sources


# ---------------------------------------------------------------------------
# Tiện ích sở hữu (BR-05 -> 404) + thống kê lần làm
# ---------------------------------------------------------------------------
def _get_owned_quiz(db: Session, quiz_id: str, user: User) -> QuizSet:
    quiz = db.get(QuizSet, quiz_id)
    # Chỉ bộ ôn tập — API ôn tập trả kèm đáp án đúng, không được dùng để đọc đề thi thử (UC-22).
    if quiz is None or quiz.user_id != user.id or quiz.status != "ready" or quiz.mode != "practice":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy bộ câu hỏi.")
    return quiz


def _get_owned_attempt(db: Session, attempt_id: str, user: User) -> QuizAttempt:
    attempt = db.get(QuizAttempt, attempt_id)
    if attempt is None or attempt.user_id != user.id or attempt.mode != "practice":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy lần làm bài.")
    return attempt


def _attempt_stats(db: Session, quiz_id: str) -> tuple[int, int | None]:
    """(số lần ĐÃ nộp, điểm cao nhất) — COUNT(finished_at) chỉ đếm dòng khác NULL."""
    row = db.execute(
        select(func.count(QuizAttempt.finished_at), func.max(QuizAttempt.score_percent)).where(
            QuizAttempt.quiz_set_id == quiz_id
        )
    ).one()
    return row[0] or 0, row[1]


def _open_attempt(db: Session, quiz_id: str, user: User) -> QuizAttempt | None:
    return db.scalar(
        select(QuizAttempt)
        .where(QuizAttempt.quiz_set_id == quiz_id, QuizAttempt.user_id == user.id, QuizAttempt.finished_at.is_(None))
        .order_by(QuizAttempt.attempt_no.desc())
        .limit(1)
    )


def _to_attempt_out(attempt: QuizAttempt) -> QuizAttemptOut:
    return QuizAttemptOut(
        id=attempt.id,
        attempt_no=attempt.attempt_no,
        total_questions=attempt.total_questions,
        answers=[
            QuizAnswerOut(question_id=a.question_id, selected_positions=a.selected_positions, is_correct=a.is_correct)
            for a in attempt.answers
        ],
    )


def _full_out(db: Session, quiz: QuizSet, user: User) -> QuizSetOut:
    out = _to_quiz_set_out(quiz)
    out.attempts, out.best_score = _attempt_stats(db, quiz.id)
    open_attempt = _open_attempt(db, quiz.id, user)
    out.open_attempt = _to_attempt_out(open_attempt) if open_attempt else None
    return out


# ---------------------------------------------------------------------------
# Danh sách / mở lại / xoá bộ câu hỏi đã tạo (tab "Đã tạo" ở màn Ôn tập)
# ---------------------------------------------------------------------------
@router.get("/sets", response_model=list[QuizSetSummaryOut])
def list_quiz_sets(
    subject_id: str | None = Query(None, max_length=36),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(QuizSet).where(
        QuizSet.user_id == current_user.id, QuizSet.status == "ready", QuizSet.mode == "practice"
    )
    if subject_id:
        stmt = stmt.where(QuizSet.subject_id == subject_id)
    quizzes = db.scalars(stmt.order_by(QuizSet.created_at.desc())).all()
    stats = {
        row[0]: tuple(row[1:])
        for row in db.execute(
            select(
                QuizAttempt.quiz_set_id,
                func.count(QuizAttempt.finished_at),
                func.max(QuizAttempt.score_percent),
                func.sum(case((QuizAttempt.finished_at.is_(None), 1), else_=0)),
                # "Làm gần nhất" — khoảng tương đối tính bằng giờ DB (DATETIME không kèm múi giờ)
                func.timestampdiff(text("SECOND"), func.max(QuizAttempt.finished_at), func.now()),
            )
            .where(QuizAttempt.user_id == current_user.id)
            .group_by(QuizAttempt.quiz_set_id)
        ).all()
    }
    result = []
    for q in quizzes:
        done, best, open_count, last_ago = stats.get(q.id, (0, None, 0, None))
        result.append(
            QuizSetSummaryOut(
                id=q.id,
                subject_id=q.subject_id,
                subject_name=q.subject.name,
                title=q.title,
                question_count=q.question_count,
                difficulty=q.difficulty,
                question_type=q.question_type,
                created_at=q.created_at,
                attempts=done or 0,
                best_score=best,
                has_open_attempt=bool(open_count),
                last_attempt_seconds_ago=max(0, int(last_ago)) if last_ago is not None else None,
            )
        )
    return result


@router.get("/sets/{quiz_id}", response_model=QuizSetOut)
def get_quiz_set(quiz_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _full_out(db, _get_owned_quiz(db, quiz_id, current_user), current_user)


@router.get("/sets/{quiz_id}/attempts", response_model=list[QuizAttemptHistoryOut])
def list_quiz_attempts(quiz_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Các lần ĐÃ nộp của 1 bộ (mới nhất trước) — lịch sử mở ra khi bấm 1 dòng ở tab "Đã tạo"."""
    _get_owned_quiz(db, quiz_id, current_user)
    rows = db.execute(
        select(
            QuizAttempt.attempt_no,
            QuizAttempt.correct_count,
            QuizAttempt.total_questions,
            QuizAttempt.score_percent,
            QuizAttempt.duration_seconds,
            func.timestampdiff(text("SECOND"), QuizAttempt.finished_at, func.now()),
        )
        .where(QuizAttempt.quiz_set_id == quiz_id, QuizAttempt.finished_at.is_not(None))
        .order_by(QuizAttempt.attempt_no.desc())
    ).all()
    return [
        QuizAttemptHistoryOut(
            attempt_no=r[0],
            correct_count=r[1],
            total_questions=r[2],
            score_percent=r[3],
            duration_seconds=max(0, int(r[4] or 0)),
            finished_seconds_ago=max(0, int(r[5] or 0)),
        )
        for r in rows
    ]


@router.delete("/sets/{quiz_id}", response_model=SimpleMessageResponse)
def delete_quiz_set(quiz_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    quiz = _get_owned_quiz(db, quiz_id, current_user)
    db.delete(quiz)  # câu hỏi/phương án/trích dẫn/lần làm xoá theo FK ON DELETE CASCADE
    db.commit()
    return SimpleMessageResponse(message="Đã xoá bộ câu hỏi.")


# ---------------------------------------------------------------------------
# Lần làm bài (UC-21 bước 5-6)
# ---------------------------------------------------------------------------
@router.post("/sets/{quiz_id}/attempts", response_model=QuizAttemptOut, status_code=status.HTTP_201_CREATED)
def start_attempt(quiz_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    quiz = _get_owned_quiz(db, quiz_id, current_user)
    # Tối đa 1 lần làm dở/bộ: bắt đầu lần mới = bỏ lần dở cũ (đáp án của nó xoá theo CASCADE).
    db.execute(
        delete(QuizAttempt).where(
            QuizAttempt.quiz_set_id == quiz.id,
            QuizAttempt.user_id == current_user.id,
            QuizAttempt.finished_at.is_(None),
        )
    )
    last_no = db.scalar(select(func.max(QuizAttempt.attempt_no)).where(QuizAttempt.quiz_set_id == quiz.id)) or 0
    attempt = QuizAttempt(
        quiz_set_id=quiz.id, user_id=current_user.id, attempt_no=last_no + 1, total_questions=len(quiz.questions)
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return _to_attempt_out(attempt)


@router.put("/attempts/{attempt_id}/answers/{question_id}", response_model=QuizAnswerOut)
def answer_question(
    attempt_id: str,
    question_id: str,
    payload: QuizAnswerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Chốt đáp án 1 câu — chấm đúng/sai ở SERVER theo quiz_question_options, lưu cố định
    (không đổi được nữa, đúng như giao diện: chốt rồi thì hiện đáp án + giải thích)."""
    attempt = _get_owned_attempt(db, attempt_id, current_user)
    if attempt.finished_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Lần làm bài này đã nộp.")
    question = db.get(QuizQuestion, question_id)
    if question is None or question.quiz_set_id != attempt.quiz_set_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy câu hỏi.")
    if any(a.question_id == question_id for a in attempt.answers):
        raise HTTPException(status.HTTP_409_CONFLICT, "Câu này đã được chốt đáp án.")
    selected = sorted(set(payload.selected_positions))
    valid = {o.position for o in question.options}
    if any(p not in valid for p in selected) or (question.question_type == "single" and len(selected) != 1):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Lựa chọn không hợp lệ cho câu hỏi này.")
    correct = {o.position for o in question.options if o.is_correct}
    answer = QuizAttemptAnswer(
        attempt_id=attempt.id, question_id=question.id, selected_positions=selected, is_correct=set(selected) == correct
    )
    db.add(answer)
    db.commit()
    return QuizAnswerOut(question_id=question.id, selected_positions=selected, is_correct=answer.is_correct)


@router.post("/attempts/{attempt_id}/finish", response_model=QuizFinishOut)
def finish_attempt(attempt_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Nộp bài: câu chưa trả lời tính là sai. Gọi lại khi đã nộp thì trả nguyên kết quả cũ (bấm 2
    lần không tạo lỗi). Thời gian làm tính bằng giờ của DB (started_at cũng do DB ghi)."""
    attempt = _get_owned_attempt(db, attempt_id, current_user)
    if attempt.finished_at is None:
        total = attempt.total_questions
        correct = sum(1 for a in attempt.answers if a.is_correct)
        db.execute(
            update(QuizAttempt)
            .where(QuizAttempt.id == attempt.id)
            .values(
                finished_at=func.now(),
                submit_reason="manual",
                duration_seconds=func.timestampdiff(text("SECOND"), QuizAttempt.started_at, func.now()),
                correct_count=correct,
                score_percent=(correct * 100 + total // 2) // total if total else 0,
            )
        )
        db.commit()
        db.refresh(attempt)
    attempts, best = _attempt_stats(db, attempt.quiz_set_id)
    return QuizFinishOut(
        attempt_id=attempt.id,
        attempt_no=attempt.attempt_no,
        total_questions=attempt.total_questions,
        correct_count=attempt.correct_count,
        score_percent=attempt.score_percent,
        duration_seconds=attempt.duration_seconds or 0,
        attempts=attempts,
        best_score=best or 0,
    )


# ===========================================================================
# UC-22 Tạo đề thi thử — frontend/js/ghichu_thithu.js (khuôn API ghi ở đầu file đó).
# Khác ôn tập: câu 1 đáp án, đáp án SỬA ĐƯỢC tới lúc nộp (upsert), có hạn nộp `deadline_at` do DB
# tính, mỗi đề chỉ 1 lần làm (DB ép: chk_quiz_attempts_exam_once), và KHÔNG response nào trước khi nộp
# chứa đáp án đúng / giải thích / trích dẫn. Hết giờ thì tự nộp "lười": mọi endpoint thi thử gọi
# _expire_if_due() trước — không cần job nền; câu chưa trả lời tính sai.
# ===========================================================================
_TIMEOUT_GRACE_SECONDS = 5  # đồng hồ máy người học lệch vài giây vẫn nhận là "hết giờ"


def _get_owned_exam(db: Session, exam_id: str, user: User) -> QuizSet:
    exam = db.get(QuizSet, exam_id)
    if exam is None or exam.user_id != user.id or exam.status != "ready" or exam.mode != "exam":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy đề thi.")
    return exam


def _get_exam_attempt(db: Session, attempt_id: str, user: User) -> QuizAttempt:
    attempt = db.get(QuizAttempt, attempt_id)
    if attempt is None or attempt.user_id != user.id or attempt.mode != "exam":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy bài thi.")
    return attempt


def _exam_attempt_of(db: Session, exam: QuizSet, user: User) -> QuizAttempt | None:
    return db.scalar(select(QuizAttempt).where(QuizAttempt.quiz_set_id == exam.id, QuizAttempt.user_id == user.id))


def _seconds_left(db: Session, attempt: QuizAttempt) -> int:
    """Giây còn lại theo đồng hồ DB (deadline_at cũng do DB ghi) — không lệch múi giờ app/DB."""
    left = db.scalar(select(func.timestampdiff(text("SECOND"), func.now(), attempt.deadline_at)))
    return max(0, left or 0)


def _finalize(db: Session, attempt: QuizAttempt, reason: str) -> None:
    """Chốt bài thi: điểm từ is_correct đã chấm lúc lưu (câu không có dòng/[] = sai). Hết giờ thì
    thời điểm nộp = deadline_at và thời gian làm = đúng giới hạn."""
    total = attempt.total_questions
    correct = sum(1 for a in attempt.answers if a.is_correct)
    time_limit = attempt.quiz_set.time_limit_seconds
    timed_out = reason == "timeout"
    db.execute(
        update(QuizAttempt)
        .where(QuizAttempt.id == attempt.id, QuizAttempt.finished_at.is_(None))
        .values(
            finished_at=QuizAttempt.deadline_at if timed_out else func.now(),
            submit_reason=reason,
            duration_seconds=time_limit if timed_out else func.least(
                func.timestampdiff(text("SECOND"), QuizAttempt.started_at, func.now()), time_limit
            ),
            correct_count=correct,
            score_percent=(correct * 100 + total // 2) // total if total else 0,
        )
    )
    db.commit()
    db.refresh(attempt)


def _expire_if_due(db: Session, attempt: QuizAttempt | None) -> None:
    if attempt is not None and attempt.finished_at is None and _seconds_left(db, attempt) <= 0:
        _finalize(db, attempt, "timeout")


def _to_exam_attempt_out(db: Session, attempt: QuizAttempt) -> ExamAttemptOut:
    return ExamAttemptOut(
        id=attempt.id,
        remaining_seconds=0 if attempt.finished_at else _seconds_left(db, attempt),
        finished=attempt.finished_at is not None,
        answers=[
            ExamAnswerStateOut(question_id=a.question_id, selected_positions=a.selected_positions, is_flagged=a.is_flagged)
            for a in attempt.answers
        ],
    )


def _to_exam_out(db: Session, exam: QuizSet, attempt: QuizAttempt | None) -> ExamOut:
    return ExamOut(
        id=exam.id,
        title=exam.title,
        subject_id=exam.subject_id,
        requested_count=exam.requested_count,
        question_count=exam.question_count,
        time_limit_seconds=exam.time_limit_seconds,
        questions=[
            ExamQuestionOut(
                id=q.id,
                position=q.position,
                difficulty=q.difficulty,
                question_text=q.question_text,
                short_text=q.short_text,
                options=[ExamOptionOut(position=o.position, content=o.content) for o in q.options],
            )
            for q in exam.questions
        ],
        attempt=_to_exam_attempt_out(db, attempt) if attempt else None,
    )


def _to_exam_result(attempt: QuizAttempt) -> ExamResultOut:
    picked = {a.question_id: a.selected_positions for a in attempt.answers}
    return ExamResultOut(
        correct_count=attempt.correct_count,
        total_questions=attempt.total_questions,
        score_percent=attempt.score_percent,
        duration_seconds=attempt.duration_seconds or 0,
        time_limit_seconds=attempt.quiz_set.time_limit_seconds,
        submit_reason=attempt.submit_reason or "manual",
        questions=[
            ExamResultQuestionOut(**q.model_dump(), selected_positions=picked.get(q.id, []))
            for q in _to_quiz_set_out(attempt.quiz_set).questions
        ],
    )


@router.post("/exams", response_model=ExamOut, status_code=status.HTTP_201_CREATED)
def create_exam(
    payload: ExamCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject, sources = _validate_sources(db, current_user, payload.subject_id, payload.sources)
    tracker = quota.start(db, current_user, "quiz")
    exam = quiz_generation.generate_exam_set(
        db, current_user, subject, sources, payload.requested_count, payload.time_limit_minutes * 60,
        title=payload.title,
        quotas=tuple(payload.difficulty_counts) if payload.difficulty_counts else None,
    )
    if exam.status != "ready":
        quota.failed(tracker, model=exam.model_name)
        message = exam.error_message or "Không tạo được đề thi."
        db.delete(exam)
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, message)
    quota.done(tracker, exam.model_name)
    db.refresh(exam)
    return _to_exam_out(db, exam, None)


@router.get("/exams/{exam_id}", response_model=ExamOut)
def get_exam(exam_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mở lại đề (F5 giữa bài / bấm lại thẻ Thi thử) — kèm lần làm (nếu có) và thời gian còn lại."""
    exam = _get_owned_exam(db, exam_id, current_user)
    attempt = _exam_attempt_of(db, exam, current_user)
    _expire_if_due(db, attempt)
    return _to_exam_out(db, exam, attempt)


@router.post("/exams/{exam_id}/start", response_model=ExamAttemptOut)
def start_exam(exam_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Bắt đầu làm bài: đồng hồ tính từ đây (deadline_at = NOW() + giới hạn, giờ DB). Đã có lần làm
    thì trả lại đúng lần đó — mỗi đề chỉ 1 lần làm, không có "làm lại" như ôn tập."""
    exam = _get_owned_exam(db, exam_id, current_user)
    attempt = _exam_attempt_of(db, exam, current_user)
    if attempt is None:
        db.add(
            QuizAttempt(
                quiz_set_id=exam.id,
                user_id=current_user.id,
                mode="exam",
                attempt_no=1,
                total_questions=len(exam.questions),
                deadline_at=func.date_add(func.now(), text(f"INTERVAL {int(exam.time_limit_seconds)} SECOND")),
            )
        )
        try:
            db.commit()
        except IntegrityError:  # 2 request "bắt đầu" cùng lúc -> UNIQUE (quiz_set_id, attempt_no)
            db.rollback()
        attempt = _exam_attempt_of(db, exam, current_user)
    _expire_if_due(db, attempt)
    return _to_exam_attempt_out(db, attempt)


@router.put("/exam-attempts/{attempt_id}/answers/{question_id}", response_model=SimpleMessageResponse)
def save_exam_answer(
    attempt_id: str,
    question_id: str,
    payload: ExamAnswerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lưu/sửa đáp án + cờ "xem lại" của 1 câu. Server chấm is_correct ngay nhưng KHÔNG trả về."""
    attempt = _get_exam_attempt(db, attempt_id, current_user)
    _expire_if_due(db, attempt)
    if attempt.finished_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Bài thi đã nộp hoặc đã hết giờ.")
    question = db.get(QuizQuestion, question_id)
    if question is None or question.quiz_set_id != attempt.quiz_set_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy câu hỏi.")
    selected = sorted(set(payload.selected_positions))
    if any(p not in {o.position for o in question.options} for p in selected):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Lựa chọn không hợp lệ cho câu hỏi này.")
    correct = {o.position for o in question.options if o.is_correct}
    is_correct = bool(selected) and set(selected) == correct
    answer = next((a for a in attempt.answers if a.question_id == question.id), None)
    if answer is None:
        attempt.answers.append(
            QuizAttemptAnswer(
                question_id=question.id, selected_positions=selected, is_correct=is_correct, is_flagged=payload.is_flagged
            )
        )
    else:
        answer.selected_positions, answer.is_correct, answer.is_flagged = selected, is_correct, payload.is_flagged
    db.commit()
    return SimpleMessageResponse(message="Đã lưu.")


@router.post("/exam-attempts/{attempt_id}/submit", response_model=ExamResultOut)
def submit_exam(
    attempt_id: str,
    payload: ExamSubmitRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Nộp bài (bấm "Nộp bài" hoặc hết giờ). Gọi lại khi đã nộp thì trả nguyên kết quả cũ. Client báo
    hết giờ mà server chưa thấy hết giờ (lệch quá vài giây) thì ghi là nộp tay."""
    attempt = _get_exam_attempt(db, attempt_id, current_user)
    _expire_if_due(db, attempt)
    if attempt.finished_at is None:
        reason = payload.reason if payload else "manual"
        if reason == "timeout" and _seconds_left(db, attempt) > _TIMEOUT_GRACE_SECONDS:
            reason = "manual"
        _finalize(db, attempt, reason)
    return _to_exam_result(attempt)


# ---------------------------------------------------------------------------
# Tab "Đã tạo" của màn Thi thử: danh sách / xem lại kết quả / xoá / làm lại. "Mỗi đề chỉ làm một
# lần" vẫn giữ nguyên (DB ép) — "Làm lại" NHÂN BẢN đề thành 1 đề thi mới (cùng câu hỏi, xáo lại thứ
# tự, đồng hồ mới), không gọi AI nên không tính lượt BR-08 (không qua quota.start);
# đề cũ giữ nguyên kết quả để xem lại.
# ---------------------------------------------------------------------------
@router.get("/exams", response_model=list[ExamSummaryOut])
def list_exams(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    exams = db.scalars(
        select(QuizSet)
        .where(QuizSet.user_id == current_user.id, QuizSet.status == "ready", QuizSet.mode == "exam")
        .order_by(QuizSet.created_at.desc())
    ).all()
    attempts = {
        a.quiz_set_id: a
        for a in db.scalars(
            select(QuizAttempt).where(QuizAttempt.user_id == current_user.id, QuizAttempt.mode == "exam")
        ).all()
    }
    for attempt in attempts.values():
        _expire_if_due(db, attempt)  # bài đang làm đã quá hạn -> chốt "hết giờ" trước khi báo trạng thái
    # "Ngày làm" — khoảng tương đối tính bằng giờ DB (DATETIME không kèm múi giờ)
    ago = dict(db.execute(
        select(QuizAttempt.id, func.timestampdiff(text("SECOND"), QuizAttempt.finished_at, func.now()))
        .where(QuizAttempt.user_id == current_user.id, QuizAttempt.mode == "exam", QuizAttempt.finished_at.is_not(None))
    ).all())
    result = []
    for exam in exams:
        attempt = attempts.get(exam.id)
        done = attempt is not None and attempt.finished_at is not None
        result.append(
            ExamSummaryOut(
                id=exam.id,
                subject_id=exam.subject_id,
                subject_name=exam.subject.name,
                title=exam.title,
                question_count=exam.question_count,
                time_limit_seconds=exam.time_limit_seconds,
                created_at=exam.created_at,
                status="done" if done else "in_progress" if attempt else "new",
                remaining_seconds=_seconds_left(db, attempt) if attempt and not done else None,
                correct_count=attempt.correct_count if done else None,
                score_percent=attempt.score_percent if done else None,
                submit_reason=attempt.submit_reason if done else None,
                duration_seconds=attempt.duration_seconds if done else None,
                finished_seconds_ago=max(0, int(ago.get(attempt.id) or 0)) if done else None,
            )
        )
    return result


@router.get("/exams/{exam_id}/result", response_model=ExamResultOut)
def get_exam_result(exam_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Xem lại kết quả đề đã nộp (đáp án, giải thích, nguồn). Chưa nộp thì 409 — không lộ đáp án."""
    exam = _get_owned_exam(db, exam_id, current_user)
    attempt = _exam_attempt_of(db, exam, current_user)
    _expire_if_due(db, attempt)
    if attempt is None or attempt.finished_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Đề thi này chưa nộp bài nên chưa xem được đáp án.")
    return _to_exam_result(attempt)


@router.delete("/exams/{exam_id}", response_model=SimpleMessageResponse)
def delete_exam(exam_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    exam = _get_owned_exam(db, exam_id, current_user)
    db.delete(exam)  # câu hỏi/phương án/trích dẫn/lần làm xoá theo FK ON DELETE CASCADE
    db.commit()
    return SimpleMessageResponse(message="Đã xoá đề thi.")


@router.post("/exams/{exam_id}/retake", response_model=ExamOut, status_code=status.HTTP_201_CREATED)
def retake_exam(exam_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """"Làm lại" 1 đề đã nộp = nhân bản thành đề thi MỚI: chép nguồn + câu hỏi + phương án + trích dẫn
    (snapshot), xáo lại thứ tự câu. Đề gốc chưa nộp thì 409 (làm tiếp đề gốc thay vì nhân bản)."""
    src = _get_owned_exam(db, exam_id, current_user)
    attempt = _exam_attempt_of(db, src, current_user)
    _expire_if_due(db, attempt)
    if attempt is None or attempt.finished_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Đề thi này chưa làm xong — hãy làm tiếp đề đó.")
    order = list(src.questions)
    random.shuffle(order)
    copy = QuizSet(
        user_id=current_user.id,
        subject_id=src.subject_id,
        title=src.title,
        mode="exam",
        requested_count=src.requested_count,
        question_count=src.question_count,
        difficulty=None,
        question_type=src.question_type,
        time_limit_seconds=src.time_limit_seconds,
        status="ready",
        model_name=None,  # không gọi AI -> không tính lượt BR-08
        sources=[
            QuizSetSource(source_type=s.source_type, chapter_id=s.chapter_id, document_id=s.document_id, source_label=s.source_label)
            for s in src.sources
        ],
        questions=[
            QuizQuestion(
                position=i,
                question_type=q.question_type,
                difficulty=q.difficulty,
                question_text=q.question_text,
                short_text=q.short_text,
                explanation=q.explanation,
                options=[QuizQuestionOption(position=o.position, content=o.content, is_correct=o.is_correct) for o in q.options],
                citations=[
                    QuizQuestionCitation(
                        source_type=c.source_type,
                        chapter_id=c.chapter_id,
                        document_id=c.document_id,
                        embedding_chunk_id=c.embedding_chunk_id,
                        source_label=c.source_label,
                        page_number=c.page_number,
                        quote=c.quote,
                    )
                    for c in q.citations
                ],
            )
            for i, q in enumerate(order, start=1)
        ],
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return _to_exam_out(db, copy, None)
