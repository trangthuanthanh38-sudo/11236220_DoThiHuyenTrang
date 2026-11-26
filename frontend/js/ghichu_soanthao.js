/* ======================================================================
   ghichu_soanthao.js — MODULE 1: Notebook & soạn thảo (UC-12..18, mở rộng
   UC-16/17). Phụ trách:
     - CRUD Môn học / Chương / File PDF, đổi tên, xoá, kéo-thả sắp xếp
     - Chọn Chương/File PDF và đổ nội dung vào khung soạn/xem tương ứng
     - Cầu nối CKEditor (khởi tạo, autosave, chế độ chỉ đọc) + phần mở rộng
       bullet 3 cấp (chỉ phần MÔ HÌNH/HÀNH VI TỰ ĐỘNG của editor — các nút
       ribbon gọi các hành vi này nằm ở ghichu_chucnangcacthe.js)
     - PDF viewer (PDF.js, cuộn dọc liên tục) + chú thích (textbox/tô màu/
       vẽ/xoá) + autosave annotation lên backend
     - Download/In cho cả Chương lẫn File PDF (dựng PDF mới từ nội dung
       hiện có — không đụng file/nội dung gốc, không lưu DB)
     - Toàn bộ lệnh gọi API/Database của phần soạn thảo (subjects/chapters/
       pdf/annotations — backend/app/routers/knowledge.py)

   Chỉ import từ ghichu_core.js (không phụ thuộc 2 module còn lại). Gọi
   ngược lên ghichu.js (render lại ribbon/toàn trang) qua `hooks` của core —
   xem comment đầu ghichu_core.js.
   ====================================================================== */
import * as Ve from "./ghichu_ve.js";   // thẻ Draw: lớp vẽ trực tiếp (Chương + trang PDF)
import {
  hooks, state, $, el, esc, persist, isOnline, authToken, genLocalId,
  findSubject, chapterInSub, pdfInSub, findChapter, findPdfItem, docKey, docFor,
  hasActiveChapter, activeItemName, sharedSubject, itemRole, isViewOnly, COLORS, FONTS, SIZE_LIST, MAX_IMAGE_BYTES,
  buildGroup, btnText, btnTextDropdown, btnToggle, openDropdown, closeDropdownEl, chapterLocked,
} from "./ghichu_core.js";

/* ====================================================================
   CKEditor bridge — khởi tạo, autosave, chế độ chỉ đọc
   ==================================================================== */
export var editor = null;
var saveTimer = null;

/* Không dùng CKBox/dịch vụ upload đám mây (đã removePlugins) — dán/kéo-thả ảnh trực tiếp
   vào trình soạn thảo cũng cần một adapter để không báo lỗi "no upload adapter"; ở đây
   nhúng ảnh dạng base64 ngay trong nội dung, giống hệt nút "Hình ảnh" ở tab Chèn. */
function Base64UploadAdapter(loader) { this.loader = loader; }
Base64UploadAdapter.prototype.upload = function () {
  return this.loader.file.then(function (file) {
    return new Promise(function (resolve, reject) {
      if (file.size > MAX_IMAGE_BYTES) { reject("Ảnh quá lớn (tối đa 6MB)."); return; }
      var reader = new FileReader();
      reader.onload = function () { resolve({ default: String(reader.result) }); };
      reader.onerror = function () { reject("Không đọc được tệp ảnh."); };
      reader.readAsDataURL(file);
    });
  });
};
Base64UploadAdapter.prototype.abort = function () {};

function ckConfig() {
  return {
    removePlugins: [
      "AIAssistant", "CKBox", "CKFinder", "EasyImage", "RealTimeCollaborativeComments",
      "RealTimeCollaborativeTrackChanges", "RealTimeCollaborativeRevisionHistory", "PresenceList",
      "Comments", "TrackChanges", "TrackChangesData", "RevisionHistory", "Pagination",
      "WProofreader", "MathType", "SlashCommand", "Template", "DocumentOutline", "FormatPainter",
      "TableOfContents", "PasteFromOfficeEnhanced", "CaseChange", "ExportPdf", "ExportWord",
      "MultiLevelList", "Uploadcare", "UploadcareImageEdit", "Mermaid", "Title", "ImageToolbar",
      // Liên kết: bỏ khung nổi tiếng Anh của CKEditor, dùng hộp thoại + ô nhỏ tiếng Việt ở ghichu_chucnangcacthe.js (khối "Liên kết").
      // Giữ LinkEditing (thuộc tính linkHref, lệnh link/unlink, Ctrl+bấm mở liên kết) và AutoLink (gõ địa chỉ tự thành liên kết).
      "Link", "LinkUI", "LinkImage", "LinkImageUI",
    ],
    toolbar: { items: [] },
    fontSize: { options: SIZE_LIST, supportAllValues: true },
    fontFamily: { supportAllValues: true },
    // Mặc định CKEditor lệch 1 bậc: model "heading1" → thẻ view <h2> (dành <h1> cho plugin
    // Title mà ứng dụng này không dùng — đã loại "Title" khỏi removePlugins ở trên). Khai
    // báo lại tường minh để "heading1/2/3" khớp đúng 1-1 với thẻ <h1>/<h2>/<h3> thật.
    heading: {
      options: [
        { model: "paragraph", title: "Paragraph", class: "ck-heading_paragraph" },
        { model: "heading1", view: "h1", title: "Heading 1", class: "ck-heading_heading1" },
        { model: "heading2", view: "h2", title: "Heading 2", class: "ck-heading_heading2" },
        { model: "heading3", view: "h3", title: "Heading 3", class: "ck-heading_heading3" },
      ],
    },
    list: { properties: { styles: true, startIndex: true, reversed: false } },
    // Ảnh: căn lề / kích thước / chú thích làm bằng thanh công cụ riêng tiếng Việt dưới ảnh + menu Insert ▸ Hình ảnh
    // (ghichu_chucnangcacthe.js, khối "Ảnh") — tắt thanh nổi tiếng Anh của CKEditor (removePlugins "ImageToolbar") để không chồng 2 thanh. Ảnh chèn mới
    // luôn là ảnh khối (đứng riêng 1 dòng) để căn trái/giữa/phải không tách đoạn văn; kéo góc đổi cỡ theo px.
    image: { resizeUnit: "px", insert: { type: "block" } },
    table: { contentToolbar: ["tableColumn", "tableRow", "mergeTableCells"] },
    link: { addTargetToExternalLinks: true, defaultProtocol: "https://" },
    placeholder: "Bắt đầu soạn nội dung cho chương này…",
  };
}

/* Ảnh khối đã đổi RIÊNG chiều rộng + chiều cao (Insert ▸ Hình ảnh) lưu thành <figure style="width:…;height:…">; đo thật
   ở CKEditor 41.4.2: đọc lại HTML đó (F5 / mở lại Chương) thì mất CẢ 2 kích thước (chỉ có width thì đọc được). Bộ đọc bổ
   sung chạy SAU bộ đọc gốc: figure.image có style width / height mà ảnh trong model chưa có thì gán lại. */
function setupImageSizeUpcast(ed) {
  ed.conversion.for("upcast").add(function (dispatcher) {
    dispatcher.on("element:figure", function (evt, data, api) {
      if (!data.modelRange || !data.viewItem.hasClass("image")) return;
      var img = null;
      for (var item of data.modelRange.getItems({ shallow: true })) if (item.is && item.is("element", "imageBlock")) { img = item; break; }
      if (!img) return;
      var w = data.viewItem.getStyle("width"), h = data.viewItem.getStyle("height");
      if (w && !img.hasAttribute("resizedWidth")) api.writer.setAttribute("resizedWidth", w, img);
      if (h && !img.hasAttribute("resizedHeight")) api.writer.setAttribute("resizedHeight", h, img);
      var off = data.viewItem.getStyle("margin-left");
      if (off && /^\d+(\.\d+)?px$/.test(off)) api.writer.setAttribute("imageOffset", off, img);
    }, { priority: "low" });
  });
  // Vị trí tự do của ảnh (kéo nút ✥ — ghichu_chucnangcacthe.js): độ lệch từ lề trái nội dung, lưu thành
  // <figure class="image image-style-block-align-left" style="margin-left:Npx">; đi kèm kiểu căn trái nên khi
  // bỏ thuộc tính này ảnh vẫn hiển thị hợp lệ. Nằm trong luồng văn bản (không đè chữ), di chuyển lên/xuống = đổi chỗ khối.
  ed.model.schema.extend("imageBlock", { allowAttributes: ["imageOffset"] });
  ed.conversion.for("downcast").add(function (dispatcher) {
    dispatcher.on("attribute:imageOffset:imageBlock", function (evt, data, api) {
      if (!api.consumable.consume(data.item, evt.name)) return;
      var fig = api.mapper.toViewElement(data.item);
      if (!fig) return;
      if (data.attributeNewValue) api.writer.setStyle("margin-left", data.attributeNewValue, fig);
      else api.writer.removeStyle("margin-left", fig);
    });
  });
}

export function initEditor() {
  var Ed = window.CKEDITOR && (window.CKEDITOR.DecoupledEditor || window.DecoupledEditor);
  var host = $("ck-host");
  if (!Ed || !host) { setTimeout(initEditor, 150); return; }
  Ed.create(host, ckConfig()).then(function (ed) {
    editor = ed;
    editor.plugins.get("FileRepository").createUploadAdapter = function (loader) { return new Base64UploadAdapter(loader); };
    setupCustomBulletSupport(editor);
    setupListMarkerStyle(editor);
    setupImageSizeUpcast(editor);
    editor.setData(docFor(state.active));
    applyReadOnly();
    setupDashAutoformat(editor);
    setupBulletTabLeveling(editor);
    editor.model.document.on("change:data", onEditorChange);
    // Ô font / cỡ trên ribbon theo VÙNG CHỌN (Ctrl+A, bôi đen…), không chỉ khi giá trị lệnh đổi.
    var fmtRaf = null;
    editor.model.document.selection.on("change:range", function () {
      if (fmtRaf) return;
      fmtRaf = requestAnimationFrame(function () { fmtRaf = null; readFormats(); });
    });
    [
      "bold", "italic", "underline", "strikethrough", "bulletedList", "numberedList",
      "heading", "fontFamily", "fontSize", "fontColor", "fontBackgroundColor",
    ].forEach(function (name) {
      var cmd = editor.commands.get(name);
      if (cmd) cmd.on("change:value", readFormats);
    });
    // Các lệnh thao tác bảng không có "value" ý nghĩa — chỉ bật/tắt theo việc con trỏ có
    // đang ở trong một ô bảng hay không.
    [
      "insertTableRowAbove", "insertTableRowBelow", "removeTableRow",
      "insertTableColumnLeft", "insertTableColumnRight", "removeTableColumn",
    ].forEach(function (name) {
      var cmd = editor.commands.get(name);
      if (cmd) cmd.on("change:isEnabled", readFormats);
    });
    readFormats();
  }).catch(function (err) { console.error("Không khởi tạo được CKEditor:", err); });
}

export function applyReadOnly() {
  if (!editor) return;
  var isChapter = hasActiveChapter();
  // "no-chapter" và "user-lock" là 2 lý do khoá độc lập — editor chỉ hết readOnly khi CẢ HAI đều được gỡ.
  if (isChapter) editor.disableReadOnlyMode("no-chapter");
  else editor.enableReadOnlyMode("no-chapter");
  if (state.noteLocked && isChapter) editor.enableReadOnlyMode("user-lock");
  else editor.disableReadOnlyMode("user-lock");
  // Chia sẻ: Chương người khác chia sẻ với quyền "Có thể xem" -> chỉ đọc (lý do khoá thứ 3, độc lập 2 lý do trên)
  if (isChapter && isViewOnly()) editor.enableReadOnlyMode("shared-view");
  else editor.disableReadOnlyMode("shared-view");
  // Review > Password: Chương có mật khẩu chưa mở khoá -> khoá soạn thảo (lý do thứ 4, độc lập)
  if (isChapter && chapterLocked()) editor.enableReadOnlyMode("pw-lock");
  else editor.disableReadOnlyMode("pw-lock");
  switchEditorView();
  if (chapterDraw.s) {
    if (chapterDrawReadOnly()) Ve.leaveDraw();
    Ve.refreshSurface(chapterDraw.s);
  }
}

export function toggleSpellcheck() {
  if (!hasActiveChapter()) return;
  state.spellcheckOn = !state.spellcheckOn;
  $("ck-host").setAttribute("spellcheck", state.spellcheckOn ? "true" : "false");
  hooks.renderRibbon();
}

export function toggleNoteLock() {
  if (!hasActiveChapter()) return;
  state.noteLocked = !state.noteLocked;
  applyReadOnly();
  hooks.renderRibbon();
}

function onEditorChange() {
  if (!hasActiveChapter() || !editor || applyingServer || chapterLocked()) return;
  if (window.CSS && CSS.highlights) CSS.highlights.delete("td-cite");   // người học sửa nội dung -> bỏ bôi vàng nguồn
  state.docs[docKey(state.active)] = editor.getData();
  setSaveStatus("editing");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commitSave, 1200); // autosave định kỳ (UC-16, bước 3)
}

/* Lưu lên máy chủ XẾP HÀNG (saveChain) để 2 lượt autosave sát nhau không cùng gửi 1 base_version rồi tự 409 với chính
   mình. Chia sẻ — khoá lạc quan: gửi kèm base_version = version đang sửa; người khác vừa lưu bản mới hơn -> 409, KHÔNG
   ghi đè, hooks.onSaveConflict hiện thanh "… vừa sửa chương này" (ghichu_chiase.js). force = "Giữ bản của tôi" (ghi đè). */
var saveChain = Promise.resolve();
export function chapterMetaOf(d) {
  return { role: d.role || "owner", updatedBy: d.updated_by_name || null, updatedAgo: d.updated_seconds_ago, at: Date.now() };
}
// Review > Password: trước khi khoá lại, đẩy nốt nội dung đang gõ lên máy chủ (đang còn khoá mở).
export function flushSaves() {
  if (state.saveStatus === "editing") commitSave();
  flushChapterDrawing();
  return new Promise(function (r) { setTimeout(r, 260); }).then(function () { return saveChain; });
}
export function commitSave(force) {
  clearTimeout(saveTimer);
  if (!hasActiveChapter()) return; // đang xem PDF (hoặc chưa chọn gì) -> không có nội dung Chương nào để lưu
  if (chapterLocked()) { setSaveStatus("idle"); return; }   // Chương có mật khẩu đang khoá: chưa có nội dung để lưu
  if (editor) state.docs[docKey(state.active)] = editor.getData();
  if (isViewOnly()) { setSaveStatus("idle"); return; } // được chia sẻ chỉ xem -> không có gì để lưu
  setSaveStatus("saving");
  var savingFor = state.active; // chốt lại chương đang lưu — người dùng có thể đổi mục trong lúc chờ
  setTimeout(function () {
    persist();
    if (!isOnline() || !savingFor) { state.savedAt = new Date(); setSaveStatus("saved"); return; }
    saveChain = saveChain.then(function () {
      var body = { content_json: state.docs[docKey(savingFor)] || "" };
      if (force !== true && state.versions[savingFor.id] != null) body.base_version = state.versions[savingFor.id];
      return apiAuth("PUT", "/chapters/" + savingFor.id, authToken(), body).then(function (res) {
        var still = state.active && state.active.kind === "chapter" && state.active.id === savingFor.id;
        if (res.ok && res.data) {
          state.versions[savingFor.id] = res.data.content_version;
          state.chapterMeta[savingFor.id] = chapterMetaOf(res.data);
          state.savedAt = new Date();
          if (still && state.saveStatus === "saving") setSaveStatus("saved");
          hooks.onChapterSaved(savingFor, res.data);
        } else if (res.status === 409) {
          if (still) setSaveStatus("conflict");
          hooks.onSaveConflict(savingFor, res.data && res.data.detail);
        } else if (res.status === 403 && res.data && res.data.err && res.data.err.code === "chapter_locked") {
          // Review > Password: khoá mở hết hạn / mật khẩu vừa bị đổi -> giữ bản nháp, hiện màn khoá, mở lại thì lưu tiếp
          state.pwDrafts = state.pwDrafts || {};
          state.pwDrafts[savingFor.id] = body.content_json;
          delete state.chapterKeys[savingFor.id];
          if (still) { setSaveStatus("idle"); fetchChapterDetail(savingFor.id); }
        } else if (res.status === 403 || res.status === 404) {
          hooks.onAccessLost(savingFor, res.status);
        } else if (still && state.saveStatus === "saving") {
          state.savedAt = new Date();
          setSaveStatus("saved");   // lỗi mạng: bản nháp vẫn ở localStorage như trước (UC-16 E1)
        }
      });
    });
  }, 200);
}

// Cập nhật cờ "có mật khẩu" của Chương ở cây (của mình hoặc được chia sẻ) theo máy chủ.
export function markProtected(chapterId, on) {
  var changed = false;
  state.subjects.concat(state.shared).forEach(function (s) {
    (s.chapters || []).forEach(function (c) { if (c.id === chapterId && !!c.protected !== !!on) { c.protected = !!on; changed = true; } });
  });
  if (changed) { persist(); hooks.renderAll(); }
}

/* Đổ bản mới nhất từ máy chủ vào Chương (người khác vừa sửa / "Xem bản mới nhất") — không coi là thay đổi của mình. */
export function applyServerChapter(chapterId, d) {
  state.docs[chapterId] = d.content_json || "";
  takeServerDrawing(chapterId, d);
  state.versions[chapterId] = d.content_version;
  state.chapterMeta[chapterId] = chapterMetaOf(d);
  state.loadedChapters[chapterId] = true;
  if (state.active && state.active.kind === "chapter" && state.active.id === chapterId && editor) {
    applyingServer = true;
    editor.setData(state.docs[chapterId]);
    applyingServer = false;
    applyReadOnly();
    mountChapterDrawing();
    setSaveStatus("saved");
  }
  persist();
}
var applyingServer = false;

// renderStatusPill() thật sự thuộc ghichu.js (breadcrumb/trạng thái lưu — hiển thị chung cho
// cả Chương/PDF) — gọi qua hook thay vì renderAll() nguyên trang chỉ vì đổi trạng thái lưu,
// đúng hành vi gốc (bản gốc gọi thẳng renderStatusPill()).
function setSaveStatus(s) {
  state.saveStatus = s;
  hooks.renderStatusPill();
}

// beforeunload (ghichu.js) cần đẩy nội dung đang gõ vào state trước khi persist() — gói lại
// thành hàm xuất ra thay vì để ghichu.js đọc thẳng biến `editor` (giữ editor là chi tiết nội
// bộ của module này).
export function flushActiveChapterEditor() {
  if (hasActiveChapter() && editor) state.docs[docKey(state.active)] = editor.getData();
}

/* ====================================================================
   Mô hình bullet tuỳ chọn + tự động hoá khi gõ (KHÔNG phải hành động ribbon
   — đây là hành vi editor tự chạy, nên ở cùng chỗ khởi tạo editor). Nút
   "Kho ký hiệu"/Tab-để-đổi-cấp mà người dùng bấm nằm ở ghichu_chucnangcacthe.js
   (toggleList/applyBulletType tại module đó gọi setBulletTypeForSelection()
   xuất ra dưới đây).
   ==================================================================== */
var STANDARD_LIST_TYPES = ["disc", "circle", "square", "decimal", "decimal-leading-zero", "lower-roman", "upper-roman", "lower-latin", "upper-latin", "default"];

function setupCustomBulletSupport(ed) {
  ed.model.schema.extend("$block", { allowAttributes: "customBulletGlyph" });
  ed.model.document.registerPostFixer(function (writer) {
    var changed = false;
    ed.model.document.differ.getChanges().forEach(function (change) {
      var item = change.type === "attribute" ? change.range.start.nodeAfter : change.position && change.position.nodeAfter;
      if (!item || !item.is || !item.is("element")) return;
      if (item.hasAttribute("customBulletGlyph") && !item.hasAttribute("listType")) {
        writer.removeAttribute("customBulletGlyph", item);
        changed = true;
      }
    });
    return changed;
  });
  var applyGlyphStyle = function (modelItem, conversionApi) {
    var viewElement = conversionApi.mapper.toViewElement(modelItem);
    var li = viewElement && (viewElement.is("containerElement", "li") ? viewElement : viewElement.findAncestor("li"));
    if (!li) return;
    var value = modelItem.getAttribute("customBulletGlyph");
    if (value) conversionApi.writer.setStyle("list-style-type", value, li);
    else conversionApi.writer.removeStyle("list-style-type", li);
  };
  var addLiStyleConverter = function (dispatcher) {
    dispatcher.on("attribute:customBulletGlyph:paragraph", function (evt, data, conversionApi) {
      applyGlyphStyle(data.item, conversionApi);
    });
    dispatcher.on("insert:paragraph", function (evt, data, conversionApi) {
      if (!data.item.hasAttribute("customBulletGlyph")) return;
      applyGlyphStyle(data.item, conversionApi);
    }, { priority: "low" });
    dispatcher.on("attribute:listIndent:paragraph", function (evt, data, conversionApi) {
      applyGlyphStyle(data.item, conversionApi);
    }, { priority: "low" });
  };
  addLiStyleConverter(ed.editing.downcastDispatcher);
  addLiStyleConverter(ed.data.downcastDispatcher);
  ed.conversion.for("upcast").attributeToAttribute({
    view: { name: "li", styles: { "list-style-type": /.+/ } },
    model: { key: "customBulletGlyph", value: function (viewElement) { return viewElement.getStyle("list-style-type"); } },
  });
}

/* Dấu đầu dòng / số thứ tự đi theo kiểu chữ của mục (như Word): chữ trong 1 mục danh sách cùng 1 màu / cỡ / font thì
   <li> mang biến CSS --mk-color / --mk-size / --mk-font, `li::marker` (ghichu_soanthao.css + xem.css) dùng lại → Ctrl+A
   đổi màu / cỡ / font thì ký hiệu đầu dòng đổi theo. Chữ trong mục KHÔNG đồng nhất → bỏ biến, ký hiệu về mặc định. Mục rỗng
   đọc kiểu đã "nhớ" trên dòng trống (thuộc tính selection:*, xem applyToEmptyBlocks ở ghichu_chucnangcacthe.js). Chạy ở cả
   editing lẫn data downcast nên Download / In / trang xem công khai cũng đúng; không có upcast (đọc lại từ chữ). */
var MARKER_PROPS = [["fontColor", "--mk-color"], ["fontSize", "--mk-size"], ["fontFamily", "--mk-font"]];
function listItemFirstBlock(block) {
  if (!block || !block.is || !block.is("element") || !block.hasAttribute("listItemId")) return null;
  var id = block.getAttribute("listItemId"), b = block;
  while (b.previousSibling && b.previousSibling.is("element") && b.previousSibling.getAttribute("listItemId") === id) b = b.previousSibling;
  return b;
}
function uniformMarkerStyle(block) {
  var out = {};
  MARKER_PROPS.forEach(function (pr) {
    var vals = [], any = false;
    for (var n of block.getChildren()) {
      if (!n.is("$text")) continue;
      if (!n.data.trim()) continue;
      any = true;
      var v = n.getAttribute(pr[0]) || null;
      if (vals.indexOf(v) < 0) vals.push(v);
    }
    if (!any) { var st = block.getAttribute("selection:" + pr[0]); out[pr[1]] = st || null; }
    else out[pr[1]] = vals.length === 1 ? vals[0] : null;
  });
  return out;
}
function setupListMarkerStyle(ed) {
  var apply = function (block, api) {
    var first = listItemFirstBlock(block);
    if (!first) return;
    var ve = api.mapper.toViewElement(first);
    var li = ve && (ve.is("containerElement", "li") ? ve : ve.findAncestor("li"));
    if (!li) return;
    var st = uniformMarkerStyle(first);
    Object.keys(st).forEach(function (k) {
      if (st[k]) api.writer.setStyle(k, st[k], li); else api.writer.removeStyle(k, li);
    });
  };
  var parentBlock = function (pos) { return pos && pos.parent; };
  var add = function (dispatcher) {
    ["paragraph", "heading1", "heading2", "heading3"].forEach(function (name) {
      dispatcher.on("insert:" + name, function (evt, data, api) { apply(data.item, api); }, { priority: "lowest" });
      ["listItemId", "listIndent", "listType"].forEach(function (a) {
        dispatcher.on("attribute:" + a + ":" + name, function (evt, data, api) { apply(data.item, api); }, { priority: "lowest" });
      });
    });
    MARKER_PROPS.forEach(function (pr) {
      dispatcher.on("attribute:" + pr[0] + ":$text", function (evt, data, api) { apply(data.item.parent, api); }, { priority: "lowest" });
      dispatcher.on("attribute:selection:" + pr[0], function (evt, data, api) { apply(data.item, api); }, { priority: "lowest" });
    });
    dispatcher.on("insert:$text", function (evt, data, api) { apply(data.item.parent, api); }, { priority: "lowest" });
    dispatcher.on("remove", function (evt, data, api) { apply(parentBlock(data.position), api); }, { priority: "lowest" });
  };
  add(ed.editing.downcastDispatcher);
  add(ed.data.downcastDispatcher);
}

// Áp bullet cho (các) mục danh sách trong vùng chọn hiện tại — dùng chung cho cả bullet
// chuẩn (disc/circle/square/none) lẫn ký hiệu tuỳ chọn. Xuất ra cho ghichu_chucnangcacthe.js
// (nút Kho ký hiệu ở tab Home) dùng lại.
export function applyBulletType(type) {
  if (!editor) return;
  var isStandard = STANDARD_LIST_TYPES.indexOf(type) >= 0;
  if (isStandard && editor.commands.get("listStyle")) editor.execute("listStyle", { type: type });
  editor.model.change(function (writer) {
    var blocks = Array.from(editor.model.document.selection.getSelectedBlocks());
    blocks.forEach(function (block) {
      if (!block.hasAttribute("listType")) return;
      if (isStandard) writer.removeAttribute("customBulletGlyph", block);
      else writer.setAttribute("customBulletGlyph", type, block);
    });
  });
}

function setupDashAutoformat(ed) {
  ed.editing.view.document.on("insertText", function (evt, data) {
    if (data.text !== " ") return;
    var selection = ed.model.document.selection;
    if (!selection.isCollapsed) return;
    var position = selection.getFirstPosition();
    var block = position.parent;
    if (!block.is || !block.is("element", "paragraph")) return;
    if (position.offset !== 1) return;
    var text = "";
    for (var item of ed.model.createRangeIn(block).getItems()) { if (item.is && item.is("$textProxy")) text += item.data; }
    if (text !== "-" && text !== "*") return;
    evt.stop();
    ed.model.change(function (writer) {
      writer.remove(writer.createRange(writer.createPositionAt(block, 0), position));
    });
    ed.execute("bulletedList");
    if (text === "-") applyBulletType('"- "');
    ed.editing.view.focus();
  }, { priority: "high" });
}

/* ---- Bullet: giới hạn 3 cấp khi gõ Tab/Shift+Tab (xem chi tiết ở bản gốc) ---- */
var BULLET_LEVEL_TYPES = ['"- "', "circle", "disc"];
var BULLET_MAX_LEVEL = BULLET_LEVEL_TYPES.length - 1;

function bulletListBlockAt(ed) {
  var pos = ed.model.document.selection.getFirstPosition();
  var block = pos && pos.parent;
  return (block && typeof block.hasAttribute === "function" && block.hasAttribute("listType")) ? block : null;
}
function setBulletLevelGlyph(ed, block, type) {
  if (!block || typeof block.hasAttribute !== "function" || !block.hasAttribute("listType")) return;
  ed.model.change(function (writer) { writer.setAttribute("customBulletGlyph", type, block); });
}
function setupBulletTabLeveling(ed) {
  ed.editing.view.document.on("keydown", function (evt, data) {
    var isTab = data.keyCode === 9 || (data.domEvent && data.domEvent.key === "Tab");
    if (!isTab) return;
    var block = bulletListBlockAt(ed);
    if (!block || block.getAttribute("listType") !== "bulleted") return;
    var shiftKey = !!(data.shiftKey || (data.domEvent && data.domEvent.shiftKey));
    var indentCmd = ed.commands.get("indentList");
    var outdentCmd = ed.commands.get("outdentList");
    var level = block.getAttribute("listIndent") || 0;
    var moved = false;

    if (!shiftKey) {
      if (level >= BULLET_MAX_LEVEL) {
        while (level > 0) {
          if (!outdentCmd || !outdentCmd.isEnabled) break;
          ed.execute("outdentList");
          moved = true;
          block = bulletListBlockAt(ed);
          level = block ? (block.getAttribute("listIndent") || 0) : 0;
        }
      } else if (indentCmd && indentCmd.isEnabled) {
        ed.execute("indentList");
        moved = true;
      }
    } else if (level > 0 && outdentCmd && outdentCmd.isEnabled) {
      ed.execute("outdentList");
      moved = true;
    }

    evt.stop();
    if (data.preventDefault) data.preventDefault(); else if (data.domEvent) data.domEvent.preventDefault();
    if (!moved) return;

    var newBlock = bulletListBlockAt(ed);
    if (!newBlock) return;
    var newLevel = newBlock.getAttribute("listIndent") || 0;
    var idx = Math.max(0, Math.min(BULLET_MAX_LEVEL, newLevel));
    setBulletLevelGlyph(ed, newBlock, BULLET_LEVEL_TYPES[idx]);
  }, { priority: "highest" });
}

/* Đọc trạng thái định dạng thật tại vị trí con trỏ/selection hiện tại và đồng bộ lại toàn
   bộ toolbar (Home tab, ghichu_chucnangcacthe.js) theo đó. */
var MIXED = {};
// Giá trị CHUNG của 1 thuộc tính chữ trên cả vùng chọn (MIXED nếu khác nhau). Chữ không có thuộc tính → fallback(khối).
function selectionAttrValue(key, fallback) {
  var sel = editor.model.document.selection;
  if (sel.isCollapsed) {
    var v0 = sel.getAttribute(key);
    return v0 != null ? v0 : fallback(sel.getFirstPosition().parent);
  }
  var seen = null, has = false, cache = new Map();
  for (var range of sel.getRanges()) {
    for (var item of range.getItems()) {
      if (!item.is("$textProxy") || !item.data.trim()) continue;
      var v = item.getAttribute(key);
      if (v == null) {
        var blk = item.parent;
        if (!cache.has(blk)) cache.set(blk, fallback(blk));
        v = cache.get(blk);
      }
      if (!has) { seen = v; has = true; } else if (v !== seen) return MIXED;
    }
  }
  return has ? seen : (sel.getAttribute(key) || fallback(sel.getFirstPosition().parent));
}
// Cỡ chữ thật (px) của 1 khối chưa đặt cỡ riêng — đo trên DOM (tiêu đề h1/h2/h3 to hơn đoạn văn).
function blockDefaultSize(block) {
  try {
    var ve = editor.editing.mapper.toViewElement(block);
    var dom = ve && editor.editing.view.domConverter.mapViewToDom(ve);
    if (!dom) return null;
    var zoom = parseFloat(getComputedStyle(dom).zoom) || 1;
    return Math.round(parseFloat(getComputedStyle(dom).fontSize) / (zoom || 1)) + "px";
  } catch (e) { return null; }
}

export function readFormats() {
  if (!editor) return;
  var v = function (name) { var c = editor.commands.get(name); return !!(c && c.value); };
  var val = function (name) { var c = editor.commands.get(name); return c ? c.value : undefined; };
  var enabled = function (name) { var c = editor.commands.get(name); return !!(c && c.isEnabled); };
  state.fmt = {
    bold: v("bold"), italic: v("italic"), underline: v("underline"), strikeThrough: v("strikethrough"),
    insertUnorderedList: v("bulletedList"), insertOrderedList: v("numberedList"),
    blockQuote: v("blockQuote"),
    heading: val("heading") || false,
    inTable: enabled("insertTableRowBelow"),
  };

  // Như Word: vùng chọn có nhiều font / cỡ khác nhau thì ô font / cỡ để TRỐNG (trước đây hiện giá trị của ký tự đầu, vd. sau
  // Ctrl+A luôn ghi "Figtree 16"); chữ chưa đặt cỡ riêng thì hiện cỡ thật của khối (tiêu đề không còn bị ghi 16).
  var ff = selectionAttrValue("fontFamily", function () { return null; });
  if (ff === MIXED) state.font = "";
  else {
    var normFont = function (x) { return String(x || "").replace(/["']/g, "").replace(/\s*,\s*/g, ",").trim().toLowerCase(); };
    var matchFont = FONTS.filter(function (f) { return normFont(f.stack) === normFont(ff); })[0];
    state.font = ff == null ? FONTS[0].value : (matchFont ? matchFont.value : "");
  }
  var fs = selectionAttrValue("fontSize", blockDefaultSize);
  if (fs === MIXED) { state.size = null; state.sizeDraft = ""; }
  else {
    var n = fs != null ? parseInt(String(fs), 10) : NaN;
    state.size = isNaN(n) ? 16 : n;
    state.sizeDraft = String(state.size);
  }

  var fc = val("fontColor"); if (fc) state.inkColor = fc;
  var hc = val("fontBackgroundColor"); if (hc) state.hiColor = hc;

  hooks.renderRibbon();
}

/* ====================================================================
   Cây Môn học → Chương → File PDF (CRUD, kéo-thả, đổi tên, xoá — UC-12..15)
   ==================================================================== */
export function addSubject() {
  var name = state.subjectDraft.trim();
  state.typingSubject = false; state.subjectDraft = "";
  if (!name) { renderTree(); return; }

  function finish(sub) {
    state.subjects.push(sub);
    state.open[sub.id] = true;
    persist();
    renderTree();
  }

  if (isOnline()) {
    apiAuth("POST", "/subjects", authToken(), { name: name }).then(function (res) {
      if (!res.ok) { window.alert((res.data && res.data.detail) || "Không tạo được môn học."); renderTree(); return; }
      finish({ id: res.data.id, name: res.data.name, chapters: [], pdfs: [] });
    });
    return;
  }
  finish({ id: genLocalId(), name: name, chapters: [], pdfs: [] });
}

export function addChapter(subjectId) {
  var name = state.chapterDraft.trim();
  state.typingChapterIn = null; state.chapterDraft = "";
  if (!name) { renderTree(); return; }
  var sub = findSubject(subjectId);
  if (!sub) { renderTree(); return; }

  function finish(chapter) {
    sub.chapters.push(chapter);
    state.active = { s: subjectId, kind: "chapter", id: chapter.id };
    state.loadedChapters[chapter.id] = true; // vừa tạo -> chắc chắn rỗng, khỏi cần GET lại
    persist();
    loadActiveIntoEditor();
    hooks.renderAll();
  }

  if (isOnline()) {
    apiAuth("POST", "/subjects/" + subjectId + "/chapters", authToken(), { name: name }).then(function (res) {
      if (!res.ok) { window.alert((res.data && res.data.detail) || "Không tạo được chương."); renderTree(); return; }  // E1
      finish({ id: res.data.id, name: res.data.name });
    });
    return;
  }
  finish({ id: genLocalId(), name: name });
}

export function commitRename() {
  var r = state.rename;
  var name = state.renameDraft.trim();
  state.rename = null; state.renameDraft = "";
  if (!r || !name) { renderTree(); return; }

  if (r.kind === "subject") {
    var sub = findSubject(r.id);
    if (!sub || sub.name === name) { renderTree(); return; }
    var applySubject = function () { sub.name = name; persist(); hooks.renderAll(); };
    if (isOnline()) {
      apiAuth("PUT", "/subjects/" + r.id, authToken(), { name: name }).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không đổi tên được môn học."); renderTree(); return; }
        applySubject();
      });
      return;
    }
    applySubject();
  } else if (r.kind === "chapter") {
    var chapter = findChapter(r.s, r.id);
    if (!chapter || chapter.name === name) { renderTree(); return; }
    var applyChapter = function () { chapter.name = name; persist(); hooks.renderAll(); };
    if (isOnline()) {
      apiAuth("PUT", "/chapters/" + r.id, authToken(), { name: name }).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không đổi tên được chương."); renderTree(); return; }
        applyChapter();
      });
      return;
    }
    applyChapter();
  } else if (r.kind === "pdf") {
    var pdfItem = findPdfItem(r.s, r.id);
    if (!pdfItem || pdfItem.name === name) { renderTree(); return; }
    var applyPdf = function () {
      pdfItem.name = name;
      if (state.pdfs[r.id]) state.pdfs[r.id].name = name;
      persist();
      hooks.renderAll();
    };
    if (isOnline()) {
      apiAuth("PUT", "/pdf/" + r.id, authToken(), { name: name }).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không đổi tên được tệp PDF."); renderTree(); return; }
        applyPdf();
      });
      return;
    }
    applyPdf();
  }
}

// Gỡ 1 mục PDF khỏi state.pdfs + huỷ blob URL đang giữ trong bộ nhớ (nếu có) — dùng khi xoá
// Môn học/File PDF (BR-10 cascade) để không rò rỉ Object URL. Chỉ dọn state cục bộ: PDF/
// annotation THẬT trên backend đã tự bị xoá cascade theo FK khi gọi DELETE /subjects|/pdf.
function removePdfEntry(pdfId) {
  if (pdfBlobCache[pdfId]) { URL.revokeObjectURL(pdfBlobCache[pdfId].blobUrl); delete pdfBlobCache[pdfId]; }
  delete state.pdfs[pdfId];
  if (state.active && state.active.kind === "pdf" && state.active.id === pdfId) closePdfViewer();
}

export function deleteMenuTarget() {
  var m = state.menu;
  state.menu = null;
  if (!m) { hooks.renderAll(); return; }

  if (m.kind === "subject") {
    var subj = findSubject(m.id);
    var pdfIds = subj ? subj.pdfs.map(function (p) { return p.id; }) : [];
    var finishSubject = function () {
      pdfIds.forEach(removePdfEntry);
      state.subjects = state.subjects.filter(function (s) { return s.id !== m.id; });
      if (state.active && state.active.s === m.id) state.active = null;
      persist();
      loadActiveIntoEditor();
      hooks.renderAll();
    };
    if (isOnline()) {
      apiAuth("DELETE", "/subjects/" + m.id, authToken()).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không xoá được môn học."); hooks.renderAll(); return; }
        finishSubject();
      });
      return;
    }
    finishSubject();
  } else if (m.kind === "chapter") {
    var finishChapter = function () {
      var sub = findSubject(m.s);
      if (sub) sub.chapters = sub.chapters.filter(function (c) { return c.id !== m.id; });
      if (state.active && state.active.s === m.s && state.active.kind === "chapter" && state.active.id === m.id) state.active = null;
      persist();
      loadActiveIntoEditor();
      hooks.renderAll();
    };
    if (isOnline()) {
      apiAuth("DELETE", "/chapters/" + m.id, authToken()).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không xoá được chương."); hooks.renderAll(); return; }
        finishChapter();
      });
      return;
    }
    finishChapter();
  } else if (m.kind === "pdf") {
    var finishPdf = function () {
      removePdfEntry(m.id);
      var sub = findSubject(m.s);
      if (sub) sub.pdfs = sub.pdfs.filter(function (p) { return p.id !== m.id; });
      if (state.active && state.active.s === m.s && state.active.kind === "pdf" && state.active.id === m.id) state.active = null;
      persist();
      loadActiveIntoEditor();
      hooks.renderAll();
    };
    if (isOnline()) {
      apiAuth("DELETE", "/pdf/" + m.id, authToken()).then(function (res) {
        if (!res.ok) { window.alert((res.data && res.data.detail) || "Không xoá được tệp PDF."); hooks.renderAll(); return; }
        finishPdf();
      });
      return;
    }
    finishPdf();
  }
}

// Kéo-thả sắp xếp lại xong thì hiện ngay (optimistic) rồi mới bắn PUT .../reorder nền.
export function reorder(drag, target) {
  if (!drag || !target || drag.kind !== target.kind) return;
  if (drag.kind === "subject") {
    if (drag.id === target.id) return;
    var from = state.subjects.findIndex(function (s) { return s.id === drag.id; });
    var to = state.subjects.findIndex(function (s) { return s.id === target.id; });
    if (from < 0 || to < 0) return;
    var moved = state.subjects.splice(from, 1)[0];
    state.subjects.splice(to, 0, moved);
    persist();
    renderTree();
    if (isOnline()) {
      apiAuth("PUT", "/subjects/reorder", authToken(), { ordered_ids: state.subjects.map(function (s) { return s.id; }) });
    }
  } else if (drag.kind === "chapter") {
    if (drag.s !== target.s || drag.id === target.id) return;
    var sub = findSubject(drag.s);
    if (!sub) return;
    var f = sub.chapters.findIndex(function (c) { return c.id === drag.id; });
    var t = sub.chapters.findIndex(function (c) { return c.id === target.id; });
    if (f < 0 || t < 0) return;
    var mv = sub.chapters.splice(f, 1)[0];
    sub.chapters.splice(t, 0, mv);
    persist();
    renderTree();
    if (isOnline()) {
      apiAuth("PUT", "/subjects/" + drag.s + "/chapters/reorder", authToken(), { ordered_ids: sub.chapters.map(function (c) { return c.id; }) });
    }
  } else if (drag.kind === "pdf") {
    if (drag.id === target.id) return;
    movePdfWithinTree(drag.id, drag.s, target.s, target.id);
  }
}

// Kéo 1 File PDF thả lên 1 File PDF khác (cùng Môn hoặc khác Môn) HOẶC lên hẳn tiêu đề 1 Môn
// học khác (targetPdfId = null -> xếp cuối danh sách PDF của Môn đó).
function movePdfWithinTree(pdfId, fromSubjectId, toSubjectId, targetPdfId) {
  var fromSub = findSubject(fromSubjectId), toSub = findSubject(toSubjectId);
  if (!fromSub || !toSub) return;
  var moving = pdfInSub(fromSub, pdfId);
  if (!moving) return;
  fromSub.pdfs = fromSub.pdfs.filter(function (p) { return p.id !== pdfId; });
  var insertAt = targetPdfId ? toSub.pdfs.findIndex(function (p) { return p.id === targetPdfId; }) : -1;
  if (insertAt < 0) insertAt = toSub.pdfs.length;
  toSub.pdfs.splice(insertAt, 0, moving);
  if (state.active && state.active.kind === "pdf" && state.active.id === pdfId) state.active.s = toSubjectId;
  persist();
  renderTree();
  if (!isOnline()) return;
  var subjectChanged = fromSubjectId !== toSubjectId;
  var afterMove = subjectChanged
    ? apiAuth("PUT", "/pdf/" + pdfId, authToken(), { subject_id: toSubjectId })
    : Promise.resolve();
  afterMove.then(function () {
    apiAuth("PUT", "/subjects/" + toSubjectId + "/pdfs/reorder", authToken(), { ordered_ids: toSub.pdfs.map(function (p) { return p.id; }) });
  });
}

/* ====================================================================
   File PDF — item độc lập, cùng cấp với Chương dưới 1 Môn học. Xem PDF gốc
   qua PDF.js (cuộn dọc liên tục, mỗi trang render riêng) + vẽ annotation
   trên overlay (KHÔNG sửa file gốc).
   ==================================================================== */
var MAX_PDF_BYTES = 20 * 1024 * 1024; // BR-14: khớp settings.MAX_PDF_MB mặc định ở backend/app/config.py
var PDF_BASE_SCALE = 1.25; // mốc "100%" hiển thị cho người dùng dễ đọc
// Cột 3 (Studio) đang mở thì cột giữa hẹp lại -> PDF tự thu về 60% để nhìn được trọn bề ngang trang;
// đóng cột 3 thì trở lại 100%. ghichu.js báo qua setPdfStudioFit() mỗi khi cột 3 hiện/ẩn.
var PDF_STUDIO_RATIO = 0.6;
var pdfStudioVisible = false;
// Responsive: khung xem hẹp hơn trang PDF (iPad dọc / điện thoại) thì tỉ lệ mặc định thu vừa bề ngang khung
// (không cuộn ngang); khung đủ rộng thì giữ đúng mốc 100% / 60% như cũ. pageW1 = bề rộng trang 1 ở scale 1.
function pdfDefaultScale() {
  var s = PDF_BASE_SCALE * (pdfStudioVisible ? PDF_STUDIO_RATIO : 1);
  var box = $("editor-scroll") || document.querySelector(".editor-scroll");
  if (box && box.clientWidth) {
    var cs = getComputedStyle(box);
    var avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 8;
    var fit = avail / (pdfViewer.pageW1 || 612);
    if (avail > 120 && fit < s) s = Math.max(0.3, fit);
  }
  return s;
}
var PDF_ANNOT_COLORS = ["#ffd43b", "#ff6b6b", "#38d9a9", "#4dabf7", "#e599f7", "#050d2b"];
var PDF_TOOLS = [
  { key: "textbox", glyph: "🔤", label: "Textbox" },
  { key: "highlight", glyph: "🖊", label: "Tô màu" },
  { key: "draw", glyph: "✏️", label: "Vẽ" },
  { key: "erase", glyph: "🧽", label: "Xoá" },
];
var TEXTBOX_DRAG_THRESHOLD = 4; // px — dưới ngưỡng này coi là click (mở sửa), không phải kéo

// pdfBlobCache: pdfId -> {file, blobUrl} — SỐNG NGOÀI state (không persist), vì Blob/File
// không đưa vào JSON/localStorage được.
var pdfBlobCache = {};
var pdfUploadTargetSubject = null;

export var pdfViewer = {
  open: false,
  pdfId: null,
  fileName: "",
  pdfDoc: null,
  numPages: 1,
  scale: PDF_BASE_SCALE,
  tool: null,             // null | 'textbox' | 'highlight' | 'draw' | 'erase'
  color: PDF_ANNOT_COLORS[0],
  pages: [],
  currentPageNum: 1,
  activePage: null,
  dragging: false,
  dragStartPdf: null,
  strokePdf: null,
  observer: null,
  pendingPage: null,      // trang cần cuộn tới sau lần dựng trang kế tiếp (bấm trích dẫn AI — UC-20 5a)
};

/* ---- Thẻ Draw trên File PDF: mỗi trang 1 lớp vẽ (ghichu_ve.js). Nét vẽ = annotation 'draw', hình khối = 'shape'; data
   chính là phần tử của lớp vẽ (toạ độ PDF user space) — giữ nguyên đối tượng nên hoàn tác / sửa cập nhật đúng dòng. ---- */
function normalizeDrawData(a) {
  var d = a.data;
  if (a.type === "draw" && !d.t) {   // nét vẽ tạo bằng công cụ "Vẽ" cũ: {color, strokeWidth (px ở cỡ gốc), paths}
    d.t = "ink"; d.kind = d.kind || "pen";
    if (d.w == null) d.w = (d.strokeWidth || 2.5) / PDF_BASE_SCALE;
  }
  if (a.type === "shape" && !d.t) d.t = "shape";
  return d;
}
function annotOfData(item) { return pdfAnnotList().filter(function (a) { return a.data === item; })[0] || null; }
function pdfDrawAdapter(pageState) {
  return {
    key: "pdf:" + pdfViewer.pdfId, page: pageState.num,
    list: function () {
      return pdfAnnotList().filter(function (a) { return a.page === pageState.num && (a.type === "draw" || a.type === "shape"); }).map(normalizeDrawData);
    },
    add: function (item) { addPdfAnnotation(pageState.num, item.t === "ink" ? "draw" : "shape", item); },
    remove: function (item) { var a = annotOfData(item); if (a) deleteAnnotationDirect(a, pageState); },
    update: function (item) { var a = annotOfData(item); persist(); if (a) syncAnnotationUpdate(a); },
    toPx: function (pt) { var v = pageState.viewport.convertToViewportPoint(pt[0], pt[1]); return [v[0], v[1]]; },
    fromPx: function (q) { return pageState.viewport.convertToPdfPoint(q[0], q[1]); },
    k: function () { return pdfViewer.scale; },
    readOnly: function () { return !pdfViewer.pdfDoc || isViewOnly(); },
    // Tẩy cũng xoá được vùng tô màu / hộp văn bản của bộ chú thích cũ.
    eraseExtra: function (q) {
      var rec = state.pdfs[pdfViewer.pdfId];
      if (!rec) return;
      var hit = rec.annotations.filter(function (a) {
        return a.page === pageState.num && (a.type === "highlight" || a.type === "textbox") && pdfAnnotationHit(a, { x: q[0], y: q[1] }, pageState.viewport);
      });
      hit.forEach(function (a) { deleteAnnotationDirect(a, pageState); });
    },
  };
}
function unmountPdfDrawLayers() {
  pdfViewer.pages.forEach(function (p) { if (p.dv) { Ve.unmountSurface(p.dv); p.dv = null; } });
}
// Thẻ Draw khi đang xem PDF: thêm nút "Hộp văn bản" (công cụ chú thích cũ) cạnh bộ bút / hình khối.
export function buildPdfDrawExtras() {
  var b = btnToggle("🔤", "Text Box", pdfViewer.tool === "textbox", function () {
    pdfViewer.tool = pdfViewer.tool === "textbox" ? null : "textbox";
    if (pdfViewer.tool) Ve.setTool(null, { silent: true });
    hooks.renderRibbon();
    pdfInteractCursor();
  }, !pdfViewer.pdfDoc || isViewOnly());
  b.title = "Text Box — click the PDF page to type; drag a box to move it, click to edit";
  return [b];
}
// Chọn bút / tẩy / hình của thẻ Draw → tắt công cụ "Hộp văn bản" của PDF.
Ve.dv.onToolChange = function () { if (pdfViewer.tool) { pdfViewer.tool = null; pdfInteractCursor(); } };

function pdfAnnotList() {
  var rec = pdfViewer.pdfId && state.pdfs[pdfViewer.pdfId];
  return (rec && rec.annotations) || [];
}

export function triggerPdfUpload(subjectId) {
  if (!subjectId) return;
  pdfUploadTargetSubject = subjectId;
  $("pdf-file-input").value = "";
  $("pdf-file-input").click();
}

export function handlePdfFileSelected() {
  var file = $("pdf-file-input").files[0];
  var subjectId = pdfUploadTargetSubject;
  pdfUploadTargetSubject = null;
  if (!file || !subjectId) return;
  var isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) { window.alert("Chỉ nhận tệp PDF (.pdf)."); return; }
  if (!isOnline() && file.size > MAX_PDF_BYTES) { window.alert("Tệp PDF quá lớn (tối đa " + Math.round(MAX_PDF_BYTES / 1024 / 1024) + "MB)."); return; }
  // Đã đăng nhập: kích thước / số tệp của Môn / dung lượng còn trống theo hạn mức UC-33 (ghichu_hanmuc.js)
  var go = function () { uploadPdfForSubject(subjectId, file); };
  if (hooks.precheckUpload(file, { subjectId: subjectId, kind: "pdf" }, go)) go();
}

function uploadPdfForSubject(subjectId, file) {
  if (isOnline()) { uploadPdfToBackend(subjectId, file); return; }
  var sub = findSubject(subjectId);
  if (!sub) return;
  var id = genLocalId();
  var blobUrl = URL.createObjectURL(file);
  pdfBlobCache[id] = { file: file, blobUrl: blobUrl };
  state.pdfs[id] = { name: file.name, annotations: [] };
  sub.pdfs.push({ id: id, name: file.name });
  persist();
  selectPdf(subjectId, id);
}

function uploadPdfToBackend(subjectId, file) {
  var form = new FormData();
  form.append("file", file);
  apiUpload("/subjects/" + subjectId + "/pdf", authToken(), form).then(function (res) {
    if (!res.ok) {
      if (hooks.handleUploadError(res, file, { subjectId: subjectId, kind: "pdf" }, function () { uploadPdfToBackend(subjectId, file); })) return;
      window.alert((res.data && res.data.detail) || "Không tải lên được tệp PDF."); return;  // BR-14
    }
    hooks.afterUpload(res.data.original_name);
    var sub = findSubject(subjectId);
    if (!sub) return;
    var blobUrl = URL.createObjectURL(file);
    pdfBlobCache[res.data.id] = { file: file, blobUrl: blobUrl };
    state.pdfs[res.data.id] = { name: res.data.original_name, annotations: [] };
    sub.pdfs.push({ id: res.data.id, name: res.data.original_name });
    persist();
    selectPdf(subjectId, res.data.id);
  });
}

function loadPdfIntoViewer(pdfId) {
  var cached = pdfBlobCache[pdfId];
  if (cached) { openPdfViewerWithBlob(pdfId, cached.blobUrl); return; }

  var rec = state.pdfs[pdfId];
  if (isOnline() && rec) {
    apiAuthBlob("/pdf/" + pdfId + "/file", authToken()).then(function (res) {
      if (!res.ok || !res.blob) { window.alert("Không tải được tệp PDF từ server."); return; }
      var blobUrl = URL.createObjectURL(res.blob);
      pdfBlobCache[pdfId] = { file: null, blobUrl: blobUrl };
      openPdfViewerWithBlob(pdfId, blobUrl);
    });
    return;
  }

  window.alert('Tệp PDF gốc chỉ được giữ trong phiên làm việc hiện tại (bản thử nghiệm, chưa đăng nhập). Vui lòng chọn lại tệp "' + (rec ? rec.name : "") + '".');
  triggerPdfUpload(state.active ? state.active.s : null);
}

function openPdfViewerWithBlob(pdfId, blobUrl) {
  var rec = state.pdfs[pdfId];
  if (!rec) return;
  pdfViewer.open = true;
  pdfViewer.pdfId = pdfId;
  pdfViewer.fileName = rec.name;
  pdfViewer.pageW1 = null;
  pdfViewer.manualZoom = false;
  pdfViewer.scale = pdfDefaultScale();
  pdfViewer.tool = null;
  pdfViewer.currentPageNum = 1;
  switchEditorView();
  hooks.renderRibbon();
  renderPdfInlineToolbar();

  var loadAnnotations = isOnline()
    ? apiAuth("GET", "/pdf/" + pdfId + "/annotations", authToken()).then(function (res) {
        if (res.ok && Array.isArray(res.data)) {
          rec.annotations = res.data.map(function (a) {
            return { id: a.id, page: a.page_number, type: a.annotation_type, data: a.data };
          });
        }
      })
    : Promise.resolve();

  loadAnnotations.then(function () {
    window.pdfjsLib.getDocument(blobUrl).promise.then(function (doc) {
      if (pdfViewer.pdfId !== pdfId) { doc.destroy(); return; }
      pdfViewer.pdfDoc = doc;
      pdfViewer.numPages = doc.numPages;
      // Bề rộng thật của trang 1 -> tỉ lệ "vừa bề ngang" chính xác trên màn hẹp (pdfDefaultScale).
      doc.getPage(1).then(function (p1) {
        pdfViewer.pageW1 = p1.getViewport({ scale: 1 }).width;
        if (pdfViewer.pdfDoc === doc) pdfViewer.scale = pdfDefaultScale();
      }).catch(function () {}).then(function () {
        if (pdfViewer.pdfDoc !== doc) return;
        renderAllPdfPages();
        renderPdfInlineToolbar();
      });
      hooks.renderRibbon();   // nút của thẻ Draw (bút / hình / Hộp văn bản) chỉ bật khi PDF đã mở xong
      if (isOnline() && !rec.pageCountSynced) {
        rec.pageCountSynced = true;
        apiAuth("PATCH", "/pdf/" + pdfId + "/page-count", authToken(), { page_count: doc.numPages });
      }
    }).catch(function (err) {
      console.error("Không mở được PDF:", err);
      window.alert("Không mở được tệp PDF này (tệp có thể bị hỏng).");
      closePdfViewer();
    });
  });
}

function closePdfViewer() {
  if (pdfViewer.observer) { pdfViewer.observer.disconnect(); pdfViewer.observer = null; }
  if (pdfViewer.pdfDoc) { try { pdfViewer.pdfDoc.destroy(); } catch (e) {} }
  pdfViewer.open = false;
  pdfViewer.pdfDoc = null;
  pdfViewer.pdfId = null;
  pdfViewer.tool = null;
  pdfViewer.pages = [];
  pdfViewer.activePage = null;
  unmountPdfDrawLayers();
  $("pdf-pages-scroll").innerHTML = "";
  switchEditorView();
  hooks.renderRibbon();
}

// Nguồn sự thật duy nhất cho việc ẩn/hiện ck-host / editor-empty / pdf-host / thanh công cụ.
export function switchEditorView() {
  var isChapter = hasActiveChapter();
  var showPdf = pdfViewer.open;
  document.querySelector(".editor-shell").hidden = showPdf;
  var pwLocked = isChapter && !showPdf && chapterLocked();
  $("ck-host").hidden = !isChapter || showPdf || pwLocked;
  hooks.renderChapterLock(pwLocked);   // ghichu_review.js: màn "This chapter is password protected" 
  $("editor-empty").hidden = !!state.active || showPdf;
  $("pdf-host").hidden = !showPdf;
  $("pdf-inline-toolbar").hidden = !showPdf;
  $("doc-zoom-toolbar").hidden = !isChapter || showPdf;
  if (!isChapter) state.findOpen = false;
  $("find-box").hidden = !isChapter || !state.findOpen;
  $("btn-find-toggle").hidden = !isChapter || pwLocked;
  if (pwLocked) $("find-box").hidden = true;
}

/* ---- cuộn dọc liên tục: dựng + render tất cả các trang vào #pdf-pages-scroll ---- */
function renderAllPdfPages() {
  var container = $("pdf-pages-scroll");
  unmountPdfDrawLayers();
  container.innerHTML = "";
  pdfViewer.pages = [];
  pdfViewer.activePage = null;
  if (pdfViewer.observer) { pdfViewer.observer.disconnect(); pdfViewer.observer = null; }
  if (!pdfViewer.pdfDoc) return;

  var sized = [];
  for (var i = 1; i <= pdfViewer.numPages; i++) {
    (function (pageNum) {
      var wrap = el("div", "pdf-page-block");
      wrap.setAttribute("data-page", String(pageNum));
      var canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      var overlay = document.createElement("canvas");
      overlay.className = "pdf-overlay-canvas";
      var textboxLayer = el("div", "pdf-textbox-layer");
      var interactLayer = el("div", "pdf-interact-layer");
      var citeLayer = el("div", "pdf-cite-layer");   // khung vàng đoạn được trích dẫn (drawPdfHighlight)
      wrap.appendChild(canvas); wrap.appendChild(citeLayer); wrap.appendChild(overlay); wrap.appendChild(textboxLayer); wrap.appendChild(interactLayer);
      container.appendChild(wrap);

      var pageState = { num: pageNum, wrap: wrap, canvas: canvas, overlay: overlay, textboxLayer: textboxLayer, interactLayer: interactLayer, viewport: null };
      pdfViewer.pages.push(pageState);
      interactLayer.addEventListener("pointerdown", function (e) { pdfInteractDown(e, pageState); });

      sized.push(pdfViewer.pdfDoc.getPage(pageNum).then(function (page) {
        var viewport = page.getViewport({ scale: pdfViewer.scale });
        pageState.viewport = viewport;
        canvas.width = viewport.width; canvas.height = viewport.height;
        overlay.width = viewport.width; overlay.height = viewport.height;
        wrap.style.width = viewport.width + "px";
        wrap.style.height = viewport.height + "px";
        page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise.then(function () {
          var hl = pdfViewer.citeHL;   // phóng to / thu nhỏ: vẽ lại khung vàng theo tỉ lệ mới
          if (hl && hl.page === pageNum) drawPdfHighlight(pageState, hl.items, hl.from, hl.to);
          renderPdfAnnotationsForPage(pageState);
          renderPdfTextboxesForPage(pageState);
          if (pdfViewer.pages.indexOf(pageState) >= 0) pageState.dv = Ve.mountSurface(wrap, pdfDrawAdapter(pageState));
        });
      }));
    })(i);
  }

  // Cuộn tới trang đích chỉ khi mọi trang phía trước đã có kích thước thật (getPage bất đồng
  // bộ — cuộn sớm thì các khối trang còn cao 0px, sẽ rơi nhầm vị trí).
  if (pdfViewer.pendingPage) {
    var target = Math.min(pdfViewer.pendingPage, pdfViewer.numPages);
    pdfViewer.pendingPage = null;
    var find = citeFind && citeFind.kind === "pdf" && citeFind.id === pdfViewer.pdfId ? citeFind : null;
    citeFind = null;
    Promise.all(sized.slice(0, target)).then(function () {
      if (!find) { scrollToPdfPage(target); return; }
      // cuộn tới trang trước cho nhanh, tìm thấy câu thì cuộn tiếp tới đúng đoạn + bôi vàng
      scrollToPdfPage(target);
      locatePdfHighlight(find, sized);
    });
  }

  renderPdfInlineToolbar();
  pdfInteractCursor();
  setupPdfScrollObserver();
}

function setupPdfScrollObserver() {
  var root = document.querySelector(".editor-scroll");
  var visibility = {};
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var pageNum = parseInt(entry.target.getAttribute("data-page"), 10);
      visibility[pageNum] = entry.isIntersecting ? entry.intersectionRatio : 0;
    });
    var best = null, bestRatio = 0;
    Object.keys(visibility).forEach(function (k) {
      if (visibility[k] > bestRatio) { bestRatio = visibility[k]; best = parseInt(k, 10); }
    });
    if (best && best !== pdfViewer.currentPageNum) {
      pdfViewer.currentPageNum = best;
      renderPdfInlineToolbar();
    }
  }, { root: root, threshold: [0, 0.25, 0.5, 0.75, 1] });
  pdfViewer.pages.forEach(function (p) { observer.observe(p.wrap); });
  pdfViewer.observer = observer;
}

function renderPdfInlineToolbar() {
  $("pdf-page-indicator").textContent = "Trang " + pdfViewer.currentPageNum + "/" + pdfViewer.numPages;
  $("pdf-zoom-indicator").textContent = Math.round((pdfViewer.scale / PDF_BASE_SCALE) * 100) + "%";
  $("pdf-prev").disabled = pdfViewer.currentPageNum <= 1;
  $("pdf-next").disabled = pdfViewer.currentPageNum >= pdfViewer.numPages;
}

function scrollToPdfPage(pageNum) {
  var pageState = pdfViewer.pages[pageNum - 1];
  if (pageState && pageState.wrap.scrollIntoView) pageState.wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function pdfGoToPage(delta) {
  var next = pdfViewer.currentPageNum + delta;
  if (next < 1 || next > pdfViewer.numPages) return;
  scrollToPdfPage(next);
}

var pdfRefitTimer = null;
export function setPdfStudioFit(studioVisible) {
  var changed = studioVisible !== pdfStudioVisible;
  pdfStudioVisible = studioVisible;
  if (!pdfViewer.open) return;
  if (changed) { applyPdfDefaultScale(); return; }
  // Responsive: cùng trạng thái cột Studio nhưng cửa sổ đổi cỡ (xoay iPad, kéo cửa sổ) -> vừa lại bề ngang,
  // trừ khi người dùng đã tự phóng to / thu nhỏ. Màn rộng thì tỉ lệ mặc định không đổi nên không vẽ lại.
  if (pdfViewer.manualZoom) return;
  clearTimeout(pdfRefitTimer);
  pdfRefitTimer = setTimeout(function () {
    if (pdfViewer.open && !pdfViewer.manualZoom && Math.abs(pdfDefaultScale() - pdfViewer.scale) > 0.01) applyPdfDefaultScale();
  }, 200);
}
function applyPdfDefaultScale() {
  pdfViewer.scale = pdfDefaultScale();
  if (!pdfViewer.pdfDoc) return;
  pdfViewer.pendingPage = pdfViewer.currentPageNum > 1 ? pdfViewer.currentPageNum : null; // giữ trang đang đọc
  renderAllPdfPages();
  renderPdfInlineToolbar();
}

export function pdfZoom(delta) {
  // Sàn 50% như cũ; riêng khi tỉ lệ "vừa bề ngang" của màn hẹp đã < 50% thì sàn là tỉ lệ đó (nút − không phóng to ngược).
  var next = Math.max(Math.min(0.5, pdfViewer.scale), Math.min(3, pdfViewer.scale + delta));
  if (Math.abs(next - pdfViewer.scale) < 0.001) return;
  pdfViewer.manualZoom = true;
  pdfViewer.scale = next;
  if (pdfViewer.pdfDoc) renderAllPdfPages();
  if (state.tab === "View") hooks.renderRibbon();   // ô Zoom ở thẻ View đi theo
}

// Quy đổi toạ độ: PDF user-space (lưu trong DB/state) <-> pixel canvas hiện tại, theo viewport
// của ĐÚNG trang đang thao tác.
function pdfToView(viewport, pt) {
  var r = viewport.convertToViewportPoint(pt[0], pt[1]);
  return { x: r[0], y: r[1] };
}
function viewToPdf(viewport, x, y) {
  return viewport.convertToPdfPoint(x, y);
}

function renderPdfAnnotationsForPage(pageState) {
  var canvas = pageState.overlay;
  if (!canvas.width) return;
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  pdfAnnotList().filter(function (a) { return a.page === pageState.num; }).forEach(function (a) {
    if (a.type === "highlight") {
      var rect = a.data.rects[0];
      var p1 = pdfToView(pageState.viewport, [rect.x, rect.y]), p2 = pdfToView(pageState.viewport, [rect.x + rect.w, rect.y + rect.h]);
      ctx.save();
      ctx.globalAlpha = a.data.opacity != null ? a.data.opacity : 0.4;
      ctx.fillStyle = a.data.color;
      ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      ctx.restore();
    } else if (a.type === "draw" && false) {   // nét vẽ: lớp vẽ ghichu_ve.js (pdfDrawAdapter) vẽ — giữ code cũ để tham khảo
      ctx.save();
      ctx.strokeStyle = a.data.color; ctx.lineWidth = a.data.strokeWidth || 2.5;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      a.data.paths.forEach(function (path) {
        if (path.length < 2) return;
        ctx.beginPath();
        path.forEach(function (pt, i) {
          var v = pdfToView(pageState.viewport, pt);
          if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
        });
        ctx.stroke();
      });
      ctx.restore();
    }
    // 'textbox' render ở lớp DOM riêng (renderPdfTextboxesForPage).
  });
}

function renderPdfTextboxesForPage(pageState) {
  var layer = pageState.textboxLayer;
  layer.innerHTML = "";
  var scale = pdfViewer.scale;
  pdfAnnotList().filter(function (a) { return a.page === pageState.num && a.type === "textbox"; }).forEach(function (a) {
    var topLeft = pdfToView(pageState.viewport, [a.data.x, a.data.y + a.data.h]);
    var box = el("div", "pdf-textbox", esc(a.data.text));
    box.style.left = topLeft.x + "px";
    box.style.top = topLeft.y + "px";
    box.style.width = (a.data.w * scale) + "px";
    box.style.minHeight = (a.data.h * scale) + "px";
    box.style.color = a.data.color;
    box.style.fontSize = (a.data.fontSize * scale) + "px";
    box.style.letterSpacing = (a.data.letterSpacing || 0) + "em";
    wireExistingTextbox(box, a, pageState);
    layer.appendChild(box);
  });
}

// Textbox đã tạo (không còn ở chế độ soạn) vẫn phải thao tác được: kéo -> đổi vị trí; bấm
// (không kéo) -> mở lại ô soạn để sửa nội dung. Cả 2 đều UPDATE annotation đã có.
function wireExistingTextbox(box, annotation, pageState) {
  box.addEventListener("pointerdown", function (e) {
    if (pdfViewer.tool || isViewOnly()) return;
    e.stopPropagation();
    e.preventDefault();
    var startX = e.clientX, startY = e.clientY;
    var startLeft = parseFloat(box.style.left), startTop = parseFloat(box.style.top);
    var moved = false;
    if (box.setPointerCapture) { try { box.setPointerCapture(e.pointerId); } catch (err) {} }

    function onMove(ev) {
      var dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > TEXTBOX_DRAG_THRESHOLD || Math.abs(dy) > TEXTBOX_DRAG_THRESHOLD)) {
        moved = true;
        box.classList.add("dragging");
      }
      if (moved) { box.style.left = (startLeft + dx) + "px"; box.style.top = (startTop + dy) + "px"; }
    }
    function onUp() {
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.classList.remove("dragging");
      if (moved) commitTextboxMove(annotation, pageState, parseFloat(box.style.left), parseFloat(box.style.top));
      else openTextboxEditor(box, annotation, pageState);
    }
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
  });
}

function commitTextboxMove(annotation, pageState, newLeftPx, newTopPx) {
  var topLeftPdf = viewToPdf(pageState.viewport, newLeftPx, newTopPx);
  var bottomLeftPdf = viewToPdf(pageState.viewport, newLeftPx, newTopPx + annotation.data.h * pdfViewer.scale);
  annotation.data = Object.assign({}, annotation.data, { x: topLeftPdf[0], y: bottomLeftPdf[1] });
  renderPdfAnnotationsForPage(pageState);
  renderPdfTextboxesForPage(pageState);
  syncAnnotationUpdate(annotation);
}

// Bấm (không kéo) mở lại ô soạn (có thanh định dạng) — commit xong (blur) thì UPDATE annotation cũ; xoá sạch nội dung
// hoặc bấm Xoá trên thanh = xoá hẳn annotation.
function openTextboxEditor(box, annotation, pageState) {
  var d = annotation.data;
  var left = parseFloat(box.style.left), top = parseFloat(box.style.top), width = box.style.width;
  box.remove();
  editPdfTextbox(pageState, {
    left: left, top: top, width: width, text: d.text,
    color: d.color, fontSize: d.fontSize, letterSpacing: d.letterSpacing || 0, fontFamily: d.fontFamily, select: true,
  }, function (r) {
    if (!r) { deleteAnnotationDirect(annotation, pageState); return; }
    annotation.data = Object.assign({}, r, { fontFamily: d.fontFamily || r.fontFamily });
    renderPdfAnnotationsForPage(pageState);
    renderPdfTextboxesForPage(pageState);
    syncAnnotationUpdate(annotation);
  }, function () { renderPdfTextboxesForPage(pageState); });
}

function syncAnnotationUpdate(annotation) {
  if (!isOnline() || !pdfViewer.pdfId || String(annotation.id).indexOf("local-") === 0) return;
  apiAuth("PUT", "/pdf/annotations/" + annotation.id, authToken(), { data: annotation.data });
}

function deleteAnnotationDirect(annotation, pageState) {
  var rec = state.pdfs[pdfViewer.pdfId];
  if (rec) rec.annotations = rec.annotations.filter(function (a) { return a.id !== annotation.id; });
  persist();
  renderPdfAnnotationsForPage(pageState);
  renderPdfTextboxesForPage(pageState);
  if (isOnline() && String(annotation.id).indexOf("local-") !== 0) apiAuth("DELETE", "/pdf/annotations/" + annotation.id, authToken());
}

/* ---- Tương tác chuột trên overlay: vẽ highlight/draw/textbox, xoá ---- */
function pdfPointerPos(e, pageState) {
  var canvas = pageState.overlay;
  var r = canvas.getBoundingClientRect();
  var scaleX = canvas.width / r.width, scaleY = canvas.height / r.height;
  var p = e.touches ? e.touches[0] : e;
  return { x: (p.clientX - r.left) * scaleX, y: (p.clientY - r.top) * scaleY };
}

function pdfInteractCursor() {
  var host = $("pdf-host");
  host.classList.remove("tool-textbox", "tool-erase", "tool-draw", "tool-highlight");
  if (pdfViewer.tool) host.classList.add("tool-" + pdfViewer.tool);
  host.classList.toggle("has-tool", !!pdfViewer.tool);
}

// Esc thoát chế độ công cụ chú thích PDF đang chọn (Textbox/Tô màu/Vẽ/Xoá) — gọi từ phím tắt
// toàn cục ở ghichu.js.
export function exitPdfTool() {
  pdfViewer.tool = null;
  hooks.renderRibbon();
  pdfInteractCursor();
}

function pdfInteractDown(e, pageState) {
  if (!pdfViewer.tool || !pageState.viewport || isViewOnly()) return;
  e.preventDefault();
  pdfViewer.activePage = pageState;
  var pos = pdfPointerPos(e, pageState);
  if (pdfViewer.tool === "textbox") { startPdfTextbox(pos, pageState); return; }
  if (pdfViewer.tool === "erase") { erasePdfAnnotationAt(pos, pageState); return; }
  var pdfPt = viewToPdf(pageState.viewport, pos.x, pos.y);
  pdfViewer.dragging = true;
  if (pdfViewer.tool === "highlight") {
    pdfViewer.dragStartPdf = pdfPt;
  } else if (pdfViewer.tool === "draw") {
    pdfViewer.strokePdf = [pdfPt];
  }
}

export function pdfInteractMove(e) {
  var pageState = pdfViewer.activePage;
  if (!pdfViewer.dragging || !pageState) return;
  e.preventDefault();
  var pos = pdfPointerPos(e, pageState);
  if (pdfViewer.tool === "highlight") {
    renderPdfAnnotationsForPage(pageState);
    var ctx = pageState.overlay.getContext("2d");
    var p1 = pdfToView(pageState.viewport, pdfViewer.dragStartPdf);
    ctx.save();
    ctx.globalAlpha = 0.4; ctx.fillStyle = pdfViewer.color;
    ctx.fillRect(Math.min(p1.x, pos.x), Math.min(p1.y, pos.y), Math.abs(pos.x - p1.x), Math.abs(pos.y - p1.y));
    ctx.restore();
  } else if (pdfViewer.tool === "draw") {
    var pdfPt = viewToPdf(pageState.viewport, pos.x, pos.y);
    var last = pdfViewer.strokePdf[pdfViewer.strokePdf.length - 1];
    pdfViewer.strokePdf.push(pdfPt);
    var ctx2 = pageState.overlay.getContext("2d");
    var lastView = pdfToView(pageState.viewport, last);
    ctx2.save();
    ctx2.strokeStyle = pdfViewer.color; ctx2.lineWidth = 2.5; ctx2.lineCap = "round"; ctx2.lineJoin = "round";
    ctx2.beginPath(); ctx2.moveTo(lastView.x, lastView.y); ctx2.lineTo(pos.x, pos.y); ctx2.stroke();
    ctx2.restore();
  }
}

export function pdfInteractUp(e) {
  var pageState = pdfViewer.activePage;
  if (!pdfViewer.dragging || !pageState) return;
  pdfViewer.dragging = false;
  var pos = pdfPointerPos(e, pageState);
  if (pdfViewer.tool === "highlight") {
    var start = pdfViewer.dragStartPdf, end = viewToPdf(pageState.viewport, pos.x, pos.y);
    var x = Math.min(start[0], end[0]), y = Math.min(start[1], end[1]);
    var w = Math.abs(end[0] - start[0]), h = Math.abs(end[1] - start[1]);
    pdfViewer.dragStartPdf = null;
    if (w < 3 || h < 3) { renderPdfAnnotationsForPage(pageState); return; }
    addPdfAnnotation(pageState.num, "highlight", { rects: [{ x: x, y: y, w: w, h: h }], color: pdfViewer.color, opacity: 0.4 });
  } else if (pdfViewer.tool === "draw") {
    var pts = pdfViewer.strokePdf;
    pdfViewer.strokePdf = null;
    if (!pts || pts.length < 2) { renderPdfAnnotationsForPage(pageState); return; }
    addPdfAnnotation(pageState.num, "draw", { color: pdfViewer.color, strokeWidth: 2.5, paths: [pts] });
  }
}

function startPdfTextbox(pos, pageState) {
  var st = pdfViewer.tbStyle || { color: "#050d2b", fontSize: 15 / pdfViewer.scale, letterSpacing: 0 };
  editPdfTextbox(pageState, {
    left: pos.x, top: pos.y, width: "180px", text: "",
    color: st.color, fontSize: st.fontSize, letterSpacing: st.letterSpacing, fontFamily: "Figtree, sans-serif",
  }, function (r) { if (r) addPdfAnnotation(pageState.num, "textbox", r); }, null);
}

/* ---- Trình soạn hộp văn bản PDF + thanh định dạng nổi (theo mẫu: Màu chữ ⌄ | Tăng / Giảm cỡ chữ | Giãn / Co khoảng cách
   chữ | Xoá). Kiểu chữ áp cho cả hộp; hộp mới lấy kiểu của lần chỉnh gần nhất (pdfViewer.tbStyle) như Word.
   fontSize lưu theo đơn vị PDF (px hiển thị = fontSize × scale), letterSpacing theo em. onDone(null) = rỗng / bấm Xoá. ---- */
var TB_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
var TB_LS_STEP = 0.05, TB_LS_MIN = -0.1, TB_LS_MAX = 0.5;
var TB_COLORS = ["#050d2b", "#495057", "#e03131", "#e8590c", "#f08c00", "#2f9e44", "#0c8599", "#1971c2", "#004f8b", "#7048e8", "#c2255c", "#ffffff"];
var tbBar = null, tbCur = null;
var ICO_TB = {
  color: function (c) { return '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M6.5 14.5L11 4l4.5 10.5M8.2 10.6h5.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="16.5" width="14" height="3.2" rx=".6" fill="' + c + '" stroke="rgba(0,0,0,.25)" stroke-width=".6"/></svg>'; },
  grow: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 18L9 5l5.5 13M5.6 13.4h6.8"/><path d="M15 6.5l2.2-2.5 2.3 2.5"/></svg>',
  shrink: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 18L9 5l5.5 13M5.6 13.4h6.8"/><path d="M15 4l2.2 2.5L19.5 4"/></svg>',
  wide: '<svg width="24" height="22" viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L6.5 3 10 12M4.3 8.8h4.4M12 3l3.5 9L19 3"/><path d="M3 17.5h18M3 17.5l2-1.8M3 17.5l2 1.8M21 17.5l-2-1.8M21 17.5l-2 1.8"/></svg>',
  narrow: '<svg width="24" height="22" viewBox="0 0 24 22" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12L6.5 3 10 12M4.3 8.8h4.4M12 3l3.5 9L19 3"/><path d="M3 17.5h6.5M9.5 17.5l-2-1.8M9.5 17.5l-2 1.8M21 17.5h-6.5M14.5 17.5l2-1.8M14.5 17.5l2 1.8"/></svg>',
  del: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.3 5.5l.8 11h7.8l.8-11M8.3 8.5v5M11.7 8.5v5"/></svg>',
};

function editPdfTextbox(pageState, init, onDone, onCancel) {
  hideTbBar();
  var layer = pageState.textboxLayer;
  var ta = document.createElement("textarea");
  ta.className = "pdf-textbox pdf-textbox-editing";
  ta.placeholder = "Start typing here…";
  ta.style.left = init.left + "px";
  ta.style.top = init.top + "px";
  ta.style.width = init.width;
  ta.value = init.text || "";
  var st = { color: init.color || "#050d2b", fontSize: init.fontSize || 15 / pdfViewer.scale, letterSpacing: init.letterSpacing || 0 };
  var apply = function () {
    ta.style.color = st.color;
    ta.style.fontSize = (st.fontSize * pdfViewer.scale) + "px";
    ta.style.letterSpacing = st.letterSpacing + "em";
    pdfViewer.tbStyle = { color: st.color, fontSize: st.fontSize, letterSpacing: st.letterSpacing };
    if (tbCur && tbCur.ta === ta) renderTbBar();
  };
  apply();
  layer.appendChild(ta);
  ta.focus();
  if (init.select) ta.select();
  var finished = false;
  var finish = function (deleteIt) {
    if (finished) return;
    finished = true;
    ta.removeEventListener("blur", onBlur);
    document.removeEventListener("pointerdown", onOutside, true);
    hideTbBar();
    var text = ta.value.trim();
    var w = ta.offsetWidth, h = ta.offsetHeight;
    var left = parseFloat(ta.style.left), top = parseFloat(ta.style.top);
    ta.remove();
    if (deleteIt || !text) { onDone(null); return; }
    var topLeftPdf = viewToPdf(pageState.viewport, left, top);
    var bottomLeftPdf = viewToPdf(pageState.viewport, left, top + h);
    onDone({
      x: topLeftPdf[0], y: bottomLeftPdf[1], w: w / pdfViewer.scale, h: h / pdfViewer.scale,
      text: text, fontSize: st.fontSize, color: st.color, letterSpacing: st.letterSpacing, fontFamily: init.fontFamily || "Figtree, sans-serif",
    });
  };
  var onBlur = function () {
    // Bấm vào thanh định dạng / bảng màu thì không coi là rời hộp
    setTimeout(function () {
      if (finished) return;
      var a = document.activeElement;
      if (a === ta || (tbBar && tbBar.contains(a)) || (a && a.closest && a.closest("#dd-panel"))) return;
      finish(false);
    }, 0);
  };
  // Ô chữ đã mất focus (vd. vừa mở / huỷ hộp chọn màu khác) mà người dùng bấm ra chỗ khác -> vẫn chốt hộp.
  var onOutside = function (e) {
    var t = e.target;
    if (ta.contains(t) || (tbBar && tbBar.contains(t)) || (t.closest && t.closest("#dd-panel"))) return;
    if (document.activeElement !== ta) finish(false);
  };
  ta.addEventListener("blur", onBlur);
  document.addEventListener("pointerdown", onOutside, true);
  ta.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      finished = true; ta.removeEventListener("blur", onBlur); document.removeEventListener("pointerdown", onOutside, true); hideTbBar(); ta.remove();
      if (onCancel) onCancel();
    }
  });
  tbCur = { ta: ta, st: st, apply: apply, finish: finish };
  showTbBar();
}

function showTbBar() {
  if (!tbBar) {
    tbBar = el("div", "ptb-bar");
    tbBar.setAttribute("role", "toolbar");
    tbBar.setAttribute("aria-label", "Text box formatting");
    // giữ con trỏ trong ô chữ khi bấm nút (trừ ô chọn màu khác)
    tbBar.addEventListener("mousedown", function (e) { if (!e.target.closest("input")) e.preventDefault(); });
    document.body.appendChild(tbBar);
    window.addEventListener("scroll", placeTbBar, true);
    window.addEventListener("resize", placeTbBar);
  }
  renderTbBar();
  tbBar.classList.add("show");
  placeTbBar();
}
function hideTbBar() {
  if (tbBar) tbBar.classList.remove("show");
  if (state.dd && state.dd.id === "textboxcolor") hooks.closeFloating();
  tbCur = null;
}
function placeTbBar() {
  if (!tbBar || !tbCur || !tbBar.classList.contains("show")) return;
  var r = tbCur.ta.getBoundingClientRect(), bw = tbBar.offsetWidth || 300;
  var top = r.top - tbBar.offsetHeight - 10;
  if (top < 8) top = r.bottom + 10;
  tbBar.style.left = Math.max(8, Math.min(r.left, window.innerWidth - bw - 8)) + "px";
  tbBar.style.top = top + "px";
}
function renderTbBar() {
  if (!tbCur) return;
  var st = tbCur.st, curPt = Math.round(st.fontSize * 10) / 10;
  var b = function (act, title, html, dis) {
    return '<button type="button" class="ptb-btn" data-tb="' + act + '" title="' + title + '"' + (dis ? " disabled" : "") + ">" + html + "</button>";
  };
  tbBar.innerHTML =
    '<button type="button" class="ptb-btn ptb-color" data-tb="color" title="Font Color">' + ICO_TB.color(st.color) +
    '<svg class="ptb-chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
    '<span class="ptb-sep"></span>' +
    b("grow", "Increase Font Size (" + curPt + " pt)", ICO_TB.grow, curPt >= TB_SIZES[TB_SIZES.length - 1]) +
    b("shrink", "Decrease Font Size (" + curPt + " pt)", ICO_TB.shrink, curPt <= TB_SIZES[0]) +
    '<span class="ptb-sep"></span>' +
    b("wide", "Increase Character Spacing", ICO_TB.wide, st.letterSpacing >= TB_LS_MAX - 1e-6) +
    b("narrow", "Decrease Character Spacing", ICO_TB.narrow, st.letterSpacing <= TB_LS_MIN + 1e-6) +
    '<span class="ptb-sep"></span>' +
    b("del", "Delete", ICO_TB.del, false);
  tbBar.querySelectorAll("[data-tb]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var cur = tbCur; if (!cur) return;
      var a = btn.getAttribute("data-tb"), s2 = cur.st, pt = Math.round(s2.fontSize * 10) / 10;
      if (a === "color") { openTextboxColorPicker(btn, s2.color, function (c) { s2.color = c; cur.apply(); }); return; }
      if (a === "grow") s2.fontSize = TB_SIZES.filter(function (x) { return x > pt + 0.01; })[0] || s2.fontSize;
      if (a === "shrink") s2.fontSize = TB_SIZES.filter(function (x) { return x < pt - 0.01; }).pop() || s2.fontSize;
      if (a === "wide") s2.letterSpacing = Math.min(TB_LS_MAX, Math.round((s2.letterSpacing + TB_LS_STEP) * 100) / 100);
      if (a === "narrow") s2.letterSpacing = Math.max(TB_LS_MIN, Math.round((s2.letterSpacing - TB_LS_STEP) * 100) / 100);
      if (a === "del") { cur.finish(true); return; }
      cur.apply();
      cur.ta.focus();
      placeTbBar();
    });
  });
}

// Bảng màu chữ của hộp văn bản (mở từ nút Font Color của thanh định dạng).
function openTextboxColorPicker(anchor, currentColor, onPick) {
  var r = anchor.getBoundingClientRect();
  var html = '<div class="ptb-colors"><div class="dd-label">Font Color</div><div class="ptb-swatches">' + TB_COLORS.map(function (c) {
    return '<button type="button" class="dd-swatch' + (currentColor === c ? " on" : "") + '" style="background:' + c + '" data-color="' + c + '" title="' + c + '"></button>';
  }).join("") + '</div><label class="ptb-more">More Colors…<input type="color" value="' + (/^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#050d2b") + '"></label></div>';
  openDropdown("textboxcolor", r.left, r.bottom + 6, html, function (panel) {
    var back = function () { if (tbCur) tbCur.ta.focus(); };
    panel.querySelectorAll("[data-color]").forEach(function (b) {
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        onPick(b.getAttribute("data-color"));
        hooks.closeFloating();
        back();
      });
    });
    var inp = panel.querySelector("input[type=color]");
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    inp.addEventListener("change", function () { onPick(inp.value); hooks.closeFloating(); back(); });
  });
}

function buildPdfColorDropdown() {
  return {
    html: '<div class="dd-color-row">' + PDF_ANNOT_COLORS.map(function (c) {
      return '<button type="button" class="dd-swatch' + (pdfViewer.color === c ? " on" : "") + '" style="background:' + c + '" data-color="' + c + '" title="' + c + '"></button>';
    }).join("") + "</div>",
    bind: function (panel) {
      panel.querySelectorAll("[data-color]").forEach(function (b) {
        b.addEventListener("click", function () { pdfViewer.color = b.getAttribute("data-color"); hooks.closeFloating(); });
      });
    },
  };
}

export function buildPdfAnnotationRibbon() {
  var frag = document.createDocumentFragment();
  frag.appendChild(buildGroup(PDF_TOOLS.map(function (t) {
    return btnToggle(t.glyph, t.label, pdfViewer.tool === t.key, function () {
      pdfViewer.tool = (pdfViewer.tool === t.key) ? null : t.key;
      hooks.renderRibbon();
      pdfInteractCursor();
    }, !pdfViewer.pdfDoc || isViewOnly());   // được chia sẻ chỉ xem: không chú thích
  })));
  var colorDd = buildPdfColorDropdown();
  frag.appendChild(buildGroup([
    btnTextDropdown("🎨", "Màu", function () {}, !pdfViewer.pdfDoc || isViewOnly(), "pdfcolor", 190, function () { return colorDd.html; }, colorDd.bind),
  ]));
  return frag;
}

// Vẽ lên overlay ngay (optimistic, id tạm "local-...") rồi mới POST /pdf/{document_id}/
// annotations nền.
function addPdfAnnotation(pageNum, type, data) {
  var rec = state.pdfs[pdfViewer.pdfId];
  if (!rec) return;
  var entry = { id: genLocalId(), page: pageNum, type: type, data: data };
  rec.annotations.push(entry);
  persist();
  var pageState = pdfViewer.pages[pageNum - 1];
  if (pageState) { renderPdfAnnotationsForPage(pageState); renderPdfTextboxesForPage(pageState); }
  if (isOnline() && pdfViewer.pdfId) {
    apiAuth("POST", "/pdf/" + pdfViewer.pdfId + "/annotations", authToken(), {
      page_number: pageNum, annotation_type: type, data: data,
    }).then(function (res) {
      if (res.ok && res.data && res.data.id) { entry.id = res.data.id; persist(); }
    });
  }
}

function erasePdfAnnotationAt(pos, pageState) {
  var rec = state.pdfs[pdfViewer.pdfId];
  if (!rec) return;
  var list = rec.annotations;
  for (var i = list.length - 1; i >= 0; i--) {
    var a = list[i];
    if (a.page !== pageState.num) continue;
    if (pdfAnnotationHit(a, pos, pageState.viewport)) {
      list.splice(i, 1);
      persist();
      renderPdfAnnotationsForPage(pageState);
      renderPdfTextboxesForPage(pageState);
      if (isOnline() && String(a.id).indexOf("local-") !== 0) {
        apiAuth("DELETE", "/pdf/annotations/" + a.id, authToken());
      }
      return;
    }
  }
}

function pdfAnnotationHit(a, pos, viewport) {
  if (a.type === "highlight") {
    var r = a.data.rects[0];
    var p1 = pdfToView(viewport, [r.x, r.y]), p2 = pdfToView(viewport, [r.x + r.w, r.y + r.h]);
    return pos.x >= Math.min(p1.x, p2.x) && pos.x <= Math.max(p1.x, p2.x) && pos.y >= Math.min(p1.y, p2.y) && pos.y <= Math.max(p1.y, p2.y);
  }
  if (a.type === "textbox") {
    var topLeft = pdfToView(viewport, [a.data.x, a.data.y + a.data.h]);
    var w = a.data.w * pdfViewer.scale, h = a.data.h * pdfViewer.scale;
    return pos.x >= topLeft.x && pos.x <= topLeft.x + w && pos.y >= topLeft.y && pos.y <= topLeft.y + h;
  }
  if (a.type === "draw") {
    var hitRadius = 10;
    return a.data.paths.some(function (path) {
      return path.some(function (pt) {
        var v = pdfToView(viewport, pt);
        return Math.abs(v.x - pos.x) <= hitRadius && Math.abs(v.y - pos.y) <= hitRadius;
      });
    });
  }
  return false;
}

/* ====================================================================
   Download / In — dùng CHUNG cho cả Chương lẫn File PDF (nút ở thẻ File,
   ghichu_chucnangcacthe.js dựng UI 2 nút và gọi 2 hàm dispatch dưới cùng):
   Chương thì "chụp" nội dung CKEditor đang hiển thị bằng html2canvas rồi
   ghép trang qua jsPDF; File PDF thì dựng lại từng trang bằng chính
   pdfViewer.pdfDoc (PDF.js) + annotation hiện có, vẽ đè lên 1 canvas raster
   độ phân giải cao rồi cũng ghép bằng jsPDF. Không đụng file/nội dung gốc
   trên server; kết quả chỉ tồn tại dưới dạng Blob tạm trong trình duyệt
   (không lưu DB).
   ==================================================================== */
var PDF_EXPORT_SCALE = 2.5; // độ phân giải raster khi xuất/tải/in File PDF
var CHAPTER_EXPORT_SCALE = 2; // độ phân giải raster khi html2canvas "chụp" nội dung Chương
export var fileExportBusy = false; // đang ghép Download/In (Chương HOẶC File PDF) — dùng chung để chặn bấm chồng

function sanitizeFileName(name) {
  return (name || "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "tai-lieu";
}

function pdfWrapTextForExport(ctx, text, maxWidthPx) {
  var lines = [];
  (text || "").split("\n").forEach(function (rawLine) {
    var words = rawLine.split(" ");
    var current = "";
    words.forEach(function (word) {
      var test = current ? current + " " + word : word;
      if (current && ctx.measureText(test).width > maxWidthPx) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    });
    lines.push(current);
  });
  return lines;
}

function drawAnnotationsForExport(ctx, viewport, pageNum) {
  pdfAnnotList().filter(function (a) { return a.page === pageNum; }).forEach(function (a) {
    if (a.type === "highlight") {
      var rect = a.data.rects[0];
      var p1 = pdfToView(viewport, [rect.x, rect.y]), p2 = pdfToView(viewport, [rect.x + rect.w, rect.y + rect.h]);
      ctx.save();
      ctx.globalAlpha = a.data.opacity != null ? a.data.opacity : 0.4;
      ctx.fillStyle = a.data.color;
      ctx.fillRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      ctx.restore();
    } else if (a.type === "draw" || a.type === "shape") {
      Ve.drawItemsToCanvas(ctx, [normalizeDrawData(a)], function (pt) { var v = pdfToView(viewport, pt); return [v.x, v.y]; }, viewport.scale);
    } else if (a.type === "draw-legacy") {
      ctx.save();
      ctx.strokeStyle = a.data.color;
      ctx.lineWidth = (a.data.strokeWidth || 2.5) * (viewport.scale / PDF_BASE_SCALE);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      a.data.paths.forEach(function (path) {
        if (path.length < 2) return;
        ctx.beginPath();
        path.forEach(function (pt, i) {
          var v = pdfToView(viewport, pt);
          if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
        });
        ctx.stroke();
      });
      ctx.restore();
    } else if (a.type === "textbox") {
      var topLeft = pdfToView(viewport, [a.data.x, a.data.y + a.data.h]);
      var fontPx = a.data.fontSize * viewport.scale;
      var widthPx = a.data.w * viewport.scale;
      ctx.save();
      ctx.fillStyle = a.data.color;
      ctx.font = fontPx + "px " + (a.data.fontFamily || "Inter, sans-serif");
      if ("letterSpacing" in ctx) ctx.letterSpacing = ((a.data.letterSpacing || 0) * fontPx) + "px";
      ctx.textBaseline = "top";
      var lineHeight = fontPx * 1.3;
      pdfWrapTextForExport(ctx, a.data.text, widthPx).forEach(function (line, i) {
        ctx.fillText(line, topLeft.x, topLeft.y + i * lineHeight);
      });
      ctx.restore();
    }
  });
}

function renderPdfPageForExport(pageNum) {
  return pdfViewer.pdfDoc.getPage(pageNum).then(function (page) {
    var viewport = page.getViewport({ scale: PDF_EXPORT_SCALE });
    var canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    var ctx = canvas.getContext("2d");
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
      drawAnnotationsForExport(ctx, viewport, pageNum);
      var baseViewport = page.getViewport({ scale: 1 });
      return { canvas: canvas, widthPt: baseViewport.width, heightPt: baseViewport.height };
    });
  });
}

function buildAnnotatedPdfDoc() {
  var jsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!pdfViewer.pdfDoc || !jsPDF) return Promise.reject(new Error("pdf-export-unavailable"));

  var doc = null;
  var chain = Promise.resolve();
  for (var i = 1; i <= pdfViewer.numPages; i++) {
    (function (pageNum) {
      chain = chain.then(function () { return renderPdfPageForExport(pageNum); }).then(function (p) {
        var orientation = p.widthPt >= p.heightPt ? "l" : "p";
        if (!doc) doc = new jsPDF({ orientation: orientation, unit: "pt", format: [p.widthPt, p.heightPt] });
        else doc.addPage([p.widthPt, p.heightPt], orientation);
        doc.addImage(p.canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, p.widthPt, p.heightPt);
      });
    })(i);
  }
  return chain.then(function () { return doc; });
}

function triggerBlobDownload(blob, fileName) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function downloadAnnotatedPdf() {
  if (!pdfViewer.pdfDoc || fileExportBusy) return;
  fileExportBusy = true;
  hooks.renderRibbon();
  buildAnnotatedPdfDoc().then(function (doc) {
    triggerBlobDownload(doc.output("blob"), pdfViewer.fileName || "tai-lieu.pdf");
  }).catch(function (err) {
    console.error("Không tạo được PDF để tải xuống:", err);
    window.alert("Không tạo được file PDF để tải xuống. Vui lòng thử lại.");
  }).then(function () { fileExportBusy = false; hooks.renderRibbon(); });
}

function printAnnotatedPdf() {
  if (!pdfViewer.pdfDoc || fileExportBusy) return;
  fileExportBusy = true;
  hooks.renderRibbon();
  buildAnnotatedPdfDoc().then(function (doc) {
    doc.autoPrint();
    var win = window.open(doc.output("bloburl"), "_blank");
    if (!win) window.alert("Trình duyệt đã chặn cửa sổ in. Vui lòng cho phép pop-up cho trang này rồi thử lại.");
  }).catch(function (err) {
    console.error("Không chuẩn bị được bản in:", err);
    window.alert("Không chuẩn bị được bản in. Vui lòng thử lại.");
  }).then(function () { fileExportBusy = false; hooks.renderRibbon(); });
}

// Các mốc "an toàn" để cắt trang khi tải Chương thành PDF — mép DƯỚI (px canvas, đã nhân
// CHAPTER_EXPORT_SCALE) của từng phần tử KHÔNG được phép bị cắt ngang.
function computeChapterPageBreakpoints(target, scale) {
  var targetTop = target.getBoundingClientRect().top;
  var nodes = target.querySelectorAll(".ck-content > *, li, tr, img, blockquote, pre, figure, hr");
  var bottoms = [];
  nodes.forEach(function (elNode) {
    var r = elNode.getBoundingClientRect();
    if (r.height > 0) bottoms.push((r.bottom - targetTop) * scale);
  });
  bottoms.sort(function (a, b) { return a - b; });
  return bottoms;
}

function downloadChapterPdf() {
  if (!hasActiveChapter() || fileExportBusy) return;
  var jsPDF = window.jspdf && window.jspdf.jsPDF;
  var target = document.querySelector(".editor-shell");
  if (!jsPDF || !window.html2canvas || !target) {
    window.alert("Chưa tải được công cụ xuất PDF. Vui lòng tải lại trang rồi thử lại.");
    return;
  }

  fileExportBusy = true;
  hooks.renderRibbon();
  var zoomBefore = target.style.zoom;
  target.style.zoom = "";   // xuất PDF luôn ở cỡ 100%, không theo mức zoom đang xem
  var breakpoints = computeChapterPageBreakpoints(target, CHAPTER_EXPORT_SCALE);
  window.html2canvas(target, {
    scale: CHAPTER_EXPORT_SCALE,
    useCORS: true,
    backgroundColor: "#ffffff",
    onclone: function (clonedDoc) { clonedDoc.documentElement.setAttribute("data-theme", "light"); },
  }).then(function (canvas) {
    var pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
    var pageWidthPt = pdf.internal.pageSize.getWidth();
    var pageHeightPt = pdf.internal.pageSize.getHeight();
    var pxPerPagePt = canvas.width / pageWidthPt;
    var idealSliceHeightPx = pageHeightPt * pxPerPagePt;
    var renderedPx = 0;
    var firstPage = true;
    while (renderedPx < canvas.height) {
      var idealEnd = Math.min(renderedPx + idealSliceHeightPx, canvas.height);
      var cut = idealEnd;
      if (idealEnd < canvas.height) {
        for (var i = breakpoints.length - 1; i >= 0; i--) {
          if (breakpoints[i] > renderedPx && breakpoints[i] <= idealEnd) { cut = breakpoints[i]; break; }
        }
      }
      var thisSliceHeightPx = cut - renderedPx;
      var sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = thisSliceHeightPx;
      sliceCanvas.getContext("2d").drawImage(
        canvas, 0, renderedPx, canvas.width, thisSliceHeightPx, 0, 0, canvas.width, thisSliceHeightPx
      );
      var sliceHeightPt = thisSliceHeightPx / pxPerPagePt;
      if (!firstPage) pdf.addPage();
      pdf.addImage(sliceCanvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageWidthPt, sliceHeightPt);
      renderedPx = cut;
      firstPage = false;
    }
    triggerBlobDownload(pdf.output("blob"), sanitizeFileName(activeItemName()) + ".pdf");
  }).catch(function (err) {
    console.error("Không tạo được PDF cho ghi chú:", err);
    window.alert("Không tạo được file PDF để tải xuống. Vui lòng thử lại.");
  }).then(function () { target.style.zoom = zoomBefore; fileExportBusy = false; hooks.renderRibbon(); });
}

// Điều phối chung cho 2 nút "Download"/"In" ở thẻ File (UI dựng ở ghichu_chucnangcacthe.js) —
// áp dụng như nhau cho cả Chương lẫn File PDF, chỉ khác cơ chế dựng PDF bên dưới.
export function downloadCurrentContent() {
  if (pdfViewer.open) { downloadAnnotatedPdf(); return; }
  if (hasActiveChapter()) { downloadChapterPdf(); return; }
}
export function printCurrentContent() {
  if (pdfViewer.open) { printAnnotatedPdf(); return; }
  if (hasActiveChapter()) { window.print(); return; } // giữ nguyên UC-17 (đã có sẵn CSS @media print)
}

/* ====================================================================
   Chọn Chương/File PDF hiện hành + đổ nội dung vào khung soạn/xem
   ==================================================================== */

/* ====================================================================
   Bôi vàng đoạn được trích dẫn khi bấm "Nguồn" (UC-20 5a + nguồn của Ôn tập / Thi thử / Flashcard / Sơ đồ)
   - Chương: tìm câu trong vùng soạn thảo CKEditor, bôi bằng CSS Custom Highlight API (KHÔNG sửa nội dung → không
     bị lưu vào Chương), cuộn tới; xoá khi người học gõ / mở mục khác.
   - PDF: tìm câu trong lớp chữ của trang (PDF.js getTextContent) — thử trang được trích rồi trang kề bên — vẽ
     khung vàng lên lớp .pdf-cite-layer của trang đó, cuộn tới; phóng to / thu nhỏ thì vẽ lại.
   So khớp bỏ hết khoảng trắng + chữ thường (nguồn trích từ văn bản thuần nên xuống dòng/khoảng trắng khác HTML/PDF);
   không khớp nguyên câu thì thử khúc đầu/cuối; vẫn không thấy thì chỉ mở tới Chương / trang như cũ.
   ==================================================================== */
var citeFind = null;   // {kind:'chapter', id, text} | {kind:'pdf', id, page, text} — chờ nội dung tải xong

function hlNorm(chars) {   // [{c, ref}] -> {s, refs} bỏ khoảng trắng, chữ thường
  var s = "", refs = [];
  chars.forEach(function (x) {
    if (/\s|­/.test(x.c)) return;
    s += x.c.toLowerCase(); refs.push(x.ref);
  });
  return { s: s, refs: refs };
}
function hlNeedle(text) { return String(text || "").normalize("NFC").replace(/[\s­]+/g, "").toLowerCase(); }
// Vị trí [đầu, cuối) của needle trong hay; không thấy nguyên câu thì ghép khúc đầu + khúc cuối.
function hlSpan(hay, needle) {
  if (needle.length < 6) return null;
  var i = hay.indexOf(needle);
  if (i >= 0) return [i, i + needle.length];
  var n = needle.length, lens = [60, 40, 24, 14];
  for (var k = 0; k < lens.length; k++) {
    var L = lens[k]; if (n <= L) continue;
    var h = hay.indexOf(needle.slice(0, L));
    var t = hay.indexOf(needle.slice(n - L), h >= 0 ? h : 0);
    if (h >= 0 && t > h && t - h < n * 1.6) return [h, t + L];
    if (h >= 0) return [h, Math.min(hay.length, h + n)];
    if (t >= 0) return [Math.max(0, t + L - n), t + L];
  }
  return null;
}
function scrollIntoMiddle(rect) {
  var box = $("editor-scroll"); if (!box || !rect) return;
  var b = box.getBoundingClientRect();
  box.scrollTo({ top: box.scrollTop + rect.top - b.top - b.height / 3, behavior: "smooth" });
}

export function clearCiteHighlight() {
  if (window.CSS && CSS.highlights) CSS.highlights.delete("td-cite");
  pdfViewer.citeHL = null;
  document.querySelectorAll(".pdf-cite-layer").forEach(function (l) { l.innerHTML = ""; });
}

function applyChapterHighlight(text) {
  var root = editor && editor.ui.getEditableElement();
  if (!root) return false;
  var chars = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), node;
  while ((node = walker.nextNode())) {
    for (var i = 0; i < node.data.length; i++) chars.push({ c: node.data[i], ref: { n: node, o: i } });
  }
  var hay = hlNorm(chars), span = hlSpan(hay.s, hlNeedle(text));
  if (!span) return false;
  var a = hay.refs[span[0]], z = hay.refs[span[1] - 1];
  var range = document.createRange();
  range.setStart(a.n, a.o); range.setEnd(z.n, z.o + 1);
  if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set("td-cite", new Highlight(range));
  scrollIntoMiddle(range.getBoundingClientRect());
  return true;
}

// Vẽ khung vàng cho các dòng chữ [from, to) (chỉ số trong items) của 1 trang PDF; trả DOMRect khung đầu tiên.
function drawPdfHighlight(pageState, items, from, to) {
  var layer = pageState.wrap.querySelector(".pdf-cite-layer"); if (!layer || !pageState.viewport) return null;
  layer.innerHTML = "";
  var first = null;
  for (var i = from; i <= to; i++) {
    var it = items[i]; if (!it || !it.str || !it.str.trim()) continue;
    var tx = window.pdfjsLib.Util.transform(pageState.viewport.transform, it.transform);
    var h = Math.hypot(tx[2], tx[3]);
    var r = el("div", "pdf-cite-rect");
    r.style.left = tx[4] + "px"; r.style.top = (tx[5] - h) + "px";
    r.style.width = Math.max(4, it.width * pageState.viewport.scale) + "px"; r.style.height = h * 1.15 + "px";
    layer.appendChild(r);
    if (!first) first = r;
  }
  return first;
}
function findInPdfPage(pageNum, text) {
  return pdfViewer.pdfDoc.getPage(pageNum).then(function (page) { return page.getTextContent(); }).then(function (tc) {
    var chars = [];
    tc.items.forEach(function (it, idx) { for (var i = 0; i < (it.str || "").length; i++) chars.push({ c: it.str[i], ref: idx }); });
    var hay = hlNorm(chars), span = hlSpan(hay.s, hlNeedle(text));
    return span ? { page: pageNum, items: tc.items, from: hay.refs[span[0]], to: hay.refs[span[1] - 1] } : null;
  });
}
// Sau khi các trang đã có kích thước: tìm câu ở trang được trích -> trang sau -> trang trước.
function locatePdfHighlight(find, sized) {
  var order = [find.page, find.page + 1, find.page - 1].filter(function (p) { return p >= 1 && p <= pdfViewer.numPages; });
  var tryAt = function (k) {
    if (k >= order.length || pdfViewer.pdfId !== find.id) return Promise.resolve(null);
    return findInPdfPage(order[k], find.text).then(function (hit) { return hit || tryAt(k + 1); });
  };
  return tryAt(0).then(function (hit) {
    if (!hit || pdfViewer.pdfId !== find.id) return false;
    pdfViewer.citeHL = hit;
    return Promise.all(sized.slice(0, hit.page)).then(function () {
      var ps = pdfViewer.pages[hit.page - 1];
      var r = ps && drawPdfHighlight(ps, hit.items, hit.from, hit.to);
      if (r) scrollIntoMiddle(r.getBoundingClientRect());
      return !!r;
    });
  });
}

export function loadActiveIntoEditor() {
  state.noteLocked = false;
  var isChapter = hasActiveChapter();
  var isPdf = state.active && state.active.kind === "pdf";

  if (!isPdf) closePdfViewer();

  if (editor) {
    clearCiteHighlight();
    applyingServer = true;   // đổ nội dung lúc mở mục không phải là "người dùng sửa"
    editor.setData(isChapter && !chapterLocked() ? docFor(state.active) : "");
    applyingServer = false;
    applyReadOnly();
    readFormats();
  }
  // Mở Chương từ "Nguồn": nội dung vừa vào CKEditor -> tìm + bôi vàng câu được trích (chờ CKEditor vẽ DOM xong).
  var cf = citeFind;
  if (isChapter && cf && cf.kind === "chapter" && cf.id === state.active.id && (!isOnline() || state.loadedChapters[cf.id])) {
    citeFind = null;
    setTimeout(function () { applyChapterHighlight(cf.text); }, 80);
  }
  setSaveStatus(isChapter ? "saved" : "idle");
  mountChapterDrawing();

  if (isPdf) loadPdfIntoViewer(state.active.id);
}

/* ====================================================================
   Thẻ Draw trên trang Chương (ghichu_ve.js): lớp vẽ chồng lên .editor-shell, toạ độ = px CSS của trang (zoom trang
   soạn thảo tự quy đổi). Lưu ở state.drawings[chapterId] (localStorage) + PUT /chapters/{id}/drawing (chapters.drawing_json)
   — TÁCH khỏi nội dung chữ: không đụng content_json / re-embed / version. Nền trang (dòng kẻ / ô lưới) = class trên shell.
   ==================================================================== */
var chapterDraw = { s: null, id: null, timer: null, pending: {} };
function drawingOf(id) {
  var d = state.drawings[id];
  if (!d || typeof d !== "object") d = state.drawings[id] = { v: 1, bg: null, items: [] };
  if (!Array.isArray(d.items)) d.items = [];
  return d;
}
function chapterDrawReadOnly() { return !hasActiveChapter() || state.noteLocked || isViewOnly(); }
function applyChapterBg() {
  var shell = document.querySelector(".editor-shell");
  if (!shell) return;
  var d = chapterDraw.id ? state.drawings[chapterDraw.id] : null, bg = d && d.bg;
  shell.classList.remove("dv-bg", "dv-bg-rule", "dv-bg-grid");
  if (bg && bg.kind && bg.kind !== "none" && hasActiveChapter()) {
    shell.classList.add("dv-bg", "dv-bg-" + bg.kind);
    shell.style.setProperty("--dv-step", Ve.bgStep(bg) + "px");
  } else shell.style.removeProperty("--dv-step");
  // Page Color (thẻ View): tô cả vùng trang (#editor-scroll) — chỉ khi đang mở Chương, PDF thì bỏ
  var scroll = $("editor-scroll"), page = d && d.page && hasActiveChapter() && !pdfViewer.open ? d.page : null;
  if (scroll) {
    scroll.classList.toggle("dv-page", !!page);
    if (page) scroll.style.setProperty("--dv-page", page); else scroll.style.removeProperty("--dv-page");
  }
}
function scheduleDrawingSave(id) {
  chapterDraw.pending[id] = true;
  persist();
  clearTimeout(chapterDraw.timer);
  chapterDraw.timer = setTimeout(function () { saveDrawingNow(id); }, 600);
}
function saveDrawingNow(id) {
  clearTimeout(chapterDraw.timer);
  if (!chapterDraw.pending[id]) return;
  delete chapterDraw.pending[id];
  persist();
  if (!isOnline() || (state.active && state.active.id === id && chapterLocked())) return;
  var d = state.drawings[id];
  var empty = !d || (!d.items.length && !(d.bg && d.bg.kind && d.bg.kind !== "none") && !d.page);
  apiAuth("PUT", "/chapters/" + id + "/drawing", authToken(), { drawing: empty ? null : d }).then(function (res) {
    if (!res.ok && res.status !== 403 && res.status !== 404) console.warn("Không lưu được nét vẽ", res.status, res.data);
  });
}
export function flushChapterDrawing() { if (chapterDraw.id) saveDrawingNow(chapterDraw.id); }
export function mountChapterDrawing() {
  var id = hasActiveChapter() && !chapterLocked() ? state.active.id : null;
  var shell = document.querySelector(".editor-shell");
  if (chapterDraw.s && chapterDraw.id === id) { applyChapterBg(); Ve.refreshSurface(chapterDraw.s); return; }
  if (chapterDraw.s) { saveDrawingNow(chapterDraw.id); Ve.unmountSurface(chapterDraw.s); chapterDraw.s = null; }
  chapterDraw.id = id;
  applyChapterBg();
  if (!shell) return;
  shell.style.minHeight = "";
  if (!id) return;
  chapterDraw.s = Ve.mountSurface(shell, {
    key: "ch:" + id, page: 0,
    list: function () { return drawingOf(id).items; },
    add: function (item) { drawingOf(id).items.push(item); scheduleDrawingSave(id); },
    remove: function (item) { var a = drawingOf(id).items, i = a.indexOf(item); if (i >= 0) a.splice(i, 1); scheduleDrawingSave(id); },
    update: function () { scheduleDrawingSave(id); },
    toPx: function (pt) { return [pt[0], pt[1]]; },
    fromPx: function (q) { return [q[0], q[1]]; },
    k: function () { return 1; },
    readOnly: chapterDrawReadOnly,
    gridPx: function () { var bg = drawingOf(id).bg; return bg && bg.kind === "grid" ? Ve.bgStep(bg) : 0; },
    // nét vẽ / hình nằm dưới cuối nội dung → kéo dài trang để vẫn thấy và cuộn tới được
    afterRender: function (maxBottom) { shell.style.minHeight = maxBottom ? Math.ceil(maxBottom + 60) + "px" : ""; },
  });
}
// Nút "Nền trang" của thẻ Draw (chỉ khi đang mở Chương).
export function chapterBgControl() {
  if (!hasActiveChapter()) return null;
  var id = state.active.id;
  return {
    get: function () { return (state.drawings[id] && state.drawings[id].bg) || null; },
    set: function (bg) { drawingOf(id).bg = bg; applyChapterBg(); scheduleDrawingSave(id); if (chapterDraw.s) Ve.refreshSurface(chapterDraw.s); },
  };
}
// Nút "Page Color" của thẻ View — màu nền trang Chương, lưu cùng nét vẽ (`drawing_json.page`, "#rrggbb" | null).
export function chapterPageColorControl() {
  if (!hasActiveChapter()) return null;
  var id = state.active.id;
  return {
    get: function () { return (state.drawings[id] && state.drawings[id].page) || null; },
    set: function (c) { drawingOf(id).page = c || null; applyChapterBg(); scheduleDrawingSave(id); },
  };
}
export function chapterDrawReadOnlyNow() { return chapterDrawReadOnly(); }
function takeServerDrawing(chapterId, d) {
  if (chapterDraw.pending[chapterId]) return;   // đang có nét vẽ chưa kịp lưu — giữ bản của mình
  if (d && "drawing_json" in d) state.drawings[chapterId] = d.drawing_json || null;
}

export function fetchChapterDetail(chapterId) {
  apiAuth("GET", "/chapters/" + chapterId, authToken()).then(function (res) {
    if (res.ok && res.data && res.data.locked) {
      // Review > Password: máy chủ chưa nhận khoá mở (chưa mở / khoá hết hạn / mật khẩu vừa đổi) -> màn khoá
      delete state.chapterKeys[chapterId];
      delete state.docs[chapterId];
      delete state.drawings[chapterId];
      state.loadedChapters[chapterId] = false;
      state.chapterLockInfo[chapterId] = { hint: res.data.password_hint || "" };
      markProtected(chapterId, true);
      state.versions[chapterId] = res.data.content_version;
      state.chapterMeta[chapterId] = chapterMetaOf(res.data);
    } else if (res.ok && res.data) {
      markProtected(chapterId, !!res.data.protected);
      state.docs[chapterId] = res.data.content_json || "";
      takeServerDrawing(chapterId, res.data);
      state.loadedChapters[chapterId] = true;
      state.versions[chapterId] = res.data.content_version;
      state.chapterMeta[chapterId] = chapterMetaOf(res.data);
    } else if ((res.status === 403 || res.status === 404) && state.active && state.active.shared) {
      hooks.onAccessLost(state.active, res.status);
      return;
    }
    if (state.active && state.active.kind === "chapter" && state.active.id === chapterId) loadActiveIntoEditor();
  });
}

// `highlight` (tuỳ chọn) = câu trích dẫn cần bôi vàng khi mở từ "Nguồn".
export function selectChapter(subjectId, chapterId, highlight) {
  citeFind = highlight ? { kind: "chapter", id: chapterId, text: highlight } : null;
  if (hasActiveChapter() && editor) state.docs[docKey(state.active)] = editor.getData();
  state.active = { s: subjectId, kind: "chapter", id: chapterId };
  if (sharedSubject(subjectId)) state.active.shared = true;
  persist();
  // Mục được chia sẻ luôn tải lại (người khác có thể vừa sửa); Chương của mình chỉ tải 1 lần / phiên như trước.
  // Chương có mật khẩu chưa mở: hỏi máy chủ (khoá có thể đã hết hạn / bị đổi mật khẩu).
  if (isOnline() && (!state.loadedChapters[chapterId] || state.active.shared || chapterLocked())) fetchChapterDetail(chapterId);
  else loadActiveIntoEditor();
  hooks.renderAll();
}

// Mở PDF rồi cuộn tới `page` (bấm vào trích dẫn trong AI Chat — UC-20 luồng thay thế 5a).
export function selectPdfAtPage(subjectId, pdfId, page, highlight) {
  selectPdf(subjectId, pdfId);
  pdfViewer.pendingPage = page || 1;
  citeFind = highlight ? { kind: "pdf", id: pdfId, page: page || 1, text: highlight } : null;
}

export function selectPdf(subjectId, pdfId) {
  citeFind = null; clearCiteHighlight();
  if (hasActiveChapter() && editor) state.docs[docKey(state.active)] = editor.getData();
  state.active = { s: subjectId, kind: "pdf", id: pdfId };
  if (sharedSubject(subjectId)) state.active.shared = true;
  persist();
  loadActiveIntoEditor();
  hooks.renderAll();
}

/* ====================================================================
   Render: cây Notebooks (Môn học → Chương/File PDF) — UC-12..18
   ==================================================================== */
function clearDropTargets() {
  var scroll = $("tree-scroll");
  if (!scroll) return;
  scroll.querySelectorAll(".drop-target").forEach(function (n) { n.classList.remove("drop-target"); });
}

var ICO_SHARED = '<svg class="tree-shared-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"></path><circle cx="17" cy="9" r="2.4"></circle><path d="M16.5 14.4c2.2.2 3.6 1.8 4 4.1"></path></svg>';
export function renderTree() {
  var scroll = $("tree-scroll");
  scroll.innerHTML = "";
  var q = state.query.trim().toLowerCase();

  var visible = state.subjects.filter(function (sub) {
    if (!q) return true;
    var chapMatch = sub.chapters.some(function (c) { return c.name.toLowerCase().indexOf(q) >= 0; });
    var pdfMatch = sub.pdfs.some(function (p) { return p.name.toLowerCase().indexOf(q) >= 0; });
    return chapMatch || pdfMatch || sub.name.toLowerCase().indexOf(q) >= 0;
  });

  visible.forEach(function (sub) {
    var open = q ? true : !!state.open[sub.id];
    var item = el("div", "tree-item");
    item.draggable = true;
    item.addEventListener("dragstart", function (e) {
      e.stopPropagation();
      state.drag = { kind: "subject", id: sub.id };
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", sub.name); }
    });
    var acceptsDrag = function () {
      return state.drag && (state.drag.kind === "subject" || (state.drag.kind === "pdf" && state.drag.s !== sub.id));
    };
    item.addEventListener("dragenter", function (e) {
      if (!acceptsDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropTargets();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragover", function (e) {
      if (!acceptsDrag()) return;
      e.preventDefault(); e.stopPropagation();
    });
    item.addEventListener("dragleave", function (e) {
      if (e.relatedTarget && item.contains(e.relatedTarget)) return;
      item.classList.remove("drop-target");
    });
    item.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation();
      var drag = state.drag;
      clearDropTargets();
      state.drag = null;
      if (drag && drag.kind === "pdf" && drag.s !== sub.id) { movePdfWithinTree(drag.id, drag.s, sub.id, null); return; }
      reorder(drag, { kind: "subject", id: sub.id });
    });
    item.addEventListener("dragend", function () { clearDropTargets(); state.drag = null; });

    var renaming = state.rename && state.rename.kind === "subject" && state.rename.id === sub.id;
    if (renaming) {
      var input = el("input", "tree-input"); input.type = "text"; input.value = state.renameDraft;
      input.addEventListener("input", function () { state.renameDraft = input.value; });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitRename(); } if (e.key === "Escape") { state.rename = null; renderTree(); } });
      input.addEventListener("blur", commitRename);
      item.appendChild(input);
      scroll.appendChild(item);
      setTimeout(function () { input.focus(); input.select(); }, 0);
      return;
    }

    var row = el("div", "tree-row");
    var rowBtn = el("button", "tree-row-btn");
    rowBtn.type = "button";
    rowBtn.innerHTML =
      '<span class="tree-caret' + (open ? " open" : "") + '">▶</span>' +
      '<span class="tree-dot" style="background:' + COLORS[state.subjects.indexOf(sub) % COLORS.length] + '"></span>' +
      '<span class="tree-name">' + esc(sub.name) + '</span>' +
      (sub.isShared ? '<span class="tree-shared" title="Đã chia sẻ">' + ICO_SHARED + "</span>" : "") +
      '<span class="tree-count">' + (sub.chapters.length + sub.pdfs.length) + "</span>";
    rowBtn.addEventListener("click", function () { state.open[sub.id] = !state.open[sub.id]; renderTree(); });
    rowBtn.addEventListener("contextmenu", function (e) { openMenu(e, { kind: "subject", id: sub.id, title: sub.name }); });
    var menuBtn = el("button", "menu-btn", "⋯"); menuBtn.type = "button"; menuBtn.title = "Tùy chọn";
    menuBtn.addEventListener("click", function (e) { openMenu(e, { kind: "subject", id: sub.id, title: sub.name }); });
    row.appendChild(rowBtn); row.appendChild(menuBtn);
    item.appendChild(row);

    if (open) {
      var list = el("div", "chapter-list");
      sub.chapters.forEach(function (c) {
        var isActive = state.active && state.active.s === sub.id && state.active.kind === "chapter" && state.active.id === c.id;
        var ci = el("div", "chapter-item");
        ci.draggable = true;
        ci.addEventListener("dragstart", function (e) {
          e.stopPropagation();
          state.drag = { kind: "chapter", s: sub.id, id: c.id, name: c.name };
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.name); }
        });
        ci.addEventListener("dragenter", function (e) {
          if (!state.drag || state.drag.kind !== "chapter" || state.drag.s !== sub.id) return;
          e.preventDefault();
          e.stopPropagation();
          clearDropTargets();
          ci.classList.add("drop-target");
        });
        ci.addEventListener("dragover", function (e) {
          if (!state.drag || state.drag.kind !== "chapter" || state.drag.s !== sub.id) return;
          e.preventDefault(); e.stopPropagation();
        });
        ci.addEventListener("dragleave", function (e) {
          if (e.relatedTarget && ci.contains(e.relatedTarget)) return;
          ci.classList.remove("drop-target");
        });
        ci.addEventListener("drop", function (e) {
          e.preventDefault(); e.stopPropagation();
          var drag = state.drag;
          clearDropTargets();
          state.drag = null;
          reorder(drag, { kind: "chapter", s: sub.id, id: c.id, name: c.name });
        });
        ci.addEventListener("dragend", function () { clearDropTargets(); state.drag = null; });

        var renamingCh = state.rename && state.rename.kind === "chapter" && state.rename.s === sub.id && state.rename.id === c.id;
        if (renamingCh) {
          var ip = el("input", "tree-input chapter-input"); ip.type = "text"; ip.value = state.renameDraft;
          ip.addEventListener("input", function () { state.renameDraft = ip.value; });
          ip.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitRename(); } if (e.key === "Escape") { state.rename = null; renderTree(); } });
          ip.addEventListener("blur", commitRename);
          ci.appendChild(ip);
          list.appendChild(ci);
          setTimeout(function () { ip.focus(); ip.select(); }, 0);
          return;
        }

        var crow = el("div", "chapter-row" + (isActive ? " active" : ""));
        var cbtn = el("button", "chapter-row-btn");
        cbtn.type = "button";
        cbtn.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + (isActive ? "#0d6efd" : "#050d2b") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4.5 4.5V21H6z"></path><path d="M14 3v5h4.5"></path></svg>' +
          '<span class="chapter-name' + (isActive ? " active" : "") + '">' + esc(c.name) + "</span>" +
          (c.protected || c.pw ? '<span class="tree-pw" title="Password protected"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>' : "") +
          (c.isShared ? '<span class="tree-shared" title="Đã chia sẻ">' + ICO_SHARED + "</span>" : "");
        cbtn.addEventListener("click", function () { selectChapter(sub.id, c.id); });
        cbtn.addEventListener("contextmenu", function (e) { openMenu(e, { kind: "chapter", s: sub.id, id: c.id, title: c.name }); });
        var cmenu = el("button", "chapter-menu-btn", "⋯"); cmenu.type = "button"; cmenu.title = "Tùy chọn";
        cmenu.addEventListener("click", function (e) { openMenu(e, { kind: "chapter", s: sub.id, id: c.id, title: c.name }); });
        crow.appendChild(cbtn); crow.appendChild(cmenu);
        ci.appendChild(crow);
        list.appendChild(ci);
      });

      sub.pdfs.forEach(function (p) {
        var isActivePdf = state.active && state.active.s === sub.id && state.active.kind === "pdf" && state.active.id === p.id;
        var pi = el("div", "chapter-item");
        pi.draggable = true;
        pi.addEventListener("dragstart", function (e) {
          e.stopPropagation();
          state.drag = { kind: "pdf", s: sub.id, id: p.id, name: p.name };
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.name); }
        });
        pi.addEventListener("dragenter", function (e) {
          if (!state.drag || state.drag.kind !== "pdf" || state.drag.id === p.id) return;
          e.preventDefault();
          e.stopPropagation();
          clearDropTargets();
          pi.classList.add("drop-target");
        });
        pi.addEventListener("dragover", function (e) {
          if (!state.drag || state.drag.kind !== "pdf" || state.drag.id === p.id) return;
          e.preventDefault(); e.stopPropagation();
        });
        pi.addEventListener("dragleave", function (e) {
          if (e.relatedTarget && pi.contains(e.relatedTarget)) return;
          pi.classList.remove("drop-target");
        });
        pi.addEventListener("drop", function (e) {
          e.preventDefault(); e.stopPropagation();
          var drag = state.drag;
          clearDropTargets();
          state.drag = null;
          reorder(drag, { kind: "pdf", s: sub.id, id: p.id, name: p.name });
        });
        pi.addEventListener("dragend", function () { clearDropTargets(); state.drag = null; });

        var renamingPdf = state.rename && state.rename.kind === "pdf" && state.rename.s === sub.id && state.rename.id === p.id;
        if (renamingPdf) {
          var pip = el("input", "tree-input chapter-input"); pip.type = "text"; pip.value = state.renameDraft;
          pip.addEventListener("input", function () { state.renameDraft = pip.value; });
          pip.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitRename(); } if (e.key === "Escape") { state.rename = null; renderTree(); } });
          pip.addEventListener("blur", commitRename);
          pi.appendChild(pip);
          list.appendChild(pi);
          setTimeout(function () { pip.focus(); pip.select(); }, 0);
          return;
        }

        var prow = el("div", "chapter-row" + (isActivePdf ? " active" : ""));
        var pbtn = el("button", "chapter-row-btn");
        pbtn.type = "button";
        pbtn.innerHTML = '<span style="font-size:13px;line-height:1">📄</span>' +
          '<span class="chapter-name' + (isActivePdf ? " active" : "") + '">' + esc(p.name) + "</span>";
        pbtn.addEventListener("click", function () { selectPdf(sub.id, p.id); });
        pbtn.addEventListener("contextmenu", function (e) { openMenu(e, { kind: "pdf", s: sub.id, id: p.id, title: p.name }); });
        var pmenu = el("button", "chapter-menu-btn", "⋯"); pmenu.type = "button"; pmenu.title = "Tùy chọn";
        pmenu.addEventListener("click", function (e) { openMenu(e, { kind: "pdf", s: sub.id, id: p.id, title: p.name }); });
        prow.appendChild(pbtn); prow.appendChild(pmenu);
        pi.appendChild(prow);
        list.appendChild(pi);
      });

      if (state.typingChapterIn === sub.id) {
        var draft = el("input", "tree-input chapter-input"); draft.type = "text"; draft.placeholder = "Tên chương rồi Enter"; draft.value = state.chapterDraft;
        draft.addEventListener("input", function () { state.chapterDraft = draft.value; });
        draft.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addChapter(sub.id); } if (e.key === "Escape") { state.typingChapterIn = null; state.chapterDraft = ""; renderTree(); } });
        draft.addEventListener("blur", function () { addChapter(sub.id); });
        list.appendChild(draft);
        setTimeout(function () { draft.focus(); }, 0);
      } else {
        var actionsRow = el("div", "new-item-actions");
        var addBtn = el("button", "new-chapter-btn",
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg> Chương mới');
        addBtn.type = "button";
        addBtn.addEventListener("click", function () { state.typingChapterIn = sub.id; state.chapterDraft = ""; renderTree(); });
        var uploadBtn = el("button", "new-chapter-btn",
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M12 3l4 4M12 3L8 7"></path><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4"></path></svg> Tải PDF');
        uploadBtn.type = "button";
        uploadBtn.title = "Tải PDF lên môn này";
        uploadBtn.addEventListener("click", function (e) { e.stopPropagation(); triggerPdfUpload(sub.id); });
        actionsRow.appendChild(addBtn);
        actionsRow.appendChild(uploadBtn);
        list.appendChild(actionsRow);
      }
      item.appendChild(list);
    }

    scroll.appendChild(item);
  });

  if (state.typingSubject) {
    var sInput = el("input", "tree-input"); sInput.type = "text"; sInput.placeholder = "Tên môn rồi Enter"; sInput.value = state.subjectDraft;
    sInput.style.margin = "2px 0";
    sInput.addEventListener("input", function () { state.subjectDraft = sInput.value; });
    sInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addSubject(); } if (e.key === "Escape") { state.typingSubject = false; state.subjectDraft = ""; renderTree(); } });
    sInput.addEventListener("blur", addSubject);
    scroll.appendChild(sInput);
    setTimeout(function () { sInput.focus(); }, 0);
  }

  if (state.subjects.length === 0 && !state.typingSubject) {
    scroll.appendChild(el("p", "sidebar-empty", "Chưa có môn nào. Bấm dấu cộng để thêm môn đầu tiên. Kéo thả để sắp xếp lại."));
  }

  renderSharedTree(scroll, q);

  var totalChapters = state.subjects.reduce(function (n, s) { return n + s.chapters.length; }, 0);
  var totalPdfs = state.subjects.reduce(function (n, s) { return n + s.pdfs.length; }, 0);
  $("total-chapters").textContent = totalChapters + (totalChapters === 1 ? " chapter" : " chapters") + (totalPdfs > 0 ? ", " + totalPdfs + (totalPdfs === 1 ? " PDF" : " PDFs") : "");
  $("search-marquee").hidden = state.query.length > 0;
}

/* "Được chia sẻ với tôi" (như OneNote "Sổ tay được chia sẻ" / Word "Được chia sẻ với tôi") — cuối cây Notebook.
   Không kéo-thả, không đổi tên / xoá; "⋯" mở menu riêng (ghichu_chiase.js): Chia sẻ… / Tạo bản sao / Xoá khỏi danh sách.
   Người được chia sẻ CẢ Môn với quyền chỉnh sửa vẫn thêm được Chương như sổ OneNote dùng chung. */
var ROLE_BADGE = { viewer: "Chỉ xem", editor: "Chỉnh sửa" };
function renderSharedTree(scroll, q) {
  if (!state.shared.length) return;
  var list = state.shared.filter(function (sub) {
    if (!q) return true;
    return sub.name.toLowerCase().indexOf(q) >= 0 || sub.chapters.concat(sub.pdfs).some(function (x) { return x.name.toLowerCase().indexOf(q) >= 0; });
  });
  if (!list.length) return;
  var head = el("div", "tree-shared-head", ICO_SHARED + "<span>Được chia sẻ với tôi</span>");
  scroll.appendChild(head);
  list.forEach(function (sub) {
    var open = q ? true : !!state.open[sub.id];
    var item = el("div", "tree-item tree-item--shared");
    var row = el("div", "tree-row");
    var rowBtn = el("button", "tree-row-btn");
    rowBtn.type = "button";
    rowBtn.title = sub.name + " — của " + sub.owner.name;
    rowBtn.innerHTML =
      '<span class="tree-caret' + (open ? " open" : "") + '">▶</span>' +
      '<span class="tree-owner-av">' + avatarHtml(sub.owner) + "</span>" +
      '<span class="tree-name-wrap"><span class="tree-name">' + esc(sub.name) + '</span><span class="tree-owner">' + esc(sub.owner.name) +
      (sub.whole ? "" : " · " + sub.chapters.length + " chương") + "</span></span>" +
      (sub.whole ? '<span class="tree-role r-' + sub.role + '">' + ROLE_BADGE[sub.role] + "</span>" : "");
    rowBtn.addEventListener("click", function () { state.open[sub.id] = !state.open[sub.id]; renderTree(); });
    rowBtn.addEventListener("contextmenu", function (e) { e.preventDefault(); hooks.openSharedMenu(e, { kind: "subject", s: sub.id, id: sub.id, title: sub.name }); });
    var menuBtn = el("button", "menu-btn", "⋯"); menuBtn.type = "button"; menuBtn.title = "Tùy chọn";
    menuBtn.addEventListener("click", function (e) { hooks.openSharedMenu(e, { kind: "subject", s: sub.id, id: sub.id, title: sub.name }); });
    row.appendChild(rowBtn); row.appendChild(menuBtn);
    item.appendChild(row);
    if (open) {
      var box = el("div", "chapter-list");
      sub.chapters.forEach(function (c) { box.appendChild(sharedRow(sub, c, "chapter")); });
      sub.pdfs.forEach(function (p) { box.appendChild(sharedRow(sub, p, "pdf")); });
      if (sub.whole && sub.role === "editor") {
        if (state.typingChapterIn === sub.id) {
          var draft = el("input", "tree-input chapter-input"); draft.type = "text"; draft.placeholder = "Tên chương rồi Enter"; draft.value = state.chapterDraft;
          draft.addEventListener("input", function () { state.chapterDraft = draft.value; });
          draft.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addChapter(sub.id); } if (e.key === "Escape") { state.typingChapterIn = null; state.chapterDraft = ""; renderTree(); } });
          draft.addEventListener("blur", function () { addChapter(sub.id); });
          box.appendChild(draft);
          setTimeout(function () { draft.focus(); }, 0);
        } else {
          var acts = el("div", "new-item-actions");
          var addBtn = el("button", "new-chapter-btn", '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg> Chương mới');
          addBtn.type = "button";
          addBtn.addEventListener("click", function () { state.typingChapterIn = sub.id; state.chapterDraft = ""; renderTree(); });
          acts.appendChild(addBtn);
          box.appendChild(acts);
        }
      }
      if (!sub.chapters.length && !sub.pdfs.length) box.appendChild(el("p", "tree-shared-empty", "Môn này chưa có chương nào."));
      item.appendChild(box);
    }
    scroll.appendChild(item);
  });
}

function sharedRow(sub, x, kind) {
  var isActive = state.active && state.active.s === sub.id && state.active.kind === kind && state.active.id === x.id;
  var ci = el("div", "chapter-item");
  var crow = el("div", "chapter-row" + (isActive ? " active" : ""));
  var b = el("button", "chapter-row-btn");
  b.type = "button";
  var ico = kind === "pdf" ? '<span style="font-size:13px;line-height:1">📄</span>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + (isActive ? "#0d6efd" : "#050d2b") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4.5 4.5V21H6z"></path><path d="M14 3v5h4.5"></path></svg>';
  b.innerHTML = ico + '<span class="chapter-name' + (isActive ? " active" : "") + '">' + esc(x.name) + "</span>" +
    (x.protected ? '<span class="tree-pw" title="Password protected"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>' : "") +
    (!sub.whole || x.role !== sub.role ? '<span class="tree-role r-' + x.role + '">' + ROLE_BADGE[x.role] + "</span>" : "");
  b.addEventListener("click", function () { if (kind === "pdf") selectPdf(sub.id, x.id); else selectChapter(sub.id, x.id); });
  var payload = { kind: kind, s: sub.id, id: x.id, title: x.name };
  b.addEventListener("contextmenu", function (e) { e.preventDefault(); hooks.openSharedMenu(e, payload); });
  var mb = el("button", "chapter-menu-btn", "⋯"); mb.type = "button"; mb.title = "Tùy chọn";
  mb.addEventListener("click", function (e) { hooks.openSharedMenu(e, payload); });
  crow.appendChild(b); crow.appendChild(mb);
  ci.appendChild(crow);
  return ci;
}

export function avatarHtml(p) {
  if (p && p.avatar) return '<img src="' + esc(p.avatar) + '" alt="" referrerpolicy="no-referrer">';
  var name = (p && p.name) || "?";
  var parts = name.trim().split(/\s+/);
  return esc((parts[parts.length - 1] || "?").charAt(0).toUpperCase());
}

/* ====================================================================
   Menu ngữ cảnh của cây (đổi tên / xoá) — riêng của module này vì các nút
   trong menu gọi thẳng commitRename()/deleteMenuTarget() ở trên.
   ==================================================================== */
export function openMenu(e, payload) {
  e.preventDefault(); e.stopPropagation();
  var x = e.clientX, y = e.clientY;
  if (!x && e.currentTarget) { var r = e.currentTarget.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  state.menu = Object.assign({}, payload, { x: Math.max(8, Math.min(x, window.innerWidth - 190)), y: Math.max(8, Math.min(y, window.innerHeight - 100)) });
  state.dd = null;
  renderMenu();
  closeDropdownEl();
}

export function renderMenu() {
  var m = state.menu;
  var box = $("ctx-menu");
  if (!m) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.style.left = m.x + "px"; box.style.top = m.y + "px";
  var canShare = isOnline() && (m.kind === "subject" || m.kind === "chapter");
  box.innerHTML =
    '<div class="ctx-menu-title">' + esc(m.title) + '</div>' +
    (canShare ? '<button type="button" class="ctx-menu-item" id="ctx-share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"></path><path d="M17 8v6M14 11h6"></path></svg>Chia sẻ…</button>' : "") +
    '<button type="button" class="ctx-menu-item" id="ctx-rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16z"></path><path d="M14 6l4 4"></path></svg>Đổi tên</button>' +
    '<button type="button" class="ctx-menu-item danger" id="ctx-delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"></path></svg>Xóa</button>';
  if (canShare) $("ctx-share").addEventListener("click", function (e) {
    e.stopPropagation();
    state.menu = null; renderMenu();
    hooks.openShare({ type: m.kind, id: m.id });
  });
  $("ctx-rename").addEventListener("click", function (e) {
    e.stopPropagation();
    state.rename = m.kind === "subject" ? { kind: "subject", id: m.id } : { kind: m.kind, s: m.s, id: m.id };
    state.renameDraft = m.title;
    state.menu = null;
    renderMenu(); renderTree();
  });
  $("ctx-delete").addEventListener("click", function (e) {
    e.stopPropagation();
    var confirmMsg = m.kind === "subject"
      ? 'Xoá môn học "' + m.title + '" và toàn bộ chương/File PDF bên trong? Không thể hoàn tác.'
      : m.kind === "pdf"
      ? 'Xoá File PDF "' + m.title + '"? Không thể hoàn tác.'
      : 'Xoá chương "' + m.title + '"? Không thể hoàn tác.';
    var ok = window.confirm(confirmMsg);
    if (!ok) { state.menu = null; renderMenu(); return; }
    deleteMenuTarget();
    renderMenu();
  });
}

/* Nạp cây Môn học -> Chương thật từ backend khi đã đăng nhập, THAY THẾ hoàn toàn dữ liệu mẫu
   đang có trong state.subjects. Chưa đăng nhập -> bỏ qua, giữ nguyên "chế độ mẫu" cục bộ. */
export function bootKnowledgeTree() {
  if (!isOnline()) return Promise.resolve();
  return apiAuth("GET", "/subjects", authToken()).then(function (res) {
    if (!res.ok || !Array.isArray(res.data)) return;

    state.subjects = res.data.map(function (s) {
      return {
        id: s.id,
        name: s.name,
        isShared: !!s.shared,   // mình đã chia sẻ Môn này (biểu tượng người ở cây)
        chapters: s.chapters.map(function (c) { return { id: c.id, name: c.name, isShared: !!c.shared, protected: !!c.protected }; }),
        pdfs: s.pdfs.map(function (p) {
          var existing = state.pdfs[p.id];
          state.pdfs[p.id] = { name: p.original_name, annotations: (existing && existing.annotations) || [] };
          // pageCount: hiện "Tệp PDF · N trang" ở khung chọn nguồn Tạo câu hỏi ôn tập (ghichu_ontap.js).
          return { id: p.id, name: p.original_name, pageCount: p.page_count };
        }),
      };
    });

    if (state.active && !state.active.shared) {   // mục được chia sẻ: ghichu_chiase.js kiểm sau khi tải danh sách
      var sub = findSubject(state.active.s);
      var stillThere = state.active.kind === "pdf" ? pdfInSub(sub, state.active.id) : chapterInSub(sub, state.active.id);
      if (!stillThere) state.active = null;
    }

    persist();
    if (state.active && state.active.shared) { hooks.renderAll(); return; }
    if (state.active && state.active.kind === "chapter" && !state.loadedChapters[state.active.id]) fetchChapterDetail(state.active.id);
    else loadActiveIntoEditor();
    hooks.renderAll();
  });
}

/* ---- Zoom trang soạn thảo Chương (− 100% +, giống thanh zoom File PDF): CSS `zoom` lên .editor-shell — chữ, bảng, ảnh
   phóng theo và CKEditor vẫn đặt con trỏ / bôi đen đúng (Chromium tính zoom vào toạ độ). Chỉ là cách XEM, không đổi nội
   dung đã lưu; nhớ mức zoom theo trình duyệt ở localStorage `td_doc_zoom`. Bấm số % = về 100%. ---- */
var DOC_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
var docZoom = 1;
try { var z0 = Number(localStorage.getItem("td_doc_zoom")); if (DOC_ZOOM_STEPS.indexOf(z0) >= 0) docZoom = z0; } catch (e) { /* bỏ qua */ }
function applyDocZoom() {
  var shell = document.querySelector(".editor-shell");
  if (shell) shell.style.zoom = docZoom === 1 ? "" : String(docZoom);
  $("doc-zoom-indicator").textContent = Math.round(docZoom * 100) + "%";
  $("doc-zoom-out").disabled = docZoom <= DOC_ZOOM_STEPS[0];
  $("doc-zoom-in").disabled = docZoom >= DOC_ZOOM_STEPS[DOC_ZOOM_STEPS.length - 1];
  try { localStorage.setItem("td_doc_zoom", String(docZoom)); } catch (e) { /* bỏ qua */ }
  window.dispatchEvent(new Event("resize"));   // các nút nổi bám theo nội dung (thanh ảnh, "+" bảng) đo lại vị trí
  if (state.tab === "View") hooks.renderRibbon();   // ô Zoom ở thẻ View đi theo
}
export function setDocZoom(dir) {
  var i = DOC_ZOOM_STEPS.indexOf(docZoom);
  if (dir === 0) docZoom = 1;
  else docZoom = DOC_ZOOM_STEPS[Math.max(0, Math.min(DOC_ZOOM_STEPS.length - 1, i + dir))];
  applyDocZoom();
}

/* ---- Zoom ở thẻ View (Zoom: [100% ▾] · Zoom In · Zoom Out · 100%) — áp cho Chương (zoom trang soạn thảo) hoặc File PDF
   (tỉ lệ hiển thị PDF) tuỳ mục đang mở. Giá trị = tỉ lệ (1 = 100%). ---- */
export var VIEW_ZOOM_STEPS = DOC_ZOOM_STEPS;
export function viewZoomTarget() { return pdfViewer.open ? (pdfViewer.pdfDoc ? "pdf" : null) : hasActiveChapter() ? "doc" : null; }
export function viewZoomValue() { return viewZoomTarget() === "pdf" ? pdfViewer.scale : docZoom; }
export function setViewZoom(v) {
  var t = viewZoomTarget();
  if (t === "doc") { docZoom = DOC_ZOOM_STEPS.indexOf(v) >= 0 ? v : 1; applyDocZoom(); }
  else if (t === "pdf") pdfZoom(v - pdfViewer.scale);
}
export function stepViewZoom(dir) {
  var t = viewZoomTarget();
  if (t === "doc") { setDocZoom(dir); return; }
  if (t !== "pdf") return;
  var cur = pdfViewer.scale, next;
  if (dir === 0) next = 1;
  else if (dir > 0) next = DOC_ZOOM_STEPS.find(function (s) { return s > cur + 0.001; }) || 3;
  else next = DOC_ZOOM_STEPS.slice().reverse().find(function (s) { return s < cur - 0.001; }) || DOC_ZOOM_STEPS[0];
  pdfZoom(next - cur);
}

/* ====================================================================
   Khởi tạo module — wiring DOM tĩnh riêng của Notebook/PDF viewer, gọi 1
   lần từ ghichu.js (init()).
   ==================================================================== */
export function initSoanthao() {
  $("btn-new-subject").addEventListener("click", function (e) { e.stopPropagation(); state.typingSubject = true; state.subjectDraft = ""; renderTree(); });
  $("pdf-file-input").addEventListener("change", handlePdfFileSelected);

  $("pdf-prev").addEventListener("click", function () { pdfGoToPage(-1); });
  $("pdf-next").addEventListener("click", function () { pdfGoToPage(1); });
  $("pdf-zoom-out").addEventListener("click", function () { pdfZoom(-0.25); });
  $("pdf-zoom-in").addEventListener("click", function () { pdfZoom(0.25); });
  $("doc-zoom-out").addEventListener("click", function () { setDocZoom(-1); });
  $("doc-zoom-in").addEventListener("click", function () { setDocZoom(1); });
  $("doc-zoom-indicator").addEventListener("click", function () { setDocZoom(0); });
  applyDocZoom();
  window.addEventListener("pointermove", pdfInteractMove);
  window.addEventListener("pointerup", pdfInteractUp);

  var searchInput = $("tree-search");
  searchInput.addEventListener("input", function () { state.query = searchInput.value; renderTree(); });
}
