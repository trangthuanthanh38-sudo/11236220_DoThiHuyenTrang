"""UC-23 (Tạo Flashcard theo chương): sinh 1 bộ thẻ ghi nhớ từ các nguồn (Chương / Tệp PDF) người học
đã tick, lưu vào các bảng flashcard_* (database/studio_tools_flashcard_schema.sql + _v2), + lịch lặp
lại ngắt quãng (schedule_next), ghi 1 phiên ôn trọn vẹn (save_session) và chuỗi ngày ôn (streak_days).
Số thẻ từng loại do người học chốt ("Loại thẻ": [thuật ngữ, câu hỏi]) — xin dư ~20% rồi _pick_by_type.

Dùng lại nguyên các bước chung của quiz_generation.py (cùng triết lý tiết kiệm quota): lấy mẫu chunk
ĐÃ embed của nguồn (không gọi embedding API), ĐÚNG 1 lượt `generate_content` cho cả bộ với
`response_schema`, chuỗi model QUIZ_MODEL -> QUIZ_FALLBACK_MODEL, báo đúng loại lỗi. Không raise khi
LLM lỗi: bộ thẻ chuyển `status='failed'` + `error_message` (router xoá bộ đó và trả 502).
"""
import math
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Chapter, EmbeddingChunk, Flashcard, FlashcardReview, FlashcardSession, FlashcardSet, \
    FlashcardSetSource, PdfDocument, Subject, User
from app.services.quiz_generation import _clean, _generate, _label, _norm, _quote_for, _source_label

MIN_CARDS, MAX_CARDS = 5, 50          # khớp CHECK chk_flashcard_sets_requested_count
# Trần "nguồn chỉ đủ khái niệm cho tối đa N thẻ" (/quiz/source-stats mode=flashcard). ĐO THẬT 01/10: Chương
# 1.666 ký tự -> Gemini sinh đủ 20/20 thẻ không trùng ý; xin 30 thì bắt đầu lặp khái niệm giữa 2 loại thẻ.
# (Bản đầu 900 ký tự/thẻ chặn oan: nguồn đó chỉ được 1 thẻ, dưới mức tối thiểu 5.)
CHARS_PER_CARD = 80
_EXTRA = 1.2                          # xin dư ~20% mỗi loại để còn chỗ lọc thẻ hỏng mà vẫn đủ hạn ngạch
_CHUNKS_PER_CARD = 1.5
_MIN_CHUNKS, _MAX_CHUNKS = 4, 60      # chặn độ dài prompt (TPM/độ trễ) như đề thi thử
_MAX_FRONT, _MAX_BACK = 300, 700      # thẻ dài hơn thế không còn là "thẻ ghi nhớ" -> bỏ

# --- Lịch lặp lại ngắt quãng (đã chốt: Khó 10 phút; Dễ 3 ngày rồi x2,5, tối đa 180 ngày) ---
HARD_SECONDS = 10 * 60
EASY_FIRST_SECONDS = 3 * 86400
EASY_FACTOR = 2.5
MAX_INTERVAL_SECONDS = 180 * 86400

_TYPE_VI = {"term": "Thuật ngữ – Định nghĩa", "qa": "Câu hỏi – Đáp án ngắn"}
_FAIL_WORD_RE = re.compile(r"câu hỏi", re.IGNORECASE)


# --- Khuôn JSON ép Gemini trả về (response_schema) -------------------------------------------
class _GenCard(BaseModel):
    card_type: Literal["term", "qa"]
    front: str        # thuật ngữ / câu hỏi
    back: str         # định nghĩa / đáp án ngắn
    source_ref: str   # mã đoạn nguồn, vd. "S3"
    quote: str        # câu trích NGUYÊN VĂN từ đoạn nguồn đó


class _GenDeck(BaseModel):
    cards: list[_GenCard]


_SYSTEM_PROMPT = (
    "Bạn là giảng viên soạn thẻ ghi nhớ (flashcard) cho sinh viên Việt Nam ôn tập theo phương pháp lặp "
    "lại ngắt quãng. Chỉ được dùng thông tin trong các ĐOẠN NGUỒN được cung cấp (mỗi đoạn có mã dạng "
    "[S1], [S2]...) — tuyệt đối không dùng kiến thức bên ngoài, không bịa. Viết bằng đúng ngôn ngữ của "
    "đoạn nguồn (mặc định tiếng Việt).\n"
    "Hai loại thẻ:\n"
    "• term (Thuật ngữ – Định nghĩa): front là 1 thuật ngữ/khái niệm ngắn (vài từ); back là định nghĩa "
    "súc tích 1-2 câu.\n"
    "• qa (Câu hỏi – Đáp án ngắn): front là 1 câu hỏi cụ thể; back là đáp án ngắn gọn (1-2 câu).\n"
    "Yêu cầu cho MỖI thẻ:\n"
    "• Mỗi thẻ chỉ kiểm tra 1 ý, back dưới 250 ký tự, front không chứa sẵn đáp án.\n"
    "• source_ref: mã của đúng 1 đoạn nguồn chứa căn cứ.\n"
    "• quote: 1 câu/cụm trích NGUYÊN VĂN từ đoạn nguồn đó (không diễn đạt lại).\n"
    "Mã [S1], [S2]... chỉ dùng cho source_ref — KHÔNG nhắc tới mã này hay cụm \"đoạn nguồn\" trong "
    "front/back. Ưu tiên khái niệm, định nghĩa, sự kiện quan trọng. Không tạo 2 thẻ trùng ý. Nếu nội "
    "dung nguồn không đủ khái niệm cho số thẻ được yêu cầu, hãy tạo ÍT thẻ hơn thay vì lặp lại hay bịa thêm."
)


def _build_prompt(chunks: list[EmbeddingChunk], quotas: tuple[int, int]) -> str:
    parts = []
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        parts.append(f"[S{i}] ({name}" + (f", trang {page}" if page else "") + f")\n{chunk.content}")
    asks = [f"{max(1, round(n * _EXTRA))} thẻ {t} ({_TYPE_VI[t]})" for t, n in zip(("term", "qa"), quotas) if n]
    only = "" if all(quotas) else " Không tạo loại thẻ nào khác."
    return (
        f"Hãy tạo {' và '.join(asks)}.{only} Rải thẻ đều trên các đoạn nguồn.\n\n"
        "ĐOẠN NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )


def _pick_by_type(
    kept: list[tuple[_GenCard, EmbeddingChunk]], quotas: tuple[int, int]
) -> list[tuple[_GenCard, EmbeddingChunk]]:
    """Giữ đúng hạn ngạch từng loại theo thứ tự thuật ngữ trước rồi câu hỏi; loại nào thiếu thì bù bằng
    thẻ dư của loại kia (chỉ khi người học chọn cả 2 loại — tổng vẫn <= số thẻ)."""
    picked, rest = [], []
    for t, quota in zip(("term", "qa"), quotas):
        same = [x for x in kept if x[0].card_type == t]
        picked.extend(same[:quota])
        rest.extend(same[quota:])
    picked.extend(rest[: max(0, sum(quotas) - len(picked))])
    return picked


def _valid_cards(
    raw: list[_GenCard], refs: dict[str, EmbeddingChunk], card_types: list[str], limit: int
) -> list[tuple[_GenCard, EmbeddingChunk]]:
    """UC-23 E1: lọc thẻ rỗng/quá dài/sai loại/trùng mặt trước/mã nguồn lạ thay vì lưu thẻ sai."""
    kept: list[tuple[_GenCard, EmbeddingChunk]] = []
    seen: set[str] = set()
    for c in raw:
        c.front, c.back = _clean(c.front), _clean(c.back)
        chunk = refs.get(c.source_ref.strip().strip("[]").upper())
        if (
            not c.front
            or not c.back
            or len(c.front) > _MAX_FRONT
            or len(c.back) > _MAX_BACK
            or c.card_type not in card_types
            or chunk is None
            or _norm(c.front) in seen
            or _norm(c.front) == _norm(c.back)
        ):
            continue
        seen.add(_norm(c.front))
        kept.append((c, chunk))
        if len(kept) == limit:
            break
    return kept


def _fail(db: Session, fset: FlashcardSet, message: str) -> FlashcardSet:
    fset.status, fset.error_message = "failed", message[:500]
    db.commit()
    return fset


def generate_flashcard_set(
    db: Session,
    user: User,
    subject: Subject,
    sources: list[Chapter | PdfDocument],
    title: str,
    type_counts: tuple[int, int],
    shuffle: bool = True,
    show_citation: bool = True,
) -> FlashcardSet:
    """Tạo + lưu 1 bộ flashcard. Nơi gọi (router) phải kiểm trước BR-05/BR-07 (_validate_sources)
    và BR-08. `type_counts` = [thuật ngữ, câu hỏi], tổng = số thẻ 5-50. Luôn trả FlashcardSet đã
    commit: 'ready' (card_count có thể < requested_count — UC-23 E1) hoặc 'failed' + error_message."""
    quotas = (int(type_counts[0]), int(type_counts[1]))
    count = sum(quotas)
    card_types = [t for t, n in zip(("term", "qa"), quotas) if n]
    fset = FlashcardSet(
        user_id=user.id,
        subject_id=subject.id,
        title=title[:200],
        count_mode="manual",
        requested_count=count,
        card_types=set(card_types),
        shuffle_cards=shuffle,
        show_citation=show_citation,
        status="generating",
    )
    fset.sources = [
        FlashcardSetSource(
            source_type="CHAPTER" if isinstance(s, Chapter) else "PDF",
            chapter_id=s.id if isinstance(s, Chapter) else None,
            document_id=s.id if isinstance(s, PdfDocument) else None,
            source_label=_source_label(s)[:255],
        )
        for s in sources
    ]
    db.add(fset)
    db.flush()

    budget = min(_MAX_CHUNKS, max(_MIN_CHUNKS, math.ceil(count * _CHUNKS_PER_CARD)))
    # _generate (quiz_generation) chỉ dùng status/error_message/model_name nên nhận được FlashcardSet.
    chunks, result = _generate(
        db, fset, sources, budget, lambda c: _build_prompt(c, quotas), _GenDeck, _SYSTEM_PROMPT
    )
    if result is None:
        # Thông báo lỗi dùng chung với quiz nói "câu hỏi" -> đổi cho đúng ngữ cảnh.
        fset.error_message = _FAIL_WORD_RE.sub("flashcard", fset.error_message or "")[:500]
        db.commit()
        return fset
    refs = {f"S{i}": c for i, c in enumerate(chunks, start=1)}
    kept = _pick_by_type(_valid_cards(result.cards, refs, card_types, len(result.cards)), quotas)
    if not kept:
        return _fail(db, fset, "Không tạo được thẻ hợp lệ từ nội dung đã chọn — hãy chọn thêm nguồn hoặc thử lại.")

    for position, (c, chunk) in enumerate(kept, start=1):
        name, page = _label(chunk)
        fset.cards.append(
            Flashcard(
                position=position,
                card_type=c.card_type,
                front=c.front,
                back=c.back,
                source_type="PDF" if chunk.source_type == "PDF" else "CHAPTER",
                chapter_id=chunk.chapter_id,
                document_id=chunk.document_id,
                embedding_chunk_id=chunk.id,
                source_label=name[:255],
                page_number=page,
                quote=_quote_for(c, chunk),
            )
        )
    fset.card_count = len(kept)
    fset.status = "ready"
    db.commit()
    return fset


# ---------------------------------------------------------------------------
# Lặp lại ngắt quãng
# ---------------------------------------------------------------------------
def next_interval(card: Flashcard, rating: str) -> int:
    """Khoảng (giây) tới lần ôn sau nếu chấm `rating` ngay bây giờ — hàm thuần, không ghi gì."""
    if rating == "hard":
        return HARD_SECONDS
    if card.review_count == 0 or card.last_rating == "hard" or not card.interval_seconds:
        return EASY_FIRST_SECONDS
    return min(MAX_INTERVAL_SECONDS, round(card.interval_seconds * EASY_FACTOR))


def preview_intervals(card: Flashcard) -> dict[str, int]:
    return {"hard": next_interval(card, "hard"), "easy": next_interval(card, "easy")}


def schedule_next(card: Flashcard, rating: str, now: datetime) -> int:
    """Cập nhật trạng thái lịch ôn của thẻ sau 1 lần chấm (`now` = giờ DB). Trả khoảng mới (giây)."""
    interval = next_interval(card, rating)
    card.interval_seconds = interval
    card.due_at = now + timedelta(seconds=interval)
    card.review_count += 1
    if rating == "hard":
        card.lapse_count += 1
    card.last_rating = rating
    card.last_reviewed_at = now
    return interval


def streak_days(db: Session, user_id: str) -> int:
    """Chuỗi ngày ôn liên tiếp (có >= 1 lần chấm thẻ/ngày), tính lùi từ hôm nay — hoặc từ hôm qua
    nếu hôm nay chưa ôn (chuỗi chưa bị đứt). Mốc ngày theo giờ DB như BR-08."""
    today = db.scalar(select(func.curdate()))
    days = db.scalars(
        select(func.date(FlashcardReview.reviewed_at))
        .where(FlashcardReview.user_id == user_id)
        .group_by(func.date(FlashcardReview.reviewed_at))
        .order_by(func.date(FlashcardReview.reviewed_at).desc())
        .limit(400)
    ).all()
    if not days:
        return 0
    expected = today if days[0] == today else today - timedelta(days=1)
    streak = 0
    for d in days:
        if d != expected:
            break
        streak += 1
        expected -= timedelta(days=1)
    return streak


def save_session(
    db: Session, fset: FlashcardSet, user: User, kind: str, duration_seconds: int, ratings: list[tuple[str, str]]
) -> tuple[FlashcardSession, list[tuple[Flashcard, str, int | None]]]:
    """Ghi 1 phiên ôn TRỌN VẸN trong 1 transaction (giờ DB): Dễ/Khó -> xếp lịch thẻ + 1 dòng
    flashcard_reviews gắn phiên; Bỏ qua -> không đổi lịch. Thẻ lặp lại trong `ratings` chỉ tính lần
    cuối. Nơi gọi đã kiểm mọi card_id thuộc bộ. Trả (phiên, [(thẻ, rating, khoảng mới | None)])."""
    cards = {c.id: c for c in fset.cards}
    final: dict[str, str] = {}
    for card_id, rating in ratings:
        final[card_id] = rating
    now: datetime = db.scalar(select(func.now()))
    last_no = db.scalar(
        select(func.coalesce(func.max(FlashcardSession.session_no), 0)).where(FlashcardSession.flashcard_set_id == fset.id)
    )
    counts = {r: sum(1 for v in final.values() if v == r) for r in ("easy", "hard", "skip")}
    session = FlashcardSession(
        flashcard_set_id=fset.id,
        user_id=user.id,
        session_no=last_no + 1,
        kind=kind,
        card_total=len(final),
        easy_count=counts["easy"],
        hard_count=counts["hard"],
        skip_count=counts["skip"],
        duration_seconds=duration_seconds,
        finished_at=now,
    )
    db.add(session)
    db.flush()
    out = []
    for card_id, rating in final.items():
        card = cards[card_id]
        interval = None
        if rating != "skip":
            interval = schedule_next(card, rating, now)
            db.add(FlashcardReview(
                flashcard_id=card.id, user_id=user.id, session_id=session.id, rating=rating,
                interval_seconds=interval, reviewed_at=now,
            ))
        out.append((card, rating, interval))
    db.commit()
    return session, out
