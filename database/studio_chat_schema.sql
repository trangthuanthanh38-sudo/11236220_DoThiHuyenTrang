-- =============================================================================
-- AI Studio Tri Thức — AI Chat Foundation Schema (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: CHỈ tạo cấu trúc dữ liệu nền tảng cho tính năng "AI Chat" (khởi đầu
-- của UC-20 — Hỏi đáp tri thức, xem .claude/rules/08-ai-studio.md). Nhóm này
-- KHÔNG triển khai bất kỳ logic AI nào — không gọi LLM, không RAG, không
-- embedding/vector search, không OCR. Việc gọi Gemini API (hoặc nhà cung cấp
-- LLM khác) và pipeline RAG thật sẽ làm ở phiên làm việc kế tiếp, dùng lại
-- đúng 3 bảng dưới đây để lưu hội thoại + trích dẫn.
--
-- Quyết định thiết kế quan trọng:
--   - `chat_sessions.id` dùng CHAR(36) UUID, cùng quy ước với các bảng thực
--     thể khác (subjects/chapters/pdf_documents) — một phiên chat là 1 "thực
--     thể" người dùng thấy/quản lý (đổi tên, xoá) trong danh sách hội thoại.
--   - `chat_messages.id` dùng BIGINT UNSIGNED AUTO_INCREMENT thay vì UUID —
--     giống `login_audit_logs`/`account_security_logs`: tin nhắn là dữ liệu
--     dạng nhật ký, chỉ INSERT (append-only), không cần ID đoán trước được
--     hay sinh ở client, và AUTO_INCREMENT cho thứ tự chèn ổn định + rẻ hơn
--     khi đánh index/join số lượng lớn.
--   - `scope_subject_id`/`scope_chapter_id`/`scope_note_id` (nullable, ON DELETE
--     SET NULL): chuẩn bị cho UC-19 (Chọn phạm vi nội dung nguồn), đúng cả 3
--     mức phạm vi mà UC-19 liệt kê ở luồng chính bước 1 ("theo Môn học, theo
--     Chương, theo Bài ghi chú cụ thể") — một phiên chat CÓ THỂ gắn với 1
--     Môn học/Chương/Bài ghi chú cụ thể để AI trả lời bám tài liệu đó, hoặc để
--     trống cả ba nếu là hỏi đáp chung. `scope_note_id` tham chiếu bảng
--     `notes` (đã tạo ở knowledge_content_schema.sql, hiện là bảng "dự trữ"
--     theo đặc tả 3 tầng — xem comment đầu file đó) — tầng ứng dụng chỉ dùng
--     được mức phạm vi này khi UI thật sự có node Bài ghi chú. KHÔNG có cột
--     nào tham chiếu tới embedding/chunk vì chưa xây RAG — khi làm RAG thật,
--     các bảng EMBEDDING_CHUNK/trích dẫn nguồn sẽ được thêm sau bằng file
--     schema riêng, không sửa 2 bảng này.
--   - `chat_messages.model_name` chỉ là VARCHAR tự do, luôn NULL cho tới khi
--     tầng ứng dụng điền tên model thật đã dùng để sinh câu trả lời (vd.
--     "gemini-2.5-flash") — schema KHÔNG hard-code bất kỳ nhà cung cấp AI
--     nào (Gemini/OpenAI/Claude...), không có ENUM/default gắn với 1 vendor.
--   - KHÔNG có cột nào lưu API key/secret của bất kỳ nhà cung cấp AI nào —
--     khoá gọi API luôn nằm ở biến môi trường phía backend (xem
--     backend/app/config.py), không bao giờ đi vào DB.
--   - Sở hữu dữ liệu (BR-05 áp dụng tương tự): 1 phiên chat luôn thuộc đúng 1
--     user qua `chat_sessions.user_id`; tin nhắn không có user_id riêng — suy
--     ra quyền truy cập qua `chat_sessions.user_id` (tầng ứng dụng phải JOIN
--     qua session để kiểm tra quyền trước khi trả message cho client).
--   - `chat_message_citations` (BR-09 + UC-20 luồng thay thế 5a): mỗi trích
--     dẫn là 1 dòng riêng, tách khỏi `chat_messages.content` (chuỗi trả lời
--     thô) — để 1 câu trả lời trích được NHIỀU đoạn nguồn, và để truy vấn/
--     thống kê trực tiếp trên trích dẫn (vd. "Bài ghi chú nào được AI trích
--     dẫn nhiều nhất": `GROUP BY note_id`) mà không phải parse `content`.
--     `note_id` có FK thật tới `notes` (đã tồn tại) vì UC-20 5a cần điều
--     hướng thẳng tới Bài ghi chú gốc. `embedding_chunk_id` CHƯA có FK — bảng
--     EMBEDDING_CHUNK chưa được tạo (đúng quyết định ở trên: chưa xây RAG),
--     nên cột này tạm là UUID tự do, sẽ gắn FK thật bằng ALTER TABLE khi
--     EMBEDDING_CHUNK ra đời ở giai đoạn RAG. Một trích dẫn PHẢI có ít nhất 1
--     trong 2 tham chiếu (`embedding_chunk_id` hoặc `note_id`) — ràng buộc này
--     CHỈ kiểm tra ở tầng ứng dụng, KHÔNG có CHECK constraint ở DB: MySQL 8.0
--     cấm CHECK trên cột đang tham gia hành vi `ON DELETE SET NULL` của FK
--     (lỗi 3823 — "column needed in a foreign key constraint referential
--     action"), mà `note_id` bắt buộc phải SET NULL (không CASCADE) để giữ
--     đúng nguyên tắc "không mất lịch sử hội thoại" đã áp dụng cho scope_* ở
--     chat_sessions — hai yêu cầu này xung đột kỹ thuật, ưu tiên giữ SET NULL.
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy (đã có dữ liệu cũ, không nạp lại từ đầu qua Docker):
--   mysql -u root -p ai_studio_tri_thuc < database/studio_chat_schema.sql
-- (Nếu chạy lần đầu qua `docker compose up -d` với volume rỗng, file này tự
-- nạp theo thứ tự bảng chữ cái — SAU auth_schema.sql (cần bảng `users`) và
-- SAU knowledge_content_schema.sql (cần bảng `subjects`/`chapters`); tên file
-- cố ý bắt đầu bằng "studio_" để xếp sau cả hai theo alphabet.)
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 1. CHAT_SESSIONS — Phiên trò chuyện AI Chat
-- -----------------------------------------------------------------------------
CREATE TABLE chat_sessions (
    id                CHAR(36)     NOT NULL DEFAULT (UUID()),
    user_id           CHAR(36)     NOT NULL,

    title             VARCHAR(200) NULL,   -- NULL = "Cuộc trò chuyện mới" (đặt tên ở tầng ứng
                                            -- dụng, vd. theo câu hỏi đầu tiên); người dùng đổi
                                            -- tên được sau đó.

    -- Phạm vi nội dung nguồn đã chọn cho phiên (nền cho UC-19/UC-20 kế tiếp) —
    -- đúng 3 mức của UC-19: Môn học / Chương / Bài ghi chú. Để trống cả ba =
    -- phiên hỏi đáp chung, không neo vào tài liệu cụ thể.
    scope_subject_id  CHAR(36)     NULL,
    scope_chapter_id  CHAR(36)     NULL,
    scope_note_id     CHAR(36)     NULL,

    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_chat_sessions_user_updated (user_id, updated_at),
    KEY idx_chat_sessions_scope_subject (scope_subject_id),
    KEY idx_chat_sessions_scope_chapter (scope_chapter_id),
    KEY idx_chat_sessions_scope_note (scope_note_id),

    CONSTRAINT fk_chat_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    -- SET NULL (không CASCADE): xoá Môn học/Chương/Bài ghi chú chỉ gỡ tham
    -- chiếu phạm vi, KHÔNG xoá lịch sử hội thoại — hội thoại vẫn là dữ liệu
    -- thuộc về người dùng dù nguồn tham chiếu đã bị xoá.
    CONSTRAINT fk_chat_sessions_scope_subject
        FOREIGN KEY (scope_subject_id) REFERENCES subjects(id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_sessions_scope_chapter
        FOREIGN KEY (scope_chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_sessions_scope_note
        FOREIGN KEY (scope_note_id) REFERENCES notes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Phiên trò chuyện AI Chat — nền tảng dữ liệu cho UC-19/UC-20, chưa có logic AI.';

-- -----------------------------------------------------------------------------
-- 2. CHAT_MESSAGES — Tin nhắn trong phiên trò chuyện
-- -----------------------------------------------------------------------------
CREATE TABLE chat_messages (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    session_id    CHAR(36)        NOT NULL,

    role          ENUM('user','assistant','system') NOT NULL,
    content       LONGTEXT        NOT NULL,

    -- Tên model đã sinh câu trả lời (vd. "gemini-2.5-flash") — chỉ có ý nghĩa
    -- với role='assistant'; luôn NULL cho tới khi giai đoạn nối AI thật điền
    -- vào theo cấu hình runtime, KHÔNG hard-code giá trị mặc định của bất kỳ
    -- nhà cung cấp nào ở đây.
    model_name    VARCHAR(100)    NULL,

    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_chat_messages_session_created (session_id, created_at, id),

    CONSTRAINT fk_chat_messages_session
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
    CONSTRAINT chk_chat_messages_model_name_role
        CHECK (role = 'assistant' OR model_name IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Tin nhắn trong phiên AI Chat — user/assistant/system, append-only.';

-- -----------------------------------------------------------------------------
-- 3. CHAT_MESSAGE_CITATIONS — Trích dẫn nguồn gắn với 1 tin nhắn (BR-09, UC-20 5a)
-- -----------------------------------------------------------------------------
-- Áp dụng cho tin nhắn role='assistant' (câu trả lời do AI sinh ra) — ràng buộc
-- này thuộc về nghiệp vụ (BR-09), không diễn đạt được bằng CHECK constraint vì
-- `role` nằm ở bảng khác; tầng ứng dụng chịu trách nhiệm chỉ INSERT citation cho
-- message role='assistant'.
CREATE TABLE chat_message_citations (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    message_id         BIGINT UNSIGNED NOT NULL,

    -- Đoạn nguồn cụ thể (từ pipeline RAG) — chưa có FK vì bảng EMBEDDING_CHUNK
    -- chưa được tạo (xem khối "Quyết định thiết kế quan trọng" đầu file). Vẫn
    -- lưu để giữ chỗ + join được ngay khi EMBEDDING_CHUNK ra đời, không phải
    -- migrate lại chat_message_citations lúc đó.
    embedding_chunk_id CHAR(36)        NULL,
    -- Bài ghi chú gốc chứa đoạn trích — denormalize thẳng ở đây (thay vì chỉ suy
    -- ra qua embedding_chunk_id -> note) để UC-20 5a điều hướng nhanh và để
    -- thống kê (vd. "Bài ghi chú nào được trích dẫn nhiều nhất") không cần JOIN
    -- qua bảng embedding sau này.
    note_id            CHAR(36)        NULL,

    created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_citations_message (message_id),
    KEY idx_citations_note (note_id),
    KEY idx_citations_embedding_chunk (embedding_chunk_id),

    -- CASCADE: xoá tin nhắn thì trích dẫn của nó không còn ý nghĩa, xoá theo luôn.
    CONSTRAINT fk_citations_message
        FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    -- SET NULL: xoá Bài ghi chú gốc chỉ gỡ tham chiếu, KHÔNG xoá dòng trích dẫn —
    -- giữ đúng nguyên tắc "không mất lịch sử hội thoại" đã áp dụng cho scope_*
    -- ở chat_sessions. (Không thêm CHECK "phải có ít nhất 1 trong 2 tham chiếu"
    -- ở đây — xem lý do kỹ thuật (lỗi MySQL 3823) trong khối comment đầu file;
    -- ràng buộc này do tầng ứng dụng đảm bảo khi ghi citation.)
    CONSTRAINT fk_citations_note
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Trích dẫn nguồn của từng câu trả lời AI — BR-09, UC-20 luồng thay thế 5a.';
