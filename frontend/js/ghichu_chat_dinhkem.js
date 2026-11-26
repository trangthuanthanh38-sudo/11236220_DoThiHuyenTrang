/* ======================================================================
   ghichu_chat_dinhkem.js — đính kèm ngữ cảnh ở ô nhập AI Chat (UC-19 bước 1
   + 1a): gõ "@" mở dropdown tìm-chọn Chương, kéo-thả 1 Chương từ cây
   Notebook (cột 1) giữ phím Shift, hoặc bấm "+" tải tệp/ảnh từ máy — cả 3
   cách đều tạo ra 1 "chip" gắn vào ô nhập trước khi bấm Gửi.

   Module riêng (không nhồi vào ghichu.js) vì đây là 1 khối tính năng tự
   khép kín (state + dropdown + kéo-thả + upload + chip). Chỉ import từ
   core (không import ghichu.js) để tránh vòng lặp import — gọi ngược lên
   ghichu.js (vẽ lại khung chat sau khi đổi state) qua hooks.renderChatDock,
   đúng cơ chế "cầu nối 1 chiều" đã dùng cho renderAll/renderRibbon... (xem
   comment đầu ghichu_core.js). apiAuth()/apiUpload() gọi thẳng — đây là hàm
   global do auth-client.js khai báo bằng `function` top-level trong classic
   <script> (không phải module), gọi được từ module ES6 không cần import gì
   thêm (giống cách ghichu_soanthao.js đang gọi chúng).

   Ranh giới rõ ràng: CHƯA có LLM/RAG nào đọc dữ liệu đính kèm ở đây để trả
   lời — xem docstring đầu backend/app/routers/chat.py. Module này chỉ ghi
   nhận & hiển thị lại (chip); câu trả lời của bot ở ghichu.js vẫn là 1 câu
   cố định như trước.
   ====================================================================== */
import {
  state, $, esc, isOnline, authToken, genLocalId, openDropdown, closeDropdownEl, hooks,
} from "./ghichu_core.js";

var MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024; // khớp settings.MAX_CHAT_ATTACHMENT_MB (backend/app/config.py)
var ACCEPT_RE = /\.(pdf|png|jpe?g|webp|gif|txt)$/i;
var MAX_MENTION_ROWS = 8;

var attach = {
  items: [],          // [{id, kind:'chapter'|'file', label, subjectId, chapterId, mime, size, preview, text, uploading}]
  restored: false,    // chỉ khôi phục chip 'pending' từ server 1 lần/phiên trang
  mention: { open: false, start: -1, query: "", index: 0, rows: [], input: null },
};

function repaint() { hooks.renderChatDock(); }

/* ====================================================================
   Danh sách chip: gửi / khôi phục sau F5 / gỡ
   ==================================================================== */
export function peekChatAttachments() { return attach.items.length; }

export function takeChatAttachments() {
  var copy = attach.items.slice();
  attach.items = [];
  var ids = copy.filter(function (a) { return String(a.id).indexOf("local-") !== 0; }).map(function (a) { return a.id; });
  if (ids.length && isOnline()) apiAuth("POST", "/chat/attachments/mark-sent", authToken(), { ids: ids });
  return copy;
}

export function restoreChatAttachments(onDone) {
  if (attach.restored || !isOnline()) { if (onDone) onDone(); return; }
  attach.restored = true;
  apiAuth("GET", "/chat/attachments?status=pending", authToken()).then(function (res) {
    if (res.ok && Array.isArray(res.data)) {
      attach.items = res.data.map(function (a) {
        return {
          id: a.id, kind: a.kind, label: a.label, subjectId: a.subject_id, chapterId: a.chapter_id,
          mime: a.mime_type, size: a.file_size_bytes, preview: a.preview,
        };
      });
    }
    if (onDone) onDone();
  });
}

export function removeChatAttachment(id) {
  attach.items = attach.items.filter(function (x) { return x.id !== id; });
  repaint();
  if (isOnline() && String(id).indexOf("local-") !== 0) apiAuth("DELETE", "/chat/attachments/" + id, authToken());
}

/* ====================================================================
   Chip — HTML (đang soạn, có nút "×") và readonly (đã gửi, trong bong bóng)
   ==================================================================== */
function chipIconSvg(kind) {
  if (kind === "chapter") {
    return '<svg class="chat-chip-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"></path><path d="M14 2v6h6"></path></svg>';
  }
  return '<svg class="chat-chip-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.19 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>';
}

function chipTitle(a) {
  if (a.kind === "chapter") return a.preview || a.label;
  return a.label + (a.size ? " (" + Math.round(a.size / 1024) + "KB)" : "");
}

export function renderChatChips(host) {
  if (!host) return;
  host.innerHTML = attach.items.map(function (a) {
    return (
      '<span class="chat-chip' + (a.uploading ? " chat-chip--pending" : "") + '" title="' + esc(chipTitle(a)) + '">' +
        chipIconSvg(a.kind) +
        '<span class="chat-chip-label">' + esc(a.label) + "</span>" +
        (a.uploading ? "" : '<button type="button" class="chat-chip-x" data-id="' + esc(a.id) + '">×</button>') +
      "</span>"
    );
  }).join("");
  host.querySelectorAll(".chat-chip-x").forEach(function (btn) {
    btn.addEventListener("click", function (e) { e.stopPropagation(); removeChatAttachment(btn.getAttribute("data-id")); });
  });
}

export function chipStaticHtml(a) {
  return '<span class="chat-chip" title="' + esc(chipTitle(a)) + '">' + chipIconSvg(a.kind) + '<span class="chat-chip-label">' + esc(a.label) + "</span></span>";
}

/* ====================================================================
   Gắn 1 Chương làm ngữ cảnh — dùng chung cho "@" và kéo-thả+Shift
   ==================================================================== */
function attachChapter(row) {
  // row: {id, name, subjectId}
  if (attach.items.some(function (x) { return x.kind === "chapter" && x.chapterId === row.id; })) return;

  if (!isOnline()) {
    var localText = state.docs[row.id] ? String(state.docs[row.id]).replace(/<[^>]+>/g, " ").trim() : "";
    attach.items.push({
      id: genLocalId(), kind: "chapter", chapterId: row.id, subjectId: row.subjectId,
      label: row.name, preview: localText.slice(0, 200), text: localText,
    });
    repaint();
    return;
  }

  apiAuth("POST", "/chat/attachments/chapter", authToken(), { chapter_id: row.id }).then(function (res) {
    if (!res.ok) { window.alert((res.data && res.data.detail) || "Không đính kèm được chương này."); return; }
    var item = {
      id: res.data.id, kind: "chapter", chapterId: row.id, subjectId: res.data.subject_id,
      label: res.data.label, preview: res.data.preview,
    };
    attach.items.push(item);
    repaint();
    // Nội dung thật (content_text) — tiêu thụ field mới ở ChapterDetailOut, phục vụ RAG sau này.
    apiAuth("GET", "/chapters/" + row.id, authToken()).then(function (r2) {
      if (r2.ok && r2.data) item.text = r2.data.content_text || "";
    });
  });
}

/* ====================================================================
   "@" mention — gõ để tìm-chọn Chương, dùng lại #dd-panel dùng chung
   (openDropdown/closeDropdownEl — ghichu_core.js) và khung .dd-plain button
   đã dùng cho menu "⋯" đổi tên/xoá phiên chat.
   ==================================================================== */
function mentionRows(query) {
  var q = (query || "").trim().toLowerCase();
  var rows = [];
  state.subjects.forEach(function (sub) {
    sub.chapters.forEach(function (c) {
      if (!q || c.name.toLowerCase().indexOf(q) >= 0 || sub.name.toLowerCase().indexOf(q) >= 0) {
        rows.push({ id: c.id, name: c.name, subjectId: sub.id, subjectName: sub.name });
      }
    });
  });
  return rows.slice(0, MAX_MENTION_ROWS);
}

function closeMention() {
  attach.mention.open = false;
  state.dd = null;
  closeDropdownEl();
}

function selectMention(i) {
  var row = attach.mention.rows[i];
  var input = attach.mention.input;
  if (!row || !input) { closeMention(); return; }
  var start = attach.mention.start;
  var caret = input.selectionStart;
  var value = input.value;
  input.value = value.slice(0, start) + value.slice(caret);
  input.selectionStart = input.selectionEnd = start;
  input.dispatchEvent(new Event("input")); // đồng bộ lại chat.input phía ghichu.js (listener đã gắn ở đó)
  input.focus();
  closeMention();
  attachChapter(row);
}

function openMentionDropdown(input) {
  var rows = mentionRows(attach.mention.query);
  attach.mention.rows = rows;
  if (attach.mention.index >= rows.length) attach.mention.index = 0;

  var r = input.getBoundingClientRect();
  var h = Math.min(Math.max(rows.length, 1) * 34 + 16, 280);
  var y = Math.max(8, r.top - h - 10); // mở HƯỚNG LÊN — pill thường nằm sát đáy màn hình
  var x = Math.max(8, Math.min(r.left - 12, window.innerWidth - 320));

  var html = rows.length
    ? '<div class="dd-plain chat-mention">' + rows.map(function (row, i) {
        return (
          '<button type="button" data-i="' + i + '" class="chat-mention-row' + (i === attach.mention.index ? " on" : "") + '">' +
            '<span class="chat-mention-name">' + esc(row.name) + "</span>" +
            '<span class="chat-mention-sub">' + esc(row.subjectName) + "</span>" +
          "</button>"
        );
      }).join("") + "</div>"
    : '<div class="dd-plain chat-mention"><button type="button" disabled class="chat-mention-row">Chưa có chương nào</button></div>';

  attach.mention.open = true;
  attach.mention.input = input;
  openDropdown("chat-mention", x, y, html, function (panel) {
    panel.querySelectorAll(".chat-mention-row[data-i]").forEach(function (btn) {
      // mousedown (không phải click) + preventDefault để input không mất focus trước khi ta đọc caret.
      btn.addEventListener("mousedown", function (e) {
        e.preventDefault();
        selectMention(parseInt(btn.getAttribute("data-i"), 10));
      });
    });
  });
}

export function detectMention(input) {
  var caret = input.selectionStart;
  var value = input.value;
  var idx = -1;
  for (var i = caret - 1; i >= 0; i--) {
    var ch = value[i];
    if (ch === "@") { idx = i; break; }
    if (/\s/.test(ch)) break;
  }
  var validStart = idx === 0 || (idx > 0 && /\s/.test(value[idx - 1]));
  if (idx < 0 || !validStart) { if (attach.mention.open) closeMention(); return; }

  attach.mention.start = idx;
  attach.mention.query = value.slice(idx + 1, caret);
  attach.mention.index = 0;
  openMentionDropdown(input);
}

/* Trả true nếu dropdown "@" đã xử lý phím này — bindChatInput (ghichu.js) gọi
   hàm này TRƯỚC khi tự kiểm tra Enter, để dropdown có quyền ưu tiên phím. */
export function handleChatKeydown(e, input) {
  if (!attach.mention.open) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    attach.mention.index = Math.min(attach.mention.index + 1, attach.mention.rows.length - 1);
    openMentionDropdown(input);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    attach.mention.index = Math.max(attach.mention.index - 1, 0);
    openMentionDropdown(input);
    return true;
  }
  if (e.key === "Enter") { e.preventDefault(); selectMention(attach.mention.index); return true; }
  if (e.key === "Escape") { e.preventDefault(); closeMention(); return true; }
  return false;
}

/* ====================================================================
   Kéo-thả 1 Chương từ cây Notebook + giữ Shift, và nút "+" — gắn cho 1 pill cụ thể
   (gọi 2 lần: pill rỗng + pill thanh dưới). `onPlus` (tuỳ chọn): ghichu.js truyền vào
   openPlusMenu (menu "Tải tệp" + "Giới hạn phạm vi" — Bước 5, UC-19); không truyền thì
   "+" mở thẳng hộp chọn tệp như trước.
   ==================================================================== */
export function bindChatPill(pill, input, onPlus) {
  if (!pill || pill.dataset.attachBound) return;
  pill.dataset.attachBound = "1";

  var plusBtn = pill.querySelector(".chat-pill-plus");
  if (plusBtn) plusBtn.addEventListener("click", onPlus || function (e) { e.stopPropagation(); triggerChatFileUpload(); });

  // Nguồn sự thật của việc đang kéo gì là state.drag (ghichu_core.js), KHÔNG phải
  // e.dataTransfer — không đụng gì tới dragstart hiện có của cây Notebook.
  function accepts(e) { return !!(state.drag && state.drag.kind === "chapter" && e.shiftKey); }

  pill.addEventListener("dragenter", function (e) {
    if (!accepts(e)) return;
    e.preventDefault(); e.stopPropagation();
    pill.classList.add("chat-pill--droptarget");
  });
  pill.addEventListener("dragover", function (e) {
    if (!accepts(e)) { pill.classList.remove("chat-pill--droptarget"); return; } // không giữ Shift -> không preventDefault, hành vi cũ nguyên vẹn
    e.preventDefault(); e.stopPropagation();
    // "move" — PHẢI khớp effectAllowed="move" mà dragstart của hàng Chương đã đặt
    // (ghichu_soanthao.js) — dropEffect không tương thích effectAllowed khiến trình duyệt
    // từ chối hoàn tất thả (dù dragover đã preventDefault()) trên drag-and-drop gốc trình
    // duyệt thật, kể cả khi có hiện highlight; CHỈ lộ ra khi test bằng chuột thật, không lộ
    // qua drop event tự dispatch bằng JS lúc gỡ lỗi.
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    pill.classList.add("chat-pill--droptarget");
  });
  pill.addEventListener("dragleave", function (e) {
    if (e.relatedTarget && pill.contains(e.relatedTarget)) return;
    pill.classList.remove("chat-pill--droptarget");
  });
  pill.addEventListener("drop", function (e) {
    if (!accepts(e)) return;
    e.preventDefault(); e.stopPropagation();
    var drag = state.drag; // đọc TRƯỚC khi dragend của hàng nguồn tự set về null
    pill.classList.remove("chat-pill--droptarget");
    state.drag = null;
    attachChapter({ id: drag.id, name: drag.name, subjectId: drag.s });
  });
}

/* ====================================================================
   Nút "+" — tải tệp/ảnh từ máy (cùng khuôn triggerPdfUpload/
   handlePdfFileSelected — ghichu_soanthao.js)
   ==================================================================== */
export function initChatAttach() {
  var input = $("chat-file-input");
  if (input) input.addEventListener("change", handleChatFileSelected);
}

export function triggerChatFileUpload() {
  var input = $("chat-file-input");
  if (!input) return;
  input.value = "";
  input.click();
}

function handleChatFileSelected() {
  var file = $("chat-file-input").files[0];
  if (!file) return;
  if (!ACCEPT_RE.test(file.name)) { window.alert("Chỉ nhận tệp PDF, ảnh (PNG/JPG/WEBP/GIF) hoặc .txt."); return; }
  if (!isOnline() && file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    window.alert("Tệp quá lớn (tối đa " + Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1024 / 1024) + "MB).");
    return;
  }
  // Đã đăng nhập: kích thước tệp + dung lượng còn trống theo hạn mức UC-33 (ghichu_hanmuc.js)
  if (isOnline() && !hooks.precheckUpload(file, { subjectId: null, kind: "chat" }, function () { uploadChatFile(file); })) return;
  uploadChatFile(file);
}

function uploadChatFile(file) {
  if (!isOnline()) {
    attach.items.push({ id: genLocalId(), kind: "file", label: file.name, size: file.size, mime: file.type });
    repaint();
    return;
  }

  var item = { id: genLocalId(), kind: "file", label: file.name, size: file.size, mime: file.type, uploading: true };
  attach.items.push(item);
  repaint();

  var form = new FormData();
  form.append("file", file);
  apiUpload("/chat/attachments/file", authToken(), form).then(function (res) {
    if (!res.ok) {
      attach.items = attach.items.filter(function (x) { return x !== item; });
      repaint();
      if (hooks.handleUploadError(res, file, { subjectId: null, kind: "chat" }, function () { uploadChatFile(file); })) return;
      window.alert((res.data && res.data.detail) || "Không tải lên được tệp đính kèm.");
      return;
    }
    hooks.afterUpload(res.data.label);
    item.id = res.data.id;
    item.label = res.data.label;
    item.mime = res.data.mime_type;
    item.size = res.data.file_size_bytes;
    item.uploading = false;
    repaint();
  });
}
