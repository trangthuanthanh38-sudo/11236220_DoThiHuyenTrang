/* ======================================================================
   ghichu_chiase.js — CHIA SẺ Môn học / Chương, làm giống Word / OneNote nhất có thể
   (backend: routers/shares.py + knowledge.py, DB: database/sharing_schema.sql).

   Người dùng chốt: chia sẻ CẢ MÔN (như sổ tay OneNote — mọi Chương + PDF) hoặc TỪNG CHƯƠNG (như 1 tài liệu Word);
   quyền "Có thể chỉnh sửa" / "Có thể xem"; mời theo SĐT / Gmail + "Sao chép liên kết"; AI Studio KHÔNG dùng nội dung
   được chia sẻ (muốn dùng thì "Tạo bản sao" về Notebook của mình).

   Phụ trách:
     - Hộp "Chia sẻ" (nút Chia sẻ ở topbar / "Chia sẻ…" ở menu ⋯ của Môn, Chương): mời người (ô SĐT / Gmail + quyền +
       lời nhắn), liên kết (Ai có liên kết / Chỉ người có quyền truy cập, Xem / Chỉnh sửa, Tắt liên kết, Sao chép), danh
       sách "Những người có quyền truy cập" (đổi quyền / xoá quyền; quyền qua cả Môn hiện "qua môn"). Chỉ CHỦ SỞ HỮU
       quản lý; người được chia sẻ mở hộp chỉ xem danh sách + sao chép liên kết.
     - "Được chia sẻ với tôi" (state.shared, vẽ ở ghichu_soanthao.js renderSharedTree) + menu ⋯ riêng: Mở / Chia sẻ… /
       Tạo bản sao / Xoá khỏi danh sách.
     - Mở liên kết ghichu.html?share=<token> (chưa đăng nhập -> html/xem.html chỉ xem; "Chỉ người có quyền" -> hộp xin
       quyền) và ?open=<subject|chapter>:<id> (nút "Mở" trong email mời).
     - Cùng sửa 1 Chương (CKEditor bản miễn phí không có đồng soạn thảo thời gian thực): nhịp 10 giây GET
       /chapters/{id}/sync -> avatar "Đang xem" cạnh nút Chia sẻ, người khác vừa lưu mà mình không đang gõ dở thì tự tải
       bản mới; đang gõ dở hoặc lưu bị 409 thì thanh vàng "… vừa sửa chương này" [Xem bản mới nhất] [Giữ bản của tôi].
     - Thanh dưới breadcrumb: "Chỉ xem · X đã chia sẻ với bạn [Tạo bản sao]" / "Có thể chỉnh sửa · Chia sẻ bởi X ·
       Sửa lần cuối: Y, 3 phút trước".
   Chỉ import ghichu_core.js + ghichu_soanthao.js (mở Chương / PDF, lưu, đổ bản mới).
   ====================================================================== */
import {
  hooks, state, $, el, esc, isOnline, authToken, persist, sharedSubject, itemRole, chapterInSub, pdfInSub, findSubject,
} from "./ghichu_core.js";
import * as Soanthao from "./ghichu_soanthao.js";

var ROLE_TEXT = { editor: "Có thể chỉnh sửa", viewer: "Có thể xem", owner: "Chủ sở hữu" };
var SYNC_MS = 10000;
var ICO = {
  link: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>',
  lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  globe: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  pen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
  people: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"></path><path d="M17 8v6M14 11h6"></path></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4.5 4.5V21H6z"/><path d="M14 3v5h4.5"/></svg>',
  leave: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
};

/* ---------------- tiện ích ---------------- */
function avatar(p, cls) { return '<span class="' + (cls || "sh-av") + '">' + Soanthao.avatarHtml(p) + "</span>"; }
function agoText(sec) {
  if (sec == null) return "";
  if (sec < 60) return "vừa xong";
  if (sec < 3600) return Math.floor(sec / 60) + " phút trước";
  if (sec < 86400) return Math.floor(sec / 3600) + " giờ trước";
  return Math.floor(sec / 86400) + " ngày trước";
}
function myName() { var u = hooks.currentUser(); return (u && u.name) || ""; }
function linkUrl(token) { return location.origin + location.pathname.replace(/[^/]*$/, "") + "ghichu.html?share=" + token; }
function detailMsg(res, fallback) {
  var d = res && res.data && res.data.detail;
  if (!d) return fallback;
  if (typeof d === "string") return d;
  if (d.message) return d.message;
  if (Array.isArray(d) && d[0] && d[0].msg) return d[0].msg;
  return fallback;
}
// Mục của mình đang được chia sẻ (biểu tượng người ở cây) — cần nhịp đồng bộ / avatar "Đang xem"
function ownShared(a) {
  var sub = state.subjects.find(function (s) { return s.id === a.s; });
  if (!sub) return false;
  if (sub.isShared) return true;
  var c = a.kind === "chapter" && chapterInSub(sub, a.id);
  return !!(c && c.isShared);
}
function markShared(type, id) {
  state.subjects.forEach(function (s) {
    if (type === "subject" && s.id === id) s.isShared = true;
    if (type === "chapter") s.chapters.forEach(function (c) { if (c.id === id) c.isShared = true; });
  });
  persist();
}

/* ====================================================================
   "Được chia sẻ với tôi"
   ==================================================================== */
var sharedLoaded = null;
export function loadShared() {
  if (!isOnline()) return Promise.resolve();
  sharedLoaded = apiAuth("GET", "/shares/with-me", authToken()).then(function (res) {
    if (!res.ok || !Array.isArray(res.data)) return;
    state.shared = res.data.map(function (s) {
      return {
        id: s.subject_id, name: s.subject_name, shared: true, owner: s.owner, whole: s.whole, role: s.role, shareId: s.share_id,
        chapters: s.chapters.map(function (c) { return { id: c.id, name: c.name, role: c.role, shareId: c.share_id, protected: !!c.protected }; }),
        pdfs: s.pdfs.map(function (p) {
          state.pdfs[p.id] = Object.assign({ annotations: [] }, state.pdfs[p.id] || {}, { name: p.name });
          return { id: p.id, name: p.name, role: p.role, pageCount: p.page_count };
        }),
      };
    });
    var a = state.active;
    if (a && a.shared) {
      var sub = sharedSubject(a.s);
      var item = sub && (a.kind === "pdf" ? pdfInSub(sub, a.id) : chapterInSub(sub, a.id));
      if (!item) { state.active = null; persist(); Soanthao.loadActiveIntoEditor(); }
      else if (a.kind === "chapter") Soanthao.selectChapter(a.s, a.id);
      else Soanthao.selectPdf(a.s, a.id);
    }
    hooks.renderAll();
  });
  return sharedLoaded;
}

function openItem(subjectId, kind, id) {
  hooks.showNotebook();
  state.open[subjectId] = true;
  if (kind === "pdf") Soanthao.selectPdf(subjectId, id);
  else Soanthao.selectChapter(subjectId, id);
}

/* Mở đúng mục theo id (thông báo "đã chia sẻ với bạn", ?open=, liên kết): Môn -> mở rộng + mở Chương đầu. */
export function openTarget(type, id) {
  return (sharedLoaded || loadShared()).then(function () {
    var all = state.subjects.concat(state.shared);
    var sub = all.find(function (s) { return s.id === id; });
    if (sub) {
      hooks.showNotebook();
      state.open[sub.id] = true;
      var first = sub.chapters[0];
      if (first) Soanthao.selectChapter(sub.id, first.id);
      else if (sub.pdfs[0]) Soanthao.selectPdf(sub.id, sub.pdfs[0].id);
      else hooks.renderAll();
      return true;
    }
    for (var i = 0; i < all.length; i++) {
      if (chapterInSub(all[i], id)) { openItem(all[i].id, "chapter", id); return true; }
    }
    window.alert("Nội dung này không còn được chia sẻ với bạn (hoặc đã bị xoá).");
    return false;
  });
}

/* ====================================================================
   Mở liên kết chia sẻ / ?open=
   ==================================================================== */
function handleUrl() {
  var u = new URL(location.href);
  var tok = u.searchParams.get("share"), open = u.searchParams.get("open");
  // Bấm "Đăng nhập để lưu bản sao" ở trang xem công khai (xem.js) -> đăng nhập xong mở lại đúng liên kết
  var pending = null;
  try { pending = localStorage.getItem("td_pending_share"); localStorage.removeItem("td_pending_share"); } catch (e) { /* bỏ qua */ }
  if (!tok && !open && pending) { acceptLink(pending); return; }
  if (!tok && !open) return;
  u.searchParams.delete("share"); u.searchParams.delete("open");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
  if (tok) { acceptLink(tok); return; }
  var parts = open.split(":");
  if (parts.length === 2) openTarget(parts[0], parts[1]);
}

function acceptLink(tok) {
  apiAuth("POST", "/shares/link/" + encodeURIComponent(tok) + "/accept", authToken()).then(function (res) {
    if (res.ok && res.data) {
      var d = res.data;
      var reload = d.role === "owner" ? Soanthao.bootKnowledgeTree() : loadShared();
      reload.then(function () { openTarget(d.target_type, d.target_id); });
      return;
    }
    var det = res.data && res.data.detail;
    if (res.status === 403 && det && det.code === "need_access") { showNeedAccess(tok, det); return; }
    showMessage("Không mở được liên kết", detailMsg(res, "Liên kết không tồn tại hoặc đã bị tắt."));
  });
}

/* ====================================================================
   Khung hộp thoại dùng chung (Chia sẻ / Xin quyền / Tạo bản sao / thông báo)
   ==================================================================== */
var overlay = null;
function openOverlay(html, cls) {
  closeOverlay();
  overlay = el("div", "sh-overlay");
  overlay.innerHTML = '<div class="sh-dialog ' + (cls || "") + '" role="dialog" aria-modal="true">' + html + "</div>";
  overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) closeOverlay(); });
  overlay.addEventListener("click", function (e) { e.stopPropagation(); });
  document.body.appendChild(overlay);
  var x = overlay.querySelector(".sh-x");
  if (x) x.addEventListener("click", closeOverlay);
  return overlay.firstChild;
}
function closeOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
  dlg = null;
  if (lookupTimer) clearTimeout(lookupTimer);
}
export function isOverlayOpen() { return !!overlay; }
function head(title) {
  return '<div class="sh-head"><h2 class="sh-title">' + title + '</h2><button type="button" class="sh-x" aria-label="Đóng" title="Đóng">×</button></div>';
}
function showMessage(title, text) {
  var box = openOverlay(head(esc(title)) + '<p class="sh-text">' + esc(text) + '</p><div class="sh-foot"><button type="button" class="sh-btn sh-btn--primary" id="sh-ok">Đóng</button></div>', "sh-dialog--sm");
  box.querySelector("#sh-ok").addEventListener("click", closeOverlay);
}

function showNeedAccess(tok, det) {
  var box = openOverlay(head("Bạn cần quyền truy cập") +
    '<div class="sh-need"><span class="sh-need-ico">' + ICO.lock + "</span><p>Liên kết này chỉ dành cho những người <b>" + esc(det.owner_name || "chủ sở hữu") +
    "</b> đã cấp quyền. Gửi yêu cầu để chủ sở hữu thêm bạn.</p></div>" +
    '<div class="sh-foot"><button type="button" class="sh-btn" id="sh-cancel">Huỷ</button><button type="button" class="sh-btn sh-btn--primary" id="sh-req">Yêu cầu quyền truy cập</button></div>', "sh-dialog--sm");
  box.querySelector("#sh-cancel").addEventListener("click", closeOverlay);
  box.querySelector("#sh-req").addEventListener("click", function () {
    var b = this; b.disabled = true; b.textContent = "Đang gửi…";
    apiAuth("POST", "/shares/link/" + encodeURIComponent(tok) + "/request", authToken()).then(function (res) {
      if (!res.ok) { b.disabled = false; b.textContent = "Yêu cầu quyền truy cập"; window.alert(detailMsg(res, "Không gửi được yêu cầu.")); return; }
      box.querySelector(".sh-need p").innerHTML = "Đã gửi yêu cầu tới <b>" + esc(det.owner_name || "chủ sở hữu") + "</b>. Bạn sẽ nhận thông báo khi được cấp quyền.";
      box.querySelector(".sh-foot").innerHTML = '<button type="button" class="sh-btn sh-btn--primary" id="sh-ok">Đóng</button>';
      box.querySelector("#sh-ok").addEventListener("click", closeOverlay);
    });
  });
}

/* ====================================================================
   HỘP CHIA SẺ
   ==================================================================== */
var dlg = null;            // {type, id, chapterCtx, subjectId, data, chips:[], role, message, found, lookupMsg, linkOpen, copied}
var lookupTimer = null;

// Nút "Chia sẻ" ở topbar: chia sẻ mục đang mở (PDF không chia sẻ riêng -> chia sẻ cả Môn chứa nó)
function shareActive() {
  if (!isOnline()) { showLoginNeeded(); return; }
  var a = state.active;
  if (!a) {
    showMessage("Chia sẻ", "Mở một Chương để chia sẻ, hoặc chọn \"Chia sẻ…\" ở menu ⋯ của một Môn học trong cột Notebooks.");
    return;
  }
  if (a.kind === "pdf") openShare({ type: "subject", id: a.s, note: "Tệp PDF được chia sẻ cùng cả môn học." });
  else openShare({ type: "chapter", id: a.id });
}

function showLoginNeeded() {
  var box = openOverlay(head("Chia sẻ") + '<p class="sh-text">Đăng nhập để chia sẻ Môn học hoặc Chương với bạn bè — mời theo SĐT / Gmail hoặc gửi liên kết, giống Word và OneNote.</p>' +
    '<div class="sh-foot"><button type="button" class="sh-btn" id="sh-cancel">Để sau</button><a class="sh-btn sh-btn--primary" href="dangnhap.html">Đăng nhập</a></div>', "sh-dialog--sm");
  box.querySelector("#sh-cancel").addEventListener("click", closeOverlay);
}

/* target {type:'subject'|'chapter', id, note?, prefill?: {id, name}} */
export function openShare(target) {
  if (!isOnline()) { showLoginNeeded(); return; }
  var subjectId = target.type === "subject" ? target.id : null;
  if (!subjectId) {
    var all = state.subjects.concat(state.shared);
    var s = all.find(function (x) { return chapterInSub(x, target.id); });
    subjectId = s ? s.id : null;
  }
  openOverlay('<div class="sh-loading">Đang tải…</div>', "sh-dialog--share");   // trước khi gán dlg: openOverlay xoá dlg cũ
  dlg = {
    type: target.type, id: target.id, chapterCtx: target.type === "chapter" ? target.id : null, subjectId: subjectId,
    note: target.note || "", data: null, chips: [], role: "editor", message: "", found: null, lookupMsg: "", linkOpen: false, copied: false,
  };
  if (target.prefill && target.prefill.id) dlg.chips.push({ id: target.prefill.id, name: target.prefill.name || "Người yêu cầu", avatar: null, contact: "" });
  loadTarget();
}

function loadTarget() {
  var d = dlg;
  apiAuth("GET", "/shares/" + d.type + "/" + d.id, authToken()).then(function (res) {
    if (dlg !== d) return;
    if (!res.ok) { showMessage("Chia sẻ", detailMsg(res, "Không tải được thông tin chia sẻ.")); return; }
    d.data = res.data;
    d.subjectId = res.data.subject_id;
    renderShare();
  });
}

function renderShare(focusInput) {
  var d = dlg; if (!d || !d.data || !overlay) return;
  var t = d.data, box = overlay.firstChild;
  var canManage = t.can_manage;
  var html = head('Chia sẻ <span class="sh-title-name">“' + esc(t.name) + '”</span>');

  // Chương này | Cả môn — chỉ chủ sở hữu, khi mở từ 1 Chương (như OneNote: chia sẻ trang hay cả sổ)
  if (d.chapterCtx && canManage) {
    html += '<div class="sh-scope" role="tablist">' +
      '<button type="button" role="tab" class="' + (d.type === "chapter" ? "on" : "") + '" data-scope="chapter">' + ICO.open + "Chương này</button>" +
      '<button type="button" role="tab" class="' + (d.type === "subject" ? "on" : "") + '" data-scope="subject">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/></svg>' +
      'Cả môn “' + esc(t.subject_name) + "”</button></div>";
  }
  if (d.note) html += '<p class="sh-note">' + esc(d.note) + "</p>";

  if (canManage) {
    html += '<div class="sh-invite">' +
      '<div class="sh-field"><div class="sh-chips">' +
      d.chips.map(function (c, i) { return '<span class="sh-chip">' + avatar(c, "sh-av sh-av--xs") + esc(c.name) + '<button type="button" data-unchip="' + i + '" aria-label="Bỏ ' + esc(c.name) + '">×</button></span>'; }).join("") +
      '<input type="text" id="sh-input" autocomplete="off" placeholder="' + (d.chips.length ? "Thêm người khác" : "Nhập SĐT hoặc Gmail để mời") + '">' +
      "</div>" + roleSelect("sh-role", d.role) + "</div>";
    if (d.found) {
      html += '<button type="button" class="sh-suggest" id="sh-suggest">' + avatar(d.found) + '<span class="sh-p-tx"><b>' + esc(d.found.name) + "</b><small>" + esc(d.found.contact || "") + "</small></span>" +
        (d.found.has ? '<span class="sh-tag">Đã có quyền</span>' : '<span class="sh-add">Thêm</span>') + "</button>";
    } else if (d.lookupMsg) {
      html += '<p class="sh-lookup-msg">' + esc(d.lookupMsg) + "</p>";
    }
    if (d.chips.length) {
      html += '<textarea id="sh-msg" class="sh-msg" rows="2" maxlength="500" placeholder="Thêm lời nhắn (không bắt buộc)">' + esc(d.message) + "</textarea>" +
        '<div class="sh-send-row"><span class="sh-hint">Người được mời nhận thông báo trong ứng dụng' + " (và email nếu có)." + '</span><button type="button" class="sh-btn sh-btn--primary" id="sh-send">Gửi</button></div>';
    }
    html += "</div>";
  } else {
    html += '<p class="sh-note">Chỉ chủ sở hữu <b>' + esc(t.owner.name) + "</b> mới mời thêm người hoặc đổi quyền. Quyền của bạn: <b>" + ROLE_TEXT[t.my_role] + "</b>.</p>";
  }

  // Liên kết
  var L = t.link;
  var lt, ls, li;
  if (!L) { li = ICO.link; lt = "Chưa bật liên kết"; ls = canManage ? "Sao chép liên kết để tạo — mặc định ai có liên kết đều có thể xem." : "Chủ sở hữu chưa bật liên kết chia sẻ."; }
  else if (L.audience === "anyone") { li = ICO.globe; lt = "Ai có liên kết đều " + (L.role === "editor" ? "có thể chỉnh sửa" : "có thể xem"); ls = L.role === "editor" ? "Người đã đăng nhập mở liên kết được chỉnh sửa; người chưa đăng nhập chỉ xem." : "Kể cả người chưa đăng nhập (chỉ xem)."; }
  else { li = ICO.lock; lt = "Chỉ những người có quyền truy cập"; ls = "Người khác mở liên kết sẽ phải gửi yêu cầu quyền truy cập."; }
  html += '<div class="sh-sec sh-link"><div class="sh-link-row"><span class="sh-link-ico' + (L ? " on" : "") + '">' + li + '</span><span class="sh-link-tx"><b>' + lt + "</b><small>" + ls + "</small></span>" +
    (canManage && L ? '<button type="button" class="sh-btn sh-btn--ghost" id="sh-link-set" aria-expanded="' + d.linkOpen + '">Cài đặt</button>' : "") +
    (L || canManage ? '<button type="button" class="sh-btn' + (d.copied ? " sh-btn--done" : "") + '" id="sh-copy">' + ICO.copy + (d.copied ? "Đã sao chép" : "Sao chép liên kết") + "</button>" : "") + "</div>";
  if (canManage && L && d.linkOpen) {
    html += '<div class="sh-link-set">' +
      '<label class="sh-radio"><input type="radio" name="sh-aud" value="anyone"' + (L.audience === "anyone" ? " checked" : "") + '><span><b>Ai có liên kết</b><small>Không cần đăng nhập để xem</small></span></label>' +
      '<label class="sh-radio"><input type="radio" name="sh-aud" value="invited"' + (L.audience === "invited" ? " checked" : "") + '><span><b>Chỉ người có quyền truy cập</b><small>Người được mời trong danh sách bên dưới</small></span></label>' +
      (L.audience === "anyone" ? '<div class="sh-link-role"><span>Người đã đăng nhập mở liên kết</span>' + roleSelect("sh-link-role", L.role) + "</div>" : "") +
      '<button type="button" class="sh-linkoff" id="sh-link-off">Tắt liên kết</button></div>';
  }
  html += "</div>";

  // Người có quyền truy cập
  html += '<div class="sh-sec"><div class="sh-sec-h">Những người có quyền truy cập</div><ul class="sh-people">';
  var me = myName();
  html += '<li>' + avatar(t.owner) + '<span class="sh-p-tx"><b>' + esc(t.owner.name) + (t.my_role === "owner" ? " (bạn)" : "") + "</b><small>" + esc(t.owner.contact || "") + '</small></span><span class="sh-p-role">Chủ sở hữu</span></li>';
  t.grants.forEach(function (g) {
    var sub = [g.user.contact, g.inherited ? "qua cả môn" : "", g.via === "link" ? "mở bằng liên kết" : ""].filter(Boolean).join(" · ");
    var you = t.my_role !== "owner" && g.user.name === me ? " (bạn)" : "";
    var ctl = canManage && !g.inherited
      ? '<select class="sh-sel" data-grant="' + g.id + '" aria-label="Quyền của ' + esc(g.user.name) + '">' +
        '<option value="editor"' + (g.role === "editor" ? " selected" : "") + ">Có thể chỉnh sửa</option>" +
        '<option value="viewer"' + (g.role === "viewer" ? " selected" : "") + ">Có thể xem</option>" +
        '<option value="remove">Xoá quyền truy cập</option></select>'
      : '<span class="sh-p-role">' + ROLE_TEXT[g.role] + "</span>";
    html += "<li>" + avatar(g.user) + '<span class="sh-p-tx"><b>' + esc(g.user.name) + you + "</b><small>" + esc(sub) + "</small></span>" + ctl + "</li>";
  });
  if (!t.grants.length) html += '<li class="sh-empty">Chưa chia sẻ với ai.</li>';
  html += "</ul></div>";

  box.innerHTML = html;
  box.querySelector(".sh-x").addEventListener("click", closeOverlay);
  bindShare(box, focusInput);
}

function roleSelect(id, val) {
  return '<select class="sh-sel" id="' + id + '" aria-label="Quyền">' +
    '<option value="editor"' + (val === "editor" ? " selected" : "") + ">Có thể chỉnh sửa</option>" +
    '<option value="viewer"' + (val === "viewer" ? " selected" : "") + ">Có thể xem</option></select>";
}

function bindShare(box, focusInput) {
  var d = dlg;
  box.querySelectorAll("[data-scope]").forEach(function (b) {
    b.addEventListener("click", function () {
      var sc = b.getAttribute("data-scope");
      if (sc === d.type) return;
      d.type = sc; d.id = sc === "chapter" ? d.chapterCtx : d.subjectId;
      d.found = null; d.lookupMsg = ""; d.linkOpen = false; d.copied = false;
      loadTarget();
    });
  });
  var input = box.querySelector("#sh-input");
  if (input) {
    input.addEventListener("input", function () { scheduleLookup(input.value); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); if (d.found && !d.found.has) addChip(d.found); else lookupNow(input.value); }
      if (e.key === "Backspace" && !input.value && d.chips.length) { d.chips.pop(); renderShare(true); }
    });
    if (focusInput !== false) setTimeout(function () { input.focus(); }, 0);
  }
  box.querySelectorAll("[data-unchip]").forEach(function (b) {
    b.addEventListener("click", function () { d.chips.splice(+b.getAttribute("data-unchip"), 1); renderShare(true); });
  });
  var role = box.querySelector("#sh-role");
  if (role) role.addEventListener("change", function () { d.role = role.value; });
  var sug = box.querySelector("#sh-suggest");
  if (sug) sug.addEventListener("click", function () { if (!d.found.has) addChip(d.found); });
  var msg = box.querySelector("#sh-msg");
  if (msg) msg.addEventListener("input", function () { d.message = msg.value; });
  var send = box.querySelector("#sh-send");
  if (send) send.addEventListener("click", sendInvites);
  var copy = box.querySelector("#sh-copy");
  if (copy) copy.addEventListener("click", copyLink);
  var set = box.querySelector("#sh-link-set");
  if (set) set.addEventListener("click", function () { d.linkOpen = !d.linkOpen; renderShare(false); });
  box.querySelectorAll('input[name="sh-aud"]').forEach(function (r) {
    r.addEventListener("change", function () { saveLink(r.value, d.data.link.role); });
  });
  var lr = box.querySelector("#sh-link-role");
  if (lr) lr.addEventListener("change", function () { saveLink(d.data.link.audience, lr.value); });
  var off = box.querySelector("#sh-link-off");
  if (off) off.addEventListener("click", function () {
    if (!window.confirm("Tắt liên kết? Người đang giữ liên kết cũ sẽ không mở được nữa (người đã có trong danh sách vẫn giữ quyền).")) return;
    apiAuth("DELETE", "/shares/" + d.type + "/" + d.id + "/link", authToken()).then(function (res) {
      if (!res.ok) { window.alert(detailMsg(res, "Không tắt được liên kết.")); return; }
      d.data.link = null; d.linkOpen = false; d.copied = false; renderShare(false);
    });
  });
  box.querySelectorAll("[data-grant]").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var id = sel.getAttribute("data-grant");
      if (sel.value === "remove") {
        apiAuth("DELETE", "/shares/" + id, authToken()).then(function (res) {
          if (!res.ok) { window.alert(detailMsg(res, "Không xoá được quyền.")); return; }
          d.data.grants = d.data.grants.filter(function (g) { return g.id !== id; });
          renderShare(false);
        });
        return;
      }
      apiAuth("PATCH", "/shares/" + id, authToken(), { role: sel.value }).then(function (res) {
        if (!res.ok) { window.alert(detailMsg(res, "Không đổi được quyền.")); loadTarget(); return; }
        d.data.grants.forEach(function (g) { if (g.id === id) g.role = sel.value; });
      });
    });
  });
}

var PHONE_RE = /^(0\d{9}|\+84\d{9})$/, MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function scheduleLookup(v) {
  if (lookupTimer) clearTimeout(lookupTimer);
  lookupTimer = setTimeout(function () { lookupNow(v, true); }, 350);
}
function lookupNow(v, quiet) {
  var d = dlg; if (!d) return;
  var q = String(v || "").replace(/[\s.-]/g, "");
  if (!PHONE_RE.test(q) && !MAIL_RE.test(q)) {
    var changed = d.found || d.lookupMsg;
    d.found = null;
    d.lookupMsg = quiet || !q ? "" : "Nhập đúng SĐT (0xxxxxxxxx) hoặc Gmail của tài khoản trong hệ thống.";
    if (changed || d.lookupMsg) renderKeep(v);
    return;
  }
  apiAuth("GET", "/shares/lookup?q=" + encodeURIComponent(q), authToken()).then(function (res) {
    if (dlg !== d) return;
    var p = res.ok && res.data && res.data[0];
    if (p) {
      var has = d.data.grants.some(function (g) { return g.user.id === p.id && !g.inherited; }) || d.chips.some(function (c) { return c.id === p.id; });
      d.found = Object.assign({ has: has }, p);
      d.lookupMsg = "";
    } else {
      d.found = null;
      d.lookupMsg = "Không tìm thấy tài khoản nào với " + (MAIL_RE.test(q) ? "Gmail" : "SĐT") + " này (hoặc đó là tài khoản của bạn). Người nhận cần có tài khoản trong hệ thống.";
    }
    renderKeep(v);
  });
}
// vẽ lại hộp nhưng giữ nguyên chữ đang gõ + con trỏ trong ô mời
function renderKeep(v) {
  renderShare(true);
  var input = overlay && overlay.querySelector("#sh-input");
  if (input) { input.value = v; input.setSelectionRange(v.length, v.length); }
}
function addChip(p) {
  dlg.chips.push({ id: p.id, name: p.name, avatar: p.avatar, contact: p.contact });
  dlg.found = null; dlg.lookupMsg = "";
  renderShare(true);
}

function sendInvites() {
  var d = dlg;
  var btn = overlay.querySelector("#sh-send");
  btn.disabled = true; btn.textContent = "Đang gửi…";
  apiAuth("POST", "/shares/" + d.type + "/" + d.id + "/invite", authToken(), {
    user_ids: d.chips.map(function (c) { return c.id; }), role: d.role, message: d.message.trim() || null,
  }).then(function (res) {
    if (dlg !== d) return;
    if (!res.ok) { btn.disabled = false; btn.textContent = "Gửi"; window.alert(detailMsg(res, "Không chia sẻ được.")); return; }
    var n = d.chips.length;
    d.data = res.data; d.chips = []; d.message = ""; d.found = null;
    markShared(d.type, d.id);
    hooks.renderAll();
    renderShare(true);
    flash("Đã chia sẻ với " + n + " người");
  });
}

function saveLink(audience, role) {
  var d = dlg;
  return apiAuth("PUT", "/shares/" + d.type + "/" + d.id + "/link", authToken(), { audience: audience, role: role }).then(function (res) {
    if (dlg !== d) return null;
    if (!res.ok) { window.alert(detailMsg(res, "Không lưu được liên kết.")); return null; }
    d.data.link = res.data;
    markShared(d.type, d.id);
    hooks.renderAll();
    renderShare(false);
    return res.data;
  });
}

function copyLink() {
  var d = dlg;
  var p = d.data.link ? Promise.resolve(d.data.link) : (d.data.can_manage ? saveLink("anyone", "viewer") : Promise.resolve(null));
  p.then(function (link) {
    if (!link || dlg !== d) return;
    var url = linkUrl(link.token);
    var done = function () { d.copied = true; renderShare(false); setTimeout(function () { if (dlg === d) { d.copied = false; renderShare(false); } }, 2200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt("Sao chép liên kết:", url); });
    } else {
      window.prompt("Sao chép liên kết:", url);
    }
  });
}

function flash(text) {
  if (!overlay) return;
  var f = el("div", "sh-flash", esc(text));
  overlay.firstChild.appendChild(f);
  setTimeout(function () { f.remove(); }, 2400);
}

/* ====================================================================
   Menu ⋯ của mục "Được chia sẻ với tôi"
   ==================================================================== */
function openSharedMenu(e, m) {
  e.preventDefault(); e.stopPropagation();
  hooks.closeFloating();
  var x = e.clientX, y = e.clientY;
  if (!x && e.currentTarget) { var r = e.currentTarget.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  var sub = sharedSubject(m.s);
  if (!sub) return;
  var chapterShare = m.kind === "chapter" && (chapterInSub(sub, m.id) || {}).shareId;
  var canLeave = m.kind === "subject" || (m.kind === "chapter" && chapterShare && !sub.whole);
  var box = $("ctx-menu");
  state.menu = { kind: "shared" };
  box.hidden = false;
  box.style.left = Math.max(8, Math.min(x, window.innerWidth - 230)) + "px";
  box.style.top = Math.max(8, Math.min(y, window.innerHeight - 200)) + "px";
  box.innerHTML = '<div class="ctx-menu-title">' + esc(m.title) + " · của " + esc(sub.owner.name) + "</div>" +
    (m.kind !== "subject" ? '<button type="button" class="ctx-menu-item" data-act="open">' + ICO.open + "Mở</button>" : "") +
    (m.kind !== "pdf" ? '<button type="button" class="ctx-menu-item" data-act="share">' + ICO.people + "Chia sẻ…</button>" : "") +
    '<button type="button" class="ctx-menu-item" data-act="copy">' + ICO.copy + "Tạo bản sao vào Notebook của tôi</button>" +
    (canLeave ? '<button type="button" class="ctx-menu-item danger" data-act="leave">' + ICO.leave + "Xoá khỏi danh sách</button>" : "");
  box.querySelectorAll("[data-act]").forEach(function (b) {
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      hooks.closeFloating();
      var act = b.getAttribute("data-act");
      if (act === "open") openItem(sub.id, m.kind, m.id);
      if (act === "share") openShare({ type: m.kind, id: m.id });
      if (act === "copy") openCopy(m, sub);
      if (act === "leave") leaveShared(m, sub);
    });
  });
}

function leaveShared(m, sub) {
  var what = m.kind === "subject" ? 'môn "' + sub.name + '"' : 'chương "' + m.title + '"';
  if (!window.confirm("Xoá " + what + " khỏi danh sách của bạn? Bạn sẽ mất quyền truy cập cho tới khi " + sub.owner.name + " chia sẻ lại.")) return;
  var ids = m.kind === "subject"
    ? [sub.shareId].concat(sub.chapters.map(function (c) { return c.shareId; })).filter(Boolean)
    : [(chapterInSub(sub, m.id) || {}).shareId].filter(Boolean);
  Promise.all(ids.map(function (id) { return apiAuth("DELETE", "/shares/" + id, authToken()); })).then(function () {
    if (state.active && state.active.s === sub.id && (m.kind === "subject" || state.active.id === m.id)) {
      state.active = null; persist(); Soanthao.loadActiveIntoEditor();
    }
    loadShared();
  });
}

/* "Tạo bản sao" — như "Lưu bản sao" của Word: chép vào Notebook của mình (bản sao dùng được AI Studio) */
function openCopy(m, sub) {
  if (m.kind === "subject") {
    if (!window.confirm('Tạo bản sao cả môn "' + sub.name + '" (mọi Chương + tệp PDF) vào Notebook của bạn?')) return;
    doCopy({ kind: "subject", id: m.id });
    return;
  }
  var opts = state.subjects.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + "</option>"; }).join("");
  var box = openOverlay(head("Tạo bản sao") +
    '<p class="sh-text">Lưu bản sao <b>“' + esc(m.title) + '”</b> vào Notebook của bạn. Bản sao là của bạn: sửa tự do, dùng được Ôn tập, Flashcard, Tóm tắt… — bản gốc không bị ảnh hưởng.</p>' +
    '<label class="sh-lbl" for="sh-to">Lưu vào môn</label><select class="sh-sel sh-sel--full" id="sh-to">' + opts +
    '<option value="__new">+ Môn mới “' + esc(sub.name) + '”</option></select>' +
    '<div class="sh-foot"><button type="button" class="sh-btn" id="sh-cancel">Huỷ</button><button type="button" class="sh-btn sh-btn--primary" id="sh-do">Tạo bản sao</button></div>', "sh-dialog--sm");
  if (!state.subjects.length) box.querySelector("#sh-to").value = "__new";
  box.querySelector("#sh-cancel").addEventListener("click", closeOverlay);
  box.querySelector("#sh-do").addEventListener("click", function () {
    var btn = this, to = box.querySelector("#sh-to").value;
    btn.disabled = true; btn.textContent = "Đang sao chép…";
    var target = to !== "__new" ? Promise.resolve(to)
      : apiAuth("POST", "/subjects", authToken(), { name: sub.name }).then(function (r) { return r.ok ? r.data.id : null; });
    target.then(function (sid) {
      if (!sid) { btn.disabled = false; btn.textContent = "Tạo bản sao"; window.alert("Không tạo được môn học."); return; }
      doCopy({ kind: m.kind, id: m.id, to_subject_id: sid });
    });
  });
}

function doCopy(body) {
  apiAuth("POST", "/shares/copy", authToken(), body).then(function (res) {
    if (!res.ok) { window.alert(detailMsg(res, "Không tạo được bản sao.")); return; }
    closeOverlay();
    var d = res.data;
    Soanthao.bootKnowledgeTree().then(function () {
      hooks.showNotebook();
      state.open[d.subject_id] = true;
      var sub = findSubject(d.subject_id);
      if (d.kind === "pdf") Soanthao.selectPdf(d.subject_id, d.id);
      else if (d.kind === "chapter") Soanthao.selectChapter(d.subject_id, d.id);
      else if (sub && sub.chapters[0]) Soanthao.selectChapter(sub.id, sub.chapters[0].id);
      else hooks.renderAll();
      toast("Đã tạo bản sao trong Notebook của bạn.");
    });
  });
}

/* ====================================================================
   Thanh dưới breadcrumb + avatar "Đang xem" + đồng bộ khi cùng sửa
   ==================================================================== */
var conflict = null;     // {chapterId, message, current}
var remote = null;       // {chapterId, by} — người khác vừa lưu trong lúc mình đang gõ dở
var notice = null;       // {text, until}
var viewers = [];
var lastKey = "";

export function renderBar() {
  var bar = $("share-bar");
  if (!bar) return;
  var a = state.active;
  if (!isOnline() || !a || $("editor-head").hidden) { bar.hidden = true; return; }
  var sub = sharedSubject(a.s), role = itemRole(a);
  var meta = a.kind === "chapter" ? state.chapterMeta[a.id] : null;
  var html = "", cls = "share-bar";
  var c = conflict && conflict.chapterId === a.id ? conflict : null;
  var rm = !c && remote && remote.chapterId === a.id ? remote : null;
  if (c || rm) {
    cls += " share-bar--warn";
    html = '<span class="share-bar-ico">' + ICO.warn + '</span><span class="share-bar-tx">' +
      esc(c ? c.message : (rm.by || "Người khác") + " vừa sửa chương này trong lúc bạn đang soạn.") +
      " Chọn bản muốn giữ:</span>" +
      '<button type="button" class="share-bar-btn" id="share-latest">Xem bản mới nhất</button>' +
      '<button type="button" class="share-bar-btn share-bar-btn--primary" id="share-keep">Giữ bản của tôi</button>';
  } else if (notice && notice.until > Date.now() && notice.chapterId === a.id) {
    cls += " share-bar--info";
    html = '<span class="share-bar-ico">' + ICO.pen + '</span><span class="share-bar-tx">' + esc(notice.text) + "</span>";
  } else if (sub) {
    var edit = meta && meta.updatedBy && meta.updatedAgo != null
      ? '<span class="share-bar-sub">Sửa lần cuối: ' + esc(meta.updatedBy) + ", " + agoText(meta.updatedAgo + Math.round((Date.now() - meta.at) / 1000)) + "</span>" : "";
    if (role === "viewer") {
      cls += " share-bar--view";
      html = '<span class="share-bar-ico">' + ICO.eye + '</span><span class="share-bar-tx"><b>Chỉ xem</b> · ' + esc(sub.owner.name) + " đã chia sẻ với bạn</span>" + edit +
        '<button type="button" class="share-bar-btn" id="share-copy-item">Tạo bản sao</button>';
    } else {
      html = '<span class="share-bar-ico">' + ICO.pen + '</span><span class="share-bar-tx"><b>Có thể chỉnh sửa</b> · Chia sẻ bởi ' + esc(sub.owner.name) + "</span>" + edit;
    }
  } else if (meta && meta.updatedBy && meta.updatedBy !== myName() && ownShared(a)) {
    html = '<span class="share-bar-ico">' + ICO.people + '</span><span class="share-bar-tx">Đã chia sẻ · Sửa lần cuối: <b>' + esc(meta.updatedBy) + "</b>, " +
      agoText(meta.updatedAgo + Math.round((Date.now() - meta.at) / 1000)) + "</span>";
  }
  bar.className = cls;
  bar.hidden = !html;
  bar.innerHTML = html;
  var latest = $("share-latest");
  if (latest) latest.addEventListener("click", takeLatest);
  var keep = $("share-keep");
  if (keep) keep.addEventListener("click", keepMine);
  var cp = $("share-copy-item");
  if (cp) cp.addEventListener("click", function () {
    var item = a.kind === "pdf" ? pdfInSub(sub, a.id) : chapterInSub(sub, a.id);
    openCopy({ kind: a.kind, s: sub.id, id: a.id, title: item ? item.name : "" }, sub);
  });
}

function takeLatest() {
  var a = state.active; if (!a) return;
  var c = conflict && conflict.chapterId === a.id ? conflict : null;
  conflict = null; remote = null;
  if (c && c.current) { Soanthao.applyServerChapter(a.id, c.current); renderBar(); return; }
  apiAuth("GET", "/chapters/" + a.id, authToken()).then(function (res) {
    if (res.ok && res.data) Soanthao.applyServerChapter(a.id, res.data);
    renderBar();
  });
}
function keepMine() {
  conflict = null; remote = null;
  renderBar();
  Soanthao.commitSave(true);   // ghi đè bản trên máy chủ bằng bản đang soạn
}

function renderPresence() {
  var box = $("share-presence");
  if (!box) return;
  if (!viewers.length) { box.hidden = true; box.innerHTML = ""; return; }
  var shown = viewers.slice(0, 3);
  box.hidden = false;
  box.title = viewers.map(function (v) { return v.name; }).join(", ") + " đang xem chương này";
  box.innerHTML = shown.map(function (v) { return avatar(v, "sh-pres-av"); }).join("") +
    (viewers.length > 3 ? '<span class="sh-pres-av sh-pres-more">+' + (viewers.length - 3) + "</span>" : "");
}

function syncTick() {
  var a = state.active;
  if (!isOnline() || document.hidden || !a || a.kind !== "chapter" || !(a.shared || ownShared(a)) || $("editor-head").hidden) {
    if (viewers.length) { viewers = []; renderPresence(); }
    return;
  }
  var id = a.id;
  apiAuth("GET", "/chapters/" + id + "/sync", authToken()).then(function (res) {
    if (!state.active || state.active.id !== id) return;
    if (res.status === 403 || res.status === 404) { onAccessLost(state.active, res.status); return; }
    if (!res.ok || !res.data) return;
    var d = res.data;
    viewers = d.viewers || [];
    renderPresence();
    var meta = state.chapterMeta[id] || {};
    var roleChanged = meta.role && meta.role !== d.role;
    state.chapterMeta[id] = Object.assign({}, meta, { role: d.role, updatedBy: d.updated_by_name, updatedAgo: d.updated_seconds_ago, at: Date.now() });
    if (roleChanged) { Soanthao.applyReadOnly(); hooks.renderAll(); }
    var mine = state.versions[id];
    if (mine != null && d.version > mine) {
      var dirty = state.saveStatus === "editing" || state.saveStatus === "saving" || state.saveStatus === "conflict";
      if (!dirty) {
        apiAuth("GET", "/chapters/" + id, authToken()).then(function (r) {
          if (!r.ok || !r.data || !state.active || state.active.id !== id) return;
          if (state.saveStatus === "editing" || state.saveStatus === "saving") { remote = { chapterId: id, by: d.updated_by_name }; renderBar(); return; }
          Soanthao.applyServerChapter(id, r.data);
          notice = { chapterId: id, text: "Đã cập nhật nội dung mới nhất của " + (d.updated_by_name || "người khác") + ".", until: Date.now() + 6000 };
          renderBar();
          setTimeout(renderBar, 6100);
        });
      } else if (!conflict) {
        remote = { chapterId: id, by: d.updated_by_name };
      }
    }
    renderBar();
  });
}

function onChapterSaved(item) {
  if (conflict && conflict.chapterId === item.id) conflict = null;
  if (remote && remote.chapterId === item.id) remote = null;
  renderBar();
}
function onSaveConflict(item, detail) {
  conflict = { chapterId: item.id, message: (detail && detail.message) || "Người khác vừa sửa chương này.", current: detail && detail.current };
  remote = null;
  renderBar();
}
function onAccessLost(item, status) {
  if (!item) return;
  if (status === 403) {   // bị hạ xuống "Chỉ xem" trong lúc đang sửa
    apiAuth("GET", "/chapters/" + item.id, authToken()).then(function (res) {
      if (res.ok && res.data) Soanthao.applyServerChapter(item.id, res.data);
      notice = { chapterId: item.id, text: "Quyền của bạn với chương này vừa đổi thành Chỉ xem — thay đổi chưa lưu không được ghi.", until: Date.now() + 8000 };
      hooks.renderAll();
    });
    return;
  }
  var name = (function () { var s = findSubject(item.s); var x = s && (item.kind === "pdf" ? pdfInSub(s, item.id) : chapterInSub(s, item.id)); return x ? x.name : "nội dung này"; })();
  if (state.active && state.active.id === item.id) { state.active = null; persist(); Soanthao.loadActiveIntoEditor(); }
  viewers = []; renderPresence();
  loadShared();
  showMessage("Không còn quyền truy cập", "Bạn không còn quyền truy cập “" + name + "” (chủ sở hữu đã gỡ quyền hoặc xoá nội dung).");
}

// gọi mỗi lần vẽ lại trang (renderAll): đổi mục đang mở thì đồng bộ ngay, bỏ thanh xung đột của mục cũ
export function onRender() {
  var a = state.active, key = a ? a.kind + ":" + a.id : "";
  if (key !== lastKey) {
    lastKey = key;
    viewers = []; renderPresence();
    notice = null;
    setTimeout(syncTick, 300);
  }
  renderBar();
}

var toastTimer = null;
function toast(text) {
  var t = $("share-toast");
  if (!t) { t = el("div", "sh-toast"); t.id = "share-toast"; document.body.appendChild(t); }
  t.textContent = text; t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2600);
}

/* ====================================================================
   Khởi tạo
   ==================================================================== */
export function initChiase() {
  // Chưa đăng nhập mà mở liên kết chia sẻ -> trang xem công khai (chỉ xem)
  var tok = new URL(location.href).searchParams.get("share");
  if (tok && !isOnline()) { location.replace("xem.html?share=" + encodeURIComponent(tok)); return; }

  $("btn-share").addEventListener("click", function (e) { e.stopPropagation(); shareActive(); });
  hooks.openShare = openShare;
  hooks.openSharedMenu = openSharedMenu;
  hooks.onChapterSaved = onChapterSaved;
  hooks.onSaveConflict = onSaveConflict;
  hooks.onAccessLost = onAccessLost;
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay) { e.stopPropagation(); closeOverlay(); } }, true);
  setInterval(syncTick, SYNC_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) syncTick(); });
}

// Sau khi nạp cây Notebook của mình (init() ở ghichu.js): tải "Được chia sẻ với tôi" rồi xử lý ?share= / ?open=
export function bootShared() {
  if (!isOnline()) return;
  loadShared().then(handleUrl);
}

// Thông báo chuông: "X đã chia sẻ … với bạn" -> mở đúng mục; "X yêu cầu quyền truy cập" -> hộp Chia sẻ điền sẵn người đó
export function openFromNotification(n) {
  if (n.kind === "share") { openTarget(null, n.refId); return; }
  var isSubject = state.subjects.some(function (s) { return s.id === n.refId; });
  var isChapter = state.subjects.some(function (s) { return chapterInSub(s, n.refId); });
  if (!isSubject && !isChapter) { showMessage("Yêu cầu quyền truy cập", "Nội dung này không còn trong Notebook của bạn."); return; }
  var who = String(n.detail || "").replace(/ yêu cầu quyền truy cập.*$/, "");
  openShare({ type: isSubject ? "subject" : "chapter", id: n.refId, prefill: { id: n.actorId, name: who } });
}
