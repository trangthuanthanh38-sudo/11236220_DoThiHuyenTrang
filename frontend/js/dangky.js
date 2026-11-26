const stepInfo = document.getElementById("step-info");
const stepOtp = document.getElementById("step-otp");
const stepDone = document.getElementById("step-done");

function goTo(step) {
  stepInfo.hidden = step !== "info";
  stepOtp.hidden = step !== "otp";
  stepDone.hidden = step !== "done";
}

// --- toggle hiện/ẩn mật khẩu ---
document.getElementById("btn-eye1").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById("su-pass");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  btn.classList.toggle("is-shown", !showing);
});

// --- 6 ô OTP: gõ số tự nhảy ô kế, backspace tự lùi ---
const codeBoxes = [...document.querySelectorAll("#code-row .dc-code-box")];
codeBoxes.forEach((box, i) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/\D/g, "").slice(-1);
    if (box.value && i < codeBoxes.length - 1) codeBoxes[i + 1].focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && i > 0) codeBoxes[i - 1].focus();
  });
});
function readOtp() { return codeBoxes.map(b => b.value).join(""); }
function clearOtp() { codeBoxes.forEach(b => b.value = ""); codeBoxes[0].focus(); }

let registeredPhone = "";

// --- Bước 1 submit ---
const msgInfo = document.getElementById("msg-info");
const btnInfo = document.getElementById("btn-info");
stepInfo.addEventListener("submit", async (e) => {
  e.preventDefault();
  msgInfo.hidden = true;
  btnInfo.disabled = true;
  btnInfo.textContent = "Đang xử lý...";

  const phone = document.getElementById("su-phone").value.trim();
  const { ok, data } = await apiPost("/auth/register", {
    phone_number: phone,
    display_name: document.getElementById("su-name").value.trim(),
    password: document.getElementById("su-pass").value,
    confirm_password: document.getElementById("su-pass2").value,
  });

  btnInfo.disabled = false;
  btnInfo.textContent = "Tạo tài khoản";

  if (!ok) {
    showMessage(msgInfo, data.detail || "Đăng ký thất bại.", "error");
    return;
  }

  registeredPhone = phone;
  document.getElementById("otp-phone-label").textContent = phone;
  if (data.dev_otp) {
    showMessage(document.getElementById("msg-otp"), `[CHỈ DEV] Mã OTP: ${data.dev_otp}`, "hint");
    document.getElementById("msg-otp").hidden = false;
  }
  goTo("otp");
  codeBoxes[0].focus();
});

// --- Bước 2 submit ---
const msgOtp = document.getElementById("msg-otp");
const btnOtp = document.getElementById("btn-otp");
stepOtp.addEventListener("submit", async (e) => {
  e.preventDefault();
  const otp = readOtp();
  if (otp.length !== 6) {
    showMessage(msgOtp, "Vui lòng nhập đủ 6 số.", "error");
    return;
  }
  btnOtp.disabled = true;
  btnOtp.textContent = "Đang kiểm tra...";

  const { ok, data } = await apiPost("/auth/verify-otp", {
    phone_number: registeredPhone,
    otp_code: otp,
  });

  btnOtp.disabled = false;
  btnOtp.textContent = "Xác nhận";

  if (!ok) {
    showMessage(msgOtp, data.detail || "Xác thực thất bại.", "error");
    clearOtp();
    return;
  }
  goTo("done");
});

document.getElementById("link-resend").addEventListener("click", async (e) => {
  e.preventDefault();
  clearOtp();
  const { ok, data } = await apiPost("/auth/resend-otp", { phone_number: registeredPhone });
  showMessage(
    msgOtp,
    ok ? (data.dev_otp ? `[CHỈ DEV] Mã OTP mới: ${data.dev_otp}` : "Đã gửi lại mã OTP.") : (data.detail || "Gửi lại thất bại."),
    ok ? "hint" : "error"
  );
});

document.getElementById("link-back").addEventListener("click", (e) => {
  e.preventDefault();
  goTo("info");
});

document.getElementById("btn-done").addEventListener("click", () => {
  window.location.href = "dangnhap.html";
});
