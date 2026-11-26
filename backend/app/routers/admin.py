"""Admin Console — UC-32 → UC-37 (giao diện: frontend/html/admin.html, đặc tả: .claude/rules/10-admin.md).

Mọi route yêu cầu role='admin' (`require_admin`, BR-13). Mọi thao tác thay đổi dữ liệu ghi 1 dòng nhật ký
(services/audit.py, BR-18). Quản trị viên chỉ thấy số liệu tổng hợp, định danh luôn ĐÃ CHE (BR-16) — ngoại lệ
duy nhất: ảnh người học tự đính kèm góp ý (xem được, việc xem được ghi nhật ký). Trang Người dùng / Hạn mức chỉ
liệt kê tài khoản role='learner'; thao tác lên tài khoản admin bị chặn (BR-15).

  UC-32 Người dùng   GET  /admin/users · GET /admin/users/export.csv · GET /admin/users/{id}
                     PATCH /admin/users/{id}/status · POST /admin/users/{id}/force-reset · DELETE /admin/users/{id}
  UC-33 Hạn mức      GET/PUT /admin/quota · POST /admin/quota/preview · GET /admin/quota/accounts
                     GET /admin/quota/accounts/export.csv · POST /admin/quota/accounts/{id}/remind
  UC-36 Tệp          GET /admin/files · GET /admin/files/export.csv · GET /admin/files/{type}/{id}
                     POST /admin/files/pdf/{id}/reprocess · DELETE /admin/files/{type}/{id}
  UC-34 Nhật ký      GET /admin/logs · GET /admin/logs/export.csv
  UC-35 Góp ý        GET /admin/feedback · GET /admin/feedback/{id} · PATCH /admin/feedback/{id}
                     POST /admin/feedback/{id}/reply · GET /admin/feedback/{id}/image
  UC-37 Báo cáo      GET /admin/reports · GET /admin/reports/export.xlsx
  Chuông admin       GET /admin/alerts

Giờ: cột tự sinh của bảng cũ (users.created_at, login_audit_logs.created_at...) theo giờ DB = UTC → đổi bằng
stats.utc_to_local; bảng mới (ai_usage_events, admin_audit_logs, feedback, study_sessions) đã là giờ địa phương.
"""
import csv
import io
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_db, require_admin
from app.models import (
    AdminAuditLog,
    AiUsageEvent,
    ChatAttachment,
    Feedback,
    LoginAuditLog,
    Notification,
    PdfDocument,
    StudySession,
    Subject,
    User,
    UserQuotaState,
)
from app.schemas import (
    AdminDeleteUserRequest,
    AdminFeedbackPatch,
    AdminFeedbackReply,
    AdminFileDeleteRequest,
    AdminQuotaRequest,
    AdminStatusRequest,
)
from app.services import accounts, audit, embeddings, quota, stats
from app.services.audit import user_key
from app.services.schedule_notifier import local_now

router = APIRouter(prefix="/admin", tags=["Quản trị (UC-32 → UC-37)"], dependencies=[Depends(require_admin)])

MB = quota.MB
ST_NAME = {"active": "Hoạt động", "locked": "Bị khoá", "temp": "Khoá tạm", "disabled": "Vô hiệu hoá",
           "pending_verification": "Chưa xác thực"}


def _csv(name: str, rows: list[list]) -> StreamingResponse:
    buf = io.StringIO()
    buf.write("﻿")   # BOM để Excel đọc đúng tiếng Việt
    csv.writer(buf).writerows(rows)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _page(items: list, page: int, per: int) -> dict:
    pages = max(1, -(-len(items) // per))
    page = min(max(1, page), pages)
    return {"total": len(items), "page": page, "pages": pages, "items": items[(page - 1) * per: page * per]}


def _today_start() -> datetime:
    return local_now().replace(hour=0, minute=0, second=0, microsecond=0)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="minutes") if dt else None


# =========================================================================== số liệu gom theo người dùng

def _bulk_usage(db: Session, user_ids: list[str] | None = None) -> dict[str, dict]:
    """Mức dùng của nhiều người trong ít truy vấn: dung lượng theo loại, số tệp môn nhiều nhất, số môn,
    lượt AI hôm nay từng tính năng."""
    def scoped(stmt, col):
        return stmt.where(col.in_(user_ids)) if user_ids is not None else stmt

    out: dict[str, dict] = {}

    def row(uid):
        return out.setdefault(uid, {"pdf": 0, "chat": 0, "fb": 0, "subjects": 0, "fmax": 0, "fsub": None,
                                    "uses": {f: 0 for f in quota.FEATURES}})

    for uid, n in db.execute(scoped(select(Subject.owner_id, func.count()).group_by(Subject.owner_id), Subject.owner_id)):
        row(uid)["subjects"] = n
    for uid, sname, n, size in db.execute(scoped(
        select(Subject.owner_id, Subject.name, func.count(PdfDocument.id), func.coalesce(func.sum(PdfDocument.file_size_bytes), 0))
        .join(PdfDocument, PdfDocument.subject_id == Subject.id).group_by(Subject.id), Subject.owner_id)):
        r = row(uid)
        r["pdf"] += int(size)
        if n > r["fmax"]:
            r["fmax"], r["fsub"] = n, sname
    for uid, size in db.execute(scoped(
        select(ChatAttachment.user_id, func.sum(ChatAttachment.file_size_bytes))
        .where(ChatAttachment.kind == "file").group_by(ChatAttachment.user_id), ChatAttachment.user_id)):
        row(uid)["chat"] = int(size or 0)
    for uid, size in db.execute(scoped(
        select(Feedback.user_id, func.sum(Feedback.image_bytes)).where(Feedback.user_id.is_not(None))
        .group_by(Feedback.user_id), Feedback.user_id)):
        row(uid)["fb"] = int(size or 0)
    for uid, f, n in db.execute(scoped(
        select(AiUsageEvent.user_id, AiUsageEvent.feature, func.count())
        .where(AiUsageEvent.status == "ok", AiUsageEvent.created_at >= _today_start())
        .group_by(AiUsageEvent.user_id, AiUsageEvent.feature), AiUsageEvent.user_id)):
        row(uid)["uses"][f] = n
    return out


def _metrics(u: dict | None, cfg: dict) -> dict:
    u = u or {"pdf": 0, "chat": 0, "fb": 0, "subjects": 0, "fmax": 0, "fsub": None, "uses": {f: 0 for f in quota.FEATURES}}
    used = u["pdf"] + u["chat"] + u["fb"]
    limit = cfg["storage.user_mb"] * MB
    sp, fp = used / limit * 100, u["fmax"] / cfg["storage.subject_files"] * 100
    best = None
    for f, (key, name, _) in quota.FEATURES.items():
        if f in quota.PER_SESSION:   # Hỏi đáp: hạn mức theo cuộc hội thoại, không so với lượt trong ngày
            continue
        p = u["uses"][f] / cfg[key] * 100
        if best is None or p > best["pct"]:
            best = {"feature": f, "name": name, "used": u["uses"][f], "limit": cfg[key], "pct": p}
    best["near"] = best["used"] > 0 and best["pct"] >= 100 - cfg["warn.ai"]
    return {"used": used, "limit": limit, "sp": sp, "fp": fp, "fmax": u["fmax"], "fsub": u["fsub"],
            "subjects": u["subjects"], "ai_today": sum(u["uses"].values()), "uses": u["uses"], "ai": best,
            "level": quota.level_of(sp, fp, cfg)}


def _status(u: User) -> str:
    if u.status == "active" and u.locked_until and u.locked_until > datetime.utcnow():
        return "temp"
    return u.status


def _disabled_left(u: User) -> int | None:
    if u.status != "disabled" or not u.disabled_at:
        return None
    return max(0, accounts.DISABLED_KEEP_DAYS - (local_now() - u.disabled_at).days - 1)


def _user_row(u: User, m: dict) -> dict:
    return {
        "id": u.id, "name": u.display_name, "key": user_key(u), "login": "gg" if u.auth_provider == "google" else "sdt",
        "subjects": m["subjects"], "storage_used": m["used"], "storage_limit": m["limit"], "ai_today": m["ai_today"],
        "status": _status(u), "disabled_days_left": _disabled_left(u),
        "joined": _iso(stats.utc_to_local(u.created_at)),
    }


def _learners_filtered(db: Session, q: str, st: str):
    stmt = select(User).where(User.role == "learner")
    if st == "active":
        stmt = stmt.where(User.status == "active")
    elif st == "locked":
        stmt = stmt.where(or_(User.status == "locked", User.locked_until > datetime.utcnow()))
    elif st == "disabled":
        stmt = stmt.where(User.status == "disabled")
    q = (q or "").strip()
    if q:
        digits = _phone_digits(q)
        conds = [User.display_name.like(f"%{q}%"), User.google_email.like(f"%{q}%")]
        if len(digits) >= 3:
            conds.append(User.phone_number.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conds))
    return db.scalars(stmt.order_by(User.created_at.desc())).all()


def _phone_digits(q: str) -> str:
    """Chữ số để dò SĐT: '0912 345' -> '912345' (DB lưu +84912345678, bỏ số 0 đầu cho khớp)."""
    d = "".join(ch for ch in q if ch.isdigit())
    return d[1:] if d.startswith("0") else d


def _active_today(db: Session) -> int:
    start = _today_start()
    a = set(db.scalars(select(AiUsageEvent.user_id).where(AiUsageEvent.created_at >= start).distinct()))
    b = set(db.scalars(select(StudySession.user_id).where(StudySession.started_at >= start).distinct()))
    return len(a | b)


# =========================================================================== UC-32 Người dùng

@router.get("/users")
def list_users(q: str = "", status_: str = Query("all", alias="status"), page: int = 1, per: int = Query(6, le=50),
               db: Session = Depends(get_db)):
    """KPI + bảng người học. items: {id, name, key (đã che), login sdt|gg, subjects, storage_used, storage_limit,
    ai_today, status active|locked|temp|disabled|pending_verification, disabled_days_left, joined}."""
    cfg = quota.get_settings(db)
    learners = db.scalars(select(User).where(User.role == "learner")).all()
    now_utc = datetime.utcnow()
    ai_rows = db.execute(
        select(AiUsageEvent.feature, func.count()).where(AiUsageEvent.status == "ok", AiUsageEvent.created_at >= _today_start())
        .group_by(AiUsageEvent.feature)
    ).all()
    ai_total = sum(n for _, n in ai_rows)
    kpi = {
        "total": len(learners),
        "new_week": sum(1 for u in learners if u.created_at >= now_utc - timedelta(days=7)),
        "active_today": _active_today(db),
        "locked": sum(1 for u in learners if _status(u) in ("locked", "temp")),
        "disabled": sum(1 for u in learners if u.status == "disabled"),
        "ai_today": ai_total,
        "qa_share": round(dict(ai_rows).get("qa", 0) / ai_total * 100) if ai_total else 0,
    }
    rows = _learners_filtered(db, q, status_)
    paged = _page(rows, page, per)
    usage = _bulk_usage(db, [u.id for u in paged["items"]])
    paged["items"] = [_user_row(u, _metrics(usage.get(u.id), cfg)) for u in paged["items"]]
    return {"kpi": kpi, **paged}


@router.get("/users/export.csv")
def export_users(q: str = "", status_: str = Query("all", alias="status"), admin: User = Depends(require_admin),
                 db: Session = Depends(get_db)):
    cfg = quota.get_settings(db)
    rows = _learners_filtered(db, q, status_)
    usage = _bulk_usage(db, [u.id for u in rows])
    data = [["Tên", "Đăng nhập", "Định danh", "Môn", "Dung lượng (MB)", "AI hôm nay", "Trạng thái", "Tham gia"]]
    for u in rows:
        m = _metrics(usage.get(u.id), cfg)
        joined = stats.utc_to_local(u.created_at)
        data.append([u.display_name, "Google" if u.auth_provider == "google" else "SĐT", user_key(u), m["subjects"],
                     round(m["used"] / MB, 1), m["ai_today"], ST_NAME[_status(u)], joined.strftime("%d/%m/%Y")])
    audit.log(db, admin, "acc", "Xuất danh sách người dùng", f"{len(rows)} tài khoản", "Tệp CSV", "—", "Đã xuất")
    db.commit()
    return _csv("nguoi-dung.csv", data)


def _get_learner(db: Session, user_id: str) -> User:
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy người dùng.")
    if u.role == "admin":   # BR-15 + trang chỉ quản lý người học
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không thao tác trên tài khoản quản trị viên tại đây.")
    return u


@router.get("/users/{user_id}")
def user_detail(user_id: str, db: Session = Depends(get_db)):
    """Bảng chi tiết (drawer): chỉ số liệu tổng hợp — không nội dung ghi chú/tài liệu (BR-16)."""
    u = _get_learner(db, user_id)
    cfg = quota.get_settings(db)
    m = _metrics(_bulk_usage(db, [u.id]).get(u.id), cfg)
    last = db.scalar(select(func.max(LoginAuditLog.created_at)).where(LoginAuditLog.user_id == u.id, LoginAuditLog.success.is_(True)))
    state = db.get(UserQuotaState, u.id)
    return {
        **_user_row(u, m),
        "since": _iso(u.disabled_at if u.status == "disabled" else stats.utc_to_local(u.updated_at) if u.status == "locked" else None),
        "locked_until": _iso(stats.utc_to_local(u.locked_until)) if _status(u) == "temp" else None,
        "last_login": _iso(stats.utc_to_local(last)),
        "storage_pct": round(m["sp"]),
        "reminded_level": state.storage_level if state else 0,
        "ai": [{"feature": f, "name": name, "used": m["uses"][f], "limit": cfg[key], "per_session": f in quota.PER_SESSION}
               for f, (key, name, _) in quota.FEATURES.items()],
    }


@router.patch("/users/{user_id}/status")
def set_user_status(user_id: str, payload: AdminStatusRequest, admin: User = Depends(require_admin),
                    db: Session = Depends(get_db)):
    """lock / unlock / disable / restore. Khoá & vô hiệu hoá thu hồi mọi phiên ngay (UC-32 E2)."""
    u = _get_learner(db, user_id)
    prev = _status(u)
    revoked = 0
    if payload.action == "lock":
        u.status = "locked"
        revoked = accounts.revoke_sessions(db, u.id)
        act, to = "Khoá tài khoản", "locked"
    elif payload.action == "disable":
        u.status, u.disabled_at = "disabled", local_now()
        revoked = accounts.revoke_sessions(db, u.id)
        act, to = "Vô hiệu hoá tài khoản", "disabled"
    elif payload.action == "restore":
        if u.status != "disabled":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản không ở trạng thái vô hiệu hoá.")
        u.status, u.disabled_at = "active", None
        act, to = "Khôi phục tài khoản", "active"
    else:   # unlock — gồm cả mở sớm "Khoá tạm · sai mật khẩu"
        if u.status == "disabled":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản đang vô hiệu hoá — dùng Khôi phục.")
        u.status, u.locked_until, u.failed_login_attempts = "active", None, 0
        act, to = "Mở khoá tài khoản", "active"
    if payload.undo:
        act = "Hoàn tác: " + act[0].lower() + act[1:]
    audit.log(db, admin, "acc", act, u.display_name, user_key(u), ST_NAME[prev], ST_NAME[to],
              negative=to != "active")
    db.commit()
    return {"status": _status(u), "revoked": revoked, "disabled_days_left": _disabled_left(u)}


@router.post("/users/{user_id}/force-reset")
def force_reset(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = _get_learner(db, user_id)
    if u.auth_provider != "local":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản Google: mật khẩu do Google quản lý nên không thể buộc đặt lại.")
    if u.status == "disabled":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản đang vô hiệu hoá.")
    u.must_reset_password = True
    n = accounts.revoke_sessions(db, u.id)
    audit.log(db, admin, "acc", "Buộc đặt lại mật khẩu", u.display_name, user_key(u), "—", f"Thu hồi {n} phiên")
    db.commit()
    return {"revoked": n}


@router.delete("/users/{user_id}")
def delete_user(user_id: str, payload: AdminDeleteUserRequest, admin: User = Depends(require_admin),
                db: Session = Depends(get_db)):
    u = _get_learner(db, user_id)
    if u.auth_provider == "google":
        ok = payload.confirm.strip().lower() == (u.google_email or "").lower()
    else:
        ok = audit.local_phone(payload.confirm) == audit.local_phone(u.phone_number)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Gmail không khớp với tài khoản này." if u.auth_provider == "google" else "SĐT không khớp với tài khoản này.")
    name, key, prev = u.display_name, user_key(u), ST_NAME[_status(u)]
    info = accounts.delete_user(db, u)
    audit.log(db, admin, "acc", "Xoá vĩnh viễn tài khoản", "Người dùng đã xoá", "Ảnh chụp: " + key, prev, "Đã xoá",
              negative=True)
    db.commit()
    return {"deleted": name, "files": info["files"]}


# =========================================================================== UC-33 Hạn mức

@router.get("/quota")
def get_quota(db: Session = Depends(get_db)):
    """Cấu hình chung + lượt hôm nay / số người chạm hạn mức từng tính năng."""
    cfg = quota.get_settings(db)
    start = _today_start()
    used = dict(db.execute(select(AiUsageEvent.feature, func.count()).where(
        AiUsageEvent.status == "ok", AiUsageEvent.created_at >= start).group_by(AiUsageEvent.feature)).all())
    hit = dict(db.execute(select(AiUsageEvent.feature, func.count(AiUsageEvent.user_id.distinct())).where(
        AiUsageEvent.status == "limited", AiUsageEvent.created_at >= start).group_by(AiUsageEvent.feature)).all())
    fb_today = db.scalar(select(func.count()).select_from(Feedback).where(Feedback.created_at >= start)) or 0
    features = [{"key": key, "feature": f, "name": name, "value": cfg[key], "cap": cap, "used_today": used.get(f, 0),
                 "hit_today": hit.get(f, 0), "per_session": f in quota.PER_SESSION}
                for f, (key, name, cap) in quota.FEATURES.items()]
    features.append({"key": quota.FEEDBACK[0], "feature": "feedback", "name": quota.FEEDBACK[1] + " (BR-19)",
                     "value": cfg["feedback"], "cap": quota.FEEDBACK[2], "used_today": fb_today, "hit_today": 0})
    notes = {"storage.file_mb": "Áp dụng cho PDF và ảnh", "storage.subject_files": "Không tính ảnh đính kèm chat"}
    usage = _bulk_usage(db)
    over = sum(1 for m in (_metrics(x, cfg) for x in usage.values()) if m["sp"] >= cfg["warn.w1"])
    return {
        "features": features,
        "storage": [{"key": k, "name": n, "unit": unit, "value": cfg[k], "cap": cap, "note": notes.get(k)}
                    for k, (n, unit, cap) in quota.STORAGE.items()],
        "warn": {"w1": cfg["warn.w1"], "w2": cfg["warn.w2"], "ai": cfg["warn.ai"]},
        "users_over_w1": over,
        # hạn mức đang tạm thời: {key: {base, expires_at}} — hiện nhãn "Tạm thời tới … · sau đó về …" ở từng ô
        "temporary": {k: {"base": t["base"], "expires_at": _iso(t["expires_at"])} for k, t in quota.temporary(db).items()},
    }


def _merged(db: Session, values: dict[str, int]) -> dict[str, int]:
    cfg = quota.get_settings(db)
    unknown = set(values) - set(quota.DEFAULTS)
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Khoá hạn mức không hợp lệ: " + ", ".join(sorted(unknown)))
    cfg.update(values)
    return cfg


def _newly_full(db: Session, new_cfg: dict) -> int:
    cur = quota.get_settings(db)
    n = 0
    learners = set(db.scalars(select(User.id).where(User.role == "learner")))
    for uid, u in _bulk_usage(db).items():
        if uid in learners and _metrics(u, new_cfg)["level"] == 3 and _metrics(u, cur)["level"] < 3:
            n += 1
    return n


@router.post("/quota/preview")
def preview_quota(payload: AdminQuotaRequest, db: Session = Depends(get_db)):
    """Số tài khoản sẽ vượt hạn mức nếu lưu (hộp "N tài khoản sẽ vượt hạn mức mới")."""
    return {"newly_full": _newly_full(db, _merged(db, payload.values))}


@router.put("/quota")
def save_quota(payload: AdminQuotaRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Lưu hạn mức: bắt buộc LÝ DO (gửi thông báo tới mọi người học, kind quota_change); `until` = tạm thời tới lúc đó,
    hết hạn vòng nền tự trả về số cố định (quota.expire_temporary). Đang tạm thời mà sửa tạm thời tiếp -> vẫn về đúng số
    cố định ban đầu; sửa cố định -> bỏ hạn."""
    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nhập lý do thay đổi (ít nhất 5 ký tự) — lý do được gửi tới người học.")
    now = local_now()
    until = payload.until.replace(tzinfo=None, second=0, microsecond=0) if payload.until else None
    if until is not None and not (now + timedelta(minutes=5) <= until <= now + timedelta(days=90)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Thời điểm trở về mức cố định phải sau ít nhất 5 phút và trong vòng 90 ngày.")
    new_cfg = _merged(db, payload.values)
    err = quota.validate_settings(new_cfg)
    if err:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, err)
    from app.models import QuotaChangeEvent, QuotaSetting

    cur = quota.get_settings(db)
    changed = [(k, v) for k, v in payload.values.items() if v != cur[k]]
    if not changed:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không có thay đổi nào để lưu.")
    event = QuotaChangeEvent(kind="change", admin_id=admin.id, admin_label=admin.display_name[:100], reason=reason,
                             changes=[], expires_at=until, created_at=now)
    db.add(event)
    db.flush()
    changes = []
    tail = f" (tạm thời tới {until:%H:%M %d/%m})" if until else ""
    for key, value in changed:
        name, unit = quota.setting_label(key)
        row = db.get(QuotaSetting, key) or QuotaSetting(setting_key=key, value=cur[key])
        active_temp = row.expires_at is not None and row.expires_at > now
        if until:
            row.base_value = row.base_value if active_temp else cur[key]
            row.expires_at, row.change_id = until, event.id
        else:
            row.base_value = row.expires_at = row.change_id = None
        row.value, row.updated_by = value, admin.id
        db.add(row)
        changes.append({"key": key, "name": name, "unit": unit, "from": cur[key], "to": value})
        fmt_v = (lambda v: f"{v}%") if unit == "%" else (lambda v: f"{v:,} {unit}".replace(",", "."))
        category = ("Sửa ngưỡng nhắc", "Cảnh báo sớm") if key.startswith("warn.") else                    ("Sửa hạn mức", "Dung lượng & tệp") if key in quota.STORAGE else ("Sửa hạn mức", "Hạn mức chung")
        audit.log(db, admin, "quota", category[0], category[1], name, fmt_v(cur[key]), fmt_v(value) + tail)
    event.changes = changes
    audit.log(db, admin, "quota", "Thông báo đổi hạn mức", "Mọi người học", "Lý do: " + reason, "—",
              f"Tạm thời tới {until:%H:%M %d/%m/%Y}" if until else "Cố định")
    db.flush()
    notified = quota.announce(db, event)
    db.commit()
    quota.invalidate()
    reminded = 0
    # hạn mức mới -> tính lại mức của mọi người học, tự nhắc ai vừa chạm ngưỡng
    before = dict(db.execute(select(UserQuotaState.user_id, UserQuotaState.storage_level)).all())
    for uid in db.scalars(select(User.id).where(User.role == "learner")):
        if quota.refresh_level(db, uid) > before.get(uid, 0):
            reminded += 1
    db.commit()
    return {"changed": len(changed), "reminded": reminded, "notified": notified}


def _reminder_info(db: Session, uid: str, state: UserQuotaState | None, m: dict) -> dict | None:
    if state and state.storage_level:
        return {"level": state.storage_level, "kind": state.level_kind, "at": _iso(state.notified_at)}
    if m["ai"]["near"]:
        at = db.scalar(select(func.max(Notification.fire_at)).where(
            Notification.user_id == uid, Notification.kind == "quota_ai", Notification.fire_at >= _today_start()))
        return {"level": 0, "kind": "ai", "at": _iso(at)}
    return None


def _accounts(db: Session, q: str, flt: str) -> tuple[list[dict], dict]:
    cfg = quota.get_settings(db)
    users = {u.id: u for u in db.scalars(select(User).where(User.role == "learner"))}
    states = {s.user_id: s for s in db.scalars(select(UserQuotaState))}
    rows, counts = [], {"all": 0, "mb": 0, "file": 0, "ai": 0, "full": 0}
    qn = (q or "").strip().lower()
    digits = _phone_digits(qn)
    for uid, raw in _bulk_usage(db).items():
        u = users.get(uid)
        if u is None:
            continue
        m = _metrics(raw, cfg)
        if not m["level"] and not m["ai"]["near"]:
            continue
        flags = {"mb": m["sp"] >= cfg["warn.w1"], "file": m["fp"] >= cfg["warn.w1"], "ai": m["ai"]["near"],
                 "full": m["level"] == 3}
        counts["all"] += 1
        for k, v in flags.items():
            counts[k] += int(v)
        if flt != "all" and not flags[flt]:
            continue
        if qn and not (qn in u.display_name.lower() or qn in (u.google_email or "").lower()
                       or (len(digits) >= 3 and digits in (u.phone_number or ""))):
            continue
        rows.append({
            "id": uid, "name": u.display_name, "key": user_key(u),
            "storage_used": m["used"], "storage_limit": m["limit"], "storage_pct": round(m["sp"], 1),
            "fmax": m["fmax"], "fsub": m["fsub"], "file_limit": cfg["storage.subject_files"], "file_pct": round(m["fp"], 1),
            "ai": m["ai"], "reminder": _reminder_info(db, uid, states.get(uid), m),
            "_sort": max(m["sp"], m["fp"], m["ai"]["pct"] * 0.9 if m["ai"]["near"] else 0),
        })
    rows.sort(key=lambda r: r["_sort"], reverse=True)
    for r in rows:
        r.pop("_sort")
    return rows, counts


@router.get("/quota/accounts")
def quota_accounts(q: str = "", filter: str = Query("all", pattern="^(all|mb|file|ai|full)$"), page: int = 1,
                   per: int = Query(7, le=50), db: Session = Depends(get_db)):
    """Tab "Theo tài khoản": người đã vượt nhắc lần 1 hoặc sắp hết lượt AI, gần chạm nhất lên đầu."""
    rows, counts = _accounts(db, q, filter)
    cfg = quota.get_settings(db)
    return {"counts": counts, "warn": {"w1": cfg["warn.w1"], "w2": cfg["warn.w2"]}, **_page(rows, page, per)}


@router.get("/quota/accounts/export.csv")
def export_quota_accounts(q: str = "", filter: str = Query("all", pattern="^(all|mb|file|ai|full)$"),
                          db: Session = Depends(get_db)):
    rows, _ = _accounts(db, q, filter)
    data = [["Tên", "Định danh", "Dung lượng (MB)", "% dung lượng", "Tệp nhiều nhất / môn", "Môn", "Lượt AI cao nhất", "Đã nhắc"]]
    for r in rows:
        rem = r["reminder"]
        data.append([r["name"], r["key"], round(r["storage_used"] / MB, 1), round(r["storage_pct"]), r["fmax"], r["fsub"] or "",
                     f'{r["ai"]["used"]}/{r["ai"]["limit"]} {r["ai"]["name"]}',
                     (f'Lần {rem["level"]} · {rem["at"] or ""}' if rem and rem["level"] else "Nhắc lượt AI" if rem else "")])
    return _csv("muc-su-dung.csv", data)


@router.post("/quota/accounts/{user_id}/remind")
def resend_reminder(user_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    u = _get_learner(db, user_id)
    m = quota.usage(db, u.id)
    if not m["level"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tài khoản này chưa chạm ngưỡng nhắc dung lượng.")
    now = local_now()
    if m["kind"] == "file" and m["max_subject_id"]:
        subj = db.get(Subject, m["max_subject_id"])
        title = f"Môn {subj.name if subj else ''} đã có {m['max_subject_files']} / {m['cfg']['storage.subject_files']} tệp"
        detail, ref, sub = "Có thể gộp các PDF nhỏ hoặc xoá bản cũ.", m["max_subject_id"], \
            f"Tệp {m['max_subject_files']} / {m['cfg']['storage.subject_files']} · {subj.name if subj else ''}"
    else:
        title, detail = quota.storage_message(db, u.id, m)
        ref, sub = u.id, f"Dung lượng {m['used'] // MB} / {m['cfg']['storage.user_mb']} MB"
    quota.notify(db, u.id, "quota", ref, title, detail, f"qr:{now:%Y%m%d%H%M%S}")
    state = db.get(UserQuotaState, u.id) or UserQuotaState(user_id=u.id, storage_level=m["level"], level_kind=m["kind"])
    state.notified_at = now
    db.add(state)
    audit.log(db, admin, "quota", "Gửi lại nhắc dung lượng", u.display_name, sub, "—", "Đã gửi")
    db.commit()
    return {"at": _iso(now)}


# =========================================================================== UC-36 File & Storage

_PDF_ST = {"ready": "ok", "ocr_error": "ocr", "processing": "proc", "empty": "empty"}
_ST_LABEL = {"ok": "Đã lập chỉ mục", "ocr": "Lỗi OCR", "proc": "Đang xử lý", "empty": "Tệp trống", "none": "Không cần xử lý"}
_TYPE_LABEL = {"pdf": "PDF", "chat": "Đính kèm chat", "fbimg": "Ảnh góp ý"}


def _all_files(db: Session) -> list[dict]:
    # Tên hiển thị có thể TRÙNG giữa nhiều người -> mỗi tệp kèm định danh đã che (owner_key) + lọc chính xác theo owner_id;
    # tìm kiếm khớp cả tên, Gmail, SĐT (_owner_match) như trang Người dùng.
    users = {u.id: u for u in db.scalars(select(User))}
    names = {uid: u.display_name for uid, u in users.items()}
    out = []
    for d, sname, owner in db.execute(
        select(PdfDocument, Subject.name, Subject.owner_id).join(Subject, Subject.id == PdfDocument.subject_id)
    ):
        out.append({"type": "pdf", "id": d.id, "name": d.original_name, "subject": sname, "owner_id": owner,
                    "owner": names.get(owner, "—"), "size_bytes": d.file_size_bytes, "pages": d.page_count,
                    "created_at": stats.utc_to_local(d.created_at), "status": _PDF_ST[d.process_status]})
    for c in db.scalars(select(ChatAttachment).where(ChatAttachment.kind == "file")):
        out.append({"type": "chat", "id": c.id, "name": c.original_name or c.label, "subject": None, "owner_id": c.user_id,
                    "owner": names.get(c.user_id, "—"), "size_bytes": c.file_size_bytes or 0, "pages": None,
                    "created_at": stats.utc_to_local(c.created_at), "status": "none"})
    for f in db.scalars(select(Feedback).where(Feedback.image_path.is_not(None))):
        out.append({"type": "fbimg", "id": str(f.id), "name": f.image_name or "anh-gop-y", "subject": None,
                    "owner_id": f.user_id, "owner": names.get(f.user_id, "Người dùng đã xoá"),
                    "size_bytes": f.image_bytes or 0, "pages": None, "created_at": f.created_at, "status": "none"})
    for f in out:
        u = users.get(f["owner_id"])
        f["owner_key"] = user_key(u) if u else None
        f["_mail"] = (u.google_email or "").lower() if u else ""
        f["_phone"] = (u.phone_number or "") if u else ""
    out.sort(key=lambda x: x["created_at"] or datetime.min, reverse=True)
    return out


def _owner_match(f: dict, qn: str, digits: str) -> bool:
    return (qn in (f["owner"] or "").lower() or (qn and qn in f["_mail"])
            or (len(digits) >= 3 and digits in f["_phone"]))


def _filter_files(files: list[dict], q: str, t: str, owner: str = "") -> list[dict]:
    qn = (q or "").strip().lower()
    digits = _phone_digits(qn)
    if owner:
        files = [f for f in files if f["owner_id"] == owner]
    if t in ("pdf", "chat", "fbimg"):
        files = [f for f in files if f["type"] == t]
    elif t == "err":
        files = [f for f in files if f["status"] in ("ocr", "empty")]
    if qn:
        files = [f for f in files if qn in f["name"].lower() or _owner_match(f, qn, digits)]
    return files


def _file_out(f: dict) -> dict:
    return {**{k: v for k, v in f.items() if k not in ("_mail", "_phone")}, "created_at": _iso(f["created_at"]),
            "status_label": _ST_LABEL[f["status"]], "type_label": _TYPE_LABEL[f["type"]]}


@router.get("/files")
def list_files(q: str = "", type: str = Query("all", pattern="^(all|pdf|chat|fbimg|err)$"), owner: str = "", page: int = 1,
               per: int = Query(6, le=50), db: Session = Depends(get_db)):
    files = _all_files(db)
    n = len(files) or 1
    try:
        disk = shutil.disk_usage(Path(settings.PDF_UPLOAD_DIR).resolve().anchor or ".").total
    except OSError:
        disk = None
    cfg = quota.get_settings(db)
    near = sum(1 for x in _bulk_usage(db).values() if _metrics(x, cfg)["sp"] >= cfg["warn.w1"])
    kpi = {
        "total_bytes": sum(f["size_bytes"] for f in files), "disk_bytes": disk, "count": len(files),
        "pct": {t: round(sum(1 for f in files if f["type"] == t) / n * 100) for t in ("pdf", "chat", "fbimg")},
        "errors": sum(1 for f in files if f["status"] in ("ocr", "empty")), "near": near, "w1": cfg["warn.w1"],
    }
    paged = _page(_filter_files(files, q, type, owner), page, per)
    paged["items"] = [_file_out(f) for f in paged["items"]]
    return {"kpi": kpi, **paged}


@router.get("/files/export.csv")
def export_files(q: str = "", type: str = Query("all", pattern="^(all|pdf|chat|fbimg|err)$"), owner: str = "",
                 db: Session = Depends(get_db)):
    data = [["Tệp", "Loại", "Môn", "Chủ sở hữu", "Định danh", "Dung lượng (MB)", "Ngày tải", "Trạng thái"]]
    for f in _filter_files(_all_files(db), q, type, owner):
        data.append([f["name"], _TYPE_LABEL[f["type"]], f["subject"] or "", f["owner"], f["owner_key"] or "", round(f["size_bytes"] / MB, 1),
                     f["created_at"].strftime("%d/%m/%Y") if f["created_at"] else "", _ST_LABEL[f["status"]]])
    return _csv("tep-luu-tru.csv", data)


def _find_file(db: Session, ftype: str, fid: str):
    if ftype == "pdf":
        obj = db.get(PdfDocument, fid)
    elif ftype == "chat":
        obj = db.get(ChatAttachment, fid)
        obj = obj if obj and obj.kind == "file" else None
    elif ftype == "fbimg" and fid.isdigit():
        obj = db.get(Feedback, int(fid))
        obj = obj if obj and obj.image_path else None
    else:
        obj = None
    if obj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tệp.")
    return obj


@router.get("/files/{ftype}/{fid}")
def file_info(ftype: str, fid: str, db: Session = Depends(get_db)):
    """Thông tin tệp — không có nội dung (BR-16)."""
    _find_file(db, ftype, fid)
    f = next(x for x in _all_files(db) if x["type"] == ftype and x["id"] == fid)
    return _file_out(f)


@router.post("/files/pdf/{fid}/reprocess")
def reprocess_pdf(fid: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Chạy lại trích văn bản (OCR) + embedding — đồng bộ, có thể mất vài chục giây với PDF scan."""
    doc = _find_file(db, "pdf", fid)
    if doc.process_status not in ("ocr_error", "empty"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chỉ xử lý lại tệp đang lỗi OCR hoặc trống.")
    before = _ST_LABEL[_PDF_ST[doc.process_status]]
    owner = db.get(User, doc.subject.owner_id)
    with embeddings._lock_for(f"pdf:{doc.id}"):
        embeddings.reembed_pdf(db, doc)
    db.refresh(doc)
    after = _ST_LABEL[_PDF_ST[doc.process_status]]
    audit.log(db, admin, "file", "Xử lý lại tệp", doc.original_name,
              "Chủ sở hữu: " + (f"{owner.display_name} · {user_key(owner)}" if owner else "—"), before,
              after if doc.process_status != "empty" else "Vẫn trống", negative=doc.process_status != "ready")
    db.commit()
    return {"status": _PDF_ST[doc.process_status], "status_label": after}


@router.delete("/files/{ftype}/{fid}")
def delete_file(ftype: str, fid: str, payload: AdminFileDeleteRequest, admin: User = Depends(require_admin),
                db: Session = Depends(get_db)):
    """Xoá tệp khỏi ổ đĩa và báo chủ sở hữu (thông báo kind='file_removed', detail = lý do)."""
    obj = _find_file(db, ftype, fid)
    if ftype == "pdf":
        name, owner_id, size, path = obj.original_name, obj.subject.owner_id, obj.file_size_bytes, obj.file_path
        db.delete(obj)
    elif ftype == "chat":
        name, owner_id, size, path = obj.original_name or obj.label, obj.user_id, obj.file_size_bytes or 0, obj.file_path
        db.delete(obj)
    else:
        name, owner_id, size, path = obj.image_name or "anh-gop-y", obj.user_id, obj.image_bytes or 0, obj.image_path
        obj.image_path = obj.image_name = obj.image_bytes = None
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass
    owner = db.get(User, owner_id) if owner_id else None
    if owner:
        quota.notify(db, owner.id, "file_removed", fid, f"Quản trị viên đã xoá tệp “{name}”",
                     f"Lý do: {payload.reason}", f"fr:{ftype}:{fid}")
    db.flush()
    if owner:
        quota.refresh_level(db, owner.id)
    audit.log(db, admin, "file", "Xoá tệp", name, "Chủ sở hữu: " + (f"{owner.display_name} · {user_key(owner)}" if owner else "—"),
              f"{size / MB:.1f} MB".replace(".", ","), "Đã xoá", negative=True)
    db.commit()
    return {"deleted": name, "owner": owner.display_name if owner else None}


# =========================================================================== UC-34 Nhật ký

def _logs(db: Session, q: str, cat: str, days: int) -> list[AdminAuditLog]:
    stmt = select(AdminAuditLog)
    if cat != "all":
        stmt = stmt.where(AdminAuditLog.category == cat)
    if days:
        stmt = stmt.where(AdminAuditLog.created_at >= _today_start() - timedelta(days=days - 1))
    q = (q or "").strip()
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(AdminAuditLog.object_label.like(like), AdminAuditLog.object_sub.like(like),
                              AdminAuditLog.admin_label.like(like), AdminAuditLog.action.like(like)))
    return db.scalars(stmt.order_by(AdminAuditLog.created_at.desc(), AdminAuditLog.id.desc())).all()


def _log_out(r: AdminAuditLog) -> dict:
    return {"id": r.id, "at": _iso(r.created_at), "by": r.admin_label, "category": r.category, "action": r.action,
            "object": r.object_label, "sub": r.object_sub or "", "from": r.from_value, "to": r.to_value, "bad": r.is_negative}


@router.get("/logs")
def list_logs(q: str = "", cat: str = Query("all", pattern="^(all|acc|quota|file|fb)$"),
              days: int = Query(7, ge=0, le=3650), page: int = 1, per: int = Query(8, le=100), db: Session = Depends(get_db)):
    """Chỉ đọc (BR-18) — không có endpoint sửa/xoá."""
    paged = _page(_logs(db, q, cat, days), page, per)
    paged["items"] = [_log_out(r) for r in paged["items"]]
    return paged


@router.get("/logs/export.csv")
def export_logs(q: str = "", cat: str = Query("all", pattern="^(all|acc|quota|file|fb)$"), days: int = Query(7, ge=0),
                db: Session = Depends(get_db)):
    data = [["Thời gian", "Quản trị viên", "Thao tác", "Đối tượng", "Chi tiết", "Trước", "Sau"]]
    for r in _logs(db, q, cat, days):
        data.append([r.created_at.strftime("%d/%m/%Y %H:%M"), r.admin_label, r.action, r.object_label, r.object_sub or "",
                     r.from_value, r.to_value])
    return _csv("nhat-ky-quan-tri.csv", data)


# =========================================================================== UC-35 Góp ý

_FB_ST = {"new": "Mới", "doing": "Đang xử lý", "done": "Đã xong"}


def _fb_out(db: Session, f: Feedback, full: bool = False) -> dict:
    u = db.get(User, f.user_id) if f.user_id else None
    out = {"id": f.id, "category": f.category, "title": f.title, "status": f.status, "created_at": _iso(f.created_at),
           "user": u.display_name if u else None, "duplicate_of": f.duplicate_of}
    if full:
        out.update({"user_key": user_key(u) if u else None, "body": f.body, "context": f.context or [],
                    "quote_heading": f.quote_heading, "quote_text": f.quote_text, "ref_type": f.ref_type,
                    "image": ({"name": f.image_name, "bytes": f.image_bytes} if f.image_path else None),
                    "reply": f.reply, "replied_at": _iso(f.replied_at)})
    return out


def _get_fb(db: Session, fid: int) -> Feedback:
    f = db.get(Feedback, fid)
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy góp ý.")
    return f


@router.get("/feedback")
def list_feedback(status_: str = Query("new", alias="status", pattern="^(new|doing|done)$"), page: int = 1,
                  per: int = Query(5, le=50), db: Session = Depends(get_db)):
    counts = dict(db.execute(select(Feedback.status, func.count()).group_by(Feedback.status)).all())
    rows = db.scalars(select(Feedback).where(Feedback.status == status_).order_by(Feedback.created_at.desc())).all()
    paged = _page(rows, page, per)
    paged["items"] = [_fb_out(db, f) for f in paged["items"]]
    return {"counts": {k: counts.get(k, 0) for k in _FB_ST}, **paged}


@router.get("/feedback/{fid}")
def feedback_detail(fid: int, db: Session = Depends(get_db)):
    return _fb_out(db, _get_fb(db, fid), full=True)


@router.patch("/feedback/{fid}")
def update_feedback(fid: int, payload: AdminFeedbackPatch, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Đổi trạng thái / đóng (không phản hồi) / đánh dấu trùng (đóng + gộp vào góp ý gốc)."""
    f = _get_fb(db, fid)
    prev = f.status
    if payload.duplicate_of is not None:
        if payload.duplicate_of == f.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không thể đánh dấu trùng với chính nó.")
        _get_fb(db, payload.duplicate_of)
        f.duplicate_of, f.status = payload.duplicate_of, "done"
        audit.log(db, admin, "fb", "Đánh dấu trùng", f"#GY-{f.id}", f"Trùng #GY-{payload.duplicate_of}", _FB_ST[prev], "Đã đóng")
    elif payload.status is not None and payload.status != prev:
        f.status = payload.status
        if payload.status != "done":
            f.duplicate_of = None
        action = "Đóng góp ý" if payload.closing else "Đã xem góp ý mới" if payload.auto else "Đổi trạng thái góp ý"
        audit.log(db, admin, "fb", action, f"#GY-{f.id}", f.title,
                  _FB_ST[prev], "Đã đóng" if payload.closing else _FB_ST[payload.status])
    db.commit()
    return _fb_out(db, f, full=True)


@router.post("/feedback/{fid}/reply")
def reply_feedback(fid: int, payload: AdminFeedbackReply, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    f = _get_fb(db, fid)
    u = db.get(User, f.user_id) if f.user_id else None
    if u is None:   # UC-35 E2
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Người gửi đã xoá tài khoản, không gửi được phản hồi.")
    prev = f.status
    if prev == "done":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Góp ý đã xong — mở lại trước khi gửi phản hồi.")
    msg = payload.reply.strip()
    # Gửi phản hồi KHÔNG đóng góp ý (người dùng chốt): góp ý ở lại / chuyển "Đang xử lý", gửi được nhiều lần;
    # chỉ khi admin tự đổi trạng thái sang "Đã xong" mới chuyển. `reply` giữ tin gần nhất.
    f.reply, f.status, f.replied_at, f.replied_by = msg, "doing", local_now(), admin.id
    quota.notify(db, u.id, "feedback", str(f.id), f"Quản trị viên đã phản hồi góp ý #GY-{f.id} của bạn",
                 f.reply, f"fb:{f.id}:{local_now():%Y%m%d%H%M%S%f}")
    audit.log(db, admin, "fb", "Phản hồi góp ý", f"#GY-{f.id}", u.display_name, _FB_ST[prev], "Đang xử lý")
    db.commit()
    return _fb_out(db, f, full=True)


@router.get("/feedback/{fid}/image")
def feedback_image(fid: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Ngoại lệ BR-16: ảnh người học tự đính kèm — mở được, việc mở được ghi nhật ký."""
    f = _get_fb(db, fid)
    if not f.image_path or not Path(f.image_path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Góp ý không có ảnh đính kèm.")
    audit.log(db, admin, "fb", "Xem ảnh góp ý", f"#GY-{f.id}", f.image_name, "—", "Đã xem")
    db.commit()
    return FileResponse(f.image_path, filename=f.image_name or "anh-gop-y")


# =========================================================================== Chuông admin

@router.get("/alerts")
def admin_alerts(db: Session = Depends(get_db)):
    return {
        "new_feedback": db.scalar(select(func.count()).select_from(Feedback).where(Feedback.status == "new")) or 0,
        # id góp ý mới nhất: chuông admin (poll) so với lần trước để biết vừa có góp ý MỚI GỬI tới -> kêu + báo
        "latest_feedback_id": db.scalar(select(func.max(Feedback.id))) or 0,
        "file_errors": db.scalar(select(func.count()).select_from(PdfDocument).where(
            PdfDocument.process_status.in_(("ocr_error", "empty")))) or 0,
        "full_accounts": db.scalar(select(func.count()).select_from(UserQuotaState).where(UserQuotaState.storage_level == 3)) or 0,
    }


# =========================================================================== UC-37 Báo cáo

MAX_REPORT_DAYS = 90


def _range(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    b = date_to or local_now().date()
    a = date_from or b - timedelta(days=6)
    if a > b:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ngày bắt đầu phải trước ngày kết thúc.")
    if (b - a).days + 1 > MAX_REPORT_DAYS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Tối đa {MAX_REPORT_DAYS} ngày.")
    return a, b


def _report(db: Session, a: date, b: date) -> dict:
    start, end = datetime(a.year, a.month, a.day), datetime(b.year, b.month, b.day) + timedelta(days=1)
    n = (b - a).days + 1
    day = func.date(AiUsageEvent.created_at)
    per_day: dict[date, dict] = {a + timedelta(days=i): {"calls": 0, "err": 0, "gem": 0, "users": set()} for i in range(n)}
    for d, st, src, uid in db.execute(
        select(day, AiUsageEvent.status, AiUsageEvent.error_source, AiUsageEvent.user_id)
        .where(AiUsageEvent.created_at >= start, AiUsageEvent.created_at < end)
    ):
        r = per_day.get(d if isinstance(d, date) else date.fromisoformat(str(d)))
        if r is None:
            continue
        r["users"].add(uid)
        if st == "ok":
            r["calls"] += 1
        elif st == "error":
            r["err"] += 1
            r["gem"] += int(src == "gemini")
    for d, uid in db.execute(
        select(func.date(StudySession.started_at), StudySession.user_id)
        .where(StudySession.started_at >= start, StudySession.started_at < end)
    ):
        r = per_day.get(d if isinstance(d, date) else date.fromisoformat(str(d)))
        if r is not None:
            r["users"].add(uid)
    totals = db.execute(
        select(func.coalesce(func.sum(AiUsageEvent.tokens_in), 0), func.coalesce(func.sum(AiUsageEvent.tokens_out), 0),
               func.coalesce(func.sum(AiUsageEvent.tokens_thinking), 0), func.coalesce(func.sum(AiUsageEvent.cost_usd), 0))
        .where(AiUsageEvent.created_at >= start, AiUsageEvent.created_at < end)
    ).one()
    feats = dict(db.execute(select(AiUsageEvent.feature, func.count()).where(
        AiUsageEvent.status == "ok", AiUsageEvent.created_at >= start, AiUsageEvent.created_at < end)
        .group_by(AiUsageEvent.feature)).all())
    hits = dict(db.execute(select(AiUsageEvent.feature, func.count()).where(
        AiUsageEvent.status == "limited", AiUsageEvent.created_at >= start, AiUsageEvent.created_at < end)
        .group_by(AiUsageEvent.feature)).all())
    first = db.scalar(select(func.min(AiUsageEvent.created_at)))
    pa = a - timedelta(days=n)
    prev_calls = None
    if first is not None and first.date() <= pa:
        prev_calls = db.scalar(select(func.count()).select_from(AiUsageEvent).where(
            AiUsageEvent.status == "ok", AiUsageEvent.created_at >= datetime(pa.year, pa.month, pa.day),
            AiUsageEvent.created_at < start)) or 0
    cfg = quota.get_settings(db)
    near = sum(1 for x in _bulk_usage(db).values() if _metrics(x, cfg)["sp"] >= cfg["warn.w1"])
    days = [{"date": d.isoformat(), "calls": r["calls"], "users": len(r["users"]), "err": r["err"], "gem": r["gem"]}
            for d, r in sorted(per_day.items())]
    calls = sum(x["calls"] for x in days)
    return {
        "from": a.isoformat(), "to": b.isoformat(), "data_from": first.date().isoformat() if first else None,
        "calls": calls, "prev_calls": prev_calls,
        "tokens_in": int(totals[0]), "tokens_out": int(totals[1]), "tokens_thinking": int(totals[2]),
        "cost_usd": round(float(totals[3]), 4),
        "errors": sum(x["err"] for x in days), "errors_gemini": sum(x["gem"] for x in days),
        "days": days,
        "features": [{"feature": f, "name": name, "calls": feats.get(f, 0)} for f, (_, name, _) in quota.FEATURES.items()],
        "hits": [{"feature": f, "name": name, "count": hits.get(f, 0)} for f, (_, name, _) in quota.FEATURES.items()],
        "hits_total": sum(hits.values()), "storage_near": near,
    }


@router.get("/reports")
def report(date_from: date | None = Query(None, alias="from"), date_to: date | None = Query(None, alias="to"),
           db: Session = Depends(get_db)):
    """Tính trực tiếp từ ai_usage_events + study_sessions — không lưu (UC-37 hậu điều kiện)."""
    a, b = _range(date_from, date_to)
    return _report(db, a, b)


@router.get("/reports/export.xlsx")
def report_xlsx(date_from: date | None = Query(None, alias="from"), date_to: date | None = Query(None, alias="to"),
                db: Session = Depends(get_db)):
    from openpyxl import Workbook

    a, b = _range(date_from, date_to)
    r = _report(db, a, b)
    wb = Workbook()
    ws = wb.active
    ws.title = "Tổng quan"
    ws.append(["Báo cáo hệ thống", f"{a:%d/%m/%Y} – {b:%d/%m/%Y}"])
    for row in (["Lượt gọi AI", r["calls"]], ["Kỳ trước", r["prev_calls"] if r["prev_calls"] is not None else "Chưa đủ dữ liệu"],
                ["Token vào", r["tokens_in"]], ["Token ra", r["tokens_out"]], ["Token suy luận", r["tokens_thinking"]],
                ["Chi phí ước tính (USD)", r["cost_usd"]], ["Lỗi hệ thống", r["errors"]],
                ["Lỗi Gemini", r["errors_gemini"]], ["Lỗi máy chủ", r["errors"] - r["errors_gemini"]],
                ["Bị chặn vì hết lượt", r["hits_total"]], ["Người dùng gần đầy dung lượng", r["storage_near"]]):
        ws.append(row)
    ws2 = wb.create_sheet("Theo ngày")
    ws2.append(["Ngày", "Lượt gọi AI", "Người dùng hoạt động", "Lỗi", "Lỗi Gemini"])
    for d in r["days"]:
        ws2.append([d["date"], d["calls"], d["users"], d["err"], d["gem"]])
    ws3 = wb.create_sheet("Theo tính năng")
    ws3.append(["Tính năng", "Lượt gọi", "Chạm hạn mức"])
    hits = {h["feature"]: h["count"] for h in r["hits"]}
    for f in r["features"]:
        ws3.append([f["name"], f["calls"], hits[f["feature"]]])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="bao-cao-{a}-{b}.xlsx"'})
