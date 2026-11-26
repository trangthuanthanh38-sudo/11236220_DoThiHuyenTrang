/* ======================================================================
   ghichu_thongbao.js — THÔNG BÁO dùng chung cả app (UC-31 + nhắc học). Tách từ mục "Thông báo" cũ của
   ghichu_lichbieu.js để 2 chuông dùng CHUNG 1 nguồn dữ liệu (số chưa đọc luôn khớp nhau):
     - chuông topbar trang soạn thảo (#btn-noti, cạnh "Chia sẻ") — panel #noti-panel gắn vào body (position:fixed,
       vì .tabstrip có overflow-x nên dropdown đặt trong topbar sẽ bị cắt);
     - chuông ở màn Lịch biểu (#lb-bell / #lb-notif — ghichu_lichbieu.js gọi renderPanel()).
   Loại thông báo (`kind`, backend: database/schedule_schema_v3.sql + services/study_reminders.py):
     schedule  — nhắc lịch biểu (item_type event|class|deadline|exam, item_date, start_minute)
     flashcard — bộ thẻ có thẻ đến hạn ôn            (ref_id = bộ thẻ)
     exam      — đề thi thử đang làm dở, còn giờ      (ref_id = đề)
     practice  — bài ôn tập chưa nộp                  (ref_id = bộ câu hỏi)
     share         — có người chia sẻ Môn / Chương với mình (ref_id = Môn hoặc Chương — routers/shares.py)
     share_request — có người xin quyền truy cập Môn / Chương của mình (ref_id + actor_id = người xin)
   Bấm 1 thông báo -> đánh dấu đã đọc rồi hooks.openNotiTarget(n) (ghichu.js mở đúng công cụ / đúng chỗ).

   API (routers/schedule.py):
     GET  /schedule/notifications -> {items:[{id, kind, ref_id, schedule_item_id, item_type, title, detail, item_date,
            start_minute, fire_at, is_read}], unread_count, now, effective_email, email_enabled}
     POST /schedule/notifications/{id}/read  ·  POST /schedule/notifications/read-all

   Báo thông báo MỚI: chạy nền suốt khi đã đăng nhập (poll NOTI_POLL_MS). Mỗi thông báo chỉ báo 1 LẦN (id đã báo lưu
   localStorage ANNOUNCED_KEY, nên F5 không kêu lại nhưng nhắc đến đúng lúc đang tải lại trang vẫn được báo); tiếng
   "ding-dong" bằng Web Audio (không cần file âm thanh; trình duyệt chỉ cho phát sau thao tác đầu tiên trên trang) +
   hộp báo góc phải KHÔNG tự ẩn (ở lại tới khi bấm nút / ×); tiêu đề tab có "(n)" = số chưa đọc.
   Chế độ mẫu (chưa đăng nhập): danh sách minh hoạ do Lịch biểu đưa vào (setSample), không gọi API.
   ====================================================================== */
import { hooks, $, esc, isOnline, authToken } from "./ghichu_core.js";

var NOTI_POLL_MS = 10000;   // + tải ngay khi quay lại tab (visibilitychange) — thông báo mới hiện không cần F5
var FRESH_MS = 12 * 3600 * 1000;   // đến giờ quá 12 tiếng thì không bật hộp báo nữa (vẫn có chấm đỏ + trong danh sách)
var ANNOUNCED_KEY = "td_lb_announced";
var KIND = {
  event: "Nhắc sự kiện", class: "Nhắc buổi học", deadline: "Nhắc deadline", exam: "Nhắc lịch thi",
  flashcard: "Nhắc ôn thẻ", "q-exam": "Bài thi đang dở", practice: "Bài ôn tập đang dở",
  share: "Được chia sẻ", share_request: "Yêu cầu quyền truy cập",
  quota: "Dung lượng", quota_ai: "Lượt AI", feedback: "Phản hồi góp ý", file_removed: "Tệp bị xoá", account: "Tài khoản",
  quota_change: "Thay đổi hạn mức",
};
var ACT = { schedule: "Xem", flashcard: "Ôn ngay", exam: "Làm tiếp", practice: "Làm tiếp", share: "Mở", share_request: "Cấp quyền",
  quota: "Dọn dung lượng", quota_ai: "Xem", feedback: "Xem", file_removed: "Xem", account: "Xem", quota_change: "Xem" };
var DOWF = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
var BELL = '<svg width="17" height="19" viewBox="0 0 20 22" fill="none"><path d="M10 2a6 6 0 0 0-6 6v4.2L2.4 15.4c-.3.6.1 1.3.8 1.3h13.6c.7 0 1.1-.7.8-1.3L16 12.2V8a6 6 0 0 0-6-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.6 19.2a2.6 2.6 0 0 0 4.8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
var ICON = {
  schedule: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  flashcard: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.5" width="13" height="14" rx="2"/><path d="M8 4.5h10.5a2 2 0 0 1 2 2V17"/></svg>',
  exam: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/></svg>',
  practice: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5l2.2 2.2L16 9"/><rect x="4" y="3.5" width="16" height="17" rx="2.5"/></svg>',
  share: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.4c2.2.2 3.6 1.8 4 4.1"/></svg>',
  share_request: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><path d="M17 8v6M14 11h6"/></svg>',
  // UC-33 / UC-35 / UC-36 — nhắc hạn mức, phản hồi góp ý, tệp bị quản trị viên xoá
  quota: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
  quota_ai: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  feedback: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  file_removed: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  // UC-33: quản trị viên đổi hạn mức (kèm lý do, có thể tạm thời)
  quota_change: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  account: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
};

var nt = { items: [], unread: 0, now: null, email: null, listeners: [], polling: false };

/* ---------- dữ liệu ---------- */
export function items() { return nt.items; }
export function unreadCount() { return nt.unread; }
export function email() { return nt.email; }
export function setEmail(effective) { nt.email = { effective: effective, enabled: nt.email ? nt.email.enabled : false }; emit("change"); }
// fn(type) — type "change" (dữ liệu / đã đọc đổi) hoặc "announce" (vừa báo thông báo mới)
export function subscribe(fn) { nt.listeners.push(fn); }
function emit(type) { nt.listeners.forEach(function (fn) { try { fn(type); } catch (e) { /* 1 nơi lỗi không chặn nơi khác */ } }); renderTitleBadge(); }

function fromApi(n) {
  return {
    id: n.id, kind: n.kind || "schedule", itemId: n.schedule_item_id, refId: n.ref_id, actorId: n.actor_id, type: n.item_type,
    title: n.title, detail: n.detail, date: n.item_date, s: n.start_minute, fire: new Date(n.fire_at), unread: !n.is_read,
  };
}

// Chế độ mẫu: Lịch biểu đưa vào thông báo minh hoạ gắn với sự kiện mẫu của nó (n.when / n.sub viết sẵn).
export function setSample(list, unread) {
  if (isOnline()) return;
  nt.items = list.map(function (n) { return Object.assign({ kind: "schedule" }, n); });
  nt.unread = unread;
  emit("change");
}

export function load() {
  if (!isOnline()) return Promise.resolve();
  return apiAuth("GET", "/schedule/notifications", authToken()).then(function (res) {
    if (!res.ok) return;
    nt.now = new Date(res.data.now);
    nt.items = res.data.items.map(fromApi);
    nt.unread = res.data.unread_count;
    nt.email = { effective: res.data.effective_email, enabled: res.data.email_enabled };
    // Thông báo MỚI = chưa đọc, chưa từng báo và đến giờ trong FRESH_MS gần đây.
    var told = announcedIds();
    var fresh = nt.items.filter(function (n) { return n.unread && !told.has(n.id) && nt.now - n.fire < FRESH_MS; });
    if (fresh.length) { fresh.forEach(function (n) { told.add(n.id); }); saveAnnounced(told); }
    emit("change");
    if (fresh.length) announce(fresh);
  });
}

export function markAllRead() {
  nt.items.forEach(function (n) { n.unread = false; }); nt.unread = 0; emit("change");
  if (isOnline()) apiAuth("POST", "/schedule/notifications/read-all", authToken());
}
function markRead(n) {
  if (!n.unread) return;
  n.unread = false; nt.unread = Math.max(0, nt.unread - 1); emit("change");
  if (isOnline() && typeof n.id === "number") apiAuth("POST", "/schedule/notifications/" + n.id + "/read", authToken());
}
// Bấm 1 thông báo (danh sách hoặc hộp báo): đã đọc + mở đúng chỗ (ghichu.js).
export function openItem(n) {
  markRead(n);
  closeTopPanel();
  hooks.openNotiTarget(n);
}

/* ---------- hiển thị ---------- */
function pad(n) { return String(n).padStart(2, "0"); }
function hm(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function parseDay(k) { var a = k.split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function kindLabel(n) { return n.kind === "schedule" ? KIND[n.type] || "Nhắc lịch" : n.kind === "exam" ? KIND["q-exam"] : KIND[n.kind]; }
// "Hôm nay, 07:30" / "Hôm qua, 14:00" / "30/09, 16:45" — so theo "bây giờ" của máy chủ (APP_TIMEZONE).
function whenText(n) {
  if (n.when) return n.when;
  var f = n.fire, t = new Date(nt.now || new Date()); t.setHours(0, 0, 0, 0);
  var fd = new Date(f); fd.setHours(0, 0, 0, 0);
  var diff = Math.round((t - fd) / 86400000), time = pad(f.getHours()) + ":" + pad(f.getMinutes());
  return (diff === 0 ? "Hôm nay" : diff === 1 ? "Hôm qua" : pad(f.getDate()) + "/" + pad(f.getMonth() + 1)) + ", " + time;
}
function subText(n) {
  if (n.sub) return n.sub;
  if (n.kind !== "schedule") return n.detail || "";
  var t = new Date(nt.now || new Date()); t.setHours(0, 0, 0, 0);
  var d = parseDay(n.date), diff = Math.round((d - t) / 86400000);
  var day = diff === 0 ? "hôm nay" : diff === 1 ? "ngày mai" : diff === -1 ? "hôm qua" : DOWF[d.getDay()].toLowerCase() + " " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
  return (n.type === "deadline" ? "Hạn " : "Bắt đầu ") + hm(n.s) + " " + day;
}
function channelsText() {
  if (!isOnline()) return "Đang nhận qua: Trong app, Email";
  var e = nt.email && nt.email.effective;
  return "Đang nhận qua: Trong app" + (e && nt.email.enabled ? ", Email (" + esc(e) + ")" : "");
}

/* Vẽ nội dung bảng thông báo vào `el` (khung + vị trí do nơi gọi lo). opts:
     onProfile() — bấm "Đi tới Hồ sơ để nhập email";   withIcons — icon theo loại ở mỗi dòng;
     footExtra   — HTML thêm ở chân (vd. nút "Mở Lịch biểu" của chuông topbar, data-act="lichbieu"). */
export function renderPanel(el, opts) {
  opts = opts || {};
  var any = nt.items.some(function (n) { return n.unread; });
  var ask = isOnline() && nt.email && !nt.email.effective
    ? '<div class="lb-nask"><span>Bạn chưa có email nhận nhắc lịch. Nhập email trong Hồ sơ để nhận nhắc qua Email.</span>' +
      '<button type="button" class="lb-btn-primary sm" data-act="profile">Đi tới Hồ sơ để nhập email</button></div>'
    : "";
  var foot = '<div class="nf"><span>' + channelsText() + "</span>";
  if (!isOnline()) foot += "<span>Chế độ mẫu — đăng nhập để nhận nhắc thật.</span>";
  else if (nt.email && nt.email.effective && !nt.email.enabled) foot += '<span class="lb-nwarn">Email chưa gửi được: máy chủ chưa cấu hình hộp thư gửi (SMTP_USER / SMTP_PASSWORD trong backend/.env). Hiện chỉ nhắc trong app.</span>';
  foot += (opts.footExtra || "") + "</div>";
  el.innerHTML = '<div class="nh"><b>Thông báo</b><button type="button" data-act="read-all" ' + (any ? "" : "disabled") + ">" + (any ? "Đánh dấu đã đọc" : "Đã đọc hết") + "</button></div>" + ask +
    '<div class="nl">' + (nt.items.length ? nt.items.map(function (n, i) {
      var ic = opts.withIcons ? '<i class="lb-ni-ic k-' + n.kind + '">' + ICON[n.kind] + "</i>" : "";
      return '<button type="button" class="lb-ni ' + (n.unread ? "unread " : "") + (ic ? "has-ic" : "") + '" data-n="' + i + '">' + ic +
        "<small>" + kindLabel(n) + " · " + whenText(n) + "</small><b>" + esc(n.title) + "</b><span>" + esc(subText(n)) + "</span></button>";
    }).join("") : '<div class="lb-nempty">Chưa có thông báo nào. Nhắc lịch, thẻ đến hạn ôn và bài làm dở sẽ hiện ở đây.</div>') + "</div>" + foot;
  el.onclick = function (e) {
    e.stopPropagation();
    var b = e.target.closest("[data-n]"); if (b) { openItem(nt.items[+b.dataset.n]); return; }
    var a = e.target.closest("[data-act]"); if (!a) return;
    if (a.dataset.act === "read-all") markAllRead();
    else if (a.dataset.act === "profile" && opts.onProfile) opts.onProfile();
    else if (a.dataset.act === "lichbieu") { closeTopPanel(); hooks.openLichbieu(); }
  };
}

var baseTitle = document.title;
function renderTitleBadge() { document.title = (isOnline() && nt.unread > 0 ? "(" + nt.unread + ") " : "") + baseTitle; }

/* ---------- tiếng chuông + hộp báo góc phải ---------- */
var audioCtx = null;
function audio() {
  if (!audioCtx) {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { audioCtx = new C(); } catch (e) { return null; }
  }
  return audioCtx;
}
function unlockAudio() { var c = audio(); if (c && c.state === "suspended") c.resume(); }
// "Ding-dong" 2 nốt, lặp 2 lần
function playChime() {
  var c = audio(); if (!c) return;
  if (c.state === "suspended") c.resume();
  var t = c.currentTime + 0.02;
  [[880, 0], [1318.5, 0.2], [880, 0.75], [1318.5, 0.95]].forEach(function (p) {
    var o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.value = p[0];
    g.gain.setValueAtTime(0.0001, t + p[1]);
    g.gain.exponentialRampToValueAtTime(0.22, t + p[1] + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p[1] + 0.55);
    o.connect(g); g.connect(c.destination);
    o.start(t + p[1]); o.stop(t + p[1] + 0.6);
  });
}
function announcedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || "[]")); } catch (e) { return new Set(); }
}
function saveAnnounced(set) {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(Array.from(set).slice(-200))); } catch (e) { /* bỏ qua */ }
}
function announce(fresh) {
  playChime();
  ringTopBell();
  emit("announce");               // Lịch biểu đang mở: chuông của nó lắc thêm
  showAlert(fresh[0], fresh.length);
}
function showAlert(n, count) {
  var box = $("lb-alerts");
  if (!box) { box = document.createElement("div"); box.id = "lb-alerts"; box.className = "lb-alerts"; document.body.appendChild(box); }
  var el = document.createElement("div");
  el.className = "lb-alert"; el.setAttribute("role", "alert");
  el.innerHTML = '<span class="lb-alert-ic">' + BELL + "</span>" +
    '<div class="lb-alert-tx"><small>' + kindLabel(n) + (count > 1 ? " · và " + (count - 1) + " nhắc khác" : "") + "</small><b>" + esc(n.title) + "</b><span>" + esc(subText(n)) + "</span></div>" +
    '<div class="lb-alert-acts"><button type="button" class="lb-alert-view">' + (ACT[n.kind] || "Xem") + '</button><button type="button" class="lb-alert-x" aria-label="Đóng">×</button></div>';
  box.appendChild(el);
  el.querySelector(".lb-alert-x").onclick = function (ev) { ev.stopPropagation(); el.remove(); };
  el.querySelector(".lb-alert-view").onclick = function (ev) { ev.stopPropagation(); el.remove(); openItem(n); };
}

/* ---------- chuông topbar trang soạn thảo ---------- */
function topPanel() { return $("noti-panel"); }
function renderTopBell() {
  var dot = $("btn-noti-dot"); if (!dot) return;
  dot.hidden = !(nt.unread > 0);
  dot.textContent = nt.unread > 9 ? "9+" : nt.unread > 0 ? String(nt.unread) : "";
  $("btn-noti").setAttribute("aria-label", "Thông báo" + (nt.unread ? " (" + nt.unread + " chưa đọc)" : ""));
}
function ringTopBell() {
  var b = $("btn-noti"); if (!b) return;
  b.classList.remove("ring"); void b.offsetWidth; b.classList.add("ring");
  clearTimeout(ringTopBell.t); ringTopBell.t = setTimeout(function () { b.classList.remove("ring"); }, 2200);
}
function renderTop() {
  var p = topPanel(); if (!p || p.hidden) return;
  renderPanel(p, {
    withIcons: true,
    onProfile: function () { closeTopPanel(); hooks.openProfile(); },
    footExtra: '<button type="button" class="noti-open-lb" data-act="lichbieu">Mở Lịch biểu</button>',
  });
}
function placeTopPanel() {
  var p = topPanel(), r = $("btn-noti").getBoundingClientRect();
  p.style.top = Math.round(r.bottom + 8) + "px";
  p.style.right = Math.max(12, Math.round(window.innerWidth - r.right - 8)) + "px";
}
function openTopPanel() {
  var p = topPanel(); if (!p) return;
  p.hidden = false; $("btn-noti").classList.add("on"); $("btn-noti").setAttribute("aria-expanded", "true");
  placeTopPanel(); renderTop();
  load();
}
export function closeTopPanel() {
  var p = topPanel(); if (!p || p.hidden) return;
  p.hidden = true; $("btn-noti").classList.remove("on"); $("btn-noti").setAttribute("aria-expanded", "false");
}

export function initThongbao() {
  ["pointerdown", "keydown"].forEach(function (t) { document.addEventListener(t, unlockAudio, { passive: true }); });
  subscribe(function () { renderTopBell(); renderTop(); });
  var btn = $("btn-noti");
  if (btn) {
    var p = document.createElement("div");
    p.id = "noti-panel"; p.className = "lb-notif noti-panel"; p.hidden = true; p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "Thông báo");
    document.body.appendChild(p);
    btn.addEventListener("click", function (e) { e.stopPropagation(); if (p.hidden) openTopPanel(); else closeTopPanel(); });
    document.addEventListener("click", function (e) { if (!p.hidden && !e.target.closest("#noti-panel, #btn-noti")) closeTopPanel(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !p.hidden) { closeTopPanel(); btn.focus(); } });
    window.addEventListener("resize", function () { if (!p.hidden) placeTopPanel(); });
    renderTopBell();
  }
  if (isOnline() && !nt.polling) {
    nt.polling = true; load();
    setInterval(function () { if (!document.hidden) load(); }, NOTI_POLL_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  }
}
