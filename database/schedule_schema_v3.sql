-- =============================================================================
-- AI Studio Tri Thức — Lịch biểu v3: thông báo NHẮC HỌC ngoài nhắc lịch (MySQL 8.0+)
-- =============================================================================
-- Bảng `notifications` (UC-31) giờ chứa thêm nhắc do máy chủ tự sinh từ dữ liệu học tập, hiện chung 1 chuông
-- (topbar trang soạn thảo + màn Lịch biểu), cùng cơ chế đã đọc / tiếng chuông / hộp báo:
--   kind = 'schedule'  — nhắc lịch biểu như trước (item_type / item_date / start_minute bắt buộc)
--   kind = 'flashcard' — bộ thẻ có thẻ đến hạn ôn            (ref_id = flashcard_sets.id)
--   kind = 'exam'      — đề thi thử đang làm dở, còn giờ      (ref_id = quiz_sets.id)
--   kind = 'practice'  — bài ôn tập đang làm dở, chưa nộp     (ref_id = quiz_sets.id)
-- `ref_id` KHÔNG có FK (trỏ tới 2 bảng khác nhau) — nguồn bị xoá thì giao diện báo "đã bị xoá".
-- `detail` = dòng phụ snapshot lúc nhắc ("12 thẻ đến hạn ôn", "Đã làm 8/20 câu · còn 14 phút").
-- `dedupe_key` + UNIQUE(user_id, dedupe_key) chống tạo trùng khi vòng nền và lượt quét "lười" chạy cùng lúc
-- (fc:<bộ>:<ngày> / ex:<lượt thi> / pr:<lượt làm>:<ngày>); nhắc lịch để NULL (đã chống trùng bằng remind_sent).
-- Nhắc học chỉ có kênh 'app' (không gửi email).
--
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/schedule_schema_v3.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file xếp ngay SAU schedule_schema_v2.sql.
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE notifications
    ADD COLUMN kind ENUM('schedule','flashcard','practice','exam') NOT NULL DEFAULT 'schedule' AFTER schedule_item_id,
    ADD COLUMN ref_id     CHAR(36)     NULL AFTER kind,
    ADD COLUMN detail     VARCHAR(255) NULL AFTER title,
    ADD COLUMN dedupe_key VARCHAR(100) NULL AFTER detail,
    MODIFY COLUMN item_type    ENUM('event','class','deadline','exam') NULL,
    MODIFY COLUMN item_date    DATE NULL,
    MODIFY COLUMN start_minute SMALLINT UNSIGNED NULL,
    ADD UNIQUE KEY uq_notifications_dedupe (user_id, dedupe_key),
    ADD CONSTRAINT chk_notifications_kind CHECK (
        (kind = 'schedule' AND item_type IS NOT NULL AND item_date IS NOT NULL AND start_minute IS NOT NULL)
        OR (kind <> 'schedule' AND ref_id IS NOT NULL)
    );
