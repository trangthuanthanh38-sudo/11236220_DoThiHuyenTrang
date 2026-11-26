"""Bước 3 lộ trình RAG (UC-19->25, xem .claude/rules/08-ai-studio.md): pipeline chunking +
embedding cho nội dung Chương (`chapters.content_text`) và PDF (`text_extraction.
extract_pdf_pages`), ghi vào bảng `embedding_chunks` (database/studio_rag_schema.sql +
studio_rag_schema_v2.sql). Được gọi từ `routers/knowledge.py` mỗi khi Chương/PDF được
lưu/tải lên (xem `reembed_chapter`/`reembed_pdf`), hoặc chạy thủ công toàn bộ backfill qua
`python -m app.services.embeddings` (vd. sau khi đổi `settings.EMBEDDING_MODEL`).

Nguyên tắc "dễ đổi model" (yêu cầu tường minh của người dùng khi giao Bước 3): CHỈ
`_embed_batch()` là hàm DUY NHẤT trong toàn bộ codebase gọi embedding API thật. Đổi
model/provider sau này chỉ cần sửa đúng hàm đó + `settings.EMBEDDING_MODEL`, không đụng gì
tới chunking hay các điểm gọi vào pipeline ở `knowledge.py`.

Ranh giới rõ ràng: pipeline này CHƯA làm vector search/cosine similarity (Bước 4), CHƯA nối
vào luồng trả lời của `routers/chat.py` (Bước 4), CHƯA có UI chọn phạm vi Môn học/Chương đầy
đủ (Bước 5 — UC-19). Lỗi API/chưa có `GEMINI_API_KEY`/lỗi mạng đều KHÔNG raise — coi như
"chưa embed được", không chặn việc lưu Chương/tải PDF (đúng triết lý đã dùng cho OCR ở
`text_extraction.py`).
"""
import re
import sys
import threading
import time
from pathlib import Path

import numpy as np
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Chapter, EmbeddingChunk, PdfDocument
from app.services import text_extraction

_CHUNK_SIZE_CHARS = 2_000
_CHUNK_OVERLAP_CHARS = 200
# Số đoạn/1 lượt gọi API — CHƯA verify giới hạn thật của Gemini Developer API qua 1 lượt gọi
# thật, chỉ mới verify đúng chữ ký hàm. Test với batch nhỏ trước khi chạy backfill số lượng
# lớn (reembed_all()).
_EMBEDDING_BATCH_SIZE = 100
_EMBEDDING_MAX_ATTEMPTS = 2  # 1 lần gọi + 1 lần thử lại — chỉ cho lỗi 503, cùng khuôn chat.py

_PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n")


def chunk_text(
    text: str, chunk_size: int = _CHUNK_SIZE_CHARS, overlap: int = _CHUNK_OVERLAP_CHARS
) -> list[str]:
    """Gộp các đoạn văn (tách bằng dòng trống) lại tới gần `chunk_size` ký tự — giữ nguyên
    ranh giới đoạn văn khi có thể (embedding theo đoạn ý trọn vẹn cho kết quả tốt hơn cắt
    cứng giữa câu). Đoạn văn đơn dài hơn `chunk_size` (hiếm nhưng có thể xảy ra) bị cắt cứng
    thành nhiều mảnh có `overlap` ký tự chồng lấp để không mất ngữ cảnh ở ranh giới cắt.
    Không thêm dependency ngoài (không langchain/tiktoken) — đủ dùng cho văn bản tiếng Việt/
    Anh thông thường của Chương/PDF trong dự án này."""
    text = text.strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in _PARAGRAPH_SPLIT_RE.split(text) if p.strip()]
    if not paragraphs:
        paragraphs = [text]

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) <= chunk_size:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        if len(para) <= chunk_size:
            current = para
            continue
        # 1 đoạn văn đơn dài hơn chunk_size -> cắt cứng có overlap.
        start = 0
        while start < len(para):
            end = start + chunk_size
            chunks.append(para[start:end])
            start = end if end >= len(para) else end - overlap
    if current:
        chunks.append(current)
    return chunks


_embedding_client: genai.Client | None = None
_embedding_client_checked = False


def _get_embedding_client() -> genai.Client | None:
    """Tạo lười + cache lại 1 client dùng chung cho cả process — cùng khuôn
    `_get_gemini_client()` ở `routers/chat.py` (dùng chung 1 `GEMINI_API_KEY`, khác
    `GEMINI_MODEL`/`EMBEDDING_MODEL`). Trả None nếu chưa cấu hình key."""
    global _embedding_client, _embedding_client_checked
    if not _embedding_client_checked:
        _embedding_client_checked = True
        if settings.GEMINI_API_KEY:
            _embedding_client = genai.Client(api_key=settings.GEMINI_API_KEY)
    return _embedding_client


def _embed_batch(client: genai.Client, texts: list[str], task_type: str) -> list[list[float]] | None:
    """DUY NHẤT hàm gọi embedding API thật trong toàn bộ codebase — xem docstring đầu file.
    Trả None (không raise) nếu lỗi API sau khi đã thử lại — nơi gọi coi cả batch là "chưa
    embed được"."""
    for attempt in range(1, _EMBEDDING_MAX_ATTEMPTS + 1):
        try:
            response = client.models.embed_content(
                model=settings.EMBEDDING_MODEL,
                contents=texts,
                config=types.EmbedContentConfig(task_type=task_type),
            )
            if not response.embeddings:
                return None
            return [e.values for e in response.embeddings]
        except genai_errors.ServerError:
            if attempt == _EMBEDDING_MAX_ATTEMPTS:
                return None
            time.sleep(1)  # lỗi 503 tạm thời, cùng cách xử lý với chat.py
        except Exception:
            return None
    return None


def generate_embeddings(texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT") -> list[list[float]] | None:
    """Entrypoint công khai — tự chia batch, gọi `_embed_batch()`. Trả None nếu chưa cấu
    hình `GEMINI_API_KEY` hoặc bất kỳ batch nào lỗi (không raise, không trả kết quả nửa vời
    lẫn model cũ/mới); trả `[]` nếu `texts` rỗng."""
    if not texts:
        return []
    client = _get_embedding_client()
    if client is None:
        return None
    vectors: list[list[float]] = []
    for i in range(0, len(texts), _EMBEDDING_BATCH_SIZE):
        batch_vectors = _embed_batch(client, texts[i : i + _EMBEDDING_BATCH_SIZE], task_type)
        if batch_vectors is None:
            return None
        vectors.extend(batch_vectors)
    return vectors


def search_similar_chunks(
    db: Session,
    user_id: str,
    query_vector: list[float],
    top_k: int = None,
    min_similarity: float = None,
    subject_id: str | None = None,
    chapter_id: str | None = None,
    document_id: str | None = None,
    chapter_ids: list[str] | None = None,
) -> list[tuple[EmbeddingChunk, float]]:
    """Bước 4 lộ trình RAG: vector search bằng cosine similarity tính tay (NumPy, không ANN
    index — xem database/studio_rag_schema.sql). CHỈ so sánh chunk cùng
    `settings.EMBEDDING_MODEL` hiện tại (khác model = khác không gian vector, so cosine vô
    nghĩa nếu có chunk cũ còn sót lại từ lần đổi model trước). Bước 5 (UC-19) lọc phạm vi qua
    `subject_id`/`chapter_id`/`document_id` (phạm vi của phiên chat, xem chat.py
    `_resolve_scope`); để trống cả 3 = tìm trên TOÀN BỘ tri thức của user. Lưu ý chunk PDF có
    `chapter_id=NULL` (PDF gắn thẳng vào Môn) nên phạm vi Chương không bao gồm PDF — muốn hỏi
    riêng 1 PDF thì dùng `document_id`. `chapter_ids` = chỉ tìm trong đúng các Chương này (Chương người
    dùng đính kèm thủ công ở ô chat). Trả list (chunk, similarity) giảm dần, đã lọc
    similarity >= min_similarity, tối đa top_k phần tử. [] nếu không chunk nào khớp."""
    if top_k is None:
        top_k = settings.RAG_TOP_K
    if min_similarity is None:
        min_similarity = settings.RAG_MIN_SIMILARITY

    query = select(EmbeddingChunk).where(
        EmbeddingChunk.user_id == user_id,
        EmbeddingChunk.embedding_model == settings.EMBEDDING_MODEL,
    )
    if subject_id is not None:
        query = query.where(EmbeddingChunk.subject_id == subject_id)
    if chapter_id is not None:
        query = query.where(EmbeddingChunk.chapter_id == chapter_id)
    if document_id is not None:
        query = query.where(EmbeddingChunk.document_id == document_id)
    if chapter_ids:
        query = query.where(EmbeddingChunk.chapter_id.in_(chapter_ids))
    chunks = db.scalars(query).all()
    if not chunks:
        return []

    matrix = np.array([c.embedding_vector for c in chunks], dtype=np.float32)
    query_arr = np.array(query_vector, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1) * np.linalg.norm(query_arr)
    norms[norms == 0] = 1e-9  # phòng thủ chia 0 (không nên xảy ra với vector thật)
    similarities = (matrix @ query_arr) / norms
    ranked = sorted(zip(chunks, similarities.tolist()), key=lambda x: x[1], reverse=True)
    return [(c, s) for c, s in ranked if s >= min_similarity][:top_k]


def reembed_chapter(db: Session, chapter: Chapter) -> int:
    """Idempotent: chunk+embed lại `chapter.content_text` rồi THAY THẾ toàn bộ chunk cũ nguồn
    CHAPTER của Chương này. Trả số chunk mới (0 nếu nội dung rỗng, lỗi API, hoặc lỗi DB khi
    ghi — KHÔNG raise, để lỗi ở đây không bao giờ làm hỏng việc lưu Chương ở nơi gọi. Mọi lỗi
    đều `db.rollback()` trước khi trả về, tránh để Session ở trạng thái "pending rollback"
    làm hỏng luôn các thao tác DB khác sau đó trong cùng request).

    Gọi embedding API TRƯỚC, chỉ xoá chunk cũ khi đã có vector mới: bản đầu xoá trước rồi mới
    embed, nên 1 lần lỗi mạng/429 thoáng qua là xoá sạch index của cả Chương (AI không còn
    tìm thấy gì cho tới lần lưu kế tiếp). Nội dung rỗng thật thì vẫn xoá chunk cũ — đúng ý."""
    try:
        # Review > Password: Chương có mật khẩu không được AI đọc -> coi như rỗng (xoá chunk cũ nếu còn).
        pieces = [] if chapter.password_hash else chunk_text((chapter.content_text or ""))
        vectors = generate_embeddings(pieces) if pieces else []
        if pieces and not vectors:
            db.rollback()
            return 0  # lỗi API/thiếu key -> giữ nguyên chunk cũ
        db.execute(
            delete(EmbeddingChunk).where(
                EmbeddingChunk.chapter_id == chapter.id, EmbeddingChunk.source_type == "CHAPTER"
            )
        )
        if not pieces:
            db.commit()
            return 0
        dimension = len(vectors[0]) if vectors[0] else None
        user_id = chapter.subject.owner_id
        for index, (piece, vector) in enumerate(zip(pieces, vectors)):
            db.add(
                EmbeddingChunk(
                    source_type="CHAPTER",
                    chunk_index=index,
                    content=piece,
                    user_id=user_id,
                    subject_id=chapter.subject_id,
                    chapter_id=chapter.id,
                    embedding_vector=vector,
                    embedding_model=settings.EMBEDDING_MODEL,
                    embedding_dimension=dimension,
                    # Chưa map offset về đúng vị trí trong content_json (CKEditor HTML,
                    # không phải cấu trúc block có block_id) — chỉ số thứ tự chunk là đủ
                    # dùng cho Bước 3, việc điều hướng trích dẫn UC-20 5a thuộc Bước 4/5.
                    source_location={"chunk_index": index},
                )
            )
        db.commit()
        return len(pieces)
    except Exception:
        db.rollback()
        return 0


def reembed_pdf(db: Session, doc: PdfDocument) -> int:
    """Cùng khuôn `reembed_chapter` (embed trước, chỉ thay chunk cũ khi thành công) nhưng
    chunk theo TỪNG TRANG (qua `text_extraction.extract_pdf_pages()`) để
    `source_location={"page": N}` phản ánh đúng trang thật (UC-20 luồng thay thế 5a). Một
    trang dài vẫn có thể sinh nhiều chunk (qua `chunk_text()`) nhưng tất cả đều gắn đúng
    `page` của trang đó.

    Ghi `doc.process_status` (UC-36 / Dọn dung lượng UC-33): ready = đã có chunk; không trích được chữ nào →
    ocr_error nếu tệp ≥ 1 MB (thường là PDF scan OCR hỏng/thiếu Tesseract), ngược lại empty (tệp trống);
    lỗi embedding API / lỗi khác → ocr_error (admin "Xử lý lại" được)."""
    try:
        pages = text_extraction.extract_pdf_pages(Path(doc.file_path))
        pieces: list[str] = []
        locations: list[dict] = []
        for page_number, page_text in enumerate(pages, start=1):
            for piece in chunk_text(page_text or ""):
                pieces.append(piece)
                locations.append({"page": page_number})
        vectors = generate_embeddings(pieces) if pieces else []
        if pieces and not vectors:
            db.rollback()
            _set_pdf_status(db, doc, "ocr_error")
            return 0  # lỗi API/thiếu key -> giữ nguyên chunk cũ
        db.execute(delete(EmbeddingChunk).where(EmbeddingChunk.document_id == doc.id))
        if not pieces:
            doc.process_status = "ocr_error" if doc.file_size_bytes >= 1024 * 1024 else "empty"
            db.commit()
            return 0
        dimension = len(vectors[0]) if vectors[0] else None
        user_id = doc.subject.owner_id
        for index, (piece, vector, location) in enumerate(zip(pieces, vectors, locations)):
            db.add(
                EmbeddingChunk(
                    source_type="PDF",
                    chunk_index=index,
                    content=piece,
                    user_id=user_id,
                    subject_id=doc.subject_id,
                    document_id=doc.id,
                    chapter_id=None,
                    embedding_vector=vector,
                    embedding_model=settings.EMBEDDING_MODEL,
                    embedding_dimension=dimension,
                    source_location=location,
                )
            )
        doc.process_status = "ready"
        db.commit()
        return len(pieces)
    except Exception:
        db.rollback()
        _set_pdf_status(db, doc, "ocr_error")
        return 0


def _set_pdf_status(db: Session, doc: PdfDocument, value: str) -> None:
    try:
        doc.process_status = value
        db.commit()
    except Exception:
        db.rollback()


# Khoá theo từng nguồn cho các tác vụ nền bên dưới: autosave (1.2s) có thể bắn 2 lần PUT sát
# nhau cho cùng 1 Chương -> 2 tác vụ nền chạy chồng lên nhau sẽ cùng xoá rồi cùng ghi, ra chunk
# trùng lặp. Khoá tuần tự hoá chúng; tác vụ sau đọc lại nội dung MỚI NHẤT từ DB nên kết quả
# cuối vẫn đúng. Chỉ đúng trong 1 process (uvicorn 1 worker như cấu hình dev hiện tại).
_source_locks: dict[str, threading.Lock] = {}
_source_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _source_locks_guard:
        return _source_locks.setdefault(key, threading.Lock())


def reembed_chapter_background(chapter_id: str) -> None:
    """Entrypoint cho FastAPI `BackgroundTasks` (xem `routers/knowledge.py` update_chapter):
    chạy SAU khi response đã trả về nên autosave không phải chờ embedding API. Mở Session
    riêng — Session của request đã đóng lúc tác vụ nền chạy. Chương đã bị xoá thì bỏ qua."""
    from app.database import SessionLocal

    with _lock_for(f"chapter:{chapter_id}"):
        db = SessionLocal()
        try:
            chapter = db.get(Chapter, chapter_id)
            if chapter is not None:
                reembed_chapter(db, chapter)
        finally:
            db.close()


def reembed_pdf_background(document_id: str) -> None:
    """Như `reembed_chapter_background` nhưng cho PDF vừa tải lên (OCR PDF scan nhiều trang
    có thể mất cả chục giây — không để request tải lên phải chờ)."""
    from app.database import SessionLocal

    with _lock_for(f"pdf:{document_id}"):
        db = SessionLocal()
        try:
            doc = db.get(PdfDocument, document_id)
            if doc is not None:
                reembed_pdf(db, doc)
        finally:
            db.close()


def reembed_all(db: Session) -> dict:
    """Backfill toàn bộ Chapter + PdfDocument có nội dung — chạy thủ công khi đổi
    `EMBEDDING_MODEL` (chunk của model cũ bị `reembed_chapter`/`reembed_pdf` xoá sạch trước
    khi ghi lại bằng model mới, không có bước "chờ" — xem `python -m app.services.embeddings`
    ở cuối file)."""
    stats = {"chapters": 0, "chapter_chunks": 0, "pdfs": 0, "pdf_chunks": 0}
    for chapter in db.scalars(select(Chapter)).all():
        # Tính lại content_text theo html_to_text() hiện hành — dữ liệu lưu bằng bản cũ còn
        # nguyên "&nbsp;" và chữ bị tách đôi ("xây d ựng") ở chỗ <span> cắt giữa chữ.
        if chapter.content_json is not None:
            chapter.content_text = text_extraction.html_to_text(chapter.content_json)
        if not (chapter.content_text or "").strip():
            continue
        stats["chapter_chunks"] += reembed_chapter(db, chapter)
        stats["chapters"] += 1
    for doc in db.scalars(select(PdfDocument)).all():
        stats["pdf_chunks"] += reembed_pdf(db, doc)
        stats["pdfs"] += 1
    return stats


if __name__ == "__main__":
    # Console mặc định trên Windows (cp1252) không encode được dấu tiếng Việt -> crash khi
    # print(). reconfigure về UTF-8 (Python 3.7+), errors="replace" để không bao giờ crash
    # dù terminal cũ không hiển thị đúng ký tự.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    from app.database import SessionLocal

    session = SessionLocal()
    try:
        result = reembed_all(session)
        print(
            f"Đã re-embed {result['chapters']} Chương ({result['chapter_chunks']} chunk) + "
            f"{result['pdfs']} PDF ({result['pdf_chunks']} chunk) bằng model "
            f"'{settings.EMBEDDING_MODEL}'."
        )
    finally:
        session.close()
