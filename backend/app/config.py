"""Cấu hình ứng dụng, đọc từ biến môi trường / file .env.

Xem .env.example để biết ý nghĩa từng biến.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    DATABASE_URL: str = "mysql+pymysql://root:devpassword@127.0.0.1:3306/ai_studio_tri_thuc"

    JWT_SECRET: str = "change-this-dev-secret-please"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_EXPIRE_MINUTES: int = 1440  # 24h — BR-03
    JWT_REFRESH_EXPIRE_DAYS: int = 30      # BR-03

    DEV_MODE: bool = True

    CORS_ORIGINS: str = "*"

    # BR-01: mật khẩu tối thiểu 8 ký tự, có chữ hoa/thường/số
    PASSWORD_MIN_LENGTH: int = 8

    # UC-01 E4: sai quá 5 lần/15 phút -> khoá tạm 15 phút
    MAX_FAILED_LOGIN: int = 5
    LOGIN_LOCK_MINUTES: int = 15

    # UC-03: OTP hạn 15 phút, sai quá 5 lần khoá 10 phút, gửi lại tối đa 3 lần/giờ
    OTP_EXPIRE_MINUTES: int = 15
    OTP_MAX_ATTEMPTS: int = 5
    OTP_LOCK_MINUTES: int = 10
    OTP_MAX_RESEND_PER_HOUR: int = 3

    # UC-16 (nhánh tải PDF lên) / BR-14: nơi lưu file PDF gốc trên đĩa (KHÔNG lưu BLOB
    # trong DB — xem comment đầu database/knowledge_content_schema.sql), và giới hạn
    # Đường dẫn tương đối tính từ thư mục chạy uvicorn (backend/). Giới hạn kích thước/tệp, dung lượng/người,
    # số tệp/môn: bảng quota_settings (UC-33, services/quota.py).
    PDF_UPLOAD_DIR: str = "uploads/pdf"
    # Ảnh người học đính kèm góp ý (UC-35) — tính vào dung lượng của người gửi.
    FEEDBACK_UPLOAD_DIR: str = "uploads/feedback"

    # UC-19 (đính kèm ngữ cảnh ở ô nhập AI Chat): nơi lưu tệp/ảnh người dùng kéo-thả
    # hoặc chọn từ máy, và giới hạn dung lượng/tệp. Cùng quy ước với PDF_UPLOAD_DIR —
    # đường dẫn tương đối tính từ thư mục chạy uvicorn (backend/), KHÔNG lưu BLOB trong DB.
    CHAT_ATTACHMENT_UPLOAD_DIR: str = "uploads/chat"

    # Bước 2 lộ trình RAG (UC-20, xem backend/app/routers/chat.py) — gọi Gemini API thật
    # thay cho câu trả lời cố định. Để trống (mặc định) = chưa cấu hình -> router tự rơi về
    # câu trả lời cố định như Bước 1, KHÔNG raise lỗi (dev chưa có key vẫn chạy được app).
    # Lấy key tại https://aistudio.google.com/apikey — KHÔNG bao giờ commit giá trị thật lên
    # git, chỉ đặt trong .env cục bộ (xem .env.example).
    GEMINI_API_KEY: str = ""
    # "-lite" thay vì "gemini-flash-latest" (bản suy luận sâu, hay bị quá tải/lỗi 503 lúc
    # cao điểm) — đủ dùng cho câu trả lời cơ bản ở Bước 2 (chưa RAG), phản hồi nhanh & ổn
    # định hơn để dev test. Đổi qua `.env` nếu muốn dùng bản mạnh hơn.
    GEMINI_MODEL: str = "gemini-flash-lite-latest"

    # Đọc nội dung tệp PDF/ảnh (đính kèm AI Chat, kind='file', VÀ pipeline chunking+embedding
    # Bước 3 — xem app/services/text_extraction.py) bằng Tesseract OCR — engine cài ở máy
    # (KHÔNG cài được qua pip, xem README/CLAUDE.md phần cài đặt). TESSERACT_CMD trỏ thẳng
    # vào tesseract.exe thay vì trông chờ PATH (không phải máy dev nào cũng thêm Tesseract
    # vào PATH lúc cài).
    # TESSDATA_DIR (chứa eng.traineddata/vie.traineddata) đặt trong project thay vì thư mục
    # cài đặt mặc định của Tesseract (thường ở Program Files) để KHÔNG cần quyền admin ghi
    # vào đó khi thêm gói ngôn ngữ.
    TESSERACT_CMD: str = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    TESSDATA_DIR: str = "tessdata"

    # Bước 3 lộ trình RAG — model sinh vector (backend/app/services/embeddings.py). Đổi model
    # chỉ cần sửa giá trị này rồi chạy `python -m app.services.embeddings` để backfill lại —
    # embedding_model được lưu NOT NULL theo từng chunk (studio_rag_schema.sql) nên chunk của
    # model cũ/mới không lẫn khi so sánh cosine (Bước 4).
    EMBEDDING_MODEL: str = "gemini-embedding-001"

    # Bước 4 lộ trình RAG (vector search, backend/app/services/embeddings.py
    # search_similar_chunks) — số chunk liên quan nhất lấy ra mỗi câu hỏi và ngưỡng cosine
    # similarity tối thiểu để coi là "đủ liên quan" (lọc bớt kết quả không ăn nhập, tránh đưa
    # nhiễu vào ngữ cảnh của Gemini). RAG_MIN_SIMILARITY=0.65 đã hiệu chỉnh bằng đo thật với
    # model gemini-embedding-001 (KHÔNG phải đoán suông) — câu hỏi liên quan thật ra điểm
    # ~0.73-0.77, câu hỏi không liên quan gì vẫn ra ~0.52-0.56 (embedding model này không có
    # baseline quanh 0 như cosine "lý thuyết"), 0.65 nằm giữa 2 dải, cách đều biên an toàn.
    # Có thể cần tinh chỉnh lại nếu đổi EMBEDDING_MODEL khác (baseline similarity đổi theo).
    RAG_TOP_K: int = 5
    RAG_MIN_SIMILARITY: float = 0.65

    # Số tin nhắn gần nhất của phiên gửi kèm mỗi lượt gọi Gemini (multi-turn) — phiên dài
    # không làm phình prompt/chi phí vô hạn. 20 tin = 10 lượt hỏi-đáp.
    CHAT_HISTORY_MAX_MESSAGES: int = 20
    # UC-21 Tạo bộ câu hỏi — model RIÊNG với GEMINI_MODEL (chat) để không ăn chung quota với chat
    # (xem hạn mức từng model tại https://aistudio.google.com/rate-limit). Sinh câu hỏi cần chất
    # lượng cao hơn chat (đáp án đúng, giải thích, trích dẫn) nên model chính là bản Flash. Model
    # chính lỗi (quá tải/hết quota/sai tên) thì thử LẦN LƯỢT các model trong QUIZ_FALLBACK_MODEL
    # (phân tách bằng dấu phẩy). Đo thật 26/09: gemini-3.5-flash và gemini-flash-lite-latest trả
    # 503 "high demand" liên tục, gemini-3.6-flash / gemini-3.1-flash-lite gọi bình thường —
    # tình trạng quá tải của Google đổi theo thời điểm, cứ chỉnh lại thứ tự trong .env khi cần.
    QUIZ_MODEL: str = "gemini-3.6-flash"
    QUIZ_FALLBACK_MODEL: str = "gemini-3.1-flash-lite,gemini-3.5-flash,gemini-flash-lite-latest"
    # Mức "suy nghĩ" của model (minimal|low|medium|high; để trống = mặc định của model). Token suy
    # nghĩ cũng tính vào quota/TPM — đo thật với gemini-3.5-flash: mặc định mất ~60s cho 6 câu.
    QUIZ_THINKING_LEVEL: str = "low"

    # BR-08 / UC-33: hạn mức lượt AI, dung lượng, kích thước tệp, số tệp/môn KHÔNG còn ở đây — lưu trong bảng
    # quota_settings (database/system_admin_schema.sql), admin sửa ở trang Hạn mức, đọc qua services/quota.py.
    # UC-37 "Chi phí ước tính": giá USD / 1 triệu token theo model, dạng "model=giá_vào:giá_ra" phân tách bằng dấu
    # phẩy; token suy luận tính như token ra; "*" = giá cho model không có trong danh sách.
    AI_PRICES_PER_MTOK: str = "*=0.10:0.40,gemini-flash-lite-latest=0.10:0.40,gemini-3.1-flash-lite=0.10:0.40,gemini-3.5-flash=0.30:2.50,gemini-3.6-flash=0.30:2.50,gemini-embedding-001=0.15:0"

    # UC-01/UC-02 luồng 3a — Đăng nhập / đăng ký bằng Google (app/services/google_auth.py). OAuth Client ID loại
    # "Web application" tạo ở https://console.cloud.google.com/apis/credentials, "Authorized JavaScript origins" phải
    # có địa chỉ frontend (vd. http://localhost:5500). Chỉ cần Client ID (công khai, không phải bí mật), KHÔNG cần
    # Client Secret. Để trống = nút "Tiếp tục với Google" bị khoá kèm lời giải thích.
    GOOGLE_CLIENT_ID: str = ""

    # Lịch biểu (UC-26/31, database/schedule_schema.sql): giờ sự kiện lưu theo giờ địa phương (ngày +
    # phút trong ngày); "bây giờ" để tính/quét giờ nhắc lấy theo múi giờ này bằng Python — KHÔNG dùng
    # NOW() của MySQL (container chạy UTC).
    APP_TIMEZONE: str = "Asia/Ho_Chi_Minh"
    # Vòng quét nhắc lịch chạy nền trong process uvicorn (app/services/schedule_notifier.py); 0 = tắt
    # (thông báo trong app vẫn được tạo "lười" khi người dùng mở chuông, nhưng KHÔNG gửi email).
    SCHEDULER_INTERVAL_SECONDS: int = 30
    # Gửi email nhắc lịch (UC-31, app/services/mailer.py). Để trống SMTP_HOST = chưa cấu hình -> kênh
    # Email ghi 'skipped', không lỗi. Gmail: smtp.gmail.com, cổng 587 (STARTTLS), SMTP_PASSWORD là
    # "App Password" 16 ký tự (https://myaccount.google.com/apppasswords), KHÔNG phải mật khẩu Gmail.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""          # để trống = dùng SMTP_USER
    SMTP_USE_SSL: bool = False   # True cho cổng 465 (SSL ngay từ đầu), False = STARTTLS
    # Đường dẫn trang ứng dụng — nút "Mở Lịch biểu" trong email nhắc lịch trỏ tới đây
    APP_URL: str = "http://localhost:5500/html/ghichu.html"


settings = Settings()
