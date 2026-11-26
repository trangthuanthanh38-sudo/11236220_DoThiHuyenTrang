import asyncio
import contextlib
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    admin, auth, chat, feedback, flashcards, health, knowledge, me_quota, mindmaps, profile, quiz, schedule, shares, stats,
    summaries, translate,
)
from app.services import mailer, quota, schedule_notifier

# Console Windows mặc định dùng codepage cp1252 -> print() chuỗi tiếng Việt (vd. log
# "[MOCK SMS] Gửi OTP...") sẽ crash với UnicodeEncodeError. Ép stdout/stderr sang UTF-8
# ngay từ đầu để chạy ổn định trên mọi terminal (PowerShell, CMD, Git Bash...).
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """UC-31: vòng quét nhắc lịch chạy nền trong process (không có Celery) — xem services/schedule_notifier.py."""
    print(mailer.status_line())   # cho biết ngay lúc khởi động email nhắc lịch có gửi được không
    task = asyncio.create_task(schedule_notifier.run_forever()) if settings.SCHEDULER_INTERVAL_SECONDS > 0 else None
    yield
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    lifespan=lifespan,
    title="AI Studio Tri Thức — Auth API",
    description=(
        "UC-01 -> UC-05 (Xác thực & Truy cập, xem .claude/rules/04-auth-access.md) + "
        "UC-06 -> UC-09 (Hồ sơ & Cài đặt cá nhân, xem .claude/rules/05-profile-settings.md) + "
        "UC-12 -> UC-18 (Quản lý Tri thức & Nội dung, xem .claude/rules/07-knowledge-content.md) + "
        "UC-19 (đính kèm ngữ cảnh ở ô nhập AI Chat, xem .claude/rules/08-ai-studio.md — CHƯA có LLM/RAG)."
    ),
    version="0.4.0",
)

# UC-37: lượt AI đã quota.start() mà request trả 5xx / văng lỗi -> ghi "lỗi máy chủ" (services/quota.py)
app.middleware("http")(quota.track_server_errors)

origins = ["*"] if settings.CORS_ORIGINS.strip() == "*" else [o.strip() for o in settings.CORS_ORIGINS.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(knowledge.router)
app.include_router(chat.router)
app.include_router(quiz.router)
app.include_router(flashcards.router)
app.include_router(mindmaps.router)
app.include_router(summaries.router)
app.include_router(schedule.router)
app.include_router(stats.router)
app.include_router(shares.router)
app.include_router(shares.public_router)
app.include_router(me_quota.router)
app.include_router(feedback.router)
app.include_router(translate.router)
app.include_router(admin.router)
app.include_router(health.router)


@app.get("/health")
def health():
    return {"status": "ok"}
