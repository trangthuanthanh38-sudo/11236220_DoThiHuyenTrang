-- =============================================================================
-- AI Studio Tri Thức — Flashcard (UC-23) v2: giao diện mới `flashcard mới.html` (MySQL 8.0+)
-- =============================================================================
-- ALTER trên studio_tools_flashcard_schema.sql (không xoá dữ liệu cũ):
--   1. flashcard_sets: 2 công tắc "Khi ôn" — Trộn thứ tự thẻ / Hiện nguồn ở mặt sau.
--      count_mode giữ nguyên cột; giao diện mới không còn "Hệ thống đề xuất" nên code mới luôn
--      ghi 'manual' (bộ cũ 'auto' vẫn đọc được).
--   2. flashcard_sessions: 1 dòng = 1 "Lần ôn" (cột Lần ôn / Lần gần nhất / Lịch sử ở tab Đã tạo,
--      "Lần ôn thứ N" ở màn Hoàn thành). Kết quả chỉ được ghi khi ôn XONG cả phiên (1 request) —
--      dừng giữa chừng thì không có dòng nào. Phiên "Ôn lại thẻ khó" (kind='hard') vẫn tính là 1
--      lần ôn. Số Dễ/Khó/Bỏ qua lưu cố định (thẻ "Bỏ qua" không có dòng flashcard_reviews và không
--      đổi lịch ôn của thẻ).
--   3. flashcard_reviews.session_id: lần chấm thuộc phiên nào (NULL = chấm lẻ qua API cũ
--      PUT /flashcards/cards/{id}/review, trước v2).
--
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_flashcard_schema_v2.sql
-- Nạp lần đầu qua `docker compose up -d`: tên file xếp ngay SAU studio_tools_flashcard_schema.sql.
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE flashcard_sets
    ADD COLUMN shuffle_cards  BOOLEAN NOT NULL DEFAULT TRUE AFTER card_types,
    ADD COLUMN show_citation  BOOLEAN NOT NULL DEFAULT TRUE AFTER shuffle_cards;

CREATE TABLE flashcard_sessions (
    id                 CHAR(36)          NOT NULL DEFAULT (UUID()),
    flashcard_set_id   CHAR(36)          NOT NULL,
    user_id            CHAR(36)          NOT NULL,
    session_no         SMALLINT UNSIGNED NOT NULL,   -- "Lần N" (bắt đầu từ 1, theo từng bộ)
    kind               ENUM('full','hard') NOT NULL DEFAULT 'full',  -- cả bộ / "Ôn lại thẻ khó"

    card_total         SMALLINT UNSIGNED NOT NULL,
    easy_count         SMALLINT UNSIGNED NOT NULL,
    hard_count         SMALLINT UNSIGNED NOT NULL,
    skip_count         SMALLINT UNSIGNED NOT NULL,
    duration_seconds   INT UNSIGNED      NOT NULL,
    finished_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_flashcard_sessions_set_no (flashcard_set_id, session_no),
    KEY idx_flashcard_sessions_set_finished (flashcard_set_id, finished_at),
    KEY idx_flashcard_sessions_user_finished (user_id, finished_at),

    CONSTRAINT fk_flashcard_sessions_set
        FOREIGN KEY (flashcard_set_id) REFERENCES flashcard_sets(id) ON DELETE CASCADE,
    CONSTRAINT fk_flashcard_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_flashcard_sessions_no
        CHECK (session_no >= 1),
    CONSTRAINT chk_flashcard_sessions_total
        CHECK (card_total >= 1 AND easy_count + hard_count + skip_count = card_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Mỗi lần ôn trọn 1 phiên flashcard — UC-23.';

ALTER TABLE flashcard_reviews
    ADD COLUMN session_id CHAR(36) NULL AFTER user_id,
    ADD KEY idx_flashcard_reviews_session (session_id),
    ADD CONSTRAINT fk_flashcard_reviews_session
        FOREIGN KEY (session_id) REFERENCES flashcard_sessions(id) ON DELETE CASCADE;
