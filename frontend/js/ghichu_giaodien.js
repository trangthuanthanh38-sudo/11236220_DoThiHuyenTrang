/* ======================================================================
   ghichu_giaodien.js — MODULE 2: Hồ sơ cá nhân (UC-06), Cài đặt tài khoản
   (Giao diện sáng/tối UC-09, Đổi SĐT UC-07, Đổi mật khẩu UC-08), popover
   tài khoản cuối sidebar (Hồ sơ/Cài đặt/Trợ giúp/Đăng xuất) — mọi modal/
   menu liên quan tới TÀI KHOẢN người dùng và logic UI/API tương ứng
   (backend/app/routers/profile.py, /users/me/*).

   Chỉ import từ ghichu_core.js — không phụ thuộc ghichu_soanthao.js hay
   ghichu_chucnangcacthe.js (đổi hồ sơ/cài đặt không đụng gì tới nội dung
   đang soạn hay PDF đang xem).
   ====================================================================== */
import { hooks, state, $, el, esc, authToken, authRefreshToken, isOnline } from "./ghichu_core.js";

/* UC-06 -> UC-09: hồ sơ & cài đặt cá nhân thật, nối API /users/me/*. Nếu trang mở khi CHƯA
   đăng nhập (không có access_token — vd. mở trực tiếp để xem UI) hoặc backend không chạy,
   trang vẫn hoạt động ở "chế độ mẫu" với CURRENT_USER_FALLBACK, giữ đúng hành vi cũ trước khi
   nối API. Hệ thống này định danh bằng SĐT chứ không có Email (BR-02) nên popover hiển thị
   SĐT thay cho email. */
var CURRENT_USER_FALLBACK = { name: "Trần Dương", phone: "0912 345 678" };
// Hồ sơ thật tải từ GET /users/me/profile — null nếu chưa đăng nhập hoặc chưa tải xong.
var profile = null;

function currentDisplayName() { return (profile && profile.display_name) || CURRENT_USER_FALLBACK.name; }
function isGoogleAccount() { return !!(profile && profile.auth_provider === "google"); }
// Tài khoản Google không có SĐT -> không mượn SĐT mẫu (popover hiện Gmail thay thế, Hồ sơ để trống ô SĐT)
function currentDisplayPhone() {
  if (isGoogleAccount()) return profile.phone_number || "";
  return (profile && profile.phone_number) || CURRENT_USER_FALLBACK.phone;
}
function currentAccountSub() { return isGoogleAccount() ? (profile.google_email || "Tài khoản Google") : currentDisplayPhone(); }
function currentAvatarUrl() { return profile ? profile.avatar_url : null; }
// Tên + ảnh tài khoản cho module khác (Thống kê) qua hooks.currentUser.
export function currentUser() { return { name: currentDisplayName(), avatar: currentAvatarUrl() }; }

function initials(name) {
  var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Dùng chung cho avatar cuối sidebar, avatar trong popover tài khoản, và preview trong modal
// Hồ sơ (UC-06) — nếu URL ảnh lỗi/không tải được thì tự rơi về chữ tắt tên.
function setAvatarContent(elem, url, name) {
  var label = initials(name);
  elem.innerHTML = "";
  if (!url) { elem.textContent = label; return; }
  var img = document.createElement("img");
  img.src = url;
  img.alt = "";
  img.onerror = function () { elem.innerHTML = ""; elem.textContent = label; };
  elem.appendChild(img);
}

export function renderAccountBadge() {
  setAvatarContent($("btn-account"), currentAvatarUrl(), currentDisplayName());
}

/* ====================================================================
   Popover tài khoản (cuối sidebar) — Hồ sơ / Cài đặt / Trợ giúp / Đăng xuất
   ==================================================================== */
export function toggleAccountMenu(e) {
  e.stopPropagation();
  if (state.accountMenuOpen) { hooks.closeFloating(); return; }
  state.dd = null; state.menu = null; $("dd-panel").hidden = true; $("dd-panel").innerHTML = ""; $("ctx-menu").hidden = true;
  state.accountMenuOpen = true;
  renderAccountMenu();
}

var ACCOUNT_MENU_ICONS = {
  profile: '<circle cx="12" cy="8" r="3.6"></circle><path d="M4.5 20c1.4-4 4-6 7.5-6s6.1 2 7.5 6"></path>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"></path>',
  help: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.2a2.5 2.5 0 114 2c-.9.6-1.5 1.1-1.5 2.3"></path><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"></circle>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path>',
};
function accountMenuIcon(key) {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + ACCOUNT_MENU_ICONS[key] + "</svg>";
}

export function renderAccountMenu() {
  var box = $("account-menu");
  var btn = $("btn-account");
  btn.classList.toggle("on", state.accountMenuOpen);
  btn.setAttribute("aria-expanded", state.accountMenuOpen ? "true" : "false");
  if (!state.accountMenuOpen) { box.hidden = true; box.innerHTML = ""; return; }

  box.innerHTML =
    '<div class="account-menu-head">' +
      '<span class="avatar-badge avatar-badge--lg" id="account-menu-avatar"></span>' +
      '<div style="min-width:0">' +
        '<div class="account-menu-name">' + esc(currentDisplayName()) + "</div>" +
        '<div class="account-menu-sub">' + esc(currentAccountSub()) + "</div>" +
      "</div>" +
    "</div>" +
    '<div class="ctx-menu-sep"></div>' +
    '<button type="button" class="ctx-menu-item" id="acc-profile">' + accountMenuIcon("profile") + "Profile</button>" +
    '<button type="button" class="ctx-menu-item" id="acc-settings">' + accountMenuIcon("settings") + "Settings</button>" +
    '<button type="button" class="ctx-menu-item" id="acc-help">' + accountMenuIcon("help") + "Help</button>" +
    '<div class="ctx-menu-sep"></div>' +
    '<button type="button" class="ctx-menu-item danger" id="acc-logout">' + accountMenuIcon("logout") + "Sign Out</button>";
  setAvatarContent($("account-menu-avatar"), currentAvatarUrl(), currentDisplayName());

  var r = btn.getBoundingClientRect();
  box.hidden = false;
  box.style.visibility = "hidden";
  box.style.left = Math.max(8, r.left) + "px";
  box.style.top = "0px";
  var h = box.offsetHeight;
  box.style.top = Math.max(8, r.top - h - 8) + "px";
  box.style.visibility = "";

  $("acc-profile").addEventListener("click", function (e) { e.stopPropagation(); hooks.closeFloating(); openProfileModal(); });
  $("acc-settings").addEventListener("click", function (e) { e.stopPropagation(); hooks.closeFloating(); openSettingsModal("theme"); });
  $("acc-help").addEventListener("click", function (e) { e.stopPropagation(); hooks.closeFloating(); openInfoModalForHelp(); });
  $("acc-logout").addEventListener("click", function (e) {
    e.stopPropagation();
    hooks.closeFloating();
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    window.location.href = "dangnhap.html";
  });
}

// "Trợ giúp" trong popover tài khoản mở CÙNG modal Hướng dẫn nhanh với tab Help của ribbon
// (ghichu_chucnangcacthe.js) — hàm mở modal đó thuộc module kia; ghichu.js gán hàm thật vào
// đây một lần lúc khởi tạo để tránh vòng import ngược (xem initGiaodien()).
var openInfoModalForHelp = function () {};
export function setHelpOpener(fn) { openInfoModalForHelp = fn; }

/* ====================================================================
   UC-09 — Đổi giao diện sáng-tối
   ==================================================================== */
var THEME_STORAGE_KEY = "td_theme_pref"; // đọc bởi <script> đầu ghichu.html (chống nhấp nháy sáng->tối)
var themePref = "system"; // light | dark | system — LỰA CHỌN của người dùng (khác giá trị áp dụng thật)

function computeEffectiveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

// Áp dụng ngay client-side (UC-09 bước 2) + lưu cục bộ để lần mở trang sau (hoặc khi mất
// mạng — E1) vẫn giữ đúng lựa chọn, không chờ phản hồi máy chủ.
function applyTheme(pref) {
  themePref = pref;
  document.documentElement.setAttribute("data-theme", computeEffectiveTheme(pref));
  try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch (e) { /* E1: vẫn áp dụng tạm thời phía client */ }
}

// "Theo hệ thống": nếu OS đổi sáng/tối khi trang đang mở, phản ánh lại ngay.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
    if (themePref === "system") document.documentElement.setAttribute("data-theme", computeEffectiveTheme("system"));
  });
}

/* ====================================================================
   Modal Hồ sơ cá nhân (UC-06)
   ==================================================================== */
// Xuất ra để Lịch biểu (qua hooks.openProfile) mở Hồ sơ cho người dùng nhập email nhận nhắc.
export function openProfileModal() {
  $("profile-msg").hidden = true;
  $("profile-name").value = currentDisplayName();
  $("profile-avatar-url").value = currentAvatarUrl() || "";
  $("profile-school").value = (profile && profile.school_name) || "";
  $("profile-class").value = (profile && profile.class_name) || "";
  var google = isGoogleAccount();
  // Tên: tài khoản Google mặc định là tên Google; xoá trắng rồi Lưu -> quay về tên Google (backend tự điền)
  var gName = google ? (profile.google_name || "") : "";
  $("profile-name").placeholder = gName;
  $("profile-name-hint").hidden = !gName;
  $("profile-name-hint").textContent = gName ? "Defaults to your Google name (" + gName + "). Leave blank and Save to use your Google name again." : "";
  // SĐT: tài khoản Google đăng nhập bằng Gmail nên không có SĐT -> để trống
  $("profile-phone").value = currentDisplayPhone();
  $("profile-phone").placeholder = google ? "None — this account signs in with Google" : "";
  $("profile-phone-hint").textContent = google
    ? "Google accounts don't need a phone number."
    : 'Change your phone number in "Settings".';
  // Email nhận nhắc lịch: Google -> Gmail đăng nhập, khoá; SĐT -> tự nhập (user_settings.notify_email)
  $("profile-email").value = google ? (profile.google_email || "") : ((profile && profile.notify_email) || "");
  $("profile-email").disabled = google;
  $("profile-email-hint").textContent = google
    ? "Your Google account email — schedule reminders are sent to this address."
    : "Class, deadline and exam reminders will be sent to this email.";
  setAvatarContent($("profile-avatar-preview"), currentAvatarUrl(), currentDisplayName());
  $("profile-overlay").hidden = false;
}
function closeProfileModal() { $("profile-overlay").hidden = true; }

function submitProfileForm() {
  var name = $("profile-name").value.trim();
  var avatar = $("profile-avatar-url").value.trim();
  var school = $("profile-school").value.trim();
  var klass = $("profile-class").value.trim();
  var google = isGoogleAccount();
  var email = google ? null : $("profile-email").value.trim();
  var msg = $("profile-msg");

  if (!name && google && profile.google_name) name = profile.google_name;   // để trống -> tên Google
  if (!name) { showMessage(msg, "Display name can't be empty.", "error"); return; } // E2
  if (/[<>{}\\/"|]/.test(name)) { showMessage(msg, "Display name contains invalid characters.", "error"); return; } // E2
  if (avatar && !/^https?:\/\//i.test(avatar)) { // E1 (tinh thần BR-14 — không upload file, chỉ nhận đường dẫn)
    showMessage(msg, "Profile picture must be a URL starting with http:// or https://.", "error");
    return;
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showMessage(msg, "Notification email is not valid.", "error"); return; }

  var token = authToken();
  if (!token) {
    profile = profile || {};
    profile.display_name = name; profile.avatar_url = avatar || null;
    profile.school_name = school || null; profile.class_name = klass || null;
    profile.notify_email = email || null;
    CURRENT_USER_FALLBACK.name = name;
    renderAccountBadge();
    showMessage(msg, "Saved (preview mode — not signed in, so nothing was synced to the server).", "hint");
    return;
  }

  var btn = $("profile-save");
  btn.disabled = true;
  apiAuth("PUT", "/users/me/profile", token, {
    display_name: name, avatar_url: avatar || null, school_name: school || null, class_name: klass || null,
    notify_email: email || null,
  }).then(function (res) {
    btn.disabled = false;
    if (!res.ok) {
      var d = res.data.detail;
      showMessage(msg, Array.isArray(d) ? String((d[0] && d[0].msg) || "Invalid data.").replace(/^Value error, /, "") : (d || "Couldn't save your profile."), "error");
      return;
    }
    profile = res.data;
    hooks.onProfileSaved(profile); // Lịch biểu cập nhật email nhận nhắc
    renderAccountBadge();
    setAvatarContent($("profile-avatar-preview"), currentAvatarUrl(), currentDisplayName());
    showMessage(msg, "Profile saved.", "success"); // UC-06 bước 5
  });
}

/* ====================================================================
   Modal Cài đặt tài khoản — tab Giao diện (UC-09) / Đổi SĐT (UC-07) /
   Đổi mật khẩu (UC-08)
   ==================================================================== */
var settingsTab = "theme";        // theme | phone | password
var phoneChangeStage = "request"; // request | confirm — chỉ dùng trong tab "phone"

var THEME_OPTIONS = [
  { value: "light", label: "Sáng", icon: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"></path>' },
  { value: "dark", label: "Tối", icon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"></path>' },
  { value: "system", label: "Theo hệ thống", icon: '<rect x="3" y="4" width="18" height="12" rx="2" ry="2"></rect><path d="M8 20h8M12 16v4"></path>' },
];

function openSettingsModal(tab) {
  settingsTab = tab || "theme";
  phoneChangeStage = "request";
  $("settings-overlay").hidden = false;
  renderSettingsTabs();
  renderSettingsBody();
}
function closeSettingsModal() { $("settings-overlay").hidden = true; }

function renderSettingsTabs() {
  $("settings-tabs").querySelectorAll(".settings-tab").forEach(function (b) {
    b.classList.toggle("on", b.getAttribute("data-tab") === settingsTab);
  });
}

function switchSettingsTab(tab) {
  settingsTab = tab;
  phoneChangeStage = "request";
  renderSettingsTabs();
  renderSettingsBody();
}

function renderSettingsBody() {
  if (settingsTab === "theme") { $("settings-body").innerHTML = themePanelHtml(); bindThemePanel(); return; }
  if (settingsTab === "phone") { $("settings-body").innerHTML = phonePanelHtml(); bindPhonePanel(); return; }
  $("settings-body").innerHTML = passwordPanelHtml();
  bindPasswordPanel();
}

function themePanelHtml() {
  return '<div class="theme-options">' + THEME_OPTIONS.map(function (o) {
    return '<button type="button" class="theme-option' + (themePref === o.value ? " on" : "") + '" data-theme-opt="' + o.value + '">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + o.icon + "</svg>" +
      "<span>" + esc(o.label) + "</span></button>";
  }).join("") + "</div>" +
    '<div class="form-msg form-msg--hint" id="theme-msg" hidden></div>';
}

function bindThemePanel() {
  $("settings-body").querySelectorAll("[data-theme-opt]").forEach(function (b) {
    b.addEventListener("click", function () {
      var pref = b.getAttribute("data-theme-opt");
      applyTheme(pref);
      renderSettingsBody(); // vẽ lại ngay để phản ánh lựa chọn mới (đồng thời tạo lại #theme-msg)
      var token = authToken();
      var justApplied = $("theme-msg");
      if (!token) { showMessage(justApplied, "Đã áp dụng trên máy này (chưa đăng nhập nên chưa đồng bộ máy chủ).", "hint"); return; }
      apiAuth("PUT", "/users/me/theme", token, { theme: pref }).then(function (res) {
        var m = $("theme-msg"); // truy vấn lại theo id: null nếu người dùng đã chuyển sang tab khác
        if (!m) return;
        if (!res.ok) { showMessage(m, "Lưu lên máy chủ thất bại — vẫn áp dụng tạm thời trên máy này.", "error"); return; } // E1
        if (profile) profile.theme = pref;
        showMessage(m, "Đã lưu.", "success");
      });
    });
  });
}

function phonePanelHtml() {
  if (!authToken()) return '<div class="form-msg form-msg--hint">Vui lòng đăng nhập để đổi số điện thoại.</div>';
  if (profile && profile.auth_provider === "google") {
    return '<div class="form-msg form-msg--hint">Tài khoản Google không dùng SĐT để đăng nhập.</div>';
  }
  if (phoneChangeStage === "confirm") {
    return '<div class="form-msg" id="phone-msg" hidden></div>' +
      '<p class="form-hint" style="margin:-2px 0 14px">Đã gửi mã OTP tới số điện thoại mới. Nhập mã để xác nhận.</p>' +
      '<div class="form-field"><label class="form-label" for="phone-otp">Mã OTP (6 số)</label>' +
      '<input type="text" class="form-input" id="phone-otp" maxlength="6" inputmode="numeric" autocomplete="off"></div>' +
      '<div class="settings-panel-actions">' +
      '<button type="button" class="btn-plain" id="phone-back">Nhập lại số khác</button>' +
      '<button type="button" class="btn-solid" id="phone-confirm-btn">Xác nhận đổi SĐT</button>' +
      "</div>";
  }
  return '<div class="form-msg" id="phone-msg" hidden></div>' +
    '<div class="form-field"><label class="form-label">Số hiện tại</label><input type="text" class="form-input" value="' + esc(currentDisplayPhone()) + '" disabled></div>' +
    '<div class="form-field"><label class="form-label" for="phone-new">Số điện thoại mới</label><input type="text" class="form-input" id="phone-new" placeholder="0xxxxxxxxx" autocomplete="off"></div>' +
    '<div class="form-field"><label class="form-label" for="phone-password">Mật khẩu hiện tại</label><input type="password" class="form-input" id="phone-password" autocomplete="current-password"></div>' +
    '<div class="settings-panel-actions"><button type="button" class="btn-solid" id="phone-request-btn">Gửi mã OTP</button></div>';
}

function bindPhonePanel() {
  if (phoneChangeStage === "confirm") {
    var back = $("phone-back"), confirmBtn = $("phone-confirm-btn"), otp = $("phone-otp");
    if (!confirmBtn) return; // tài khoản Google / chưa đăng nhập -> panel chỉ có form-msg, không có nút
    back.addEventListener("click", function () { phoneChangeStage = "request"; renderSettingsBody(); });
    confirmBtn.addEventListener("click", submitPhoneConfirm);
    otp.addEventListener("keydown", function (e) { if (e.key === "Enter") submitPhoneConfirm(); });
    return;
  }
  var reqBtn = $("phone-request-btn");
  if (!reqBtn) return;
  reqBtn.addEventListener("click", submitPhoneRequest);
  $("phone-password").addEventListener("keydown", function (e) { if (e.key === "Enter") submitPhoneRequest(); });
}

function submitPhoneRequest() {
  var newPhone = $("phone-new").value.trim();
  var pwd = $("phone-password").value;
  var msg = $("phone-msg");
  if (!newPhone || !pwd) { showMessage(msg, "Vui lòng nhập đủ số điện thoại mới và mật khẩu hiện tại.", "error"); return; }
  var btn = $("phone-request-btn");
  btn.disabled = true;
  apiAuth("POST", "/users/me/phone/request-otp", authToken(), { new_phone_number: newPhone, current_password: pwd }).then(function (res) {
    btn.disabled = false;
    if (!res.ok) { showMessage(msg, res.data.detail || "Không gửi được mã OTP.", "error"); return; } // E1/E2
    phoneChangeStage = "confirm";
    renderSettingsBody();
    var hint = res.data.dev_otp ? " (DEV: mã là " + res.data.dev_otp + ")" : "";
    showMessage($("phone-msg"), "Đã gửi mã OTP tới số điện thoại mới." + hint, "success");
  });
}

function submitPhoneConfirm() {
  var otp = $("phone-otp").value.trim();
  var msg = $("phone-msg");
  if (otp.length !== 6) { showMessage(msg, "Mã OTP phải gồm 6 số.", "error"); return; }
  var btn = $("phone-confirm-btn");
  btn.disabled = true;
  apiAuth("POST", "/users/me/phone/confirm", authToken(), { otp_code: otp }).then(function (res) {
    btn.disabled = false;
    if (!res.ok) { showMessage(msg, res.data.detail || "Xác nhận không thành công.", "error"); return; } // E3 (hết hạn) hoặc sai mã
    profile = res.data;
    renderAccountBadge();
    phoneChangeStage = "request";
    renderSettingsBody();
    showMessage($("phone-msg"), "Đổi số điện thoại thành công.", "success");
  });
}

function passwordPanelHtml() {
  if (!authToken()) return '<div class="form-msg form-msg--hint">Vui lòng đăng nhập để đổi mật khẩu.</div>';
  if (profile && profile.auth_provider === "google") {
    return '<div class="form-msg form-msg--hint">Tài khoản Google không có mật khẩu để đổi.</div>';
  }
  return '<div class="form-msg" id="password-msg" hidden></div>' +
    '<div class="form-field"><label class="form-label" for="pwd-current">Mật khẩu hiện tại</label><input type="password" class="form-input" id="pwd-current" autocomplete="current-password"></div>' +
    '<div class="form-field"><label class="form-label" for="pwd-new">Mật khẩu mới</label><input type="password" class="form-input" id="pwd-new" autocomplete="new-password"></div>' +
    '<div class="form-field"><label class="form-label" for="pwd-confirm">Xác nhận mật khẩu mới</label><input type="password" class="form-input" id="pwd-confirm" autocomplete="new-password"></div>' +
    '<div class="form-hint" style="margin-bottom:6px">Tối thiểu 8 ký tự, có chữ hoa, chữ thường và số (BR-01).</div>' +
    '<div class="settings-panel-actions"><button type="button" class="btn-solid" id="pwd-submit-btn">Đổi mật khẩu</button></div>';
}

function bindPasswordPanel() {
  var btn = $("pwd-submit-btn");
  if (!btn) return;
  btn.addEventListener("click", submitPasswordChange);
}

function submitPasswordChange() {
  var cur = $("pwd-current").value, next = $("pwd-new").value, confirmVal = $("pwd-confirm").value;
  var msg = $("password-msg");
  if (!cur || !next || !confirmVal) { showMessage(msg, "Vui lòng điền đủ các trường.", "error"); return; }
  if (next !== confirmVal) { showMessage(msg, "Mật khẩu xác nhận không khớp.", "error"); return; } // E (mới không khớp)
  var btn = $("pwd-submit-btn");
  btn.disabled = true;
  apiAuth("POST", "/users/me/password", authToken(), {
    current_password: cur, new_password: next, confirm_password: confirmVal,
    current_refresh_token: authRefreshToken(),
  }).then(function (res) {
    btn.disabled = false;
    if (!res.ok) { showMessage(msg, res.data.detail || "Đổi mật khẩu thất bại.", "error"); return; } // E1/E2/E3
    $("pwd-current").value = ""; $("pwd-new").value = ""; $("pwd-confirm").value = "";
    showMessage($("password-msg"), "Đổi mật khẩu thành công.", "success");
  });
}

/* Tải hồ sơ thật khi đã đăng nhập. Không có token -> giữ nguyên chế độ mẫu (CURRENT_USER_
   FALLBACK), không ép điều hướng sang trang đăng nhập. Theme: giá trị server (nếu có) được
   coi là nguồn đồng bộ đa thiết bị và ưu tiên hơn giá trị đã lưu cục bộ trên máy này. */
function bootUserProfile() {
  try { themePref = localStorage.getItem(THEME_STORAGE_KEY) || "system"; } catch (e) { themePref = "system"; }
  var token = authToken();
  if (!token) return;
  apiAuth("GET", "/users/me/profile", token).then(function (res) {
    if (!res.ok) return; // token hết hạn/không hợp lệ -> im lặng dùng chế độ mẫu, không chặn trang
    profile = res.data;
    if (profile.theme && profile.theme !== themePref) applyTheme(profile.theme);
    renderAccountBadge();
  });
}

/* ====================================================================
   Khởi tạo module — wiring DOM tĩnh riêng của Hồ sơ/Cài đặt/popover tài
   khoản, gọi 1 lần từ ghichu.js (init()).
   ==================================================================== */
export function initGiaodien(helpOpener) {
  setHelpOpener(helpOpener);
  renderAccountBadge();
  $("btn-account").addEventListener("click", toggleAccountMenu);

  $("profile-close").addEventListener("click", closeProfileModal);
  $("profile-cancel").addEventListener("click", closeProfileModal);
  $("profile-save").addEventListener("click", submitProfileForm);
  $("profile-overlay").addEventListener("click", function (e) { if (e.target === $("profile-overlay")) closeProfileModal(); });
  $("profile-avatar-url").addEventListener("input", function () {
    setAvatarContent($("profile-avatar-preview"), $("profile-avatar-url").value.trim(), $("profile-name").value || currentDisplayName());
  });

  $("settings-close").addEventListener("click", closeSettingsModal);
  $("settings-overlay").addEventListener("click", function (e) { if (e.target === $("settings-overlay")) closeSettingsModal(); });
  $("settings-tabs").addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-tab]") : null;
    if (btn) switchSettingsTab(btn.getAttribute("data-tab"));
  });

  bootUserProfile();
}

// Được ghichu.js gọi khi Esc được bấm trong lúc modal Hồ sơ/Cài đặt đang mở.
export function isProfileModalOpen() { return !$("profile-overlay").hidden; }
export function isSettingsModalOpen() { return !$("settings-overlay").hidden; }
export { closeProfileModal, closeSettingsModal };
