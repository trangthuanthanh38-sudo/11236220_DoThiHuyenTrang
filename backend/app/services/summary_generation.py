"""UC-24 (Tạo bản tóm tắt theo chương): sinh bản tóm tắt của ĐÚNG 1 nguồn (Chương hoặc Tệp PDF) và lưu vào các
bảng summary_* (database/studio_tools_summary_schema.sql).

Dùng lại các bước chung của quiz_generation.py (cùng triết lý tiết kiệm quota như Flashcard / Sơ đồ tư duy): lấy
mẫu chunk ĐÃ embed của nguồn (không gọi embedding API), ĐÚNG 1 lượt `generate_content` với `response_schema`,
chuỗi model QUIZ_MODEL -> QUIZ_FALLBACK_MODEL, báo đúng loại lỗi. KHÁC các công cụ kia: bước gọi AI (run()) KHÔNG
ghi gì vào DB — "Tạo lại" ghi đè tại chỗ nên khi AI lỗi phải giữ nguyên bản cũ (không được đánh dấu 'failed' như
_generate()). Lưu là bước riêng (save()) chạy trong 1 transaction.

Khuôn kết quả: các MỤC có tiêu đề (kind general / definition / number / example — khớp 3 công tắc "Giữ lại"), mỗi
mục gồm các Ý, mỗi ý 1 câu hoàn chỉnh (Định dạng "Đoạn văn" chỉ là nối các ý của 1 mục) + trích dẫn (BR-09) nguyên
văn từ đúng đoạn nguồn (_quote_for).

"Nội dung gốc đã thay đổi": source_hash() = SHA-256 nội dung nguồn (Chương: chapters.content_text; PDF: nội dung
chunk theo thứ tự — PDF không sửa được nên không bao giờ "đã thay đổi").
"""
import hashlib
import html
import re
from dataclasses import dataclass, field

from google import genai
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Chapter, EmbeddingChunk, PdfDocument, Summary, SummaryGeneration, SummaryPoint, SummarySection
from app.services.quiz_generation import _call_llm, _clean, _label, _norm, _sample_chunks, _source_label

MIN_WORDS = 500   # UC-24 E1 — khớp MIN_WORDS ở frontend/js/ghichu_tomtat.js
# Độ dài -> (số ý tối thiểu gợi ý, trần số ý lưu lại, số chunk đưa cho AI)
LENGTHS = {"short": (5, 7, 12), "medium": (10, 15, 24), "long": (20, 30, 40)}
KINDS = ("general", "definition", "number", "example")
_DEFAULT_HEADING = {
    "general": "Ý chính", "definition": "Định nghĩa quan trọng",
    "number": "Công thức, số liệu", "example": "Ví dụ minh họa",
}
_KIND_ALIASES = {"definitions": "definition", "numbers": "number", "formula": "number", "examples": "example"}
_MAX_POINT = 1000
_WS = re.compile(r"\s+")
_WORD = re.compile(r"\w{2,}")
_SENTENCE = re.compile(r"(?<=[.!?…])\s+")


# --- Khuôn JSON ép Gemini trả về (response_schema) -------------------------------------------
class _GenPoint(BaseModel):
    content: str      # 1 câu hoàn chỉnh
    source_ref: str   # mã đoạn nguồn, vd. "S3"
    quote: str        # câu trích NGUYÊN VĂN từ đoạn nguồn đó


class _GenSection(BaseModel):
    heading: str
    kind: str         # general | definition | number | example
    points: list[_GenPoint]


class _GenSummary(BaseModel):
    sections: list[_GenSection]


_SYSTEM_PROMPT = (
    "Bạn là giảng viên viết BẢN TÓM TẮT giúp sinh viên Việt Nam ôn tập nhanh trước kỳ thi. Chỉ được dùng thông tin "
    "trong các ĐOẠN NGUỒN được cung cấp (mỗi đoạn có mã dạng [S1], [S2]...) — tuyệt đối không dùng kiến thức bên "
    "ngoài, không bịa. Viết bằng đúng ngôn ngữ của đoạn nguồn (mặc định tiếng Việt).\n"
    "Bản tóm tắt gồm các MỤC có tiêu đề ngắn, đi theo trình tự của tài liệu. Mỗi mục có `kind`:\n"
    "• general — ý chính, khái niệm, nội dung cốt lõi;\n"
    "• definition — định nghĩa / thuật ngữ quan trọng;\n"
    "• number — công thức, số liệu, mốc thời gian, con số cần nhớ;\n"
    "• example — ví dụ minh họa.\n"
    "Mỗi ý (point) là ĐÚNG 1 câu hoàn chỉnh, ngắn gọn, tự đứng được (để có thể nối các ý của 1 mục thành 1 đoạn "
    "văn), không đánh số, không gạch đầu dòng. Mỗi ý có source_ref = mã của đúng 1 đoạn nguồn chứa căn cứ và quote = "
    "1 câu/cụm trích NGUYÊN VĂN từ đoạn đó (không diễn đạt lại). Mã [S1]... chỉ dùng cho source_ref — KHÔNG nhắc mã "
    "hay cụm \"đoạn nguồn\" trong tiêu đề hay nội dung. Không lặp lại cùng 1 ý."
)


@dataclass
class Result:
    sections: list[tuple[str, str, list[tuple[str, EmbeddingChunk, str]]]] = field(default_factory=list)
    model: str = ""

    @property
    def point_count(self) -> int:
        return sum(len(points) for _, _, points in self.sections)


# --- Nguồn: độ dài + mã băm --------------------------------------------------------------------
def _source_cond(source: Chapter | PdfDocument):
    return EmbeddingChunk.chapter_id == source.id if isinstance(source, Chapter) else EmbeddingChunk.document_id == source.id


def word_count(db: Session, source: Chapter | PdfDocument) -> int:
    """Số từ của nội dung ĐÃ embed (cùng cách đếm với /quiz/source-stats) — UC-24 E1."""
    contents = db.scalars(select(EmbeddingChunk.content).where(_source_cond(source))).all()
    return sum(len(c.split()) for c in contents)


def hash_text(text: str | None) -> str:
    return hashlib.sha256(_WS.sub(" ", text or "").strip().encode("utf-8")).hexdigest()


def source_hash(db: Session, source: Chapter | PdfDocument) -> str:
    if isinstance(source, Chapter):
        return hash_text(source.content_text)
    contents = db.scalars(
        select(EmbeddingChunk.content).where(_source_cond(source)).order_by(EmbeddingChunk.chunk_index)
    ).all()
    return hash_text("\n".join(contents))


# --- Gọi AI -------------------------------------------------------------------------------------
def _build_prompt(chunks: list[EmbeddingChunk], source: Chapter | PdfDocument, length: str,
                  keep_definitions: bool, keep_numbers: bool, keep_examples: bool) -> str:
    lo, hi, _ = LENGTHS[length]
    parts = []
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        # Giải mã "&nbsp;"/"&amp;" còn sót trong content_text để AI chép được câu nguyên văn (xem _quote()).
        parts.append(f"[S{i}] ({name}" + (f", trang {page}" if page else "") + f")\n{html.unescape(chunk.content)}")
    rules = [
        f"Tổng cộng khoảng {lo}-{hi} ý (KHÔNG quá {hi} ý), chia thành vài mục theo bố cục tài liệu.",
        "Có 1 mục kind=definition tiêu đề \"Định nghĩa quan trọng\" gom các định nghĩa / thuật ngữ then chốt."
        if keep_definitions else "KHÔNG tạo mục kind=definition.",
        "Giữ lại công thức, số liệu, mốc thời gian quan trọng (có thể gom vào mục kind=number)."
        if keep_numbers else "KHÔNG đưa công thức, con số, số liệu cụ thể vào bản tóm tắt; KHÔNG tạo mục kind=number.",
        "Có 1 mục kind=example tiêu đề \"Ví dụ minh họa\" gồm các ví dụ có trong tài liệu (nếu tài liệu có)."
        if keep_examples else "KHÔNG đưa ví dụ minh họa; KHÔNG tạo mục kind=example.",
    ]
    return (
        f"Tóm tắt tài liệu \"{_source_label(source)}\".\n" + "\n".join("- " + r for r in rules)
        + "\n\nĐOẠN NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )


def _quote(p: _GenPoint, content: str, chunk: EmbeddingChunk) -> str:
    """Trích dẫn (BR-09) phải là câu CÓ THẬT trong đoạn nguồn. Khác _quote_for() dùng chung: chunk của Chương được cắt
    từ chapters.content_text còn nguyên thực thể HTML ("&nbsp;", "&amp;") nên giải mã cả 2 phía trước khi so; câu AI
    đưa không khớp nguyên văn thì chọn câu của chunk trùng nhiều từ nhất với ý (thay vì lấy đầu chunk — đầu chunk
    thường là tiêu đề / câu không liên quan, cột "Nội dung gốc" sẽ tô sai đoạn)."""
    source = _WS.sub(" ", html.unescape(chunk.content)).strip()
    quote = _WS.sub(" ", html.unescape(p.quote)).strip().strip('"“”').strip()
    if quote and _norm(quote) in _norm(source):
        return quote
    words = set(_WORD.findall(_norm(content + " " + quote)))
    sentences = [s.strip() for s in _SENTENCE.split(source) if len(s.strip()) > 15] or [source]
    best = max(sentences, key=lambda s: len(words & set(_WORD.findall(_norm(s)))))
    return best[:400] + ("…" if len(best) > 400 else "")


def _valid(raw: _GenSummary, refs: dict[str, EmbeddingChunk], length: str,
           keep_definitions: bool, keep_numbers: bool, keep_examples: bool) -> list:
    """Lọc mục/ý hỏng: kind lạ -> general, mục bị công tắc tắt -> bỏ, ý rỗng/trùng/mã nguồn lạ -> bỏ (không trích
    dẫn được thì không lưu — BR-09), cắt tổng số ý theo trần độ dài, bỏ mục rỗng."""
    off = {k for k, on in (("definition", keep_definitions), ("number", keep_numbers), ("example", keep_examples)) if not on}
    limit = LENGTHS[length][1]
    seen: set[str] = set()
    out, total = [], 0
    for sec in raw.sections:
        kind = _KIND_ALIASES.get(sec.kind.strip().lower(), sec.kind.strip().lower())
        if kind not in KINDS:
            kind = "general"
        if kind in off:
            continue
        points = []
        for p in sec.points:
            if total >= limit:
                break
            content = _clean(p.content).strip(" -•*").strip()[:_MAX_POINT]
            chunk = refs.get(p.source_ref.strip().strip("[]").upper())
            if not content or chunk is None or _norm(content) in seen:
                continue
            seen.add(_norm(content))
            points.append((content, chunk, _quote(p, content, chunk)))
            total += 1
        if points:
            heading = _clean(sec.heading).strip(" -•*:").strip()[:255] or _DEFAULT_HEADING[kind]
            out.append((heading, kind, points))
    return out


def run(db: Session, source: Chapter | PdfDocument, length: str, keep_definitions: bool, keep_numbers: bool,
        keep_examples: bool) -> tuple[Result | None, str | None]:
    """1 lượt gọi AI, KHÔNG ghi DB. Trả (Result, None) hoặc (None, thông báo lỗi cho người học)."""
    chunks = _sample_chunks(db, [source], LENGTHS[length][2])
    if not chunks:  # BR-07
        return None, ("Nguồn đã chọn chưa có nội dung nào sẵn sàng cho AI (chưa lưu nội dung, hoặc tệp không trích "
                      "được chữ).")
    if not settings.GEMINI_API_KEY:
        return None, "Chưa cấu hình GEMINI_API_KEY nên chưa tạo được bản tóm tắt."
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    prompt = _build_prompt(chunks, source, length, keep_definitions, keep_numbers, keep_examples)
    parsed, model, error = _call_llm(client, prompt, _GenSummary, _SYSTEM_PROMPT)
    if parsed is None:
        return None, (error or "AI không trả về bản tóm tắt.").replace("câu hỏi", "bản tóm tắt")
    refs = {f"S{i}": c for i, c in enumerate(chunks, start=1)}
    sections = _valid(parsed, refs, length, keep_definitions, keep_numbers, keep_examples)
    if not sections:
        return None, "Không tạo được bản tóm tắt hợp lệ từ nội dung đã chọn — hãy thử lại."
    return Result(sections=sections, model=model or ""), None


# --- Lưu ------------------------------------------------------------------------------------------
def save(db: Session, summary: Summary, source: Chapter | PdfDocument, result: Result, kind: str) -> None:
    """Ghi (đè) toàn bộ mục/ý của `summary` trong 1 transaction + 1 dòng summary_generations (BR-08), rồi commit.
    `summary` phải đã có id (flush). Xoá mục cũ bằng SQL để DB cascade các ý (FK ghép ON DELETE CASCADE)."""
    db.execute(delete(SummarySection).where(SummarySection.summary_id == summary.id))
    db.expire(summary, ["sections"])
    for s_pos, (heading, sec_kind, points) in enumerate(result.sections, start=1):
        section = SummarySection(summary_id=summary.id, position=s_pos, heading=heading, kind=sec_kind)
        db.add(section)
        db.flush()
        for p_pos, (content, chunk, quote) in enumerate(points, start=1):
            db.add(SummaryPoint(
                summary_id=summary.id, section_id=section.id, position=p_pos, content=content,
                embedding_chunk_id=chunk.id, page_number=_label(chunk)[1], quote=quote,
            ))
    summary.model_name = result.model
    summary.source_text_hash = source_hash(db, source)
    summary.source_word_count = word_count(db, source)
    summary.status, summary.error_message = "ready", None
    summary.generated_at = func.now()
    summary.updated_at = func.now()
    db.add(SummaryGeneration(summary_id=summary.id, user_id=summary.user_id, kind=kind, model_name=result.model))
    db.commit()
