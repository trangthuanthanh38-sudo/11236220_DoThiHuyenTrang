/* ======================================================================
   ghichu_tomtat.js — MODULE "Tạo bản tóm tắt" (UC-24, Studio AI). HTML ở html/ghichu_tomtat.frag
   (nạp vào #mount-tomtat-pane), style ở css/ghichu_tomtat.css (tiền tố `ts-`).
   Bố cục/luồng theo giao diện mẫu `tom-tat.html` — cùng khuôn với Ôn tập / Thi thử / Flashcard / Sơ đồ:
     Tạo mới  — chọn Môn + ĐÚNG 1 Chương hoặc 1 Tệp PDF (chip radio — form chung ghichu_studio_form.js
                chỉ có chip tick nhiều nên phần chọn nguồn vẽ riêng ở đây), tên (bắt buộc — quy tắc chung:
                mở form để trống, bấm chọn nguồn thì tự điền tên nguồn, không tiền tố), Độ dài Ngắn/Vừa/Chi
                tiết, Định dạng Gạch đầu dòng/Đoạn văn, 3 công tắc "Giữ lại", ô "Đang tạo" (bước đổi theo
                THỜI GIAN chờ, Hủy = AbortController). UC-24 E1: nguồn < MIN_WORDS từ -> ô nguồn viền đỏ, khoá
                phần thiết lập, "+ Thêm nội dung vào chương" mở Chương ở Notebook.
     Đã tạo   — bảng: tên + nguồn (+ nhãn "Nội dung gốc đã thay đổi"), Độ dài, Định dạng, Cập nhật,
                "Tạo lại" (chỉ khi đã thay đổi), Mở, xoá.
     Xem      — 2 cột: Bản tóm tắt (mục -> ý, số trích dẫn liên tục; Tạo lại ghi đè tại chỗ) | Nội dung
                gốc (Chương: đoạn chứa câu trích được tô sáng; PDF hoặc nguồn đã xoá: danh sách đoạn trích
                theo trang). Tên sửa tại chỗ ("Đã lưu lúc"), Xuất PDF (UC-24 4a — tải thẳng file .pdf, html2canvas + jsPDF, không lưu).

   Database: studio_tools_summary_schema.sql (summaries / summary_sections / summary_points /
   summary_generations). Backend: backend/app/routers/summaries.py + services/summary_generation.py (1 lượt Gemini/bản,
   chuỗi QUIZ_MODEL; máy chủ cũ trả 404 thì báo "API /summaries chưa được nối"). Đổi field nào thì sửa normalizeSum() /
   listRow() và schemas.py (Summary*):
     POST   /summaries {subject_id, source_type:'CHAPTER'|'PDF', source_id, title, length:'short'|'medium'|'long',
                        format:'bullet'|'paragraph', keep_definitions, keep_numbers, keep_examples} -> chi tiết
     GET    /summaries          -> [{id, title, subject_id, source_type, chapter_id, document_id, source_label,
                                     length, format, is_stale, updated_seconds_ago}]
     GET    /summaries/{id}     -> {id, title, subject_id, source_type, chapter_id, document_id, source_label, length,
                                     format, keep_definitions, keep_numbers, keep_examples, is_stale, updated_seconds_ago,
                                     sections:[{position, heading, kind, points:[{position, content, page_number, quote}]}]}
     PATCH  /summaries/{id} {title}            -> {updated_seconds_ago}
     POST   /summaries/{id}/regenerate         -> chi tiết (ghi đè tại chỗ, giữ id/tên)
     DELETE /summaries/{id}
   chapter_id/document_id = null khi nguồn đã bị xoá (FK SET NULL) -> không Tạo lại được. `is_stale` do server
   so SHA-256 nội dung hiện tại với summaries.source_text_hash. Đo độ dài nguồn (E1): POST /quiz/source-stats
   mode 'summary' (word_count; backend cũng chặn < MIN_WORDS -> 400). Nội dung Chương ở cột phải: GET /chapters/{id}
   (content_text) có sẵn.

   Khi CHƯA đăng nhập ("chế độ mẫu", isOnline()) thì "Tạo tóm tắt" dựng bản MINH HOẠ cục bộ từ nội dung
   Chương trong trình soạn thảo (câu đầu mỗi đoạn, chia mục theo tiêu đề — không gọi API, mất khi tải
   lại); tệp PDF không đọc được ở chế độ này. Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi
   `ts.open` rồi gọi hooks.syncLayout().
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, closeDropdownEl, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";
import { pad, agoDate, fmtDay, apiErrorText } from "./ghichu_studio_form.js";
import { SOURCE_KINDS, isReal } from "./ghichu_nguon.js";

var MIN_WORDS = 500;   // UC-24 E1 — dưới mức này không đủ để tóm tắt có ý nghĩa
var LEN = {
  short: { name: "Ngắn", note: "Khoảng nửa trang · 5–7 ý chính", max: 7 },
  medium: { name: "Vừa", note: "Khoảng 1 trang · 10–15 ý chính", max: 15 },
  long: { name: "Chi tiết", note: "Khoảng 2–3 trang · 20–30 ý chính", max: 30 },
};
var FMT = { bullet: "Gạch đầu dòng", paragraph: "Đoạn văn" };
var STEPS = ["Đọc nội dung nguồn", "Tìm ý chính, định nghĩa", "Viết bản tóm tắt", "Gắn trích dẫn từng ý"];

// Nhớ bản tóm tắt đang xem để F5 rồi vẫn mở lại đúng bản (xoá khi rời màn xem bằng × / Xong).
var RESUME_KEY = "td_ts_resume";
function saveResume(id) { try { localStorage.setItem(RESUME_KEY, String(id)); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return localStorage.getItem(RESUME_KEY); } catch (e) { return null; } }

/* ---------------- state riêng của module ---------------- */
var ts = {
  open: false,
  screen: "setup",          // setup | saved | view
  // --- Tạo mới ---
  subjectId: null,
  pick: null,               // {kind:'chapter'|'pdf', id} — đúng 1 nguồn
  name: "", nameTouched: false, picking: false,
  len: "medium", fmt: "bullet",
  keep: { def: true, num: true, ex: false },   // summaries.keep_definitions / keep_numbers / keep_examples
  stats: null,              // {key, words (null = chưa biết), loading}
  job: null,                // ô "Đang tạo": {t0, controller, timer, done, sum}
  error: "",
  // --- Đã tạo ---
  saved: null, savedError: "",
  samples: [],              // chế độ mẫu: các bản minh hoạ trong phiên
  busy: {},                 // id -> true khi đang Tạo lại từ bảng
  lq: "", lf: "all", lsort: "new", lpage: 0, lmenu: null,   // tab Đã tạo: tìm, lọc, sắp xếp, trang, menu "···" đang mở
  pendingDel: null,         // {m, timer} — vừa xoá, còn "Hoàn tác" được (DELETE chưa gửi)
  // --- Xem ---
  sum: null,                // normalizeSum()
  active: null,             // số trích dẫn đang chọn
  src: null,                // nội dung Chương cột phải: {key, paras, loading, error}
  regen: false,
  savedAt: null, saveErr: "",
  titleTimer: 0,
  sync: Promise.resolve(),
  pdf: { paper: "A4", cite: true, notes: false },
};
var uid = 1;

export function isOpen() { return ts.open; }

/* ====================================================================
   Mở / đóng
   ==================================================================== */
// Bấm thẻ "Tạo bản tóm tắt": GIỮ NGUYÊN trang đang dở (vd. vừa bấm "Mở trong Notebook" rồi quay lại).
export function openTomtat() {
  ts.open = true;
  state.dd = null;
  closeDropdownEl();
  initSource();
  hooks.syncLayout();
  if (!ts.sum && readResume() && isOnline()) { resumeIfNeeded(); return; }
  if (ts.screen === "view" && !ts.sum) ts.screen = "setup";
  show(ts.screen);
  refreshSaved();
}

// Ẩn màn Tóm tắt (chuyển công cụ / mở nguồn). Bản đang xem giữ nguyên.
export function closeTomtat() {
  flushTitle();
  commitDelete();
  ts.lmenu = null;
  closePdf();
  ts.open = false;
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
}

// F5 khi đang xem 1 bản tóm tắt -> mở lại đúng bản đó (bản mẫu không sống qua F5).
export function resumeIfNeeded() {
  var id = readResume();
  if (!id) return;
  if (!isOnline()) { clearResume(); return; }
  apiAuth("GET", "/summaries/" + encodeURIComponent(id), authToken()).then(function (res) {
    if (!res.ok) { clearResume(); return; }
    ts.open = true;
    initSource();
    hooks.syncLayout();
    openSum(normalizeSum(res.data));
    refreshSaved();
  });
}

function show(screen) {
  ts.screen = screen;
  render();
  if (screen !== "view") $("ts-body").scrollTop = 0;
}

// `act` (tuỳ chọn): {label, fn, ms} — nút trong toast, vd. "Hoàn tác" sau khi xoá.
function toast(msg, act) {
  var t = $("ts-toast");
  t.textContent = msg; t.hidden = false;
  if (act) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = act.label;
    b.onclick = function () { t.hidden = true; act.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { t.hidden = true; }, act && act.ms ? act.ms : 3200);
}

function render() {
  if (!ts.open) return;
  var sc = ts.screen, view = sc === "view";
  ["setup", "saved", "view"].forEach(function (s) { $("ts-s-" + s).hidden = s !== sc; });
  $("ts-tabbar").hidden = view;
  Array.prototype.forEach.call($("ts-tabs").children, function (b) {
    b.classList.toggle("on", (b.dataset.tab === "new" ? "setup" : "saved") === sc);
  });
  var n = savedList().length;
  $("ts-saved-count").textContent = n ? n : "";
  $("ts-create").hidden = sc !== "setup";
  $("ts-title").hidden = view;
  ["ts-sum-name", "ts-saved", "ts-pdf-btn", "ts-done"].forEach(function (id) { $(id).hidden = !view; });
  if (sc === "setup") renderSetup();
  else if (sc === "saved") renderSaved();
  else renderView();
}

// Nút × : Tạo mới / Đã tạo -> về Notebook; màn xem -> Đã tạo.
function onClose() {
  if (ts.screen === "view") { finishView(); return; }
  closeTomtat();
}

/* ====================================================================
   TẠO MỚI — chọn 1 nguồn, tên, độ dài, định dạng, giữ lại; POST /summaries
   ==================================================================== */
function realSubjects() { return state.subjects.filter(isReal); }
function currentSubject() { return realSubjects().find(function (s) { return s.id === ts.subjectId; }) || null; }
// Chương + PDF của Môn, theo thứ tự SOURCE_KINDS (Chương trước, PDF sau).
function subjectItems(sub) {
  var out = [];
  if (!sub) return out;
  SOURCE_KINDS.forEach(function (k) {
    k.items(sub).filter(isReal).forEach(function (item) { out.push({ kind: k.kind, apiType: k.apiType, item: item }); });
  });
  return out;
}
function pickedItem() {
  if (!ts.pick) return null;
  return subjectItems(currentSubject()).find(function (x) { return x.kind === ts.pick.kind && x.item.id === ts.pick.id; }) || null;
}
function sourceName(x) { return x ? x.item.name.replace(/\.pdf$/i, "") : ""; }

// Giữ Môn/nguồn đã chọn nếu còn; chưa có thì lấy Môn + Chương/PDF đang mở ở Notebook (không tự điền tên).
function initSource() {
  var sub = currentSubject();
  if (!sub) {
    ts.pick = null;
    var act = state.active;
    sub = (act && realSubjects().find(function (s) { return s.id === act.s; })) || realSubjects()[0] || null;
    ts.subjectId = sub ? sub.id : null;
    if (sub && act && act.s === sub.id && (act.kind === "chapter" || act.kind === "pdf")) ts.pick = { kind: act.kind, id: act.id };
  }
  if (!pickedItem()) ts.pick = null;
  loadStats();
}

function pickSource(kind, id, byUser) {
  ts.pick = { kind: kind, id: id };
  if (byUser) {
    ts.picking = true;
    if (!ts.nameTouched) ts.name = sourceName(pickedItem());
  }
  loadStats();
}

/* ---------- Độ dài nguồn (UC-24 E1) ---------- */
function htmlBlocks(html) {
  var doc = new DOMParser().parseFromString(html || "", "text/html");
  var sel = "h1,h2,h3,h4,p,li,blockquote,pre,td";
  var out = [];
  doc.body.querySelectorAll(sel).forEach(function (el) {
    if (el.parentElement && el.parentElement.closest(sel)) return; // khối lồng (p trong li...) đã tính ở khối cha
    var t = el.textContent.replace(/\s+/g, " ").trim();
    if (t) out.push({ heading: /^H[1-4]$/.test(el.tagName), text: t });
  });
  return out;
}
// chapters.content_text (và chunk tạo từ nó) giữ nguyên thực thể HTML thô ("&nbsp;", "&amp;"...) vì backend chỉ bỏ thẻ
// -> câu trích có thể chứa chúng: giải mã trước khi hiển thị / so khớp với đoạn gốc.
function decodeEntities(t) {
  t = String(t || "");
  if (!/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/i.test(t)) return t;
  return new DOMParser().parseFromString("<body>" + t.replace(/</g, "&lt;"), "text/html").body.textContent;
}
function countWords(text) { return text ? text.split(/\s+/).filter(Boolean).length : 0; }
function localChapterBlocks(chapterId) { return htmlBlocks(state.docs[chapterId] || ""); }
function localChapterText(chapterId) { return localChapterBlocks(chapterId).map(function (b) { return b.text; }).join("\n"); }

function loadStats() {
  var x = pickedItem();
  if (!x) { ts.stats = null; return; }
  var key = x.kind + ":" + x.item.id;
  if (!isOnline()) {
    ts.stats = { key: key, loading: false, words: x.kind === "chapter" ? countWords(localChapterText(x.item.id)) : null, offlinePdf: x.kind === "pdf" };
    return;
  }
  if (ts.stats && ts.stats.key === key) return;
  ts.stats = { key: key, words: null, loading: true };
  var body = { subject_id: ts.subjectId, sources: [{ source_type: x.apiType, id: x.item.id }], mode: "summary" };
  apiAuth("POST", "/quiz/source-stats", authToken(), body).then(function (res) {
    if (!ts.stats || ts.stats.key !== key) return; // đã đổi nguồn trong lúc chờ
    // Lỗi đo -> không chặn ở client (backend vẫn kiểm BR-07/E1 khi tạo).
    ts.stats = { key: key, loading: false, words: res.ok && res.data ? Number(res.data.word_count) || 0 : null };
    if (ts.open && ts.screen === "setup") renderSetup();
  });
}

// Thông báo E1 ("" = đủ dài hoặc chưa biết).
function shortError() {
  var st = ts.stats, x = pickedItem();
  if (!st || st.loading || !x) return "";
  if (st.offlinePdf) return "Chế độ mẫu chưa đọc được nội dung tệp PDF. Đăng nhập để tóm tắt tệp PDF.";
  if (st.words == null || st.words >= MIN_WORDS) return "";
  var what = x.kind === "pdf" ? "Tệp PDF này" : "Chương này";
  return st.words ? what + " chỉ có khoảng " + st.words.toLocaleString("vi-VN") + " từ, chưa đủ để tóm tắt."
    : x.kind === "pdf" ? "Tệp PDF này chưa có nội dung nào sẵn sàng cho AI (không trích được chữ)."
    : "Chương này chưa có nội dung nào để tóm tắt.";
}

function renderSource() {
  var sub = currentSubject();
  $("ts-subject-name").textContent = sub ? sub.name : "Chưa có Môn học";
  var items = subjectItems(sub);
  $("ts-src-list").innerHTML = items.length ? items.map(function (x) {
    var on = !!ts.pick && ts.pick.kind === x.kind && ts.pick.id === x.item.id;
    return '<button type="button" class="ts-chip' + (on ? " on" : "") + '" data-kind="' + x.kind + '" data-id="' + esc(x.item.id) +
      '" role="radio" aria-checked="' + on + '" title="' + esc(x.item.name) + '"><span class="ts-radio"></span><span class="nm">' +
      esc(x.item.name) + "</span>" + (x.kind === "pdf" ? '<span class="kd">PDF</span>' : "") + "</button>";
  }).join("") : '<div class="ts-chips-empty">' + (sub
    ? "Môn này chưa có Chương hay tệp PDF nào — thêm nội dung ở Notebook trước."
    : "Chưa có Môn học nào trong Notebook.") + "</div>";
  var x = pickedItem(), st = ts.stats;
  $("ts-src-info").textContent = !x ? "Chưa chọn nguồn"
    : st && st.loading ? "Đang đo độ dài…"
    : st && st.words != null ? st.words.toLocaleString("vi-VN") + " từ" : "";
  var err = shortError();
  $("ts-src-box").classList.toggle("err", !!err);
  $("ts-src-foot").hidden = !!err;
  $("ts-src-err").hidden = !err;
  $("ts-src-err-text").textContent = err;
  $("ts-add-note").hidden = !x || x.kind !== "chapter";
  $("ts-settings").classList.toggle("ts-dim", !!err);
  $("ts-keep-box").classList.toggle("ts-dim", !!err);
}

function renderSetup() {
  var busy = !!ts.job;
  $("ts-main").classList.toggle("ts-locked", busy);
  $("ts-keep-box").style.pointerEvents = busy ? "none" : "";
  renderSource();
  var nameIn = $("ts-name");
  if (document.activeElement !== nameIn) nameIn.value = ts.name;
  Array.prototype.forEach.call($("ts-len-seg").children, function (b) { b.classList.toggle("on", b.dataset.v === ts.len); });
  $("ts-len-note").textContent = LEN[ts.len].note;
  Array.prototype.forEach.call($("ts-fmt-seg").children, function (b) {
    var on = b.dataset.v === ts.fmt;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("ts-keep-box").querySelectorAll(".ts-sw-row").forEach(function (r) {
    r.classList.toggle("on", !!ts.keep[r.dataset.k]);
    r.setAttribute("aria-pressed", String(!!ts.keep[r.dataset.k]));
  });
  validate();
  renderPanel();
}

// true khi đủ điều kiện bấm "Tạo tóm tắt"; đồng thời tô lỗi tên + trạng thái nút.
function validate() {
  var x = pickedItem(), loading = !!(ts.stats && ts.stats.loading);
  var srcOk = !!x && !shortError();
  var nameOk = ts.name.trim() !== "";
  $("ts-f-name").classList.toggle("err", !nameOk && srcOk && ts.picking);
  var j = ts.job, ok = srcOk && nameOk && !loading && !j;
  var btn = $("ts-create");
  btn.disabled = !ok;
  btn.classList.toggle("busy", !!(j && !j.done));
  btn.innerHTML = j && !j.done ? '<span class="ts-spin"></span>Đang tạo' : "Tạo tóm tắt";
  return ok;
}

/* ---------- Ô "Đang tạo" — bước đổi theo THỜI GIAN chờ (tạo là 1 request đồng bộ, không có %) ---------- */
var CHECK_SVG = '<svg width="9" height="7" viewBox="0 0 12 10" fill="none"><path d="M1 5.2 4.3 8.5 11 1.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="color:var(--ts-on-primary)"/></svg>';
function jobStep(j) {
  var sec = (Date.now() - j.t0) / 1000;
  return sec < 3 ? 0 : sec < 9 ? 1 : sec < 18 ? 2 : 3;
}
function renderPanel() {
  var p = $("ts-panel"), j = ts.job;
  p.classList.toggle("run", !!j);
  if (!j) {
    p.innerHTML = '<span class="ts-h3">Đang tạo</span>' + (ts.error
      ? '<p class="ts-red">' + esc(ts.error) + "</p>"
      : '<p class="ts-muted">Chưa có bản tóm tắt nào đang tạo. Tiến độ sẽ hiện ở đây sau khi bạn bấm Tạo tóm tắt.</p>') +
      (isOnline() ? "" : '<p class="ts-muted">Chế độ mẫu: bản tóm tắt được dựng minh hoạ từ câu đầu mỗi đoạn của chương và mất khi tải lại trang. Đăng nhập để AI tóm tắt từ nội dung của bạn.</p>');
  } else if (j.done) {
    p.innerHTML = '<div class="ts-p-head"><span class="ts-h3">Đã tạo xong</span><span class="ts-h3" style="color:var(--ts-green)">✓</span></div>' +
      '<div class="ts-pbar"><i></i></div><div class="ts-ready"><p><b style="font-weight:500">' + esc(j.sum.title) + '</b><br><span class="ts-muted">' +
      countPoints(j.sum) + " ý · đã lưu vào tab Đã tạo</span></p>" +
      '<div class="acts"><button type="button" class="ts-btn-primary sm" data-act="start">Mở bản tóm tắt</button>' +
      '<button type="button" class="ts-link" data-act="again">Tạo bản khác</button></div></div>';
  } else {
    var step = jobStep(j), sec = Math.floor((Date.now() - j.t0) / 1000);
    p.innerHTML = '<div class="ts-p-head"><span class="ts-h3">Đang tạo</span><span class="ts-muted">' + sec + " giây</span></div>" +
      '<div class="ts-pbar indet"><i></i></div><div class="ts-steps">' + STEPS.map(function (s, i) {
        var cls = step > i ? "done" : step === i ? "now" : "";
        return '<div class="ts-step ' + cls + '"><span class="ic">' + (step > i ? CHECK_SVG : "") + '</span><span class="t">' + s +
          '</span><span class="s">' + (step > i ? "Xong" : "") + "</span></div>";
      }).join("") + "</div>" +
      '<button type="button" class="ts-btn-text" data-act="cancel" style="align-self:flex-start">Hủy</button>';
  }
}

function createSummary() {
  if (ts.job || !validate()) return;
  var x = pickedItem();
  if (!isOnline()) {
    ts.error = "";
    var sm = buildSample({ id: "sample-" + uid++, title: ts.name.trim(), subjectId: ts.subjectId, chapterId: x.item.id,
      sourceLabel: x.item.name, length: ts.len, format: ts.fmt, keep: Object.assign({}, ts.keep) });
    ts.samples.unshift(sm);
    resetForm();
    openSum(sm);
    return;
  }
  var body = {
    subject_id: ts.subjectId, source_type: x.apiType, source_id: x.item.id, title: ts.name.trim(),
    length: ts.len, format: ts.fmt, keep_definitions: ts.keep.def, keep_numbers: ts.keep.num, keep_examples: ts.keep.ex,
  };
  var controller = window.AbortController ? new AbortController() : null;
  var job = { t0: Date.now(), controller: controller, done: false };
  ts.job = job; ts.error = "";
  job.timer = setInterval(function () { if (ts.open && ts.screen === "setup") renderPanel(); }, 1000);
  renderSetup();

  apiAuth("POST", "/summaries", authToken(), body, controller ? controller.signal : undefined).then(function (res) {
    if (ts.job !== job) return; // đã bấm Hủy
    clearInterval(job.timer);
    if (res.ok && res.data) {
      var sum = normalizeSum(res.data);
      refreshSaved();
      if (ts.open && ts.screen === "setup") { ts.job = null; resetForm(); openSum(sum); return; }
      job.done = true;
      job.sum = sum;
      if (ts.open) toast("Đã tạo xong “" + sum.title + "” — xem ở tab Đã tạo.");
    } else {
      ts.job = null;
      ts.error = apiErrorText(res, "/summaries", "Không tạo được bản tóm tắt.");
    }
    if (ts.open && ts.screen === "setup") renderSetup();
  });
}

function cancelJob() {
  var j = ts.job;
  if (!j || j.done) return;
  clearInterval(j.timer);
  if (j.controller) j.controller.abort();
  ts.job = null;
  renderSetup();
  toast("Đã ngừng chờ. Nếu máy chủ đã kịp tạo xong, bản tóm tắt vẫn sẽ hiện ở tab Đã tạo.");
  setTimeout(refreshSaved, 20000); // server vẫn có thể đang tạo nốt
}

function resetForm() { ts.name = ""; ts.nameTouched = false; ts.picking = false; }
function resetJob() {
  ts.job = null; ts.error = "";
  resetForm();
  if (ts.open && ts.screen === "setup") renderSetup();
}

/* ====================================================================
   Dữ liệu bản tóm tắt
   ==================================================================== */
// Chuẩn hoá phản hồi API (tách khỏi tên cột backend). Số trích dẫn đánh liên tục theo mục rồi ý.
function normalizeSum(d) {
  var byPos = function (a, b) { return (a.position || 0) - (b.position || 0); };
  var sections = (d.sections || []).slice().sort(byPos).map(function (s) {
    return {
      heading: s.heading || "", kind: s.kind || "general",
      points: (s.points || []).slice().sort(byPos).map(function (p) {
        return { content: decodeEntities(p.content), page: p.page_number || null, quote: decodeEntities(p.quote) };
      }),
    };
  });
  return number({
    id: d.id, title: d.title || "Bản tóm tắt", subjectId: d.subject_id,
    sourceType: d.source_type === "PDF" ? "PDF" : "CHAPTER", chapterId: d.chapter_id || null, documentId: d.document_id || null,
    sourceLabel: d.source_label || "", length: LEN[d.length] ? d.length : "medium", format: FMT[d.format] ? d.format : "bullet",
    keep: { def: d.keep_definitions !== false, num: d.keep_numbers !== false, ex: !!d.keep_examples },
    stale: !!d.is_stale, sample: false, sections: sections,
    updatedAt: d.updated_seconds_ago != null ? agoDate(d.updated_seconds_ago) : new Date(),
  });
}
function number(sum) {
  var n = 0;
  sum.sections.forEach(function (s) { s.points.forEach(function (p) { p.n = ++n; }); });
  sum.sections = sum.sections.filter(function (s) { return s.points.length; });
  return sum;
}
function allPoints(sum) { return sum.sections.reduce(function (a, s) { return a.concat(s.points); }, []); }
function countPoints(sum) { return allPoints(sum).length; }
function pointByN(n) { return ts.sum ? allPoints(ts.sum).find(function (p) { return p.n === n; }) || null : null; }

// Nguồn còn tồn tại? (null id = đã bị xoá, FK SET NULL). Chế độ mẫu: Chương còn trong cây cục bộ.
function sourceAlive(sum) {
  if (!sum.sample) return !!(sum.chapterId || sum.documentId);
  return state.subjects.some(function (s) { return (s.chapters || []).some(function (c) { return c.id === sum.chapterId; }); });
}

/* ---------- Bản minh hoạ (chế độ mẫu) — trích câu đầu mỗi đoạn, chia mục theo tiêu đề ---------- */
function firstSentence(t) {
  var m = t.match(/^.+?[.!?…](?=\s|$)/);
  return (m ? m[0] : t).trim();
}
function buildSample(base) {
  var blocks = localChapterBlocks(base.chapterId);
  var heads = [], cur = { heading: "Ý chính", kind: "general", points: [] }, defs = [], exs = [];
  heads.push(cur);
  blocks.forEach(function (b) {
    if (b.heading) { cur = { heading: b.text.slice(0, 120), kind: "general", points: [] }; heads.push(cur); return; }
    var s = firstSentence(b.text), pt = { content: s, page: null, quote: s };
    if (/^ví dụ/i.test(s)) { if (base.keep.ex) exs.push(pt); return; }
    if (/\d/.test(s) && !base.keep.num) return;
    if (/\s(là|được gọi là|nghĩa là)\s/i.test(s) && base.keep.def) { defs.push(pt); return; }
    cur.points.push(pt);
  });
  var sections = heads.concat(
    defs.length ? [{ heading: "Định nghĩa quan trọng", kind: "definition", points: defs }] : [],
    exs.length ? [{ heading: "Ví dụ minh họa", kind: "example", points: exs }] : []);
  // Cắt theo Độ dài: giữ các ý rải đều trên cả chương để mục nào cũng còn đại diện.
  var flat = [];
  sections.forEach(function (s, si) { s.points.forEach(function (p) { flat.push({ si: si, p: p }); }); });
  var max = LEN[base.length].max;
  if (flat.length > max) {
    var keep = new Set();
    for (var i = 0; i < max; i++) keep.add(flat[Math.floor(i * flat.length / max)].p);
    sections.forEach(function (s) { s.points = s.points.filter(function (p) { return keep.has(p); }); });
  }
  return number(Object.assign(base, {
    sourceType: "CHAPTER", documentId: null, stale: false, sample: true, sections: sections,
    sig: localChapterText(base.chapterId), updatedAt: new Date(),
  }));
}
function sampleStale(sm) { return sourceAlive(sm) && localChapterText(sm.chapterId) !== sm.sig; }

/* ====================================================================
   ĐÃ TẠO — bảng (GET /summaries)
   ==================================================================== */
function listRow(m) { // bản mẫu -> cùng shape với GET /summaries
  return { id: m.id, title: m.title, chapter_id: sourceAlive(m) ? m.chapterId : null, document_id: null, source_label: m.sourceLabel,
    length: m.length, format: m.format, is_stale: sampleStale(m), updated_seconds_ago: Math.max(0, (Date.now() - m.updatedAt) / 1000) };
}
function savedList() { return isOnline() ? (ts.saved || []) : ts.samples.map(listRow); }

function refreshSaved() {
  if (!isOnline()) { if (ts.open && ts.screen !== "view") render(); return; }
  apiAuth("GET", "/summaries", authToken()).then(function (res) {
    ts.saved = res.ok && Array.isArray(res.data) ? res.data : (ts.saved || []);
    ts.savedError = res.ok ? "" : apiErrorText(res, "/summaries", "Không tải được danh sách bản tóm tắt.");
    if (ts.open && ts.screen !== "view") render();
  });
}

/* Đã tạo dạng THẺ (mẫu `tom-tat sửa phần đã tạo.html`): mỗi bản 1 thẻ — tên, nguồn, Độ dài · Định dạng, số ý chính · số
   trích dẫn, nhãn "Nội dung gốc đã thay đổi" / "Đã cập nhật theo nội dung gốc", chân "Cập nhật …" + Tạo lại / Mở, menu "···"
   (Mở / Xuất PDF / Tạo lại / Xoá). Tìm theo tên + tên nguồn, lọc "Cần cập nhật", sắp xếp, chia trang 6 ô; ô cuối "Tạo bản tóm
   tắt mới" (chỉ khi không lọc). Xoá có "Hoàn tác" 5 giây: lệnh DELETE chỉ gửi khi hết 5 giây / xoá bản khác / rời màn / đóng
   trang (commitDelete) — API xoá là vĩnh viễn nên không thể khôi phục sau khi đã gửi. */
var SORTS = { new: "Mới cập nhật", old: "Cũ nhất", src: "Theo nguồn", az: "Tên A–Z" };
var PER_OPTS = [6, 9, 12, 24];   // số ô mỗi trang ở Đã tạo — người dùng chọn, nhớ localStorage (như ghichu_cardlist.js)
var PER = getPerPage("cl_tomtat", 6, PER_OPTS);
var CARD_IC = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 5h12M4 9h12M4 13h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function listItems() {
  var q = ts.lq.trim().toLowerCase(), pend = ts.pendingDel && String(ts.pendingDel.m.id);
  var a = savedList().filter(function (m) {
    return String(m.id) !== pend && (ts.lf === "all" || m.is_stale) &&
      (!q || (m.title + " " + (m.source_label || "")).toLowerCase().indexOf(q) >= 0);
  });
  var cmp = {
    new: function (x, y) { return x.updated_seconds_ago - y.updated_seconds_ago; },
    old: function (x, y) { return y.updated_seconds_ago - x.updated_seconds_ago; },
    src: function (x, y) { return (x.source_label || "").localeCompare(y.source_label || "", "vi", { numeric: true }) || x.updated_seconds_ago - y.updated_seconds_ago; },
    az: function (x, y) { return x.title.localeCompare(y.title, "vi", { numeric: true }); },
  }[ts.lsort];
  return a.sort(cmp);
}

function cardHtml(m) {
  var mid = esc(m.id), alive = !!(m.chapter_id || m.document_id), busy = ts.busy[m.id];
  var badge = busy ? '<span class="ts-badge">Đang cập nhật…</span>'
    : m.is_stale ? '<span class="ts-badge stale">Nội dung gốc đã thay đổi</span>'
    : !alive ? '<span class="ts-badge gone">Nguồn đã bị xoá</span>'
    : '<span class="ts-badge">Đã cập nhật theo nội dung gốc</span>';
  var foot = busy ? '<span class="ts-cbusy"><span class="ts-spin ts-spin--ink"></span>Đang tạo lại…</span>'
    : (m.is_stale && alive ? '<button type="button" class="ts-link" data-act="regen">Tạo lại</button>' : "") +
      '<button type="button" class="ts-link" data-act="open">Mở</button>';
  var menu = ts.lmenu === String(m.id)
    ? '<div class="ts-cmenu" role="menu"><button type="button" data-m="open">Mở</button><button type="button" data-m="pdf">Xuất PDF</button>' +
      '<button type="button" data-m="regen"' + (alive ? "" : " disabled") + '>Tạo lại theo nội dung gốc mới nhất</button>' +
      '<button type="button" data-m="del" class="del">Xoá bản tóm tắt</button></div>'
    : "";
  return '<div class="ts-scard" data-row="' + mid + '" role="button" tabindex="0">' +
    '<div class="sh"><span class="ic">' + CARD_IC + '</span><b title="' + esc(m.title) + '">' + esc(m.title) + "</b>" +
    '<button type="button" class="more" data-more="' + mid + '" aria-label="Thao tác khác" aria-haspopup="menu">···</button></div>' +
    '<div class="sb"><span class="l1" title="' + esc(m.source_label || "") + '">' + (m.source_type === "PDF" ? "Tệp PDF · " : "") + esc(m.source_label || "") + "</span>" +
    '<span class="mu">' + (LEN[m.length] ? LEN[m.length].name : "—") + " · " + (FMT[m.format] || "—") + "</span>" +
    (m.point_count != null ? '<span class="mu">' + m.point_count + " ý chính · " + m.citation_count + " trích dẫn</span>" : "") + badge + "</div>" +
    '<div class="sf"><span class="d">Cập nhật ' + (m.updated_seconds_ago != null ? fmtDay(agoDate(m.updated_seconds_ago)).toLowerCase() : "—") + "</span>" + foot + "</div>" +
    menu + "</div>";
}

function renderSaved() {
  var box = $("ts-saved-list");
  var all = savedList().filter(function (m) { return !ts.pendingDel || String(m.id) !== String(ts.pendingDel.m.id); });
  var nStale = all.filter(function (m) { return m.is_stale; }).length;
  $("ts-f-stale").innerHTML = "Cần cập nhật" + (nStale ? "<i>" + nStale + "</i>" : "");
  Array.prototype.forEach.call(document.querySelectorAll("#ts-s-saved .ts-fpill"), function (b) { b.classList.toggle("on", b.dataset.f === ts.lf); });
  $("ts-sort-name").textContent = SORTS[ts.lsort];
  $("ts-lq-clear").hidden = !ts.lq;
  if (isOnline() && ts.saved === null) { $("ts-pgr").hidden = true; box.innerHTML = '<div class="ts-nores"><p>Đang tải…</p></div>'; return; }
  if (isOnline() && ts.savedError) { $("ts-pgr").hidden = true; box.innerHTML = '<div class="ts-nores"><p>' + esc(ts.savedError) + "</p></div>"; return; }
  var items = listItems(), searching = !!ts.lq.trim() || ts.lf !== "all";
  var tiles = items.map(function (m) { return { m: m }; });
  if (!searching) tiles.push({ add: true });
  var pages = Math.max(1, Math.ceil(tiles.length / PER));
  ts.lpage = Math.min(ts.lpage, pages - 1);
  $("ts-pgr").hidden = pages < 2;
  if (pages > 1) $("ts-pgr").innerHTML = '<button type="button" data-pg="-1" ' + (ts.lpage ? "" : "disabled") + ' aria-label="Trang trước">‹</button>' +
    (ts.lpage + 1) + "/" + pages + '<button type="button" data-pg="1" ' + (ts.lpage < pages - 1 ? "" : "disabled") + ' aria-label="Trang sau">›</button>';
  var html = tiles.slice(ts.lpage * PER, ts.lpage * PER + PER).map(function (t) {
    if (t.add) return '<button type="button" class="ts-snew" data-new><span class="pl"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5v13M1.5 8h13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>' +
      "<b>Tạo bản tóm tắt mới</b><span>Mỗi bản dành cho một chương hoặc một tệp PDF</span>" +
      (!isOnline() ? "<span>Chế độ mẫu: bản minh hoạ chỉ có trong phiên này</span>" : "") + "</button>";
    return cardHtml(t.m);
  }).join("");
  if (!items.length && searching) {
    var onlyStale = ts.lf === "stale" && !ts.lq.trim();
    html = '<div class="ts-nores"><b>' + (onlyStale ? "Tất cả bản tóm tắt đều đã cập nhật theo nội dung gốc" : "Không tìm thấy bản tóm tắt phù hợp") + "</b>" +
      "<p>" + (onlyStale ? "Không có bản nào cần tạo lại." : "Thử từ khoá khác, ví dụ tên chương hoặc tên tệp.") + "</p>" +
      '<button type="button" class="ts-btn-secondary sm" data-reset>Xem tất cả</button></div>';
  }
  box.innerHTML = html;
}

function openSaved(id) {
  if (!isOnline()) {
    var sm = ts.samples.find(function (m) { return m.id === id; });
    if (sm) { sm.stale = sampleStale(sm); openSum(sm); }
    return Promise.resolve();
  }
  return apiAuth("GET", "/summaries/" + encodeURIComponent(id), authToken()).then(function (res) {
    if (!res.ok) { toast(apiErrorText(res, "/summaries/{id}", "Không mở được bản tóm tắt.")); return; }
    openSum(normalizeSum(res.data));
  });
}

// Xoá có Hoàn tác: ẩn thẻ ngay, gửi DELETE sau 5 giây (hoặc sớm hơn — commitDelete).
function deleteSaved(id) {
  var m = savedList().find(function (x) { return String(x.id) === id; });
  if (!m) return;
  commitDelete();
  ts.lmenu = null;
  ts.pendingDel = { m: m, timer: setTimeout(commitDelete, 5000) };
  if (ts.sum && String(ts.sum.id) === id) { ts.sum = null; clearResume(); }
  renderSaved();
  toast("Đã xoá “" + m.title + "”", { label: "Hoàn tác", fn: undoDelete, ms: 5000 });
}
function undoDelete() {
  var d = ts.pendingDel; if (!d) return;
  clearTimeout(d.timer); ts.pendingDel = null;
  if (ts.open && ts.screen === "saved") renderSaved();
}
// `keepalive`: lúc đóng trang (pagehide) — fetch thường bị huỷ khi trang tắt.
function commitDelete(keepalive) {
  var d = ts.pendingDel; if (!d) return;
  clearTimeout(d.timer); ts.pendingDel = null;
  var id = String(d.m.id);
  if (!isOnline()) { ts.samples = ts.samples.filter(function (x) { return x.id !== id; }); return; }
  ts.saved = (ts.saved || []).filter(function (x) { return String(x.id) !== id; });
  if (keepalive) {
    try { fetch(API_BASE + "/summaries/" + encodeURIComponent(id), { method: "DELETE", keepalive: true, headers: { Authorization: "Bearer " + authToken() } }); } catch (e) { /* bỏ qua */ }
    return;
  }
  apiAuth("DELETE", "/summaries/" + encodeURIComponent(id), authToken()).then(function (res) {
    if (!res.ok) toast(apiErrorText(res, "/summaries/{id}", "Không xoá được bản tóm tắt."));
    refreshSaved();
  });
}

// "Tạo lại" ghi đè tại chỗ (giữ id/tên). Trả Promise<sum mới | null>.
function regenerate(id) {
  if (!isOnline()) {
    var sm = ts.samples.find(function (m) { return m.id === id; });
    if (!sm || !sourceAlive(sm)) return Promise.resolve(null);
    var fresh = buildSample({ id: sm.id, title: sm.title, subjectId: sm.subjectId, chapterId: sm.chapterId, sourceLabel: sm.sourceLabel,
      length: sm.length, format: sm.format, keep: sm.keep });
    ts.samples = ts.samples.map(function (m) { return m.id === id ? fresh : m; });
    return new Promise(function (ok) { setTimeout(function () { ok(fresh); }, 700); });
  }
  return apiAuth("POST", "/summaries/" + encodeURIComponent(id) + "/regenerate", authToken()).then(function (res) {
    if (!res.ok || !res.data) { toast(apiErrorText(res, "/summaries/{id}/regenerate", "Không tạo lại được bản tóm tắt — bản cũ được giữ nguyên.")); return null; }
    return normalizeSum(res.data);
  });
}

function regenFromList(id) {
  if (ts.busy[id]) return;
  ts.busy[id] = true;
  ts.lmenu = null;
  renderSaved();
  regenerate(id).then(function (sum) {
    delete ts.busy[id];
    if (sum) toast("Đã tạo lại theo nội dung gốc mới nhất");
    if (isOnline()) refreshSaved(); else if (ts.open && ts.screen === "saved") renderSaved();
  });
}

/* ====================================================================
   XEM SONG SONG
   ==================================================================== */
function openSum(sum) {
  ts.sum = sum;
  ts.active = null;
  ts.saveErr = "";
  ts.savedAt = sum.updatedAt || new Date();
  if (!sum.sample) saveResume(sum.id); else clearResume();
  show("view");
  loadSource();
}

function renderView() {
  var s = ts.sum;
  var nameIn = $("ts-sum-name");
  if (document.activeElement !== nameIn) nameIn.value = s.title;
  renderSavedLabel();
  $("ts-sum-tag").textContent = LEN[s.length].name + " · " + FMT[s.format];
  var alive = sourceAlive(s);
  $("ts-stale-bar").hidden = !s.stale || !alive;
  $("ts-regen-btn").hidden = !alive;
  $("ts-regen-mask").hidden = !ts.regen;
  $("ts-sample-note").hidden = !s.sample;
  $("ts-open-src").hidden = !alive;
  renderSum();
  renderSrc();
}

function renderSavedLabel() {
  var el = $("ts-saved");
  el.classList.toggle("err", !!ts.saveErr);
  if (ts.saveErr) { el.textContent = ts.saveErr; return; }
  var d = ts.savedAt;
  el.textContent = ts.sum && ts.sum.sample ? "Bản minh hoạ · không lưu" : d ? "Đã lưu lúc " + pad(d.getHours()) + ":" + pad(d.getMinutes()) : "";
}

function renderSum() {
  var s = ts.sum;
  var on = function (p) { return ts.active === p.n ? " on" : ""; };
  $("ts-sum-body").innerHTML = s.sections.length ? s.sections.map(function (sec) {
    return '<div class="ts-sec">' + esc(sec.heading) + "</div>" + (s.format === "bullet"
      ? sec.points.map(function (p) {
        return '<button type="button" class="ts-pt' + on(p) + '" data-n="' + p.n + '"><span class="dot"></span><span class="tx">' +
          esc(p.content) + '</span><span class="ts-num">' + p.n + "</span></button>";
      }).join("")
      : '<p class="ts-para">' + sec.points.map(function (p) {
        return '<span class="ts-sent' + on(p) + '" data-n="' + p.n + '">' + esc(p.content) + ' <span class="ts-num">' + p.n + "</span></span>";
      }).join(" ") + "</p>");
  }).join("") : '<p class="ts-empty-sum">Bản tóm tắt này không có ý nào' + (s.sample ? " — chương chưa có đoạn văn phù hợp với các tuỳ chọn đã chọn." : ".") + "</p>";
}

function activate(n) {
  ts.active = ts.active === n ? null : n;
  $("ts-sum-body").querySelectorAll("[data-n]").forEach(function (x) { x.classList.toggle("on", Number(x.dataset.n) === ts.active); });
  renderSrc();
}

/* ---------- Cột "Nội dung gốc" ---------- */
// Chương còn tồn tại -> đọc nội dung (online: GET /chapters/{id}; mẫu: trình soạn thảo cục bộ).
// PDF hoặc nguồn đã xoá -> chỉ hiện các đoạn trích đã lưu cùng bản tóm tắt.
function loadSource() {
  var s = ts.sum;
  if (s.sourceType !== "CHAPTER" || !sourceAlive(s)) { ts.src = null; renderSrc(); return; }
  if (s.sample) { ts.src = { key: s.chapterId, paras: localChapterBlocks(s.chapterId) }; renderSrc(); return; }
  if (ts.src && ts.src.key === s.chapterId && ts.src.paras) { renderSrc(); return; }
  var key = s.chapterId;
  ts.src = { key: key, loading: true };
  renderSrc();
  apiAuth("GET", "/chapters/" + encodeURIComponent(key), authToken()).then(function (res) {
    if (!ts.src || ts.src.key !== key) return;
    // Tách đoạn theo HTML của trình soạn thảo (content_json) — content_text không còn xuống dòng giữa các đoạn
    // (backend gộp khi bỏ thẻ) nên chỉ dùng làm dự phòng khi Chương chưa có content_json.
    var d = res.ok && res.data ? res.data : null;
    var paras = !d ? null : d.content_json ? htmlBlocks(d.content_json)
      : String(d.content_text || "").split(/\n+/).map(function (t) { return { heading: false, text: decodeEntities(t).trim() }; })
        .filter(function (b) { return b.text; });
    ts.src = paras == null ? { key: key, error: apiErrorText(res, "/chapters/{id}", "Không tải được nội dung chương.") }
      : { key: key, paras: paras };
    if (ts.open && ts.screen === "view") renderSrc();
  });
}

var norm = function (t) { return String(t || "").replace(/\s+/g, " ").trim().toLowerCase(); };
// Đoạn gốc chứa câu trích. Chunk được cắt từ văn bản đã gộp các đoạn (cả tiêu đề) nên 1 câu trích có thể vắt qua
// nhiều đoạn, và khi câu AI đưa không khớp nguyên văn thì backend lấy ~300 ký tự đầu chunk + "…" -> thử cả câu,
// rồi lần lượt các khúc 30 ký tự từ đầu tới cuối (đoạn đầu tiên khớp thắng). -1 = không còn trong nội dung hiện tại.
function findQuote(paras, quote) {
  var q = norm(quote).replace(/^…+|…+$/g, "").trim();
  if (!q) return -1;
  var texts = paras.map(function (b) { return norm(b.text); });
  var find = function (part) { return texts.findIndex(function (t) { return t.indexOf(part) !== -1; }); };
  var i = find(q);
  for (var at = 0; i === -1 && at + 30 <= q.length; at += 15) i = find(q.slice(at, at + 30));
  return i;
}

function renderSrc() {
  var s = ts.sum, body = $("ts-src-body");
  if (!s) return;
  var p = ts.active != null ? pointByN(ts.active) : null;
  $("ts-src-meta").textContent = s.sourceLabel + (sourceAlive(s) ? "" : " · nguồn đã bị xoá") + (p && p.page ? " · trang " + p.page : "");
  var qp = function (n) { return '<span class="qp">Trích dẫn ' + n + "</span>"; };
  var src = ts.src;
  if (src && src.loading) { body.innerHTML = '<p class="ts-empty-sum">Đang tải nội dung chương…</p>'; return; }
  if (src && src.paras) {
    var hit = p ? findQuote(src.paras, p.quote) : -1;
    var html = src.paras.map(function (b, i) {
      return i === hit ? '<p class="q" id="ts-hl">' + qp(p.n) + esc(b.text) + "</p>" : "<p" + (b.heading ? ' class="h"' : "") + ">" + esc(b.text) + "</p>";
    }).join("");
    // Câu trích không còn trong nội dung hiện tại (đã sửa Chương sau khi tạo) -> hiện riêng đoạn trích ở đầu.
    if (p && hit === -1) html = '<p class="q" id="ts-hl">' + qp(p.n) + esc(p.quote || p.content) + '<span class="pg" style="margin-top:6px">Đoạn này không còn nguyên văn trong nội dung hiện tại.</span></p>' + html;
    body.innerHTML = html || '<p class="ts-empty-sum">Chương hiện chưa có nội dung.</p>';
  } else {
    // PDF / nguồn đã xoá / lỗi tải: các đoạn trích đã lưu, theo thứ tự ý.
    var pts = allPoints(s);
    body.innerHTML = (src && src.error ? '<p class="ts-red">' + esc(src.error) + "</p>" : "") + (pts.length ? pts.map(function (x) {
      var on = p && x.n === p.n;
      return '<p class="' + (on ? "q" : "") + '"' + (on ? ' id="ts-hl"' : "") + ">" + (x.page ? '<span class="pg">Trang ' + x.page + "</span>" : "") +
        (on ? qp(x.n) : "[" + x.n + "] ") + esc(x.quote || x.content) + "</p>";
    }).join("") : '<p class="ts-empty-sum">Không có đoạn trích nào.</p>');
  }
  var hl = $("ts-hl");
  if (hl) { // giữ đoạn liền trước làm ngữ cảnh; đoạn trích đã nằm trọn trong khung thì không cuộn
    var top = hl.offsetTop - body.offsetTop, prev = hl.previousElementSibling;
    var y = top + hl.offsetHeight <= body.clientHeight ? 0 : prev ? prev.offsetTop - body.offsetTop : top;
    body.scrollTo({ top: y, behavior: "smooth" });
  } else body.scrollTop = 0;
}

function openSourceInNotebook() {
  var s = ts.sum;
  if (!s || !sourceAlive(s)) return;
  var p = ts.active != null ? pointByN(ts.active) : null;
  flushTitle();
  hooks.openSource({ subject_id: s.subjectId, chapter_id: s.chapterId, document_id: s.documentId, page: p && p.page ? p.page : 1 });
}

function regenView() {
  var s = ts.sum;
  if (!s || ts.regen || !sourceAlive(s)) return;
  ts.regen = true;
  renderView();
  regenerate(s.id).then(function (fresh) {
    ts.regen = false;
    if (ts.sum !== s) return;
    if (fresh) {
      fresh.title = s.title;
      ts.sum = fresh;
      ts.active = null;
      ts.savedAt = fresh.updatedAt || new Date();
      ts.src = null;
      toast("Đã tạo lại bản tóm tắt");
      if (isOnline()) refreshSaved();
      loadSource();
    }
    if (ts.open && ts.screen === "view") renderView();
  });
}

/* ---------- Tên bản tóm tắt (PATCH, debounce) ---------- */
function saveTitle() {
  var s = ts.sum, t = s ? s.title.trim() : "";
  if (!s || s.sample || !t) return;
  ts.sync = ts.sync.then(function () {
    return apiAuth("PATCH", "/summaries/" + encodeURIComponent(s.id), authToken(), { title: t }).then(function (res) {
      if (ts.sum !== s) return;
      if (res.ok) { ts.saveErr = ""; ts.savedAt = res.data && res.data.updated_seconds_ago != null ? agoDate(res.data.updated_seconds_ago) : new Date(); }
      else ts.saveErr = "Chưa lưu được — " + apiErrorText(res, "/summaries/{id}", "lỗi máy chủ.");
      if (ts.open && ts.screen === "view") renderSavedLabel();
    });
  });
}
function flushTitle() {
  if (!ts.titleTimer) return;
  clearTimeout(ts.titleTimer);
  ts.titleTimer = 0;
  saveTitle();
}

// "Xong" / × ở màn xem: lưu nốt tên rồi về Đã tạo.
function finishView() {
  var s = ts.sum, empty = !s.title.trim();
  if (empty) s.title = "Bản tóm tắt chưa đặt tên";
  if (empty || ts.titleTimer) { clearTimeout(ts.titleTimer); ts.titleTimer = 0; saveTitle(); }
  closePdf();
  clearResume();
  if (s.sample) { s.updatedAt = new Date(); toast("Đã cập nhật bản minh hoạ (chế độ mẫu)"); }
  else ts.sync.then(function () { toast(ts.saveErr ? ts.saveErr : "Đã lưu bản tóm tắt"); refreshSaved(); });
  show("saved");
}

/* ====================================================================
   XUẤT PDF (UC-24 luồng 4a) — tải thẳng file .pdf xuống máy (hộp tuỳ chọn #ts-pdf-modal không còn được mở)
   ==================================================================== */
function slug(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/[–—:\/]/g, " ").replace(/[^A-Za-z0-9 -]/g, "").trim().replace(/[\s-]+/g, "-") || "ban-tom-tat";
}
function openPdf() {
  var inp = $("ts-file-in");
  inp.value = slug(ts.sum.title) + ".pdf";
  $("ts-f-file").classList.remove("err");
  renderPdfOpts();
  $("ts-pdf-modal").hidden = false;
  inp.focus();
  inp.setSelectionRange(0, inp.value.length - 4);
}
function closePdf() { var m = $("ts-pdf-modal"); if (m) m.hidden = true; }
function renderPdfOpts() {
  Array.prototype.forEach.call($("ts-paper-seg").children, function (b) { b.classList.toggle("on", b.dataset.v === ts.pdf.paper); });
  $("ts-pdf-modal").querySelectorAll(".ts-sw-row").forEach(function (r) {
    r.classList.toggle("on", !!ts.pdf[r.dataset.p]);
    r.setAttribute("aria-pressed", String(!!ts.pdf[r.dataset.p]));
  });
}

// Bấm "Xuất PDF" = tải thẳng file .pdf xuống máy (người dùng chốt: không hộp xem trước, không hộp in).
// Dựng trang trong 1 khối ẩn ngoài màn hình -> html2canvas chụp -> jsPDF cắt trang (ngắt ở mép khối) -> save().
var PDF_W_PX = 658; // bề rộng nội dung (px) ~ A4 trừ lề 18mm 2 bên ở 96dpi
function exportPdf() {
  if (ts.pdfBusy || !ts.sum) return;
  var jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDF || !window.html2canvas) { toast("Chưa tải được công cụ xuất PDF. Vui lòng tải lại trang rồi thử lại."); return; }
  var file = slug(ts.sum.title || "") + ".pdf";
  var s = ts.sum, o = ts.pdf, pts = allPoints(s);
  var sup = function (p) { return o.cite ? " <sup>[" + p.n + "]</sup>" : ""; };
  var h = "<h1>" + esc(s.title) + '</h1><div class="m">' + esc(s.sourceLabel) + " · " + LEN[s.length].name + " · " + FMT[s.format] + "</div>";
  s.sections.forEach(function (sec) {
    h += "<h2>" + esc(sec.heading) + "</h2>" + (s.format === "bullet"
      ? "<ul>" + sec.points.map(function (p) { return "<li>" + esc(p.content) + sup(p) + "</li>"; }).join("") + "</ul>"
      : "<p>" + sec.points.map(function (p) { return esc(p.content) + sup(p); }).join(" ") + "</p>");
  });
  if (o.cite && pts.length) {
    h += '<h2>Trích dẫn</h2><div class="refs">' + pts.map(function (p) {
      return "<p>[" + p.n + "] " + esc(s.sourceLabel) + (p.page ? ", trang " + p.page : "") + (p.quote ? ": “" + esc(p.quote) + "”" : "") + "</p>";
    }).join("") + "</div>";
  }
  if (o.notes) {
    var paras = ts.src && ts.src.paras;
    h += "<h2>Nội dung gốc — " + esc(s.sourceLabel) + "</h2>" + (paras
      ? paras.map(function (b) { return b.heading ? "<h3>" + esc(b.text) + "</h3>" : "<p>" + esc(b.text) + "</p>"; }).join("")
      : pts.map(function (p) { return "<p>" + (p.page ? "(trang " + p.page + ") " : "") + esc(p.quote || p.content) + "</p>"; }).join(""));
  }
  var css = ".tspdf{position:fixed;left:-10000px;top:0;width:" + PDF_W_PX + "px;background:#fff;color:#000;" +
    "font-family:Inter,system-ui,sans-serif;font-size:16px;line-height:1.5;text-align:left}" +
    ".tspdf h1{font-size:24px;font-weight:500;margin:0 0 5px}.tspdf h2{font-size:17px;color:#0a1a4d;font-weight:500;margin:18px 0 5px}" +
    ".tspdf h3{font-size:15px;font-weight:600;margin:12px 0 4px}.tspdf ul{margin:0;padding-left:22px}" +
    ".tspdf li{margin:4px 0}.tspdf sup{color:#0a1a4d;font-weight:500}.tspdf .m{color:#666}" +
    ".tspdf .refs p{margin:4px 0}.tspdf p{margin:0 0 8px}";
  closePdf();
  var box = document.createElement("div");
  box.className = "tspdf";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = "<style>" + css + "</style>" + h;
  document.body.appendChild(box);
  var SCALE = 2;
  ts.pdfBusy = true;
  toast("Đang tạo “" + file + "”…");
  window.html2canvas(box, { scale: SCALE, backgroundColor: "#ffffff", useCORS: true }).then(function (canvas) {
    var pdf = new jsPDF({ orientation: "p", unit: "pt", format: o.paper === "A4" ? "a4" : "letter" });
    var margin = 51; // 18mm
    var pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    var contentW = pageW - margin * 2, contentH = pageH - margin * 2;
    var pxPerPt = canvas.width / contentW;
    var sliceMax = contentH * pxPerPt;
    var y = 0, first = true;
    var ctx = canvas.getContext("2d");
    // Ngắt trang ở hàng điểm ảnh TRẮNG gần mép trang nhất (khoảng giữa 2 dòng chữ) — đo trên chính ảnh đã
    // chụp vì html2canvas vẽ chữ lệch vài px so với toạ độ DOM, ngắt theo DOM từng cắt ngang dòng chữ.
    function blankRowAbove(limit, floor) {
      var top = Math.max(floor, limit - Math.floor(sliceMax * 0.4));
      var data = ctx.getImageData(0, top, canvas.width, limit - top).data, w = canvas.width * 4;
      for (var r = limit - top - 1; r >= 0; r--) {
        var row = r * w, blank = true;
        for (var k = 0; k < w; k += 4) {
          if (data[row + k] < 245 || data[row + k + 1] < 245 || data[row + k + 2] < 245) { blank = false; break; }
        }
        if (blank) return top + r;
      }
      return limit;
    }
    while (y < canvas.height - 1) {
      var end = Math.min(Math.floor(y + sliceMax), canvas.height);
      if (end < canvas.height) end = blankRowAbove(end, y + 1);
      var hpx = end - y;
      var slice = document.createElement("canvas");
      slice.width = canvas.width; slice.height = hpx;
      slice.getContext("2d").drawImage(canvas, 0, y, canvas.width, hpx, 0, 0, canvas.width, hpx);
      if (!first) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, contentW, hpx / pxPerPt);
      first = false;
      y = end;
    }
    pdf.save(file);
    toast("Đã tải “" + file + "” xuống máy");
  }).catch(function () {
    toast("Không tạo được tệp PDF. Vui lòng thử lại.");
  }).then(function () {
    box.remove();
    ts.pdfBusy = false;
  });
}

/* ====================================================================
   Gắn sự kiện — gọi 1 lần từ init() của ghichu.js
   ==================================================================== */
export function initTomtat() {
  // UC-35: "Báo nội dung sai" — ý đang chọn (bấm vào 1 ý trước) hoặc cả bản tóm tắt
  $("ts-report").addEventListener("click", function () {
    var s = ts.sum; if (!s) return;
    var p = ts.active ? allPoints(s).find(function (x) { return x.n === ts.active; }) : null;
    hooks.reportContent({
      title: "Tóm tắt sai: " + s.title, context: ["Tóm tắt", s.sourceLabel, p ? "Ý " + p.n : "Cả bản"],
      quote_heading: p ? "Ý " + p.n + " · " + s.title : s.title,
      quote_text: p ? p.content + (p.quote ? "\nTrích dẫn: " + p.quote : "") : "",
    });
  });
  $("ts-back-btn").addEventListener("click", function (e) { e.stopPropagation(); onClose(); });
  $("ts-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]"); if (!b) return;
    if (b.dataset.tab === "saved") { refreshSaved(); show("saved"); }
    else { initSource(); show("setup"); }
  });

  // --- Tạo mới ---
  $("ts-subject-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    if (ts.job) return;
    var m = $("ts-subject-menu");
    if (!m.hidden) { m.hidden = true; return; }
    var subs = realSubjects();
    m.innerHTML = subs.length ? subs.map(function (s) {
      return '<button type="button" data-s="' + esc(s.id) + '"' + (s.id === ts.subjectId ? ' class="on"' : "") + ">" + esc(s.name) + "</button>";
    }).join("") : '<div class="empty">Chưa có Môn học nào.</div>';
    m.hidden = false;
  });
  $("ts-subject-menu").addEventListener("click", function (e) {
    e.stopPropagation();
    var b = e.target.closest("button[data-s]"); if (!b) return;
    $("ts-subject-menu").hidden = true;
    if (b.dataset.s === ts.subjectId) return;
    ts.subjectId = b.dataset.s;
    var first = subjectItems(currentSubject())[0];
    ts.pick = null;
    if (first) pickSource(first.kind, first.item.id, true);
    else { ts.picking = true; if (!ts.nameTouched) ts.name = ""; ts.stats = null; }
    renderSetup();
  });
  document.addEventListener("click", function () { var m = $("ts-subject-menu"); if (m) m.hidden = true; });
  $("ts-src-list").addEventListener("click", function (e) {
    var c = e.target.closest(".ts-chip"); if (!c || ts.job) return;
    pickSource(c.dataset.kind, c.dataset.id, true);
    renderSetup();
  });
  $("ts-add-note").addEventListener("click", function () {
    var x = pickedItem();
    if (x && x.kind === "chapter") hooks.openSource({ subject_id: ts.subjectId, chapter_id: x.item.id });
  });
  $("ts-name").addEventListener("input", function (e) {
    ts.name = e.target.value;
    ts.nameTouched = ts.name.trim() !== ""; // xoá trắng -> lần bấm chọn nguồn sau lại tự điền
    validate();
  });
  $("ts-len-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b || ts.job) return;
    ts.len = b.dataset.v;
    renderSetup();
  });
  $("ts-fmt-seg").addEventListener("click", function (e) {
    var b = e.target.closest(".ts-fmt"); if (!b || ts.job) return;
    ts.fmt = b.dataset.v;
    renderSetup();
  });
  $("ts-keep-box").addEventListener("click", function (e) {
    var r = e.target.closest(".ts-sw-row"); if (!r || ts.job) return;
    ts.keep[r.dataset.k] = !ts.keep[r.dataset.k];
    renderSetup();
  });
  $("ts-panel").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cancel") cancelJob();
    else if (b.dataset.act === "again") resetJob();
    else if (b.dataset.act === "start" && ts.job && ts.job.sum) { var s = ts.job.sum; resetJob(); openSum(s); }
  });
  $("ts-create").addEventListener("click", createSummary);

  // --- Đã tạo ---
  $("ts-saved-list").addEventListener("click", function (e) {
    if (e.target.closest("[data-new]")) { ts.lmenu = null; show("setup"); return; }
    if (e.target.closest("[data-reset]")) { ts.lq = ""; ts.lf = "all"; ts.lpage = 0; $("ts-lq").value = ""; renderSaved(); return; }
    var more = e.target.closest("[data-more]");
    if (more) { e.stopPropagation(); ts.lmenu = ts.lmenu === more.dataset.more ? null : more.dataset.more; renderSaved(); return; }
    var card = e.target.closest(".ts-scard[data-row]"); if (!card) return;
    var id = card.dataset.row, m = e.target.closest("[data-m]");
    if (m) {
      e.stopPropagation(); ts.lmenu = null;
      if (m.dataset.m === "open") openCard(card);
      else if (m.dataset.m === "pdf") openCard(card, true);
      else if (m.dataset.m === "regen") regenFromList(id);
      else if (m.dataset.m === "del") deleteSaved(id);
      return;
    }
    if (e.target.closest(".ts-cmenu")) return;
    var b = e.target.closest("[data-act]");
    if (b && b.dataset.act === "regen") { regenFromList(id); return; }
    if (ts.busy[id]) return;
    if (ts.lmenu != null) { ts.lmenu = null; renderSaved(); return; }
    openCard(card);
  });
  // Mở 1 thẻ (cả thẻ bấm được); `pdf` = mở rồi bật hộp Xuất PDF (mục menu "Xuất PDF").
  function openCard(card, pdf) {
    if (card.dataset.busy || ts.busy[card.dataset.row]) return;
    card.dataset.busy = "1";
    openSaved(card.dataset.row).then(function () { delete card.dataset.busy; if (pdf && ts.screen === "view") exportPdf(); });
  }
  $("ts-saved-list").addEventListener("keydown", function (e) {
    var card = e.target.closest(".ts-scard[data-row]");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCard(card); }
  });
  $("ts-lq").addEventListener("input", function (e) { ts.lq = e.target.value; ts.lpage = 0; renderSaved(); });
  $("ts-lq-clear").addEventListener("click", function (e) { e.preventDefault(); ts.lq = ""; $("ts-lq").value = ""; ts.lpage = 0; renderSaved(); $("ts-lq").focus(); });
  Array.prototype.forEach.call(document.querySelectorAll("#ts-s-saved .ts-fpill"), function (b) {
    b.addEventListener("click", function () { ts.lf = b.dataset.f; ts.lpage = 0; renderSaved(); });
  });
  $("ts-sort-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    var mn = $("ts-sort-menu");
    mn.innerHTML = Object.keys(SORTS).map(function (k) { return '<button type="button" data-k="' + k + '" class="' + (k === ts.lsort ? "on" : "") + '">' + SORTS[k] + "</button>"; }).join("");
    mn.hidden = !mn.hidden;
  });
  $("ts-sort-menu").addEventListener("click", function (e) {
    var b = e.target.closest("[data-k]"); if (!b) return;
    ts.lsort = b.dataset.k; ts.lpage = 0; $("ts-sort-menu").hidden = true; renderSaved();
  });
  $("ts-per").innerHTML = perSelectHtml(PER, PER_OPTS, "ô");
  bindPerSelect($("ts-per"), "cl_tomtat", function (v) { PER = v; ts.lpage = 0; ts.lmenu = null; renderSaved(); });
  $("ts-pgr").addEventListener("click", function (e) { var b = e.target.closest("[data-pg]"); if (b) { ts.lpage += +b.dataset.pg; ts.lmenu = null; renderSaved(); } });
  document.addEventListener("click", function (e) {
    if (!ts.open) return;
    if (!e.target.closest("#ts-sort-menu, #ts-sort-btn")) $("ts-sort-menu").hidden = true;
    if (ts.lmenu != null && ts.screen === "saved" && !e.target.closest(".ts-cmenu, [data-more]")) { ts.lmenu = null; renderSaved(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !ts.open || ts.screen !== "saved") return;
    if (!$("ts-sort-menu").hidden) $("ts-sort-menu").hidden = true;
    else if (ts.lmenu != null) { ts.lmenu = null; renderSaved(); }
  });
  window.addEventListener("pagehide", function () { commitDelete(true); });

  // --- Xem ---
  $("ts-done").addEventListener("click", finishView);
  $("ts-sum-name").addEventListener("input", function (e) {
    ts.sum.title = e.target.value.slice(0, 200);
    if (ts.sum.sample) { ts.sum.updatedAt = new Date(); return; }
    clearTimeout(ts.titleTimer);
    ts.titleTimer = setTimeout(function () { ts.titleTimer = 0; saveTitle(); }, 600);
  });
  $("ts-sum-name").addEventListener("keydown", function (e) { if (e.key === "Enter") e.target.blur(); });
  $("ts-sum-body").addEventListener("click", function (e) {
    var el = e.target.closest("[data-n]");
    if (el) activate(Number(el.dataset.n));
  });
  $("ts-regen-btn").addEventListener("click", regenView);
  $("ts-stale-regen").addEventListener("click", regenView);
  $("ts-open-src").addEventListener("click", openSourceInNotebook);

  // --- Xuất PDF ---
  $("ts-pdf-btn").addEventListener("click", exportPdf);
  $("ts-pdf-cancel").addEventListener("click", closePdf);
  $("ts-pdf-go").addEventListener("click", exportPdf);
  $("ts-pdf-modal").addEventListener("click", function (e) { if (e.target === $("ts-pdf-modal")) closePdf(); });
  $("ts-paper-seg").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b) return;
    ts.pdf.paper = b.dataset.v;
    renderPdfOpts();
  });
  $("ts-pdf-modal").querySelectorAll(".ts-sw-row").forEach(function (r) {
    r.addEventListener("click", function () { ts.pdf[r.dataset.p] = !ts.pdf[r.dataset.p]; renderPdfOpts(); });
  });
  $("ts-file-in").addEventListener("input", function (e) { $("ts-f-file").classList.toggle("err", !e.target.value.trim()); });
  $("ts-file-in").addEventListener("keydown", function (e) { if (e.key === "Enter") exportPdf(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && ts.open && !$("ts-pdf-modal").hidden) closePdf();
  });
  window.addEventListener("beforeunload", flushTitle);
}
