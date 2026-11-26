/* UC-33 — Hạn mức phía người học (mẫu han-muc-nguoi-hoc.html, đặc tả .claude/rules/10-admin.md mục "Luồng phía
   người học"). Chỉ chạy khi ĐÃ đăng nhập (chế độ mẫu không có hạn mức):
   - Thanh "Dung lượng" cuối cột Notebook + dải nhắc 3 mức (≥ nhắc lần 1 / ≥ nhắc lần 2 / đầy) phía trên cây, dòng
     nhắc Môn có nhiều tệp nhất khi ≥ nhắc lần 1 của hạn mức số tệp.
   - "Còn x / y lượt hôm nay" trên từng thẻ Studio (vàng khi còn ≤ ngưỡng nhắc lượt AI, đỏ "Hết lượt" khi 0 — vẫn mở
     công cụ được để xem / ôn lại các bộ đã tạo).
   - Kiểm tra TRƯỚC khi tải tệp (precheckUpload: kích thước → số tệp của Môn → dung lượng còn trống) và xử lý lỗi
     413/409 có `code` từ máy chủ (handleUploadError) — máy chủ luôn kiểm lại (E1).
   - Màn "Dọn dung lượng" (#hm-pane, chiếm trọn cột giữa): lọc Lớn nhất / Tệp trùng / Chưa mở 30 ngày / Lỗi xử lý /
     theo Môn, chọn nhiều, xoá có Hoàn tác 6 giây (POST /me/files/delete chỉ gửi khi hết giờ, rời màn hoặc đóng tab —
     fetch keepalive), giữ tệp đang chờ tải để "Tải lên ngay" khi đã đủ chỗ.
   API: GET /me/quota, GET /me/files, POST /me/files/delete (backend/app/routers/me_quota.py). */
import { $, hooks, isOnline, authToken, esc, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";

var PER_OPTS = [8, 15, 30, 50];   // số tệp mỗi trang ở Dọn dung lượng (người dùng chọn, nhớ localStorage)

var MB = 1024 * 1024;
var CARD_FEATURE = { hoidap: "qa", ontap: "quiz", thithu: "quiz", flashcard: "fc", tomtat: "sum", mindmap: "mind" };
var RESUME_KEY = "td_hm_resume";
var UNDO_MS = 6000;

var hm = {
  quota: null, open: false, filter: "all", subjectId: null, page: 1, per: getPerPage("hm_files", 8, PER_OPTS),
  files: [], loading: false, sel: new Set(), pending: null, del: null, refreshTimer: null,
};

var mbf = function (b) { return (Math.round(b / MB * 10) / 10).toLocaleString("vi-VN", { maximumFractionDigits: 1 }); };
var mb0 = function (b) { return b < 10 * MB ? mbf(b) : Math.round(b / MB).toLocaleString("vi-VN"); };   // < 10 MB: giữ 1 số lẻ
function untilMidnight(sec) { return Math.floor(sec / 3600) + " giờ " + Math.floor(sec % 3600 / 60) + " phút"; }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } }
function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

/* ---------------- dữ liệu ---------------- */
export async function refresh() {
  if (!isOnline()) return null;
  var res = await apiAuth("GET", "/me/quota", authToken());
  if (!res.ok) return null;
  hm.quota = res.data;
  renderSidebar();
  renderCards();
  if (hm.open) renderClean();
  return hm.quota;
}
// Gọi mỗi lần đổi màn (updateWorkspaceCols) — gộp các lần gọi sát nhau, ít nhất 4 giây/lần.
export function refreshSoon() {
  if (!isOnline() || hm.refreshTimer) return;
  hm.refreshTimer = setTimeout(function () { hm.refreshTimer = null; refresh(); }, 1200);
}
function free() { var s = hm.quota.storage; return Math.max(0, s.limit_bytes - s.used_bytes); }

/* ---------------- toast + hộp thoại ---------------- */
var toastTimer = null, undoFn = null;
export function toast(text, undo, warn) {
  var t = $("hm-toast");
  if (!t) { t = document.createElement("div"); t.id = "hm-toast"; t.className = "hm-toast"; document.body.appendChild(t); }
  clearTimeout(toastTimer);
  t.className = "hm-toast" + (warn ? " warn" : "");
  t.innerHTML = "<span>" + esc(text) + "</span>" + (undo ? '<button type="button">Hoàn tác</button>' : "");
  t.hidden = false;
  undoFn = undo || null;
  if (undo) t.querySelector("button").onclick = function () { t.hidden = true; var f = undoFn; undoFn = null; f && f(); };
  toastTimer = setTimeout(function () { t.hidden = true; undoFn = null; }, undo ? UNDO_MS : 3600);
}
export function modal(html, mount) {
  closeModal();
  var ov = document.createElement("div");
  ov.className = "hm-ov"; ov.id = "hm-ov";
  ov.innerHTML = '<div class="hm-modal" role="dialog" aria-modal="true">' + html + "</div>";
  document.body.appendChild(ov);
  ov.addEventListener("mousedown", function (e) { if (e.target === ov) closeModal(); });
  if (mount) mount(ov.firstElementChild);
  return ov.firstElementChild;
}
export function closeModal() { var o = $("hm-ov"); if (o) o.remove(); }
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && $("hm-ov")) closeModal(); });

/* ---------------- cột Notebook: thanh Dung lượng + dải nhắc ---------------- */
function ensureSidebarSlots() {
  var side = $("sidebar");
  if (!side) return false;
  if (!$("hm-meter")) {
    var m = document.createElement("div"); m.id = "hm-meter"; m.className = "hm-meter";
    side.insertBefore(m, side.querySelector(".sidebar-foot"));
  }
  if (!$("hm-banner")) {
    var b = document.createElement("div"); b.id = "hm-banner";
    side.insertBefore(b, $("tree-scroll"));
  }
  return true;
}
function bannerKey() { return "td_hm_banner_closed_" + today(); }

function renderSidebar() {
  if (!hm.quota || !ensureSidebarSlots()) return;
  var s = hm.quota.storage, w = hm.quota.warn, lv = s.level;
  var p = Math.min(100, s.used_bytes / s.limit_bytes * 100);
  var m = $("hm-meter");
  m.className = "hm-meter l" + lv;
  m.innerHTML = '<div class="hm-mh"><span>Dung lượng</span><b>' + Math.round(p) + "%</b></div>"
    + '<i><b style="width:' + p + '%"></b></i>'
    + '<div class="hm-mrow"><span>' + mb0(s.used_bytes) + " / " + mb0(s.limit_bytes) + " MB" + (lv === 3 ? " · đã đầy" : "") + "</span>"
    + (lv ? '<button type="button" data-hm="clean">Dọn dung lượng</button>' : "") + "</div>";

  var f = free(), avg = s.avg_pdf_bytes || 5 * MB, html = "";
  if (lv === 1 && lsGet(bannerKey()) !== "1") {
    html = '<div class="hm-banner l1"><div>Bạn đã dùng <b>' + mb0(s.used_bytes) + " / " + mb0(s.limit_bytes) + " MB</b> (" + Math.round(p) + "%). Còn khoảng "
      + mb0(f) + " MB — đủ cho " + Math.max(1, Math.floor(f / avg)) + " tệp PDF nữa.<small>Gợi ý: xoá tệp trùng nhau hoặc tệp lâu không mở.</small></div>"
      + '<button type="button" class="hm-x" data-hm="close" aria-label="Ẩn nhắc">×</button>'
      + '<div class="hm-bact"><button type="button" class="hm-btn sm pri" data-hm="clean">Dọn dung lượng</button></div></div>';
  } else if (lv === 2) {
    html = '<div class="hm-banner l2"><div><b>Sắp đầy: còn ' + mbf(f) + " MB.</b> Tệp lớn hơn " + mbf(f) + " MB sẽ không tải lên được.<small>Đã dùng "
      + mb0(s.used_bytes) + " / " + mb0(s.limit_bytes) + " MB (" + Math.round(p) + "%).</small></div><span></span>"
      + '<div class="hm-bact"><button type="button" class="hm-btn sm pri" data-hm="clean">Dọn dung lượng</button></div></div>';
  } else if (lv === 3) {
    html = '<div class="hm-banner l3"><div><b>Dung lượng đã đầy (' + mb0(s.used_bytes) + " / " + mb0(s.limit_bytes) + " MB).</b> Bạn chưa thể tải tệp mới."
      + "<small>Ghi chú, Flashcard, Quiz và các tài liệu đã có vẫn dùng bình thường.</small></div><span></span>"
      + '<div class="hm-bact"><button type="button" class="hm-btn sm pri" data-hm="clean">Dọn dung lượng</button></div></div>';
  }
  // Môn có nhiều tệp nhất đã ≥ nhắc lần 1 của hạn mức số tệp
  var lim = s.subject_files_limit, top = s.subjects.slice().sort(function (a, b) { return b.count - a.count; })[0];
  if (top && top.count * 100 >= lim * w.w1) {
    var full = top.count >= lim;
    html += '<div class="hm-sline' + (full ? " d" : "") + '">Môn <b>' + esc(top.name) + "</b> " + (full ? "đã đủ" : "đã có") + " <b>" + top.count + " / " + lim
      + " tệp</b>" + (full ? ", chưa thể tải thêm. " : ". ") + '<button type="button" data-hm="subj" data-sid="' + esc(top.id) + '">Quản lý tệp của môn</button></div>';
  }
  $("hm-banner").innerHTML = html;
}

document.addEventListener("click", function (e) {
  var b = e.target.closest && e.target.closest("[data-hm]");
  if (!b || !b.closest("#sidebar")) return;
  if (b.dataset.hm === "close") { lsSet(bannerKey(), "1"); renderSidebar(); toast("Đã ẩn nhắc · bạn vẫn xem được mức dùng ở cuối cột Notebook"); return; }
  if (b.dataset.hm === "subj") { openClean({ filter: "subject", subjectId: b.dataset.sid }); return; }
  openClean({ filter: "all" });
});

/* ---------------- thẻ Studio ---------------- */
function featureOf(f) { return hm.quota.ai.find(function (x) { return x.feature === f; }); }
function renderCards() {
  if (!hm.quota) return;
  var warnPct = hm.quota.warn.ai, reset = hm.quota.reset_in_seconds;
  Object.keys(CARD_FEATURE).forEach(function (card) {
    var el = $("studio-card-" + card); if (!el) return;
    var a = featureOf(CARD_FEATURE[card]); if (!a) return;
    var line = el.querySelector(".hm-cnt");
    if (!line) { line = document.createElement("span"); line.className = "hm-cnt"; (el.querySelector(".studio-card-label") || el).after(line); }
    if (a.per_session) {   // Hỏi đáp: hạn mức theo từng cuộc hội thoại, không hết lượt theo ngày
      line.className = "hm-cnt";
      line.textContent = "Tối đa " + a.limit + " lượt / cuộc hội thoại";
      el.classList.remove("hm-zero");
      el.title = "";
      return;
    }
    var low = a.remaining > 0 && a.remaining <= Math.ceil(a.limit * warnPct / 100);
    line.className = "hm-cnt" + (a.remaining === 0 ? " z" : low ? " w" : "");
    line.textContent = a.remaining === 0 ? "Hết lượt · mới lúc 00:00" : "Còn " + a.remaining + " / " + a.limit + " lượt hôm nay";
    el.classList.toggle("hm-zero", a.remaining === 0);
    el.title = a.remaining === 0 ? "Đã dùng hết " + a.limit + " lượt " + a.name + " hôm nay. Lượt mới có lúc 00:00 · còn " + untilMidnight(reset)
      + ". Bạn vẫn mở được để xem lại các bộ đã tạo." : "";
  });
}

// Lỗi 429 "hết lượt" từ form công cụ — cập nhật lại thẻ và trả câu thông báo (kèm việc làm được ngay).
export function aiLimitText(res) {
  var err = res && res.data && res.data.err;
  if (!err || err.code !== "ai_limit") return null;
  refresh();
  var best = hm.quota ? hm.quota.ai.filter(function (x) { return x.feature !== err.feature && !x.per_session; }).sort(function (a, b) { return b.remaining - a.remaining; })[0] : null;
  return err.message + " Còn " + untilMidnight(err.reset_in_seconds || 0) + "." + (best && best.remaining ? " Trong lúc chờ: còn " + best.remaining + " lượt " + best.name + "." : "");
}

/* ---------------- tải tệp lên ---------------- */
// ctx = {subjectId|null, kind:'pdf'|'chat', label} ; proceed() = tải thật. Trả true nếu được tải ngay.
export function precheckUpload(file, ctx, proceed) {
  if (!isOnline() || !hm.quota) return true;
  var s = hm.quota.storage;
  if (file.size > s.file_limit_mb * MB) {
    showSimple("Tệp quá lớn", "“" + file.name + "” nặng " + mbf(file.size) + " MB, vượt giới hạn " + s.file_limit_mb
      + " MB mỗi tệp. Hãy nén PDF hoặc tách thành nhiều phần nhỏ hơn.");
    return false;
  }
  if (ctx.subjectId) {
    var sub = s.subjects.find(function (x) { return x.id === ctx.subjectId; });
    if (sub && sub.count >= s.subject_files_limit) { showSubjectFull(ctx.subjectId, s.subject_files_limit); return false; }
  }
  if (file.size > free()) { showFull(file, ctx, proceed); return false; }
  return true;
}
// Máy chủ từ chối (413/409 kèm code) — cùng cách xử lý như kiểm tra trước. Trả true nếu đã xử lý.
export function handleUploadError(res, file, ctx, proceed) {
  var err = res && res.data && res.data.err;
  if (!err) return false;
  refresh();
  if (err.code === "file_too_big") { showSimple("Tệp quá lớn", err.message); return true; }
  if (err.code === "subject_full") { showSubjectFull(ctx.subjectId, err.limit); return true; }
  if (err.code === "storage_full") { showFull(file, ctx, proceed, err.free_bytes); return true; }
  return false;
}
// Sau khi tải lên / xoá thành công: cập nhật thanh dung lượng, cảnh báo nếu vừa lên mức ≥ 2.
export async function afterUpload(name) {
  var before = hm.quota ? hm.quota.storage.level : 0;
  var q = await refresh();
  if (q && q.storage.level >= 2 && q.storage.level > before) toast("Đã tải " + name + " · dung lượng còn " + mbf(free()) + " MB", null, true);
}

function showSimple(title, text) {
  modal("<h2>" + esc(title) + '</h2><p class="hm-msub">' + esc(text) + '</p><div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Đóng</button></div>',
    function (m) { m.querySelector("#hm-mc").onclick = closeModal; });
}
function showSubjectFull(subjectId, limit) {
  modal("<h2>Môn này đã đủ " + limit + ' tệp</h2><p class="hm-msub">Hãy gộp các PDF nhỏ thành một tệp hoặc xoá bản cũ trước khi tải thêm. Ghi chú và tài liệu đã có vẫn dùng bình thường.</p>'
    + '<div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Đóng</button><button type="button" class="hm-btn sm pri" id="hm-mok">Quản lý tệp của môn</button></div>',
    function (m) {
      m.querySelector("#hm-mc").onclick = closeModal;
      m.querySelector("#hm-mok").onclick = function () { closeModal(); openClean({ filter: "subject", subjectId: subjectId }); };
    });
}
function showFull(file, ctx, proceed, freeBytes) {
  var fr = freeBytes != null ? freeBytes : free(), need = file.size - fr;
  modal('<div class="hm-mi"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg></div>'
    + "<h2>Không đủ dung lượng để tải tệp này</h2><p class=\"hm-msub\">Ghi chú, Flashcard, Quiz và các tài liệu đã có vẫn dùng bình thường.</p>"
    + '<div class="hm-box"><div class="rw"><span>Tệp cần tải</span><b>' + esc(file.name) + " · " + mbf(file.size) + ' MB</b></div><div class="rw"><span>Còn trống</span><b>'
    + mbf(fr) + ' MB</b></div><div class="rw"><span>Cần xoá bớt ít nhất</span><b style="color:var(--hm-red)">' + mbf(need) + " MB</b></div></div>"
    + '<p id="hm-full-hint" style="margin:0">Đang tìm tệp trùng và tệp lỗi có thể xoá ngay…</p>'
    + '<div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Huỷ</button><button type="button" class="hm-btn sm pri" id="hm-mok">Chọn tệp để xoá</button></div>',
    function (m) {
      m.querySelector("#hm-mc").onclick = closeModal;
      m.querySelector("#hm-mok").onclick = function () {
        closeModal();
        hm.pending = { file: file, ctx: ctx, proceed: proceed };
        openClean({ filter: "all" });
      };
    });
  Promise.all([apiAuth("GET", "/me/files?filter=dup", authToken()), apiAuth("GET", "/me/files?filter=err", authToken())]).then(function (r) {
    var h = $("hm-full-hint"); if (!h) return;
    var dup = r[0].ok ? r[0].data.length : 0, er = r[1].ok ? r[1].data.length : 0;
    h.innerHTML = dup || er ? "Gợi ý: bạn có <b>" + dup + " tệp trùng</b> và <b>" + er + " tệp bị lỗi</b> có thể xoá ngay mà không mất nội dung."
      : "Gợi ý: bắt đầu với các tệp lớn nhất hoặc lâu không mở.";
  });
}

/* ---------------- màn Dọn dung lượng ---------------- */
export function isOpen() { return hm.open; }

export function openClean(opts) {
  opts = opts || {};
  if (!isOnline()) return;
  hm.filter = opts.filter || "all";
  hm.subjectId = opts.subjectId || null;
  hm.page = 1; hm.sel.clear();
  if (!hm.open) { hm.open = true; if (hooks.openHanmuc) hooks.openHanmuc(); }
  lsSet(RESUME_KEY, JSON.stringify({ filter: hm.filter, subjectId: hm.subjectId }));
  hooks.syncLayout();
  loadFiles();
  if (!hm.quota) refresh();
}
// keepPending: rời tạm (vd. chuyển công cụ) — vẫn nhớ tệp đang chờ tải.
export function closeClean(keepPending) {
  if (!hm.open) return;
  commitDelete();
  hm.open = false; hm.sel.clear();
  if (!keepPending) hm.pending = null;
  lsSet(RESUME_KEY, null);
  hooks.syncLayout();
}
export function resumeIfNeeded() {
  var raw = lsGet(RESUME_KEY);
  if (!raw || !isOnline()) return;
  try { var o = JSON.parse(raw); openClean(o); } catch (e) { lsSet(RESUME_KEY, null); }
}

async function loadFiles() {
  hm.loading = true; renderClean();
  var path = "/me/files?filter=" + hm.filter + (hm.filter === "subject" && hm.subjectId ? "&subject_id=" + encodeURIComponent(hm.subjectId) : "");
  var res = await apiAuth("GET", path, authToken());
  hm.loading = false;
  hm.files = res.ok ? res.data : [];
  renderClean();
}

var COLORS = { pdf: "#0A1A4D", chat: "#6B789E", fb: "#B5BACA" };
var TYPE = { pdf: "PDF", chat: "Ảnh / tệp đính kèm chat", fb: "Ảnh góp ý" };
function key(f) { return f.type + ":" + f.id; }
function visibleFiles() { var hidden = hm.del ? hm.del.keys : null; return hm.files.filter(function (f) { return !hidden || !hidden.has(key(f)); }); }
function selFiles() { return visibleFiles().filter(function (f) { return hm.sel.has(key(f)); }); }
function pendingFreed() { return hm.del ? hm.del.bytes : 0; }

function renderClean() {
  if (!hm.open || !$("hm-pane")) return;
  var q = hm.quota;
  if (q) {
    var s = q.storage, used = s.used_bytes - pendingFreed(), by = s.by_type;
    $("hm-sub").textContent = "Đã dùng " + mbf(used) + " / " + mb0(s.limit_bytes) + " MB (" + Math.round(used / s.limit_bytes * 100) + "%) · tệp đã xoá không khôi phục được sau 6 giây";
    $("hm-ubar").innerHTML = ["pdf", "chat", "fb"].map(function (t) { return '<b style="width:' + (by[t] / s.limit_bytes * 100) + "%;background:" + COLORS[t] + '"></b>'; }).join("");
    $("hm-legend").innerHTML = '<span><i style="background:' + COLORS.pdf + '"></i>Tài liệu PDF <b>' + mbf(by.pdf) + ' MB</b></span><span><i style="background:' + COLORS.chat
      + '"></i>Đính kèm chat <b>' + mbf(by.chat) + ' MB</b></span><span><i style="background:' + COLORS.fb + '"></i>Ảnh góp ý <b>' + mbf(by.fb)
      + ' MB</b></span><span><i style="background:var(--hm-track)"></i>Còn trống <b>' + mbf(Math.max(0, s.limit_bytes - used)) + " MB</b></span>";
    var selMb = selFiles().reduce(function (a, f) { return a + f.size_bytes; }, 0), need = "";
    if (hm.pending) {
      var fr = Math.max(0, s.limit_bytes - used), lack = hm.pending.file.size - fr;
      need = lack > 0
        ? '<div class="hm-need r"><span>Cần xoá thêm <b>' + mbf(lack) + " MB</b> để tải <b>" + esc(hm.pending.file.name) + "</b> (" + mbf(hm.pending.file.size) + " MB)."
          + (selMb ? " Đã chọn " + mbf(selMb) + " MB" + (selMb >= lack ? " — đủ rồi" : "") + "." : "") + '</span><span class="sp"></span><button type="button" class="hm-link" id="hm-cancel-pend">Bỏ tải tệp này</button></div>'
        : '<div class="hm-need g"><span>Đã đủ chỗ cho <b>' + esc(hm.pending.file.name) + '</b>.</span><span class="sp"></span><button type="button" class="hm-btn sm pri" id="hm-do-pend">Tải lên ngay</button></div>';
    } else if (s.level) {
      need = '<div class="hm-need ' + (s.level >= 2 ? "r" : "n") + '"><span>' + (s.level === 3 ? "Dung lượng đã đầy — đang chặn tải tệp mới." : s.level === 2 ? "Sắp đầy: còn " + mbf(Math.max(0, s.limit_bytes - used)) + " MB." : "Bạn đã dùng hơn " + q.warn.w1 + "% dung lượng.")
        + " Bắt đầu với tệp trùng và tệp bị lỗi — xoá chúng không làm mất nội dung.</span></div>";
    }
    $("hm-need").innerHTML = need;
    if ($("hm-cancel-pend")) $("hm-cancel-pend").onclick = function () { hm.pending = null; renderClean(); };
    if ($("hm-do-pend")) $("hm-do-pend").onclick = doPending;
  }
  // bộ lọc
  var subjName = "";
  if (q && hm.subjectId) { var sb = q.storage.subjects.find(function (x) { return x.id === hm.subjectId; }); subjName = sb ? sb.name : ""; }
  var fl = [["all", "Lớn nhất trước"], ["dup", "Tệp trùng"], ["old", "Chưa mở 30 ngày"], ["err", "Bị lỗi xử lý"]];
  if (hm.subjectId && subjName) fl.push(["subject", "Môn " + subjName]);
  $("hm-filters").innerHTML = fl.map(function (x) { return '<button type="button" class="hm-pill' + (hm.filter === x[0] ? " on" : "") + '" data-f="' + x[0] + '">' + esc(x[1]) + "</button>"; }).join("");
  // bảng
  var list = visibleFiles(), pages = Math.max(1, Math.ceil(list.length / hm.per));
  if (hm.page > pages) hm.page = pages;
  var rows = list.slice((hm.page - 1) * hm.per, hm.page * hm.per);
  var allSel = rows.length && rows.every(function (f) { return hm.sel.has(key(f)); }), someSel = rows.some(function (f) { return hm.sel.has(key(f)); });
  var head = '<div class="hm-tr h"><button type="button" class="hm-cb' + (allSel ? " on" : someSel ? " mid" : "") + '" id="hm-selall" aria-label="Chọn cả trang"></button><span>Tệp</span><span>Mở gần nhất</span><span>Ghi chú</span><span class="hm-sz">Dung lượng</span></div>';
  var body = hm.loading ? '<div class="hm-empty">Đang tải…</div>' : rows.length ? rows.map(function (f) {
    var opened = f.opened_days_ago == null ? "—" : f.opened_days_ago === 0 ? "Hôm nay" : f.opened_days_ago + " ngày trước";
    var note = f.dup_of ? '<span class="hm-chip a" title="Trùng nội dung với ' + esc(f.dup_of) + '">Trùng tệp khác</span>'
      : f.status === "ocr_error" ? '<span class="hm-chip r">Lỗi OCR</span>' : f.status === "empty" ? '<span class="hm-chip r">Tệp trống</span>'
      : f.status === "processing" ? '<span class="hm-chip gr">Đang xử lý…</span>' : f.cited ? '<span class="hm-chip n">AI trích dẫn ' + f.cited + " lần</span>" : '<span style="color:var(--muted)">—</span>';
    return '<div class="hm-tr r' + (hm.sel.has(key(f)) ? " sel" : "") + '" data-k="' + esc(key(f)) + '"><span class="hm-cb"></span><div class="hm-two"><b>' + esc(f.name) + "</b><small>"
      + esc((f.subject_name ? f.subject_name + " · " : "") + TYPE[f.type]) + "</small></div><span>" + opened + "</span><span>" + note + '</span><span class="hm-sz">' + mbf(f.size_bytes) + " MB</span></div>";
  }).join("") : '<div class="hm-empty"><b>Không còn tệp nào trong mục này</b>Thử mục “Lớn nhất trước”.</div>';
  var foot = '<div class="hm-tfoot"><span>Trang ' + hm.page + " / " + pages + " · " + list.length + " tệp</span><span style=\"flex:1\"></span>" + perSelectHtml(hm.per, PER_OPTS, "tệp")
    + (pages > 1 ? '<div class="hm-pg" id="hm-pg"></div>' : "") + "</div>";
  $("hm-table").innerHTML = head + body + foot;
  bindPerSelect($("hm-table"), "hm_files", function (v) { hm.per = v; hm.page = 1; renderClean(); });
  if (pages > 1) {
    var pg = $("hm-pg"), add = function (t, p, dis, on) { var b = document.createElement("button"); b.type = "button"; b.textContent = t; b.disabled = dis; if (on) b.className = "on"; b.onclick = function () { hm.page = p; renderClean(); }; pg.appendChild(b); };
    add("‹", hm.page - 1, hm.page === 1); for (var i = 1; i <= pages; i++) add(i, i, false, i === hm.page); add("›", hm.page + 1, hm.page === pages);
  }
  // thanh chọn
  var sel = selFiles(), n = sel.length, bytes = sel.reduce(function (a, f) { return a + f.size_bytes; }, 0), cites = sel.reduce(function (a, f) { return a + (f.cited || 0); }, 0);
  $("hm-selbar").innerHTML = n ? "<span>Đã chọn <b>" + n + " tệp · " + mbf(bytes) + " MB</b><br><small>" + (cites ? cites + " trích dẫn AI đang trỏ tới các tệp này sẽ hiện “Nguồn đã bị xoá”" : "Không có câu trả lời AI nào trích dẫn các tệp này")
    + '</small></span><span class="sp"></span><button type="button" class="hm-btn sm" id="hm-selclear">Bỏ chọn</button><button type="button" class="hm-btn sm dan" id="hm-seldel">Xoá ' + n + " tệp</button>"
    : '<span style="color:var(--muted)">Chọn tệp để xoá. Tệp trùng và tệp bị lỗi có thể xoá mà không mất nội dung.</span>';
  if (n) { $("hm-selclear").onclick = function () { hm.sel.clear(); renderClean(); }; $("hm-seldel").onclick = confirmDel; }
}

function bindPane() {
  if (!$("hm-pane") || $("hm-pane").dataset.bound) return;
  $("hm-pane").dataset.bound = "1";
  $("hm-back").onclick = function () { closeClean(); };
  $("hm-filters").onclick = function (e) { var b = e.target.closest(".hm-pill"); if (!b) return; hm.filter = b.dataset.f; hm.page = 1; hm.sel.clear(); lsSet(RESUME_KEY, JSON.stringify({ filter: hm.filter, subjectId: hm.subjectId })); loadFiles(); };
  $("hm-table").onclick = function (e) {
    if (e.target.closest("#hm-selall")) {
      var list = visibleFiles(), rows = list.slice((hm.page - 1) * hm.per, hm.page * hm.per);
      var all = rows.every(function (f) { return hm.sel.has(key(f)); });
      rows.forEach(function (f) { if (all) hm.sel.delete(key(f)); else hm.sel.add(key(f)); });
      renderClean(); return;
    }
    var r = e.target.closest(".hm-tr.r"); if (!r) return;
    if (hm.sel.has(r.dataset.k)) hm.sel.delete(r.dataset.k); else hm.sel.add(r.dataset.k);
    renderClean();
  };
}

function confirmDel() {
  var items = selFiles(), bytes = items.reduce(function (a, f) { return a + f.size_bytes; }, 0), cites = items.reduce(function (a, f) { return a + (f.cited || 0); }, 0);
  modal("<h2>Xoá " + items.length + " tệp (" + mbf(bytes) + " MB)?</h2><ul>" + items.slice(0, 4).map(function (f) { return "<li>" + esc(f.name) + " · " + mbf(f.size_bytes) + " MB</li>"; }).join("")
    + (items.length > 4 ? "<li>và " + (items.length - 4) + " tệp khác</li>" : "") + "</ul>"
    + (cites ? '<div class="hm-warnbox">' + cites + " trích dẫn AI đang trỏ tới các tệp này sẽ hiện “Nguồn đã bị xoá”. Ghi chú, Flashcard và Quiz đã tạo vẫn giữ nguyên.</div>" : "")
    + '<p class="hm-msub" style="margin:0">Bạn có 6 giây để hoàn tác sau khi xoá.</p><div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Huỷ</button><button type="button" class="hm-btn sm dan" id="hm-mok">Xoá tệp</button></div>',
    function (m) {
      m.querySelector("#hm-mc").onclick = closeModal;
      m.querySelector("#hm-mok").onclick = function () { closeModal(); startDelete(items, bytes); };
    });
}

// Xoá "mềm" 6 giây: ẩn khỏi bảng ngay, chỉ gửi POST /me/files/delete khi hết giờ / xoá đợt khác / rời màn / đóng tab.
function startDelete(items, bytes) {
  commitDelete();
  hm.del = { keys: new Set(items.map(key)), items: items, bytes: bytes, timer: setTimeout(commitDelete, UNDO_MS) };
  hm.sel.clear();
  renderClean();
  var enough = hm.pending && hm.quota && hm.pending.file.size <= Math.max(0, hm.quota.storage.limit_bytes - hm.quota.storage.used_bytes + bytes);
  toast(enough ? "Đã xoá " + items.length + " tệp · đã đủ chỗ cho " + hm.pending.file.name : "Đã xoá " + items.length + " tệp · giải phóng " + mbf(bytes) + " MB",
    function () { if (!hm.del) return; clearTimeout(hm.del.timer); hm.del = null; renderClean(); });
}
function deleteBody(items) {
  return {
    pdf_ids: items.filter(function (f) { return f.type === "pdf"; }).map(function (f) { return f.id; }),
    attachment_ids: items.filter(function (f) { return f.type === "chat"; }).map(function (f) { return f.id; }),
    feedback_ids: items.filter(function (f) { return f.type === "fb"; }).map(function (f) { return +f.id; }),
  };
}
export async function commitDelete() {
  var d = hm.del; if (!d) return;
  clearTimeout(d.timer); hm.del = null;
  var res = await apiAuth("POST", "/me/files/delete", authToken(), deleteBody(d.items));
  if (!res.ok) { toast((res.data && res.data.detail) || "Không xoá được tệp.", null, true); }
  hm.files = hm.files.filter(function (f) { return !d.keys.has(key(f)); });
  if (hooks.onFilesDeleted) hooks.onFilesDeleted(d.items.filter(function (f) { return f.type === "pdf"; }).map(function (f) { return f.id; }));
  await refresh();
}
addEventListener("pagehide", function () {
  var d = hm.del; if (!d) return;
  try {
    fetch(API_BASE + "/me/files/delete", { method: "POST", keepalive: true,
      headers: { Authorization: "Bearer " + authToken(), "Content-Type": "application/json" }, body: JSON.stringify(deleteBody(d.items)) });
  } catch (e) { /* bỏ qua */ }
});

async function doPending() {
  var p = hm.pending; if (!p) return;
  await commitDelete();
  hm.pending = null;
  closeClean();
  p.proceed();
}

/* ---------------- khởi động ---------------- */
export function initHanmuc() {
  bindPane();
  if (!isOnline()) return;
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, 120000);   // đổi ngày (00:00) / admin đổi hạn mức
}

/* ---------------- hộp xem thông báo từ quản trị viên ---------------- */
// feedback: phản hồi góp ý (lấy đủ nội dung từ GET /feedback/mine); file_removed: lý do xoá tệp (detail).
function fmtWhen(iso) {
  var d = new Date(iso), p = function (v) { return String(v).padStart(2, "0"); };
  return p(d.getHours()) + ":" + p(d.getMinutes()) + " ngày " + p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
}
export async function showNotice(n) {
  var body = '<p class="hm-msub">' + esc(n.detail || "") + "</p>";
  if (n.kind === "feedback" && isOnline()) {
    var res = await apiAuth("GET", "/feedback/mine", authToken());
    var f = res.ok ? res.data.find(function (x) { return String(x.id) === String(n.refId); }) : null;
    // Admin gửi được NHIỀU phản hồi cho 1 góp ý: mỗi thông báo hiện đúng tin của nó (detail ≤ 255 ký tự); tin dài bị cắt
    // thì lấy bản đầy đủ f.reply nếu đó chính là tin gần nhất.
    var msg = n.detail || "";
    if (f && f.reply && f.reply.length > msg.length && f.reply.indexOf(msg) === 0) msg = f.reply;
    if (f) body = '<div class="hm-quote">Góp ý #GY-' + f.id + " · " + esc(f.title) + '</div><div class="hm-box"><b>Phản hồi của quản trị viên</b><span>' + esc(msg) + "</span></div>";
  }
  // UC-33: quản trị viên đổi hạn mức — lý do + từng thay đổi cũ -> mới + tạm thời tới đâu (bản đầy đủ ở máy chủ).
  if (n.kind === "quota_change" && isOnline() && n.refId) {
    var cr = await apiAuth("GET", "/me/quota/changes/" + n.refId, authToken());
    if (cr.ok) {
      var c = cr.data, num = function (v) { return Number(v).toLocaleString("vi-VN"); };
      var rows = c.changes.map(function (x) {
        var u = x.unit === "%" ? "%" : " " + x.unit;
        return "<li>" + esc(x.name) + ": " + num(x.from) + u + " → <b>" + num(x.to) + u + "</b></li>";
      }).join("");
      var when = c.expires_at ? '<p class="hm-msub">Áp dụng tạm thời tới <b>' + esc(fmtWhen(c.expires_at)) + "</b>, sau đó tự trở về mức cố định.</p>" : "";
      body = '<p class="hm-msub">' + (c.kind === "revert" ? "Hệ thống" : "Quản trị viên") + " · " + esc(fmtWhen(c.created_at)) + "</p>" +
        '<div class="hm-box"><b>' + (c.kind === "revert" ? "Thông báo của hệ thống" : "Lý do của quản trị viên") + "</b><span>" + esc(c.reason) + "</span></div>" +
        '<div class="hm-chg-h">Hạn mức mới</div><ul class="hm-chg">' + rows + "</ul>" + when;
    }
  }
  modal("<h2>" + esc(n.title) + "</h2>" + body + '<div class="hm-mf"><button type="button" class="hm-btn sm pri" id="hm-mc">Đã hiểu</button></div>',
    function (m) { m.querySelector("#hm-mc").onclick = closeModal; });
}
