/* ======================================================================
   ghichu_mindmap.js — MODULE "Tạo sơ đồ tư duy" (UC-25, Studio AI). HTML ở
   html/ghichu_mindmap.frag (nạp vào #mount-mindmap-pane), style ở css/ghichu_mindmap.css.
   Bố cục/luồng theo giao diện mẫu `so-do-tu-duy.html` — cùng khuôn với Ôn tập / Thi thử / Flashcard:
     Tạo mới  — chọn Môn + tick Chương/Tệp PDF (mỗi nguồn = 1 nhánh lớn), tên sơ đồ, "Độ sâu mỗi chương"
                2/3/4 cấp, "Dựng khung sơ đồ từ" (tiêu đề có sẵn / hệ thống tự phân tích), "Bố cục hiển thị"
                (Cây ngang / Tỏa tròn), "Khi bấm vào node" (Hiện trích dẫn nguồn / Mở hỏi đáp), ô "Đang tạo".
                Form chung: ghichu_studio_form.js (tuỳ chọn count:false — không có ô số lượng).
     Đã tạo   — bảng sơ đồ: Số node / Số cấp / Cập nhật (+ nhãn "Cấu trúc phẳng"), Mở, xoá.
     Khung vẽ — kéo nền, kéo node (cả nhánh con đi theo), nhấn đúp sửa chữ, Ctrl+Z / Ctrl+Y (hoặc ↶ ↷) hoàn
                tác / làm lại kéo node, sửa chữ, thêm và xoá node, − 100% + / Căn giữa /
                + Thêm node, bảng "Node đang chọn" (sửa nội dung, Cấp, Thuộc nhánh, Nguồn — bấm mở đúng
                Chương/PDF, "Hỏi về chủ đề này" mở khung Hỏi đáp, + Thêm nhánh con, Xóa node — gốc không xoá
                được), banner UC-25 E1 "chỉ gồm một cấp" + "Chọn nguồn khác", tên sơ đồ sửa tại chỗ.

   Database: studio_tools_mindmap_schema.sql (mindmaps / mindmap_sources / mindmap_nodes). Mỗi node của
   API ứng đúng 1 dòng mindmap_nodes; vị trí node KHÔNG lưu — bố cục tính lại ở client (layoutTree /
   layoutRadial), chỉ lưu độ lệch do kéo (offset_x/offset_y, cộng dồn theo nhánh cha). Backend:
   backend/app/routers/mindmaps.py + services/mindmap_generation.py (gốc = tên Môn, nhánh lớn = nguồn đã tick,
   ý con do Gemini sinh — 1 lượt/sơ đồ). Đổi field nào thì sửa normalizeMap() và schemas.py (Mindmap*):
     POST   /mindmaps {subject_id, sources:[{source_type, id}], title, depth (2-4), build_method:'headings'|'auto',
                       layout:'tree'|'radial', show_citation, ask_qa}               -> sơ đồ (như GET /mindmaps/{id})
     GET    /mindmaps            -> [{id, title, subject_name, source_labels, node_count, max_depth, is_flat,
                                     updated_seconds_ago}]
     GET    /mindmaps/{id}       -> {id, title, subject_id, depth, build_method, layout, show_citation, ask_qa,
                                     is_flat, updated_seconds_ago, nodes:[{id, parent_id, depth, position, label,
                                     origin:'ai'|'user', offset_x, offset_y, citation:{source_type, chapter_id,
                                     document_id, source_label, page_number, quote} | null}]}
     PATCH  /mindmaps/{id} {title}                                              -> {updated_seconds_ago}
     DELETE /mindmaps/{id}
     POST   /mindmaps/{id}/nodes {parent_id, label}                             -> node (origin 'user')
     PATCH  /mindmaps/{id}/nodes/{node_id} {label? , offset_x?, offset_y?}      -> {updated_seconds_ago}
     DELETE /mindmaps/{id}/nodes/{node_id}  (xoá cả nhánh con; node gốc -> 400)
     POST   /mindmaps/{id}/nodes/restore {parent_id, before_id|null, node:{label, origin, offset_x, offset_y,
                       citation|null, children:[...]}}   -> {nodes:[node… theo tiền thứ tự], updated_seconds_ago}
                       (Ctrl+Z sau Xóa node / Ctrl+Y sau Thêm node — dựng lại nhánh đúng vị trí, giữ trích dẫn gốc)
   Mốc thời gian dùng khoảng TƯƠNG ĐỐI (`*_seconds_ago`) — DATETIME của DB không kèm múi giờ.
   Mọi lệnh lưu xếp hàng tuần tự qua `mm.sync` (node vừa thêm có id thật rồi mới sửa/xoá được).

   Khi CHƯA đăng nhập ("chế độ mẫu", isOnline()) thì "Tạo sơ đồ" dựng sơ đồ MINH HOẠ cục bộ từ tên các
   nguồn đã tick (không đọc nội dung, không gọi API); sửa/kéo/thêm/xoá chỉ trong bộ nhớ, mất khi tải lại.
   Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi `mm.open` rồi gọi hooks.syncLayout().
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, closeDropdownEl } from "./ghichu_core.js";
import { createCardList } from "./ghichu_cardlist.js";
import { createStudioForm, pad, agoDate, fmtDay, apiErrorText } from "./ghichu_studio_form.js";

var LEVEL = ["Chủ đề", "Nhánh lớn", "Ý chính", "Ý phụ", "Chi tiết", "Ví dụ"];
var DEPTH_NAMES = ["Ý chính", "Ý phụ", "Chi tiết", "Ví dụ"];
var SAMPLE_CITE = "Minh hoạ (chế độ mẫu)";
var COL_GAP = 60, ROW_GAP = 12, BRANCH_GAP = 28;   // khoảng cách bố cục (px ở mức 100%)
var Z_MIN = 0.4, Z_MAX = 1.6;

// Nhớ sơ đồ đang mở ở khung vẽ để F5 rồi vẫn mở lại đúng sơ đồ (xoá khi rời khung vẽ bằng × / Xong).
var RESUME_KEY = "td_mm_resume";
function saveResume(id) { try { localStorage.setItem(RESUME_KEY, String(id)); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return localStorage.getItem(RESUME_KEY); } catch (e) { return null; } }

/* ---------------- state riêng của module ---------------- */
var mm = {
  open: false,
  screen: "setup",          // setup | saved | canvas
  // --- Tạo mới (nguồn/tên ở `form` — ghichu_studio_form.js) ---
  depth: 3,                 // mindmaps.depth
  method: "headings",       // mindmaps.build_method
  layout: "tree",           // mindmaps.layout
  opts: { showCite: true, askQA: true },  // mindmaps.show_citation / ask_qa
  job: null,                // ô "Đang tạo": {t0, total, nSrc, controller, timer, done, map}
  error: "",
  // --- Đã tạo ---
  saved: null,              // GET /mindmaps (null = chưa tải)
  savedError: "",
  samples: [],              // chế độ mẫu: các sơ đồ minh hoạ trong phiên
  // --- Khung vẽ ---
  map: null,                // normalizeMap()
  sel: null,                // key node đang chọn
  view: { z: 1, px: 0, py: 0, fitted: false },
  info: null,               // key -> {n, d, p, el, w, h}
  pos: new Map(),           // key -> vị trí bố cục {x, y}
  bounds: null,
  sync: Promise.resolve(),  // hàng đợi lệnh lưu
  savedAt: null, saveErr: "",
  pending: {},              // debounce sửa chữ: key/"title" -> timer
  undo: [], redo: [],       // lịch sử thao tác ở khung vẽ (Ctrl+Z / Ctrl+Y) — xem khối "Hoàn tác / Làm lại"
  labelStart: null,         // {n, v}: nội dung node lúc bắt đầu sửa ở bảng "Node đang chọn"
};
var uid = 1;

export function isOpen() { return mm.open; }

var form = createStudioForm({
  ids: "mm", cls: "mm", mode: "mindmap", count: false,
  minCount: 1, maxCount: 1, defaultCount: 1,
  createLabel: "Tạo sơ đồ", unit: "sơ đồ",
  panel: {
    idle: "Chưa có sơ đồ nào đang tạo. Tiến độ sẽ hiện ở đây sau khi bạn bấm Tạo sơ đồ.",
    steps: ["Đọc {n} nguồn nội dung", "Dựng nhánh, trích ý chính", "Gộp, kiểm tra cấu trúc"],
    startLabel: "Mở sơ đồ", againLabel: "Tạo sơ đồ khác",
  },
  active: function () { return mm.open && mm.screen === "setup"; },
  job: function () { return mm.job; },
  onChange: function () { renderSetup(); },
});

/* ====================================================================
   Mở / đóng
   ==================================================================== */
// Mở (bấm thẻ "Tạo sơ đồ tư duy"): GIỮ NGUYÊN trang đang dở (khung vẽ / Đã tạo) — vd. vừa bấm "Nguồn"
// hay "Hỏi về chủ đề này" rồi quay lại. Sau F5 thì mở lại sơ đồ đang vẽ dở.
export function openMindmap() {
  mm.open = true;
  state.dd = null;
  closeDropdownEl();
  form.initSource();
  hooks.syncLayout();
  if (!mm.map && readResume() && isOnline()) { resumeIfNeeded(); return; }
  if (mm.screen === "canvas" && !mm.map) mm.screen = "setup";
  show(mm.screen);
  refreshSaved();
}

// Ẩn màn Sơ đồ (chuyển công cụ / bấm Nguồn / Hỏi về chủ đề này). Sơ đồ đang mở giữ nguyên.
export function closeMindmap() {
  flushPending();
  mm.open = false;
  if (list) list.leave();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
}

// F5 khi đang ở khung vẽ -> mở lại đúng sơ đồ (chỉ khi đã đăng nhập; sơ đồ mẫu không sống qua F5).
export function resumeIfNeeded() {
  var id = readResume();
  if (!id) return;
  if (!isOnline()) { clearResume(); return; }
  apiAuth("GET", "/mindmaps/" + encodeURIComponent(id), authToken()).then(function (res) {
    if (!res.ok) { clearResume(); return; }
    mm.open = true;
    form.initSource();
    hooks.syncLayout();
    openMap(normalizeMap(res.data));
    refreshSaved();
  });
}

function show(screen) {
  mm.screen = screen;
  render();
  if (screen !== "canvas") $("mm-body").scrollTop = 0;
}

function toast(msg) {
  var t = $("mm-toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { t.hidden = true; }, 3200);
}

function savedList() { return isOnline() ? (mm.saved || []) : mm.samples.map(sampleSummary); }

function render() {
  if (!mm.open) return;
  var sc = mm.screen, formView = sc !== "canvas";
  ["setup", "saved", "canvas"].forEach(function (s) { $("mm-s-" + s).hidden = s !== sc; });
  $("mm-tabbar").hidden = !formView;
  Array.prototype.forEach.call($("mm-tabs").children, function (b) {
    b.classList.toggle("on", (b.dataset.tab === "new" ? "setup" : "saved") === sc);
  });
  var n = savedList().length;
  $("mm-saved-count").textContent = n ? n : "";
  $("mm-create").hidden = sc !== "setup";
  $("mm-done").hidden = sc !== "canvas";
  $("mm-title").hidden = sc === "canvas";
  $("mm-map-name").hidden = sc !== "canvas";
  $("mm-saved").hidden = sc !== "canvas";
  $("mm-body").classList.toggle("mm-body--canvas", sc === "canvas");
  if (sc === "setup") renderSetup();
  else if (sc === "saved") renderSaved();
  else renderCanvas();
}

// Nút × : Tạo mới / Đã tạo -> về Notebook; khung vẽ -> Đã tạo.
function onClose() {
  if (mm.screen === "canvas") { finishEditing(); return; }
  closeMindmap();
}

/* ====================================================================
   TẠO MỚI — độ sâu, cách dựng khung, bố cục, 2 công tắc; gọi POST /mindmaps
   ==================================================================== */
function renderSetup() {
  var busy = !!mm.job;
  Array.prototype.forEach.call($("mm-depth-seg").children, function (b) { b.classList.toggle("on", Number(b.dataset.v) === mm.depth); });
  $("mm-depth-note").textContent = mm.depth + " cấp dưới mỗi chương: " + DEPTH_NAMES.slice(0, mm.depth).join(" → ");
  $("mm-method-box").querySelectorAll(".mm-opt-row").forEach(function (r) {
    var on = r.dataset.v === mm.method;
    r.classList.toggle("on", on);
    r.setAttribute("aria-checked", String(on));
  });
  Array.prototype.forEach.call($("mm-layout-seg").children, function (b) { b.classList.toggle("on", b.dataset.v === mm.layout); });
  $("mm-opts").querySelectorAll(".mm-sw-row").forEach(function (r) {
    r.classList.toggle("on", !!mm.opts[r.dataset.k]);
    r.setAttribute("aria-pressed", String(!!mm.opts[r.dataset.k]));
  });
  $("mm-layout-box").style.pointerEvents = busy ? "none" : "";
  $("mm-opts").style.pointerEvents = busy ? "none" : "";
  form.render();
  renderPanel();
}

function renderPanel() {
  form.renderPanel(mm.error, function (j) {
    var m = j.map;
    return '<p><b style="font-weight:500">' + esc(m.title) + '</b><br><span class="mm-muted">' + countNodes(m.root) + " node · " +
      levelText(m) + " · đã lưu vào tab Đã tạo</span></p>";
  });
  if (!isOnline() && !mm.job) {
    $("mm-panel").insertAdjacentHTML("beforeend", '<p class="mm-muted">Chế độ mẫu: sơ đồ được dựng minh hoạ từ tên các nguồn đã chọn và mất khi tải lại trang. Đăng nhập để AI dựng sơ đồ từ nội dung tài liệu của bạn.</p>');
  }
}

function createMap() {
  if (mm.job || !form.validate()) return;
  if (!isOnline()) {
    mm.error = "";
    var sm = sampleMap();
    mm.samples.unshift(sm);
    openMap(sm);
    return;
  }
  var body = form.sourcesForApi();
  body.title = form.name.trim();
  body.depth = mm.depth;
  body.build_method = mm.method;
  body.layout = mm.layout;
  body.show_citation = mm.opts.showCite;
  body.ask_qa = mm.opts.askQA;

  var controller = window.AbortController ? new AbortController() : null;
  var job = { t0: Date.now(), total: body.sources.length * 4, nSrc: body.sources.length, controller: controller, done: false };
  mm.job = job; mm.error = "";
  job.timer = setInterval(function () { if (mm.open && mm.screen === "setup") renderPanel(); }, 1000);
  renderSetup();

  apiAuth("POST", "/mindmaps", authToken(), body, controller ? controller.signal : undefined).then(function (res) {
    if (mm.job !== job) return; // đã bấm Hủy
    clearInterval(job.timer);
    var map = res.ok ? normalizeMap(res.data) : null;
    if (map && map.root) {
      refreshSaved();
      if (mm.open && mm.screen === "setup") { mm.job = null; form.reset(); openMap(map); return; }
      job.done = true;
      job.map = map;
      if (mm.open) toast("Đã tạo xong “" + map.title + "” — xem ở tab Đã tạo.");
    } else {
      mm.job = null;
      mm.error = res.ok ? "AI chưa dựng được sơ đồ từ nguồn đã chọn." : apiErrorText(res, "/mindmaps", "Không tạo được sơ đồ tư duy.");
    }
    if (mm.open && mm.screen === "setup") renderSetup();
  });
}

function cancelJob() {
  var j = mm.job;
  if (!j || j.done) return;
  clearInterval(j.timer);
  if (j.controller) j.controller.abort();
  mm.job = null;
  renderSetup();
  toast("Đã ngừng chờ. Nếu máy chủ đã kịp tạo xong, sơ đồ vẫn sẽ hiện ở tab Đã tạo.");
  setTimeout(refreshSaved, 20000); // server vẫn có thể đang tạo nốt
}

function resetJob() {
  mm.job = null; mm.error = "";
  form.reset();
  if (mm.open && mm.screen === "setup") renderSetup();
}

/* ---------- Sơ đồ minh hoạ (chế độ mẫu) — nhánh = nguồn đã tick, ý con là câu hướng dẫn ---------- */
// S(nhãn, ...con) — 4 tầng dưới mỗi nhánh (Ý chính → Ý phụ → Chi tiết → Ví dụ), cắt theo "Độ sâu".
function S(label) { return { label: label, kids: Array.prototype.slice.call(arguments, 1) }; }
var SAMPLE_IDEAS = [
  S("Khái niệm cốt lõi", S("Định nghĩa", S("Thuật ngữ chính", S("Ví dụ ngắn"))), S("Đặc điểm", S("Điểm cần nhớ", S("Ví dụ ngắn")))),
  S("Cách áp dụng", S("Các bước thực hiện", S("Bước quan trọng nhất", S("Ví dụ ngắn"))), S("Lưu ý khi dùng", S("Lỗi hay gặp", S("Ví dụ ngắn")))),
];
function sampleMap() {
  var sub = state.subjects.find(function (s) { return s.id === form.subjectId; });
  var picked = form.sourcesForApi().sources;
  var labels = [];
  var items = sub ? (sub.chapters || []).map(function (c) { return { id: c.id, name: c.name, kind: "CHAPTER" }; })
    .concat((sub.pdfs || []).map(function (p) { return { id: p.id, name: p.name, kind: "PDF" }; })) : [];
  var cite = { label: SAMPLE_CITE };
  var mk = function (label, origin) { return { key: "k" + uid++, id: null, label: label, origin: origin || "ai", ox: 0, oy: 0, cite: cite, kids: [], parent: null }; };
  var root = mk(sub ? sub.name : "Sơ đồ minh hoạ");
  root.cite = null;
  picked.forEach(function (s) {
    var it = items.find(function (x) { return x.id === s.id; });
    var name = it ? it.name.replace(/\.pdf$/i, "") : "Nguồn";
    labels.push(name);
    var br = mk(name);
    addKid(root, br);
    var grow = function (parent, spec, lvl) {
      if (lvl > mm.depth) return;
      var n = mk(spec.label);
      addKid(parent, n);
      spec.kids.forEach(function (k) { grow(n, k, lvl + 1); });
    };
    SAMPLE_IDEAS.forEach(function (idea) { grow(br, idea, 1); });
  });
  return {
    id: "sample-" + uid++, title: form.name.trim() || "Sơ đồ minh hoạ", subjectId: form.subjectId, subjectName: sub ? sub.name : "",
    sourceLabels: labels, depth: mm.depth, method: mm.method, layout: mm.layout,
    showCite: mm.opts.showCite, askQA: mm.opts.askQA, isFlat: false, sample: true, root: root, updatedAt: new Date(),
  };
}
function sampleSummary(m) {
  return { id: m.id, title: m.title, subject_name: m.subjectName, source_labels: m.sourceLabels, node_count: countNodes(m.root),
    max_depth: maxDepth(m.root), is_flat: m.isFlat, updated_seconds_ago: Math.max(0, (Date.now() - m.updatedAt) / 1000) };
}

/* ---------- Chuẩn hoá phản hồi API (tách khỏi tên cột backend) ---------- */
// `raw` = citation nguyên bản của API — gửi lại khi dựng lại node đã xoá (Ctrl+Z) để giữ đúng trích dẫn gốc.
function citeFrom(c) {
  return c && c.source_label ? {
    label: c.source_label + (c.page_number ? " · trang " + c.page_number : ""),
    quote: c.quote || "", page: c.page_number, chapter_id: c.chapter_id, document_id: c.document_id, raw: c,
  } : null;
}

function normalizeMap(d) {
  var byId = {}, root = null;
  var rows = (d.nodes || []).slice().sort(function (a, b) { return a.depth - b.depth || a.position - b.position; });
  rows.forEach(function (r) {
    byId[r.id] = {
      key: "k" + uid++, id: r.id, label: r.label, origin: r.origin || "ai",
      ox: Number(r.offset_x) || 0, oy: Number(r.offset_y) || 0,
      cite: citeFrom(r.citation),
      kids: [], parent: null,
    };
  });
  rows.forEach(function (r) {
    var n = byId[r.id];
    if (r.parent_id == null) { if (!root) root = n; return; }
    var p = byId[r.parent_id];
    if (p) addKid(p, n);
  });
  return {
    id: d.id, title: d.title || "Sơ đồ tư duy", subjectId: d.subject_id, depth: d.depth, method: d.build_method,
    layout: d.layout === "radial" ? "radial" : "tree", showCite: d.show_citation !== false, askQA: d.ask_qa !== false,
    isFlat: !!d.is_flat, sample: false, root: root,
    updatedAt: d.updated_seconds_ago != null ? agoDate(d.updated_seconds_ago) : null,
  };
}

function addKid(p, n) { n.parent = p; p.kids.push(n); }
function walk(n, f, d) { d = d || 0; f(n, d); n.kids.forEach(function (k) { walk(k, f, d + 1); }); }
function countNodes(r) { var c = 0; if (r) walk(r, function () { c++; }); return c; }
function maxDepth(r) { var m = 0; if (r) walk(r, function (n, d) { if (d > m) m = d; }); return m; }
// "Số cấp" = số cấp dưới mỗi chương (gốc + nhánh lớn không tính); sơ đồ phẳng = 1.
function levelCount(isFlat, depth) { return isFlat ? 1 : Math.max(1, depth - 1); }
function levelText(m) { return levelCount(m.isFlat, maxDepth(m.root)) + " cấp"; }
function findNode(key) { var r = null; if (mm.map && mm.map.root) walk(mm.map.root, function (n) { if (n.key === key) r = n; }); return r; }

/* ====================================================================
   ĐÃ TẠO — bảng (GET /mindmaps)
   ==================================================================== */
function refreshSaved() {
  if (!isOnline()) { if (mm.open && mm.screen !== "canvas") render(); return; }
  apiAuth("GET", "/mindmaps", authToken()).then(function (res) {
    mm.saved = res.ok && Array.isArray(res.data) ? res.data : (mm.saved || []);
    mm.savedError = res.ok ? "" : apiErrorText(res, "/mindmaps", "Không tải được danh sách sơ đồ.");
    if (mm.open && mm.screen !== "canvas") render();
  });
}

// Đã tạo = lưới thẻ dùng chung (ghichu_cardlist.js, cùng khuôn Tóm tắt) — tạo trong initMindmap().
var list = null;
function renderSaved() { if (list) list.render(); }
function byTitle(a, b) { return a.title.localeCompare(b.title, "vi", { numeric: true }); }
function byNum(v) { return function (a, b) { var x = v(a), y = v(b); return (x == null) - (y == null) || (x == null ? 0 : x - y); }; }
function savedCard(m) {
  var src = (m.source_labels && m.source_labels.length ? m.source_labels.join(", ") : m.subject_name) || "";
  return {
    lines: [
      { cls: "l1", html: esc(src) },
      { html: m.node_count + " node · " + levelCount(m.is_flat, m.max_depth) + " cấp" },
    ].concat(src !== m.subject_name && m.subject_name ? [{ html: "Môn " + esc(m.subject_name) }] : []),
    badge: null,
    foot: m.updated_seconds_ago != null ? "Cập nhật " + fmtDay(agoDate(m.updated_seconds_ago)).toLowerCase() : "",
    acts: [{ act: "open", label: "Mở" }],
    menu: [{ m: "open", label: "Mở" }, { m: "del", label: "Xoá sơ đồ", del: true }],
  };
}
function initSavedList() {
  list = createCardList({
    pane: $("mm-pane"), bar: $("mm-saved-bar"), box: $("mm-saved-list"), noun: "sơ đồ",
    items: function () { return isOnline() && mm.saved === null ? null : savedList(); },
    error: function () { return isOnline() ? mm.savedError || "" : ""; },
    notice: function () { return isOnline() ? "" : "Chế độ mẫu: sơ đồ minh hoạ chỉ có trong phiên này"; },
    id: function (m) { return String(m.id); }, title: function (m) { return m.title; },
    search: function (m) { return m.title + " " + (m.source_labels || []).join(" ") + " " + (m.subject_name || ""); },
    filters: [{ key: "all", label: "Tất cả" }],   // người dùng chốt: bỏ bộ lọc "Cấu trúc phẳng"
    sorts: {
      new: { label: "Mới cập nhật", cmp: byNum(function (m) { return m.updated_seconds_ago; }) },
      old: { label: "Cũ nhất", cmp: byNum(function (m) { return -m.updated_seconds_ago; }) },
      big: { label: "Nhiều node nhất", cmp: byNum(function (m) { return -m.node_count; }) },
      az: { label: "Tên A–Z", cmp: byTitle },
    },
    card: savedCard, primary: function () { return "open"; },
    onAct: function (act, id) { if (act === "open") return openSaved(id); },
    newTile: { title: "Tạo sơ đồ tư duy mới", sub: "Mỗi Chương / tệp PDF là một nhánh lớn" },
    onNew: function () { form.initSource(); show("setup"); },
    remove: {
      api: function (id) { return "/mindmaps/" + encodeURIComponent(id); },
      local: function (id) { mm.samples = mm.samples.filter(function (x) { return x.id !== id; }); if (mm.map && mm.map.id === id) mm.map = null; render(); },
      after: function (id) { if (mm.map && String(mm.map.id) === id) { mm.map = null; clearResume(); } refreshSaved(); },
    },
  });
}

function openSaved(id) {
  if (!isOnline()) {
    var sm = mm.samples.find(function (m) { return m.id === id; });
    if (sm) openMap(sm);
    return Promise.resolve();
  }
  return apiAuth("GET", "/mindmaps/" + encodeURIComponent(id), authToken()).then(function (res) {
    if (!res.ok) { toast(apiErrorText(res, "/mindmaps/{id}", "Không mở được sơ đồ.")); return; }
    var map = normalizeMap(res.data);
    if (!map.root) { toast("Sơ đồ này chưa có node nào."); return; }
    openMap(map);
  });
}

/* ====================================================================
   KHUNG VẼ
   ==================================================================== */
function openMap(map) {
  mm.map = map;
  mm.sel = null;
  mm.undo = []; mm.redo = []; mm.labelStart = null;
  mm.view.fitted = false;
  mm.saveErr = "";
  mm.savedAt = map.updatedAt || new Date();
  if (!map.sample) saveResume(map.id); else clearResume();
  show("canvas");
}

function renderCanvas() {
  var m = mm.map;
  var nameIn = $("mm-map-name");
  if (document.activeElement !== nameIn) nameIn.value = m.title;
  $("mm-flat-notice").hidden = true;   // người dùng chốt: không hiện dải "cấu trúc phẳng" (E1)
  renderSavedLabel();
  renderHistoryBtns();
  draw();
  if (!mm.view.fitted) mm.view.fitted = fitView(); else applyView();
  renderNodePanel();
}

function renderSavedLabel() {
  var el = $("mm-saved");
  el.classList.toggle("err", !!mm.saveErr);
  if (mm.saveErr) { el.textContent = mm.saveErr; return; }
  var d = mm.savedAt;
  el.textContent = mm.map && mm.map.sample ? "Bản minh hoạ · không lưu" : d ? "Đã lưu lúc " + pad(d.getHours()) + ":" + pad(d.getMinutes()) : "";
}

// Vẽ: tạo node, đo kích thước, xếp vị trí theo bố cục, nối đường.
function draw() {
  var box = $("mm-nodes");
  box.innerHTML = "";
  var info = new Map();
  walk(mm.map.root, function (n, d) {
    var el = document.createElement("div");
    el.className = "mm-node l" + Math.min(d, 4) + (mm.sel === n.key ? " sel" : "");
    el.textContent = n.label;
    el.dataset.key = n.key;
    box.appendChild(el);
    info.set(n.key, { n: n, d: d, p: n.parent, el: el, w: 0, h: 0 });
  });
  info.forEach(function (o) { o.w = o.el.offsetWidth; o.h = o.el.offsetHeight; });
  mm.info = info;
  mm.pos = new Map();
  (mm.map.layout === "radial" ? layoutRadial : layoutTree)(info);
  place();
}

// Cây ngang: cột theo cấp, node lá xếp dọc, node cha nằm giữa các con.
function layoutTree(info) {
  var colW = [];
  info.forEach(function (o) { colW[o.d] = Math.max(colW[o.d] || 0, o.w); });
  var colX = [0];
  for (var i = 1; i < colW.length; i++) colX[i] = colX[i - 1] + colW[i - 1] + COL_GAP;
  var y = 0;
  var lay = function (n, d) {
    var o = info.get(n.key);
    if (!n.kids.length) { o.cy = y + o.h / 2; y += o.h + ROW_GAP; }
    else {
      n.kids.forEach(function (k, i) { lay(k, d + 1); if (d === 0 && i < n.kids.length - 1) y += BRANCH_GAP; });
      o.cy = (info.get(n.kids[0].key).cy + info.get(n.kids[n.kids.length - 1].key).cy) / 2;
    }
    mm.pos.set(n.key, { x: colX[d], y: o.cy - o.h / 2 });
  };
  lay(mm.map.root, 0);
}

// Tỏa tròn: node trung tâm ở giữa, các nhánh chia đều 2 bên trái / phải (theo số node lá).
function layoutRadial(info) {
  var root = mm.map.root, center = root.kids.length === 1 ? root.kids[0] : root;
  var leaves = function (n) { return n.kids.length ? n.kids.reduce(function (a, k) { return a + leaves(k); }, 0) : 1; };
  var total = center.kids.reduce(function (a, k) { return a + leaves(k); }, 0);
  var R = [], L = [], acc = 0;
  center.kids.forEach(function (k) { (acc < total / 2 ? R : L).push(k); acc += leaves(k); });
  var c = info.get(center.key);
  mm.pos.set(center.key, { x: -c.w / 2, y: -c.h / 2 });
  if (center !== root) { var r = info.get(root.key); mm.pos.set(root.key, { x: -r.w / 2, y: -c.h / 2 - 80 - r.h }); }
  var side = function (list, dir) {
    var colW = [];
    var meas = function (n, d) { colW[d] = Math.max(colW[d] || 0, info.get(n.key).w); n.kids.forEach(function (k) { meas(k, d + 1); }); };
    list.forEach(function (k) { meas(k, 1); });
    var colX = []; colX[1] = c.w / 2 + COL_GAP;
    for (var i = 2; i < colW.length; i++) colX[i] = colX[i - 1] + colW[i - 1] + COL_GAP;
    var y = 0;
    var lay = function (n) {
      var o = info.get(n.key);
      if (!n.kids.length) { o.cy = y + o.h / 2; y += o.h + ROW_GAP; }
      else { n.kids.forEach(lay); o.cy = (info.get(n.kids[0].key).cy + info.get(n.kids[n.kids.length - 1].key).cy) / 2; }
    };
    list.forEach(function (k, i) { lay(k); if (i < list.length - 1) y += BRANCH_GAP; });
    var H = Math.max(0, y - ROW_GAP);
    var put = function (n, d) {
      var o = info.get(n.key);
      mm.pos.set(n.key, { x: dir > 0 ? colX[d] : -colX[d] - o.w, y: o.cy - H / 2 - o.h / 2 });
      n.kids.forEach(function (k) { put(k, d + 1); });
    };
    list.forEach(function (k) { put(k, 1); });
  };
  side(R, 1); side(L, -1);
}

// Vị trí thật = vị trí bố cục + độ lệch kéo của chính node và mọi node cha (offset_x/offset_y).
function absPos(key) {
  var o = mm.info.get(key), p = mm.pos.get(key), dx = 0, dy = 0, cur = o.n;
  while (cur) { dx += cur.ox; dy += cur.oy; cur = cur.parent; }
  return { x: p.x + dx, y: p.y + dy, w: o.w, h: o.h };
}

function place() {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  mm.info.forEach(function (o) {
    var a = absPos(o.n.key);
    o.el.style.left = a.x + "px"; o.el.style.top = a.y + "px";
    minX = Math.min(minX, a.x); minY = Math.min(minY, a.y); maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
  });
  mm.bounds = { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  var radial = mm.map.layout === "radial", d = "";
  mm.info.forEach(function (o) {
    if (!o.p) return;
    var a = absPos(o.p.key), b = absPos(o.n.key);
    var acx = a.x + a.w / 2, bcx = b.x + b.w / 2, x1, y1, x2, y2, m;
    if (radial && Math.abs(acx - bcx) < (a.w + b.w) / 2) {           // nối dọc (gốc -> node trung tâm)
      var top = a.y < b.y ? a : b, bot = a.y < b.y ? b : a;
      x1 = top.x + top.w / 2; y1 = top.y + top.h; x2 = bot.x + bot.w / 2; y2 = bot.y; m = (y1 + y2) / 2;
      d += "M" + x1 + "," + y1 + " C" + x1 + "," + m + " " + x2 + "," + m + " " + x2 + "," + y2 + " ";
      return;
    }
    if (radial && bcx < acx) { x1 = a.x; x2 = b.x + b.w; }             // nhánh bên trái
    else { x1 = a.x + a.w; x2 = b.x; }
    y1 = a.y + a.h / 2; y2 = b.y + b.h / 2; m = (x1 + x2) / 2;
    d += "M" + x1 + "," + y1 + " C" + m + "," + y1 + " " + m + "," + y2 + " " + x2 + "," + y2 + " ";
  });
  $("mm-edges").innerHTML = '<path d="' + d + '"/>';
}

function applyView() {
  $("mm-world").style.transform = "translate(" + mm.view.px + "px," + mm.view.py + "px) scale(" + mm.view.z + ")";
  $("mm-z-val").textContent = Math.round(mm.view.z * 100) + "%";
}

// Vừa khung theo chiều cao, chữ không nhỏ hơn 75%. Sơ đồ cây rộng hơn khung thì canh trái, kéo nền để xem tiếp.
function fitView() {
  var c = $("mm-canvas"), b = mm.bounds, v = mm.view;
  if (!b || !c.clientWidth) return false;
  var top = mm.map.isFlat ? 120 : 60, bottom = 40, left = 24, right = 24;
  var W = c.clientWidth - left - right, H = c.clientHeight - top - bottom;
  var bw = b.maxX - b.minX || 1, bh = b.maxY - b.minY || 1;
  v.z = Math.max(0.75, Math.min(1, W / bw, H / bh));
  var tooWide = bw * v.z > W;
  v.px = tooWide && mm.map.layout !== "radial" ? left - b.minX * v.z : left + (W - bw * v.z) / 2 - b.minX * v.z;
  v.py = top + Math.max(0, (H - bh * v.z) / 2) - b.minY * v.z;
  applyView();
  return true;
}

// Chọn node bị bảng bên phải / thanh công cụ che thì lướt khung cho node lộ ra.
function reveal(key) {
  if (!mm.info.get(key)) return;
  var a = absPos(key), c = $("mm-canvas"), v = mm.view;
  var sx = v.px + a.x * v.z, sr = sx + a.w * v.z, sy = v.py + a.y * v.z, sb = sy + a.h * v.z;
  var limitR = c.clientWidth - 320, limitB = c.clientHeight - 40, dx = 0, dy = 0;
  if (sr > limitR) dx = limitR - sr;
  if (sx + dx < 16) dx = 16 - sx;
  if (sb > limitB) dy = limitB - sb;
  if (sy + dy < 60) dy = 60 - sy;
  if (!dx && !dy) return;
  var w = $("mm-world");
  w.style.transition = "transform .25s";
  v.px += dx; v.py += dy;
  applyView();
  setTimeout(function () { w.style.transition = ""; }, 260);
}

function zoomBy(f) {
  var c = $("mm-canvas"), v = mm.view, cx = c.clientWidth / 2, cy = c.clientHeight / 2;
  var z = Math.max(Z_MIN, Math.min(Z_MAX, Math.round((v.z + f) * 100) / 100));
  v.px = cx - (cx - v.px) * z / v.z; v.py = cy - (cy - v.py) * z / v.z; v.z = z;
  applyView();
}

function select(key) {
  mm.sel = key;
  mm.info.forEach(function (o) { o.el.classList.toggle("sel", o.n.key === key); });
  renderNodePanel();
  if (key != null) reveal(key);
}

/* ---------- Bảng "Node đang chọn" ---------- */
function nodeInfo(key) { return mm.info && mm.info.get(key); }
function branchOf(o) { var n = o.n; while (n.parent && n.parent.parent) n = n.parent; return n; }

function renderNodePanel() {
  var o = mm.sel != null ? nodeInfo(mm.sel) : null;
  $("mm-npanel").hidden = !o;
  if (!o) return;
  var n = o.n, m = mm.map;
  var t = $("mm-np-text");
  if (document.activeElement !== t) t.value = n.label;
  $("mm-np-level").textContent = m.isFlat && o.d === 1 ? "Ý chính" : LEVEL[Math.min(o.d, LEVEL.length - 1)];
  $("mm-np-branch").textContent = o.d === 0 ? "—" : branchOf(o).label;
  var src = $("mm-np-src");
  src.hidden = !m.showCite || !n.cite;
  if (n.cite) {
    $("mm-np-src-text").textContent = n.cite.label;
    src.title = n.cite.quote || "";
    src.disabled = !(n.cite.chapter_id || n.cite.document_id);
  }
  $("mm-np-ask").hidden = !m.askQA;
  $("mm-np-del").disabled = o.d === 0;
}

/* ====================================================================
   Lưu (đã đăng nhập) — hàng đợi tuần tự; chế độ mẫu chỉ đổi trong bộ nhớ
   ==================================================================== */
function mapPath(rest) { return "/mindmaps/" + encodeURIComponent(mm.map.id) + (rest || ""); }

// fn() trả Promise kết quả apiAuth (hoặc null = bỏ qua). Lỗi giữ trên nhãn "Đã lưu" tới lần lưu được sau.
function enqueue(fn) {
  var map = mm.map;
  if (!map || map.sample) { if (map) map.updatedAt = new Date(); return Promise.resolve(); }
  mm.sync = mm.sync.then(function () {
    var p = fn();
    if (!p) return null;
    return p.then(function (res) {
      if (mm.map !== map) return res;
      if (res.ok) {
        mm.saveErr = "";
        mm.savedAt = res.data && res.data.updated_seconds_ago != null ? agoDate(res.data.updated_seconds_ago) : new Date();
      } else {
        mm.saveErr = "Chưa lưu được — " + apiErrorText(res, "/mindmaps", "lỗi máy chủ.");
      }
      if (mm.open && mm.screen === "canvas") renderSavedLabel();
      return res;
    });
  });
  return mm.sync;
}

function saveNode(n, fields) {
  enqueue(function () { return n.id == null ? null : apiAuth("PATCH", mapPath("/nodes/" + n.id), authToken(), fields); });
}

// mm.pending[name] = {timer, fn} — giữ fn để flushPending() gửi ngay khi rời khung vẽ.
function debounce(name, fn) {
  if (mm.pending[name]) clearTimeout(mm.pending[name].timer);
  mm.pending[name] = { fn: fn, timer: setTimeout(function () { delete mm.pending[name]; fn(); }, 600) };
}
// Rời khung vẽ / đóng module: gửi ngay các lần sửa chữ còn đang chờ.
function flushPending() {
  Object.keys(mm.pending).forEach(function (k) {
    var p = mm.pending[k];
    clearTimeout(p.timer);
    delete mm.pending[k];
    p.fn();
  });
}

function setLabel(n, label, immediate) {
  n.label = label;
  if (mm.map.sample) { mm.map.updatedAt = new Date(); return; }
  var send = function () { saveNode(n, { label: n.label }); };
  if (immediate) {
    if (mm.pending["n" + n.key]) { clearTimeout(mm.pending["n" + n.key].timer); delete mm.pending["n" + n.key]; }
    send();
  }
  else debounce("n" + n.key, send);
}

function addChild(parentKey) {
  var p = findNode(parentKey);
  if (!p) return;
  var n = { key: "k" + uid++, id: null, label: "Nhánh mới", origin: "user", ox: 0, oy: 0, cite: p.cite, kids: [], parent: null };
  addKid(p, n);
  record({ kind: "add", n: n, p: p, index: p.kids.length - 1 });
  mm.sel = n.key;
  draw(); renderNodePanel(); reveal(n.key);
  $("mm-np-text").focus(); $("mm-np-text").select();
  enqueue(function () {
    if (p.id == null) return null;
    return apiAuth("POST", mapPath("/nodes"), authToken(), { parent_id: p.id, label: n.label }).then(function (res) {
      if (res.ok && res.data) {
        n.id = res.data.id;
        var c = res.data.citation;
        if (c && c.source_label) n.cite = citeFrom(c);
        else if (res.data.citation === null) n.cite = null;
        if (mm.sel === n.key) renderNodePanel();
      }
      return res;
    });
  });
}

function deleteSelected() {
  var o = nodeInfo(mm.sel);
  if (!o || !o.p) return;
  var n = o.n, p = o.p;
  record({ kind: "del", n: n, p: p, index: p.kids.indexOf(n) });
  removeNode(n);
  mm.sel = p.key;
  draw(); renderNodePanel();
  toast("Đã xoá node" + (n.kids.length ? " và các nhánh con" : "") + " · Ctrl+Z để hoàn tác");
}

// Gỡ node (cả nhánh con) khỏi cây + DELETE. Object node vẫn được giữ trong lịch sử để dựng lại được.
function removeNode(n) {
  var p = n.parent;
  p.kids = p.kids.filter(function (k) { return k !== n; });
  enqueue(function () { return n.id == null ? null : apiAuth("DELETE", mapPath("/nodes/" + n.id), authToken()); });
}

// Gắn lại node (cả nhánh con) vào vị trí cũ + POST .../nodes/restore. Id đọc LÚC GỬI (hàng đợi tuần tự) vì node
// cha / node anh em có thể vừa được dựng lại, có id mới. Node dựng lại nhận id mới theo đúng tiền thứ tự.
function restoreNode(p, n, index) {
  n.parent = p;
  p.kids.splice(Math.max(0, Math.min(index, p.kids.length)), 0, n);
  enqueue(function () {
    if (p.id == null || p.kids.indexOf(n) < 0) return null;
    var before = p.kids[p.kids.indexOf(n) + 1];
    var body = { parent_id: p.id, before_id: before && before.id != null ? before.id : null, node: snapshot(n) };
    return apiAuth("POST", mapPath("/nodes/restore"), authToken(), body).then(function (res) {
      if (res.ok && res.data && Array.isArray(res.data.nodes)) {
        var list = [];
        walk(n, function (x) { list.push(x); });
        res.data.nodes.forEach(function (r, i) { if (list[i]) list[i].id = r.id; });
      }
      return res;
    });
  });
}

function snapshot(n) {
  var c = n.cite && n.cite.raw;
  return {
    label: n.label.slice(0, 500), origin: n.origin === "ai" ? "ai" : "user",
    offset_x: Math.round(n.ox * 10) / 10, offset_y: Math.round(n.oy * 10) / 10,
    citation: c && c.source_type && c.source_label ? {
      source_type: c.source_type, chapter_id: c.chapter_id || null, document_id: c.document_id || null,
      source_label: String(c.source_label).slice(0, 255), page_number: c.page_number || null,
      quote: c.quote ? String(c.quote).slice(0, 5000) : null,
    } : null,
    children: n.kids.map(snapshot),
  };
}

/* ---------- Hoàn tác / Làm lại (Ctrl+Z / Ctrl+Y, nút ↶ ↷) ----------
   Mỗi bước: {kind:'move', n, from:{x,y}, to:{x,y}} | {kind:'label', n, from, to} | {kind:'add'|'del', n, p, index}.
   Bước giữ THAM CHIẾU tới object node (không giữ id): node dựng lại có id mới nhưng vẫn là object cũ, nên các bước
   cũ hơn trong lịch sử vẫn trỏ đúng. Lịch sử theo từng lần mở sơ đồ (openMap() xoá), tối đa HISTORY_MAX bước; thao
   tác mới xoá nhánh "làm lại" như Word. Mỗi bước hoàn tác / làm lại được lưu lên máy chủ như thao tác thường. */
var HISTORY_MAX = 100;

function record(step) {
  mm.undo.push(step);
  if (mm.undo.length > HISTORY_MAX) mm.undo.shift();
  mm.redo = [];
  renderHistoryBtns();
}

function renderHistoryBtns() {
  $("mm-undo").disabled = !mm.undo.length;
  $("mm-redo").disabled = !mm.redo.length;
}

function undo() { travel(mm.undo, mm.redo, true); }
function redo() { travel(mm.redo, mm.undo, false); }

function travel(from, to, back) {
  if (!mm.map || !from.length || drag) return;
  flushPending();
  var st = from.pop();
  to.push(st);
  var n = st.n, focus = n;
  if (st.kind === "move") {
    var v = back ? st.from : st.to;
    n.ox = v.x; n.oy = v.y;
    if (mm.map.sample) mm.map.updatedAt = new Date();
    else saveNode(n, { offset_x: Math.round(n.ox * 10) / 10, offset_y: Math.round(n.oy * 10) / 10 });
  } else if (st.kind === "label") {
    setLabel(n, back ? st.from : st.to, true);
  } else if ((st.kind === "add") === back) {   // bỏ "Thêm node" / làm lại "Xóa node"
    removeNode(n);
    focus = st.p;
  } else {                                      // dựng lại node đã xoá / làm lại "Thêm node"
    restoreNode(st.p, n, st.index);
  }
  mm.sel = focus.key;
  draw(); renderNodePanel(); renderHistoryBtns();
  reveal(focus.key);
}

function setTitle(v) {
  mm.map.title = v;
  if (mm.map.sample) { mm.map.updatedAt = new Date(); return; }
  debounce("title", function () {
    var t = mm.map.title.trim();
    if (t) enqueue(function () { return apiAuth("PATCH", mapPath(), authToken(), { title: t }); });
  });
}

// "Xong" / × ở khung vẽ: lưu nốt rồi về Đã tạo.
function finishEditing() {
  if (!mm.map.title.trim()) {
    mm.map.title = "Sơ đồ chưa đặt tên";
    if (!mm.map.sample) enqueue(function () { return apiAuth("PATCH", mapPath(), authToken(), { title: mm.map.title }); });
  }
  flushPending();
  clearResume();
  var map = mm.map;
  mm.sync.then(function () {
    if (map.sample) { toast("Đã cập nhật sơ đồ minh hoạ (chế độ mẫu)"); return; }
    toast(mm.saveErr ? mm.saveErr : "Đã lưu sơ đồ");
    refreshSaved();
  });
  show("saved");
}

/* ---------- Kéo nền / kéo node / nhấn đúp sửa ---------- */
var drag = null;
function bindCanvas() {
  var cv = $("mm-canvas");
  cv.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || e.target.closest(".mm-toolbar, .mm-npanel, .mm-cnotice")) return;
    var el = e.target.closest(".mm-node");
    if (el && el.isContentEditable) return;
    var n = el ? findNode(el.dataset.key) : null;
    drag = { el: el, n: n, sx: e.clientX, sy: e.clientY, moved: false, ox: n ? n.ox : 0, oy: n ? n.oy : 0, px: mm.view.px, py: mm.view.py };
  });
  cv.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    // Chỉ giữ con trỏ khi đã thật sự kéo — bấm/nhấn đúp thường vẫn trúng đúng node (dblclick để sửa).
    if (!drag.moved) cv.setPointerCapture(e.pointerId);
    drag.moved = true;
    if (drag.n) {
      drag.el.classList.add("dragging");
      drag.n.ox = drag.ox + dx / mm.view.z; drag.n.oy = drag.oy + dy / mm.view.z;
      place();
    } else {
      cv.classList.add("panning");
      mm.view.px = drag.px + dx; mm.view.py = drag.py + dy;
      applyView();
    }
  });
  var end = function (e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    cv.classList.remove("panning");
    if (cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    if (d.n) {
      d.el.classList.remove("dragging");
      if (d.moved) {
        record({ kind: "move", n: d.n, from: { x: d.ox, y: d.oy }, to: { x: d.n.ox, y: d.n.oy } });
        if (mm.map.sample) mm.map.updatedAt = new Date();
        else saveNode(d.n, { offset_x: Math.round(d.n.ox * 10) / 10, offset_y: Math.round(d.n.oy * 10) / 10 });
      } else select(d.n.key);
    } else if (!d.moved) select(null);
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", function (e) {
    var el = e.target.closest(".mm-node"); if (!el) return;
    var n = findNode(el.dataset.key); if (!n) return;
    el.contentEditable = "true";
    el.focus();
    document.getSelection().selectAllChildren(el);
    var finished = false;
    var done = function (save) {
      if (finished) return;
      finished = true;
      el.contentEditable = "false";
      var t = el.textContent.trim().slice(0, 500);
      if (save && t && t !== n.label) { record({ kind: "label", n: n, from: n.label, to: t }); setLabel(n, t, true); }
      draw(); renderNodePanel();
    };
    el.onkeydown = function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); done(true); }
      if (ev.key === "Escape") { ev.preventDefault(); done(false); }
    };
    el.onblur = function () { done(true); };
  });
  // Lăn chuột + Ctrl = phóng to/thu nhỏ quanh con trỏ; lăn thường = cuộn khung.
  cv.addEventListener("wheel", function (e) {
    if (e.target.closest(".mm-npanel")) return;
    e.preventDefault();
    var v = mm.view;
    if (e.ctrlKey) {
      var r = cv.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      var z = Math.max(Z_MIN, Math.min(Z_MAX, Math.round(v.z * (e.deltaY < 0 ? 1.1 : 0.9) * 100) / 100));
      v.px = cx - (cx - v.px) * z / v.z; v.py = cy - (cy - v.py) * z / v.z; v.z = z;
    } else { v.px -= e.deltaX; v.py -= e.deltaY; }
    applyView();
  }, { passive: false });
}

/* ====================================================================
   Gắn sự kiện — gọi 1 lần từ init() của ghichu.js
   ==================================================================== */
export function initMindmap() {
  // UC-35: "Báo nội dung sai" ở bảng Node đang chọn
  $("mm-np-report").addEventListener("click", function () {
    var o = mm.sel != null ? nodeInfo(mm.sel) : null;
    if (!o) return;
    var n = o.n;
    hooks.reportContent({
      title: "Node sơ đồ sai: " + n.label.slice(0, 80), context: ["Sơ đồ tư duy", mm.map.title, o.d === 0 ? "Gốc" : "Nhánh " + branchOf(o).label],
      quote_heading: "Node “" + n.label + "”", quote_text: n.cite && n.cite.quote ? "Nguồn: " + n.cite.quote : n.label,
      ref_type: n.id != null ? "mindmap_node" : null, ref_id: n.id != null ? n.id : null,
    });
  });
  form.bind();
  $("mm-back-btn").addEventListener("click", function (e) { e.stopPropagation(); onClose(); });

  $("mm-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]"); if (!b) return;
    if (b.dataset.tab === "saved") { refreshSaved(); show("saved"); }
    else { form.initSource(); show("setup"); }
  });

  // --- Tạo mới ---
  $("mm-depth-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b || mm.job) return;
    mm.depth = Number(b.dataset.v);
    renderSetup();
  });
  $("mm-method-box").addEventListener("click", function (e) {
    var r = e.target.closest(".mm-opt-row"); if (!r || mm.job) return;
    mm.method = r.dataset.v;
    renderSetup();
  });
  $("mm-layout-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b || mm.job) return;
    mm.layout = b.dataset.v;
    renderSetup();
  });
  $("mm-opts").addEventListener("click", function (e) {
    var r = e.target.closest(".mm-sw-row"); if (!r || mm.job) return;
    mm.opts[r.dataset.k] = !mm.opts[r.dataset.k];
    renderSetup();
  });
  $("mm-panel").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cancel") cancelJob();
    else if (b.dataset.act === "again") resetJob();
    else if (b.dataset.act === "start" && mm.job && mm.job.map) { var m = mm.job.map; resetJob(); openMap(m); }
  });
  $("mm-create").addEventListener("click", createMap);

  // --- Đã tạo ---
  initSavedList();

  // --- Khung vẽ ---
  bindCanvas();
  $("mm-done").addEventListener("click", finishEditing);
  $("mm-map-name").addEventListener("input", function (e) { setTitle(e.target.value); });
  $("mm-map-name").addEventListener("keydown", function (e) { if (e.key === "Enter") e.target.blur(); });
  $("mm-z-in").addEventListener("click", function () { zoomBy(0.1); });
  $("mm-z-out").addEventListener("click", function () { zoomBy(-0.1); });
  $("mm-fit").addEventListener("click", function () { fitView(); });
  $("mm-undo").addEventListener("click", undo);
  $("mm-redo").addEventListener("click", redo);
  $("mm-add-node").addEventListener("click", function () { addChild(mm.sel != null ? mm.sel : mm.map.root.key); });
  $("mm-pick-other").addEventListener("click", function () {
    form.initSource();
    show("setup");
    toast("Chọn nguồn khác hoặc dùng “Hệ thống tự phân tích nội dung”.");
  });
  $("mm-np-close").addEventListener("click", function () { select(null); });
  $("mm-np-text").addEventListener("input", function (e) {
    var o = nodeInfo(mm.sel); if (!o) return;
    var v = e.target.value.slice(0, 500);
    o.el.textContent = v || " ";
    if (v.trim()) setLabel(o.n, v.trim(), false);
  });
  // Cả lượt gõ ở ô này (vào ô -> rời ô) là 1 bước hoàn tác; trong lúc đang gõ, Ctrl+Z là hoàn tác chữ của ô nhập.
  $("mm-np-text").addEventListener("focus", function () {
    var o = nodeInfo(mm.sel);
    mm.labelStart = o ? { n: o.n, v: o.n.label } : null;
  });
  $("mm-np-text").addEventListener("change", function () {
    var st = mm.labelStart;
    mm.labelStart = null;
    if (st && st.n.label !== st.v) record({ kind: "label", n: st.n, from: st.v, to: st.n.label });
    if (mm.sel != null) { draw(); renderNodePanel(); }
  });
  $("mm-np-text").addEventListener("keydown", function (e) { if (e.key === "Enter") e.target.blur(); });
  $("mm-np-add").addEventListener("click", function () { if (mm.sel != null) addChild(mm.sel); });
  $("mm-np-del").addEventListener("click", deleteSelected);
  $("mm-np-src").addEventListener("click", function () {
    var o = nodeInfo(mm.sel); if (!o || !o.n.cite) return;
    var c = o.n.cite;
    if (!c.chapter_id && !c.document_id) return;
    flushPending();
    hooks.openSource({ subject_id: mm.map.subjectId, chapter_id: c.chapter_id, document_id: c.document_id, page: c.page, quote: c.quote });
  });
  $("mm-np-ask").addEventListener("click", function () {
    var o = nodeInfo(mm.sel); if (!o) return;
    var br = o.d > 1 ? branchOf(o).label : "";
    flushPending();
    hooks.askAbout("Giải thích giúp tôi về “" + o.n.label + "”" + (br ? " (thuộc " + br + ")" : "") + ".");
  });
  document.addEventListener("keydown", function (e) {
    if (!mm.open || mm.screen !== "canvas" || !mm.map) return;
    var t = e.target;
    // Đang gõ trong ô nhập / node đang sửa: để trình duyệt tự hoàn tác chữ trong ô đó.
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var k = (e.key || "").toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === "z" || k === "y")) {
      e.preventDefault();
      if (k === "z" && !e.shiftKey) undo(); else redo();   // Ctrl+Y hoặc Ctrl+Shift+Z = làm lại
      return;
    }
    if (e.key === "Escape" && mm.sel != null) select(null);
  });
  window.addEventListener("beforeunload", flushPending);
}
