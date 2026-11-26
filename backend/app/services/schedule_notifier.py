"""UC-31 Nhận thông báo — actor Hệ thống/Scheduler (xem .claude/rules/09-schedule-stats.md).

Không có Celery/Redis nên "scheduler" là vòng lặp nền trong process uvicorn (`run_forever()`, đăng ký ở
lifespan của app/main.py, mỗi settings.SCHEDULER_INTERVAL_SECONDS). Ngoài ra `GET /schedule/notifications`
gọi `run_due(db, user_id, send_emails=False)` "lười" cho riêng người đang mở chuông — chuông vẫn đúng dù vòng nền
chưa tới lượt (email vẫn do vòng nền gửi, nên SCHEDULER_INTERVAL_SECONDS=0 = không gửi email).

Một lượt quét:
  1. Lấy các schedule_items có remind_sent=0 và remind_at <= bây giờ (giờ địa phương APP_TIMEZONE — tính
     bằng Python, KHÔNG dùng NOW() của MySQL vì container chạy UTC). Khoá dòng FOR UPDATE SKIP LOCKED để 2
     lượt quét chạy cùng lúc (vòng nền + chuông) không nhắc trùng.
  2. Sự kiện đã KẾT THÚC (máy chủ tắt quá lâu, vừa sửa lùi giờ…) thì chỉ đánh dấu đã nhắc, không tạo
     thông báo cũ vô nghĩa. Còn lại: tạo NOTIFICATION + 1 delivery/kênh đã bật (UNIQUE chống gửi trùng):
     app -> 'sent' ngay; email -> 'pending'; push -> 'skipped' (chưa có hạ tầng).
     Sự kiện LẶP LẠI: `remind_at` trỏ tới lần xuất hiện kế tiếp; nhắc xong tính lần sau (compute_next_remind)
     và đặt lại remind_sent=0, hết chuỗi thì giữ 1.
  3. Gửi các delivery email 'pending'/'failed' còn lượt (attempts < 3, UC-31 E1). Chưa cấu hình SMTP hoặc
     người dùng chưa có email -> 'skipped'.
"""
import asyncio
import html
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.models import Notification, NotificationDelivery, ScheduleItem, User, UserSettings
from app.services import mailer, study_reminders

log = logging.getLogger(__name__)

REMIND_MINUTES = {"m10": 10, "m30": 30, "h1": 60, "d1": 1440}
MAX_EMAIL_ATTEMPTS = 3
REMIND_TEXT = {"m10": "10 phút", "m30": "30 phút", "h1": "1 giờ", "d1": "1 ngày"}
TYPE_KIND = {"event": "Nhắc sự kiện", "class": "Nhắc buổi học", "deadline": "Nhắc deadline", "exam": "Nhắc lịch thi"}
_DOW = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"]
_BATCH = 200


def local_now() -> datetime:
    """Bây giờ theo APP_TIMEZONE, dạng naive (cùng kiểu với cột DATETIME giờ địa phương)."""
    return datetime.now(ZoneInfo(settings.APP_TIMEZONE)).replace(tzinfo=None, microsecond=0)


def at_minute(d: date, minute: int) -> datetime:
    return datetime(d.year, d.month, d.day) + timedelta(minutes=minute)


def compute_remind_at(d: date, start_minute: int, remind_before: str) -> datetime | None:
    if remind_before == "none":
        return None
    return at_minute(d, start_minute) - timedelta(minutes=REMIND_MINUTES[remind_before])


def initial_remind_sent(d: date, start_minute: int, remind_before: str) -> bool:
    """Sự kiện đã bắt đầu thì không nhắc nữa. Giờ nhắc đã qua nhưng chưa bắt đầu -> lượt quét kế tiếp nhắc ngay."""
    return remind_before == "none" or at_minute(d, start_minute) <= local_now()


# ---------------------------------------------------------------------------
# Sự kiện lặp lại (schedule_schema_v2.sql): 1 dòng = 1 chuỗi, `item_date` = lần đầu, `repeat_until` NULL = mãi.
# Hằng tháng: tháng không có ngày đó (31/30/29) thì bỏ qua; hằng năm: 29/2 chỉ năm nhuận. Quy tắc này phải
# khớp occursOn() ở frontend/js/ghichu_lichbieu.js.
# ---------------------------------------------------------------------------
def occurs_on(first: date, rule: str, until: date | None, d: date) -> bool:
    if d < first or (until is not None and d > until):
        return False
    if rule == "weekly":
        return (d - first).days % 7 == 0
    if rule == "monthly":
        return d.day == first.day
    if rule == "yearly":
        return d.day == first.day and d.month == first.month
    return d == first


def next_occurrence(first: date, rule: str, until: date | None, after: date) -> date | None:
    """Lần xuất hiện đầu tiên >= `after` (None nếu chuỗi đã hết)."""
    if after <= first:
        return first if until is None or first <= until else None
    found: date | None = None
    if rule == "weekly":
        found = after + timedelta(days=(-(after - first).days) % 7)
    elif rule == "monthly":
        y, m = after.year, after.month
        for _ in range(48):                                   # ngày 31 có thể cần bỏ qua vài tháng
            try:
                c = date(y, m, first.day)
            except ValueError:
                c = None
            if c is not None and c >= after:
                found = c
                break
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    elif rule == "yearly":
        for y in range(after.year, after.year + 9):           # 29/2: tối đa 8 năm tới năm nhuận kế
            try:
                c = date(y, first.month, first.day)
            except ValueError:
                continue
            if c >= after:
                found = c
                break
    if found is None or (until is not None and found > until):
        return None
    return found


def compute_next_remind(
    first: date, start_minute: int, remind_before: str, rule: str, until: date | None, now: datetime | None = None
) -> tuple[datetime | None, bool]:
    """(remind_at, remind_sent) cho lần xuất hiện đầu tiên CHƯA bắt đầu. Không lặp = như compute_remind_at +
    initial_remind_sent. Hết chuỗi -> giữ remind_at của lần đầu (CHECK cần khác NULL), remind_sent = True."""
    if rule == "none" or remind_before == "none":
        return compute_remind_at(first, start_minute, remind_before), initial_remind_sent(first, start_minute, remind_before)
    now = now or local_now()
    occ = next_occurrence(first, rule, until, now.date())
    if occ is not None and at_minute(occ, start_minute) <= now:     # hôm nay đã bắt đầu -> lần sau
        occ = next_occurrence(first, rule, until, occ + timedelta(days=1))
    if occ is None:
        return compute_remind_at(first, start_minute, remind_before), True
    return compute_remind_at(occ, start_minute, remind_before), False


def recipient_email(db: Session, user_id: str) -> str | None:
    """Email nhận nhắc: tài khoản Google -> Gmail đã đăng nhập; tài khoản SĐT -> email tự nhập ở Hồ sơ (UC-06)."""
    user = db.get(User, user_id)
    if user is None:
        return None
    if user.auth_provider == "google":
        return user.google_email
    s = db.get(UserSettings, user_id)
    return s.notify_email if s is not None else None


# ---------------------------------------------------------------------------
# 1-2. Tạo thông báo cho các sự kiện đến giờ nhắc
# ---------------------------------------------------------------------------
def _create_due_notifications(db: Session, now: datetime, user_id: str | None) -> int:
    q = (
        select(ScheduleItem)
        .where(ScheduleItem.remind_sent.is_(False), ScheduleItem.remind_at.is_not(None), ScheduleItem.remind_at <= now)
        .order_by(ScheduleItem.remind_at)
        .limit(_BATCH)
        .with_for_update(skip_locked=True)
    )
    if user_id is not None:
        q = q.where(ScheduleItem.user_id == user_id)
    created = 0
    for item in db.scalars(q).all():
        item.remind_sent = True
        # Ngày của lần xuất hiện đang nhắc (sự kiện lặp: remind_at trỏ tới lần kế tiếp, không phải item_date)
        if item.repeat_rule != "none":
            occ = (item.remind_at + timedelta(minutes=REMIND_MINUTES[item.remind_before])).date()
        else:
            occ = item.item_date
        if item.repeat_rule != "none":                 # xếp lần nhắc cho lần xuất hiện CHƯA bắt đầu kế tiếp
            # max(): máy chủ tắt lâu thì nhảy thẳng tới lần sắp tới, không nhắc bù từng lần đã qua
            item.remind_at, item.remind_sent = compute_next_remind(
                item.item_date, item.start_minute, item.remind_before, item.repeat_rule, item.repeat_until,
                now=max(now, at_minute(occ, item.start_minute)),
            )
        if at_minute(occ, item.end_minute) < now:
            continue                                   # sự kiện đã qua — không nhắc muộn
        n = Notification(
            user_id=item.user_id, schedule_item_id=item.id, item_type=item.item_type, title=item.title,
            item_date=occ, start_minute=item.start_minute, fire_at=now,
        )
        if item.via_app:
            n.deliveries.append(NotificationDelivery(channel="app", status="sent", attempts=1, sent_at=now))
        if item.via_email:
            n.deliveries.append(NotificationDelivery(channel="email", status="pending"))
        if item.via_push:
            n.deliveries.append(NotificationDelivery(channel="push", status="skipped", last_error="Chưa hỗ trợ thông báo đẩy."))
        if not n.deliveries:
            continue
        db.add(n)
        created += 1
    db.commit()
    return created


# ---------------------------------------------------------------------------
# 3. Gửi email (thử lại tối đa 3 lần)
# ---------------------------------------------------------------------------
def _hm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def _day_text(d: date) -> str:
    """"hôm nay" / "ngày mai" / "Thứ Sáu 16/10/2026" — so với ngày hiện tại theo APP_TIMEZONE."""
    diff = (d - local_now().date()).days
    if diff == 0:
        return "hôm nay"
    if diff == 1:
        return "ngày mai"
    return f"{_DOW[d.weekday()]} {d.day:02d}/{d.month:02d}/{d.year}"


def _email_content(db: Session, n: Notification) -> tuple[str, str, str]:
    """(tiêu đề, bản text, bản HTML) của 1 email nhắc. Lấy thêm Nhãn / Môn · Chương / giờ kết thúc / màu từ
    mục lịch nếu còn; không thì chỉ dùng snapshot trong notifications."""
    item = db.get(ScheduleItem, n.schedule_item_id) if n.schedule_item_id else None
    kind = TYPE_KIND.get(n.item_type, "Nhắc lịch")
    day = _day_text(n.item_date)
    start = _hm(n.start_minute)
    if n.item_type == "deadline":
        when = f"Hạn {start} {day}"
    else:
        when = f"{start}" + (f" – {_hm(item.end_minute)}" if item else "") + f" {day}"
    subject = f"[{kind}] {n.title} · {start} {day}"

    rows: list[tuple[str, str]] = [("Thời gian", when[0].upper() + when[1:])]
    color = "#2c4a8c"
    if item is not None:
        if item.label is not None:
            rows.append(("Nhãn", item.label.name))
        if item.subject is not None:
            rows.append(("Môn học", item.subject.name + (f" · {item.chapter.name}" if item.chapter is not None else "")))
        if item.remind_before in REMIND_TEXT:
            rows.append(("Nhắc trước", REMIND_TEXT[item.remind_before]))
        color = item.label.color if item.label is not None else item.color
    url = settings.APP_URL

    text_body = (
        f"{kind}\n\n{n.title}\n"
        + "".join(f"{k}: {v}\n" for k, v in rows)
        + f"\nMở Lịch biểu: {url}\n\n"
        "Bạn nhận email này vì đã bật nhắc qua Email cho sự kiện trên trong AI Studio Tri Thức.\n"
        "Không muốn nhận nữa: mở sự kiện > Sửa > bỏ chọn \"Email\" ở mục Gửi qua."
    )
    e = html.escape
    table = "".join(
        f'<tr><td style="padding:3px 16px 3px 0;color:#6b7280;white-space:nowrap;vertical-align:top">{e(k)}</td>'
        f'<td style="padding:3px 0;color:#111827">{e(v)}</td></tr>'
        for k, v in rows
    )
    html_body = (
        '<div style="background:#f3f6fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
        '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e9f2">'
        f'<div style="background:#1f5f99;color:#ffffff;padding:14px 22px;font-size:14px">{e(kind)}</div>'
        '<div style="padding:20px 22px 22px">'
        f'<div style="border-left:4px solid {e(color)};padding:2px 0 2px 12px;margin-bottom:14px">'
        f'<div style="font-size:19px;font-weight:bold;color:#111827">{e(n.title)}</div></div>'
        f'<table style="border-collapse:collapse;font-size:14px;margin-bottom:20px">{table}</table>'
        f'<a href="{e(url)}" style="display:inline-block;background:#1f5f99;color:#ffffff;text-decoration:none;'
        'padding:10px 20px;border-radius:20px;font-size:14px">Mở Lịch biểu</a>'
        '</div>'
        '<div style="border-top:1px solid #eef1f6;padding:12px 22px;color:#9ca3af;font-size:12px;line-height:1.5">'
        'Bạn nhận email này vì đã bật nhắc qua Email cho sự kiện trên trong AI Studio Tri Thức. '
        'Không muốn nhận nữa: mở sự kiện &rsaquo; Sửa &rsaquo; bỏ chọn “Email” ở mục Gửi qua.</div>'
        '</div></div>'
    )
    return subject, text_body, html_body


def _send_pending_emails(db: Session, user_id: str | None) -> int:
    """Khoá + gửi + commit TỪNG thư: commit nhả mọi khoá của transaction, nên nếu khoá cả lô rồi commit giữa
    chừng thì các thư chưa gửi của lô có thể bị lượt quét khác lấy -> gửi trùng. Thư lỗi trong lượt này không
    thử lại ngay (`done`) — đợi lượt quét sau."""
    sent, done = 0, set()
    for _ in range(_BATCH):
        q = (
            select(NotificationDelivery)
            .join(Notification, Notification.id == NotificationDelivery.notification_id)
            .where(
                NotificationDelivery.channel == "email",
                or_(NotificationDelivery.status == "pending", NotificationDelivery.status == "failed"),
                NotificationDelivery.attempts < MAX_EMAIL_ATTEMPTS,
            )
            .order_by(NotificationDelivery.id)
            .limit(1)
            .with_for_update(skip_locked=True, of=NotificationDelivery)
        )
        if user_id is not None:
            q = q.where(Notification.user_id == user_id)
        if done:
            q = q.where(NotificationDelivery.id.not_in(done))
        d = db.scalars(q).first()
        if d is None:
            break
        done.add(d.id)
        n = d.notification
        to = recipient_email(db, n.user_id)
        if not mailer.is_configured():
            d.status, d.last_error = "skipped", "Máy chủ chưa cấu hình SMTP."
        elif not to:
            d.status, d.last_error = "skipped", "Chưa có email nhận nhắc."
        else:
            d.recipient = to
            d.attempts += 1
            try:
                mailer.send_email(to, *_email_content(db, n))
                d.status, d.sent_at, d.last_error = "sent", local_now(), None
                sent += 1
            except Exception as exc:  # noqa: BLE001 — mọi lỗi SMTP/mạng đều thử lại ở lượt sau
                d.status, d.last_error = "failed", mailer.describe_error(exc)[:500]
                log.warning("Gửi email nhắc lịch thất bại (lần %s): %s", d.attempts, exc)
        db.commit()
    return sent


def run_due(db: Session, user_id: str | None = None, send_emails: bool = True) -> None:
    """1 lượt quét. Vòng nền: mọi người + gửi email. Quét "lười" khi mở chuông (user_id, send_emails=False):
    chỉ tạo thông báo — không bắt request chờ SMTP (tới 15 giây/thư), email để vòng nền gửi."""
    now = local_now()
    _create_due_notifications(db, now, user_id)
    study_reminders.create_study_reminders(db, now, user_id)   # nhắc ôn thẻ / bài làm dở (chỉ trong app)
    if send_emails:
        _send_pending_emails(db, user_id)


def cancel_pending_for_item(db: Session, item_id: str) -> None:
    """UC-28 bước 3: xoá sự kiện -> huỷ các email nhắc còn chờ/đang thử lại của sự kiện đó."""
    ids = select(Notification.id).where(Notification.schedule_item_id == item_id)
    for d in db.scalars(
        select(NotificationDelivery).where(
            NotificationDelivery.notification_id.in_(ids),
            or_(NotificationDelivery.status == "pending", NotificationDelivery.status == "failed"),
        )
    ).all():
        d.status = "cancelled"


_last_weekly_hour: datetime | None = None


def _run_weekly_snapshots(db: Session) -> None:
    """UC-29: chốt snapshot tuần vừa kết thúc (services/stats.py) — chạy cùng vòng nền này, tối đa 1 lần/giờ."""
    global _last_weekly_hour
    hour = local_now().replace(minute=0, second=0)
    if _last_weekly_hour == hour:
        return
    _last_weekly_hour = hour
    from app.services import accounts, stats   # import muộn: 2 module này import ngược schedule_notifier

    stats.run_weekly_for_all(db)
    accounts.purge_disabled(db)   # UC-32: tự xoá tài khoản vô hiệu hoá quá 30 ngày (cùng nhịp 1 lần/giờ)


def _run_once() -> None:
    db = SessionLocal()
    try:
        run_due(db)
        _run_weekly_snapshots(db)
        from app.services import quota   # tránh import vòng (quota import local_now từ module này)
        quota.expire_temporary(db)      # UC-33: hạn mức tạm thời hết hạn -> về số cố định + báo người học
    except Exception:  # noqa: BLE001 — vòng nền không được chết vì 1 lượt lỗi (vd. MySQL restart)
        db.rollback()
        log.exception("Lượt quét nhắc lịch lỗi")
    finally:
        db.close()


async def run_forever() -> None:
    interval = settings.SCHEDULER_INTERVAL_SECONDS
    while True:
        await asyncio.to_thread(_run_once)
        await asyncio.sleep(interval)
