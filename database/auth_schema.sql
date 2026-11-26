-- =============================================================================
-- AI Studio Tri Thức — Auth & Access Schema (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: CHỈ nhóm UC-01 → UC-05 (Xác thực & Truy cập) trong
-- .claude/rules/04-auth-access.md. Các bảng của nhóm khác (PROGRESS,
-- USER_SETTINGS, SUBJECT...) CHƯA được tạo ở đây — sẽ bổ sung ở các phần sau.
--
-- Quyết định thiết kế quan trọng (khớp với thay đổi nghiệp vụ mới nhất):
--   - Bỏ hẳn Email làm định danh đăng nhập thủ công. Chỉ còn 2 phương thức:
--       1) "local"  : SĐT + mật khẩu, xác thực chủ quyền SĐT qua OTP (UC-03).
--       2) "google" : Google OAuth — coi như đã xác thực ngay (Google đã xác
--                      minh danh tính), không cần chạy UC-03.
--   - Một user chỉ thuộc đúng 1 auth_provider tại một thời điểm (ràng buộc
--     bằng CHECK constraint bên dưới). Việc "liên kết thêm phương thức còn
--     lại" (vd. tài khoản Google gắn thêm SĐT) thuộc UC-07 — không xử lý ở
--     schema auth lõi này.
--   - password_hash chỉ có giá trị với tài khoản "local" → UC-04 (Khôi phục
--     mật khẩu) chỉ áp dụng cho nhóm này (E4 trong UC-04).
--
-- Yêu cầu: MySQL 8.0.16+ (CHECK constraint được enforce) hoặc MariaDB 10.2+.
-- Cách chạy:
--   mysql -u root -p -e "CREATE DATABASE ai_studio_tri_thuc CHARACTER SET utf8mb4"
--   mysql -u root -p ai_studio_tri_thuc < database/auth_schema.sql
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 1. USERS — tài khoản gốc (UC-01, UC-02)
-- -----------------------------------------------------------------------------
-- Mỗi dòng là một tài khoản, tạo bằng đúng 1 trong 2 phương thức:
--   auth_provider = 'local'  → bắt buộc có phone_number + password_hash.
--   auth_provider = 'google' → bắt buộc có google_sub; password_hash luôn NULL.
CREATE TABLE users (
    id                    CHAR(36)        NOT NULL DEFAULT (UUID()),

    -- Định danh (BR-02: SĐT hoặc google_sub là duy nhất trong hệ thống)
    phone_number          VARCHAR(20)     NULL,       -- E.164, vd. +84901234567; NULL nếu auth_provider='google'
    google_sub            VARCHAR(255)    NULL,       -- "sub" claim từ Google ID token; NULL nếu auth_provider='local'
    google_email          VARCHAR(255)    NULL,       -- email Gmail hiển thị/liên hệ (KHÔNG dùng để đăng nhập/định danh)

    auth_provider         ENUM('local','google') NOT NULL,
    password_hash         VARCHAR(255)    NULL,       -- bcrypt hash; NULL nếu auth_provider='google'

    display_name          VARCHAR(100)    NOT NULL,
    avatar_url            VARCHAR(500)    NULL,

    role                  ENUM('learner','admin') NOT NULL DEFAULT 'learner',  -- BR-13

    -- Trạng thái xác thực & khoá tài khoản
    status                ENUM('pending_verification','active','locked') NOT NULL DEFAULT 'pending_verification',
    phone_verified_at     DATETIME        NULL,       -- set khi UC-03 hoàn tất; tài khoản 'google' set = created_at ngay lúc tạo

    -- Chống dò mật khẩu (UC-01, E4: sai quá 5 lần/15 phút → khoá tạm 15 phút)
    failed_login_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until          DATETIME        NULL,

    created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_users_phone_number (phone_number),
    UNIQUE KEY uq_users_google_sub (google_sub),

    -- Ràng buộc: đúng bộ trường bắt buộc theo từng auth_provider (BR-02)
    CONSTRAINT chk_users_provider_fields CHECK (
        (auth_provider = 'local'  AND phone_number IS NOT NULL AND password_hash IS NOT NULL AND google_sub IS NULL)
        OR
        (auth_provider = 'google' AND google_sub IS NOT NULL AND password_hash IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Tài khoản người dùng — UC-01, UC-02. Nguồn của BR-02, BR-04, BR-13.';

-- -----------------------------------------------------------------------------
-- 2. PHONE_VERIFICATION_TOKENS — OTP xác thực SĐT (UC-03)
-- -----------------------------------------------------------------------------
-- Chỉ phát sinh cho tài khoản auth_provider='local'. Không dùng cho 'google'.
CREATE TABLE phone_verification_tokens (
    id                CHAR(36)      NOT NULL DEFAULT (UUID()),
    user_id           CHAR(36)      NOT NULL,

    purpose           ENUM('register','change_phone') NOT NULL DEFAULT 'register',  -- 'change_phone' dùng lại bởi UC-07
    new_phone_number  VARCHAR(20)   NULL,     -- SĐT mới đang chờ xác nhận, chỉ set khi purpose='change_phone'

    otp_code          CHAR(6)       NOT NULL,
    expires_at        DATETIME      NOT NULL, -- created_at + 15 phút

    attempt_count     TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- E2: sai quá 5 lần → khoá thao tác 10 phút
    locked_until      DATETIME      NULL,

    consumed_at       DATETIME      NULL,     -- set khi xác thực thành công (token dùng 1 lần)
    created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_phone_tokens_user_purpose (user_id, purpose, created_at),
    CONSTRAINT fk_phone_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='OTP xác thực SĐT — UC-03. Đếm số dòng trong 1 giờ gần nhất theo (user_id, purpose) để áp E1: tối đa 3 lần gửi lại/giờ.';

-- -----------------------------------------------------------------------------
-- 3. PASSWORD_RESET_TOKENS — Khôi phục mật khẩu (UC-04)
-- -----------------------------------------------------------------------------
-- Chỉ phát sinh cho tài khoản auth_provider='local' (kiểm tra ở tầng ứng dụng
-- trước khi insert — xem UC-04 E4).
CREATE TABLE password_reset_tokens (
    id            CHAR(36)   NOT NULL DEFAULT (UUID()),
    user_id       CHAR(36)   NOT NULL,

    otp_code      CHAR(6)    NOT NULL,
    expires_at    DATETIME   NOT NULL,   -- created_at + 15 phút

    attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    consumed_at   DATETIME   NULL,       -- token dùng 1 lần

    created_at    DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_reset_tokens_user (user_id, created_at),
    CONSTRAINT fk_reset_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='OTP đặt lại mật khẩu — UC-04.';

-- -----------------------------------------------------------------------------
-- 4. REFRESH_TOKENS — Phiên đăng nhập (UC-01 phát hành, UC-05 thu hồi, BR-03)
-- -----------------------------------------------------------------------------
-- Access token (JWT, hạn 24h) KHÔNG lưu DB — chỉ ký & xác minh bằng secret.
-- Chỉ refresh token (hạn 30 ngày) cần lưu để có thể thu hồi (revoke).
CREATE TABLE refresh_tokens (
    id            CHAR(36)   NOT NULL DEFAULT (UUID()),
    user_id       CHAR(36)   NOT NULL,

    token_hash    CHAR(64)   NOT NULL,   -- SHA-256(refresh_token) — không lưu token thô
    device_info   VARCHAR(255) NULL,
    ip_address    VARCHAR(45)  NULL,

    issued_at     DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at    DATETIME   NOT NULL,   -- issued_at + 30 ngày (BR-03)
    revoked_at    DATETIME   NULL,       -- set khi UC-05 (đăng xuất) hoặc bị thu hồi hàng loạt (đổi mật khẩu, khoá tài khoản...)

    PRIMARY KEY (id),
    UNIQUE KEY uq_refresh_tokens_hash (token_hash),
    KEY idx_refresh_tokens_user (user_id, revoked_at),
    CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Phiên đăng nhập / refresh token — UC-01, UC-05, BR-03.';

-- -----------------------------------------------------------------------------
-- 5. LOGIN_AUDIT_LOGS — Nhật ký đăng nhập (UC-01 bước 5: "ghi log đăng nhập")
-- -----------------------------------------------------------------------------
-- Ghi cả lần thành công lẫn thất bại để phục vụ audit và đối chiếu khi có
-- khiếu nại tài khoản bị khoá (E4). user_id NULL khi SĐT nhập vào không tồn
-- tại trong hệ thống (không tiết lộ trường sai — E1).
CREATE TABLE login_audit_logs (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id       CHAR(36)     NULL,
    phone_attempt VARCHAR(20)  NULL,     -- SĐT được nhập, kể cả khi không khớp tài khoản nào
    auth_provider ENUM('local','google') NOT NULL,
    success       TINYINT(1)   NOT NULL,
    ip_address    VARCHAR(45)  NULL,
    user_agent    VARCHAR(255) NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_login_logs_user (user_id, created_at),
    CONSTRAINT fk_login_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nhật ký đăng nhập — UC-01 bước 5.';
