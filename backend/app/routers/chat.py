"""Endpoint UC-19 (đính kèm ngữ cảnh ở ô nhập AI Chat) + AI Chat — lưu phiên/tin nhắn
thật (Bước 1) + gọi Gemini API thật (Bước 2) + vector search/trích dẫn thật (Bước 4) của lộ
trình RAG. Xem .claude/rules/08-ai-studio.md, database/studio_chat_attachments_schema.sql,
database/studio_chat_schema.sql.

Ranh giới rõ ràng (đọc trước khi mở rộng file này):
  - THẬT: file nhị phân lưu trên đĩa (settings.CHAT_ATTACHMENT_UPLOAD_DIR), các dòng
    `chat_attachments` trong DB, kiểm tra sở hữu (BR-05 -> 404), endpoint tải file có
    auth, nội dung Chương đọc thật từ `chapters.content_text` qua GET /chapters/{id}.
    Từ Bước 1: phiên chat + tin nhắn (`chat_sessions`/`chat_messages`) đã LƯU THẬT vào
    DB. Từ Bước 2: câu trả lời do Gemini API thật sinh ra (`google-genai`, xem
    `_generate_ai_reply`) khi `settings.GEMINI_API_KEY` có giá trị — có kèm lịch sử hội
    thoại (multi-turn) và nội dung Chương đã đính kèm (`attachment_ids`, kind='chapter')
    làm ngữ cảnh trong `system_instruction`. Từ Bước 4: NGOÀI đính kèm thủ công, mỗi câu
    hỏi còn được tự động embed rồi tìm chunk liên quan nhất trong TOÀN BỘ tri thức đã embed
    của user qua vector search (`_build_retrieved_context`, `embeddings.search_similar_
    chunks` — cosine similarity tính tay bằng NumPy, xem `app/services/embeddings.py`), và
    Gemini thật sự trả lời (`model_used is not None`) thì các chunk đã dùng được ghi thật
    vào `chat_message_citations` (BR-09), trả ra qua `ChatMessageOut.citations`.
  - VẪN LÀ STUB/CHƯA XÂY: `GEMINI_API_KEY` để trống -> rơi về `_CANNED_REPLY` như Bước 1
    (không lỗi, tiện cho ai chưa có key, và không chạy retrieval tốn API — xem
    `_build_retrieved_context`). Gemini lỗi/timeout -> rơi về `_GEMINI_ERROR_REPLY`, KHÔNG
    làm hỏng cả request (tin nhắn user vẫn được lưu, KHÔNG ghi citation vì câu trả lời đó
    không thật sự dựa trên chunk nào). CHƯA có UI hiển thị citation dưới bong bóng chat hay
    bấm-để-nhảy-tới-vị-trí (UC-20 luồng thay thế 5a) — dữ liệu đã có qua API, chỉ còn thiếu
    phần UI (bước riêng sau Bước 5).
  - Bước 5 (UC-19, chọn phạm vi nội dung nguồn): mỗi phiên chat có 1 phạm vi (Môn / Chương /
    Tệp PDF / Toàn bộ — cột `chat_sessions.scope_*`, xem `_resolve_scope`) giới hạn vector
    search của `_build_retrieved_context`. Đính kèm thủ công (`attachment_ids`) KHÔNG bị
    giới hạn bởi phạm vi — người dùng chủ động gắn thì luôn được đọc.
  - Đính kèm kind='file' (PDF/ảnh) ĐÃ đọc được nội dung qua
    `app.services.text_extraction.extract_file_text` (dùng chung với pipeline embedding
    Bước 3) — PyMuPDF (`fitz`) đọc lớp text thật của PDF, hoặc OCR (Tesseract qua
    `pytesseract`) nếu trang PDF không có lớp text (scan) hoặc file là ảnh — cần cài
    Tesseract engine ở máy (KHÔNG cài được qua pip, xem CLAUDE.md phần cài đặt) + gói ngôn
    ngữ eng/vie trong `settings.TESSDATA_DIR`. Lỗi trích xuất (thiếu Tesseract, file
    hỏng...) trả chuỗi rỗng — KHÔNG raise, chỉ đơn giản là file đó không góp được gì vào
    ngữ cảnh.
"""
import hashlib
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import get_current_user, get_db
from app.models import (
    Chapter,
    ChatAttachment,
    ChatMessage,
    ChatMessageCitation,
    ChatSession,
    EmbeddingChunk,
    PdfDocument,
    Subject,
    User,
)
from app.routers.knowledge import _get_owned_chapter, _get_owned_pdf, _get_owned_subject
from app.services import embeddings, quota, text_extraction
from app.schemas import (
    ChatAttachmentMarkSentRequest,
    ChatAttachmentOut,
    ChatChapterAttachRequest,
    ChatCitationOut,
    ChatMessageOut,
    ChatScopeOut,
    ChatScopeRequest,
    ChatSendMessageRequest,
    ChatSendMessageResponse,
    ChatSessionOut,
    ChatSessionRenameRequest,
    SimpleMessageResponse,
)

router = APIRouter(prefix="/chat", tags=["chat"])

_PREVIEW_CHARS = 200

# Câu trả lời khi CHƯA cấu hình GEMINI_API_KEY — giữ đúng chuỗi Bước 1 để không đổi
# hành vi người dùng thấy được lúc chưa có key.
_CANNED_REPLY = "Tính năng hỏi đáp AI sẽ sớm có mặt."
# Gemini API lỗi (mạng/key sai/hết quota...) — KHÔNG bịa câu trả lời, báo thật cho người
# dùng thay vì làm hỏng cả request gửi tin nhắn.
_GEMINI_ERROR_REPLY = "Xin lỗi, hiện không gọi được AI để trả lời (lỗi kết nối tới Gemini). Thử lại sau."
_WHITESPACE_RE = re.compile(r"\s+")
_AUTO_TITLE_MAX_CHARS = 40
# Giới hạn ký tự nội dung mỗi Chương/tệp đính kèm đưa vào prompt — đủ rộng để đọc HẾT hầu
# hết tài liệu thực tế (CV, báo cáo vài chục trang, ~60000 ký tự ≈ 15000 token, so với cửa
# sổ ngữ cảnh cả triệu token của Gemini flash thì vẫn rất nhỏ), chỉ để chặn trường hợp cực
# đoan (1 giáo trình cả trăm trang) làm phình prompt/tốn phí — không phải giới hạn kỹ thuật
# do OCR. Ngữ cảnh tìm được tự động qua vector search (Bước 4) không dùng giới hạn này —
# đã bị chặn tự nhiên bởi settings.RAG_TOP_K (số chunk) x kích thước chunk cố định.
_ATTACHMENT_CONTEXT_MAX_CHARS = 60_000

_SYSTEM_PROMPT = (
    "Bạn là trợ lý học tập trong một nền tảng ghi chú của sinh viên Việt Nam. Trả lời "
    "ngắn gọn, rõ ràng, bằng tiếng Việt trừ khi người dùng hỏi bằng ngôn ngữ khác. Ngoài "
    "lịch sử hội thoại hiện tại, bạn có thể được cấp thêm 2 loại ngữ cảnh (đánh dấu rõ ràng "
    "trong phần dưới đây nếu có): nội dung Chương/tệp mà người dùng CHỦ ĐỘNG đính kèm vào "
    "tin nhắn này, và các đoạn trích tìm được TỰ ĐỘNG bằng tìm kiếm ngữ nghĩa (semantic "
    "search) trên toàn bộ tri thức người dùng đã lưu, mỗi đoạn có số thứ tự [1], [2]… "
    # Trích dẫn theo SỐ (_select_citations bên dưới): chỉ đoạn nào được ghi số trong câu trả lời mới thành
    # "Nguồn" — trước đây mọi đoạn tìm được đều bị lưu làm nguồn nên người dùng thấy nguồn thừa, không liên quan.
    "QUY TẮC TRÍCH NGUỒN (bắt buộc): mỗi khi một câu hoặc một ý dùng thông tin từ đoạn trích có "
    "số, ghi đúng số đó trong ngoặc vuông ngay cuối câu/ý, vd. '... là giao thức nhẹ [1].' hoặc "
    "'[1][3]' nếu ý đó gộp từ 2 đoạn. CHỈ ghi số của đoạn bạn THỰC SỰ lấy thông tin để viết; "
    "KHÔNG ghi số cho đoạn chỉ na ná chủ đề mà bạn không dùng; KHÔNG ghi tên Chương/tệp trong "
    "ngoặc vuông; KHÔNG liệt kê danh sách nguồn ở cuối câu trả lời; không tự nghĩ ra số không có "
    "trong danh sách. Câu trả lời không dựa vào đoạn trích nào (lời chào, báo không tìm thấy, "
    "câu tiếp nối từ lịch sử) thì không ghi số nào. Nội dung Chương/tệp được đính kèm (không có "
    "số) dùng bình thường, không cần ghi số. Nếu không có đủ thông tin để trả lời chắc chắn, hãy "
    "nói rõ là chưa có đủ ngữ cảnh thay vì suy đoán. "
    # Giao diện (chatMarkdown() ở frontend/js/ghichu.js) dựng Markdown cơ bản thành HTML căn đều 2 lề — chỉ dùng
    # đúng các cú pháp nó hỗ trợ: **đậm**, *nghiêng*, `mã`, "- " / "1. " danh sách (lồng 1 cấp), "### " tiêu đề.
    "Trình bày bằng Markdown cơ bản để dễ đọc: in đậm (**...**) thuật ngữ / khái niệm chính, danh sách gạch "
    "đầu dòng bắt đầu bằng '- ' (hoặc '1. ', '2. ' khi các ý có thứ tự), tiêu đề ngắn bắt đầu bằng '### ' khi câu "
    "trả lời có nhiều phần. Với định nghĩa, viết dạng '- **Thuật ngữ (English):** định nghĩa'. KHÔNG dùng bảng, "
    "khối mã, ảnh hay liên kết."
)
_TITLE_SYSTEM_PROMPT = (
    "Tóm tắt tin nhắn sau thành một tiêu đề ngắn gọn (tối đa 6 từ) đặt tên cho đoạn hội "
    "thoại này, bằng đúng ngôn ngữ của tin nhắn. Chỉ trả về đúng tiêu đề — không thêm dấu "
    "ngoặc kép, không giải thích, không chấm câu cuối."
)

_gemini_client: genai.Client | None = None
_gemini_client_checked = False


def _get_gemini_client() -> genai.Client | None:
    """Tạo lười (lazy) + cache lại 1 client dùng chung cho cả process — tránh khởi tạo
    lại mỗi request. Trả None nếu chưa cấu hình GEMINI_API_KEY (xem docstring đầu file)."""
    global _gemini_client, _gemini_client_checked
    if not _gemini_client_checked:
        _gemini_client_checked = True
        if settings.GEMINI_API_KEY:
            _gemini_client = genai.Client(api_key=settings.GEMINI_API_KEY)
    return _gemini_client


def _build_attachment_context(
    db: Session, attachment_ids: list[str], user: User
) -> tuple[str | None, list[str] | None]:
    """Trả (ngữ cảnh đính kèm, id các Chương đính kèm). Id Chương là None khi KHÔNG có đính kèm hợp lệ nào
    (vector search chạy theo phạm vi phiên như cũ); là list (có thể rỗng — chỉ đính kèm tệp từ máy) khi người
    dùng đã chỉ định nguồn: lúc đó chỉ tìm + trích dẫn trong đúng các Chương đó, không quét toàn bộ tri thức.

    Đọc nội dung các đính kèm thuộc sở hữu người dùng (BR-05) — Chương (content_text có
    sẵn) hoặc tệp PDF/ảnh/.txt (trích bằng `text_extraction.extract_file_text`, có OCR — xem
    `app/services/text_extraction.py`). Id lạ/không sở hữu bị lọc bỏ êm, không báo lỗi (đính
    kèm là tuỳ chọn, không có nghĩa request sai)."""
    if not attachment_ids:
        return None, None
    atts = db.scalars(
        select(ChatAttachment).where(
            ChatAttachment.id.in_(attachment_ids), ChatAttachment.user_id == user.id
        )
    ).all()
    if not atts:
        return None, None
    chunks = []
    chapter_ids = [att.chapter.id for att in atts if att.kind == "chapter" and att.chapter is not None]
    for att in atts:
        if att.kind == "chapter":
            chapter = att.chapter
            text = (chapter.content_text or "").strip() if chapter is not None and not chapter.password_hash else ""
            if text:
                chunks.append(f"[Chương: {chapter.name}]\n{text[:_ATTACHMENT_CONTEXT_MAX_CHARS]}")
        elif att.kind == "file" and att.file_path:
            text = text_extraction.extract_file_text(Path(att.file_path), att.mime_type or "").strip()
            if text:
                chunks.append(f"[Tệp: {att.original_name or att.label}]\n{text[:_ATTACHMENT_CONTEXT_MAX_CHARS]}")
    if not chunks:
        return None, chapter_ids
    return "Nội dung các Chương/tệp người dùng đã đính kèm làm ngữ cảnh cho câu hỏi này:\n\n" + "\n\n---\n\n".join(
        chunks
    ), chapter_ids


def _chunk_label(chunk: EmbeddingChunk) -> str:
    """Nhãn nguồn của 1 chunk — dùng cả khi đưa vào prompt (Gemini có thể trích dẫn lại
    trong câu trả lời, xem `_SYSTEM_PROMPT`) lẫn khi build `ChatCitationOut` cho API.

    Cố tình chèn `page_count` (tổng số trang, cột `pdf_documents.page_count` — metadata do
    PDF.js đo phía frontend, KHÔNG phải nội dung văn bản trong chunk) vào ngay nhãn: retrieval
    chỉ tìm được NỘI DUNG liên quan về mặt ngữ nghĩa, không tìm được các câu hỏi về metadata
    file (vd. "file này có bao nhiêu trang?") vì câu trả lời đó không nằm trong văn bản của
    bất kỳ chunk nào cả. Chèn sẵn vào nhãn là cách rẻ nhất để Gemini vẫn trả lời được câu hỏi
    dạng đó bất cứ khi nào có ít nhất 1 chunk của đúng file đó được tìm thấy."""
    if chunk.source_type == "CHAPTER" and chunk.chapter is not None:
        return f"Chương: {chunk.chapter.name}"
    if chunk.source_type == "PDF" and chunk.document is not None:
        page = chunk.source_location.get("page") if isinstance(chunk.source_location, dict) else None
        total_pages = chunk.document.page_count
        label = f"Tệp: {chunk.document.original_name}"
        if page and total_pages:
            return label + f" (trang {page}/{total_pages})"
        if total_pages:
            return label + f" (tổng {total_pages} trang)"
        if page:
            return label + f" (trang {page})"
        return label
    return "Nguồn không xác định"


class _Scope:
    """Phạm vi nội dung nguồn đã kiểm tra (Bước 5, UC-19) — 3 mức loại trừ nhau: Môn (chỉ
    `subject`), Chương (`subject` + `chapter`), Tệp PDF (chỉ `document`). Rỗng = toàn bộ."""

    def __init__(
        self,
        subject: Subject | None = None,
        chapter: Chapter | None = None,
        document: PdfDocument | None = None,
    ):
        self.subject, self.chapter, self.document = subject, chapter, document

    @classmethod
    def of_session(cls, session: ChatSession) -> "_Scope":
        # Đọc lại từ cột FK đã lưu — Môn/Chương/PDF đã bị xoá thì cột thành NULL (SET NULL) và
        # phiên tự nới về "Toàn bộ tri thức", đúng thiết kế (không mất lịch sử hội thoại).
        return cls(session.scope_subject, session.scope_chapter, session.scope_document)

    @property
    def subject_id(self) -> str | None:
        return self.subject.id if self.subject else None

    @property
    def chapter_id(self) -> str | None:
        return self.chapter.id if self.chapter else None

    @property
    def document_id(self) -> str | None:
        return self.document.id if self.document else None

    @property
    def is_all(self) -> bool:
        return not (self.subject or self.chapter or self.document)

    def label(self) -> str:
        if self.document is not None:
            return f"Tệp: {self.document.original_name}"
        if self.chapter is not None:
            return f"Chương: {self.chapter.name}"
        if self.subject is not None:
            return f"Môn học: {self.subject.name}"
        return "Toàn bộ tri thức"

    def apply_to(self, session: ChatSession) -> None:
        session.scope_subject_id = self.subject_id
        session.scope_chapter_id = self.chapter_id
        session.scope_document_id = self.document_id

    def out(self) -> ChatScopeOut:
        return ChatScopeOut(
            subject_id=self.subject_id,
            subject_name=self.subject.name if self.subject else None,
            chapter_id=self.chapter_id,
            chapter_name=self.chapter.name if self.chapter else None,
            document_id=self.document_id,
            document_name=self.document.original_name if self.document else None,
        )


def _resolve_scope(db: Session, user: User, req: ChatScopeRequest) -> _Scope:
    """Kiểm tra phạm vi người dùng chọn (UC-19): BR-05 (sở hữu, 404 nếu không) + BR-07 (phạm vi
    phải có tối thiểu 1 chunk đã embed với model hiện tại, 400 nếu không — UC-19 E1). Chọn
    "Toàn bộ" (cả 3 field None) không kiểm BR-07, giữ đúng hành vi Bước 4 (không chunk nào thì
    retrieval tự bỏ qua êm)."""
    if not (req.subject_id or req.chapter_id or req.document_id):
        return _Scope()

    if req.document_id:
        if req.subject_id or req.chapter_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Phạm vi Tệp PDF không đi kèm Môn học/Chương.")
        scope = _Scope(document=_get_owned_pdf(db, req.document_id, user))
        count_filter = EmbeddingChunk.document_id == scope.document_id
    elif req.chapter_id:
        chapter = _get_owned_chapter(db, req.chapter_id, user)
        if req.subject_id and req.subject_id != chapter.subject_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chương không thuộc đúng Môn học đã chọn.")
        scope = _Scope(subject=chapter.subject, chapter=chapter)
        count_filter = EmbeddingChunk.chapter_id == chapter.id
    else:
        scope = _Scope(subject=_get_owned_subject(db, req.subject_id, user))
        count_filter = EmbeddingChunk.subject_id == scope.subject_id

    chunk_count = db.scalar(
        select(func.count())
        .select_from(EmbeddingChunk)
        .where(
            EmbeddingChunk.user_id == user.id,
            EmbeddingChunk.embedding_model == settings.EMBEDDING_MODEL,
            count_filter,
        )
    )
    if not chunk_count:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f'Phạm vi "{scope.label()}" chưa có nội dung nào sẵn sàng cho AI (chưa lưu nội dung, '
            "hoặc tệp không trích được chữ). Hãy chọn phạm vi khác hoặc thêm nội dung trước.",
        )
    return scope


def _build_retrieved_context(
    db: Session, user: User, question: str, scope: "_Scope", chapter_ids: list[str] | None = None
) -> tuple[str | None, list[EmbeddingChunk]]:
    """RAG thật (Bước 4 lộ trình RAG): embed câu hỏi rồi tìm chunk liên quan nhất trong tri
    thức đã embed của user, giới hạn theo phạm vi của phiên chat (Bước 5, UC-19 — `scope`
    rỗng = toàn bộ tri thức). Trả (đoạn text đưa vào system_instruction, list chunk đã dùng để ghi citation
    sau khi có assistant_message.id). (None, []) nếu chưa có GEMINI_API_KEY, lỗi gọi embedding
    API, hoặc không chunk nào đủ liên quan (dưới settings.RAG_MIN_SIMILARITY) — KHÔNG raise,
    model vẫn trả lời được dựa trên lịch sử hội thoại/đính kèm thủ công (nếu có).

    `chapter_ids` khác None = người dùng đã đính kèm nguồn cụ thể (xem `_build_attachment_context`): chỉ tìm
    trong đúng các Chương đó, bỏ qua phạm vi phiên; list rỗng (chỉ đính kèm tệp từ máy — tệp không có chunk)
    thì bỏ hẳn vector search: đỡ 1 lượt gọi embedding API và không trích dẫn lan sang tài liệu khác."""
    if chapter_ids is not None and not chapter_ids:
        return None, []
    query_vectors = embeddings.generate_embeddings([question], task_type="RETRIEVAL_QUERY")
    if not query_vectors:
        return None, []
    if chapter_ids is not None:
        results = embeddings.search_similar_chunks(db, user.id, query_vectors[0], chapter_ids=chapter_ids)
        where = "trong các Chương người dùng đã đính kèm"
    else:
        results = embeddings.search_similar_chunks(
            db,
            user.id,
            query_vectors[0],
            subject_id=scope.subject_id,
            chapter_id=scope.chapter_id,
            document_id=scope.document_id,
        )
        where = (
            "từ toàn bộ tri thức của người dùng"
            if scope.is_all
            else f"trong phạm vi người dùng đã chọn ({scope.label()})"
        )
    if not results:
        return None, []
    parts = [f"[{i}] ({_chunk_label(chunk)})\n{chunk.content}" for i, (chunk, _score) in enumerate(results, 1)]
    text = (
        f"Các đoạn trích CÓ THỂ liên quan tới câu hỏi, tìm được TỰ ĐỘNG {where} (tìm kiếm ngữ "
        "nghĩa — có đoạn không thật sự liên quan, hãy bỏ qua những đoạn đó). Khi dùng đoạn nào, "
        "ghi số của đoạn đó theo QUY TẮC TRÍCH NGUỒN:\n\n" + "\n\n---\n\n".join(parts)
    )
    return text, [chunk for chunk, _score in results]


# ---- Chọn đúng nguồn đã dùng (BR-09 "đúng, đủ, không thừa") -------------------------------------------
# Gemini ghi số đoạn trích [n] sau mỗi câu/ý (xem _SYSTEM_PROMPT). Chỉ các đoạn được ghi số mới thành nguồn;
# nhiều đoạn cùng 1 Chương (hoặc cùng 1 trang PDF) gộp thành 1 nguồn. Số trong câu trả lời được ĐÁNH LẠI
# 1, 2, 3… theo thứ tự xuất hiện để khớp đúng danh sách "Nguồn" hiển thị bên dưới.
_CITE_MARK = re.compile(r"\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*\]")
# Cả cụm số đứng liền nhau "[1][3]" / "[1, 3]" + khoảng trắng phía trước — xử lý 1 lần để không ra "[1][1]" khi 2 đoạn
# cùng 1 Chương, và bỏ số lạ không để lại dấu cách thừa trước dấu chấm.
_CITE_RUN = re.compile(r"[ \t]*\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\](?:\s*\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\])*")
_LABEL_MARK = re.compile(r"\[\s*((?:Chương|Tệp)\s*:[^\]]+)\]")


def _source_key(chunk: EmbeddingChunk) -> str:
    if chunk.source_type == "PDF":
        page = chunk.source_location.get("page") if isinstance(chunk.source_location, dict) else None
        return f"pdf:{chunk.document_id}:{page}"
    return f"chapter:{chunk.chapter_id}"


def _norm_label(s: str) -> str:
    s = re.sub(r"\s*\((trang|tổng)[^)]*\)\s*$", "", s.strip(), flags=re.I)
    return _WHITESPACE_RE.sub(" ", s).lower()


def _select_citations(reply: str, chunks: list[EmbeddingChunk]) -> tuple[str, list[EmbeddingChunk]]:
    """Trả (câu trả lời đã đánh lại số, các chunk được trích — mỗi nguồn 1 chunk, theo thứ tự [1], [2]…)."""
    if not chunks:
        return _CITE_RUN.sub("", reply).strip(), []
    picked: list[EmbeddingChunk] = []
    number_of: dict[str, int] = {}

    def number(chunk: EmbeddingChunk) -> int:
        key = _source_key(chunk)
        if key not in number_of:
            picked.append(chunk)
            number_of[key] = len(picked)
        return number_of[key]

    def renumber(m: re.Match) -> str:
        nums = []
        for raw in re.findall(r"\d+", m.group(0)):
            i = int(raw)
            if 1 <= i <= len(chunks):
                n = number(chunks[i - 1])
                if n not in nums:
                    nums.append(n)
        return "".join(f"[{n}]" for n in nums)   # số lạ (ngoài danh sách) bị bỏ hẳn; số bám sát chữ phía trước

    if _CITE_MARK.search(reply):
        out = _CITE_RUN.sub(renumber, reply)
    else:
        # Dự phòng: model vẫn ghi kiểu cũ "[Chương: X]" / "[Tệp: X (trang a/b)]" -> khớp nhãn với đoạn trích.
        def by_label(m: re.Match) -> str:
            want = _norm_label(m.group(1))
            page = re.search(r"trang\s+(\d+)", m.group(1), re.I)
            hits = [c for c in chunks if _norm_label(_chunk_label(c)) == want]
            if page:
                exact = [c for c in hits if isinstance(c.source_location, dict)
                         and str(c.source_location.get("page")) == page.group(1)]
                hits = exact or hits[:1]
            return "".join(f"[{number(c)}]" for c in hits[:1]) if hits else m.group(0)
        out = _LABEL_MARK.sub(by_label, reply)
        out = re.sub(r"[ \t]+(\[\d+\])", r"\1", out)   # "câu [1]" -> "câu[1]" để số bám sát chữ
    return out.strip(), picked


# UC-20 E1 (chống hallucination): khi KHÔNG có đoạn nào đủ liên quan (retrieval rỗng) và cũng
# không có đính kèm thủ công, nói thẳng với model điều đó thay vì để nó tự do trả lời bằng kiến
# thức chung như 1 chatbot thường. Vẫn cho phép chào hỏi/câu hỏi tiếp nối dựa trên lịch sử.
_NO_CONTEXT_NOTE = (
    "QUAN TRỌNG: hệ thống KHÔNG tìm thấy đoạn nào trong tài liệu của người dùng đủ liên quan "
    "tới tin nhắn này. Bạn là trợ lý hỏi đáp THEO TÀI LIỆU, không phải chatbot kiến thức chung: "
    "với mọi câu hỏi về kiến thức/nội dung (kể cả kiến thức phổ thông bạn biết chắc), KHÔNG "
    'được tự trả lời — chỉ nói "Không tìm thấy thông tin này trong tài liệu của bạn." rồi gợi ý '
    "người dùng thêm ghi chú/tệp liên quan, đính kèm Chương hoặc tệp bằng nút '+' ở ô nhập, hoặc đổi phạm vi tìm kiếm. "
    "Ngoại lệ duy nhất: lời chào hỏi, câu hỏi về cách dùng ứng dụng, hoặc câu hỏi tiếp nối mà "
    "câu trả lời đã nằm sẵn trong lịch sử hội thoại phía trên."
)

_GEMINI_MAX_ATTEMPTS = 2  # 1 lần gọi + 1 lần thử lại — chỉ cho lỗi 503 (quá tải tạm thời,
# thực tế đo được ở model gemini-flash-latest lúc phát triển tính năng này), KHÔNG retry
# lỗi 401/400 (key sai/request sai thì thử lại cũng vẫn sai y hệt, chỉ tốn thời gian chờ).


def _generate_ai_reply(
    history: list[ChatMessage], user_content: str, context_text: str | None
) -> tuple[str, str | None]:
    """Gọi Gemini với lịch sử hội thoại (multi-turn) + tin nhắn mới. Trả về
    (nội dung câu trả lời, tên model đã dùng | None nếu là câu trả lời dự phòng —
    chưa có key hoặc gọi lỗi, xem docstring đầu file)."""
    client = _get_gemini_client()
    if client is None:
        return _CANNED_REPLY, None

    contents = []
    if settings.CHAT_HISTORY_MAX_MESSAGES > 0:
        history = history[-settings.CHAT_HISTORY_MAX_MESSAGES :]
    for m in history:
        if m.role not in ("user", "assistant"):
            continue  # role='system' (nếu có) không phải lượt hội thoại thật
        role = "model" if m.role == "assistant" else "user"
        # Số trích [n] của lượt cũ ứng với danh sách đoạn trích CŨ — bỏ đi để model không nhầm với danh sách mới.
        text = _CITE_MARK.sub("", m.content) if m.role == "assistant" else m.content
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text)]))
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_content)]))

    today = datetime.now()
    today_line = f"Hôm nay là ngày {today.day}/{today.month}/{today.year}."
    system_instruction = _SYSTEM_PROMPT + "\n\n" + today_line + ("\n\n" + context_text if context_text else "")

    for attempt in range(1, _GEMINI_MAX_ATTEMPTS + 1):
        try:
            response = client.models.generate_content(
                model=settings.GEMINI_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(system_instruction=system_instruction),
            )
            quota.add_usage(response)
            text = (response.text or "").strip()
            return (text, settings.GEMINI_MODEL) if text else (_GEMINI_ERROR_REPLY, None)
        except genai_errors.ServerError:
            if attempt == _GEMINI_MAX_ATTEMPTS:
                return _GEMINI_ERROR_REPLY, None
            time.sleep(1)  # Google tự khuyến nghị "thử lại sau" cho lỗi 503 này
        except Exception:
            return _GEMINI_ERROR_REPLY, None


def _generate_session_title(client: genai.Client, first_message: str) -> str:
    """Đặt tên phiên chat mới bằng chính Gemini — tóm tắt chủ đề thay vì cắt nguyên câu
    đầu (`_auto_title`). Chỉ 1 lượt gọi ngắn (không multi-turn, không system prompt của
    cuộc hội thoại chính) — lỗi/rỗng đều rơi về `_auto_title` cho chắc chắn (đặt tên phiên
    không được phép làm hỏng cả request gửi tin nhắn)."""
    try:
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=first_message)])],
            config=types.GenerateContentConfig(
                system_instruction=_TITLE_SYSTEM_PROMPT, max_output_tokens=20
            ),
        )
        title = _WHITESPACE_RE.sub(" ", (response.text or "").strip()).strip("\"'“”").strip()
        if title and len(title) <= _AUTO_TITLE_MAX_CHARS * 2:
            return title
    except Exception:
        pass
    return _auto_title(first_message)


# Whitelist định dạng (tương đương BR-14 cho PDF ở knowledge.py) — nhận PDF, ảnh phổ biến
# và .txt; KHÔNG nhận file thực thi/nén/office để tránh rác lưu trữ ngoài ý muốn.
_ALLOWED_CHAT_MIME = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "text/plain": ".txt",
}
_ALLOWED_CHAT_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".txt"}


def _resolve_chat_ext(file: UploadFile) -> str | None:
    ext = _ALLOWED_CHAT_MIME.get(file.content_type or "")
    if ext:
        return ext
    name = (file.filename or "").lower()
    for e in _ALLOWED_CHAT_EXT:
        if name.endswith(e):
            return ".jpg" if e == ".jpeg" else e
    return None


# ---------------------------------------------------------------------------
# Tra cứu có kiểm tra quyền sở hữu (BR-05) — cùng khuôn _get_owned_pdf (knowledge.py)
# ---------------------------------------------------------------------------
def _get_owned_attachment(db: Session, attachment_id: str, user: User) -> ChatAttachment:
    att = db.get(ChatAttachment, attachment_id)
    if att is None or att.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy đính kèm.")
    return att


def _get_owned_session(db: Session, session_id: str, user: User) -> ChatSession:
    session = db.get(ChatSession, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy đoạn chat.")
    return session


def _auto_title(content: str) -> str:
    """Tự đặt tên phiên chat mới từ tin nhắn đầu tiên — cùng công thức với
    chatSessionTitle() ở frontend/js/ghichu.js (giữ 2 nơi khớp nhau khi hiển thị)."""
    collapsed = _WHITESPACE_RE.sub(" ", content.strip())
    if not collapsed:
        return "Đoạn chat mới"
    if len(collapsed) > _AUTO_TITLE_MAX_CHARS:
        return collapsed[:_AUTO_TITLE_MAX_CHARS] + "…"
    return collapsed


# ---------------------------------------------------------------------------
# Lưu trữ file vật lý trên đĩa (KHÔNG có cột BLOB trong DB) — cùng khuôn
# _ensure_upload_dir/_delete_pdf_file (knowledge.py)
# ---------------------------------------------------------------------------
def _ensure_chat_upload_dir() -> Path:
    upload_dir = Path(settings.CHAT_ATTACHMENT_UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)
    return upload_dir


def _delete_attachment_file(rel_path: str | None) -> None:
    if not rel_path:
        return
    try:
        Path(rel_path).unlink(missing_ok=True)
    except OSError:
        pass  # dọn dẹp best-effort — không chặn thao tác DB vì lỗi filesystem


def _to_attachment_out(att: ChatAttachment) -> ChatAttachmentOut:
    chapter = att.chapter  # None nếu kind='file'
    return ChatAttachmentOut(
        id=att.id,
        kind=att.kind,
        label=att.label,
        status=att.status,
        chapter_id=att.chapter_id,
        subject_id=chapter.subject_id if chapter is not None else None,
        original_name=att.original_name,
        file_size_bytes=att.file_size_bytes,
        mime_type=att.mime_type,
        preview=(chapter.content_text or "")[:_PREVIEW_CHARS] if chapter is not None and not chapter.password_hash else None,
    )


def _to_session_out(db: Session, session: ChatSession, qa_used: int | None = None) -> ChatSessionOut:
    """`qa_used` = số câu trả lời AI thật của phiên (hạn mức Hỏi đáp theo cuộc hội thoại) — truyền sẵn khi đã
    đếm gộp (danh sách phiên), bỏ trống thì đếm riêng phiên này."""
    return ChatSessionOut(
        id=session.id, title=session.title or "Đoạn chat mới", scope=_Scope.of_session(session).out(),
        qa_used=quota.session_uses(db, session.id) if qa_used is None else qa_used,
        qa_limit=quota.get_settings(db)[quota.FEATURES["qa"][0]],
    )


# --- Đoạn cần bôi vàng khi bấm nguồn (UC-20 5a) ------------------------------------------------------------
# Chunk dài tới ~2000 ký tự nên không bôi cả chunk: chọn 1-3 câu liền nhau trong chunk trùng nhiều cặp từ (bigram —
# tiếng Việt mang nghĩa ở cặp âm tiết) nhất với câu trả lời của AI. Tính lúc trả API (không lưu DB, không gọi AI) nên
# áp dụng được cả cho lịch sử cũ.
_SENT_SPLIT = re.compile(r"(?<=[.!?…;:])\s+|\n+")
_WORD = re.compile(r"\w+", re.UNICODE)
_STOP = {"là", "của", "và", "các", "có", "trong", "được", "cho", "một", "những", "với", "này", "đó", "thì", "để",
         "theo", "từ", "khi", "như", "tài", "liệu", "chương", "tệp", "trang", "the", "a", "of"}


def _bigrams(text: str) -> set:
    w = [x for x in _WORD.findall(text.lower())]
    return {(a, b) for a, b in zip(w, w[1:]) if not (a in _STOP and b in _STOP)}


def _highlight_for(chunk_text: str, answer: str) -> str | None:
    answer = re.sub(r"\[[^\]]*\]", " ", answer or "")   # bỏ nhãn nguồn "[Chương: …]" Gemini chèn vào câu trả lời
    target = _bigrams(answer)
    sents = [s.strip() for s in _SENT_SPLIT.split(chunk_text or "") if len(s.strip()) >= 12]
    if not sents or not target:
        return None
    scores = [len(_bigrams(s) & target) for s in sents]
    best = max(range(len(sents)), key=lambda i: scores[i])
    if scores[best] == 0:
        return None
    lo = hi = best
    # nới sang câu bên cạnh nếu cũng liên quan (tối đa 3 câu, ~450 ký tự)
    for _ in range(2):
        cand = [(scores[i], i) for i in (lo - 1, hi + 1) if 0 <= i < len(sents) and scores[i] * 2 >= scores[best]]
        if not cand:
            break
        _, i = max(cand)
        if sum(len(s) for s in sents[min(lo, i):max(hi, i) + 1]) > 450:
            break
        lo, hi = min(lo, i), max(hi, i)
    return " ".join(sents[lo:hi + 1])


def _claims_for(answer: str, n: int) -> str:
    """Các câu / dòng của câu trả lời có ghi số [n] — đoạn bôi vàng của nguồn n chỉ so với đúng những câu này."""
    mark = f"[{n}]"
    parts = re.split(r"(?<=[.!?…])\s+|\n+", answer or "")
    hit = [p for p in parts if mark in p]
    return " ".join(hit) if hit else answer


def _to_message_out(message: ChatMessage) -> ChatMessageOut:
    # Bỏ qua citation nào embedding_chunk đã None — chunk gốc bị xoá/re-embed (FK SET NULL,
    # xem database/studio_chat_schema.sql), dòng citation vẫn còn trong DB làm lịch sử nhưng
    # không đủ dữ liệu để hiển thị lại (không phải lỗi).
    content = message.content or ""
    numbered = bool(_CITE_MARK.search(content))
    rows = [c for c in message.citations if c.embedding_chunk is not None]
    if numbered and len(rows) != len(message.citations):
        # Có nguồn đã mất (chunk bị xoá / re-embed): đánh lại số [n] theo các nguồn CÒN LẠI để số trong câu trả
        # lời vẫn khớp đúng danh sách "Nguồn"; số của nguồn đã mất bị bỏ.
        alive = {}
        for i, c in enumerate(message.citations, 1):
            if c.embedding_chunk is not None:
                alive[i] = len(alive) + 1
        content = _CITE_MARK.sub(
            lambda m: "".join(f"[{alive[int(x)]}]" for x in re.split(r"[,;]", m.group(1)) if int(x) in alive), content
        )
    if rows and not numbered:
        # Câu trả lời CŨ (trước khi trích theo số): khi đó mọi đoạn tìm được đều bị lưu làm nguồn. Chỉ giữ nguồn
        # được nhắc tên "[Chương: …]" / "[Tệp: …]" trong câu trả lời, mỗi nguồn 1 lần — không nhắc nguồn nào thì
        # không hiện "Nguồn" (khớp quy tắc đúng, đủ, không thừa của câu trả lời mới).
        named = {_norm_label(m) for m in _LABEL_MARK.findall(content)}
        seen, kept = set(), []
        for c in rows:
            key = _source_key(c.embedding_chunk)
            if _norm_label(_chunk_label(c.embedding_chunk)) in named and key not in seen:
                seen.add(key)
                kept.append(c)
        rows = kept
    citations = [
        ChatCitationOut(
            id=c.id,
            source_type=c.embedding_chunk.source_type,
            label=_chunk_label(c.embedding_chunk),
            page=c.embedding_chunk.source_location.get("page")
            if isinstance(c.embedding_chunk.source_location, dict)
            else None,
            total_pages=c.embedding_chunk.document.page_count if c.embedding_chunk.document is not None else None,
            preview=c.embedding_chunk.content[:200],
            highlight=_highlight_for(
                c.embedding_chunk.content, _claims_for(content, i) if numbered else content
            ),
            subject_id=c.embedding_chunk.subject_id,
            chapter_id=c.embedding_chunk.chapter_id,
            document_id=c.embedding_chunk.document_id,
        )
        for i, c in enumerate(rows, 1)
    ]
    return ChatMessageOut(id=message.id, role=message.role, content=content, citations=citations)


@router.get("/attachments", response_model=list[ChatAttachmentOut])
def list_chat_attachments(
    status_filter: str | None = Query(None, alias="status", pattern="^(pending|sent)$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Khôi phục lại chip ở ô nhập sau khi tải lại trang (`?status=pending`)."""
    stmt = select(ChatAttachment).where(ChatAttachment.user_id == current_user.id)
    if status_filter is not None:
        stmt = stmt.where(ChatAttachment.status == status_filter)
    rows = db.scalars(stmt.order_by(ChatAttachment.created_at)).all()
    return [_to_attachment_out(a) for a in rows]


@router.post("/attachments/chapter", response_model=ChatAttachmentOut, status_code=status.HTTP_201_CREATED)
def attach_chapter(
    payload: ChatChapterAttachRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapter = _get_owned_chapter(db, payload.chapter_id, current_user)  # 404 nếu không sở hữu — BR-05

    existing = db.scalar(
        select(ChatAttachment).where(
            ChatAttachment.user_id == current_user.id,
            ChatAttachment.kind == "chapter",
            ChatAttachment.chapter_id == chapter.id,
            ChatAttachment.status == "pending",
        )
    )
    if existing is not None:
        return _to_attachment_out(existing)  # đã đính kèm rồi -> trả lại chip cũ, không tạo trùng

    att = ChatAttachment(user_id=current_user.id, kind="chapter", label=chapter.name, chapter_id=chapter.id)
    db.add(att)
    db.commit()
    db.refresh(att)
    return _to_attachment_out(att)


@router.post("/attachments/file", response_model=ChatAttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_chat_attachment(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ext = _resolve_chat_ext(file)
    if ext is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Chỉ nhận tệp PDF, ảnh (PNG/JPG/WEBP/GIF) hoặc .txt.")

    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tệp rỗng.")
    quota.check_upload(db, current_user, len(content))   # BR-14 / UC-33 (ảnh chat không tính số tệp/môn)

    upload_dir = _ensure_chat_upload_dir()
    stored_name = f"{uuid.uuid4()}{ext}"
    disk_path = upload_dir / stored_name
    disk_path.write_bytes(content)
    rel_path = str(Path(settings.CHAT_ATTACHMENT_UPLOAD_DIR) / stored_name).replace("\\", "/")

    att = ChatAttachment(
        user_id=current_user.id,
        kind="file",
        label=file.filename or "tep-dinh-kem",
        original_name=file.filename or "tep-dinh-kem",
        file_path=rel_path,
        file_size_bytes=len(content),
        mime_type=file.content_type or "application/octet-stream",
        content_sha256=hashlib.sha256(content).hexdigest(),
    )
    db.add(att)
    db.flush()
    quota.refresh_level(db, current_user.id)
    db.commit()
    db.refresh(att)
    return _to_attachment_out(att)


@router.get("/attachments/{attachment_id}/file")
def download_chat_attachment(
    attachment_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    att = _get_owned_attachment(db, attachment_id, current_user)
    if att.kind != "file" or not att.file_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Đính kèm này không phải tệp tải lên.")
    disk_path = Path(att.file_path)
    if not disk_path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tệp đính kèm không còn trên server.")
    return FileResponse(disk_path, media_type=att.mime_type or "application/octet-stream", filename=att.original_name)


@router.post("/attachments/mark-sent", response_model=SimpleMessageResponse)
def mark_attachments_sent(
    payload: ChatAttachmentMarkSentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Bấm Gửi: đánh dấu cụm chip vừa gửi là 'sent' — id lạ/không sở hữu bị WHERE lọc
    bỏ êm, không cần tra từng cái (không leak 404)."""
    db.execute(
        update(ChatAttachment)
        .where(ChatAttachment.id.in_(payload.ids), ChatAttachment.user_id == current_user.id)
        .values(status="sent")
    )
    db.commit()
    return SimpleMessageResponse(message="Đã ghi nhận đính kèm.")


@router.delete("/attachments/{attachment_id}", response_model=SimpleMessageResponse)
def delete_chat_attachment(
    attachment_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    att = _get_owned_attachment(db, attachment_id, current_user)
    _delete_attachment_file(att.file_path)  # trước DB — file vật lý dọn best-effort
    db.delete(att)
    db.flush()
    quota.refresh_level(db, current_user.id)
    db.commit()
    return SimpleMessageResponse(message="Đã gỡ đính kèm.")


# ---------------------------------------------------------------------------
# AI Chat — phiên & tin nhắn thật (Bước 1), Gemini thật (Bước 2), RAG + trích dẫn
# (Bước 4), phạm vi nội dung nguồn UC-19 (Bước 5) — xem docstring đầu file.
# ---------------------------------------------------------------------------
@router.get("/scope-check", response_model=ChatScopeOut)
def check_chat_scope(
    subject_id: str | None = Query(None, max_length=36),
    chapter_id: str | None = Query(None, max_length=36),
    document_id: str | None = Query(None, max_length=36),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Kiểm tra trước 1 phạm vi (BR-05/BR-07) khi phiên chat còn là NHÁP (chưa có id thật ở
    backend) — để báo lỗi ngay lúc người dùng CHỌN phạm vi thay vì đợi tới lúc gửi tin nhắn
    đầu (UC-19 E1). Không ghi gì vào DB; phạm vi thật được lưu khi POST /chat/messages tạo
    phiên (`scope`) hoặc qua PUT /chat/sessions/{id}/scope."""
    req = ChatScopeRequest(subject_id=subject_id, chapter_id=chapter_id, document_id=document_id)
    return _resolve_scope(db, current_user, req).out()

@router.get("/sessions", response_model=list[ChatSessionOut])
def list_chat_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Danh sách "Gần đây" ở cột Studio — mới nhất (tin nhắn gần nhất) lên đầu."""
    rows = db.scalars(
        select(ChatSession)
        .where(ChatSession.user_id == current_user.id)
        .order_by(ChatSession.updated_at.desc())
    ).all()
    # Đếm gộp số câu trả lời AI thật của mọi phiên bằng 1 truy vấn (hạn mức Hỏi đáp theo cuộc hội thoại).
    used = dict(db.execute(
        select(ChatMessage.session_id, func.count())
        .join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .where(ChatSession.user_id == current_user.id, ChatMessage.role == "assistant", ChatMessage.model_name.is_not(None))
        .group_by(ChatMessage.session_id)
    ).all())
    return [_to_session_out(db, s, used.get(s.id, 0)) for s in rows]


@router.get("/sessions/{session_id}/messages", response_model=list[ChatMessageOut])
def list_session_messages(
    session_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """Mở lại 1 đoạn chat đã có — trả nguyên lịch sử tin nhắn theo thứ tự đã gửi."""
    session = _get_owned_session(db, session_id, current_user)
    return [_to_message_out(m) for m in session.messages]


@router.post("/messages", response_model=ChatSendMessageResponse, status_code=status.HTTP_201_CREATED)
def send_chat_message(
    payload: ChatSendMessageRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Gửi 1 tin nhắn. `session_id=None` tạo phiên mới — tiêu đề do chính Gemini tóm tắt
    (`_generate_session_title`) khi đã có key, ngược lại cắt nguyên câu đầu (`_auto_title`).
    Việc đặt tên phiên chạy trên 1 THREAD NỀN song song với retrieval + gọi Gemini trả lời
    chính (đo thật: đặt tên ~5s, embed+trả lời ~6.5s — chạy tuần tự sẽ mất ~11.5s/tin nhắn
    đầu phiên, chạy song song chỉ mất bằng thời gian bước chậm nhất; xem `title_thread` bên
    dưới) — CỐ TÌNH không gộp lại thành tuần tự, tránh mất hiệu năng đã đo được.
    Gọi Gemini thật (Bước 2, kèm lịch sử hội thoại + `attachment_ids` đính kèm thủ công +
    Bước 4: chunk tìm được tự động qua vector search — xem `_build_retrieved_context`) nếu đã
    cấu hình GEMINI_API_KEY, ngược lại rơi về câu trả lời cố định (xem `_generate_ai_reply`)
    — cả 2 tin nhắn (user + assistant) luôn được lưu thật vào DB, kèm citation thật (BR-09)
    cho các chunk đã dùng khi Gemini thật sự trả lời. Vector search bị giới hạn theo phạm vi
    của phiên (Bước 5, UC-19): phiên mới lấy từ `payload.scope` (kiểm BR-05/BR-07 qua
    `_resolve_scope`), phiên cũ dùng phạm vi đã lưu."""
    content = payload.content.strip()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nội dung tin nhắn không được để trống.")
    if payload.session_id is not None:
        session = _get_owned_session(db, payload.session_id, current_user)   # 404 trước khi đếm lượt
    # BR-08 / UC-20 E2: hạn mức "Hỏi đáp" tính THEO CUỘC HỘI THOẠI (services/quota.py PER_SESSION) — phiên đã đủ
    # lượt thì 429 code 'session_limit' trước khi gọi API nào; người dùng phải mở cuộc hội thoại mới.
    tracker = quota.start(db, current_user, "qa", session_id=payload.session_id)

    if payload.session_id is not None:
        scope = _Scope.of_session(session)
        title_thread = None
        title_box = None
    else:
        # Kiểm phạm vi TRƯỚC khi khởi động thread đặt tên — phạm vi sai (400/404) thì không
        # tạo phiên, không tốn lượt gọi Gemini nào.
        scope = _resolve_scope(db, current_user, payload.scope)
        client = _get_gemini_client()
        title_box: dict = {}
        if client is not None:
            # _generate_session_title là hàm thuần (chỉ gọi Gemini API, KHÔNG đụng db/Session
            # nào) nên chạy trên thread khác an toàn tuyệt đối — Gemini call là I/O, GIL nhả
            # ra lúc chờ mạng nên có concurrency thật với luồng chính bên dưới.
            title_thread = threading.Thread(
                target=lambda: title_box.__setitem__("title", _generate_session_title(client, content)),
                daemon=True,
            )
            title_thread.start()
        else:
            title_thread = None
        # Tên tạm (không gọi API, gần như free) — bị ghi đè bằng tên Gemini sinh ra nếu
        # title_thread xong kịp trước lúc join() ở dưới; lỗi/timeout thì giữ nguyên tên này.
        session = ChatSession(user_id=current_user.id, title=_auto_title(content))
        scope.apply_to(session)
        db.add(session)
        db.flush()  # cần session.id (UUID sinh ở default=_uuid) trước khi gắn message vào

    # Đọc lịch sử + gọi Gemini TRƯỚC khi thêm tin nhắn mới vào session.messages — history
    # ở đây là các lượt ĐÃ có, tin nhắn user vừa gõ được nối thêm riêng trong _generate_ai_reply.
    history = list(session.messages)
    attachment_context, attached_chapter_ids = _build_attachment_context(db, payload.attachment_ids, current_user)
    retrieved_context, retrieved_chunks = _build_retrieved_context(
        db, current_user, content, scope, chapter_ids=attached_chapter_ids
    )
    context_text = "\n\n".join(t for t in (attachment_context, retrieved_context) if t) or _NO_CONTEXT_NOTE
    reply_text, model_used = _generate_ai_reply(history, content, context_text)
    cited_chunks: list[EmbeddingChunk] = []
    if model_used is not None:
        reply_text, cited_chunks = _select_citations(reply_text, retrieved_chunks)
        quota.done(tracker, model_used)
    elif reply_text == _GEMINI_ERROR_REPLY:
        quota.failed(tracker, model=settings.GEMINI_MODEL)   # câu dự phòng khi lỗi Gemini: không trừ lượt

    user_message = ChatMessage(session_id=session.id, role="user", content=content)
    db.add(user_message)
    assistant_message = ChatMessage(
        session_id=session.id, role="assistant", content=reply_text, model_name=model_used
    )
    db.add(assistant_message)
    db.flush()  # cần assistant_message.id (autoincrement) trước khi ghi citation bên dưới

    # Chỉ ghi citation cho các đoạn Gemini THỰC SỰ trích (số [n] trong câu trả lời, xem _select_citations) —
    # CANNED_REPLY/GEMINI_ERROR_REPLY không dựa trên chunk nào nên không có nguồn (BR-09). Ghi đúng thứ tự [1], [2]…
    for chunk in cited_chunks:
        db.add(ChatMessageCitation(message_id=assistant_message.id, embedding_chunk_id=chunk.id))

    # Gộp lại kết quả thread đặt tên phiên (đã chạy song song từ đầu request, xem trên) —
    # timeout=10 chỉ để phòng hờ Gemini treo bất thường, không chờ vô hạn. Timeout/lỗi/rỗng
    # đều giữ nguyên tên tạm _auto_title(content) đã gán lúc tạo session, không raise.
    if title_thread is not None:
        title_thread.join(timeout=10)
        new_title = title_box.get("title")
        if new_title:
            session.title = new_title

    # Đẩy phiên lên đầu "Gần đây" — gán trực tiếp thay vì trông chờ server_onupdate của
    # DB (chỉ tự chạy khi CHÍNH bảng chat_sessions có cột đổi giá trị trong 1 UPDATE,
    # mà ở đây ta chỉ INSERT các dòng chat_messages con).
    session.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(session)
    db.refresh(user_message)
    db.refresh(assistant_message)
    return ChatSendMessageResponse(
        session=_to_session_out(db, session),
        user_message=_to_message_out(user_message),
        assistant_message=_to_message_out(assistant_message),
    )


@router.patch("/sessions/{session_id}", response_model=ChatSessionOut)
def rename_chat_session(
    session_id: str,
    payload: ChatSessionRenameRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = _get_owned_session(db, session_id, current_user)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tên đoạn chat không được để trống.")
    session.title = title
    db.commit()
    db.refresh(session)
    return _to_session_out(db, session)


@router.put("/sessions/{session_id}/scope", response_model=ChatSessionOut)
def update_chat_session_scope(
    session_id: str,
    payload: ChatScopeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Đổi phạm vi nội dung nguồn (UC-19) của 1 phiên đã tồn tại — áp dụng từ câu hỏi tiếp
    theo, không ảnh hưởng các câu trả lời/citation cũ. Cả 3 field None = về "Toàn bộ"."""
    session = _get_owned_session(db, session_id, current_user)
    _resolve_scope(db, current_user, payload).apply_to(session)
    db.commit()
    db.refresh(session)
    return _to_session_out(db, session)


@router.delete("/sessions/{session_id}", response_model=SimpleMessageResponse)
def delete_chat_session(
    session_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    session = _get_owned_session(db, session_id, current_user)
    db.delete(session)  # cascade xuống chat_messages/chat_message_citations (DB FK)
    db.commit()
    return SimpleMessageResponse(message="Đã xoá đoạn chat.")
