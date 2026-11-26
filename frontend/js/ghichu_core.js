/* ======================================================================
   ghichu_core.js — nền dùng CHUNG cho 3 module (soạn thảo / giao diện / chức
   năng các thẻ) + file điều phối ghichu.js: state chia sẻ, lưu trữ cục bộ,
   tiện ích DOM, tra cứu cây Môn học/Chương/PDF, các hằng số cấu hình dùng ở
   nhiều nơi, và các khối UI nổi dùng chung (dropdown/nhóm nút ribbon).

   Module này KHÔNG import bất kỳ module nào khác (core → không phụ thuộc
   ngược) — mọi module còn lại đều import TỪ đây. Việc gọi ngược lên
   ghichu.js (vd. render lại ribbon sau khi 1 module con đổi dữ liệu) đi qua
   `hooks` bên dưới thay vì import thẳng ghichu.js, để tránh vòng lặp import
   (ghichu.js lại là nơi import cả 3 module con).
   ====================================================================== */

/* ---------------- hooks: cầu nối 1 chiều "lên" ghichu.js ----------------
   ghichu.js gán đè 3 hàm này bằng đúng triển khai thật của nó (renderAll/
   renderRibbon/closeFloating) NGAY SAU KHI import xong mọi module — vì đây
   là 1 object dùng chung (không phải biến export bị gán lại), việc ghichu.js
   sửa thuộc tính của object này vẫn thấy được từ mọi module đã import nó
   trước đó, không cần cơ chế setter riêng. Giá trị mặc định là hàm rỗng chỉ
   để không vỡ nếu lỡ gọi trước khi ghichu.js kịp gán (không nên xảy ra trong
   luồng chạy bình thường). */
export var hooks = {
  renderAll: function () {},
  renderRibbon: function () {},
  setTab: function () {},          // chuyển thẻ ribbon theo khoá nội bộ "File"|"Home"|"Insert"… (ghichu.js setTab)
  renderStatusPill: function () {},
  closeFloating: function () {},
  renderChatDock: function () {},
  syncLayout: function () {},      // bật/tắt Notebook/chat/ôn tập + cột 1/cột 3/Topbar (ghichu.js syncMainPane)
  openSource: function () {},      // rời màn Studio AI, mở Chương/PDF nguồn {chapter_id|document_id, page} (ghichu.js openSource)
  askAbout: function () {},        // rời màn Studio AI, mở Hỏi đáp tri thức với câu hỏi điền sẵn (ghichu.js askAbout)
  openProfile: function () {},     // mở modal Hồ sơ (ghichu_giaodien.js) — Lịch biểu cần để người dùng nhập email nhận nhắc
  onProfileSaved: function () {},  // Hồ sơ vừa lưu xong (đối số = profile mới) — Lịch biểu cập nhật email nhận nhắc
  openLichbieu: function () {},    // mở màn Lịch biểu (đóng công cụ Studio khác) — hộp báo nhắc lịch góc phải bấm "Xem"
  openTool: function () {},        // mở 1 công cụ Studio theo tên ontap|thithu|flashcard|mindmap|tomtat (Thống kê: "Công cụ học tập")
  openSubject: function () {},     // về Notebook ở 1 Môn: (subjectId, "chapter"|"pdf") hoặc (null, "newSubject") (Thống kê: trang Notebook)
  currentUser: function () { return null; }, // {name, avatar} tài khoản đang đăng nhập (ghichu_giaodien.js) — thanh trên Thống kê
  // Chia sẻ (ghichu_chiase.js): mở hộp Chia sẻ {type:'subject'|'chapter', id}; menu "⋯" của mục được chia sẻ;
  // Chương vừa lưu xong (data = ChapterDetailOut) / bị 409 vì người khác vừa sửa / mất quyền truy cập (403, 404)
  openShare: function () {},
  showNotebook: function () {},    // đóng mọi công cụ Studio / chat, về Notebook (ghichu.js closeToolsExcept)
  openSharedMenu: function () {},
  onChapterSaved: function () {},
  onSaveConflict: function () {},
  onAccessLost: function () {},
  // UC-33 hạn mức (ghichu_hanmuc.js, gán ở ghichu.js): kiểm trước khi tải tệp — (file, {subjectId, kind}, proceed) -> true
  // nếu được tải ngay; máy chủ từ chối 413/409 kèm code -> handleUploadError(res, file, ctx, proceed) trả true nếu đã
  // hiện hộp xử lý; tải xong -> afterUpload(tên tệp) cập nhật thanh Dung lượng.
  precheckUpload: function () { return true; },
  handleUploadError: function () { return false; },
  afterUpload: function () {},
  aiLimitText: function () { return null; },
  reportContent: function () {},   // UC-35 "Báo nội dung sai" (ghichu_gopy.js) — {title, context[], quote_heading, quote_text, ref_type, ref_id}
  renderChapterLock: function () {},   // Review > Password (ghichu_review.js): vẽ / ẩn màn "Chương đã khoá"
  openFeedback: function () {},    // UC-35 Góp ý (Help ▸ Feedback)   // 429 code 'ai_limit' -> câu thông báo đầy đủ, null nếu không phải lỗi hết lượt
};

/* ---------------- lưu trữ ----------------
   Khi đã đăng nhập (isOnline() = true), state.subjects/docs/pdfs được NẠP TỪ
   BACKEND qua bootKnowledgeTree() (ghichu_soanthao.js) — localStorage chỉ còn
   vai trò cache/nháp offline (autosave giữ bản chưa kịp đồng bộ nếu mất
   mạng, UC-16 E1). Khi CHƯA đăng nhập, trang vẫn hoạt động ở "chế độ mẫu"
   hoàn toàn cục bộ như trước (không ép điều hướng sang đăng nhập). */
export var STORAGE_KEY = "td_notebook_v3";
export var Store = {
  load: function () {
    var empty = { subjects: [], docs: {}, pdfs: {}, open: {}, active: null, drawings: {} };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      var parsed = JSON.parse(raw);
      var subjects = Array.isArray(parsed.subjects) ? parsed.subjects : [];
      var active = parsed.active && typeof parsed.active === "object" ? parsed.active : null;
      if (active && !active.shared) {   // mục được chia sẻ: kiểm lại sau khi tải "Được chia sẻ với tôi" (ghichu_chiase.js)
        var sub = subjects.filter(function (s) { return s.id === active.s; })[0];
        var list = sub ? (active.kind === "pdf" ? sub.pdfs : sub.chapters) : null;
        var stillThere = list && list.some(function (x) { return x.id === active.id; });
        if (!stillThere) active = null;
      }
      return {
        subjects: subjects,
        docs: parsed.docs && typeof parsed.docs === "object" ? parsed.docs : {},
        pdfs: parsed.pdfs && typeof parsed.pdfs === "object" ? parsed.pdfs : {},
        open: parsed.open && typeof parsed.open === "object" ? parsed.open : {},
        active: active,
        drawings: parsed.drawings && typeof parsed.drawings === "object" ? parsed.drawings : {},
      };
    } catch (e) { return empty; }
  },
  save: function (subjects, docs, pdfs, open, active, drawings) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ subjects: subjects, docs: docs, pdfs: pdfs, open: open, active: active, drawings: drawings || {} })); return true; }
    catch (e) { console.warn("Không lưu được vào localStorage", e); return false; }
  },
};

var boot = Store.load();

/* ---------------- state (chia sẻ giữa mọi module) ---------------- */
export var state = {
  subjects: boot.subjects,      // [{id, name, chapters:[{id,name}], pdfs:[{id,name}]}] — id thật từ backend khi online
  docs: boot.docs,              // chapterId -> HTML nội dung
  drawings: boot.drawings,      // chapterId -> lớp vẽ thẻ Draw {v, bg, items} (ghichu_ve.js; khi online = chapters.drawing_json)
  pdfs: boot.pdfs,               // pdfId -> {name, annotations:[...]}
  open: boot.open,              // subjectId -> bool (đang mở rộng)
  active: boot.active,          // {s: subjectId, kind:'chapter'|'pdf', id} | null — mục đang mở gần nhất
  loadedChapters: {},            // chapterId -> true, chỉ GET /chapters/{id} một lần/phiên
  tab: "Home",
  query: "",
  findOpen: false,
  studioOpen: false,
  treeDrawer: false,            // responsive: ngăn kéo cây Notebook đang mở (chỉ có tác dụng khi cửa sổ hẹp)
  font: "figtree",
  size: 16,
  sizeDraft: "16",
  fmt: {},
  dd: null,                     // {id, x, y}
  menu: null,                   // {kind, s, id, title, x, y}
  rename: null,                 // {kind:'subject', id} | {kind:'chapter'|'pdf', s, id}
  renameDraft: "",
  typingSubject: false,
  subjectDraft: "",
  typingChapterIn: null,        // subjectId đang gõ tên chương mới
  chapterDraft: "",
  drag: null,       // {kind:'subject', id} | {kind:'chapter'|'pdf', s, id, name}
  saveStatus: "idle",           // idle | editing | saving | saved
  savedAt: null,
  spellcheckOn: false,
  noteLocked: false,
  accountMenuOpen: false,
  // Chia sẻ (ghichu_chiase.js): "Được chia sẻ với tôi" — cùng khuôn state.subjects + {shared:true, owner, whole, role,
  // shareId}, mỗi Chương / PDF có `role`. KHÔNG trộn vào state.subjects để mọi công cụ AI Studio (đọc state.subjects)
  // không thấy nội dung được chia sẻ (người dùng chốt; máy chủ cũng chặn).
  shared: [],
  versions: {},                 // chapterId -> content_version đang sửa (khoá lạc quan khi nhiều người cùng sửa)
  chapterMeta: {},              // chapterId -> {role, updatedBy, updatedAgo} từ GET /chapters/{id}
  // Review > Password (ghichu_review.js): khoá mở do máy chủ cấp sau khi nhập đúng mật khẩu — CHỈ trong bộ nhớ trang
  // (F5 / Lock All = phải nhập lại). auth-client.js tự gắn header X-Chapter-Key cho /chapters/{id}…
  chapterKeys: {},              // chapterId -> khoá mở (online)
  sampleUnlocked: {},           // chapterId -> true (chế độ mẫu: mật khẩu kiểm cục bộ)
  chapterLockInfo: {},          // chapterId -> {hint} khi máy chủ báo Chương đang khoá
};
window.tdChapterKeys = state.chapterKeys;

/* ---------------- tiện ích DOM nhỏ ---------------- */
export function $(id) { return document.getElementById(id); }
export function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------------- khoá tài liệu + tra cứu cây Môn/Chương/PDF ---------------- */
export function docKey(active) { return (active && active.kind === "chapter") ? active.id : null; }
export function docFor(active) { var k = docKey(active); return k ? (state.docs[k] || "") : ""; }
export function findSubject(id) {
  return state.subjects.find(function (s) { return s.id === id; }) || state.shared.find(function (s) { return s.id === id; }) || null;
}
// Môn trong "Được chia sẻ với tôi" (không phải của mình)
export function sharedSubject(id) { return state.shared.find(function (s) { return s.id === id; }) || null; }
/* Quyền với mục đang mở (hoặc `active` truyền vào): 'owner' | 'editor' | 'viewer'. Mục của mình luôn 'owner';
   Chương mình được chia sẻ lấy quyền mới nhất máy chủ trả (chapterMeta) nếu có. */
export function itemRole(active) {
  active = active || state.active;
  if (!active) return "owner";
  var sub = sharedSubject(active.s);
  if (!sub) return "owner";
  var meta = active.kind === "chapter" && state.chapterMeta[active.id];
  if (meta && meta.role) return meta.role;
  var item = active.kind === "pdf" ? pdfInSub(sub, active.id) : chapterInSub(sub, active.id);
  return (item && item.role) || sub.role || "viewer";
}
export function isViewOnly(active) { return itemRole(active) === "viewer"; }
export function chapterInSub(sub, chapterId) { return sub ? (sub.chapters.find(function (c) { return c.id === chapterId; }) || null) : null; }
export function pdfInSub(sub, pdfId) { return sub ? (sub.pdfs.find(function (p) { return p.id === pdfId; }) || null) : null; }
export function findChapter(subjectId, chapterId) { return chapterInSub(findSubject(subjectId), chapterId); }
export function findPdfItem(subjectId, pdfId) { return pdfInSub(findSubject(subjectId), pdfId); }
// Tên hiển thị của mục đang mở (Chương hoặc File PDF) — dùng ở breadcrumb/tiêu đề in/Studio.
export function activeItemName() {
  if (!state.active) return "";
  var sub = findSubject(state.active.s);
  var item = state.active.kind === "pdf" ? pdfInSub(sub, state.active.id) : chapterInSub(sub, state.active.id);
  return item ? item.name : "";
}
export function hasActiveChapter() { return !!(state.active && state.active.kind === "chapter"); }

/* true = đã đăng nhập -> Môn học/Chương/PDF là dữ liệu THẬT nối backend.
   false = chưa đăng nhập -> "chế độ mẫu" hoàn toàn cục bộ (localStorage). */
export function authToken() { try { return localStorage.getItem("access_token"); } catch (e) { return null; } }
export function authRefreshToken() { try { return localStorage.getItem("refresh_token"); } catch (e) { return null; } }
export function isOnline() { return !!authToken(); }

// Id tạm cho Môn học/Chương/annotation được tạo khi CHƯA đăng nhập (chế độ mẫu) — luôn có
// tiền tố "local-" để không bao giờ trùng/nhầm với UUID thật do backend cấp.
export function genLocalId() {
  return "local-" + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
}

export function persist() {
  // Đã đăng nhập: nội dung / nét vẽ của Chương có mật khẩu KHÔNG được lưu bản nháp vào localStorage (chỉ máy chủ giữ).
  var docs = state.docs, drawings = state.drawings;
  if (isOnline()) {
    var hide = {};
    state.subjects.concat(state.shared).forEach(function (s) { (s.chapters || []).forEach(function (c) { if (c.protected) hide[c.id] = 1; }); });
    if (Object.keys(hide).length) {
      docs = {}; drawings = {};
      Object.keys(state.docs).forEach(function (k) { if (!hide[k]) docs[k] = state.docs[k]; });
      Object.keys(state.drawings || {}).forEach(function (k) { if (!hide[k]) drawings[k] = state.drawings[k]; });
    }
  }
  Store.save(state.subjects, docs, state.pdfs, state.open, state.active, drawings);
}
/* Review > Password: Chương có mật khẩu (online: cờ protected từ máy chủ; chế độ mẫu: c.pw = {salt, hash, hint}). */
export function chapterProtected(subjectId, chapterId) {
  var c = findChapter(subjectId, chapterId);
  return !!(c && (c.protected || c.pw));
}
// Đang khoá = có mật khẩu mà chưa mở trong phiên này.
export function chapterLocked(active) {
  active = active || state.active;
  if (!active || active.kind !== "chapter" || !chapterProtected(active.s, active.id)) return false;
  return isOnline() ? !state.chapterKeys[active.id] : !state.sampleUnlocked[active.id];
}

/* ---------------- hằng số cấu hình dùng chung ---------------- */
export var COLORS = ["#0d6efd", "#12b886", "#f59f00", "#7048e8", "#e8590c", "#0ca678"];
// 21 font phổ biến, miễn phí — ưu tiên font hỗ trợ tiếng Việt tốt, dùng ở tab Home
// (ghichu_chucnangcacthe.js) VÀ khi đọc lại định dạng tại con trỏ (ghichu_soanthao.js) nên đặt
// ở core để 2 module đó không phải phụ thuộc lẫn nhau chỉ vì 1 bảng hằng số.
export var FONTS = [
  { value: "figtree", label: "Figtree", stack: "Figtree, sans-serif" },
  { value: "lora", label: "Lora", stack: "Lora, serif" },
  { value: "arial", label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { value: "calibri", label: "Calibri", stack: "Calibri, Candara, Segoe, 'Segoe UI', sans-serif" },
  { value: "times", label: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  { value: "georgia", label: "Georgia", stack: "Georgia, serif" },
  { value: "verdana", label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  { value: "tahoma", label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  { value: "trebuchet", label: "Trebuchet MS", stack: "'Trebuchet MS', sans-serif" },
  { value: "inter", label: "Inter", stack: "Inter, sans-serif" },
  { value: "roboto", label: "Roboto", stack: "Roboto, sans-serif" },
  { value: "opensans", label: "Open Sans", stack: "'Open Sans', sans-serif" },
  { value: "lato", label: "Lato", stack: "Lato, sans-serif" },
  { value: "montserrat", label: "Montserrat", stack: "Montserrat, sans-serif" },
  { value: "poppins", label: "Poppins", stack: "Poppins, sans-serif" },
  { value: "nunito", label: "Nunito", stack: "Nunito, sans-serif" },
  { value: "notosans", label: "Noto Sans", stack: "'Noto Sans', sans-serif" },
  { value: "notoserif", label: "Noto Serif", stack: "'Noto Serif', serif" },
  { value: "merriweather", label: "Merriweather", stack: "Merriweather, serif" },
  { value: "sourcesans", label: "Source Sans 3", stack: "'Source Sans 3', sans-serif" },
  { value: "ubuntu", label: "Ubuntu", stack: "Ubuntu, sans-serif" },
];
export var SIZE_LIST = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40];
export var SIZE_MENU = SIZE_LIST.filter(function (n) { return n <= 30; });
// Kho ký hiệu bullet — type dùng nguyên văn làm giá trị CSS list-style-type.
export var BULLET_LIB = [
  { glyph: "∅", label: "None", type: "none" },
  { glyph: "-", label: "Dash", type: '"- "' },
  { glyph: "▢", label: "Hollow Square Bullet", type: '"▢ "' },
  { glyph: "~", label: "Tilde", type: '"~ "' },
  { glyph: "⚓", label: "Anchor", type: '"⚓ "' },
  { glyph: "●", label: "Filled Round Bullet", type: "disc" },
  { glyph: "○", label: "Hollow Round Bullet", type: "circle" },
  { glyph: "▪", label: "Filled Square Bullet", type: "square" },
  { glyph: "✤", label: "Four-Petal Bullet", type: '"✤ "' },
  { glyph: "✦", label: "Star Bullet", type: '"✦ "' },
  { glyph: "➤", label: "Arrow Bullet", type: '"➤ "' },
  { glyph: "✓", label: "Check Mark Bullet", type: '"✓ "' },
];
// Giới hạn ảnh chèn trực tiếp (base64) — dùng ở cả CKEditor upload adapter (ghichu_soanthao.js)
// lẫn nút "Hình ảnh" tab Insert (ghichu_chucnangcacthe.js).
export var MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/* ---------------- khối nút ribbon dùng chung (Home/Insert/Draw/File...) ---------------- */
export function buildGroup(buttons) {
  var g = el("div", "ribbon-group");
  buttons.forEach(function (b) { g.appendChild(b); });
  return g;
}
export function btnText(glyph, label, onClick, disabled) {
  var b = el("button", "ribbon-btn", '<span class="glyph">' + glyph + "</span><span>" + esc(label) + "</span>");
  b.type = "button";
  b.disabled = !!disabled;
  b.title = label;
  b.addEventListener("click", onClick);
  return b;
}
export function btnToggle(glyph, label, active, onClick, disabled) {
  var b = el("button", "ribbon-btn" + (active ? " on" : ""), '<span class="glyph">' + glyph + "</span><span>" + esc(label) + "</span>");
  b.type = "button"; b.disabled = !!disabled; b.title = label;
  b.addEventListener("click", onClick);
  return b;
}
/* Nút ribbon có thêm mũi tên dropdown cạnh bên — cùng cơ chế dd-panel dùng chung
   (openDropdown/closeDropdownEl bên dưới). */
export function btnTextDropdown(glyph, label, onClick, disabled, ddId, ddWidth, htmlFn, bindFn) {
  var wrap = el("div", "ribbon-btn-wrap");
  var b = btnText(glyph, label, onClick, disabled);
  wrap.appendChild(b);
  var caret = el("button", "ribbon-btn-caret", "▾");
  caret.type = "button"; caret.title = "Tùy chọn"; caret.disabled = !!disabled;
  caret.addEventListener("click", function (e) {
    e.stopPropagation();
    var r = b.getBoundingClientRect();
    var x = Math.max(8, Math.min(r.left, window.innerWidth - (ddWidth || 220) - 10));
    openDropdown(ddId, x, r.bottom + 6, htmlFn(), bindFn);
  });
  wrap.appendChild(caret);
  return wrap;
}

/* ---------------- panel nổi dùng chung (dropdown ribbon + PDF color picker...) ---------------- */
export function openDropdown(id, x, y, html, bind) {
  state.dd = { id: id };
  var panel = $("dd-panel");
  panel.hidden = false;
  panel.style.left = Math.max(8, x) + "px";
  panel.style.top = y + "px";
  panel.innerHTML = html;
  if (bind) bind(panel);
}
export function closeDropdownEl() { $("dd-panel").hidden = true; $("dd-panel").innerHTML = ""; }

/* ---------- Số dòng / ô mỗi trang do người dùng tự chọn (dùng chung mọi danh sách có phân trang) ----------
   Nhớ theo TỪNG danh sách trong localStorage `td_per_<key>` (tiện ích riêng mỗi trình duyệt — mất thì về mặc định).
   perSelectHtml() vẽ ô "Hiển thị [n] <đơn vị>/trang"; bindPerSelect() gắn sự kiện đổi (về trang đầu rồi vẽ lại).
   value 0 = "Vừa khung" (danh sách tự tính số dòng vừa chiều cao, dùng ở màn Kết quả). */
export function getPerPage(key, def, options) {
  try {
    var v = Number(localStorage.getItem("td_per_" + key));
    if (localStorage.getItem("td_per_" + key) !== null && options.indexOf(v) >= 0) return v;
  } catch (e) { /* bỏ qua */ }
  return def;
}
export function setPerPage(key, v) {
  try { localStorage.setItem("td_per_" + key, String(v)); } catch (e) { /* bỏ qua */ }
}
export function perSelectHtml(cur, options, unit) {
  return '<label class="td-per">Hiển thị <select data-per-sel aria-label="Số ' + esc(unit) + ' mỗi trang">' +
    options.map(function (n) { return '<option value="' + n + '"' + (n === cur ? " selected" : "") + ">" + (n === 0 ? "Vừa khung" : n) + "</option>"; }).join("") +
    "</select>" + esc(unit) + "/trang</label>";
}
export function bindPerSelect(root, key, onChange) {
  var sel = root && root.querySelector("[data-per-sel]");
  if (!sel) return;
  sel.onchange = function () { var v = Number(sel.value); setPerPage(key, v); onChange(v); };
  sel.onclick = function (e) { e.stopPropagation(); };
}
