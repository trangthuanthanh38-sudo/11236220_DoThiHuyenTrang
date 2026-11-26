"""UC-30 Đưa ra nhận xét & biện pháp khắc phục — gọi Gemini 1 lượt trên số liệu đã tính sẵn (services/stats.py).

- E1 (dữ liệu quá ít) kiểm ở router TRƯỚC khi gọi hàm này: không tốn lượt AI.
- Dùng lại `_call_llm` của quiz_generation (chuỗi QUIZ_MODEL dự phòng, JSON ép khuôn bằng response_schema).
- Đề xuất hành động có CẤU TRÚC (môn, số buổi, phút/buổi) để "Thêm đề xuất vào Lịch biểu" tạo được schedule_items
  thật; tên môn AI trả về được đối chiếu lại với Môn của người học (không khớp -> đề xuất không gắn môn, không thêm
  được vào lịch).
"""
from __future__ import annotations

from google import genai
from pydantic import BaseModel

from app.config import settings
from app.services.quiz_generation import _call_llm

_MAX_ITEMS = 3


class _Act(BaseModel):
    subject: str
    sessions: int
    minutes: int
    text: str


class _GenReview(BaseModel):
    good: list[str]
    bad: list[str]
    act: list[_Act]


_SYSTEM_PROMPT = (
    "Bạn là cố vấn học tập cho sinh viên Việt Nam. Bạn nhận SỐ LIỆU THỐNG KÊ học tập của 1 kỳ và viết nhận xét "
    "ngắn gọn, cụ thể, bằng tiếng Việt, xưng 'bạn'. CHỈ dựa vào số liệu được cung cấp — không bịa thêm môn, điểm, "
    "con số hay sự kiện nào. Trả về JSON gồm:\n"
    "- good: đúng 3 câu về điểm mạnh (môn/kỹ năng làm tốt), mỗi câu có con số cụ thể;\n"
    "- bad: đúng 3 câu về điểm cần cải thiện (môn điểm thấp, tỷ lệ nhớ thấp, thẻ chưa thuộc nhiều, học ít);\n"
    "- act: đúng 3 đề xuất hành động cho TUẦN TỚI. Mỗi đề xuất có subject = tên môn CHÍNH XÁC trong danh sách môn, "
    "sessions = số buổi trong tuần (1-5), minutes = phút mỗi buổi (15-90), text = 1 câu hành động cụ thể "
    "(vd. 'Ôn Flashcard môn X 4 buổi, mỗi buổi 20 phút').\n"
    "Mỗi câu tối đa 30 từ. Không dùng markdown."
)


def _fmt(x, kind: str) -> str:
    if x is None:
        return "chưa có"
    if kind == "score":
        return f"{x:.1f}/10"
    if kind == "pct":
        return f"{round(x * 100)}%"
    return f"{round(x)} phút"


def build_prompt(m: dict, prev: dict | None) -> str:
    lines = [
        f"Kỳ: {m['from']} đến {m['to']} ({m['len']} ngày).",
        f"Số ngày học: {m['active_days']}/{m['len']}. Chuỗi ngày học hiện tại: {m['streak']} ngày.",
        f"Tổng thời gian học: {_fmt(m['minutes'], 'min')}"
        + (f" (kỳ trước: {_fmt(prev['minutes'], 'min')})" if prev else "") + ".",
        f"Lượt làm bài: {m['practice_count']} ôn tập, {m['exam_count']} thi thử; điểm TB {_fmt(m['q_avg'], 'score')}"
        + (f" (kỳ trước {_fmt(prev['q_avg'], 'score')})" if prev else "") + ".",
        f"Ôn thẻ: {m['rev']} lượt, tỷ lệ nhớ {_fmt(m['recall'], 'pct')}"
        + (f" (kỳ trước {_fmt(prev['recall'], 'pct')})" if prev else "") + ".",
        f"Thẻ hiện tại: {m['cards']['mastered']} đã thuộc, {m['cards']['learning']} đang học, {m['cards']['new']} chưa ôn "
        f"(tổng {m['cards']['total']}).",
        "Theo môn:",
    ]
    for s in m["by_subject"].values():
        sets = "; ".join(
            f"'{x['title']}' cao nhất {max(x['scores']):.1f}" for x in s["sets"]
        )
        lines.append(
            f"- {s['name']}: học {_fmt(s['minutes'], 'min')}, {s['attempts']} lượt làm bài (điểm TB {_fmt(s['q_avg'], 'score')}), "
            f"{s['rev']} lượt ôn thẻ (nhớ {_fmt(s['recall'], 'pct')}), điểm năng lực "
            f"{_fmt(s['cap'], 'score') if s['eligible'] else 'chưa đủ dữ liệu'}" + (f". Bộ đã làm: {sets}" if sets else "")
        )
    lines.append("Danh sách môn hợp lệ cho act.subject: " + ", ".join(s["name"] for s in m["by_subject"].values()))
    return "\n".join(lines)


def generate_review(m: dict, prev: dict | None) -> tuple[dict | None, str | None, str | None]:
    """(kết quả {good, bad, act[{subject_id, subject_name, sessions, minutes, text}]}, model, lỗi)."""
    if not settings.GEMINI_API_KEY:
        return None, None, "Chưa cấu hình GEMINI_API_KEY nên chưa tạo được nhận xét."
    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    parsed, model, error = _call_llm(client, build_prompt(m, prev), _GenReview, _SYSTEM_PROMPT)
    if parsed is None:
        return None, None, error
    by_name = {s["name"].strip().lower(): s for s in m["by_subject"].values()}

    def clean(items):
        return [x.strip() for x in items if x and x.strip()][:_MAX_ITEMS]

    acts = []
    for a in parsed.act[:_MAX_ITEMS]:
        s = by_name.get((a.subject or "").strip().lower())
        acts.append({
            "subject_id": s["id"] if s else None,
            "subject_name": s["name"] if s else (a.subject or "").strip() or None,
            "sessions": max(1, min(5, a.sessions)),
            "minutes": max(15, min(90, a.minutes)),
            "text": a.text.strip(),
        })
    return {"good": clean(parsed.good), "bad": clean(parsed.bad), "act": acts}, model, None
