-- =============================================================================
-- AI Studio Tri Thức — Thống kê hiệu suất (UC-29) + Nhận xét AI (UC-30) (MySQL 8.0+)
-- =============================================================================
-- Giao diện mẫu: thong-ke.html ở gốc repo (Tổng quan: Hôm nay / Hoạt động / Kết quả học tập / So sánh môn /
-- Nhận xét AI / Lịch sử tiến bộ + Notebook). Số liệu KHÔNG lưu sẵn ở bảng tổng hợp: backend
-- (services/stats.py) tính lại từ dữ liệu gốc mỗi lần xem — quiz_attempts, flashcard_sessions, các bảng nội
-- dung — cộng với 2 bảng mới dưới đây:
--
--   study_sessions  — PHIÊN HỌC: thời gian thật người học mở Chương/PDF hoặc dùng công cụ Studio. Trước đây app
--                     không đo thời gian học ở đâu cả, mà đây là chỉ số chính của mẫu (KPI, theo môn, heatmap).
--   stat_snapshots  — STAT_SNAPSHOT (UC-29 hậu điều kiện): số liệu 1 kỳ được CHỐT lại làm lịch sử tiến bộ, kèm
--                     nhận xét AI (UC-30) nếu có. Chỉ lưu khi (a) 1 tuần T2–CN đã kết thúc và đủ BR-12, hoặc (b)
--                     người học bấm "Phân tích ngay" — không lưu mỗi lần xem như mẫu (lịch sử sẽ rối).
--
-- Quyết định thiết kế:
--   - Giờ của study_sessions là GIỜ ĐỊA PHƯƠNG (settings.APP_TIMEZONE), backend ghi bằng local_now() — KHÔNG
--     dùng CURRENT_TIMESTAMP vì container MySQL chạy UTC. Các bảng cũ (quiz_attempts.finished_at,
--     flashcard_sessions.finished_at, *.created_at) lưu UTC theo giờ DB -> services/stats.py đổi UTC -> địa
--     phương trước khi gom theo ngày.
--   - active_seconds chỉ cộng khi tab đang hiện và người học có thao tác gần đây (frontend gửi nhịp 30 giây,
--     backend chặn mỗi nhịp tối đa ~2 phút) — không tính thời gian treo tab.
--   - Phạm vi (subject/chapter/document) FK SET NULL: xoá Môn/Chương/PDF không xoá thời gian đã học (vẫn tính
--     vào tổng, chỉ mất phân bổ theo môn).
--   - stat_snapshots.metrics là JSON (KPI, theo môn, năng lực) vì đây là bản CHỤP bất biến để so sánh về sau;
--     ai_result JSON {good[], bad[], act[]}. subject_id NULL = tất cả môn.
--
-- Cách chạy (DB dev đã có dữ liệu):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/stats_schema.sql
-- Nạp lần đầu qua `docker compose up -d`: tên "stats_" xếp sau "schedule_*" và trước "studio_*"; chỉ FK tới
-- users/subjects/chapters/pdf_documents (đã có từ auth_/knowledge_) nên thứ tự đó đủ.
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. STUDY_SESSIONS — phiên học (thời gian học thật)
-- -----------------------------------------------------------------------------
CREATE TABLE study_sessions (
    id              CHAR(36)       NOT NULL DEFAULT (UUID()),
    user_id         CHAR(36)       NOT NULL,
    activity        ENUM('chapter','pdf','practice','exam','flashcard','mindmap','summary','chat') NOT NULL,
    subject_id      CHAR(36)       NULL,
    chapter_id      CHAR(36)       NULL,
    document_id     CHAR(36)       NULL,

    started_at      DATETIME       NOT NULL,          -- giờ địa phương
    last_beat_at    DATETIME       NOT NULL,          -- nhịp gần nhất (giờ địa phương)
    ended_at        DATETIME       NULL,              -- NULL = đang mở (hoặc tab bị đóng đột ngột)
    active_seconds  INT UNSIGNED   NOT NULL DEFAULT 0,

    PRIMARY KEY (id),
    KEY idx_study_sessions_user (user_id, started_at),
    KEY idx_study_sessions_subject (user_id, subject_id, started_at),
    CONSTRAINT fk_study_sessions_user     FOREIGN KEY (user_id)     REFERENCES users(id)         ON DELETE CASCADE,
    CONSTRAINT fk_study_sessions_subject  FOREIGN KEY (subject_id)  REFERENCES subjects(id)      ON DELETE SET NULL,
    CONSTRAINT fk_study_sessions_chapter  FOREIGN KEY (chapter_id)  REFERENCES chapters(id)      ON DELETE SET NULL,
    CONSTRAINT fk_study_sessions_document FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL,
    CONSTRAINT chk_study_sessions_beat CHECK (last_beat_at >= started_at),
    CONSTRAINT chk_study_sessions_end  CHECK (ended_at IS NULL OR ended_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Phiên học — thời gian học thật cho UC-29 (giờ địa phương).';

-- -----------------------------------------------------------------------------
-- 2. STAT_SNAPSHOTS — số liệu 1 kỳ đã chốt + nhận xét AI
-- -----------------------------------------------------------------------------
CREATE TABLE stat_snapshots (
    id            CHAR(36)      NOT NULL DEFAULT (UUID()),
    user_id       CHAR(36)      NOT NULL,
    subject_id    CHAR(36)      NULL,                 -- NULL = tất cả môn
    period_from   DATE          NOT NULL,
    period_to     DATE          NOT NULL,
    kind          ENUM('weekly','ai') NOT NULL,       -- tự chốt cuối tuần / lưu khi bấm "Phân tích ngay"

    metrics       JSON          NOT NULL,             -- KPI, theo môn, điểm năng lực của kỳ (bất biến)
    ai_result     JSON          NULL,                 -- {good[], bad[], act[{subject_id, sessions, minutes, text}]} hoặc {few:true,...}
    ai_saved      BOOLEAN       NOT NULL DEFAULT FALSE,   -- người học đã bấm "Lưu nhận xét"
    model_name    VARCHAR(100)  NULL,                 -- khác NULL = có 1 lượt gọi AI thật (BR-08)
    ai_at         DATETIME      NULL,                 -- giờ địa phương lúc tạo nhận xét

    created_at    DATETIME      NOT NULL,             -- giờ địa phương lúc chốt
    updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    -- Không có UNIQUE (user, môn, kỳ, kind): subject_id NULL không bị UNIQUE chặn trùng, còn cột sinh
    -- COALESCE(subject_id,'') thì MySQL cấm vì subject_id có FK CASCADE (lỗi 1215) -> tầng ứng dụng tự kiểm
    -- (services/stats.py khoá dòng users FOR UPDATE trước khi chốt snapshot).
    KEY idx_stat_snapshots_user (user_id, period_to),
    KEY idx_stat_snapshots_period (user_id, period_from, period_to, kind),
    CONSTRAINT fk_stat_snapshots_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
    CONSTRAINT fk_stat_snapshots_subject FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    CONSTRAINT chk_stat_snapshots_period CHECK (period_to >= period_from),
    CONSTRAINT chk_stat_snapshots_saved  CHECK (ai_saved = FALSE OR ai_result IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='STAT_SNAPSHOT — UC-29/30. Số liệu kỳ đã chốt + nhận xét AI.';
