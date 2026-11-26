"""UC-29 Thống kê hiệu suất học tập + dữ liệu cho UC-30 (Nhận xét AI) — chỗ DUY NHẤT tính số liệu, dùng chung cho
API (routers/stats.py), snapshot tuần và prompt AI. Xem .claude/rules/09-schedule-stats.md, database/stats_schema.sql,
giao diện mẫu thong-ke.html.

Nguồn dữ liệu (không có bảng tổng hợp — tính lại mỗi lần xem):
  - Thời gian học: study_sessions.active_seconds (giờ ĐỊA PHƯƠNG).
  - Lượt Ôn tập / Thi thử: quiz_attempts đã nộp (finished_at, score_percent 0-100 -> thang 10).
  - Ôn thẻ: flashcard_sessions (easy/hard/skip). Tỷ lệ nhớ = Dễ / (Dễ + Khó), Bỏ qua không tính.
  - Nội dung tạo: created_at của chapters / pdf_documents / quiz_sets / flashcard_sets / mindmaps / summaries.
**Múi giờ:** các cột cũ lưu theo giờ DB (container MySQL chạy UTC) -> đổi sang APP_TIMEZONE trước khi gom theo
ngày (`utc_to_local`), nếu không bài nộp sau 17:00 giờ VN rơi sang hôm sau. Lọc khoảng thì đổi mốc địa phương ->
UTC (`_utc_bounds`).

Định nghĩa:
  - Ngày hoạt động = ngày có phút học > 0, hoặc nộp 1 bài, hoặc xong 1 phiên ôn thẻ.
  - BR-12: `hist` = số ngày hoạt động (mọi môn) tính từ đầu tới cuối kỳ; < 7 thì giao diện chặn Kết quả / So sánh /
    Nhận xét AI và không so với kỳ trước.
  - Điểm năng lực môn (thang 10) = 0,6 × điểm Quiz/Test + 0,4 × tỷ lệ nhớ × 10; môn chỉ có 1 nguồn thì lấy đúng nguồn
    đó (không tự suy nguồn còn thiếu như mẫu). Môn được xếp hạng khi ≥ 3 lượt làm bài hoặc ≥ 20 lượt ôn thẻ.
  - Trạng thái thẻ (HIỆN TẠI, không phải cuối kỳ): chưa ôn = review_count 0; đã thuộc = khoảng ôn ≥ 21 ngày.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Chapter,
    Flashcard,
    FlashcardSession,
    FlashcardSet,
    FlashcardSetSource,
    Mindmap,
    PdfDocument,
    QuizAttempt,
    QuizSet,
    QuizSetSource,
    ScheduleItem,
    StatSnapshot,
    StudySession,
    Subject,
    Summary,
    User,
)
from app.services import schedule_notifier
from app.services.schedule_notifier import local_now

MIN_HIST_DAYS = 7                 # BR-12
RANK_MIN_ATTEMPTS = 3             # môn đủ dữ liệu để xếp hạng
RANK_MIN_REVIEWS = 20
MASTERED_SECONDS = 21 * 86400     # thẻ "đã thuộc"
FEW_ATTEMPTS, FEW_REVIEWS = 3, 30  # UC-30 E1: dưới cả 2 ngưỡng -> AI không nhận xét
MADE_TYPES = ("chapter", "pdf", "practice", "exam", "flashcard", "mindmap", "summary")
SHORT_WORDS = 500                 # "nội dung còn ít" — cùng ngưỡng E1 của Tóm tắt


# ---------------------------------------------------------------------------
# Múi giờ
# ---------------------------------------------------------------------------
def _tz() -> ZoneInfo:
    return ZoneInfo(settings.APP_TIMEZONE)


def utc_to_local(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(_tz()).replace(tzinfo=None)


def local_to_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=_tz()).astimezone(timezone.utc).replace(tzinfo=None)


def _utc_bounds(a: date, b: date) -> tuple[datetime, datetime]:
    """[a 00:00, b+1 00:00) giờ địa phương -> UTC, để lọc các cột lưu giờ DB."""
    return local_to_utc(datetime(a.year, a.month, a.day)), local_to_utc(datetime(b.year, b.month, b.day) + timedelta(days=1))


def today() -> date:
    return local_now().date()


def _days(a: date, b: date) -> list[date]:
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


# ---------------------------------------------------------------------------
# Đọc dữ liệu gốc của 1 khoảng (đã đổi sang ngày địa phương)
# ---------------------------------------------------------------------------
def _subjects(db: Session, user_id: str) -> list[Subject]:
    return list(db.scalars(select(Subject).where(Subject.owner_id == user_id).order_by(Subject.sort_order, Subject.created_at)))


def _minutes_by_day(db: Session, user_id: str, a: date, b: date, subject_id: str | None):
    """{(ngày, subject_id|None): giây}. Phiên vắt qua nửa đêm tính trọn vào ngày bắt đầu (phiên ngắn, chấp nhận)."""
    q = select(StudySession.started_at, StudySession.subject_id, StudySession.active_seconds).where(
        StudySession.user_id == user_id,
        StudySession.started_at >= datetime(a.year, a.month, a.day),
        StudySession.started_at < datetime(b.year, b.month, b.day) + timedelta(days=1),
        StudySession.active_seconds > 0,
    )
    if subject_id:
        q = q.where(StudySession.subject_id == subject_id)
    out: dict[tuple[date, str | None], int] = {}
    for started, sid, secs in db.execute(q):
        k = (started.date(), sid)
        out[k] = out.get(k, 0) + secs
    return out


def _attempts(db: Session, user_id: str, a: date, b: date, subject_id: str | None):
    lo, hi = _utc_bounds(a, b)
    q = (
        select(QuizAttempt, QuizSet)
        .join(QuizSet, QuizSet.id == QuizAttempt.quiz_set_id)
        .where(
            QuizAttempt.user_id == user_id,
            QuizAttempt.finished_at.is_not(None),
            QuizAttempt.finished_at >= lo,
            QuizAttempt.finished_at < hi,
        )
        .order_by(QuizAttempt.finished_at)
    )
    if subject_id:
        q = q.where(QuizSet.subject_id == subject_id)
    out = []
    for att, qs in db.execute(q):
        out.append({
            "date": utc_to_local(att.finished_at).date(),
            "subject_id": qs.subject_id,
            "set_id": qs.id,
            "title": qs.title,
            "mode": qs.mode,
            "score": (att.score_percent or 0) / 10,
            "correct": (att.correct_count or 0) / att.total_questions if att.total_questions else 0,
            "seconds": att.duration_seconds or 0,
        })
    return out


def _fc_sessions(db: Session, user_id: str, a: date, b: date, subject_id: str | None):
    lo, hi = _utc_bounds(a, b)
    q = (
        select(FlashcardSession, FlashcardSet)
        .join(FlashcardSet, FlashcardSet.id == FlashcardSession.flashcard_set_id)
        .where(FlashcardSession.user_id == user_id, FlashcardSession.finished_at >= lo, FlashcardSession.finished_at < hi)
    )
    if subject_id:
        q = q.where(FlashcardSet.subject_id == subject_id)
    return [
        {
            "date": utc_to_local(fs.finished_at).date(),
            "subject_id": st.subject_id,
            "set_id": st.id,
            "title": st.title,
            "cards": st.card_count,
            "n": fs.easy_count + fs.hard_count,
            "ok": fs.easy_count,
        }
        for fs, st in db.execute(q)
    ]


def _made(db: Session, user_id: str, a: date, b: date, subject_id: str | None) -> dict[date, dict[str, int]]:
    lo, hi = _utc_bounds(a, b)
    out: dict[date, dict[str, int]] = {}

    def add(kind: str, rows):
        for (created,) in rows:
            d = utc_to_local(created).date()
            out.setdefault(d, dict.fromkeys(MADE_TYPES, 0))[kind] += 1

    def owned(model, subject_col):
        q = select(model.created_at).join(Subject, Subject.id == subject_col).where(
            Subject.owner_id == user_id, model.created_at >= lo, model.created_at < hi
        )
        return q.where(subject_col == subject_id) if subject_id else q

    add("chapter", db.execute(owned(Chapter, Chapter.subject_id)))
    add("pdf", db.execute(owned(PdfDocument, PdfDocument.subject_id)))
    for kind, model, extra in (
        ("practice", QuizSet, QuizSet.mode == "practice"),
        ("exam", QuizSet, QuizSet.mode == "exam"),
        ("flashcard", FlashcardSet, None),
        ("mindmap", Mindmap, None),
        ("summary", Summary, None),
    ):
        q = select(model.created_at).where(
            model.user_id == user_id, model.status == "ready", model.created_at >= lo, model.created_at < hi
        )
        if extra is not None:
            q = q.where(extra)
        if subject_id:
            q = q.where(model.subject_id == subject_id)
        add(kind, db.execute(q))
    return out


def active_dates(db: Session, user_id: str, until: date, subject_id: str | None = None) -> set[date]:
    """Mọi ngày hoạt động từ đầu tới `until` (dùng cho BR-12, chuỗi ngày, heatmap)."""
    start = date(2000, 1, 1)
    days = {d for (d, _sid), secs in _minutes_by_day(db, user_id, start, until, subject_id).items() if secs > 0}
    days |= {x["date"] for x in _attempts(db, user_id, start, until, subject_id)}
    days |= {x["date"] for x in _fc_sessions(db, user_id, start, until, subject_id)}
    return days


def _streaks(days: set[date], end: date) -> tuple[int, int]:
    """(chuỗi hiện tại tính tới `end` — nếu `end` là hôm nay mà chưa học thì tính từ hôm qua, kỷ lục tới `end`)."""
    d = end
    if d not in days and d == today():
        d -= timedelta(days=1)
    cur = 0
    while d in days:
        cur += 1
        d -= timedelta(days=1)
    best = run = 0
    prev = None
    for x in sorted(x for x in days if x <= end):
        run = run + 1 if prev and (x - prev).days == 1 else 1
        best = max(best, run)
        prev = x
    return cur, best


def card_states(db: Session, user_id: str, subject_id: str | None = None) -> dict:
    q = (
        select(Flashcard.review_count, Flashcard.interval_seconds)
        .join(FlashcardSet, FlashcardSet.id == Flashcard.flashcard_set_id)
        .where(FlashcardSet.user_id == user_id, FlashcardSet.status == "ready")
    )
    if subject_id:
        q = q.where(FlashcardSet.subject_id == subject_id)
    total = mast = new = 0
    for rc, iv in db.execute(q):
        total += 1
        if not rc:
            new += 1
        elif (iv or 0) >= MASTERED_SECONDS:
            mast += 1
    return {"total": total, "mastered": mast, "learning": total - mast - new, "new": new}


def _cap(q_avg: float | None, recall: float | None) -> float | None:
    if q_avg is not None and recall is not None:
        return round(0.6 * q_avg + 0.4 * recall * 10, 2)
    if q_avg is not None:
        return round(q_avg, 2)
    if recall is not None:
        return round(recall * 10, 2)
    return None


# ---------------------------------------------------------------------------
# Số liệu 1 kỳ
# ---------------------------------------------------------------------------
def compute_metrics(db: Session, user_id: str, a: date, b: date, subject_id: str | None = None) -> dict:
    subs = _subjects(db, user_id)
    mins = _minutes_by_day(db, user_id, a, b, subject_id)
    atts = _attempts(db, user_id, a, b, subject_id)
    fcs = _fc_sessions(db, user_id, a, b, subject_id)
    made = _made(db, user_id, a, b, subject_id)

    days = []
    for d in _days(a, b):
        secs = sum(v for (dd, _s), v in mins.items() if dd == d)
        act = secs > 0 or any(x["date"] == d for x in atts) or any(x["date"] == d for x in fcs)
        days.append({
            "date": d.isoformat(),
            "minutes": round(secs / 60, 1),
            "active": act,
            "made": made.get(d, dict.fromkeys(MADE_TYPES, 0)),
            "scores": [x["score"] for x in atts if x["date"] == d],
        })

    by_sub = {}
    for s in subs:
        if subject_id and s.id != subject_id:
            continue
        sa = [x for x in atts if x["subject_id"] == s.id]
        sf = [x for x in fcs if x["subject_id"] == s.id]
        secs = sum(v for (_d, sid), v in mins.items() if sid == s.id)
        q_avg = sum(x["score"] for x in sa) / len(sa) if sa else None
        rev, ok = sum(x["n"] for x in sf), sum(x["ok"] for x in sf)
        recall = ok / rev if rev else None
        sets: dict[str, dict] = {}
        for x in sa:
            st = sets.setdefault(x["set_id"], {"id": x["set_id"], "title": x["title"], "mode": x["mode"], "scores": []})
            st["scores"].append(x["score"])
        fsets: dict[str, dict] = {}
        for x in sf:
            st = fsets.setdefault(x["set_id"], {"id": x["set_id"], "title": x["title"], "cards": x["cards"], "n": 0, "ok": 0})
            st["n"] += x["n"]
            st["ok"] += x["ok"]
        eligible = len(sa) >= RANK_MIN_ATTEMPTS or rev >= RANK_MIN_REVIEWS
        by_sub[s.id] = {
            "id": s.id, "name": s.name, "minutes": round(secs / 60, 1),
            "attempts": len(sa), "q_avg": q_avg, "rev": rev, "ok": ok, "recall": recall,
            "eligible": eligible, "cap": _cap(q_avg, recall) if eligible else None,
            "sets": list(sets.values()), "fsets": list(fsets.values()),
        }

    total_secs = sum(mins.values())
    made_tot = dict.fromkeys(MADE_TYPES, 0)
    for v in made.values():
        for k in MADE_TYPES:
            made_tot[k] += v[k]
    act_all = active_dates(db, user_id, b)                     # BR-12 tính trên mọi môn
    act_scope = act_all if not subject_id else active_dates(db, user_id, b, subject_id)
    streak, best = _streaks(act_scope, b)
    rev, ok = sum(x["n"] for x in fcs), sum(x["ok"] for x in fcs)
    return {
        "from": a.isoformat(), "to": b.isoformat(), "len": (b - a).days + 1, "subject_id": subject_id,
        "days": days,
        "minutes": round(total_secs / 60, 1),
        "active_days": sum(1 for d in days if d["active"]),
        "made": made_tot, "made_total": sum(made_tot.values()),
        "attempts": len(atts),
        "practice_count": sum(1 for x in atts if x["mode"] == "practice"),
        "exam_count": sum(1 for x in atts if x["mode"] == "exam"),
        "q_avg": sum(x["score"] for x in atts) / len(atts) if atts else None,
        "correct": sum(x["correct"] for x in atts) / len(atts) if atts else None,
        "rev": rev, "ok": ok, "recall": ok / rev if rev else None,
        "by_subject": by_sub,
        "streak": streak, "best_streak": best,
        "hist": len(act_all),
        "enough": len(act_all) >= MIN_HIST_DAYS,
        "empty": total_secs == 0 and not atts and not fcs and sum(made_tot.values()) == 0,
        "cards": card_states(db, user_id, subject_id),
    }


def prev_range(a: date, b: date) -> tuple[date, date]:
    n = (b - a).days + 1
    return a - timedelta(days=n), a - timedelta(days=1)


def has_data(m: dict) -> bool:
    return not m["empty"]


def heatmap(db: Session, user_id: str, end: date, subject_id: str | None = None, weeks: int = 12) -> list[dict]:
    """Phút học mỗi ngày của `weeks` tuần (T2-CN) kết thúc ở tuần chứa `end`."""
    last = end + timedelta(days=6 - end.weekday())
    first = last - timedelta(days=weeks * 7 - 1)
    mins = _minutes_by_day(db, user_id, first, last, subject_id)
    act = active_dates(db, user_id, last, subject_id)
    return [
        {"date": d.isoformat(), "minutes": round(sum(v for (dd, _s), v in mins.items() if dd == d) / 60, 1), "active": d in act}
        for d in _days(first, last)
    ]


# ---------------------------------------------------------------------------
# Trang "Hôm nay"
# ---------------------------------------------------------------------------
def _occurrences(db: Session, user_id: str, a: date, b: date) -> list[dict]:
    items = db.scalars(
        select(ScheduleItem).where(ScheduleItem.user_id == user_id, ScheduleItem.item_date <= b)
    ).all()
    out = []
    for it in items:
        for d in _days(a, b):
            if schedule_notifier.occurs_on(it.item_date, it.repeat_rule, it.repeat_until, d):
                out.append({
                    "id": it.id, "title": it.title, "type": it.item_type, "date": d.isoformat(),
                    "start_minute": it.start_minute, "end_minute": it.end_minute,
                    "color": it.label.color if it.label else it.color,
                    "subject_name": it.subject.name if it.subject else None,
                })
    out.sort(key=lambda x: (x["date"], x["start_minute"]))
    return out


def today_overview(db: Session, user: User) -> dict:
    t = today()
    now = local_now()
    mon = t - timedelta(days=t.weekday())
    wk = compute_metrics(db, user.id, mon, t)
    pw = compute_metrics(db, user.id, mon - timedelta(days=7), t - timedelta(days=7))
    now_utc = local_to_utc(now)

    # Thẻ đến hạn (đã ôn và tới hạn) + thẻ mới chưa ôn
    due_rows = db.execute(
        select(FlashcardSet.id, FlashcardSet.title, FlashcardSet.subject_id, func.count())
        .join(Flashcard, Flashcard.flashcard_set_id == FlashcardSet.id)
        .where(
            FlashcardSet.user_id == user.id, FlashcardSet.status == "ready",
            Flashcard.review_count > 0, Flashcard.due_at <= now_utc,
        )
        .group_by(FlashcardSet.id, FlashcardSet.title, FlashcardSet.subject_id)
        .order_by(func.count().desc())
    ).all()
    due = sum(r[3] for r in due_rows)

    # Bài đang làm dở (ôn tập; đề thi còn hạn)
    open_att = db.execute(
        select(QuizAttempt, QuizSet)
        .join(QuizSet, QuizSet.id == QuizAttempt.quiz_set_id)
        .where(
            QuizAttempt.user_id == user.id, QuizAttempt.finished_at.is_(None),
            (QuizAttempt.deadline_at.is_(None)) | (QuizAttempt.deadline_at > func.now()),
        )
        .order_by(QuizAttempt.started_at.desc())
        .limit(1)
    ).first()
    last_sess = db.scalars(
        select(StudySession)
        .where(
            StudySession.user_id == user.id, StudySession.activity.in_(("chapter", "pdf")),
            (StudySession.chapter_id.is_not(None)) | (StudySession.document_id.is_not(None)),
        )
        .order_by(StudySession.last_beat_at.desc())
        .limit(1)
    ).first()
    resume = None
    if open_att:
        att, qs = open_att
        answered = len(att.answers) if att.answers is not None else 0
        resume = {
            "kind": qs.mode, "id": qs.id, "title": qs.title,
            "subject_id": qs.subject_id, "subject_name": qs.subject.name if qs.subject else None,
            "detail": f"Đã làm {answered}/{att.total_questions} câu",
            "at": utc_to_local(att.started_at).isoformat(),
        }
    elif last_sess:
        if last_sess.chapter_id:
            ch = db.get(Chapter, last_sess.chapter_id)
            title = ch.name if ch else None
        else:
            doc = db.get(PdfDocument, last_sess.document_id) if last_sess.document_id else None
            title = doc.original_name if doc else None
        if title:
            sub = db.get(Subject, last_sess.subject_id)
            resume = {
                "kind": last_sess.activity, "id": last_sess.chapter_id or last_sess.document_id, "title": title,
                "subject_id": last_sess.subject_id, "subject_name": sub.name if sub else None,
                "detail": "Đọc lần cuối", "at": last_sess.last_beat_at.isoformat(),
            }

    # Lịch hôm nay + sắp tới (14 ngày: deadline / lịch thi)
    occ = _occurrences(db, user.id, t, t + timedelta(days=14))
    today_items = [x for x in occ if x["date"] == t.isoformat()]
    upcoming = [x for x in occ if x["date"] > t.isoformat() and x["type"] in ("deadline", "exam")][:3]
    next_exam = next(
        (x for x in occ if x["type"] == "exam" and (x["date"] > t.isoformat() or x["end_minute"] > now.hour * 60 + now.minute)),
        None,
    )
    last_exam = db.execute(
        select(QuizAttempt.score_percent)
        .where(QuizAttempt.user_id == user.id, QuizAttempt.mode == "exam", QuizAttempt.finished_at.is_not(None))
        .order_by(QuizAttempt.finished_at.desc())
        .limit(1)
    ).scalar()

    # Môn học gần đây (theo hoạt động gần nhất)
    recent = sorted(
        (s for s in subject_list(db, user.id) if s["last_at"]), key=lambda s: s["last_at"], reverse=True
    )[:3]
    return {
        "date": t.isoformat(),
        "week": {"minutes": wk["minutes"], "prev_minutes": pw["minutes"], "prev_has_data": has_data(pw)},
        "streak": wk["streak"], "best_streak": wk["best_streak"],
        "studied_today": t in active_dates(db, user.id, t),
        "due": {"total": due, "sets": [{"id": r[0], "title": r[1], "subject_id": r[2], "count": r[3]} for r in due_rows[:3]]},
        "resume": resume,
        "today_items": today_items, "upcoming": upcoming,
        "next_exam": next_exam, "last_exam_score": last_exam / 10 if last_exam is not None else None,
        "recent_subjects": recent,
        "name": user.display_name,
    }


# ---------------------------------------------------------------------------
# Notebook: danh sách môn + trang môn
# ---------------------------------------------------------------------------
def _reviewed_sources(db: Session, user_id: str) -> tuple[set[str], set[str]]:
    """(chapter_id, document_id) là nguồn của bộ ôn tập / đề thi đã có lượt nộp, hoặc bộ thẻ đã có phiên ôn."""
    ch, doc = set(), set()
    done_quiz = select(QuizAttempt.quiz_set_id).where(QuizAttempt.user_id == user_id, QuizAttempt.finished_at.is_not(None))
    for c, d in db.execute(select(QuizSetSource.chapter_id, QuizSetSource.document_id).where(QuizSetSource.quiz_set_id.in_(done_quiz))):
        if c:
            ch.add(c)
        if d:
            doc.add(d)
    done_fc = select(FlashcardSession.flashcard_set_id).where(FlashcardSession.user_id == user_id)
    for c, d in db.execute(
        select(FlashcardSetSource.chapter_id, FlashcardSetSource.document_id).where(FlashcardSetSource.flashcard_set_id.in_(done_fc))
    ):
        if c:
            ch.add(c)
        if d:
            doc.add(d)
    return ch, doc


def _studied_sources(db: Session, user_id: str) -> tuple[dict[str, datetime], dict[str, datetime]]:
    ch: dict[str, datetime] = {}
    doc: dict[str, datetime] = {}
    for c, d, at in db.execute(
        select(StudySession.chapter_id, StudySession.document_id, func.max(StudySession.last_beat_at))
        .where(StudySession.user_id == user_id, StudySession.active_seconds > 0)
        .group_by(StudySession.chapter_id, StudySession.document_id)
    ):
        if c:
            ch[c] = max(ch.get(c, at), at)
        if d:
            doc[d] = max(doc.get(d, at), at)
    return ch, doc


def _last_activity(db: Session, user_id: str) -> dict[str, datetime]:
    """Lần học gần nhất theo môn (phiên học / bài nộp / phiên ôn thẻ), giờ địa phương."""
    out: dict[str, datetime] = {}

    def put(sid, at):
        if sid and at and (sid not in out or at > out[sid]):
            out[sid] = at

    for sid, at in db.execute(
        select(StudySession.subject_id, func.max(StudySession.last_beat_at))
        .where(StudySession.user_id == user_id, StudySession.active_seconds > 0)
        .group_by(StudySession.subject_id)
    ):
        put(sid, at)
    for sid, at in db.execute(
        select(QuizSet.subject_id, func.max(QuizAttempt.finished_at))
        .join(QuizSet, QuizSet.id == QuizAttempt.quiz_set_id)
        .where(QuizAttempt.user_id == user_id, QuizAttempt.finished_at.is_not(None))
        .group_by(QuizSet.subject_id)
    ):
        put(sid, utc_to_local(at))
    for sid, at in db.execute(
        select(FlashcardSet.subject_id, func.max(FlashcardSession.finished_at))
        .join(FlashcardSet, FlashcardSet.id == FlashcardSession.flashcard_set_id)
        .where(FlashcardSession.user_id == user_id)
        .group_by(FlashcardSet.subject_id)
    ):
        put(sid, utc_to_local(at))
    return out


def _count_by_subject(db: Session, model, user_id: str, *conds) -> dict[str, int]:
    q = select(model.subject_id, func.count()).where(model.user_id == user_id, model.status == "ready", *conds).group_by(model.subject_id)
    return {sid: n for sid, n in db.execute(q)}


def _word_count(text: str | None) -> int:
    return len((text or "").split())


def subject_list(db: Session, user_id: str) -> list[dict]:
    subs = _subjects(db, user_id)
    last = _last_activity(db, user_id)
    reviewed_ch, reviewed_doc = _reviewed_sources(db, user_id)
    practice = _count_by_subject(db, QuizSet, user_id, QuizSet.mode == "practice")
    exams = _count_by_subject(db, QuizSet, user_id, QuizSet.mode == "exam")
    fsets = _count_by_subject(db, FlashcardSet, user_id)
    out = []
    for s in subs:
        ch_ids = [c for (c,) in db.execute(select(Chapter.id).where(Chapter.subject_id == s.id))]
        doc_ids = [d for (d,) in db.execute(select(PdfDocument.id).where(PdfDocument.subject_id == s.id))]
        items = len(ch_ids) + len(doc_ids)
        done = sum(1 for c in ch_ids if c in reviewed_ch) + sum(1 for d in doc_ids if d in reviewed_doc)
        out.append({
            "id": s.id, "name": s.name,
            "chapters": len(ch_ids), "pdfs": len(doc_ids),
            "practice_sets": practice.get(s.id, 0), "exams": exams.get(s.id, 0), "flashcard_sets": fsets.get(s.id, 0),
            "reviewed_percent": round(done / items * 100) if items else 0,
            "last_at": last[s.id].isoformat() if s.id in last else None,
        })
    return out


def subject_detail(db: Session, user_id: str, subject: Subject) -> dict:
    reviewed_ch, reviewed_doc = _reviewed_sources(db, user_id)
    studied_ch, studied_doc = _studied_sources(db, user_id)

    def status(rid, reviewed, studied):
        return "reviewed" if rid in reviewed else "learning" if rid in studied else "new"

    items = []
    for c in db.scalars(select(Chapter).where(Chapter.subject_id == subject.id).order_by(Chapter.sort_order, Chapter.created_at)):
        items.append({
            "kind": "chapter", "id": c.id, "name": c.name, "words": _word_count(c.content_text),
            "pages": None, "status": status(c.id, reviewed_ch, studied_ch),
            "sort": c.sort_order,
        })
    for d in db.scalars(select(PdfDocument).where(PdfDocument.subject_id == subject.id).order_by(PdfDocument.sort_order, PdfDocument.created_at)):
        items.append({
            "kind": "pdf", "id": d.id, "name": d.original_name, "words": None,
            "pages": d.page_count, "status": status(d.id, reviewed_doc, studied_doc),
            "sort": d.sort_order,
        })
    items.sort(key=lambda x: (x["sort"] or 0))
    for x in items:
        x.pop("sort")
        x["short"] = x["kind"] == "chapter" and x["words"] < SHORT_WORDS
    cards = db.scalar(
        select(func.count()).select_from(Flashcard).join(FlashcardSet, FlashcardSet.id == Flashcard.flashcard_set_id)
        .where(FlashcardSet.subject_id == subject.id, FlashcardSet.user_id == user_id, FlashcardSet.status == "ready")
    ) or 0
    t = today()
    m7 = compute_metrics(db, user_id, t - timedelta(days=6), t, subject.id)
    b = m7["by_subject"].get(subject.id, {})
    last = _last_activity(db, user_id).get(subject.id)
    done = sum(1 for x in items if x["status"] == "reviewed")
    return {
        "id": subject.id, "name": subject.name,
        "items": items,
        "reviewed_percent": round(done / len(items) * 100) if items else 0,
        "last_at": last.isoformat() if last else None,
        "tools": {
            "practice": _count_by_subject(db, QuizSet, user_id, QuizSet.mode == "practice", QuizSet.subject_id == subject.id).get(subject.id, 0),
            "exam": _count_by_subject(db, QuizSet, user_id, QuizSet.mode == "exam", QuizSet.subject_id == subject.id).get(subject.id, 0),
            "flashcard": _count_by_subject(db, FlashcardSet, user_id, FlashcardSet.subject_id == subject.id).get(subject.id, 0),
            "cards": cards,
            "mindmap": _count_by_subject(db, Mindmap, user_id, Mindmap.subject_id == subject.id).get(subject.id, 0),
            "summary": _count_by_subject(db, Summary, user_id, Summary.subject_id == subject.id).get(subject.id, 0),
        },
        "week": {"cap": b.get("cap"), "recall": b.get("recall"), "minutes": b.get("minutes", 0)},
    }


# ---------------------------------------------------------------------------
# Snapshot (STAT_SNAPSHOT)
# ---------------------------------------------------------------------------
def snapshot_summary(m: dict) -> dict:
    """Phần số liệu cất vào snapshot (bỏ `days` chi tiết cho gọn, giữ điểm theo ngày để vẽ lại)."""
    el = [x for x in m["by_subject"].values() if x["eligible"] and x["cap"] is not None]
    keep = {k: v for k, v in m.items() if k != "days"}
    keep["cap"] = round(sum(x["cap"] for x in el) / len(el), 2) if el else None
    return keep


def _lock_user(db: Session, user_id: str) -> None:
    db.execute(select(User.id).where(User.id == user_id).with_for_update())


def ensure_weekly_snapshots(db: Session, user_id: str, weeks_back: int = 8) -> int:
    """Chốt snapshot cho các tuần T2-CN ĐÃ KẾT THÚC (tối đa `weeks_back` tuần) còn thiếu, nếu tuần đó đủ BR-12 và có dữ
    liệu. Idempotent: khoá dòng users rồi mới kiểm trùng (bảng không có UNIQUE — xem stats_schema.sql)."""
    t = today()
    last_sun = t - timedelta(days=t.weekday() + 1)
    created = 0
    _lock_user(db, user_id)
    have = {
        (f, to) for f, to in db.execute(
            select(StatSnapshot.period_from, StatSnapshot.period_to).where(
                StatSnapshot.user_id == user_id, StatSnapshot.kind == "weekly", StatSnapshot.subject_id.is_(None)
            )
        )
    }
    acts = active_dates(db, user_id, last_sun)
    for w in range(weeks_back):
        b = last_sun - timedelta(days=7 * w)
        a = b - timedelta(days=6)
        if (a, b) in have:
            continue
        if sum(1 for d in acts if d <= b) < MIN_HIST_DAYS or not any(a <= d <= b for d in acts):
            continue
        m = compute_metrics(db, user_id, a, b)
        db.add(StatSnapshot(
            user_id=user_id, subject_id=None, period_from=a, period_to=b, kind="weekly",
            metrics=_jsonable(snapshot_summary(m)), created_at=local_now(),
        ))
        created += 1
    db.commit()
    return created


def run_weekly_for_all(db: Session) -> None:
    """Vòng nền: chốt tuần vừa xong cho mọi người có hoạt động trong 8 ngày gần đây."""
    since = local_now() - timedelta(days=8)
    since_utc = local_to_utc(since)
    users = set(db.scalars(select(StudySession.user_id).where(StudySession.started_at >= since).distinct()))
    users |= set(db.scalars(select(QuizAttempt.user_id).where(QuizAttempt.finished_at >= since_utc).distinct()))
    users |= set(db.scalars(select(FlashcardSession.user_id).where(FlashcardSession.finished_at >= since_utc).distinct()))
    for uid in users:
        ensure_weekly_snapshots(db, uid, weeks_back=1)


def _jsonable(v):
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def jsonable(v):
    return _jsonable(v)
