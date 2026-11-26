"""UC-33 Hạn mức sử dụng — chỗ DUY NHẤT đọc hạn mức, đếm lượt AI, tính dung lượng và gửi nhắc chạm ngưỡng.

Thay services/ai_quota.py (BR-08 cũ = 1 hạn mức chung 100 lượt/ngày). Giờ:
- Hạn mức lấy từ bảng `quota_settings` (admin sửa ở trang Hạn mức), cache 30 giây, `invalidate()` khi admin lưu.
  Mỗi lần sửa có lý do + thông báo mọi người học (`announce`, bảng quota_change_events); sửa TẠM THỜI thì hết
  `expires_at` tự về `base_value` — `get_settings()` dùng ngay giá trị cố định, `expire_temporary()` (vòng nền) ghi lại.
- Lượt AI đếm RIÊNG từng tính năng (BR-08): qa Hỏi đáp (đếm THEO TỪNG CUỘC HỘI THOẠI, không theo ngày — xem
  `PER_SESSION`) · quiz Ôn tập + Thi thử · fc Flashcard · sum Tóm tắt ·
  mind Sơ đồ tư duy · review Nhận xét AI. 1 lượt = 1 dòng `ai_usage_events.status='ok'` trong ngày (từ 0:00 theo
  APP_TIMEZONE, BR-17). Lỗi gọi AI ghi status='error' và KHÔNG trừ lượt; bị chặn vì hết lượt ghi 'limited' (báo cáo
  UC-37 "chạm hạn mức"). Góp ý (BR-19) đếm thẳng bảng `feedback`.
- Cách dùng ở router:  `t = quota.start(db, user, "fc")` (hết lượt → 429, trước khi gọi AI) → sinh nội dung →
  `quota.done(t, model)` khi có kết quả thật / `quota.failed(t)` khi AI lỗi. Không gọi gì cả = không tính lượt
  (vd. Hỏi đáp chưa cấu hình key, trả câu cố định). Token: mọi lượt `generate_content` trong cùng request gọi
  `add_usage(response)` (ContextVar) — chat.py và `_call_llm` của quiz_generation (dùng chung cho Flashcard / Sơ đồ /
  Tóm tắt / Nhận xét AI). Request chết giữa chừng (5xx) mà chưa done/failed → middleware `track_server_errors`
  ghi 'error' + error_source='server'.
- Sự kiện ghi bằng Session RIÊNG (commit ngay) để không dính vào transaction của request (bị rollback khi lỗi).
- Dung lượng = PDF (pdf_documents) + tệp đính kèm chat (chat_attachments kind='file') + ảnh góp ý (feedback).
  Số tệp/môn chỉ đếm PDF (không tính ảnh chat). Mức 0–3: max(% dung lượng, % số tệp môn nhiều nhất) so với
  ngưỡng nhắc 1 / nhắc 2 / 100% (= đầy, chặn tải lên). `refresh_level()` chỉ tạo thông báo khi mức TĂNG.
"""
from __future__ import annotations

import math
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import (
    AiUsageEvent,
    ChatAttachment,
    ChatMessage,
    Feedback,
    Notification,
    NotificationDelivery,
    PdfDocument,
    QuotaChangeEvent,
    QuotaSetting,
    Subject,
    User,
    UserQuotaState,
)
from app.services.schedule_notifier import local_now

MB = 1024 * 1024

# feature -> (khoá quota_settings, tên hiển thị, trần kỹ thuật)
FEATURES: dict[str, tuple[str, str, int]] = {
    "qa": ("ai.qa", "Hỏi đáp", 200),
    "quiz": ("ai.quiz", "Ôn tập, thi thử", 50),
    "fc": ("ai.fc", "Flashcard", 50),
    "sum": ("ai.sum", "Tóm tắt", 50),
    "mind": ("ai.mind", "Sơ đồ tư duy", 50),
    "review": ("ai.review", "Nhận xét AI", 50),
}
# Tính năng có hạn mức theo TỪNG cuộc hội thoại (kiểu ChatGPT): `ai.qa` = số câu trả lời AI tối đa trong 1 phiên chat,
# hết thì phải mở cuộc hội thoại mới; không giới hạn theo ngày, không nhắc chuông "sắp hết lượt hôm nay".
PER_SESSION = {"qa"}
FEEDBACK = ("feedback", "Góp ý", 50)
STORAGE: dict[str, tuple[str, str, int]] = {
    "storage.user_mb": ("Dung lượng mỗi người", "MB", 5000),
    "storage.file_mb": ("Kích thước tệp tối đa", "MB", 100),
    "storage.subject_files": ("Số tệp mỗi môn", "tệp", 200),
}
WARN_KEYS = ("warn.w1", "warn.w2", "warn.ai")
DEFAULTS = {
    "ai.qa": 50, "ai.quiz": 10, "ai.fc": 10, "ai.sum": 10, "ai.mind": 10, "ai.review": 5, "feedback": 5,
    "storage.user_mb": 500, "storage.file_mb": 20, "storage.subject_files": 30,
    "warn.w1": 80, "warn.w2": 95, "warn.ai": 20,
}


# --------------------------------------------------------------------------- cấu hình

_cache: dict = {"at": 0.0, "rows": None}


def _rows(db: Session) -> dict[str, tuple[int, int | None, datetime | None]]:
    if _cache["rows"] is None or time.monotonic() - _cache["at"] > 30:
        rows = db.execute(select(QuotaSetting.setting_key, QuotaSetting.value, QuotaSetting.base_value,
                                 QuotaSetting.expires_at)).all()
        _cache.update(at=time.monotonic(), rows={k: (v, b, e) for k, v, b, e in rows})
    return _cache["rows"]


def get_settings(db: Session) -> dict[str, int]:
    """Hạn mức đang hiệu lực: hạn tạm thời đã hết thì dùng ngay số cố định (base_value), kể cả khi vòng nền chưa kịp ghi."""
    now = local_now()
    values = dict(DEFAULTS)
    for k, (v, base, exp) in _rows(db).items():
        values[k] = base if exp is not None and base is not None and exp <= now else v
    return values


def temporary(db: Session) -> dict[str, dict]:
    """Hạn mức đang tạm thời (chưa hết hạn): {key: {base, expires_at}}."""
    now = local_now()
    return {k: {"base": base, "expires_at": exp} for k, (v, base, exp) in _rows(db).items()
            if exp is not None and exp > now}


def setting_label(key: str) -> tuple[str, str]:
    """(tên hiển thị, đơn vị) của 1 khoá hạn mức — dùng cho thông báo người học / nhật ký."""
    for f, (k, name, _) in FEATURES.items():
        if k == key:
            return name, "lượt / cuộc hội thoại" if f in PER_SESSION else "lượt / ngày"
    if key == FEEDBACK[0]:
        return FEEDBACK[1], "lần gửi / ngày"
    if key in STORAGE:
        return STORAGE[key][0], STORAGE[key][1]
    return {"warn.w1": "Nhắc lần 1", "warn.w2": "Nhắc lần 2", "warn.ai": "Nhắc lượt AI (còn)"}[key], "%"


def announce(db: Session, event: QuotaChangeEvent) -> int:
    """Gửi 1 thông báo (kind quota_change) tới MỌI người học về lần đổi hạn mức này. Trả số người đã báo.
    Chuông / hộp báo chỉ hiện NGẮN GỌN (tiêu đề + tên các mục đổi + hạn tạm thời); lý do và từng thay đổi cũ -> mới nằm
    ở popup khi bấm thông báo (GET /me/quota/changes/{id})."""
    title = "Hạn mức đã trở về mức cố định" if event.kind == "revert" else "Hạn mức sử dụng đã thay đổi"
    names = list(dict.fromkeys(c["name"] for c in event.changes))
    detail = ", ".join(names[:3]) + (f" và {len(names) - 3} mục khác" if len(names) > 3 else "")
    if event.expires_at is not None:
        detail += f" · tạm thời tới {event.expires_at:%H:%M %d/%m}"
    detail += " · Bấm để xem chi tiết"
    n = 0
    for uid in db.scalars(select(User.id).where(User.role == "learner")):
        n += notify(db, uid, "quota_change", str(event.id), title, detail, f"qc:{event.id}")
    return n


def expire_temporary(db: Session) -> int:
    """Vòng nền: hạn mức tạm thời đã hết hạn -> ghi lại số cố định, 1 sự kiện 'revert' cho mỗi thời điểm hết hạn, ghi nhật ký quản trị (người làm = Hệ thống) + thông báo người học. Trả số khoá đã trả về."""
    from app.services import audit   # tránh import vòng (audit -> models)

    now = local_now()
    rows = db.scalars(select(QuotaSetting).where(QuotaSetting.expires_at.is_not(None), QuotaSetting.expires_at <= now)
                      .with_for_update(skip_locked=True)).all()
    if not rows:
        return 0
    groups: dict = {}   # cùng thời điểm hết hạn -> 1 thông báo (kể cả khi thuộc nhiều lần sửa tạm thời khác nhau)
    for r in rows:
        groups.setdefault(r.expires_at, []).append(r)
    events = []
    for _exp, items in groups.items():
        changes = []
        for r in items:
            name, unit = setting_label(r.setting_key)
            changes.append({"key": r.setting_key, "name": name, "unit": unit, "from": r.value, "to": r.base_value})
            audit.log(db, None, "quota", "Hết hạn tạm thời", "Hạn mức chung", name, str(r.value), f"{r.base_value} (cố định)")
            r.value, r.base_value, r.expires_at, r.change_id = r.base_value, None, None, None
        ev = QuotaChangeEvent(kind="revert", admin_id=None, admin_label=audit.SYSTEM_LABEL,
                              reason="Hết thời gian áp dụng tạm thời — hạn mức trở về mức cố định.",
                              changes=changes, created_at=now)
        db.add(ev)
        events.append(ev)
    db.flush()
    for ev in events:
        announce(db, ev)
    db.commit()
    invalidate()
    for uid in db.scalars(select(User.id).where(User.role == "learner")):
        refresh_level(db, uid)
    db.commit()
    return len(rows)


def invalidate() -> None:
    _cache["rows"] = None


def validate_settings(values: dict[str, int]) -> str | None:
    """Kiểm như `tErr()` + trần của mockup admin. Trả lỗi tiếng Việt hoặc None."""
    caps = {k: c for k, _, c in FEATURES.values()} | {FEEDBACK[0]: FEEDBACK[2]} | {k: v[2] for k, v in STORAGE.items()}
    for key, cap in caps.items():
        v = values.get(key)
        if not isinstance(v, int) or v <= 0 or v > cap:
            return ("Có giá trị không hợp lệ: phải là số nguyên lớn hơn 0 và không vượt trần (Hỏi đáp 200, công cụ khác 50; "
                    "dung lượng 5.000 MB, tệp 100 MB, 200 tệp).")
    w1, w2, ai = values.get("warn.w1"), values.get("warn.w2"), values.get("warn.ai")
    if not all(isinstance(x, int) for x in (w1, w2, ai)):
        return "Ngưỡng nhắc phải là số nguyên."
    if w1 < 50 or w1 >= w2:
        return "Nhắc lần 1 phải từ 50% và nhỏ hơn nhắc lần 2."
    if w2 > 99:
        return "Nhắc lần 2 tối đa 99% — tới 100% hệ thống tự chặn tải lên."
    if ai < 5 or ai > 50:
        return "Nhắc lượt AI: từ 5% tới 50% số lượt còn lại."
    return None


# --------------------------------------------------------------------------- lượt AI

def _midnight() -> datetime:
    return local_now().replace(hour=0, minute=0, second=0, microsecond=0)


def seconds_to_midnight() -> int:
    return int((_midnight() + timedelta(days=1) - local_now()).total_seconds())


def uses_today(db: Session, user_id: str) -> dict[str, int]:
    rows = db.execute(
        select(AiUsageEvent.feature, func.count())
        .where(AiUsageEvent.user_id == user_id, AiUsageEvent.status == "ok", AiUsageEvent.created_at >= _midnight())
        .group_by(AiUsageEvent.feature)
    ).all()
    out = {f: 0 for f in FEATURES}
    out.update({f: n for f, n in rows})
    return out


def feedback_today(db: Session, user_id: str) -> int:
    return db.scalar(
        select(func.count()).select_from(Feedback).where(Feedback.user_id == user_id, Feedback.created_at >= _midnight())
    ) or 0


def session_uses(db: Session, session_id: str | None) -> int:
    """Số câu trả lời AI THẬT (model_name khác NULL — câu dự phòng khi lỗi không tính) trong 1 phiên chat."""
    if session_id is None:
        return 0
    return db.scalar(
        select(func.count()).select_from(ChatMessage).where(
            ChatMessage.session_id == session_id, ChatMessage.role == "assistant", ChatMessage.model_name.is_not(None)
        )
    ) or 0


def remaining(db: Session, user: User, feature: str) -> int:
    limit = get_settings(db)[FEATURES[feature][0]]
    return max(0, limit - uses_today(db, user.id)[feature])


@dataclass
class Tracker:
    user_id: str
    feature: str
    tokens_in: int = 0
    tokens_out: int = 0
    tokens_thinking: int = 0
    finished: bool = False


_tracker: ContextVar[Tracker | None] = ContextVar("ai_tracker", default=None)
_holder: ContextVar[list | None] = ContextVar("ai_tracker_holder", default=None)


def _limit_error(feature: str, limit: int, used: int) -> HTTPException:
    name = FEATURES[feature][1]
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        {
            "message": f"Bạn đã dùng hết {limit} lượt {name} hôm nay. Lượt mới có lúc 00:00.",
            "code": "ai_limit", "feature": feature, "limit": limit, "used": used,
            "reset_in_seconds": seconds_to_midnight(),
        },
    )


def _session_limit_error(limit: int, used: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        {
            "message": f"Cuộc hội thoại này đã dùng hết {limit} lượt hỏi đáp. Hãy tạo cuộc hội thoại mới để tiếp tục.",
            "code": "session_limit", "feature": "qa", "limit": limit, "used": used,
        },
    )


def start(db: Session, user: User, feature: str, session_id: str | None = None) -> Tracker:
    """Kiểm hạn mức TRƯỚC khi gọi AI (hết lượt → ghi 'limited' + 429) rồi mở bộ đếm token cho request này.
    Tính năng PER_SESSION (Hỏi đáp) đếm trong phiên `session_id` (None = phiên mới, chưa dùng lượt nào)."""
    limit = get_settings(db)[FEATURES[feature][0]]
    per_session = feature in PER_SESSION
    used = session_uses(db, session_id) if per_session else uses_today(db, user.id)[feature]
    if used >= limit:
        _write(AiUsageEvent(user_id=user.id, feature=feature, status="limited", created_at=local_now()))
        raise _session_limit_error(limit, used) if per_session else _limit_error(feature, limit, used)
    t = Tracker(user.id, feature)
    _tracker.set(t)
    holder = _holder.get()
    if holder is not None:
        holder.append(t)
    return t


def add_usage(response) -> None:
    """Cộng token của 1 lượt generate_content vào bộ đếm của request (không có bộ đếm thì bỏ qua)."""
    t = _tracker.get()
    meta = getattr(response, "usage_metadata", None)
    if t is None or meta is None:
        return
    t.tokens_in += getattr(meta, "prompt_token_count", None) or 0
    t.tokens_out += getattr(meta, "candidates_token_count", None) or 0
    t.tokens_thinking += getattr(meta, "thoughts_token_count", None) or 0


def _prices() -> dict[str, tuple[float, float]]:
    out = {}
    for item in settings.AI_PRICES_PER_MTOK.split(","):
        if "=" in item and ":" in item:
            name, p = item.split("=", 1)
            a, b = p.split(":", 1)
            out[name.strip()] = (float(a), float(b))
    return out


def _cost(model: str | None, t: Tracker) -> float:
    prices = _prices()
    pin, pout = prices.get(model or "", prices.get("*", (0.0, 0.0)))
    return round((t.tokens_in * pin + (t.tokens_out + t.tokens_thinking) * pout) / 1e6, 6)


def done(t: Tracker, model: str | None) -> None:
    """Kết quả AI thật → trừ 1 lượt; sắp hết lượt thì nhắc vào chuông (1 lần/tính năng/ngày)."""
    if t.finished:
        return
    t.finished = True
    _write(AiUsageEvent(
        user_id=t.user_id, feature=t.feature, status="ok", model_name=model, tokens_in=t.tokens_in,
        tokens_out=t.tokens_out, tokens_thinking=t.tokens_thinking, cost_usd=_cost(model, t), created_at=local_now(),
    ))
    with SessionLocal() as db:
        _warn_ai(db, t.user_id, t.feature)
        db.commit()


def failed(t: Tracker, source: str = "gemini", model: str | None = None) -> None:
    if t.finished:
        return
    t.finished = True
    _write(AiUsageEvent(
        user_id=t.user_id, feature=t.feature, status="error", error_source=source, model_name=model,
        tokens_in=t.tokens_in, tokens_out=t.tokens_out, tokens_thinking=t.tokens_thinking,
        cost_usd=_cost(model, t), created_at=local_now(),
    ))


def _write(event: AiUsageEvent) -> None:
    with SessionLocal() as db:
        db.add(event)
        db.commit()


async def track_server_errors(request, call_next):
    """Middleware: lượt AI đã start() mà request trả 5xx / văng lỗi → ghi lỗi máy chủ (UC-37)."""
    holder: list[Tracker] = []
    token = _holder.set(holder)
    try:
        response = await call_next(request)
    except Exception:
        for t in holder:
            failed(t, "server")
        raise
    finally:
        _holder.reset(token)
    if response.status_code >= 500:
        for t in holder:
            failed(t, "server")
    return response


# --------------------------------------------------------------------------- dung lượng

def storage_bytes(db: Session, user_id: str) -> dict[str, int]:
    pdf = db.scalar(
        select(func.coalesce(func.sum(PdfDocument.file_size_bytes), 0))
        .join(Subject, Subject.id == PdfDocument.subject_id)
        .where(Subject.owner_id == user_id)
    )
    chat = db.scalar(
        select(func.coalesce(func.sum(ChatAttachment.file_size_bytes), 0))
        .where(ChatAttachment.user_id == user_id, ChatAttachment.kind == "file")
    )
    fb = db.scalar(
        select(func.coalesce(func.sum(Feedback.image_bytes), 0)).where(Feedback.user_id == user_id)
    )
    return {"pdf": int(pdf or 0), "chat": int(chat or 0), "fb": int(fb or 0)}


def subject_file_counts(db: Session, user_id: str) -> dict[str, int]:
    rows = db.execute(
        select(PdfDocument.subject_id, func.count())
        .join(Subject, Subject.id == PdfDocument.subject_id)
        .where(Subject.owner_id == user_id)
        .group_by(PdfDocument.subject_id)
    ).all()
    return {sid: n for sid, n in rows}


def level_of(storage_pct: float, file_pct: float, cfg: dict[str, int]) -> int:
    p = max(storage_pct, file_pct)
    return 3 if p >= 100 else 2 if p >= cfg["warn.w2"] else 1 if p >= cfg["warn.w1"] else 0


def usage(db: Session, user_id: str) -> dict:
    """Mức dùng hiện tại của 1 người (dùng cho /me/quota, admin, refresh_level)."""
    cfg = get_settings(db)
    by = storage_bytes(db, user_id)
    used = sum(by.values())
    limit = cfg["storage.user_mb"] * MB
    counts = subject_file_counts(db, user_id)
    fmax_sid, fmax = max(counts.items(), key=lambda kv: kv[1]) if counts else (None, 0)
    sp = used / limit * 100
    fp = fmax / cfg["storage.subject_files"] * 100
    return {
        "used": used, "limit": limit, "by_type": by, "storage_pct": sp,
        "subject_counts": counts, "max_subject_id": fmax_sid, "max_subject_files": fmax, "file_pct": fp,
        "level": level_of(sp, fp, cfg), "kind": "mb" if sp >= fp else "file", "cfg": cfg,
    }


def _upload_error(code: int, kind: str, message: str, **extra) -> HTTPException:
    return HTTPException(code, {"message": message, "code": kind, **extra})


def check_upload(db: Session, user: User, size_bytes: int, subject_id: str | None = None) -> None:
    """BR-14: kiểm theo đúng thứ tự của màn người học — kích thước tệp → số tệp của Môn → dung lượng còn trống.
    subject_id chỉ truyền khi tải PDF vào 1 Môn (ảnh chat / ảnh góp ý không tính số tệp môn)."""
    cfg = get_settings(db)
    if size_bytes > cfg["storage.file_mb"] * MB:
        raise _upload_error(
            413, "file_too_big",
            f"Tệp nặng {size_bytes / MB:.1f} MB, vượt giới hạn {cfg['storage.file_mb']} MB mỗi tệp. "
            "Hãy nén PDF hoặc tách thành nhiều phần nhỏ hơn.",
            limit_mb=cfg["storage.file_mb"],
        )
    if subject_id is not None:
        n = db.scalar(select(func.count()).select_from(PdfDocument).where(PdfDocument.subject_id == subject_id)) or 0
        if n >= cfg["storage.subject_files"]:
            raise _upload_error(
                409, "subject_full",
                f"Môn này đã đủ {cfg['storage.subject_files']} tệp. Hãy xoá hoặc gộp bớt tệp cũ trước khi tải thêm.",
                limit=cfg["storage.subject_files"],
            )
    used = sum(storage_bytes(db, user.id).values())
    free = max(0, cfg["storage.user_mb"] * MB - used)
    if size_bytes > free:
        raise _upload_error(
            413, "storage_full",
            f"Không đủ dung lượng để tải tệp này: còn trống {free / MB:.1f} MB, cần xoá bớt ít nhất "
            f"{(size_bytes - free) / MB:.1f} MB.",
            free_bytes=free, need_bytes=size_bytes - free, size_bytes=size_bytes,
        )


# --------------------------------------------------------------------------- nhắc vào chuông

def notify(db: Session, user_id: str, kind: str, ref_id: str, title: str, detail: str, key: str) -> bool:
    """Tạo 1 thông báo chỉ-trong-app, chống trùng bằng dedupe_key (như study_reminders._add)."""
    if db.scalar(select(Notification.id).where(Notification.user_id == user_id, Notification.dedupe_key == key[:100])):
        return False
    now = local_now()
    n = Notification(user_id=user_id, kind=kind, ref_id=ref_id[:36], title=title[:200], detail=(detail or "")[:255],
                     dedupe_key=key[:100], fire_at=now)
    n.deliveries.append(NotificationDelivery(channel="app", status="sent", attempts=1, sent_at=now))
    try:
        with db.begin_nested():
            db.add(n)
    except IntegrityError:
        return False
    return True


def _mb(n: float) -> str:
    return f"{n / MB:,.0f}".replace(",", ".")


def _avg_pdf_bytes(db: Session, user_id: str) -> float:
    avg = db.scalar(
        select(func.avg(PdfDocument.file_size_bytes)).join(Subject, Subject.id == PdfDocument.subject_id)
        .where(Subject.owner_id == user_id)
    )
    return float(avg or 5 * MB)


def storage_message(db: Session, user_id: str, u: dict) -> tuple[str, str]:
    cfg, used, limit = u["cfg"], u["used"], u["limit"]
    free = max(0, limit - used)
    if u["level"] == 3:
        return (f"Dung lượng đã đầy ({_mb(used)} / {cfg['storage.user_mb']} MB)",
                "Bạn chưa thể tải tệp mới — ghi chú, Flashcard, Quiz vẫn dùng bình thường.")
    if u["level"] == 2:
        return (f"Sắp đầy dung lượng: chỉ còn {free / MB:.1f} MB".replace(".", ","),
                "Tệp lớn hơn mức này sẽ không tải lên được.")
    n = max(1, math.floor(free / _avg_pdf_bytes(db, user_id)))
    return (f"Bạn đã dùng {_mb(used)} / {cfg['storage.user_mb']} MB ({round(u['storage_pct'])}%)",
            f"Còn khoảng {_mb(free)} MB — đủ cho {n} tệp PDF nữa.")


def refresh_level(db: Session, user_id: str) -> int:
    """Tính lại mức dung lượng; TĂNG bậc → 1 thông báo kind='quota' (+ nhắc riêng Môn có nhiều tệp). Không commit."""
    u = usage(db, user_id)
    cfg = u["cfg"]
    state = db.get(UserQuotaState, user_id)
    if state is None:
        state = UserQuotaState(user_id=user_id, storage_level=0)
        db.add(state)
    now = local_now()
    lv = u["level"]
    if lv > state.storage_level:
        if u["storage_pct"] >= cfg["warn.w1"]:
            title, detail = storage_message(db, user_id, {**u, "level": level_of(u["storage_pct"], 0, cfg)})
            notify(db, user_id, "quota", user_id, title, detail, f"q:{lv}:{now:%Y%m%d%H%M%S}")
        state.storage_level, state.level_kind, state.notified_at = lv, u["kind"], now
    elif lv < state.storage_level:
        state.storage_level = lv
        if lv == 0:
            state.level_kind = None
    # Nhắc số tệp theo từng Môn (≥ nhắc lần 1 / đã đủ), tối đa 1 lần/Môn/mức/ngày
    lim = cfg["storage.subject_files"]
    for sid, n in u["subject_counts"].items():
        slv = 3 if n >= lim else 1 if n * 100 >= lim * cfg["warn.w1"] else 0
        if not slv:
            continue
        subj = db.get(Subject, sid)
        name = subj.name if subj else "Môn học"
        detail = ("Không thể tải thêm vào môn này." if slv == 3
                  else "Có thể gộp các PDF nhỏ hoặc xoá bản cũ.")
        notify(db, user_id, "quota", sid, f"Môn {name} đã có {n} / {lim} tệp", detail, f"qs:{sid}:{slv}:{now:%Y%m%d}")
    return lv


def refresh_after_change(user_id: str) -> None:
    """Gọi sau khi tải lên / xoá tệp (Session riêng, an toàn để gọi cả trong BackgroundTasks)."""
    with SessionLocal() as db:
        refresh_level(db, user_id)
        db.commit()


def _warn_ai(db: Session, user_id: str, feature: str) -> None:
    if feature in PER_SESSION:
        return
    cfg = get_settings(db)
    limit = cfg[FEATURES[feature][0]]
    left = max(0, limit - uses_today(db, user_id)[feature])
    if 0 < left <= math.ceil(limit * cfg["warn.ai"] / 100):
        name = FEATURES[feature][1]
        notify(db, user_id, "quota_ai", feature, f"Còn {left} / {limit} lượt {name} hôm nay",
               "Lượt mới có lúc 00:00.", f"ai:{feature}:{local_now():%Y%m%d}")


def ai_near(db: Session, user_id: str) -> dict | None:
    """Tính năng có % dùng cao nhất hôm nay — admin "Lượt AI cao nhất"; near = còn ≤ ngưỡng nhắc lượt AI."""
    cfg = get_settings(db)
    uses = uses_today(db, user_id)
    best = None
    for f, (key, name, _) in FEATURES.items():
        if f in PER_SESSION:
            continue
        limit = cfg[key]
        p = uses[f] / limit * 100
        if best is None or p > best["pct"]:
            best = {"feature": f, "name": name, "used": uses[f], "limit": limit, "pct": p}
    best["near"] = best["used"] > 0 and best["pct"] >= 100 - cfg["warn.ai"]
    return best
