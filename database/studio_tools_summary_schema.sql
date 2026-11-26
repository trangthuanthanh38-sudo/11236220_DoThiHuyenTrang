-- =============================================================================
-- AI Studio Tri Thức — Tạo bản tóm tắt theo chương (UC-24) (MySQL 8.0+)
-- =============================================================================
-- Cấu trúc dữ liệu cho luồng "Tạo bản tóm tắt" (UC-24, xem .claude/rules/08-ai-studio.md) theo
-- giao diện tom-tat.html ở gốc repo: Tạo mới (chọn Môn + 1 Chương, tên, Độ dài Ngắn/Vừa/Chi tiết,
-- Định dạng Gạch đầu dòng/Đoạn văn, 3 công tắc "Giữ lại trong tóm tắt", ô "Đang tạo") -> Xem song
-- song (bản tóm tắt chia mục -> ý, mỗi ý 1 số trích dẫn; bấm số -> đoạn gốc tô ở cột phải; sửa tên;
-- Tạo lại) + tab "Đã tạo" (Độ dài / Định dạng / Cập nhật / nhãn "Ghi chú gốc đã thay đổi").
-- Chưa có ORM/router/logic gọi Gemini — đợt sau.
--
-- 4 bảng:
--   summaries            — 1 bản tóm tắt (SUMMARY) + nguồn + tham số người học đã chọn
--   summary_sections     — các mục có tiêu đề ("Khái niệm", "Định nghĩa quan trọng", ...)
--   summary_points       — từng ý của 1 mục + trích dẫn (BR-09)
--   summary_generations  — nhật ký mỗi lượt gọi AI thành công (tạo + tạo lại) cho BR-08
--
-- Quyết định thiết kế quan trọng:
--   - Nguồn = ĐÚNG 1 Chương HOẶC 1 Tệp PDF (người dùng chốt; mẫu chỉ có radio Chương, PDF ngang hàng
--     Chương trong Môn nên mở sẵn ở DB). Vì chỉ 1 nguồn, cột nguồn GỘP vào `summaries` — không có
--     bảng *_sources như quiz/flashcard/mindmap, và trích dẫn trên từng ý không lặp lại source_type.
--   - Cùng khuôn quiz_*/flashcard_*/mindmaps: `subject_id` NOT NULL + CASCADE (UC-13 bước 4 — xoá Môn
--     xoá SUMMARY liên quan); FK tới Chương/PDF/chunk dùng SET NULL + snapshot (`source_label`,
--     `quote`, `page_number`) — xoá nguồn hay re-embed không làm hỏng bản tóm tắt đã lưu. Xoá Chương/
--     PDF nguồn thì bản tóm tắt vẫn đọc được nhưng không "Tạo lại" được nữa (tầng ứng dụng khoá nút).
--   - "Tạo lại" GHI ĐÈ TẠI CHỖ (người dùng chốt): giữ id/tên, xoá mục/ý cũ rồi ghi mục/ý mới trong 1
--     transaction, cập nhật `generated_at`/`source_text_hash`/`model_name` và chạm `updated_at`.
--     Không lưu phiên bản cũ. Tạo lại lỗi thì giữ nguyên nội dung cũ.
--   - "Ghi chú gốc đã thay đổi": `source_text_hash` = SHA-256 nội dung nguồn lúc sinh
--     (`chapters.content_text`; PDF = ghép văn bản chunk) — stale khi hash hiện tại khác hash đã lưu.
--     KHÔNG so `chapters.updated_at` vì đổi tên/chỉ đổi định dạng Chương cũng chạm cột đó.
--   - Mục (section) và ý (point) là 2 bảng: mẫu hiển thị theo mục có tiêu đề, công tắc "Giữ lại"
--     ứng với loại mục (`kind`), và mỗi ý có trích dẫn riêng. Định dạng Gạch đầu dòng/Đoạn văn chỉ là
--     cách VẼ cùng 1 dữ liệu (Đoạn văn = nối các ý của 1 mục thành 1 đoạn).
--   - Số trích dẫn 1, 2, 3... KHÔNG lưu: tính theo thứ tự (section.position, point.position) nên luôn
--     liên tục trên toàn bản tóm tắt (đúng compose() của mẫu), kể cả trong bản Xuất PDF.
--   - FK GHÉP `(summary_id, section_id) -> summary_sections(summary_id, id)`: DB ép ý nằm trong mục
--     của ĐÚNG bản tóm tắt đó (cùng cách mindmap_nodes ép node cha cùng sơ đồ).
--   - BR-08: "Tạo lại" ghi đè nên đếm dòng `summaries` sẽ thiếu lượt -> mỗi lượt gọi AI thành công ghi
--     1 dòng `summary_generations` (summary_id SET NULL: xoá bản tóm tắt vẫn giữ lượt đã dùng trong
--     ngày). Nối vào backend/app/services/ai_quota.py là việc của đợt backend.
--   - Không có ở DB (tầng ứng dụng): UC-24 E1 "nguồn quá ngắn" (mẫu: < 500 từ) + BR-07; "đúng 1 trong
--     chapter_id/document_id khớp source_type" (lỗi 3823 cấm CHECK trên cột FK có SET NULL); Xuất PDF
--     (in phía client, tuỳ chọn khổ giấy/kèm trích dẫn không lưu). Mức "Bài ghi chú" (bảng `notes`)
--     chưa dùng — cột phải "Bài ghi chú gốc" hiện nội dung Chương/PDF nguồn.
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_summary_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file bắt đầu "studio_tools_" để xếp SAU
-- "studio_rag_schema*.sql" (summary_points tham chiếu embedding_chunks).
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. SUMMARIES — 1 bản tóm tắt (UC-24 bước 1-4)
-- -----------------------------------------------------------------------------
CREATE TABLE summaries (
    id                CHAR(36)          NOT NULL DEFAULT (UUID()),
    user_id           CHAR(36)          NOT NULL,
    subject_id        CHAR(36)          NOT NULL,

    -- Nguồn duy nhất (UC-19): 1 Chương hoặc 1 Tệp PDF
    source_type       ENUM('CHAPTER','PDF') NOT NULL,
    chapter_id        CHAR(36)          NULL,
    document_id       CHAR(36)          NULL,
    source_label      VARCHAR(255)      NOT NULL,   -- snapshot "Chương 3 – Mô hình OSI" (Đã tạo, Xuất PDF)

    title             VARCHAR(200)      NOT NULL,   -- "Tên bản tóm tắt (bắt buộc)", sửa được ở màn xem

    -- Tham số ở màn Tạo mới (UC-24 bước 2)
    length            ENUM('short','medium','long') NOT NULL DEFAULT 'medium',   -- Ngắn / Vừa / Chi tiết
    format            ENUM('bullet','paragraph')    NOT NULL DEFAULT 'bullet',   -- Gạch đầu dòng / Đoạn văn
    keep_definitions  BOOLEAN           NOT NULL DEFAULT TRUE,   -- "Định nghĩa quan trọng"
    keep_numbers      BOOLEAN           NOT NULL DEFAULT TRUE,   -- "Công thức, số liệu"
    keep_examples     BOOLEAN           NOT NULL DEFAULT FALSE,  -- "Ví dụ minh họa"

    -- Phát hiện "Ghi chú gốc đã thay đổi" (xem đầu file)
    source_text_hash  CHAR(64)          NULL,       -- SHA-256 hex nội dung nguồn lúc sinh/tạo lại
    source_word_count INT UNSIGNED      NULL,       -- "N từ" lúc sinh

    status            ENUM('generating','ready','failed') NOT NULL DEFAULT 'generating',
    error_message     VARCHAR(500)      NULL,
    model_name        VARCHAR(100)      NULL,       -- model LLM của lần sinh gần nhất
    generated_at      DATETIME          NULL,       -- lần sinh / tạo lại thành công gần nhất

    created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_summaries_user_subject_updated (user_id, subject_id, updated_at),  -- tab Đã tạo theo Môn
    KEY idx_summaries_user_created (user_id, created_at),
    KEY idx_summaries_subject (subject_id),
    KEY idx_summaries_chapter (chapter_id),
    KEY idx_summaries_document (document_id),

    CONSTRAINT fk_summaries_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_summaries_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,   -- UC-13 bước 4
    CONSTRAINT fk_summaries_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_summaries_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Bản tóm tắt AI sinh từ 1 Chương/PDF — UC-24.';

-- -----------------------------------------------------------------------------
-- 2. SUMMARY_SECTIONS — mục có tiêu đề của bản tóm tắt
-- -----------------------------------------------------------------------------
CREATE TABLE summary_sections (
    id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    summary_id  CHAR(36)          NOT NULL,
    position    SMALLINT UNSIGNED NOT NULL,   -- thứ tự mục (bắt đầu từ 1)
    heading     VARCHAR(255)      NOT NULL,
    -- Loại mục, khớp công tắc "Giữ lại": definition / number / example; còn lại là general
    kind        ENUM('general','definition','number','example') NOT NULL DEFAULT 'general',

    PRIMARY KEY (id),
    UNIQUE KEY uq_summary_sections_summary_id (summary_id, id),          -- đích của FK ghép
    UNIQUE KEY uq_summary_sections_position (summary_id, position),

    CONSTRAINT fk_summary_sections_summary
        FOREIGN KEY (summary_id) REFERENCES summaries(id) ON DELETE CASCADE,
    CONSTRAINT chk_summary_sections_position
        CHECK (position >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Mục có tiêu đề của 1 bản tóm tắt — UC-24.';

-- -----------------------------------------------------------------------------
-- 3. SUMMARY_POINTS — từng ý + trích dẫn (UC-24 bước 4, BR-09)
-- -----------------------------------------------------------------------------
CREATE TABLE summary_points (
    id                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    summary_id          CHAR(36)          NOT NULL,
    section_id          BIGINT UNSIGNED   NOT NULL,
    position            SMALLINT UNSIGNED NOT NULL,   -- thứ tự trong mục (bắt đầu từ 1)
    content             TEXT              NOT NULL,

    -- Trích dẫn (snapshot) — nguồn luôn là nguồn của bản tóm tắt
    embedding_chunk_id  CHAR(36)          NULL,       -- chunk đã đưa cho LLM; NULL sau khi re-embed
    page_number         INT UNSIGNED      NULL,       -- chỉ PDF
    quote               TEXT              NOT NULL,   -- câu nguyên văn trong đoạn nguồn (tô ở cột phải)

    PRIMARY KEY (id),
    UNIQUE KEY uq_summary_points_position (section_id, position),
    KEY idx_summary_points_summary_section (summary_id, section_id),
    KEY idx_summary_points_chunk (embedding_chunk_id),

    CONSTRAINT fk_summary_points_summary
        FOREIGN KEY (summary_id) REFERENCES summaries(id) ON DELETE CASCADE,
    CONSTRAINT fk_summary_points_section
        FOREIGN KEY (summary_id, section_id) REFERENCES summary_sections(summary_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_summary_points_chunk
        FOREIGN KEY (embedding_chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL,
    CONSTRAINT chk_summary_points_position
        CHECK (position >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Ý của bản tóm tắt + trích dẫn nguồn — UC-24.';

-- -----------------------------------------------------------------------------
-- 4. SUMMARY_GENERATIONS — mỗi lượt gọi AI thành công (BR-08)
-- -----------------------------------------------------------------------------
CREATE TABLE summary_generations (
    id          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
    summary_id  CHAR(36)          NULL,       -- NULL sau khi xoá bản tóm tắt (lượt vẫn được tính)
    user_id     CHAR(36)          NOT NULL,
    kind        ENUM('create','regenerate') NOT NULL,
    model_name  VARCHAR(100)      NOT NULL,
    created_at  DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_summary_generations_user_created (user_id, created_at),   -- BR-08 trong ngày
    KEY idx_summary_generations_summary (summary_id),

    CONSTRAINT fk_summary_generations_summary
        FOREIGN KEY (summary_id) REFERENCES summaries(id) ON DELETE SET NULL,
    CONSTRAINT fk_summary_generations_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nhật ký lượt sinh/tạo lại bản tóm tắt — BR-08.';
