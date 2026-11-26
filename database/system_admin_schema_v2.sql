-- =============================================================================
-- UC-33 Hạn mức — đợt 2 (người dùng chốt): mọi lần quản trị viên sửa hạn mức phải kèm LÝ DO và được thông báo
-- tới mọi người học; mỗi lần sửa có thể là CỐ ĐỊNH hoặc TẠM THỜI tới 1 thời điểm, hết hạn thì tự trở về số lượng cố
-- định (giá trị trước lần sửa tạm thời). "Hỏi đáp" (ai.qa) giờ là số lượt MỖI CUỘC HỘI THOẠI, không theo ngày.
--
-- 1. quota_settings + base_value / expires_at / change_id: đang tạm thời <=> 2 cột đầu khác NULL (CHECK).
--    base_value = số lượng cố định sẽ trở về; expires_at = giờ ĐỊA PHƯƠNG (APP_TIMEZONE, như ai_usage_events) hết hạn.
--    Sửa tạm thời lần nữa khi đang tạm thời -> giữ nguyên base_value (vẫn về đúng mức cố định ban đầu); sửa cố định ->
--    xoá cả 2. Hết hạn: services/quota.get_settings() dùng ngay base_value, vòng nền quota.expire_temporary() ghi lại
--    value = base_value, ghi nhật ký + thông báo người học.
-- 2. quota_change_events: 1 dòng = 1 lần đổi hạn mức (kind 'change' do admin, 'revert' do hệ thống khi hết hạn) —
--    lý do + danh sách thay đổi đầy đủ (JSON) để người học bấm thông báo xem chi tiết (notifications.detail chỉ 255
--    ký tự). admin_id không FK (như admin_audit_logs).
-- 3. notifications.kind thêm 'quota_change' (ref_id = quota_change_events.id).
--
-- Nạp lần đầu qua `docker compose up -d`: "system_admin_schema_v2" xếp ngay SAU system_admin_schema.sql.
-- =============================================================================

-- 1 -------------------------------------------------------------------------
ALTER TABLE quota_settings
    ADD COLUMN base_value INT        NULL AFTER value,
    ADD COLUMN expires_at DATETIME   NULL AFTER base_value,
    ADD COLUMN change_id  BIGINT UNSIGNED NULL AFTER expires_at,
    ADD CONSTRAINT chk_quota_settings_temp CHECK ((base_value IS NULL) = (expires_at IS NULL)),
    ADD CONSTRAINT chk_quota_settings_base CHECK (base_value IS NULL OR base_value > 0);

UPDATE quota_settings SET value = 50 WHERE setting_key = 'ai.qa' AND value = 60;   -- mặc định mới: 50 lượt / hội thoại

-- 2 -------------------------------------------------------------------------
CREATE TABLE quota_change_events (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    kind         ENUM('change','revert') NOT NULL,
    admin_id     CHAR(36)     NULL,
    admin_label  VARCHAR(100) NOT NULL,
    reason       VARCHAR(300) NOT NULL,
    changes      JSON         NOT NULL,   -- [{key, name, unit, from, to}]
    expires_at   DATETIME     NULL,       -- kind='change' tạm thời: hết hạn lúc nào
    created_at   DATETIME     NOT NULL,
    PRIMARY KEY (id),
    KEY idx_quota_change_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Lịch sử đổi hạn mức + lý do gửi người học — UC-33.';

-- 3 -------------------------------------------------------------------------
ALTER TABLE notifications
    MODIFY COLUMN kind ENUM('schedule','flashcard','practice','exam','share','share_request',
                            'quota','quota_ai','feedback','file_removed','account','quota_change') NOT NULL DEFAULT 'schedule';
