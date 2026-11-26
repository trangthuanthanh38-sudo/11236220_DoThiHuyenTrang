// Helper dùng chung cho các trang dangky/dangnhap/quenmatkhau.
// (Bước xác thực OTP nằm ngay trong dangky.html — không còn trang xacthucotp.html riêng.)
// Gói lỗi backend (FastAPI trả {"detail": "..."}) thành 1 dạng {ok, status, data} thống nhất.
// Lỗi có cấu trúc (hạn mức UC-33: {"detail": {"message", "code", ...}}) -> data.detail = message (mọi chỗ cũ vẫn hiện
// đúng chuỗi), bản đầy đủ ở data.err (vd. data.err.code === "storage_full" / "ai_limit" / "account_locked").
function normDetail(data) {
  if (data && data.detail && typeof data.detail === "object" && !Array.isArray(data.detail) && data.detail.message) {
    data.err = data.detail;
    data.detail = data.detail.message;
  }
  return data;
}

async function apiPost(path, body) {
  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = normDetail(await res.json().catch(() => ({})));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { detail: "Không kết nối được tới server (" + API_BASE + "). Backend đã chạy chưa?" } };
  }
}

async function apiGet(path, token) {
  try {
    const res = await fetch(API_BASE + path, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    const data = normDetail(await res.json().catch(() => ({})));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { detail: "Không kết nối được tới server (" + API_BASE + ")." } };
  }
}

// Dùng cho các endpoint cần JWT (UC-06->09: /users/me/...) với method bất kỳ
// (GET/PUT/POST). `body` bỏ qua nếu undefined (vd. GET không cần body). `signal` (tuỳ chọn,
// AbortController.signal) để người gọi ngừng chờ — bị huỷ thì trả {aborted: true, status: 0}.
async function apiAuth(method, path, token, body, signal) {
  try {
    const opts = { method: method, headers: { Authorization: "Bearer " + token }, cache: "no-store" };
    if (signal) opts.signal = signal;
    // Review > Password: Chương có mật khẩu đã mở khoá -> gửi kèm khoá mở (ghichu_core.js state.chapterKeys).
    const cm = /^\/chapters\/([^/?]+)/.exec(path);
    if (cm && window.tdChapterKeys && window.tdChapterKeys[cm[1]]) opts.headers["X-Chapter-Key"] = window.tdChapterKeys[cm[1]];
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API_BASE + path, opts);
    const data = normDetail(await res.json().catch(() => ({})));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, status: 0, aborted: true, data: {} };
    return { ok: false, status: 0, data: { detail: "Không kết nối được tới server (" + API_BASE + ")." } };
  }
}

// Upload multipart/form-data (vd. tải PDF lên chương — mở rộng UC-16) kèm JWT. KHÔNG tự
// set Content-Type: để trình duyệt tự sinh boundary đúng cho FormData.
async function apiUpload(path, token, formData) {
  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: formData,
    });
    const data = normDetail(await res.json().catch(() => ({})));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { detail: "Không kết nối được tới server (" + API_BASE + ")." } };
  }
}

// Tải file nhị phân kèm JWT (vd. GET /pdf/{id}/file) — không gắn được header Authorization
// vào <img>/<iframe> src, nên phải tự fetch rồi tạo blob URL phía gọi.
async function apiAuthBlob(path, token) {
  try {
    const res = await fetch(API_BASE + path, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) return { ok: false, status: res.status, blob: null };
    const blob = await res.blob();
    return { ok: true, status: res.status, blob: blob };
  } catch (err) {
    return { ok: false, status: 0, blob: null };
  }
}

function showMessage(el, text, kind) {
  // kind: "error" | "success" | "hint"
  el.textContent = text;
  // 2 bộ class: dc-msg-- (trang dangnhap/dangky/quenmatkhau, auth-style.css) và form-msg-- (modal Hồ sơ/Cài đặt
  // trong ghichu.html, ghichu_giaodien.css) — trước đây chỉ có form-msg nên thông báo ở trang đăng nhập không có màu.
  el.className = "dc-msg dc-msg--" + kind + " form-msg form-msg--" + kind;
  el.hidden = false;
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Vừa đăng nhập xong -> vào thẳng trang soạn thảo: xoá dấu "đang dở" của các công cụ Studio (Ôn tập, Thi thử, Flashcard,
// Sơ đồ, Tóm tắt, Lịch biểu, Thống kê) để ghichu.html không tự mở lại công cụ của phiên trước. F5 khi đã ở trong trang
// vẫn mở lại đúng chỗ như cũ (các key này chỉ bị xoá ở bước đăng nhập).
function clearStudioResume() {
  ["td_ontap_resume", "td_thithu_resume", "td_fc_resume", "td_mm_resume", "td_ts_resume", "td_lb_resume", "td_tk_resume",
   "td_hm_resume"]
    .forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
}
