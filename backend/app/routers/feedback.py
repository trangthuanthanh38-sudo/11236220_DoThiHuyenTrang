"""UC-35 — Luồng người học gửi góp ý (phía quản trị xử lý ở routers/admin.py).

  - POST /feedback       multipart: category ai|bug|idea, title, body, context (chuỗi JSON: danh sách chip ngữ
                         cảnh), quote_heading/quote_text (trích đoạn bị báo), ref_type/ref_id, image (tuỳ chọn)
  - GET  /feedback/mine  góp ý đã gửi + phản hồi của quản trị viên (mở từ thông báo kind='feedback')

BR-19: tối đa `quota_settings.feedback` góp ý/người/ngày (từ 0:00) → 429 code 'feedback_limit'. Ảnh đính kèm kiểm
bằng quota.check_upload (kích thước tệp + dung lượng còn trống) và tính vào dung lượng của người gửi.
"""
import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.models import Feedback, User
from app.schemas import FeedbackMineOut
from app.services import quota
from app.services.schedule_notifier import local_now

router = APIRouter(prefix="/feedback", tags=["Góp ý (UC-35)"])

_IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
_DEFAULT_TITLE = {"ai": "Nội dung AI sai", "bug": "Lỗi ứng dụng", "idea": "Đề xuất"}


@router.post("", response_model=FeedbackMineOut, status_code=status.HTTP_201_CREATED)
async def send_feedback(
    category: str = Form(..., pattern="^(ai|bug|idea)$"),
    body: str = Form(..., min_length=1, max_length=2000),
    title: str = Form("", max_length=150),
    context: str = Form(""),
    quote_heading: str = Form("", max_length=255),
    quote_text: str = Form("", max_length=2000),
    ref_type: str = Form("", pattern="^(|flashcard|quiz_question|summary_point|mindmap_node)$"),
    ref_id: str = Form("", max_length=36),
    image: UploadFile | None = File(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    body = body.strip()
    if not body:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nội dung góp ý không được để trống.")
    limit = quota.get_settings(db)["feedback"]
    if quota.feedback_today(db, current_user.id) >= limit:   # BR-19
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, {
            "message": f"Bạn đã gửi đủ {limit} góp ý hôm nay. Lượt mới có lúc 00:00.",
            "code": "feedback_limit", "limit": limit, "reset_in_seconds": quota.seconds_to_midnight()})
    try:
        ctx = json.loads(context) if context else None
        ctx = [str(x)[:80] for x in ctx][:8] if isinstance(ctx, list) else None
    except ValueError:
        ctx = None
    if bool(ref_type) != bool(ref_id):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "ref_type và ref_id phải đi cùng nhau.")

    fb = Feedback(
        user_id=current_user.id, category=category,
        title=(title.strip() or _DEFAULT_TITLE[category])[:150], body=body, context=ctx,
        quote_heading=quote_heading.strip() or None, quote_text=quote_text.strip() or None,
        ref_type=ref_type or None, ref_id=ref_id or None, created_at=local_now(),
    )
    if image is not None and image.filename:
        ext = _IMAGE_EXT.get(image.content_type or "")
        if ext is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ảnh đính kèm phải là PNG, JPG, WEBP hoặc GIF.")
        content = await image.read()
        if content:
            quota.check_upload(db, current_user, len(content))
            folder = Path(settings.FEEDBACK_UPLOAD_DIR)
            folder.mkdir(parents=True, exist_ok=True)
            stored = f"{uuid.uuid4()}{ext}"
            (folder / stored).write_bytes(content)
            fb.image_path = str(folder / stored).replace("\\", "/")
            fb.image_name = (image.filename or "anh-gop-y" + ext)[:255]
            fb.image_bytes = len(content)
    db.add(fb)
    db.flush()
    if fb.image_bytes:
        quota.refresh_level(db, current_user.id)
    db.commit()
    db.refresh(fb)
    return fb


@router.get("/mine", response_model=list[FeedbackMineOut])
def my_feedback(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(
        select(Feedback).where(Feedback.user_id == current_user.id).order_by(Feedback.id.desc()).limit(50)
    ).all()
