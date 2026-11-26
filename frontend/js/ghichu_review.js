/* ======================================================================
   ghichu_review.js — thẻ Review: Translate (theo Word) + Password (theo OneNote "Password Protection").

   • Translate — chỉ dịch đoạn đang bôi đen (người dùng chốt: bỏ chế độ dịch cả Chương). Khung Translator nổi bên phải,
     không chặn trang; "Insert" thay đoạn đã chọn bằng bản dịch (1 bước Ctrl+Z; vị trí giữ bằng marker CKEditor nên vẫn
     đúng chỗ dù người dùng bấm ra ngoài khung dịch). Gọi POST /translate (Gemini) — chế độ mẫu không dịch được.
   • Password ▾ — Password Protect This Chapter… / Change Password… / Remove Password… (chỉ chủ sở hữu) + Lock All
     Protected Chapters. Chương có mật khẩu: cây hiện ổ khoá, mở ra là màn "This chapter is password protected" (gợi ý
     nếu có); máy chủ chỉ trả nội dung khi kèm khoá mở (X-Chapter-Key, state.chapterKeys — chỉ trong bộ nhớ trang) và
     AI Studio không đọc Chương có mật khẩu. Không thao tác 10 phút -> tự khoá lại như OneNote. Chế độ mẫu: mật khẩu
     băm SHA-256 + salt lưu cục bộ trên Chương (c.pw), chỉ là khoá giao diện.
   Chữ trên giao diện: tiếng Anh như Word / OneNote (người dùng chốt cho mọi chức năng của các thẻ ribbon).
   ====================================================================== */
import {
  hooks, state, $, el, esc, persist, isOnline, authToken, hasActiveChapter, findChapter, itemRole,
  chapterLocked, chapterProtected, openDropdown,
} from "./ghichu_core.js";
import {
  editor, applyServerChapter, loadActiveIntoEditor, markProtected, commitSave, flushSaves, fetchChapterDetail,
} from "./ghichu_soanthao.js";

/* ---------------- tiện ích ---------------- */
var LANGS = [
  ["en", "English"], ["vi", "Vietnamese"], ["zh", "Chinese (Simplified)"], ["ja", "Japanese"], ["ko", "Korean"],
  ["fr", "French"], ["de", "German"], ["es", "Spanish"], ["ru", "Russian"], ["th", "Thai"],
];
function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } }
function errText(res, fallback) {
  var d = res && res.data && res.data.detail;
  return typeof d === "string" && d ? d : fallback;
}
// HTML CKEditor -> văn bản thuần, giữ xuống dòng giữa các khối.
function htmlToPlain(html) {
  var h = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|div|blockquote|tr|figcaption|pre)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t");
  var d = document.createElement("div");
  d.innerHTML = h;
  return (d.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var ICO_LOCK_BIG = '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path><circle cx="12" cy="15.5" r="1.3" fill="currentColor"></circle></svg>';

/* ====================================================================
   PASSWORD
   ==================================================================== */
function activeChapter() { return hasActiveChapter() ? findChapter(state.active.s, state.active.id) : null; }
function isOwnerHere() { return hasActiveChapter() && itemRole() === "owner"; }

// Chế độ mẫu: băm cục bộ (SHA-256 của salt + mật khẩu).
function sha256Hex(text) {
  if (!window.crypto || !crypto.subtle) return Promise.resolve(text);   // trình duyệt quá cũ: chỉ khoá giao diện
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  });
}
function newSalt() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function sampleCheck(c, pw) { return sha256Hex(c.pw.salt + pw).then(function (h) { return h === c.pw.hash; }); }

/* ---- màn "This chapter is password protected" (thay chỗ trang soạn thảo) ---- */
function renderChapterLock(show) {
  var host = $("chapter-lock");
  if (!host) {
    var shell = document.querySelector(".editor-shell");
    if (!shell) return;
    host = el("div", "pw-lock");
    host.id = "chapter-lock";
    shell.appendChild(host);
  }
  host.hidden = !show;
  if (!show) { host.removeAttribute("data-for"); return; }
  var id = state.active.id;
  if (host.getAttribute("data-for") === id) return;   // đã vẽ cho đúng Chương — giữ chữ đang gõ trong ô mật khẩu
  host.setAttribute("data-for", id);
  var c = activeChapter();
  var hint = (state.chapterLockInfo[id] && state.chapterLockInfo[id].hint) || (c && c.pw && c.pw.hint) || "";
  host.innerHTML =
    '<div class="pw-lock-card">' + '<div class="pw-lock-ico">' + ICO_LOCK_BIG + "</div>" +
    '<div class="pw-lock-title">This chapter is password protected</div>' +
    '<div class="pw-lock-sub">Enter the password to open <b>' + esc(c ? c.name : "") + "</b>.</div>" +
    '<form class="pw-lock-form" autocomplete="off"><input type="password" class="pw-input" id="pw-lock-input" placeholder="Password" autocomplete="current-password">' +
    '<button type="submit" class="btn-solid" id="pw-lock-btn">Unlock</button></form>' +
    (hint ? '<div class="pw-lock-hint">Hint: ' + esc(hint) + "</div>" : "") +
    '<div class="pw-err" id="pw-lock-err" hidden></div>' +
    '<div class="pw-lock-note">Protected chapters are not used by Studio (AI) and are locked again after 10 minutes of inactivity.</div></div>';
  host.querySelector("form").addEventListener("submit", function (e) { e.preventDefault(); unlockActive(); });
  setTimeout(function () { var i = $("pw-lock-input"); if (i && !host.hidden) i.focus(); }, 30);
}

function showErr(id, msg) { var e = $(id); if (!e) return; e.textContent = msg || ""; e.hidden = !msg; }

function unlockActive() {
  if (!hasActiveChapter()) return;
  var id = state.active.id, inp = $("pw-lock-input"), pw = inp ? inp.value : "";
  if (!pw) { showErr("pw-lock-err", "Enter the password."); return; }
  var btn = $("pw-lock-btn"); if (btn) btn.disabled = true;
  var done = function () {
    var draft = state.pwDrafts && state.pwDrafts[id];
    if (draft != null) { state.docs[id] = draft; delete state.pwDrafts[id]; }
    delete state.chapterLockInfo[id];
    touch();
    loadActiveIntoEditor();
    hooks.renderAll();
    if (draft != null) commitSave();
  };
  if (!isOnline()) {
    var c = activeChapter();
    sampleCheck(c, pw).then(function (ok) {
      if (btn) btn.disabled = false;
      if (!ok) { showErr("pw-lock-err", "The password is incorrect."); if (inp) inp.select(); return; }
      state.sampleUnlocked[id] = true;
      done();
    });
    return;
  }
  apiAuth("POST", "/chapters/" + id + "/unlock", authToken(), { password: pw }).then(function (res) {
    if (btn) btn.disabled = false;
    if (!res.ok) {
      showErr("pw-lock-err", res.status === 403 ? "The password is incorrect." : errText(res, "Could not unlock the chapter."));
      if (inp) inp.select();
      return;
    }
    if (res.data.key) state.chapterKeys[id] = res.data.key;
    applyServerChapter(id, res.data.chapter);
    done();
  });
}

/* ---- hộp thoại Đặt / Đổi / Gỡ mật khẩu ---- */
var pwMode = null;
function ensurePwModal() {
  if ($("pw-overlay")) return;
  var o = el("div", "modal-overlay");
  o.id = "pw-overlay"; o.hidden = true;
  o.innerHTML =
    '<form class="modal pw-modal" autocomplete="off"><div class="modal-head"><span class="modal-title" id="pw-title">Password Protection</span>' +
    '<button type="button" class="icon-btn-sm" id="pw-close" title="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>' +
    '<div class="pw-body">' +
    '<div class="pw-desc" id="pw-desc"></div>' +
    '<label class="pw-field" id="pw-f-cur"><span>Current password</span><input type="password" class="pw-input" id="pw-cur" autocomplete="current-password"></label>' +
    '<label class="pw-field" id="pw-f-new"><span>Enter password</span><input type="password" class="pw-input" id="pw-new" autocomplete="new-password"></label>' +
    '<label class="pw-field" id="pw-f-conf"><span>Confirm password</span><input type="password" class="pw-input" id="pw-conf" autocomplete="new-password"></label>' +
    '<label class="pw-field" id="pw-f-hint"><span>Hint (optional)</span><input type="text" class="pw-input" id="pw-hint" maxlength="200" placeholder="Shown on the lock screen — never the password itself"></label>' +
    '<div class="pw-err" id="pw-err" hidden></div>' +
    '<div class="pw-warn" id="pw-warn">If you forget the password, nobody — not even an administrator — can recover this chapter. Protected chapters are not used by Studio (AI).</div>' +
    '</div><div class="modal-foot"><span style="flex:1"></span><button type="button" class="btn-plain" id="pw-cancel">Cancel</button>' +
    '<button type="submit" class="btn-solid" id="pw-ok">OK</button></div></form>';
  document.body.appendChild(o);
  var close = function () { o.hidden = true; pwMode = null; };
  o.addEventListener("click", function (e) { if (e.target === o) close(); });
  o.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); close(); } });
  $("pw-close").addEventListener("click", close);
  $("pw-cancel").addEventListener("click", close);
  o.querySelector("form").addEventListener("submit", function (e) { e.preventDefault(); submitPw(); });
}

function openPwDialog(mode) {
  if (!hasActiveChapter()) return;
  ensurePwModal();
  pwMode = mode;
  var c = activeChapter();
  var titles = { set: "Password Protect This Chapter", change: "Change Password", remove: "Remove Password" };
  var descs = {
    set: "Choose a password for <b>" + esc(c.name) + "</b>. You will need it to open this chapter.",
    change: "Change the password of <b>" + esc(c.name) + "</b>.",
    remove: "Enter the current password to remove protection from <b>" + esc(c.name) + "</b>.",
  };
  $("pw-title").textContent = titles[mode];
  $("pw-desc").innerHTML = descs[mode];
  $("pw-f-cur").hidden = mode === "set";
  $("pw-f-new").hidden = $("pw-f-conf").hidden = $("pw-f-hint").hidden = mode === "remove";
  $("pw-f-new").querySelector("span").textContent = mode === "change" ? "New password" : "Enter password";
  $("pw-warn").hidden = mode === "remove";
  $("pw-ok").textContent = mode === "remove" ? "Remove" : "OK";
  ["pw-cur", "pw-new", "pw-conf", "pw-hint"].forEach(function (k) { $(k).value = ""; });
  if (mode === "change") $("pw-hint").value = (state.chapterLockInfo[c.id] && state.chapterLockInfo[c.id].hint) || (c.pw && c.pw.hint) || c.pwHint || "";
  showErr("pw-err", "");
  $("pw-overlay").hidden = false;
  setTimeout(function () { (mode === "set" ? $("pw-new") : $("pw-cur")).focus(); }, 30);
}

function submitPw() {
  var mode = pwMode, id = state.active && state.active.id, c = activeChapter();
  if (!mode || !c) return;
  var cur = $("pw-cur").value, nw = $("pw-new").value, conf = $("pw-conf").value, hint = $("pw-hint").value.trim();
  if (mode !== "set" && !cur) { showErr("pw-err", "Enter the current password."); return; }
  if (mode !== "remove") {
    if (nw.length < 4) { showErr("pw-err", "The password must be at least 4 characters."); return; }
    if (nw !== conf) { showErr("pw-err", "The passwords don't match."); return; }
    if (hint && hint.toLowerCase().indexOf(nw.toLowerCase()) >= 0) { showErr("pw-err", "The hint can't contain the password."); return; }
  }
  var finish = function () {
    $("pw-overlay").hidden = true; pwMode = null;
    persist(); hooks.renderAll(); hooks.renderRibbon();
  };
  $("pw-ok").disabled = true;
  if (!isOnline()) {
    var go = function () {
      if (mode === "remove") { delete c.pw; delete state.sampleUnlocked[id]; finish(); return; }
      var salt = newSalt();
      sha256Hex(salt + nw).then(function (h) { c.pw = { salt: salt, hash: h, hint: hint }; state.sampleUnlocked[id] = true; finish(); });
    };
    if (mode === "set") { $("pw-ok").disabled = false; go(); return; }
    sampleCheck(c, cur).then(function (ok) {
      $("pw-ok").disabled = false;
      if (!ok) { showErr("pw-err", "The current password is incorrect."); return; }
      go();
    });
    return;
  }
  var body = { new_password: mode === "remove" ? null : nw, current_password: mode === "set" ? null : cur, hint: hint || null };
  flushSaves().then(function () {
    return apiAuth("PUT", "/chapters/" + id + "/password", authToken(), body);
  }).then(function (res) {
    $("pw-ok").disabled = false;
    if (!res.ok) { showErr("pw-err", res.status === 403 ? errText(res, "The current password is incorrect.") : errText(res, "Could not change the password.")); return; }
    if (res.data.key) state.chapterKeys[id] = res.data.key; else delete state.chapterKeys[id];
    state.chapterLockInfo[id] = mode === "remove" ? undefined : { hint: hint };
    if (mode === "remove") delete state.chapterLockInfo[id];
    markProtected(id, mode !== "remove");
    touch();
    finish();
  });
}

/* ---- khoá lại tất cả ---- */
export function lockAll() {
  var any = Object.keys(state.chapterKeys).length || Object.keys(state.sampleUnlocked).length;
  if (!any) return Promise.resolve();
  return flushSaves().then(function () {
    Object.keys(state.chapterKeys).forEach(function (k) {
      delete state.chapterKeys[k];
      delete state.docs[k];            // nội dung đã giải khoá chỉ ở bộ nhớ — bỏ đi
      delete state.drawings[k];
      state.loadedChapters[k] = false;
    });
    Object.keys(state.sampleUnlocked).forEach(function (k) { delete state.sampleUnlocked[k]; });
    var lk = $("chapter-lock"); if (lk) lk.removeAttribute("data-for");
    if (hasActiveChapter() && chapterLocked()) {
      if (isOnline()) fetchChapterDetail(state.active.id); else loadActiveIntoEditor();
    }
    hooks.renderAll();
  });
}

/* ---- tự khoá sau 10 phút không thao tác (như OneNote) ---- */
var IDLE_MS = 10 * 60 * 1000, lastAct = Date.now();
function touch() { lastAct = Date.now(); }
["pointerdown", "keydown", "wheel"].forEach(function (ev) { document.addEventListener(ev, touch, true); });
setInterval(function () {
  var any = Object.keys(state.chapterKeys).length || Object.keys(state.sampleUnlocked).length;
  if (any && Date.now() - lastAct > IDLE_MS) lockAll();
}, 30000);

function passwordMenuHtml() {
  var c = activeChapter(), owner = isOwnerHere();
  var prot = c && chapterProtected(state.active.s, c.id), locked = prot && chapterLocked();
  var row = function (act, label, dis, title) {
    return '<button type="button" class="dv-menu-row" data-pw="' + act + '"' + (dis ? " disabled" : "") + (title ? ' title="' + esc(title) + '"' : "") + ">" + label + "</button>";
  };
  var notOwner = !owner ? "Only the owner of this chapter can change its password." : "";
  var html = '<div class="dv-menu rv-menu">';
  if (!prot) html += row("set", "Password Protect This Chapter…", !c || !owner, !c ? "Open a chapter first." : notOwner);
  else {
    html += row("change", "Change Password…", !owner || locked, locked ? "Unlock the chapter first." : notOwner);
    html += row("remove", "Remove Password…", !owner || locked, locked ? "Unlock the chapter first." : notOwner);
  }
  var unlockedCount = Object.keys(state.chapterKeys).length + Object.keys(state.sampleUnlocked).length;
  html += '<div class="dv-menu-sep"></div>' + row("lockall", "Lock All Protected Chapters", !unlockedCount);
  html += '<div class="dv-menu-hint">Protected chapters ask for the password every time the page is reloaded, and lock again after 10 minutes of inactivity.</div></div>';
  return html;
}
function bindPasswordMenu(panel) {
  panel.querySelectorAll("[data-pw]").forEach(function (b) {
    b.addEventListener("click", function () {
      var a = b.getAttribute("data-pw");
      hooks.closeFloating();
      if (a === "lockall") lockAll(); else openPwDialog(a);
    });
  });
}

/* ====================================================================
   TRANSLATE
   ==================================================================== */
var tr = { src: "", busy: false, result: "", seq: 0 };
var MARKER = "td-translate";

function ensurePane() {
  if ($("tr-pane")) return;
  var p = el("aside", "tr-pane");
  p.id = "tr-pane"; p.hidden = true;
  p.setAttribute("aria-label", "Translator");
  p.innerHTML =
    '<div class="tr-head"><span class="tr-title">Translator</span><button type="button" class="icon-btn-sm" id="tr-close" title="Close">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></div>' +
    '<div class="tr-body">' +
    '<div class="tr-lang"><span>From</span><b id="tr-from">Auto-detect</b></div>' +
    '<textarea id="tr-src" class="tr-text" spellcheck="false" placeholder="Select text in the note, or type here"></textarea>' +
    '<div class="tr-lang"><span>To</span><select id="tr-to">' + LANGS.map(function (l) { return '<option value="' + l[0] + '">' + l[1] + "</option>"; }).join("") + "</select>" +
    '<button type="button" class="btn-solid tr-go" id="tr-go">Translate</button></div>' +
    '<div class="tr-out" id="tr-out"><span class="tr-ph">The translation appears here.</span></div>' +
    '<div class="pw-err" id="tr-err" hidden></div>' +
    "</div>" +
    '<div class="tr-foot"><button type="button" class="btn-solid" id="tr-insert">Insert</button>' +
    '<button type="button" class="btn-plain" id="tr-copy">Copy</button><span class="tr-note">Translated by AI — check before using.</span></div>';
  document.body.appendChild(p);
  $("tr-close").addEventListener("click", closeTranslator);
  $("tr-to").value = lsGet("td_tr_target", "en");
  $("tr-to").addEventListener("change", function () { lsSet("td_tr_target", $("tr-to").value); });
  $("tr-go").addEventListener("click", runTranslate);
  $("tr-src").addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runTranslate(); } });
  $("tr-copy").addEventListener("click", function () {
    var b = $("tr-copy"), t = tr.result;
    if (!t) return;
    var ok = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, ok); else ok();
  });
  $("tr-insert").addEventListener("click", insertTranslation);
}

function clearMarker() {
  if (editor && editor.model.markers.has(MARKER)) editor.model.change(function (w) { w.removeMarker(MARKER); });
}
function closeTranslator() {
  var p = $("tr-pane"); if (p) p.hidden = true;
  tr.seq++; tr.busy = false;
  clearMarker();
}

export function openTranslator() {
  ensurePane();
  tr.result = ""; tr.seq++; tr.busy = false;
  var p = $("tr-pane");
  p.hidden = false;
  $("tr-from").textContent = "Auto-detect";
  $("tr-out").innerHTML = '<span class="tr-ph">The translation appears here.</span>';
  showErr("tr-err", "");
  clearMarker();
  var src = "";
  if (editor && hasActiveChapter() && !chapterLocked()) {
    var sel = editor.model.document.selection;
    var range = sel.isCollapsed ? null : editor.model.createRange(sel.getFirstPosition(), sel.getLastPosition());
    if (range) {
      src = htmlToPlain(editor.data.stringify(editor.model.getSelectedContent(sel)));
      editor.model.change(function (w) { w.addMarker(MARKER, { range: range, usingOperation: false, affectsData: false }); });
    }
  }
  tr.src = src;
  $("tr-src").value = src;
  var canWrite = hasActiveChapter() && !chapterLocked() && itemRole() !== "viewer" && !state.noteLocked;
  $("tr-insert").title = "Replace the selected text with the translation";
  $("tr-insert").hidden = !canWrite;
  $("tr-insert").disabled = true;
  $("tr-copy").disabled = true;
  if (!isOnline()) { showErr("tr-err", "Sign in to use Translate."); return; }
  if (!src) showErr("tr-err", "Select text in the note (or type it above), then click Translate.");
  if (src) runTranslate();
}

// Chia văn bản dài thành khúc ≤ max ký tự theo đoạn (API nhận ≤ 6000 ký tự / lượt).
function splitChunks(text, max) {
  var out = [], cur = "";
  text.split(/\n/).forEach(function (line) {
    while (line.length > max) { if (cur) { out.push(cur); cur = ""; } out.push(line.slice(0, max)); line = line.slice(max); }
    if ((cur + "\n" + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  });
  if (cur.trim()) out.push(cur);
  return out;
}

function runTranslate() {
  if (!isOnline()) { showErr("tr-err", "Sign in to use Translate."); return; }
  var text = $("tr-src").value.trim();
  if (!text) { showErr("tr-err", "There is no text to translate."); return; }
  if (text !== tr.src) clearMarker();   // người dùng tự gõ chữ khác -> không còn "thay đoạn đã chọn"
  var target = $("tr-to").value, seq = ++tr.seq, chunks = splitChunks(text, 4500);
  tr.busy = true; tr.result = "";
  showErr("tr-err", "");
  $("tr-go").disabled = true; $("tr-insert").disabled = true; $("tr-copy").disabled = true;
  var parts = [], i = 0, detected = null;
  var step = function () {
    if (seq !== tr.seq) return;
    if (i >= chunks.length) {
      tr.busy = false; tr.result = parts.join("\n");
      $("tr-go").disabled = false;
      $("tr-from").textContent = detected ? detected + " (detected)" : "Auto-detect";
      $("tr-out").textContent = tr.result;
      $("tr-copy").disabled = false;
      $("tr-insert").disabled = !(editor && editor.model.markers.has(MARKER));
      if ($("tr-insert").disabled) $("tr-insert").title = "Select text in the note first to replace it";
      return;
    }
    $("tr-out").innerHTML = '<span class="tr-ph">Translating' + (chunks.length > 1 ? " " + (i + 1) + "/" + chunks.length : "") + "…</span>";
    apiAuth("POST", "/translate", authToken(), { text: chunks[i], target: target }).then(function (res) {
      if (seq !== tr.seq) return;
      if (!res.ok) {
        tr.busy = false; $("tr-go").disabled = false;
        $("tr-out").innerHTML = '<span class="tr-ph">—</span>';
        showErr("tr-err", errText(res, "Could not translate right now. Try again later."));
        return;
      }
      parts.push(res.data.translation);
      detected = detected || res.data.detected;
      i++; step();
    });
  };
  step();
}

function insertTranslation() {
  if (!editor || !tr.result || !editor.model.markers.has(MARKER)) return;
  var range = editor.model.markers.get(MARKER).getRange();
  var text = tr.result;
  editor.model.change(function (w) {
    w.setSelection(range);
    var attrs = Object.fromEntries(editor.model.document.selection.getAttributes());
    var lines = text.split(/\n/);
    if (lines.length === 1) editor.model.insertContent(w.createText(text, attrs));
    else editor.model.insertContent(editor.data.parse(lines.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("")));
    w.removeMarker(MARKER);
  });
  editor.editing.view.focus();
  closeTranslator();
}

/* ---------------- nút ribbon (gọi từ buildReviewTab ở ghichu_chucnangcacthe.js) ---------------- */
var ICO_TR = '<svg width="18" height="18" viewBox="0 0 18 18" style="display:block" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1.5" width="9.5" height="9.5" rx="1.6" fill="#2b6cb0"/><path d="M3.3 8.6l2.5-5.6 2.5 5.6M4.2 6.8h3.2" stroke="#fff" stroke-width="1.2"/><rect x="7.5" y="7" width="9.5" height="9.5" rx="1.6" fill="#fff" stroke="#6b7385" stroke-width="1"/><path d="M9.6 9.6h5.4M12.3 8.6v1M10.5 9.6c.6 2.2 2.2 3.9 4.3 4.6M14.1 9.6c-.6 2.2-2.2 3.9-4.2 4.6" stroke="#4a5468" stroke-width="1.05"/></svg>';
var ICO_PW = '<svg width="18" height="18" viewBox="0 0 18 18" style="display:block"><path d="M5.5 8V5.6a3.5 3.5 0 0 1 7 0V8" fill="none" stroke="#6b7385" stroke-width="1.4"/><rect x="3" y="7.8" width="12" height="8.6" rx="1.6" fill="#f0a030" stroke="#c77700" stroke-width="1"/><circle cx="9" cy="11.6" r="1.2" fill="#fff"/><path d="M9 12.4v1.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>';

export function reviewButtons(btnTextDropdown, btnText) {
  // Translate: 1 nút (không menu ▾) — dịch đoạn đang bôi đen.
  var trBtn = btnText(ICO_TR, "Translate", function () { openTranslator(); }, false);
  trBtn.title = "Translate the selected text";
  var pwBtn = btnTextDropdown(ICO_PW, "Password", function (e) {
    e.stopPropagation();
    var r = e.currentTarget.getBoundingClientRect();
    openDropdown("rvpw", Math.max(8, Math.min(r.left, window.innerWidth - 300)), r.bottom + 6, passwordMenuHtml(), bindPasswordMenu);
  }, false, "rvpw", 290, passwordMenuHtml, bindPasswordMenu);
  if (hasActiveChapter() && chapterProtected(state.active.s, state.active.id)) pwBtn.firstChild.classList.add("on");
  return [trBtn, pwBtn];
}

export function initReview() {
  hooks.renderChapterLock = renderChapterLock;
}
