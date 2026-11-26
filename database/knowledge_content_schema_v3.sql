-- =============================================================================
-- knowledge_content_schema_v3.sql — Đặt mật khẩu cho Chương (thẻ Review ▸ Password, theo OneNote "Password Protection")
-- =============================================================================
-- password_hash: bcrypt (app.security.hash_password); NULL = Chương không có mật khẩu.
-- password_hint: gợi ý tuỳ chọn, hiện ở màn "Chương đã khoá" (không bao giờ chứa mật khẩu).
-- Quy tắc ở tầng ứng dụng (routers/knowledge.py, services/chapter_lock.py):
--   * GET /chapters/{id} chỉ trả nội dung (content_json / content_text / drawing_json) khi kèm khoá mở hợp lệ
--     (header X-Chapter-Key, HMAC theo id + hạn + password_hash — đổi mật khẩu là mọi khoá cũ hết hiệu lực);
--     ghi nội dung / nét vẽ cũng phải có khoá. Chỉ CHỦ SỞ HỮU đặt / đổi / gỡ mật khẩu.
--   * Như OneNote, Chương có mật khẩu KHÔNG được AI Studio đọc: xoá embedding_chunks của Chương, không re-embed,
--     không dùng làm đính kèm chat, trang chia sẻ công khai không hiện nội dung. Gỡ mật khẩu thì embed lại.
-- Docker nạp file này SAU knowledge_content_schema_v2.sql.
SET NAMES utf8mb4;

ALTER TABLE chapters
    ADD COLUMN password_hash VARCHAR(255) NULL,
    ADD COLUMN password_hint VARCHAR(200) NULL;
