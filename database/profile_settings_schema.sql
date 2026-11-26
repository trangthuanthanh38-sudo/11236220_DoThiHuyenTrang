-- =============================================================================
-- AI Studio Tri Thức — Profile & Settings Schema (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: nhóm UC-06 → UC-09 (Hồ sơ & Cài đặt cá nhân) trong
-- .claude/rules/05-profile-settings.md. File này CHỈ bổ sung thêm vào schema
-- đã có ở database/auth_schema.sql (bảng `users`, `phone_verification_tokens`,
-- `refresh_tokens`...) — không định nghĩa lại các bảng đó.
--
-- Ánh xạ UC → dữ liệu:
--   - UC-06 (Cập nhật thông tin cá nhân): tên hiển thị + ảnh đại diện đã có sẵn
--     ở users.display_name / users.avatar_url (auth_schema.sql); trường/lớp là
--     dữ liệu MỚI, không thuộc nhận dạng tài khoản → đặt trong user_settings
--     (đúng với glossary CLAUDE.md: USER_SETTINGS tách khỏi USER).
--   - UC-07 (Đổi Email/SĐT): theo quyết định BR-02 hiện hành (bỏ Email thủ
--     công), UC này chỉ còn nhánh đổi SĐT — TÁI SỬ DỤNG
--     phone_verification_tokens(purpose='change_phone', new_phone_number) đã
--     có ở auth_schema.sql, không cần bảng mới cho luồng xác thực. Bước 5
--     ("gửi thông báo tới địa chỉ liên hệ cũ để cảnh báo bảo mật") được ghi
--     nhận vào account_security_logs bên dưới.
--   - UC-08 (Đổi mật khẩu): tái sử dụng users.password_hash +
--     refresh_tokens.revoked_at (auth_schema.sql) để "thu hồi các refresh
--     token khác, giữ phiên hiện tại". Bước 5 (thông báo đổi mật khẩu) cũng
--     ghi vào account_security_logs.
--   - UC-09 (Đổi giao diện sáng-tối): user_settings.theme.
--
-- USER_SETTINGS được tạo LẦN ĐẦU ở đây với đúng 3 cột nhóm UC-06→09 cần dùng
-- ngay (school_name, class_name, theme). Các nhóm UC sau (Onboarding UC-10/11,
-- ...) sẽ ALTER TABLE bổ sung cột riêng của mình (vd. onboarding_completed)
-- trong file schema của nhóm đó, không lặp lại CREATE TABLE ở đây.
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy (đã có dữ liệu cũ, không nạp lại từ đầu qua Docker):
--   mysql -u root -p ai_studio_tri_thuc < database/profile_settings_schema.sql
-- (Nếu chạy lần đầu qua `docker compose up -d` với volume rỗng, file này được
-- tự nạp theo thứ tự bảng chữ cái ngay sau auth_schema.sql.)
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 1. USER_SETTINGS — cài đặt & hồ sơ mở rộng theo từng người dùng (UC-06, UC-09)
-- -----------------------------------------------------------------------------
-- Quan hệ 1-1 với users: mỗi USER có đúng 1 dòng, tạo cùng lúc đăng ký
-- (UC-02 bước 4: "khởi tạo PROGRESS + USER_SETTINGS mặc định") — ở tầng ứng
-- dụng khi implement UC-02 cần INSERT kèm dòng user_settings mặc định.
CREATE TABLE user_settings (
    user_id       CHAR(36)     NOT NULL,

    -- UC-06: "trường/lớp" — không phải định danh tài khoản nên không đặt ở
    -- bảng users; tên hiển thị & ảnh đại diện vẫn ở users.display_name /
    -- users.avatar_url (đã có từ auth_schema.sql, không lặp lại ở đây).
    school_name   VARCHAR(150) NULL,
    class_name    VARCHAR(100) NULL,

    -- UC-09: đồng bộ đa thiết bị qua server; 'system' = theo hệ điều hành.
    theme         ENUM('light','dark','system') NOT NULL DEFAULT 'system',

    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id),
    CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Hồ sơ mở rộng & tuỳ chọn hiển thị — UC-06, UC-09. Mở rộng thêm cột ở các nhóm UC sau (không tạo lại bảng).';

-- -----------------------------------------------------------------------------
-- 2. ACCOUNT_SECURITY_LOGS — nhật ký thay đổi nhạy cảm tài khoản (UC-07, UC-08)
-- -----------------------------------------------------------------------------
-- Ghi lại đúng bước "gửi thông báo cảnh báo bảo mật" ở UC-07 bước 5 và UC-08
-- bước 5, theo cùng phong cách audit-log đã dùng ở login_audit_logs
-- (auth_schema.sql) — phục vụ tra soát khi người dùng khiếu nại bị đổi thông
-- tin mà không phải do chính họ thực hiện.
CREATE TABLE account_security_logs (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id           CHAR(36)     NOT NULL,

    event_type        ENUM('phone_changed','password_changed') NOT NULL,
    old_phone_number  VARCHAR(20)  NULL,   -- chỉ set khi event_type='phone_changed' (UC-07)

    ip_address        VARCHAR(45)  NULL,
    user_agent        VARCHAR(255) NULL,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_security_logs_user (user_id, created_at),
    CONSTRAINT fk_security_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

    -- Đúng bộ trường theo từng loại sự kiện (cùng phong cách CHECK ở bảng users).
    CONSTRAINT chk_security_logs_fields CHECK (
        (event_type = 'phone_changed'    AND old_phone_number IS NOT NULL)
        OR
        (event_type = 'password_changed' AND old_phone_number IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nhật ký đổi SĐT/mật khẩu — UC-07 bước 5, UC-08 bước 5.';
