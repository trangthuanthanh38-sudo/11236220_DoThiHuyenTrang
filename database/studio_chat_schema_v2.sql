-- =============================================================================
-- AI Studio Tri Thức — RAG Bước 5 (UC-19): thêm mức phạm vi "Tệp PDF" cho chat_sessions (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: migration ALTER cho bảng `chat_sessions` đã tạo ở studio_chat_schema.sql.
-- Bước 5 (UI chọn phạm vi nội dung nguồn, xem backend/app/routers/chat.py `_resolve_scope`)
-- phát hiện 3 cột scope_* gốc (Môn học/Chương/Bài ghi chú) KHÔNG đủ: PDF là item độc lập gắn
-- thẳng vào Môn học (`pdf_documents.subject_id`), ngang hàng với Chương, và chunk PDF có
-- `embedding_chunks.chapter_id = NULL` — không có cách nào giới hạn hỏi đáp trong riêng 1
-- file PDF nếu chỉ có 2 mức Môn/Chương. Thêm cột thứ 4 `scope_document_id`.
--
-- Quy ước 3 mức loại trừ nhau (tầng ứng dụng đảm bảo, KHÔNG CHECK ở DB — MySQL cấm CHECK
-- trên cột tham gia ON DELETE SET NULL, lỗi 3823, giống ghi chú ở studio_chat_schema.sql):
--   Môn   -> chỉ scope_subject_id
--   Chương -> scope_subject_id + scope_chapter_id
--   PDF   -> CHỈ scope_document_id (không lưu subject: kéo-thả PDF sang Môn khác không làm
--            lệch phạm vi, vì lọc chunk theo document_id không phụ thuộc Môn)
-- ON DELETE SET NULL như các scope_* khác: xoá PDF không xoá lịch sử hội thoại, phiên đó
-- quay về "Toàn bộ tri thức".
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   mysql -u root -p ai_studio_tri_thuc < database/studio_chat_schema_v2.sql
-- (Nạp lần đầu qua `docker compose up -d` với volume rỗng: "studio_chat_schema_v2" xếp SAU
-- "studio_chat_schema" và "knowledge_content_schema" (tạo pdf_documents) theo thứ tự bảng
-- chữ cái nên luôn chạy đúng thứ tự.)
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE chat_sessions
    ADD COLUMN scope_document_id CHAR(36) NULL AFTER scope_note_id,
    ADD KEY idx_chat_sessions_scope_document (scope_document_id),
    ADD CONSTRAINT fk_chat_sessions_scope_document
        FOREIGN KEY (scope_document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL;
