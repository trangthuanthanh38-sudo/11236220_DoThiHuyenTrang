-- =============================================================================
-- AI Studio Tri Thức — RAG Bước 3: thêm nguồn CHAPTER cho embedding_chunks (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: migration ALTER cho bảng `embedding_chunks` đã tạo ở studio_rag_schema.sql.
-- Bước 3 (chunking + embedding thật, xem backend/app/services/embeddings.py) phát hiện
-- source_type gốc chỉ có 'NOTE'/'PDF' không đủ: nội dung Chương thật nằm ở
-- `chapters.content_text` (xem knowledge_content_schema.sql + knowledge.py update_chapter),
-- KHÔNG ở bảng `notes` (bảng dự trữ theo đặc tả 3 tầng, chưa router nào dùng — đúng cách mọi
-- tính năng khác trong dự án đã xử lý tình huống này, vd. chat attachment kind='chapter' đọc
-- thẳng `chapters.content_text` chứ không qua `notes`). Vì vậy thêm 'CHAPTER' làm source_type
-- thứ 3, tái dùng cột `chapter_id` đã có sẵn (trước đây chỉ để denormalize phạm vi) làm FK
-- nguồn thật cho trường hợp này — không cần thêm cột mới. `'NOTE'` GIỮ NGUYÊN trong ENUM
-- (không xoá, không rủi ro với dữ liệu/route nào đang tồn tại) dù pipeline Bước 3 hiện chỉ
-- ghi 'CHAPTER'/'PDF' — nếu UC-16 sau này nối bảng `notes` thật thì source đó vẫn dùng được.
--
-- Cách chạy (DB dev đã có dữ liệu từ studio_rag_schema.sql, không cần xoá volume):
--   mysql -u root -p ai_studio_tri_thuc < database/studio_rag_schema_v2.sql
-- (Nếu nạp lần đầu qua `docker compose up -d` với volume rỗng, tên file "studio_rag_schema_v2"
-- xếp SAU "studio_rag_schema" theo thứ tự bảng chữ cái nên luôn chạy đúng sau file gốc.)
-- =============================================================================

SET NAMES utf8mb4;

-- 1. Nới ENUM source_type thêm 'CHAPTER'.
ALTER TABLE embedding_chunks
    MODIFY COLUMN source_type ENUM('NOTE','PDF','CHAPTER') NOT NULL;

-- 2. chk_embedding_chunks_source: thêm nhánh CHAPTER (không note_id, không document_id —
--    nguồn thật là chapter_id, đã có sẵn cột này).
ALTER TABLE embedding_chunks DROP CHECK chk_embedding_chunks_source;
ALTER TABLE embedding_chunks
    ADD CONSTRAINT chk_embedding_chunks_source
        CHECK (
            (source_type = 'NOTE'    AND note_id IS NOT NULL AND document_id IS NULL)
            OR (source_type = 'PDF'     AND document_id IS NOT NULL AND note_id IS NULL)
            OR (source_type = 'CHAPTER' AND note_id IS NULL AND document_id IS NULL)
        );

-- 3. chk_embedding_chunks_chapter_matches_source: CHAPTER cũng bắt buộc có chapter_id
--    (giống NOTE), chỉ PDF là NULL.
ALTER TABLE embedding_chunks DROP CHECK chk_embedding_chunks_chapter_matches_source;
ALTER TABLE embedding_chunks
    ADD CONSTRAINT chk_embedding_chunks_chapter_matches_source
        CHECK (
            (source_type IN ('NOTE','CHAPTER') AND chapter_id IS NOT NULL)
            OR (source_type = 'PDF' AND chapter_id IS NULL)
        );

-- 4. Không cho 2 chunk trùng số thứ tự trong cùng 1 Chương (đúng cặp UNIQUE đã có sẵn cho
--    note_id/document_id — chapter_id trước đây chỉ denormalize nên chưa có UNIQUE riêng).
ALTER TABLE embedding_chunks
    ADD UNIQUE KEY uq_embedding_chunks_chapter_index (chapter_id, chunk_index);
