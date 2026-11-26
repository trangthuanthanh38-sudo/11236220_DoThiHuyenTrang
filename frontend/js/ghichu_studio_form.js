/* ======================================================================
   ghichu_studio_form.js — FORM "Tạo mới" DÙNG CHUNG cho các công cụ Studio AI tạo đề
   (UC-19 + UC-21 Ôn tập / UC-22 Thi thử), tách từ ghichu_ontap.js khi làm lại giao diện Thi
   thử theo cùng khuôn (on-tap-tao-moi.html / desktop-6-thi-thu (moi).html):
     - Nguồn nội dung: dropdown Môn + chip Chương / Tệp PDF của Môn đó (mọi nguồn cùng 1 Môn —
       quiz_sets.subject_id), đọc từ state.subjects, loại nguồn theo SOURCE_KINDS (ghichu_nguon.js)
     - Tên (bắt buộc): mở form thì để TRỐNG; người học bấm chọn Chương/tệp thì tự điền tên nguồn đầu tiên
       đang tick (bỏ đuôi .pdf) tới khi tự gõ tên khác — sửa được tự do; xoá trắng thì lại tự điền theo nguồn
       ở lần bấm chọn sau. Nguồn được tick sẵn lúc mở form (Chương đang mở ở Notebook) KHÔNG tự điền tên.
     - Gợi ý / "chỉ đủ tối đa N câu" theo độ dài nội dung đã embed: POST /quiz/source-stats
     - Phân bổ độ khó: Theo khuyến nghị 30/40/30 hoặc Tự điều chỉnh − +
     - Ô "Đang tạo": các bước đổi theo THỜI GIAN chờ (tạo đề là 1 request đồng bộ, không có %)
     - fit(): trình duyệt đang phóng to trang (Ctrl +) -> trang Tạo mới thu vừa khít, không thanh cuộn
       dọc; zoom trình duyệt 100% -> giữ cỡ gốc, bố cục 2 cột, cho cuộn dọc

   createStudioForm(cfg) — cfg:
     ids     tiền tố id phần tử trong fragment (vd "ontap" -> #ontap-src-list, #ontap-count...)
     cls     tiền tố class CSS của module (vd "ontap" -> .ontap-chip, .ontap-level...)
     mode    "practice" | "exam" | "flashcard" (gửi kèm source-stats: trần 30 câu / 50 câu / 50 thẻ)
     minCount, maxCount, defaultCount, createLabel, unit ("bộ câu hỏi" | "đề thi")
     unitWord  đơn vị đếm trong gợi ý/lỗi: "câu" (mặc định) | "thẻ"
     nameSuffix  true = tên luôn kết thúc bằng " - <tên Môn>" (Flashcard): tự điền "<nguồn> - <Môn>", rời ô tên / tạo bộ thì
               tự thêm nếu thiếu, đổi Môn thì đổi đuôi theo — dùng `f.finalName()` khi gửi tên lên máy chủ
     mix     tuỳ chọn — thay ô "Phân bổ độ khó": {render(countOk) -> true nếu hợp lệ, bind()} (Flashcard
             dùng cho ô "Loại thẻ"); không có thì form tự vẽ + gắn sự kiện ô độ khó như cũ
     count   tuỳ chọn — `false` = công cụ KHÔNG có ô số câu/số thẻ và ô độ khó (Sơ đồ tư duy UC-25): bỏ qua
             mọi phần tử #…-count* / #…-diff-*, nút tạo chỉ cần nguồn + tên; #…-count-err (nếu có) chỉ báo nguồn
             chưa có nội dung. Mặc định (không truyền) giữ nguyên hành vi cũ của Ôn tập / Thi thử / Flashcard.
     panel   {idle, steps:[3 nhãn, "{n}" = số nguồn, "{c}" = số câu], startLabel, againLabel}
     active()  true khi đang hiện trang Tạo mới (để biết có cần vẽ lại)
     job()     ô "Đang tạo" hiện tại của module (null | {t0, total, nSrc, done, set, ...})
     onChange() module vẽ lại trang Tạo mới
   Module vẫn tự giữ luồng gọi API tạo đề, lần làm, Đã tạo...
   ====================================================================== */
import { state, $, esc, isOnline, authToken, hooks } from "./ghichu_core.js";
import { SOURCE_KINDS, kindOf, isReal } from "./ghichu_nguon.js";

export var LEVELS = ["easy", "medium", "hard"];
export var LEVEL_LABEL = { easy: "Dễ", medium: "Trung bình", hard: "Khó" };
var FIT_MIN = 0.6; // không thu nhỏ quá 60% để chữ còn đọc được

// 30% dễ / 40% trung bình / 30% khó, làm tròn .5 LÊN — khớp split_difficulty() ở backend.
export function split(n) { var e = Math.floor(n * 0.3 + 0.5); return [e, Math.max(0, n - 2 * e), e]; }

/* ---------- định dạng thời gian (API trả mốc TƯƠNG ĐỐI `*_seconds_ago`) ---------- */
export function pad(n) { return String(n).padStart(2, "0"); }
export function mmss(s) { s = Math.max(0, Math.round(s)); return pad(Math.floor(s / 60)) + ":" + pad(s % 60); }
export function agoDate(sec) { return new Date(Date.now() - sec * 1000); }
export function fmtDay(d) {
  var t = new Date(), y = new Date(t);
  y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Hôm nay";
  if (d.toDateString() === y.toDateString()) return "Hôm qua";
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
}
export function fmtTime(d) { return fmtDay(d) + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }
export function fmtDuration(sec) { return sec < 60 ? sec + " giây" : Math.round(sec / 60) + " phút"; }

// Lỗi API -> câu cho người học ("chưa được nối" khi máy chủ cũ trả 404 mặc định của FastAPI).
export function apiErrorText(res, path, fallback) {
  var limit = hooks.aiLimitText(res);   // UC-33: hết lượt AI -> kèm thời gian chờ + tính năng còn lượt (ghichu_hanmuc.js)
  if (limit) return limit;
  if (res.status === 404 && !(res.data && res.data.detail && res.data.detail !== "Not Found"))
    return "Máy chủ chưa có chức năng này (API " + path + " chưa được nối).";
  return (res.data && typeof res.data.detail === "string" && res.data.detail) || fallback;
}

export function createStudioForm(cfg) {
  var P = cfg.ids, C = cfg.cls, U = cfg.unitWord || "câu";
  var CHECK_SVG = '<svg width="9" height="7" viewBox="0 0 12 10" fill="none"><path d="M1 5.2 4.3 8.5 11 1.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="color:var(--' + C + '-on-primary)"/></svg>';
  var id = function (s) { return $(P + "-" + s); };

  var f = {
    subjectId: null,
    picked: [],            // [{kind, id}] theo thứ tự tick — mọi nguồn thuộc subjectId
    name: "", nameTouched: false,  // nameTouched = người học đã tự gõ tên (khác rỗng) -> không tự điền nữa
    picking: false,                 // đã tự bấm chọn nguồn -> ô tên trống mới tô đỏ
    countRaw: String(cfg.defaultCount), count: cfg.defaultCount,
    diffMode: "auto",      // auto (30/40/30) | custom
    custom: split(cfg.defaultCount),
    stats: null,           // {key, data, loading}
    statsTimer: 0,
    CHECK_SVG: CHECK_SVG,
  };

  function realSubjects() { return state.subjects.filter(isReal); }
  function currentSubject() { return realSubjects().find(function (s) { return s.id === f.subjectId; }) || null; }
  // Chương + PDF của Môn, theo thứ tự SOURCE_KINDS (Chương trước, PDF sau).
  function subjectItems(sub) {
    var out = [];
    if (!sub) return out;
    SOURCE_KINDS.forEach(function (k) {
      k.items(sub).filter(isReal).forEach(function (item) { out.push({ kind: k.kind, item: item, k: k }); });
    });
    return out;
  }
  function isPicked(kind, itemId) { return f.picked.some(function (p) { return p.kind === kind && p.id === itemId; }); }
  function pickedItems() {
    var items = subjectItems(currentSubject());
    return f.picked.map(function (p) {
      return items.find(function (x) { return x.kind === p.kind && x.item.id === p.id; });
    }).filter(Boolean);
  }
  function locked() { return !!cfg.job(); }

  // Khi mở màn: giữ Môn/nguồn đã chọn nếu còn tồn tại; chưa có thì lấy Môn đang mở trong Notebook
  // (+ tick sẵn Chương/PDF đang mở), không có thì Môn đầu tiên.
  f.initSource = function () {
    var sub = currentSubject();
    if (!sub) {
      f.picked = [];
      var act = state.active;
      sub = (act && realSubjects().find(function (s) { return s.id === act.s; })) || realSubjects()[0] || null;
      f.subjectId = sub ? sub.id : null;
      if (sub && act && act.s === sub.id && kindOf(act.kind)) {
        var exists = kindOf(act.kind).items(sub).some(function (x) { return x.id === act.id; });
        if (exists) f.picked.push({ kind: act.kind, id: act.id });
      }
    }
    var items = subjectItems(sub);
    f.picked = f.picked.filter(function (p) {
      return items.some(function (x) { return x.kind === p.kind && x.item.id === p.id; });
    });
    f.sourceChanged();
  };

  f.sourcesForApi = function () {
    return {
      subject_id: f.subjectId,
      sources: pickedItems().map(function (x) { return { source_type: x.k.apiType, id: x.item.id }; }),
    };
  };

  // Đổi nguồn -> đo lại độ dài nguồn; `byUser` (người học tự bấm chọn chip / đổi Môn) thì tên chưa tự gõ
  // lấy theo nguồn đầu tiên đang tick (không còn nguồn nào -> trống).
  f.sourceChanged = function (byUser) {
    if (byUser && !f.nameTouched) {
      var first = pickedItems()[0];
      f.name = first ? f.finalName(first.item.name.replace(/\.pdf$/i, "")) : "";
    } else if (byUser && cfg.nameSuffix && f.suffixSub && f.suffixSub !== subjectName()) {
      // tên tự gõ còn đuôi Môn cũ -> đổi sang Môn mới
      var old = " - " + f.suffixSub;
      if (f.name.slice(-old.length).toLowerCase() === old.toLowerCase()) f.name = f.finalName(f.name.slice(0, -old.length));
    }
    f.suffixSub = subjectName();
    if (byUser) f.picking = true;
    loadStats();
  };

  function loadStats() {
    clearTimeout(f.statsTimer);
    var body = f.sourcesForApi();
    if (!body.sources.length || !isOnline()) { f.stats = null; return; }
    body.mode = cfg.mode;
    var key = JSON.stringify(body);
    if (f.stats && f.stats.key === key) return;
    f.stats = { key: key, data: null, loading: true };
    f.statsTimer = setTimeout(function () {
      apiAuth("POST", "/quiz/source-stats", authToken(), body).then(function (res) {
        if (!f.stats || f.stats.key !== key) return; // đã đổi nguồn trong lúc chờ
        f.stats = { key: key, data: res.ok ? res.data : null, loading: false };
        if (cfg.active()) cfg.onChange();
      });
    }, 250);
  }

  function subjectName() { var s = currentSubject(); return s ? s.name : ""; }
  // Tên gửi lên máy chủ: với cfg.nameSuffix thì luôn có đuôi " - <Môn>" (không thêm lần 2 nếu đã có).
  f.finalName = function (name) {
    var n = (name === undefined ? f.name : name).trim(), sub = subjectName();
    if (!cfg.nameSuffix || !n || !sub) return n;
    var tail = " - " + sub;
    return n.slice(-tail.length).toLowerCase() === tail.toLowerCase() || n.toLowerCase() === sub.toLowerCase() ? n : n + tail;
  };

  f.dist = function () { return f.diffMode === "auto" ? split(f.count) : f.custom; };
  // Phần độ khó của request: cả đề chỉ 1 mức -> {difficulty} (chỉ ôn tập dùng), ngược lại phân bổ.
  f.difficultyPayload = function (allowSingle) {
    var d = f.dist(), nonzero = d.filter(function (v) { return v > 0; }).length;
    if (allowSingle && nonzero === 1) return { difficulty: LEVELS[d.findIndex(function (v) { return v > 0; })] };
    return { difficulty_counts: d.slice() };
  };
  f.reset = function () { f.nameTouched = false; f.picking = false; f.name = ""; f.sourceChanged(); };

  /* ---------- vẽ ---------- */
  function renderSource() {
    var sub = currentSubject();
    id("subject-name").textContent = sub ? sub.name : "Chưa có Môn học";
    var items = subjectItems(sub);
    id("src-list").innerHTML = items.length ? items.map(function (x) {
      var on = isPicked(x.kind, x.item.id);
      return '<button type="button" class="' + C + "-chip" + (on ? " on" : "") + '" data-kind="' + x.kind + '" data-id="' + esc(x.item.id) +
        '" role="checkbox" aria-checked="' + on + '" title="' + esc(x.item.name) + '">' +
        '<span class="' + C + '-cb">' + CHECK_SVG + '</span><span class="nm">' + esc(x.item.name) + "</span>" +
        (x.kind === "pdf" ? '<span class="kd">PDF</span>' : "") + "</button>";
    }).join("") : '<div class="' + C + '-chips-empty">' + (sub
      ? "Môn này chưa có Chương hay tệp PDF nào — thêm nội dung ở Notebook trước."
      : "Chưa có Môn học nào trong Notebook.") + "</div>";
    var n = f.picked.length, st = f.stats && f.stats.data;
    id("src-summary").textContent = !n ? "Chưa chọn nguồn nào"
      : n + " nguồn" + (st ? " · " + st.word_count.toLocaleString("vi-VN") + " từ" : "");
  }

  function toggleSubjectMenu() {
    var m = id("subject-menu");
    if (!m.hidden) { m.hidden = true; return; }
    var subs = realSubjects();
    m.innerHTML = subs.length ? subs.map(function (s) {
      return '<button type="button" data-s="' + esc(s.id) + '"' + (s.id === f.subjectId ? ' class="on"' : "") + ">" + esc(s.name) + "</button>";
    }).join("") : '<div class="empty">Chưa có Môn học nào.</div>';
    m.hidden = false;
  }

  function renderDiff(countOk) {
    if (cfg.mix) return cfg.mix.render(countOk);
    var d = f.dist(), total = d[0] + d[1] + d[2];
    id("diff-box").classList.toggle(C + "-custom", f.diffMode === "custom");
    id("diff-box").classList.toggle(C + "-faded", !countOk);
    Array.prototype.forEach.call(id("diff-mode").children, function (b) { b.classList.toggle("on", b.dataset.v === f.diffMode); });
    id("levels").innerHTML = d.map(function (v, i) {
      var lb = LEVEL_LABEL[LEVELS[i]];
      return '<div class="' + C + '-level"><div class="t"><div class="' + C + '-muted">' + lb + "</div><div>" + v + "</div></div>" +
        '<div class="pm"><button type="button" data-i="' + i + '" data-d="-1"' + (v <= 0 ? " disabled" : "") + ' aria-label="Giảm ' + lb + '">−</button>' +
        '<button type="button" data-i="' + i + '" data-d="1"' + (total >= f.count ? " disabled" : "") + ' aria-label="Tăng ' + lb + '">+</button></div></div>';
    }).join("");
    d.forEach(function (v, i) { id("b" + i).style.flex = v + " 0 0"; });
    var note = id("diff-note");
    if (!countOk) note.textContent = "Nhập số câu hợp lệ để phân bổ độ khó";
    else if (f.diffMode === "auto") note.textContent = "Khuyến nghị: 30% dễ · 40% trung bình · 30% khó";
    else note.innerHTML = '<span class="' + C + (total === f.count ? "-navy" : "-red") + '">Tổng ' + total + " / " + f.count + " câu</span> · chỉnh từng mức bằng − +";
    return total === f.count;
  }

  // Trả true khi đủ điều kiện bấm nút tạo; đồng thời vẽ gợi ý/lỗi/độ khó + trạng thái nút.
  f.validate = function () {
    if (cfg.count === false) return validateNoCount();
    var hasSrc = f.picked.length > 0, n = f.count, st = f.stats;
    var max = st && st.data ? Math.min(cfg.maxCount, st.data.max_questions) : null; // null = chưa biết
    var loading = !!(st && st.loading);
    var err = "";
    if (hasSrc) {
      if (f.countRaw === "" || n < cfg.minCount) err = "Nhập số " + (U === "câu" ? "câu hỏi" : U) + " (ít nhất " + cfg.minCount + " " + U + ").";
      else if (n > cfg.maxCount) err = "Mỗi " + cfg.unit + " tối đa " + cfg.maxCount + " " + U + ".";
      else if (max !== null && n > max) err = max >= cfg.minCount
        ? "Nguồn đã chọn chỉ đủ dữ liệu cho tối đa " + max + " " + U + ". Hãy giảm số " + U + " hoặc thêm nguồn."
        : max > 0
          ? "Nguồn đã chọn chỉ đủ dữ liệu cho " + max + " " + U + ", chưa đủ " + cfg.minCount + " " + U + " tối thiểu. Hãy thêm nguồn."
          : "Các nguồn đã chọn chưa có nội dung nào sẵn sàng cho AI (Chương chưa có nội dung, hoặc tệp PDF không trích được chữ). Hãy chọn nguồn khác.";
    }
    var countOk = hasSrc && !err;
    id("f-count").classList.toggle("err", !!err);
    id("count-err").hidden = !err;
    id("count-err").textContent = err;
    var hint = "";
    if (!err) {
      if (!hasSrc) hint = "Chọn ít nhất một nguồn để xem gợi ý số " + U;
      else if (loading) hint = "Đang tính gợi ý số " + U + "…";
      else if (max !== null) {
        var lo = Math.max(cfg.minCount, st.data.suggested_min);
        hint = "Gợi ý: " + (lo < max ? lo + "–" : "") + max + " " + U + " với nguồn đã chọn";
      } else hint = cfg.minCount > 1 ? "Từ " + cfg.minCount + " đến " + cfg.maxCount + " " + U : "Tối đa " + cfg.maxCount + " " + U;
    }
    id("count-hint").textContent = hint;
    var diffOk = renderDiff(countOk);
    var nameOk = f.name.trim() !== "";
    // Mở form tên để trống là bình thường -> chỉ tô đỏ khi người học đã bấm chọn nguồn mà tên vẫn trống.
    id("f-name").classList.toggle("err", !nameOk && hasSrc && f.picking);
    var j = cfg.job();
    var ok = countOk && diffOk && nameOk && !loading && !j;
    var btn = id("create");
    btn.disabled = !ok;
    btn.classList.toggle("busy", !!(j && !j.done));
    btn.innerHTML = j && !j.done ? '<span class="' + C + '-spin"></span>Đang tạo' : cfg.createLabel;
    f.fit(); // dòng lỗi/gợi ý số câu hiện-ẩn làm đổi chiều cao
    return ok;
  };

  // Biến thể không có ô số lượng (cfg.count === false): chỉ cần nguồn có nội dung + tên.
  function validateNoCount() {
    var hasSrc = f.picked.length > 0, st = f.stats;
    var loading = !!(st && st.loading);
    var empty = hasSrc && st && st.data && !st.data.word_count;
    var errBox = id("count-err");
    if (errBox) {
      errBox.hidden = !empty;
      errBox.textContent = empty ? "Các nguồn đã chọn chưa có nội dung nào sẵn sàng cho AI (Chương chưa có nội dung, hoặc tệp PDF không trích được chữ). Hãy chọn nguồn khác." : "";
    }
    var srcOk = hasSrc && !empty;
    var mixOk = cfg.mix ? cfg.mix.render(srcOk) : true;
    var nameOk = f.name.trim() !== "";
    id("f-name").classList.toggle("err", !nameOk && hasSrc && f.picking);
    var j = cfg.job();
    var ok = srcOk && mixOk && nameOk && !loading && !j;
    var btn = id("create");
    btn.disabled = !ok;
    btn.classList.toggle("busy", !!(j && !j.done));
    btn.innerHTML = j && !j.done ? '<span class="' + C + '-spin"></span>Đang tạo' : cfg.createLabel;
    f.fit();
    return ok;
  }

  /* Trang Tạo mới: cỡ hiển thị tính theo cửa sổ PHÓNG TO TỐI ĐA chứ không theo cửa sổ hiện tại —
     phóng to thì vừa khít, không thanh cuộn dọc; thu nhỏ cửa sổ thì vẫn giữ đúng cỡ chữ/bố cục đó và
     cuộn dọc (người dùng yêu cầu cả 2 điều). Chiều cao vùng nội dung khi phóng to = chiều cao hiện tại +
     phần cửa sổ còn thiếu so với màn hình (screen.availHeight trừ thanh công cụ trình duyệt). Nội dung
     cao hơn thì thu đều chữ + khoảng cách bằng `zoom` (chỉ giảm cỡ chữ thì padding vẫn giữ nguyên nên
     không hết cuộn), không nhỏ hơn FIT_MIN.
     CHỈ áp dụng khi trình duyệt đang PHÓNG TO TRANG (Ctrl +) — người dùng đã duyệt cách hiển thị đó, cấm
     đổi. Ở zoom trình duyệt bình thường (100%) thì KHÔNG thu nhỏ: giữ cỡ gốc, không đủ chỗ thì cuộn dọc.
     Mức zoom trình duyệt ≈ outerWidth / innerWidth (outerWidth không đổi theo zoom trang, innerWidth tính
     bằng CSS px nên co lại khi phóng to); ngưỡng 1.1 chừa chỗ cho viền cửa sổ + thanh bên của trình duyệt. */
  var PAGE_ZOOM_MIN = 1.1;
  f.fit = function () {
    if (!cfg.active()) return;
    var body = id("pane").querySelector("." + C + "-body"), form = id("new");
    form.style.zoom = "";
    // Máy cảm ứng (iPad / điện thoại) và cửa sổ hẹp: outerWidth/innerWidth không phải mức zoom trang (pinch-zoom,
    // thanh địa chỉ co giãn) -> không thu nhỏ, để bố cục responsive 1 cột + cuộn dọc (css/responsive.css).
    if (window.innerWidth < 1024 || (window.matchMedia && window.matchMedia("(pointer:coarse)").matches)) return;
    var pageZoom = window.innerWidth ? window.outerWidth / window.innerWidth : 1;
    if (pageZoom < PAGE_ZOOM_MIN) return; // zoom 100%: giữ cỡ gốc + thanh cuộn dọc
    var browserBars = Math.max(0, window.outerHeight - window.innerHeight);
    var maxInner = window.screen && window.screen.availHeight ? window.screen.availHeight - browserBars : window.innerHeight;
    var extra = Math.max(0, maxInner - window.innerHeight); // cửa sổ đang thấp hơn lúc phóng to bao nhiêu
    var need = form.offsetHeight, avail = body.clientHeight + extra;
    if (!need || !avail || need <= avail) return;
    var z = Math.max(FIT_MIN, Math.floor(avail / need * 100) / 100);
    form.style.zoom = String(z);
    // Làm tròn pixel khi zoom có thể còn tràn 1-2px -> giảm tiếp từng 1% tới khi vừa khung lúc phóng to.
    while (body.scrollHeight - body.clientHeight > extra && z > FIT_MIN) {
      z = Math.max(FIT_MIN, Math.round((z - 0.01) * 100) / 100);
      form.style.zoom = String(z);
    }
  };

  // Vẽ phần chung của trang Tạo mới (module vẽ thêm phần riêng rồi gọi renderPanel).
  f.render = function () {
    id("main").classList.toggle(C + "-locked", locked());
    renderSource();
    var nameIn = id("name");
    if (document.activeElement !== nameIn) nameIn.value = f.name;
    var countIn = id("count");
    if (countIn && document.activeElement !== countIn) countIn.value = f.countRaw;
    f.validate();
  };

  /* ---------- Ô "Đang tạo" ---------- */
  // Bước hiện tại theo THỜI GIAN đã chờ: đọc nguồn ~3s, soạn câu ~ (6 + 1.2s/câu), còn lại là bước 3.
  function jobStep(j) {
    var sec = (Date.now() - j.t0) / 1000;
    if (sec < 3) return 0;
    return sec < 3 + 6 + 1.2 * j.total ? 1 : 2;
  }
  // errorText: lỗi tạo gần nhất (hiện khi không có job). doneHtml(j): nội dung khi đã xong.
  f.renderPanel = function (errorText, doneHtml) {
    var p = id("panel"), j = cfg.job(), T = cfg.panel;
    p.classList.toggle("run", !!j);
    if (!j) {
      p.innerHTML = '<span class="' + C + '-h3">Đang tạo</span>' + (errorText
        ? '<p class="' + C + '-red">' + esc(errorText) + "</p>"
        : '<p class="' + C + '-muted">' + T.idle + "</p>");
    } else if (j.done) {
      p.innerHTML = '<div class="' + C + '-p-head"><span class="' + C + '-h3">Đã tạo xong</span><span class="' + C + '-h3" style="color:var(--' + C + '-green)">✓</span></div>' +
        '<div class="' + C + '-pbar"><i></i></div>' +
        '<div class="' + C + '-ready">' + doneHtml(j) +
        '<div class="acts"><button type="button" class="' + C + '-btn-primary sm" data-act="start">' + T.startLabel + "</button>" +
        '<button type="button" class="' + C + '-link" data-act="again">' + T.againLabel + "</button></div></div>";
    } else {
      var step = jobStep(j), sec = Math.floor((Date.now() - j.t0) / 1000);
      var row = function (i) {
        var cls = step > i ? "done" : step === i ? "now" : "";
        var label = T.steps[i].replace("{n}", j.nSrc).replace("{c}", j.total);
        return '<div class="' + C + "-step " + cls + '"><span class="ic">' + (step > i ? CHECK_SVG : "") + '</span><span class="t">' +
          label + '</span><span class="s">' + (step > i ? "Xong" : "") + "</span></div>";
      };
      p.innerHTML = '<div class="' + C + '-p-head"><span class="' + C + '-h3">Đang tạo</span><span class="' + C + '-muted">' + sec + " giây</span></div>" +
        '<div class="' + C + '-pbar indet"><i></i></div>' +
        '<div class="' + C + '-steps">' + row(0) + row(1) + row(2) + "</div>" +
        '<button type="button" class="' + C + '-btn-text" data-act="cancel" style="align-self:flex-start">Hủy</button>';
    }
    f.fit();
  };

  /* ---------- sự kiện (gắn 1 lần) ---------- */
  f.bind = function () {
    window.addEventListener("resize", f.fit);
    id("subject-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (!locked()) toggleSubjectMenu();
    });
    id("subject-menu").addEventListener("click", function (e) {
      e.stopPropagation();
      var b = e.target.closest("button[data-s]"); if (!b) return;
      if (b.dataset.s !== f.subjectId) { f.subjectId = b.dataset.s; f.picked = []; f.sourceChanged(true); }
      id("subject-menu").hidden = true;
      cfg.onChange();
    });
    document.addEventListener("click", function () { var m = id("subject-menu"); if (m) m.hidden = true; });
    id("src-list").addEventListener("click", function (e) {
      var c = e.target.closest("." + C + "-chip"); if (!c || locked()) return;
      var kind = c.dataset.kind, itemId = c.dataset.id;
      if (isPicked(kind, itemId)) f.picked = f.picked.filter(function (p) { return !(p.kind === kind && p.id === itemId); });
      else f.picked.push({ kind: kind, id: itemId });
      f.sourceChanged(true);
      cfg.onChange();
    });
    id("name").addEventListener("input", function (e) {
      f.name = e.target.value;
      f.nameTouched = f.name.trim() !== ""; // xoá trắng -> lần bấm chọn nguồn sau lại tự điền
      f.validate();
    });
    if (cfg.nameSuffix) id("name").addEventListener("blur", function (e) {
      var n = f.finalName();
      if (n && n !== f.name) { f.name = n; e.target.value = n; }
    });
    if (cfg.count === false) { if (cfg.mix && cfg.mix.bind) cfg.mix.bind(); return; }
    id("count").addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 2);
      f.countRaw = e.target.value; f.count = parseInt(f.countRaw, 10) || 0;
      if (f.diffMode === "custom") f.custom = split(f.count);
      f.validate();
    });
    id("count").addEventListener("keydown", function (e) {
      if (e.key === "Enter") e.target.blur();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        f.count = Math.min(cfg.maxCount, Math.max(cfg.minCount, f.count + (e.key === "ArrowUp" ? 1 : -1)));
        e.target.value = f.countRaw = String(f.count);
        if (f.diffMode === "custom") f.custom = split(f.count);
        f.validate();
      }
    });
    if (cfg.mix) { if (cfg.mix.bind) cfg.mix.bind(); return; }
    id("diff-mode").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]"); if (!b) return;
      f.diffMode = b.dataset.v;
      if (f.diffMode === "custom") f.custom = split(f.count);
      f.validate();
    });
    id("levels").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-d]"); if (!b || b.disabled) return;
      var i = Number(b.dataset.i);
      f.custom[i] = Math.max(0, f.custom[i] + Number(b.dataset.d));
      f.validate();
    });
  };

  return f;
}
