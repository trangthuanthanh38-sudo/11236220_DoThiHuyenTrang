"""Gửi email qua SMTP — hàm DUY NHẤT trong codebase gửi mail thật (nhắc lịch UC-31).

Cấu hình qua settings.SMTP_* (xem .env.example). Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587 (STARTTLS),
SMTP_USER = Gmail gửi, SMTP_PASSWORD = "App Password" 16 ký tự (https://myaccount.google.com/apppasswords — tài
khoản phải bật Xác minh 2 bước), KHÔNG phải mật khẩu Gmail. Chưa cấu hình (SMTP_HOST trống) thì `is_configured()`
trả False để nơi gọi ghi kênh Email là 'skipped' thay vì lỗi. Lỗi gửi được raise ra cho nơi gọi tự ghi 'failed' +
thử lại (UC-31 E1); `describe_error()` dịch lỗi sang câu tiếng Việt để lưu vào notification_deliveries.last_error.

Gửi thử bằng tay (sau khi điền .env):  python -m app.services.mailer email-nhan@gmail.com
"""
import smtplib
import socket
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from app.config import settings

_TIMEOUT_SECONDS = 15


def is_configured() -> bool:
    return bool(settings.SMTP_HOST.strip() and (settings.SMTP_FROM.strip() or settings.SMTP_USER.strip()))


def sender() -> str:
    """Địa chỉ "From". SMTP_FROM dạng "Tên <email>" hoặc chỉ email; trống thì dùng SMTP_USER."""
    raw = settings.SMTP_FROM.strip() or settings.SMTP_USER.strip()
    name, addr = parseaddr(raw)
    return formataddr((name, addr)) if name else addr


def send_email(to: str, subject: str, text_body: str, html_body: str | None = None) -> None:
    msg = EmailMessage()
    msg["From"] = sender()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    context = ssl.create_default_context()
    if settings.SMTP_USE_SSL:
        server = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=_TIMEOUT_SECONDS, context=context)
    else:
        server = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=_TIMEOUT_SECONDS)
    with server:
        if not settings.SMTP_USE_SSL:
            server.starttls(context=context)
        if settings.SMTP_USER:
            # App Password Google hiển thị có dấu cách ("abcd efgh ...") — bỏ đi cho chắc
            try:
                server.login(settings.SMTP_USER, settings.SMTP_PASSWORD.replace(" ", ""))
            except smtplib.SMTPServerDisconnected as exc:
                # Đo thật: Gmail ĐÓNG kết nối (không trả 535) khi tài khoản/mật khẩu sai -> coi là lỗi đăng nhập
                raise smtplib.SMTPAuthenticationError(535, b"Server closed the connection during login") from exc
        server.send_message(msg)


def describe_error(exc: Exception) -> str:
    """Lỗi SMTP -> câu tiếng Việt ngắn (lưu vào last_error, in ra ở lệnh gửi thử)."""
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return ("Sai Gmail hoặc App Password — SMTP_PASSWORD phải là App Password 16 ký tự "
                "(myaccount.google.com/apppasswords), không phải mật khẩu Gmail.")
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        return "Địa chỉ email nhận không hợp lệ hoặc bị máy chủ thư từ chối."
    if isinstance(exc, smtplib.SMTPSenderRefused):
        return "Địa chỉ gửi (SMTP_FROM/SMTP_USER) bị từ chối — Gmail chỉ cho gửi từ chính tài khoản đăng nhập."
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return f"Hết thời gian chờ kết nối tới {settings.SMTP_HOST}:{settings.SMTP_PORT}."
    if isinstance(exc, (socket.gaierror, ConnectionError, OSError)) and not isinstance(exc, smtplib.SMTPException):
        return f"Không kết nối được {settings.SMTP_HOST}:{settings.SMTP_PORT} ({exc})."
    return f"Lỗi gửi email: {exc}"[:500]


def status_line() -> str:
    if not is_configured():
        return "Email nhắc lịch: CHƯA cấu hình SMTP trong backend/.env — kênh Email sẽ được bỏ qua."
    return f"Email nhắc lịch: gửi qua {settings.SMTP_HOST}:{settings.SMTP_PORT} từ {sender()}."


if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        print("Cách dùng: python -m app.services.mailer email-nhan@gmail.com")
        sys.exit(2)
    print(status_line())
    if not is_configured():
        sys.exit(1)
    to = sys.argv[1]
    try:
        send_email(
            to,
            "Thư thử — AI Studio Tri Thức",
            "Nếu bạn đọc được thư này, cấu hình gửi email nhắc lịch đã hoạt động.",
            "<p>Nếu bạn đọc được thư này, cấu hình gửi email nhắc lịch của <b>AI Studio Tri Thức</b> đã hoạt động.</p>",
        )
    except Exception as exc:  # noqa: BLE001
        print("THẤT BẠI:", describe_error(exc))
        sys.exit(1)
    print(f"ĐÃ GỬI tới {to} — kiểm tra hộp thư (và cả mục Spam).")
