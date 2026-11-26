-- =============================================================================
-- AI Studio Tri Thức — Tạo bộ câu hỏi (UC-21 Ôn tập / UC-22 Thi thử) (MySQL 8.0+)
-- =============================================================================
-- Phạm vi: CHỈ cấu trúc dữ liệu cho luồng "Tạo câu hỏi ôn tập" (UC-21, xem
-- .claude/rules/08-ai-studio.md) theo đúng thiết kế giao diện desktop-4-on-tap.html
-- (3 màn: Bước 1 chọn nguồn + thiết lập -> Làm bài -> Kết quả). Chưa có router/logic
-- gọi Gemini — file này chỉ là nơi lưu kết quả sinh câu hỏi và lịch sử làm bài.
--
-- 7 bảng:
--   quiz_sets              — 1 bộ câu hỏi (QUIZ_SET) + tham số người dùng đã chọn
--   quiz_set_sources       — các nguồn (Chương / Tệp PDF) được tick ở Bước 1
--   quiz_questions         — từng câu hỏi (QUESTION) + giải thích
--   quiz_question_options  — các phương án A/B/C/D của 1 câu, đánh dấu đáp án đúng
--   quiz_question_citations— đoạn nguồn trích dẫn của 1 câu (BR-09)
--   quiz_attempts          — mỗi lần làm bài ("Lần làm", "Điểm cao nhất")
--   quiz_attempt_answers   — lựa chọn của người học cho từng câu trong 1 lần làm
--
-- Quyết định thiết kế quan trọng:
--   - DÙNG CHUNG cho UC-21 và UC-22: đặc tả mô tả 2 UC là 2 biến thể (generalization) của
--     1 use case cha "Tạo bộ câu hỏi" (Phụ lục A mục 3.3) — nên chỉ có 1 bộ bảng, phân biệt
--     bằng `quiz_sets.mode` ('practice' | 'exam'). Thi thử chỉ thêm `time_limit_seconds`
--     (ép bằng CHECK) và độ khó rải đều theo TỪNG CÂU (vì vậy `quiz_sets.difficulty` được
--     NULL = "hỗn hợp", còn `quiz_questions.difficulty` luôn NOT NULL). "Thi thử không cho
--     làm lại cùng bộ" (UC-22) là quy tắc tầng ứng dụng, không ép ở DB.
--   - NHIỀU nguồn / 1 bộ (khác phạm vi chat UC-20 chỉ 1 mức): giao diện Bước 1 là danh sách
--     checkbox, tick bao nhiêu nguồn cũng được -> bảng nối `quiz_set_sources`. Nguồn là
--     Chương (`chapters`) hoặc Tệp PDF (`pdf_documents`) — 2 loại nội dung thật đang có
--     embedding (xem studio_rag_schema_v2.sql); bảng `notes` chưa dùng nên chưa có loại NOTE.
--   - `quiz_sets.subject_id` NOT NULL + ON DELETE CASCADE: UC-13 bước 4 ghi rõ xoá Môn học
--     phải xoá cascade "nội dung AI Studio liên quan (QUIZ_SET, ...)". Hệ quả: mọi nguồn của
--     1 bộ phải thuộc CÙNG 1 Môn học (tầng ứng dụng kiểm, giống BR-05) — khớp giao diện
--     ("Ôn tập · Mô hình OSI", các nguồn đều cùng 1 môn) và câu "Bộ câu hỏi đã được lưu
--     trong Notebook" (bộ câu hỏi hiện dưới đúng 1 Môn).
--   - Xoá 1 Chương/PDF nguồn KHÔNG xoá bộ câu hỏi (UC-15 chỉ cascade Bài ghi chú con): các FK
--     tới nguồn dùng SET NULL, và mọi thứ cần HIỂN THỊ LẠI đều được chụp lại (snapshot) lúc
--     sinh câu hỏi: `quiz_set_sources.source_label`, `quiz_question_citations.source_label`/
--     `quote`/`page_number`. Bài học từ chat_message_citations: bảng đó chỉ giữ
--     `embedding_chunk_id`, nên khi Chương được sửa -> re-embed -> chunk cũ bị xoá -> citation
--     còn dòng nhưng mất nội dung hiển thị. Bộ câu hỏi "lưu lại, làm lại nhiều lần" (UC-21
--     hậu điều kiện) nên KHÔNG được phụ thuộc chunk còn sống.
--   - MySQL cấm CHECK trên cột tham gia FK ON DELETE SET NULL (lỗi 3823, đã gặp ở
--     studio_chat_schema.sql) -> quy tắc "đúng 1 trong chapter_id/document_id khớp
--     source_type" chỉ kiểm ở tầng ứng dụng lúc INSERT; sau đó cả 2 có thể thành NULL khi
--     nguồn bị xoá — đó là trạng thái hợp lệ ("nguồn đã bị xoá").
--   - Phương án trả lời là BẢNG riêng (`quiz_question_options`, mỗi dòng 1 phương án +
--     `is_correct`) thay vì JSON: đáp án đúng truy vấn/kiểm được, và UC-35 (admin sửa đáp
--     án câu bị gắn cờ) sửa được từng phương án. Ràng buộc "Một đáp án đúng -> đúng 1
--     is_correct; Nhiều đáp án -> >= 2" không diễn đạt được bằng CHECK trên nhiều dòng ->
--     tầng ứng dụng kiểm khi lưu kết quả của LLM (UC-21 E1: câu không hợp lệ bị lọc, sinh bù).
--   - Lựa chọn của người học lưu dạng JSON mảng `position` (0=A, 1=B...) trong
--     `quiz_attempt_answers.selected_positions` — 1 câu có thể chọn nhiều phương án, và dữ
--     liệu này chỉ đọc lại nguyên cụm để vẽ màn "Xem lại từng câu", không cần JOIN theo từng
--     phương án. `is_correct` được chấm và LƯU SẴN lúc người học bấm chọn/"Kiểm tra" (không
--     tính lại lúc đọc) để kết quả lần làm cũ không đổi nếu admin sửa đáp án sau này (UC-35 E1).
--   - "Lần làm" / "Điểm cao nhất" / "Tiến độ ôn tập" (màn Kết quả + UC-21 bước 6 "cập nhật
--     PROGRESS") KHÔNG có bảng/cột tổng hợp riêng: tính từ `quiz_attempts` (COUNT, MAX
--     score_percent) — dữ liệu gốc duy nhất, không lo lệch số. Bảng PROGRESS/STAT_SNAPSHOT
--     của UC-29 sau này đọc từ đây.
--   - ID: `quiz_sets`/`quiz_questions`/`quiz_attempts` là UUID CHAR(36) (thực thể được tham
--     chiếu qua URL/API, và câu hỏi còn được UC-35 tham chiếu); các bảng con thuần dữ liệu
--     (options/sources/citations/answers) dùng BIGINT AUTO_INCREMENT — cùng quy ước với
--     chat_sessions (UUID) / chat_messages (BIGINT).
--   - Sở hữu (BR-05): chỉ `quiz_sets.user_id` và `quiz_attempts.user_id` giữ chủ sở hữu; bảng
--     con suy ra qua quiz_set. `quiz_attempts.user_id` là bản sao có chủ đích cho thống kê
--     UC-29 (lọc lần làm theo người học không cần JOIN qua quiz_sets).
--   - Chưa có cột cho UC-35 (gắn cờ/duyệt câu hỏi: flagged, verified) — sẽ ALTER thêm khi làm
--     nhóm Quản trị, không đoán trước ở đây.
--
-- Cách chạy (DB dev đã có dữ liệu, không cần xoá volume):
--   docker exec -i kltn-mysql mysql -uroot -pdevpassword ai_studio_tri_thuc < database/studio_tools_quiz_schema.sql
-- Nạp lần đầu qua `docker compose up -d` (volume rỗng): tên file CỐ Ý bắt đầu bằng
-- "studio_tools_" để xếp SAU "studio_rag_schema*.sql" theo bảng chữ cái — bảng
-- quiz_question_citations tham chiếu embedding_chunks (tạo ở studio_rag_schema.sql). Các công
-- cụ Studio khác (Flashcard/Tóm tắt/Mindmap) nên theo cùng tiền tố này.
-- =============================================================================

SET NAMES utf8mb4;

-- -----------------------------------------------------------------------------
-- 1. QUIZ_SETS — 1 bộ câu hỏi (UC-21 bước 2-4 / UC-22 bước 2-3)
-- -----------------------------------------------------------------------------
CREATE TABLE quiz_sets (
    id                  CHAR(36)      NOT NULL DEFAULT (UUID()),
    user_id             CHAR(36)      NOT NULL,
    subject_id          CHAR(36)      NOT NULL,   -- Môn học chứa bộ câu hỏi (xem đầu file)

    title               VARCHAR(200)  NOT NULL,   -- vd. "Mô hình OSI" -> header "Ôn tập · Mô hình OSI"
    mode                ENUM('practice','exam') NOT NULL DEFAULT 'practice',  -- UC-21 | UC-22

    -- Tham số người học chọn ở "2. Thiết lập bộ câu hỏi"
    requested_count     TINYINT UNSIGNED NOT NULL,               -- stepper, "Tối đa 30 câu"
    question_count      TINYINT UNSIGNED NOT NULL DEFAULT 0,     -- số câu THẬT đã sinh; < requested
                                                                  -- = UC-21 E2 (thông báo "giảm từ 10
                                                                  -- xuống 8 câu" ở màn làm bài)
    difficulty          ENUM('easy','medium','hard') NULL,       -- Dễ/Trung bình/Khó; NULL = hỗn hợp
                                                                  -- (thi thử rải đều, UC-22 bước 2)
    question_type       ENUM('single','multi') NOT NULL DEFAULT 'single',  -- "Một đáp án đúng" /
                                                                  -- "Nhiều đáp án đúng"
    time_limit_seconds  INT UNSIGNED  NULL,                      -- chỉ mode='exam'

    -- Vòng đời sinh câu hỏi: 'generating' khi đang gọi LLM (cho phép chuyển sang job nền sau
    -- này — backlog "async job"), 'ready' khi đã lưu đủ câu, 'failed' khi LLM lỗi/không đủ
    -- nội dung (error_message giải thích cho người học).
    status              ENUM('generating','ready','failed') NOT NULL DEFAULT 'generating',
    error_message       VARCHAR(500)  NULL,
    model_name          VARCHAR(100)  NULL,   -- model LLM đã sinh (không hard-code vendor, như chat_messages)

    created_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_quiz_sets_user_created (user_id, created_at),
    KEY idx_quiz_sets_subject (subject_id),

    CONSTRAINT fk_quiz_sets_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_quiz_sets_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,   -- UC-13 bước 4
    CONSTRAINT chk_quiz_sets_requested_count
        CHECK (requested_count BETWEEN 1 AND 30),
    CONSTRAINT chk_quiz_sets_question_count
        CHECK (question_count <= requested_count),
    CONSTRAINT chk_quiz_sets_mode_time_limit
        CHECK ((mode = 'practice' AND time_limit_seconds IS NULL)
            OR (mode = 'exam' AND time_limit_seconds IS NOT NULL AND time_limit_seconds > 0)),
    CONSTRAINT chk_quiz_sets_practice_difficulty
        CHECK (mode = 'exam' OR difficulty IS NOT NULL)   -- ôn tập luôn chọn 1 độ khó cụ thể
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Bộ câu hỏi AI sinh — UC-21 (practice) / UC-22 (exam).';

-- -----------------------------------------------------------------------------
-- 2. QUIZ_SET_SOURCES — nguồn nội dung đã tick ở "1. Chọn nguồn nội dung" (UC-19)
-- -----------------------------------------------------------------------------
CREATE TABLE quiz_set_sources (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quiz_set_id   CHAR(36)        NOT NULL,

    source_type   ENUM('CHAPTER','PDF') NOT NULL,   -- cùng tên giá trị với embedding_chunks.source_type
    chapter_id    CHAR(36)        NULL,             -- source_type='CHAPTER'
    document_id   CHAR(36)        NULL,             -- source_type='PDF'
    source_label  VARCHAR(255)    NOT NULL,         -- snapshot tên hiển thị lúc tạo — còn hiển
                                                    -- thị được khi nguồn đã bị xoá (FK -> NULL)

    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_set_sources_chapter (quiz_set_id, chapter_id),    -- không tick trùng 1 nguồn
    UNIQUE KEY uq_quiz_set_sources_document (quiz_set_id, document_id),  -- (NULL không bị coi là trùng)
    KEY idx_quiz_set_sources_chapter (chapter_id),
    KEY idx_quiz_set_sources_document (document_id),

    CONSTRAINT fk_quiz_set_sources_set
        FOREIGN KEY (quiz_set_id) REFERENCES quiz_sets(id) ON DELETE CASCADE,
    CONSTRAINT fk_quiz_set_sources_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_quiz_set_sources_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Nguồn (Chương/PDF) dùng để sinh 1 bộ câu hỏi — nhiều nguồn/bộ.';

-- -----------------------------------------------------------------------------
-- 3. QUIZ_QUESTIONS — từng câu hỏi (UC-21 bước 3-4)
-- -----------------------------------------------------------------------------
CREATE TABLE quiz_questions (
    id              CHAR(36)          NOT NULL DEFAULT (UUID()),
    quiz_set_id     CHAR(36)          NOT NULL,
    position        TINYINT UNSIGNED  NOT NULL,   -- thứ tự "Câu 1 / 8" (bắt đầu từ 1)

    question_type   ENUM('single','multi') NOT NULL,           -- nhãn "Một đáp án"/"Nhiều đáp án"
    difficulty      ENUM('easy','medium','hard') NOT NULL,     -- nhãn "· Trung bình" (thi thử: mỗi câu 1 mức)
    question_text   TEXT              NOT NULL,   -- câu hỏi đầy đủ ở màn làm bài
    short_text      VARCHAR(255)      NULL,       -- bản rút gọn cho danh sách "Xem lại từng câu";
                                                  -- NULL -> UI cắt question_text
    explanation     TEXT              NOT NULL,   -- khối "Giải thích" hiện sau khi trả lời

    created_at      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_questions_set_position (quiz_set_id, position),

    CONSTRAINT fk_quiz_questions_set
        FOREIGN KEY (quiz_set_id) REFERENCES quiz_sets(id) ON DELETE CASCADE,
    CONSTRAINT chk_quiz_questions_position
        CHECK (position >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Câu hỏi trắc nghiệm của 1 bộ câu hỏi.';

-- -----------------------------------------------------------------------------
-- 4. QUIZ_QUESTION_OPTIONS — phương án A/B/C/D
-- -----------------------------------------------------------------------------
CREATE TABLE quiz_question_options (
    id            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    question_id   CHAR(36)         NOT NULL,
    position      TINYINT UNSIGNED NOT NULL,   -- 0=A, 1=B, 2=C, 3=D (khớp selected_positions)
    content       TEXT             NOT NULL,
    is_correct    BOOLEAN          NOT NULL DEFAULT FALSE,

    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_question_options_position (question_id, position),

    CONSTRAINT fk_quiz_question_options_question
        FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE,
    CONSTRAINT chk_quiz_question_options_position
        CHECK (position < 6)   -- giao diện thiết kế 4 phương án; chừa tối đa 6 (A-F)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Phương án trả lời của 1 câu hỏi, đánh dấu đáp án đúng.';

-- -----------------------------------------------------------------------------
-- 5. QUIZ_QUESTION_CITATIONS — trích dẫn nguồn của câu hỏi (BR-09, UC-21 bước 4)
-- -----------------------------------------------------------------------------
-- Màn làm bài hiện: đoạn trích trong ngoặc kép + "Nguồn: <tên> · trang N". Mọi thứ cần
-- hiển thị đều là snapshot (xem đầu file); các FK chỉ để bấm-nhảy-tới-nguồn (như UC-20 5a)
-- khi nguồn còn tồn tại.
CREATE TABLE quiz_question_citations (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    question_id         CHAR(36)        NOT NULL,

    source_type         ENUM('CHAPTER','PDF') NOT NULL,
    chapter_id          CHAR(36)        NULL,
    document_id         CHAR(36)        NULL,
    embedding_chunk_id  CHAR(36)        NULL,   -- chunk đã đưa cho LLM; NULL sau khi re-embed

    source_label        VARCHAR(255)    NOT NULL,   -- snapshot, vd. "Chương 3 – Mô hình OSI.pdf"
    page_number         INT UNSIGNED    NULL,       -- chỉ PDF ("· trang 5")
    quote               TEXT            NOT NULL,   -- đoạn nguồn trích dẫn (snapshot)

    PRIMARY KEY (id),
    KEY idx_quiz_question_citations_question (question_id),
    KEY idx_quiz_question_citations_chapter (chapter_id),
    KEY idx_quiz_question_citations_document (document_id),
    KEY idx_quiz_question_citations_chunk (embedding_chunk_id),

    CONSTRAINT fk_quiz_question_citations_question
        FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE,
    CONSTRAINT fk_quiz_question_citations_chapter
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE SET NULL,
    CONSTRAINT fk_quiz_question_citations_document
        FOREIGN KEY (document_id) REFERENCES pdf_documents(id) ON DELETE SET NULL,
    CONSTRAINT fk_quiz_question_citations_chunk
        FOREIGN KEY (embedding_chunk_id) REFERENCES embedding_chunks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Đoạn nguồn trích dẫn của câu hỏi (BR-09), lưu snapshot.';

-- -----------------------------------------------------------------------------
-- 6. QUIZ_ATTEMPTS — mỗi lần làm bài (UC-21 bước 5-6; nút "Làm lại")
-- -----------------------------------------------------------------------------
CREATE TABLE quiz_attempts (
    id                CHAR(36)          NOT NULL DEFAULT (UUID()),
    quiz_set_id       CHAR(36)          NOT NULL,
    user_id           CHAR(36)          NOT NULL,   -- bản sao cho thống kê UC-29 (xem đầu file)
    attempt_no        SMALLINT UNSIGNED NOT NULL,   -- "Lần làm" thứ mấy của bộ này (1, 2, ...)

    started_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at       DATETIME          NULL,       -- NULL = đang làm dở (chưa bấm "Xem kết quả")
    duration_seconds  INT UNSIGNED      NULL,       -- "· 3 phút 12 giây" ở màn Kết quả

    total_questions   TINYINT UNSIGNED  NOT NULL,   -- snapshot question_count lúc bắt đầu
    correct_count     TINYINT UNSIGNED  NULL,       -- "6 / 8 câu đúng" (có khi finished)
    score_percent     TINYINT UNSIGNED  NULL,       -- 0-100; MAX(...) = "Điểm cao nhất"

    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_attempts_set_no (quiz_set_id, attempt_no),
    KEY idx_quiz_attempts_user_finished (user_id, finished_at),

    CONSTRAINT fk_quiz_attempts_set
        FOREIGN KEY (quiz_set_id) REFERENCES quiz_sets(id) ON DELETE CASCADE,
    CONSTRAINT fk_quiz_attempts_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_quiz_attempts_attempt_no
        CHECK (attempt_no >= 1),
    CONSTRAINT chk_quiz_attempts_score
        CHECK (score_percent IS NULL OR score_percent <= 100),
    CONSTRAINT chk_quiz_attempts_correct
        CHECK (correct_count IS NULL OR correct_count <= total_questions),
    -- Đã nộp thì phải có đủ kết quả; đang làm dở thì chưa có kết quả nào.
    CONSTRAINT chk_quiz_attempts_finished
        CHECK ((finished_at IS NULL AND correct_count IS NULL AND score_percent IS NULL)
            OR (finished_at IS NOT NULL AND correct_count IS NOT NULL AND score_percent IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Mỗi lần làm 1 bộ câu hỏi — nguồn cho "Lần làm", "Điểm cao nhất", UC-29.';

-- -----------------------------------------------------------------------------
-- 7. QUIZ_ATTEMPT_ANSWERS — lựa chọn cho từng câu trong 1 lần làm
-- -----------------------------------------------------------------------------
-- 1 dòng được ghi khi câu đó được "chốt": chế độ ôn tập = ngay khi chọn (1 đáp án) hoặc bấm
-- "Kiểm tra" (nhiều đáp án) — lúc đó đáp án + giải thích hiện ra, không đổi được nữa. Câu
-- không có dòng nào = chưa trả lời (tính là sai khi nộp, vd. thi thử hết giờ UC-22 E2).
CREATE TABLE quiz_attempt_answers (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    attempt_id          CHAR(36)        NOT NULL,
    question_id         CHAR(36)        NOT NULL,

    selected_positions  JSON            NOT NULL,   -- vd. [1] hoặc [0,1] (0=A)
    is_correct          BOOLEAN         NOT NULL,   -- chấm lúc chốt, lưu cố định (xem đầu file)
    answered_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_quiz_attempt_answers_question (attempt_id, question_id),
    KEY idx_quiz_attempt_answers_question (question_id),   -- UC-39 sau này: câu hay sai

    CONSTRAINT fk_quiz_attempt_answers_attempt
        FOREIGN KEY (attempt_id) REFERENCES quiz_attempts(id) ON DELETE CASCADE,
    CONSTRAINT fk_quiz_attempt_answers_question
        FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE,
    CONSTRAINT chk_quiz_attempt_answers_selected
        CHECK (JSON_TYPE(selected_positions) = 'ARRAY' AND JSON_LENGTH(selected_positions) >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Đáp án người học chọn cho từng câu trong 1 lần làm bài.';
