/* ======================================================================
   ghichu_lichbieu.js — MODULE "Lịch biểu" (UC-26 Tạo lịch/deadline, UC-27 Xem thời gian biểu, UC-28 Xoá
   mục lịch + Sửa, và chuông thông báo của UC-31). HTML ở html/ghichu_lichbieu.frag (nạp vào
   #mount-lichbieu-pane), style ở css/ghichu_lichbieu.css (tiền tố `lb-`). Logic port từ giao diện mẫu
   `lich-bieu.html` (lưới Ngày/Tuần/Tháng, lịch nhỏ, Nhãn ẩn/hiện/đổi tên/gộp, form Thêm/Sửa
   bước 15', cảnh báo trùng giờ BR-11, xem nhanh, xoá + Hoàn tác, chuông) — khác mẫu:
     - Lưới đo kích thước thật của #lb-grid (không còn khung cố định 1440×1024 + zoom). Giờ CẢ NGÀY 00:00–23:59
       (mẫu chỉ 07:00–21:00): Ngày/Tuần = hàng tiêu đề ngày cố định + thân cuộn dọc ~14 giờ/màn, mở lần đầu cuộn
       tới 07:00 (hoặc ngay trước giờ hiện tại nếu hôm nay đang hiện).
     - Màu sự kiện lưu thẳng hex (#rrggbb); nền nhạt tính bằng color-mix ở CSS theo theme.
     - Form có thêm "Môn học" (+ Chương) tuỳ chọn — UC-26 luồng 1a, để UC-29 thống kê theo Môn sau này.
       Chọn Môn khi Nhãn còn đi theo tên sự kiện thì Nhãn tự lấy tên Môn.
     - Kênh "Thông báo đẩy" chưa có hạ tầng -> không hiện trong form (luôn gửi via_push=false). Email chỉ bật
       được khi đã có email nhận nhắc (đặt ở Hồ sơ).
     - Lặp lại hằng tuần / tháng / năm (tuỳ chọn, "Đến ngày" tuỳ chọn): 1 sự kiện = 1 chuỗi, `date` = lần đầu.
       visible() trải chuỗi ra từng ngày bằng occursOn() (cùng quy tắc với schedule_notifier.occurs_on ở
       backend); mỗi lần xuất hiện là bản sao id "<id>@<ngày>" kèm `base` = dòng gốc. Sửa/xoá luôn áp dụng cả chuỗi.

   Database: database/schedule_schema.sql. Backend: backend/app/routers/schedule.py (+ services/
   schedule_notifier.py quét giờ nhắc). Đổi field nào thì sửa fromApi()/toPayload() và schemas.py (Schedule*):
     GET    /schedule/items?from=YYYY-MM-DD&to=YYYY-MM-DD -> [{id, title, item_type, label_id, label, color,
              subject_id, subject_name, chapter_id, chapter_name, date, start_minute, end_minute,
              repeat_rule, repeat_until, remind_before, via_app, via_email, via_push}]
              (sự kiện lặp: dòng gốc của chuỗi còn xuất hiện trong khoảng, `date` = lần đầu)
     POST   /schedule/items {title, item_type, label, color, subject_id, chapter_id, date, start_minute,
              end_minute, repeat_rule, repeat_until, remind_before, via_app, via_email, via_push} -> {item, conflicts, labels}
     PUT    /schedule/items/{id} (như POST)                       -> {item, conflicts, labels}
     DELETE /schedule/items/{id}                                  -> {labels}
     GET    /schedule/conflicts?date&start_minute&end_minute&item_type&exclude_id -> [{id,title,start_minute,end_minute}]
     GET    /schedule/labels  ·  PATCH /schedule/labels/{id} {name?|color?|is_hidden?} -> {merged_into, labels}
     Thông báo (GET /schedule/notifications, read, read-all): xem ghichu_thongbao.js — module đó tải, báo và vẽ
     danh sách cho cả chuông ở đây lẫn chuông topbar trang soạn thảo.
   Email nhận nhắc KHÔNG đặt ở đây mà ở Hồ sơ (UC-06, PUT /users/me/profile notify_email — tài khoản Google luôn
   dùng Gmail đăng nhập, ô bị khoá). GET /schedule/notifications trả kèm {effective_email, email_enabled}; chưa có
   email thì bảng thông báo hiện yêu cầu "Đi tới Hồ sơ" (hooks.openProfile).
   Giờ = phút trong ngày theo giờ địa phương. Dữ liệu tải theo cả lưới THÁNG chứa ngày đang xem (≤ 42 ngày),
   nên chuyển Ngày/Tuần trong cùng tháng không gọi lại API. "Hoàn tác" sau khi xoá = POST lại dữ liệu cũ.

   Khi CHƯA đăng nhập ("chế độ mẫu", isOnline()) giữ nguyên dữ liệu minh hoạ của mẫu (thời khoá biểu học
   kỳ 1/2026-2027 + vài deadline/lịch thi + 3 thông báo), mọi thao tác chỉ trong bộ nhớ, mất khi tải lại.
   Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi `lb.open` rồi gọi hooks.syncLayout().
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken } from "./ghichu_core.js";
import * as Thongbao from "./ghichu_thongbao.js";

/* ---------------- hằng số ---------------- */
var H0 = 0, H1 = 24;                 // lưới cả ngày; mốc cuối 23:59 (DAY_END)
var DAY_END = 23 * 60 + 59;
var TOP = 54, TW = 54, MIN_HH = 34;  // cao dòng tiêu đề ngày, rộng cột giờ, cao tối thiểu 1 giờ
var HOURS_IN_VIEW = 14;              // số giờ thấy được trong khung, phần còn lại cuộn
var SCROLL_HOUR = 7;                 // lần đầu mở / đổi khoảng xem: cuộn tới 07:00
var DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
var DOWF = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
var PALETTE = [
  ["#2c4a8c", "Xanh đậm"], ["#0d7380", "Xanh mòng két"], ["#ad6e0d", "Hổ phách"], ["#804080", "Tím"],
  ["#2e7d4f", "Xanh lá"], ["#b83d38", "Đỏ"], ["#2f62c4", "Xanh dương"], ["#5c6370", "Xám"],
  ["#c4561d", "Cam"], ["#b03a74", "Hồng"], ["#6b7a1f", "Ô liu"], ["#1c86a8", "Xanh trời"],
];
// Màu dự phòng: form chỉ hiện PALETTE_SLOTS ô, màu đã thuộc nhãn khác bị ẩn và màu dự phòng chưa dùng thế chỗ
// (backend/app/routers/stats.py _PALETTE giữ cùng thứ tự PALETTE + RESERVE).
var RESERVE = [
  ["#3f51b5", "Chàm"], ["#00897b", "Ngọc lục"], ["#a0522d", "Nâu đất"], ["#7a4fb5", "Tím oải hương"],
  ["#558b2f", "Xanh rêu"], ["#c2185b", "Hồng đậm"], ["#00838f", "Xanh lơ"], ["#d84315", "Cam cháy"],
  ["#6a1b9a", "Tím đậm"], ["#9e7c0c", "Vàng đồng"], ["#455a64", "Xám xanh"], ["#8d6e63", "Nâu nhạt"],
];
var ALL_COLORS = PALETTE.concat(RESERVE);
var PALETTE_SLOTS = PALETTE.length;
var TYPES = { event: "Sự kiện", class: "Buổi học", deadline: "Deadline", exam: "Lịch thi" };
var REM = { none: "Không nhắc", m10: "10 phút trước", m30: "30 phút trước", h1: "1 giờ trước", d1: "1 ngày trước" };
var REMS = { none: "", m10: "10 phút", m30: "30 phút", h1: "1 giờ", d1: "1 ngày" };
var VIA = { app: "Trong app", email: "Email", push: "Thông báo đẩy" };
var REPEATS = ["none", "weekly", "monthly", "yearly"];
var CHECK = '<svg width="10" height="8" viewBox="0 0 12 10" fill="none"><path d="M1 5.2 4.3 8.5 11 1.5" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var FLAG = '<svg width="10" height="12" viewBox="0 0 12 14" fill="none"><path d="M1.5 13V1.5h8.2L8 4.6l1.7 3.1H1.5" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
var CHEV = '<svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Mở lại đúng chế độ xem + ngày khi F5 lúc đang ở Lịch biểu (xoá khi rời màn).
var RESUME_KEY = "td_lb_resume";
var HIDE_NONE_KEY = "td_lb_hide_none";   // ẩn "Không có nhãn" (nhãn thật lưu is_hidden ở server)
function saveResume() { try { localStorage.setItem(RESUME_KEY, JSON.stringify({ view: lb.view, cur: key(lb.cur) })); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "null"); } catch (e) { return null; } }

/* ---------------- ngày giờ ---------------- */
function pad(n) { return String(n).padStart(2, "0"); }
function key(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parse(k) { var a = k.split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function addD(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mon(d) { return addD(d, -((d.getDay() + 6) % 7)); }
function same(a, b) { return key(a) === key(b); }
function hm(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function today() { var t = new Date(); t.setHours(0, 0, 0, 0); return t; }
function nowMin() { var n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function lk(s) { return (s || "").trim().toLowerCase(); }
function monthRows(first) {
  var rows = [];
  for (var d = mon(first); rows.length < 6; d = addD(d, 7)) {
    if (rows.length >= 4 && d.getMonth() !== first.getMonth() && d > first) break;
    rows.push(d);
  }
  return rows;
}

/* ---------------- state riêng của module ---------------- */
var lb = {
  open: false,
  view: "week",                 // day | week | month
  cur: today(),
  mini: null,                   // tháng đang xem ở lịch nhỏ
  ev: [],                       // sự kiện đã tải (online) / toàn bộ dữ liệu mẫu (offline)
  labels: [],                   // online: [{id, name, color, is_hidden, item_count}] từ server
  hideSample: new Set(),        // chế độ mẫu: key nhãn đang ẩn
  hideNone: false,              // ẩn nhóm "Không có nhãn"
  loaded: null,                 // {from, to} khoảng đã tải (online)
  reqSeq: 0,
  sel: null, draft: null, pendingPop: null,
  scrollKey: "", scrollTop: 0, progScrollAt: 0, popAt: 0,   // vị trí cuộn thân lưới Ngày/Tuần
  customCols: [],
  lastDel: null, pendingDel: null,
  timers: [],
  sampleReady: false,
};
var uid = 1;

export function isOpen() { return lb.open; }

/* ====================================================================
   Mở / đóng
   ==================================================================== */
export function openLichbieu() {
  lb.open = true;
  lb.scrollKey = "";            // mở lại -> cuộn về 07:00 / giờ hiện tại
  if (!lb.mini) lb.mini = new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1);
  try { lb.hideNone = localStorage.getItem(HIDE_NONE_KEY) === "1"; } catch (e) {}
  if (!isOnline()) initSample();
  hooks.syncLayout();
  saveResume();
  syncViewSeg();
  render();
  if (isOnline()) {
    lb.loaded = null;           // dữ liệu có thể đã đổi ở thiết bị khác -> tải lại khi mở
    ensureLoaded();
    loadLabels();
    Thongbao.load();
  }
  lb.timers.push(setInterval(function () { if (lb.view !== "month" && $("lb-ev-modal").hidden) renderGrid(); }, 60000));
}

// Rời màn Lịch biểu (× / chuyển công cụ / mở Chương từ sự kiện). Không giữ trang để F5 mở lại.
export function closeLichbieu() {
  lb.open = false;
  lb.timers.forEach(clearInterval); lb.timers = [];
  closeForm(); closePop(); closeNotif();
  $("lb-del-modal").hidden = true;
  $("lb-snack").hidden = true;
  clearResume();
  hooks.syncLayout();
}

export function resumeIfNeeded() {
  var r = readResume();
  if (!r) return;
  if (r.view === "day" || r.view === "week" || r.view === "month") lb.view = r.view;
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.cur || "")) { lb.cur = parse(r.cur); lb.mini = new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1); }
  openLichbieu();
}

/* ====================================================================
   Dữ liệu — online (API) / chế độ mẫu (cục bộ)
   ==================================================================== */
function fromApi(o) {
  return {
    id: o.id, title: o.title, type: o.item_type, lbl: o.label || "", labelId: o.label_id, col: o.color,
    subjectId: o.subject_id, subjectName: o.subject_name, chapterId: o.chapter_id, chapterName: o.chapter_name,
    date: o.date, s: o.start_minute, e: o.end_minute, repeat: o.repeat_rule || "none", until: o.repeat_until || null,
    remind: o.remind_before,
    via: { app: o.via_app, email: o.via_email, push: o.via_push },
  };
}
function toPayload(d) {
  return {
    title: d.title, item_type: d.type, label: d.lbl || null, color: d.col,
    subject_id: d.subjectId || null, chapter_id: d.subjectId ? (d.chapterId || null) : null,
    date: d.date, start_minute: d.s, end_minute: d.type === "deadline" ? d.s : d.e,
    repeat_rule: d.repeat || "none", repeat_until: d.repeat && d.repeat !== "none" ? (d.until || null) : null,
    remind_before: d.remind, via_app: !!d.via.app, via_email: !!d.via.email, via_push: !!d.via.push,
  };
}
function apiErr(res, fallback) {
  var d = res && res.data && res.data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) return String(d[0].msg || fallback).replace(/^Value error, /, "");
  if (res && res.status === 404) return "API /schedule chưa được nối (máy chủ trả 404).";
  return fallback;
}
function showError(msg) {
  var b = $("lb-error"); b.textContent = msg; b.hidden = false;
  clearTimeout(showError.t); showError.t = setTimeout(function () { b.hidden = true; }, 4500);
}

// Khoảng cần có dữ liệu = cả lưới tháng chứa ngày đang xem (tuần của ngày đó luôn nằm trong lưới này).
function neededRange() {
  var rows = monthRows(new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1));
  return { from: key(rows[0]), to: key(addD(rows[rows.length - 1], 6)) };
}
function ensureLoaded() {
  if (!isOnline() || !lb.open) return;
  var r = neededRange();
  if (lb.loaded && lb.loaded.from <= r.from && lb.loaded.to >= r.to) return;
  var seq = ++lb.reqSeq;
  $("lb-loading").hidden = false;
  apiAuth("GET", "/schedule/items?from=" + r.from + "&to=" + r.to, authToken()).then(function (res) {
    if (seq !== lb.reqSeq) return;
    $("lb-loading").hidden = true;
    if (!res.ok) { showError(apiErr(res, "Không tải được lịch.")); return; }
    lb.ev = res.data.map(fromApi);
    lb.loaded = r;
    renderLabels(); renderGrid();
  });
}
function reload() { lb.loaded = null; ensureLoaded(); }
function loadLabels() {
  apiAuth("GET", "/schedule/labels", authToken()).then(function (res) {
    if (res.ok) { lb.labels = res.data; renderLabels(); renderGrid(); }
  });
}

/* ---------- dữ liệu mẫu (giữ nguyên của lich-bieu.html, đổi tên màu sang hex) ---------- */
function addSample(o) {
  var e = Object.assign({ id: "s" + uid++, lbl: o.title, repeat: "none", until: null, remind: "m30", via: { app: true, email: true, push: false } }, o);
  lb.ev.push(e); return e;
}
function initSample() {
  if (lb.sampleReady) return;
  lb.sampleReady = true; lb.ev = [];
  var C = { navy: "#2c4a8c", teal: "#0d7380", amber: "#ad6e0d", purple: "#804080", gray: "#5c6370" };
  var S = { mmt: [C.navy, "Mạng máy tính", "MMT"], csdl: [C.teal, "Cơ sở dữ liệu", "CSDL"], trr: [C.amber, "Toán rời rạc", "TRR"], ta: [C.purple, "Tiếng Anh", "TA"] };
  var WEEKLY = [[1, "mmt", 480, 600], [1, "trr", 840, 930], [2, "csdl", 540, 660], [2, "ta", 1140, 1230], [3, "mmt", 480, 600], [4, "trr", 900, 1020], [5, "csdl", 480, 570]];
  for (var w = mon(new Date(2026, 7, 31)); w < new Date(2026, 11, 28); w = addD(w, 7)) {
    WEEKLY.forEach(function (x) { var s = S[x[1]]; addSample({ title: s[1], lbl: s[1], abbr: s[2], type: "class", col: s[0], date: key(addD(w, x[0] - 1)), s: x[2], e: x[3] }); });
  }
  addSample({ title: "Ôn flashcard", lbl: "Mạng máy tính", type: "class", col: C.navy, date: "2026-10-03", s: 540, e: 630 });
  var DL1 = addSample({ title: "Hạn bài tập CSDL tuần 5", short: "Hạn BT CSDL", lbl: "Cơ sở dữ liệu", type: "deadline", col: C.teal, date: "2026-09-30", s: 1065, e: 1065, remind: "h1" });
  var EX1 = addSample({ title: "Thi giữa kỳ – Mạng máy tính", short: "Thi giữa kỳ MMT", lbl: "Mạng máy tính", type: "exam", col: C.navy, date: "2026-10-02", s: 840, e: 960, remind: "d1" });
  addSample({ title: "Hạn nộp đồ án Mạng máy tính", short: "Hạn đồ án MMT", lbl: "Mạng máy tính", type: "deadline", col: C.navy, date: "2026-10-16", s: 1020, e: 1020, remind: "d1" });
  addSample({ title: "Thi giữa kỳ – Cơ sở dữ liệu", short: "Thi CSDL", lbl: "Cơ sở dữ liệu", type: "exam", col: C.teal, date: "2026-10-23", s: 540, e: 660, remind: "d1" });
  addSample({ title: "Họp nhóm câu lạc bộ", lbl: "Cá nhân", type: "event", col: C.gray, date: "2026-10-03", s: 900, e: 990, remind: "h1" });
  addSample({ title: "Khám răng", lbl: "Cá nhân", type: "event", col: C.gray, date: "2026-10-07", s: 1050, e: 1110, remind: "h1" });
  var CS1 = lb.ev.find(function (e) { return e.date === "2026-10-02" && e.col === C.teal; });
  Thongbao.setSample([
    { id: 1, itemId: EX1.id, type: "exam", title: EX1.title, date: EX1.date, s: EX1.s, when: "Hôm qua, 14:00", sub: "Bắt đầu 14:00 hôm nay", unread: true },
    { id: 2, itemId: CS1.id, type: "class", title: CS1.title, date: CS1.date, s: CS1.s, when: "Hôm nay, 07:30", sub: "Bắt đầu 08:00 hôm nay", unread: true },
    { id: 3, itemId: DL1.id, type: "deadline", title: DL1.title, date: DL1.date, s: DL1.s, when: "30/09, 16:45", sub: "Hạn 17:45 thứ Tư", unread: false },
    { id: 4, kind: "flashcard", title: "Bộ thẻ minh hoạ", when: "Hôm nay, 19:00", sub: "8 thẻ đến hạn ôn", unread: true },
  ], 3);
}

/* ---------- nhãn ---------- */
// Danh sách nhãn cho cột trái: online lấy từ server, chế độ mẫu suy ra từ sự kiện (như mẫu).
// Nhóm "Không có nhãn" chỉ hiện khi có sự kiện không nhãn trong dữ liệu đang có.
function labelList() {
  var list;
  if (isOnline()) {
    list = lb.labels.map(function (l) { return { k: lk(l.name), id: l.id, name: l.name, col: l.color, n: l.item_count, hidden: l.is_hidden }; });
  } else {
    var m = new Map();
    lb.ev.forEach(function (e) {
      var k = lk(e.lbl); if (!k) return;
      if (!m.has(k)) m.set(k, { k: k, id: k, name: e.lbl.trim(), col: e.col, n: 0, hidden: lb.hideSample.has(k) });
      m.get(k).n++;
    });
    list = Array.from(m.values());
  }
  if (lb.ev.some(function (e) { return !lk(e.lbl); })) list.push({ k: "", id: "", name: "", col: null, n: 0, hidden: lb.hideNone });
  return list;
}
function labelOf(name) { var k = lk(name); return k ? labelList().find(function (l) { return l.k === k; }) : null; }
function colorOf(e) {
  if (!isOnline()) return e.col;
  var l = e.lbl ? labelOf(e.lbl) : null;
  return l ? l.col : e.col;
}
function isHidden(e) {
  var k = lk(e.lbl);
  if (!k) return lb.hideNone;
  var l = labelOf(e.lbl);
  return !!(l && l.hidden);
}
// Sự kiện lặp: hằng tuần cùng thứ; hằng tháng cùng ngày (tháng không có ngày đó thì bỏ qua); hằng năm cùng
// ngày/tháng (29/2 chỉ năm nhuận). Khớp schedule_notifier.occurs_on() ở backend.
function isRepeat(e) { return !!e.repeat && e.repeat !== "none"; }
function occursOn(e, k) {
  if (!isRepeat(e)) return e.date === k;
  if (k < e.date || (e.until && k > e.until)) return false;
  var a = parse(e.date), d = parse(k);
  if (e.repeat === "weekly") return Math.round((d - a) / 864e5) % 7 === 0;
  if (e.repeat === "monthly") return d.getDate() === a.getDate();
  return d.getDate() === a.getDate() && d.getMonth() === a.getMonth();
}
// 1 lần xuất hiện của chuỗi: id riêng để chọn/tô trên lưới, `base` = dòng gốc (Sửa/Xoá dùng dòng này)
function occOf(e, k) { return isRepeat(e) ? Object.assign({}, e, { id: e.id + "@" + k, date: k, base: e }) : e; }
function visible(d) {
  var k = key(d);
  return lb.ev.filter(function (e) { return occursOn(e, k) && !isHidden(e); })
    .map(function (e) { return occOf(e, k); })
    .sort(function (a, b) { return (a.type === "class") - (b.type === "class") || a.s - b.s; });
}
function label(e) { return e.short || e.title; }

/* ====================================================================
   Vẽ
   ==================================================================== */
function render() {
  if (!lb.open) return;
  $("lb-range").textContent = rangeText();
  renderMini(); renderLabels(); renderGrid(); renderBell();
  ensureLoaded();
}
function rangeText() {
  var c = lb.cur;
  if (lb.view === "day") return DOWF[c.getDay()] + ", " + c.getDate() + " tháng " + (c.getMonth() + 1) + ", " + c.getFullYear();
  if (lb.view === "month") return "Tháng " + (c.getMonth() + 1) + ", " + c.getFullYear();
  var a = mon(c), b = addD(a, 6);
  if (a.getMonth() === b.getMonth()) return "Tháng " + (a.getMonth() + 1) + ", " + a.getFullYear();
  if (a.getFullYear() === b.getFullYear()) return "Thg " + (a.getMonth() + 1) + " – Thg " + (b.getMonth() + 1) + ", " + b.getFullYear();
  return "Thg " + (a.getMonth() + 1) + ", " + a.getFullYear() + " – Thg " + (b.getMonth() + 1) + ", " + b.getFullYear();
}
function syncViewSeg() {
  Array.from($("lb-view-seg").children).forEach(function (b) { b.classList.toggle("on", b.dataset.v === lb.view); });
}
function setView(v) { lb.view = v; syncViewSeg(); closePop(); saveResume(); render(); }
function stepRange(n) {
  var c = lb.cur;
  lb.cur = lb.view === "day" ? addD(c, n) : lb.view === "week" ? addD(c, 7 * n) : new Date(c.getFullYear(), c.getMonth() + n, 1);
  syncMini(); closePop(); saveResume(); render();
}
function goDate(d, view) {
  lb.cur = new Date(d); if (view) lb.view = view;
  syncViewSeg(); syncMini(); closePop(); saveResume(); render();
}
function syncMini() { lb.mini = new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1); }

/* ---------- lịch nhỏ ---------- */
function miniHTML(first, selKey, weekOf) {
  var t = today();
  return '<div class="mh"><b>Tháng ' + (first.getMonth() + 1) + ", " + first.getFullYear() + '</b><span><button type="button" data-m="-1" aria-label="Tháng trước">‹</button><button type="button" data-m="1" aria-label="Tháng sau">›</button></span></div>' +
    '<div class="lb-mrow dn">' + ["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map(function (x) { return "<span>" + x + "</span>"; }).join("") + "</div>" +
    monthRows(first).map(function (r) {
      return '<div class="lb-mrow ' + (weekOf && same(mon(weekOf), r) ? "wk" : "") + '">' + [0, 1, 2, 3, 4, 5, 6].map(function (i) {
        var d = addD(r, i);
        return '<button type="button" data-d="' + key(d) + '" class="' + (d.getMonth() !== first.getMonth() ? "out " : "") + (same(d, t) ? "today " : "") + (key(d) === selKey ? "sel" : "") + '"><span>' + d.getDate() + "</span></button>";
      }).join("") + "</div>";
    }).join("");
}
function renderMini() { $("lb-mini").innerHTML = miniHTML(lb.mini, lb.view === "day" ? key(lb.cur) : "", lb.cur); }

/* ---------- cột Nhãn ---------- */
function renderLabels() {
  var L = labelList().sort(function (a, b) { return (!a.k) - (!b.k); });
  var box = $("lb-labels");
  if (!L.length) {
    box.innerHTML = '<span class="lbl">Nhãn</span><span class="lb-lempty">Chưa có nhãn nào.</span>';
  } else {
    box.innerHTML = '<span class="lbl">Nhãn</span><div class="lb-llist">' + L.map(function (l) {
      var on = !l.hidden;
      return '<div class="lb-lrow" style="--c:' + (l.col || "var(--muted-3)") + '"><button type="button" class="lb-ck ' + (on ? "on" : "") + '" data-lid="' + esc(l.id) + '" role="checkbox" aria-checked="' + on + '" aria-label="Hiện / ẩn"><i>' + CHECK + "</i></button>" +
        (l.k ? '<input class="lb-lname" data-lid="' + esc(l.id) + '" value="' + esc(l.name) + '" maxlength="80" aria-label="Tên nhãn" title="' + (l.n ? l.n + " sự kiện" : "") + '">' : '<span class="lb-lname none">Không có nhãn</span>') + "</div>";
    }).join("") + '</div><p class="lb-lhint">Bấm vào tên để đổi tên nhãn.</p>';
  }
  $("lb-lbl-list").innerHTML = L.filter(function (l) { return l.k; }).map(function (l) { return '<option value="' + esc(l.name) + '"></option>'; }).join("");
}
// Hiện lại nhãn của 1 sự kiện đang bị ẩn (bấm thông báo của sự kiện đó), rồi vẽ lại + mở chi tiết.
function showLabelOf(ev) {
  var l = ev.lbl ? labelOf(ev.lbl) : null;
  lb.pendingPop = { id: ev.id, date: ev.date };
  if (!l) toggleLabel("");
  else toggleLabel(l.id);
}
function toggleLabel(id) {
  if (!id) {
    lb.hideNone = !lb.hideNone;
    try { localStorage.setItem(HIDE_NONE_KEY, lb.hideNone ? "1" : "0"); } catch (e) {}
  } else if (isOnline()) {
    var l = lb.labels.find(function (x) { return x.id === id; }); if (!l) return;
    l.is_hidden = !l.is_hidden;
    apiAuth("PATCH", "/schedule/labels/" + encodeURIComponent(id), authToken(), { is_hidden: l.is_hidden }).then(function (res) {
      if (!res.ok) { l.is_hidden = !l.is_hidden; renderLabels(); renderGrid(); showError(apiErr(res, "Không lưu được trạng thái nhãn.")); }
    });
  } else {
    lb.hideSample.has(id) ? lb.hideSample.delete(id) : lb.hideSample.add(id);
  }
  renderLabels(); closePop(); renderGrid();
}
// Đổi tên nhãn -> áp dụng cho mọi sự kiện cùng nhãn; trùng tên nhãn khác thì gộp (như mẫu).
function renameLabel(input) {
  var id = input.dataset.lid, name = input.value.trim();
  var cur = labelList().find(function (l) { return l.id === id; });
  if (!cur || !name || name === cur.name) { renderLabels(); return; }
  var target = labelOf(name), merge = target && target.id !== id;
  if (isOnline()) {
    apiAuth("PATCH", "/schedule/labels/" + encodeURIComponent(id), authToken(), { name: name }).then(function (res) {
      if (!res.ok) { renderLabels(); showError(apiErr(res, "Không đổi được tên nhãn.")); return; }
      lb.labels = res.data.labels;
      reload();
      toast(res.data.merged_into ? "Đã gộp vào nhãn “" + target.name + "”" : "Đã đổi tên nhãn");
    });
    return;
  }
  var old = cur.k, wasHidden = lb.hideSample.has(old);
  lb.ev.forEach(function (x) { if (lk(x.lbl) === old) { x.lbl = name; if (merge) x.col = target.col; } });
  lb.hideSample.delete(old); if (wasHidden) lb.hideSample.add(lk(name));
  renderLabels(); renderGrid();
  toast(merge ? "Đã gộp vào nhãn “" + target.name + "”" : "Đã đổi tên nhãn");
}

/* ---------- lưới Ngày / Tuần ---------- */
function gridSize() {
  var g = $("lb-grid");
  return { w: g.clientWidth, h: g.clientHeight };
}
function evStyle(e) { return "--c:" + colorOf(e); }
function layoutDay(list) {      // chia cột cho các sự kiện trùng giờ (như mẫu)
  var items = list.map(function (e) { return { e: e, s: e.s, en: Math.max(e.e, e.s + 40) }; }).sort(function (a, b) { return a.s - b.s || b.en - a.en; });
  var group = [], end = -1, out = [];
  function flush() {
    var cols = [];
    group.forEach(function (it) { var c = cols.findIndex(function (x) { return x <= it.s; }); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.en; it.col = c; });
    group.forEach(function (it) { it.n = cols.length; });
    out.push.apply(out, group); group = [];
  }
  items.forEach(function (it) { if (it.s >= end && group.length) flush(); group.push(it); end = Math.max(end, it.en); });
  if (group.length) flush();
  return out;
}
function evBlock(it, x, w, HH) {      // toạ độ trong thân cuộn (.lb-tin), 0 = 00:00
  var e = it.e, gap = 3, cw = (w - gap * (it.n - 1)) / it.n;
  var top = (Math.max(e.s, H0 * 60) / 60 - H0) * HH + 1;
  var h = e.type === "deadline" ? 27 : Math.max(27, (Math.min(e.e, H1 * 60) - Math.max(e.s, H0 * 60)) / 60 * HH - 3);
  var cls = ["lb-ev", e.type === "exam" ? "exam" : "", h < 45 || cw < 70 ? "tight" : "", lb.sel === e.id ? "sel" : "", e.draft ? "draft" : ""].join(" ");
  var time = e.type === "deadline" ? "" : "<span>" + hm(e.s) + " – " + hm(e.e) + "</span>";
  var name = e.draft ? esc(e.title || "Mới") : e.type === "deadline" ? FLAG + esc(label(e)) : esc(label(e));
  return '<button type="button" class="' + cls + '" ' + (e.draft ? "" : 'data-ev="' + esc(e.id) + '"') + ' style="' + evStyle(e) + ";left:" + (x + it.col * (cw + gap)) + "px;top:" + top + "px;width:" + cw + "px;height:" + h + 'px" title="' + esc(e.title) + '"><b>' + name + "</b>" + (h >= 45 ? time : "") + "</button>";
}
function renderTime(days) {
  var g = $("lb-grid"), t = today(), n = days.length;
  g.style.overflowY = "hidden";
  var oldBody = $("lb-tbody");
  if (oldBody) lb.scrollTop = oldBody.scrollTop;
  g.innerHTML = '<div class="lb-thead" id="lb-thead" style="height:' + TOP + 'px"></div>' +
    '<div class="lb-tbody" id="lb-tbody" style="top:' + TOP + 'px"><div class="lb-tin" id="lb-tin"></div></div>';
  var body = $("lb-tbody");
  var HH = Math.max(MIN_HH, body.clientHeight / HOURS_IN_VIEW);
  var W = body.clientWidth, cw = (W - TW) / n, H = HH * (H1 - H0);   // bề rộng theo thân (đã trừ thanh cuộn) -> tiêu đề thẳng cột
  var head = "", h = "";
  for (var k = 1; k < H1 - H0; k++) {
    h += '<div class="lb-hl" style="left:' + TW + "px;right:0;top:" + (k * HH - 1) + 'px"></div>';
    h += '<span class="lb-hr" style="top:' + (k * HH - 9) + 'px">' + pad(H0 + k) + ":00</span>";
  }
  h += '<div class="lb-slots" id="lb-slots" style="left:' + TW + "px;top:0;height:" + H + 'px"></div>';
  days.forEach(function (d, i) {
    var x = TW + i * cw;
    head += '<div class="lb-vl" style="left:' + (x - 1) + 'px"></div>';
    h += '<div class="lb-vl" style="left:' + (x - 1) + 'px;height:' + H + 'px"></div>';
    head += n > 1
      ? '<button type="button" class="lb-dh ' + (same(d, t) ? "today" : "") + '" data-day="' + key(d) + '" style="left:' + x + "px;width:" + cw + 'px"><small>' + DOW[d.getDay()] + "</small><b>" + d.getDate() + "</b></button>"
      : '<div class="lb-dh row ' + (same(d, t) ? "today" : "") + '" style="left:' + x + "px;right:0;height:" + TOP + 'px"><small>' + DOW[d.getDay()] + "</small><b>" + d.getDate() + "</b></div>";
    var list = visible(d).slice();
    if (lb.draft && lb.draft.date === key(d)) list.push(lb.draft);
    layoutDay(list).forEach(function (it) { h += evBlock(it, x + 3, cw - 6, HH); });
    if (same(d, t)) h += '<div class="lb-now" style="left:' + x + "px;width:" + cw + "px;top:" + (nowMin() / 60 * HH - 1) + 'px"></div>';
  });
  $("lb-thead").innerHTML = head;
  var tin = $("lb-tin");
  tin.style.height = H + "px";
  tin.innerHTML = h;
  if (n === 1 && !visible(days[0]).length && !lb.draft) {
    g.insertAdjacentHTML("beforeend", '<div class="lb-empty"><span class="ic"><svg width="22" height="22" viewBox="0 0 26 26" fill="none"><rect x="3" y="5" width="20" height="18" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M3 10.5h20M8.5 2.5v4.5M17.5 2.5v4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>' +
      "<b>Không có sự kiện nào trong ngày này</b><p>Thêm buổi học, deadline hoặc lịch thi để lên kế hoạch ôn tập.</p>" +
      '<button type="button" class="lb-btn-primary" id="lb-empty-add">+&nbsp;&nbsp;Thêm sự kiện</button></div>');
    $("lb-empty-add").onclick = function (ev) { ev.stopPropagation(); openForm({ date: key(days[0]) }); };
  }
  // Giữ vị trí cuộn khi vẽ lại cùng khoảng xem; khoảng xem mới -> cuộn tới 07:00 (hoặc trước giờ hiện tại 1 giờ)
  var sk = lb.view + "|" + key(days[0]);
  if (sk !== lb.scrollKey) {
    lb.scrollKey = sk;
    var hasToday = days.some(function (d) { return same(d, t); });
    lb.scrollTop = Math.max(0, (hasToday ? Math.min(SCROLL_HOUR, nowMin() / 60 - 1) : SCROLL_HOUR) * HH);
  }
  setScroll(lb.scrollTop);
  body.onscroll = function () {
    lb.scrollTop = body.scrollTop;
    // người dùng tự cuộn -> đóng chi tiết (bỏ qua cuộn do code và cuộn ngay sau khi vừa mở, vd. trình duyệt đưa ô vào tầm nhìn)
    var t0 = Date.now();
    if (t0 - lb.progScrollAt > 150 && t0 - lb.popAt > 400 && !$("lb-pop").hidden) closePop();
  };
  $("lb-slots").onclick = function (ev) {      // bấm ô trống -> thêm sự kiện tại giờ đó (làm tròn 30')
    var r = $("lb-slots").getBoundingClientRect();
    var col = Math.min(n - 1, Math.max(0, Math.floor((ev.clientX - r.left) / cw)));
    var m = Math.floor((ev.clientY - r.top) / HH * 2) * 30;
    m = Math.min(Math.max(m, 0), 23 * 60);
    closePop(); openForm({ date: key(days[col]), s: m, e: Math.min(m + 60, DAY_END) });
  };
}
function setScroll(top) {
  var body = $("lb-tbody"); if (!body) return;
  lb.progScrollAt = Date.now();
  body.scrollTop = top;
}
// Cuộn thân lưới để thấy 1 sự kiện (bấm thông báo của sự kiện ngoài vùng đang thấy).
function revealEvent(el) {
  var body = $("lb-tbody"); if (!body || !body.contains(el)) return;
  var top = el.offsetTop, bottom = top + el.offsetHeight;
  if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) setScroll(Math.max(0, top - body.clientHeight / 3));
  lb.scrollTop = body.scrollTop;
}

/* ---------- lưới Tháng ---------- */
function renderMonth() {
  var g = $("lb-grid"); g.style.overflowY = "hidden";
  var sz = gridSize(), first = new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1), rows = monthRows(first), t = today();
  var cw = sz.w / 7, hh = 34, rh = (sz.h - hh) / rows.length, maxChips = Math.max(1, Math.floor((rh - 33) / 24));
  var h = '<div class="lb-hl top" style="top:' + (hh - 1) + 'px"></div>';
  ["T2", "T3", "T4", "T5", "T6", "T7", "CN"].forEach(function (x, i) {
    h += '<span class="lb-mhd" style="left:' + i * cw + "px;width:" + cw + "px;height:" + hh + 'px">' + x + "</span>";
    if (i) h += '<div class="lb-vl" style="left:' + (i * cw - 1) + 'px"></div>';
  });
  rows.forEach(function (r, ri) {
    if (ri) h += '<div class="lb-hl" style="left:0;right:0;top:' + (hh + ri * rh - 1) + 'px;background:var(--lb-line)"></div>';
    for (var i = 0; i < 7; i++) {
      var d = addD(r, i), list = visible(d), shown = list.length > maxChips ? list.slice(0, maxChips - 1) : list;
      h += '<div class="lb-cell ' + (d.getMonth() !== first.getMonth() ? "out " : "") + (same(d, t) ? "today" : "") + '" data-cell="' + key(d) + '" style="left:' + i * cw + "px;top:" + (hh + ri * rh) + "px;width:" + (cw - 1) + "px;height:" + (rh - 1) + 'px">' +
        '<button type="button" class="dn" data-day="' + key(d) + '">' + d.getDate() + "</button>" +
        shown.map(function (e) {
          var txt = e.type === "deadline" ? FLAG + esc(label(e)) : e.type === "exam" ? hm(e.s) + " " + esc(label(e).replace("giữa kỳ ", "")) : hm(e.s) + " " + esc(e.abbr || label(e));
          return '<button type="button" class="lb-mc ' + (e.type === "exam" ? "exam " : "") + (lb.sel === e.id ? "sel" : "") + '" data-ev="' + esc(e.id) + '" style="' + evStyle(e) + '" title="' + esc(e.title) + '">' + txt + "</button>";
        }).join("") +
        (list.length > shown.length ? '<button type="button" class="lb-more" data-day="' + key(d) + '">+' + (list.length - shown.length) + " sự kiện khác</button>" : "") + "</div>";
    }
  });
  g.innerHTML = h;
}

function renderGrid() {
  if (!lb.open) return;
  if (lb.view === "month") renderMonth();
  else if (lb.view === "week") { var a = mon(lb.cur); renderTime([0, 1, 2, 3, 4, 5, 6].map(function (i) { return addD(a, i); })); }
  else renderTime([lb.cur]);
  if (lb.pendingPop && inLoaded(lb.pendingPop.date)) {   // bấm thông báo -> mở chi tiết khi dữ liệu tháng đó đã về
    var p = lb.pendingPop, ev = findEv(p.id);
    lb.pendingPop = null;
    lb.popReq = { p: p, at: Date.now() };
    if (!ev) { toast("Không tìm thấy sự kiện này (đã bị xoá hoặc dời ngày)"); return; }
    if (isHidden(ev)) { showLabelOf(ev); return; }          // nhãn đang ẩn -> hiện lại rồi mở (như mẫu)
    var occId = isRepeat(ev) ? ev.id + "@" + p.date : ev.id;
    var el = document.querySelector('#lb-grid [data-ev="' + occId + '"]');
    if (el) { revealEvent(el); openPop(occId, el); }
  }
}

/* ====================================================================
   D · Chi tiết sự kiện
   ==================================================================== */
function findEv(id) {
  var e = lb.ev.find(function (x) { return x.id === id; });
  if (e || String(id).indexOf("@") < 0) return e;
  var at = String(id).lastIndexOf("@"), base = findEv(id.slice(0, at));   // 1 lần xuất hiện của sự kiện lặp
  return base ? occOf(base, id.slice(at + 1)) : null;
}
function relPos(node) {
  var c = $("lb-pane").getBoundingClientRect(), r = node.getBoundingClientRect();
  return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, pw: c.width, ph: c.height };
}
function whenText(e) {
  var d = parse(e.date);
  return DOWF[d.getDay()] + ", " + d.getDate() + " tháng " + (d.getMonth() + 1) + " · " + (e.type === "deadline" ? "Hạn " + hm(e.s) : hm(e.s) + " – " + hm(e.e));
}
function dmy(k) { var d = parse(k); return d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear(); }
function repeatName(rule, dateKey) {
  var d = parse(dateKey);
  if (rule === "weekly") return "Hằng tuần vào " + DOWF[d.getDay()];
  if (rule === "monthly") return "Hằng tháng vào ngày " + d.getDate();
  if (rule === "yearly") return "Hằng năm vào ngày " + d.getDate() + "/" + (d.getMonth() + 1);
  return "Không lặp lại";
}
function repeatText(e) { return repeatName(e.repeat, (e.base || e).date) + (e.until ? " · đến " + dmy(e.until) : ""); }
function remText(e) {
  if (e.remind === "none") return "Không nhắc";
  var ch = Object.keys(VIA).filter(function (k) { return e.via[k]; }).map(function (k) { return VIA[k]; });
  return REMS[e.remind] + " · " + (ch.join(", ") || "chưa chọn kênh");
}
function openPop(id, node) {
  if (lb.sel === id) { closePop(); return; }
  closeNotif();
  var e = findEv(id); if (!e) return;
  lb.sel = id; lb.popAt = Date.now();
  document.querySelectorAll("#lb-grid [data-ev]").forEach(function (x) { x.classList.toggle("sel", x.dataset.ev === id); });
  var p = $("lb-pop");
  p.style.cssText = evStyle(e);
  var subj = e.subjectName ? esc(e.subjectName) + (e.chapterName ? " · " + esc(e.chapterName) : "") +
    (e.chapterId ? ' <button type="button" class="lb-link" id="lb-p-open" title="Mở Chương trong Notebook">Mở</button>' : "") : "";
  p.innerHTML = '<div class="acts">' +
      '<button type="button" class="lb-icb" id="lb-p-edit" aria-label="Sửa" title="Sửa"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3l8-8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>' +
      '<button type="button" class="lb-icb" id="lb-p-del" aria-label="Xoá" title="Xoá"><svg width="14" height="15" viewBox="0 0 16 17" fill="none"><path d="M2 4h12M6 4V2.5h4V4M3.5 4l.8 10.5h7.4L12.5 4M6.5 7v5M9.5 7v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      '<button type="button" class="lb-icb" id="lb-p-close" aria-label="Đóng" title="Đóng"><svg width="10" height="10" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>' +
    "<h3><i></i>" + esc(e.title) + '</h3><div class="when">' + whenText(e) + "</div>" +
    "<dl><dt>Loại</dt><dd>" + TYPES[e.type] + "</dd>" +
      ((e.lbl || "").trim() ? "<dt>Nhãn</dt><dd>" + esc(e.lbl.trim()) + "</dd>" : "") +
      (subj ? "<dt>Môn học</dt><dd>" + subj + "</dd>" : "") +
      (isRepeat(e) ? "<dt>Lặp lại</dt><dd>" + repeatText(e) + "</dd>" : "") +
      "<dt>Nhắc trước</dt><dd>" + remText(e) + "</dd></dl>";
  p.hidden = false;
  var r = relPos(node), W = 352, H = p.offsetHeight;
  var x = r.x + r.w + 10; if (x + W > r.pw - 16) x = r.x - W - 10; if (x < 16) x = Math.min(r.pw - W - 16, Math.max(16, r.x + r.w / 2 - W / 2));
  var y = Math.max(70, Math.min(r.y - 30, r.ph - H - 16));
  p.style.left = x + "px"; p.style.top = y + "px";
  $("lb-p-close").onclick = closePop;
  $("lb-p-edit").onclick = function () { closePop(); openForm(null, e.base || e); };   // sự kiện lặp: sửa cả chuỗi
  $("lb-p-del").onclick = function () { askDelete(e.base || e); };
  if ($("lb-p-open")) $("lb-p-open").onclick = function () {
    closePop();
    hooks.openSource({ subject_id: e.subjectId, chapter_id: e.chapterId });
  };
}
function closePop() {
  lb.sel = null;
  if ($("lb-pop")) $("lb-pop").hidden = true;
  document.querySelectorAll("#lb-grid [data-ev].sel").forEach(function (x) { x.classList.remove("sel"); });
}

/* ====================================================================
   E · Xoá (UC-28) & Hoàn tác
   ==================================================================== */
function askDelete(e) {
  lb.pendingDel = e;
  $("lb-d-text").textContent = "“" + e.title + "”" + (isRepeat(e) ? " và mọi lần lặp lại" : "") + " sẽ bị xoá khỏi thời gian biểu." + (e.remind !== "none" ? " Các nhắc nhở đã lên lịch cho sự kiện này cũng bị huỷ." : "");
  $("lb-del-modal").hidden = false; $("lb-d-ok").focus();
}
function cancelDelete() { $("lb-del-modal").hidden = true; lb.pendingDel = null; }
function confirmDelete() {
  var e = lb.pendingDel; $("lb-del-modal").hidden = true; if (!e) return;
  lb.pendingDel = null;
  var done = function () {
    lb.lastDel = { e: e, i: lb.ev.indexOf(e) };
    lb.ev = lb.ev.filter(function (x) { return x !== e; });
    closePop(); renderLabels(); renderGrid();
    $("lb-snack-text").textContent = e.remind !== "none" ? "Đã xoá sự kiện và huỷ nhắc nhở" : "Đã xoá sự kiện";
    $("lb-toast").hidden = true; $("lb-snack").hidden = false;
    clearTimeout(confirmDelete.t); confirmDelete.t = setTimeout(function () { $("lb-snack").hidden = true; }, 6000);
  };
  if (!isOnline()) { done(); return; }
  apiAuth("DELETE", "/schedule/items/" + encodeURIComponent(e.id), authToken()).then(function (res) {
    if (!res.ok) { showError(apiErr(res, "Không xoá được sự kiện.")); return; }
    lb.labels = res.data.labels || lb.labels;
    done();
  });
}
function undoDelete() {
  var d = lb.lastDel; if (!d) return;
  lb.lastDel = null; $("lb-snack").hidden = true;
  if (!isOnline()) { lb.ev.splice(d.i, 0, d.e); renderLabels(); renderGrid(); toast("Đã khôi phục sự kiện"); return; }
  apiAuth("POST", "/schedule/items", authToken(), toPayload(d.e)).then(function (res) {
    if (!res.ok) { showError(apiErr(res, "Không khôi phục được sự kiện.")); return; }
    lb.labels = res.data.labels; reload(); toast("Đã khôi phục sự kiện");
  });
}

/* ====================================================================
   G · Thông báo (UC-31) — dữ liệu, tiếng chuông, hộp báo góc phải và cách vẽ danh sách nằm ở ghichu_thongbao.js
   (dùng chung với chuông topbar trang soạn thảo). Ở đây chỉ còn chuông của màn Lịch biểu + mở đúng sự kiện.
   ==================================================================== */
function ringBell() {
  var b = $("lb-bell"); if (!b) return;
  b.classList.remove("ring"); void b.offsetWidth; b.classList.add("ring");
  clearTimeout(ringBell.t); ringBell.t = setTimeout(function () { b.classList.remove("ring"); }, 2200);
}
function renderBell() { if ($("lb-bell-dot")) $("lb-bell-dot").hidden = !(Thongbao.unreadCount() > 0); }
function renderNotif() { Thongbao.renderPanel($("lb-notif"), { onProfile: goProfile }); }
// Mở Hồ sơ (UC-06) để nhập email — Lịch biểu vẫn mở phía sau; lưu Hồ sơ xong ghichu.js gọi onProfileSaved().
function goProfile() { closeNotif(); closeForm(); hooks.openProfile(); }
export function onProfileSaved(p) {
  if (!p) return;
  Thongbao.setEmail(p.effective_email);
  if (lb.open && isOnline()) Thongbao.load();
}
function toggleNotif() {
  if (!$("lb-notif").hidden) { closeNotif(); return; }
  closePop(); renderNotif(); $("lb-notif").hidden = false; $("lb-bell").classList.add("on");
  Thongbao.load();
}
function closeNotif() {
  if (!$("lb-notif")) return;
  $("lb-notif").hidden = true; $("lb-bell").classList.remove("on");
}
// Thông báo nhắc lịch (kind 'schedule'; ghichu.js đã mở Lịch biểu) -> về đúng tuần rồi mở chi tiết sự kiện.
export function showNotiEvent(n) {
  closeNotif();
  if (!n.itemId) { toast("Sự kiện này đã bị xoá"); return; }
  var ev = findEv(n.itemId);
  // sự kiện có thể đã bị dời ngày sau khi nhắc; sự kiện lặp: đúng lần xuất hiện đã nhắc
  lb.pendingPop = { id: n.itemId, date: ev && !(isRepeat(ev) && occursOn(ev, n.date)) ? ev.date : n.date };
  if (!ev && isOnline()) lb.loaded = null;   // sự kiện tạo/sửa ở nơi khác chưa có trong dữ liệu đã tải -> tải lại
  goDate(parse(lb.pendingPop.date), lb.view === "month" ? "month" : "week");
}
// Chế độ mẫu: dựng dữ liệu minh hoạ sớm (lúc vào trang) để chuông topbar có thông báo mẫu gắn với sự kiện mẫu.
export function prepareSample() { if (!isOnline()) initSample(); }

/* ====================================================================
   B · Thêm / sửa sự kiện (UC-26)
   ==================================================================== */
var F = {};
var formMenuFor = null;
function defaultDate() {   // ngày đang xem; nếu khoảng đang xem có hôm nay thì lấy hôm nay (như mẫu)
  var t = today();
  if (lb.view === "day") return key(lb.cur);
  if (lb.view === "week") return key(same(mon(lb.cur), mon(t)) ? t : mon(lb.cur));
  var first = new Date(lb.cur.getFullYear(), lb.cur.getMonth(), 1);
  return key(t.getMonth() === first.getMonth() && t.getFullYear() === first.getFullYear() ? t : first);
}
function hasEmail() { var m = Thongbao.email(); return !isOnline() || !!(m && m.effective); }
function openForm(pre, edit) {
  closeNotif();
  var base = edit || {};
  var s = pre && pre.s != null ? pre.s : Math.min(Math.ceil((nowMin() + 1) / 30) * 30, 23 * 60);
  F = {
    edit: edit ? edit.id : null,
    title: base.title || "", type: base.type || "event",
    lbl: edit ? (edit.lbl || "") : "", lblTouched: !!edit && lk(edit.lbl) !== lk(edit.title), colTouched: false,
    date: base.date || (pre && pre.date) || defaultDate(),
    s: edit ? edit.s : s, e: edit ? edit.e : (pre && pre.e) || Math.min(s + 60, DAY_END),
    repeat: base.repeat || "none", until: base.until || null,
    col: edit ? colorOf(edit) : (openForm.last || PALETTE[0][0]),
    remind: base.remind || "m30",
    via: Object.assign({}, base.via || { app: true, email: hasEmail(), push: false }),
    subjectId: base.subjectId || null, chapterId: base.chapterId || null,
    subjectName: base.subjectName || null, chapterName: base.chapterName || null,
    remote: null, saving: false, err: "", colMsg: "",
  };
  $("lb-m-title").textContent = edit ? "Sửa sự kiện" : "Thêm sự kiện";
  $("lb-f-title").value = F.title; $("lb-f-title").classList.remove("err");
  $("lb-f-lbl").value = F.lbl;
  $("lb-ev-modal").hidden = false;
  renderForm();
  setTimeout(function () { if (!$("lb-ev-box").contains(document.activeElement)) $("lb-f-title").focus(); }, 30);
}
function closeForm() {
  if (!$("lb-ev-modal") || $("lb-ev-modal").hidden) return;
  $("lb-ev-modal").hidden = true; closeMenu(); lb.draft = null; renderGrid();
}
function inLoaded(dateKey) { return !isOnline() || (lb.loaded && lb.loaded.from <= dateKey && lb.loaded.to >= dateKey); }
// BR-11: trùng khung giờ (deadline là 1 mốc giờ nên không tính). Ngày ngoài khoảng đã tải -> hỏi máy chủ.
function conflicts() {
  if (F.type === "deadline") return [];
  if (inLoaded(F.date)) {
    return lb.ev.filter(function (e) { return e.id !== F.edit && occursOn(e, F.date) && e.type !== "deadline" && e.s < F.e && F.s < e.e; })
      .sort(function (a, b) { return a.s - b.s; });
  }
  var k = [F.date, F.s, F.e, F.type].join("|");
  if (F.remote && F.remote.k === k) return F.remote.list;
  if (!F.remoteBusy || F.remoteBusy !== k) {
    F.remoteBusy = k;
    var q = "?date=" + F.date + "&start_minute=" + F.s + "&end_minute=" + F.e + "&item_type=" + F.type + (F.edit ? "&exclude_id=" + encodeURIComponent(F.edit) : "");
    apiAuth("GET", "/schedule/conflicts" + q, authToken()).then(function (res) {
      if (!res.ok || F.remoteBusy !== k) return;
      F.remote = { k: k, list: res.data.map(function (c) { return { title: c.title, s: c.start_minute, e: c.end_minute }; }) };
      if (!$("lb-ev-modal").hidden) renderForm();
    });
  }
  return [];
}
function subjectsList() { return state.subjects || []; }
function renderForm() {
  var d = parse(F.date), dl = F.type === "deadline";
  Array.from($("lb-f-type").children).forEach(function (b) { b.classList.toggle("on", b.dataset.v === F.type); });
  $("lb-f-time-lbl").textContent = dl ? "Hạn lúc" : "Thời gian";
  $("lb-f-date").innerHTML = DOWF[d.getDay()] + ", " + d.getDate() + "/" + (d.getMonth() + 1) + " " + CHEV;
  $("lb-f-start").textContent = hm(F.s); $("lb-f-end").textContent = hm(F.e);
  $("lb-f-end").hidden = $("lb-f-dash").hidden = dl;
  var bad = !dl && F.e <= F.s;
  $("lb-f-end").classList.toggle("err", bad); $("lb-f-err").hidden = !bad;
  // Lặp lại (tuỳ chọn) + "Đến ngày" (trống = lặp mãi)
  var rep = F.repeat !== "none", untilBad = rep && !!F.until && F.until < F.date;
  $("lb-f-repeat").innerHTML = repeatName(F.repeat, F.date) + " " + CHEV;
  $("lb-f-until").hidden = !rep;
  $("lb-f-until").innerHTML = (F.until ? "Đến " + dmy(F.until) : "Không kết thúc") + " " + CHEV;
  $("lb-f-until").classList.toggle("err", untilBad);
  var repHint = untilBad ? "Ngày kết thúc lặp lại phải từ ngày bắt đầu trở đi."
    : rep && F.repeat === "monthly" && d.getDate() > 28 ? "Tháng không có ngày " + d.getDate() + " sẽ được bỏ qua."
    : rep && F.repeat === "yearly" && d.getDate() === 29 && d.getMonth() === 1 ? "Chỉ lặp lại vào năm nhuận." : "";
  $("lb-f-repeat-hint").hidden = !repHint; $("lb-f-repeat-hint").textContent = repHint;
  $("lb-f-repeat-hint").classList.toggle("red", untilBad);
  var cf = bad ? [] : conflicts();
  $("lb-f-warn").hidden = !cf.length;
  if (cf.length) $("lb-f-warn").textContent = "Trùng giờ với “" + label(cf[0]) + "” (" + hm(cf[0].s) + " – " + hm(cf[0].e) + ")" + (cf.length > 1 ? " và " + (cf.length - 1) + " sự kiện khác" : "") + ". Bạn vẫn có thể lưu sự kiện này.";
  // Môn học / Chương (UC-26 1a)
  var sub = F.subjectId ? subjectsList().find(function (x) { return x.id === F.subjectId; }) : null;
  var subName = sub ? sub.name : (F.subjectId ? (F.subjectName || "Môn đã xoá") : "Không liên kết");
  $("lb-f-subject").innerHTML = "<span>" + esc(subName) + "</span> " + CHEV;
  $("lb-f-chapter").hidden = !F.subjectId;
  if (F.subjectId) {
    var ch = F.chapterId && sub ? (sub.chapters || []).find(function (c) { return c.id === F.chapterId; }) : null;
    $("lb-f-chapter").innerHTML = "<span>" + esc(ch ? ch.name : (F.chapterId ? (F.chapterName || "Chương") : "Cả môn")) + "</span> " + CHEV;
  }
  // Màu — mỗi nhãn một màu riêng (sự kiện không nhãn cũng không được mượn màu nhãn): màu đã thuộc nhãn KHÁC bị ẩn,
  // màu chưa dùng (PALETTE rồi RESERVE) lấp đầy PALETTE_SLOTS ô; màu tự chọn bằng "+" luôn hiện thêm nếu chưa bị chiếm.
  var taken = takenColors();
  var cols = ALL_COLORS.filter(function (c) { return !taken[lc(c[0])]; }).slice(0, PALETTE_SLOTS)
    .concat(lb.customCols.filter(function (c) { return !taken[lc(c)]; }).map(function (c) { return [c, "Màu tự chọn"]; }));
  if (taken[lc(F.col)] && cols.length) F.col = cols[0][0];   // vd. vừa đổi tên nhãn / màu lần trước đã bị chiếm
  if (!taken[lc(F.col)] && !cols.some(function (c) { return lc(c[0]) === lc(F.col); })) cols.push([F.col, "Màu hiện tại"]);
  $("lb-f-col").innerHTML = cols.map(function (c) {
    return '<button type="button" class="lb-sw1 ' + (lc(c[0]) === lc(F.col) ? "on" : "") + '" data-v="' + c[0] + '" style="--c:' + c[0] + '" aria-label="Màu ' + esc(c[1]) + '" title="' + esc(c[1]) + '"></button>';
  }).join("") + '<label class="lb-addc" title="Chọn màu khác">+<input type="color" id="lb-f-pick" value="#3a7bd5" aria-label="Chọn màu khác"></label>';
  $("lb-f-pick").addEventListener("change", function (ev) {
    var c = addColor(ev.target.value);
    if (taken[lc(c)]) { F.colMsg = "Màu này đã dùng cho nhãn “" + taken[lc(c)] + "”. Mỗi nhãn một màu riêng — chọn màu khác."; renderForm(); return; }
    F.col = c; F.colTouched = true; F.colMsg = ""; renderForm(); setTimeout(function () { $("lb-f-lbl").focus(); }, 0);
  });
  var colBad = !!taken[lc(F.col)];   // hết màu trống trong bảng -> phải tự chọn màu khác bằng "+"
  var colHint = F.colMsg || (colBad ? "Mọi màu trong bảng đã thuộc nhãn khác. Bấm + để chọn một màu mới." : "");
  $("lb-f-col-hint").hidden = !colHint; $("lb-f-col-hint").textContent = colHint;
  $("lb-f-col-hint").classList.toggle("red", !!F.colMsg || colBad);
  // Nhãn
  if (document.activeElement !== $("lb-f-lbl")) $("lb-f-lbl").value = F.lbl;
  $("lb-f-sync").hidden = !F.lblTouched || lk(F.lbl) === lk(F.title);
  var ex = labelOf(F.lbl), editEv = F.edit ? findEv(F.edit) : null;
  var own = ex && editEv && ex.n === 1 && lk(editEv.lbl) === ex.k;
  $("lb-f-lbl-hint").hidden = !ex || own;
  if (ex && !own) $("lb-f-lbl-hint").textContent = ex.col === F.col ? "Dùng màu của nhãn có sẵn “" + ex.name + "”." : "Đổi màu sẽ áp dụng cho mọi sự kiện có nhãn “" + ex.name + "”.";
  // Nhắc trước + kênh
  $("lb-f-rem").innerHTML = REM[F.remind] + " " + CHEV;
  var noRem = F.remind === "none";
  Array.from($("lb-f-via").children).forEach(function (b) {
    var k = b.dataset.k, lock = noRem || (k === "email" && !hasEmail());
    b.classList.toggle("on", !!F.via[k]);
    b.innerHTML = "<i>" + CHECK + "</i>" + VIA[k];
    b.disabled = lock;
    b.style.opacity = noRem ? ".4" : "";
  });
  $("lb-f-via-hint").hidden = noRem || hasEmail();
  $("lb-f-via-hint").innerHTML = 'Chưa có email nhận nhắc. <button type="button" class="lb-link" id="lb-f-go-profile">Nhập email trong Hồ sơ</button>';
  $("lb-f-go-profile").onclick = function (ev) { ev.stopPropagation(); goProfile(); };
  $("lb-f-save-err").hidden = !F.err; $("lb-f-save-err").textContent = F.err;
  $("lb-m-save").disabled = bad || untilBad || colBad || !F.title.trim() || F.saving;
  $("lb-m-save").textContent = F.saving ? "Đang lưu…" : "Lưu";
  // xem trước sự kiện trên lưới (khung nét đứt)
  lb.draft = { id: "draft", draft: true, title: F.title.trim() || "Mới", type: F.type, col: F.col, lbl: "", date: F.date, s: F.s, e: dl ? F.s : Math.max(F.e, F.s + 30) };
  if (lb.view !== "month") {
    var inView = lb.view === "day" ? F.date === key(lb.cur) : same(mon(parse(F.date)), mon(lb.cur));
    if (!inView) lb.draft = null;
  }
  renderGrid();
}
// Màu tự chọn: chữ/viền dùng màu đậm (tự làm tối nếu quá nhạt) — như mẫu.
function addColor(hex) {
  hex = hex.toLowerCase();
  var found = ALL_COLORS.concat(lb.customCols.map(function (c) { return [c]; })).find(function (c) { return c[0] === hex; });
  if (found) return found[0];
  var rgb = [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); });
  var lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  if (lum > 0.55) { var f = 0.55 / lum; rgb = rgb.map(function (v) { return Math.round(v * f); }); }
  var out = "#" + rgb.map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
  if (lb.customCols.indexOf(out) < 0) lb.customCols.push(out);
  return out;
}
function pickLabelColor() { F.colMsg = ""; var ex = labelOf(F.lbl); if (ex && ex.col && !F.colTouched) F.col = ex.col; }
function lc(c) { return (c || "").toLowerCase(); }
// Màu đang thuộc nhãn KHÁC nhãn đang nhập ở form: {màu thường: tên nhãn}. Bỏ qua nhãn cũ chỉ còn đúng sự kiện đang sửa
// (đổi sang nhãn khác thì nhãn cũ tự bị xoá khi lưu nên màu của nó được giải phóng). Máy chủ kiểm lại (409).
function takenColors() {
  var me = lk(F.lbl), editEv = F.edit ? findEv(F.edit) : null, out = {};
  labelList().forEach(function (l) {
    if (!l.k || !l.col || l.k === me) return;
    if (editEv && lk(editEv.lbl) === l.k && l.n <= 1) return;
    out[lc(l.col)] = l.name;
  });
  return out;
}

/* ---------- menu thả xuống trong hộp thoại ---------- */
function openMenu(btn, html, onPick, cls) {
  var m = $("lb-fmenu");
  if (formMenuFor === btn && !m.hidden) { closeMenu(); return; }
  closeMenu(); formMenuFor = btn; btn.classList.add("open");
  m.className = "lb-fmenu " + (cls || ""); m.innerHTML = html; m.hidden = false;
  var box = $("lb-ev-box"), x = btn.offsetLeft, y = btn.offsetTop + btn.offsetHeight + 5;
  m.style.left = x + "px"; m.style.top = y + "px"; m.style.minWidth = btn.offsetWidth + "px";
  if (y + m.offsetHeight > box.offsetHeight - 8) m.style.top = Math.max(8, btn.offsetTop - m.offsetHeight - 5) + "px";
  if (x + m.offsetWidth > box.offsetWidth - 8) m.style.left = (box.offsetWidth - m.offsetWidth - 8) + "px";
  var on = m.querySelector(".on"); if (on && m.scrollHeight > m.clientHeight) m.scrollTop = on.offsetTop - 100;
  m.onclick = function (ev) { ev.stopPropagation(); onPick(ev); };
}
function closeMenu() { if (!$("lb-fmenu")) return; $("lb-fmenu").hidden = true; if (formMenuFor) formMenuFor.classList.remove("open"); formMenuFor = null; }
function opts(list, cur) {
  return list.map(function (o) { return '<button type="button" data-v="' + esc(String(o[0])) + '" class="' + (o[0] === cur ? "on" : "") + '">' + o[1] + "</button>"; }).join("");
}
function times(from, to) { var a = []; for (var m = from; m <= to; m += 15) a.push([m, hm(m)]); return a; }
var pickMonth = null;
function showDatePick(keepOpen) {
  var html = '<div class="lb-mini">' + miniHTML(pickMonth, F.date, null) + "</div>";
  if (keepOpen) { $("lb-fmenu").innerHTML = html; return; }
  openMenu($("lb-f-date"), html, function (ev) {
    var m = ev.target.closest("[data-m]"); if (m) { pickMonth = new Date(pickMonth.getFullYear(), pickMonth.getMonth() + +m.dataset.m, 1); showDatePick(true); return; }
    var d = ev.target.closest("[data-d]"); if (d) { F.date = d.dataset.d; closeMenu(); renderForm(); }
  }, "cal");
}

function showUntilPick(keepOpen) {
  var html = '<button type="button" class="lb-until-none' + (F.until ? "" : " on") + '" data-none="1">Không kết thúc</button>' +
    '<div class="lb-mini">' + miniHTML(pickMonth, F.until || "", null) + "</div>";
  if (keepOpen) { $("lb-fmenu").innerHTML = html; return; }
  openMenu($("lb-f-until"), html, function (ev) {
    if (ev.target.closest("[data-none]")) { F.until = null; closeMenu(); renderForm(); return; }
    var m = ev.target.closest("[data-m]"); if (m) { pickMonth = new Date(pickMonth.getFullYear(), pickMonth.getMonth() + +m.dataset.m, 1); showUntilPick(true); return; }
    var d = ev.target.closest("[data-d]"); if (d) { F.until = d.dataset.d; closeMenu(); renderForm(); }
  }, "cal");
}

function saveForm() {
  if ($("lb-m-save").disabled) return;
  openForm.last = F.col;
  var data = {
    title: F.title.trim(), lbl: F.lbl.trim(), type: F.type, col: F.col, date: F.date, s: F.s,
    e: F.type === "deadline" ? F.s : F.e, repeat: F.repeat, until: F.repeat !== "none" ? F.until : null,
    remind: F.remind, via: Object.assign({}, F.via),
    subjectId: F.subjectId, chapterId: F.subjectId ? F.chapterId : null,
  };
  if (!hasEmail()) data.via.email = false;
  data.via.push = false;
  var after = function (ev, wasEdit) {
    $("lb-ev-modal").hidden = true; closeMenu(); lb.draft = null;
    var d = parse(ev.date);
    var inView = lb.view === "month" ? d.getMonth() === lb.cur.getMonth() && d.getFullYear() === lb.cur.getFullYear()
      : lb.view === "week" ? same(mon(d), mon(lb.cur)) : same(d, lb.cur);
    if (isRepeat(ev) && ev.date <= key(lb.cur)) inView = true;   // chuỗi lặp đã bắt đầu: ở lại khoảng đang xem
    if (!inView) goDate(d); else render();
    toast(wasEdit ? "Đã lưu thay đổi" : "Đã thêm “" + ev.title + "”");
  };
  if (!isOnline()) {
    if (data.lbl) lb.ev.forEach(function (x) { if (lk(x.lbl) === lk(data.lbl)) x.col = F.col; });   // một nhãn – một màu
    var sub = data.subjectId ? subjectsList().find(function (x) { return x.id === data.subjectId; }) : null;
    var ch = sub && data.chapterId ? (sub.chapters || []).find(function (c) { return c.id === data.chapterId; }) : null;
    data.subjectName = sub ? sub.name : null; data.chapterName = ch ? ch.name : null;
    var ev;
    if (F.edit) { ev = findEv(F.edit); delete ev.short; delete ev.abbr; Object.assign(ev, data); }
    else ev = addSample(data);
    lb.hideSample.delete(lk(ev.lbl));
    after(ev, !!F.edit);
    return;
  }
  F.saving = true; F.err = ""; renderForm();
  var wasEdit = !!F.edit;
  var req = wasEdit ? apiAuth("PUT", "/schedule/items/" + encodeURIComponent(F.edit), authToken(), toPayload(data))
    : apiAuth("POST", "/schedule/items", authToken(), toPayload(data));
  req.then(function (res) {
    F.saving = false;
    if (!res.ok) { F.err = apiErr(res, "Không lưu được sự kiện."); renderForm(); return; }
    lb.labels = res.data.labels;
    var ev = fromApi(res.data.item);
    // nhãn vừa lưu đang bị ẩn -> hiện lại cho thấy sự kiện (như mẫu)
    var l = ev.labelId && lb.labels.find(function (x) { return x.id === ev.labelId; });
    if (l && l.is_hidden) { l.is_hidden = false; apiAuth("PATCH", "/schedule/labels/" + encodeURIComponent(l.id), authToken(), { is_hidden: false }); }
    if (!ev.lbl && lb.hideNone) { lb.hideNone = false; try { localStorage.setItem(HIDE_NONE_KEY, "0"); } catch (e) {} }
    lb.loaded = null;           // màu nhãn có thể đổi ở nhiều sự kiện -> tải lại khoảng đang xem
    after(ev, wasEdit);
  });
}

/* ---------- thông báo ngắn ---------- */
function toast(msg) {
  $("lb-snack").hidden = true;
  var t = $("lb-toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2200);
}

/* ====================================================================
   Gắn sự kiện DOM (1 lần)
   ==================================================================== */
export function initLichbieu() {
  if (!$("lb-pane")) return;   // ghichu_lichbieu.frag tải lỗi
  // Thông báo do ghichu_thongbao.js tải nền (Thongbao.initThongbao ở ghichu.js) — chuông ở đây chỉ vẽ lại theo.
  Thongbao.subscribe(function (type) {
    renderBell();
    if (!$("lb-notif").hidden) renderNotif();
    if (type === "announce" && lb.open) ringBell();   // đang ở Lịch biểu: chuông lắc THÊM — hộp báo vẫn hiện
  });
  renderBell();
  $("lb-back-btn").onclick = function (e) { e.stopPropagation(); closeLichbieu(); };
  $("lb-view-seg").onclick = function (e) { var b = e.target.closest("button"); if (b) setView(b.dataset.v); };
  $("lb-prev").onclick = function () { stepRange(-1); };
  $("lb-next").onclick = function () { stepRange(1); };
  $("lb-today").onclick = function () { lb.cur = today(); syncMini(); closePop(); saveResume(); render(); };
  $("lb-add").onclick = function (e) { e.stopPropagation(); closePop(); openForm(); };
  $("lb-bell").onclick = function (e) { e.stopPropagation(); toggleNotif(); };

  $("lb-mini").onclick = function (e) {
    var m = e.target.closest("[data-m]");
    if (m) { lb.mini = new Date(lb.mini.getFullYear(), lb.mini.getMonth() + +m.dataset.m, 1); renderMini(); return; }
    var d = e.target.closest("[data-d]");
    if (d) { lb.cur = parse(d.dataset.d); if (lb.view === "month") syncMini(); closePop(); saveResume(); render(); }
  };
  $("lb-labels").onclick = function (e) { var b = e.target.closest("button[data-lid]"); if (b) toggleLabel(b.dataset.lid); };
  $("lb-labels").addEventListener("keydown", function (e) {
    if (!e.target.matches("input.lb-lname")) return;
    if (e.key === "Enter") e.target.blur();
    if (e.key === "Escape") { e.stopPropagation(); e.target.value = ""; e.target.blur(); }
  });
  $("lb-labels").addEventListener("focusout", function (e) { if (e.target.matches("input.lb-lname")) renameLabel(e.target); });

  $("lb-grid").addEventListener("click", function (e) {
    var ev = e.target.closest("[data-ev]");
    if (ev) { e.stopPropagation(); openPop(ev.dataset.ev, ev); return; }
    var day = e.target.closest("[data-day]");
    if (day) { goDate(parse(day.dataset.day), "day"); return; }
    var cell = e.target.closest("[data-cell]");
    if (cell) { closePop(); openForm({ date: cell.dataset.cell }); }
  });
  $("lb-pane").addEventListener("click", function (e) {
    if (!$("lb-pop").hidden && !e.target.closest("#lb-pop, [data-ev], .lb-overlay, #lb-notif")) closePop();
    if (!$("lb-notif").hidden && !e.target.closest("#lb-notif, #lb-bell")) closeNotif();
  });

  // Xoá
  $("lb-d-cancel").onclick = cancelDelete;
  $("lb-del-modal").onclick = function (e) { if (e.target === $("lb-del-modal")) cancelDelete(); };
  $("lb-d-ok").onclick = confirmDelete;
  $("lb-undo").onclick = undoDelete;

  // Hộp Thêm/Sửa
  $("lb-f-title").addEventListener("input", function (e) {
    F.title = e.target.value;
    if (!F.lblTouched) { F.lbl = F.title; pickLabelColor(); }
    $("lb-f-title").classList.toggle("err", !F.title.trim()); renderForm();
  });
  $("lb-f-type").onclick = function (e) {
    var b = e.target.closest("button"); if (!b) return;
    F.type = b.dataset.v; if (F.type === "exam" && F.remind === "m30") F.remind = "d1"; renderForm();
  };
  $("lb-f-via").onclick = function (e) { var b = e.target.closest("[data-k]"); if (!b || b.disabled) return; F.via[b.dataset.k] = !F.via[b.dataset.k]; renderForm(); };
  $("lb-ev-box").addEventListener("click", function (e) { if (!e.target.closest("#lb-fmenu, .lb-dd")) closeMenu(); });
  $("lb-f-start").onclick = function () {
    openMenu($("lb-f-start"), opts(times(0, 23 * 60 + 45), F.s), function (e) {
      var b = e.target.closest("[data-v]"); if (!b) return;
      var len = F.e - F.s; F.s = +b.dataset.v; if (len > 0) F.e = Math.min(DAY_END, F.s + len); closeMenu(); renderForm();
    });
  };
  $("lb-f-end").onclick = function () {
    openMenu($("lb-f-end"), opts(times(15, 23 * 60 + 45).concat([[DAY_END, hm(DAY_END)]]), F.e), function (e) { var b = e.target.closest("[data-v]"); if (!b) return; F.e = +b.dataset.v; closeMenu(); renderForm(); });
  };
  $("lb-f-repeat").onclick = function () {
    openMenu($("lb-f-repeat"), opts(REPEATS.map(function (r) { return [r, repeatName(r, F.date)]; }), F.repeat), function (e) {
      var b = e.target.closest("[data-v]"); if (!b) return; F.repeat = b.dataset.v; if (F.repeat === "none") F.until = null; closeMenu(); renderForm();
    });
  };
  $("lb-f-until").onclick = function () { var d = parse(F.until || F.date); pickMonth = new Date(d.getFullYear(), d.getMonth(), 1); showUntilPick(); };
  $("lb-f-date").onclick = function () { var d = parse(F.date); pickMonth = new Date(d.getFullYear(), d.getMonth(), 1); showDatePick(); };
  $("lb-f-rem").onclick = function () {
    openMenu($("lb-f-rem"), opts(Object.keys(REM).map(function (k) { return [k, REM[k]]; }), F.remind), function (e) { var b = e.target.closest("[data-v]"); if (!b) return; F.remind = b.dataset.v; closeMenu(); renderForm(); });
  };
  $("lb-f-subject").onclick = function () {
    var list = [["", "Không liên kết"]].concat(subjectsList().map(function (s) { return [s.id, esc(s.name)]; }));
    if (list.length === 1) list.push(["__none", '<span style="color:var(--muted)">Chưa có Môn học nào trong Notebook</span>']);
    openMenu($("lb-f-subject"), opts(list, F.subjectId || ""), function (e) {
      var b = e.target.closest("[data-v]"); if (!b || b.dataset.v === "__none") return;
      var id = b.dataset.v || null;
      if (id !== F.subjectId) { F.subjectId = id; F.chapterId = null; }
      var sub = id ? subjectsList().find(function (s) { return s.id === id; }) : null;
      if (sub && !F.lblTouched) { F.lbl = sub.name; F.lblTouched = lk(F.lbl) !== lk(F.title); pickLabelColor(); }
      closeMenu(); renderForm();
    });
  };
  $("lb-f-chapter").onclick = function () {
    var sub = subjectsList().find(function (s) { return s.id === F.subjectId; });
    var list = [["", "Cả môn"]].concat(((sub && sub.chapters) || []).map(function (c) { return [c.id, esc(c.name)]; }));
    openMenu($("lb-f-chapter"), opts(list, F.chapterId || ""), function (e) { var b = e.target.closest("[data-v]"); if (!b) return; F.chapterId = b.dataset.v || null; closeMenu(); renderForm(); });
  };
  $("lb-f-col").onclick = function (e) { var b = e.target.closest("[data-v]"); if (!b || b.disabled) return; F.col = b.dataset.v; F.colTouched = true; F.colMsg = ""; renderForm(); };
  $("lb-f-lbl").addEventListener("input", function (e) { F.lbl = e.target.value; F.lblTouched = lk(F.lbl) !== lk(F.title); pickLabelColor(); renderForm(); });
  $("lb-f-sync").onclick = function () { F.lbl = F.title; F.lblTouched = false; pickLabelColor(); renderForm(); };
  $("lb-m-close").onclick = closeForm; $("lb-m-cancel").onclick = closeForm;
  $("lb-ev-modal").onclick = function (e) { if (e.target === $("lb-ev-modal")) closeForm(); };
  $("lb-m-save").onclick = saveForm;

  // Phím tắt: Esc đóng lớp trên cùng; Enter ở ô tên để lưu (như mẫu)
  document.addEventListener("keydown", function (e) {
    if (!lb.open) return;
    if (e.key === "Escape") {
      if (!$("lb-fmenu").hidden) { closeMenu(); return; }
      if (!$("lb-del-modal").hidden) { cancelDelete(); return; }
      if (!$("lb-ev-modal").hidden) { closeForm(); return; }
      if (!$("lb-pop").hidden) { closePop(); return; }
      if (!$("lb-notif").hidden) { closeNotif(); return; }
    }
    if (e.key === "Enter" && !$("lb-ev-modal").hidden && e.target === $("lb-f-title")) saveForm();
  });

  // Lưới đo kích thước thật -> vẽ lại khi cửa sổ / cột giữa đổi cỡ
  // Pane vừa hiện (mở từ thông báo) -> ResizeObserver vẽ lại ngay sau khi popup chi tiết vừa mở: mở lại popup đó.
  var redraw = function () {
    if (!lb.open) return;
    if (lb.popReq && Date.now() - lb.popReq.at < 800 && !$("lb-pop").hidden) lb.pendingPop = lb.popReq.p;
    closePop(); renderGrid();
  };
  if (window.ResizeObserver) new ResizeObserver(redraw).observe($("lb-grid"));
  else window.addEventListener("resize", redraw);
}
