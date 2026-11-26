"""Thống kê hiệu suất (UC-29) + Nhận xét AI (UC-30) + ghi phiên học. Xem .claude/rules/09-schedule-stats.md,
database/stats_schema.sql. Mọi con số tính ở services/stats.py; giao diện: frontend/js/ghichu_thongke.js (theo mẫu
thong-ke.html), ghi phiên học: frontend/js/ghichu_phienhoc.js.

- BR-05: Môn / Chương / PDF / snapshot phải thuộc người dùng -> 404.
- BR-12: dưới 7 ngày hoạt động -> `enough=false` (giao diện chặn Kết quả / So sánh / AI), không trả kỳ trước;
  POST /stats/ai -> 400.
- UC-30 E1: quá ít dữ liệu (< 3 lượt làm bài VÀ < 30 lượt ôn thẻ) -> trả `few`, KHÔNG gọi AI, không tốn lượt.
- Hạn mức: lượt "Nhận xét AI" riêng (tính năng 'review' của services/quota.py, mặc định 5/ngày, admin sửa ở UC-33);
  mỗi lượt "Phân tích" là 1 snapshot kind='ai' mới.
"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.models import Chapter, PdfDocument, ScheduleItem, ScheduleLabel, StatSnapshot, StudySession, Subject, User
from app.routers.schedule import _apply as apply_schedule_item
from app.schemas import (
    STATS_MAX_RANGE_DAYS,
    ScheduleItemIn,
    StatsAiRequest,
    StatsScheduleRequest,
    StudySessionBeat,
    StudySessionStart,
)
from app.services import quota, stats, stats_ai
from app.services.schedule_notifier import local_now

router = APIRouter(prefix="/stats", tags=["Thống kê hiệu suất (UC-29, UC-30)"])

_MAX_BEAT_GAP = 120     # 1 nhịp cộng tối đa 2 phút dù client báo nhiều hơn (chống treo tab / đồng hồ máy sai)
# Bảng màu của Lịch biểu (ghichu_lichbieu.js PALETTE + RESERVE) — chọn màu trống cho nhãn môn khi thêm đề xuất vào lịch
_PALETTE = ["#2c4a8c", "#0d7380", "#ad6e0d", "#804080", "#2e7d4f", "#b83d38", "#2f62c4", "#5c6370",
            "#c4561d", "#b03a74", "#6b7a1f", "#1c86a8",
            # màu dự phòng (RESERVE) — dùng khi 12 màu trên đã thuộc nhãn khác
            "#3f51b5", "#00897b", "#a0522d", "#7a4fb5", "#558b2f", "#c2185b", "#00838f", "#d84315",
            "#6a1b9a", "#9e7c0c", "#455a64", "#8d6e63"]
_SUGGEST_START_MINUTE = 19 * 60   # buổi ôn đề xuất bắt đầu 19:00


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _owned_subject(db: Session, user: User, subject_id: str | None) -> Subject | None:
    if not subject_id:
        return None
    s = db.get(Subject, subject_id)
    if s is None or s.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy Môn học.")
    return s


def _range(a: date, b: date) -> None:
    if b < a or (b - a).days >= STATS_MAX_RANGE_DAYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Khoảng thời gian phải từ 1 đến {STATS_MAX_RANGE_DAYS} ngày.")


def _snap_out(s: StatSnapshot, subject_name: str | None = None, full: bool = False) -> dict:
    m = s.metrics or {}
    out = {
        "id": s.id, "kind": s.kind, "from": s.period_from.isoformat(), "to": s.period_to.isoformat(),
        "len": (s.period_to - s.period_from).days + 1, "subject_id": s.subject_id, "subject_name": subject_name,
        "created_at": s.created_at.isoformat(), "q_avg": m.get("q_avg"), "recall": m.get("recall"),
        "minutes": m.get("minutes"), "cap": m.get("cap"),
        "ai_saved": s.ai_saved, "has_ai": s.ai_result is not None and not (s.ai_result or {}).get("few"),
        "ai_at": s.ai_at.isoformat() if s.ai_at else None,
    }
    if full:
        out["metrics"] = m
        out["ai_result"] = s.ai_result
    return out


def _latest_ai(db: Session, user: User, a: date, b: date, subject_id: str | None) -> StatSnapshot | None:
    q = select(StatSnapshot).where(
        StatSnapshot.user_id == user.id, StatSnapshot.kind == "ai",
        StatSnapshot.period_from == a, StatSnapshot.period_to == b,
    )
    q = q.where(StatSnapshot.subject_id == subject_id) if subject_id else q.where(StatSnapshot.subject_id.is_(None))
    return db.scalars(q.order_by(StatSnapshot.created_at.desc())).first()


def _owned_snapshot(db: Session, user: User, snap_id: str) -> StatSnapshot:
    s = db.get(StatSnapshot, snap_id)
    if s is None or s.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy snapshot.")
    return s


# ---------------------------------------------------------------------------
# Phiên học
# ---------------------------------------------------------------------------
@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def start_session(payload: StudySessionStart, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    subject_id = payload.subject_id
    if payload.chapter_id:
        ch = db.get(Chapter, payload.chapter_id)
        if ch is None or ch.subject.owner_id != current_user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy Chương.")
        subject_id = ch.subject_id
    if payload.document_id:
        doc = db.get(PdfDocument, payload.document_id)
        if doc is None or doc.subject.owner_id != current_user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tệp PDF.")
        subject_id = doc.subject_id
    _owned_subject(db, current_user, subject_id)
    now = local_now()
    s = StudySession(
        user_id=current_user.id, activity=payload.activity, subject_id=subject_id,
        chapter_id=payload.chapter_id, document_id=payload.document_id,
        started_at=now, last_beat_at=now, active_seconds=0,
    )
    db.add(s)
    db.commit()
    return {"id": s.id}


@router.patch("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def beat_session(
    session_id: str, payload: StudySessionBeat, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    s = db.get(StudySession, session_id)
    if s is None or s.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy phiên học.")
    if s.ended_at is not None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    now = local_now()
    gap = max(0, int((now - s.last_beat_at).total_seconds())) + 5
    s.active_seconds += min(payload.active_seconds, gap, _MAX_BEAT_GAP)
    s.last_beat_at = now
    if payload.end:
        s.ended_at = now
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Tổng quan
# ---------------------------------------------------------------------------
@router.get("/today")
def get_today(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return stats.jsonable(stats.today_overview(db, current_user))


@router.get("/overview")
def get_overview(
    a: date = Query(..., alias="from"),
    b: date = Query(..., alias="to"),
    subject_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Số liệu kỳ [from, to] + kỳ liền trước cùng độ dài (chỉ khi đủ BR-12) + nhận xét AI gần nhất của đúng kỳ này."""
    _range(a, b)
    _owned_subject(db, current_user, subject_id)
    cur = stats.compute_metrics(db, current_user.id, a, b, subject_id)
    prev = None
    if cur["enough"]:
        pa, pb = stats.prev_range(a, b)
        prev = stats.compute_metrics(db, current_user.id, pa, pb, subject_id)
        if not stats.has_data(prev):
            prev = None
    ai = _latest_ai(db, current_user, a, b, subject_id)
    return stats.jsonable({
        "cur": cur, "prev": prev,
        "ai": _snap_out(ai, full=True) if ai else None,
        "ai_remaining": quota.remaining(db, current_user, "review"),
        "ai_limit": quota.get_settings(db)["ai.review"],
    })


@router.get("/heatmap")
def get_heatmap(
    to: date, subject_id: str | None = None,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    _owned_subject(db, current_user, subject_id)
    return stats.heatmap(db, current_user.id, to, subject_id)


# ---------------------------------------------------------------------------
# Notebook
# ---------------------------------------------------------------------------
@router.get("/subjects")
def list_subjects(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return stats.subject_list(db, current_user.id)


@router.get("/subjects/{subject_id}")
def get_subject(subject_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return stats.jsonable(stats.subject_detail(db, current_user.id, _owned_subject(db, current_user, subject_id)))


# ---------------------------------------------------------------------------
# Lịch sử tiến bộ (snapshot)
# ---------------------------------------------------------------------------
@router.get("/snapshots")
def list_snapshots(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Snapshot tuần (tự chốt "lười" các tuần đã xong còn thiếu) + nhận xét AI ĐÃ LƯU. Nhận xét AI đã lưu của đúng 1 tuần
    đã có snapshot tuần thì gắn vào dòng tuần đó (`ai_id`), không thành dòng riêng."""
    stats.ensure_weekly_snapshots(db, current_user.id)
    rows = db.scalars(
        select(StatSnapshot)
        .where(StatSnapshot.user_id == current_user.id)
        .where((StatSnapshot.kind == "weekly") | (StatSnapshot.ai_saved.is_(True)))
        .order_by(StatSnapshot.period_to.desc(), StatSnapshot.created_at.desc())
    ).all()
    names = {s.id: s.name for s in stats._subjects(db, current_user.id)}
    weekly = {(r.period_from, r.period_to): r for r in rows if r.kind == "weekly"}
    out, attached = [], set()
    for r in rows:
        if r.kind == "ai" and r.subject_id is None and (r.period_from, r.period_to) in weekly:
            w = weekly[(r.period_from, r.period_to)]
            if w.id not in attached:
                attached.add(w.id)
                w._ai = r          # noqa: SLF001 — gắn tạm cho vòng dưới
    for r in rows:
        if r.kind == "ai" and r.subject_id is None and (r.period_from, r.period_to) in weekly:
            continue
        o = _snap_out(r, names.get(r.subject_id))
        ai = getattr(r, "_ai", None)
        if ai is not None:
            o["ai_id"], o["ai_saved"], o["has_ai"] = ai.id, True, True
        out.append(o)
    return out


@router.get("/snapshots/{snap_id}")
def get_snapshot(snap_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = _owned_snapshot(db, current_user, snap_id)
    sub = db.get(Subject, s.subject_id) if s.subject_id else None
    return _snap_out(s, sub.name if sub else None, full=True)


# ---------------------------------------------------------------------------
# UC-30 Nhận xét AI
# ---------------------------------------------------------------------------
@router.post("/ai")
def create_review(payload: StatsAiRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a, b, sid = payload.from_date, payload.to_date, payload.subject_id
    _owned_subject(db, current_user, sid)
    m = stats.compute_metrics(db, current_user.id, a, b, sid)
    if not m["enough"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cần ít nhất 7 ngày hoạt động để AI nhận xét (BR-12).")
    if m["empty"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không có hoạt động nào trong khoảng thời gian này.")
    now = local_now()
    snap = StatSnapshot(
        user_id=current_user.id, subject_id=sid, period_from=a, period_to=b, kind="ai",
        metrics=stats.jsonable(stats.snapshot_summary(m)), created_at=now,
    )
    if m["attempts"] < stats.FEW_ATTEMPTS and m["rev"] < stats.FEW_REVIEWS:      # UC-30 E1 — không gọi AI
        snap.ai_result = {"few": True, "attempts": m["attempts"], "rev": m["rev"]}
        db.add(snap)
        db.commit()
        return {"snapshot": _snap_out(snap, full=True), "ai_remaining": quota.remaining(db, current_user, "review")}
    tracker = quota.start(db, current_user, "review")
    pa, pb = stats.prev_range(a, b)
    prev = stats.compute_metrics(db, current_user.id, pa, pb, sid)
    result, model, error = stats_ai.generate_review(m, prev if stats.has_data(prev) else None)
    if result is None:
        quota.failed(tracker)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, error or "Chưa thể tạo nhận xét lúc này.")
    snap.ai_result, snap.model_name, snap.ai_at = result, model, local_now()
    db.add(snap)
    db.commit()
    quota.done(tracker, model)
    return {"snapshot": _snap_out(snap, full=True), "ai_remaining": quota.remaining(db, current_user, "review")}


@router.post("/ai/{snap_id}/save")
def save_review(snap_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = _owned_snapshot(db, current_user, snap_id)
    if s.kind != "ai" or not s.ai_result or s.ai_result.get("few"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Snapshot này không có nhận xét để lưu.")
    s.ai_saved = True
    db.commit()
    return _snap_out(s, full=True)


@router.post("/ai/{snap_id}/schedule")
def add_review_to_schedule(
    snap_id: str, payload: StatsScheduleRequest,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    """Thêm các đề xuất `act` (có môn) thành buổi ôn ở TUẦN SAU: chia đều các ngày T2-CN, bắt đầu 19:00 (nhiều buổi
    cùng ngày thì xếp nối tiếp), nhãn = tên môn, liên kết Môn (UC-26 1a). Trùng giờ với lịch sẵn có vẫn tạo (BR-11)."""
    s = _owned_snapshot(db, current_user, snap_id)
    acts = (s.ai_result or {}).get("act") or []
    idx = payload.indexes or [i for i, x in enumerate(acts) if x.get("subject_id")]
    t = stats.today()
    next_mon = t + timedelta(days=7 - t.weekday())
    created = []
    day_cursor: dict[date, int] = {}       # các buổi cùng ngày xếp NỐI TIẾP (19:00, rồi sau buổi trước 10 phút)
    for i in idx:
        if i < 0 or i >= len(acts):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Đề xuất không hợp lệ.")
        act = acts[i]
        subj = db.get(Subject, act.get("subject_id")) if act.get("subject_id") else None
        if subj is None or subj.owner_id != current_user.id:
            continue                                     # đề xuất không gắn môn / môn đã xoá
        label = db.scalars(
            select(ScheduleLabel).where(ScheduleLabel.user_id == current_user.id, ScheduleLabel.name == subj.name)
        ).first()
        if label is not None:
            color = label.color
        else:
            used = {c.lower() for c in db.scalars(select(ScheduleLabel.color).where(ScheduleLabel.user_id == current_user.id))}
            color = next((c for c in _PALETTE if c not in used), _PALETTE[0])
        n, minutes = int(act.get("sessions") or 1), int(act.get("minutes") or 30)
        for k in range(n):
            day = next_mon + timedelta(days=round(k * 7 / n))
            start = day_cursor.get(day, _SUGGEST_START_MINUTE)
            if start + minutes > 23 * 60 + 59:
                start = max(0, 23 * 60 + 59 - minutes)
            day_cursor[day] = start + minutes + 10
            item = ScheduleItem(user_id=current_user.id, item_date=day, start_minute=-1, remind_before="none")
            apply_schedule_item(db, current_user, item, ScheduleItemIn(
                title=f"Ôn {subj.name}", item_type="event", label=subj.name, color=color, subject_id=subj.id,
                date=day, start_minute=start, end_minute=start + minutes, remind_before="m10",
            ))
            db.add(item)
            db.flush()
            created.append({"id": item.id, "title": item.title, "date": day.isoformat(), "start_minute": start, "end_minute": start + minutes})
    db.commit()
    return {"created": created, "week_start": next_mon.isoformat()}
