/* ======================================================================
   ghichu_nguon.js — "Chọn nguồn nội dung" DÙNG CHUNG cho các công cụ Studio AI
   (UC-19): Tạo câu hỏi ôn tập (ghichu_ontap.js) và Tạo đề thi thử
   (ghichu_thithu.js). Tách ra từ ghichu_ontap.js để 2 module không nhân bản
   logic; mỗi module vẫn giữ giao diện danh sách nguồn + state riêng.

   Dữ liệu đọc từ state.subjects — cây Môn học đã nạp từ GET /subjects
   (bootKnowledgeTree() ở ghichu_soanthao.js): mỗi Môn có `chapters` và `pdfs`
   (tệp PDF gắn THẲNG vào Môn, ngang hàng Chương — đúng pdf_documents.subject_id),
   không gọi API riêng, không hard-code.

   - createSourceSelection(): 1 tập nguồn [{kind, s: subjectId, id, on}] + các
     thao tác chọn/bỏ/xoá, ép "mọi nguồn cùng 1 Môn" (quiz_sets.subject_id).
   - openSourcePicker(): khung chọn Môn học → Chương / Tệp PDF khi bấm nút "+",
     tái dùng #dd-panel/.dd-plain dùng chung (openDropdown ở ghichu_core.js).
   Thêm loại nguồn mới (vd. "Bài ghi chú" khi bảng notes được dùng thật) = thêm
   1 phần tử vào SOURCE_KINDS; mọi công cụ dùng module này tự có loại nguồn đó.
   ====================================================================== */
import { state, $, esc, isOnline, openDropdown } from "./ghichu_core.js";

/* `items(sub)` lấy danh sách con của Môn trong state.subjects, `apiType` là giá trị source_type
   gửi backend (khớp ENUM quiz_set_sources.source_type). */
export var SOURCE_KINDS = [
  {
    kind: "chapter", apiType: "CHAPTER", label: "Chương",
    items: function (sub) { return sub.chapters || []; },
    meta: function () { return "Chương"; },
  },
  {
    kind: "pdf", apiType: "PDF", label: "PDF",
    items: function (sub) { return sub.pdfs || []; },
    meta: function (item) { return "Tệp PDF" + (item.pageCount ? " · " + item.pageCount + " trang" : ""); },
  },
];

export function kindOf(kind) { return SOURCE_KINDS.find(function (k) { return k.kind === kind; }); }

// Chế độ mẫu (chưa đăng nhập) dùng id "local-..."; khi online chỉ nhận mục đã có id thật.
export function isReal(item) { return !isOnline() || String(item.id).indexOf("local-") !== 0; }

/* Tập nguồn của 1 công cụ. `sameSubjectMsg`: lỗi hiện khi tick nguồn khác Môn đang chọn. */
export function createSourceSelection(sameSubjectMsg) {
  var sel = {
    items: [], // thứ tự người dùng thêm vào

    resolve: function (src) {
      var sub = state.subjects.find(function (s) { return s.id === src.s; });
      var k = kindOf(src.kind);
      if (!sub || !k) return null;
      var item = k.items(sub).find(function (x) { return x.id === src.id; });
      return item ? { sub: sub, item: item, kind: k } : null;
    },
    // Nguồn bị xoá/đổi Môn trong lúc đang mở màn công cụ -> bỏ khỏi danh sách thay vì hiện mục "ma".
    prune: function () { sel.items = sel.items.filter(function (src) { return !!sel.resolve(src); }); },
    selected: function () { return sel.items.filter(function (s) { return s.on; }); },
    lockedSubjectId: function () { var on = sel.selected(); return on.length ? on[0].s : null; },

    // Đang mở sẵn 1 Chương/PDF trong Notebook -> gợi ý luôn làm nguồn đầu tiên.
    preselectActive: function () {
      if (sel.items.length || !state.active) return;
      var pre = { kind: state.active.kind, s: state.active.s, id: state.active.id, on: true };
      var r = sel.resolve(pre);
      if (r && isReal(r.item)) sel.items.push(pre);
    },
    // Trả "" khi đổi được, hoặc thông báo lỗi (khác Môn đang chọn).
    toggle: function (i) {
      var src = sel.items[i];
      if (!src) return "";
      var locked = sel.lockedSubjectId();
      if (!src.on && locked && locked !== src.s) return sameSubjectMsg;
      src.on = !src.on;
      return "";
    },
    pick: function (kind, s, id) {
      var existing = sel.items.find(function (x) { return x.kind === kind && x.id === id; });
      var locked = sel.lockedSubjectId();
      if (existing && existing.on) existing.on = false;   // bấm lại = bỏ chọn
      else if (locked && locked !== s) return;              // khác Môn đang chọn (đã disabled ở UI)
      else if (existing) existing.on = true;
      else sel.items.push({ kind: kind, s: s, id: id, on: true });
    },
    remove: function (i) { sel.items.splice(i, 1); },
    clear: function () { sel.items = []; },
    // Phần "nguồn" của request tạo bộ câu hỏi/đề thi: {subject_id, sources:[{source_type, id}]}.
    toApi: function () {
      var on = sel.selected();
      return {
        subject_id: on.length ? on[0].s : null,
        sources: on.map(function (src) { return { source_type: kindOf(src.kind).apiType, id: src.id }; }),
      };
    },
  };
  return sel;
}

/* ---------- Khung chọn nguồn: Môn học → Chương / Tệp PDF ----------
   opts: {key (khoá dropdown), head (dòng hướng dẫn đầu khung), onChange()} */
var BOOK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2z"></path></svg>';

function pickerHtml(sel, head) {
  var locked = sel.lockedSubjectId();
  var subjects = state.subjects.filter(isReal);
  var html = '<div class="dd-plain nguon-picker"><div class="nguon-picker-head">' + esc(head) + "</div>";
  if (!subjects.length) html += '<div class="nguon-picker-head">Chưa có Môn học nào trong Notebook.</div>';
  subjects.forEach(function (sub) {
    var off = !!locked && locked !== sub.id;
    html += '<div class="nguon-picker-subject' + (off ? " off" : "") + '">' + BOOK_SVG + esc(sub.name) + "</div>";
    var count = 0;
    SOURCE_KINDS.forEach(function (k) {
      k.items(sub).filter(isReal).forEach(function (item) {
        count++;
        var picked = sel.items.some(function (s) { return s.kind === k.kind && s.id === item.id && s.on; });
        html += '<button type="button" data-kind="' + k.kind + '" data-s="' + esc(sub.id) + '" data-id="' + esc(item.id) + '"' +
          (picked ? ' class="on"' : "") + (off ? " disabled" : "") + ">" +
          '<span class="tick">' + (picked ? "✓" : "") + '</span><span class="lbl">' + esc(item.name) + '</span><span class="kind">' + k.label + "</span></button>";
      });
    });
    if (!count) html += '<div class="nguon-picker-empty-sub">Chưa có Chương hay tệp PDF nào.</div>';
  });
  return html + "</div>";
}

export function openSourcePicker(sel, anchor, opts) {
  var rect = anchor.getBoundingClientRect();
  var bind = function (panel) {
    panel.addEventListener("click", function (e) { e.stopPropagation(); });
    panel.querySelectorAll("button[data-id]").forEach(function (b) {
      b.addEventListener("click", function () {
        sel.pick(b.dataset.kind, b.dataset.s, b.dataset.id);
        opts.onChange();
        panel.innerHTML = pickerHtml(sel, opts.head); // vẽ lại tại chỗ, panel vẫn mở để chọn tiếp
        bind(panel);
      });
    });
  };
  var x = Math.max(8, Math.min(rect.left, window.innerWidth - 400));
  openDropdown(opts.key, x, 0, pickerHtml(sel, opts.head), bind);
  var panel = $("dd-panel");
  var h = panel.offsetHeight;
  var y = rect.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 6); // không đủ chỗ -> mở lên trên
  panel.style.top = y + "px";
}
