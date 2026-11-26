"""UC-25 Tạo sơ đồ tư duy theo chương (xem .claude/rules/08-ai-studio.md). Frontend:
frontend/js/ghichu_mindmap.js (khuôn request/response ghi ở đầu file đó). Sinh sơ đồ thật do
app/services/mindmap_generation.py làm (1 lượt gọi Gemini/sơ đồ, chuỗi model QUIZ_MODEL) — router chỉ kiểm
tra quyền + điều kiện nghiệp vụ TRƯỚC khi tốn lượt gọi AI (dùng chung _validate_sources của quiz.py):
  - BR-05: Môn học + từng nguồn (Chương/PDF) phải thuộc người dùng -> 404
  - mọi nguồn phải thuộc đúng `subject_id` (xoá Môn -> xoá sơ đồ) -> 400
  - BR-07 / UC-19 E1: nguồn phải có ít nhất 1 đoạn đã xử lý cho AI -> 400
  - BR-08: hạn mức lượt AI/ngày RIÊNG của tính năng 'mind' (services/quota.py) -> 429
Sơ đồ sinh lỗi bị XOÁ luôn và trả 502 kèm lý do (giống flashcards.py).

Khung vẽ (UC-25 bước 5): mỗi thao tác lưu ĐÚNG 1 node — sửa chữ/độ lệch kéo (PATCH), thêm nhánh con (POST,
origin='user', mượn trích dẫn của node cha), xoá node (DELETE — cả nhánh con mất theo FK CASCADE ghép, gốc
không xoá được). Vị trí node không lưu (client tự tính bố cục), chỉ lưu offset_x/offset_y. Mỗi lần lưu chạm
`mindmaps.updated_at` (ON UPDATE không bắt khi chỉ sửa node) rồi trả khoảng TƯƠNG ĐỐI `updated_seconds_ago`
theo giờ DB (DATETIME không kèm múi giờ).

Hoàn tác / làm lại (Ctrl+Z / Ctrl+Y ở khung vẽ): sửa chữ / kéo node dùng lại PATCH, bỏ thêm node dùng DELETE;
riêng dựng lại nhánh đã xoá (hoặc làm lại "Thêm node") dùng POST .../nodes/restore — giữ đúng vị trí giữa các node
anh em, origin và trích dẫn gốc (POST .../nodes thường chỉ mượn trích dẫn của cha). Node dựng lại có id MỚI.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, literal_column, select, text
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db
from app.models import Chapter, Mindmap, MindmapNode, MindmapSource, PdfDocument, Subject, User
from app.routers.quiz import _validate_sources
from app.schemas import (
    MindmapCitationOut,
    MindmapCreateRequest,
    MindmapNodeCreate,
    MindmapNodeOut,
    MindmapNodeUpdate,
    MindmapOut,
    MindmapRestoreNode,
    MindmapRestoreOut,
    MindmapRestoreRequest,
    MindmapSavedOut,
    MindmapSummaryOut,
    MindmapUpdateRequest,
    SimpleMessageResponse,
)
from app.services import mindmap_generation, quota

router = APIRouter(prefix="/mindmaps", tags=["AI Studio — Sơ đồ tư duy (UC-25)"])
_SECOND = literal_column("SECOND")   # đơn vị của TIMESTAMPDIFF (MySQL)


def _seconds_ago(db: Session, mindmap_id: str) -> int:
    value = db.scalar(
        select(func.timestampdiff(_SECOND, Mindmap.updated_at, func.now())).where(Mindmap.id == mindmap_id)
    )
    return max(0, int(value or 0))


def _node_out(n: MindmapNode) -> MindmapNodeOut:
    return MindmapNodeOut(
        id=n.id,
        parent_id=n.parent_id,
        depth=n.depth,
        position=n.position,
        label=n.label,
        origin=n.origin,
        offset_x=n.offset_x or 0,
        offset_y=n.offset_y or 0,
        citation=MindmapCitationOut(
            source_type=n.source_type,
            chapter_id=n.chapter_id,
            document_id=n.document_id,
            source_label=n.source_label,
            page_number=n.page_number,
            quote=n.quote,
        ) if n.source_type and n.source_label else None,
    )


def _map_out(db: Session, m: Mindmap) -> MindmapOut:
    nodes = db.scalars(
        select(MindmapNode).where(MindmapNode.mindmap_id == m.id)
        .order_by(MindmapNode.depth, MindmapNode.position, MindmapNode.id)
    ).all()
    return MindmapOut(
        id=m.id,
        title=m.title,
        subject_id=m.subject_id,
        depth=m.depth,
        build_method=m.build_method,
        layout=m.layout,
        show_citation=m.show_citation,
        ask_qa=m.ask_qa,
        is_flat=m.is_flat,
        updated_seconds_ago=_seconds_ago(db, m.id),
        nodes=[_node_out(n) for n in nodes],
    )


def _get_owned_map(db: Session, mindmap_id: str, user: User) -> Mindmap:
    m = db.get(Mindmap, mindmap_id)
    if m is None or m.user_id != user.id or m.status != "ready":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy sơ đồ tư duy.")
    return m


def _get_node(db: Session, m: Mindmap, node_id: int) -> MindmapNode:
    n = db.get(MindmapNode, node_id)
    if n is None or n.mindmap_id != m.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Không tìm thấy node trong sơ đồ này.")
    return n


def _touch(db: Session, m: Mindmap) -> MindmapSavedOut:
    """Chạm mindmaps.updated_at (cột "Cập nhật" / nhãn "Đã lưu lúc") rồi commit."""
    m.updated_at = func.now()
    db.commit()
    return MindmapSavedOut(updated_seconds_ago=_seconds_ago(db, m.id))


@router.post("", response_model=MindmapOut, status_code=status.HTTP_201_CREATED)
def create_mindmap(
    payload: MindmapCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    subject, sources = _validate_sources(db, current_user, payload.subject_id, payload.sources, what="sơ đồ")
    tracker = quota.start(db, current_user, "mind")

    m = mindmap_generation.generate_mindmap(
        db, current_user, subject, sources, payload.title, payload.depth, payload.build_method,
        payload.layout, payload.show_citation, payload.ask_qa,
    )
    if m.status != "ready":
        quota.failed(tracker, model=m.model_name)
        message = m.error_message or "Không tạo được sơ đồ tư duy."
        db.delete(m)
        db.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, message)
    quota.done(tracker, m.model_name)
    db.refresh(m)
    return _map_out(db, m)


@router.get("", response_model=list[MindmapSummaryOut])
def list_mindmaps(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Tab "Đã tạo": mới cập nhật lên đầu. Số node / độ sâu lớn nhất tính bằng 1 truy vấn GROUP BY."""
    maps = db.execute(
        select(Mindmap, Subject.name, func.timestampdiff(_SECOND, Mindmap.updated_at, func.now()))
        .join(Subject, Subject.id == Mindmap.subject_id)
        .where(Mindmap.user_id == current_user.id, Mindmap.status == "ready")
        .order_by(Mindmap.updated_at.desc(), Mindmap.created_at.desc())
    ).all()
    ids = [m.id for m, _, _ in maps]
    stats = {
        mid: (cnt, depth)
        for mid, cnt, depth in db.execute(
            select(MindmapNode.mindmap_id, func.count(), func.max(MindmapNode.depth))
            .where(MindmapNode.mindmap_id.in_(ids)).group_by(MindmapNode.mindmap_id)
        ).all()
    } if ids else {}
    labels: dict[str, list[str]] = {}
    if ids:
        for mid, label in db.execute(
            select(MindmapSource.mindmap_id, MindmapSource.source_label)
            .where(MindmapSource.mindmap_id.in_(ids)).order_by(MindmapSource.position)
        ).all():
            labels.setdefault(mid, []).append(label)
    return [
        MindmapSummaryOut(
            id=m.id,
            title=m.title,
            subject_id=m.subject_id,
            subject_name=subject_name,
            source_labels=labels.get(m.id, []),
            node_count=stats.get(m.id, (0, 0))[0],
            max_depth=stats.get(m.id, (0, 0))[1] or 0,
            is_flat=m.is_flat,
            updated_seconds_ago=max(0, int(ago or 0)),
        )
        for m, subject_name, ago in maps
    ]


@router.get("/{mindmap_id}", response_model=MindmapOut)
def get_mindmap(mindmap_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _map_out(db, _get_owned_map(db, mindmap_id, current_user))


@router.patch("/{mindmap_id}", response_model=MindmapSavedOut)
def rename_mindmap(
    mindmap_id: str,
    payload: MindmapUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    m = _get_owned_map(db, mindmap_id, current_user)
    m.title = payload.title[:200]
    return _touch(db, m)


@router.delete("/{mindmap_id}", response_model=SimpleMessageResponse)
def delete_mindmap(mindmap_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    m = _get_owned_map(db, mindmap_id, current_user)
    db.delete(m)  # nguồn / node xoá theo FK ON DELETE CASCADE
    db.commit()
    return SimpleMessageResponse(message="Đã xoá sơ đồ tư duy.")


@router.post("/{mindmap_id}/nodes", response_model=MindmapNodeOut, status_code=status.HTTP_201_CREATED)
def add_node(
    mindmap_id: str,
    payload: MindmapNodeCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """"+ Thêm node / nhánh con": node mới ở cuối các node anh em, mượn trích dẫn của node cha (nếu có) để
    "Nguồn" / "Hỏi về chủ đề này" vẫn trỏ đúng tài liệu."""
    m = _get_owned_map(db, mindmap_id, current_user)
    parent = _get_node(db, m, payload.parent_id)
    if parent.depth + 1 > mindmap_generation.MAX_TREE_DEPTH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Sơ đồ đã quá sâu — không thêm được nhánh con ở cấp này.")
    last = db.scalar(select(func.max(MindmapNode.position)).where(MindmapNode.parent_id == parent.id)) or 0
    node = MindmapNode(
        mindmap_id=m.id, parent_id=parent.id, depth=parent.depth + 1, position=last + 1,
        label=payload.label.strip()[:500], origin="user",
        source_type=parent.source_type, chapter_id=parent.chapter_id, document_id=parent.document_id,
        source_label=parent.source_label, page_number=parent.page_number,
    )
    db.add(node)
    _touch(db, m)
    db.refresh(node)
    return _node_out(node)


_MAX_RESTORE_NODES = 500


def _restore_depth(n: MindmapRestoreNode) -> int:
    return 1 + max((_restore_depth(c) for c in n.children), default=0)


def _restore_count(n: MindmapRestoreNode) -> int:
    return 1 + sum(_restore_count(c) for c in n.children)


@router.post("/{mindmap_id}/nodes/restore", response_model=MindmapRestoreOut, status_code=status.HTTP_201_CREATED)
def restore_nodes(
    mindmap_id: str,
    payload: MindmapRestoreRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    m = _get_owned_map(db, mindmap_id, current_user)
    parent = _get_node(db, m, payload.parent_id)
    if parent.depth + _restore_depth(payload.node) > mindmap_generation.MAX_TREE_DEPTH:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Sơ đồ đã quá sâu — không dựng lại được nhánh ở cấp này.")
    if _restore_count(payload.node) > _MAX_RESTORE_NODES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nhánh quá lớn để khôi phục.")

    if payload.before_id is not None:
        before = _get_node(db, m, payload.before_id)
        if before.parent_id != parent.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Node đứng sau không cùng node cha.")
        position = before.position
        # Dời các node anh em từ vị trí này ra sau 1 bậc — từ cuối lên để không đụng UNIQUE (cha, position).
        db.execute(
            text(
                "UPDATE mindmap_nodes SET position = position + 1 "
                "WHERE mindmap_id = :m AND parent_id = :p AND position >= :pos ORDER BY position DESC"
            ),
            {"m": m.id, "p": parent.id, "pos": position},
        )
        db.expire_all()
    else:
        position = (db.scalar(select(func.max(MindmapNode.position)).where(MindmapNode.parent_id == parent.id)) or 0) + 1

    # Trích dẫn do client gửi lại: chỉ giữ Chương / PDF thuộc đúng Môn của sơ đồ (BR-05), còn lại để NULL như
    # nguồn đã bị xoá (snapshot nhãn + câu trích vẫn giữ).
    chapter_ok = set(db.scalars(select(Chapter.id).where(Chapter.subject_id == m.subject_id)))
    document_ok = set(db.scalars(select(PdfDocument.id).where(PdfDocument.subject_id == m.subject_id)))

    created: list[MindmapNode] = []

    def build(src: MindmapRestoreNode, parent_id: int, depth: int, pos: int) -> None:
        c = src.citation
        node = MindmapNode(
            mindmap_id=m.id, parent_id=parent_id, depth=depth, position=pos,
            label=src.label.strip()[:500] or "Node", origin=src.origin,
            offset_x=src.offset_x, offset_y=src.offset_y,
            source_type=c.source_type if c else None,
            chapter_id=c.chapter_id if c and c.source_type == "CHAPTER" and c.chapter_id in chapter_ok else None,
            document_id=c.document_id if c and c.source_type == "PDF" and c.document_id in document_ok else None,
            source_label=c.source_label if c else None,
            page_number=c.page_number if c else None,
            quote=c.quote if c else None,
        )
        db.add(node)
        db.flush()
        created.append(node)
        for i, child in enumerate(src.children, start=1):
            build(child, node.id, depth + 1, i)

    build(payload.node, parent.id, parent.depth + 1, position)
    saved = _touch(db, m)
    for n in created:
        db.refresh(n)
    return MindmapRestoreOut(nodes=[_node_out(n) for n in created], updated_seconds_ago=saved.updated_seconds_ago)


@router.patch("/{mindmap_id}/nodes/{node_id}", response_model=MindmapSavedOut)
def update_node(
    mindmap_id: str,
    node_id: int,
    payload: MindmapNodeUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    m = _get_owned_map(db, mindmap_id, current_user)
    node = _get_node(db, m, node_id)
    if payload.label is not None:
        node.label = payload.label[:500]
    if payload.offset_x is not None:
        node.offset_x = payload.offset_x
    if payload.offset_y is not None:
        node.offset_y = payload.offset_y
    return _touch(db, m)


@router.delete("/{mindmap_id}/nodes/{node_id}", response_model=MindmapSavedOut)
def delete_node(
    mindmap_id: str, node_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    m = _get_owned_map(db, mindmap_id, current_user)
    node = _get_node(db, m, node_id)
    if node.parent_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Không xoá được node gốc — hãy xoá cả sơ đồ.")
    # Xoá bằng SQL để DB tự cascade cả nhánh con (FK ghép ON DELETE CASCADE), rồi bỏ cache ORM cũ.
    db.execute(delete(MindmapNode).where(MindmapNode.id == node.id))
    db.expire_all()
    return _touch(db, m)
