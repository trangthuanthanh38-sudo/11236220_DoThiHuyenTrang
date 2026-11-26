"""UC-25 (Tạo sơ đồ tư duy theo chương): dựng 1 sơ đồ cây từ các nguồn (Chương / Tệp PDF) người học đã
tick, lưu vào các bảng mindmap_* (database/studio_tools_mindmap_schema.sql).

Cấu trúc cây (đúng mẫu so-do-tu-duy.html): gốc (depth 0) = tên Môn học; mỗi nguồn đã tick = 1 nhánh lớn
(depth 1, do SERVER tạo, trích dẫn = chính nguồn đó); dưới mỗi nhánh tối đa `depth` cấp do AI sinh
(Ý chính → Ý phụ → Chi tiết → Ví dụ). Mỗi node AI có trích dẫn snapshot (BR-09) lấy từ đúng đoạn nguồn.

Dùng lại nguyên các bước chung của quiz_generation.py (cùng triết lý tiết kiệm quota như Flashcard): lấy
mẫu chunk ĐÃ embed của nguồn (không gọi embedding API), ĐÚNG 1 lượt `generate_content` với
`response_schema`, chuỗi model QUIZ_MODEL -> QUIZ_FALLBACK_MODEL, báo đúng loại lỗi. Khuôn JSON là danh
sách node PHẲNG (key + parent) thay vì cây lồng nhau — tránh schema đệ quy mà response_schema không hỗ trợ.

"Dựng khung từ tiêu đề có sẵn" (build_method='headings'): kèm dàn ý tiêu đề trích sẵn (Chương: thẻ
<h1>-<h4> trong chapters.content_json; PDF: mục lục get_toc() của file) để AI bám bố cục tài liệu;
'auto' thì AI tự gom ý. Nội dung không có phân cấp -> các ý nằm ngang hàng ngay dưới nhánh (UC-25 E1,
mindmaps.is_flat). Không raise khi LLM lỗi: sơ đồ chuyển `status='failed'` + `error_message`.
"""
import html
import re

import fitz  # PyMuPDF
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.models import Chapter, EmbeddingChunk, Mindmap, MindmapNode, MindmapSource, PdfDocument, Subject, User
from app.services.quiz_generation import _clean, _generate, _label, _norm, _quote_for, _source_label

MAX_TREE_DEPTH = 12                    # khớp CHECK chk_mindmap_nodes_depth (InnoDB cascade tối đa 15 tầng)
_MAX_NODES_PER_BRANCH, _MAX_NODES = 30, 120
_MAX_LABEL = 160                       # nhãn dài hơn thế không còn là "ý" của sơ đồ -> bỏ
_MIN_CHUNKS, _MAX_CHUNKS, _CHUNKS_PER_SOURCE = 8, 60, 12
_MAX_OUTLINE_LINES = 60
_LEVEL_VI = ["Ý chính", "Ý phụ", "Chi tiết", "Ví dụ"]
_FAIL_WORD_RE = re.compile(r"câu hỏi", re.IGNORECASE)
_HEADING_RE = re.compile(r"<h([1-4])[^>]*>(.*?)</h\1\s*>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_BRANCH_RE = re.compile(r"[Bb]\d+")


# --- Khuôn JSON ép Gemini trả về (response_schema) -------------------------------------------
class _GenNode(BaseModel):
    key: str          # mã node do AI đặt, vd. "n1"
    parent: str       # "B1".. (nhánh = nguồn thứ i) hoặc key của node cha
    label: str        # nội dung ngắn của ý
    source_ref: str   # mã đoạn nguồn, vd. "S3"
    quote: str        # câu trích NGUYÊN VĂN từ đoạn nguồn đó


class _GenMap(BaseModel):
    nodes: list[_GenNode]


_SYSTEM_PROMPT = (
    "Bạn là giảng viên dựng SƠ ĐỒ TƯ DUY giúp sinh viên Việt Nam ôn tập. Chỉ được dùng thông tin trong các "
    "ĐOẠN NGUỒN được cung cấp (mỗi đoạn có mã dạng [S1], [S2]...) — tuyệt đối không dùng kiến thức bên "
    "ngoài, không bịa. Viết bằng đúng ngôn ngữ của đoạn nguồn (mặc định tiếng Việt).\n"
    "Sơ đồ đã có sẵn các NHÁNH LỚN mã B1, B2... (mỗi nhánh là 1 tài liệu). Nhiệm vụ: tạo các ý con bên dưới "
    "từng nhánh, phân cấp từ khái quát đến cụ thể.\n"
    "Trả về DANH SÁCH PHẲNG các node; mỗi node gồm:\n"
    "• key: mã duy nhất do bạn đặt (n1, n2...).\n"
    "• parent: mã nhánh (B1, B2...) nếu là ý cấp 1, hoặc key của node cha (node cha phải xuất hiện trước).\n"
    "• label: cụm từ NGẮN GỌN (tối đa khoảng 8-10 từ), không phải câu dài, không đánh số.\n"
    "• source_ref: mã của đúng 1 đoạn nguồn chứa căn cứ cho ý đó.\n"
    "• quote: 1 câu/cụm trích NGUYÊN VĂN từ đoạn nguồn đó (không diễn đạt lại).\n"
    "Mã [S1], [B1]... chỉ dùng cho parent/source_ref — KHÔNG nhắc tới mã hay cụm \"đoạn nguồn\" trong label. "
    "Không tạo 2 node trùng ý dưới cùng 1 cha. Nếu nội dung KHÔNG có cấu trúc phân cấp rõ ràng (vd. văn bản kể "
    "chuyện, liệt kê sự kiện) thì chỉ tạo các ý cấp 1 ngang hàng dưới nhánh, không cố bịa thêm cấp."
)


# --- Dàn ý tiêu đề có sẵn (build_method='headings') ------------------------------------------
def _chapter_outline(chapter: Chapter) -> list[str]:
    lines = []
    for level, inner in _HEADING_RE.findall(chapter.content_json or ""):
        title = _clean(html.unescape(_TAG_RE.sub(" ", inner)))
        if title:
            lines.append("  " * (int(level) - 1) + "- " + title[:_MAX_LABEL])
    return lines[:_MAX_OUTLINE_LINES]


def _pdf_outline(document: PdfDocument) -> list[str]:
    try:
        with fitz.open(document.file_path) as doc:
            toc = doc.get_toc(simple=True)
    except Exception:  # noqa: BLE001 — không đọc được mục lục thì coi như không có dàn ý
        return []
    lines = []
    for level, title, page in toc:
        title = _clean(str(title))
        if title and level <= 4:
            lines.append("  " * (level - 1) + "- " + title[:_MAX_LABEL] + (f" (trang {page})" if page else ""))
    return lines[:_MAX_OUTLINE_LINES]


def _outline(source: Chapter | PdfDocument) -> list[str]:
    return _chapter_outline(source) if isinstance(source, Chapter) else _pdf_outline(source)


def _branch_of(chunk: EmbeddingChunk, sources: list[Chapter | PdfDocument]) -> int:
    for i, s in enumerate(sources):
        if (isinstance(s, Chapter) and chunk.chapter_id == s.id and chunk.source_type != "PDF") or (
            isinstance(s, PdfDocument) and chunk.document_id == s.id
        ):
            return i
    return 0


def _build_prompt(
    chunks: list[EmbeddingChunk], sources: list[Chapter | PdfDocument], depth: int, method: str
) -> str:
    groups: list[list[str]] = [[] for _ in sources]
    for i, chunk in enumerate(chunks, start=1):
        name, page = _label(chunk)
        groups[_branch_of(chunk, sources)].append(f"[S{i}] ({name}" + (f", trang {page}" if page else "") + f")\n{chunk.content}")
    levels = " → ".join(_LEVEL_VI[:depth])
    parts = []
    for b, (src, texts) in enumerate(zip(sources, groups), start=1):
        head = f"=== NHÁNH B{b}: {_source_label(src)} ==="
        outline = _outline(src) if method == "headings" else []
        if outline:
            head += "\nDÀN Ý TIÊU ĐỀ CÓ SẴN CỦA TÀI LIỆU NÀY:\n" + "\n".join(outline)
        parts.append(head + "\n\n" + ("\n\n---\n\n".join(texts) if texts else "(không có đoạn nguồn)"))
    how = (
        "Dựng khung BÁM SÁT dàn ý tiêu đề có sẵn của từng tài liệu (tiêu đề lớn -> ý cấp 1, tiêu đề con -> ý cấp "
        "dưới); tài liệu nào không có dàn ý thì tự gom ý theo nội dung."
        if method == "headings"
        else "Tự phân tích nội dung và gom các ý liên quan thành nhóm (không cần bám tiêu đề của tài liệu)."
    )
    return (
        f"Tạo các ý cho từng nhánh, TỐI ĐA {depth} cấp dưới mỗi nhánh ({levels}); mỗi nhánh khoảng 3-6 ý cấp 1, "
        f"mỗi ý tối đa khoảng 4 ý con, tổng không quá {_MAX_NODES_PER_BRANCH} node mỗi nhánh. {how}\n\n"
        + "\n\n".join(parts)
    )


def _valid_nodes(
    raw: list[_GenNode], refs: dict[str, EmbeddingChunk], n_branches: int, depth: int
) -> list[tuple[_GenNode, str, int, EmbeddingChunk]]:
    """Lọc node hỏng: nhãn rỗng/quá dài, cha không tồn tại (gồm vòng lặp — cha phải đứng trước), quá độ sâu,
    trùng ý dưới cùng cha, vượt trần node. Mã nguồn lạ thì mượn đoạn nguồn của node cha (vẫn trích dẫn được).
    Trả [(node, parent_key, độ sâu tính từ nhánh 1..depth, chunk)] theo thứ tự AI trả."""
    kept: list[tuple[_GenNode, str, int, EmbeddingChunk]] = []
    info: dict[str, tuple[int, int, EmbeddingChunk | None]] = {  # key -> (độ sâu, nhánh, chunk)
        f"B{b}": (0, b, None) for b in range(1, n_branches + 1)
    }
    seen: set[tuple[str, str]] = set()
    per_branch: dict[int, int] = {}
    for n in raw:
        n.label = _clean(n.label).strip(" -•*").strip()
        key, parent = n.key.strip(), n.parent.strip().strip("[]")
        if _BRANCH_RE.fullmatch(parent):
            parent = parent.upper()   # "b1" / "[B1]" -> "B1"
        if not n.label or len(n.label) > _MAX_LABEL or not key or key in info or parent not in info:
            continue
        p_depth, branch, p_chunk = info[parent]
        if p_depth + 1 > depth or (parent, _norm(n.label)) in seen:
            continue
        if per_branch.get(branch, 0) >= _MAX_NODES_PER_BRANCH or len(kept) >= _MAX_NODES:
            continue
        chunk = refs.get(n.source_ref.strip().strip("[]").upper()) or p_chunk
        if chunk is None:
            continue  # ý cấp 1 không có đoạn nguồn hợp lệ -> không trích dẫn được (BR-09)
        seen.add((parent, _norm(n.label)))
        per_branch[branch] = per_branch.get(branch, 0) + 1
        info[key] = (p_depth + 1, branch, chunk)
        kept.append((n, parent, p_depth + 1, chunk))
    return kept


def _fail(db: Session, mindmap: Mindmap, message: str) -> Mindmap:
    mindmap.status, mindmap.error_message = "failed", message[:500]
    db.commit()
    return mindmap


def generate_mindmap(
    db: Session,
    user: User,
    subject: Subject,
    sources: list[Chapter | PdfDocument],
    title: str,
    depth: int = 3,
    build_method: str = "headings",
    layout: str = "tree",
    show_citation: bool = True,
    ask_qa: bool = True,
) -> Mindmap:
    """Tạo + lưu 1 sơ đồ. Nơi gọi (router) phải kiểm trước BR-05/BR-07 (_validate_sources) và BR-08.
    Luôn trả Mindmap đã commit: 'ready' hoặc 'failed' + error_message."""
    mindmap = Mindmap(
        user_id=user.id,
        subject_id=subject.id,
        title=title[:200],
        depth=depth,
        build_method=build_method,
        layout=layout,
        show_citation=show_citation,
        ask_qa=ask_qa,
        status="generating",
    )
    mindmap.sources = [
        MindmapSource(
            position=i,
            source_type="CHAPTER" if isinstance(s, Chapter) else "PDF",
            chapter_id=s.id if isinstance(s, Chapter) else None,
            document_id=s.id if isinstance(s, PdfDocument) else None,
            source_label=_source_label(s)[:255],
        )
        for i, s in enumerate(sources, start=1)
    ]
    db.add(mindmap)
    db.flush()

    budget = min(_MAX_CHUNKS, max(_MIN_CHUNKS, _CHUNKS_PER_SOURCE * len(sources)))
    # _generate (quiz_generation) chỉ dùng status/error_message/model_name nên nhận được Mindmap.
    chunks, result = _generate(
        db, mindmap, sources, budget, lambda c: _build_prompt(c, sources, depth, build_method), _GenMap, _SYSTEM_PROMPT
    )
    if result is None:
        mindmap.error_message = _FAIL_WORD_RE.sub("sơ đồ tư duy", mindmap.error_message or "")[:500]
        db.commit()
        return mindmap
    refs = {f"S{i}": c for i, c in enumerate(chunks, start=1)}
    kept = _valid_nodes(result.nodes, refs, len(sources), depth)
    if not kept:
        return _fail(db, mindmap, "Không dựng được sơ đồ từ nội dung đã chọn — hãy chọn thêm nguồn hoặc thử lại.")

    # Gốc + nhánh lớn (server tạo), rồi các node AI theo từng tầng (flush để có id cha).
    root = MindmapNode(mindmap_id=mindmap.id, parent_id=None, depth=0, position=1, label=subject.name[:500])
    db.add(root)
    db.flush()
    ids: dict[str, int] = {}
    for b, s in enumerate(sources, start=1):
        node = MindmapNode(
            mindmap_id=mindmap.id, parent_id=root.id, depth=1, position=b, label=_source_label(s)[:500],
            source_type="CHAPTER" if isinstance(s, Chapter) else "PDF",
            chapter_id=s.id if isinstance(s, Chapter) else None,
            document_id=s.id if isinstance(s, PdfDocument) else None,
            source_label=_source_label(s)[:255],
        )
        db.add(node)
        db.flush()
        ids[f"B{b}"] = node.id
    positions: dict[str, int] = {}
    for level in range(1, depth + 1):
        for n, parent, d, chunk in kept:
            if d != level:
                continue
            positions[parent] = positions.get(parent, 0) + 1
            name, page = _label(chunk)
            node = MindmapNode(
                mindmap_id=mindmap.id, parent_id=ids[parent], depth=d + 1, position=positions[parent],
                label=n.label[:500],
                source_type="PDF" if chunk.source_type == "PDF" else "CHAPTER",
                chapter_id=chunk.chapter_id,
                document_id=chunk.document_id,
                embedding_chunk_id=chunk.id,
                source_label=name[:255],
                page_number=page,
                quote=_quote_for(n, chunk),
            )
            db.add(node)
            db.flush()
            ids[n.key.strip()] = node.id
    mindmap.is_flat = all(d <= 1 for _, _, d, _ in kept)   # UC-25 E1: chỉ có ý cấp 1
    mindmap.status = "ready"
    db.commit()
    return mindmap
