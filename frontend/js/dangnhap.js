const btnEye = document.getElementById("btn-eye");
const passInput = document.getElementById("password");
btnEye.addEventListener("click", () => {
  const showing = passInput.type === "text";
  passInput.type = showing ? "password" : "text";
  btnEye.classList.toggle("is-shown", !showing);
  btnEye.setAttribute("aria-label", showing ? "Hiện mật khẩu" : "Ẩn mật khẩu");
});

const form = document.getElementById("form-login");
const msg = document.getElementById("msg");
const btn = document.getElementById("btn-submit");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.hidden = true;
  btn.disabled = true;
  btn.textContent = "Đang đăng nhập...";

  const { ok, data } = await apiPost("/auth/login", {
    phone_number: document.getElementById("phone").value.trim(),
    password: passInput.value,
  });

  btn.disabled = false;
  btn.textContent = "Đăng nhập";

  if (!ok) {
    showMessage(msg, data.detail || "Đăng nhập thất bại.", "error");
    if (data.err && data.err.code === "must_reset_password") {   // UC-32 "Buộc đặt lại mật khẩu" -> UC-04
      const a = document.createElement("a");
      a.href = "quenmatkhau.html";
      a.textContent = " Đặt lại mật khẩu ngay";
      msg.appendChild(a);
    }
    return;
  }

  localStorage.setItem("access_token", data.access_token);
  localStorage.setItem("refresh_token", data.refresh_token);
  clearStudioResume();
  showMessage(msg, `Đăng nhập thành công. Xin chào ${data.user.display_name}! Đang chuyển hướng...`, "success");
  // UC-01 bước 6: điều hướng theo role — admin vào Admin Console
  setTimeout(() => { window.location.href = data.user.role === "admin" ? "admin.html" : "ghichu.html"; }, 900);
});
