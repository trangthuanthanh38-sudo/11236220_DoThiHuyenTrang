-- =============================================================================
-- AI Studio Tri Thức — Tạo Flashcard theo chương (UC-23) (MySQL 8.0+)
-- =============================================================================
-- Cấu trúc dữ liệu cho luồng "Tạo Flashcard" (UC-23, xem .claude/rules/08-ai-studio.md) theo
-- giao diện flashcard.html (Tạo flashcard -> Ôn thẻ lật mặt trước/sau -> Hoàn thành phiên ôn)
-- + tab "Đã tạo" để mở lại bộ thẻ và ôn các thẻ đến hạn (lặp lại ngắt quãng).
-- Backend: backend/app/routers/flashcards.py + services/flashcard_generation.py.
--
-- 4 bảng:
--   flashcard_sets         — 1 bộ thẻ (FLASHCARD_SET) + tham số người học đã chọn
--   flashcard_set_sources  — các nguồn (Chương / Tệp PDF) được tick ở bước "Chọn nguồn"
--   flashcards             — từng thẻ (FLASHCARD): 2 mặt + trích dẫn + trạng thái lịch ôn
--   flashcard_reviews      — lịch sử từng lần chấm Dễ/Khó (chuỗi ngày ôn, UC-29/UC-39 sau này)
--
-- Quyết định thiết kế quan trọng:
--   - Cùng khuôn với quiz_* (studio_tools_quiz_schema.sql): `subject_id` NOT NULL + CASCADE
--     (UC-13 bước 4 — xoá Môn xoá nội dung AI Studio liên quan) nên mọi nguồn của 1 bộ phải cùng
--     1 Môn (tầng ứng dụng kiểm); FK tới Chương/PDF/chunk dùng SET NULL và mọi thứ cần hiển thị lại
--     (tên nguồn, trang, đoạn trích) đều lưu snapshot — xoá nguồn hay re-embed không làm hỏng bộ thẻ.
--   - Trích dẫn (BR-09) GỘP vào dòng thẻ thay vì bảng riêng như quiz_question_citations: mỗi thẻ
--     luôn đúng 1 đoạn nguồn, và thẻ chỉ đọc lại nguyên dòng.
--   - Trạng thái lặp lại ngắt quãng nằm NGAY trên thẻ (due_at/interval_seconds/...): bộ thẻ chỉ
--     thuộc 1 người (không chia sẻ) nên không cần bảng trạng thái theo từng người học.
--     due_at NULL = thẻ mới chưa ôn lần nào. Thuật toán (services/flashcard_generation.py
--     schedule_next): Khó -> 10 phút; Dễ lần đầu / sau 1 lần Khó -> 3 ngày, các lần Dễ tiếp theo
--     nhân 2,5, tối đa 180 ngày.
--   - `requested_count` là số thẻ ĐÃ CHỐT (kể cả khi "Hệ thống đề xuất" — backend tính từ độ dài
--     nội dung rồi ghi vào đây), `count_mode` giữ lựa chọn để thông báo UC-23 E1 đúng câu
--     ("ít hơn N thẻ đề xuất ban đầu" / "bạn chọn"). `card_count` = số thẻ THẬT đã sinh.
--   - `updated_at` trên thẻ: sẵn cho UC-23 luồng 2a (sửa tay nội dung thẻ) — chưa có API.
--   - MySQL cấm CHECK trên cột tham gia FK ON DELETE SET NULL (lỗi 3823) -> "đúng 1 trong
--     chapter_id/document_id khớp source_type" chỉ kiểm ở tầng ứng dụng lúc INSERT.
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_flashcard_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file bắt đầu "studio_tools_" để xếp SAU
-- "studio_rag_schema*.sql" (flashcards tham chiếu embedding_chunks).
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. FLASHCARD_SETS — 1 bộ thẻ (UC-23 bước 2-4)
-- -----------------------------------------------------------------------------
CREATE TABLE flashcard_sets (
    id               CHAR(36)          NOT NULL DEFAULT (UUID()),
    user_id          CHAR(36)          NOT NULL,
    subject_id       CHAR(36)          NOT NULL,

    title            VARCHAR(200)      NOT NULL,   -- header "Ôn flashcard · <title>"
    count_mode       ENUM('auto','manual') NOT NULL DEFAULT 'auto',  -- "Hệ thống đề xuất" / "Tự chọn"
    requested_count  TINYINT UNSIGNED  NOT NULL,   -- số thẻ đã chốt (5-50)
    card_count       TINYINT UNSIGNED  NOT NULL DEFAULT 0,  -- số thẻ thật; < requested = UC-23 E1
    card_types       SET('term','qa')  NOT NULL,   -- "Thuật ngữ – Định nghĩa" / "Câu hỏi – Đáp án ngắn"

    status           ENUM('generating','ready','failed') NOT NULL DEFAULT 'generating',
    error_message    VARCHAR(500)      NULL,
    model_name       VARCHAR(100)      NULL,       -- model LLM thật đã sinh (BR-08 đếm dòng có giá trị)

    created_at       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_flashcard_sets_user_created (user_id, created_at),
    KEY idx_flashcard_sets_subject (subject_id),

    CONSTRAINT fk_flashcard_sets_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_flashcard_sets_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,   -- UC-13 bước 4
    CONSTRAINT chk_flashcard_sets_requested_count
        CHECK (requested_count BETWEEN 5 AND 50),
    CONSTRAINT chk_flashcard_sets_card_count
        CHECK (card_count <= requested_count),
    CONSTRAINT chk_flashcard_sets_card_types
        CHECK (card_types <> '')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Bộ flashcard AI sinh — UC-23.';

-- -----------------------------------------------------------------------------
-- 2. FLASHCARD_SET_SOURCES — nguồn nội dung đã tick (UC-19), nhiều nguồn/bộ
-- -----------------------------------------------------------------------------
CREATE TABLE flashcard_set_sources (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    flashcard_set_id   CHAR(36)        NOT NULL,

    source_type        ENUM('CHAPTER','PDF') NOT NULL,
    chapter_id         CHAR(36)        NULL,
    document_id        CHAR(36)        NULL,
    source_label       VARCHAR(255)    NOT NULL,   -- snapshot tên hiển thị lúc tạo

    PRIMARY KEY (id),
    UNIQUE KEY uq_flashcard_set_sources_chapter (flashcard_set_id, chapter_id),
    UNIQUE KEY uq_flashcard_set_sources_document (flashcard_set_id, document_id),
    KEY idx_flashcard_set_sources_chapter (chapter_id),
    KEY idx_flashcard_set_sources_document (document_id),

    CONSTRAINT fk_flashcard_set_sources_set
        FOREIGN KEY (flashcard_set_id) REFERENCES flashcard_sets(id) ON DELETE CASCADE,
    CONSTRAINT fk_flashcard_set_sources_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_flashcard_set_sources_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nguồn (Chương/PDF) dùng để sinh 1 bộ flashcard.';

-- -----------------------------------------------------------------------------
-- 3. FLASHCARDS — từng thẻ + trích dẫn (BR-09) + trạng thái lặp lại ngắt quãng
-- -----------------------------------------------------------------------------
CREATE TABLE flashcards (
    id                  CHAR(36)          NOT NULL DEFAULT (UUID()),
    flashcard_set_id    CHAR(36)          NOT NULL,
    position            TINYINT UNSIGNED  NOT NULL,   -- thứ tự gốc (bắt đầu từ 1)

    card_type           ENUM('term','qa') NOT NULL,   -- nhãn "Mặt trước · Thuật ngữ / Câu hỏi"
    front               TEXT              NOT NULL,
    back                TEXT              NOT NULL,

    -- Trích dẫn nguồn (snapshot, xem đầu file)
    source_type         ENUM('CHAPTER','PDF') NOT NULL,
    chapter_id          CHAR(36)          NULL,
    document_id         CHAR(36)          NULL,
    embedding_chunk_id  CHAR(36)          NULL,       -- chunk đã đưa cho LLM; NULL sau khi re-embed
    source_label        VARCHAR(255)      NOT NULL,
    page_number         INT UNSIGNED      NULL,       -- chỉ PDF
    quote               TEXT              NOT NULL,   -- câu nguyên văn trong đoạn nguồn

    -- Lặp lại ngắt quãng (due_at NULL = thẻ mới)
    due_at              DATETIME          NULL,
    interval_seconds    INT UNSIGNED      NULL,       -- khoảng lần gần nhất đã xếp
    review_count        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    lapse_count         SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- số lần chấm "Khó"
    last_rating         ENUM('easy','hard') NULL,
    last_reviewed_at    DATETIME          NULL,

    created_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_flashcards_set_position (flashcard_set_id, position),
    KEY idx_flashcards_set_due (flashcard_set_id, due_at),
    KEY idx_flashcards_chapter (chapter_id),
    KEY idx_flashcards_document (document_id),
    KEY idx_flashcards_chunk (embedding_chunk_id),

    CONSTRAINT fk_flashcards_set
        FOREIGN KEY (flashcard_set_id) REFERENCES flashcard_sets(id) ON DELETE CASCADE,
    CONSTRAINT fk_flashcards_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_flashcards_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL,
    CONSTRAINT fk_flashcards_chunk
        FOREIGN KEY (embedding_chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL,
    CONSTRAINT chk_flashcards_position
        CHECK (position >= 1),
    -- Đã ôn ít nhất 1 lần thì phải có đủ lịch; thẻ mới thì chưa có gì.
    CONSTRAINT chk_flashcards_schedule
        CHECK ((review_count = 0 AND due_at IS NULL AND interval_seconds IS NULL AND last_rating IS NULL)
            OR (review_count > 0 AND due_at IS NOT NULL AND interval_seconds IS NOT NULL AND last_rating IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Thẻ ghi nhớ của 1 bộ flashcard + lịch ôn.';

-- -----------------------------------------------------------------------------
-- 4. FLASHCARD_REVIEWS — mỗi lần chấm Dễ/Khó (UC-23 bước 5)
-- -----------------------------------------------------------------------------
CREATE TABLE flashcard_reviews (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    flashcard_id      CHAR(36)        NOT NULL,
    user_id           CHAR(36)        NOT NULL,   -- bản sao cho thống kê/chuỗi ngày ôn (không JOIN)
    rating            ENUM('easy','hard') NOT NULL,
    interval_seconds  INT UNSIGNED    NOT NULL,   -- khoảng mới được xếp sau lần chấm này
    reviewed_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_flashcard_reviews_user_time (user_id, reviewed_at),
    KEY idx_flashcard_reviews_card (flashcard_id),

    CONSTRAINT fk_flashcard_reviews_card
        FOREIGN KEY (flashcard_id) REFERENCES flashcards(id) ON DELETE CASCADE,
    CONSTRAINT fk_flashcard_reviews_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Lịch sử ôn flashcard — chuỗi ngày ôn, UC-29/UC-39.';
