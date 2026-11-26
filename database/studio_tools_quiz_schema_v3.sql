-- =============================================================================
-- AI Studio Tri Thức — Bổ sung cho UC-21 Ôn tập theo giao diện on-tap-tao-moi.html (MySQL 8.0+)
-- =============================================================================
-- Nối tiếp studio_tools_quiz_schema.sql + _v2.sql. KHÔNG tạo bảng mới. Giao diện mới của màn
-- "Tạo câu hỏi ôn tập" có 2 thứ bản đầu (viết theo desktop-4-on-tap.html) chưa lưu được:
--
--   1. "Phân bổ độ khó" (Theo khuyến nghị 30/40/30 hoặc Tự điều chỉnh số câu Dễ/TB/Khó) thay cho
--      chọn đúng 1 mức. Bỏ CHECK chk_quiz_sets_practice_difficulty -> bộ ôn tập cũng được
--      quiz_sets.difficulty = NULL (= hỗn hợp, như thi thử); độ khó THẬT của từng câu vẫn ở
--      quiz_questions.difficulty (NOT NULL) — bảng "Câu dễ / trung bình / khó" ở màn Kết quả tính
--      từ đó. Bộ tạo theo 1 mức (API cũ) vẫn lưu difficulty như trước.
--   2. "Sau mỗi câu": Hiện đáp án đúng / Hiện giải thích / Hiện trích dẫn nguồn — lưu THEO BỘ để
--      mở lại/làm lại ở tab "Đã tạo" vẫn đúng tuỳ chọn lúc tạo. Mặc định TRUE (= hành vi cũ, và
--      các bộ đã có trước file này). Thi thử không đọc 3 cột này (đáp án chỉ hiện sau khi nộp).
--
-- Không cần cột cho: tên bộ (quiz_sets.title có sẵn — giờ do người học nhập), "Làm gần nhất" /
-- lịch sử từng lần làm (MAX/SELECT trên quiz_attempts), gợi ý số câu tối đa (tính từ độ dài chunk
-- đã embed của nguồn, không lưu).
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE quiz_sets
    DROP CHECK chk_quiz_sets_practice_difficulty;

ALTER TABLE quiz_sets
    ADD COLUMN show_answer      BOOLEAN NOT NULL DEFAULT TRUE AFTER question_type,  -- "Hiện đáp án đúng"
    ADD COLUMN show_explanation BOOLEAN NOT NULL DEFAULT TRUE AFTER show_answer,    -- "Hiện giải thích"
    ADD COLUMN show_citation    BOOLEAN NOT NULL DEFAULT TRUE AFTER show_explanation; -- "Hiện trích dẫn nguồn"
