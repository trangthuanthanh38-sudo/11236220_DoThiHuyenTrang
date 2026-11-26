-- =============================================================================
-- AI Studio Tri Thức — Knowledge Content Schema (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: nhóm UC-12 → UC-18 (Quản lý Tri thức & Nội dung) trong
-- .claude/rules/07-knowledge-content.md, cộng thêm chức năng MỚI "tải PDF lên
-- trong cột 1 – Notebook" (yêu cầu bổ sung, không có UC riêng — coi là mở
-- rộng của UC-16 luồng thay thế 2a "Tải lên tệp đính kèm (PDF/ảnh) làm
-- SOURCE_DOCUMENT gắn với Bài ghi chú").
--
-- Đây là LẦN ĐẦU các bảng subjects/chapters/notes được tạo — CLAUDE.md tính
-- đến trước file này ghi rõ "Các nhóm UC còn lại chưa có code, chỉ có đặc tả
-- trong .claude/rules/", nên nhóm UC-12→18 CHƯA có bảng nào trong DB thật.
--
-- *** CẬP NHẬT (phiên làm việc kết nối Editor ↔ Database) ***
-- 07-knowledge-content.md đặc tả mô hình 3 tầng Môn học → Chương → Bài ghi
-- chú (nội dung ở tầng Note). Nhưng `frontend/html/ghichu.html` hiện tại chỉ
-- có cây 2 tầng Subject→Chapter (không có node "Note" nào trong sidebar), và
-- soạn thảo/lưu nội dung diễn ra trực tiếp trên Chương đang chọn — xem
-- comment đầu `frontend/js/ghichu.js`. Khi nối luồng Editor↔DB, đã CHỐT theo
-- đúng UI hiện tại (người dùng xác nhận): **nội dung soạn thảo gắn thẳng vào
-- CHAPTERS**, không qua tầng Note. Bảng `notes` bên dưới vẫn được tạo/giữ
-- nguyên (đúng đặc tả chính thức, không xoá) nhưng TẠM CHƯA được ghichu.html
-- hay bất kỳ API nào dùng tới — để dành cho khi UI thật sự có nhiều Bài ghi
-- chú/Chương (khi đó `chapters.content_json` sẽ "chuyển vai" thành nội dung
-- của Bài ghi chú đầu tiên/mặc định, còn các Bài ghi chú khác dùng bảng
-- `notes`).
--
-- *** CẬP NHẬT TIẾP (phiên làm việc "Môn → Chương/File PDF ngang hàng") ***
-- File PDF đổi từ gắn vào 1 Chương cụ thể (`pdf_documents.chapter_id`) sang
-- gắn thẳng vào Môn học (`pdf_documents.subject_id`) — theo đúng yêu cầu UI
-- mới: PDF là một item ĐỘC LẬP, cùng cấp với Chương trong cây Notebook (không
-- nằm "bên trong" Chương nào), đổi tên/xoá/kéo-thả giữa các Môn tương tự
-- Chương. Xem mục 4 (PDF_DOCUMENTS) bên dưới.
--
-- Quyết định thiết kế quan trọng:
--   - Quy ước đặt tên PK: dùng `id` cho mọi bảng (khớp auth_schema.sql /
--     profile_settings_schema.sql), KHÔNG dùng `document_id`/`annotation_id`
--     như văn xuôi yêu cầu gốc — các FK trỏ tới bảng khác vẫn giữ đúng tên đó
--     (subject_id, document_id) như yêu cầu.
--   - `chapters.content_json`/`content_text`/`ocr_text`: nội dung soạn thảo
--     thật của Chương — xem mục 2 bên dưới. Tên cột giữ theo glossary
--     CLAUDE.md ("NOTE.content_json") để dễ tra chiếu với đặc tả, dù giờ đặt
--     ở bảng chapters.
--   - `pdf_documents.subject_id`: một PDF tải lên (mục "tải PDF lên trong
--     cột 1 – Notebook") gắn trực tiếp vào Môn học, ngang hàng Chương, KHÔNG
--     qua Chương/Note.
--   - `pdf_documents`: CHỈ metadata (tên file, đường dẫn/storage key, số
--     trang, dung lượng, mime) — file PDF thật lưu ngoài DB (local disk/S3/
--     MinIO, xem app.config sau này). KHÔNG có cột BLOB nào ở đây.
--   - `pdf_annotations`: mỗi thao tác chú thích là 1 dòng độc lập, sửa thì
--     UPDATE, xoá thì DELETE — KHÔNG ghi đè/gộp vào PDF gốc (PDF gốc bất biến
--     — xem khối comment "NGUYÊN TẮC HIỂN THỊ" ngay trên bảng pdf_annotations).
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy (đã có dữ liệu cũ, không nạp lại từ đầu qua Docker):
--   mysql -u root -p ai_studio_tri_thuc < database/knowledge_content_schema.sql
-- (Nếu chạy lần đầu qua `docker compose up -d` với volume rỗng, file này tự
-- nạp theo thứ tự bảng chữ cái: sau auth_schema.sql, trước
-- profile_settings_schema.sql — cả hai không phụ thuộc file này nên thứ tự
-- không quan trọng, chỉ cần đứng sau auth_schema.sql vì cần bảng `users`.)
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 1. SUBJECTS — Môn học, tầng 1 của cây tri thức (UC-12, UC-13)
-- -----------------------------------------------------------------------------
CREATE TABLE subjects (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()),
    owner_id      CHAR(36)     NOT NULL,   -- BR-05: chỉ chủ sở hữu thao tác được

    name          VARCHAR(150) NOT NULL,   -- KHÔNG unique: UC-12 E1 cho phép trùng tên
                                            -- (gợi ý hậu tố phân biệt ở tầng ứng dụng)
    description   VARCHAR(500) NULL,
    color         VARCHAR(20)  NULL,       -- UC-12: "màu/icon phân loại"
    icon          VARCHAR(50)  NULL,
    sort_order    INT          NOT NULL DEFAULT 0,   -- kéo-thả sắp xếp lại Môn học trong
                                                      -- Notebook (yêu cầu đồng bộ DB khi
                                                      -- kết nối Editor↔Database)

    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_subjects_owner (owner_id, sort_order),
    CONSTRAINT fk_subjects_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Môn học — UC-12, UC-13. BR-10: xoá cascade xuống chapters/notes/pdf_*.';

-- -----------------------------------------------------------------------------
-- 2. CHAPTERS — Chương, tầng 2 của cây tri thức (UC-14, UC-15, UC-16, UC-18)
-- -----------------------------------------------------------------------------
-- Đây cũng là bảng giữ NỘI DUNG SOẠN THẢO thật (UC-16) — khớp đúng mô hình
-- hiện tại của ghichu.html: chọn 1 Chương ở cột 1 (Notebook) là mở editor
-- cho ĐÚNG Chương đó, autosave/nút Lưu đều UPDATE theo `chapter_id`.
CREATE TABLE chapters (
    id            CHAR(36)     NOT NULL DEFAULT (UUID()),
    subject_id    CHAR(36)     NOT NULL,

    name          VARCHAR(150) NOT NULL,
    sort_order    INT          NOT NULL DEFAULT 0,   -- UC-14: mặc định = cuối danh sách;
                                                      -- UC-15: kéo-thả sắp xếp lại

    -- Nội dung soạn thảo (UC-16). Giữ tên "content_json" đúng như glossary
    -- CLAUDE.md ("NOTE.content_json") để dễ tra chiếu với đặc tả, dù đặt ở
    -- bảng chapters; kiểu LONGTEXT (không dùng kiểu JSON gốc của MySQL) vì
    -- trình soạn thảo hiện tại (CKEditor 5, xem ghichu.js) sinh ra HTML
    -- string qua getData()/setData(), không phải một JSON document — ép
    -- kiểu JSON của MySQL sẽ từ chối chuỗi HTML thô khi insert. NULL nghĩa
    -- là "Chương chưa có nội dung" -> frontend hiển thị editor trống.
    content_json  LONGTEXT     NULL,
    -- Bản plain-text (không thẻ HTML) trích từ content_json mỗi lần lưu, chỉ
    -- để phục vụ FULLTEXT INDEX bên dưới — không phải nguồn sự thật của nội
    -- dung (content_json mới là nguồn sự thật khi tải lại trang soạn thảo).
    content_text  LONGTEXT     NULL,
    -- Văn bản OCR từ ảnh/tệp scan chèn trong ghi chú (UC-16 bước 5) — làm
    -- nguồn cho tìm kiếm (UC-18) và AI Studio (UC-19/BR-07).
    ocr_text      LONGTEXT     NULL,

    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_chapters_subject_order (subject_id, sort_order),
    FULLTEXT INDEX ft_chapters_search (name, content_text, ocr_text),  -- UC-18
    CONSTRAINT fk_chapters_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Chương — UC-14/15/16/18. BR-10: xoá cascade xuống pdf_*.';

-- -----------------------------------------------------------------------------
-- 3. NOTES — Bài ghi chú (DỰ TRỮ, đúng đặc tả 3 tầng — CHƯA được UI dùng)
-- -----------------------------------------------------------------------------
-- Xem khối "*** CẬP NHẬT ***" ở đầu file: ghichu.html hiện tại KHÔNG có node
-- Note trong cây, nên nội dung/PDF đang gắn thẳng vào `chapters` (mục 2 và
-- 4). Bảng này giữ đúng đặc tả chính thức UC-16 (Chương → NHIỀU Bài ghi chú)
-- để dùng khi UI mở rộng thêm tầng Note — TẠM CHƯA có FK nào trỏ vào đây.
CREATE TABLE notes (
    id            CHAR(36)      NOT NULL DEFAULT (UUID()),
    chapter_id    CHAR(36)      NOT NULL,

    note_type     ENUM('text','pdf') NOT NULL DEFAULT 'text',
    title         VARCHAR(200)  NOT NULL,
    content_json  LONGTEXT      NULL,
    content_text  LONGTEXT      NULL,
    ocr_text      LONGTEXT      NULL,
    sort_order    INT           NOT NULL DEFAULT 0,

    created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_notes_chapter_order (chapter_id, sort_order),
    FULLTEXT INDEX ft_notes_search (title, content_text, ocr_text),
    CONSTRAINT fk_notes_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='DỰ TRỮ — Bài ghi chú theo đặc tả 3 tầng, chưa được ghichu.html dùng (xem mục 2).';

-- =============================================================================
-- CHỨC NĂNG BỔ SUNG — Tải PDF lên trong cột 1 (Notebook)
-- =============================================================================
-- NGUYÊN TẮC HIỂN THỊ (bắt buộc đọc trước khi cài đặt frontend):
--   1. Backend trả `file_path` của pdf_documents  -> frontend tải PDF GỐC.
--   2. PDF.js render PDF gốc lên <canvas> theo viewport hiện tại (một scale/
--      kích thước màn hình cụ thể).
--   3. Backend trả danh sách pdf_annotations của đúng document (và thường
--      chỉ đúng trang đang xem, lọc theo page_number — xem index bên dưới).
--   4. Frontend vẽ annotation lên một OVERLAY LAYER (<canvas>/<svg> riêng)
--      đặt CHỒNG lên canvas của PDF.js — KHÔNG ghi gì vào file PDF gốc.
--   PDF gốc không bao giờ bị sửa; "PDF đã chú thích" mà người dùng thấy chỉ
--   là kết quả ghép PDF gốc + overlay tại thời điểm hiển thị.
--
-- HỆ TOẠ ĐỘ ANNOTATION — quyết định sống còn để zoom/resize không lệch:
--   Toạ độ trong cột `data` PHẢI được lưu ở **PDF user space** (đơn vị point,
--   1/72 inch) của TRANG GỐC tại scale=1, rotation=0 — chính là hệ toạ độ mà
--   PDF.js expose qua `page.getViewport({scale:1}).convertToPdfPoint(x, y)`.
--   TUYỆT ĐỐI không lưu toạ độ pixel trên <canvas> ở một zoom/kích thước màn
--   hình cụ thể. Khi hiển thị, luôn tính lại toạ độ màn hình hiện tại bằng
--   `viewport.convertToViewportPoint(pdfX, pdfY)` với viewport MỚI (đúng
--   scale/kích thước đang render) — vì vậy annotation luôn khớp pixel dù
--   người dùng zoom in/out hoặc đổi kích thước cửa sổ, do phép biến đổi
--   affine của PDF.js tự xử lý quy đổi, DB không cần biết zoom hiện tại là gì.
--   (Gốc toạ độ PDF user space là góc DƯỚI-TRÁI trang — khác quy ước canvas/
--   màn hình thông thường là góc trên-trái; đây là quy ước chuẩn của PDF.js,
--   không phải lựa chọn riêng của schema này.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4. PDF_DOCUMENTS — Metadata file PDF đã tải lên (KHÔNG lưu nội dung/BLOB)
-- -----------------------------------------------------------------------------
-- *** CẬP NHẬT (phiên làm việc "Môn → Chương/File PDF ngang hàng") ***
-- Đổi từ gắn vào Chương (chapter_id) sang gắn thẳng vào Môn học (subject_id): file PDF giờ
-- là một item độc lập, CÙNG CẤP với Chương trong cây Notebook (không nằm trong 1 Chương cụ
-- thể nào), giống hệt cách Chương là con trực tiếp của Môn học. `sort_order` phục vụ kéo-thả
-- sắp xếp lại vị trí các PDF trong cùng 1 Môn học, cùng kiểu với `chapters.sort_order`.
CREATE TABLE pdf_documents (
    id               CHAR(36)      NOT NULL DEFAULT (UUID()),
    subject_id       CHAR(36)      NOT NULL,   -- 1 Môn học có thể có nhiều pdf_documents,
                                                -- ngang hàng với các Chương của Môn đó

    original_name    VARCHAR(255)  NOT NULL,   -- tên hiển thị (đổi tên được — UC "Sửa/Xoá
                                                -- File PDF"), khởi tạo = tên file lúc tải lên
    file_path        VARCHAR(500)  NOT NULL,   -- đường dẫn/storage key thật trên
                                                -- server/S3/MinIO — KHÔNG lưu nội dung
    page_count       SMALLINT UNSIGNED NULL,   -- NULL cho tới khi backend parse xong
                                                -- PDF (có thể điền ngay lúc upload
                                                -- hoặc cập nhật sau bằng job nền)
    file_size_bytes  BIGINT UNSIGNED NOT NULL, -- BR-14: đối chiếu giới hạn dung lượng/tệp
    mime_type        VARCHAR(100)  NOT NULL DEFAULT 'application/pdf',
    sort_order       INT           NOT NULL DEFAULT 0,  -- kéo-thả sắp xếp trong Môn học

    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_pdf_documents_file_path (file_path),
    KEY idx_pdf_documents_subject (subject_id, sort_order),
    CONSTRAINT fk_pdf_documents_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    -- Bảng này CHỈ dành cho PDF (đúng tên & phạm vi yêu cầu) — chặn dữ liệu bẩn
    -- nếu tầng ứng dụng lỡ tái sử dụng bảng cho định dạng khác (BR-14).
    CONSTRAINT chk_pdf_documents_mime CHECK (mime_type = 'application/pdf'),
    CONSTRAINT chk_pdf_documents_page_count CHECK (page_count IS NULL OR page_count > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Metadata PDF tải lên (cột 1 - Notebook), gắn thẳng vào Môn học (ngang hàng Chương) — file thật lưu ngoài DB (local/S3/MinIO).';

-- -----------------------------------------------------------------------------
-- 5. PDF_ANNOTATIONS — Chú thích/chỉnh sửa trên PDF (overlay, KHÔNG sửa gốc)
-- -----------------------------------------------------------------------------
CREATE TABLE pdf_annotations (
    id               CHAR(36)     NOT NULL DEFAULT (UUID()),
    document_id      CHAR(36)     NOT NULL,
    created_by       CHAR(36)     NOT NULL,   -- BR-05: luôn = chủ sở hữu Note hiện tại;
                                               -- giữ lại để làm audit trail, sẵn cho khi
                                               -- có chia sẻ/đồng chỉnh sửa ở giai đoạn sau

    page_number      SMALLINT UNSIGNED NOT NULL,  -- 1-based, khớp PDF.js `pageNumber`
    annotation_type  ENUM('highlight','underline','strikeout','textbox','draw','shape','note')
                     NOT NULL,
    -- Toạ độ/màu/nội dung/nét vẽ — LUÔN ở PDF user space (xem khối "HỆ TOẠ ĐỘ
    -- ANNOTATION" phía trên). Cấu trúc gợi ý theo annotation_type:
    --   highlight/underline/strikeout: {"rects":[{"x":,"y":,"w":,"h":},...],
    --                                   "color":"#RRGGBB","opacity":0.4}
    --   textbox: {"x":,"y":,"w":,"h":,"text":"...","fontSize":,"color":,
    --             "fontFamily":}
    --   draw   : {"color":,"strokeWidth":,"paths":[[[x,y],[x,y],...],...]}
    --   shape  : {"shape":"rect|ellipse|line|arrow","x":,"y":,"w":,"h":,
    --             "color":,"strokeWidth":}
    --   note   : {"x":,"y":,"text":"...","color":}   -- ghim chú thích dạng sticky note
    data             JSON         NOT NULL,

    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_pdf_annotations_doc_page (document_id, page_number),  -- truy vấn chính:
                                                                   -- "lấy annotation của
                                                                   -- đúng trang đang mở"
    CONSTRAINT fk_pdf_annotations_document FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdf_annotations_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_pdf_annotations_page CHECK (page_number >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Annotation overlay trên PDF — mỗi thao tác 1 dòng, sửa=UPDATE, xoá=DELETE, không đụng file PDF gốc.';
