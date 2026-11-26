"""Lịch biểu — UC-26 Tạo lịch/deadline, UC-27 Xem thời gian biểu, UC-28 Xoá mục lịch (+ Sửa, theo giao diện
mẫu lich-bieu.html) và phần người dùng của UC-31 (chuông thông báo). Email nhận nhắc đặt ở Hồ sơ (routers/profile.py, UC-06). Xem
.claude/rules/09-schedule-stats.md, database/schedule_schema.sql. Frontend: frontend/js/ghichu_lichbieu.js.

- Giờ = ngày + phút trong ngày theo giờ địa phương; `remind_at` tính sẵn (services/schedule_notifier.py).
- Nhãn: gửi TÊN nhãn kèm sự kiện; trùng tên (không phân biệt hoa thường) thì dùng nhãn có sẵn và đổi màu nhãn
  theo màu vừa chọn ("một nhãn – một màu"). Nhãn không còn sự kiện nào tự bị xoá (cột Nhãn của mẫu chỉ liệt kê
  nhãn đang dùng).
- BR-05: mọi id phải thuộc người dùng -> 404. Môn/Chương (UC-26 1a) tuỳ chọn; Chương phải thuộc Môn -> 400.
- BR-11 / UC-26 E2: trùng giờ vẫn lưu, trả `conflicts` để giao diện cảnh báo.
- Lặp lại hằng tuần/tháng/năm (schedule_schema_v2.sql): 1 dòng = 1 chuỗi, `GET /items` trả DÒNG GỐC của chuỗi có
  xuất hiện trong khoảng xem, giao diện tự trải ra từng ngày. Sửa/xoá áp dụng cả chuỗi.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import (
    Chapter,
    Notification,
    NotificationDelivery,
    ScheduleItem,
    ScheduleLabel,
    Subject,
    User,
)
from app.schemas import (
    NotificationListOut,
    NotificationOut,
    ScheduleConflictOut,
    ScheduleItemIn,
    ScheduleItemOut,
    ScheduleItemSavedOut,
    ScheduleLabelOut,
    ScheduleLabelSavedOut,
    ScheduleLabelUpdate,
)
from app.services import mailer, schedule_notifier

router = APIRouter(prefix="/schedule", tags=["Lịch biểu (UC-26 → UC-28, UC-31)"])

_MAX_RANGE_DAYS = 62          # tháng xem rộng nhất = 6 tuần; chặn truy vấn khoảng vô hạn
_NOTIFICATION_LIMIT = 30


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_owned_item(db: Session, user: User, item_id: str) -> ScheduleItem:
    item = db.get(ScheduleItem, item_id)
    if item is None or item.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy sự kiện.")
    return item


def _label_key(name: str) -> str:
    return name.strip().lower()


def _find_label(db: Session, user: User, name: str) -> ScheduleLabel | None:
    return db.scalars(
        select(ScheduleLabel).where(
            ScheduleLabel.user_id == user.id, func.lower(func.trim(ScheduleLabel.name)) == _label_key(name)
        )
    ).first()


def _resolve_label(db: Session, user: User, name: str | None, color: str) -> ScheduleLabel | None:
    if not name:
        return None
    label = _find_label(db, user, name)
    if label is None:
        label = ScheduleLabel(user_id=user.id, name=name, color=color)
        db.add(label)
        db.flush()
    else:
        label.color = color          # một nhãn – một màu: màu vừa chọn áp dụng cho mọi sự kiện cùng nhãn
    return label


def _check_color_free(
    db: Session, user: User, color: str, keep_label_id: str | None = None, item_id: str | None = None
) -> None:
    """Mỗi nhãn một màu riêng: `color` không được trùng màu một nhãn KHÁC (`keep_label_id` = nhãn đang dùng màu này
    hợp lệ). Nhãn chỉ còn đúng sự kiện `item_id` đang sửa không tính — đổi nhãn/bỏ nhãn thì nó bị xoá khi lưu."""
    other_item = select(ScheduleItem.id).where(ScheduleItem.label_id == ScheduleLabel.id)
    if item_id:
        other_item = other_item.where(ScheduleItem.id != item_id)
    q = select(ScheduleLabel).where(
        ScheduleLabel.user_id == user.id, func.lower(ScheduleLabel.color) == color.lower(), other_item.exists()
    )
    if keep_label_id:
        q = q.where(ScheduleLabel.id != keep_label_id)
    owner = db.scalars(q).first()
    if owner is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Màu này đã dùng cho nhãn “{owner.name}”. Mỗi nhãn một màu riêng — chọn màu khác."
        )


def _check_subject(db: Session, user: User, subject_id: str | None, chapter_id: str | None) -> None:
    if subject_id:
        subject = db.get(Subject, subject_id)
        if subject is None or subject.owner_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy Môn học.")
    if chapter_id:
        chapter = db.get(Chapter, chapter_id)
        if chapter is None or chapter.subject_id != subject_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chương không thuộc Môn học đã chọn.")


def _drop_unused_labels(db: Session, user: User) -> None:
    used = select(ScheduleItem.label_id).where(ScheduleItem.user_id == user.id, ScheduleItem.label_id.is_not(None))
    db.execute(delete(ScheduleLabel).where(ScheduleLabel.user_id == user.id, ScheduleLabel.id.not_in(used)))


def _item_out(item: ScheduleItem) -> ScheduleItemOut:
    label = item.label
    return ScheduleItemOut(
        id=item.id,
        title=item.title,
        item_type=item.item_type,
        label_id=label.id if label else None,
        label=label.name if label else None,
        color=label.color if label else item.color,
        subject_id=item.subject_id,
        subject_name=item.subject.name if item.subject else None,
        chapter_id=item.chapter_id,
        chapter_name=item.chapter.name if item.chapter else None,
        date=item.item_date,
        start_minute=item.start_minute,
        end_minute=item.end_minute,
        repeat_rule=item.repeat_rule,
        repeat_until=item.repeat_until,
        remind_before=item.remind_before,
        via_app=item.via_app,
        via_email=item.via_email,
        via_push=item.via_push,
    )


def _labels_out(db: Session, user: User) -> list[ScheduleLabelOut]:
    rows = db.execute(
        select(ScheduleLabel, func.count(ScheduleItem.id))
        .outerjoin(ScheduleItem, ScheduleItem.label_id == ScheduleLabel.id)
        .where(ScheduleLabel.user_id == user.id)
        .group_by(ScheduleLabel.id)
        .order_by(ScheduleLabel.name)
    ).all()
    return [
        ScheduleLabelOut(id=l.id, name=l.name, color=l.color, is_hidden=l.is_hidden, item_count=n) for l, n in rows
    ]


def _conflicts(
    db: Session, user: User, day: date, start: int, end: int, item_type: str, exclude_id: str | None
) -> list[ScheduleConflictOut]:
    """BR-11: trùng khung giờ với sự kiện khác cùng ngày (kể cả 1 lần xuất hiện của sự kiện lặp). Deadline là 1
    mốc giờ nên không tính trùng (như mẫu). Sự kiện lặp đang tạo/sửa: chỉ kiểm ngày đầu tiên của chuỗi."""
    if item_type == "deadline":
        return []
    q = select(ScheduleItem).where(
        ScheduleItem.user_id == user.id,
        or_(ScheduleItem.item_date == day, and_(ScheduleItem.repeat_rule != "none", ScheduleItem.item_date < day)),
        ScheduleItem.item_type != "deadline",
        ScheduleItem.start_minute < end,
        ScheduleItem.end_minute > start,
    ).order_by(ScheduleItem.start_minute)
    if exclude_id:
        q = q.where(ScheduleItem.id != exclude_id)
    return [
        ScheduleConflictOut(id=i.id, title=i.title, start_minute=i.start_minute, end_minute=i.end_minute)
        for i in db.scalars(q).all()
        if schedule_notifier.occurs_on(i.item_date, i.repeat_rule, i.repeat_until, day)
    ]


def _apply(db: Session, user: User, item: ScheduleItem, data: ScheduleItemIn) -> None:
    _check_subject(db, user, data.subject_id, data.chapter_id)
    timing_changed = (
        item.item_date != data.date or item.start_minute != data.start_minute or item.remind_before != data.remind_before
        or item.repeat_rule != data.repeat_rule or item.repeat_until != data.repeat_until
    )
    existing = _find_label(db, user, data.label) if data.label else None
    _check_color_free(db, user, data.color, existing.id if existing else None, item.id)   # sự kiện không nhãn cũng không mượn màu nhãn
    label = _resolve_label(db, user, data.label, data.color)
    item.title = data.title
    item.item_type = data.item_type
    item.label_id = label.id if label else None
    item.color = data.color
    item.subject_id = data.subject_id
    item.chapter_id = data.chapter_id
    item.item_date = data.date
    item.start_minute = data.start_minute
    item.end_minute = data.end_minute
    item.repeat_rule = data.repeat_rule
    item.repeat_until = data.repeat_until
    item.via_app, item.via_email, item.via_push = data.via_app, data.via_email, data.via_push
    if timing_changed:   # sửa giờ/mức nhắc -> tính lại và cho phép nhắc lại theo giờ mới
        item.remind_before = data.remind_before
        item.remind_at, item.remind_sent = schedule_notifier.compute_next_remind(
            data.date, data.start_minute, data.remind_before, data.repeat_rule, data.repeat_until
        )


def _saved(db: Session, user: User, item: ScheduleItem) -> ScheduleItemSavedOut:
    db.refresh(item)
    return ScheduleItemSavedOut(
        item=_item_out(item),
        conflicts=_conflicts(db, user, item.item_date, item.start_minute, item.end_minute, item.item_type, item.id),
        labels=_labels_out(db, user),
    )


# ---------------------------------------------------------------------------
# UC-27 Xem thời gian biểu
# ---------------------------------------------------------------------------
@router.get("/items", response_model=list[ScheduleItemOut])
def list_items(
    start: date = Query(..., alias="from"),
    end: date = Query(..., alias="to"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mục lịch trong [from, to] (gồm cả 2 đầu) — khoảng Ngày/Tuần/Tháng do client tính. Sự kiện lặp: trả dòng gốc
    nếu chuỗi còn trong khoảng (bắt đầu trước `to`, chưa hết trước `from`) — client trải ra từng ngày."""
    if end < start or (end - start).days > _MAX_RANGE_DAYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Khoảng xem phải từ 1 đến {_MAX_RANGE_DAYS + 1} ngày.")
    items = db.scalars(
        select(ScheduleItem)
        .where(
            ScheduleItem.user_id == current_user.id,
            ScheduleItem.item_date <= end,
            or_(
                ScheduleItem.item_date >= start,
                and_(
                    ScheduleItem.repeat_rule != "none",
                    or_(ScheduleItem.repeat_until.is_(None), ScheduleItem.repeat_until >= start),
                ),
            ),
        )
        .order_by(ScheduleItem.item_date, ScheduleItem.start_minute)
    ).all()
    return [_item_out(i) for i in items]


@router.get("/conflicts", response_model=list[ScheduleConflictOut])
def check_conflicts(
    day: date = Query(..., alias="date"),
    start_minute: int = Query(..., ge=0, le=1439),
    end_minute: int = Query(..., ge=0, le=1440),
    item_type: str = "event",
    exclude_id: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Cảnh báo trùng giờ ngay trong form (BR-11), trước khi bấm Lưu."""
    return _conflicts(db, current_user, day, start_minute, end_minute, item_type, exclude_id)


# ---------------------------------------------------------------------------
# UC-26 Tạo / Sửa / UC-28 Xoá
# ---------------------------------------------------------------------------
@router.post("/items", response_model=ScheduleItemSavedOut, status_code=status.HTTP_201_CREATED)
def create_item(payload: ScheduleItemIn, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """UC-26. Cũng dùng cho "Hoàn tác" sau khi xoá (tạo lại từ dữ liệu cũ, id mới)."""
    item = ScheduleItem(user_id=current_user.id, item_date=payload.date, start_minute=-1, remind_before="none")
    _apply(db, current_user, item, payload)
    db.add(item)
    db.commit()
    return _saved(db, current_user, item)


@router.put("/items/{item_id}", response_model=ScheduleItemSavedOut)
def update_item(
    item_id: str, payload: ScheduleItemIn, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    item = _get_owned_item(db, current_user, item_id)
    _apply(db, current_user, item, payload)
    db.flush()
    _drop_unused_labels(db, current_user)
    db.commit()
    return _saved(db, current_user, item)


@router.delete("/items/{item_id}", response_model=ScheduleLabelSavedOut)
def delete_item(item_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """UC-28: xoá sự kiện + huỷ email nhắc đang chờ. Thông báo đã hiện ở chuông được giữ (FK SET NULL)."""
    item = _get_owned_item(db, current_user, item_id)
    schedule_notifier.cancel_pending_for_item(db, item.id)
    db.delete(item)
    db.flush()
    _drop_unused_labels(db, current_user)
    db.commit()
    return ScheduleLabelSavedOut(labels=_labels_out(db, current_user))


# ---------------------------------------------------------------------------
# Nhãn (cột trái của mẫu)
# ---------------------------------------------------------------------------
@router.get("/labels", response_model=list[ScheduleLabelOut])
def list_labels(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _labels_out(db, current_user)


@router.patch("/labels/{label_id}", response_model=ScheduleLabelSavedOut)
def update_label(
    label_id: str, payload: ScheduleLabelUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Đổi tên / màu / ẩn-hiện. Đổi sang tên trùng nhãn khác -> GỘP: sự kiện chuyển sang nhãn đích (lấy màu
    nhãn đích), nhãn cũ bị xoá, trạng thái ẩn đi theo nhãn cũ (như mẫu)."""
    label = db.get(ScheduleLabel, label_id)
    if label is None or label.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy nhãn.")
    merged_into = None
    if payload.name is not None:
        target = _find_label(db, current_user, payload.name)
        if target is not None and target.id != label.id:
            db.execute(update(ScheduleItem).where(ScheduleItem.label_id == label.id).values(label_id=target.id))
            if label.is_hidden:
                target.is_hidden = True
            db.delete(label)
            merged_into = target.id
        else:
            label.name = payload.name
    if merged_into is None:
        if payload.color is not None:
            _check_color_free(db, current_user, payload.color, label.id)
            label.color = payload.color
        if payload.is_hidden is not None:
            label.is_hidden = payload.is_hidden
    db.commit()
    return ScheduleLabelSavedOut(merged_into=merged_into, labels=_labels_out(db, current_user))


# ---------------------------------------------------------------------------
# UC-31 — chuông thông báo + email nhận nhắc
# ---------------------------------------------------------------------------
def _app_notifications(user: User):
    has_app = select(NotificationDelivery.id).where(
        NotificationDelivery.notification_id == Notification.id, NotificationDelivery.channel == "app"
    ).exists()
    return select(Notification).where(Notification.user_id == user.id, has_app)


@router.get("/notifications", response_model=NotificationListOut)
def list_notifications(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    schedule_notifier.run_due(db, current_user.id, send_emails=False)   # quét "lười": chỉ tạo thông báo
    q = _app_notifications(current_user)
    items = db.scalars(q.order_by(Notification.fire_at.desc(), Notification.id.desc()).limit(_NOTIFICATION_LIMIT)).all()
    unread = db.scalar(select(func.count()).select_from(q.where(Notification.is_read.is_(False)).subquery()))
    return NotificationListOut(
        items=[NotificationOut.model_validate(n, from_attributes=True) for n in items],
        unread_count=unread or 0,
        now=schedule_notifier.local_now(),
        effective_email=schedule_notifier.recipient_email(db, current_user.id),
        email_enabled=mailer.is_configured(),
    )


@router.post("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def read_notification(notification_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy thông báo.")
    n.is_read = True
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT)
def read_all_notifications(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.execute(update(Notification).where(Notification.user_id == current_user.id).values(is_read=True))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
