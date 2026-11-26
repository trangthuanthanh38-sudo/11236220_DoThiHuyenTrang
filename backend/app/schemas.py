"""Pydantic schemas cho request/response của các endpoint UC-01 -> UC-05."""
import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# UC-02 — Đăng ký (nhánh SĐT)
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    phone_number: str = Field(..., examples=["0987654321"])
    password: str
    confirm_password: str
    display_name: str = Field(..., min_length=1, max_length=100)


class RegisterResponse(BaseModel):
    message: str
    user_id: str
    phone_number: str
    dev_otp: str | None = None  # chỉ có giá trị khi DEV_MODE=true


# ---------------------------------------------------------------------------
# UC-03 — Xác thực SĐT qua OTP
# ---------------------------------------------------------------------------
class VerifyOtpRequest(BaseModel):
    phone_number: str
    otp_code: str = Field(..., min_length=6, max_length=6)


class ResendOtpRequest(BaseModel):
    phone_number: str


class SimpleMessageResponse(BaseModel):
    message: str
    dev_otp: str | None = None


# ---------------------------------------------------------------------------
# UC-01 — Đăng nhập
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    phone_number: str
    password: str


class UserPublic(BaseModel):
    id: str
    phone_number: str | None
    display_name: str
    role: str
    status: str


class LoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserPublic


class GoogleLoginRequest(BaseModel):
    """UC-01/UC-02 3a: access token Google Identity Services (popup) — backend tự xác minh với Google."""

    access_token: str = Field(..., min_length=10, max_length=4096)


class GoogleLoginResponse(LoginResponse):
    is_new: bool = False   # True = vừa tạo tài khoản mới (nhánh Google của UC-02)


class GoogleConfigOut(BaseModel):
    enabled: bool
    client_id: str | None = None


class LogoutRequest(BaseModel):
    refresh_token: str


# ---------------------------------------------------------------------------
# UC-04 — Khôi phục mật khẩu
# ---------------------------------------------------------------------------
class ForgotPasswordRequest(BaseModel):
    phone_number: str


class ResetPasswordRequest(BaseModel):
    phone_number: str
    otp_code: str = Field(..., min_length=6, max_length=6)
    new_password: str
    confirm_password: str


# ---------------------------------------------------------------------------
# UC-06 -> UC-09 (Hồ sơ & Cài đặt cá nhân)
# ---------------------------------------------------------------------------
class ProfileResponse(BaseModel):
    id: str
    phone_number: str | None
    display_name: str
    avatar_url: str | None
    role: str
    status: str
    auth_provider: str
    school_name: str | None
    class_name: str | None
    theme: str
    # Email nhận nhắc lịch (UC-31): Google -> luôn là google_email (khoá ở Hồ sơ); SĐT -> notify_email tự nhập
    google_email: str | None = None
    google_name: str | None = None   # tên Google — Hồ sơ để trống ô tên thì dùng tên này
    notify_email: str | None = None
    effective_email: str | None = None


class UpdateProfileRequest(BaseModel):
    """UC-06. `avatar_url` là một đường dẫn (không upload file) — xem ghi chú
    thiết kế trong routers/profile.py. `display_name` rỗng chỉ hợp lệ với tài khoản
    Google (= quay về tên Google), tài khoản SĐT bị router chặn 400."""

    display_name: str = Field("", max_length=100)
    avatar_url: str | None = Field(None, max_length=500)
    school_name: str | None = Field(None, max_length=150)
    class_name: str | None = Field(None, max_length=100)
    notify_email: str | None = Field(None, max_length=255)   # chỉ áp dụng tài khoản SĐT (Google bị bỏ qua)

    @model_validator(mode="after")
    def _check_email(self):
        v = (self.notify_email or "").strip()
        if v and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
            raise ValueError("Email nhận thông báo không hợp lệ.")
        self.notify_email = v or None
        return self


class UpdateThemeRequest(BaseModel):
    theme: str = Field(..., pattern="^(light|dark|system)$")


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_password: str
    # Refresh token của phiên hiện tại -> KHÔNG thu hồi token này (UC-08 bước 4:
    # "thu hồi các refresh token khác, giữ phiên hiện tại"). Có thể để trống nếu
    # client không có refresh token nào đang lưu.
    current_refresh_token: str | None = None


class RequestPhoneChangeRequest(BaseModel):
    new_phone_number: str
    current_password: str


class ConfirmPhoneChangeRequest(BaseModel):
    otp_code: str = Field(..., min_length=6, max_length=6)


# ---------------------------------------------------------------------------
# UC-12 -> UC-18 (Quản lý Tri thức & Nội dung) + PDF upload (mở rộng UC-16)
# ---------------------------------------------------------------------------
class SubjectCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    description: str | None = Field(None, max_length=500)
    color: str | None = Field(None, max_length=20)
    icon: str | None = Field(None, max_length=50)


class SubjectUpdateRequest(BaseModel):
    """UC-13. Mọi trường đều optional — chỉ field được gửi lên mới bị ghi đè."""

    name: str | None = Field(None, min_length=1, max_length=150)
    description: str | None = Field(None, max_length=500)
    color: str | None = Field(None, max_length=20)
    icon: str | None = Field(None, max_length=50)


class ReorderRequest(BaseModel):
    """Kéo-thả sắp xếp lại Môn học (UC-12) hoặc Chương trong 1 Môn học (UC-15) — gửi
    nguyên danh sách id theo thứ tự mới, backend gán lại sort_order = vị trí trong mảng."""

    ordered_ids: list[str] = Field(..., min_length=1)


class ChapterCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)


class ChapterUpdateRequest(BaseModel):
    """UC-15 (đổi tên) và UC-16 (lưu nội dung soạn thảo) dùng chung 1 request — field nào
    không gửi lên (None) thì giữ nguyên giá trị cũ."""

    name: str | None = Field(None, min_length=1, max_length=150)
    content_json: str | None = None
    # Chia sẻ: version nội dung client đang sửa — lệch bản trên máy chủ (người khác vừa lưu) -> 409 kèm bản mới
    # nhất. Không gửi = ghi đè như trước (chế độ cũ / "Giữ bản của tôi").
    base_version: int | None = None


class ChapterListItemOut(BaseModel):
    id: str
    name: str
    sort_order: int
    shared: bool = False      # chủ sở hữu đã chia sẻ Chương này (mời người / bật liên kết)
    protected: bool = False   # Chương có mật khẩu (thẻ Review ▸ Password)


class ChapterDetailOut(ChapterListItemOut):
    content_json: str | None = None
    # Bản plain-text đã tách khỏi HTML (ghi ở update_chapter) — trả ra để tính năng đính
    # kèm Chương ở AI Chat (UC-19) lấy nội dung thật mà không phải tự strip HTML phía
    # frontend.
    content_text: str | None = None
    # Chia sẻ (database/sharing_schema.sql)
    content_version: int = 0
    role: str = "owner"                       # owner | editor | viewer — quyền của người đang xem
    updated_by_name: str | None = None        # "Sửa lần cuối bởi …" (None = chưa ai sửa / chính chủ chưa từng lưu)
    updated_seconds_ago: int | None = None
    drawing_json: dict | None = None          # thẻ Draw: nét vẽ / hình khối / nền trang (knowledge_content_schema_v2.sql)
    # Review ▸ Password: locked=True -> Chương có mật khẩu và request không kèm khoá mở hợp lệ: content_json /
    # content_text / drawing_json để None, client hiện màn "Chương đã khoá" (password_hint nếu có).
    locked: bool = False
    password_hint: str | None = None


class ChapterUnlockRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)


class ChapterUnlockOut(BaseModel):
    key: str                  # gửi lại trong header X-Chapter-Key khi đọc / ghi Chương này
    chapter: "ChapterDetailOut"


class ChapterPasswordRequest(BaseModel):
    """Đặt / đổi / gỡ mật khẩu Chương (chỉ chủ sở hữu). new_password=None = gỡ mật khẩu. Đã có mật khẩu thì
    bắt buộc current_password."""

    new_password: str | None = Field(None, min_length=4, max_length=200)
    current_password: str | None = Field(None, max_length=200)
    hint: str | None = Field(None, max_length=200)


class TranslateRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=6000)
    target: str = Field(..., min_length=2, max_length=10)     # mã ngôn ngữ đích: vi, en, ja, ...


class TranslateOut(BaseModel):
    translation: str
    detected: str | None = None   # tên ngôn ngữ gốc AI nhận ra (tiếng Việt / English ...)
    model_name: str | None = None


class ChapterDrawingRequest(BaseModel):
    """PUT /chapters/{id}/drawing — ghi đè cả lớp vẽ của Chương (None / {} = xoá hết)."""

    drawing: dict | None = None


class PdfDocumentOut(BaseModel):
    id: str
    subject_id: str
    original_name: str
    file_size_bytes: int
    page_count: int | None
    mime_type: str
    sort_order: int


class UpdatePdfPageCountRequest(BaseModel):
    """Frontend gọi sau khi PDF.js mở thành công tệp vừa tải lên, điền `page_count` mà
    backend chưa parse lúc upload (xem comment `pdf_documents.page_count` trong
    database/knowledge_content_schema.sql)."""

    page_count: int = Field(..., gt=0)


class PdfUpdateRequest(BaseModel):
    """Đổi tên (`original_name`) và/hoặc kéo-thả chuyển File PDF sang Môn học khác
    (`subject_id`) — cùng 1 request giống ChapterUpdateRequest, field nào không gửi lên
    (None) thì giữ nguyên."""

    name: str | None = Field(None, min_length=1, max_length=255)
    subject_id: str | None = None


class SubjectOut(BaseModel):
    id: str
    name: str
    description: str | None
    color: str | None
    icon: str | None
    sort_order: int
    chapters: list[ChapterListItemOut]
    pdfs: list[PdfDocumentOut]
    shared: bool = False      # chủ sở hữu đã chia sẻ cả Môn


class PdfAnnotationCreateRequest(BaseModel):
    page_number: int = Field(..., ge=1)
    annotation_type: str = Field(..., pattern="^(highlight|underline|strikeout|textbox|draw|shape|note)$")
    data: dict = Field(default_factory=dict)


class PdfAnnotationUpdateRequest(BaseModel):
    """Sửa 1 annotation đã có (kéo-thả di chuyển textbox, sửa lại nội dung...) — UPDATE tại
    chỗ, KHÔNG tạo dòng mới (xem comment `pdf_annotations` trong
    database/knowledge_content_schema.sql). Field nào không gửi lên (None) thì giữ nguyên."""

    page_number: int | None = Field(None, ge=1)
    data: dict | None = None


class PdfAnnotationOut(BaseModel):
    id: str
    document_id: str
    page_number: int
    annotation_type: str
    data: dict


# ---------------------------------------------------------------------------
# UC-19 — Đính kèm ngữ cảnh ở ô nhập AI Chat (Chương tham chiếu / tệp-ảnh tải lên)
# ---------------------------------------------------------------------------
class ChatChapterAttachRequest(BaseModel):
    """Đính kèm 1 Chương làm ngữ cảnh — chỉ cần id, nhãn/nội dung backend tự đọc từ DB
    (không tin nhãn do client gửi lên)."""

    chapter_id: str = Field(..., min_length=1, max_length=36)


class ChatAttachmentMarkSentRequest(BaseModel):
    """Bấm Gửi: đánh dấu cả cụm chip của tin nhắn đó là 'sent' trong 1 lượt gọi — id nào
    không thuộc user hiện tại thì bỏ qua im lặng (BR-05)."""

    ids: list[str] = Field(..., min_length=1)


class ChatAttachmentOut(BaseModel):
    id: str
    kind: str                       # 'chapter' | 'file'
    label: str
    status: str
    chapter_id: str | None = None
    subject_id: str | None = None   # để frontend định vị Chương trong cây Notebook
    original_name: str | None = None
    file_size_bytes: int | None = None
    mime_type: str | None = None
    # ~200 ký tự đầu của chapters.content_text — chỉ để hiện tooltip trên chip. Nội dung đầy
    # đủ gửi cho Gemini do chat.py `_build_attachment_context` tự đọc lại từ DB lúc gửi tin nhắn.
    preview: str | None = None


# ---------------------------------------------------------------------------
# AI Chat — phiên/tin nhắn lưu thật (Bước 1), câu trả lời của Gemini thật (Bước 2),
# RAG + trích dẫn (Bước 3-4), chọn phạm vi nội dung nguồn UC-19 (Bước 5). Xem
# database/studio_chat_schema.sql + studio_chat_schema_v2.sql, backend/app/routers/chat.py.
# ---------------------------------------------------------------------------
class ChatScopeRequest(BaseModel):
    """Bước 5 (UC-19) — phạm vi nội dung nguồn của 1 phiên chat. 3 mức loại trừ nhau:
    Môn (`subject_id`), Chương (`chapter_id`, có thể kèm `subject_id` của đúng Môn cha), Tệp
    PDF (`document_id`, KHÔNG kèm 2 field kia). Cả 3 đều None = "Toàn bộ tri thức"."""

    subject_id: str | None = Field(None, max_length=36)
    chapter_id: str | None = Field(None, max_length=36)
    document_id: str | None = Field(None, max_length=36)


class ChatScopeOut(BaseModel):
    """Phạm vi đã được backend kiểm tra (BR-05 sở hữu + BR-07 có nội dung đã embed), kèm tên
    hiển thị. Cả 3 id đều None = "Toàn bộ tri thức" — kể cả khi Môn/Chương/PDF từng được chọn
    đã bị xoá (FK SET NULL, phiên tự nới về toàn bộ, không lỗi)."""

    subject_id: str | None = None
    subject_name: str | None = None
    chapter_id: str | None = None
    chapter_name: str | None = None
    document_id: str | None = None
    document_name: str | None = None


class ChatSessionOut(BaseModel):
    id: str
    title: str
    scope: ChatScopeOut = Field(default_factory=ChatScopeOut)
    # Hạn mức Hỏi đáp theo cuộc hội thoại (quota.PER_SESSION): số câu trả lời AI thật đã dùng / tối đa của phiên này.
    qa_used: int = 0
    qa_limit: int = 0


class ChatCitationOut(BaseModel):
    """Trích dẫn thật (BR-09) — Bước 4 lộ trình RAG. `source_type`/`label`/`page` đọc từ
    `EmbeddingChunk` (chunk đã dùng để trả lời), `preview` là ~200 ký tự đầu nội dung chunk
    (hiện khi rê chuột lên nguồn). `subject_id`/`chapter_id`/`document_id` để frontend bấm vào
    trích dẫn là mở đúng Chương/PDF (+ cuộn tới `page`) — UC-20 luồng thay thế 5a.
    `total_pages` (chỉ có với source_type='PDF') là metadata `pdf_documents.page_count`,
    KHÔNG phải nội dung chunk — tách riêng field này để consumer khỏi phải tự parse `label`."""

    id: int
    source_type: str  # 'CHAPTER' | 'PDF'
    label: str
    page: int | None = None
    total_pages: int | None = None
    preview: str
    # Câu trong đoạn nguồn khớp nhất với câu trả lời (chat.py `_highlight_for`) — frontend tìm đúng câu này trong
    # Chương / trang PDF để cuộn tới và bôi vàng khi bấm nguồn.
    highlight: str | None = None
    subject_id: str | None = None
    chapter_id: str | None = None
    document_id: str | None = None


class ChatMessageOut(BaseModel):
    id: int
    role: str  # 'user' | 'assistant' | 'system'
    content: str
    citations: list[ChatCitationOut] = Field(default_factory=list)


class ChatSendMessageRequest(BaseModel):
    """`session_id=None` -> tạo phiên mới (tiêu đề tự sinh từ `content`, giống
    chatSessionTitle() phía frontend); có giá trị -> phải là phiên đã tồn tại
    và thuộc sở hữu người dùng hiện tại (BR-05).

    `attachment_ids`: id các `chat_attachments` đang gắn ở ô nhập lúc bấm Gửi (frontend
    lấy từ Dinhkem.takeChatAttachments()) — kind='chapter' đọc `content_text`, kind='file'
    trích văn bản PDF/ảnh/.txt (có OCR, xem chat.py `_build_attachment_context`); id
    lạ/không sở hữu bị lọc bỏ êm.

    `scope` (Bước 5, UC-19): CHỈ dùng khi `session_id=None` (tạo phiên mới) — phiên đã tồn
    tại dùng phạm vi đã lưu sẵn, đổi qua PUT /chat/sessions/{id}/scope."""

    session_id: str | None = None
    content: str = Field(..., min_length=1)
    attachment_ids: list[str] = Field(default_factory=list)
    scope: ChatScopeRequest = Field(default_factory=ChatScopeRequest)


class ChatSendMessageResponse(BaseModel):
    session: ChatSessionOut
    user_message: ChatMessageOut
    assistant_message: ChatMessageOut


class ChatSessionRenameRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# UC-21 Tạo bộ câu hỏi — Chế độ ôn tập (database/studio_tools_quiz_schema.sql,
# backend/app/routers/quiz.py, frontend/js/ghichu_ontap.js — khuôn dữ liệu ghi ở đầu file JS đó).
# ---------------------------------------------------------------------------
class QuizSourceIn(BaseModel):
    source_type: Literal["CHAPTER", "PDF"]
    id: str = Field(..., max_length=36)


class QuizSetCreateRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    sources: list[QuizSourceIn] = Field(..., min_length=1, max_length=50)
    requested_count: int = Field(..., ge=1, le=30)
    # Tên do người học nhập ("Tên bộ câu hỏi (bắt buộc)"); bỏ trống (client cũ) -> tự đặt theo nguồn.
    title: str | None = Field(None, max_length=200)
    # Phân bổ độ khó [dễ, trung bình, khó] (tổng = requested_count) -> bộ "hỗn hợp", difficulty=NULL.
    # Không gửi thì dùng `difficulty` (1 mức, như bản đầu).
    difficulty: Literal["easy", "medium", "hard"] | None = None
    difficulty_counts: list[int] | None = Field(None, min_length=3, max_length=3)
    question_type: Literal["single", "multi"]
    # "Sau mỗi câu" — lưu theo bộ (quiz_sets.show_*).
    show_answer: bool = True
    show_explanation: bool = True
    show_citation: bool = True

    @model_validator(mode="after")
    def _check_difficulty(self):
        if self.title is not None:
            self.title = self.title.strip() or None
        if self.difficulty_counts is not None:
            if any(n < 0 for n in self.difficulty_counts) or sum(self.difficulty_counts) != self.requested_count:
                raise ValueError("Tổng số câu dễ / trung bình / khó phải bằng số câu hỏi.")
        elif self.difficulty is None:
            raise ValueError("Cần chọn độ khó hoặc phân bổ độ khó.")
        return self


class QuizSourceStatsRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    sources: list[QuizSourceIn] = Field(..., min_length=1, max_length=50)
    # trần số câu: ôn tập 30, thi thử 50; flashcard 50 thẻ (~900 ký tự/thẻ)
    mode: Literal["practice", "exam", "flashcard", "mindmap", "summary"] = "practice"   # mindmap/summary: chỉ cần word_count


class QuizSourceStatsOut(BaseModel):
    """Độ dài nội dung ĐÃ embed của các nguồn đang chọn -> "n nguồn · x từ", gợi ý + tối đa số câu."""

    chunk_count: int
    char_count: int
    word_count: int
    max_questions: int    # 0 = nguồn chưa có nội dung sẵn sàng cho AI (BR-07)
    suggested_min: int


class QuizAttemptHistoryOut(BaseModel):
    """1 lần ĐÃ nộp — lịch sử mở ra khi bấm 1 dòng ở tab "Đã tạo"."""

    attempt_no: int
    correct_count: int
    total_questions: int
    score_percent: int
    duration_seconds: int
    finished_seconds_ago: int   # khoảng tương đối (DATETIME không kèm múi giờ)


class QuizOptionOut(BaseModel):
    position: int
    content: str
    is_correct: bool


class QuizCitationOut(BaseModel):
    source_type: str
    source_label: str
    page_number: int | None = None
    quote: str
    chapter_id: str | None = None
    document_id: str | None = None


class QuizQuestionOut(BaseModel):
    id: str
    position: int
    question_type: str
    difficulty: str
    question_text: str
    short_text: str | None = None
    explanation: str
    options: list[QuizOptionOut]
    citations: list[QuizCitationOut]


class QuizSetOut(BaseModel):
    id: str
    subject_id: str
    title: str
    mode: str
    status: str
    error_message: str | None = None
    requested_count: int
    question_count: int
    difficulty: str | None = None
    question_type: str
    show_answer: bool = True
    show_explanation: bool = True
    show_citation: bool = True
    model_name: str | None = None
    questions: list[QuizQuestionOut]
    # Thống kê lần làm (màn Kết quả: "Lần làm"/"Điểm cao nhất") + lần làm dở để "Làm tiếp".
    attempts: int = 0
    best_score: int | None = None
    open_attempt: "QuizAttemptOut | None" = None


class QuizAnswerRequest(BaseModel):
    selected_positions: list[int] = Field(..., min_length=1, max_length=6)


class QuizAnswerOut(BaseModel):
    question_id: str
    selected_positions: list[int]
    is_correct: bool


class QuizAttemptOut(BaseModel):
    id: str
    attempt_no: int
    total_questions: int
    answers: list[QuizAnswerOut]


class QuizFinishOut(BaseModel):
    attempt_id: str
    attempt_no: int
    total_questions: int
    correct_count: int
    score_percent: int
    duration_seconds: int
    attempts: int              # tổng số lần đã nộp của bộ này ("Lần làm")
    best_score: int            # điểm cao nhất trong các lần đã nộp ("Điểm cao nhất")


class QuizSetSummaryOut(BaseModel):
    """1 dòng ở tab "Đã tạo" của màn Ôn tập."""

    id: str
    subject_id: str
    subject_name: str
    title: str
    question_count: int
    difficulty: str | None = None
    question_type: str
    created_at: datetime
    attempts: int
    best_score: int | None = None
    has_open_attempt: bool
    last_attempt_seconds_ago: int | None = None   # "Làm gần nhất"; None = chưa nộp lần nào


# QuizSetOut tham chiếu QuizAttemptOut (khai báo phía sau) — giải forward reference.
QuizSetOut.model_rebuild()


# ---------------------------------------------------------------------------
# UC-22 Tạo đề thi thử (backend/app/routers/quiz.py, prefix /quiz/exams + /quiz/exam-attempts;
# frontend/js/ghichu_thithu.js — khuôn dữ liệu ghi ở đầu file JS đó). Trước khi nộp bài, KHÔNG
# response nào có đáp án đúng / giải thích / trích dẫn ("Đáp án chỉ hiện sau khi nộp bài").
# ---------------------------------------------------------------------------
class ExamCreateRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    sources: list[QuizSourceIn] = Field(..., min_length=1, max_length=50)
    requested_count: int = Field(..., ge=5, le=50)       # khớp CHECK chk_quiz_sets_requested_count (exam)
    time_limit_minutes: Literal[15, 30, 45, 60]
    # "Tên đề thi (bắt buộc)" ở giao diện; bỏ trống (client cũ) -> tự đặt theo nguồn.
    title: str | None = Field(None, max_length=200)
    # "Phân bổ độ khó" [dễ, trung bình, khó], tổng = requested_count; không gửi -> 30/40/30.
    difficulty_counts: list[int] | None = Field(None, min_length=3, max_length=3)

    @model_validator(mode="after")
    def _check(self):
        if self.title is not None:
            self.title = self.title.strip() or None
        if self.difficulty_counts is not None and (
            any(n < 0 for n in self.difficulty_counts) or sum(self.difficulty_counts) != self.requested_count
        ):
            raise ValueError("Tổng số câu dễ / trung bình / khó phải bằng số câu hỏi.")
        return self


class ExamOptionOut(BaseModel):
    position: int
    content: str


class ExamQuestionOut(BaseModel):
    id: str
    position: int
    difficulty: str
    question_text: str
    short_text: str | None = None
    options: list[ExamOptionOut]


class ExamAnswerStateOut(BaseModel):
    question_id: str
    selected_positions: list[int]
    is_flagged: bool


class ExamAttemptOut(BaseModel):
    id: str
    remaining_seconds: int
    finished: bool
    answers: list[ExamAnswerStateOut]


class ExamOut(BaseModel):
    id: str
    title: str
    subject_id: str
    requested_count: int
    question_count: int
    time_limit_seconds: int
    questions: list[ExamQuestionOut]
    attempt: ExamAttemptOut | None = None


class ExamAnswerRequest(BaseModel):
    selected_positions: list[int] = Field(..., max_length=1)   # [] = bỏ chọn; đề thi chỉ có câu 1 đáp án
    is_flagged: bool = False


class ExamSubmitRequest(BaseModel):
    reason: Literal["manual", "timeout"] = "manual"


class ExamSummaryOut(BaseModel):
    """1 dòng ở tab "Đã tạo" của màn Thi thử. status: new (chưa làm) | in_progress | done."""

    id: str
    subject_id: str
    subject_name: str
    title: str
    question_count: int
    time_limit_seconds: int
    created_at: datetime
    status: Literal["new", "in_progress", "done"]
    remaining_seconds: int | None = None      # chỉ in_progress
    correct_count: int | None = None          # chỉ done
    score_percent: int | None = None
    submit_reason: str | None = None
    duration_seconds: int | None = None       # chỉ done — thời gian đã dùng
    finished_seconds_ago: int | None = None   # chỉ done — "Ngày làm" (tương đối, DATETIME không kèm múi giờ)


class ExamResultQuestionOut(QuizQuestionOut):
    selected_positions: list[int]


class ExamResultOut(BaseModel):
    correct_count: int
    total_questions: int
    score_percent: int
    duration_seconds: int
    time_limit_seconds: int
    submit_reason: str
    questions: list[ExamResultQuestionOut]


# ---------------------------------------------------------------------------
# UC-23 Tạo Flashcard (database/studio_tools_flashcard_schema.sql, backend/app/routers/flashcards.py,
# frontend/js/ghichu_flashcard.js — khuôn dữ liệu ghi ở đầu file JS đó).
# ---------------------------------------------------------------------------
class FlashcardSetCreateRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    sources: list[QuizSourceIn] = Field(..., min_length=1, max_length=50)
    title: str = Field(..., max_length=200)
    requested_count: int = Field(..., ge=5, le=50)   # khớp CHECK chk_flashcard_sets_requested_count
    # "Loại thẻ" [thuật ngữ, câu hỏi], tổng = requested_count (Cả hai = chia đều, lẻ ưu tiên thuật ngữ).
    type_counts: list[int] = Field(..., min_length=2, max_length=2)
    # 2 công tắc "Khi ôn" — lưu theo bộ (flashcard_sets.shuffle_cards / show_citation).
    shuffle: bool = True
    show_citation: bool = True

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Cần nhập tên bộ thẻ.")
        if any(n < 0 for n in self.type_counts) or sum(self.type_counts) != self.requested_count:
            raise ValueError("Tổng số thẻ thuật ngữ / câu hỏi phải bằng số thẻ.")
        return self

    @property
    def card_types(self) -> list[str]:
        return [t for t, n in zip(("term", "qa"), self.type_counts) if n > 0]


class FlashcardCitationOut(BaseModel):
    source_type: str
    source_label: str
    page_number: int | None = None
    quote: str
    chapter_id: str | None = None
    document_id: str | None = None


class FlashcardIntervalsOut(BaseModel):
    """Khoảng ôn lại (giây) nếu chấm Khó / Dễ ngay bây giờ — nhãn trên 2 nút chấm."""
    hard: int
    easy: int


class FlashcardOut(BaseModel):
    id: str
    position: int
    card_type: str
    front: str
    back: str
    citation: FlashcardCitationOut
    due_at: datetime | None = None
    review_count: int
    last_rating: str | None = None        # easy | hard | None (chưa ôn)
    is_due: bool = False                  # đã ôn và tới hạn ôn lại (giờ DB) — nhắc ôn thẻ chỉ ôn các thẻ này
    next_intervals: FlashcardIntervalsOut


class FlashcardSetOut(BaseModel):
    id: str
    title: str
    subject_id: str
    count_mode: str
    requested_count: int
    card_count: int
    cards: list[FlashcardOut]
    streak_days: int
    shuffle: bool = True
    show_citation: bool = True
    session_count: int = 0   # số lần ôn đã xong -> phiên mới là "Lần ôn thứ session_count + 1"


class FlashcardSetSummaryOut(BaseModel):
    id: str
    title: str
    subject_id: str
    subject_name: str
    card_count: int
    due_count: int      # đã ôn và tới hạn ôn lại
    new_count: int      # chưa ôn lần nào
    # Khoảng TƯƠNG ĐỐI do server tính theo giờ DB (DATETIME không kèm múi giờ — client không tự so
    # mốc tuyệt đối để khỏi lệch giờ, cùng lý do Thi thử trả remaining_seconds).
    next_due_in_seconds: int | None = None   # thẻ đã ôn sớm đến hạn nhất (<= 0 = đã đến hạn)
    last_reviewed_days_ago: int | None = None  # 0 = hôm nay; None = chưa ôn lần nào
    created_at: datetime
    source_labels: list[str] = []            # dòng phụ dưới tên bộ ("Chương 3, Chương 4")
    session_count: int = 0                   # cột "Lần ôn"
    last_hard_count: int | None = None       # cột "Lần gần nhất": số thẻ khó của phiên gần nhất
    last_session_seconds_ago: int | None = None


class FlashcardReviewRequest(BaseModel):
    rating: Literal["easy", "hard"]


class FlashcardReviewOut(BaseModel):
    card_id: str
    due_at: datetime
    interval_seconds: int
    next_intervals: FlashcardIntervalsOut
    streak_days: int


class FlashcardSessionRatingIn(BaseModel):
    card_id: str = Field(..., max_length=36)
    rating: Literal["easy", "hard", "skip"]


class FlashcardSessionCreate(BaseModel):
    """Kết quả 1 phiên ôn TRỌN VẸN (gửi 1 lần lúc xong phiên)."""
    kind: Literal["full", "hard"] = "full"
    duration_seconds: int = Field(..., ge=0, le=86400)
    ratings: list[FlashcardSessionRatingIn] = Field(..., min_length=1, max_length=50)


class FlashcardSessionCardOut(BaseModel):
    card_id: str
    rating: str
    interval_seconds: int | None = None   # khoảng tới lần ôn sau (None = Bỏ qua, lịch không đổi)
    next_intervals: FlashcardIntervalsOut


class FlashcardSessionOut(BaseModel):
    id: str
    session_no: int
    kind: str
    card_total: int
    easy_count: int
    hard_count: int
    skip_count: int
    duration_seconds: int
    finished_seconds_ago: int = 0
    cards: list[FlashcardSessionCardOut] = []   # chỉ có ở phản hồi POST
    streak_days: int | None = None              # chỉ có ở phản hồi POST


# ---------------------------------------------------------------------------
# UC-25 Tạo sơ đồ tư duy — routers/mindmaps.py (khuôn ghi ở đầu frontend/js/ghichu_mindmap.js)
# ---------------------------------------------------------------------------
class MindmapCreateRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    sources: list[QuizSourceIn] = Field(..., min_length=1, max_length=50)
    title: str = Field(..., max_length=200)
    depth: int = Field(3, ge=2, le=4)                          # khớp CHECK chk_mindmaps_depth
    build_method: Literal["headings", "auto"] = "headings"
    layout: Literal["tree", "radial"] = "tree"
    show_citation: bool = True
    ask_qa: bool = True

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Cần nhập tên sơ đồ.")
        return self


class MindmapCitationOut(BaseModel):
    source_type: str
    chapter_id: str | None = None
    document_id: str | None = None
    source_label: str
    page_number: int | None = None
    quote: str | None = None


class MindmapNodeOut(BaseModel):
    id: int
    parent_id: int | None = None
    depth: int
    position: int
    label: str
    origin: str
    offset_x: float = 0
    offset_y: float = 0
    citation: MindmapCitationOut | None = None


class MindmapOut(BaseModel):
    id: str
    title: str
    subject_id: str
    depth: int
    build_method: str
    layout: str
    show_citation: bool
    ask_qa: bool
    is_flat: bool
    updated_seconds_ago: int = 0   # khoảng TƯƠNG ĐỐI theo giờ DB (DATETIME không kèm múi giờ)
    nodes: list[MindmapNodeOut]


class MindmapSummaryOut(BaseModel):
    id: str
    title: str
    subject_id: str
    subject_name: str
    source_labels: list[str] = []
    node_count: int
    max_depth: int                 # MAX(depth); giao diện hiện "Số cấp" = max_depth - 1 (phẳng = 1)
    is_flat: bool
    updated_seconds_ago: int = 0


class MindmapUpdateRequest(BaseModel):
    title: str = Field(..., max_length=200)

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Tên sơ đồ không được để trống.")
        return self


class MindmapNodeCreate(BaseModel):
    parent_id: int
    label: str = Field(..., min_length=1, max_length=500)


class MindmapNodeUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=500)
    offset_x: float | None = Field(None, ge=-100000, le=100000)
    offset_y: float | None = Field(None, ge=-100000, le=100000)

    @model_validator(mode="after")
    def _check(self):
        if self.label is not None:
            self.label = self.label.strip()
            if not self.label:
                raise ValueError("Nội dung node không được để trống.")
        if self.label is None and self.offset_x is None and self.offset_y is None:
            raise ValueError("Không có gì để cập nhật.")
        return self


class MindmapSavedOut(BaseModel):
    updated_seconds_ago: int = 0


class MindmapRestoreCitation(BaseModel):
    source_type: Literal["CHAPTER", "PDF"]
    chapter_id: str | None = Field(None, max_length=36)
    document_id: str | None = Field(None, max_length=36)
    source_label: str = Field(..., min_length=1, max_length=255)
    page_number: int | None = None
    quote: str | None = Field(None, max_length=5000)


class MindmapRestoreNode(BaseModel):
    """1 node (kèm cả nhánh con) cần dựng lại — snapshot client giữ lúc xoá/thêm."""
    label: str = Field(..., min_length=1, max_length=500)
    origin: Literal["ai", "user"] = "user"
    offset_x: float = Field(0, ge=-100000, le=100000)
    offset_y: float = Field(0, ge=-100000, le=100000)
    citation: MindmapRestoreCitation | None = None
    children: list["MindmapRestoreNode"] = Field(default_factory=list, max_length=200)


class MindmapRestoreRequest(BaseModel):
    """Ctrl+Z sau "Xóa node" / Ctrl+Y sau "Thêm node": dựng lại nhánh dưới `parent_id`, đứng ngay trước node anh
    em `before_id` (NULL = cuối)."""
    parent_id: int
    before_id: int | None = None
    node: MindmapRestoreNode


class MindmapRestoreOut(BaseModel):
    nodes: list[MindmapNodeOut]   # theo thứ tự duyệt TIỀN THỨ TỰ (node, rồi lần lượt từng nhánh con)
    updated_seconds_ago: int = 0


# ---------------------------------------------------------------------------
# UC-24 Tạo bản tóm tắt — routers/summaries.py (khuôn ghi ở đầu frontend/js/ghichu_tomtat.js)
# ---------------------------------------------------------------------------
class SummaryCreateRequest(BaseModel):
    subject_id: str = Field(..., max_length=36)
    source_type: Literal["CHAPTER", "PDF"]
    source_id: str = Field(..., max_length=36)   # ĐÚNG 1 nguồn
    title: str = Field(..., max_length=200)
    length: Literal["short", "medium", "long"] = "medium"
    format: Literal["bullet", "paragraph"] = "bullet"
    keep_definitions: bool = True
    keep_numbers: bool = True
    keep_examples: bool = False

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Cần nhập tên bản tóm tắt.")
        return self


class SummaryUpdateRequest(BaseModel):
    title: str = Field(..., max_length=200)

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Tên bản tóm tắt không được để trống.")
        return self


class SummaryPointOut(BaseModel):
    position: int
    content: str
    page_number: int | None = None
    quote: str


class SummarySectionOut(BaseModel):
    position: int
    heading: str
    kind: str
    points: list[SummaryPointOut]


class SummaryListItemOut(BaseModel):
    id: str
    title: str
    subject_id: str
    source_type: str
    chapter_id: str | None = None    # None = nguồn đã bị xoá (FK SET NULL) -> không "Tạo lại" được
    document_id: str | None = None
    source_label: str
    length: str
    format: str
    is_stale: bool = False           # nội dung gốc đã đổi sau lần tạo (so SHA-256)
    updated_seconds_ago: int = 0     # khoảng TƯƠNG ĐỐI theo giờ DB (DATETIME không kèm múi giờ)
    point_count: int | None = None   # chỉ GET /summaries (thẻ ở tab "Đã tạo"): số ý chính
    citation_count: int | None = None  # số đoạn nguồn khác nhau được trích


class SummaryOut(SummaryListItemOut):
    keep_definitions: bool
    keep_numbers: bool
    keep_examples: bool
    source_word_count: int | None = None
    sections: list[SummarySectionOut]


class SummarySavedOut(BaseModel):
    updated_seconds_ago: int = 0


# ---------------------------------------------------------------------------
# Lịch biểu — UC-26/27/28/31 (routers/schedule.py, database/schedule_schema.sql)
# ---------------------------------------------------------------------------
ScheduleItemType = Literal["event", "class", "deadline", "exam"]
ScheduleRemind = Literal["none", "m10", "m30", "h1", "d1"]
ScheduleRepeat = Literal["none", "weekly", "monthly", "yearly"]   # schedule_schema_v2.sql
_HEX_COLOR = r"^#[0-9a-fA-F]{6}$"
SCHEDULE_DAY_END = 23 * 60 + 59          # giờ cả ngày 00:00–23:59


class ScheduleItemIn(BaseModel):
    """Tạo (UC-26) / sửa sự kiện. Giờ = phút trong ngày theo giờ địa phương (480 = 08:00)."""

    title: str = Field(..., max_length=200)
    item_type: ScheduleItemType = "event"
    label: str | None = Field(None, max_length=80)     # tên nhãn; trống = "Không có nhãn"
    color: str = Field(..., pattern=_HEX_COLOR)
    subject_id: str | None = None                      # UC-26 1a (tuỳ chọn)
    chapter_id: str | None = None
    date: date
    start_minute: int = Field(..., ge=0, le=1439)
    end_minute: int = Field(..., ge=0, le=1440)       # 1440 -> 422 tiếng Việt ở validator (tối đa 23:59)
    repeat_rule: ScheduleRepeat = "none"               # lặp hằng tuần/tháng/năm; `date` = lần đầu
    repeat_until: date | None = None                   # ngày cuối còn xuất hiện; None = lặp mãi
    remind_before: ScheduleRemind = "m30"
    via_app: bool = True
    via_email: bool = False
    via_push: bool = False

    @model_validator(mode="after")
    def _check(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("Tên sự kiện không được để trống.")
        self.label = (self.label or "").strip() or None
        self.color = self.color.lower()
        if self.item_type == "deadline":
            self.end_minute = self.start_minute
        elif self.end_minute <= self.start_minute:   # UC-26 E1
            raise ValueError("Giờ kết thúc phải sau giờ bắt đầu.")
        if self.end_minute > SCHEDULE_DAY_END:
            raise ValueError("Lịch biểu chỉ nhận giờ trong khoảng 00:00–23:59.")
        if self.chapter_id and not self.subject_id:
            raise ValueError("Chọn Môn học trước khi chọn Chương.")
        if self.repeat_rule == "none":
            self.repeat_until = None
        elif self.repeat_until is not None and self.repeat_until < self.date:
            raise ValueError("Ngày kết thúc lặp lại phải từ ngày bắt đầu trở đi.")
        return self


class ScheduleItemOut(BaseModel):
    id: str
    title: str
    item_type: str
    label_id: str | None = None
    label: str | None = None
    color: str                     # màu hiển thị: màu nhãn nếu có nhãn, ngược lại màu riêng
    subject_id: str | None = None
    subject_name: str | None = None
    chapter_id: str | None = None
    chapter_name: str | None = None
    date: date
    start_minute: int
    end_minute: int
    repeat_rule: str = "none"
    repeat_until: date | None = None
    remind_before: str
    via_app: bool
    via_email: bool
    via_push: bool


class ScheduleConflictOut(BaseModel):
    id: str
    title: str
    start_minute: int
    end_minute: int


class ScheduleLabelOut(BaseModel):
    id: str
    name: str
    color: str
    is_hidden: bool
    item_count: int


class ScheduleItemSavedOut(BaseModel):
    item: ScheduleItemOut
    conflicts: list[ScheduleConflictOut] = []   # BR-11: vẫn lưu, chỉ cảnh báo
    labels: list[ScheduleLabelOut] = []         # màu nhãn có thể đổi theo -> client vẽ lại cột Nhãn


class ScheduleLabelUpdate(BaseModel):
    name: str | None = Field(None, max_length=80)
    color: str | None = Field(None, pattern=_HEX_COLOR)
    is_hidden: bool | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.name is not None:
            self.name = self.name.strip()
            if not self.name:
                raise ValueError("Tên nhãn không được để trống.")
        if self.color:
            self.color = self.color.lower()
        return self


class ScheduleLabelSavedOut(BaseModel):
    merged_into: str | None = None   # id nhãn đích khi đổi tên trùng nhãn khác (gộp)
    labels: list[ScheduleLabelOut]


class NotificationOut(BaseModel):
    id: int
    schedule_item_id: str | None = None   # None = sự kiện đã bị xoá
    kind: str = "schedule"                # schedule | flashcard | exam | practice | share | share_request
    ref_id: str | None = None             # bộ thẻ / bộ câu hỏi / đề (nhắc học); Môn / Chương được chia sẻ
    actor_id: str | None = None           # share_request: người xin quyền truy cập
    item_type: str | None = None          # các trường lịch chỉ có với kind='schedule'
    title: str
    detail: str | None = None
    item_date: date | None = None
    start_minute: int | None = None
    fire_at: datetime                     # giờ địa phương (không kèm múi giờ)
    is_read: bool


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    unread_count: int
    now: datetime                         # "bây giờ" theo APP_TIMEZONE để client ghi "Hôm nay, 07:30"
    effective_email: str | None = None    # email nhận nhắc (Google: Gmail; SĐT: email nhập ở Hồ sơ)
    email_enabled: bool = False           # máy chủ đã cấu hình SMTP chưa


# ---------------------------------------------------------------------------
# Thống kê hiệu suất — UC-29/30 (routers/stats.py, services/stats.py). Response là dict do services/stats.py
# dựng (cấu trúc lồng nhiều tầng, chỉ giao diện Thống kê đọc) — chỉ khai báo request ở đây.
# ---------------------------------------------------------------------------
StudyActivity = Literal["chapter", "pdf", "practice", "exam", "flashcard", "mindmap", "summary", "chat"]
STATS_MAX_RANGE_DAYS = 365


class StudySessionStart(BaseModel):
    activity: StudyActivity
    subject_id: str | None = None
    chapter_id: str | None = None
    document_id: str | None = None


class StudySessionBeat(BaseModel):
    active_seconds: int = Field(0, ge=0, le=600)   # giây hoạt động từ nhịp trước (server còn chặn theo giờ thật)
    end: bool = False


class StatsAiRequest(BaseModel):
    from_date: date = Field(..., alias="from")
    to_date: date = Field(..., alias="to")
    subject_id: str | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.to_date < self.from_date or (self.to_date - self.from_date).days >= STATS_MAX_RANGE_DAYS:
            raise ValueError(f"Khoảng thời gian phải từ 1 đến {STATS_MAX_RANGE_DAYS} ngày.")
        return self


class StatsScheduleRequest(BaseModel):
    indexes: list[int] = Field(default_factory=list)   # vị trí các đề xuất `act` muốn thêm; rỗng = tất cả có môn


# ---------------------------------------------------------------------------
# CHIA SẺ Môn học / Chương (routers/shares.py, database/sharing_schema.sql)
# ---------------------------------------------------------------------------
ShareRole = Literal["viewer", "editor"]


class SharePersonOut(BaseModel):
    id: str
    name: str
    avatar: str | None = None
    contact: str | None = None    # SĐT che bớt / Gmail — chỉ chủ sở hữu thấy


class ShareGrantOut(BaseModel):
    id: str
    user: SharePersonOut
    role: str
    via: str                      # invite | link
    inherited: bool = False       # quyền đến từ chia sẻ cả Môn (hiện ở hộp chia sẻ Chương, không sửa ở đây)


class ShareLinkOut(BaseModel):
    token: str
    audience: str                 # anyone | invited
    role: str


class ShareTargetOut(BaseModel):
    target_type: str
    target_id: str
    name: str
    subject_id: str
    subject_name: str
    owner: SharePersonOut
    my_role: str                  # owner | editor | viewer
    can_manage: bool
    grants: list[ShareGrantOut]
    link: ShareLinkOut | None = None


class ShareInviteRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=20)
    role: ShareRole = "editor"
    message: str | None = Field(None, max_length=500)


class ShareRoleRequest(BaseModel):
    role: ShareRole


class ShareLinkRequest(BaseModel):
    audience: Literal["anyone", "invited"] = "anyone"
    role: ShareRole = "viewer"


class SharedItemOut(BaseModel):
    id: str
    name: str
    role: str
    protected: bool = False
    page_count: int | None = None
    share_id: str | None = None   # Chương được chia sẻ RIÊNG (không qua cả Môn) — "Xoá khỏi danh sách"


class SharedSubjectOut(BaseModel):
    """1 mục ở "Được chia sẻ với tôi": cả Môn (whole=True — mọi Chương + PDF) hoặc chỉ vài Chương của Môn đó."""
    subject_id: str
    subject_name: str
    owner: SharePersonOut
    whole: bool
    role: str | None = None       # quyền ở cấp Môn (None = chỉ được chia sẻ từng Chương)
    share_id: str | None = None   # dòng shares cấp Môn — "Xoá khỏi danh sách"
    chapters: list[SharedItemOut]
    pdfs: list[SharedItemOut]


class ShareAcceptOut(BaseModel):
    target_type: str
    target_id: str
    subject_id: str
    role: str


class ShareCopyRequest(BaseModel):
    kind: Literal["chapter", "pdf", "subject"]
    id: str
    to_subject_id: str | None = None   # bắt buộc với chapter / pdf


class ShareCopyOut(BaseModel):
    subject_id: str
    kind: str
    id: str


class ChapterSyncOut(BaseModel):
    version: int
    role: str
    updated_by_name: str | None = None
    updated_seconds_ago: int | None = None
    viewers: list[SharePersonOut]


class PublicShareOut(BaseModel):
    """Trang xem công khai (chưa đăng nhập) — chỉ liên kết "Ai có liên kết"."""
    target_type: str
    name: str
    subject_name: str
    owner_name: str
    chapters: list[SharedItemOut]
    pdfs: list[SharedItemOut]


# ---------------------------------------------------------------------------
# UC-33 — Hạn mức phía người học (routers/me_quota.py) · UC-35 — Góp ý (routers/feedback.py)
# ---------------------------------------------------------------------------
class QuotaSubjectOut(BaseModel):
    id: str
    name: str
    count: int


class QuotaStorageOut(BaseModel):
    used_bytes: int
    limit_bytes: int
    free_bytes: int
    pct: float
    level: int                      # 0 bình thường · 1 nhắc lần 1 · 2 nhắc lần 2 · 3 đầy (chặn tải lên)
    by_type: dict[str, int]         # pdf / chat / fb
    avg_pdf_bytes: float
    file_limit_mb: int
    subject_files_limit: int
    subjects: list[QuotaSubjectOut]


class QuotaFeatureOut(BaseModel):
    feature: str
    name: str
    used: int
    limit: int
    remaining: int
    per_session: bool = False       # True = `limit` là số lượt mỗi cuộc hội thoại (Hỏi đáp), không theo ngày


class MyQuotaOut(BaseModel):
    storage: QuotaStorageOut
    ai: list[QuotaFeatureOut]
    feedback: QuotaFeatureOut
    warn: dict[str, int]            # w1 / w2 / ai (%)
    reset_in_seconds: int


class MyFileOut(BaseModel):
    type: Literal["pdf", "chat", "fb"]
    id: str
    name: str
    subject_id: str | None = None
    subject_name: str | None = None
    size_bytes: int
    opened_days_ago: int | None = None
    status: str                     # ready / processing / ocr_error / empty / none
    dup_of: str | None = None       # tên tệp gốc nếu là bản trùng
    cited: int = 0                  # số trích dẫn AI đang trỏ tới tệp


class MyFilesDeleteRequest(BaseModel):
    pdf_ids: list[str] = []
    attachment_ids: list[str] = []
    feedback_ids: list[int] = []    # chỉ gỡ ẢNH đính kèm, góp ý vẫn giữ


class MyFilesDeleteOut(BaseModel):
    deleted: int
    freed_bytes: int
    level: int


class FeedbackMineOut(BaseModel):
    id: int
    category: str
    title: str
    status: str
    reply: str | None = None
    created_at: datetime
    replied_at: datetime | None = None


# ---------------------------------------------------------------------------
# UC-32 → UC-37 — Admin Console (routers/admin.py). Phản hồi trả dict (mô tả khuôn ở docstring từng endpoint).
# ---------------------------------------------------------------------------
class AdminStatusRequest(BaseModel):
    action: Literal["lock", "unlock", "disable", "restore"]
    undo: bool = False              # thao tác do nút "Hoàn tác" gửi -> nhật ký ghi "Hoàn tác: …"


class AdminDeleteUserRequest(BaseModel):
    confirm: str                    # SĐT hoặc Gmail đầy đủ của tài khoản, gõ lại để xác nhận


class AdminQuotaRequest(BaseModel):
    values: dict[str, int]
    # Bắt buộc khi lưu (PUT /admin/quota) — gửi kèm thông báo tới mọi người học; preview không cần.
    reason: str | None = Field(None, max_length=300)
    # None = cố định; có giá trị = tạm thời tới thời điểm này (giờ địa phương APP_TIMEZONE), hết hạn tự về số cố định.
    until: datetime | None = None


class AdminFileDeleteRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=200)


class AdminFeedbackPatch(BaseModel):
    status: Literal["new", "doing", "done"] | None = None
    duplicate_of: int | None = None
    closing: bool = False           # "Đóng góp ý" (không gửi phản hồi)
    auto: bool = False              # Mới -> Đang xử lý tự động khi admin đã mở xem rồi rời đi


class AdminFeedbackReply(BaseModel):
    reply: str = Field(..., min_length=1, max_length=500)
