-- =============================================================================
-- AI Studio Tri Thức — Lịch biểu (UC-26, UC-27, UC-28, UC-31) (MySQL 8.0+)
-- =============================================================================
-- Cấu trúc dữ liệu cho module Lịch biểu (xem .claude/rules/09-schedule-stats.md) theo giao diện
-- mẫu lich-bieu.html ở gốc repo: lưới Ngày/Tuần/Tháng, cột trái "Nhãn" (ẩn/hiện, đổi tên, trùng tên
-- thì gộp), form Thêm/Sửa sự kiện (tên, loại, ngày + giờ, màu, nhãn, nhắc trước, gửi qua), xoá có
-- xác nhận + Hoàn tác, chuông thông báo.
--
-- 5 phần:
--   schedule_labels          — nhãn của từng người (1 nhãn – 1 màu)
--   schedule_items           — SCHEDULE_ITEM: 1 sự kiện / buổi học / deadline / lịch thi
--   notifications            — NOTIFICATION: 1 lần nhắc đã đến giờ (UC-31), hiện ở chuông
--   notification_deliveries  — kết quả gửi theo từng kênh (Trong app / Email / Push) + thử lại
--   user_settings.notify_email (ALTER) — địa chỉ nhận email nhắc lịch
--
-- Quyết định thiết kế quan trọng:
--   - Giờ lưu theo GIỜ ĐỊA PHƯƠNG dạng ngày + phút trong ngày (`item_date` + `start_minute`/
--     `end_minute`) — đúng cách mẫu tính lưới (07:00-21:00, bước 15'), không lệch múi giờ khi DB
--     server chạy UTC. `remind_at` (DATETIME, giờ địa phương theo settings.APP_TIMEZONE) do backend
--     tính sẵn từ ngày/giờ bắt đầu và mức nhắc trước, để scheduler quét bằng index; backend so với
--     giờ hiện tại tính bằng Python theo APP_TIMEZONE, KHÔNG dùng NOW() của MySQL.
--   - Deadline là 1 mốc giờ: `end_minute = start_minute`; các loại khác bắt buộc kết thúc sau bắt
--     đầu (UC-26 E1) — ép bằng CHECK.
--   - Nhãn tách bảng riêng vì mẫu coi nhãn là thực thể dùng chung nhiều sự kiện: "một nhãn – một
--     màu", đổi tên 1 lần áp dụng mọi sự kiện, đổi sang tên trùng nhãn khác thì gộp, ẩn/hiện theo
--     nhãn. So tên không phân biệt hoa thường/khoảng trắng đầu cuối qua cột ảo `name_key` + UNIQUE.
--     Sự kiện không nhãn dùng màu riêng `schedule_items.color`; có nhãn thì màu hiển thị = màu nhãn.
--   - Liên kết Môn học/Chương (UC-26 1a) là TUỲ CHỌN, độc lập với Nhãn: FK SET NULL — xoá Môn/
--     Chương không xoá lịch của người học. "Chương phải thuộc Môn" kiểm ở tầng ứng dụng (lỗi 3823
--     cấm CHECK trên cột FK có SET NULL).
--   - NOTIFICATION chỉ được tạo khi ĐẾN GIỜ nhắc (UC-31 bước 2), không tạo trước lúc lưu sự kiện.
--     `schedule_items.remind_sent` đánh dấu đã nhắc; sửa ngày/giờ/mức nhắc thì backend đặt lại 0.
--     Xoá sự kiện (UC-28) giữ thông báo đã gửi (schedule_item_id SET NULL — chuông báo "Sự kiện này
--     đã bị xoá" như mẫu), còn lần gửi email đang chờ/thử lại thì chuyển 'cancelled'.
--   - notification_deliveries: 1 dòng/kênh/thông báo, UNIQUE(notification_id, channel) chống gửi
--     trùng (UC-31 bước 4); email lỗi -> 'failed' + attempts, thử lại tối đa 3 lần (UC-31 E1).
--     Push chưa có hạ tầng -> luôn 'skipped'.
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/schedule_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file "schedule_" xếp SAU "knowledge_content_schema.sql"
-- (FK subjects/chapters) và "profile_settings_schema.sql" (ALTER user_settings).
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. SCHEDULE_LABELS — nhãn tự đặt tên của người học
-- -----------------------------------------------------------------------------
CREATE TABLE schedule_labels (
    id          CHAR(36)     NOT NULL DEFAULT (UUID()),
    user_id     CHAR(36)     NOT NULL,
    name        VARCHAR(80)  NOT NULL,
    name_key    VARCHAR(80)  GENERATED ALWAYS AS (LOWER(TRIM(name))) STORED,
    color       CHAR(7)      NOT NULL,                  -- '#0a1a4d' — màu chuẩn hoặc màu tự chọn của mẫu
    is_hidden   BOOLEAN      NOT NULL DEFAULT FALSE,    -- ô tick ẩn/hiện ở cột "Nhãn"

    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_schedule_labels_name (user_id, name_key),
    CONSTRAINT fk_schedule_labels_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_schedule_labels_name CHECK (TRIM(name) <> ''),
    CONSTRAINT chk_schedule_labels_color CHECK (REGEXP_LIKE(color, '^#[0-9a-f]{6}$', 'c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nhãn lịch biểu — 1 nhãn 1 màu, tên không phân biệt hoa thường.';

-- -----------------------------------------------------------------------------
-- 2. SCHEDULE_ITEMS — mục lịch (UC-26 tạo, UC-27 xem, UC-28 xoá; sửa theo mẫu)
-- -----------------------------------------------------------------------------
CREATE TABLE schedule_items (
    id             CHAR(36)      NOT NULL DEFAULT (UUID()),
    user_id        CHAR(36)      NOT NULL,

    title          VARCHAR(200)  NOT NULL,
    item_type      ENUM('event','class','deadline','exam') NOT NULL DEFAULT 'event',
                                 -- Sự kiện / Buổi học / Deadline / Lịch thi

    label_id       CHAR(36)      NULL,                  -- NULL = "Không có nhãn"
    color          CHAR(7)       NOT NULL,              -- màu khi không nhãn (có nhãn thì dùng màu nhãn)

    -- UC-26 luồng 1a: liên kết tuỳ chọn để UC-29 thống kê theo Môn
    subject_id     CHAR(36)      NULL,
    chapter_id     CHAR(36)      NULL,

    item_date      DATE          NOT NULL,              -- ngày địa phương
    start_minute   SMALLINT UNSIGNED NOT NULL,          -- phút trong ngày, 480 = 08:00
    end_minute     SMALLINT UNSIGNED NOT NULL,          -- deadline: = start_minute

    remind_before  ENUM('none','m10','m30','h1','d1') NOT NULL DEFAULT 'm30',
    via_app        BOOLEAN       NOT NULL DEFAULT TRUE,
    via_email      BOOLEAN       NOT NULL DEFAULT FALSE,
    via_push       BOOLEAN       NOT NULL DEFAULT FALSE,
    remind_at      DATETIME      NULL,                  -- giờ địa phương; NULL khi remind_before='none'
    remind_sent    BOOLEAN       NOT NULL DEFAULT FALSE,

    created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_schedule_items_range (user_id, item_date),
    KEY idx_schedule_items_remind (remind_sent, remind_at),
    CONSTRAINT fk_schedule_items_user    FOREIGN KEY (user_id)    REFERENCES users(id)           ON DELETE CASCADE,
    CONSTRAINT fk_schedule_items_label   FOREIGN KEY (label_id)   REFERENCES schedule_labels(id) ON DELETE SET NULL,
    CONSTRAINT fk_schedule_items_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)        ON DELETE SET NULL,
    CONSTRAINT fk_schedule_items_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id)        ON DELETE SET NULL,
    CONSTRAINT chk_schedule_items_title  CHECK (TRIM(title) <> ''),
    CONSTRAINT chk_schedule_items_color  CHECK (REGEXP_LIKE(color, '^#[0-9a-f]{6}$', 'c')),
    CONSTRAINT chk_schedule_items_start  CHECK (start_minute < 1440),
    CONSTRAINT chk_schedule_items_end    CHECK (end_minute <= 1440),
    -- UC-26 E1: kết thúc sau bắt đầu; deadline là 1 mốc giờ
    CONSTRAINT chk_schedule_items_span   CHECK (
        (item_type = 'deadline' AND end_minute = start_minute) OR
        (item_type <> 'deadline' AND end_minute > start_minute)
    ),
    CONSTRAINT chk_schedule_items_remind CHECK ((remind_before = 'none') = (remind_at IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SCHEDULE_ITEM — UC-26/27/28. Giờ địa phương: ngày + phút trong ngày.';

-- -----------------------------------------------------------------------------
-- 3. NOTIFICATIONS — 1 lần nhắc đã đến giờ (UC-31 bước 2), hiện ở chuông
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id           CHAR(36)     NOT NULL,
    schedule_item_id  CHAR(36)     NULL,                 -- SET NULL: xoá sự kiện vẫn giữ thông báo cũ

    -- Snapshot lúc nhắc (sự kiện có thể bị sửa/xoá sau đó)
    item_type         ENUM('event','class','deadline','exam') NOT NULL,
    title             VARCHAR(200) NOT NULL,
    item_date         DATE         NOT NULL,
    start_minute      SMALLINT UNSIGNED NOT NULL,

    fire_at           DATETIME     NOT NULL,             -- giờ địa phương lúc nhắc
    is_read           BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_notifications_user (user_id, fire_at),
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id)          REFERENCES users(id)          ON DELETE CASCADE,
    CONSTRAINT fk_notifications_item FOREIGN KEY (schedule_item_id) REFERENCES schedule_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NOTIFICATION — UC-31. Chỉ tạo khi đến giờ nhắc.';

-- -----------------------------------------------------------------------------
-- 4. NOTIFICATION_DELIVERIES — gửi theo từng kênh (UC-31 bước 3-4, E1)
-- -----------------------------------------------------------------------------
CREATE TABLE notification_deliveries (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    notification_id  BIGINT UNSIGNED NOT NULL,
    channel          ENUM('app','email','push') NOT NULL,
    status           ENUM('pending','sent','failed','skipped','cancelled') NOT NULL DEFAULT 'pending',
    recipient        VARCHAR(255) NULL,                  -- email đã gửi tới (snapshot)
    attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
    last_error       VARCHAR(500) NULL,
    sent_at          DATETIME     NULL,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_notification_deliveries (notification_id, channel),
    KEY idx_notification_deliveries_retry (status, attempts),
    CONSTRAINT fk_notification_deliveries_notification
        FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
    CONSTRAINT chk_notification_deliveries_attempts CHECK (attempts <= 3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Kết quả gửi nhắc theo kênh — chống gửi trùng, thử lại tối đa 3 lần.';

-- -----------------------------------------------------------------------------
-- 5. USER_SETTINGS — email nhận nhắc lịch
-- -----------------------------------------------------------------------------
-- Tài khoản SĐT không có email; tài khoản Google mặc định dùng users.google_email khi cột này NULL.
ALTER TABLE user_settings
    ADD COLUMN notify_email VARCHAR(255) NULL AFTER theme;
