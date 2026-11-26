-- =============================================================================
-- AI Studio Tri Thức — Quản trị hệ thống UC-32 → UC-37 + Hạn mức phía người học (MySQL 8.0+)
-- =============================================================================
-- Đặc tả: .claude/rules/10-admin.md (đã viết lại theo giao diện admin.html + han-muc-nguoi-hoc.html).
--
-- 1. users: thêm trạng thái 'disabled' (Vô hiệu hoá — tự xoá vĩnh viễn sau 30 ngày, đếm từ disabled_at) và cờ
--    must_reset_password ("Buộc đặt lại mật khẩu" UC-32 — chỉ tài khoản SĐT; mọi API trả 403 tới khi đặt lại qua UC-04).
--    "Khoá tạm · sai mật khẩu" KHÔNG là 1 trạng thái: vẫn là locked_until > bây giờ (UC-01 E4) như trước.
-- 2. quota_settings: hạn mức CHUNG cho mọi người học (BR-17), admin sửa ở UC-33. Thay AI_DAILY_LIMIT /
--    STATS_AI_DAILY_LIMIT / MAX_PDF_MB / MAX_CHAT_ATTACHMENT_MB trong .env. Trần kỹ thuật (Hỏi đáp 200, công cụ khác
--    50, 5.000 MB, 100 MB, 200 tệp) kiểm ở tầng ứng dụng (services/quota.py) — CHECK ở đây chỉ chặn số ≤ 0.
-- 3. ai_usage_events: 1 dòng = 1 lượt gọi AI (BR-08 đếm RIÊNG từng tính năng). Nguồn DUY NHẤT để đếm lượt/ngày
--    (status='ok'), "chạm hạn mức" (status='limited' = bị trả 429) và báo cáo UC-37 (token, chi phí, lỗi).
--    user_id KHÔNG có FK: xoá tài khoản vẫn giữ số liệu báo cáo. created_at = giờ ĐỊA PHƯƠNG (APP_TIMEZONE, ghi
--    bằng local_now() của Python — container MySQL chạy UTC), để "đặt lại lúc 00:00" đúng giờ Việt Nam.
-- 4. admin_audit_logs: nhật ký quản trị UC-34 — chỉ đọc (BR-18): 2 trigger chặn UPDATE/DELETE ở mức DB.
--    admin_id KHÔNG có FK (FK có referential action sẽ phải UPDATE dòng log khi xoá admin) — giữ admin_label snapshot.
-- 5. feedback: góp ý UC-35. id tăng dần để hiện "#GY-218". user_id SET NULL = "Người dùng đã xoá" (ẩn danh).
--    ref_type/ref_id trỏ tới thứ bị báo (thẻ / câu hỏi / ý tóm tắt / node sơ đồ) — KHÔNG FK (nhiều bảng, kiểu id khác
--    nhau); nội dung bị báo đã chụp lại ở quote_heading/quote_text. Ảnh đính kèm lưu trên đĩa (như pdf_documents) và
--    tính vào dung lượng của người gửi.
-- 6. user_quota_state: mức dung lượng đã báo gần nhất (0 = chưa, 1 = nhắc lần 1, 2 = nhắc lần 2, 3 = đầy) — chỉ tạo
--    thông báo khi mức TĂNG; giảm thì hạ theo (dọn xong rồi lại đầy thì được nhắc lại). Cột "Đã nhắc" ở UC-33.
-- 7. pdf_documents / chat_attachments: content_sha256 (Dọn dung lượng → lọc "Tệp trùng" = cùng chủ, cùng hash),
--    pdf_documents.last_opened_at ("Chưa mở 30 ngày"), process_status (UC-36 "Lỗi OCR / Tệp trống / Đang xử lý").
-- 8. notifications.kind thêm: quota (dung lượng / số tệp môn), quota_ai (sắp hết lượt AI), feedback (admin phản hồi),
--    file_removed (admin xoá tệp, detail = lý do), account. ref_id bắt buộc như các kind khác (CHECK cũ giữ nguyên).
--
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/system_admin_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: "system_" xếp SAU mọi file studio_* / stats_* / sharing_* (cần
-- notifications.kind bản sharing_schema.sql).
-- =============================================================================

SET NAMES utf8mb4;

-- 1 -------------------------------------------------------------------------
ALTER TABLE users
    MODIFY COLUMN status ENUM('pending_verification','active','locked','disabled') NOT NULL DEFAULT 'pending_verification',
    ADD COLUMN disabled_at         DATETIME   NULL AFTER locked_until,
    ADD COLUMN must_reset_password TINYINT(1) NOT NULL DEFAULT 0 AFTER disabled_at,
    ADD CONSTRAINT chk_users_disabled CHECK ((status = 'disabled') = (disabled_at IS NOT NULL));

-- 2 -------------------------------------------------------------------------
CREATE TABLE quota_settings (
    setting_key  VARCHAR(40)  NOT NULL,
    value        INT          NOT NULL,
    updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    updated_by   CHAR(36)     NULL,      -- admin sửa gần nhất (không FK, như admin_audit_logs)
    PRIMARY KEY (setting_key),
    CONSTRAINT chk_quota_settings_value CHECK (value > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Hạn mức chung cho mọi người học — UC-33, BR-08/14/17/19.';

INSERT INTO quota_settings (setting_key, value) VALUES
    ('ai.qa', 60), ('ai.quiz', 10), ('ai.fc', 10), ('ai.sum', 10), ('ai.mind', 10), ('ai.review', 5),
    ('feedback', 5),
    ('storage.user_mb', 500), ('storage.file_mb', 20), ('storage.subject_files', 30),
    ('warn.w1', 80), ('warn.w2', 95), ('warn.ai', 20);

-- 3 -------------------------------------------------------------------------
CREATE TABLE ai_usage_events (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id          CHAR(36)     NOT NULL,
    feature          ENUM('qa','quiz','fc','sum','mind','review') NOT NULL,
    status           ENUM('ok','error','limited') NOT NULL,
    error_source     ENUM('gemini','server') NULL,
    model_name       VARCHAR(100) NULL,
    tokens_in        INT UNSIGNED NOT NULL DEFAULT 0,
    tokens_out       INT UNSIGNED NOT NULL DEFAULT 0,
    tokens_thinking  INT UNSIGNED NOT NULL DEFAULT 0,
    cost_usd         DECIMAL(12,6) NOT NULL DEFAULT 0,
    created_at       DATETIME     NOT NULL,           -- giờ địa phương (local_now())
    PRIMARY KEY (id),
    KEY idx_ai_usage_user_day (user_id, feature, status, created_at),
    KEY idx_ai_usage_day (created_at),
    CONSTRAINT chk_ai_usage_error CHECK ((status = 'error') = (error_source IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='1 lượt gọi AI — đếm hạn mức BR-08 + báo cáo UC-37.';

-- 4 -------------------------------------------------------------------------
CREATE TABLE admin_audit_logs (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    admin_id      CHAR(36)     NULL,                 -- NULL = hệ thống tự làm (vd. tự xoá tài khoản vô hiệu hoá)
    admin_label   VARCHAR(100) NOT NULL,             -- snapshot tên hiển thị của admin / "Hệ thống"
    category      ENUM('acc','quota','file','fb') NOT NULL,
    action        VARCHAR(100) NOT NULL,             -- "Khoá tài khoản", "Sửa hạn mức"...
    object_label  VARCHAR(255) NOT NULL,             -- tên người dùng / tệp / #GY-218 / "Hạn mức chung"
    object_sub    VARCHAR(255) NULL,                 -- định danh ĐÃ CHE / "Chủ sở hữu: …" / tên tính năng
    from_value    VARCHAR(255) NOT NULL DEFAULT '—',
    to_value      VARCHAR(255) NOT NULL DEFAULT '—',
    is_negative   TINYINT(1)   NOT NULL DEFAULT 0,   -- khoá / xoá / vô hiệu hoá → tô đỏ
    created_at    DATETIME     NOT NULL,             -- giờ địa phương
    PRIMARY KEY (id),
    KEY idx_admin_logs_time (created_at),
    KEY idx_admin_logs_cat (category, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nhật ký quản trị — UC-34, chỉ đọc (BR-18).';

DELIMITER $$
CREATE TRIGGER trg_admin_audit_logs_no_update BEFORE UPDATE ON admin_audit_logs FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admin_audit_logs is read-only (BR-18)';
END$$
CREATE TRIGGER trg_admin_audit_logs_no_delete BEFORE DELETE ON admin_audit_logs FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'admin_audit_logs is read-only (BR-18)';
END$$
DELIMITER ;

-- 5 -------------------------------------------------------------------------
CREATE TABLE feedback (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id        CHAR(36)     NULL,
    category       ENUM('ai','bug','idea') NOT NULL,
    title          VARCHAR(150) NOT NULL,
    body           TEXT         NOT NULL,
    context        JSON         NULL,               -- ["Flashcard","Mạng máy tính","Chương 3","Thẻ 12 / 18"]
    quote_heading  VARCHAR(255) NULL,
    quote_text     TEXT         NULL,
    ref_type       ENUM('flashcard','quiz_question','summary_point','mindmap_node') NULL,
    ref_id         VARCHAR(36)  NULL,
    image_name     VARCHAR(255) NULL,
    image_path     VARCHAR(500) NULL,
    image_bytes    BIGINT UNSIGNED NULL,
    status         ENUM('new','doing','done') NOT NULL DEFAULT 'new',
    duplicate_of   INT UNSIGNED NULL,
    reply          TEXT         NULL,
    replied_at     DATETIME     NULL,
    replied_by     CHAR(36)     NULL,
    created_at     DATETIME     NOT NULL,           -- giờ địa phương
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_feedback_image_path (image_path),
    KEY idx_feedback_status (status, created_at),
    KEY idx_feedback_user (user_id, created_at),
    CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_feedback_dup  FOREIGN KEY (duplicate_of) REFERENCES feedback(id) ON DELETE SET NULL,
    CONSTRAINT chk_feedback_ref CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
    CONSTRAINT chk_feedback_image CHECK ((image_path IS NULL) = (image_bytes IS NULL))
) ENGINE=InnoDB AUTO_INCREMENT=200 DEFAULT CHARSET=utf8mb4 COMMENT='Góp ý của người học — UC-35, BR-19.';

-- 6 -------------------------------------------------------------------------
CREATE TABLE user_quota_state (
    user_id        CHAR(36)   NOT NULL,
    storage_level  TINYINT UNSIGNED NOT NULL DEFAULT 0,
    level_kind     ENUM('mb','file') NULL,
    notified_at    DATETIME   NULL,                  -- giờ địa phương
    PRIMARY KEY (user_id),
    CONSTRAINT fk_user_quota_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_user_quota_state_level CHECK (storage_level <= 3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Mức dung lượng đã nhắc gần nhất — UC-33.';

-- 7 -------------------------------------------------------------------------
ALTER TABLE pdf_documents
    ADD COLUMN content_sha256 CHAR(64) NULL AFTER mime_type,
    ADD COLUMN last_opened_at DATETIME NULL AFTER content_sha256,
    ADD COLUMN process_status ENUM('processing','ready','ocr_error','empty') NOT NULL DEFAULT 'processing' AFTER last_opened_at,
    ADD KEY idx_pdf_documents_sha (content_sha256);

ALTER TABLE chat_attachments
    ADD COLUMN content_sha256 CHAR(64) NULL AFTER mime_type,
    ADD KEY idx_chat_attachments_sha (content_sha256);

-- Dữ liệu cũ: PDF đã có chunk → ready; chưa có chunk → empty (UC-36 cho "Xử lý lại").
UPDATE pdf_documents p
SET p.process_status = IF(EXISTS (SELECT 1 FROM embedding_chunks c WHERE c.document_id = p.id), 'ready', 'empty');

-- 8 -------------------------------------------------------------------------
ALTER TABLE notifications
    MODIFY COLUMN kind ENUM('schedule','flashcard','practice','exam','share','share_request',
                            'quota','quota_ai','feedback','file_removed','account') NOT NULL DEFAULT 'schedule';
