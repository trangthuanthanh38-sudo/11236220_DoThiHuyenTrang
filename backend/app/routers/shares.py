"""CHIA SẺ Môn học / Chương — giống Word / OneNote (database/sharing_schema.sql, quyền tính ở services/sharing.py).

Luồng (frontend: js/ghichu_chiase.js — hộp "Chia sẻ" cạnh nút chuông, mục "Được chia sẻ với tôi" ở cây Notebook):
  GET    /shares/lookup?q=                   tìm 1 tài khoản theo SĐT hoặc Gmail (khớp CHÍNH XÁC — không cho dò danh sách)
  GET    /shares/{type}/{id}                 dữ liệu hộp Chia sẻ: chủ sở hữu, người có quyền, liên kết (type = subject|chapter)
  POST   /shares/{type}/{id}/invite          mời {user_ids, role, message} -> thông báo chuông (+ email nếu có SMTP)
  PATCH  /shares/{share_id}                  đổi quyền Xem / Chỉnh sửa (chủ sở hữu)
  DELETE /shares/{share_id}                  gỡ quyền (chủ sở hữu) hoặc tự rời ("Xoá khỏi danh sách" — người được chia sẻ)
  PUT    /shares/{type}/{id}/link            bật / đổi liên kết {audience anyone|invited, role}
  DELETE /shares/{type}/{id}/link            tắt liên kết (link cũ chết; bật lại = token mới)
  GET    /shares/with-me                     "Được chia sẻ với tôi"
  POST   /shares/link/{token}/accept         mở liên kết khi đã đăng nhập -> thêm vào "Được chia sẻ với tôi"
  POST   /shares/link/{token}/request        "Yêu cầu quyền truy cập" (link "Chỉ người có quyền") -> thông báo chủ sở hữu
  POST   /shares/copy                        "Tạo bản sao" Chương / PDF / cả Môn về Notebook của mình (để dùng AI Studio)
Công khai (không cần đăng nhập, chỉ link "Ai có liên kết", CHỈ XEM — trang html/xem.html):
  GET    /public/share/{token}  ·  /public/share/{token}/chapters/{id}  ·  /public/share/{token}/pdf/{id}/file
Chỉ CHỦ SỞ HỮU mời / đổi quyền / bật tắt liên kết (người được chia sẻ chỉ xem danh sách + sao chép liên kết đang bật).
"""
import secrets
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.deps import get_current_user, get_db
from app.models import (
    Chapter, Notification, NotificationDelivery, PdfAnnotation, PdfDocument, Share, ShareLink, Subject, User,
)
from app.schemas import (
    ChapterDetailOut, PublicShareOut, ShareAcceptOut, ShareCopyOut, ShareCopyRequest, SharedItemOut, SharedSubjectOut,
    ShareGrantOut, ShareInviteRequest, ShareLinkOut, ShareLinkRequest, SharePersonOut, ShareRoleRequest,
    ShareTargetOut, SimpleMessageResponse,
)
from app.security import ValidationError, normalize_phone
from app.services import embeddings, mailer, quota, sharing
from app.services.schedule_notifier import local_now, recipient_email
from app.services.text_extraction import html_to_text

router = APIRouter(prefix="/shares", tags=["shares"])
public_router = APIRouter(prefix="/public/share", tags=["shares"])

ROLE_TEXT = {"viewer": "Có thể xem", "editor": "Có thể chỉnh sửa", "owner": "Chủ sở hữu"}


# ---------------------------------------------------------------------------
# Đích chia sẻ
# ---------------------------------------------------------------------------
def _resolve(db: Session, target_type: str, target_id: str, user: User, need: str = "viewer"):
    """-> (subject, chapter|None, tên hiển thị, quyền của user)."""
    if target_type == "subject":
        subject, role = sharing.get_subject(db, target_id, user, need)
        return subject, None, subject.name, role
    if target_type == "chapter":
        chapter, role = sharing.get_chapter(db, target_id, user, need)
        return chapter.subject, chapter, chapter.name, role
    raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy nội dung.")


def _target_cols(target_type: str, subject: Subject, chapter: Chapter | None) -> dict:
    return {
        "target_type": target_type,
        "target_id": chapter.id if chapter else subject.id,
        "subject_id": subject.id if target_type == "subject" else None,
        "chapter_id": chapter.id if chapter else None,
    }


def _link_out(link: ShareLink | None) -> ShareLinkOut | None:
    return ShareLinkOut(token=link.token, audience=link.audience, role=link.role) if link else None


def _grant_out(db: Session, g: Share, with_contact: bool, inherited: bool = False) -> ShareGrantOut:
    return ShareGrantOut(
        id=g.id, user=SharePersonOut(**sharing.person(db.get(User, g.grantee_id), with_contact)),
        role=g.role, via=g.via, inherited=inherited,
    )


def _notify(db: Session, user_id: str, kind: str, ref_id: str, title: str, detail: str, key: str) -> None:
    now = local_now()
    n = Notification(user_id=user_id, kind=kind, ref_id=ref_id, title=title[:200], detail=detail[:255], dedupe_key=key[:100], fire_at=now)
    n.deliveries.append(NotificationDelivery(channel="app", status="sent", attempts=1, sent_at=now))
    try:
        with db.begin_nested():
            db.add(n)
    except IntegrityError:   # đã báo cùng key (vd. xin quyền nhiều lần trong ngày)
        pass


def _send_invite_email(user_id: str, owner_name: str, item: str, what: str, role: str, message: str | None, url: str) -> None:
    """Chạy nền sau response — như email "X đã chia sẻ … với bạn" của Word / OneNote. Lỗi gửi thì bỏ qua."""
    if not mailer.is_configured():
        return
    db = SessionLocal()
    try:
        to = recipient_email(db, user_id)
    finally:
        db.close()
    if not to:
        return
    subject = f'{owner_name} đã chia sẻ {what} "{item}" với bạn'
    note = f"\n\n“{message}”" if message else ""
    text_body = f"{subject} ({ROLE_TEXT[role].lower()}).{note}\n\nMở: {url}"
    msg_html = f'<p style="margin:14px 0;padding:10px 14px;background:#f1f4f9;border-radius:8px">{_esc(message)}</p>' if message else ""
    html = (
        '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e3e8f0;border-radius:12px;overflow:hidden">'
        f'<div style="background:#1f5f99;color:#fff;padding:16px 20px;font-size:16px"><b>{_esc(owner_name)}</b> đã chia sẻ {what} với bạn</div>'
        f'<div style="padding:18px 20px;color:#0a1a4d"><div style="font-size:18px;font-weight:600">{_esc(item)}</div>'
        f'<div style="color:#5b6b85;margin-top:4px">{ROLE_TEXT[role]}</div>{msg_html}'
        f'<a href="{url}" style="display:inline-block;margin-top:10px;background:#1f5f99;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">Mở</a></div></div>'
    )
    try:
        mailer.send_email(to, subject, text_body, html)
    except Exception:  # noqa: BLE001 — email chỉ là kênh phụ, thông báo trong app đã có
        pass


def _esc(s: str | None) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _open_url(target_type: str, target_id: str) -> str:
    return f"{settings.APP_URL}?open={target_type}:{target_id}"


# ---------------------------------------------------------------------------
# Tìm người + hộp Chia sẻ
# ---------------------------------------------------------------------------
@router.get("/lookup", response_model=list[SharePersonOut])
def lookup(q: str = Query(min_length=3, max_length=255), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Khớp CHÍNH XÁC 1 SĐT (0xxxxxxxxx / +84…) hoặc 1 Gmail tài khoản Google — không gợi ý theo tên để tránh dò người dùng."""
    q = q.strip()
    if "@" in q:
        user = db.scalar(select(User).where(func.lower(User.google_email) == q.lower(), User.status == "active"))
    else:
        try:
            phone = normalize_phone(q)
        except ValidationError:
            return []
        user = db.scalar(select(User).where(User.phone_number == phone, User.status == "active"))
    if user is None or user.id == current_user.id:
        return []
    return [SharePersonOut(**sharing.person(user, with_contact=True))]


@router.get("/with-me", response_model=list[SharedSubjectOut])
def shared_with_me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    grants = db.scalars(select(Share).where(Share.grantee_id == current_user.id).order_by(Share.created_at.desc())).all()
    whole = {g.target_id: g for g in grants if g.target_type == "subject"}
    by_chapter: dict[str, Share] = {g.target_id: g for g in grants if g.target_type == "chapter"}
    out: list[SharedSubjectOut] = []
    seen: set[str] = set()
    for g in grants:
        if g.target_type == "subject":
            sub = db.get(Subject, g.target_id)
        else:
            ch = db.get(Chapter, g.target_id)
            sub = ch.subject if ch else None
        if sub is None or sub.id in seen or sub.owner_id == current_user.id:
            continue
        seen.add(sub.id)
        sg = whole.get(sub.id)
        if sg:
            chapters = [SharedItemOut(id=c.id, name=c.name, protected=bool(c.password_hash), role=sharing.best(sg.role, by_chapter[c.id].role if c.id in by_chapter else None),
                                      share_id=by_chapter[c.id].id if c.id in by_chapter else None)
                        for c in sub.chapters]
            pdfs = [SharedItemOut(id=p.id, name=p.original_name, role=sg.role, page_count=p.page_count) for p in sub.pdf_documents]
        else:
            chapters = [SharedItemOut(id=c.id, name=c.name, protected=bool(c.password_hash), role=by_chapter[c.id].role, share_id=by_chapter[c.id].id)
                        for c in sub.chapters if c.id in by_chapter]
            pdfs = []
        out.append(SharedSubjectOut(
            subject_id=sub.id, subject_name=sub.name, owner=SharePersonOut(**sharing.person(db.get(User, sub.owner_id))),
            whole=bool(sg), role=sg.role if sg else None, share_id=sg.id if sg else None, chapters=chapters, pdfs=pdfs,
        ))
    return out


@router.get("/{target_type}/{target_id}", response_model=ShareTargetOut)
def get_target(target_type: str, target_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    subject, chapter, name, role = _resolve(db, target_type, target_id, current_user)
    is_owner = role == "owner"
    cols = _target_cols(target_type, subject, chapter)
    own = db.scalars(select(Share).where(Share.target_type == target_type, Share.target_id == cols["target_id"])
                     .order_by(Share.created_at)).all()
    grants = [_grant_out(db, g, is_owner) for g in own]
    if chapter is not None:   # người có quyền qua chia sẻ cả Môn — chỉ hiện, sửa ở hộp chia sẻ của Môn
        mine = {g.grantee_id for g in own}
        inherited = db.scalars(select(Share).where(Share.target_type == "subject", Share.target_id == subject.id)
                               .order_by(Share.created_at)).all()
        grants += [_grant_out(db, g, is_owner, inherited=True) for g in inherited if g.grantee_id not in mine]
    link = db.scalar(select(ShareLink).where(ShareLink.target_type == target_type, ShareLink.target_id == cols["target_id"]))
    return ShareTargetOut(
        target_type=target_type, target_id=cols["target_id"], name=name, subject_id=subject.id, subject_name=subject.name,
        owner=SharePersonOut(**sharing.person(db.get(User, subject.owner_id), is_owner)),
        my_role=role, can_manage=is_owner, grants=grants, link=_link_out(link),
    )


@router.post("/{target_type}/{target_id}/invite", response_model=ShareTargetOut)
def invite(
    target_type: str, target_id: str, payload: ShareInviteRequest, background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
):
    subject, chapter, name, _role = _resolve(db, target_type, target_id, current_user, "owner")
    cols = _target_cols(target_type, subject, chapter)
    what = "môn học" if target_type == "subject" else "chương"
    message = (payload.message or "").strip() or None
    for uid in dict.fromkeys(payload.user_ids):
        user = db.get(User, uid)
        if user is None or user.status != "active":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tài khoản được mời.")
        if user.id == subject.owner_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bạn đã là chủ sở hữu nội dung này.")
        g = db.scalar(select(Share).where(Share.grantee_id == uid, Share.target_type == target_type, Share.target_id == cols["target_id"]))
        if g is not None:      # mời lại = đổi quyền (như Word), không báo lại
            g.role, g.via = payload.role, "invite"
            continue
        g = Share(owner_id=subject.owner_id, grantee_id=uid, role=payload.role, via="invite", **cols)
        db.add(g)
        db.flush()
        detail = f"{current_user.display_name} đã chia sẻ {what} với bạn · {ROLE_TEXT[payload.role]}"
        if message:
            detail += f" · “{message}”"
        _notify(db, uid, "share", cols["target_id"], name, detail, f"sh:{g.id}")
        background_tasks.add_task(_send_invite_email, uid, current_user.display_name, name, what, payload.role, message,
                                  _open_url(target_type, cols["target_id"]))
    db.commit()
    return get_target(target_type, target_id, current_user, db)


@router.patch("/{share_id}", response_model=SimpleMessageResponse)
def change_role(share_id: str, payload: ShareRoleRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.get(Share, share_id)
    if g is None or g.owner_id != current_user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy quyền truy cập.")
    g.role = payload.role
    db.commit()
    return SimpleMessageResponse(message="Đã đổi quyền.")


@router.delete("/{share_id}", response_model=SimpleMessageResponse)
def remove_share(share_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.get(Share, share_id)
    if g is None or current_user.id not in (g.owner_id, g.grantee_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy quyền truy cập.")
    db.delete(g)
    db.commit()
    return SimpleMessageResponse(message="Đã gỡ quyền truy cập.")


@router.put("/{target_type}/{target_id}/link", response_model=ShareLinkOut)
def set_link(target_type: str, target_id: str, payload: ShareLinkRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    subject, chapter, _name, _role = _resolve(db, target_type, target_id, current_user, "owner")
    cols = _target_cols(target_type, subject, chapter)
    link = db.scalar(select(ShareLink).where(ShareLink.target_type == target_type, ShareLink.target_id == cols["target_id"]))
    if link is None:
        link = ShareLink(token=secrets.token_urlsafe(24), owner_id=subject.owner_id, **cols)
        db.add(link)
    link.audience, link.role = payload.audience, payload.role
    db.commit()
    return _link_out(link)


@router.delete("/{target_type}/{target_id}/link", response_model=SimpleMessageResponse)
def delete_link(target_type: str, target_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    subject, chapter, _name, _role = _resolve(db, target_type, target_id, current_user, "owner")
    cols = _target_cols(target_type, subject, chapter)
    link = db.scalar(select(ShareLink).where(ShareLink.target_type == target_type, ShareLink.target_id == cols["target_id"]))
    if link is not None:
        db.delete(link)
        db.commit()
    return SimpleMessageResponse(message="Đã tắt liên kết.")


# ---------------------------------------------------------------------------
# Mở liên kết
# ---------------------------------------------------------------------------
def _link_or_404(db: Session, token: str) -> ShareLink:
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Liên kết không tồn tại hoặc đã bị tắt.")
    return link


@router.post("/link/{token}/accept", response_model=ShareAcceptOut)
def accept_link(token: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    link = _link_or_404(db, token)
    if link.target_type == "subject":
        subject = db.get(Subject, link.target_id)
        role = sharing.subject_role(db, subject, current_user)
    else:
        chapter = db.get(Chapter, link.target_id)
        subject = chapter.subject
        role = sharing.chapter_role(db, chapter, current_user)
    if link.audience == "anyone" and sharing.RANK[link.role] > sharing.RANK[role]:
        g = db.scalar(select(Share).where(Share.grantee_id == current_user.id, Share.target_type == link.target_type,
                                          Share.target_id == link.target_id))
        if g is None:
            db.add(Share(owner_id=subject.owner_id, grantee_id=current_user.id, role=link.role, via="link",
                         target_type=link.target_type, target_id=link.target_id,
                         subject_id=link.subject_id, chapter_id=link.chapter_id))
        else:
            g.role = link.role
        db.commit()
        role = link.role
    if role is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {
            "code": "need_access", "message": "Bạn cần được chủ sở hữu cấp quyền để mở nội dung này.",
            "owner_name": db.get(User, subject.owner_id).display_name,
        })
    return ShareAcceptOut(target_type=link.target_type, target_id=link.target_id, subject_id=subject.id, role=role)


@router.post("/link/{token}/request", response_model=SimpleMessageResponse)
def request_access(token: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    link = _link_or_404(db, token)
    if link.target_type == "subject":
        name = db.get(Subject, link.target_id).name
    else:
        name = db.get(Chapter, link.target_id).name
    day = local_now().date().isoformat()
    _notify(db, link.owner_id, "share_request", link.target_id, name,
            f"{current_user.display_name} yêu cầu quyền truy cập", f"rq:{link.target_id}:{current_user.id}:{day}")
    db.commit()
    return SimpleMessageResponse(message="Đã gửi yêu cầu tới chủ sở hữu.")


# ---------------------------------------------------------------------------
# Tạo bản sao về Notebook của mình
# ---------------------------------------------------------------------------
def _copy_pdf_file(src: str) -> str:
    upload_dir = Path(settings.PDF_UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)
    stored = f"{uuid.uuid4()}.pdf"
    shutil.copyfile(src, upload_dir / stored)
    return str(Path(settings.PDF_UPLOAD_DIR) / stored).replace("\\", "/")


def _next_order(db: Session, model, subject_id: str) -> int:
    m = db.scalar(select(func.max(model.sort_order)).where(model.subject_id == subject_id))
    return (m if m is not None else -1) + 1


def _copy_chapter(db: Session, src: Chapter, to: Subject, user: User) -> Chapter:
    c = Chapter(subject_id=to.id, name=src.name, sort_order=_next_order(db, Chapter, to.id),
                content_json=src.content_json, content_text=src.content_text or html_to_text(src.content_json or ""),
                drawing_json=src.drawing_json, password_hash=src.password_hash, password_hint=src.password_hint)
    db.add(c)
    db.flush()
    return c


def _copy_pdf(db: Session, src: PdfDocument, to: Subject, user: User) -> PdfDocument:
    if not Path(src.file_path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tệp PDF không còn trên server.")
    quota.check_upload(db, user, src.file_size_bytes, to.id)   # bản sao tính vào dung lượng của mình (UC-33)
    d = PdfDocument(subject_id=to.id, original_name=src.original_name, file_path=_copy_pdf_file(src.file_path),
                    page_count=src.page_count, file_size_bytes=src.file_size_bytes, mime_type=src.mime_type,
                    content_sha256=src.content_sha256, process_status="processing", last_opened_at=local_now(),
                    sort_order=_next_order(db, PdfDocument, to.id))
    db.add(d)
    db.flush()
    for a in src.annotations:
        db.add(PdfAnnotation(document_id=d.id, created_by=user.id, page_number=a.page_number,
                             annotation_type=a.annotation_type, data=a.data))
    return d


@router.post("/copy", response_model=ShareCopyOut)
def copy_to_mine(payload: ShareCopyRequest, background_tasks: BackgroundTasks,
                 current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """"Tạo bản sao" (như "Lưu bản sao" của Word): chép vào Notebook của mình — bản sao là của mình nên dùng được AI Studio."""
    if payload.kind == "subject":
        src, _ = sharing.get_subject(db, payload.id, current_user)
        files = [p for p in src.pdf_documents if Path(p.file_path).is_file()]
        if files:   # kiểm cả Môn TRƯỚC khi chép tệp nào lên đĩa
            cfg = quota.get_settings(db)
            if len(files) > cfg["storage.subject_files"]:
                raise HTTPException(status.HTTP_409_CONFLICT, {
                    "message": f"Môn này có {len(files)} tệp, vượt hạn mức {cfg['storage.subject_files']} tệp mỗi môn.",
                    "code": "subject_full", "limit": cfg["storage.subject_files"]})
            total = sum(p.file_size_bytes for p in files)
            free = max(0, cfg["storage.user_mb"] * quota.MB - sum(quota.storage_bytes(db, current_user.id).values()))
            if total > free:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, {
                    "message": f"Không đủ dung lượng để sao chép môn này: cần {total / quota.MB:.1f} MB, còn trống "
                               f"{free / quota.MB:.1f} MB.",
                    "code": "storage_full", "free_bytes": free, "need_bytes": total - free, "size_bytes": total})
        m = db.scalar(select(func.max(Subject.sort_order)).where(Subject.owner_id == current_user.id))
        to = Subject(owner_id=current_user.id, name=src.name, description=src.description, color=src.color, icon=src.icon,
                     sort_order=(m if m is not None else -1) + 1)
        db.add(to)
        db.flush()
        chapters = [_copy_chapter(db, c, to, current_user) for c in src.chapters]
        pdfs = [_copy_pdf(db, p, to, current_user) for p in files]
        db.commit()
        background_tasks.add_task(quota.refresh_after_change, current_user.id)
        for c in chapters:
            background_tasks.add_task(embeddings.reembed_chapter_background, c.id)
        for d in pdfs:
            background_tasks.add_task(embeddings.reembed_pdf_background, d.id)
        return ShareCopyOut(subject_id=to.id, kind="subject", id=to.id)
    if not payload.to_subject_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Chọn Môn học để lưu bản sao.")
    to, _ = sharing.get_subject(db, payload.to_subject_id, current_user, "owner")
    if payload.kind == "chapter":
        src, _ = sharing.get_chapter(db, payload.id, current_user)
        c = _copy_chapter(db, src, to, current_user)
        db.commit()
        background_tasks.add_task(embeddings.reembed_chapter_background, c.id)
        return ShareCopyOut(subject_id=to.id, kind="chapter", id=c.id)
    src, _ = sharing.get_pdf(db, payload.id, current_user)
    d = _copy_pdf(db, src, to, current_user)
    db.commit()
    background_tasks.add_task(embeddings.reembed_pdf_background, d.id)
    background_tasks.add_task(quota.refresh_after_change, current_user.id)
    return ShareCopyOut(subject_id=to.id, kind="pdf", id=d.id)


# ---------------------------------------------------------------------------
# Xem công khai (chưa đăng nhập) — chỉ liên kết "Ai có liên kết", luôn CHỈ XEM
# ---------------------------------------------------------------------------
def _public_link(db: Session, token: str) -> tuple[ShareLink, Subject]:
    link = db.scalar(select(ShareLink).where(ShareLink.token == token))
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Liên kết không tồn tại hoặc đã bị tắt.")
    if link.audience != "anyone":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Liên kết này chỉ dành cho người được chủ sở hữu cấp quyền. Hãy đăng nhập.")
    subject = db.get(Subject, link.subject_id) if link.subject_id else db.get(Chapter, link.chapter_id).subject
    return link, subject


@public_router.get("/{token}", response_model=PublicShareOut)
def public_share(token: str, db: Session = Depends(get_db)):
    link, subject = _public_link(db, token)
    owner = db.get(User, subject.owner_id)
    if link.target_type == "subject":
        chapters = [SharedItemOut(id=c.id, name=c.name, role="viewer", protected=bool(c.password_hash)) for c in subject.chapters]
        pdfs = [SharedItemOut(id=p.id, name=p.original_name, role="viewer", page_count=p.page_count) for p in subject.pdf_documents]
        name = subject.name
    else:
        ch = db.get(Chapter, link.chapter_id)
        chapters, pdfs, name = [SharedItemOut(id=ch.id, name=ch.name, role="viewer", protected=bool(ch.password_hash))], [], ch.name
    return PublicShareOut(target_type=link.target_type, name=name, subject_name=subject.name,
                          owner_name=owner.display_name if owner else "", chapters=chapters, pdfs=pdfs)


@public_router.get("/{token}/chapters/{chapter_id}", response_model=ChapterDetailOut)
def public_chapter(token: str, chapter_id: str, db: Session = Depends(get_db)):
    link, subject = _public_link(db, token)
    ch = db.get(Chapter, chapter_id)
    ok = ch is not None and (ch.id == link.chapter_id if link.target_type == "chapter" else ch.subject_id == subject.id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy chương.")
    if ch.password_hash:   # Review > Password: trang công khai không có cách mở khoá -> không lộ nội dung
        return ChapterDetailOut(id=ch.id, name=ch.name, sort_order=ch.sort_order, protected=True, locked=True,
                                content_version=ch.content_version or 0, role="viewer")
    return ChapterDetailOut(id=ch.id, name=ch.name, sort_order=ch.sort_order, content_json=ch.content_json,
                            content_version=ch.content_version or 0, role="viewer", drawing_json=ch.drawing_json)


@public_router.get("/{token}/pdf/{document_id}/file")
def public_pdf(token: str, document_id: str, db: Session = Depends(get_db)):
    link, subject = _public_link(db, token)
    doc = db.get(PdfDocument, document_id)
    if doc is None or link.target_type != "subject" or doc.subject_id != subject.id or not Path(doc.file_path).is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy tệp PDF.")
    return FileResponse(Path(doc.file_path), media_type="application/pdf", filename=doc.original_name,
                        content_disposition_type="inline")
