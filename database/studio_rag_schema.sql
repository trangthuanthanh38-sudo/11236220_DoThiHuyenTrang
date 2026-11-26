-- =============================================================================
-- AI Studio Tri Thức — RAG Foundation Schema: EMBEDDING_CHUNK (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: CHỈ tạo bảng `embedding_chunks` — nền tảng dữ liệu chuẩn bị cho RAG
-- (UC-19 → UC-25, xem .claude/rules/08-ai-studio.md). KHÔNG triển khai chunking,
-- không gọi embedding API, không vector search/cosine similarity, không
-- retrieval, không RAG prompt. Bảng này chỉ là NƠI LƯU kết quả của pipeline đó
-- sau này — mỗi dòng là 1 đoạn văn bản (chunk) ĐÃ được embed xong.
--
-- Mỗi chunk phải trả lời được 3 câu hỏi (đúng yêu cầu thiết kế):
--   1. Lấy từ đâu?      -> source_type + note_id/document_id + chunk_index + content
--   2. Thuộc phạm vi nào? -> user_id + subject_id + chapter_id
--   3. Vector nào, model nào? -> embedding_vector + embedding_model (+ embedding_dimension)
--
-- Quyết định thiết kế quan trọng:
--   - `id` CHAR(36) UUID (không phải AUTO_INCREMENT) — vì chunk là một THỰC THỂ
--     được tham chiếu từ nơi khác (chat_message_citations.embedding_chunk_id,
--     xem studio_chat_schema.sql, đã tạo CHAR(36) từ trước đúng để khớp kiểu
--     này) chứ không chỉ là dữ liệu log nội bộ một chiều.
--   - MySQL thuần, KHÔNG dùng pgvector/Qdrant/ANN index. `embedding_vector`
--     lưu dạng JSON (mảng số thực) — tầng Python sau này tự load JSON ->
--     NumPy để tính cosine similarity bằng tay, không có index chuyên biệt
--     cho vector ở DB.
--   - `embedding_model` BẮT BUỘC (NOT NULL): các model embedding khác nhau
--     sinh ra vector không cùng không gian, không so sánh cosine trực tiếp
--     được với nhau. Cột này còn dùng để xác định chunk nào cần re-embed khi
--     đổi model (`WHERE embedding_model <> '<model mới>'`) — vì vậy bảng chỉ
--     lưu chunk ĐÃ embed xong (kèm model), không có trạng thái "chờ embed"
--     (pipeline chunking + gọi embedding API coi như chạy xong trước khi
--     INSERT dòng vào bảng này).
--   - `source_type` dùng ENUM('NOTE','PDF') — ENUM đã tự đảm bảo đúng "CHECK
--     source_type IN ('NOTE','PDF')" theo yêu cầu, không cần thêm CHECK dư
--     thừa trên cột ENUM (cùng cách các cột loại tương tự trong project đang
--     làm: users.auth_provider, chat_messages.role...).
--   - Đúng 1 trong 2 (`note_id` XOR `document_id`) phải khớp `source_type` —
--     ép bằng CHECK `chk_embedding_chunks_source`. `document_id` tham chiếu
--     `pdf_documents` (bảng PDF duy nhất hiện có — xem
--     knowledge_content_schema.sql), không phải một bảng "documents" chung.
--   - `chapter_id` NULLABLE: `notes.chapter_id` luôn NOT NULL (mọi Note đều
--     thuộc 1 Chương) nhưng `pdf_documents` KHÔNG có chapter_id — PDF gắn
--     thẳng vào Subject, không thuộc Chương nào (xem comment "CẬP NHẬT TIẾP"
--     đầu knowledge_content_schema.sql). Vì vậy chunk nguồn PDF không thể có
--     chapter_id — ép bằng CHECK `chk_embedding_chunks_chapter_matches_source`
--     (NOTE thì bắt buộc có chapter_id, PDF thì bắt buộc NULL).
--   - `user_id`/`subject_id`/`chapter_id` là bản SAO (denormalize) từ chuỗi sở
--     hữu Note/PDF -> Chapter -> Subject -> User tại thời điểm chunk hoá —
--     KHÔNG phải nguồn sự thật (nguồn thật vẫn là notes/chapters/subjects) —
--     chỉ để UC-19 lọc theo phạm vi nhanh (WHERE subject_id=... /
--     chapter_id=...) mà không phải JOIN ngược qua note/chapter mỗi lần
--     retrieval. Tầng ứng dụng phải tự đảm bảo 3 cột này khớp đúng với
--     note/document tương ứng khi INSERT (DB không tự suy ra được).
--   - TẤT CẢ FK ở bảng này dùng ON DELETE CASCADE (cả nguồn lẫn phạm vi) —
--     khác hẳn `chat_sessions.scope_*`/`chat_message_citations.note_id` (dùng
--     SET NULL để giữ lịch sử chat). Ở đây một chunk KHÔNG có ý nghĩa gì nếu
--     tách khỏi nguồn/phạm vi của nó (không phải "lịch sử" cần giữ lại như
--     hội thoại) — xoá Note/PDF/Chapter/Subject/User thì chunk con phải mất
--     theo, nếu không sẽ để lại chunk "mồ côi" bị embed từ nội dung đã xoá.
--     (CASCADE cũng tránh được đúng lỗi MySQL 3823 "CHECK constraint không
--     được dùng trên cột đang SET NULL qua FK" mà studio_chat_schema.sql đã
--     gặp phải — CASCADE không bị giới hạn này.)
--   - `uq_embedding_chunks_note_index`/`uq_embedding_chunks_document_index`:
--     UNIQUE (note_id, chunk_index) và (document_id, chunk_index) — không cho
--     2 chunk trùng số thứ tự trong cùng 1 nguồn (NULL không đụng nhau trong
--     UNIQUE KEY của MySQL nên 2 khoá này không xung đột lẫn nhau giữa 2 loại
--     nguồn).
--   - Không có cột nào lưu API key — khoá gọi embedding API (khi làm thật)
--     nằm ở biến môi trường phía backend, không bao giờ vào DB.
--
-- Hoàn thiện luôn phần còn thiếu từ studio_chat_schema.sql: cột
-- `chat_message_citations.embedding_chunk_id` trước đó CHƯA có FK (bảng này
-- chưa tồn tại lúc đó, xem comment trong file .sql) — nay ALTER TABLE gắn FK
-- thật (ON DELETE SET NULL, cùng logic với `note_id` ở bảng đó: xoá chunk vì
-- re-embed/đổi model KHÔNG được xoá mất lịch sử hội thoại).
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy (đã có dữ liệu cũ, không nạp lại từ đầu qua Docker):
--   mysql -u root -p ai_studio_tri_thuc < database/studio_rag_schema.sql
-- (Nếu chạy lần đầu qua `docker compose up -d` với volume rỗng, file này tự
-- nạp theo thứ tự bảng chữ cái — SAU auth_schema.sql (`users`), SAU
-- knowledge_content_schema.sql (`subjects`/`chapters`/`notes`/`pdf_documents`)
-- và SAU studio_chat_schema.sql (`chat_message_citations`, cần có trước để
-- ALTER TABLE gắn FK ở cuối file này) — tên file bắt đầu bằng "studio_rag_"
-- xếp sau "studio_chat_" theo alphabet nên luôn đúng thứ tự.)
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 1. EMBEDDING_CHUNKS — Đoạn văn bản đã chunk + vector embedding
-- -----------------------------------------------------------------------------
CREATE TABLE embedding_chunks (
    id                   CHAR(36)          NOT NULL DEFAULT (UUID()),

    -- --- Nguồn: chunk lấy từ đâu? ---
    source_type          ENUM('NOTE','PDF') NOT NULL,
    note_id              CHAR(36)          NULL,   -- bắt buộc khi source_type='NOTE'
    document_id          CHAR(36)          NULL,   -- bắt buộc khi source_type='PDF'
    chunk_index          SMALLINT UNSIGNED NOT NULL,   -- thứ tự chunk trong nguồn (0-based)
    content               LONGTEXT          NOT NULL,   -- văn bản thô của chunk (đầu vào embedding)

    -- --- Phạm vi: chunk thuộc về ai / môn nào / chương nào? (denormalize) ---
    user_id              CHAR(36)          NOT NULL,
    subject_id           CHAR(36)          NOT NULL,
    chapter_id           CHAR(36)          NULL,   -- NULL khi source_type='PDF' (PDF không thuộc Chương)

    -- --- Embedding: vector nào, model nào sinh ra? ---
    embedding_vector     JSON              NOT NULL,   -- mảng số thực; tính cosine ở tầng Python (NumPy)
    embedding_model      VARCHAR(100)      NOT NULL,   -- vd. "text-embedding-004" — KHÔNG hard-code vendor
    embedding_dimension  SMALLINT UNSIGNED NULL,        -- độ dài vector, để đối chiếu/validate nhanh

    -- --- Vị trí trong nguồn (để UC-20 5a điều hướng đúng chỗ) ---
    -- PDF: {"page": 3, ...} (số trang, có thể thêm toạ độ sau).
    -- NOTE: {"start_offset": 120, "end_offset": 480, "block_id": "..."} (character
    -- offset/block id khớp cấu trúc content_json của trình soạn thảo — xem
    -- knowledge_content_schema.sql phần content_json).
    source_location      JSON              NOT NULL,

    created_at           DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),

    -- Không trùng số thứ tự chunk trong cùng 1 nguồn.
    UNIQUE KEY uq_embedding_chunks_note_index (note_id, chunk_index),
    UNIQUE KEY uq_embedding_chunks_document_index (document_id, chunk_index),

    KEY idx_embedding_chunks_user (user_id),
    KEY idx_embedding_chunks_subject (subject_id),
    KEY idx_embedding_chunks_chapter (chapter_id),
    KEY idx_embedding_chunks_note (note_id),
    KEY idx_embedding_chunks_document (document_id),
    KEY idx_embedding_chunks_source_type (source_type),
    -- Composite phục vụ UC-19 (Chọn phạm vi nội dung nguồn): lọc theo đúng
    -- user sở hữu + môn/chương đã chọn trong 1 lần dùng index, không cần JOIN.
    KEY idx_embedding_chunks_scope (user_id, subject_id, chapter_id),

    -- Nguồn — CASCADE: xoá Note/PDF gốc thì chunk sinh ra từ nó không còn ý
    -- nghĩa, phải mất theo (khác hẳn logic "giữ lịch sử chat" ở nơi khác).
    CONSTRAINT fk_embedding_chunks_note
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    CONSTRAINT fk_embedding_chunks_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE CASCADE,

    -- Phạm vi — CASCADE: xoá User/Subject/Chapter thì toàn bộ chunk thuộc phạm
    -- vi đó cũng phải dọn theo (đúng BR-10 "xoá cascade toàn bộ dữ liệu con").
    CONSTRAINT fk_embedding_chunks_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_embedding_chunks_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_embedding_chunks_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,

    -- Đúng 1 trong 2 nguồn, khớp source_type — không cho chunk "không xác định
    -- được nguồn" (không có cả note_id lẫn document_id, hoặc có cả hai).
    CONSTRAINT chk_embedding_chunks_source
        CHECK (
            (source_type = 'NOTE' AND note_id IS NOT NULL AND document_id IS NULL)
            OR
            (source_type = 'PDF' AND document_id IS NOT NULL AND note_id IS NULL)
        ),
    -- chapter_id phải khớp đúng bản chất nguồn: NOTE luôn có Chương, PDF thì không.
    CONSTRAINT chk_embedding_chunks_chapter_matches_source
        CHECK (
            (source_type = 'NOTE' AND chapter_id IS NOT NULL)
            OR
            (source_type = 'PDF' AND chapter_id IS NULL)
        ),
    CONSTRAINT chk_embedding_chunks_dimension
        CHECK (embedding_dimension IS NULL OR embedding_dimension > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Đoạn văn bản đã chunk + vector embedding — nền tảng RAG (UC-19->25), chưa có logic chunking/embedding/retrieval thật.';

-- -----------------------------------------------------------------------------
-- 2. Hoàn thiện FK đã hẹn từ trước ở studio_chat_schema.sql
-- -----------------------------------------------------------------------------
-- SET NULL (không CASCADE): re-embed/xoá chunk (vd. đổi embedding model) không
-- được xoá mất tin nhắn/lịch sử hội thoại đã hiển thị cho người dùng — cùng
-- triết lý với fk_chat_sessions_scope_note ở studio_chat_schema.sql.
ALTER TABLE chat_message_citations
    ADD CONSTRAINT fk_citations_embedding_chunk
        FOREIGN KEY (embedding_chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL;
