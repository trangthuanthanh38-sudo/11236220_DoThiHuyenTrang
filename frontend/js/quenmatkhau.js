const COPY = [
  { title: "Xác minh số điện thoại", hint: "Nhập số điện thoại đã dùng để đăng ký, chúng tôi sẽ gửi mã xác thực qua SMS.", cta: "Gửi mã xác thực" },
  { title: "Nhập mã xác thực", hint: "Mã gồm 6 chữ số vừa được gửi tới ", cta: "Xác nhận" },
  { title: "Đặt mật khẩu mới", hint: "Mật khẩu mới cần khác mật khẩu cũ và dài ít nhất 8 ký tự.", cta: "Cập nhật mật khẩu" },
  { title: "Hoàn tất", hint: "", cta: "Về trang đăng nhập" },
];

let step = 0;
let phone = "";

const progressBars = [...document.querySelectorAll("#progress span")];
const stepPanels = [...document.querySelectorAll("[data-step]")];
const msg = document.getElementById("msg");
const btnNext = document.getElementById("btn-next");
const linkBack = document.getElementById("link-back");

function render() {
  stepPanels.forEach(p => { p.hidden = Number(p.dataset.step) !== step; });
  progressBars.forEach((b, i) => b.classList.toggle("is-active", i <= Math.min(step, 2)));
  document.getElementById("step-label").textContent = `Bước ${Math.min(step, 2) + 1} / 3`;
  const c = COPY[step];
  document.getElementById("step-title").textContent = c.title;
  document.getElementById("step-hint").textContent = step === 1 ? c.hint + phone + "." : c.hint;
  btnNext.textContent = c.cta;
  linkBack.textContent = (step === 0 || step === 3) ? "Quay lại đăng nhập" : "Quay lại bước trước";
  msg.hidden = true;
}
render();

// --- toggle hiện/ẩn mật khẩu ---
document.getElementById("btn-eye").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById("fp-new");
  const input2 = document.getElementById("fp-new2");
  const showing = input.type === "text";
  input.type = input2.type = showing ? "password" : "text";
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
function clearOtp() { codeBoxes.forEach(b => b.value = ""); }

document.getElementById("link-resend").addEventListener("click", async (e) => {
  e.preventDefault();
  clearOtp();
  const { ok, data } = await apiPost("/auth/forgot-password", { phone_number: phone });
  showMessage(msg, ok ? (data.dev_otp ? `[CHỈ DEV] Mã OTP mới: ${data.dev_otp}` : data.message) : (data.detail || "Gửi lại thất bại."), ok ? "hint" : "error");
});

linkBack.addEventListener("click", (e) => {
  e.preventDefault();
  if (step === 0 || step === 3) { window.location.href = "dangnhap.html"; return; }
  step -= 1;
  render();
});

document.getElementById("wizard").addEventListener("submit", async (e) => {
  e.preventDefault();
  btnNext.disabled = true;

  if (step === 0) {
    phone = document.getElementById("fp-phone").value.trim();
    if (!phone) { showMessage(msg, "Vui lòng nhập số điện thoại.", "error"); btnNext.disabled = false; return; }
    btnNext.textContent = "Đang gửi...";
    const { ok, data } = await apiPost("/auth/forgot-password", { phone_number: phone });
    btnNext.disabled = false;
    if (!ok) { showMessage(msg, data.detail || "Có lỗi xảy ra.", "error"); return; }
    step = 1; render();
    if (data.dev_otp) showMessage(msg, `[CHỈ DEV] Mã OTP: ${data.dev_otp}`, "hint");
    codeBoxes[0].focus();
    return;
  }

  if (step === 1) {
    const otp = readOtp();
    btnNext.disabled = false;
    if (otp.length !== 6) { showMessage(msg, "Vui lòng nhập đủ 6 số.", "error"); return; }
    // OTP được xác nhận thật khi đặt mật khẩu mới ở bước 3 (BE gộp verify+reset làm 1 lượt).
    window.__otp = otp;
    step = 2; render();
    return;
  }

  if (step === 2) {
    const newPass = document.getElementById("fp-new").value;
    const newPass2 = document.getElementById("fp-new2").value;
    btnNext.textContent = "Đang cập nhật...";
    const { ok, data } = await apiPost("/auth/reset-password", {
      phone_number: phone,
      otp_code: window.__otp || "",
      new_password: newPass,
      confirm_password: newPass2,
    });
    btnNext.disabled = false;
    btnNext.textContent = COPY[2].cta;
    if (!ok) {
      showMessage(msg, (data.detail || "Đặt lại mật khẩu thất bại.") + " Nhấn \"Quay lại bước trước\" để kiểm tra lại mã OTP.", "error");
      return;
    }
    step = 3; render();
    return;
  }

  if (step === 3) {
    window.location.href = "dangnhap.html";
  }
});
