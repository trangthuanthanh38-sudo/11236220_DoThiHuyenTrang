"""UC-21 (Tạo bộ câu hỏi — Chế độ ôn tập) + UC-22 (Tạo đề thi thử): sinh 1 bộ câu hỏi trắc nghiệm
từ các nguồn (Chương / Tệp PDF) người học đã tick, lưu vào các bảng quiz_* (xem
database/studio_tools_quiz_schema.sql + _v2). 2 chế độ là generalization của "Tạo bộ câu hỏi" nên
dùng chung mọi bước (lấy chunk, gọi LLM, lọc, lưu); chỉ khác: ôn tập = 1 độ khó + dạng câu người học
chọn (generate_quiz_set), thi thử = câu 1 đáp án, độ khó rải 30/40/30 theo TỪNG câu, xáo thứ tự, có
giới hạn thời gian (generate_exam_set).

Nguyên tắc tiết kiệm quota (đây là lý do tách thành service riêng, không gộp vào chat.py):
  - ĐÚNG 1 lượt `generate_content` cho cả bộ câu hỏi (không gọi từng câu), ép đầu ra JSON theo
    `response_schema` để không phải gọi lại vì JSON hỏng.
  - KHÔNG gọi embedding API: người học đã chọn sẵn nguồn, nên đọc thẳng các chunk ĐÃ embed trong
    `embedding_chunks` theo chapter_id/document_id (khác Hỏi đáp tri thức phải embed câu hỏi để
    vector search). Chỉ lấy mẫu rải đều tối đa ~2 chunk/câu hỏi để chặn TPM.
  - Model riêng `settings.QUIZ_MODEL` (không ăn quota của chat), lỗi thì thử LẦN LƯỢT các model
    trong `settings.QUIZ_FALLBACK_MODEL` (danh sách phân tách bằng dấu phẩy);
    `quiz_sets.model_name` ghi model thật đã dùng. Hết model mà vẫn lỗi thì báo ĐÚNG loại lỗi
    (Google quá tải 503 / hết hạn mức theo phút / theo ngày 429) — xem _error_kind().
  - "Làm lại" đọc bộ câu hỏi từ DB, không đi qua service này.

Không raise khi LLM lỗi/không đủ nội dung: bộ câu hỏi chuyển `status='failed'` kèm
`error_message` cho người học đọc (cùng triết lý "không làm hỏng request" của chat.py).
"""
import html
import logging
import math
import random
import re
from typing import Literal

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.services import quota
from app.models import Chapter, EmbeddingChunk, PdfDocument, QuizQuestion, QuizQuestionCitation, \
    QuizQuestionOption, QuizSet, QuizSetSource, Subject, User

logger = logging.getLogger(__name__)

MAX_PRACTICE = 30  # khớp CHECK chk_quiz_sets_requested_count + "Tối đa 30 câu" (ôn tập)
MAX_EXAM = 50      # "Tối đa 50 câu" (thi thử, tối thiểu 5 — ép ở ExamCreateRequest + CHECK)
_MAX_EXAM_CHUNKS = 60  # 50 câu x 2 chunk thì prompt quá dài (TPM/độ trễ) -> chặn trần
_EXAM_EXTRA = 1.2      # xin dư ~20% câu để còn chỗ lọc câu hỏng mà vẫn đủ hạn ngạch từng mức
_CHUNKS_PER_QUESTION = 2
# Gợi ý "tối đa N câu" ở màn Tạo câu hỏi ôn tập: ~1 câu / 600 ký tự nội dung ĐÃ embed của nguồn.
# Đo thật: Chương ~3.100 ký tự -> Gemini sinh đủ 6/6 câu hợp lệ, không trùng (bản đầu để 1200 thì
# chỉ cho tối đa 2 câu — chặn oan). Chỉ để gợi ý/chặn ở giao diện; lúc sinh thật vẫn theo UC-21 E2
# (nguồn thiếu -> ít câu hơn, báo "giảm từ N xuống M").
_CHARS_PER_QUESTION = 600
_MIN_CHUNKS = 4
_OPTION_COUNT = 4  # giao diện thiết kế A/B/C/D
_DIFFICULTY_VI = {"easy": "Dễ", "medium": "Trung bình", "hard": "Khó"}
_WS_RE = re.compile(r"\s+")


# --- Khuôn JSON ép Gemini trả về (response_schema) -------------------------------------------
class _GenQuestion(BaseModel):
    question: str
    short: str                  # bản rút gọn cho "Xem lại từng câu"
    options: list[str]          # đúng 4 phương án
    correct: list[int]          # vị trí đáp án đúng, 0 = A
    explanation: str
    source_ref: str             # mã đoạn nguồn, vd. "S3"
    quote: str                  # câu trích NGUYÊN VĂN từ đoạn nguồn đó


class _GenQuiz(BaseModel):
    questions: list[_GenQuestion]


class _GenExamQuestion(_GenQuestion):
    difficulty: Literal["easy", "medium", "hard"]   # thi thử: độ khó theo TỪNG câu


class _GenExam(BaseModel):
    questions: list[_GenExamQuestion]


_SYSTEM_PROMPT = (
    "Bạn là giảng viên soạn đề trắc nghiệm ôn tập cho sinh viên Việt Nam. Chỉ được dùng thông tin "
    "trong các ĐOẠN NGUỒN được cung cấp (mỗi đoạn có mã dạng [S1], [S2]...) — tuyệt đối không dùng "
    "kiến thức bên ngoài, không bịa. Viết bằng đúng ngôn ngữ của đoạn nguồn (mặc định tiếng Việt).\n"
    "Yêu cầu cho MỖI câu hỏi:\n"
    f"• options: đúng {_OPTION_COUNT} phương án, khác nhau, phương án sai phải hợp lý (không lộ liễu).\n"
    "• correct: danh sách vị trí đáp án đúng (0 = A).\n"
    "• explanation: giải thích vì sao đáp án đúng, và vì sao các phương án sai là sai nếu cần.\n"
    "• source_ref: mã của đúng 1 đoạn nguồn chứa căn cứ cho câu hỏi.\n"
    "• quote: 1 câu/cụm trích NGUYÊN VĂN từ đoạn nguồn đó làm căn cứ (không diễn đạt lại).\n"
    "• short: câu hỏi rút gọn dưới 80 ký tự.\n"
    "Mã [S1], [S2]... chỉ dùng cho source_ref — KHÔNG nhắc tới mã này hay cụm \"đoạn nguồn\" "
    "trong question/options/explanation (người học không nhìn thấy các mã đó).\n"
    "Không tạo 2 câu hỏi trùng ý. Nếu nội dung nguồn không đủ cho số câu được yêu cầu, hãy tạo ÍT "
    "câu hơn thay vì lặp lại hay bịa thêm."
)


_MIXED_SYSTEM_PROMPT = _SYSTEM_PROMPT + (
    "\nGhi độ khó của từng câu vào trường difficulty (easy = nhớ/nhận biết, medium = hiểu/vận dụng, "
    "hard = phân tích, so sánh, kết hợp nhiều ý) và tạo đúng số câu mỗi mức được yêu cầu."
)


_EXAM_SYSTEM_PROMPT = _SYSTEM_PROMPT.replace(
    "soạn đề trắc nghiệm ôn tập", "soạn đề thi thử trắc nghiệm"
) + (
    "\nĐây là đề THI THỬ: mọi câu có ĐÚNG 1 đáp án đúng. Ghi độ khó của từng câu vào trường "
    "difficulty (easy = nhớ/nhận biết, medium = hiểu/vận dụng, hard = phân tích, so sánh, kết hợp "
    "nhiều ý) và tạo đúng số câu mỗi mức được yêu cầu."
)


def split_difficulty(n: int) -> tuple[int, int, int]:
    """Rải độ khó thi thử 30% dễ / 40% trung bình / 30% khó — khớp split() ở frontend ghichu_thithu.js."""
    easy = hard = math.floor(n * 0.3 + 0.5)  # làm tròn .5 lên như Math.round (round() của Python làm tròn chẵn)
    return easy, n - easy - hard, hard


def _label(chunk: EmbeddingChunk) -> tuple[str, int | None]:
    """(tên nguồn hiển thị, số trang) — snapshot lưu vào quiz_question_citations."""
    if chunk.source_type == "PDF" and chunk.document is not None:
        page = chunk.source_location.get("page") if isinstance(chunk.source_location, dict) else None
        return chunk.document.original_name, page
    if chunk.chapter is not None:
        return chunk.chapter.name, None
    return "Nguồn không xác định", None


def _source_label(source: Chapter | PdfDocument) -> str:
    return source.name if isinstance(source, Chapter) else source.original_name


def _sample_chunks(db: Session, sources: list[Chapter | PdfDocument], budget: int) -> list[EmbeddingChunk]:
    """Đọc chunk ĐÃ embed của từng nguồn (không gọi API nào), chia `budget` theo tỉ lệ số chunk
    mỗi nguồn (tối thiểu 1/nguồn) rồi lấy mẫu RẢI ĐỀU theo chunk_index — câu hỏi phủ cả tài liệu
    thay vì chỉ vài trang đầu."""
    per_source: list[list[EmbeddingChunk]] = []
    for src in sources:
        cond = (
            EmbeddingChunk.chapter_id == src.id if isinstance(src, Chapter) else EmbeddingChunk.document_id == src.id
        )
        per_source.append(
            db.scalars(select(EmbeddingChunk).where(cond).order_by(EmbeddingChunk.chunk_index)).all()
        )
    total = sum(len(c) for c in per_source)
    if total == 0:
        return []
    picked: list[EmbeddingChunk] = []
    for chunks in per_source:
        if not chunks:
            continue
        take = min(len(chunks), max(1, round(budget * len(chunks) / total)))
        step = len(chunks) / take
        picked.extend(chunks[int(i * step)] for i in range(take))
    return picked


def _build_prompt(chunks: list[EmbeddingChunk], count: int, difficulty: str, question_type: str) -> str:
    parts = []
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        where = f"{name}" + (f", trang {page}" if page else "")
        parts.append(f"[S{i}] ({where})\n{chunk.content}")
    type_rule = (
        "Mỗi câu có ĐÚNG 1 đáp án đúng."
        if question_type == "single"
        else f"Mỗi câu có TỪ 2 đến {_OPTION_COUNT - 1} đáp án đúng (người học phải chọn tất cả đáp án đúng)."
    )
    return (
        f"Hãy tạo {count} câu hỏi trắc nghiệm, độ khó: {_DIFFICULTY_VI[difficulty]}. {type_rule}\n\n"
        "ĐOẠN NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )


def _model_chain() -> list[str]:
    """QUIZ_MODEL rồi lần lượt các model trong QUIZ_FALLBACK_MODEL (phân tách bằng dấu phẩy), bỏ
    trùng — thứ tự thử khi model trước lỗi."""
    chain: list[str] = []
    for name in [settings.QUIZ_MODEL] + settings.QUIZ_FALLBACK_MODEL.split(","):
        name = name.strip()
        if name and name not in chain:
            chain.append(name)
    return chain


def _error_kind(exc: Exception) -> str:
    """Phân loại lỗi để báo ĐÚNG cho người học — trước đây mọi lỗi đều thành "quá tải hoặc hết lượt
    dùng", khiến 503 quá tải phía Google bị hiểu nhầm là hết quota."""
    if isinstance(exc, genai_errors.ServerError):
        return "overloaded"      # 500/503: máy chủ Google quá tải, không liên quan quota
    if isinstance(exc, genai_errors.ClientError) and getattr(exc, "code", None) == 429:
        return "quota_day" if "PerDay" in str(exc) else "quota_minute"
    return "other"               # 404 sai tên model, 400, JSON hỏng...


_ERROR_MESSAGES = {  # thứ tự ưu tiên khi các model trong chuỗi lỗi khác nhau
    "quota_day": "Đã hết hạn mức miễn phí trong ngày của Gemini API (phía Google) — vui lòng thử lại vào ngày mai.",
    "quota_minute": "Gọi AI quá nhiều trong thời gian ngắn (giới hạn theo phút của Gemini API) — vui lòng đợi khoảng 1 phút rồi thử lại.",
    "overloaded": "Máy chủ AI của Google đang quá tải (không phải do bạn hết lượt dùng) — vui lòng thử lại sau ít phút.",
    "other": "AI tạm thời không tạo được câu hỏi — vui lòng thử lại sau.",
}


def _call_llm(
    client: genai.Client, prompt: str, schema: type[BaseModel] = _GenQuiz, system: str = _SYSTEM_PROMPT
) -> tuple[BaseModel | None, str | None, str | None]:
    """Gọi lần lượt các model trong _model_chain() tới khi 1 model trả kết quả hợp lệ (quá tải 503,
    hết quota 429, sai tên model 404, JSON hỏng... đều chuyển sang model kế tiếp). Trả (kết quả,
    model đã dùng, thông báo lỗi cho người học khi MỌI model đều lỗi)."""
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        thinking_config=(
            types.ThinkingConfig(thinking_level=settings.QUIZ_THINKING_LEVEL.upper())
            if settings.QUIZ_THINKING_LEVEL
            else None
        ),
    )
    kinds: set[str] = set()
    for model in _model_chain():
        try:
            response = client.models.generate_content(model=model, contents=prompt, config=config)
            quota.add_usage(response)   # token cho báo cáo UC-37 (cả lượt model dự phòng)
            parsed = response.parsed
            if isinstance(parsed, schema):
                return parsed, model, None
            parsed = schema.model_validate_json(response.text or "")
            return parsed, model, None
        except Exception as exc:  # noqa: BLE001 — mọi lỗi đều chuyển sang model dự phòng
            kinds.add(_error_kind(exc))
            logger.warning("Sinh câu hỏi bằng %s lỗi: %s", model, exc)
    kind = next((k for k in _ERROR_MESSAGES if k in kinds), "other")
    return None, None, _ERROR_MESSAGES[kind]


def _norm(text: str) -> str:
    return _WS_RE.sub(" ", text).strip().lower()


# Mã nội bộ "[S1]" — cả dạng không ngoặc khi đi sau "theo"/"đoạn nguồn" ("Theo S1, ...").
_REF_RE = re.compile(
    r"\s*\(?(?:(?:theo\s+)?(?:đoạn nguồn\s*)?\[S\d+\]|theo\s+(?:đoạn nguồn\s*)?S\d+\b|đoạn nguồn\s*S\d+\b)\)?,?",
    re.IGNORECASE,
)


def _clean(text: str) -> str:
    """Phòng khi model vẫn lộ mã nội bộ "[S1]" vào nội dung hiển thị cho người học."""
    out = _WS_RE.sub(" ", _REF_RE.sub("", text)).strip()
    if out and out != text.strip() and text.strip()[:1].isupper():
        out = out[0].upper() + out[1:]  # "Theo S1, nền kinh tế..." -> "Nền kinh tế..."
    return out


def _valid_questions(
    raw: list[_GenQuestion], refs: dict[str, EmbeddingChunk], question_type: str, limit: int
) -> list[tuple[_GenQuestion, EmbeddingChunk]]:
    """UC-21 E1: lọc câu không hợp lệ/trùng lặp thay vì lưu câu hỏi sai. Ràng buộc "single = đúng
    1, multi >= 2 đáp án đúng" không ép được bằng CHECK ở DB nên kiểm ở đây."""
    kept: list[tuple[_GenQuestion, EmbeddingChunk]] = []
    seen: set[str] = set()
    for q in raw:
        options = [o.strip() for o in q.options]
        correct = sorted(set(q.correct))
        chunk = refs.get(q.source_ref.strip().strip("[]").upper())
        if (
            not q.question.strip()
            or not q.explanation.strip()
            or len(options) != _OPTION_COUNT
            or any(not o for o in options)
            or len({_norm(o) for o in options}) != _OPTION_COUNT
            or not correct
            or any(i < 0 or i >= _OPTION_COUNT for i in correct)
            or (question_type == "single" and len(correct) != 1)
            or (question_type == "multi" and not 2 <= len(correct) < _OPTION_COUNT)
            or chunk is None
            or _norm(q.question) in seen
        ):
            continue
        seen.add(_norm(q.question))
        q.options, q.correct = options, correct
        kept.append((q, chunk))
        if len(kept) == limit:
            break
    return kept


def _quote_for(q: _GenQuestion, chunk: EmbeddingChunk) -> str:
    """Chỉ tin câu trích của LLM khi nó thật sự nằm trong đoạn nguồn (BR-09 — trích dẫn phải có
    thật); ngược lại lấy đoạn đầu của chunk làm căn cứ."""
    quote = html.unescape(q.quote).strip().strip('"“”')
    source = html.unescape(chunk.content)  # chunk Chương cũ (trước html_to_text) còn "&nbsp;"
    if quote and _norm(quote) in _norm(source):
        return quote
    return source[:300].strip() + ("…" if len(source) > 300 else "")


def _new_quiz_set(
    db: Session, user: User, subject: Subject, sources: list[Chapter | PdfDocument], title: str | None, **fields
) -> QuizSet:
    """Tạo dòng quiz_sets (status 'generating') + quiz_set_sources, flush để có id."""
    quiz = QuizSet(
        user_id=user.id,
        subject_id=subject.id,
        title=(title or (_source_label(sources[0]) if len(sources) == 1 else subject.name))[:200],
        status="generating",
        **fields,
    )
    quiz.sources = [
        QuizSetSource(
            source_type="CHAPTER" if isinstance(s, Chapter) else "PDF",
            chapter_id=s.id if isinstance(s, Chapter) else None,
            document_id=s.id if isinstance(s, PdfDocument) else None,
            source_label=_source_label(s)[:255],
        )
        for s in sources
    ]
    db.add(quiz)
    db.flush()
    return quiz


def _fail(db: Session, quiz: QuizSet, message: str) -> QuizSet:
    quiz.status, quiz.error_message = "failed", message[:500]
    db.commit()
    return quiz


def _generate(
    db: Session, quiz: QuizSet, sources: list[Chapter | PdfDocument], budget: int, build_prompt, schema, system
):
    """Bước chung: lấy chunk đã embed (không gọi embedding API) -> 1 lượt gọi LLM. Trả (chunks, kết quả),
    hoặc (None, None) khi đã đánh dấu quiz 'failed'."""
    chunks = _sample_chunks(db, sources, budget)
    if not chunks:  # BR-07
        _fail(db, quiz, "Các nguồn đã chọn chưa có nội dung nào sẵn sàng cho AI (chưa lưu nội dung, "
                        "hoặc tệp không trích được chữ).")
        return None, None
    if not settings.GEMINI_API_KEY:
        _fail(db, quiz, "Chưa cấu hình GEMINI_API_KEY nên chưa tạo được câu hỏi.")
        return None, None
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    result, model_used, error = _call_llm(client, build_prompt(chunks), schema, system)
    if result is None:
        _fail(db, quiz, error or "AI không trả về câu hỏi nào.")
        return None, None
    quiz.model_name = model_used
    return chunks, result


def _save_questions(
    db: Session, quiz: QuizSet, kept: list[tuple[_GenQuestion, EmbeddingChunk]], question_type: str, difficulty_of
) -> QuizSet:
    """Lưu câu hỏi + phương án + trích dẫn (BR-09) theo thứ tự `kept`, chốt status='ready'."""
    for position, (q, chunk) in enumerate(kept, start=1):
        name, page = _label(chunk)
        quiz.questions.append(
            QuizQuestion(
                position=position,
                question_type=question_type,
                difficulty=difficulty_of(q),
                question_text=_clean(q.question),
                short_text=_clean(q.short)[:255] or None,
                explanation=_clean(q.explanation),
                options=[
                    QuizQuestionOption(position=i, content=_clean(o), is_correct=i in q.correct)
                    for i, o in enumerate(q.options)
                ],
                citations=[
                    QuizQuestionCitation(
                        source_type="PDF" if chunk.source_type == "PDF" else "CHAPTER",
                        chapter_id=chunk.chapter_id,
                        document_id=chunk.document_id,
                        embedding_chunk_id=chunk.id,
                        source_label=name[:255],
                        page_number=page,
                        quote=_quote_for(q, chunk),
                    )
                ],
            )
        )
    quiz.question_count = len(kept)
    quiz.status = "ready"
    db.commit()
    return quiz


_NO_VALID = "Không tạo được câu hỏi hợp lệ từ nội dung đã chọn — hãy chọn thêm nguồn hoặc thử lại."


def source_stats(db: Session, sources: list[Chapter | PdfDocument], mode: str = "practice") -> dict:
    """Độ dài nội dung ĐÃ embed của các nguồn (không gọi API nào) -> "n nguồn · x từ" + gợi ý / tối đa
    số câu ở màn Tạo câu hỏi ôn tập. 0 chunk = nguồn chưa sẵn sàng cho AI (BR-07)."""
    chapter_ids = [s.id for s in sources if isinstance(s, Chapter)]
    document_ids = [s.id for s in sources if not isinstance(s, Chapter)]
    conds = []
    if chapter_ids:
        conds.append(EmbeddingChunk.chapter_id.in_(chapter_ids))
    if document_ids:
        conds.append(EmbeddingChunk.document_id.in_(document_ids))
    contents = db.scalars(select(EmbeddingChunk.content).where(or_(*conds))).all() if conds else []
    chars = sum(len(c) for c in contents)
    words = sum(len(c.split()) for c in contents)
    if mode == "flashcard":  # UC-23 dùng chung endpoint: "chỉ đủ khái niệm cho tối đa N thẻ"
        from app.services.flashcard_generation import CHARS_PER_CARD, MAX_CARDS
        cap, per = MAX_CARDS, CHARS_PER_CARD
    else:
        cap, per = (MAX_EXAM if mode == "exam" else MAX_PRACTICE), _CHARS_PER_QUESTION
    max_q = min(cap, chars // per) if contents else 0
    if mode in ("mindmap", "summary"):  # UC-25 / UC-24 không có ô số lượng — giao diện chỉ dùng word_count (0 = chưa sẵn sàng, BR-07)
        max_q = 1 if contents else 0
    if contents and max_q == 0:
        max_q = 1  # nguồn rất ngắn vẫn tạo được 1 câu
    return {
        "chunk_count": len(contents),
        "char_count": chars,
        "word_count": words,
        "max_questions": max_q,
        "suggested_min": max(1, max_q - (6 if mode == "flashcard" else 4)) if max_q else 0,
    }


def _build_mixed_prompt(chunks: list[EmbeddingChunk], quotas: tuple[int, int, int], question_type: str) -> str:
    parts = []
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        parts.append(f"[S{i}] ({name}" + (f", trang {page}" if page else "") + f")\n{chunk.content}")
    easy, medium, hard = (max(1, round(n * _EXAM_EXTRA)) if n else 0 for n in quotas)
    type_rule = (
        "Mỗi câu có ĐÚNG 1 đáp án đúng."
        if question_type == "single"
        else f"Mỗi câu có TỪ 2 đến {_OPTION_COUNT - 1} đáp án đúng (người học phải chọn tất cả đáp án đúng)."
    )
    return (
        f"Hãy tạo {easy + medium + hard} câu hỏi trắc nghiệm ôn tập: {easy} câu difficulty=easy, "
        f"{medium} câu difficulty=medium, {hard} câu difficulty=hard. {type_rule} "
        "Rải câu hỏi đều trên các đoạn nguồn.\n\nĐOẠN NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )


def generate_quiz_set(
    db: Session,
    user: User,
    subject: Subject,
    sources: list[Chapter | PdfDocument],
    requested_count: int,
    difficulty: str | None,
    question_type: str,
    title: str | None = None,
    quotas: tuple[int, int, int] | None = None,
    show_answer: bool = True,
    show_explanation: bool = True,
    show_citation: bool = True,
) -> QuizSet:
    """Tạo + lưu 1 bộ câu hỏi chế độ ôn tập. Nơi gọi (router) phải kiểm trước: BR-05 (mọi nguồn
    thuộc `subject` của `user`), requested_count trong 1..30, difficulty/question_type hợp lệ.
    `quotas` = (dễ, trung bình, khó) cộng lại = requested_count -> bộ "hỗn hợp" (difficulty=NULL,
    độ khó theo TỪNG câu, xin dư ~20% rồi giữ đúng hạn ngạch như thi thử); không có thì cả bộ 1 mức
    `difficulty`. Luôn trả QuizSet đã commit: `status='ready'` (question_count có thể <
    requested_count — UC-21 E2) hoặc `status='failed'` kèm `error_message`."""
    quiz = _new_quiz_set(
        db, user, subject, sources, title,
        mode="practice", requested_count=requested_count, difficulty=None if quotas else difficulty,
        question_type=question_type,
        show_answer=show_answer, show_explanation=show_explanation, show_citation=show_citation,
    )
    budget = max(_MIN_CHUNKS, requested_count * _CHUNKS_PER_QUESTION)
    if quotas:
        chunks, result = _generate(
            db, quiz, sources, budget,
            lambda c: _build_mixed_prompt(c, quotas, question_type), _GenExam, _MIXED_SYSTEM_PROMPT,
        )
    else:
        chunks, result = _generate(
            db, quiz, sources, budget,
            lambda c: _build_prompt(c, requested_count, difficulty, question_type), _GenQuiz, _SYSTEM_PROMPT,
        )
    if result is None:
        return quiz
    refs = {f"S{i}": c for i, c in enumerate(chunks, start=1)}
    if quotas:
        kept = _pick_by_difficulty(
            _valid_questions(result.questions, refs, question_type, len(result.questions)), quotas
        )
        random.shuffle(kept)  # _pick_by_difficulty xếp theo mức — trộn để câu khó không dồn về cuối
    else:
        kept = _valid_questions(result.questions, refs, question_type, requested_count)
    if not kept:
        return _fail(db, quiz, _NO_VALID)
    return _save_questions(db, quiz, kept, question_type, (lambda q: q.difficulty) if quotas else (lambda q: difficulty))


def _build_exam_prompt(chunks: list[EmbeddingChunk], quotas: tuple[int, int, int]) -> str:
    parts = []
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        parts.append(f"[S{i}] ({name}" + (f", trang {page}" if page else "") + f")\n{chunk.content}")
    easy, medium, hard = (max(1, round(n * _EXAM_EXTRA)) if n else 0 for n in quotas)
    return (
        f"Hãy tạo đề thi thử gồm {easy + medium + hard} câu hỏi trắc nghiệm, mỗi câu ĐÚNG 1 đáp án đúng: "
        f"{easy} câu difficulty=easy, {medium} câu difficulty=medium, {hard} câu difficulty=hard. "
        "Rải câu hỏi đều trên các đoạn nguồn.\n\nĐOẠN NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )


def _pick_by_difficulty(
    kept: list[tuple[_GenExamQuestion, EmbeddingChunk]], quotas: tuple[int, int, int]
) -> list[tuple[_GenExamQuestion, EmbeddingChunk]]:
    """Giữ đúng hạn ngạch từng mức; mức nào thiếu thì bù bằng câu dư của mức khác (tổng vẫn <= n)."""
    picked, rest = [], []
    for level, quota in zip(("easy", "medium", "hard"), quotas):
        same = [x for x in kept if x[0].difficulty == level]
        picked.extend(same[:quota])
        rest.extend(same[quota:])
    picked.extend(rest[: max(0, sum(quotas) - len(picked))])
    return picked


def generate_exam_set(
    db: Session,
    user: User,
    subject: Subject,
    sources: list[Chapter | PdfDocument],
    requested_count: int,
    time_limit_seconds: int,
    title: str | None = None,
    quotas: tuple[int, int, int] | None = None,
) -> QuizSet:
    """Tạo + lưu 1 đề thi thử (UC-22): mode='exam', câu 1 đáp án, độ khó rải 30/40/30 theo từng câu
    (quiz_sets.difficulty = NULL), thứ tự câu xáo sẵn trong DB (đề chỉ làm 1 lần). Nơi gọi phải kiểm
    BR-05 + requested_count 5..50. Luôn trả QuizSet đã commit: 'ready' (question_count có thể <
    requested_count — "giảm từ N xuống M câu") hoặc 'failed' kèm error_message."""
    quiz = _new_quiz_set(
        db, user, subject, sources, title,
        mode="exam", requested_count=requested_count, difficulty=None, question_type="single",
        time_limit_seconds=time_limit_seconds,
    )
    quotas = quotas or split_difficulty(requested_count)  # "Tự điều chỉnh" ở giao diện, không thì 30/40/30
    budget = min(_MAX_EXAM_CHUNKS, max(_MIN_CHUNKS, requested_count * _CHUNKS_PER_QUESTION))
    chunks, result = _generate(
        db, quiz, sources, budget, lambda c: _build_exam_prompt(c, quotas), _GenExam, _EXAM_SYSTEM_PROMPT
    )
    if result is None:
        return quiz
    refs = {f"S{i}": c for i, c in enumerate(chunks, start=1)}
    kept = _pick_by_difficulty(_valid_questions(result.questions, refs, "single", len(result.questions)), quotas)
    if not kept:
        return _fail(db, quiz, _NO_VALID)
    random.shuffle(kept)
    return _save_questions(db, quiz, kept, "single", lambda q: q.difficulty)
