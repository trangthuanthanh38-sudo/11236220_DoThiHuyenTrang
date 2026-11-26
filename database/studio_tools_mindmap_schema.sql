-- =============================================================================
-- AI Studio Tri Thức — Tạo sơ đồ tư duy theo chương (UC-25) (MySQL 8.0+)
-- =============================================================================
-- Cấu trúc dữ liệu cho luồng "Tạo sơ đồ tư duy" (UC-25, xem .claude/rules/08-ai-studio.md) theo
-- giao diện so-do-tu-duy.html ở gốc repo: Tạo mới (chọn Môn + tick Chương/PDF, tên, độ sâu,
-- cách dựng khung, bố cục, 2 công tắc "Khi bấm vào node", ô "Đang tạo") -> Khung vẽ (kéo/sửa/
-- thêm/xoá node, bảng "Node đang chọn" có nguồn trích dẫn) + tab "Đã tạo" (Số node / Số cấp /
-- Cập nhật / nhãn "Cấu trúc phẳng"). Chưa có router/logic gọi Gemini — đợt sau.
--
-- 3 bảng:
--   mindmaps         — 1 sơ đồ (MINDMAP) + tham số người học đã chọn
--   mindmap_sources  — các nguồn (Chương / Tệp PDF) đã tick = các nhánh lớn của sơ đồ
--   mindmap_nodes    — từng node của cây (danh sách kề: parent_id) + độ lệch kéo + trích dẫn
--
-- Quyết định thiết kế quan trọng:
--   - Node lưu BẢNG RIÊNG, không phải 1 cột JSON cả cây (đặc tả UC-25 bước 4 ghi "node/edge dạng
--     JSON" — đã đổi có chủ đích): giao diện sửa/thêm/xoá/kéo TỪNG node và mỗi node có nguồn trích
--     dẫn riêng (BR-09). Bảng riêng cho: FK SET NULL tới Chương/PDF/chunk trên từng node; xoá 1
--     node xoá cả nhánh con ngay ở DB; "Số node"/"Số cấp" là COUNT/MAX(depth); mỗi lần lưu chỉ ghi
--     đúng node bị đổi. Cạnh (edge) KHÔNG có bảng — cây nên cạnh = (parent_id -> id).
--   - Cùng khuôn quiz_*/flashcard_*: `subject_id` NOT NULL + CASCADE (UC-13 bước 4 — xoá Môn xoá
--     MINDMAP liên quan) nên mọi nguồn của 1 sơ đồ phải cùng 1 Môn (tầng ứng dụng kiểm). Xoá 1
--     Chương/PDF nguồn KHÔNG xoá sơ đồ: FK SET NULL + snapshot tên nguồn/trang/đoạn trích.
--   - FK GHÉP `(mindmap_id, parent_id) -> mindmap_nodes(mindmap_id, id) ON DELETE CASCADE`: DB ép
--     node cha phải cùng sơ đồ, và "Xóa node" xoá luôn cả nhánh con. InnoDB chỉ cascade tối đa 15
--     tầng nên CHECK depth <= 12.
--   - Đúng 1 node gốc / sơ đồ: cột ảo `root_marker` (1 khi parent_id NULL, ngược lại NULL) +
--     UNIQUE (mindmap_id, root_marker) — UNIQUE bỏ qua NULL nên chỉ chặn gốc thứ 2. "Không xoá
--     được node gốc" (nút Xóa node bị khoá ở cấp 0) là tầng ứng dụng: xoá gốc = xoá cả sơ đồ.
--   - `depth` lưu sẵn trên node (0 = gốc, 1 = nhánh lớn/Chương, 2 = Ý chính, ...): cây không có
--     thao tác "chuyển node sang cha khác" nên depth không đổi sau khi tạo. Sơ đồ phẳng (UC-25 E1,
--     `mindmaps.is_flat`): gốc = chủ đề của chương, các ý nằm ngay depth 1.
--   - Vị trí node: CHỈ lưu `offset_x/offset_y` = độ lệch do người học kéo, so với vị trí bố cục
--     client tự tính (Cây ngang / Tỏa tròn) — giao diện cộng dồn độ lệch theo nhánh cha (kéo node
--     cha thì cả nhánh đi theo). Toạ độ tuyệt đối không lưu vì đổi cỡ chữ/sửa nội dung node là bố
--     cục tính lại.
--   - Trích dẫn (BR-09) GỘP vào dòng node như `flashcards` (mỗi node tối đa 1 đoạn nguồn). Cho phép
--     NULL vì node gốc (tên Môn) và node người học tự thêm (`origin='user'`) không bắt buộc nguồn;
--     "node AI sinh phải có nguồn" kiểm ở tầng ứng dụng.
--   - Sửa node KHÔNG tự đổi `mindmaps.updated_at` (ON UPDATE chỉ bắt khi chính dòng mindmaps đổi)
--     -> tầng ứng dụng phải chạm `mindmaps.updated_at` mỗi lần lưu node (cột "Cập nhật" ở Đã tạo,
--     "Đã lưu lúc HH:MM" trên khung vẽ).
--   - MySQL cấm CHECK trên cột tham gia FK có referential action (lỗi 3823 — cả SET NULL lẫn
--     CASCADE) -> "đúng 1 trong chapter_id/document_id khớp source_type" và "parent_id NULL <=>
--     depth = 0" (parent_id nằm trong FK CASCADE) chỉ kiểm ở tầng ứng dụng lúc INSERT.
--   - BR-08: chỉ sơ đồ `status='ready'` có `model_name` mới tính 1 lượt (như quiz/flashcard).
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_mindmap_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file bắt đầu "studio_tools_" để xếp SAU
-- "studio_rag_schema*.sql" (mindmap_nodes tham chiếu embedding_chunks).
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. MINDMAPS — 1 sơ đồ tư duy (UC-25 bước 1-4)
-- -----------------------------------------------------------------------------
CREATE TABLE mindmaps (
    id              CHAR(36)          NOT NULL DEFAULT (UUID()),
    user_id         CHAR(36)          NOT NULL,
    subject_id      CHAR(36)          NOT NULL,

    title           VARCHAR(200)      NOT NULL,   -- "Tên sơ đồ (bắt buộc)", sửa được trên khung vẽ

    -- Tham số ở màn Tạo mới
    depth           TINYINT UNSIGNED  NOT NULL DEFAULT 3,   -- "Độ sâu mỗi chương": 2/3/4 cấp
    build_method    ENUM('headings','auto') NOT NULL DEFAULT 'headings',  -- "Tiêu đề có sẵn" /
                                                            -- "Hệ thống tự phân tích nội dung"
    layout          ENUM('tree','radial') NOT NULL DEFAULT 'tree',        -- Cây ngang / Tỏa tròn
    show_citation   BOOLEAN           NOT NULL DEFAULT TRUE, -- "Hiện trích dẫn nguồn"
    ask_qa          BOOLEAN           NOT NULL DEFAULT TRUE, -- "Mở hỏi đáp về chủ đề"
    is_flat         BOOLEAN           NOT NULL DEFAULT FALSE, -- UC-25 E1: chỉ gồm 1 cấp ("Cấu trúc phẳng")

    status          ENUM('generating','ready','failed') NOT NULL DEFAULT 'generating',
    error_message   VARCHAR(500)      NULL,
    model_name      VARCHAR(100)      NULL,       -- model LLM thật đã sinh (BR-08 đếm dòng có giá trị)

    created_at      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_mindmaps_user_subject_updated (user_id, subject_id, updated_at),  -- tab Đã tạo theo Môn
    KEY idx_mindmaps_user_created (user_id, created_at),                     -- BR-08 trong ngày
    KEY idx_mindmaps_subject (subject_id),

    CONSTRAINT fk_mindmaps_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_mindmaps_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,  -- UC-13 bước 4
    CONSTRAINT chk_mindmaps_depth
        CHECK (depth BETWEEN 2 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Sơ đồ tư duy AI sinh — UC-25.';

-- -----------------------------------------------------------------------------
-- 2. MINDMAP_SOURCES — nguồn đã tick (UC-19), mỗi nguồn = 1 nhánh lớn
-- -----------------------------------------------------------------------------
CREATE TABLE mindmap_sources (
    id            BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    mindmap_id    CHAR(36)          NOT NULL,
    position      TINYINT UNSIGNED  NOT NULL,   -- thứ tự nhánh (bắt đầu từ 1)

    source_type   ENUM('CHAPTER','PDF') NOT NULL,
    chapter_id    CHAR(36)          NULL,
    document_id   CHAR(36)          NULL,
    source_label  VARCHAR(255)      NOT NULL,   -- snapshot tên lúc tạo (dòng phụ "Chương 3, 4" ở Đã tạo)

    PRIMARY KEY (id),
    UNIQUE KEY uq_mindmap_sources_position (mindmap_id, position),
    UNIQUE KEY uq_mindmap_sources_chapter (mindmap_id, chapter_id),
    UNIQUE KEY uq_mindmap_sources_document (mindmap_id, document_id),
    KEY idx_mindmap_sources_chapter (chapter_id),
    KEY idx_mindmap_sources_document (document_id),

    CONSTRAINT fk_mindmap_sources_mindmap
        FOREIGN KEY (mindmap_id) REFERENCES mindmaps(id) ON DELETE CASCADE,
    CONSTRAINT fk_mindmap_sources_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_mindmap_sources_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL,
    CONSTRAINT chk_mindmap_sources_position
        CHECK (position >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nguồn (Chương/PDF) dùng để sinh 1 sơ đồ tư duy.';

-- -----------------------------------------------------------------------------
-- 3. MINDMAP_NODES — từng node (UC-25 bước 2-5) + trích dẫn (BR-09)
-- -----------------------------------------------------------------------------
CREATE TABLE mindmap_nodes (
    id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    mindmap_id          CHAR(36)          NOT NULL,
    parent_id           BIGINT UNSIGNED   NULL,       -- NULL = node gốc
    root_marker         TINYINT           AS (IF(parent_id IS NULL, 1, NULL)) VIRTUAL,

    depth               TINYINT UNSIGNED  NOT NULL,   -- 0 gốc, 1 nhánh lớn, 2 Ý chính, 3 Ý phụ, ...
    position            SMALLINT UNSIGNED NOT NULL,   -- thứ tự trong các node anh em (bắt đầu từ 1)
    label               VARCHAR(500)      NOT NULL,
    origin              ENUM('ai','user') NOT NULL DEFAULT 'ai',  -- 'user' = "+ Thêm node / nhánh con"

    -- Độ lệch do kéo, so với vị trí bố cục client tự tính (xem đầu file)
    offset_x            FLOAT             NOT NULL DEFAULT 0,
    offset_y            FLOAT             NOT NULL DEFAULT 0,

    -- Trích dẫn nguồn (snapshot, BR-09) — NULL với node gốc / node người học tự thêm
    source_type         ENUM('CHAPTER','PDF') NULL,
    chapter_id          CHAR(36)          NULL,
    document_id         CHAR(36)          NULL,
    embedding_chunk_id  CHAR(36)          NULL,       -- chunk đã đưa cho LLM; NULL sau khi re-embed
    source_label        VARCHAR(255)      NULL,       -- "Nguồn: <tên> · trang N"
    page_number         INT UNSIGNED      NULL,       -- chỉ PDF
    quote               TEXT              NULL,       -- câu nguyên văn trong đoạn nguồn

    created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_mindmap_nodes_map_id (mindmap_id, id),           -- đích của FK ghép
    UNIQUE KEY uq_mindmap_nodes_root (mindmap_id, root_marker),    -- đúng 1 gốc / sơ đồ
    UNIQUE KEY uq_mindmap_nodes_sibling (mindmap_id, parent_id, position),
    KEY idx_mindmap_nodes_chapter (chapter_id),
    KEY idx_mindmap_nodes_document (document_id),
    KEY idx_mindmap_nodes_chunk (embedding_chunk_id),

    CONSTRAINT fk_mindmap_nodes_mindmap
        FOREIGN KEY (mindmap_id) REFERENCES mindmaps(id) ON DELETE CASCADE,
    CONSTRAINT fk_mindmap_nodes_parent
        FOREIGN KEY (mindmap_id, parent_id) REFERENCES mindmap_nodes(mindmap_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_mindmap_nodes_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_mindmap_nodes_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL,
    CONSTRAINT fk_mindmap_nodes_chunk
        FOREIGN KEY (embedding_chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL,
    CONSTRAINT chk_mindmap_nodes_depth
        CHECK (depth <= 12),
    CONSTRAINT chk_mindmap_nodes_position
        CHECK (position >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Node của sơ đồ tư duy (cây, parent_id) — UC-25.';
