/* ======================================================================
   ghichu_thongke.js — MODULE "Thống kê hiệu suất" (UC-29) + "Nhận xét AI" (UC-30). HTML ở html/ghichu_thongke.frag
   (nạp vào #mount-thongke-pane), style ở css/ghichu_thongke.css (mọi selector dưới .tk-pane). Logic port từ giao
   diện mẫu `thong-ke.html` (thanh trái Tổng quan / Notebook, 8 trang, biểu đồ SVG, popover chọn khoảng thời gian),
   GIỮ NGUYÊN bố cục mẫu — khác mẫu:
     - Số liệu thật từ backend (routers/stats.py — mọi con số tính ở services/stats.py), tên gọi theo app (Chương /
       Tệp PDF / Bộ ôn tập / Đề thi thử / Bộ thẻ / Sơ đồ / Tóm tắt thay cho "Tài liệu / Notebook / Quiz / Test").
     - Không còn khung 1440×1024 + zoom: biểu đồ là SVG có viewBox, rộng 100% thẻ chứa; màu theo token (giao diện Tối).
     - "Hôm nay" dùng dữ liệu thật (thẻ đến hạn, lịch hôm nay kể cả sự kiện lặp, bài làm dở / Chương đọc gần nhất);
       bỏ "Mục tiêu 10 giờ/tuần" (chưa có nơi đặt mục tiêu).
     - Trang Notebook: Chương + tệp PDF ngang hàng (đúng mô hình app), trạng thái Đã ôn / Đang học / Chưa ôn tính ở
       server; bấm mục -> mở trong Notebook (hooks.openSource), "Công cụ học tập" -> mở thẳng công cụ Studio.
     - Snapshot: tuần T2–CN đã xong tự chốt ở server (+ khi bấm "Phân tích ngay"), KHÔNG lưu mỗi lần xem như mẫu.
     - Nhận xét AI dùng chung hạn mức BR-08 (`ai_remaining`), E1 "quá ít dữ liệu" kiểm ở server trước khi gọi AI;
       "Thêm đề xuất vào Lịch biểu" tạo buổi ôn thật ở tuần sau (hộp xác nhận chọn đề xuất).

   Khuôn API (đổi field thì sửa ở đây + services/stats.py):
     GET  /stats/today                       -> {week{minutes,prev_minutes,prev_has_data}, streak, best_streak, studied_today,
                                                 due{total,sets[]}, resume, today_items[], upcoming[], next_exam, last_exam_score,
                                                 recent_subjects[], name}
     GET  /stats/overview?from&to&subject_id -> {cur, prev|null, ai|null, ai_remaining}
          cur = {from,to,len,days[{date,minutes,active,made{chapter,pdf,practice,exam,flashcard,mindmap,summary},scores[]}],
                 minutes, active_days, made, made_total, attempts, practice_count, exam_count, q_avg, correct, rev, ok, recall,
                 by_subject{id:{name,minutes,attempts,q_avg,rev,ok,recall,eligible,cap,sets[],fsets[]}}, streak, best_streak,
                 hist, enough, empty, cards{total,mastered,learning,new}}
     GET  /stats/heatmap?to&subject_id       -> [{date, minutes, active}] (12 tuần)
     GET  /stats/subjects · /stats/subjects/{id}
     GET  /stats/snapshots · /stats/snapshots/{id}
     POST /stats/ai {from,to,subject_id} -> {snapshot, ai_remaining} · POST /stats/ai/{id}/save · POST /stats/ai/{id}/schedule {indexes}
   Chế độ mẫu (chưa đăng nhập): giữ bộ sinh dữ liệu giả của mẫu (sampleOverview…), cùng khuôn với API, không gọi API.
   F5 khi đang mở: localStorage `td_tk_resume` {route, nb, nbTab, period} (xoá khi rời màn).
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, getPerPage, setPerPage, perSelectHtml } from "./ghichu_core.js";

var HIST_PER_OPTS = [5, 10, 20, 50];   // số snapshot mỗi trang ở Lịch sử tiến bộ (người dùng chọn, nhớ localStorage)

/* ================= Ngày giờ & định dạng ================= */
var DAY = 864e5;
function D0(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addD(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return D0(x); }
function diff(a, b) { return Math.round((D0(b) - D0(a)) / DAY); }
function pad(n) { return String(n).padStart(2, "0"); }
function dm(d) { return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); }
function dmy(d) { return dm(d) + "/" + d.getFullYear(); }
function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function P(k) { var a = String(k).slice(0, 10).split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function PT(k) { return k ? new Date(String(k).replace(" ", "T")) : null; }   // "YYYY-MM-DDTHH:MM:SS" giờ địa phương
var DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
var DOWF = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
function n1(x) { return (Math.round(x * 10) / 10).toFixed(1).replace(".", ","); }
function pct(x) { return Math.round(x * 100) + "%"; }
function hm(min) { min = Math.round(min); var h = Math.floor(min / 60), m = min % 60; return h ? h + " giờ " + pad(m) + " phút" : m + " phút"; }
function hmShort(min) { min = Math.round(min || 0); var h = Math.floor(min / 60), m = min % 60; return h ? h + "g " + pad(m) + "p" : m + "p"; }
function hhmm(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
function today() { return D0(new Date()); }
function relDay(k) {
  if (!k) return "—";
  var d = diff(P(k), today());
  return d === 0 ? "hôm nay" : d === 1 ? "hôm qua" : dm(P(k));
}

/* ================= Màu ================= */
// Màu môn: theo thứ tự Môn trong cây Notebook (subjects chưa có cột màu thật)
var SUBJ_COLORS = ["#2c4a8c", "#0D7380", "#AD6E0D", "#804080", "#5C6B85", "#2e7d4f", "#b83d38", "#2f62c4", "#c4561d", "#1c86a8"];
var SUBJ_BG = ["#DDDFE6", "#DDEBED", "#F4EBDD", "#EDE4ED", "#E4E8EF", "#E1EFE6", "#F5E1E0", "#DFE7F6", "#F7E6DC", "#DCEEF4"];
function subjIndex(id) {
  var list = TK.subjectOrder.length ? TK.subjectOrder : (state.subjects || []).map(function (s) { return s.id; });
  var i = list.indexOf(id);
  return i < 0 ? 0 : i % SUBJ_COLORS.length;
}
function subjColor(id) { return SUBJ_COLORS[subjIndex(id)]; }
function subjBg(id) { return SUBJ_BG[subjIndex(id)]; }
var TYPES = [["chapter", "Chương", "#0E5C8F"], ["pdf", "Tệp PDF", "#3E87A8"], ["practice", "Bộ ôn tập", "#1C8A8A"], ["exam", "Đề thi thử", "#5E9E7A"],
  ["flashcard", "Bộ thẻ", "#A3BE8C"], ["mindmap", "Sơ đồ", "#D3B477"], ["summary", "Tóm tắt", "#C98A5B"]];
var HEAT = ["var(--tk-track)", "#C9DCE6", "#8DB8CC", "#3E87A8", "#0E5C8F"];

/* ================= Trạng thái ================= */
var RESUME_KEY = "td_tk_resume";
var SUBS = [["homnay", "Hôm nay"], ["hoatdong", "Hoạt động"], ["ketqua", "Kết quả học tập"], ["sosanh", "So sánh môn"], ["ai", "Nhận xét AI"], ["lichsu", "Lịch sử tiến bộ"]];
function isTQ(r) { return SUBS.some(function (s) { return s[0] === r; }); }
var TK = {
  open: false,
  route: "homnay",              // homnay | hoatdong | ketqua | sosanh | ai | lichsu | nblist | nb
  nb: null, nbTab: "noidung",
  period: { kind: "7" },        // 7 | 30 | custom {a,b}
  snap: null,                   // {id, a, b, ai_id} — đang xem 1 snapshot (chỉ xem)
  hPage: 0, sbOpen: true, nbQ: "",
  hAi: null,                    // id nhận xét AI đã lưu đang mở ở khung "Nhận xét AI đã lưu" (Lịch sử tiến bộ)
  cache: {},                    // khoá -> dữ liệu đã tải; loading[khoá] = true khi đang tải
  loading: {},
  ai: {},                       // khoá kỳ -> {state: idle|loading|error|result, snap, err}
  aiRemaining: null,             // lượt Nhận xét AI còn lại hôm nay (min hạn mức riêng 5/ngày, hạn mức AI chung)
  aiLimit: null,                 // hạn mức riêng/ngày (STATS_AI_DAILY_LIMIT, mặc định 5)
  subjectOrder: [],
};

export function isOpen() { return TK.open; }

function saveResume() { try { localStorage.setItem(RESUME_KEY, JSON.stringify({ route: TK.route, nb: TK.nb, nbTab: TK.nbTab, period: TK.period.kind === "custom" ? { kind: "custom", a: iso(TK.period.a), b: iso(TK.period.b) } : TK.period })); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }

/* ================= Mở / đóng ================= */
export function openThongke() {
  TK.open = true;
  TK.cache = {}; TK.loading = {};            // dữ liệu có thể đã đổi (vừa làm bài / học thêm) -> tải lại
  TK.subjectOrder = (state.subjects || []).map(function (s) { return s.id; });
  hooks.syncLayout();
  saveResume();
  render();
}
// Responsive (< 1024px, css/responsive.css): thanh menu trái là ngăn kéo — mở bằng ☰ #tk-menu, đóng khi chọn xong 1 mục,
// bấm nền mờ hoặc Esc. Trên desktop lớp .sb-open không có tác dụng.
function setSbDrawer(open) {
  var pane = $("tk-pane"); if (!pane) return;
  pane.classList.toggle("sb-open", open);
  if (!open && TK.sbForce) { TK.sbForce = false; renderSide(TK.lastSideM); }
  var b = $("tk-menu"); if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
}
export function closeThongke() {
  setSbDrawer(false);
  TK.open = false;
  closePicker(); hideTip(); closeModal();
  clearResume();
  hooks.syncLayout();
}
export function resumeIfNeeded() {
  var r = null;
  try { r = JSON.parse(localStorage.getItem(RESUME_KEY) || "null"); } catch (e) {}
  if (!r) return;
  if (r.route) TK.route = r.route;
  TK.nb = r.nb || null; TK.nbTab = r.nbTab || "noidung";
  if (r.period && r.period.kind === "custom" && r.period.a) TK.period = { kind: "custom", a: P(r.period.a), b: P(r.period.b) };
  else if (r.period && (r.period.kind === "7" || r.period.kind === "30")) TK.period = r.period;
  if (TK.route === "nb" && !TK.nb) TK.route = "nblist";
  openThongke();
}

/* ================= Tải dữ liệu (API / chế độ mẫu) ================= */
function apiErr(res, fb) {
  var d = res && res.data && res.data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) return String(d[0].msg || fb).replace(/^Value error, /, "");
  if (res && res.status === 404) return "API /stats chưa được nối (máy chủ trả 404).";
  return fb;
}
// Lấy dữ liệu theo khoá: có sẵn -> trả về; chưa có -> tải nền rồi vẽ lại, tạm trả undefined (trang hiện "Đang tải…").
function need(key, loader) {
  if (key in TK.cache) return TK.cache[key];
  if (!TK.loading[key]) {
    TK.loading[key] = true;
    Promise.resolve(loader()).then(function (v) {
      TK.cache[key] = v; delete TK.loading[key];
      if (TK.open) render();
    });
  }
  return undefined;
}
function getJSON(path) {
  return apiAuth("GET", path, authToken()).then(function (res) { return res.ok ? res.data : { error: apiErr(res, "Không tải được số liệu.") }; });
}
function overview(a, b, sid) {
  var k = "ov|" + iso(a) + "|" + iso(b) + "|" + (sid || "");
  return need(k, function () {
    if (!isOnline()) { var so = sampleOverview(a, b, sid); TK.aiRemaining = so.ai_remaining; TK.aiLimit = so.ai_limit; return so; }
    return getJSON("/stats/overview?from=" + iso(a) + "&to=" + iso(b) + (sid ? "&subject_id=" + encodeURIComponent(sid) : "")).then(function (d) {
      if (d && !d.error) { TK.aiRemaining = d.ai_remaining; TK.aiLimit = d.ai_limit; }
      return d;
    });
  });
}
function heatData(end, sid) {
  return need("hm|" + iso(end) + "|" + (sid || ""), function () {
    return isOnline() ? getJSON("/stats/heatmap?to=" + iso(end) + (sid ? "&subject_id=" + encodeURIComponent(sid) : "")) : sampleHeatmap(end, sid);
  });
}
function todayData() { return need("today", function () { return isOnline() ? getJSON("/stats/today") : sampleToday(); }); }
function subjectsData() { return need("subjects", function () { return isOnline() ? getJSON("/stats/subjects") : sampleSubjects(); }); }
function subjectData(id) { return need("subject|" + id, function () { return isOnline() ? getJSON("/stats/subjects/" + encodeURIComponent(id)) : sampleSubject(id); }); }
function snapshotsData() { return need("snaps", function () { return isOnline() ? getJSON("/stats/snapshots") : sampleSnapshots(); }); }
function snapshotDetail(id) { return need("snap|" + id, function () { return isOnline() ? getJSON("/stats/snapshots/" + encodeURIComponent(id)) : (SAMPLE.snaps.find(function (s) { return s.id === id; }) || { error: "Không tìm thấy snapshot." }); }); }
function invalidate(prefix) { Object.keys(TK.cache).forEach(function (k) { if (!prefix || k.indexOf(prefix) === 0) delete TK.cache[k]; }); }

/* ================= Khoảng thời gian ================= */
function range() {
  if (TK.snap) return [TK.snap.a, TK.snap.b];
  if (TK.period.kind === "custom") return [TK.period.a, TK.period.b];
  var n = TK.period.kind === "30" ? 30 : 7, t = today();
  return [addD(t, -(n - 1)), t];
}
function prevOf(a, b) { var len = diff(a, b) + 1; return [addD(a, -len), addD(a, -1)]; }
function periodKey(a, b, sid) { return iso(a) + "|" + iso(b) + "|" + (sid || ""); }
function delta(cur, prev, kind) {   // [chuỗi, lớp màu]
  if (prev == null || cur == null) return ["Chưa có kỳ trước để so sánh", "flat"];
  if (kind === "pct") { if (!prev) return cur ? ["Mới trong kỳ này", "up"] : ["Bằng kỳ trước", "flat"]; var p = Math.round((cur - prev) / prev * 100); return p === 0 ? ["Bằng kỳ trước", "flat"] : [(p > 0 ? "↑" : "↓") + " " + Math.abs(p) + "% so với kỳ trước", p > 0 ? "up" : "down"]; }
  if (kind === "pt") { var q = Math.round((cur - prev) * 100); return q === 0 ? ["Bằng kỳ trước", "flat"] : [(q > 0 ? "↑" : "↓") + " " + Math.abs(q) + "%", q > 0 ? "up" : "down"]; }
  if (kind === "score") { var s = Math.round((cur - prev) * 10) / 10; return s === 0 ? ["Bằng kỳ trước", "flat"] : [(s > 0 ? "↑" : "↓") + " " + n1(Math.abs(s)) + " điểm", s > 0 ? "up" : "down"]; }
  var dd = cur - prev; return dd === 0 ? ["Bằng kỳ trước", "flat"] : [(dd > 0 ? "↑" : "↓") + " " + Math.abs(dd) + " ngày so với kỳ trước", dd > 0 ? "up" : "down"];
}

/* ================= Biểu tượng (giữ của mẫu) ================= */
function ST(c) { return 'stroke="' + c + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'; }
var IC = {
  home: function (c) { return '<rect x="3" y="3" width="6" height="6" rx="1.5" ' + ST(c) + '/><rect x="11" y="3" width="6" height="6" rx="1.5" ' + ST(c) + '/><rect x="3" y="11" width="6" height="6" rx="1.5" ' + ST(c) + '/><rect x="11" y="11" width="6" height="6" rx="1.5" ' + ST(c) + "/>"; },
  book: function (c) { return '<path d="M4 3.5h9.5a2 2 0 0 1 2 2V17H6a2 2 0 0 1-2-2V3.5Z" ' + ST(c) + '/><path d="M4 15a2 2 0 0 1 2-2h9.5" ' + ST(c) + "/>"; },
  gear: function (c) { return '<circle cx="10" cy="10" r="2.6" ' + ST(c) + '/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" ' + ST(c) + "/>"; },
  help: function (c) { return '<circle cx="10" cy="10" r="7.5" ' + ST(c) + '/><path d="M7.8 7.8a2.3 2.3 0 1 1 3 2.2c-.6.2-.8.6-.8 1.2v.6M10 14.3v.2" ' + ST(c) + "/>"; },
  check: function (c) { return '<rect x="3" y="3" width="14" height="14" rx="3" ' + ST(c) + '/><path d="m6.5 10 2.4 2.4L13.8 7.6" ' + ST(c) + "/>"; },
  clip: function (c) { return '<rect x="4" y="4" width="12" height="13.5" rx="2" ' + ST(c) + '/><path d="M7.5 2.5h5v3h-5zM7 10h6M7 13.5h4" ' + ST(c) + "/>"; },
  cards: function (c) { return '<rect x="2.5" y="6" width="11" height="10.5" rx="2" ' + ST(c) + '/><path d="M6.5 3.5h9a2 2 0 0 1 2 2V13" ' + ST(c) + "/>"; },
  mind: function (c) { return '<circle cx="10" cy="10" r="2.5" ' + ST(c) + '/><circle cx="3.5" cy="4.5" r="1.5" ' + ST(c) + '/><circle cx="16.5" cy="4.5" r="1.5" ' + ST(c) + '/><circle cx="16.5" cy="15.5" r="1.5" ' + ST(c) + '/><path d="M4.8 5.6 8 8.3M15.2 5.6 12 8.3M15.2 14.4 12 11.7" ' + ST(c) + "/>"; },
  sum: function (c) { return '<path d="M4 5h12M4 9h12M4 13h8M4 17h5" ' + ST(c) + "/>"; },
  pdf: function (c) { return '<path d="M5 2.5h7l3.5 3.5v11.5H5z" ' + ST(c) + '/><path d="M12 2.5V6h3.5" ' + ST(c) + "/>"; },
  note: function (c) { return '<rect x="4" y="3" width="12" height="14" rx="2" ' + ST(c) + '/><path d="M7 7h6M7 10h6M7 13h3" ' + ST(c) + "/>"; },
  clock: function (c) { return '<circle cx="10" cy="10" r="7" ' + ST(c) + '/><path d="M10 6v4l2.5 2" ' + ST(c) + "/>"; },
  cal: function (c) { return '<rect x="3" y="4.5" width="14" height="12.5" rx="2.5" ' + ST(c) + '/><path d="M3 8.5h14M7 2.5v3.5M13 2.5v3.5" ' + ST(c) + "/>"; },
  fire: function (c) { return '<path d="M10 2.5c1 3.3 5 5 5 9.2a5 5 0 0 1-10 .3c0-2 1.1-3.3 2.2-4.2.2 1.6.9 2.6 1.8 2.9-.3-2.8.2-5.6 1-8.2Z" ' + ST(c) + "/>"; },
  doc: function (c) { return '<rect x="4" y="3" width="12" height="14" rx="2.2" ' + ST(c) + '/><path d="M7.5 7.5h5M7.5 10.5h5M7.5 13.5h2.5" ' + ST(c) + "/>"; },
  star: function (c) { return '<path d="m10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.8 5.7 16l.9-4.7L3.1 8l4.8-.6L10 3Z" ' + ST(c) + "/>"; },
  search: function (c) { return '<circle cx="9" cy="9" r="5.5" ' + ST(c) + '/><path d="m13.2 13.2 3.3 3.3" ' + ST(c) + "/>"; },
};
function svg(k, c, s) { c = c || "currentColor"; s = s || 16; return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 20 20" fill="none">' + IC[k](c) + "</svg>"; }
function icBox(k, size, bg, col) { return '<span class="nbic" style="width:' + size + "px;height:" + size + "px;background:" + bg + '">' + svg(k, col, Math.round(size * 0.5)) + "</span>"; }
function INFO(t) { return '<svg class="info" viewBox="0 0 18 18" fill="none"><title>' + esc(t) + '</title><circle cx="9" cy="9" r="7.3" stroke="currentColor" stroke-width="1.3"/><path d="M9 8v4.5M9 5.6v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
function CHEV(c, cls) { return '<svg class="' + (cls || "") + '" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="m6 3 5 5-5 5" stroke="' + (c || "currentColor") + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function DOWN(c) { return '<svg width="11" height="11" viewBox="0 0 14 14" fill="none"><path d="M3 5l4 4 4-4" stroke="' + (c || "currentColor") + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function SPARK(s) { return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none"><path d="M14 4.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z" fill="currentColor"/><path d="M7 15.5c.3 1.6 1.1 2.4 2.7 2.7-1.6.3-2.4 1.1-2.7 2.7-.3-1.6-1.1-2.4-2.7-2.7 1.6-.3 2.4-1.1 2.7-2.7Z" fill="currentColor"/></svg>'; }

/* ================= Khung chung: thanh trái, breadcrumb, thanh trên ================= */
function renderSide(m) {
  TK.lastSideM = m;
  var tq = isTQ(TK.route);
  var aiLocked = m && (!m.enough || m.empty);
  // TK.sbForce: trong ngăn kéo (màn < 1024px) bấm "Tổng quan" khi đang ở Notebook thì THẢ danh sách mục thay vì chuyển trang ngay.
  var drop = tq || TK.sbForce;
  $("tk-sb").innerHTML = '<div class="logo"><i>' + svg("book", "#fff", 16) + "</i>Notebook</div>" +
    '<button type="button" class="nav ' + (drop ? "open" : "") + '" data-go="' + (tq ? "toggle" : "homnay") + '">' + svg("home") + "<span>Tổng quan</span>" + CHEV("currentColor", "chev") + "</button>" +
    ((tq && TK.sbOpen) || TK.sbForce ? '<div class="subs">' + SUBS.map(function (s) {
      return '<button type="button" class="sub ' + (TK.route === s[0] ? "on" : "") + '" data-go="' + s[0] + '"' + (s[0] === "ai" && aiLocked ? ' disabled title="Cần đủ 7 ngày dữ liệu"' : "") + ">" + s[1] + "</button>";
    }).join("") + "</div>" : "") +
    '<button type="button" class="nav ' + (!tq ? "on" : "") + '" data-go="nblist">' + svg("book") + "<span>Notebook</span></button>" +
    '<div class="grow"></div>' +
    '<button type="button" class="nav" data-act="settings">' + svg("gear") + "<span>Cài đặt</span></button>" +
    '<button type="button" class="nav" data-act="toast:Hỗ trợ: xem hướng dẫn ở menu Trợ giúp của Notebook">' + svg("help") + "<span>Hỗ trợ</span></button>";
}
function crumb(parts) {
  $("tk-crumb").innerHTML = parts.map(function (p, i) {
    return i < parts.length - 1 ? '<button type="button" data-go="' + p[1] + '">' + esc(p[0]) + "</button><span>/</span>" : "<b>" + esc(p[0]) + "</b>";
  }).join("");
}
function renderUser() {
  var u = hooks.currentUser ? hooks.currentUser() : null;
  var name = (u && u.name) || (isOnline() ? "Tài khoản" : "Chế độ mẫu");
  var ini = name.split(/\s+/).filter(Boolean).slice(-2).map(function (w) { return w[0]; }).join("").toUpperCase();
  $("tk-user").innerHTML = "<i>" + (u && u.avatar ? '<img src="' + esc(u.avatar) + '" alt="">' : esc(ini)) + "</i>" + esc(name);
}
function go(r, extra) {
  Object.assign(TK, extra || {});
  TK.route = r;
  if (isTQ(r)) TK.sbOpen = true;
  hideTip(); closePicker();
  saveResume();
  render();
  $("tk-main").scrollTop = 0;
}

/* ----- Tiêu đề + bộ lọc thời gian ----- */
function filtersHTML() {
  var k = TK.snap ? "snap" : TK.period.kind, r = range();
  return '<div class="filters ' + (TK.snap ? "ro" : "") + '">' +
    '<button type="button" class="pill ' + (k === "7" ? "on" : "") + '" data-per="7">7 ngày</button>' +
    '<button type="button" class="pill ' + (k === "30" ? "on" : "") + '" data-per="30">30 ngày</button>' +
    '<button type="button" class="pill ' + (k === "custom" ? "on" : "") + '" data-per="custom" id="tk-pcustom">Tùy chọn ' + DOWN() + "</button>" +
    '<span class="range">' + svg("cal", "currentColor", 15) + " " + dmy(r[0]) + " – " + dmy(r[1]) + "</span></div>";
}
function subLine(m) {
  var a = P(m.from), b = P(m.to), pr = prevOf(a, b);
  return !m.enough ? "Số liệu " + dmy(a) + " – " + dmy(b) + " · chưa đủ dữ liệu để so sánh với kỳ trước"
    : "Số liệu " + dmy(a) + " – " + dmy(b) + ", so với " + m.len + " ngày trước đó (" + dm(pr[0]) + " – " + dm(pr[1]) + ")";
}
function nowHM() { var n = new Date(); return pad(n.getHours()) + ":" + pad(n.getMinutes()); }
function headHTML(title, m, right) {
  return (TK.snap && TK.route !== "homnay" ? '<div class="banner">' + svg("clock", "currentColor", 18) + "<p>Đang xem snapshot " + dmy(TK.snap.a) + " – " + dmy(TK.snap.b) + (TK.snap.savedAt ? " (lưu lúc " + dm(TK.snap.savedAt) + " " + pad(TK.snap.savedAt.getHours()) + ":" + pad(TK.snap.savedAt.getMinutes()) + ")" : "") + ' · Chế độ chỉ xem.</p><button type="button" data-act="exitSnap">Về kỳ hiện tại</button></div>' : "") +
    '<div class="ph"><div class="t"><h1>' + title + "</h1>" + (TK.snap ? "" : '<div class="sub2">' + (m ? subLine(m) : "") + "</div>") + "</div>" +
    (right != null ? right : '<span class="upd">' + (TK.snap ? "Chỉ xem" : "Cập nhật lúc " + nowHM()) + "</span>") + "</div>";
}
function loadingHTML(msg) { return '<div class="tk-loading"><span class="spin"></span>' + (msg || "Đang tải số liệu…") + "</div>"; }
function errorHTML(msg) { return '<div class="msg err"><div class="tx"><h4>Không tải được số liệu</h4><p>' + esc(msg) + '</p><div><button type="button" class="btn sec sm" data-act="reload">Thử lại</button></div></div></div>'; }

/* ================= Biểu đồ (SVG, port từ mẫu; màu theo token) ================= */
function lbl(x, y, t, o) {
  o = o || {};
  return '<text x="' + x + '" y="' + y + '" font-size="' + (o.s || 16) + '" style="fill:' + (o.c || "var(--tk-chart-text)") + '" text-anchor="' + (o.a || "middle") + '" dominant-baseline="middle" font-weight="' + (o.w || 400) + '">' + esc(t) + "</text>";
}
function svgOpen(W, H, extra) { return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '"' + (extra || "") + ">"; }
function gridLine(x1, y, x2, dash) { return '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" style="stroke:var(--tk-chart-grid)" stroke-dasharray="' + (dash || "4 4") + '"/>'; }
function buckets(m) {   // gộp theo ngày (≤ 31 ngày) hoặc theo tuần
  var byWeek = m.len > 31, out = [];
  m.days.forEach(function (x, i) {
    var key = byWeek ? Math.floor(i / 7) : i, date = P(x.date);
    if (!out[key]) out[key] = { date: date, end: date, made: {}, scores: [], min: 0 };
    var B = out[key]; B.end = date;
    TYPES.forEach(function (t) { B.made[t[0]] = (B.made[t[0]] || 0) + (x.made[t[0]] || 0); });
    B.scores.push.apply(B.scores, x.scores || []); B.min += x.minutes || 0;
  });
  out.forEach(function (B) { B.label = byWeek ? dm(B.date) : (m.len <= 7 ? DOW[B.date.getDay()] + " " + pad(B.date.getDate()) : String(B.date.getDate())); });
  return { list: out, byWeek: byWeek };
}
function stackedBars(m) {
  var W = 656, H = 270, bk = buckets(m), list = bk.list, byWeek = bk.byWeek, L = 40, R = 8, T0 = 24, B = 34, ph = H - T0 - B, cw = (W - L - R) / list.length, t = today();
  var tots = list.map(function (b) { return TYPES.reduce(function (p, x) { return p + b.made[x[0]]; }, 0); });
  var max = Math.max.apply(null, [4].concat(tots)), step = max <= 6 ? 2 : max <= 12 ? 4 : Math.ceil(max / 3 / 5) * 5; max = Math.ceil(max / step) * step;
  var s = svgOpen(W, H);
  for (var v = 0; v <= max; v += step) { var y = T0 + ph - v / max * ph; s += gridLine(L, y, W - R) + lbl(L - 14, y, v, { a: "end" }); }
  var bw = Math.min(32, cw * 0.6), every = list.length > 16 ? 5 : 1;
  list.forEach(function (b, i) {
    var cx = L + cw * i + cw / 2, yy = T0 + ph;
    var tip = (byWeek ? "Tuần từ " + dm(b.date) : DOWF[b.date.getDay()] + " " + dm(b.date)) + ": " + tots[i] + " nội dung" +
      TYPES.filter(function (x) { return b.made[x[0]]; }).map(function (x) { return " · " + b.made[x[0]] + " " + x[1].toLowerCase(); }).join("");
    TYPES.forEach(function (x) { var val = b.made[x[0]]; if (!val) return; var hh = val / max * ph; yy -= hh; s += '<rect x="' + (cx - bw / 2) + '" y="' + (yy + 1.5) + '" width="' + bw + '" height="' + Math.max(1, hh - 1.5) + '" rx="3" fill="' + x[2] + '"/>'; });
    s += '<rect x="' + (cx - cw / 2) + '" y="' + T0 + '" width="' + cw + '" height="' + ph + '" fill="transparent" data-tip="' + esc(tip) + '"/>';
    if (list.length <= 16 && tots[i]) s += lbl(cx, T0 + ph - tots[i] / max * ph - 12, tots[i], { s: 15, c: "var(--tk-chart-strong)", w: 500 });
    if (i % every === 0 || i === list.length - 1) { var isT = !byWeek && +b.date === +t; s += lbl(cx, H - 12, b.label, { c: isT ? "var(--tk-navy)" : "var(--tk-chart-text)", w: isT ? 500 : 400 }); }
  });
  return s + "</svg>";
}
function heatmap(cells, end) {
  var W = 360, H = 206, L = 40, top = 26, cell = 21, gap = 4, months = {}, s = svgOpen(W, H);
  cells.forEach(function (x, i) {
    var d = P(x.date), c = Math.floor(i / 7), r = i % 7;
    if (d > end) return;
    if (d.getDate() <= 7 && r === 0) months[c] = "Thg " + (d.getMonth() + 1);
    var mins = x.minutes, l = !x.active && !mins ? 0 : mins < 45 ? 1 : mins < 90 ? 2 : mins < 150 ? 3 : 4;
    s += '<rect x="' + (L + c * (cell + gap)) + '" y="' + (top + r * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="4" style="fill:' + HEAT[l] + (+d === +end ? ';stroke:var(--tk-navy)" stroke-width="1.5"' : '"') + ' data-tip="' + DOWF[d.getDay()] + " " + dmy(d) + ": " + (mins ? hm(mins) : x.active ? "có hoạt động (làm bài / ôn thẻ)" : "không học") + '"/>';
  });
  ["T2", "", "T4", "", "T6", "", "CN"].forEach(function (t, r) { if (t) s += lbl(0, top + r * (cell + gap) + cell / 2, t, { a: "start", s: 15 }); });
  Object.keys(months).forEach(function (c) { s += lbl(L + c * (cell + gap), 9, months[c], { a: "start", s: 15 }); });
  return s + "</svg>";
}
function lineChart(m, prevAvg) {
  var W = 656, H = 230, bk = buckets(m), list = bk.list, byWeek = bk.byWeek, L = 40, R = 14, T0 = 14, B = 34, ph = H - T0 - B, cw = (W - L - R) / list.length, t = today();
  var vals = list.map(function (b) { return b.scores.length ? b.scores.reduce(function (p, c) { return p + c; }, 0) / b.scores.length : null; });
  var lo = Math.max(0, Math.floor(Math.min.apply(null, vals.filter(function (v) { return v != null; }).concat([prevAvg != null ? prevAvg : 10, 10])) - 1)), hi = 10;
  var X = function (i) { return L + cw * i + cw / 2; }, Y = function (v) { return T0 + ph - (v - lo) / (hi - lo) * ph; };
  var s = svgOpen(W, H), step = hi - lo > 6 ? 2 : 1;
  for (var v = lo; v <= hi; v += step) s += gridLine(L, Y(v), W - R) + lbl(L - 14, Y(v), v, { a: "end" });
  if (prevAvg != null) s += '<line x1="' + L + '" y1="' + Y(prevAvg) + '" x2="' + (W - R) + '" y2="' + Y(prevAvg) + '" style="stroke:var(--tk-prev)" stroke-width="2" stroke-dasharray="6 5"/>';
  var pts = vals.map(function (v, i) { return v == null ? null : [X(i), Y(v), v, i]; }).filter(Boolean);
  if (pts.length) {
    var path = pts.map(function (p) { return p[0] + "," + p[1]; }).join(" L");
    s += '<path d="M' + path + " L" + pts[pts.length - 1][0] + "," + Y(lo) + " L" + pts[0][0] + "," + Y(lo) + ' Z" style="fill:var(--tk-series)" fill-opacity=".08"/>';
    s += '<path d="M' + path + '" fill="none" style="stroke:var(--tk-series)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
    pts.forEach(function (p) {
      var b = list[p[3]];
      s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="5.5" style="fill:var(--panel);stroke:var(--tk-series)" stroke-width="2.5" data-tip="' + (byWeek ? "Tuần từ " + dm(b.date) : DOWF[b.date.getDay()] + " " + dm(b.date)) + ": TB " + n1(p[2]) + " điểm · " + b.scores.length + ' lượt"/>';
      if (list.length <= 16) s += lbl(p[0], p[1] - 18, n1(p[2]), { s: 15, c: "var(--tk-chart-strong)", w: 500 });
    });
  }
  var every = list.length > 16 ? 5 : 1;
  list.forEach(function (b, i) {
    if (vals[i] == null && list.length <= 16) s += lbl(X(i), Y(lo) - 14, "—", { s: 15, c: "var(--muted-3)" });
    if (i % every === 0 || i === list.length - 1) { var isT = !byWeek && +b.date === +t; s += lbl(X(i), H - 12, b.label, { c: isT ? "var(--tk-navy)" : "var(--tk-chart-text)", w: isT ? 500 : 400 }); }
  });
  return s + "</svg>";
}
function donut(parts, center, sub) {
  var D = 170, cx = D / 2, cy = D / 2, r = 68, tot = parts.reduce(function (p, c) { return p + c[0]; }, 0) || 1, a = -Math.PI / 2;
  var s = '<svg width="140" height="140" viewBox="0 0 ' + D + " " + D + '">';
  var Pt = function (t) { return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  if (!parts.some(function (p) { return p[0]; })) s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" style="stroke:var(--tk-track)" stroke-width="24"/>';
  parts.forEach(function (p) {
    var v = p[0]; if (!v) return;
    var a1 = a + v / tot * Math.PI * 2, full = v === tot;
    if (full) { s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + p[1] + '" stroke-width="24" data-tip="' + p[2] + ": " + v + ' thẻ (100%)"/>'; a = a1; return; }
    var x0y0 = Pt(a + 0.03), x1y1 = Pt(a1 - 0.03);
    s += '<path d="M' + x0y0[0] + "," + x0y0[1] + " A" + r + "," + r + " 0 " + (a1 - a > Math.PI ? 1 : 0) + " 1 " + x1y1[0] + "," + x1y1[1] + '" fill="none" stroke="' + p[1] + '" stroke-width="24" data-tip="' + p[2] + ": " + v + " thẻ (" + Math.round(v / tot * 100) + '%)"/>';
    a = a1;
  });
  return s + lbl(cx, cy - 8, center, { s: 28, c: "var(--tk-chart-strong)", w: 500 }) + lbl(cx, cy + 20, sub, { s: 16 }) + "</svg>";
}
function radar(items) {   // [{name, short, cur, prev}]
  var W = 420, H = 290, n = items.length, cx = W / 2, cy = 148, R = 98;   // rộng hơn mẫu (314) để nhãn môn 2 bên không bị cắt
  var ang = function (i) { return -Math.PI / 2 + i * 2 * Math.PI / n; }, pt = function (v, i) { return [cx + R * v / 10 * Math.cos(ang(i)), cy + R * v / 10 * Math.sin(ang(i))]; };
  var poly = function (vs) { return vs.map(function (v, i) { return pt(v, i).map(function (x) { return x.toFixed(1); }).join(","); }).join(" "); };
  var s = svgOpen(W, H, ' style="overflow:visible;max-width:420px"');
  [2.5, 5, 7.5, 10].forEach(function (v) { s += '<polygon points="' + poly(items.map(function () { return v; })) + '" fill="none" style="stroke:var(--tk-chart-grid)"/>'; });
  items.forEach(function (_, i) { var p = pt(10, i); s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0] + '" y2="' + p[1] + '" style="stroke:var(--tk-chart-grid)"/>'; });
  if (items.every(function (t) { return t.prev != null; })) s += '<polygon points="' + poly(items.map(function (t) { return t.prev; })) + '" fill="none" style="stroke:var(--tk-prev)" stroke-width="2" stroke-dasharray="5 4"/>';
  s += '<polygon points="' + poly(items.map(function (t) { return t.cur; })) + '" style="fill:var(--tk-series);stroke:var(--tk-series)" fill-opacity=".16" stroke-width="2.5" stroke-linejoin="round"/>';
  items.forEach(function (t, i) {
    var p = pt(t.cur, i), c = Math.cos(ang(i)), anchor = Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end", l = pt(11.6, i);
    s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="5" style="fill:var(--tk-series)" data-tip="' + esc(t.name) + ": " + n1(t.cur) + (t.prev != null ? " (kỳ trước " + n1(t.prev) + ")" : "") + '"/>';
    s += lbl(l[0], l[1] - 9, t.short, { s: 16, c: "var(--tk-chart-strong)", w: 500, a: anchor }) + lbl(l[0], l[1] + 10, n1(t.cur), { s: 15, a: anchor });
  });
  return s + "</svg>";
}
function historyLine(snaps) {   // [{a, b, cap}]
  var W = 314, H = 200, v = snaps.map(function (s) { return s.cap; }), L = 30, R = 14, T0 = 18, B = 30, ph = H - T0 - B;
  var lo = Math.floor(Math.min.apply(null, v) - 0.5), hi = Math.ceil(Math.max.apply(null, v) + 0.3), cw = (W - L - R) / Math.max(1, v.length - 1);
  var X = function (i) { return v.length === 1 ? W / 2 : L + i * cw; }, Y = function (x) { return T0 + ph - (x - lo) / Math.max(0.5, hi - lo) * ph; };
  var s = svgOpen(W, H, ' style="overflow:visible"');
  for (var g = lo; g <= hi; g++) s += gridLine(L, Y(g), W - R) + lbl(L - 12, Y(g), g, { a: "end", s: 15 });
  if (v.length > 1) s += '<path d="M' + v.map(function (x, i) { return X(i) + "," + Y(x); }).join(" L") + '" fill="none" style="stroke:var(--tk-series)" stroke-width="2.5" stroke-linejoin="round"/>';
  snaps.forEach(function (sn, i) {
    var last = i === v.length - 1;
    s += '<circle cx="' + X(i) + '" cy="' + Y(sn.cap) + '" r="' + (last ? 6 : 4) + '" style="fill:' + (last ? "var(--tk-series)" : "var(--panel)") + ';stroke:var(--tk-series)" stroke-width="2" data-tip="' + dm(sn.a) + " – " + dm(sn.b) + ": " + n1(sn.cap) + '"/>';
    s += lbl(X(i), H - 10, dm(sn.b), { s: 14, c: last ? "var(--tk-navy)" : "var(--tk-chart-text)", w: last ? 500 : 400 });
  });
  return s + lbl(X(v.length - 1) - 10, Y(v[v.length - 1]) - 16, n1(v[v.length - 1]), { s: 15, c: "var(--tk-chart-strong)", w: 500, a: "end" }) + "</svg>";
}
/* Chú thích khi rê chuột lên biểu đồ */
function hideTip() { if ($("tk-tip")) $("tk-tip").hidden = true; }

/* ================= Khối dùng chung ================= */
function kpi(ic, bg, col, label, value, d, note) {
  return '<div class="kpi"><div class="kh"><i style="background:' + bg + '">' + svg(ic, col, 16) + '</i><span title="' + esc(label) + '">' + label + '</span></div><div class="v">' + value + '</div><div class="d ' + d[1] + '" title="' + esc(d[0]) + '">' + d[0] + '</div><div class="n" title="' + esc(note) + '">' + note + "</div></div>";
}
function card(title, body, o) {
  o = o || {};
  return '<div class="card ' + (o.cls || "") + '" style="' + (o.style || "") + '"><div class="hd"><h3>' + title + "</h3>" + (o.right || "") + (o.info ? INFO(o.info) : "") + "</div>" + body + "</div>";
}
function legend(items) {
  return '<div class="legend">' + items.map(function (x) { return '<span><i class="' + (x[2] ? "ln" : "") + " " + (x[3] ? "dash" : "") + '" style="background:' + x[0] + '"></i>' + x[1] + "</span>"; }).join("") + "</div>";
}
var KPI_BG = { navy: ["var(--tk-soft)", "var(--tk-navy)"], teal: ["#E3F0EF", "#1C7C7C"], fire: ["#FBEFE1", "#B5651D"], green: ["#EAF2E6", "#4E7F3E"] };
function holder(title, desc, m, ghost) {
  var n = Math.min(7, m.hist);
  return '<div class="hold"><div class="tx"><h3>' + icBox("star", 32, "var(--tk-soft)", "var(--tk-navy)") + title + "</h3><p>" + desc + "</p>" +
    '<div style="display:flex;flex-direction:column;gap:8px;max-width:330px"><div style="display:flex;justify-content:space-between;font-size:14px"><b style="font-weight:500;color:var(--tk-navy)">Đã có ' + n + '/7 ngày dữ liệu</b><span class="muted" style="font-size:13px">còn ' + (7 - n) + " ngày</span></div>" +
    '<div class="seg7">' + [0, 1, 2, 3, 4, 5, 6].map(function (i) { return '<i class="' + (i < n ? "on" : "") + '"></i>'; }).join("") + "</div></div>" +
    '<div style="display:flex;gap:10px;padding-top:3px"><button type="button" class="btn" data-tool="ontap">Làm bài ôn tập</button><button type="button" class="btn sec" data-tool="flashcard">Ôn Flashcard</button></div></div>' +
    '<svg width="330" height="150" viewBox="0 0 420 190" fill="none" style="flex:none;max-width:35%">' + (ghost === "line"
      ? '<path d="M10 150 L80 120 L150 130 L220 90 L290 100 L360 60 L410 70" style="stroke:var(--tk-chart-grid)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' + [30, 65, 100, 135, 170].map(function (y) { return '<line x1="0" y1="' + y + '" x2="420" y2="' + y + '" style="stroke:var(--tk-track)" stroke-dasharray="4 4"/>'; }).join("")
      : [[30, 70], [100, 110], [170, 50], [240, 130], [310, 90]].map(function (p) { return '<rect x="' + p[0] + '" y="' + (180 - p[1]) + '" width="40" height="' + p[1] + '" rx="6" style="fill:var(--tk-chart-grid)"/>'; }).join("") + '<polygon points="380,40 410,95 380,150 350,95" style="stroke:var(--tk-chart-grid)" stroke-width="3"/>') + "</svg></div>";
}
function emptyState(m) {
  return '<div class="empty"><svg width="110" height="100" viewBox="0 0 140 130" fill="none"><circle cx="70" cy="66" r="60" style="fill:var(--tk-soft)"/><rect x="34" y="38" width="62" height="56" rx="10" style="fill:var(--panel);stroke:var(--tk-navy)" stroke-width="3"/><path d="M34 54h62M50 30v14M80 30v14" style="stroke:var(--tk-navy)" stroke-width="3" stroke-linecap="round"/><path d="M50 72h10M50 82h20" style="stroke:var(--tk-soft-line)" stroke-width="3" stroke-linecap="round"/><circle cx="96" cy="90" r="16" style="fill:var(--panel);stroke:var(--tk-navy)" stroke-width="3"/><path d="m108 102 10 10" style="stroke:var(--tk-navy)" stroke-width="3.5" stroke-linecap="round"/></svg>' +
    "<h2>Chưa có hoạt động trong khoảng thời gian này</h2>" +
    "<p>Từ " + dmy(P(m.from)) + " đến " + dmy(P(m.to)) + " bạn chưa tạo Chương, tệp PDF, bộ ôn tập hay bộ thẻ nào và cũng chưa có phiên học. Hãy chọn khoảng thời gian khác hoặc quay lại trang Hôm nay để bắt đầu học.</p>" +
    '<div style="display:flex;gap:10px;padding-top:6px"><button type="button" class="btn" data-go="homnay">Về trang Hôm nay</button><button type="button" class="btn sec" data-per="7">Xem 7 ngày gần nhất</button></div></div>';
}
function subjRows(m, p) {
  return Object.keys(m.by_subject).map(function (id) { return { id: id, s: m.by_subject[id], P: p && p.by_subject ? p.by_subject[id] : null }; })
    .filter(function (x) { return x.s.minutes || x.s.attempts || x.s.rev; });
}
// Nhãn radar: tên dài hơn 12 ký tự rút thành chữ cái đầu ("Cơ sở dữ liệu" -> "CSDL"); tên đầy đủ vẫn ở chú thích khi rê chuột
function shortName(name) { return name.length > 12 ? name.split(/\s+/).map(function (w) { return w[0]; }).join("").toUpperCase() : name; }
// Đọc số liệu kỳ đang xem (+ kỳ trước). Trả {m, p, ov} hoặc chuỗi HTML (đang tải / lỗi).
function periodData(sid) {
  var r = range(), ov = overview(r[0], r[1], sid);
  if (ov === undefined) return loadingHTML();
  if (!ov || ov.error) return errorHTML((ov && ov.error) || "Lỗi không xác định.");
  return { m: ov.cur, p: ov.prev, ov: ov };
}

/* ================= Trang: Hôm nay ================= */
function pageHomNay() {
  crumb([["Tổng quan", "homnay"], ["Hôm nay"]]);
  var d = todayData();
  var right = '<button type="button" class="btn" data-act="newSubject">+&nbsp;&nbsp;Tạo môn học</button>';
  if (d === undefined) return headHTML("Hôm nay", null, right) + loadingHTML();
  if (d.error) return headHTML("Hôm nay", null, right) + errorHTML(d.error);
  var u = hooks.currentUser ? hooks.currentUser() : null;
  var t = today(), name = ((u && u.name) || d.name || "").split(/\s+/).pop();
  var head = headHTML("Hôm nay", null, right).replace('<div class="sub2"></div>', '<div class="sub2">Chào ' + esc(name || "bạn") + "! Hôm nay " + DOWF[t.getDay()] + " " + dmy(t) + " · bạn đang có chuỗi " + d.streak + " ngày học liên tiếp</div>");
  var wk = d.week, ex = d.next_exam;
  var dueSets = d.due.sets.length ? "Từ " + d.due.sets.length + " bộ · " + esc(d.due.sets[0].title) + (d.due.sets.length > 1 ? "…" : "") : "Không có thẻ đến hạn";
  var kpis = '<div class="kpis">' +
    kpi("clock", KPI_BG.navy[0], KPI_BG.navy[1], "Giờ học tuần này", hm(wk.minutes), wk.prev_has_data ? delta(wk.minutes, wk.prev_minutes, "pct") : ["Chưa có tuần trước để so sánh", "flat"], "Tính từ Thứ Hai, chỉ thời gian đang thao tác trên app") +
    kpi("fire", KPI_BG.fire[0], KPI_BG.fire[1], "Chuỗi ngày học", d.streak + " ngày", ["Kỷ lục: " + d.best_streak + " ngày", "flat"], d.studied_today ? "Đã học hôm nay" : "Học hôm nay để lên " + (d.streak + 1) + " ngày") +
    kpi("cards", KPI_BG.teal[0], KPI_BG.teal[1], "Thẻ cần ôn", d.due.total + " thẻ", ["Đến hạn hôm nay", "flat"], dueSets) +
    kpi("check", KPI_BG.navy[0], KPI_BG.navy[1], "Bài thi sắp tới", ex ? esc(ex.title) : "Chưa có", ex ? [DOW[P(ex.date).getDay()] + " " + dm(P(ex.date)) + " · " + (diff(t, P(ex.date)) ? "còn " + diff(t, P(ex.date)) + " ngày" : "hôm nay"), 'warn" style="color:var(--tk-amber)'] : ["Thêm lịch thi trong Lịch biểu", "flat"],
      d.last_exam_score != null ? "Thi thử gần nhất: " + n1(d.last_exam_score) + " điểm" : "Chưa làm đề thi thử nào") +
    "</div>";
  var rs = d.resume, resume;
  if (rs) {
    var kindTxt = { practice: "Bài ôn tập đang làm dở", exam: "Đề thi thử đang làm dở", chapter: "Chương", pdf: "Tệp PDF" }[rs.kind] || "";
    resume = '<div class="resume">' + icBox(rs.kind === "pdf" ? "pdf" : rs.kind === "chapter" ? "book" : "check", 50, "var(--tk-navy)", "var(--tk-on-navy)") +
      '<div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:500">' + esc((rs.subject_name ? rs.subject_name + " · " : "") + rs.title) + '</div><div class="muted" style="font-size:14px">' + kindTxt + " · " + esc(rs.detail) + " · " + relDay(rs.at) + "</div></div></div>" +
      '<div style="display:flex;gap:10px"><button type="button" class="btn" data-act="resume">Tiếp tục học</button><button type="button" class="btn sec" data-tool="ontap">Ôn tập nhanh</button></div>';
  } else {
    resume = '<div class="muted" style="font-size:14px">Chưa có gì đang dở. Mở một Chương trong Notebook hoặc tạo bộ ôn tập để bắt đầu.</div><div style="display:flex;gap:10px"><button type="button" class="btn" data-act="close">Mở Notebook</button><button type="button" class="btn sec" data-tool="ontap">Ôn tập nhanh</button></div>';
  }
  var recent = d.recent_subjects.length ? '<div class="list">' + d.recent_subjects.map(function (s) {
    return '<button type="button" class="it" data-nb="' + esc(s.id) + '">' + icBox("book", 36, subjColor(s.id), "#fff") + '<span class="mid"><span class="nm">' + esc(s.name) + "</span><small>" + s.chapters + " chương · " + s.pdfs + " tệp PDF · " + s.practice_sets + " bộ ôn tập · " + s.flashcard_sets + ' bộ thẻ</small></span><span class="muted" style="font-size:13px">' + relDay(s.last_at) + "</span>" + CHEV() + "</button>";
  }).join("") + "</div>" : '<div class="muted" style="font-size:14px">Chưa có hoạt động nào.</div>';
  var ev = function (x) {
    var solid = x.type === "exam", c = x.color || "#2c4a8c";
    var when = x.type === "deadline" ? "Hạn " + hhmm(x.start_minute) : hhmm(x.start_minute) + " – " + hhmm(x.end_minute);
    return '<div class="ev ' + (solid ? "solid" : "") + '" style="border-color:' + c + ";background:" + (solid ? c : "color-mix(in srgb," + c + " 14%,var(--panel))") + '"><b style="color:' + (solid ? "#fff" : c) + '">' + (x.type === "deadline" ? "⚑ " : "") + esc(x.title) + "</b><span>" +
      (x.date !== iso(t) ? DOW[P(x.date).getDay()] + " " + dm(P(x.date)) + " · " : "") + when + " · " + { event: "Sự kiện", class: "Buổi học", deadline: "Deadline", exam: "Lịch thi" }[x.type] + "</span></div>";
  };
  var cal = (d.today_items.length ? '<div style="display:flex;flex-direction:column;gap:6px">' + d.today_items.map(ev).join("") + "</div>" : '<div class="muted" style="font-size:14px">Hôm nay không có lịch.</div>') +
    (d.upcoming.length ? '<div class="muted" style="font-size:13.5px;font-weight:500">Sắp tới</div><div style="display:flex;flex-direction:column;gap:6px">' + d.upcoming.map(ev).join("") + "</div>" : "") +
    '<button type="button" class="link" style="align-self:flex-start" data-act="lichbieu">Mở Lịch biểu</button>';
  return head + kpis + '<div class="row">' +
    '<div class="col w-main">' + card("Tiếp tục học", resume) + card("Môn học gần đây", recent, { right: '<button type="button" class="link" data-go="nblist">Xem tất cả</button>' }) + "</div>" +
    '<div class="col w-side">' + card("Lịch hôm nay", cal, { right: '<span class="note">' + DOW[t.getDay()] + " " + dm(t) + "</span>" }) + "</div></div>";
}

/* ================= Trang: Hoạt động ================= */
function pageHoatDong() {
  var pd = periodData(null);
  if (typeof pd === "string") return headHTML("Hoạt động", null) + filtersHTML() + pd;
  var m = pd.m, p = pd.p;
  if (m.empty) return headHTML("Hoạt động", m) + filtersHTML() + emptyState(m);
  var off = m.days.filter(function (x) { return !x.active; }).map(function (x) { var d = P(x.date); return DOW[d.getDay()] + " " + dm(d); });
  var parts = TYPES.filter(function (t) { return m.made[t[0]]; }).map(function (t) { return m.made[t[0]] + " " + t[1].toLowerCase(); }).join(" · ") || "Chưa tạo nội dung mới";
  var hmData = heatData(P(m.to), null);
  var heat = hmData === undefined ? loadingHTML() : hmData.error ? '<div class="muted">' + esc(hmData.error) + "</div>" : "<div>" + heatmap(hmData, P(m.to)) + "</div>";
  return headHTML("Hoạt động", m) + filtersHTML() + '<div class="kpis">' +
    kpi("clock", KPI_BG.navy[0], KPI_BG.navy[1], "Thời gian học", hm(m.minutes), p ? delta(m.minutes, p.minutes, "pct") : delta(null), "TB " + hm(m.minutes / Math.max(1, m.active_days)) + " / ngày học") +
    kpi("cal", KPI_BG.teal[0], KPI_BG.teal[1], "Số ngày học", m.active_days + "/" + m.len + " ngày", p ? delta(m.active_days, p.active_days, "day") : delta(null), off.length ? (off.length <= 2 ? "Nghỉ: " + off.join(", ") : "Nghỉ " + off.length + " ngày") : "Học đủ mọi ngày trong kỳ") +
    kpi("fire", KPI_BG.fire[0], KPI_BG.fire[1], "Chuỗi ngày học", m.streak + " ngày", ["Kỷ lục: " + m.best_streak + " ngày", "flat"], +P(m.to) === +today() ? (m.days[m.days.length - 1].active ? "Hôm nay đã học, chuỗi được giữ" : "Học tiếp hôm nay để giữ chuỗi") : "Tính đến " + dm(P(m.to))) +
    kpi("doc", KPI_BG.green[0], KPI_BG.green[1], "Nội dung đã tạo", String(m.made_total), p ? delta(m.made_total, p.made_total, "pct") : delta(null), parts) +
    "</div>" + '<div class="row">' +
    card("Nội dung tạo theo " + (m.len > 31 ? "tuần" : "ngày"), "<div>" + stackedBars(m) + "</div>" + legend(TYPES.map(function (t) { return [t[2], t[1]]; })), { cls: "w-main", info: "Số Chương, tệp PDF, bộ ôn tập, đề thi thử, bộ thẻ, sơ đồ và bản tóm tắt được tạo mới" }) +
    card("Lịch học", heat + '<div style="display:flex;flex-direction:column;gap:8px"><div class="legend" style="gap:5px;font-size:13px;color:var(--muted)">Ít ' + HEAT.map(function (c) { return '<i style="background:' + c + ';width:13px;height:13px;border-radius:3px"></i>'; }).join("") + ' Nhiều</div><div class="muted" style="font-size:13.5px">' + m.active_days + "/" + m.len + " ngày có hoạt động trong kỳ · 12 tuần gần nhất</div></div>", { cls: "w-side", info: "Màu càng đậm là ngày học càng lâu" }) +
    "</div>";
}

/* ================= Trang: Kết quả học tập ================= */
function cardParts(C) { return [[C.mastered, "#0E5C8F", "Đã thuộc"], [C.learning, "#5E9E7A", "Đang học"], [C.new, "#D3B477", "Chưa ôn"]]; }
function pageKetQua() {
  var pd = periodData(null);
  if (typeof pd === "string") return headHTML("Kết quả học tập", null) + filtersHTML() + pd;
  var m = pd.m, p = pd.p;
  if (m.empty) return headHTML("Kết quả học tập", m) + filtersHTML() + emptyState(m);
  if (!m.enough) return headHTML("Kết quả học tập", m) + filtersHTML() + holder("Cần thêm dữ liệu để xem kết quả học tập", "Điểm trung bình, tỷ lệ câu đúng và kết quả ôn Flashcard sẽ hiển thị khi bạn có đủ 7 ngày hoạt động. Hãy làm bài ôn tập hoặc ôn Flashcard để tích luỹ dữ liệu.", m, "line");
  var dQ = delta(m.q_avg, p ? p.q_avg : null, "score"), dC = delta(m.correct, p ? p.correct : null, "pt"), dR = delta(m.rev, p ? p.rev : null, "pct"), dRc = delta(m.recall, p ? p.recall : null, "pt");
  var st = function (l, v, d) { return '<div class="stat"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="d ' + d[1] + '">' + d[0].replace(" so với kỳ trước", "") + "</div></div>"; };
  var C = m.cards, parts = cardParts(C);
  return headHTML("Kết quả học tập", m) + filtersHTML() + '<div class="row">' +
    card("Điểm Ôn tập / Thi thử", '<div class="stats">' + st("Điểm trung bình", m.q_avg != null ? n1(m.q_avg) + " / 10" : "—", dQ) + st("Tỷ lệ câu đúng", m.correct != null ? pct(m.correct) : "—", dC) + st("Số lượt làm", m.attempts, [m.practice_count + " ôn tập · " + m.exam_count + " thi thử", "flat"]) + "</div>" +
      "<div>" + lineChart(m, p ? p.q_avg : null) + "</div>" + legend([["var(--tk-series)", "Điểm trung bình theo " + (m.len > 31 ? "tuần" : "ngày"), 1], ["var(--tk-prev)", "TB kỳ trước: " + (p && p.q_avg != null ? n1(p.q_avg) : "—"), 1, 1]]),
      { cls: "w-main", info: "Điểm các lượt Ôn tập và Thi thử đã nộp trong kỳ (thang 10)" }) +
    card("Flashcard", '<div class="stats" style="gap:31px">' + st("Lượt ôn thẻ", m.rev, dR) + st("Tỷ lệ nhớ", m.recall != null ? pct(m.recall) : "—", dRc) + "</div>" +
      '<div style="display:flex;align-items:center;gap:19px">' + donut(parts, C.total, "thẻ") +
      '<div style="display:flex;flex-direction:column;gap:11px">' + parts.map(function (x) { return '<div style="display:flex;gap:8px"><i style="width:10px;height:10px;border-radius:3px;background:' + x[1] + ';margin-top:5px"></i><div><div style="font-size:14px">' + x[2] + '</div><div class="muted" style="font-size:12.5px">' + x[0] + " thẻ · " + (C.total ? Math.round(x[0] / C.total * 100) : 0) + "%</div></div></div>"; }).join("") + "</div></div>" +
      '<div class="foot">Trạng thái thẻ là hiện tại (không theo kỳ): Đã thuộc = khoảng ôn lại từ 21 ngày.</div>',
      { cls: "w-side", info: "Tỷ lệ nhớ = số lần chấm “Dễ” / (Dễ + Khó), không tính Bỏ qua" }) +
    "</div>";
}

/* ================= Trang: So sánh môn ================= */
function pageSoSanh() {
  var pd = periodData(null);
  if (typeof pd === "string") return headHTML("So sánh môn", null) + filtersHTML() + pd;
  var m = pd.m, p = pd.p;
  if (m.empty) return headHTML("So sánh môn", m) + filtersHTML() + emptyState(m);
  if (!m.enough) return headHTML("So sánh môn", m) + filtersHTML() + holder("Cần thêm dữ liệu để so sánh môn học", "Radar năng lực, xếp hạng môn mạnh/yếu và thời lượng theo môn cần ít nhất 7 ngày dữ liệu để đánh giá chính xác.", m, "bars");
  var rows = subjRows(m, p);
  var el = rows.filter(function (r) { return r.s.eligible; }).sort(function (a, b) { return b.s.cap - a.s.cap; }), na = rows.filter(function (r) { return !r.s.eligible; });
  var rad = el.length >= 3 ? radar(el.map(function (r) { return { name: r.s.name, short: shortName(r.s.name), cur: r.s.cap, prev: r.P && r.P.eligible ? r.P.cap : null }; }))
    : '<div class="note-box">Cần ít nhất 3 môn đủ dữ liệu để vẽ radar.</div>';
  var rk = el.map(function (r, i) {
    var d = r.P && r.P.eligible ? Math.round((r.s.cap - r.P.cap) * 10) / 10 : null;
    return '<div class="rk ' + (i === 0 ? "first" : "") + '"><span class="no">' + (i + 1) + '</span><div class="mid"><div class="nm">' + esc(r.s.name) + (i === 0 && el.length > 1 ? '<span class="tag good">Mạnh</span>' : "") + (i === el.length - 1 && el.length > 1 ? '<span class="tag warn">Cần cải thiện</span>' : "") + "</div>" +
      '<div class="sm">Bài làm ' + (r.s.q_avg != null ? n1(r.s.q_avg) : "—") + " · Nhớ " + (r.s.recall != null ? pct(r.s.recall) : "—") + "</div></div>" +
      '<div class="sc"><b>' + n1(r.s.cap) + '</b><span class="' + (d == null ? "flat" : d >= 0 ? "up" : "down") + '">' + (d == null ? "Mới" : d === 0 ? "=" : (d > 0 ? "↑ " : "↓ ") + n1(Math.abs(d))) + "</span></div></div>";
  }).join("") + na.map(function (r) {
    return '<div class="rk na"><span class="no">–</span><div class="mid"><div class="nm">' + esc(r.s.name) + '<span class="tag gray">Chưa đủ dữ liệu</span></div><div class="sm">' + r.s.attempts + "/3 lượt làm bài · " + r.s.rev + '/20 lượt ôn thẻ</div></div><div class="sc"><b>—</b></div></div>';
  }).join("");
  var tmax = Math.max.apply(null, rows.map(function (r) { return r.s.minutes; }).concat([1]));
  var tb = rows.slice().sort(function (a, b) { return b.s.minutes - a.s.minutes; }).map(function (r) {
    return '<div class="bar"><div class="tp"><span class="nm">' + esc(r.s.name) + "</span><b>" + hm(r.s.minutes) + '</b></div><div class="track"><i style="width:' + (r.s.minutes / tmax * 100) + "%;background:" + subjColor(r.id) + '"></i></div></div>';
  }).join("");
  return headHTML("So sánh môn", m) + filtersHTML() + '<div class="row wrap">' +
    card("Năng lực theo môn", '<div style="display:flex;justify-content:center">' + rad + "</div>" + (el.length >= 3 ? legend([["var(--tk-series)", "Kỳ này", 1], ["var(--tk-prev)", "Kỳ trước", 1, 1]]) : "") +
      (na.length ? '<div class="note-box">' + INFO("") + "<span>" + na.map(function (r) { return esc(r.s.name); }).join(", ") + " chưa đủ dữ liệu nên chưa đưa vào biểu đồ.</span></div>" : ""), { style: "flex:1 1 280px", info: "Điểm năng lực của các môn đủ dữ liệu, thang 10" }) +
    card("Xếp hạng môn", '<div class="rank">' + (rk || '<div class="muted">Chưa có môn nào có hoạt động trong kỳ.</div>') + '</div><div class="foot">Điểm năng lực = 0,6 × điểm Ôn tập/Thi thử + 0,4 × tỷ lệ nhớ (thang 10); môn chỉ có 1 trong 2 nguồn thì lấy đúng nguồn đó. Môn cần ≥ 3 lượt làm bài hoặc ≥ 20 lượt ôn thẻ để được xếp hạng.</div>', { style: "flex:1 1 280px", info: "Xếp theo điểm năng lực trong kỳ" }) +
    card("Thời lượng theo môn", '<div class="bars">' + (tb || '<div class="muted">Chưa ghi nhận thời gian học theo môn.</div>') + '</div><div class="total"><span>Tổng</span><b>' + hm(m.minutes) + "</b></div>", { style: "flex:1 1 280px", info: "Tổng thời gian học của từng môn trong kỳ (đọc Chương / PDF)" }) +
    "</div>";
}

/* ================= Nhận xét AI (UC-30) ================= */
function aiBox(inner, meta, right) { return '<div class="ai"><div class="ah"><span class="ic">' + SPARK(19) + '</span><div class="tt"><h3>Nhận xét từ AI</h3><p>' + meta + "</p></div>" + (right || "") + "</div>" + inner + "</div>"; }
function aiResultHTML(r, meta, right, ro, snapId) {
  var G = function (g, t, ic, items, num) {
    return '<div class="grp ' + g + '"><h4>' + ic + t + '</h4><ul style="display:flex;flex-direction:column;gap:8px;padding:0">' + items.map(function (s, i) { return "<li><b>" + (num ? i + 1 + "." : "•") + "</b><span>" + esc(typeof s === "string" ? s : s.text) + "</span></li>"; }).join("") + "</ul>" +
      (num && !ro && items.some(function (x) { return x.subject_id; }) ? '<button type="button" class="link" style="align-self:flex-start" data-act="aiSchedule" data-snap="' + esc(snapId) + '">+&nbsp;&nbsp;Thêm đề xuất vào Lịch biểu</button>' : "") + "</div>";
  };
  return aiBox('<div class="cols">' +
    G("g1", "Điểm mạnh", '<svg width="18" height="18" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" style="fill:var(--tk-good-bg)"/><path d="m6.8 11.2 2.9 2.9 5.6-5.8" style="stroke:var(--tk-green)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', r.good || []) +
    G("g2", "Điểm cần cải thiện", '<svg width="18" height="18" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" style="fill:var(--tk-warn-bg)"/><path d="M11 6.5v5.5M11 15.2v.3" style="stroke:var(--tk-amber)" stroke-width="2.2" stroke-linecap="round"/></svg>', r.bad || []) +
    G("g3", "Đề xuất hành động", '<svg width="18" height="18" viewBox="0 0 22 22"><circle cx="11" cy="11" r="11" style="fill:var(--tk-soft)"/><path d="M7 11h8M12 7.5l3.5 3.5L12 14.5" style="stroke:var(--tk-navy)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>', r.act || [], true) + "</div>" +
    '<div class="fine">' + (ro ? "Nhận xét do AI tạo tại thời điểm lưu, không thay đổi khi số liệu hiện tại cập nhật." : "Nhận xét do AI tạo dựa trên số liệu của bạn, có thể chưa hoàn toàn chính xác. Nhận xét chỉ được lưu vào Lịch sử tiến bộ khi bạn bấm “Lưu nhận xét”.") + "</div>", meta, right);
}
function quotaTxt() {
  if (TK.aiRemaining == null) return "Không giới hạn lượt nhận xét AI";
  return "Còn " + TK.aiRemaining + (TK.aiLimit ? "/" + TK.aiLimit : "") + " lượt nhận xét AI hôm nay";
}
function fmtAt(s) { var d = PT(s); return d ? pad(d.getHours()) + ":" + pad(d.getMinutes()) : ""; }
function pageAI() {
  if (TK.snap) return pageAISnapshot();
  var pd = periodData(null);
  if (typeof pd === "string") return headHTML("Nhận xét AI", null) + filtersHTML() + pd;
  var m = pd.m;
  if (m.empty) return headHTML("Nhận xét AI", m) + filtersHTML() + emptyState(m);
  if (!m.enough) return headHTML("Nhận xét AI", m) + filtersHTML() + holder("Chưa thể nhận xét", "Nhận xét từ AI cần một kỳ có đủ 7 ngày dữ liệu. Hãy tiếp tục học để mở khoá.", m, "line");
  var r = range(), key = periodKey(r[0], r[1], null), per = dmy(r[0]) + " – " + dmy(r[1]);
  var A = TK.ai[key];
  if (!A) {
    var last = pd.ov.ai;
    A = TK.ai[key] = last && last.ai_result ? { state: "result", snap: last } : { state: "idle" };
  }
  var noQuota = TK.aiRemaining === 0, body;
  if (A.state === "idle") {
    body = '<div class="ai" style="padding:28px 31px;gap:19px"><div class="ah"><span class="ic big">' + SPARK(23) + '</span><div class="tt"><h3 style="font-size:19px">Nhận xét từ AI</h3><p style="font-size:14px">AI đọc số liệu của kỳ ' + per + " và đưa ra nhận xét gồm ba phần. Số liệu của kỳ được lưu thành 1 snapshot. Mỗi lần phân tích dùng 1 lượt nhận xét AI (tối đa ' + (TK.aiLimit || 5) + ' lượt/ngày).</p></div></div>" +
      '<div class="cols">' + [["g1", "Điểm mạnh", "Môn và kỹ năng bạn đang làm tốt, dựa trên điểm năng lực và tỷ lệ nhớ."], ["g2", "Điểm cần cải thiện", "Môn có điểm thấp, thẻ chưa thuộc nhiều hoặc thời gian học ít."], ["g3", "Đề xuất hành động", "Việc cụ thể nên làm trong tuần tới, có thể thêm thẳng vào Lịch biểu."]].map(function (x) { return '<div class="grp ' + x[0] + '"><h4>' + x[1] + "</h4><p>" + x[2] + "</p></div>"; }).join("") + "</div>" +
      '<div style="display:flex;align-items:center;gap:12px"><button type="button" class="btn" data-act="aiRun"' + (noQuota ? " disabled" : "") + ">✦&nbsp;&nbsp;Phân tích ngay</button><span class=\"muted\" style=\"font-size:13.5px\">" + quotaTxt() + "</span></div></div>";
  } else if (A.state === "loading") {
    body = aiBox('<div class="cols">' + [[0.92, 0.7, 0.85, 0.5], [0.88, 0.62, 0.9, 0.45], [0.95, 0.8, 0.66, 0.9, 0.4]].map(function (ws) { return '<div class="sk"><i class="t"></i>' + ws.map(function (w) { return '<i style="width:' + Math.round(w * 100) + '%"></i>'; }).join("") + "</div>"; }).join("") + '</div><div class="fine">Thường mất khoảng 5–20 giây. Bạn vẫn có thể xem các mục khác trong lúc chờ.</div>', "Đang phân tích số liệu kỳ " + per + "…", '<span class="spin"></span>');
  } else if (A.state === "error") {
    body = aiBox('<div class="msg err"><svg width="22" height="22" viewBox="0 0 28 28"><circle cx="14" cy="14" r="14" style="fill:var(--tk-red)"/><path d="M14 8.5v7M14 19.2v.3" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg><div class="tx"><h4>Chưa thể tạo nhận xét lúc này</h4><p>' + esc(A.err) + "</p>" +
      '<div style="display:flex;align-items:center;gap:10px;padding-top:5px"><button type="button" class="btn sec" data-act="aiRun"' + (A.quota || noQuota ? " disabled" : "") + '>Thử lại</button><span class="muted" style="font-size:13px">Số liệu thống kê của bạn vẫn được lưu bình thường.</span></div></div></div>', "Kỳ " + per);
  } else if (A.snap.ai_result.few) {
    var f = A.snap.ai_result;
    body = aiBox('<div class="msg info"><svg width="22" height="22" viewBox="0 0 28 28"><circle cx="14" cy="14" r="14" style="fill:var(--tk-soft)"/><path d="M14 8.5v7M14 19.2v.3" style="stroke:var(--tk-navy)" stroke-width="2.4" stroke-linecap="round"/></svg><div class="tx"><h4>Chưa đủ dữ liệu để đưa ra nhận xét đáng tin cậy</h4>' +
      "<p>Kỳ này bạn mới làm " + f.attempts + " lượt Ôn tập/Thi thử và " + f.rev + " lượt ôn thẻ, quá ít để đánh giá điểm mạnh và điểm yếu. AI sẽ không suy đoán khi thiếu số liệu (không tốn lượt AI). Bạn có thể:</p>" +
      '<ul class="grp" style="padding:0;gap:5px"><li><b style="color:var(--tk-navy)">•</b>Làm thêm ít nhất 1 bộ ôn tập cho mỗi môn đang học.</li><li><b style="color:var(--tk-navy)">•</b>Ôn Flashcard thêm 3–4 buổi trong tuần.</li><li><b style="color:var(--tk-navy)">•</b>Quay lại phân tích sau khi có thêm dữ liệu.</li></ul>' +
      '<div style="display:flex;gap:10px;padding-top:5px"><button type="button" class="btn sec sm" data-tool="ontap">Làm bài ôn tập</button><button type="button" class="btn sec sm" data-tool="flashcard">Ôn Flashcard</button></div></div></div>',
      "Dựa trên số liệu " + per, '<button type="button" class="btn sec" data-act="aiRun"' + (noQuota ? " disabled" : "") + ">Phân tích lại</button>");
  } else {
    body = aiResultHTML(A.snap.ai_result, "Dựa trên số liệu " + per + (A.snap.ai_at ? " · tạo lúc " + fmtAt(A.snap.ai_at) : "") + " · " + quotaTxt(),
      '<button type="button" class="btn sec" data-act="aiRun"' + (noQuota ? " disabled" : "") + ">Phân tích lại</button>" + (A.snap.ai_saved ? '<span class="saved-tag">✓ Đã lưu</span>' : '<button type="button" class="btn" data-act="aiSave">Lưu nhận xét</button>'), false, A.snap.id);
  }
  return headHTML("Nhận xét AI", m) + filtersHTML() + body;
}
function pageAISnapshot() {
  var per = dmy(TK.snap.a) + " – " + dmy(TK.snap.b), id = TK.snap.ai_id;
  var head = headHTML("Nhận xét AI", null) + filtersHTML();
  if (!id) return head + aiBox('<div class="msg info"><div class="tx"><h4>Snapshot này chưa có nhận xét được lưu</h4><p>Bạn chỉ có thể tạo nhận xét mới cho kỳ hiện tại.</p></div></div>', "Snapshot " + per);
  var s = snapshotDetail(id);
  if (s === undefined) return head + loadingHTML();
  if (s.error || !s.ai_result) return head + errorHTML(s.error || "Snapshot không có nhận xét.");
  return head + aiResultHTML(s.ai_result, "Đã lưu cùng snapshot " + per, '<span class="saved-tag">✓ Đã lưu</span>', true);
}
function aiRun() {
  var r = range(), key = periodKey(r[0], r[1], null), A = TK.ai[key] = TK.ai[key] || {};
  A.state = "loading"; render();
  var done = function (snap, remaining) {
    A.state = "result"; A.snap = snap; A.err = null;
    if (remaining !== undefined) TK.aiRemaining = remaining;
    invalidate("snaps");
    if (TK.open && TK.route === "ai") render();
  };
  if (!isOnline()) {   // chế độ mẫu: mô phỏng hạn mức 5 lượt/ngày như mẫu thong-ke.html
    if (TK.aiRemaining === 0) { A.state = "error"; A.quota = true; A.err = "Bạn đã dùng hết 5 lượt nhận xét AI trong hôm nay. Lượt mới được cấp lại vào 0:00."; render(); return; }
    setTimeout(function () { done(sampleAI(r[0], r[1]), Math.max(0, TK.aiRemaining - 1)); }, 1400); return;
  }
  apiAuth("POST", "/stats/ai", authToken(), { from: iso(r[0]), to: iso(r[1]) }).then(function (res) {
    if (!res.ok) {
      A.state = "error"; A.quota = res.status === 429;
      A.err = res.status === 429 ? apiErr(res, "Bạn đã dùng hết lượt AI hôm nay.") : res.status === 502 ? apiErr(res, "Dịch vụ phân tích đang bận. Vui lòng thử lại sau ít phút.") : apiErr(res, "Không tạo được nhận xét.");
      if (res.status === 429) TK.aiRemaining = 0;
      if (TK.open && TK.route === "ai") render();
      return;
    }
    done(res.data.snapshot, res.data.ai_remaining);
  });
}
function aiSave() {
  var r = range(), A = TK.ai[periodKey(r[0], r[1], null)];
  if (!A || !A.snap) return;
  var ok = function () { A.snap.ai_saved = true; invalidate("snaps"); toast("Đã lưu nhận xét vào Lịch sử tiến bộ"); render(); };
  if (!isOnline()) { SAMPLE.snaps.push(Object.assign({}, A.snap, { ai_saved: true })); ok(); return; }
  apiAuth("POST", "/stats/ai/" + encodeURIComponent(A.snap.id) + "/save", authToken()).then(function (res) {
    if (!res.ok) { toast(apiErr(res, "Không lưu được nhận xét.")); return; }
    ok();
  });
}
// Hộp xác nhận "Thêm đề xuất vào Lịch biểu": chọn đề xuất (chỉ đề xuất gắn được Môn), tạo buổi ôn tuần sau
function openScheduleModal(snapId) {
  var r = range(), A = TK.ai[periodKey(r[0], r[1], null)];
  var acts = (A && A.snap && A.snap.ai_result && A.snap.ai_result.act) || [];
  var t = today(), mon = addD(t, 7 - ((t.getDay() + 6) % 7));
  var box = $("tk-modal");
  box.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h3>Thêm đề xuất vào Lịch biểu</h3>' +
    '<p class="muted" style="font-size:13.5px">Mỗi đề xuất thành các buổi "Ôn &lt;môn&gt;" chia đều trong tuần ' + dm(mon) + " – " + dm(addD(mon, 6)) + ", bắt đầu 19:00, nhắc trước 10 phút. Trùng giờ với lịch sẵn có vẫn được tạo.</p>" +
    '<div class="acts-list">' + acts.map(function (a, i) {
      var ok = !!a.subject_id;
      return '<label class="' + (ok ? "" : "off") + '"><input type="checkbox" data-i="' + i + '"' + (ok ? " checked" : " disabled") + ' style="margin-top:3px"><span><b style="font-weight:500">' + esc(a.subject_name || "Không rõ môn") + "</b> · " + a.sessions + " buổi × " + a.minutes + " phút<br><span class=\"muted\">" + esc(a.text) + (ok ? "" : " (không khớp Môn nào nên không thêm được)") + "</span></span></label>";
    }).join("") + "</div>" +
    '<div class="ft"><button type="button" class="btn sec sm" data-act="modalClose">Hủy</button><button type="button" class="btn sm" data-act="scheduleOk" data-snap="' + esc(snapId) + '">Thêm vào Lịch biểu</button></div></div>';
  box.hidden = false;
}
function closeModal() { if ($("tk-modal")) { $("tk-modal").hidden = true; $("tk-modal").innerHTML = ""; } }
function scheduleOk(snapId) {
  var idx = Array.from($("tk-modal").querySelectorAll("input[data-i]:checked")).map(function (x) { return +x.dataset.i; });
  if (!idx.length) { closeModal(); return; }
  if (!isOnline()) { closeModal(); toast("Chế độ mẫu: đăng nhập để thêm buổi ôn vào Lịch biểu"); return; }
  apiAuth("POST", "/stats/ai/" + encodeURIComponent(snapId) + "/schedule", authToken(), { indexes: idx }).then(function (res) {
    closeModal();
    if (!res.ok) { toast(apiErr(res, "Không thêm được vào Lịch biểu.")); return; }
    var n = res.data.created.length;
    toast(n ? "Đã thêm " + n + " buổi ôn vào Lịch biểu tuần " + dm(P(res.data.week_start)) : "Không có đề xuất nào thêm được");
  });
}

/* ================= Trang: Lịch sử tiến bộ ================= */
function pageLichSu() {
  var list = snapshotsData(), head = headHTML("Lịch sử tiến bộ", null) + filtersHTML();
  if (list === undefined) return head + loadingHTML();
  if (list.error) return head + errorHTML(list.error);
  var all = list.slice(), per = getPerPage("tk_hist", 5, HIST_PER_OPTS), pages = Math.max(1, Math.ceil(all.length / per));
  TK.hPage = Math.min(TK.hPage, pages - 1);
  var rows = all.slice(TK.hPage * per, TK.hPage * per + per), cur = TK.snap ? TK.snap.id : null;
  var weekly = all.filter(function (s) { return s.kind === "weekly" && s.cap != null; }).sort(function (a, b) { return a.to < b.to ? -1 : 1; }).slice(-6)
    .map(function (s) { return { a: P(s.from), b: P(s.to), cap: s.cap }; });
  var ch = weekly.length >= 2 ? weekly[weekly.length - 1].cap - weekly[0].cap : 0;
  return head + '<div class="row">' +
    card("Điểm năng lực qua các tuần", weekly.length ? "<div>" + historyLine(weekly) + '</div><div class="' + (ch >= 0 ? "up" : "down") + '" style="font-size:13.5px;font-weight:500">' + (ch >= 0 ? "↑" : "↓") + " " + n1(Math.abs(ch)) + " điểm sau " + weekly.length + " tuần gần nhất</div>" : '<p class="muted">Chưa có snapshot tuần nào có điểm năng lực.</p>', { cls: "w-hist", info: "Điểm năng lực trung bình các môn đủ dữ liệu của mỗi tuần" }) +
    card("Các snapshot đã lưu", all.length ? '<table class="htable"><thead><tr><th>Kỳ</th><th>Điểm TB</th><th>Tỷ lệ nhớ</th><th>Thời gian</th><th>Nhận xét AI</th><th></th></tr></thead><tbody>' +
      rows.map(function (s) {
        var at = PT(s.created_at), isCur = cur && (s.id === cur);
        return '<tr class="' + (isCur ? "cur" : "") + '"><td class="per"><b>' + dm(P(s.from)) + " – " + dmy(P(s.to)) + (s.subject_name ? " · " + esc(s.subject_name) : "") + "</b><span>" + s.len + " ngày · " + (s.kind === "weekly" ? "tự chốt" : "lưu cùng nhận xét") + " " + (at ? dm(at) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes()) : "") + "</span></td>" +
          "<td>" + (s.q_avg != null ? n1(s.q_avg) : "—") + "</td><td>" + (s.recall != null ? pct(s.recall) : "—") + "</td><td>" + hmShort(s.minutes) + "</td>" +
          "<td>" + (s.has_ai && s.ai_saved ? '<button type="button" class="link ok" data-hai="' + esc(aiIdOf(s)) + '">✓ Xem nhận xét</button>' : '<span class="muted">—</span>') + "</td>" +
          "<td>" + (isCur ? '<span style="font-size:12px;font-weight:500;color:var(--tk-navy)">Đang xem</span>' : '<button type="button" class="link" data-snap="' + esc(s.id) + '">Xem</button>') + "</td></tr>";
      }).join("") + "</tbody></table>" +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><span class="muted" style="font-size:13px">Mỗi tuần (T2–CN) đủ 7 ngày dữ liệu được lưu tự động thành một snapshot.</span><span style="flex:1"></span><span data-per-key="tk_hist">' + perSelectHtml(per, HIST_PER_OPTS, "dòng") + '</span><div class="pager"><button type="button" data-hp="-1"' + (TK.hPage ? "" : " disabled") + ' aria-label="Trang trước">‹</button>' + (TK.hPage + 1) + "/" + pages + '<button type="button" data-hp="1"' + (TK.hPage < pages - 1 ? "" : " disabled") + ' aria-label="Trang sau">›</button></div></div>'
      : '<div style="display:flex;gap:12px;align-items:center">' + icBox("clock", 32, "var(--tk-chip)", "var(--muted-2)") + '<div><div style="font-size:15px;font-weight:500">Chưa có snapshot nào</div><div class="muted" style="font-size:13.5px">Snapshot đầu tiên được lưu tự động khi một tuần (T2–CN) đã kết thúc và bạn có đủ 7 ngày dữ liệu, hoặc khi bạn tạo nhận xét AI.</div></div></div>',
      { style: "flex:1", right: '<span class="note">' + all.length + " snapshot</span>" }) +
    "</div>" + savedAiHTML(all);
}
// Nhận xét AI ĐÃ LƯU hiện thẳng nội dung ngay trên trang Lịch sử tiến bộ (trước đây chỉ có dấu "✓ Đã lưu" trong bảng,
// muốn đọc phải bấm Xem → Hoạt động → Nhận xét AI). Mới lưu nhất đứng đầu; bấm chip kỳ để đổi nhận xét đang đọc.
function aiIdOf(s) { return s.kind === "ai" ? s.id : (s.ai_id || s.id); }
function savedAiHTML(all) {
  var saved = all.filter(function (s) { return s.has_ai && s.ai_saved; })
    .sort(function (a, b) { return (b.ai_at || b.created_at) < (a.ai_at || a.created_at) ? -1 : 1; });
  if (!saved.length) return "";
  var ids = saved.map(aiIdOf);
  if (ids.indexOf(TK.hAi) < 0) TK.hAi = ids[0];
  var cur = saved[ids.indexOf(TK.hAi)], per = dmy(P(cur.from)) + " – " + dmy(P(cur.to)) + (cur.subject_name ? " · " + esc(cur.subject_name) : "");
  var chips = saved.length > 1 ? '<div style="display:flex;flex-wrap:wrap;gap:8px">' + saved.map(function (s, i) {
    return '<button type="button" class="pill' + (ids[i] === TK.hAi ? " on" : "") + '" data-hai="' + esc(ids[i]) + '">' + dm(P(s.from)) + " – " + dm(P(s.to)) + "</button>";
  }).join("") + "</div>" : "";
  var d = snapshotDetail(TK.hAi), body;
  if (d === undefined) body = loadingHTML();
  else if (d.error || !d.ai_result) body = errorHTML(d.error || "Không đọc được nhận xét đã lưu.");
  else {
    var at = PT(d.ai_at || d.created_at);
    body = aiResultHTML(d.ai_result, "Kỳ " + per + (at ? " · lưu lúc " + pad(at.getHours()) + ":" + pad(at.getMinutes()) + " " + dmy(at) : ""), '<span class="saved-tag">✓ Đã lưu</span>', true);
  }
  return '<div class="row" id="tk-saved-ai"><div style="flex:1;display:flex;flex-direction:column;gap:12px;min-width:0">' +
    card("Nhận xét AI đã lưu", chips + body, { right: '<span class="note">' + saved.length + " nhận xét</span>" }) + "</div></div>";
}
function openSnapshot(id) {
  var list = TK.cache.snaps || [], s = list.find(function (x) { return x.id === id; });
  if (!s) return;
  TK.snap = { id: s.id, a: P(s.from), b: P(s.to), savedAt: PT(s.created_at), ai_id: s.kind === "ai" ? s.id : (s.ai_id || null) };
  go("hoatdong");
}

/* ================= Notebook: danh sách & chi tiết môn ================= */
function nbMeta(s) { return s.chapters + " chương · " + s.pdfs + " tệp PDF"; }
function pageNbList() {
  crumb([["Notebook"]]);
  var head = '<div class="ph"><div class="t"><h1>Notebook</h1><div class="sub2" id="tk-nbsub"></div></div><button type="button" class="btn" data-act="newSubject">+&nbsp;&nbsp;Tạo môn học</button></div>';
  var list = subjectsData();
  if (list === undefined) return head + loadingHTML();
  if (list.error) return head + errorHTML(list.error);
  var q = (TK.nbQ || "").toLowerCase().trim(), shown = list.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) >= 0; });
  TK.subjectOrder = list.map(function (s) { return s.id; });
  var tot = list.reduce(function (p, s) { p[0] += s.chapters; p[1] += s.pdfs; return p; }, [0, 0]);
  return head.replace('<div class="sub2" id="tk-nbsub"></div>', '<div class="sub2">' + list.length + " môn học · " + tot[0] + " chương · " + tot[1] + " tệp PDF</div>") +
    '<div class="filters"><label class="search">' + svg("search", "var(--muted)") + '<input id="tk-nbsearch" placeholder="Tìm môn học…" value="' + esc(TK.nbQ || "") + '"></label></div>' +
    '<div class="grid3">' + shown.map(function (s) {
      var p = s.reviewed_percent, c = subjColor(s.id);
      return '<button type="button" class="nbcard" data-nb="' + esc(s.id) + '"><div class="cv" style="background:color-mix(in srgb,' + c + ' 16%,var(--panel))">' + icBox("book", 38, c, "#fff") + '<b style="color:' + c + '">' + esc(s.name) + "</b></div>" +
        '<div class="bd"><span>' + nbMeta(s) + '</span><span class="muted" style="font-size:12.5px">' + s.practice_sets + " bộ ôn tập · " + s.exams + " đề thi · " + s.flashcard_sets + " bộ thẻ</span>" +
        '<span style="display:flex;justify-content:space-between;font-size:12.5px"><span class="muted">Đã ôn</span><b style="font-weight:500;color:' + c + '">' + p + "%</b></span>" +
        '<span class="track" style="height:6px"><i style="width:' + p + "%;background:" + c + '"></i></span>' +
        '<span style="display:flex;justify-content:space-between;align-items:center;font-size:12px"><span class="muted">Học lần cuối ' + relDay(s.last_at) + '</span><span class="link" style="font-size:12.5px">Mở</span></span></div></button>';
    }).join("") +
    '<button type="button" class="nbnew" data-act="newSubject"><svg width="38" height="38" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" style="fill:var(--tk-soft)"/><path d="M24 16v16M16 24h16" style="stroke:var(--tk-navy)" stroke-width="2.2" stroke-linecap="round"/></svg>Tạo môn học mới<span class="muted" style="font-size:12.5px;font-weight:400">Mỗi môn gồm các Chương và tệp PDF</span></button>' +
    "</div>";
}
var STATUS = { reviewed: ["Đã ôn", "good"], learning: ["Đang học", "navy"], new: ["Chưa ôn", "gray"] };
function pageNb() {
  var s = subjectData(TK.nb), name = (s && !s.error && s.name) || ((state.subjects || []).find(function (x) { return x.id === TK.nb; }) || {}).name || "Môn học";
  crumb([["Notebook", "nblist"], [name]]);
  var c = subjColor(TK.nb);
  var head = '<div class="ph"><span class="nb-ic" style="background:' + c + '">' + svg("book", "#fff", 23) + '</span><div class="t"><h1>' + esc(name) + '</h1><div class="sub2">' +
    (s && !s.error ? s.items.filter(function (x) { return x.kind === "chapter"; }).length + " chương · " + s.items.filter(function (x) { return x.kind === "pdf"; }).length + " tệp PDF · đã ôn " + s.reviewed_percent + "% · học lần cuối " + relDay(s.last_at) : "") + "</div></div>" +
    '<button type="button" class="btn sec" data-act="uploadPdf">Tải tệp PDF lên</button><button type="button" class="btn" data-act="addChapter">+&nbsp;&nbsp;Thêm chương</button></div>' +
    '<div class="tabs"><button type="button" class="' + (TK.nbTab === "noidung" ? "on" : "") + '" data-tab="noidung">Nội dung</button><button type="button" class="' + (TK.nbTab === "thongke" ? "on" : "") + '" data-tab="thongke">Thống kê</button></div>';
  if (TK.nbTab === "thongke") return head + nbStats(name);
  if (s === undefined) return head + loadingHTML();
  if (s.error) return head + errorHTML(s.error);
  var items = s.items.length ? s.items.map(function (x) {
    var st = STATUS[x.status], meta = x.kind === "pdf" ? "Tệp PDF" + (x.pages ? " · " + x.pages + " trang" : "") : "Chương · " + x.words.toLocaleString("vi-VN") + " từ" + (x.short ? " · nội dung còn ít" : "");
    return '<div class="chap"><button type="button" class="hd itm-open" data-open="' + x.kind + "|" + esc(x.id) + '">' + icBox(x.kind === "pdf" ? "pdf" : "note", 30, x.kind === "pdf" ? "var(--tk-err-bg)" : "var(--tk-soft)", x.kind === "pdf" ? "var(--tk-red)" : "var(--tk-navy)") +
      '<span class="mid"><b>' + esc(x.name) + '</b><small class="' + (x.short ? "warn" : "") + '">' + meta + '</small></span><span class="tag ' + st[1] + '">' + st[0] + "</span>" + CHEV() + "</button></div>";
  }).join("") : '<div class="empty" style="padding:30px"><h2>Môn này chưa có nội dung</h2><p>Thêm Chương hoặc tải tệp PDF lên để bắt đầu học.</p></div>';
  var T = s.tools;
  var tools = [["ontap", "check", "Ôn tập", T.practice + " bộ câu hỏi"], ["thithu", "clip", "Thi thử", T.exam + " đề"], ["flashcard", "cards", "Flashcard", T.flashcard + " bộ · " + T.cards + " thẻ"], ["mindmap", "mind", "Sơ đồ tư duy", T.mindmap + " sơ đồ"], ["tomtat", "sum", "Tóm tắt", T.summary + " bản tóm tắt"]];
  var w = s.week;
  return head + '<div class="row" style="min-height:0">' +
    '<div class="col w-main" style="gap:8px">' + items + '<div class="foot">Đã ôn = Chương/tệp là nguồn của bộ ôn tập, đề thi hoặc bộ thẻ bạn đã làm/ôn. Đang học = đã mở đọc nhưng chưa ôn. Bấm để mở trong Notebook.</div></div>' +
    '<div class="col w-side">' +
      '<div class="card" style="padding:15px 9px 9px;gap:3px"><div class="hd" style="padding:0 9px 6px"><h3>Công cụ học tập</h3></div>' + tools.map(function (x) { return '<button type="button" class="tool" data-tool="' + x[0] + '">' + icBox(x[1], 34, "var(--tk-soft)", "var(--tk-navy)") + '<span class="mid"><b>' + x[2] + "</b><small>" + x[3] + "</small></span>" + CHEV() + "</button>"; }).join("") + "</div>" +
      card("Tiến độ môn (7 ngày)", '<div class="stats" style="gap:25px"><div class="stat"><div class="l" style="font-size:12px">Điểm năng lực</div><div class="v" style="font-size:19px">' + (w.cap != null ? n1(w.cap) : "—") + '</div></div><div class="stat"><div class="l" style="font-size:12px">Tỷ lệ nhớ</div><div class="v" style="font-size:19px">' + (w.recall != null ? pct(w.recall) : "—") + '</div></div><div class="stat"><div class="l" style="font-size:12px">Thời gian</div><div class="v" style="font-size:19px">' + hmShort(w.minutes) + "</div></div></div>" +
        '<button type="button" class="link" style="align-self:flex-start" data-tab="thongke">Xem tab Thống kê</button>') +
    "</div></div>";
}
function nbStats(name) {
  var pd = periodData(TK.nb);
  if (typeof pd === "string") return filtersHTML() + pd;
  var m = pd.m, p = pd.p, B = m.by_subject[TK.nb] || { minutes: 0, attempts: 0, rev: 0, sets: [], fsets: [] }, PB = p && p.by_subject ? p.by_subject[TK.nb] : null;
  if (m.empty) return filtersHTML() + '<div class="empty" style="padding:38px"><h2>Chưa có hoạt động của môn này trong khoảng thời gian đã chọn</h2><p>Hãy chọn khoảng thời gian khác, hoặc mở tab Nội dung để bắt đầu học.</p><button type="button" class="btn sec" data-tab="noidung">Mở tab Nội dung</button></div>';
  var all = overview(P(m.from), P(m.to), null), rk = null, nEl = 0;
  if (all && !all.error) {
    var el = Object.keys(all.cur.by_subject).map(function (id) { return { id: id, s: all.cur.by_subject[id] }; }).filter(function (x) { return x.s.eligible; }).sort(function (a, b) { return b.s.cap - a.s.cap; });
    nEl = el.length; rk = el.findIndex(function (x) { return x.id === TK.nb; });
  }
  var sets = B.sets.slice().sort(function (a, b) { return Math.max.apply(null, b.scores) - Math.max.apply(null, a.scores); });
  return filtersHTML() + '<div class="kpis">' +
    kpi("clock", KPI_BG.navy[0], KPI_BG.navy[1], "Thời gian học", hm(B.minutes), PB ? delta(B.minutes, PB.minutes, "pct") : delta(null), all && !all.error && all.cur.minutes ? Math.round(B.minutes / all.cur.minutes * 100) + "% tổng thời gian học" : "") +
    kpi("cal", KPI_BG.teal[0], KPI_BG.teal[1], "Số ngày học", m.active_days + "/" + m.len + " ngày", p ? delta(m.active_days, p.active_days, "day") : delta(null), "Chuỗi hiện tại: " + m.streak + " ngày") +
    kpi("star", KPI_BG.navy[0], KPI_BG.navy[1], "Điểm năng lực", B.eligible ? n1(B.cap) + " / 10" : "—", B.eligible && PB && PB.eligible ? delta(B.cap, PB.cap, "score") : [B.eligible ? "Mới trong kỳ này" : "Chưa đủ dữ liệu", "flat"], B.eligible ? (rk >= 0 ? "Xếp hạng " + (rk + 1) + "/" + nEl + " môn" : "") : B.attempts + "/3 lượt làm bài · " + B.rev + "/20 lượt ôn thẻ") +
    kpi("doc", KPI_BG.green[0], KPI_BG.green[1], "Lượt làm bài", B.attempts + " lượt", [B.rev + " lượt ôn thẻ", "flat"], B.q_avg != null ? "Điểm TB " + n1(B.q_avg) + " · nhớ " + (B.recall != null ? pct(B.recall) : "—") : "Chưa làm bài trong kỳ") +
    '</div><div class="row">' +
    card("Điểm theo từng bộ Ôn tập / Thi thử", '<div class="bars">' + (sets.length ? sets.map(function (x) {
      var best = Math.max.apply(null, x.scores), last = x.scores[x.scores.length - 1];
      return '<div class="bar"><div class="tp"><span class="nm">' + esc(x.title) + "<small>" + (x.mode === "exam" ? "Thi thử · " : "Ôn tập · ") + x.scores.length + " lượt · gần nhất " + n1(last) + '</small></span><b class="big">' + n1(best) + '</b></div><div class="track" style="height:8px"><i style="width:' + best * 10 + "%;background:" + (best < 6.5 ? "#D3B477" : "var(--tk-series)") + '"></i></div></div>';
    }).join("") : '<div class="muted">Chưa làm bộ nào trong kỳ.</div>') + '</div><div class="foot">Điểm cao nhất của mỗi bộ trong kỳ, thang 10. Màu vàng: dưới 6,5 điểm, nên làm lại.</div>', { style: "flex:1" }) +
    card("Tỷ lệ nhớ theo từng bộ Flashcard", '<div class="bars">' + (B.fsets.length ? B.fsets.map(function (f) {
      var r = f.n ? f.ok / f.n : null;
      return '<div class="bar"><div class="tp"><span class="nm">' + esc(f.title) + "<small>" + f.n + " lượt ôn · " + f.cards + ' thẻ</small></span><b class="big">' + (r != null ? pct(r) : "—") + '</b></div><div class="track" style="height:8px"><i style="width:' + (r || 0) * 100 + "%;background:" + (r != null && r < 0.75 ? "#D3B477" : "#1C8A8A") + '"></i></div></div>';
    }).join("") : '<div class="muted">Chưa ôn bộ thẻ nào trong kỳ.</div>') + '</div><div class="foot">Tỷ lệ chấm “Dễ” trên Dễ + Khó trong kỳ. Màu vàng: dưới 75%.</div>', { style: "flex:1" }) +
    "</div>";
}

/* ================= Popover chọn khoảng thời gian (port từ mẫu) ================= */
var PK = { open: false, a: null, b: null, m1: null, preset: "custom", picking: false };
function openPicker() {
  var r = range();
  Object.assign(PK, { open: true, a: r[0], b: r[1], picking: false, preset: TK.period.kind === "custom" ? "custom" : TK.period.kind, m1: new Date(r[1].getFullYear(), r[1].getMonth() - 1, 1) });
  drawPicker();
}
function closePicker() { PK.open = false; var p = document.querySelector("#tk-pane .pop"); if (p) p.remove(); }
function calHTML(first, arrow) {
  var off = (first.getDay() + 6) % 7, nd = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), t = today();
  var h = '<div class="cal"><div class="mh"><button type="button" data-cm="-1" style="visibility:' + (arrow === "l" ? "visible" : "hidden") + '">‹</button>Tháng ' + (first.getMonth() + 1) + ", " + first.getFullYear() + '<button type="button" data-cm="1" style="visibility:' + (arrow === "r" ? "visible" : "hidden") + '">›</button></div><div class="g">' + ["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map(function (d) { return '<span class="dn">' + d + "</span>"; }).join("");
  for (var i = 0; i < off; i++) h += '<span class="c"></span>';
  for (var d = 1; d <= nd; d++) {
    var dt = D0(new Date(first.getFullYear(), first.getMonth(), d)), b = PK.b || PK.a, inR = PK.a && dt >= PK.a && dt <= b, col = (off + d - 1) % 7;
    var cls = ["c", inR ? "in" : "", +dt === +PK.a ? "s rs" : "", +dt === +b ? "e re" : "", inR && (col === 0 || d === 1) ? "rs" : "", inR && (col === 6 || d === nd) ? "re" : "", +dt === +t ? "today" : ""].join(" ");
    h += '<span class="' + cls + '"><button type="button" data-d="' + dt.getTime() + '"' + (dt > t ? " disabled" : "") + ">" + d + "</button></span>";
  }
  return h + "</div></div>";
}
function drawPicker() {
  var pane = $("tk-pane"), p = pane.querySelector(".pop");
  if (!p) { p = document.createElement("div"); p.className = "pop"; pane.appendChild(p); }
  var pill = $("tk-pcustom"); if (!pill) { closePicker(); return; }
  var k = pane.getBoundingClientRect(), r = pill.getBoundingClientRect();
  var len = PK.a && PK.b ? diff(PK.a, PK.b) + 1 : null, bad = len > 365;
  var pre = [["7", "7 ngày gần nhất"], ["30", "30 ngày gần nhất"], ["month", "Tháng này"], ["lastmonth", "Tháng trước"], ["custom", "Tùy chọn"]];
  var hint = "Chọn ngày bắt đầu, rồi chọn ngày kết thúc.";
  if (PK.a && PK.b) { var pr = prevOf(PK.a, PK.b); hint = bad ? "Khoảng thời gian tối đa là 365 ngày." : len + " ngày · so sánh với " + len + " ngày trước đó (" + dm(pr[0]) + " – " + dm(pr[1]) + ")"; }
  p.innerHTML = '<div class="pre">' + pre.map(function (x) { return '<button type="button" data-pre="' + x[0] + '" class="' + (PK.preset === x[0] ? "on" : "") + '">' + x[1] + (PK.preset === x[0] ? '<svg width="14" height="14" viewBox="0 0 18 18"><path d="m3.5 9.2 3.4 3.4 7.6-7.8" style="stroke:var(--tk-navy)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : "") + "</button>"; }).join("") + "</div>" +
    '<div class="cr"><div class="cals">' + calHTML(PK.m1, "l") + calHTML(new Date(PK.m1.getFullYear(), PK.m1.getMonth() + 1, 1), "r") + "</div>" +
    '<div class="fields"><div class="fld ' + (!PK.picking ? "on" : "") + '"><small>Từ ngày</small><b>' + (PK.a ? dmy(PK.a) : "—") + '</b></div><span class="muted">–</span><div class="fld ' + (PK.picking ? "on" : "") + '"><small>Đến ngày</small><b>' + (PK.b ? dmy(PK.b) : "—") + "</b></div></div>" +
    '<div class="hint ' + (bad ? "err" : "") + '">' + hint + "</div>" +
    '<div class="ft"><button type="button" class="btn sec sm" data-pk="cancel">Hủy</button><button type="button" class="btn sm" data-pk="ok"' + (!PK.a || !PK.b || bad ? " disabled" : "") + ">Áp dụng</button></div></div>";
  var left = Math.min(r.left - k.left, k.width - p.offsetWidth - 12);
  p.style.left = Math.max(12, left) + "px"; p.style.top = (r.bottom - k.top + 6) + "px";
}
function pickerClick(e) {
  var cm = e.target.closest("[data-cm]"); if (cm) { PK.m1 = new Date(PK.m1.getFullYear(), PK.m1.getMonth() + +cm.dataset.cm, 1); drawPicker(); return; }
  var d = e.target.closest("[data-d]");
  if (d) {
    var dt = D0(new Date(+d.dataset.d)); PK.preset = "custom";
    if (!PK.picking) { PK.a = dt; PK.b = null; PK.picking = true; } else { if (dt < PK.a) { PK.b = PK.a; PK.a = dt; } else PK.b = dt; PK.picking = false; }
    drawPicker(); return;
  }
  var pr = e.target.closest("[data-pre]");
  if (pr) {
    var k = pr.dataset.pre, t = today(); PK.preset = k; PK.picking = false;
    if (k === "7" || k === "30") { PK.b = t; PK.a = addD(t, -(+k - 1)); }
    if (k === "month") { PK.a = D0(new Date(t.getFullYear(), t.getMonth(), 1)); PK.b = t; }
    if (k === "lastmonth") { PK.a = D0(new Date(t.getFullYear(), t.getMonth() - 1, 1)); PK.b = D0(new Date(t.getFullYear(), t.getMonth(), 0)); }
    PK.m1 = new Date(PK.b.getFullYear(), PK.b.getMonth() - 1, 1); drawPicker(); return;
  }
  var pk = e.target.closest("[data-pk]");
  if (pk) {
    if (pk.dataset.pk === "ok") { TK.period = PK.preset === "7" || PK.preset === "30" ? { kind: PK.preset } : { kind: "custom", a: PK.a, b: PK.b }; TK.hPage = 0; saveResume(); }
    closePicker(); render();
  }
}

/* ================= Vẽ trang ================= */
function render() {
  if (!TK.open) return;
  closePicker();
  var r = TK.route, html = "";
  if (isTQ(r) && r !== "homnay") crumb([["Tổng quan", "homnay"], [SUBS.find(function (s) { return s[0] === r; })[1]]]);
  if (r === "homnay") html = pageHomNay();
  else if (r === "hoatdong") html = pageHoatDong();
  else if (r === "ketqua") html = pageKetQua();
  else if (r === "sosanh") html = pageSoSanh();
  else if (r === "ai") html = pageAI();
  else if (r === "lichsu") html = pageLichSu();
  else if (r === "nblist") html = pageNbList();
  else if (r === "nb") html = pageNb();
  var rg = range(), ov = isTQ(r) && r !== "homnay" ? TK.cache["ov|" + periodKey(rg[0], rg[1], null)] : null;
  renderSide(ov && !ov.error ? ov.cur : null);
  renderUser();
  var main = $("tk-main"), st = main.scrollTop, inSearch = document.activeElement && document.activeElement.id === "tk-nbsearch";
  var pos = inSearch ? document.activeElement.selectionStart : null;
  main.innerHTML = html;
  main.scrollTop = st;
  if (inSearch && $("tk-nbsearch")) { $("tk-nbsearch").focus(); $("tk-nbsearch").setSelectionRange(pos, pos); }
}
function toast(msg) {
  var t = $("tk-toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2600);
}

/* ================= Gắn sự kiện (1 lần) ================= */
export function initThongke() {
  var pane = $("tk-pane"); if (!pane) return;
  $("tk-close").onclick = function (e) { e.stopPropagation(); closeThongke(); };
  $("tk-bell").onclick = function (e) { e.stopPropagation(); closeThongke(); hooks.openLichbieu(); };
  $("tk-menu").onclick = function (e) {
    e.stopPropagation();
    var open = !pane.classList.contains("sb-open");
    if (open && isTQ(TK.route) && !TK.sbOpen) { TK.sbOpen = true; render(); } // mở sẵn danh sách mục của Tổng quan
    setSbDrawer(open);
  };
  $("tk-scrim").onclick = function (e) { e.stopPropagation(); setSbDrawer(false); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && pane.classList.contains("sb-open")) setSbDrawer(false); });
  $("tk-sb").addEventListener("click", function (e) {
    var a = e.target.closest("[data-act]");
    if (a) { setSbDrawer(false); act(a.dataset.act, a); return; }
    var b = e.target.closest("[data-go]"); if (!b || b.disabled) return;
    if (b.dataset.go === "toggle") { TK.sbOpen = !TK.sbOpen; render(); return; } // "Tổng quan": thả / thu danh sách, ngăn kéo vẫn mở
    if (b.dataset.go === "homnay" && b.classList.contains("nav") && pane.classList.contains("sb-open")) {
      TK.sbForce = !TK.sbForce; renderSide(TK.lastSideM); return;
    }
    setSbDrawer(false);
    if (b.dataset.go !== "nb" && b.dataset.go !== "nblist") TK.snap = TK.snap && isTQ(b.dataset.go) ? TK.snap : null;
    go(b.dataset.go);
  });
  $("tk-crumb").addEventListener("click", function (e) { var b = e.target.closest("[data-go]"); if (b) go(b.dataset.go); });
  pane.addEventListener("click", function (e) {
    var pop = e.target.closest(".pop");
    if (pop) { e.stopPropagation(); pickerClick(e); return; }
    if (PK.open && !e.target.closest("#tk-pcustom")) closePicker();
    if (e.target === $("tk-modal")) { closeModal(); return; }
  }, true);
  $("tk-modal").addEventListener("click", function (e) { var a = e.target.closest("[data-act]"); if (a) act(a.dataset.act, a); });
  var main = $("tk-main");
  // Ô "Hiển thị [n] dòng/trang" (vẽ lại mỗi lần render) — bắt sự kiện đổi bằng uỷ quyền
  main.addEventListener("change", function (e) {
    var sel = e.target.closest("[data-per-sel]"), box = sel && sel.closest("[data-per-key]");
    if (!box) return;
    setPerPage(box.dataset.perKey, Number(sel.value)); TK.hPage = 0; render();
  });
  main.addEventListener("click", function (e) {
    var per = e.target.closest("[data-per]");
    if (per) {
      if (per.dataset.per === "custom") { PK.open ? closePicker() : openPicker(); return; }
      TK.period = { kind: per.dataset.per }; TK.snap = null; saveResume(); closePicker(); render(); return;
    }
    var g = e.target.closest("[data-go]"); if (g) { go(g.dataset.go); return; }
    var nb = e.target.closest("[data-nb]"); if (nb) { go("nb", { nb: nb.dataset.nb, nbTab: "noidung", snap: null }); return; }
    var tb = e.target.closest("[data-tab]"); if (tb) { TK.nbTab = tb.dataset.tab; saveResume(); render(); return; }
    var op = e.target.closest("[data-open]");
    if (op) { var parts = op.dataset.open.split("|"); closeThongke(); hooks.openSource(parts[0] === "pdf" ? { subject_id: TK.nb, document_id: parts[1] } : { subject_id: TK.nb, chapter_id: parts[1] }); return; }
    var tl = e.target.closest("[data-tool]"); if (tl) { closeThongke(); hooks.openTool(tl.dataset.tool); return; }
    var ha = e.target.closest("[data-hai]");
    if (ha) {
      TK.hAi = ha.dataset.hai; render();
      var box = $("tk-saved-ai"); if (box && !ha.classList.contains("pill")) box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    var sn = e.target.closest("[data-snap]:not([data-act])"); if (sn) { openSnapshot(sn.dataset.snap); return; }
    var hp = e.target.closest("[data-hp]"); if (hp) { TK.hPage += +hp.dataset.hp; render(); return; }
    var a = e.target.closest("[data-act]"); if (a) act(a.dataset.act, a);
  });
  main.addEventListener("input", function (e) { if (e.target.id === "tk-nbsearch") { TK.nbQ = e.target.value; render(); } });
  main.addEventListener("mousemove", function (e) {
    var t = e.target.closest("[data-tip]"); if (!t) { hideTip(); return; }
    var k = pane.getBoundingClientRect(), tip = $("tk-tip");
    tip.textContent = t.dataset.tip; tip.hidden = false;
    var x = e.clientX - k.left + 12, y = e.clientY - k.top - 38;
    if (x + tip.offsetWidth > k.width - 8) x -= tip.offsetWidth + 24;
    tip.style.left = x + "px"; tip.style.top = Math.max(4, y) + "px";
  });
  main.addEventListener("mouseleave", hideTip);
  document.addEventListener("keydown", function (e) {
    if (!TK.open || e.key !== "Escape") return;
    if (!$("tk-modal").hidden) closeModal(); else if (PK.open) closePicker();
  });
}
function act(name, el) {
  if (name.indexOf("toast:") === 0) { toast(name.slice(6)); return; }
  if (name === "settings") { hooks.openProfile(); return; }
  if (name === "reload") { invalidate(); TK.ai = {}; render(); return; }
  if (name === "exitSnap") { TK.snap = null; render(); return; }
  if (name === "aiRun") { aiRun(); return; }
  if (name === "aiSave") { aiSave(); return; }
  if (name === "aiSchedule") { openScheduleModal(el.dataset.snap); return; }
  if (name === "modalClose") { closeModal(); return; }
  if (name === "scheduleOk") { scheduleOk(el.dataset.snap); return; }
  if (name === "lichbieu") { closeThongke(); hooks.openLichbieu(); return; }
  if (name === "close") { closeThongke(); return; }
  if (name === "newSubject") { closeThongke(); hooks.openSubject(null, "newSubject"); return; }
  if (name === "addChapter") { var sid = TK.nb; closeThongke(); hooks.openSubject(sid, "chapter"); return; }
  if (name === "uploadPdf") { var sid2 = TK.nb; closeThongke(); hooks.openSubject(sid2, "pdf"); return; }
  if (name === "resume") {
    var d = TK.cache.today, rs = d && d.resume; if (!rs) return;
    closeThongke();
    if (rs.kind === "chapter") hooks.openSource({ subject_id: rs.subject_id, chapter_id: rs.id });
    else if (rs.kind === "pdf") hooks.openSource({ subject_id: rs.subject_id, document_id: rs.id });
    else hooks.openTool(rs.kind === "exam" ? "thithu" : "ontap");
  }
}

/* ================= CHẾ ĐỘ MẪU (chưa đăng nhập) — dữ liệu giả của mẫu, cùng khuôn với API ================= */
var SAMPLE = null;
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function sample() {
  if (SAMPLE) return SAMPLE;
  var T = today(), START = addD(T, -89);
  var SUBJ = [
    { id: "s-mmt", name: "Mạng máy tính", q: 7.6, r: 0.86, w: 1.3, from: 0, quiz: ["Ôn tập Chương 1–2", "Ôn tập Chương 3 – Mô hình OSI", "Thi thử giữa kỳ (Chương 1–4)"], fc: [["Flashcard – Mô hình OSI", 48], ["Flashcard – TCP/IP", 36]], chapters: [["Chương 1 – Tổng quan", 2900, "reviewed"], ["Chương 2 – Mạng LAN", 6100, "reviewed"], ["Chương 3 – Mô hình OSI", 7400, "learning"], ["Chương 4 – TCP/IP", 5200, "new"], ["Chương 5 – Địa chỉ IP", 320, "new"]], pdfs: [["Chương 3 – Mô hình OSI.pdf", 24, "reviewed"]] },
    { id: "s-csdl", name: "Cơ sở dữ liệu", q: 7.2, r: 0.79, w: 1.1, from: 0, quiz: ["Ôn tập Chương 1 – Mô hình quan hệ", "Ôn tập Chương 2 – SQL"], fc: [["Flashcard – Câu lệnh SQL", 40]], chapters: [["Chương 1 – Mô hình quan hệ", 4100, "reviewed"], ["Chương 2 – SQL", 8200, "learning"], ["Chương 3 – Chuẩn hoá", 3600, "new"]], pdfs: [] },
    { id: "s-trr", name: "Toán rời rạc", q: 5.8, r: 0.68, w: 0.9, from: 3, quiz: ["Ôn tập Chương 1 – Logic", "Ôn tập Chương 3 – Đồ thị"], fc: [["Công thức tổ hợp", 22]], chapters: [["Chương 1 – Logic", 3800, "reviewed"], ["Chương 2 – Tập hợp", 2900, "new"], ["Chương 3 – Đồ thị", 4300, "learning"]], pdfs: [["Bài tập đồ thị.pdf", 12, "new"]] },
    { id: "s-ta", name: "Tiếng Anh", q: 6.9, r: 0.85, w: 0.7, from: 5, quiz: ["Unit 1–2 Review"], fc: [["Từ vựng Unit 1", 60], ["Từ vựng Unit 2", 54]], chapters: [["Unit 1 – Daily life", 2200, "reviewed"], ["Unit 2 – Education", 2400, "learning"]], pdfs: [] },
  ];
  var days = [];
  for (var i = 0; i <= 89; i++) {
    var date = addD(START, i), r = rng(i * 7919 + 13), wd = date.getDay();
    var day = { date: iso(date), min: {}, quiz: [], rev: [], made: {} };
    TYPES.forEach(function (t) { day.made[t[0]] = 0; });
    if (i === 0) { day.made.chapter = 6; day.made.pdf = 1; }
    var pAct = i < 10 ? [0, 1, 0, 1, 0, 0, 1, 0, 1, 0][i] : wd === 0 ? 0.35 : wd === 6 ? 0.6 : 0.88;
    if (i === 89 ? r() < 0.9 : r() < pAct) {
      var pool = SUBJ.filter(function (s) { return i >= s.from; }), k = Math.min(pool.length, 2 + Math.floor(r() * 2));
      pool.slice().sort(function (a, b) { return r() * b.w - r() * a.w; }).slice(0, k).forEach(function (s) {
        day.min[s.id] = Math.round(20 + r() * 55 * s.w);
        var trend = Math.min(1.1, i * 0.012);
        if (r() < 0.55) { var sc = Math.max(3.5, Math.min(10, s.q + trend + (r() - 0.5) * 1.8)); day.quiz.push({ sid: s.id, set: Math.floor(r() * s.quiz.length), score: Math.round(sc * 10) / 10, correct: Math.min(1, sc / 10) }); }
        if (r() < 0.75) { var n = Math.round(8 + r() * 30), rate = Math.max(0.4, Math.min(0.98, s.r + trend * 0.03 + (r() - 0.5) * 0.1)); day.rev.push({ sid: s.id, set: Math.floor(r() * s.fc.length), n: n, ok: Math.round(n * rate) }); }
      });
      if (r() < 0.4) day.made.chapter++; if (r() < 0.15) day.made.pdf++; if (r() < 0.3) day.made.practice++; if (r() < 0.08) day.made.exam++;
      if (r() < 0.25) day.made.flashcard++; if (r() < 0.1) day.made.mindmap++; if (r() < 0.1) day.made.summary++;
    }
    days.push(day);
  }
  SAMPLE = { T: T, START: START, SUBJ: SUBJ, days: days, snaps: [] };
  TK.subjectOrder = SUBJ.map(function (s) { return s.id; });
  for (var w = 6; w >= 1; w--) {
    var b = addD(T, -((T.getDay() + 6) % 7) - 1 - 7 * (w - 1)), a = addD(b, -6);
    if (a < START) continue;
    var m = sampleOverview(a, b, null).cur, el = Object.keys(m.by_subject).map(function (k) { return m.by_subject[k]; }).filter(function (x) { return x.eligible; });
    if (!m.enough) continue;
    SAMPLE.snaps.push({ id: "snap-" + w, kind: "weekly", from: iso(a), to: iso(b), len: 7, created_at: iso(addD(b, 1)) + "T00:05:00", q_avg: m.q_avg, recall: m.recall, minutes: m.minutes, cap: el.length ? el.reduce(function (p, c) { return p + c.cap; }, 0) / el.length : null, has_ai: false, ai_saved: false });
  }
  return SAMPLE;
}
function sampleDay(k) { var S = sample(), i = diff(S.START, P(k)); return i >= 0 && i < S.days.length ? S.days[i] : null; }
function activeSample(x, sid) { return !!x && (sid ? !!x.min[sid] || x.quiz.some(function (q) { return q.sid === sid; }) || x.rev.some(function (q) { return q.sid === sid; }) : Object.keys(x.min).length > 0); }
function sampleOverview(a, b, sid) {
  var S = sample();
  var calc = function (a, b) {
    var days = [], bySub = {}, mins = 0, atts = [], rev = 0, ok = 0, made = {};
    TYPES.forEach(function (t) { made[t[0]] = 0; });
    S.SUBJ.forEach(function (s) { if (!sid || s.id === sid) bySub[s.id] = { id: s.id, name: s.name, minutes: 0, attempts: 0, q: [], rev: 0, ok: 0, sets: {}, fsets: {} }; });
    for (var d = D0(a); d <= b; d = addD(d, 1)) {
      var x = sampleDay(iso(d)), row = { date: iso(d), minutes: 0, active: false, made: {}, scores: [] };
      TYPES.forEach(function (t) { row.made[t[0]] = 0; });
      if (x) {
        Object.keys(x.min).forEach(function (k) { if (bySub[k]) { row.minutes += x.min[k]; bySub[k].minutes += x.min[k]; } });
        x.quiz.forEach(function (q) { var B = bySub[q.sid]; if (!B) return; var title = S.SUBJ.find(function (s) { return s.id === q.sid; }).quiz[q.set]; row.scores.push(q.score); atts.push(q); B.q.push(q.score); (B.sets[title] = B.sets[title] || { id: title, title: title, mode: title.indexOf("Thi thử") === 0 ? "exam" : "practice", scores: [] }).scores.push(q.score); });
        x.rev.forEach(function (q) { var B = bySub[q.sid]; if (!B) return; var f = S.SUBJ.find(function (s) { return s.id === q.sid; }).fc[q.set]; rev += q.n; ok += q.ok; B.rev += q.n; B.ok += q.ok; var F = B.fsets[f[0]] = B.fsets[f[0]] || { id: f[0], title: f[0], cards: f[1], n: 0, ok: 0 }; F.n += q.n; F.ok += q.ok; });
        if (!sid) TYPES.forEach(function (t) { row.made[t[0]] = x.made[t[0]]; made[t[0]] += x.made[t[0]]; });
        row.active = activeSample(x, sid);
      }
      mins += row.minutes; days.push(row);
    }
    Object.keys(bySub).forEach(function (k) {
      var B = bySub[k]; B.attempts = B.q.length; B.q_avg = B.q.length ? B.q.reduce(function (p, c) { return p + c; }, 0) / B.q.length : null; B.recall = B.rev ? B.ok / B.rev : null;
      B.eligible = B.attempts >= 3 || B.rev >= 20;
      B.cap = !B.eligible ? null : B.q_avg != null && B.recall != null ? 0.6 * B.q_avg + 0.4 * B.recall * 10 : B.q_avg != null ? B.q_avg : B.recall * 10;
      B.sets = Object.keys(B.sets).map(function (t) { return B.sets[t]; }); B.fsets = Object.keys(B.fsets).map(function (t) { return B.fsets[t]; }); delete B.q;
    });
    var hist = 0, st = 0, best = 0, run = 0;
    for (var x2 = S.START; x2 <= b; x2 = addD(x2, 1)) { var dx = sampleDay(iso(x2)); if (activeSample(dx, null)) hist++; if (activeSample(dx, sid)) { run++; best = Math.max(best, run); } else run = 0; }
    var e = D0(b); if (!activeSample(sampleDay(iso(e)), sid) && +e === +today()) e = addD(e, -1);
    while (e >= S.START && activeSample(sampleDay(iso(e)), sid)) { st++; e = addD(e, -1); }
    var madeTot = TYPES.reduce(function (p, t) { return p + made[t[0]]; }, 0);
    var cards = S.SUBJ.filter(function (s) { return !sid || s.id === sid; }).reduce(function (p, s) { return p + s.fc.reduce(function (q, c) { return q + c[1]; }, 0); }, 0);
    return {
      from: iso(a), to: iso(b), len: diff(a, b) + 1, days: days, minutes: mins, active_days: days.filter(function (d) { return d.active; }).length,
      made: made, made_total: madeTot, attempts: atts.length, practice_count: atts.length, exam_count: 0,
      q_avg: atts.length ? atts.reduce(function (p, c) { return p + c.score; }, 0) / atts.length : null,
      correct: atts.length ? atts.reduce(function (p, c) { return p + c.correct; }, 0) / atts.length : null,
      rev: rev, ok: ok, recall: rev ? ok / rev : null, by_subject: bySub, streak: st, best_streak: best, hist: hist, enough: hist >= 7,
      empty: mins === 0 && !atts.length && !rev && !madeTot,
      cards: { total: cards, mastered: Math.round(cards * 0.38), learning: Math.round(cards * 0.27), new: cards - Math.round(cards * 0.38) - Math.round(cards * 0.27) },
    };
  };
  var cur = calc(a, b), pr = prevOf(a, b), prev = cur.enough && pr[0] >= S.START ? calc(pr[0], pr[1]) : null;
  return { cur: cur, prev: prev && !prev.empty ? prev : null, ai: null, ai_remaining: TK.aiRemaining == null ? 5 : TK.aiRemaining, ai_limit: 5 };
}
function sampleHeatmap(end, sid) {
  var last = addD(end, 6 - ((end.getDay() + 6) % 7)), first = addD(last, -83), out = [];
  for (var d = first; d <= last; d = addD(d, 1)) {
    var x = sampleDay(iso(d)), m = x ? Object.keys(x.min).filter(function (k) { return !sid || k === sid; }).reduce(function (p, k) { return p + x.min[k]; }, 0) : 0;
    out.push({ date: iso(d), minutes: m, active: activeSample(x, sid) });
  }
  return out;
}
function sampleSubjects() {
  var S = sample();
  return S.SUBJ.map(function (s) {
    var items = s.chapters.length + s.pdfs.length, done = s.chapters.concat(s.pdfs).filter(function (c) { return c[2] === "reviewed"; }).length, last = null;
    for (var i = S.days.length - 1; i >= 0; i--) if (S.days[i].min[s.id]) { last = S.days[i].date; break; }
    return { id: s.id, name: s.name, chapters: s.chapters.length, pdfs: s.pdfs.length, practice_sets: s.quiz.filter(function (q) { return q.indexOf("Thi thử") < 0; }).length, exams: s.quiz.filter(function (q) { return q.indexOf("Thi thử") === 0; }).length, flashcard_sets: s.fc.length, reviewed_percent: Math.round(done / items * 100), last_at: last };
  });
}
function sampleSubject(id) {
  var S = sample(), s = S.SUBJ.find(function (x) { return x.id === id; });
  if (!s) return { error: "Không tìm thấy môn học (chế độ mẫu)." };
  var li = sampleSubjects().find(function (x) { return x.id === id; });
  var items = s.chapters.map(function (c, i) { return { kind: "chapter", id: id + "-c" + i, name: c[0], words: c[1], pages: null, status: c[2], short: c[1] < 500 }; })
    .concat(s.pdfs.map(function (c, i) { return { kind: "pdf", id: id + "-p" + i, name: c[0], words: null, pages: c[1], status: c[2], short: false }; }));
  var t = today(), m = sampleOverview(addD(t, -6), t, id).cur, B = m.by_subject[id];
  return { id: id, name: s.name, items: items, reviewed_percent: li.reviewed_percent, last_at: li.last_at,
    tools: { practice: li.practice_sets, exam: li.exams, flashcard: s.fc.length, cards: s.fc.reduce(function (p, c) { return p + c[1]; }, 0), mindmap: 1, summary: 2 },
    week: { cap: B.cap, recall: B.recall, minutes: B.minutes } };
}
function sampleToday() {
  var S = sample(), t = today(), mon = addD(t, -((t.getDay() + 6) % 7));
  var wk = sampleOverview(mon, t, null).cur, pw = sampleOverview(addD(mon, -7), addD(t, -7), null).cur;
  var ex = addD(t, ((5 - t.getDay() + 7) % 7) + 7), dl = addD(t, ((5 - t.getDay() + 7) % 7) || 7);
  return {
    week: { minutes: wk.minutes, prev_minutes: pw.minutes, prev_has_data: !pw.empty }, streak: wk.streak, best_streak: wk.best_streak,
    studied_today: activeSample(sampleDay(iso(t)), null), due: { total: 36, sets: [{ id: "x", title: "Flashcard – Mô hình OSI", count: 20 }, { id: "y", title: "Từ vựng Unit 2", count: 16 }] },
    resume: { kind: "chapter", id: "s-mmt-c2", title: "Chương 3 – Mô hình OSI", subject_id: "s-mmt", subject_name: "Mạng máy tính", detail: "Đọc lần cuối", at: iso(t) + "T08:30:00" },
    today_items: [{ title: "Toán rời rạc", type: "class", date: iso(t), start_minute: 900, end_minute: 1020, color: "#AD6E0D" }, { title: "Ôn flashcard CSDL", type: "event", date: iso(t), start_minute: 1170, end_minute: 1200, color: "#0D7380" }],
    upcoming: [{ title: "Hạn nộp đồ án MMT", type: "deadline", date: iso(dl), start_minute: 1020, end_minute: 1020, color: "#2c4a8c" }, { title: "Thi giữa kỳ – CSDL", type: "exam", date: iso(ex), start_minute: 540, end_minute: 660, color: "#0D7380" }],
    next_exam: { title: "Thi giữa kỳ – CSDL", type: "exam", date: iso(ex), start_minute: 540, end_minute: 660 }, last_exam_score: 7.8,
    recent_subjects: sampleSubjects().slice(0, 2), name: "Chế độ mẫu",
  };
}
function sampleSnapshots() { sample(); return SAMPLE.snaps.slice().sort(function (a, b) { return a.to < b.to ? 1 : -1; }); }
function sampleAI(a, b) {
  var m = sampleOverview(a, b, null).cur;
  var rows = Object.keys(m.by_subject).map(function (k) { return m.by_subject[k]; }).filter(function (x) { return x.eligible; }).sort(function (x, y) { return y.cap - x.cap; });
  var id = "ai-" + iso(a) + "-" + iso(b) + "-" + Date.now();
  if (!rows.length || (m.attempts < 3 && m.rev < 30)) return { id: id, kind: "ai", from: iso(a), to: iso(b), len: m.len, created_at: iso(today()) + "T12:00:00", ai_result: { few: true, attempts: m.attempts, rev: m.rev }, ai_saved: false };
  var best = rows[0], worst = rows[rows.length - 1];
  return { id: id, kind: "ai", from: iso(a), to: iso(b), len: m.len, created_at: new Date().toISOString().slice(0, 19), ai_at: new Date().toISOString().slice(0, 19), q_avg: m.q_avg, recall: m.recall, minutes: m.minutes, cap: best.cap, has_ai: true, ai_saved: false,
    ai_result: {
      good: [best.name + " dẫn đầu với điểm năng lực " + n1(best.cap) + (best.recall != null ? ", tỷ lệ nhớ thẻ " + pct(best.recall) : "") + ".", "Học " + m.active_days + "/" + m.len + " ngày trong kỳ.", "Duy trì chuỗi " + m.streak + " ngày học liên tiếp."],
      bad: [worst.name + " thấp nhất (" + n1(worst.cap) + ")" + (worst.recall != null ? ", tỷ lệ nhớ thẻ chỉ " + pct(worst.recall) : "") + ".", Math.round(m.cards.new / Math.max(1, m.cards.total) * 100) + "% thẻ Flashcard chưa ôn lần nào.", "Thời gian học các môn chưa đều."],
      act: [{ subject_id: worst.id, subject_name: worst.name, sessions: 4, minutes: 20, text: "Ôn Flashcard môn " + worst.name + " 4 buổi/tuần, mỗi buổi 20 phút." },
        { subject_id: worst.id, subject_name: worst.name, sessions: 1, minutes: 30, text: "Làm lại 1 bộ ôn tập môn " + worst.name + " trong tuần tới." },
        { subject_id: best.id, subject_name: best.name, sessions: 2, minutes: 30, text: "Giữ nhịp " + best.name + " với 2 buổi 30 phút." }],
    } };
}
