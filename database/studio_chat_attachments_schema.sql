-- =============================================================================
-- AI Studio Tri Thức — Đính kèm ngữ cảnh ở ô nhập AI Chat (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: phần UI còn thiếu của UC-19 (Chọn phạm vi nội dung nguồn, xem
-- .claude/rules/08-ai-studio.md) — gõ "@" hoặc kéo-thả+Shift để gắn 1 Chương
-- làm ngữ cảnh, hoặc bấm "+" để tải tệp/ảnh, TRƯỚC khi bấm Gửi ở khung "Hỏi
-- đáp tri thức". File này KHÔNG triển khai bất kỳ logic AI nào — không gọi
-- LLM, không RAG, không embedding/vector search, không OCR. Không có gì ở
-- đây gửi nội dung Chương/tệp đã đính kèm cho một AI model nào — chỉ ghi
-- nhận & phục vụ hiển thị lại (chip) ở ô nhập.
--
-- Quyết định thiết kế quan trọng:
--   - `chat_attachments` KHÔNG có cột `message_id` và KHÔNG FK vào
--     `chat_messages` (xem studio_chat_schema.sql) — 2 bảng đó vẫn CHƯA được
--     router nào dùng, toàn bộ phiên/tin nhắn chat hiện sống 100% ở frontend
--     (mất khi tải lại trang, xem CLAUDE.md). Xây lại toàn bộ tầng lưu trữ
--     phiên/tin nhắn chat thật KHÔNG thuộc phạm vi thay đổi này — 1 "đính
--     kèm" ở đây chỉ là "thứ user đang gắn vào ô nhập", thuộc về đúng 1
--     `user_id`, có vòng đời `pending` (đang nằm trong ô nhập, khôi phục lại
--     được sau khi tải lại trang) -> `sent` (đã bấm Gửi — tin nhắn chứa nó
--     hiện CHƯA được lưu server, cột này chỉ để không hiện lại chip đó trong
--     ô nhập nữa). Khi sau này xây lịch sử chat thật, thêm cột `message_id`
--     (nullable, FK ON DELETE SET NULL) là 1 lệnh ALTER TABLE — đúng kiểu mẫu
--     "thêm FK sau" mà `chat_message_citations.embedding_chunk_id` đã dùng.
--   - Dùng 1 bảng chung cho cả 2 loại chip (`kind` ENUM 'chapter'/'file'),
--     không tách 2 bảng riêng: cả hai chỉ khác nhau vài cột (chapter_id so
--     với original_name/file_path/file_size_bytes/mime_type), và gắn Chương
--     cũng cần lưu thật (không chỉ ở RAM) để chip sống sót qua F5 — tách 2
--     bảng sẽ nhân đôi router/CRUD/kiểm tra sở hữu cho khác biệt nhỏ đó.
--   - KHÔNG tái dùng `pdf_documents` (knowledge_content_schema.sql) cho chip
--     tệp: bảng đó có `CHECK (mime_type = 'application/pdf')` — cố tình chỉ
--     nhận PDF, "để chặn dữ liệu bẩn nếu tầng ứng dụng lỡ tái sử dụng bảng
--     cho định dạng khác" (xem comment gốc) — trong khi ô "+" ở đây phải
--     nhận cả ảnh.
--   - `chapter_id` dùng `ON DELETE CASCADE` (KHÁC `chat_sessions.scope_chapter_id`
--     dùng `SET NULL` ở studio_chat_schema.sql): ở đó phải giữ nguyên lịch sử
--     hội thoại khi nguồn bị xoá; ở đây chưa có lịch sử tin nhắn thật nào cần
--     bảo toàn — 1 chip trỏ tới Chương đã xoá chỉ là rác, xoá theo cho gọn.
--     Vì dùng CASCADE (không phải SET NULL), CHECK constraint bên dưới hợp
--     lệ — MySQL 8.0 chỉ cấm CHECK trên cột đang tham gia hành vi
--     `ON DELETE SET NULL` của FK (lỗi 3823), không cấm với CASCADE.
--   - Không có cột BLOB nào — file tệp/ảnh thật nằm ngoài DB, trên đĩa server
--     (backend/app/config.py: CHAT_ATTACHMENT_UPLOAD_DIR), đúng nguyên tắc đã
--     áp dụng cho `pdf_documents.file_path`.
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy (đã có dữ liệu cũ, không nạp lại từ đầu qua Docker):
--   mysql -u root -p ai_studio_tri_thuc < database/studio_chat_attachments_schema.sql
-- (Nếu chạy lần đầu qua `docker compose up -d` với volume rỗng, file này tự
-- nạp theo thứ tự bảng chữ cái — chỉ cần bảng `users` (auth_schema.sql) và
-- `chapters` (knowledge_content_schema.sql) đã tồn tại, cả hai đều xếp trước
-- "studio_chat_attachments_schema.sql" theo alphabet nên luôn sẵn sàng; file
-- này KHÔNG phụ thuộc studio_chat_schema.sql nên thứ tự giữa 2 file "studio_
-- chat_*" không quan trọng.)
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- CHAT_ATTACHMENTS — Ngữ cảnh đính kèm ở ô nhập AI Chat (UC-19 bước 1 + 1a)
-- -----------------------------------------------------------------------------
CREATE TABLE chat_attachments (
    id               CHAR(36)     NOT NULL DEFAULT (UUID()),
    user_id          CHAR(36)     NOT NULL,   -- BR-05: chủ sở hữu duy nhất

    kind             ENUM('chapter','file') NOT NULL,

    -- Nhãn hiển thị trên "chip" ở ô nhập — snapshot tại thời điểm đính kèm
    -- (tên Chương hoặc tên tệp gốc); đổi tên Chương sau đó KHÔNG sửa nhãn cũ.
    label            VARCHAR(255) NOT NULL,

    -- pending = đang nằm trong ô nhập (khôi phục lại khi tải lại trang);
    -- sent = đã bấm Gửi (tin nhắn hiện CHƯA được lưu server — xem khối
    -- "Quyết định thiết kế" đầu file), chỉ để không hiện lại trong ô nhập.
    status           ENUM('pending','sent') NOT NULL DEFAULT 'pending',

    -- kind='chapter'
    chapter_id       CHAR(36)     NULL,

    -- kind='file' — file thật nằm ngoài DB (settings.CHAT_ATTACHMENT_UPLOAD_DIR),
    -- KHÔNG có cột BLOB, đúng nguyên tắc của pdf_documents.
    original_name    VARCHAR(255) NULL,
    file_path        VARCHAR(500) NULL,
    file_size_bytes  BIGINT UNSIGNED NULL,
    mime_type        VARCHAR(100) NULL,

    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_chat_attachments_file_path (file_path),  -- NULL lặp lại được (MySQL)
    KEY idx_chat_attachments_user_status (user_id, status, created_at),
    KEY idx_chat_attachments_chapter (chapter_id),

    CONSTRAINT fk_chat_attachments_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_attachments_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    CONSTRAINT chk_chat_attachments_shape CHECK (
        (kind = 'chapter' AND chapter_id IS NOT NULL AND file_path IS NULL)
        OR (kind = 'file' AND file_path IS NOT NULL AND chapter_id IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='Ngữ cảnh đính kèm ở ô nhập AI Chat (Chương tham chiếu / tệp-ảnh tải lên) — chưa gắn với tin nhắn nào.';
