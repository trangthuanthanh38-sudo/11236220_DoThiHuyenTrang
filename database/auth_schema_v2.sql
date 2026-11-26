-- =====================================================================
-- auth_schema_v2.sql — ALTER sau auth_schema.sql (Docker nạp theo thứ tự tên file:
-- "auth_schema.sql" < "auth_schema_v2.sql").
--
-- users.google_name: tên hiển thị Google trả về ở lần đăng nhập Google gần nhất (UC-01/UC-02 luồng 3a).
--   - Tạo tài khoản Google: display_name = google_name = tên Google.
--   - Mỗi lần đăng nhập lại: nếu người dùng CHƯA tự đổi tên (display_name = google_name cũ) thì display_name
--     theo tên Google mới; đã tự đổi ở Hồ sơ (UC-06) thì giữ nguyên tên tự đặt.
--   - Hồ sơ: tài khoản Google để trống ô "Tên hiển thị" rồi Lưu -> quay về tên Google.
--   NULL với tài khoản SĐT (local).
-- =====================================================================
ALTER TABLE users
    ADD COLUMN google_name VARCHAR(100) NULL AFTER google_email;
