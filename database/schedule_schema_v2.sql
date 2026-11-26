-- =============================================================================
-- AI Studio Tri Thức — Lịch biểu v2: sự kiện LẶP LẠI (hằng tuần / tháng / năm) (MySQL 8.0+)
-- =============================================================================
-- 1 dòng schedule_items = 1 CHUỖI: `item_date` là ngày xuất hiện đầu tiên, `repeat_rule` là quy tắc lặp,
-- `repeat_until` (tuỳ chọn) là ngày cuối cùng còn xuất hiện — NULL = lặp mãi. Không sinh nhiều dòng; giao diện
-- tự trải chuỗi ra từng ngày, backend tính lần xuất hiện bằng Python (services/schedule_notifier.py).
--   weekly  — cùng thứ trong tuần
--   monthly — cùng ngày trong tháng; tháng không có ngày đó (31, 30, 29) thì bỏ qua tháng đó
--   yearly  — cùng ngày/tháng; 29/2 chỉ xuất hiện năm nhuận
-- Sửa/xoá luôn áp dụng cả chuỗi (người dùng chốt) nên không cần bảng ngoại lệ.
-- Nhắc (UC-31): `remind_at` trỏ tới lần xuất hiện KẾ TIẾP; nhắc xong backend tính lần sau và đặt lại
-- remind_sent = 0, hết chuỗi thì remind_sent = 1.
--
-- Cột tên `repeat_rule` vì REPEAT là từ khoá MySQL.
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/schedule_schema_v2.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file xếp ngay SAU schedule_schema.sql.
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE schedule_items
    ADD COLUMN repeat_rule  ENUM('none','weekly','monthly','yearly') NOT NULL DEFAULT 'none' AFTER end_minute,
    ADD COLUMN repeat_until DATE NULL AFTER repeat_rule,
    ADD CONSTRAINT chk_schedule_items_repeat_until CHECK (repeat_until IS NULL OR repeat_until >= item_date),
    ADD CONSTRAINT chk_schedule_items_repeat_none  CHECK (repeat_rule <> 'none' OR repeat_until IS NULL);
