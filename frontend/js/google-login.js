// Nút "Tiếp tục với Google" ở dangnhap.html và dangky.html — UC-01 / UC-02 luồng 3a.
// Giữ đúng nút tự thiết kế của trang; bấm vào mở popup chọn tài khoản của Google Identity Services
// (google.accounts.oauth2 token client, scope "openid email profile") -> nhận access token -> POST /auth/google.
// Backend tự xác minh token với Google (đúng Client ID của app) rồi đăng nhập; tài khoản Google chưa có thì tạo
// mới luôn (không báo "tài khoản không tồn tại"), nên đăng nhập và đăng ký bằng Google là CÙNG 1 luồng.
// Client ID lấy từ GET /auth/google/config (backend/.env GOOGLE_CLIENT_ID) — chưa cấu hình thì bấm nút sẽ hiện
// lời giải thích thay vì im lặng.
// Cần: config.js (API_BASE), auth-client.js (apiGet/apiPost/showMessage), thẻ
// <script src="https://accounts.google.com/gsi/client" async defer> và nút #btn-google có data-msg="<id ô thông báo>".
(function () {
  const btn = document.getElementById("btn-google");
  if (!btn) return;
  const msg = document.getElementById(btn.dataset.msg);
  const label = btn.querySelector(".dc-google-label");
  const LABEL = label ? label.textContent : "";
  let tokenClient = null;
  let notReady = "Đang tải đăng nhập Google, vui lòng thử lại sau giây lát.";

  function setBusy(busy) {
    btn.disabled = busy;
    if (label) label.textContent = busy ? "Đang kết nối Google..." : LABEL;
  }

  // Thư viện Google tải async — đợi tối đa 10 giây
  function waitForGis() {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - t0 > 10000) return reject(new Error("timeout"));
        setTimeout(poll, 100);
      })();
    });
  }

  async function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) {
      setBusy(false);
      showMessage(msg, "Đăng nhập Google bị huỷ hoặc không thành công.", "error");
      return;
    }
    const { ok, data } = await apiPost("/auth/google", { access_token: resp.access_token });
    if (!ok) {
      setBusy(false);
      showMessage(msg, data.detail || "Đăng nhập Google thất bại.", "error");
      return;
    }
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);
    clearStudioResume();
    showMessage(
      msg,
      data.is_new
        ? `Đã tạo tài khoản bằng Google. Xin chào ${data.user.display_name}! Đang chuyển hướng...`
        : `Đăng nhập thành công. Xin chào ${data.user.display_name}! Đang chuyển hướng...`,
      "success",
    );
    setTimeout(() => { window.location.href = data.user.role === "admin" ? "admin.html" : "ghichu.html"; }, 900);
  }

  async function init() {
    const { ok, data } = await apiGet("/auth/google/config");
    if (!ok) { notReady = data.detail || "Không kết nối được tới server."; return; }
    if (!data.enabled) {
      notReady = "Máy chủ chưa bật đăng nhập Google (thiếu GOOGLE_CLIENT_ID trong backend/.env). Vui lòng dùng số điện thoại.";
      return;
    }
    try {
      await waitForGis();
    } catch (e) {
      notReady = "Không tải được thư viện đăng nhập của Google. Kiểm tra kết nối mạng rồi tải lại trang.";
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: data.client_id,
      scope: "openid email profile",
      callback: onToken,
      error_callback: (err) => {
        setBusy(false);
        if (err && err.type === "popup_closed") return;   // người dùng tự đóng cửa sổ
        showMessage(msg, err && err.type === "popup_failed_to_open"
          ? "Trình duyệt chặn cửa sổ đăng nhập Google. Hãy cho phép popup cho trang này rồi thử lại."
          : "Không mở được cửa sổ đăng nhập Google.", "error");
      },
    });
  }

  btn.addEventListener("click", () => {
    if (msg) msg.hidden = true;
    if (!tokenClient) { showMessage(msg, notReady, "error"); return; }
    setBusy(true);
    tokenClient.requestAccessToken({ prompt: "select_account" });
  });

  init();
})();
