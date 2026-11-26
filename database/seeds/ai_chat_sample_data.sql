-- =============================================================================
-- Dữ liệu mẫu tối thiểu — AI Chat (chat_sessions / chat_messages)
-- =============================================================================
-- CHỈ để kiểm tra thủ công rằng schema hoạt động đúng (không phải seed bắt
-- buộc của ứng dụng). KHÔNG đặt trong thư mục database/ gốc — nằm ở
-- database/seeds/ để docker-entrypoint-initdb.d (chỉ quét *.sql ở thư mục
-- gốc được mount, không đệ quy thư mục con) không tự động chạy file này khi
-- `docker compose up -d` lần đầu trên volume rỗng, vì lúc đó bảng `users`
-- chưa có tài khoản nào để gắn phiên chat mẫu vào.
--
-- Script tự bỏ qua (không INSERT gì, không lỗi) nếu bảng `users` đang rỗng —
-- an toàn để chạy trên mọi thời điểm, kể cả nhỡ tay chạy trên DB trống.
--
-- Cách chạy:
--   mysql -u root -p ai_studio_tri_thuc < database/seeds/ai_chat_sample_data.sql
-- =============================================================================

SET NAMES utf8mb4;

SET @demo_user_id    = (SELECT id FROM users ORDER BY created_at LIMIT 1);
SET @demo_session_id = (SELECT UUID());

INSERT INTO chat_sessions (id, user_id, title)
SELECT @demo_session_id, @demo_user_id, 'Cuộc trò chuyện mẫu'
WHERE @demo_user_id IS NOT NULL;

INSERT INTO chat_messages (session_id, role, content)
SELECT @demo_session_id, 'user', 'Tóm tắt nội dung chương này giúp tôi.'
WHERE @demo_user_id IS NOT NULL;

INSERT INTO chat_messages (session_id, role, content, model_name)
SELECT @demo_session_id, 'assistant',
       '(Dữ liệu mẫu — chưa nối AI thật) Đây là chỗ AI Studio sẽ trả lời ở giai đoạn kế tiếp.',
       NULL
WHERE @demo_user_id IS NOT NULL;
