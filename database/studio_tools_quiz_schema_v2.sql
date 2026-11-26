-- =============================================================================
-- AI Studio Tri Thức — Bổ sung cho UC-22 Thi thử (MySQL 8.0+)
-- =============================================================================
-- Nối tiếp studio_tools_quiz_schema.sql. KHÔNG tạo bảng mới: 7 bảng quiz_* đã thiết kế dùng
-- chung cho UC-21/UC-22 (generalization "Tạo bộ câu hỏi", phân biệt bằng quiz_sets.mode) —
-- thi thử tái dùng nguyên quiz_sets / quiz_set_sources / quiz_questions /
-- quiz_question_options / quiz_question_citations / quiz_attempts / quiz_attempt_answers,
-- cùng users / subjects / chapters / pdf_documents / embedding_chunks cho nguồn + RAG.
-- File này chỉ ALTER những chỗ bản đầu (viết theo desktop-4-on-tap.html) chưa khớp giao diện
-- desktop-6-thi-thu.html và luồng UC-22:
--
--   1. quiz_sets.requested_count: thi thử cho 5-50 câu ("Tối đa 50 câu", stepper 5..50),
--      ôn tập giữ 1-30 -> CHECK theo từng mode.
--   2. quiz_sets: UNIQUE (id, mode) — đích của FK ghép từ quiz_attempts (mục 3).
--   3. quiz_attempts.mode: bản sao mode của bộ, KHOÁ bằng FK ghép (quiz_set_id, mode) ->
--      quiz_sets(id, mode) nên không thể lệch. Nhờ có mode ngay trên dòng attempt, quy tắc
--      "Mỗi đề chỉ làm một lần" (UC-22 hậu điều kiện) được ép Ở DB: CHECK (mode='practice'
--      OR attempt_no = 1) + UNIQUE (quiz_set_id, attempt_no) có sẵn => đề thi tối đa 1 lần làm.
--      Hệ quả cho backend: với đề thi, KHÔNG được "bỏ lần dở cũ, tạo lần mới" như ôn tập —
--      mở lại luôn là lần dở duy nhất (UC-22 E1 "tiếp tục trong thời gian còn lại").
--   4. quiz_attempts.deadline_at: hạn nộp = started_at + time_limit_seconds, chốt 1 lần lúc
--      bắt đầu. Server dùng nó để tính "Thời gian còn lại" khi F5/mất mạng rồi vào lại (E1),
--      từ chối lưu đáp án sau hạn, và tự nộp bài quá hạn (E2) — không tin đồng hồ phía client.
--      Chỉ đề thi có hạn (CHECK theo mode).
--   5. quiz_attempts.submit_reason: 'manual' (bấm "Nộp bài") | 'timeout' (hết giờ tự nộp) —
--      màn Kết quả hiện "Đã hết giờ. Hệ thống tự nộp ..." khi = 'timeout'. Ôn tập không có
--      'timeout'. Các lần ôn tập đã nộp trước file này được backfill 'manual'; router ôn tập
--      hiện tại chưa ghi cột này nên CHECK vẫn cho NULL sau khi nộp.
--   6. quiz_attempt_answers: thi thử KHÁC ôn tập — đáp án đổi được tới lúc nộp (không chốt
--      từng câu), bấm lại phương án đang chọn thì bỏ chọn, và "⚑ Đánh dấu để xem lại" được cả
--      câu chưa trả lời. Nên: thêm `is_flagged`, `updated_at`; nới CHECK cho phép
--      selected_positions = [] (câu chỉ đánh dấu / đã bỏ chọn = "Chưa làm"). `is_correct` vẫn
--      do SERVER chấm mỗi lần lưu ([] -> FALSE) nhưng KHÔNG trả về client tới khi nộp bài
--      (quy tắc "Đáp án chỉ hiện sau khi nộp bài" — tầng ứng dụng). Quy tắc "ôn tập chốt 1 lần,
--      phải chọn >= 1 phương án" vẫn do router ôn tập kiểm như trước.
--
-- Không cần thêm cột cho: thời gian làm bài (quiz_sets.time_limit_seconds, đã có CHECK theo
-- mode), độ khó rải đều (quiz_sets.difficulty = NULL + quiz_questions.difficulty từng câu —
-- bảng "Câu dễ / trung bình / khó" ở màn Kết quả tính bằng JOIN), "giảm từ 20 xuống 18 câu"
-- (requested_count vs question_count), đáp án + giải thích + "Nguồn: ... · trang N" (options /
-- explanation / citations snapshot), điểm/thời gian ("18 / 20", "12:34 / 30:00" — correct_count,
-- score_percent, duration_seconds). Thứ tự câu đã xáo được lưu thẳng vào quiz_questions.position
-- lúc sinh đề (đề thi chỉ làm 1 lần nên không cần thứ tự riêng theo từng lần làm).
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_quiz_schema_v2.sql
-- Nạp lần đầu qua `docker compose up -d`: "studio_tools_quiz_schema.sql" xếp TRƯỚC
-- "studio_tools_quiz_schema_v2.sql" theo bảng chữ cái ('.' < '_'), đúng thứ tự cần.
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1-2. QUIZ_SETS
-- -----------------------------------------------------------------------------
ALTER TABLE quiz_sets
    DROP CHECK chk_quiz_sets_requested_count;

ALTER TABLE quiz_sets
    ADD CONSTRAINT chk_quiz_sets_requested_count
        CHECK ((mode = 'practice' AND requested_count BETWEEN 1 AND 30)     -- UC-21, "Tối đa 30 câu"
            OR (mode = 'exam'     AND requested_count BETWEEN 5 AND 50)),   -- UC-22, "Tối đa 50 câu"
    ADD UNIQUE KEY uq_quiz_sets_id_mode (id, mode),   -- đích FK ghép từ quiz_attempts
    ADD KEY idx_quiz_sets_user_mode_created (user_id, mode, created_at);  -- danh sách đề thi/bộ ôn tập riêng

-- -----------------------------------------------------------------------------
-- 3-5. QUIZ_ATTEMPTS
-- -----------------------------------------------------------------------------
ALTER TABLE quiz_attempts
    ADD COLUMN mode ENUM('practice','exam') NOT NULL DEFAULT 'practice' AFTER user_id,
    ADD COLUMN deadline_at DATETIME NULL AFTER started_at,          -- chỉ exam: hạn nộp bài
    ADD COLUMN submit_reason ENUM('manual','timeout') NULL AFTER finished_at;

UPDATE quiz_attempts SET submit_reason = 'manual' WHERE finished_at IS NOT NULL;

ALTER TABLE quiz_attempts
    ADD KEY idx_quiz_attempts_set_mode (quiz_set_id, mode),
    ADD KEY idx_quiz_attempts_open_deadline (finished_at, deadline_at),   -- quét đề thi quá hạn để tự nộp
    ADD CONSTRAINT fk_quiz_attempts_set_mode
        FOREIGN KEY (quiz_set_id, mode) REFERENCES quiz_sets(id, mode) ON DELETE CASCADE,
    -- "Mỗi đề chỉ làm một lần" (UC-22) — cùng UNIQUE (quiz_set_id, attempt_no) có sẵn.
    ADD CONSTRAINT chk_quiz_attempts_exam_once
        CHECK (mode = 'practice' OR attempt_no = 1),
    ADD CONSTRAINT chk_quiz_attempts_deadline
        CHECK ((mode = 'practice' AND deadline_at IS NULL)
            OR (mode = 'exam' AND deadline_at IS NOT NULL AND deadline_at > started_at)),
    -- Chưa nộp thì chưa có lý do nộp; 'timeout' chỉ có ở đề thi. Cho phép NULL sau khi nộp để
    -- router ôn tập hiện tại (chưa ghi cột này) không bị gãy — backend thi thử phải ghi rõ.
    ADD CONSTRAINT chk_quiz_attempts_submit_reason
        CHECK ((finished_at IS NOT NULL OR submit_reason IS NULL)
            AND (mode = 'exam' OR submit_reason IS NULL OR submit_reason = 'manual'));

-- -----------------------------------------------------------------------------
-- 6. QUIZ_ATTEMPT_ANSWERS
-- -----------------------------------------------------------------------------
ALTER TABLE quiz_attempt_answers
    DROP CHECK chk_quiz_attempt_answers_selected;

ALTER TABLE quiz_attempt_answers
    ADD COLUMN is_flagged BOOLEAN NOT NULL DEFAULT FALSE AFTER is_correct,   -- "⚑ Đánh dấu để xem lại"
    ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP AFTER answered_at,                       -- lần sửa đáp án cuối (thi thử)
    ADD CONSTRAINT chk_quiz_attempt_answers_selected
        CHECK (JSON_TYPE(selected_positions) = 'ARRAY');   -- [] = chưa trả lời / đã bỏ chọn
