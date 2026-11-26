# Nền tảng Quản lý Tri thức Học tập tích hợp AI Studio (RAG) cho Sinh viên

Ứng dụng web gồm: trình soạn thảo ghi chú kiểu Word (Môn học → Chương, PDF), AI Studio
(Hỏi đáp có trích dẫn, Ôn tập, Thi thử, Flashcard, Tóm tắt, Sơ đồ tư duy), Lịch biểu,
Thống kê và Admin Console.

## Yêu cầu

- Docker Desktop (chạy MySQL 8.0)
- Python 3.11+
- (Tuỳ chọn) Tesseract OCR để đọc PDF scan / ảnh: `winget install tesseract-ocr.tesseract`
  — gói ngôn ngữ đã có sẵn trong `backend/tessdata/`

## Cách chạy

**1. Cơ sở dữ liệu** (tự nạp toàn bộ schema trong `database/` ở lần chạy đầu):

```
docker compose up -d
```

**2. Backend (FastAPI):**

```
cd backend
py -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

Mở `backend/.env` và điền:
- `GEMINI_API_KEY` — khoá Google Gemini (https://aistudio.google.com/apikey) để dùng các tính năng AI.
  Để trống thì app vẫn chạy nhưng AI trả lời câu mặc định.
- `JWT_SECRET` — đổi thành chuỗi ngẫu nhiên.
- (Tuỳ chọn) `SMTP_USER` / `SMTP_PASSWORD` để gửi email nhắc lịch, `GOOGLE_CLIENT_ID` để đăng nhập bằng Google.

Swagger UI: http://localhost:8000/docs

**3. Frontend (tĩnh, không cần build):**

```
cd frontend
py -m http.server 5500
```

Mở http://localhost:5500/html/index.html

Nếu backend không chạy ở `localhost:8000`, sửa `API_BASE` trong `frontend/js/config.js`.

## Tạo tài khoản quản trị

Đăng ký 1 tài khoản bình thường, rồi trong thư mục `backend` (đã activate venv):

```
python -m app.scripts.make_admin <SĐT hoặc Gmail>
```

## Ghi chú

- OTP SMS đang ở chế độ giả lập: mã OTP được in ra log của uvicorn.
- Reset dữ liệu: `docker compose down -v` rồi `docker compose up -d`.
