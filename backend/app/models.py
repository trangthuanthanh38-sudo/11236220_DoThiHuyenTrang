"""ORM model ánh xạ các bảng trong database/auth_schema.sql (UC-01->05) và
database/profile_settings_schema.sql (UC-06->09).

Không dùng `Base.metadata.create_all()` để tạo bảng — schema đã được quản lý
thủ công bằng file .sql (xem database/*.sql + docker-compose.yml). Model ở
đây chỉ để đọc/ghi, không sinh DDL.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import (
    CHAR,
    JSON,
    TIMESTAMP,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.mysql import SET
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)

    phone_number: Mapped[str | None] = mapped_column(String(20), unique=True, nullable=True)
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    google_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Tên Google ở lần đăng nhập gần nhất (database/auth_schema_v2.sql) — display_name theo nó tới khi người dùng tự đổi
    google_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    auth_provider: Mapped[str] = mapped_column(Enum("local", "google", name="auth_provider"), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)

    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    role: Mapped[str] = mapped_column(Enum("learner", "admin", name="user_role"), default="learner", nullable=False)

    status: Mapped[str] = mapped_column(
        Enum("pending_verification", "active", "locked", "disabled", name="user_status"),
        default="pending_verification",
        nullable=False,
    )
    phone_verified_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)

    failed_login_attempts: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    # UC-32: 'disabled' = Vô hiệu hoá (tự xoá sau 30 ngày tính từ disabled_at); "Buộc đặt lại mật khẩu"
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    must_reset_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    # Quan hệ ngược 1-1 / 1-N từ các bảng thuộc về user (hoàn thiện phía "một" của
    # các FK owner_id/user_id đã có ở Subject/UserSettings/ChatSession) — chỉ để đọc
    # qua object graph (vd. user.subjects); DB đã tự đảm bảo cascade qua ON DELETE
    # CASCADE ở từng bảng, cascade ở đây khai báo lại cho khớp hành vi khi xoá qua ORM.
    settings: Mapped["UserSettings | None"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    subjects: Mapped[list["Subject"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    chat_sessions: Mapped[list["ChatSession"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    chat_attachments: Mapped[list["ChatAttachment"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class PhoneVerificationToken(Base):
    __tablename__ = "phone_verification_tokens"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    purpose: Mapped[str] = mapped_column(Enum("register", "change_phone", name="phone_token_purpose"), default="register")
    new_phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)

    otp_code: Mapped[str] = mapped_column(CHAR(6), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False)

    attempt_count: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)

    consumed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    otp_code: Mapped[str] = mapped_column(CHAR(6), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False)

    attempt_count: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    token_hash: Mapped[str] = mapped_column(CHAR(64), unique=True, nullable=False)
    device_info: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)

    issued_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TIMESTAMP, nullable=True)


class LoginAuditLog(Base):
    __tablename__ = "login_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    phone_attempt: Mapped[str | None] = mapped_column(String(20), nullable=True)
    auth_provider: Mapped[str] = mapped_column(Enum("local", "google", name="login_auth_provider"), nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


# -----------------------------------------------------------------------------
# database/profile_settings_schema.sql — UC-06 -> UC-09 (Hồ sơ & Cài đặt cá nhân)
# -----------------------------------------------------------------------------
class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)

    school_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    class_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    theme: Mapped[str] = mapped_column(
        Enum("light", "dark", "system", name="user_settings_theme"), default="system", nullable=False
    )
    # Lịch biểu UC-31 (database/schedule_schema.sql): email nhận nhắc lịch; NULL = dùng users.google_email
    notify_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    user: Mapped["User"] = relationship(back_populates="settings")


class AccountSecurityLog(Base):
    __tablename__ = "account_security_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    event_type: Mapped[str] = mapped_column(
        Enum("phone_changed", "password_changed", name="account_security_event"), nullable=False
    )
    old_phone_number: Mapped[str | None] = mapped_column(String(20), nullable=True)

    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


# -----------------------------------------------------------------------------
# database/knowledge_content_schema.sql — UC-12 -> UC-18 (Quản lý Tri thức & Nội
# dung) + PDF upload trong cột 1 - Notebook (mở rộng UC-16, xem comment đầu file
# .sql). `notes` (bảng dự trữ theo đặc tả 3 tầng, chưa được ghichu.html dùng) CHƯA
# có model ở đây — chỉ ánh xạ đúng những gì API/frontend hiện tại thực sự cần.
# -----------------------------------------------------------------------------
class Subject(Base):
    __tablename__ = "subjects"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    owner: Mapped["User"] = relationship(back_populates="subjects")
    chapters: Mapped[list["Chapter"]] = relationship(
        back_populates="subject", cascade="all, delete-orphan", order_by="Chapter.sort_order"
    )
    pdf_documents: Mapped[list["PdfDocument"]] = relationship(
        back_populates="subject", cascade="all, delete-orphan", order_by="PdfDocument.sort_order"
    )


class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)

    name: Mapped[str] = mapped_column(String(150), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Nội dung soạn thảo thật (UC-16) — HTML string do CKEditor sinh ra (getData()), xem
    # comment ở database/knowledge_content_schema.sql lý do dùng LONGTEXT/Text thay vì
    # kiểu JSON gốc của MySQL.
    content_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Chia sẻ (database/sharing_schema.sql): khoá lạc quan khi nhiều người cùng sửa + "Sửa lần cuối bởi …"
    content_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content_updated_by: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    content_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Thẻ Draw (database/knowledge_content_schema_v2.sql): nét vẽ / hình khối / nền trang — lớp riêng chồng lên nội dung,
    # KHÔNG nằm trong content_json (không re-embed, không tăng content_version).
    drawing_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Thẻ Review ▸ Password (database/knowledge_content_schema_v3.sql): bcrypt, NULL = không có mật khẩu.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_hint: Mapped[str | None] = mapped_column(String(200), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    subject: Mapped["Subject"] = relationship(back_populates="chapters")
    notes: Mapped[list["Note"]] = relationship(
        back_populates="chapter", cascade="all, delete-orphan", order_by="Note.sort_order"
    )
    # Bước 3 lộ trình RAG — chunk nguồn CHAPTER (backend/app/services/embeddings.py). Cột +
    # FK chapter_id đã tồn tại từ studio_rag_schema.sql (trước đó chỉ dùng denormalize phạm
    # vi cho NOTE), quan hệ 2 chiều này thêm ở Bước 3 khi bắt đầu ghi chunk thật vào đó.
    embedding_chunks: Mapped[list["EmbeddingChunk"]] = relationship(
        back_populates="chapter", cascade="all, delete-orphan", order_by="EmbeddingChunk.chunk_index"
    )


class Note(Base):
    """Bài ghi chú — đặc tả 3 tầng chính thức (UC-16), bảng `notes` trong
    knowledge_content_schema.sql. VẪN chưa có router/endpoint nào dùng bảng này
    (ghichu.html hiện tại soạn thảo trực tiếp trên `chapters.content_json` — xem
    comment đầu file .sql) — map ở đây CHỈ để `chat_sessions.scope_note_id`
    (studio_chat_schema.sql, UC-19 mức "theo Bài ghi chú cụ thể") có một bảng
    hợp lệ trong Base.metadata cho SQLAlchemy giải FK khi flush.
    """

    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    chapter_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False)

    note_type: Mapped[str] = mapped_column(Enum("text", "pdf", name="note_type"), default="text", nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    chapter: Mapped["Chapter"] = relationship(back_populates="notes")
    embedding_chunks: Mapped[list["EmbeddingChunk"]] = relationship(
        back_populates="note", cascade="all, delete-orphan", order_by="EmbeddingChunk.chunk_index"
    )


class PdfDocument(Base):
    __tablename__ = "pdf_documents"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    # Gắn thẳng vào Môn học — file PDF là 1 item độc lập, cùng cấp với Chương trong cây
    # Notebook (KHÔNG thuộc về 1 Chương cụ thể nào), xem khối "CẬP NHẬT TIẾP" đầu file .sql.
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Tên hiển thị (đổi tên được, độc lập với file_path thật trên đĩa), khởi tạo = tên file
    # lúc tải lên.
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Storage key thật trên đĩa (backend/uploads/pdf/<uuid>.pdf) — KHÔNG lưu nội dung
    # file trong DB, xem khối "NGUYÊN TẮC HIỂN THỊ" ở đầu bảng này trong file .sql.
    file_path: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    page_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), default="application/pdf", nullable=False)
    # UC-33 Dọn dung lượng ("Tệp trùng", "Chưa mở 30 ngày") + UC-36 trạng thái xử lý
    content_sha256: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    process_status: Mapped[str] = mapped_column(
        Enum("processing", "ready", "ocr_error", "empty", name="pdf_process_status"), nullable=False, default="processing"
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    subject: Mapped["Subject"] = relationship(back_populates="pdf_documents")
    annotations: Mapped[list["PdfAnnotation"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="PdfAnnotation.page_number"
    )
    embedding_chunks: Mapped[list["EmbeddingChunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="EmbeddingChunk.chunk_index"
    )


class PdfAnnotation(Base):
    __tablename__ = "pdf_annotations"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    document_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    page_number: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    annotation_type: Mapped[str] = mapped_column(
        Enum("highlight", "underline", "strikeout", "textbox", "draw", "shape", "note", name="pdf_annotation_type"),
        nullable=False,
    )
    # Toạ độ/màu/nội dung/nét vẽ — LUÔN ở PDF user space, xem khối "HỆ TOẠ ĐỘ ANNOTATION"
    # trong database/knowledge_content_schema.sql. Backend không diễn giải cấu trúc bên
    # trong, chỉ lưu/trả nguyên JSON cho frontend (PDF.js) tự vẽ overlay.
    data: Mapped[dict] = mapped_column(JSON, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    document: Mapped["PdfDocument"] = relationship(back_populates="annotations")


# -----------------------------------------------------------------------------
# database/studio_chat_schema.sql — Nền tảng AI Chat (chuẩn bị cho UC-19/UC-20).
# CHƯA có logic AI nào ở đây — chỉ ánh xạ 2 bảng lưu hội thoại.
# -----------------------------------------------------------------------------
class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    title: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Phạm vi nội dung nguồn (nền cho UC-19, đúng 3 mức: Môn học/Chương/Bài ghi
    # chú) — SET NULL khi nguồn bị xoá, không kéo theo xoá lịch sử hội thoại.
    # scope_note_id tham chiếu bảng `notes` (chưa có model riêng ở đây — xem
    # comment nhóm UC-12->18 phía trên — FK chỉ cần đúng tên bảng/cột).
    scope_subject_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True
    )
    scope_chapter_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True
    )
    scope_note_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True
    )
    # Bước 5 (database/studio_chat_schema_v2.sql) — mức phạm vi "Tệp PDF": PDF gắn thẳng vào
    # Môn, ngang hàng Chương, nên 3 cột trên không diễn đạt được. Khi có giá trị thì 2 cột
    # subject/chapter để trống (3 mức loại trừ nhau, xem chat.py `_resolve_scope`).
    scope_document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    user: Mapped["User"] = relationship(back_populates="chat_sessions")
    messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="ChatMessage.created_at"
    )
    # Chỉ để đọc tên hiển thị phạm vi (ChatSessionOut) — không back_populates, Môn/Chương/PDF
    # không cần biết phiên chat nào đang trỏ tới mình.
    scope_subject: Mapped["Subject | None"] = relationship()
    scope_chapter: Mapped["Chapter | None"] = relationship()
    scope_document: Mapped["PdfDocument | None"] = relationship()


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)

    role: Mapped[str] = mapped_column(Enum("user", "assistant", "system", name="chat_message_role"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # Tên model đã sinh câu trả lời — chỉ set cho role='assistant'; KHÔNG hard-code
    # nhà cung cấp AI nào ở đây (điền theo cấu hình runtime khi nối AI thật).
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    session: Mapped["ChatSession"] = relationship(back_populates="messages")
    citations: Mapped[list["ChatMessageCitation"]] = relationship(
        back_populates="message", cascade="all, delete-orphan", order_by="ChatMessageCitation.id"
    )


class ChatMessageCitation(Base):
    """Trích dẫn nguồn của 1 câu trả lời AI — BR-09, UC-20 luồng thay thế 5a.

    Ràng buộc "phải có ít nhất 1 trong 2 tham chiếu" (embedding_chunk_id hoặc
    note_id) do tầng ứng dụng đảm bảo khi tạo citation, KHÔNG có CHECK ở DB —
    MySQL cấm CHECK trên cột đang tham gia ON DELETE SET NULL (lỗi 3823), mà cả
    2 cột này đều bắt buộc SET NULL để không xoá mất lịch sử chat khi
    Note/chunk gốc bị xoá hoặc re-embed (xem comment trong file .sql).
    """

    __tablename__ = "chat_message_citations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    message_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False
    )

    embedding_chunk_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("embedding_chunks.id", ondelete="SET NULL"), nullable=True
    )
    note_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    message: Mapped["ChatMessage"] = relationship(back_populates="citations")
    embedding_chunk: Mapped["EmbeddingChunk | None"] = relationship(back_populates="citations")


# -----------------------------------------------------------------------------
# database/studio_chat_attachments_schema.sql — Đính kèm ngữ cảnh ở ô nhập AI Chat
# (UC-19 bước 1 + 1a). KHÔNG có message_id: chat_sessions/chat_messages ở trên vẫn
# chưa được router nào dùng (tin nhắn hiện hoàn toàn ở frontend) — một attachment chỉ
# thuộc về user, không thuộc về 1 tin nhắn cụ thể nào. CHƯA có LLM/RAG nào đọc dữ liệu
# này để trả lời — chỉ ghi nhận & phục vụ hiển thị lại (chip) ở ô nhập.
# -----------------------------------------------------------------------------
class ChatAttachment(Base):
    __tablename__ = "chat_attachments"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    kind: Mapped[str] = mapped_column(Enum("chapter", "file", name="chat_attachment_kind"), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        Enum("pending", "sent", name="chat_attachment_status"), default="pending", nullable=False
    )

    # kind='chapter'
    chapter_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True
    )

    # kind='file' — file thật nằm ngoài DB (settings.CHAT_ATTACHMENT_UPLOAD_DIR), không
    # có cột BLOB, giống pdf_documents.
    original_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_path: Mapped[str | None] = mapped_column(String(500), nullable=True, unique=True)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    content_sha256: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    user: Mapped["User"] = relationship(back_populates="chat_attachments")
    chapter: Mapped["Chapter | None"] = relationship()


# -----------------------------------------------------------------------------
# database/studio_rag_schema.sql — Nền tảng RAG (UC-19 -> UC-25). CHƯA có logic
# chunking/gọi embedding API/vector search — chỉ ánh xạ bảng lưu kết quả.
# -----------------------------------------------------------------------------
class EmbeddingChunk(Base):
    """Đoạn văn bản đã chunk + vector embedding, nguồn từ 1 Note, 1 PDF, hoặc 1 Chương
    (source_type='CHAPTER' thêm ở Bước 3 lộ trình RAG — nội dung Chương thật nằm ở
    `chapters.content_text`, bảng `notes` vẫn chưa router nào dùng, xem
    database/studio_rag_schema_v2.sql).

    `user_id`/`subject_id`/`chapter_id` là bản sao (denormalize) từ chuỗi sở hữu
    thật (Note/PDF/Chapter -> Subject -> User) tại thời điểm chunk hoá, chỉ để
    lọc nhanh theo phạm vi (UC-19) — tầng ứng dụng tự đảm bảo khớp đúng khi tạo,
    ORM/DB không tự suy ra được 3 cột này từ note_id/document_id/chapter_id.
    """

    __tablename__ = "embedding_chunks"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)

    source_type: Mapped[str] = mapped_column(
        Enum("NOTE", "PDF", "CHAPTER", name="embedding_chunk_source_type"), nullable=False
    )
    note_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("notes.id", ondelete="CASCADE"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="CASCADE"), nullable=True
    )
    chunk_index: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True
    )

    # Vector lưu JSON (mảng số thực) — MySQL thuần, không pgvector/ANN index; tính
    # cosine similarity ở tầng Python (NumPy) — xem search_similar_chunks() ở Bước 4.
    embedding_vector: Mapped[list[float]] = mapped_column(JSON, nullable=False)
    # KHÔNG hard-code nhà cung cấp AI nào — tên model thật điền theo cấu hình runtime.
    embedding_model: Mapped[str] = mapped_column(String(100), nullable=False)
    embedding_dimension: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)

    # Vị trí trong nguồn để điều hướng (UC-20 5a) — cấu trúc khác nhau theo source_type,
    # xem comment ở database/studio_rag_schema.sql.
    source_location: Mapped[dict] = mapped_column(JSON, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    note: Mapped["Note | None"] = relationship(back_populates="embedding_chunks")
    document: Mapped["PdfDocument | None"] = relationship(back_populates="embedding_chunks")
    chapter: Mapped["Chapter | None"] = relationship(back_populates="embedding_chunks")
    citations: Mapped[list["ChatMessageCitation"]] = relationship(back_populates="embedding_chunk")


# -----------------------------------------------------------------------------
# database/studio_tools_quiz_schema.sql — Tạo bộ câu hỏi (UC-21 Ôn tập / UC-22 Thi thử).
# Không back_populates từ User/Subject/Chapter/PdfDocument: các bảng đó không cần biết bộ
# câu hỏi nào trỏ tới mình (giống ChatSession.scope_*). Xoá cascade/SET NULL do FK ở DB lo
# (passive_deletes) — xem comment đầu file .sql.
# -----------------------------------------------------------------------------
_DIFFICULTY = ("easy", "medium", "hard")
_QUESTION_TYPE = ("single", "multi")
_QUIZ_SOURCE_TYPE = ("CHAPTER", "PDF")


class QuizSet(Base):
    __tablename__ = "quiz_sets"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    mode: Mapped[str] = mapped_column(Enum("practice", "exam", name="quiz_mode"), nullable=False, default="practice")

    requested_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    question_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    difficulty: Mapped[str | None] = mapped_column(Enum(*_DIFFICULTY, name="quiz_difficulty"), nullable=True)
    question_type: Mapped[str] = mapped_column(
        Enum(*_QUESTION_TYPE, name="quiz_question_type"), nullable=False, default="single"
    )
    # "Sau mỗi câu" của ôn tập (studio_tools_quiz_schema_v3.sql); thi thử không đọc.
    show_answer: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    show_explanation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    show_citation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    time_limit_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(
        Enum("generating", "ready", "failed", name="quiz_status"), nullable=False, default="generating"
    )
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Model LLM THẬT đã sinh bộ này (QUIZ_MODEL, hoặc QUIZ_FALLBACK_MODEL khi model chính lỗi).
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    subject: Mapped["Subject"] = relationship()
    sources: Mapped[list["QuizSetSource"]] = relationship(
        back_populates="quiz_set", cascade="all, delete-orphan", passive_deletes=True, order_by="QuizSetSource.id"
    )
    questions: Mapped[list["QuizQuestion"]] = relationship(
        back_populates="quiz_set", cascade="all, delete-orphan", passive_deletes=True, order_by="QuizQuestion.position"
    )
    attempts: Mapped[list["QuizAttempt"]] = relationship(
        back_populates="quiz_set", cascade="all, delete-orphan", passive_deletes=True, order_by="QuizAttempt.attempt_no"
    )


class QuizSetSource(Base):
    __tablename__ = "quiz_set_sources"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    quiz_set_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("quiz_sets.id", ondelete="CASCADE"), nullable=False)

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="quiz_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)  # snapshot tên nguồn

    quiz_set: Mapped["QuizSet"] = relationship(back_populates="sources")


class QuizQuestion(Base):
    __tablename__ = "quiz_questions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    quiz_set_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("quiz_sets.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # bắt đầu từ 1

    question_type: Mapped[str] = mapped_column(Enum(*_QUESTION_TYPE, name="quiz_question_type"), nullable=False)
    difficulty: Mapped[str] = mapped_column(Enum(*_DIFFICULTY, name="quiz_difficulty"), nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    short_text: Mapped[str | None] = mapped_column(String(255), nullable=True)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    quiz_set: Mapped["QuizSet"] = relationship(back_populates="questions")
    options: Mapped[list["QuizQuestionOption"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", passive_deletes=True,
        order_by="QuizQuestionOption.position",
    )
    citations: Mapped[list["QuizQuestionCitation"]] = relationship(
        back_populates="question", cascade="all, delete-orphan", passive_deletes=True,
        order_by="QuizQuestionCitation.id",
    )


class QuizQuestionOption(Base):
    __tablename__ = "quiz_question_options"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    question_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("quiz_questions.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # 0=A, 1=B...
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    question: Mapped["QuizQuestion"] = relationship(back_populates="options")


class QuizQuestionCitation(Base):
    """Trích dẫn nguồn của 1 câu hỏi (BR-09). `source_label`/`page_number`/`quote` là snapshot
    để còn hiển thị khi Chương/PDF bị xoá hoặc chunk bị re-embed (các FK -> NULL)."""

    __tablename__ = "quiz_question_citations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    question_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("quiz_questions.id", ondelete="CASCADE"), nullable=False
    )

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="quiz_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    embedding_chunk_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("embedding_chunks.id", ondelete="SET NULL"), nullable=True
    )

    source_label: Mapped[str] = mapped_column(String(255), nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quote: Mapped[str] = mapped_column(Text, nullable=False)

    question: Mapped["QuizQuestion"] = relationship(back_populates="citations")


class QuizAttempt(Base):
    __tablename__ = "quiz_attempts"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    quiz_set_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("quiz_sets.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Bản sao mode của bộ (FK ghép (quiz_set_id, mode) ở DB) — đề thi chỉ có attempt_no=1 (UC-22).
    mode: Mapped[str] = mapped_column(Enum("practice", "exam", name="quiz_mode"), nullable=False, default="practice")
    attempt_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # chỉ đề thi: hạn nộp bài
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # NULL = đang làm dở
    submit_reason: Mapped[str | None] = mapped_column(
        Enum("manual", "timeout", name="quiz_submit_reason"), nullable=True
    )
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    total_questions: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    correct_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    score_percent: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)

    quiz_set: Mapped["QuizSet"] = relationship(back_populates="attempts")
    answers: Mapped[list["QuizAttemptAnswer"]] = relationship(
        back_populates="attempt", cascade="all, delete-orphan", passive_deletes=True
    )


class QuizAttemptAnswer(Base):
    __tablename__ = "quiz_attempt_answers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    attempt_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("quiz_attempts.id", ondelete="CASCADE"), nullable=False)
    question_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("quiz_questions.id", ondelete="CASCADE"), nullable=False
    )

    selected_positions: Mapped[list[int]] = mapped_column(JSON, nullable=False)  # vd. [0, 1]
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False)
    is_flagged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # thi thử: "Đánh dấu xem lại"
    answered_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    attempt: Mapped["QuizAttempt"] = relationship(back_populates="answers")


# ---------------------------------------------------------------------------
# UC-23 Tạo Flashcard — database/studio_tools_flashcard_schema.sql
# ---------------------------------------------------------------------------
_CARD_TYPE = ("term", "qa")
_RATING = ("easy", "hard")


class FlashcardSet(Base):
    __tablename__ = "flashcard_sets"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    count_mode: Mapped[str] = mapped_column(Enum("auto", "manual", name="flashcard_count_mode"), nullable=False, default="auto")
    requested_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # số thẻ đã chốt (5-50)
    card_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    card_types: Mapped[set[str]] = mapped_column(SET(*_CARD_TYPE), nullable=False)
    # 2 công tắc "Khi ôn" (studio_tools_flashcard_schema_v2.sql)
    shuffle_cards: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    show_citation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    status: Mapped[str] = mapped_column(
        Enum("generating", "ready", "failed", name="flashcard_status"), nullable=False, default="generating"
    )
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    subject: Mapped["Subject"] = relationship()
    sources: Mapped[list["FlashcardSetSource"]] = relationship(
        back_populates="flashcard_set", cascade="all, delete-orphan", passive_deletes=True,
        order_by="FlashcardSetSource.id",
    )
    cards: Mapped[list["Flashcard"]] = relationship(
        back_populates="flashcard_set", cascade="all, delete-orphan", passive_deletes=True,
        order_by="Flashcard.position",
    )
    sessions: Mapped[list["FlashcardSession"]] = relationship(
        back_populates="flashcard_set", cascade="all, delete-orphan", passive_deletes=True,
        order_by="FlashcardSession.session_no",
    )


class FlashcardSetSource(Base):
    __tablename__ = "flashcard_set_sources"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    flashcard_set_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("flashcard_sets.id", ondelete="CASCADE"), nullable=False
    )

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="flashcard_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)

    flashcard_set: Mapped["FlashcardSet"] = relationship(back_populates="sources")


class Flashcard(Base):
    """1 thẻ: 2 mặt + trích dẫn nguồn snapshot (BR-09) + trạng thái lặp lại ngắt quãng
    (due_at NULL = thẻ mới) — lịch do services/flashcard_generation.schedule_next() tính."""

    __tablename__ = "flashcards"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    flashcard_set_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("flashcard_sets.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    card_type: Mapped[str] = mapped_column(Enum(*_CARD_TYPE, name="flashcard_card_type"), nullable=False)
    front: Mapped[str] = mapped_column(Text, nullable=False)
    back: Mapped[str] = mapped_column(Text, nullable=False)

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="flashcard_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    embedding_chunk_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("embedding_chunks.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quote: Mapped[str] = mapped_column(Text, nullable=False)

    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    interval_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    lapse_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    last_rating: Mapped[str | None] = mapped_column(Enum(*_RATING, name="flashcard_rating"), nullable=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    flashcard_set: Mapped["FlashcardSet"] = relationship(back_populates="cards")


class FlashcardReview(Base):
    __tablename__ = "flashcard_reviews"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    flashcard_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("flashcards.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # NULL = chấm lẻ qua PUT /flashcards/cards/{id}/review (trước v2)
    session_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("flashcard_sessions.id", ondelete="CASCADE"), nullable=True
    )
    rating: Mapped[str] = mapped_column(Enum(*_RATING, name="flashcard_rating"), nullable=False)
    interval_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class FlashcardSession(Base):
    """1 "Lần ôn" trọn phiên (studio_tools_flashcard_schema_v2.sql) — chỉ ghi khi ôn xong cả phiên."""

    __tablename__ = "flashcard_sessions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    flashcard_set_id: Mapped[str] = mapped_column(
        CHAR(36), ForeignKey("flashcard_sets.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    session_no: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    kind: Mapped[str] = mapped_column(Enum("full", "hard", name="flashcard_session_kind"), nullable=False, default="full")
    card_total: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    easy_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    hard_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    skip_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    flashcard_set: Mapped["FlashcardSet"] = relationship(back_populates="sessions")


# ---------------------------------------------------------------------------
# UC-25 Tạo sơ đồ tư duy — database/studio_tools_mindmap_schema.sql
# ---------------------------------------------------------------------------
class Mindmap(Base):
    """1 sơ đồ tư duy + tham số màn Tạo mới. `updated_at` KHÔNG tự đổi khi sửa node — router chạm
    tay mỗi lần lưu node (cột "Cập nhật" / "Đã lưu lúc")."""

    __tablename__ = "mindmaps"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    depth: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=3)   # 2-4 cấp dưới mỗi chương
    build_method: Mapped[str] = mapped_column(
        Enum("headings", "auto", name="mindmap_build_method"), nullable=False, default="headings"
    )
    layout: Mapped[str] = mapped_column(Enum("tree", "radial", name="mindmap_layout"), nullable=False, default="tree")
    show_citation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    ask_qa: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_flat: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)   # UC-25 E1

    status: Mapped[str] = mapped_column(
        Enum("generating", "ready", "failed", name="mindmap_status"), nullable=False, default="generating"
    )
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)   # BR-08 đếm dòng có giá trị

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    subject: Mapped["Subject"] = relationship()
    sources: Mapped[list["MindmapSource"]] = relationship(
        back_populates="mindmap", cascade="all, delete-orphan", passive_deletes=True,
        order_by="MindmapSource.position",
    )
    nodes: Mapped[list["MindmapNode"]] = relationship(
        back_populates="mindmap", cascade="all, delete-orphan", passive_deletes=True,
        order_by="(MindmapNode.depth, MindmapNode.position, MindmapNode.id)",
    )


class MindmapSource(Base):
    """Chương / tệp PDF đã tick = 1 nhánh lớn (position = thứ tự nhánh); FK nguồn SET NULL + snapshot tên."""

    __tablename__ = "mindmap_sources"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    mindmap_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("mindmaps.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="mindmap_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)

    mindmap: Mapped["Mindmap"] = relationship(back_populates="sources")


class MindmapNode(Base):
    """1 node của cây (danh sách kề: parent_id NULL = gốc). FK GHÉP (mindmap_id, parent_id) -> (mindmap_id, id)
    ON DELETE CASCADE: cha phải cùng sơ đồ, xoá node xoá cả nhánh con (ở DB). Cột ảo `root_marker` (đúng 1 gốc)
    không map. Không có relationship cha/con — router dựng cây từ danh sách phẳng."""

    __tablename__ = "mindmap_nodes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["mindmap_id", "parent_id"], ["mindmap_nodes.mindmap_id", "mindmap_nodes.id"],
            ondelete="CASCADE", name="fk_mindmap_nodes_parent",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    mindmap_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("mindmaps.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    depth: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    label: Mapped[str] = mapped_column(String(500), nullable=False)
    origin: Mapped[str] = mapped_column(Enum("ai", "user", name="mindmap_node_origin"), nullable=False, default="ai")
    offset_x: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    offset_y: Mapped[float] = mapped_column(Float, nullable=False, default=0)

    source_type: Mapped[str | None] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="mindmap_node_source_type"), nullable=True)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    embedding_chunk_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("embedding_chunks.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    mindmap: Mapped["Mindmap"] = relationship(back_populates="nodes")


# ---------------------------------------------------------------------------
# UC-24 Tạo bản tóm tắt — database/studio_tools_summary_schema.sql
# ---------------------------------------------------------------------------
class Summary(Base):
    """1 bản tóm tắt của ĐÚNG 1 nguồn (Chương hoặc PDF — cột nguồn gộp vào dòng, FK SET NULL + snapshot tên).
    "Tạo lại" ghi đè tại chỗ: xoá mục/ý cũ, ghi mới, cập nhật generated_at/source_text_hash (services/summary_generation.py)."""

    __tablename__ = "summaries"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=False)

    source_type: Mapped[str] = mapped_column(Enum(*_QUIZ_SOURCE_TYPE, name="summary_source_type"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    source_label: Mapped[str] = mapped_column(String(255), nullable=False)

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    length: Mapped[str] = mapped_column(Enum("short", "medium", "long", name="summary_length"), nullable=False, default="medium")
    format: Mapped[str] = mapped_column(Enum("bullet", "paragraph", name="summary_format"), nullable=False, default="bullet")
    keep_definitions: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    keep_numbers: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    keep_examples: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    source_text_hash: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)   # "Nội dung gốc đã thay đổi"
    source_word_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(
        Enum("generating", "ready", "failed", name="summary_status"), nullable=False, default="generating"
    )
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    sections: Mapped[list["SummarySection"]] = relationship(
        back_populates="summary", cascade="all, delete-orphan", passive_deletes=True,
        order_by="SummarySection.position",
    )


class SummarySection(Base):
    """Mục có tiêu đề; `kind` khớp 3 công tắc "Giữ lại" (definition / number / example), còn lại general."""

    __tablename__ = "summary_sections"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    summary_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("summaries.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    heading: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(
        Enum("general", "definition", "number", "example", name="summary_section_kind"), nullable=False, default="general"
    )

    summary: Mapped["Summary"] = relationship(back_populates="sections")
    points: Mapped[list["SummaryPoint"]] = relationship(
        back_populates="section", cascade="all, delete-orphan", passive_deletes=True,
        order_by="SummaryPoint.position", foreign_keys="SummaryPoint.section_id",
        primaryjoin="SummarySection.id == SummaryPoint.section_id",
    )


class SummaryPoint(Base):
    """1 ý + trích dẫn snapshot (BR-09). FK GHÉP (summary_id, section_id) -> summary_sections(summary_id, id) ép ý
    nằm trong mục của đúng bản tóm tắt đó. Số trích dẫn không lưu — tính theo thứ tự mục rồi ý."""

    __tablename__ = "summary_points"
    __table_args__ = (
        ForeignKeyConstraint(
            ["summary_id", "section_id"], ["summary_sections.summary_id", "summary_sections.id"],
            ondelete="CASCADE", name="fk_summary_points_section",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    summary_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("summaries.id", ondelete="CASCADE"), nullable=False)
    section_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    embedding_chunk_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("embedding_chunks.id", ondelete="SET NULL"), nullable=True
    )
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quote: Mapped[str] = mapped_column(Text, nullable=False)

    section: Mapped["SummarySection"] = relationship(
        back_populates="points", foreign_keys=[section_id],
        primaryjoin="SummarySection.id == SummaryPoint.section_id",
    )


class SummaryGeneration(Base):
    """Nhật ký mỗi lượt gọi AI thành công (tạo + tạo lại) — BR-08 đếm bảng này vì "Tạo lại" ghi đè tại chỗ."""

    __tablename__ = "summary_generations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    summary_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("summaries.id", ondelete="SET NULL"), nullable=True)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(Enum("create", "regenerate", name="summary_generation_kind"), nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


# ---------------------------------------------------------------------------
# Lịch biểu — UC-26/27/28/31 (database/schedule_schema.sql)
# ---------------------------------------------------------------------------
class ScheduleLabel(Base):
    """Nhãn tự đặt tên — 1 nhãn 1 màu. Cột ảo `name_key` (LOWER(TRIM(name))) + UNIQUE không map vào ORM."""

    __tablename__ = "schedule_labels"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    color: Mapped[str] = mapped_column(CHAR(7), nullable=False)
    is_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )


class ScheduleItem(Base):
    """SCHEDULE_ITEM — giờ địa phương dạng ngày + phút trong ngày; `remind_at` do backend tính sẵn."""

    __tablename__ = "schedule_items"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    item_type: Mapped[str] = mapped_column(
        Enum("event", "class", "deadline", "exam", name="schedule_item_type"), nullable=False, default="event"
    )
    label_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("schedule_labels.id", ondelete="SET NULL"), nullable=True
    )
    color: Mapped[str] = mapped_column(CHAR(7), nullable=False)
    subject_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    item_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_minute: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    end_minute: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    # 1 dòng = 1 chuỗi lặp (schedule_schema_v2.sql): item_date = lần đầu, repeat_until NULL = lặp mãi
    repeat_rule: Mapped[str] = mapped_column(
        Enum("none", "weekly", "monthly", "yearly", name="schedule_repeat_rule"), nullable=False, default="none"
    )
    repeat_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    remind_before: Mapped[str] = mapped_column(
        Enum("none", "m10", "m30", "h1", "d1", name="schedule_remind_before"), nullable=False, default="m30"
    )
    via_app: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    via_email: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    via_push: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    remind_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    remind_sent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    label: Mapped["ScheduleLabel | None"] = relationship()
    subject: Mapped["Subject | None"] = relationship()
    chapter: Mapped["Chapter | None"] = relationship()


class Notification(Base):
    """NOTIFICATION — chỉ tạo khi đến giờ nhắc (UC-31); snapshot sự kiện lúc nhắc."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    schedule_item_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("schedule_items.id", ondelete="SET NULL"), nullable=True
    )
    # schedule = nhắc lịch; flashcard / exam / practice = nhắc học do máy chủ tự sinh (services/study_reminders.py)
    kind: Mapped[str] = mapped_column(
        Enum("schedule", "flashcard", "practice", "exam", "share", "share_request",
             "quota", "quota_ai", "feedback", "file_removed", "account", "quota_change", name="notification_kind"),
        nullable=False, default="schedule",
    )
    # bộ thẻ / bộ câu hỏi / đề; share / share_request: Môn hoặc Chương được chia sẻ — không FK
    ref_id: Mapped[str | None] = mapped_column(CHAR(36), nullable=True)
    item_type: Mapped[str | None] = mapped_column(
        Enum("event", "class", "deadline", "exam", name="notification_item_type"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    item_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    start_minute: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    fire_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    deliveries: Mapped[list["NotificationDelivery"]] = relationship(
        back_populates="notification", cascade="all, delete-orphan", passive_deletes=True
    )

    @property
    def actor_id(self) -> str | None:
        """share_request: id người xin quyền (dedupe_key = "rq:<đích>:<người xin>:<ngày>") — mở hộp Chia sẻ điền sẵn."""
        if self.kind == "share_request" and self.dedupe_key and self.dedupe_key.startswith("rq:"):
            parts = self.dedupe_key.split(":")
            return parts[2] if len(parts) > 2 else None
        return None


class NotificationDelivery(Base):
    """Kết quả gửi 1 thông báo qua 1 kênh — UNIQUE(notification_id, channel), thử lại tối đa 3 lần."""

    __tablename__ = "notification_deliveries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    notification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False
    )
    channel: Mapped[str] = mapped_column(Enum("app", "email", "push", name="notification_channel"), nullable=False)
    status: Mapped[str] = mapped_column(
        Enum("pending", "sent", "failed", "skipped", "cancelled", name="notification_delivery_status"),
        nullable=False, default="pending",
    )
    recipient: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )

    notification: Mapped["Notification"] = relationship(back_populates="deliveries")


# ---------------------------------------------------------------------------
# Thống kê hiệu suất — UC-29/30 (database/stats_schema.sql, services/stats.py)
# ---------------------------------------------------------------------------
class StudySession(Base):
    """Phiên học — thời gian học thật. Giờ ĐỊA PHƯƠNG (APP_TIMEZONE), ghi bằng schedule_notifier.local_now()."""

    __tablename__ = "study_sessions"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    activity: Mapped[str] = mapped_column(
        Enum("chapter", "pdf", "practice", "exam", "flashcard", "mindmap", "summary", "chat", name="study_activity"),
        nullable=False,
    )
    subject_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str | None] = mapped_column(
        CHAR(36), ForeignKey("pdf_documents.id", ondelete="SET NULL"), nullable=True
    )
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_beat_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    active_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class StatSnapshot(Base):
    """STAT_SNAPSHOT — số liệu 1 kỳ đã chốt (tuần / lúc tạo nhận xét AI) + nhận xét AI (UC-30)."""

    __tablename__ = "stat_snapshots"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    subject_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=True)
    period_from: Mapped[date] = mapped_column(Date, nullable=False)
    period_to: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(Enum("weekly", "ai", name="stat_snapshot_kind"), nullable=False)
    metrics: Mapped[dict] = mapped_column(JSON, nullable=False)
    ai_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ai_saved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ai_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )


# ---------------------------------------------------------------------------
# CHIA SẺ Môn học / Chương (database/sharing_schema.sql) — giống Word / OneNote
# ---------------------------------------------------------------------------
class Share(Base):
    """1 tài khoản được quyền xem / chỉnh sửa 1 Môn (cả sổ) hoặc 1 Chương. Chủ sở hữu = subjects.owner_id."""

    __tablename__ = "shares"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    target_type: Mapped[str] = mapped_column(Enum("subject", "chapter", name="share_target_type"), nullable=False)
    target_id: Mapped[str] = mapped_column(CHAR(36), nullable=False)
    subject_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=True)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    grantee_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(Enum("viewer", "editor", name="share_role"), nullable=False)
    via: Mapped[str] = mapped_column(Enum("invite", "link", name="share_via"), nullable=False, default="invite")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )


class ShareLink(Base):
    """Liên kết chia sẻ — tối đa 1 / đích; tắt = xoá dòng (bật lại sinh token mới)."""

    __tablename__ = "share_links"

    id: Mapped[str] = mapped_column(CHAR(36), primary_key=True, default=_uuid)
    token: Mapped[str] = mapped_column(CHAR(32), nullable=False, unique=True)
    owner_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    target_type: Mapped[str] = mapped_column(Enum("subject", "chapter", name="share_link_target_type"), nullable=False)
    target_id: Mapped[str] = mapped_column(CHAR(36), nullable=False)
    subject_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("subjects.id", ondelete="CASCADE"), nullable=True)
    chapter_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), nullable=True)
    audience: Mapped[str] = mapped_column(Enum("anyone", "invited", name="share_link_audience"), nullable=False, default="anyone")
    role: Mapped[str] = mapped_column(Enum("viewer", "editor", name="share_link_role"), nullable=False, default="viewer")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )


class ChapterPresence(Base):
    """Ai đang mở Chương — nhịp GET /chapters/{id}/sync."""

    __tablename__ = "chapter_presence"

    chapter_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("chapters.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_seen: Mapped[datetime] = mapped_column(DateTime, nullable=False)


# --------------------------------------------------------------------------- Quản trị UC-32 → UC-37
# database/system_admin_schema.sql


class QuotaSetting(Base):
    """Hạn mức chung cho mọi người học (UC-33) — đọc qua services/quota.get_settings()."""

    __tablename__ = "quota_settings"

    setting_key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, nullable=False)
    # Đang tạm thời (system_admin_schema_v2.sql): hết `expires_at` (giờ địa phương) thì trở về `base_value` (số cố định).
    base_value: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    change_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )
    updated_by: Mapped[str | None] = mapped_column(CHAR(36), nullable=True)



class QuotaChangeEvent(Base):
    """1 lần đổi hạn mức (UC-33): 'change' do admin (kèm lý do gửi người học), 'revert' do hệ thống khi hết hạn tạm thời."""

    __tablename__ = "quota_change_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(Enum("change", "revert", name="quota_change_kind"), nullable=False)
    admin_id: Mapped[str | None] = mapped_column(CHAR(36), nullable=True)
    admin_label: Mapped[str] = mapped_column(String(100), nullable=False)
    reason: Mapped[str] = mapped_column(String(300), nullable=False)
    changes: Mapped[list] = mapped_column(JSON, nullable=False)   # [{key, name, unit, from, to}]
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

class AiUsageEvent(Base):
    """1 lượt gọi AI — đếm hạn mức BR-08 (status='ok') + báo cáo UC-37. user_id không FK."""

    __tablename__ = "ai_usage_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(CHAR(36), nullable=False)
    feature: Mapped[str] = mapped_column(
        Enum("qa", "quiz", "fc", "sum", "mind", "review", name="ai_usage_feature"), nullable=False
    )
    status: Mapped[str] = mapped_column(Enum("ok", "error", "limited", name="ai_usage_status"), nullable=False)
    error_source: Mapped[str | None] = mapped_column(Enum("gemini", "server", name="ai_usage_error_source"), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tokens_in: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tokens_thinking: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)  # giờ địa phương


class AdminAuditLog(Base):
    """Nhật ký quản trị UC-34 — chỉ INSERT (trigger DB chặn UPDATE/DELETE, BR-18)."""

    __tablename__ = "admin_audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    admin_id: Mapped[str | None] = mapped_column(CHAR(36), nullable=True)
    admin_label: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str] = mapped_column(Enum("acc", "quota", "file", "fb", name="admin_log_category"), nullable=False)
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    object_label: Mapped[str] = mapped_column(String(255), nullable=False)
    object_sub: Mapped[str | None] = mapped_column(String(255), nullable=True)
    from_value: Mapped[str] = mapped_column(String(255), nullable=False, default="—")
    to_value: Mapped[str] = mapped_column(String(255), nullable=False, default="—")
    is_negative: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class Feedback(Base):
    """Góp ý của người học (UC-35). user_id SET NULL = người dùng đã xoá."""

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    category: Mapped[str] = mapped_column(Enum("ai", "bug", "idea", name="feedback_category"), nullable=False)
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    context: Mapped[list | None] = mapped_column(JSON, nullable=True)
    quote_heading: Mapped[str | None] = mapped_column(String(255), nullable=True)
    quote_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ref_type: Mapped[str | None] = mapped_column(
        Enum("flashcard", "quiz_question", "summary_point", "mindmap_node", name="feedback_ref_type"), nullable=True
    )
    ref_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    image_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_path: Mapped[str | None] = mapped_column(String(500), nullable=True, unique=True)
    image_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(Enum("new", "doing", "done", name="feedback_status"), nullable=False, default="new")
    duplicate_of: Mapped[int | None] = mapped_column(Integer, ForeignKey("feedback.id", ondelete="SET NULL"), nullable=True)
    reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    replied_by: Mapped[str | None] = mapped_column(CHAR(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=text("CURRENT_TIMESTAMP")
    )


class UserQuotaState(Base):
    """Mức dung lượng đã nhắc gần nhất (0–3) — chỉ nhắc khi mức TĂNG (UC-33)."""

    __tablename__ = "user_quota_state"

    user_id: Mapped[str] = mapped_column(CHAR(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    storage_level: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    level_kind: Mapped[str | None] = mapped_column(Enum("mb", "file", name="quota_level_kind"), nullable=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
