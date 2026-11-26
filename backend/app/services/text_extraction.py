"""Trích văn bản từ PDF/ảnh/.txt — dùng chung cho `routers/chat.py` (đính kèm ngữ cảnh ở ô
nhập AI Chat, Bước 2 lộ trình RAG) và `services/embeddings.py` (chunking + embedding, Bước 3).
Trước đây các hàm này nằm private trong `chat.py`; tách ra đây khi làm Bước 3 để không trùng
lặp logic OCR ở 2 nơi (Bước 3 cũng cần đọc PDF/ảnh để chunk).

Không raise: lỗi/không hỗ trợ định dạng/thiếu Tesseract đều trả chuỗi (hoặc list) rỗng — nơi
gọi tự coi như "không trích được gì", không chặn luồng chính (gửi tin nhắn / lưu Chương/PDF).
"""
import html
import re
from pathlib import Path

import pytesseract
from PIL import Image

import fitz  # PyMuPDF

from app.config import settings

if settings.TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = settings.TESSERACT_CMD

_OCR_LANGS = "eng+vie"

# HTML CKEditor -> văn bản thuần (chapters.content_text). Thẻ KHỐI (đoạn, tiêu đề, mục danh
# sách, ô bảng...) thành dòng trống để chunk_text() tách theo đoạn; thẻ INLINE (<span>,
# <strong>...) bỏ hẳn, KHÔNG thay bằng dấu cách — nội dung dán từ Word hay cắt giữa 1 chữ
# ("xây d</span><span>ựng") nên thay bằng dấu cách sẽ ra "xây d ựng". Thực thể HTML (&nbsp;,
# &amp;...) được giải mã, nếu không AI và trích dẫn (BR-09) sẽ hiện nguyên "&nbsp;".
_BLOCK_TAG_RE = re.compile(
    r"</?(?:p|div|h[1-6]|li|ul|ol|table|thead|tbody|tr|td|th|blockquote|pre|figure|figcaption|section|article)\b[^>]*>",
    re.IGNORECASE,
)
_BR_TAG_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_ANY_TAG_RE = re.compile(r"<[^>]+>")
_SPACES_RE = re.compile(r"[ \t\r\f\v ​]+")
_BLANK_LINES_RE = re.compile(r"\n\s*\n\s*")


def html_to_text(html_src: str) -> str:
    text = _BLOCK_TAG_RE.sub("\n\n", html_src or "")
    text = _BR_TAG_RE.sub("\n", text)
    text = html.unescape(_ANY_TAG_RE.sub("", text))
    lines = (_SPACES_RE.sub(" ", line).strip() for line in text.split("\n"))
    return _BLANK_LINES_RE.sub("\n\n", "\n".join(lines)).strip()


# Giới hạn số trang CHẠY OCR (tốn CPU, ~1-2s/trang) trong 1 PDF — KHÔNG áp dụng cho trang
# có sẵn lớp text thật (đọc text trực tiếp rất nhanh, đọc hết cả file dù dài bao nhiêu
# trang). Chỉ trang PDF scan/không có lớp text mới tính vào giới hạn này, để 1 file scan
# quá dài không làm request treo lâu (chưa xử lý nền/async job cho việc này).
_OCR_MAX_PAGES_PER_PDF = 5


def tesseract_config() -> str:
    # KHÔNG bọc dấu ngoặc kép quanh path — pytesseract chuyển thẳng config này cho
    # subprocess mà không tự bỏ ngoặc kiểu shell, nên `"tessdata"` sẽ bị Tesseract hiểu
    # nhầm thành tên thư mục có cả 2 dấu ngoặc kép trong đó (đã xác nhận qua traceback
    # thật lúc test: 'Error opening data file "tessdata"/eng.traineddata'). Do đó
    # TESSDATA_DIR không được chứa khoảng trắng (mặc định "tessdata" trong backend/ là ổn).
    return f"--tessdata-dir {settings.TESSDATA_DIR}" if settings.TESSDATA_DIR else ""


def ocr_image(image: Image.Image) -> str:
    try:
        return pytesseract.image_to_string(image, lang=_OCR_LANGS, config=tesseract_config())
    except Exception:
        return ""  # thiếu Tesseract/lỗi OCR -> coi như không đọc được, không chặn tin nhắn


def extract_pdf_pages(disk_path: Path) -> list[str]:
    """Trả văn bản theo TỪNG TRANG (thứ tự đúng số trang trong file) — Bước 3 cần biết đúng
    trang để ghi `source_location={"page": N}` cho từng chunk (UC-20 luồng thay thế 5a — bấm
    trích dẫn nhảy đúng vị trí). Ưu tiên đọc lớp text thật của PDF (nhanh, chính xác tuyệt
    đối — CV/tài liệu xuất từ Word thường có sẵn lớp này) — đọc HẾT mọi trang, không giới
    hạn. Trang nào KHÔNG có lớp text (PDF scan/ảnh chụp) mới render ra ảnh rồi OCR, tối đa
    `_OCR_MAX_PAGES_PER_PDF` trang scan (các trang scan còn lại bị bỏ qua để tránh request
    treo quá lâu — trang có lớp text thật thì không bị ảnh hưởng bởi giới hạn này). Trang
    không trích được gì (kể cả sau OCR) trả chuỗi rỗng ở đúng vị trí trong list (giữ đúng số
    thứ tự trang thay vì bỏ hẳn trang đó)."""
    try:
        doc = fitz.open(disk_path)
    except Exception:
        return []
    try:
        pages = []
        ocr_pages_used = 0
        for page in doc:
            text = page.get_text().strip()
            if not text:
                if ocr_pages_used >= _OCR_MAX_PAGES_PER_PDF:
                    pages.append("")
                    continue  # đã OCR đủ số trang scan cho phép -> bỏ qua, không dừng cả file
                ocr_pages_used += 1
                pix = page.get_pixmap(dpi=200)
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                text = ocr_image(image).strip()
            pages.append(text)
        return pages
    finally:
        doc.close()


def extract_pdf_text(disk_path: Path) -> str:
    """Wrapper mỏng nối các trang lại — giữ nguyên hành vi trước khi tách hàm này ra
    (chỗ gọi cũ ở `_build_attachment_context` trong chat.py chỉ cần 1 chuỗi, không cần biết
    theo trang)."""
    return "\n\n".join(p for p in extract_pdf_pages(disk_path) if p)


def extract_file_text(disk_path: Path, mime_type: str) -> str:
    """Trích văn bản từ tệp đính kèm kind='file' (PDF/ảnh/.txt), dùng ở `chat.py`.
    Không raise: lỗi/không hỗ trợ định dạng đều trả chuỗi rỗng."""
    try:
        if mime_type == "application/pdf":
            return extract_pdf_text(disk_path)
        if mime_type.startswith("image/"):
            return ocr_image(Image.open(disk_path))
        if mime_type == "text/plain":
            return disk_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        pass
    return ""
