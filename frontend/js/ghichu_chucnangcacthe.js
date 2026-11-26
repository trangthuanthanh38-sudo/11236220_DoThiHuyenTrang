 /* ======================================================================
   ghichu_chucnangcacthe.js — MODULE 3: chức năng các thẻ trên thanh công cụ
   (ribbon): File (UI 2 nút Download/In — logic dựng PDF thật nằm ở
   ghichu_soanthao.js, module này chỉ dựng nút + gọi), Home (đậm/nghiêng/
   gạch chân, font/cỡ chữ, màu chữ/tô màu, danh sách có thứ tự/không thứ tự,
   thụt lề, căn lề, trích dẫn, sao chép định dạng), Insert (bảng, hình ảnh,
   liên kết, khối mã, đường kẻ), Draw (vẽ phác thảo + hình khối chèn vào ghi
   chú — khi đang xem PDF thì tab Draw đổi sang bộ công cụ chú thích PDF của
   ghichu_soanthao.js, không thuộc module này), History (hoàn tác/làm lại),
   Review (kiểm tra chính tả, khoá ghi chú, tìm trong nội dung), View (thu
   gọn Notebooks, toàn màn hình), Help (hướng dẫn/phím tắt/góp ý).

   Import từ ghichu_core.js (nền dùng chung) VÀ ghichu_soanthao.js (cần
   `editor` để gọi lệnh CKEditor, và vài hàm dispatch Download/In/bullet).
   KHÔNG có chiều import ngược lại (ghichu_soanthao.js không import module
   này) — xem ghi chú kiến trúc ở đầu ghichu_core.js.
   ====================================================================== */
import {
  hooks, state, $, el, esc, hasActiveChapter,
  FONTS, SIZE_MENU, BULLET_LIB, MAX_IMAGE_BYTES,
  buildGroup, btnText, btnTextDropdown, openDropdown,
} from "./ghichu_core.js";
import {
  editor, applyBulletType, downloadCurrentContent, printCurrentContent, fileExportBusy, pdfViewer,
  chapterBgControl, chapterDrawReadOnlyNow, buildPdfDrawExtras,
  chapterPageColorControl, VIEW_ZOOM_STEPS, viewZoomTarget, viewZoomValue, setViewZoom, stepViewZoom,
} from "./ghichu_soanthao.js";
import * as Ve from "./ghichu_ve.js";
import * as Review from "./ghichu_review.js";   // thẻ Review: Translate + Password

/* ---- các lệnh formatting: định tuyến sang lệnh thật của CKEditor ---- */
/* Định dạng chữ trên vùng chọn (font / cỡ / màu chữ / màu nền): ngoài chữ có sẵn (lệnh gốc của CKEditor — đã phủ cả ô bảng,
   chú thích ảnh, tiêu đề, danh sách), các DÒNG TRỐNG trong vùng chọn cũng "nhớ" kiểu này (thuộc tính selection:<key> mà
   CKEditor tự dùng cho dòng trống) → gõ vào dòng trống sau Ctrl+A ra đúng font / cỡ / màu như Word. Cùng 1 bước Ctrl+Z. */
var TEXT_STYLE_CMDS = ["fontFamily", "fontSize", "fontColor", "fontBackgroundColor"];
function applyTextStyle(name, opts) {
  var sel = editor.model.document.selection;
  editor.model.change(function (wr) {
    editor.execute(name, opts);
    if (sel.isCollapsed) return;
    var schema = editor.model.schema, value = opts && opts.value;
    for (var range of sel.getRanges()) {
      for (var item of range.getItems()) {
        if (!item.is("element") || !item.isEmpty || !schema.checkChild(item, "$text")) continue;
        if (value) wr.setAttribute("selection:" + name, value, item); else wr.removeAttribute("selection:" + name, item);
      }
    }
  });
}

function run(name, opts) {
  return function () {
    if (!editor) return;
    var cmd = editor.commands.get(name);
    if (!cmd) return;
    editor.editing.view.focus();
    if (TEXT_STYLE_CMDS.indexOf(name) >= 0) applyTextStyle(name, opts); else editor.execute(name, opts);
    readFormats();
    hooks.closeFloating();
  };
}

function exec(cmd, val) {
  var map = {
    bold: ["bold"], italic: ["italic"], underline: ["underline"], strikeThrough: ["strikethrough"],
    blockQuote: ["blockQuote"], removeFormat: ["removeFormat"],
    undo: ["undo"], redo: ["redo"],
    indent: ["indent"], outdent: ["outdent"],
    insertHorizontalRule: ["horizontalLine"],
    insertTable: ["insertTable", { rows: 2, columns: 2 }],
    codeBlock: ["codeBlock", { language: "plaintext" }],
    justifyLeft: ["alignment", { value: "left" }],
    justifyCenter: ["alignment", { value: "center" }],
    justifyRight: ["alignment", { value: "right" }],
    justifyFull: ["alignment", { value: "justify" }],
    foreColor: ["fontColor", { value: val }],
    hiliteColor: ["fontBackgroundColor", { value: val }],
    fontName: ["fontFamily", { value: val }],
    fontSize: ["fontSize", { value: val }],
  };
  if (cmd === "formatBlock") {
    if (val === "blockquote") return run("blockQuote");
    if (val === "p") return run("paragraph");
    return run("heading", { value: "heading" + (String(val).replace("h", "") || "2") });
  }
  var m = map[cmd];
  return m ? run(m[0], m[1]) : function () {};
}

function toggleList(kind, type) {
  if (!editor) return;
  var name = kind === "OL" ? "numberedList" : "bulletedList";
  editor.editing.view.focus();
  if (!editor.commands.get(name).value) editor.execute(name);
  if (type) applyBulletType(type);
  readFormats();
  hooks.closeFloating();
}

function indentLi() {
  if (!editor) return;
  editor.editing.view.focus();
  var c = editor.commands.get("indentList");
  editor.execute(c && c.isEnabled ? "indentList" : "indent");
  readFormats();
}
function outdentLi() {
  if (!editor) return;
  editor.editing.view.focus();
  var c = editor.commands.get("outdentList");
  editor.execute(c && c.isEnabled ? "outdentList" : "outdent");
  readFormats();
}

/* Đọc trạng thái formatting hiện tại từ CKEditor rồi render lại ribbon — hàm THẬT nằm ở
   ghichu_soanthao.js (readFormats gốc, vì nó đọc trực tiếp editor.commands và được initEditor()
   đăng ký làm listener); ở đây định nghĩa lại 1 bản dùng nội bộ module này chỉ để gọi
   hooks.renderRibbon() sau khi thực thi lệnh — TRÁNH sinh 2 nguồn sự thật, module này KHÔNG tự
   đọc lại editor.commands mà chỉ nhờ ghichu_soanthao.js làm việc đó qua editor.model.document
   "change:data"/"change:value" (đã đăng ký sẵn ở initEditor()); readFormats() ở đây chỉ cần
   render lại ribbon để phản ánh state.fmt mới nhất do sự kiện đó vừa cập nhật. */
function readFormats() { hooks.renderRibbon(); scheduleTablePlusUpdate(); }

/* ====================================================================
   Sao chép định dạng (Format Painter rút gọn — license CKEditor thật không
   khả dụng, xem giải thích trong bản gốc).
   ==================================================================== */
var FORMAT_PAINTER_ATTRS = ["bold", "italic", "underline", "strikethrough", "fontFamily", "fontSize", "fontColor", "fontBackgroundColor"];
var formatPainterClip = null;      // {attrs:{...}, heading:false|"heading1"...} | null
var formatPainterListener = null;

function toggleFormatPainter() {
  if (!editor) return;
  if (formatPainterClip) { cancelFormatPainter(); return; }
  var sel = editor.model.document.selection;
  var attrs = {};
  FORMAT_PAINTER_ATTRS.forEach(function (k) { if (sel.hasAttribute(k)) attrs[k] = sel.getAttribute(k); });
  var headingCmd = editor.commands.get("heading");
  formatPainterClip = { attrs: attrs, heading: headingCmd ? headingCmd.value : false };
  formatPainterListener = function () {
    if (editor.model.document.selection.isCollapsed) return;
    applyFormatPainter();
  };
  editor.editing.view.document.on("selectionChangeDone", formatPainterListener);
  hooks.renderRibbon();
}

export function cancelFormatPainter() {
  if (editor && formatPainterListener) editor.editing.view.document.off("selectionChangeDone", formatPainterListener);
  formatPainterListener = null;
  formatPainterClip = null;
  hooks.renderRibbon();
}

function applyFormatPainter() {
  if (!editor || !formatPainterClip) return;
  var clip = formatPainterClip;
  editor.model.change(function (writer) {
    Array.from(editor.model.document.selection.getRanges()).forEach(function (range) {
      FORMAT_PAINTER_ATTRS.forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(clip.attrs, key)) writer.setAttribute(key, clip.attrs[key], range);
        else writer.removeAttribute(key, range);
      });
    });
  });
  if (clip.heading && editor.commands.get("heading")) editor.execute("heading", { value: clip.heading });
  else if (!clip.heading && editor.commands.get("paragraph")) editor.execute("paragraph");
  cancelFormatPainter();
  readFormats();
}

function insertImage(file) {
  if (!editor || !file) return;
  if (file.size > MAX_IMAGE_BYTES) { window.alert("This picture is too large (max 6 MB)."); return; }
  var reader = new FileReader();
  reader.onload = function () {
    editor.execute("insertImage", { source: String(reader.result) });
    editor.editing.view.focus();
  };
  reader.readAsDataURL(file);
}

function triggerImagePicker() {
  if (!hasActiveChapter()) return;
  var input = document.createElement("input");
  input.type = "file"; input.accept = "image/*";
  input.addEventListener("change", function () { if (input.files && input.files[0]) insertImage(input.files[0]); });
  input.click();
}

/* ---- tìm trong nội dung (nút kính lúp cạnh breadcrumb) ---- */
function clearFind() {
  window.__tdLastFind = null;   // mở lại và tìm đúng từ cũ vẫn phải tìm lại từ đầu
  try { editor.plugins.get("FindAndReplaceEditing").stop(); } catch (e) { /* plugin không có / bản khác */ }
  try { editor.plugins.get("FindAndReplace").state.clear(editor.model); } catch (e) { /* như trên */ }
  var left = Array.from(editor.model.markers).filter(function (m) { return m.name.indexOf("findResult") === 0; });
  if (left.length) editor.model.change(function (writer) { left.forEach(function (m) { writer.removeMarker(m); }); });
}
export function runFind(action) {
  if (!editor) return;
  var has = function (n) { try { return !!editor.commands.get(n); } catch (e) { return false; } };
  var q = ($("find-input") ? $("find-input").value : "").trim();
  try {
    // Đóng ô tìm / xoá trắng từ khoá -> gỡ HẾT chữ bôi vàng. ĐO THẬT: state.clear() của FindAndReplace (CKEditor 41) không
    // gỡ marker "findResult:*" trên model nên từ khoá cũ vẫn bôi vàng sau khi đóng -> dừng plugin rồi tự gỡ marker còn sót.
    if (action === "stop" || !q) { clearFind(); return; }
    var seed = function () {
      if (window.__tdLastFind !== q && has("find")) { editor.execute("find", q); window.__tdLastFind = q; return true; }
      return false;
    };
    if (action === "find") { seed(); return; }
    if (action === "next") { var fresh = seed(); if (!fresh && has("findNext")) editor.execute("findNext"); return; }
    if (action === "prev") { seed(); if (has("findPrevious")) editor.execute("findPrevious"); }
  } catch (e) { console.warn("Tìm kiếm thất bại", e); }
}

function applySize(px) {
  var n = Math.max(8, Math.min(40, parseInt(px, 10) || 16));
  if (editor && editor.commands.get("fontSize")) {
    editor.editing.view.focus();
    applyTextStyle("fontSize", { value: n + "px" });
  }
  state.size = n; state.sizeDraft = String(n);
  hooks.renderRibbon();
}

/* ====================================================================
   Tab File — Download / In (dùng chung cho Chương lẫn File PDF; logic dựng
   PDF thật nằm ở ghichu_soanthao.js).
   ==================================================================== */
export function buildFileTab(wrap) {
  var canExportFile = pdfViewer.open || hasActiveChapter();
  var busy = fileExportBusy || (pdfViewer.open && !pdfViewer.pdfDoc);
  wrap.appendChild(buildGroup([
    btnText("⬇", fileExportBusy ? "Processing…" : "Download", downloadCurrentContent, !canExportFile || busy),
    btnText("🖨", "Print", printCurrentContent, !canExportFile || busy),
  ]));
}

/* ====================================================================
   Tab Home — kiểu đoạn văn / font / cỡ chữ / định dạng
   ==================================================================== */
function buildHomeExtra() {
  var wrap = el("div", "home-extra");

  var styleSel = el("select", "style-select");
  [["p", "Normal"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"]].forEach(function (o) {
    var opt = el("option", null, esc(o[1])); opt.value = o[0]; styleSel.appendChild(opt);
  });
  var headingVal = (state.fmt && state.fmt.heading) || false;
  styleSel.value = headingVal ? "h" + String(headingVal).replace("heading", "") : "p";
  styleSel.disabled = !hasActiveChapter();
  styleSel.addEventListener("change", function () { exec("formatBlock", styleSel.value)(); });

  var fontSel = el("select", "font-select");
  var blankOpt = el("option", null, ""); blankOpt.value = ""; blankOpt.hidden = true; fontSel.appendChild(blankOpt);   // vùng chọn nhiều font
  FONTS.forEach(function (f) {
    var opt = el("option", null, esc(f.label)); opt.value = f.value; fontSel.appendChild(opt);
  });
  fontSel.value = state.font;
  fontSel.disabled = !hasActiveChapter();
  fontSel.addEventListener("change", function () {
    if (!fontSel.value) return;
    var def = FONTS.filter(function (f) { return f.value === fontSel.value; })[0] || FONTS[0];
    exec("fontName", def.stack)();
    state.font = fontSel.value;
  });

  var sizeWrap = el("div", "size-select");
  var sizeInput = el("input", "size-input"); sizeInput.type = "number"; sizeInput.min = "8"; sizeInput.max = "40";
  sizeInput.value = state.sizeDraft; sizeInput.disabled = !hasActiveChapter();
  sizeInput.addEventListener("input", function () { state.sizeDraft = sizeInput.value; });
  sizeInput.addEventListener("change", function () { applySize(sizeInput.value); });
  sizeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); applySize(sizeInput.value); } });
  var sizeCaret = el("button", "size-caret");
  sizeCaret.type = "button"; sizeCaret.title = "Font Size"; sizeCaret.disabled = !hasActiveChapter();
  sizeCaret.addEventListener("click", function (e) {
    e.stopPropagation();
    var r = sizeWrap.getBoundingClientRect();
    var x = Math.max(8, Math.min(r.left, window.innerWidth - 90 - 10));
    openDropdown("size", x, r.bottom + 6, buildSizeDropdownHtml(), bindSizeDropdown);
  });
  sizeWrap.appendChild(sizeInput); sizeWrap.appendChild(sizeCaret);

  wrap.appendChild(styleSel); wrap.appendChild(fontSel); wrap.appendChild(sizeWrap);
  return wrap;
}

function homeIconBtn(opts) {
  var wrap = el("div", "home-item-wrap");
  var b = el("button", "home-item" + (opts.on ? " on" : ""));
  b.type = "button"; b.title = opts.label; b.disabled = !hasActiveChapter();
  b.innerHTML = opts.svg ? opts.svg : ('<span style="font-weight:' + (opts.weight || 500) + ";font-style:" + (opts.style || "normal") + ";text-decoration:" + (opts.deco || "none") + '">' + esc(opts.glyph) + "</span>");
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  wrap.appendChild(b);
  if (opts.dd) {
    var caret = el("button", "home-item-caret", "▾"); caret.type = "button"; caret.title = "More Options"; caret.disabled = !hasActiveChapter();
    caret.addEventListener("click", function (e) {
      e.stopPropagation();
      var r = b.getBoundingClientRect();
      var x = Math.max(8, Math.min(r.left - 30, window.innerWidth - (opts.ddWidth || 200) - 10));
      openDropdown(opts.id, x, r.bottom + 6, opts.dd(), opts.bind || function () {});
    });
    wrap.appendChild(caret);
  }
  return wrap;
}

function colorDropdown(cmd, stateKey, autoLabel, autoColor) {
  var themeBase = ["#ffffff", "#000000", "#e7e6e6", "#0f2a4d", "#1f6feb", "#e8590c", "#2f9e44", "#1c9be6", "#9c36b5", "#40c057"];
  var tintMixes = [null, ["#ffffff", 60], ["#000000", 25], ["#000000", 50]];
  var standardBase = ["#c92a2a", "#fa5252", "#f59f00", "#fcc419", "#a9e34b", "#40c057", "#22b8cf", "#1971c2", "#0b1e59", "#7048e8"];
  var mix = function (c, m) { return m ? "color-mix(in srgb, " + c + " " + (100 - m[1]) + "%, " + m[0] + ")" : c; };
  var html = '<div class="dd-color">';
  html += '<button type="button" class="dd-color-auto" data-auto="1"><span class="dd-color-swatch" style="background:' + autoColor + '"></span>' + esc(autoLabel) + "</button>";
  html += '<div class="dd-label">Theme Colors</div>';
  tintMixes.forEach(function (m) {
    html += '<div class="dd-color-row">' + themeBase.map(function (c) {
      var col = mix(c, m);
      return '<span class="dd-swatch" data-color="' + col + '" title="' + col + '" style="background:' + col + '"></span>';
    }).join("") + "</div>";
  });
  html += '<div class="dd-label">Standard Colors</div><div class="dd-color-row">' + standardBase.map(function (c) {
    return '<span class="dd-swatch" data-color="' + c + '" title="' + c + '" style="background:' + c + '"></span>';
  }).join("") + "</div></div>";
  return {
    html: html,
    bind: function (panel) {
      // "Tự động" / "Không tô màu" = BỎ màu (chữ theo màu mặc định của giao diện Sáng / Tối), không ghi cứng 1 mã màu.
      panel.querySelector("[data-auto]").addEventListener("click", function () { exec(cmd, null)(); state[stateKey] = autoColor; hooks.closeFloating(); });
      panel.querySelectorAll("[data-color]").forEach(function (sw) {
        sw.addEventListener("click", function () { var c = sw.getAttribute("data-color"); exec(cmd, c)(); state[stateKey] = c; hooks.closeFloating(); });
      });
    },
  };
}

function buildSizeDropdownHtml() {
  return '<div class="dd-plain">' + SIZE_MENU.map(function (n) {
    return '<button type="button" data-size="' + n + '"' + (n === state.size ? ' class="on"' : "") + ">" + n + "</button>";
  }).join("") + "</div>";
}
function bindSizeDropdown(panel) {
  panel.querySelectorAll("[data-size]").forEach(function (b) {
    b.addEventListener("click", function () { applySize(b.getAttribute("data-size")); hooks.closeFloating(); });
  });
}

function buildHomeItems() {
  var wrap = el("div", "home-items");
  var fmt = state.fmt || {};

  wrap.appendChild(homeIconBtn({ label: "Bold (Ctrl+B)", glyph: "B", weight: 700, on: fmt.bold, onClick: exec("bold") }));
  wrap.appendChild(homeIconBtn({ label: "Italic (Ctrl+I)", glyph: "I", style: "italic", on: fmt.italic, onClick: exec("italic") }));
  wrap.appendChild(homeIconBtn({ label: "Underline (Ctrl+U)", glyph: "U", deco: "underline", on: fmt.underline, onClick: exec("underline") }));
  wrap.appendChild(homeIconBtn({ label: "Strikethrough", glyph: "ab", deco: "line-through", on: fmt.strikeThrough, onClick: exec("strikeThrough") }));

  var hi = colorDropdown("hiliteColor", "hiColor", "No Color", "#ffffff");
  wrap.appendChild(homeIconBtn({
    id: "hi", label: "Text Highlight Color", ddWidth: 266,
    svg: '<svg width="21" height="21" viewBox="0 0 20 20" fill="none"><path d="M12.6 3.4l3.6 3.6-6.1 6.1H6.5V9.5z" stroke="#4a5468" stroke-width="1.4" stroke-linejoin="round"></path><path d="M5.2 13.2l1.6 1.6" stroke="#4a5468" stroke-width="1.4" stroke-linecap="round"></path><rect x="3" y="16" width="14" height="3" rx="1" fill="' + (state.hiColor || "#fff2a8") + '"></rect></svg>',
    onClick: exec("hiliteColor", state.hiColor || "#fff2a8"), dd: function () { return hi.html; }, bind: hi.bind,
  }));

  var ink = colorDropdown("foreColor", "inkColor", "Automatic", "#050d2b");
  wrap.appendChild(homeIconBtn({
    id: "ink", label: "Font Color", ddWidth: 266,
    svg: '<svg width="21" height="21" viewBox="0 0 20 20" fill="none"><text x="10" y="13.5" text-anchor="middle" font-family="Figtree, sans-serif" font-size="13" font-weight="600" fill="#4a5468">A</text><rect x="3" y="16" width="14" height="3" rx="1" fill="' + (state.inkColor || "#e03131") + '"></rect></svg>',
    onClick: exec("foreColor", state.inkColor || "#e03131"), dd: function () { return ink.html; }, bind: ink.bind,
  }));

  wrap.appendChild(homeIconBtn({
    id: "ul", label: "Bullets", ddWidth: 254, on: fmt.insertUnorderedList,
    svg: '<svg width="17" height="15" viewBox="0 0 20 16" fill="none"><rect x="0" y="1" width="3" height="3" rx="1" fill="#0d6efd"></rect><rect x="0" y="6.5" width="3" height="3" rx="1" fill="#0d6efd"></rect><rect x="0" y="12" width="3" height="3" rx="1" fill="#0d6efd"></rect><rect x="6" y="2" width="14" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="6" y="7.5" width="14" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="6" y="13" width="14" height="1.6" rx="0.8" fill="#8b93a5"></rect></svg>',
    onClick: function () { toggleList("UL", "disc"); },
    dd: function () { return '<div class="dd-bullets-label">Bullet Library</div><div class="dd-bullets">' +
      BULLET_LIB.map(function (b) { return '<button type="button" class="dd-bullet" title="' + esc(b.label) + '" data-type=\'' + esc(b.type) + "'>" + esc(b.glyph) + "</button>"; }).join("") + "</div>"; },
    bind: function (panel) { panel.querySelectorAll("[data-type]").forEach(function (b) { b.addEventListener("click", function () { toggleList("UL", b.getAttribute("data-type")); }); }); },
  }));

  wrap.appendChild(homeIconBtn({
    id: "ol", label: "Numbering", ddWidth: 180, on: fmt.insertOrderedList,
    svg: '<svg width="19" height="15" viewBox="0 0 22 16" fill="none"><text x="0" y="5" font-family="Figtree, sans-serif" font-size="6" fill="#4a5468">1</text><text x="0" y="10.5" font-family="Figtree, sans-serif" font-size="6" fill="#4a5468">2</text><text x="0" y="16" font-family="Figtree, sans-serif" font-size="6" fill="#4a5468">3</text><rect x="7" y="2" width="15" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="7" y="7.5" width="15" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="7" y="13" width="15" height="1.6" rx="0.8" fill="#8b93a5"></rect></svg>',
    onClick: function () { toggleList("OL", "decimal"); },
    dd: function () { return '<div class="dd-plain">' +
      [["decimal", "1. 2. 3."], ["lower-latin", "a. b. c."], ["upper-latin", "A. B. C."], ["lower-roman", "i. ii. iii."], ["upper-roman", "I. II. III."]]
        .map(function (o) { return '<button type="button" data-type="' + o[0] + '">' + esc(o[1]) + "</button>"; }).join("") + "</div>"; },
    bind: function (panel) { panel.querySelectorAll("[data-type]").forEach(function (b) { b.addEventListener("click", function () { toggleList("OL", b.getAttribute("data-type")); }); }); },
  }));

  wrap.appendChild(homeIconBtn({
    label: "Decrease Indent", onClick: outdentLi,
    svg: '<svg width="17" height="15" viewBox="0 0 20 16" fill="none"><rect x="7" y="1" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="7" y="7.2" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="7" y="13.4" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><path d="M5 5.2L1.5 8l3.5 2.8" stroke="#0d6efd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  }));
  wrap.appendChild(homeIconBtn({
    label: "Increase Indent", onClick: indentLi,
    svg: '<svg width="17" height="15" viewBox="0 0 20 16" fill="none"><rect x="0" y="1" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="0" y="7.2" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="0" y="13.4" width="13" height="1.6" rx="0.8" fill="#8b93a5"></rect><path d="M15 5.2L18.5 8 15 10.8" stroke="#0d6efd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  }));

  wrap.appendChild(homeIconBtn({
    id: "align", label: "Align", ddWidth: 170, onClick: exec("justifyLeft"),
    svg: '<svg width="17" height="15" viewBox="0 0 20 16" fill="none"><rect x="0" y="2" width="20" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="0" y="7.5" width="20" height="1.6" rx="0.8" fill="#8b93a5"></rect><rect x="0" y="13" width="20" height="1.6" rx="0.8" fill="#8b93a5"></rect></svg>',
    dd: function () { return '<div class="dd-plain">' +
      [["justifyLeft", "Align Left"], ["justifyCenter", "Center"], ["justifyRight", "Align Right"], ["justifyFull", "Justify"]]
        .map(function (o) { return '<button type="button" data-cmd="' + o[0] + '">' + esc(o[1]) + "</button>"; }).join("") + "</div>"; },
    bind: function (panel) { panel.querySelectorAll("[data-cmd]").forEach(function (b) { b.addEventListener("click", exec(b.getAttribute("data-cmd"))); }); },
  }));

  wrap.appendChild(homeIconBtn({ label: "Quote", glyph: "❝", on: fmt.blockQuote, onClick: exec("blockQuote") }));

  wrap.appendChild(homeIconBtn({
    label: formatPainterClip ? "Format Painter (select the text to format — click again to cancel)" : "Format Painter",
    on: !!formatPainterClip, onClick: toggleFormatPainter,
    svg: '<svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M17.2 2.8a1.3 1.3 0 0 0-1.9 0l-4.6 4.9 1.9 1.8 4.6-4.8a1.3 1.3 0 0 0 0-1.9z" fill="#fff" stroke="#4a5468" stroke-width="1.1" stroke-linejoin="round"></path><path d="M10.7 7.7l1.9 1.8-1.2 1.2-3-.6.6-1.4z" fill="#fff" stroke="#4a5468" stroke-width="1.1" stroke-linejoin="round"></path><path d="M9 9.9l2.4 1.1c-.6 2.6-2.4 5-5.9 6.4L2.6 16c2-.7 4.3-3.1 6.4-6.1z" fill="#f7a35c" stroke="#e8590c" stroke-width="1.1" stroke-linejoin="round"></path><path d="M5.2 15.4l1.8-2M7.4 15.7l1.5-1.9" stroke="#e8590c" stroke-width="1" stroke-linecap="round"></path></svg>',
  }));
  wrap.appendChild(homeIconBtn({
    label: "Clear All Formatting", onClick: exec("removeFormat"),
    svg: '<svg width="19" height="19" viewBox="0 0 20 20" fill="none"><text x="8" y="13.5" text-anchor="middle" font-family="Figtree, sans-serif" font-size="13" font-weight="600" fill="#4a5468">A</text><path d="M4 16l12-12" stroke="#e03131" stroke-width="1.6" stroke-linecap="round"></path></svg>',
  }));

  return wrap;
}

export function buildHomeTab(wrap) {
  wrap.appendChild(buildHomeExtra());
  wrap.appendChild(buildHomeItems());
}

/* ====================================================================
   Tab Insert — Bảng (dùng đúng feature Table thật của CKEditor) / Hình ảnh
   / Liên kết / Trích dẫn / Khối mã / Đường kẻ

   Bảng: bấm "Bảng" (nút chính hoặc mũi tên ▾) mở 1 lưới ô vuông kiểu
   Word/Google Docs — rê chuột để xem trước kích thước (vd. "4 × 4 Bảng"),
   bấm ô để chèn ngay đúng số cột×hàng đó; mục "Chèn bảng tuỳ chỉnh…" mở hộp
   thoại nhập số chính xác khi cần lớn hơn lưới. Phần "Hàng"/"Cột" bên dưới
   (thêm/xoá khi con trỏ đang trong 1 bảng) giữ nguyên như trước.
   ==================================================================== */
var TABLE_GRID_COLS = 10;
var TABLE_GRID_ROWS = 8;
var TABLE_DD_WIDTH = 232;

// Chia đều 100% cho từng cột, làm tròn 2 số thập phân và bù phần dư vào cột cuối để tổng
// luôn đúng 100% (tránh lỗi lệch 0.0x% khi 100 không chia hết cho số cột).
function equalColumnWidthsPercent(cols) {
  var base = Math.floor((100 / cols) * 100) / 100;
  var widths = [];
  var used = 0;
  for (var i = 0; i < cols - 1; i++) { widths.push(base); used += base; }
  widths.push(Math.round((100 - used) * 100) / 100);
  return widths.map(function (w) { return w + "%"; });
}

// Đặt lại bảng = 100% chiều rộng vùng soạn thảo + chia đều % cho TOÀN BỘ cột hiện có (đọc lại
// số cột MỚI NHẤT từ chính bảng mỗi lần gọi, không dùng số cũ) — dùng chung cho lúc chèn bảng
// lẫn mỗi lần bấm "+" thêm hàng/cột, để cột/bảng luôn được cân lại đúng theo trạng thái hiện
// tại dù thêm liên tiếp nhiều lần. "resizeTableWidth" đúng là lệnh nội bộ mà thao tác kéo-thả
// cột của CKEditor dùng — chỉ đổi thuộc tính tableWidth/columnWidths, KHÔNG đụng tới nội dung
// hàng/cột/ô nào nên không bao giờ làm mất dữ liệu đã nhập.
function rebalanceTableWidth(tableModel) {
  if (!editor || !tableModel || !editor.commands.get("resizeTableWidth")) return;
  try {
    var tableUtils = editor.plugins.get("TableUtils");
    var cols = tableUtils.getColumns(tableModel);
    editor.execute("resizeTableWidth", { table: tableModel, tableWidth: "100%", columnWidths: equalColumnWidthsPercent(cols) });
  } catch (e) { console.warn("Không cân lại được kích thước bảng", e); }
}

function insertTableSized(rows, cols) {
  if (!editor || !editor.commands.get("insertTable")) return;
  // focus() trước execute() để lệnh chèn bảng dùng ĐÚNG vị trí con trỏ hiện tại trong bài ghi
  // chú (kể cả sau khi người dùng vừa thao tác trên lưới/hộp thoại chọn kích thước, hoàn toàn
  // nằm ngoài vùng soạn thảo) — insertTable của CKEditor tự tách đoạn văn tại đúng vị trí đó
  // và đẩy phần nội dung phía sau xuống dưới bảng (insertObject + findOptimalPosition:"auto"),
  // không chèn lên đầu/cuối tài liệu.
  editor.editing.view.focus();
  editor.execute("insertTable", { rows: rows, columns: cols });
  // Mặc định CKEditor chèn bảng ở chế độ "co theo nội dung" (auto/shrink-to-fit, căn giữa) —
  // cân lại ngay để bảng = 100% chiều rộng vùng soạn thảo, cột chia đều, y hệt như vừa được
  // người dùng tự kéo-thả — nhờ đó vẫn co giãn đúng tỉ lệ khi đổi cỡ cửa sổ/zoom sau này,
  // không dùng px cố định nào.
  rebalanceTableWidth(findSelectionTableModelElement());
  readFormats();
  hooks.closeFloating();
}

function buildTableGridCellsHtml() {
  var html = "";
  for (var r = 0; r < TABLE_GRID_ROWS; r++) {
    for (var c = 0; c < TABLE_GRID_COLS; c++) {
      html += '<button type="button" class="dd-table-cell" data-r="' + r + '" data-c="' + c + '" tabindex="-1"></button>';
    }
  }
  return html;
}

/* ---- "Xoá nội dung" + "Căn lề" cho các ô đang chọn (bôi đen nhiều ô) hoặc ô đang chứa con
   trỏ — thay cho mục Hàng/Cột cũ (thêm hàng/cột giờ làm bằng nút "+" cạnh vùng bôi đen, xem
   khối "+" bên dưới). Căn lề dùng lệnh thật của plugin TableCellProperties (có sẵn trong
   super-build): căn ngang lưu thành text-align, căn dọc thành vertical-align của từng ô. ---- */
var TABLE_ALIGN_H = [
  ["left", "Align Left", '<path d="M3 5h14M3 9h9M3 13h14M3 17h9"/>'],
  ["center", "Center", '<path d="M3 5h14M5.5 9h9M3 13h14M5.5 17h9"/>'],
  ["right", "Align Right", '<path d="M3 5h14M8 9h9M3 13h14M8 17h9"/>'],
  ["justify", "Justify", '<path d="M3 5h14M3 9h14M3 13h14M3 17h14"/>'],
];
var TABLE_ALIGN_V = [
  ["top", "Align Top", '<path d="M3 3h14"/><path d="M6 7h8M6 10h8"/>'],
  ["middle", "Align Middle", '<path d="M6 8.5h8M6 11.5h8"/><path d="M3 3h14M3 17h14" stroke-dasharray="2 2"/>'],
  ["bottom", "Align Bottom", '<path d="M3 17h14"/><path d="M6 10h8M6 13h8"/>'],
];

function allCellsOfTable(table) {
  var out = [];
  for (var row of table.getChildren()) {
    if (!row.is("element", "tableRow")) continue;
    for (var cell of row.getChildren()) if (cell.is("element", "tableCell")) out.push(cell);
  }
  return out;
}

// Các ô chịu tác động của Xoá nội dung / Căn lề: ô chứa con trỏ, các ô bôi đen, và — khi chọn
// NGUYÊN bảng (bấm tay nắm góc bảng) hoặc bôi đen vắt qua cả bảng cùng đoạn văn xung quanh —
// mọi ô của (các) bảng nằm trong vùng chọn.
function selectedTableCells() {
  if (!editor) return [];
  var sel = editor.model.document.selection;
  var cells = [];
  try { cells = editor.plugins.get("TableUtils").getSelectionAffectedTableCells(sel).slice(); } catch (e) { cells = []; }
  var tables = [];
  var picked = sel.getSelectedElement();
  if (picked && picked.is("element", "table")) tables.push(picked);
  if (!cells.length) {
    for (var range of sel.getRanges()) {
      if (range.isCollapsed) continue;
      for (var item of range.getItems()) {
        if (item.is("element", "table") && tables.indexOf(item) < 0) tables.push(item);
      }
    }
  }
  tables.forEach(function (t) {
    allCellsOfTable(t).forEach(function (c) { if (cells.indexOf(c) < 0) cells.push(c); });
  });
  return cells;
}

// Căn lề ghi thẳng thuộc tính model của plugin TableCellProperties lên từng ô (giống hệt lệnh
// tableCellHorizontalAlignment / VerticalAlignment, nhưng chạy được cả khi chọn nguyên bảng —
// lúc đó 2 lệnh gốc bị khoá). Giá trị mặc định (trái / giữa dọc) thì xoá thuộc tính.
var TABLE_ALIGN_DEFAULT = { tableCellHorizontalAlignment: "left", tableCellVerticalAlignment: "middle" };

function applyCellAlign(attr, value) {
  var cells = selectedTableCells();
  if (!cells.length) return;
  editor.model.change(function (writer) {
    cells.forEach(function (cell) {
      if (value === TABLE_ALIGN_DEFAULT[attr]) writer.removeAttribute(attr, cell);
      else writer.setAttribute(attr, value, cell);
    });
  });
}

// Giá trị chung của các ô đích (null nếu các ô đang căn khác nhau → không nút nào sáng).
function cellAlignValue(attr, cells) {
  var cur;
  for (var i = 0; i < cells.length; i++) {
    var v = cells[i].getAttribute(attr) || TABLE_ALIGN_DEFAULT[attr];
    if (i === 0) cur = v; else if (v !== cur) return null;
  }
  return cur || null;
}

// Xoá chữ/ảnh trong các ô nhưng GIỮ nguyên ô (không xoá hàng/cột): mỗi ô còn lại đúng 1 đoạn
// văn rỗng. Bôi đen nhiều ô thì vùng chọn vẫn giữ các ô đó; chỉ 1 ô thì đặt con trỏ vào ô đó.
function clearTableCellsContent() {
  var cells = selectedTableCells();
  if (!cells.length) return;
  // Chỉ dời con trỏ vào ô khi đang đứng trong đúng 1 ô; bôi đen nhiều ô / chọn nguyên bảng thì giữ vùng chọn.
  var multi = cells.length > 1;
  editor.model.change(function (writer) {
    cells.forEach(function (cell) {
      writer.remove(writer.createRangeIn(cell));
      writer.insertElement("paragraph", cell, 0);
    });
    if (!multi) writer.setSelection(cells[0].getChild(0), 0);
  });
  editor.editing.view.focus();
  readFormats();
}

// Gộp ô: dùng lệnh mergeTableCells của CKEditor — cần bôi đen ≥ 2 ô liền nhau thành hình chữ
// nhật (nội dung các ô được nối vào ô đầu). Chọn nguyên bảng (tay nắm góc bảng) thì lệnh gốc bị
// khoá, nên chuyển vùng chọn thành "chọn hết ô" rồi gộp cả bảng thành 1 ô.
function wholeSelectedTable() {
  var picked = editor && editor.model.document.selection.getSelectedElement();
  return picked && picked.is("element", "table") ? picked : null;
}
function canMergeCells() {
  if (!editor || state.noteLocked) return false;
  var cmd = editor.commands.get("mergeTableCells");
  if (!cmd) return false;
  if (cmd.isEnabled) return true;
  var t = wholeSelectedTable();
  return !!t && allCellsOfTable(t).length > 1;
}
function mergeSelectedCells() {
  if (!canMergeCells()) return;
  var cmd = editor.commands.get("mergeTableCells");
  if (!cmd.isEnabled) {
    var cells = allCellsOfTable(wholeSelectedTable());
    try { editor.plugins.get("TableSelection").setCellSelection(cells[0], cells[cells.length - 1]); } catch (e) { return; }
  }
  if (!cmd.isEnabled) return;
  editor.execute("mergeTableCells");
  editor.editing.view.focus();
  readFormats();
}

function tableAlignButtonsHtml(list, cmdName, cells) {
  var enabled = cells.length > 0;
  var cur = enabled ? cellAlignValue(cmdName, cells) : null;
  return list.map(function (a) {
    return '<button type="button" class="dd-table-align-btn' + (cur === a[0] ? " on" : "") + '" data-align-cmd="' + cmdName +
      '" data-align="' + a[0] + '" title="' + esc(a[1]) + '" aria-label="' + esc(a[1]) + '"' + (enabled ? "" : " disabled") + ">" +
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' + a[2] + "</svg></button>";
  }).join("");
}

function buildTableDropdown() {
  var targetCells = editor && !state.noteLocked ? selectedTableCells() : [];
  var inTable = targetCells.length > 0;
  return {
    html: '<div class="dd-table-picker">' +
      '<div class="dd-table-label">Insert Table</div>' +
      '<div class="dd-table-grid">' + buildTableGridCellsHtml() + "</div>" +
      '<button type="button" class="dd-table-custom" data-cmd="__custom">Insert Table…</button>' +
      "</div>" +
      '<div class="dd-plain dd-table-sep">' +
      '<div class="dd-label">Cell Contents</div>' +
      '<button type="button" data-cmd="__clear"' + (inTable ? "" : " disabled") + ">Clear Contents</button>" +
      '<button type="button" data-cmd="__merge"' + (canMergeCells() ? "" : ' disabled title="Select two or more adjacent cells to merge"') + ">Merge Cells</button>" +
      '<div class="dd-label" style="margin-top:6px">Alignment</div>' +
      '<div class="dd-table-align-row"><span>Horizontal</span>' + tableAlignButtonsHtml(TABLE_ALIGN_H, "tableCellHorizontalAlignment", targetCells) + "</div>" +
      '<div class="dd-table-align-row"><span>Vertical</span>' + tableAlignButtonsHtml(TABLE_ALIGN_V, "tableCellVerticalAlignment", targetCells) + "</div>" +
      (inTable
        ? '<div class="dd-table-hint">Applies to the cell with the cursor, the selected cells, or the whole table when the table is selected. Merge Cells: select two or more adjacent cells. Select a whole row or column to show the + button.</div>'
        : '<div class="dd-table-hint">Place the cursor in a table, select cells or select the whole table to clear contents or set alignment.</div>') +
      "</div>",
    bind: function (panel) {
      var cells = Array.prototype.slice.call(panel.querySelectorAll(".dd-table-cell"));
      var label = panel.querySelector(".dd-table-label");
      var highlight = function (r, c) {
        cells.forEach(function (cell) {
          var on = (+cell.getAttribute("data-r") <= r) && (+cell.getAttribute("data-c") <= c);
          cell.classList.toggle("hover", on);
        });
        label.textContent = (c + 1) + " × " + (r + 1) + " Table";
      };
      var reset = function () {
        cells.forEach(function (cell) { cell.classList.remove("hover"); });
        label.textContent = "Insert Table";
      };
      cells.forEach(function (cell) {
        var r = +cell.getAttribute("data-r"), c = +cell.getAttribute("data-c");
        cell.addEventListener("mouseenter", function () { highlight(r, c); });
        cell.addEventListener("click", function () { insertTableSized(r + 1, c + 1); });
      });
      panel.querySelector(".dd-table-grid").addEventListener("mouseleave", reset);
      panel.querySelector('[data-cmd="__custom"]').addEventListener("click", function () {
        hooks.closeFloating();
        openTableCustomModal();
      });
      var clearBtn = panel.querySelector('[data-cmd="__clear"]');
      clearBtn.addEventListener("click", function () { clearTableCellsContent(); hooks.closeFloating(); });
      panel.querySelector('[data-cmd="__merge"]').addEventListener("click", function () { mergeSelectedCells(); hooks.closeFloating(); });
      // Căn lề: giữ hộp mở để chỉnh cả ngang lẫn dọc liền một lượt, nút đang áp dụng tô đậm.
      panel.querySelectorAll("[data-align-cmd]").forEach(function (b) {
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function (e) {
          e.stopPropagation();   // không để click lan lên document (ghichu.js) làm đóng menu
          var cmdName = b.getAttribute("data-align-cmd");
          if (!editor) return;
          applyCellAlign(cmdName, b.getAttribute("data-align"));
          panel.querySelectorAll('[data-align-cmd="' + cmdName + '"]').forEach(function (x) {
            x.classList.toggle("on", x === b);
          });
          scheduleTablePlusUpdate();
        });
      });
    },
  };
}

function openTableDropdownAt(anchorEl) {
  var tableDd = buildTableDropdown();
  var r = anchorEl.getBoundingClientRect();
  var x = Math.max(8, Math.min(r.left, window.innerWidth - TABLE_DD_WIDTH - 10));
  openDropdown("table", x, r.bottom + 6, tableDd.html, tableDd.bind);
}

/* ---- "Chèn bảng tuỳ chỉnh…" — hộp thoại nhập chính xác số cột/hàng khi
   cần lớn hơn lưới 10×8 ở trên (dựng động bằng JS, dùng lại đúng CSS modal
   dùng chung .modal-overlay/.modal/.modal-head/.modal-foot đã có sẵn). ---- */
var tableCustomModalBuilt = false;
function ensureTableCustomModal() {
  if (tableCustomModalBuilt) return;
  tableCustomModalBuilt = true;
  var overlay = el("div", "modal-overlay");
  overlay.id = "table-custom-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="modal table-custom-modal">' +
      '<div class="modal-head"><span class="modal-title">Insert Table</span>' +
        '<button type="button" class="icon-btn-sm" id="table-custom-close" title="Close">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>' +
        "</button></div>" +
      '<div class="table-custom-body">' +
        '<label>Number of columns<input type="number" id="table-custom-cols" min="1" max="30" value="3"></label>' +
        '<label>Number of rows<input type="number" id="table-custom-rows" min="1" max="100" value="3"></label>' +
      "</div>" +
      '<div class="modal-foot"><button type="button" class="btn-plain" id="table-custom-cancel">Cancel</button>' +
        '<button type="button" class="btn-solid" id="table-custom-insert">OK</button></div>' +
    "</div>";
  document.body.appendChild(overlay);
  var close = function () { overlay.hidden = true; };
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  $("table-custom-close").addEventListener("click", close);
  $("table-custom-cancel").addEventListener("click", close);
  $("table-custom-insert").addEventListener("click", function () {
    var cols = Math.max(1, Math.min(30, parseInt($("table-custom-cols").value, 10) || 1));
    var rows = Math.max(1, Math.min(100, parseInt($("table-custom-rows").value, 10) || 1));
    close();
    insertTableSized(rows, cols);
  });
}
function openTableCustomModal() {
  ensureTableCustomModal();
  $("table-custom-overlay").hidden = false;
}

/* ---- "+" thêm nhanh hàng/cột cạnh bảng đang chứa con trỏ (kiểu Notion/Google
   Docs) — 2 nút nổi dựng động, KHÔNG nằm trong nội dung bảng/editor (append
   thẳng vào <body>, ngoài .editor-scroll) nên không bao giờ lọt vào dữ liệu
   bảng, không bị chụp khi Download/In (UC-17 chỉ render/chụp .editor-shell,
   CSS @media print cũng ẩn mọi thứ ngoài .editor-scroll — xem
   ghichu_soanthao.css). Vị trí bám theo bảng qua getBoundingClientRect() nên
   cập nhật lại mỗi khi layout đổi (gõ chữ, cuộn trang, đổi cỡ cửa sổ). ---- */
var tablePlusColBtn = null, tablePlusRowBtn = null, tablePlusCurrentTable = null, tablePlusRaf = null;

function ensureTablePlusButtons() {
  if (tablePlusColBtn) return;
  tablePlusColBtn = el("button", "table-plus-btn table-plus-col", "+");
  tablePlusColBtn.type = "button"; tablePlusColBtn.title = "Insert Column";
  tablePlusRowBtn = el("button", "table-plus-btn table-plus-row", "+");
  tablePlusRowBtn.type = "button"; tablePlusRowBtn.title = "Insert Row";
  var keepFocus = function (e) { e.preventDefault(); };
  tablePlusColBtn.addEventListener("mousedown", keepFocus);
  tablePlusRowBtn.addEventListener("mousedown", keepFocus);
  tablePlusColBtn.addEventListener("click", addTableColumnQuick);
  tablePlusRowBtn.addEventListener("click", addTableRowQuick);
  document.body.appendChild(tablePlusColBtn);
  document.body.appendChild(tablePlusRowBtn);
}

function hideTablePlus() {
  tablePlusCurrentTable = null;
  if (tablePlusColBtn) tablePlusColBtn.classList.remove("show");
  if (tablePlusRowBtn) tablePlusRowBtn.classList.remove("show");
}

function findSelectionTableModelElement() {
  if (!editor) return null;
  var pos = editor.model.document.selection.getFirstPosition();
  var node = pos && pos.parent;
  while (node) {
    if (node.is && node.is("element", "table")) return node;
    node = node.parent;
  }
  return null;
}

/* ---- "+" cạnh vùng bôi đen: bôi đen trọn 1 (hoặc nhiều) hàng → nút "+" ở mép trái, ngay
   đường kẻ dưới hàng cuối được chọn → chèn 1 hàng ngay SAU đó; bôi đen trọn cột → nút "+" ở
   mép trên, ngay đường kẻ phải của cột cuối → chèn 1 cột ngay sau. Chèn xong vùng chọn chuyển
   sang hàng/cột mới nên bấm tiếp sẽ chèn nối tiếp. Dùng lệnh thật insertTableRowBelow /
   insertTableColumnRight (chèn sau hàng/cột cuối của vùng chọn, chép cấu trúc gộp ô). ---- */
var selPlusRowBtn = null, selPlusColBtn = null, selPlusInfo = null;

function ensureSelPlusButtons() {
  if (selPlusRowBtn) return;
  var make = function (cls, title, onClick) {
    var b = el("button", "table-sel-plus " + cls, "+");
    b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", onClick);
    document.body.appendChild(b);
    return b;
  };
  selPlusRowBtn = make("table-sel-plus-row", "Insert Row Below", function () { insertAfterSelection("row"); });
  selPlusColBtn = make("table-sel-plus-col", "Insert Column Right", function () { insertAfterSelection("col"); });
}

function hideSelPlus() {
  selPlusInfo = null;
  if (selPlusRowBtn) { selPlusRowBtn.classList.remove("show"); selPlusColBtn.classList.remove("show"); }
}

function cellDomRect(cell) {
  var viewEl = editor.editing.mapper.toViewElement(cell);
  var dom = viewEl && editor.editing.view.domConverter.mapViewToDom(viewEl);
  return dom ? dom.getBoundingClientRect() : null;
}

// Trả {table, rows:{first,last}, cols:{first,last}, fullRow, fullCol, rect} khi đang bôi đen
// nhiều ô (TableSelection) phủ trọn hàng và/hoặc trọn cột; ngược lại null.
function readFullRowColSelection() {
  var tu = editor.plugins.get("TableUtils");
  var cells = tu.getSelectedTableCells(editor.model.document.selection);
  if (!cells.length) return null;
  var table = cells[0].findAncestor("table");
  if (!table) return null;
  var rows = tu.getRowIndexes(cells), cols = tu.getColumnIndexes(cells);
  var fullRow = cols.first === 0 && cols.last === tu.getColumns(table) - 1;
  var fullCol = rows.first === 0 && rows.last === tu.getRows(table) - 1;
  if (!fullRow && !fullCol) return null;
  var rect = null;
  cells.forEach(function (c) {
    var r = cellDomRect(c);
    if (!r) return;
    rect = rect ? { left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top), right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  if (!rect) return null;
  return { table: table, rows: rows, cols: cols, fullRow: fullRow, fullCol: fullCol, rect: rect };
}

function updateSelPlus() {
  ensureSelPlusButtons();
  var info = null;
  try { info = readFullRowColSelection(); } catch (e) { info = null; }
  if (!info) { hideSelPlus(); return; }
  selPlusInfo = info;
  var r = info.rect;
  selPlusRowBtn.classList.toggle("show", info.fullRow);
  selPlusColBtn.classList.toggle("show", info.fullCol);
  if (info.fullRow) {
    selPlusRowBtn.style.left = (r.left - 30) + "px";
    selPlusRowBtn.style.top = (r.bottom - 11) + "px";
  }
  if (info.fullCol) {
    selPlusColBtn.style.left = (r.right - 11) + "px";
    selPlusColBtn.style.top = (r.top - 30) + "px";
  }
}

function insertAfterSelection(kind) {
  if (!editor || !selPlusInfo) return;
  var info = selPlusInfo;
  var cmdName = kind === "row" ? "insertTableRowBelow" : "insertTableColumnRight";
  if (!editor.commands.get(cmdName) || !editor.commands.get(cmdName).isEnabled) return;
  editor.execute(cmdName);
  if (kind === "col") rebalanceTableWidth(info.table);
  // Chọn trọn hàng/cột vừa chèn để thấy ngay chỗ mới và bấm "+" lần nữa thì chèn nối tiếp.
  try {
    var tu = editor.plugins.get("TableUtils");
    var at = (kind === "row" ? info.rows.last : info.cols.last) + 1;
    var picked = [];
    for (var slot of tu.createTableWalker(info.table, kind === "row" ? { row: at } : { column: at })) picked.push(slot.cell);
    if (picked.length) editor.plugins.get("TableSelection").setCellSelection(picked[0], picked[picked.length - 1]);
  } catch (e) { /* không chọn lại được thì giữ vùng chọn cũ */ }
  editor.editing.view.focus();
  readFormats();
  scheduleTablePlusUpdate();
}

function updateTablePlusPosition() {
  ensureTablePlusButtons();
  if (!editor || !hasActiveChapter() || state.noteLocked) { hideTablePlus(); hideSelPlus(); return; }
  updateSelPlus();
  var tableModel = findSelectionTableModelElement();
  if (!tableModel) { hideTablePlus(); return; }
  var viewEl = editor.editing.mapper.toViewElement(tableModel);
  var domNode = viewEl && editor.editing.view.domConverter.mapViewToDom(viewEl);
  var domTable = domNode && (domNode.tagName === "TABLE" ? domNode : domNode.querySelector("table"));
  if (!domTable) { hideTablePlus(); return; }
  var r = domTable.getBoundingClientRect();
  if (!r.width && !r.height) { hideTablePlus(); return; }
  tablePlusCurrentTable = tableModel;
  tablePlusColBtn.style.left = (r.right + 6) + "px";
  tablePlusColBtn.style.top = (r.top + r.height / 2 - 10) + "px";
  tablePlusColBtn.classList.add("show");
  tablePlusRowBtn.style.left = (r.left + r.width / 2 - 10) + "px";
  tablePlusRowBtn.style.top = (r.bottom + 6) + "px";
  tablePlusRowBtn.classList.add("show");
}

function scheduleTablePlusUpdate() {
  if (tablePlusRaf) return;
  tablePlusRaf = requestAnimationFrame(function () { tablePlusRaf = null; updateTablePlusPosition(); });
}

function addTableColumnQuick() {
  if (!editor || !tablePlusCurrentTable) return;
  try {
    var tableUtils = editor.plugins.get("TableUtils");
    tableUtils.insertColumns(tablePlusCurrentTable, { at: tableUtils.getColumns(tablePlusCurrentTable), columns: 1 });
  } catch (e) { console.warn("Không thêm được cột", e); }
  // Cân lại NGAY sau khi thêm — nếu không, cột mới sẽ mang chiều rộng mặc định riêng của
  // CKEditor (không bằng các cột cũ) và tổng có thể vượt/hụt 100%; gọi lại với số cột MỚI
  // (đã +1) để chia đều lại toàn bộ, kể cả khi bấm "+" nhiều lần liên tiếp.
  rebalanceTableWidth(tablePlusCurrentTable);
  editor.editing.view.focus();
  scheduleTablePlusUpdate();
}
function addTableRowQuick() {
  if (!editor || !tablePlusCurrentTable) return;
  try {
    var tableUtils = editor.plugins.get("TableUtils");
    tableUtils.insertRows(tablePlusCurrentTable, { at: tableUtils.getRows(tablePlusCurrentTable), rows: 1 });
  } catch (e) { console.warn("Không thêm được hàng", e); }
  // Số cột không đổi khi thêm hàng, nhưng vẫn cân lại để đảm bảo bảng luôn giữ đúng 100% chiều
  // rộng vùng soạn thảo (phòng trường hợp thuộc tính tableWidth bị mất do thao tác khác).
  rebalanceTableWidth(tablePlusCurrentTable);
  editor.editing.view.focus();
  scheduleTablePlusUpdate();
}

// Đợi CKEditor khởi tạo xong (initEditor() ở ghichu_soanthao.js tự poll tương tự) rồi mới gắn
// các sự kiện theo dõi vị trí bảng — editor chỉ được tạo 1 lần cho cả phiên nên chỉ cần gắn 1 lần.
function bindTablePlusTracking() {
  if (!editor) { setTimeout(bindTablePlusTracking, 150); return; }
  editor.editing.view.document.on("layoutChanged", scheduleTablePlusUpdate);
  editor.model.document.selection.on("change:range", scheduleTablePlusUpdate);
  editor.model.document.selection.on("change:range", syncTableTab);
  window.addEventListener("scroll", scheduleTablePlusUpdate, true);
  window.addEventListener("resize", scheduleTablePlusUpdate);
}

/* ---- Thao tác với bảng → ribbon ở thẻ Chèn ("Insert"), nút "Bảng" sáng. Chỉ chuyển thẻ lúc
   con trỏ / vùng chọn VỪA đi vào bảng (kể cả chọn nguyên bảng), do người dùng thao tác trong
   vùng soạn thảo (view đang focus — không chuyển khi mở Chương có sẵn bảng); đang ở trong bảng
   mà tự bấm sang thẻ khác (vd. Trang chủ để in đậm chữ trong ô) thì giữ nguyên lựa chọn đó. ---- */
var wasInsertCtx = null;   // "table" | "image" | null — đối tượng đang thao tác ở lần kiểm trước

function tableIsActive() {
  return !!editor && hasActiveChapter() && !state.noteLocked && selectedTableCells().length > 0 && selectionWithinOneTable();
}
// Vùng chọn nằm TRONG 1 bảng (con trỏ / ô bôi đen / chọn nguyên bảng). Vùng chọn chỉ CHỨA bảng (Ctrl+A, bôi đen vắt qua
// bảng) thì không tính — đổi sang thẻ Insert lúc đó sẽ giấu mất ô font / cỡ / màu người dùng vừa định dùng.
function selectionWithinOneTable() {
  var sel = editor.model.document.selection;
  var picked = sel.getSelectedElement();
  if (picked && picked.is("element", "table")) return true;
  var a = sel.getFirstPosition(), b = sel.getLastPosition();
  var ta = a && a.findAncestor("table"), tb = b && b.findAncestor("table");
  return !!ta && ta === tb;
}

function syncTableTab() {
  var now = tableIsActive() ? "table" : (imageIsActive() ? "image" : null);
  if (now !== wasInsertCtx) {
    if (now && editor.editing.view.document.isFocused && !state.dd && state.tab !== "Insert") hooks.setTab("Insert");
    else if (state.tab === "Insert") hooks.renderRibbon();   // cập nhật trạng thái sáng của nút "Bảng" / "Hình ảnh"
  }
  wasInsertCtx = now;
}

/* ====================================================================
   Ảnh trong trình soạn thảo (Insert ▸ Hình ảnh) — chọn 1 ảnh thì:
   • Di chuyển: kéo thẳng ảnh tới chỗ khác (kéo-thả widget có sẵn của
     CKEditor, có vạch báo chỗ thả; con trỏ chuột đổi thành dấu di chuyển),
     hoặc kéo nút ✥ ở góc trên-trái ảnh = VỊ TRÍ TỰ DO: thả ở đâu thì ảnh
     nằm ở đó — lên/xuống = đổi chỗ giữa các đoạn (vạch xanh báo chỗ),
     trái/phải = lệch tuỳ ý từ lề trái (thuộc tính model `imageOffset` →
     figure style margin-left, ghichu_soanthao.js); thả sát lề trái / giữa /
     lề phải thì tự hít về 3 kiểu căn có sẵn. Ảnh vẫn nằm trong luồng chữ
     (không đè lên chữ).
   • Kích thước: 4 tay nắm ở góc (CKEditor) giữ tỉ lệ; tay nắm GIỮA mép phải
     chỉ đổi chiều rộng, GIỮA mép dưới chỉ đổi chiều cao (code bên dưới);
     hoặc nhập Rộng × Cao (px) ở thanh dưới ảnh / menu ▾ của nút Hình ảnh,
     nút xích = giữ tỉ lệ, "↺" = về kích thước gốc.
   • Căn lề: trái / giữa / phải = kiểu ảnh khối alignBlockLeft / block /
     alignBlockRight của CKEditor — ảnh đứng riêng 1 dòng nên chữ xung
     quanh không bị chảy vòng hay tách đoạn.
   Ghi vào model qua thuộc tính có sẵn resizedWidth / resizedHeight (HTML:
   <figure class="image image_resized" style="width:…;height:…">), mỗi lần
   đổi = 1 bước Ctrl+Z. CSS ảnh co giãn theo chiều cao nằm ở
   ghichu_chucnangcacthe.css (+ xem.css cho trang xem công khai).
   ==================================================================== */
var IMG_ALIGNS = [
  ["alignBlockLeft", "Align Left", '<path d="M3 4h14M3 16h14"/><rect x="3" y="7" width="8" height="6" rx="1"/>'],
  ["block", "Center", '<path d="M3 4h14M3 16h14"/><rect x="6" y="7" width="8" height="6" rx="1"/>'],
  ["alignBlockRight", "Align Right", '<path d="M3 4h14M3 16h14"/><rect x="9" y="7" width="8" height="6" rx="1"/>'],
];
var IMG_MIN = 24, IMG_MAX_H = 4000;
var IMG_SNAP = 10;   // px CSS: thả cách lề trái / tâm / lề phải ít hơn mức này thì hít về kiểu căn tương ứng
var ICO_MOVE = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5"/></svg>';
var imgUi = { bar: null, edgeR: null, edgeB: null, mover: null, dropLine: null, ghost: null, raf: null, lock: true, drag: null, img: null };

function selectedImage() {
  if (!editor) return null;
  try { return editor.plugins.get("ImageUtils").getClosestSelectedImageElement(editor.model.document.selection); }
  catch (e) { return null; }
}
function imageIsActive() { return !!editor && hasActiveChapter() && !state.noteLocked && !editor.isReadOnly && !!selectedImage(); }

function imageImgDom(img) {
  var viewEl = editor.editing.mapper.toViewElement(img);
  var dom = viewEl && editor.editing.view.domConverter.mapViewToDom(viewEl);
  if (!dom) return null;
  return dom.tagName === "IMG" ? dom : dom.querySelector("img");
}
// Cỡ hiện tại theo px CSS (không phụ thuộc zoom) + tỉ lệ px CSS / px màn hình để đổi khi kéo.
function imageSize(img) {
  var d = img && imageImgDom(img);
  if (!d || !d.offsetWidth) return null;
  var r = d.getBoundingClientRect();
  return { w: Math.round(d.offsetWidth), h: Math.round(d.offsetHeight), rect: r, scale: d.offsetWidth / (r.width || d.offsetWidth) };
}
function imageMaxWidth() {
  var root = editor.editing.view.domConverter.mapViewToDom(editor.editing.view.document.getRoot());
  if (!root) return 2000;
  var cs = getComputedStyle(root);
  return Math.max(IMG_MIN, Math.floor(root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
}
function imageAlign(img) {
  if (img.hasAttribute("imageOffset")) return "free";
  var s = img.getAttribute("imageStyle");
  if (s === "alignBlockLeft" || s === "alignBlockRight") return s;
  return img.is("element", "imageBlock") ? "block" : null;
}
function imageNatural(img) {
  var d = imageImgDom(img);
  return d && d.naturalWidth ? { w: d.naturalWidth, h: d.naturalHeight } : null;
}

// h = null: bỏ chiều cao riêng → ảnh theo đúng tỉ lệ gốc ở chiều rộng mới.
function setImageSize(img, w, h) {
  if (!img) return;
  w = Math.max(IMG_MIN, Math.min(imageMaxWidth(), Math.round(w)));
  if (h != null) {
    h = Math.max(IMG_MIN, Math.min(IMG_MAX_H, Math.round(h)));
    // CKEditor đặt chiều cao lên cả <figure> (gồm dòng chú thích) — cộng phần chú thích để ẢNH đúng h px.
    var d = imageImgDom(img), fig = d && d.parentElement;
    if (fig && fig.tagName === "FIGURE") h += Math.max(0, Math.round(fig.offsetHeight - d.offsetHeight));
  }
  var off = parseFloat(img.getAttribute("imageOffset") || "0");
  editor.model.change(function (wr) {
    // Ảnh đặt tự do mà to ra quá lề phải → dịch sang trái cho vừa trang.
    if (off && off + w > imageMaxWidth()) wr.setAttribute("imageOffset", Math.max(0, imageMaxWidth() - w) + "px", img);
    wr.setAttribute("resizedWidth", w + "px", img);
    if (h == null) wr.removeAttribute("resizedHeight", img); else wr.setAttribute("resizedHeight", h + "px", img);
  });
  scheduleImageUi();
}
function resetImageSize(img) {
  if (!img) return;
  editor.model.change(function (wr) { wr.removeAttribute("resizedWidth", img); wr.removeAttribute("resizedHeight", img); });
  scheduleImageUi();
}
// Nhập 1 chiều: giữ tỉ lệ → chiều kia tính theo tỉ lệ ĐANG HIỆN (ảnh chưa bị kéo méo thì để trống chiều cao cho gọn);
// không giữ tỉ lệ → chiều kia giữ nguyên cỡ đang hiện.
function applyImageDim(img, dim, value) {
  var cur = imageSize(img);
  if (!img || !cur || !(value > 0)) return;
  var stretched = img.hasAttribute("resizedHeight");
  if (dim === "w") {
    if (imgUi.lock) setImageSize(img, value, stretched ? value * cur.h / cur.w : null);
    else setImageSize(img, value, cur.h);
  } else {
    if (imgUi.lock) setImageSize(img, value * cur.w / cur.h, stretched ? value : null);
    else setImageSize(img, cur.w, value);
  }
}
function setImageAlign(value) {
  var img = selectedImage();
  if (!img || !editor.commands.get("imageStyle")) return;
  if (value === "free") { setImageFreeHere(img); return; }
  editor.model.change(function (wr) {   // 1 bước hoàn tác: đổi kiểu căn + bỏ vị trí tự do
    editor.execute("imageStyle", { value: value });
    wr.removeAttribute("imageOffset", img);
  });
  scheduleImageUi();
}
function editableRootDom() {
  return editor.editing.view.domConverter.mapViewToDom(editor.editing.view.document.getRoot());
}
// Nút "Tự do": giữ nguyên chỗ ảnh đang đứng nhưng chuyển sang vị trí tự do (để kéo ✥ tiếp).
function setImageFreeHere(img) {
  var cur = imageSize(img), root = editableRootDom();
  if (!cur || !root) return;
  var x = Math.max(0, Math.round((cur.rect.left - root.getBoundingClientRect().left) * cur.scale));
  editor.model.change(function (wr) {
    wr.setAttribute("imageStyle", "alignBlockLeft", img);
    wr.setAttribute("imageOffset", Math.min(x, Math.max(0, imageMaxWidth() - cur.w)) + "px", img);
  });
  scheduleImageUiRebuild();
}
function toggleImageCaption() {
  if (editor.commands.get("toggleImageCaption")) editor.execute("toggleImageCaption", { focusCaptionOnShow: true });
  scheduleImageUi();
}

var ICO_LOCK = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8.5 11.5l3-3"/><path d="M7 9.5l-1.6 1.6a2.6 2.6 0 0 0 3.6 3.6L10.5 13"/><path d="M13 10.5l1.6-1.6a2.6 2.6 0 0 0-3.6-3.6L9.5 7"/></svg>';
var ICO_UNLOCK = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 9.5l-1.6 1.6a2.6 2.6 0 0 0 3.6 3.6L10.5 13"/><path d="M13 10.5l1.6-1.6a2.6 2.6 0 0 0-3.6-3.6L9.5 7"/><path d="M4 4l2 2M16 16l-2-2"/></svg>';

// Khối điều khiển dùng chung cho thanh dưới ảnh và menu ▾ của nút "Hình ảnh".
function imageControlsHtml(img, compact) {
  var cur = img ? imageSize(img) : null;
  var dis = img ? "" : " disabled";
  var align = img ? imageAlign(img) : null;
  var alignBtns = IMG_ALIGNS.map(function (a) {
    return '<button type="button" class="img-ctl-btn' + (align === a[0] ? " on" : "") + '" data-img-align="' + a[0] + '" title="' + a[1] + '" aria-label="' + a[1] + '"' + dis + ">" +
      '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' + a[2] + "</svg></button>";
  }).join("") +
    '<button type="button" class="img-ctl-btn' + (align === "free" ? " on" : "") + '" data-img-align="free" title="Free Position — drag the ✥ handle to place the picture anywhere" aria-label="Free Position"' + dis + ">" + ICO_MOVE + "</button>";
  var hasCap = img && editor.plugins.has("ImageCaptionUtils") && !!editor.plugins.get("ImageCaptionUtils").getCaptionFromImageModelElement(img);
  var sizeRow =
    '<label class="img-ctl-num"><span>Width</span><input type="number" min="' + IMG_MIN + '" step="1" data-img-dim="w" value="' + (cur ? cur.w : "") + '"' + dis + "></label>" +
    '<span class="img-ctl-x">×</span>' +
    '<label class="img-ctl-num"><span>Height</span><input type="number" min="' + IMG_MIN + '" step="1" data-img-dim="h" value="' + (cur ? cur.h : "") + '"' + dis + "></label>" +
    '<span class="img-ctl-unit">px</span>' +
    '<button type="button" class="img-ctl-btn' + (imgUi.lock ? " on" : "") + '" data-img-lock title="' + (imgUi.lock ? "Lock Aspect Ratio is on — click to change width and height separately" : "Lock Aspect Ratio is off — click to keep the proportions") + '"' + dis + ">" + (imgUi.lock ? ICO_LOCK : ICO_UNLOCK) + "</button>" +
    '<button type="button" class="img-ctl-btn img-ctl-txt" data-img-reset title="Reset Size"' + dis + ">↺</button>";
  if (compact) {
    return '<div class="img-ctl-group">' + alignBtns + '</div><span class="img-ctl-sep"></span>' +
      '<div class="img-ctl-group">' + sizeRow + '</div><span class="img-ctl-sep"></span>' +
      '<button type="button" class="img-ctl-btn img-ctl-txt' + (hasCap ? " on" : "") + '" data-img-caption title="Insert or remove the caption">Caption</button>';
  }
  return '<div class="dd-plain img-dd">' +
    '<button type="button" data-img-insert>Insert Picture From This Device…</button>' +
    '<div class="dd-label" style="margin-top:6px">Position</div><div class="img-ctl-group">' + alignBtns + "</div>" +
    '<div class="dd-label" style="margin-top:6px">Size</div><div class="img-ctl-group img-ctl-wrap">' + sizeRow + "</div>" +
    '<div class="dd-table-hint">' + (img
      ? "Drag the ✥ handle to place the picture anywhere (drop near a margin or the center to snap). Drag a corner square to resize proportionally, or the right / bottom edge bar to change width or height only."
      : "Click a picture in the note to change its position and size.") + "</div></div>";
}

function bindImageControls(root, onDone) {
  var img = selectedImage();
  root.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });   // giữ ảnh đang được chọn
  });
  root.querySelectorAll("[data-img-align]").forEach(function (b) {
    b.addEventListener("click", function (e) { e.stopPropagation(); setImageAlign(b.getAttribute("data-img-align")); onDone(); });
  });
  var lock = root.querySelector("[data-img-lock]");
  if (lock) lock.addEventListener("click", function (e) { e.stopPropagation(); imgUi.lock = !imgUi.lock; onDone(); });
  var reset = root.querySelector("[data-img-reset]");
  if (reset) reset.addEventListener("click", function (e) { e.stopPropagation(); resetImageSize(selectedImage()); onDone(); });
  var cap = root.querySelector("[data-img-caption]");
  if (cap) cap.addEventListener("click", function (e) { e.stopPropagation(); toggleImageCaption(); });
  var ins = root.querySelector("[data-img-insert]");
  if (ins) ins.addEventListener("click", function () { hooks.closeFloating(); triggerImagePicker(); });
  root.querySelectorAll("[data-img-dim]").forEach(function (inp) {
    var commit = function () {
      var target = selectedImage() || img;
      applyImageDim(target, inp.getAttribute("data-img-dim"), Number(inp.value));
      onDone();
    };
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    inp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); inp.removeEventListener("change", commit); commit(); editor.editing.view.focus(); }
      else if (e.key === "Escape") { e.preventDefault(); editor.editing.view.focus(); }
    });
    inp.addEventListener("change", commit);
  });
}

function ensureImageUi() {
  if (imgUi.bar) return;
  imgUi.bar = el("div", "img-bar");
  imgUi.bar.setAttribute("role", "toolbar"); imgUi.bar.setAttribute("aria-label", "Ảnh");
  document.body.appendChild(imgUi.bar);
  editor.ui.focusTracker.add(imgUi.bar);   // gõ số trong ô Rộng/Cao vẫn tính là đang ở trong trình soạn thảo
  var edge = function (cls, dim, title) {
    var h = el("div", "img-edge " + cls);
    h.title = title;
    h.addEventListener("pointerdown", function (e) { startEdgeDrag(e, dim); });
    document.body.appendChild(h);
    return h;
  };
  imgUi.edgeR = edge("img-edge-r", "w", "Drag to change the width");
  imgUi.edgeB = edge("img-edge-b", "h", "Drag to change the height");
  imgUi.ghost = el("div", "img-ghost");
  document.body.appendChild(imgUi.ghost);
  imgUi.mover = el("button", "img-move");
  imgUi.mover.type = "button";
  imgUi.mover.title = "Drag to place the picture anywhere";
  imgUi.mover.setAttribute("aria-label", "Move picture");
  imgUi.mover.innerHTML = ICO_MOVE;
  imgUi.mover.addEventListener("pointerdown", startMoveDrag);
  document.body.appendChild(imgUi.mover);
  imgUi.dropLine = el("div", "img-drop-line");
  document.body.appendChild(imgUi.dropLine);
}

function hideImageUi() {
  imgUi.img = null;
  if (!imgUi.bar) return;
  imgUi.bar.classList.remove("show"); imgUi.edgeR.classList.remove("show"); imgUi.edgeB.classList.remove("show");
  imgUi.mover.classList.remove("show");
}

function renderImageBar(img) {
  imgUi.bar.innerHTML = imageControlsHtml(img, true);
  bindImageControls(imgUi.bar, scheduleImageUiRebuild);
}

function updateImageUi() {
  if (!editor) return;
  ensureImageUi();
  if (imgUi.drag) return;
  var img = imageIsActive() ? selectedImage() : null;
  var cur = img ? imageSize(img) : null;
  var focused = editor.ui.focusTracker.isFocused;
  if (!img || !cur || !focused) { hideImageUi(); return; }
  var r = cur.rect;
  // Ảnh trôi ra ngoài khung soạn thảo (đang cuộn) thì ẩn thanh, tránh nổi đè lên ribbon.
  var host = document.querySelector(".editor-scroll, .editor-pane") || document.body;
  var hr = host.getBoundingClientRect();
  if (r.bottom < hr.top || r.top > hr.bottom) { hideImageUi(); return; }
  var bar = imgUi.bar;
  var active = bar.contains(document.activeElement);
  if (imgUi.img !== img || !bar.innerHTML || (imgUi.rebuild && !active)) { renderImageBar(img); imgUi.rebuild = false; }
  else {   // đang gõ trong 1 ô thì không dựng lại thanh (mất con trỏ) — chỉ cập nhật các ô khác
    bar.querySelectorAll("[data-img-dim]").forEach(function (inp) {
      if (inp !== document.activeElement) inp.value = inp.getAttribute("data-img-dim") === "w" ? cur.w : cur.h;
    });
    var align = imageAlign(img);
    bar.querySelectorAll("[data-img-align]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-img-align") === align); });
  }
  imgUi.img = img;
  bar.classList.add("show");
  var bw = bar.offsetWidth, bh = bar.offsetHeight;
  var x = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 8));
  var figDom = imageImgDom(img).parentElement;   // đặt dưới cả dòng chú thích, không che chữ chú thích
  var outerBottom = figDom && figDom.tagName === "FIGURE" ? figDom.getBoundingClientRect().bottom : r.bottom;
  var y = outerBottom + 10;
  if (y + bh > Math.min(window.innerHeight, hr.bottom) - 4) y = Math.max(hr.top + 4, r.top - bh - 10);   // hết chỗ dưới ảnh → đặt lên trên
  bar.style.left = x + "px"; bar.style.top = y + "px";
  imgUi.edgeR.style.left = (r.right - 5) + "px"; imgUi.edgeR.style.top = (r.top + r.height / 2 - 14) + "px";
  imgUi.edgeB.style.left = (r.left + r.width / 2 - 14) + "px"; imgUi.edgeB.style.top = (r.bottom - 5) + "px";
  imgUi.edgeR.classList.add("show"); imgUi.edgeB.classList.add("show");
  // ✥ chỉ cho ảnh nằm thẳng trong trang (không trong ô bảng / danh sách).
  var canFree = img.is("element", "imageBlock") && img.parent && img.parent.is("rootElement");
  imgUi.mover.classList.toggle("show", !!canFree);
  if (canFree) { imgUi.mover.style.left = (r.left + 6) + "px"; imgUi.mover.style.top = (r.top + 6) + "px"; }
}

/* ---- Kéo ✥: khung xem trước theo chuột + vạch xanh báo chỗ thả giữa các đoạn + nhãn kiểu căn / độ lệch. Thả = 1 bước
   hoàn tác (đổi chỗ khối + kiểu căn + imageOffset trong cùng 1 model.change). ---- */
function startMoveDrag(e) {
  var img = selectedImage();
  var cur = img && imageSize(img);
  var root = editableRootDom();
  if (!cur || !root) return;
  e.preventDefault();
  var handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* bỏ qua */ }
  var r = cur.rect, s = cur.scale || 1;
  var range = Math.max(0, imageMaxWidth() - cur.w);   // độ lệch lớn nhất (px CSS)
  var d = imgUi.drag = { img: img, kind: "move", dx: e.clientX - r.left, dy: e.clientY - r.top, ref: undefined, mode: null, off: 0 };
  document.body.classList.add("img-moving");
  imgUi.bar.classList.remove("show"); imgUi.edgeR.classList.remove("show"); imgUi.edgeB.classList.remove("show");
  var g = imgUi.ghost, line = imgUi.dropLine;
  g.classList.add("move");
  g.style.width = r.width + "px"; g.style.height = r.height + "px";
  var blocks = Array.from(img.parent.getChildren()).filter(function (c) { return c !== img; });
  var move = function (ev) {
    var rr = root.getBoundingClientRect();
    var left = Math.max(rr.left, Math.min(rr.left + range / s, ev.clientX - d.dx));
    var off = Math.round((left - rr.left) * s);
    if (off <= IMG_SNAP) { d.mode = "alignBlockLeft"; off = 0; }
    else if (Math.abs(off - range / 2) <= IMG_SNAP) { d.mode = "block"; off = Math.round(range / 2); }
    else if (off >= range - IMG_SNAP) { d.mode = "alignBlockRight"; off = range; }
    else d.mode = "free";
    d.off = off;
    // Chỗ thả theo chiều dọc: trước khối đầu tiên có tâm nằm dưới con trỏ, không có thì cuối trang.
    var ref = null, lineY = null;
    for (var i = 0; i < blocks.length; i++) {
      var dom = editor.editing.view.domConverter.mapViewToDom(editor.editing.mapper.toViewElement(blocks[i]));
      if (!dom) continue;
      var br = dom.getBoundingClientRect();
      if (ev.clientY < br.top + br.height / 2) { ref = blocks[i]; lineY = br.top - 4; break; }
      lineY = br.bottom + 4;
    }
    if (lineY === null) lineY = rr.top;
    d.ref = ref;
    g.style.left = (rr.left + off / s) + "px";
    g.style.top = (ev.clientY - d.dy) + "px";
    g.setAttribute("data-size", d.mode === "alignBlockLeft" ? "Align Left" : d.mode === "block" ? "Center" : d.mode === "alignBlockRight" ? "Align Right" : off + " px from left margin");
    g.classList.add("show");
    line.style.left = rr.left + "px"; line.style.width = rr.width + "px"; line.style.top = (lineY - 1) + "px";
    line.classList.add("show");
  };
  move(e);
  var up = function () {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("img-moving");
    g.classList.remove("show", "move"); line.classList.remove("show");
    imgUi.drag = null;
    editor.model.change(function (wr) {
      if (d.ref !== undefined && d.ref !== img.nextSibling) {
        wr.move(wr.createRangeOn(img), d.ref ? wr.createPositionBefore(d.ref) : wr.createPositionAt(img.parent, "end"));
      }
      if (d.mode === "block") wr.removeAttribute("imageStyle", img);
      else wr.setAttribute("imageStyle", d.mode === "alignBlockRight" ? "alignBlockRight" : "alignBlockLeft", img);
      if (d.mode === "free") wr.setAttribute("imageOffset", d.off + "px", img); else wr.removeAttribute("imageOffset", img);
      wr.setSelection(img, "on");
    });
    editor.editing.view.focus();
    scheduleImageUiRebuild();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function scheduleImageUi() {
  if (imgUi.raf) return;
  imgUi.raf = requestAnimationFrame(function () { imgUi.raf = null; updateImageUi(); });
}
function scheduleImageUiRebuild() { imgUi.rebuild = true; scheduleImageUi(); }

// Kéo tay nắm giữa mép phải / mép dưới: khung xem trước nét đứt + nhãn "R × C", thả chuột mới ghi vào model (1 bước hoàn tác).
function startEdgeDrag(e, dim) {
  var img = selectedImage();
  var cur = img && imageSize(img);
  if (!cur) return;
  e.preventDefault();
  var handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* bỏ qua */ }
  var maxW = imageMaxWidth();
  imgUi.drag = { img: img, dim: dim, x: e.clientX, y: e.clientY, cur: cur, w: cur.w, h: cur.h };
  document.body.classList.add(dim === "w" ? "img-resizing-w" : "img-resizing-h");
  imgUi.bar.classList.remove("show");
  var g = imgUi.ghost;
  var paint = function () {
    var d = imgUi.drag, s = d.cur.scale || 1;
    g.style.left = d.cur.rect.left + "px"; g.style.top = d.cur.rect.top + "px";
    g.style.width = (d.w / s) + "px"; g.style.height = (d.h / s) + "px";
    g.setAttribute("data-size", d.w + " × " + d.h);
    g.classList.add("show");
    if (dim === "w") handle.style.left = (d.cur.rect.left + d.w / s - 5) + "px";
    else handle.style.top = (d.cur.rect.top + d.h / s - 5) + "px";
  };
  paint();
  var move = function (ev) {
    var d = imgUi.drag, s = d.cur.scale || 1;
    if (dim === "w") d.w = Math.round(Math.max(IMG_MIN, Math.min(maxW, d.cur.w + (ev.clientX - d.x) * s)));
    else d.h = Math.round(Math.max(IMG_MIN, Math.min(IMG_MAX_H, d.cur.h + (ev.clientY - d.y) * s)));
    paint();
  };
  var up = function () {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("img-resizing-w", "img-resizing-h");
    g.classList.remove("show");
    var d = imgUi.drag;
    imgUi.drag = null;
    if (d.w !== d.cur.w || d.h !== d.cur.h) setImageSize(d.img, d.w, d.h);
    editor.editing.view.focus();
    scheduleImageUiRebuild();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function bindImageTracking() {
  if (!editor) { setTimeout(bindImageTracking, 150); return; }
  editor.model.document.selection.on("change:range", scheduleImageUiRebuild);
  editor.model.document.on("change:data", scheduleImageUi);
  editor.editing.view.document.on("layoutChanged", scheduleImageUi);
  editor.ui.focusTracker.on("change:isFocused", scheduleImageUi);
  editor.on("change:isReadOnly", scheduleImageUi);
  window.addEventListener("scroll", scheduleImageUi, true);
  window.addEventListener("resize", scheduleImageUi);
  // Ảnh mới chèn (base64) có kích thước thật sau khi tải xong → vẽ lại thanh cho đúng vị trí / số.
  document.addEventListener("load", function (e) { if (e.target && e.target.tagName === "IMG") scheduleImageUi(); }, true);
}
bindImageTracking();

function buildImageDropdown() {
  var img = imageIsActive() ? selectedImage() : null;
  return {
    html: imageControlsHtml(img, false),
    bind: function (panel) {
      bindImageControls(panel, function () {
        // Cập nhật lại menu tại chỗ (giữ menu mở) để thấy ngay kiểu căn / cỡ mới.
        requestAnimationFrame(function () {
          if (!state.dd || state.dd.id !== "image") return;
          var dd = buildImageDropdown();
          panel.innerHTML = dd.html; dd.bind(panel);
        });
      });
    },
  };
}

/* ====================================================================
   Liên kết (Insert ▸ Liên kết, Ctrl+K) — giống Word nhưng gọn hơn:
   • Hộp thoại "Chèn liên kết" / "Sửa liên kết": Văn bản hiển thị + Địa chỉ
     (URL). Bôi đen chữ rồi mở → chữ đó thành liên kết (sửa ô Văn bản thì
     thay chữ); con trỏ đứng trong 1 liên kết → sửa cả liên kết đó; không bôi
     đen gì → chèn chữ mới tại con trỏ. Nút "Gỡ liên kết" (giữ nguyên chữ).
   • Đặt con trỏ / bấm vào 1 liên kết → ô nhỏ dưới liên kết: địa chỉ (bấm =
     mở tab mới), Sửa, Sao chép, Gỡ. Ctrl+bấm vào liên kết = mở luôn (của
     LinkEditing — CKEditor); ghi chú chỉ xem / đã khoá thì bấm thường là mở.
   Ghi vào thuộc tính model `linkHref` (LinkEditing; khung nổi tiếng Anh
   LinkUI đã bỏ ở ckConfig()), mỗi lần lưu = 1 bước Ctrl+Z. Liên kết ra
   ngoài tự có target="_blank" (link.addTargetToExternalLinks).
   ==================================================================== */
var linkUi = { pop: null, raf: null, ctx: null };

// Chuẩn hoá địa chỉ người dùng gõ: "vnexpress.net" → https://…, "a@b.com" → mailto:…; chặn javascript:/data: → null.
export function normalizeLinkUrl(raw) {
  var v = String(raw || "").trim();
  if (!v) return null;
  if (/^(javascript|data|vbscript|file):/i.test(v)) return null;
  if (/^(https?|mailto|tel|ftp):/i.test(v)) {
    if (/^https?:/i.test(v)) { try { var u = new URL(v); if (!u.hostname || u.hostname.indexOf(".") < 0 && u.hostname !== "localhost") return null; } catch (e) { return null; } }
    return v;
  }
  if (/^#/.test(v) || /^\//.test(v)) return v;
  if (/^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(v)) return "mailto:" + v;
  if (/^\+?[\d\s.-]{6,}$/.test(v)) return "tel:" + v.replace(/[\s.-]/g, "");
  if (/^[^\s]+\.[a-z]{2,}([/:?#].*)?$/i.test(v) || /^localhost(:\d+)?([/?#].*)?$/i.test(v)) {
    try { new URL("https://" + v); return "https://" + v; } catch (e) { return null; }
  }
  return null;
}

// Vùng chữ của liên kết chứa vị trí pos (các nút chữ liền nhau cùng linkHref).
function linkRangeAt(pos) {
  var href = pos.textNode ? pos.textNode.getAttribute("linkHref")
    : ((pos.nodeBefore && pos.nodeBefore.getAttribute && pos.nodeBefore.getAttribute("linkHref")) || (pos.nodeAfter && pos.nodeAfter.getAttribute && pos.nodeAfter.getAttribute("linkHref")));
  if (!href) return null;
  var parent = pos.parent, kids = Array.from(parent.getChildren()), idx = -1;
  var node = pos.textNode || (pos.nodeBefore && pos.nodeBefore.getAttribute && pos.nodeBefore.getAttribute("linkHref") === href ? pos.nodeBefore : pos.nodeAfter);
  idx = kids.indexOf(node);
  if (idx < 0) return null;
  var a = idx, b = idx;
  while (a > 0 && kids[a - 1].is("$text") && kids[a - 1].getAttribute("linkHref") === href) a--;
  while (b < kids.length - 1 && kids[b + 1].is("$text") && kids[b + 1].getAttribute("linkHref") === href) b++;
  return { href: href, range: editor.model.createRange(editor.model.createPositionBefore(kids[a]), editor.model.createPositionAfter(kids[b])) };
}

function rangeText(range) {
  var out = "", plain = range.start.parent === range.end.parent;
  for (var item of range.getItems()) {
    if (item.is("$textProxy")) out += item.data; else plain = false;
  }
  return { text: out, plain: plain };
}

// Ngữ cảnh lúc mở hộp thoại: {mode:"edit"|"wrap"|"insert", range, href, text, textEditable}
function linkContext() {
  var sel = editor.model.document.selection;
  var pos = sel.getFirstPosition();
  if (sel.isCollapsed) {
    var lr = linkRangeAt(pos);
    if (lr) { var t = rangeText(lr.range); return { mode: "edit", range: lr.range, href: lr.href, text: t.text, textEditable: t.plain }; }
    return { mode: "insert", range: null, href: "", text: "", textEditable: true };
  }
  var range = sel.getFirstRange();
  // Vùng bôi đen nằm trọn trong 1 liên kết → coi như sửa liên kết đó.
  var startLink = range.start.parent === range.end.parent ? linkRangeAt(range.start) : null, href = "";
  for (var item of range.getItems()) { if (item.is("$textProxy") && item.getAttribute("linkHref")) { href = item.getAttribute("linkHref"); break; } }
  if (startLink && startLink.range.containsRange(range, true) && rangeText(range).text === rangeText(startLink.range).text) {
    var tt = rangeText(startLink.range);
    return { mode: "edit", range: startLink.range, href: startLink.href, text: tt.text, textEditable: tt.plain };
  }
  var r = rangeText(range);
  return { mode: "wrap", range: range, href: href, text: r.text, textEditable: r.plain && r.text.length > 0 };
}

function applyLink(ctx, url, text) {
  editor.model.change(function (wr) {
    var root = editor.model.document;
    if (ctx.mode === "insert") {
      var attrs = Object.fromEntries(root.selection.getAttributes());
      attrs.linkHref = url;
      editor.model.insertContent(wr.createText(text || url, attrs));   // con trỏ tự đứng sau chữ vừa chèn
      wr.removeSelectionAttribute("linkHref");
      return;
    }
    var range = ctx.range;
    if (ctx.textEditable && text && text !== ctx.text) {
      var first = null;
      for (var it of range.getItems()) { if (it.is("$textProxy")) { first = it; break; } }
      var a = first ? Object.fromEntries(first.getAttributes()) : {};
      a.linkHref = url;
      var start = range.start.offset, parent = range.start.parent;
      wr.remove(range);
      wr.insertText(text, a, wr.createPositionAt(parent, start));
      wr.setSelection(wr.createPositionAt(parent, start + text.length));
    } else {
      // Bôi đen nhiều đoạn / có ảnh: chỉ gắn địa chỉ cho phần chữ, không đụng nội dung.
      var ranges = editor.model.schema.getValidRanges([range], "linkHref");
      for (var rg of ranges) wr.setAttribute("linkHref", url, rg);
      wr.setSelection(range.end);
    }
    wr.removeSelectionAttribute("linkHref");
  });
}

function removeLink(ctx) {
  if (!ctx || !ctx.range) return;
  editor.model.change(function (wr) {
    var ranges = editor.model.schema.getValidRanges([ctx.range], "linkHref");
    for (var rg of ranges) wr.removeAttribute("linkHref", rg);
    wr.removeSelectionAttribute("linkHref");
  });
}

var linkModalBuilt = false;
function ensureLinkModal() {
  if (linkModalBuilt) return;
  linkModalBuilt = true;
  var overlay = el("div", "modal-overlay");
  overlay.id = "link-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="modal link-modal" role="dialog" aria-modal="true" aria-labelledby="link-title">' +
      '<div class="modal-head"><span class="modal-title" id="link-title">Insert Link</span>' +
        '<button type="button" class="icon-btn-sm" id="link-close" title="Close">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>' +
        "</button></div>" +
      '<div class="link-body">' +
        '<label class="link-field"><span>Text to display</span><input type="text" id="link-text" autocomplete="off" placeholder="Text shown in the note"></label>' +
        '<div class="link-note" id="link-text-note" hidden>The selection spans several paragraphs or contains a picture — the content stays as is, only the link is added.</div>' +
        '<label class="link-field"><span>Address</span><input type="text" id="link-url" autocomplete="off" spellcheck="false" placeholder="e.g. https://en.wikipedia.org"></label>' +
        '<div class="link-err" id="link-err" hidden></div>' +
        '<div class="link-hint">You can type "wikipedia.org", an email address or a phone number. In the note: click a link to view or edit it, Ctrl + click to open it.</div>' +
      "</div>" +
      '<div class="modal-foot"><button type="button" class="btn-plain link-remove" id="link-remove">Remove Link</button>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="btn-plain" id="link-cancel">Cancel</button>' +
        '<button type="button" class="btn-solid" id="link-ok">Insert</button></div>' +
    "</div>";
  document.body.appendChild(overlay);
  var close = function () { overlay.hidden = true; if (editor) editor.editing.view.focus(); };
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  $("link-close").addEventListener("click", close);
  $("link-cancel").addEventListener("click", close);
  var submit = function () {
    var ctx = linkUi.ctx;
    var url = normalizeLinkUrl($("link-url").value);
    var err = $("link-err");
    if (!url) {
      err.textContent = $("link-url").value.trim() ? "This address is not valid — for example: https://en.wikipedia.org or en.wikipedia.org" : "Enter a link address.";
      err.hidden = false; $("link-url").classList.add("bad"); $("link-url").focus();
      return;
    }
    var text = $("link-text").value.trim();
    overlay.hidden = true;
    editor.editing.view.focus();
    applyLink(ctx, url, ctx.textEditable ? text : null);
    scheduleLinkPop();
  };
  $("link-ok").addEventListener("click", submit);
  $("link-remove").addEventListener("click", function () { overlay.hidden = true; editor.editing.view.focus(); removeLink(linkUi.ctx); scheduleLinkPop(); });
  [$("link-text"), $("link-url")].forEach(function (inp) {
    inp.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
  });
  $("link-url").addEventListener("input", function () { $("link-err").hidden = true; $("link-url").classList.remove("bad"); });
}

export function openLinkDialog() {
  if (!editor || !hasActiveChapter() || state.noteLocked || editor.isReadOnly) return;
  hooks.closeFloating();
  ensureLinkModal();
  var ctx = linkUi.ctx = linkContext();
  $("link-title").textContent = ctx.mode === "edit" ? "Edit Link" : "Insert Link";
  $("link-ok").textContent = ctx.mode === "edit" ? "Save" : "Insert";
  $("link-remove").hidden = !(ctx.mode === "edit" || (ctx.mode === "wrap" && ctx.href));
  var t = $("link-text");
  t.value = ctx.text; t.disabled = !ctx.textEditable && ctx.mode !== "insert";
  $("link-text-note").hidden = !t.disabled;
  $("link-url").value = ctx.href || "";
  $("link-url").classList.remove("bad");
  $("link-err").hidden = true;
  hideLinkPop();
  $("link-overlay").hidden = false;
  // Đã có chữ → con trỏ vào ô địa chỉ; chưa có chữ → ô văn bản trước.
  setTimeout(function () {
    if (ctx.text || t.disabled) { $("link-url").focus(); $("link-url").select(); } else t.focus();
  }, 0);
}

/* ---- Ô nhỏ dưới liên kết đang đứng (con trỏ trong liên kết, đang soạn thảo) ---- */
var ICO_EXT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
function ensureLinkPop() {
  if (linkUi.pop) return;
  var pop = linkUi.pop = el("div", "link-pop");
  pop.setAttribute("role", "toolbar"); pop.setAttribute("aria-label", "Link");
  document.body.appendChild(pop);
  editor.ui.focusTracker.add(pop);
  pop.addEventListener("mousedown", function (e) { if (!e.target.closest("a")) e.preventDefault(); });
}
function hideLinkPop() { if (linkUi.pop) linkUi.pop.classList.remove("show"); }

function updateLinkPop() {
  if (!editor) return;
  ensureLinkPop();
  var sel = editor.model.document.selection;
  var dialogOpen = $("link-overlay") && !$("link-overlay").hidden;
  var on = hasActiveChapter() && !state.noteLocked && !editor.isReadOnly && !dialogOpen &&
    editor.ui.focusTracker.isFocused && sel.isCollapsed && sel.hasAttribute("linkHref");
  var lr = on ? linkRangeAt(sel.getFirstPosition()) : null;
  if (!lr) { hideLinkPop(); return; }
  // Lấy khung của thẻ <a> chứa con trỏ trong DOM.
  var vpos = editor.editing.view.document.selection.getFirstPosition();
  var va = vpos && vpos.getAncestors().reverse().find(function (n) { return n.is("attributeElement") && n.name === "a"; });
  var dom = va && editor.editing.view.domConverter.mapViewToDom(va);
  if (!dom) { hideLinkPop(); return; }
  var r = dom.getBoundingClientRect();
  var pop = linkUi.pop;
  if (pop.getAttribute("data-href") !== lr.href) {
    pop.setAttribute("data-href", lr.href);
    pop.innerHTML =
      '<a class="link-pop-url" href="' + esc(lr.href) + '" target="_blank" rel="noopener noreferrer" title="Open ' + esc(lr.href) + ' in a new tab">' + ICO_EXT + "<span>" + esc(lr.href) + "</span></a>" +
      '<span class="img-ctl-sep"></span>' +
      '<button type="button" class="img-ctl-btn img-ctl-txt" data-link="edit" title="Edit Link (Ctrl+K)">Edit</button>' +
      '<button type="button" class="img-ctl-btn img-ctl-txt" data-link="copy" title="Copy Link">Copy</button>' +
      '<button type="button" class="img-ctl-btn img-ctl-txt link-pop-del" data-link="remove" title="Remove Link (keeps the text)">Remove</button>';
    pop.querySelector('[data-link="edit"]').addEventListener("click", function () { openLinkDialog(); });
    pop.querySelector('[data-link="remove"]').addEventListener("click", function () {
      var cur = linkRangeAt(editor.model.document.selection.getFirstPosition());
      if (cur) removeLink({ range: cur.range });
      scheduleLinkPop();
    });
    pop.querySelector('[data-link="copy"]').addEventListener("click", function (e) {
      var b = e.currentTarget, href = pop.getAttribute("data-href");
      var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(href).then(done, done); else done();
    });
  }
  pop.classList.add("show");
  var w = pop.offsetWidth, h = pop.offsetHeight;
  var x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  var y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = r.top - h - 6;
  pop.style.left = x + "px"; pop.style.top = y + "px";
}
function scheduleLinkPop() {
  if (linkUi.raf) return;
  linkUi.raf = requestAnimationFrame(function () { linkUi.raf = null; updateLinkPop(); });
}

function bindLinkTracking() {
  if (!editor) { setTimeout(bindLinkTracking, 150); return; }
  editor.model.document.selection.on("change:range", scheduleLinkPop);
  editor.model.document.selection.on("change:attribute", scheduleLinkPop);
  editor.model.document.on("change:data", scheduleLinkPop);
  editor.ui.focusTracker.on("change:isFocused", scheduleLinkPop);
  editor.editing.view.document.on("layoutChanged", scheduleLinkPop);
  window.addEventListener("scroll", scheduleLinkPop, true);
  window.addEventListener("resize", scheduleLinkPop);
  // Ctrl+A: chọn TOÀN BỘ ghi chú như Word. Mặc định CKEditor đứng trong ô bảng / chú thích ảnh chỉ chọn nội dung ô đó (phải
  // bấm lần nữa mới lan ra) → đổi font / cỡ / màu sau Ctrl+A bỏ sót phần còn lại.
  editor.keystrokes.set("Ctrl+A", function (data, cancel) {
    var root = editor.model.document.getRoot();
    editor.model.change(function (wr) { wr.setSelection(root, "in"); });
    cancel();
  }, { priority: "high" });
  // Ctrl+K: mở hộp thoại tiếng Việt (thay khung nổi của CKEditor đã bỏ).
  editor.keystrokes.set("Ctrl+K", function (data, cancel) { openLinkDialog(); cancel(); }, { priority: "high" });
  // Ribbon: nút "Liên kết" sáng khi con trỏ đứng trong liên kết.
  var wasIn = false;
  editor.model.document.selection.on("change:attribute", function () {
    var now = editor.model.document.selection.hasAttribute("linkHref");
    if (now !== wasIn && state.tab === "Insert") hooks.renderRibbon();
    wasIn = now;
  });
  // Mở liên kết: đang soạn thì Ctrl (Mac: Cmd) + bấm như Word; ghi chú chỉ xem / đã khoá thì bấm thường. Bắt ở pha capture và
  // chặn lan tiếp — đo thật: Ctrl+bấm của LinkEditing (CKEditor 41) không mở được tab, và để 2 nơi cùng xử lý sẽ mở 2 tab.
  var editable = editor.ui.getEditableElement();
  if (editable) editable.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !(editor.isReadOnly || e.ctrlKey || e.metaKey)) return;
    var url = normalizeLinkUrl(a.getAttribute("href"));
    e.preventDefault(); e.stopPropagation();
    if (url) window.open(url, "_blank", "noopener");
  }, true);
}
bindLinkTracking();

export function buildInsertTab(wrap) {
  // Dựng lại menu mỗi lần mở (mũi tên ▾) để mục Xoá nội dung / Căn lề đúng trạng thái con trỏ lúc đó.
  var tableDd = null;
  var tableBtn = btnTextDropdown('<svg width="18" height="18" viewBox="0 0 18 18" style="display:block"><rect x="1.5" y="1.5" width="15" height="15" fill="#fff" stroke="#6b7385" stroke-width="1"/><rect x="2" y="2" width="14" height="3.6" fill="#a9c7ec"/><path d="M1.5 5.6h15M1.5 9.3h15M1.5 13h15M6.5 1.5v15M11.5 1.5v15" stroke="#6b7385" stroke-width="1"/></svg>', "Table", function (e) { openTableDropdownAt(e.currentTarget); }, !hasActiveChapter(), "table", TABLE_DD_WIDTH,
    function () { tableDd = buildTableDropdown(); return tableDd.html; }, function (panel) { tableDd.bind(panel); });
  if (tableIsActive()) tableBtn.firstChild.classList.add("on");   // đang thao tác trong bảng
  var imageDd = null;
  var imageBtn = btnTextDropdown('<svg width="18" height="18" viewBox="0 0 18 18" style="display:block"><rect x="1.5" y="2.5" width="15" height="13" fill="#fff" stroke="#6b7385" stroke-width="1"/><path d="M2 15l4.6-5.2 3.3 3.4 2-2L16 15z" fill="#a9c7ec" stroke="#2b6cb0" stroke-width="1" stroke-linejoin="round"/><circle cx="12.4" cy="6.3" r="1.4" fill="#f0a030"/></svg>', "Pictures", triggerImagePicker, !hasActiveChapter(), "image", 264,
    function () { imageDd = buildImageDropdown(); return imageDd.html; }, function (panel) { imageDd.bind(panel); });
  if (imageIsActive()) imageBtn.firstChild.classList.add("on");   // đang chọn 1 ảnh
  var linkBtn = btnText("🔗", "Link", function () { openLinkDialog(); }, !hasActiveChapter() || state.noteLocked);
  linkBtn.title = "Insert Link (Ctrl+K)";
  if (editor && editor.model.document.selection.hasAttribute("linkHref")) linkBtn.classList.add("on");
  wrap.appendChild(buildGroup([
    tableBtn,
    imageBtn,
    linkBtn,
  ]));
  wrap.appendChild(buildGroup([
    btnText("❝", "Quote", exec("blockQuote"), !hasActiveChapter()),
    btnText("⌘", "Code Block", exec("codeBlock"), !hasActiveChapter()),
    btnText("—", "Horizontal Line", exec("insertHorizontalRule"), !hasActiveChapter()),
  ]));
}

/* ====================================================================
   Tab Draw — vẽ TRỰC TIẾP trên trang (không còn hộp thoại vẽ riêng / chèn ảnh): bộ bút kiểu Word, Hình khối, Nền trang
   — toàn bộ ở ghichu_ve.js; lớp vẽ của Chương / từng trang PDF do ghichu_soanthao.js gắn. Đang xem PDF thì thêm nút
   "Hộp văn bản" (công cụ chú thích PDF cũ) và không có Nền trang.
   ==================================================================== */
export function leaveDrawTab() { Ve.leaveDraw(); }
export function buildDrawTab(wrap) {
  var isPdf = pdfViewer.open;
  Ve.buildDrawRibbon(wrap, {
    enabled: isPdf ? !!pdfViewer.pdfDoc : hasActiveChapter(),
    readOnly: isPdf ? false : chapterDrawReadOnlyNow(),
    bg: null,   // Rule Lines (nền trang) đã chuyển sang thẻ View
    extras: isPdf ? buildPdfDrawExtras() : [],
  });
}

/* ====================================================================
   Tab History — hoàn tác / làm lại
   ==================================================================== */
export function buildHistoryTab(wrap) {
  wrap.appendChild(buildGroup([
    btnText("↩", "Undo", exec("undo"), !hasActiveChapter()),
    btnText("↪", "Redo", exec("redo"), !hasActiveChapter()),
  ]));
}

/* ====================================================================
   Tab Review — kiểm tra chính tả / khoá ghi chú (hành vi thật — bật/tắt
   spellcheck của trình duyệt, khoá editor — thuộc ghichu_soanthao.js vì
   đụng trực tiếp tới editor/DOM ck-host; ghichu.js truyền 2 hàm đó vào đây
   để module này chỉ lo dựng UI nút bấm của tab).
   ==================================================================== */
export function buildReviewTab(wrap, toggleSpellcheck, toggleNoteLock) {
  wrap.appendChild(buildGroup([
    btnText("🔤", state.spellcheckOn ? "Spelling: On" : "Spelling", toggleSpellcheck, !hasActiveChapter()),
    btnText(state.noteLocked ? "🔓" : "🔒", state.noteLocked ? "Unlock Note" : "Lock Note", toggleNoteLock, !hasActiveChapter()),
  ]));
  // Translate (theo Word) + Password (theo OneNote) — ghichu_review.js
  wrap.appendChild(buildGroup(Review.reviewButtons(btnTextDropdown, btnText)));
}

/* ====================================================================
   Tab View — thu gọn Notebooks / toàn màn hình
   ==================================================================== */
var sidebarManualHidden = false;
export function sidebarHidden() { return sidebarManualHidden; }
function toggleSidebar() {
  sidebarManualHidden = !sidebarManualHidden;
  $("sidebar").hidden = sidebarManualHidden;
  hooks.renderRibbon();
}
function toggleFullscreen() {
  if (!document.fullscreenElement) $("app").requestFullscreen ? $("app").requestFullscreen() : null;
  else document.exitFullscreen && document.exitFullscreen();
}
// Thẻ View (theo Word): Zoom: [100% ▾] · Zoom In · Zoom Out · 100% | Rule Lines ▾ · Page Color ▾ | Notebooks · Full Screen.
// Zoom áp cho Chương (zoom trang soạn thảo) hoặc File PDF đang mở; Rule Lines + Page Color chỉ cho Chương (lưu cùng nét vẽ).
var ICO_ZOOM_IN = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="6.5"/><path d="M14 14l6 6M6 9h6M9 6v6"/></svg>';
var ICO_ZOOM_OUT = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="6.5"/><path d="M14 14l6 6M6 9h6"/></svg>';
var ICO_PAGE100 = '<svg width="18" height="22" viewBox="0 0 18 22" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="1.5" width="14" height="19" rx="1"/><path d="M5 6h8M5 9.5h8M5 13h8M5 16.5h5" stroke-linecap="round"/></svg>';
var ICO_PAGECOLOR = '<svg width="24" height="22" viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 9l6-6 7 7-6 6z"/><path d="M7.5 5.5L5 3"/><path d="M19 12.5c0 1.2-.9 2-1.6 2s-1.6-.8-1.6-2c0-1 1.6-3 1.6-3s1.6 2 1.6 3z" fill="currentColor" stroke="none"/><rect x="2" y="17.5" width="20" height="3" rx=".6" class="vz-pc-bar" stroke="none"/></svg>';
var VZ_CHEV = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
var PAGE_COLORS = [
  ["#ffffff", "White"], ["#f2f2f2", "Light Gray"], ["#fdf6e3", "Cream"], ["#fff8dc", "Light Yellow"], ["#fff2cc", "Pale Gold"],
  ["#fde9d9", "Light Orange"], ["#fce4ec", "Light Pink"], ["#f3e5f5", "Lavender"], ["#e8eaf6", "Light Indigo"], ["#deebf7", "Light Blue"],
  ["#e0f7fa", "Light Cyan"], ["#e2f0d9", "Light Green"], ["#edf7e1", "Mint"], ["#efebe9", "Light Brown"], ["#fafafa", "Snow"],
];
function vzBtn(icon, label, title, onClick, disabled) {
  var b = el("button", "vz-btn", icon + (label ? '<span>' + esc(label) + "</span>" : ""));
  b.type = "button"; b.title = title; b.disabled = !!disabled;
  b.addEventListener("click", onClick);
  return b;
}
function buildZoomGroup() {
  var target = viewZoomTarget(), dis = !target, cur = viewZoomValue();
  var box = el("div", "vz-zoom");
  box.appendChild(el("span", "vz-zoom-label", "Zoom:"));
  var sel = el("select", "vz-zoom-select");
  sel.title = "Zoom — " + (target === "pdf" ? "PDF file" : "page");
  sel.disabled = dis;
  var steps = VIEW_ZOOM_STEPS.slice();
  if (!dis && steps.every(function (s) { return Math.abs(s - cur) > 0.001; })) steps.push(cur);   // tỉ lệ "vừa khung" của PDF
  steps.sort(function (a, b) { return a - b; }).forEach(function (s) {
    var o = document.createElement("option");
    o.value = String(s); o.textContent = Math.round(s * 100) + "%";
    if (Math.abs(s - cur) < 0.001) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", function () { setViewZoom(Number(sel.value)); });
  box.appendChild(sel);
  var atMin = cur <= VIEW_ZOOM_STEPS[0] + 0.001, atMax = target === "pdf" ? cur >= 2.999 : cur >= VIEW_ZOOM_STEPS[VIEW_ZOOM_STEPS.length - 1] - 0.001;
  return [box,
    vzBtn(ICO_ZOOM_IN, "", "Zoom In", function () { stepViewZoom(1); }, dis || atMax),
    vzBtn(ICO_ZOOM_OUT, "", "Zoom Out", function () { stepViewZoom(-1); }, dis || atMin),
    vzBtn(ICO_PAGE100, "100%", "100% — zoom the page to 100% of its normal size", function () { stepViewZoom(0); }, dis)];
}
function pageColorMenuHtml(cur) {
  return '<div class="dv-menu vz-pc-menu"><div class="dv-menu-title">Page Color</div><div class="vz-pc-grid">' +
    PAGE_COLORS.map(function (c) {
      return '<button type="button" class="vz-pc-sw' + (cur && cur.toLowerCase() === c[0] ? " on" : "") + '" data-pc="' + c[0] + '" title="' + c[1] + '" style="background:' + c[0] + '"></button>';
    }).join("") + "</div>" +
    '<button type="button" class="dv-menu-row" data-pc="none"><span class="dv-check">' + (cur ? "" : "✓") + "</span>No Color</button>" +
    '<label class="dv-menu-row vz-pc-more"><span class="dv-check"></span>More Colors…<input type="color" value="' + (cur || "#ffffff") + '"></label></div>';
}
function pageColorButton(ctl, disabled) {
  var cur = ctl && ctl.get();
  var b = el("button", "dv-rbtn vz-pc" + (cur ? " on" : ""), ICO_PAGECOLOR + '<span class="dv-rbtn-label">Page Color</span>' + VZ_CHEV);
  b.type = "button"; b.disabled = !!disabled || !ctl; b.title = "Page Color — change the background color of the page";
  if (cur) b.style.setProperty("--vz-pc", cur);
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    var r = b.getBoundingClientRect();
    var bind = function (panel) {
      var pick = function (c) {
        ctl.set(c);
        b.classList.toggle("on", !!c);
        if (c) b.style.setProperty("--vz-pc", c); else b.style.removeProperty("--vz-pc");
      };
      panel.querySelectorAll("button[data-pc]").forEach(function (s) {
        s.addEventListener("click", function () { var v = s.getAttribute("data-pc"); pick(v === "none" ? null : v); hooks.closeFloating(); });
      });
      var inp = panel.querySelector(".vz-pc-more input");
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
      inp.addEventListener("change", function () { pick(inp.value.toLowerCase()); hooks.closeFloating(); });
    };
    openDropdown("vzpc", Math.max(8, Math.min(r.left, window.innerWidth - 250)), r.bottom + 6, pageColorMenuHtml(ctl.get()), bind);
  });
  return b;
}
export function buildViewTab(wrap) {
  wrap.appendChild(buildGroup(buildZoomGroup()));
  var ro = !hasActiveChapter() || pdfViewer.open || chapterDrawReadOnlyNow();
  var bgRow = el("div", "dv-rgroup");
  bgRow.appendChild(Ve.bgButton(pdfViewer.open ? null : chapterBgControl(), ro));
  bgRow.appendChild(pageColorButton(pdfViewer.open ? null : chapterPageColorControl(), ro));
  wrap.appendChild(buildGroup([bgRow]));
  wrap.appendChild(buildGroup([
    btnText("🗂", sidebarHidden() ? "Show Notebooks" : "Hide Notebooks", toggleSidebar, false),
    btnText("⛶", "Full Screen", toggleFullscreen, false),
  ]));
}

/* ====================================================================
   Tab Help — hướng dẫn nhanh / phím tắt / góp ý (qua email, không cần backend)
   ==================================================================== */
function openInfoModal(kind) {
  var title = $("info-title"), body = $("info-body");
  if (kind === "shortcuts") {
    title.textContent = "Keyboard Shortcuts";
    body.innerHTML =
      '<div class="info-row"><span>Bold / Italic / Underline</span><span><kbd>Ctrl</kbd>+<kbd>B</kbd> · <kbd>Ctrl</kbd>+<kbd>I</kbd> · <kbd>Ctrl</kbd>+<kbd>U</kbd></span></div>' +
      '<div class="info-row"><span>Insert Link</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd></span></div>' +
      '<div class="info-row"><span>Undo / Redo</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> · <kbd>Ctrl</kbd>+<kbd>Y</kbd></span></div>' +
      '<div class="info-row"><span>Find</span><span><kbd>Ctrl</kbd>+<kbd>F</kbd></span></div>' +
      '<div class="info-row"><span>Start a bulleted list</span><span>type <kbd>-</kbd> or <kbd>*</kbd> then Space</span></div>' +
      '<div class="info-row"><span>Start a numbered list</span><span>type <kbd>1.</kbd> then Space</span></div>';
  } else {
    title.textContent = "Quick Start";
    body.innerHTML = "<ul>" +
      "<li>Click <b>+</b> next to \"Notebooks\" to create a subject, then \"Chương mới\" inside it to add a chapter.</li>" +
      "<li>Pick a chapter in the left column to open the editor — each chapter keeps its own content.</li>" +
      "<li>Your work saves automatically a few seconds after you stop typing (see the status next to the chapter name).</li>" +
      "<li>The <b>Insert</b> tab has Table, Pictures and Link; the <b>Draw</b> tab lets you draw with pens and shapes directly on the page or PDF.</li>" +
      "<li>Studio (top-right button) creates quizzes, flashcards and summaries from your chapters.</li>" +
      "</ul>";
  }
  $("info-overlay").hidden = false;
}
function closeInfoModal() { $("info-overlay").hidden = true; }

// UC-35: góp ý gửi THẲNG tới Admin Console (trang Góp ý) qua POST /feedback — không mở email/Outlook (mailto).
function openFeedback() { hooks.openFeedback(); }

export function buildHelpTab(wrap) {
  wrap.appendChild(buildGroup([
    btnText("？", "Help", function () { openInfoModal("guide"); }, false),
    btnText("⌨", "Keyboard Shortcuts", function () { openInfoModal("shortcuts"); }, false),
    btnText("✉", "Feedback", openFeedback, false),
  ]));
}

// "Trợ giúp" trong popover tài khoản (ghichu_giaodien.js) mở CÙNG modal Hướng dẫn nhanh này —
// xuất ra để ghichu.js truyền vào initGiaodien() (tránh giaodien phải import thẳng module này).
export function openGuideModal() { openInfoModal("guide"); }

/* ====================================================================
   Khởi tạo module — wiring DOM tĩnh riêng của các thẻ ribbon (tìm trong nội
   dung, modal Vẽ phác thảo, modal Hướng dẫn/phím tắt), gọi 1 lần từ
   ghichu.js (init()).
   ==================================================================== */
export function initChucnangcacthe() {
  $("btn-find-toggle").addEventListener("click", function (e) {
    e.stopPropagation();
    state.findOpen = !state.findOpen;
    $("find-box").hidden = !state.findOpen;
    $("btn-find-toggle").classList.toggle("active", state.findOpen);
    if (state.findOpen) { $("find-input").focus(); } else { $("find-input").value = ""; runFind("stop"); }
  });
  $("find-input").addEventListener("input", function () { runFind("find"); });
  $("find-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); runFind(e.shiftKey ? "prev" : "next"); }
    if (e.key === "Escape") { e.preventDefault(); $("btn-find-toggle").click(); }
  });
  $("find-prev").addEventListener("click", function (e) { e.stopPropagation(); runFind("prev"); });
  $("find-next").addEventListener("click", function (e) { e.stopPropagation(); runFind("next"); });

  // Modal "Hướng dẫn / phím tắt"
  $("info-close").addEventListener("click", closeInfoModal);
  $("info-overlay").addEventListener("click", function (e) { if (e.target === $("info-overlay")) closeInfoModal(); });

  // Nút nổi "+" thêm nhanh hàng/cột cạnh bảng (tab Insert ▸ Bảng)
  ensureTablePlusButtons();
  bindTablePlusTracking();
}

// Được ghichu.js gọi khi Esc được bấm trong lúc Format Painter đang chờ chọn đích.
export function hasPendingFormatPainter() { return !!formatPainterClip; }
