"""Thẻ Review ▸ Translate (theo Word): dịch đoạn chữ đang bôi đen / cả Chương sang ngôn ngữ khác bằng Gemini.

POST /translate {text ≤ 6000 ký tự, target} -> {translation, detected, model_name}. Chỉ là công cụ soạn thảo (như
Translator của Word), không đọc kho tri thức của người học nên KHÔNG thuộc hạn mức AI Studio (BR-08 chỉ áp cho 6 tính
năng AI Studio); máy chủ chưa có GEMINI_API_KEY -> 503, Gemini lỗi -> 502 (thử lại 1 lần nếu 503 tạm thời).
"""
import json

from fastapi import APIRouter, Depends, HTTPException, status
from google.genai import types

from app.config import settings
from app.deps import get_current_user
from app.models import User
from app.routers.chat import _get_gemini_client
from app.schemas import TranslateOut, TranslateRequest

router = APIRouter(prefix="/translate", tags=["Review - Translate"])

LANGS = {
    "vi": "Vietnamese", "en": "English", "zh": "Chinese (Simplified)", "ja": "Japanese", "ko": "Korean",
    "fr": "French", "de": "German", "es": "Spanish", "ru": "Russian", "th": "Thai",
}

_PROMPT = (
    "You are a professional translator. Translate the user's text into {lang}. Keep the meaning, tone, line breaks, "
    "bullet markers, numbers, formulas and technical terms (keep well-known English terms in parentheses when translating "
    "into Vietnamese). Do not add explanations. Reply ONLY with JSON: "
    '{{"translation": "<translated text>", "detected": "<name of the source language in {lang}>"}}'
)


@router.post("", response_model=TranslateOut)
def translate(payload: TranslateRequest, current_user: User = Depends(get_current_user)):
    lang = LANGS.get(payload.target)
    if not lang:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Ngôn ngữ đích không được hỗ trợ.")
    client = _get_gemini_client()
    if client is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Máy chủ chưa cấu hình dịch vụ AI (GEMINI_API_KEY).")
    config = types.GenerateContentConfig(
        system_instruction=_PROMPT.format(lang=lang), response_mime_type="application/json", temperature=0.2,
    )
    last = None
    for _attempt in range(2):
        try:
            resp = client.models.generate_content(model=settings.GEMINI_MODEL, contents=payload.text, config=config)
            data = json.loads(resp.text or "{}")
            out = str(data.get("translation") or "").strip()
            if not out:
                raise ValueError("empty translation")
            return TranslateOut(translation=out, detected=(str(data.get("detected") or "").strip() or None),
                                model_name=settings.GEMINI_MODEL)
        except Exception as exc:   # noqa: BLE001 — lỗi mạng / quá tải / JSON hỏng đều báo chung
            last = exc
            if "503" not in str(exc):
                break
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Không dịch được lúc này (dịch vụ AI bận) — thử lại sau ít phút." if last else "Không dịch được.")
