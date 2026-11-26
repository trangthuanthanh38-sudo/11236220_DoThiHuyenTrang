-- =============================================================================
-- AI Studio Tri Thức — CHIA SẺ Môn học / Chương (giống Word / OneNote) (MySQL 8.0+)
-- =============================================================================
-- Người dùng chốt:
--   * Chia sẻ ở 2 cấp: CẢ MÔN (như sổ tay OneNote — mọi Chương + tệp PDF trong Môn, kể cả mục thêm sau) hoặc
--     TỪNG CHƯƠNG (như 1 tài liệu Word). Tệp PDF không chia sẻ riêng — đi theo Môn.
--   * Quyền: 'viewer' (Có thể xem) | 'editor' (Có thể chỉnh sửa). Chủ sở hữu = subjects.owner_id (không lưu ở đây).
--     Có cả quyền Môn lẫn quyền Chương thì lấy quyền CAO hơn.
--   * Mời theo SĐT / Gmail (tài khoản có sẵn trong hệ thống) + liên kết chia sẻ ("Ai có liên kết" / "Chỉ người
--     có quyền truy cập").
--   * AI Studio KHÔNG chạy trên nội dung được chia sẻ (BR-05 giữ nguyên với mọi API AI) — muốn dùng thì "Tạo bản sao".
--
-- Ghi chú thiết kế:
--   - Đích chia sẻ lưu 2 cách: `target_type` + `target_id` (để UNIQUE — cột sinh COALESCE trên cột FK CASCADE bị
--     MySQL cấm, lỗi 1215) VÀ FK thật `subject_id` / `chapter_id` CASCADE (xoá Môn/Chương thì quyền tự mất).
--     "Đúng 1 trong 2 cột FK khớp target_type" kiểm ở tầng ứng dụng (CHECK trên cột FK có referential action bị
--     cấm — lỗi 3823), cùng quy ước các bảng khác.
--   - shares.via = 'link' khi người nhận tự vào bằng liên kết "Ai có liên kết" (hiện ở mục "Đã chia sẻ với tôi"
--     như Word / OneNote); 'invite' = được mời đích danh.
--   - share_links: tối đa 1 liên kết / đích. "Tắt liên kết" = xoá dòng; bật lại sinh token MỚI nên link cũ chết.
--     Người CHƯA đăng nhập mở link "Ai có liên kết" chỉ được XEM (trang html/xem.html).
--   - chapters.content_version: khoá lạc quan khi nhiều người cùng sửa (CKEditor bản miễn phí không có đồng soạn
--     thảo thời gian thực): PUT nội dung gửi kèm base_version, lệch -> 409 trả bản mới nhất. content_updated_by /
--     content_updated_at = "Sửa lần cuối bởi …".
--   - chapter_presence: ai đang mở Chương (nhịp ~10 giây) -> avatar "Đang xem" cạnh nút Chia sẻ.
--   - notifications.kind thêm 'share' (được mời) / 'share_request' (có người yêu cầu quyền truy cập).
--
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/sharing_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: "sharing_" xếp SAU schedule_schema_v3.sql (notifications.kind) và
-- knowledge_content_schema.sql.
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE chapters
    ADD COLUMN content_version    INT UNSIGNED NOT NULL DEFAULT 0 AFTER ocr_text,
    ADD COLUMN content_updated_by CHAR(36)     NULL AFTER content_version,
    ADD COLUMN content_updated_at DATETIME     NULL AFTER content_updated_by,
    ADD CONSTRAINT fk_chapters_content_updated_by FOREIGN KEY (content_updated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE shares (
    id          CHAR(36)    NOT NULL,
    owner_id    CHAR(36)    NOT NULL,                       -- chủ sở hữu Môn (snapshot để tra nhanh)
    target_type ENUM('subject','chapter') NOT NULL,
    target_id   CHAR(36)    NOT NULL,                       -- = subject_id hoặc chapter_id
    subject_id  CHAR(36)    NULL,
    chapter_id  CHAR(36)    NULL,
    grantee_id  CHAR(36)    NOT NULL,
    role        ENUM('viewer','editor') NOT NULL,
    via         ENUM('invite','link')   NOT NULL DEFAULT 'invite',
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_shares_grantee_target (grantee_id, target_type, target_id),
    KEY idx_shares_target (target_type, target_id),
    KEY idx_shares_owner (owner_id),
    CONSTRAINT fk_shares_owner   FOREIGN KEY (owner_id)   REFERENCES users(id)    ON DELETE CASCADE,
    CONSTRAINT fk_shares_grantee FOREIGN KEY (grantee_id) REFERENCES users(id)    ON DELETE CASCADE,
    CONSTRAINT fk_shares_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_shares_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Quyền truy cập Môn/Chương được chia sẻ cho 1 tài khoản (xem / chỉnh sửa).';

CREATE TABLE share_links (
    id          CHAR(36)    NOT NULL,
    token       CHAR(32)    NOT NULL,
    owner_id    CHAR(36)    NOT NULL,
    target_type ENUM('subject','chapter') NOT NULL,
    target_id   CHAR(36)    NOT NULL,
    subject_id  CHAR(36)    NULL,
    chapter_id  CHAR(36)    NULL,
    audience    ENUM('anyone','invited') NOT NULL DEFAULT 'anyone',
    role        ENUM('viewer','editor')  NOT NULL DEFAULT 'viewer',  -- quyền người ĐÃ đăng nhập nhận khi mở link "anyone"
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_share_links_token (token),
    UNIQUE KEY uq_share_links_target (target_type, target_id),
    CONSTRAINT fk_share_links_owner   FOREIGN KEY (owner_id)   REFERENCES users(id)    ON DELETE CASCADE,
    CONSTRAINT fk_share_links_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_share_links_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Liên kết chia sẻ (Sao chép liên kết) — tối đa 1 / Môn hoặc Chương.';

CREATE TABLE chapter_presence (
    chapter_id CHAR(36) NOT NULL,
    user_id    CHAR(36) NOT NULL,
    last_seen  DATETIME NOT NULL,
    PRIMARY KEY (chapter_id, user_id),
    CONSTRAINT fk_presence_chapter FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    CONSTRAINT fk_presence_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Ai đang mở Chương (avatar "Đang xem" khi chia sẻ).';

ALTER TABLE notifications
    MODIFY COLUMN kind ENUM('schedule','flashcard','practice','exam','share','share_request') NOT NULL DEFAULT 'schedule';
