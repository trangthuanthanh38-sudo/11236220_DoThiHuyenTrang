"""Endpoint kiểm tra tình trạng kết nối Database (bước "Kết nối Backend với Database").

Không thuộc UC nghiệp vụ nào trong .claude/rules/ — đây là hạ tầng kỹ thuật thuần tuý
để xác nhận backend nối đúng tới MySQL (qua app/database.py + DATABASE_URL trong .env)
trước khi build tiếp các API nghiệp vụ. Endpoint /health (không tiền tố /api, xem
app/main.py) chỉ trả "server đang chạy"; /api/health/db bên dưới trả đúng "server có
nói chuyện được với Database không" bằng cách thực sự chạy 1 câu SELECT.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.deps import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("/db")
def check_database_connection(db: Session = Depends(get_db)) -> dict:
    """Chạy `SELECT 1` thật qua Session hiện có để xác nhận kết nối + quyền truy vấn.

    Không chỉ kiểm tra "mở được TCP socket tới MySQL" mà kiểm tra đúng đường đi
    Backend -> SQLAlchemy Engine -> Database mà mọi endpoint nghiệp vụ khác đang dùng
    (cùng SessionLocal ở app/database.py) — nếu endpoint này OK thì các router khác
    (auth/profile/knowledge) chắc chắn kết nối DB được.
    """
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        # Không trả chi tiết lỗi driver (có thể lộ host/user/tên DB) ra client — chỉ log
        # phía server để dev tự xem, trả về client một thông điệp chung chung.
        logger.exception("Health check thất bại: không kết nối được Database.")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Không thể kết nối tới Database. Kiểm tra lại DATABASE_URL trong .env và MySQL container.",
        )
    return {"status": "ok", "database": "connected"}
