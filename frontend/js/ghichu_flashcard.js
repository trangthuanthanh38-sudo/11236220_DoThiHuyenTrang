/* ======================================================================
   ghichu_flashcard.js — MODULE "Tạo flashcard" (UC-23, Studio AI). HTML ở
   html/ghichu_flashcard.frag (nạp vào #mount-flashcard-pane), style ở css/ghichu_flashcard.css.
   Bố cục/luồng theo giao diện mẫu `flashcard mới.html` — cùng khuôn với Ôn tập / Thi thử:
     Tạo mới    — chọn Môn + tick Chương/Tệp PDF, tên bộ, số thẻ (5–50, gợi ý/tối đa theo nguồn), loại
                  thẻ (Cả hai = chia đều, lẻ ưu tiên thuật ngữ / chỉ Thuật ngữ / chỉ Câu hỏi), "Khi ôn"
                  (Trộn thứ tự thẻ, Hiện nguồn ở mặt sau), ô "Đang tạo". Form chung: ghichu_studio_form.js.
     Đã tạo     — bảng bộ thẻ: Số thẻ / Lần ôn / Lần gần nhất (số thẻ khó) / Ôn lại vào; Lịch sử các lần
                  ôn; "Bắt đầu ôn" / "Ôn lại" (luôn ôn CẢ BỘ — cột "Ôn lại vào" chỉ để nhắc); xoá
     Ôn thẻ     — lật thẻ (bấm / Space), chấm Khó (1) / Dễ (2), Thẻ trước / Bỏ qua (← / →)
     Hoàn thành — Dễ / Khó / Bỏ qua / Chuỗi ngày ôn, xem lại từng thẻ (phân trang, "Chỉ hiện thẻ khó"),
                  "Ôn lại thẻ khó"; Xem lại 1 thẻ — mặt sau + đánh giá của bạn + lịch ôn lại
   Kết quả CHỈ ghi khi ôn XONG cả phiên (1 request) -> 1 "Lần ôn" trong lịch sử. Tiến độ phiên đang ôn
   lưu tạm ở localStorage `td_fc_resume` nên F5 / rời màn (bấm Nguồn, chuyển công cụ) vẫn ôn tiếp
   được; bấm × giữa phiên + xác nhận thì bỏ phiên (không lưu gì).

   Backend: backend/app/routers/flashcards.py + services/flashcard_generation.py; database
   studio_tools_flashcard_schema.sql + _v2. Lịch lặp lại ngắt quãng do SERVER tính (Khó -> 10 phút;
   Dễ -> 3 ngày rồi x2,5, tối đa 180 ngày) — frontend chỉ hiển thị. Đổi field nào thì sửa normalizeSet()
   và schemas.py (Flashcard*):
     POST /quiz/source-stats {subject_id, sources, mode:'flashcard'} -> {word_count, max_questions (= thẻ), ...}
     POST /flashcards/sets  {subject_id, sources:[{source_type, id}], title, requested_count (5-50),
                             type_counts:[thuật ngữ, câu hỏi], shuffle, show_citation}
       -> bộ thẻ: {id, title, subject_id, requested_count, card_count, shuffle, show_citation,
                   session_count, streak_days, cards:[{id, position, card_type, front, back,
                   next_intervals:{hard, easy} (giây), citation:{source_label, page_number, quote,
                   chapter_id, document_id}}]}
     GET  /flashcards/sets            -> [{id, title, source_labels, card_count, session_count,
                                          last_hard_count, next_due_in_seconds, ...}]
     GET  /flashcards/sets/{id}       -> bộ thẻ (thứ tự gốc)
     POST /flashcards/sets/{id}/sessions {kind:'full'|'hard', duration_seconds,
                                          ratings:[{card_id, rating:'easy'|'hard'|'skip'}]}
                                       -> {session_no, cards:[{card_id, interval_seconds, next_intervals}], streak_days}
     GET  /flashcards/sets/{id}/sessions -> [{session_no, card_total, easy_count, hard_count,
                                             duration_seconds, finished_seconds_ago}] (mới nhất trước)
     DELETE /flashcards/sets/{id}
   Mốc thời gian dùng khoảng TƯƠNG ĐỐI do server trả (giây) — DATETIME của DB không kèm múi giờ.

   Khi CHƯA đăng nhập ("chế độ mẫu", isOnline() ở ghichu_core.js) thì "Tạo bộ thẻ" dựng bộ thẻ minh
   hoạ SAMPLE_CARDS cục bộ để xem được toàn bộ luồng ôn (không gọi API, không lưu gì).
   Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi `fc.open` rồi gọi hooks.syncLayout().
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, closeDropdownEl, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";
import { createCardList, histRow, histEmpty } from "./ghichu_cardlist.js";
import { createStudioForm, pad, agoDate, fmtDay, fmtTime, fmtDuration, apiErrorText } from "./ghichu_studio_form.js";

var MIN_COUNT = 5, MAX_COUNT = 50;        // khớp CHECK chk_flashcard_sets_requested_count
var HISTORY_MAX = 4;                      // tab "Đã tạo": số lần ôn hiện khi mở 1 bộ
var TYPE_FULL = { term: "Thuật ngữ – Định nghĩa", qa: "Câu hỏi – Đáp án ngắn" };
var TYPE_SHORT = { term: "Thuật ngữ", qa: "Câu hỏi" };
var RATING_LABEL = { easy: "Dễ", hard: "Khó", skip: "Bỏ qua" };
var NEW_CARD_INTERVALS = { hard: 600, easy: 3 * 86400 }; // thẻ mới — chỉ dùng cho chế độ mẫu

// Nhớ phiên đang ôn để F5 / rời màn rồi quay lại vẫn ôn tiếp đúng thẻ (xoá khi xong hoặc bỏ phiên).
var RESUME_KEY = "td_fc_resume";
function saveResumeData(d) { try { localStorage.setItem(RESUME_KEY, JSON.stringify(d)); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return JSON.parse(localStorage.getItem(RESUME_KEY) || "null"); } catch (e) { return null; } }

// Bộ thẻ minh hoạ cho chế độ mẫu — nói về chính cách ôn flashcard, không giả làm trích dẫn thật.
var SAMPLE_SOURCE = "Thẻ minh hoạ (chế độ mẫu)";
var SAMPLE_CARDS = [
  { type: "term", front: "Flashcard", back: "Thẻ ghi nhớ hai mặt: mặt trước là thuật ngữ hoặc câu hỏi, mặt sau là định nghĩa hoặc đáp án ngắn." },
  { type: "term", front: "Lặp lại ngắt quãng", back: "Phương pháp ôn lại một nội dung sau những khoảng thời gian tăng dần, ngay trước lúc sắp quên, để nhớ lâu hơn." },
  { type: "term", front: "Chủ động nhớ lại", back: "Tự lục lại câu trả lời trong trí nhớ trước khi xem đáp án — hiệu quả hơn đọc lại nhiều lần." },
  { type: "term", front: "Đường cong lãng quên", back: "Mô tả việc trí nhớ suy giảm nhanh theo thời gian nếu không được ôn lại." },
  { type: "qa", front: "Khi nào nên chấm một thẻ là “Khó”?", back: "Khi phải nghĩ lâu, nhớ sai hoặc không nhớ ra — thẻ sẽ được đưa lại sớm để ôn tiếp." },
  { type: "qa", front: "Thẻ “Dễ” được ôn lại sau bao lâu?", back: "Khoảng 3 ngày, và giãn dần ra ở các lần ôn tiếp theo." },
  { type: "qa", front: "Vì sao mỗi thẻ cần ghi nguồn?", back: "Để đối chiếu lại đúng đoạn tài liệu gốc khi thấy nội dung thẻ chưa rõ hoặc nghi sai." },
  { type: "qa", front: "Phím tắt để lật thẻ là gì?", back: "Phím Space; sau khi lật, phím 1 chấm Khó, phím 2 chấm Dễ." },
];

/* ---------------- state riêng của module ---------------- */
var fc = {
  open: false,
  screen: "setup",          // setup | saved | study | card | done
  // --- Tạo mới (nguồn/tên/số thẻ ở `form` — ghichu_studio_form.js) ---
  type: "both",             // both | term | qa
  opts: { shuffle: true, showCite: true },
  job: null,                // ô "Đang tạo": {t0, total, nSrc, controller, timer, done, set}
  error: "",
  // --- Đã tạo ---
  saved: null,              // GET /flashcards/sets (null = chưa tải)
  savedError: "",
  openSaved: null,          // id bộ đang mở lịch sử
  history: {},              // id -> [lần ôn] | "loading" | "error"
  // --- Ôn thẻ ---
  set: null,                // bộ đang ôn (normalizeSet())
  sess: null,               // {kind, order:[chỉ số thẻ], idx, ratings, est, startedAt, elapsed}
  flipped: false,
  notice: "",
  // --- Hoàn thành / Xem lại 1 thẻ ---
  result: null,             // {kind, order, ratings, intervals, sec, sessionNo, streak, status}
  onlyHard: false,
  page: 0,
  perPage: 8,
  cIdx: 0,
};

export function isOpen() { return fc.open; }

// "Cả hai" = chia đều, lẻ ưu tiên thuật ngữ — [thuật ngữ, câu hỏi].
function typeSplit(n) {
  if (fc.type === "term") return [n, 0];
  if (fc.type === "qa") return [0, n];
  var t = Math.ceil(n / 2);
  return [t, n - t];
}

// Form "Tạo mới" dùng chung với Ôn tập / Thi thử; ô "Loại thẻ" thay ô "Phân bổ độ khó" (cfg.mix).
var form = createStudioForm({
  ids: "fc", cls: "fc", mode: "flashcard",
  minCount: MIN_COUNT, maxCount: MAX_COUNT, defaultCount: 20, unitWord: "thẻ", nameSuffix: true,
  createLabel: "Tạo bộ thẻ", unit: "bộ thẻ",
  panel: {
    idle: "Chưa có bộ thẻ nào đang tạo. Tiến độ sẽ hiện ở đây sau khi bạn bấm Tạo bộ thẻ.",
    steps: ["Đọc {n} nguồn nội dung", "Trích khái niệm, soạn {c} thẻ", "Loại thẻ trùng, gắn nguồn"],
    startLabel: "Ôn ngay", againLabel: "Tạo bộ khác",
  },
  active: function () { return fc.open && fc.screen === "setup"; },
  job: function () { return fc.job; },
  onChange: function () { renderSetup(); },
  mix: {
    render: function (countOk) {
      var d = typeSplit(form.count);
      $("fc-type-box").classList.toggle("fc-faded", !countOk);
      Array.prototype.forEach.call($("fc-type-mode").children, function (b) { b.classList.toggle("on", b.dataset.v === fc.type); });
      $("fc-levels").innerHTML = ["term", "qa"].map(function (k, i) {
        return '<div class="fc-level"><div class="t"><div class="fc-muted">' + TYPE_FULL[k] + "</div><div>" + d[i] + " thẻ</div></div></div>";
      }).join("");
      $("fc-b0").style.flex = d[0] + " 0 0";
      $("fc-b1").style.flex = d[1] + " 0 0";
      $("fc-type-note").textContent = !countOk ? "Nhập số thẻ hợp lệ để chia loại thẻ"
        : fc.type === "both" ? "Chia đều hai loại, ưu tiên thuật ngữ khi số thẻ lẻ"
        : "Chỉ tạo thẻ " + TYPE_FULL[fc.type].toLowerCase();
      return true;
    },
    bind: function () {
      $("fc-type-mode").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-v]"); if (!b || fc.job) return;
        fc.type = b.dataset.v;
        form.validate();
      });
    },
  },
});

/* ====================================================================
   Mở / đóng
   ==================================================================== */
// Mở (bấm thẻ "Tạo Flashcard"): GIỮ NGUYÊN trang đang dở (đang ôn / hoàn thành / xem lại / Đã tạo) —
// vd. vừa bấm "Nguồn" để xem tài liệu gốc rồi quay lại. Còn phiên lưu tạm (F5) thì ôn tiếp phiên đó.
export function openFlashcard() {
  fc.open = true;
  state.dd = null;
  closeDropdownEl();
  form.initSource();
  hooks.syncLayout();
  if (!fc.sess && readResume() && isOnline()) { resumeIfNeeded(); return; }
  if (fc.screen === "study" && !fc.sess) fc.screen = "saved";
  if ((fc.screen === "done" || fc.screen === "card") && !fc.result) fc.screen = "setup";
  show(fc.screen);
  refreshSaved();
}

// Ẩn màn Flashcard (chuyển công cụ / bấm "Nguồn" / về Notebook). Trang và phiên đang ôn giữ nguyên
// trong bộ nhớ + localStorage — bấm lại thẻ "Tạo Flashcard" là về đúng chỗ.
export function closeFlashcard() {
  fc.open = false;
  if (list) list.leave();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
}

function show(screen) {
  fc.screen = screen;
  render();
  $("fc-body").scrollTop = 0;
}

function toast(msg) {
  var t = $("fc-toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { t.hidden = true; }, 3200);
}

function render() {
  if (!fc.open) return;
  var sc = fc.screen, formView = sc === "setup" || sc === "saved";
  ["setup", "saved", "study", "card", "done"].forEach(function (s) { $("fc-s-" + s).hidden = s !== sc; });
  $("fc-tabbar").hidden = !formView;
  Array.prototype.forEach.call($("fc-tabs").children, function (b) {
    b.classList.toggle("on", (b.dataset.tab === "new" ? "setup" : "saved") === sc);
  });
  $("fc-saved-count").textContent = fc.saved && fc.saved.length ? fc.saved.length : "";
  $("fc-create").hidden = sc !== "setup";
  $("fc-head-note").hidden = sc !== "study" && sc !== "card";
  $("fc-head-note").textContent = sc === "card" ? "Đang xem lại phiên ôn" : "Phím Space để lật · 1 Khó · 2 Dễ";
  $("fc-title").textContent = formView || !fc.set ? "Tạo flashcard" : fc.set.title;
  if (sc === "setup") renderSetup();
  else if (sc === "saved") renderSaved();
  else if (sc === "study") renderStudy();
  else if (sc === "card") renderOne();
  else renderDone();
}

// Nút × : Tạo mới/Đã tạo -> về Notebook; đang ôn -> hỏi rồi BỎ phiên (không lưu); xem lại 1 thẻ ->
// Hoàn thành; Hoàn thành -> Đã tạo.
function onClose() {
  if (fc.screen === "study") {
    if (!window.confirm("Dừng phiên ôn? Các thẻ đã đánh giá sẽ không được lưu.")) return;
    fc.sess = null;
    clearResume();
    refreshSaved();
    show(fc.set && fc.set.sample ? "setup" : "saved");
    return;
  }
  if (fc.screen === "card") { show("done"); return; }
  if (fc.screen === "done") { refreshSaved(); show(fc.set && fc.set.sample ? "setup" : "saved"); return; }
  closeFlashcard();
}

/* ====================================================================
   TẠO MỚI — phần riêng flashcard: loại thẻ, "Khi ôn", gọi POST /flashcards/sets
   ==================================================================== */
function renderSetup() {
  $("fc-opts").style.pointerEvents = fc.job ? "none" : "";
  $("fc-opts").querySelectorAll(".fc-sw-row").forEach(function (r) {
    r.classList.toggle("on", !!fc.opts[r.dataset.k]);
    r.setAttribute("aria-pressed", String(!!fc.opts[r.dataset.k]));
  });
  form.render();
  renderPanel();
}

function renderPanel() {
  form.renderPanel(fc.error, function (j) {
    var s = j.set, n = s.cards.length, fewer = s.requested > n;
    return '<p><b style="font-weight:500">' + esc(s.title) + '</b><br><span class="fc-muted">' + n + " thẻ · " +
      (s.sample ? "bộ minh hoạ, chế độ mẫu không lưu" : "đã lưu vào tab Đã tạo") +
      (fewer ? " (nội dung nguồn chỉ đủ khái niệm cho " + n + "/" + s.requested + " thẻ)" : "") + "</span></p>";
  });
  // Chế độ mẫu: chưa có Môn thật để chọn nguồn -> cho xem thử luồng ôn bằng bộ thẻ minh hoạ.
  if (!isOnline() && !fc.job) {
    $("fc-panel").insertAdjacentHTML("beforeend", '<p class="fc-muted">Chế độ mẫu: đăng nhập để AI tạo flashcard từ tài liệu của bạn.</p>' +
      '<button type="button" class="fc-link" data-act="sample" style="align-self:flex-start">Xem bộ thẻ minh hoạ</button>');
  }
}

function sampleSet(counts) {
  var pick = function (type, n) { return SAMPLE_CARDS.filter(function (c) { return c.type === type; }).slice(0, n); };
  var cards = pick("term", counts[0]).concat(pick("qa", counts[1])).map(function (c, i) {
    return { id: "sample-" + i, type: c.type, front: c.front, back: c.back, next: NEW_CARD_INTERVALS, cite: { label: SAMPLE_SOURCE } };
  });
  return { id: null, title: form.name.trim() || "Bộ thẻ minh hoạ", subjectId: null, requested: counts[0] + counts[1],
    shuffle: fc.opts.shuffle, showCite: fc.opts.showCite, sessionCount: 0, sample: true, cards: cards };
}

function createSet() {
  if (fc.job || !form.validate()) return;
  var counts = typeSplit(form.count);
  if (!isOnline()) {
    // Chế độ mẫu: dựng ngay bộ minh hoạ theo loại/số thẻ đã chọn, không gọi API.
    fc.error = "";
    fc.job = { t0: Date.now(), total: form.count, nSrc: 1, done: true, set: sampleSet(counts) };
    renderSetup();
    return;
  }
  var body = form.sourcesForApi();
  body.title = form.finalName();   // luôn kèm " - <Môn>" (cfg.nameSuffix)
  body.requested_count = form.count;
  body.type_counts = counts;
  body.shuffle = fc.opts.shuffle;
  body.show_citation = fc.opts.showCite;

  var controller = window.AbortController ? new AbortController() : null;
  var job = { t0: Date.now(), total: form.count, nSrc: body.sources.length, controller: controller, done: false };
  fc.job = job; fc.error = "";
  job.timer = setInterval(function () { if (fc.open && fc.screen === "setup") renderPanel(); }, 1000);
  renderSetup();

  apiAuth("POST", "/flashcards/sets", authToken(), body, controller ? controller.signal : undefined).then(function (res) {
    if (fc.job !== job) return; // đã bấm Hủy
    clearInterval(job.timer);
    if (res.ok && (res.data.cards || []).length) {
      job.done = true;
      job.set = normalizeSet(res.data);
      refreshSaved(); // bộ mới xuất hiện ngay ở tab "Đã tạo"
    } else {
      fc.job = null;
      fc.error = res.ok ? "AI chưa tạo được thẻ nào từ nguồn đã chọn." : apiErrorText(res, "/flashcards/sets", "Không tạo được bộ flashcard.");
    }
    if (fc.open && fc.screen === "setup") renderSetup();
    else if (fc.open && job.done) toast("Đã tạo xong “" + job.set.title + "” — xem ở tab Đã tạo.");
  });
}

function cancelJob() {
  var j = fc.job;
  if (!j || j.done) return;
  clearInterval(j.timer);
  if (j.controller) j.controller.abort();
  fc.job = null;
  renderSetup();
  toast("Đã ngừng chờ. Nếu máy chủ đã kịp tạo xong, bộ thẻ vẫn sẽ hiện ở tab Đã tạo.");
  setTimeout(refreshSaved, 20000); // server vẫn có thể đang tạo nốt
}

function resetJob() {
  fc.job = null; fc.error = "";
  form.reset();
  if (fc.open && fc.screen === "setup") renderSetup();
}

// Chuẩn hoá phản hồi API về dạng màn ôn thẻ dùng (tách khỏi tên cột backend).
function normalizeSet(d) {
  return {
    id: d.id,
    title: d.title || "Bộ flashcard",
    subjectId: d.subject_id,
    requested: d.requested_count,
    shuffle: d.shuffle !== false,
    showCite: d.show_citation !== false,
    sessionCount: d.session_count || 0,
    sample: false,
    cards: (d.cards || []).slice().sort(function (a, b) { return a.position - b.position; }).map(function (c) {
      var ct = c.citation || {};
      return {
        id: c.id,
        type: c.card_type === "qa" ? "qa" : "term",
        front: c.front,
        back: c.back,
        next: c.next_intervals || NEW_CARD_INTERVALS,
        due: !!c.is_due,                     // đã ôn và tới hạn ôn lại (giờ máy chủ)
        hard: c.last_rating === "hard",
        cite: {
          label: ct.source_label ? ct.source_label + (ct.page_number ? " · trang " + ct.page_number : "") : "",
          quote: ct.quote || "",
          page: ct.page_number,
          chapter_id: ct.chapter_id,
          document_id: ct.document_id,
        },
      };
    }),
  };
}

/* ====================================================================
   ĐÃ TẠO — bảng (GET /flashcards/sets) + lịch sử lần ôn (GET /flashcards/sets/{id}/sessions)
   ==================================================================== */
function refreshSaved() {
  if (!isOnline()) { fc.saved = []; if (fc.open && (fc.screen === "setup" || fc.screen === "saved")) render(); return; }
  apiAuth("GET", "/flashcards/sets", authToken()).then(function (res) {
    fc.saved = res.ok && Array.isArray(res.data) ? res.data : (fc.saved || []);
    fc.savedError = res.ok ? "" : apiErrorText(res, "/flashcards/sets", "Không tải được danh sách bộ thẻ.");
    fc.history = {}; // lịch sử có thể đã đổi (vừa ôn xong) -> tải lại khi mở
    if (fc.openSaved) loadHistory(fc.openSaved);
    if (fc.open && (fc.screen === "setup" || fc.screen === "saved")) render();
  });
}

function loadHistory(id) {
  fc.history[id] = "loading";
  apiAuth("GET", "/flashcards/sets/" + id + "/sessions", authToken()).then(function (res) {
    fc.history[id] = res.ok && Array.isArray(res.data) ? res.data : "error";
    if (fc.open && fc.screen === "saved") renderSaved();
  });
}

// Đã tạo = lưới thẻ dùng chung (ghichu_cardlist.js, cùng khuôn Tóm tắt) — tạo trong initFlashcard().
var list = null;
function renderSaved() { if (list) list.render(); }

// Hộp "Lịch sử ôn" của 1 bộ (thay dòng mở rộng của bảng cũ).
function historyBody(s) {
  var h = fc.history[s.id];
  if (h === undefined) { loadHistory(s.id); h = "loading"; }
  if (h === "loading") return histEmpty("Đang tải…");
  if (h === "error") return histEmpty("Không tải được lịch sử ôn tập.");
  if (!h.length) return histEmpty("Chưa có lần ôn nào.");
  return h.map(function (a) {
    var pct = a.card_total ? Math.round(a.easy_count / a.card_total * 100) : 0;
    return histRow("Lần " + a.session_no, pct, a.easy_count + " dễ", a.hard_count + " khó · " + fmtDuration(a.duration_seconds) + (a.kind === "hard" ? " · thẻ khó" : ""), fmtTime(agoDate(a.finished_seconds_ago)));
  }).join("");
}

function byTitle(a, b) { return a.title.localeCompare(b.title, "vi", { numeric: true }); }
function byNum(v) { return function (a, b) { var x = v(a), y = v(b); return (x == null) - (y == null) || (x == null ? 0 : x - y); }; }
function dueLabel(sec) { return sec <= 0 ? "hôm nay" : fmtDay(new Date(Date.now() + sec * 1000)).toLowerCase(); }
function savedCard(s) {
  var n = s.session_count || 0;
  var src = (s.source_labels && s.source_labels.length ? s.source_labels.join(", ") : s.subject_name) || "";
  return {
    lines: [
      { cls: "l1", html: esc(src) },
      { html: s.card_count + " thẻ · " + (n ? n + " lần ôn" : "chưa ôn") },
      { html: n ? "Lần gần nhất: " + (s.last_hard_count || 0) + " thẻ khó" : s.new_count + " thẻ mới" },
    ],
    badge: s.due_count ? { text: s.due_count + " thẻ đến hạn ôn", cls: "warn" } : !n ? { text: "Chưa ôn", cls: "gone" }
      : s.next_due_in_seconds != null ? { text: "Ôn lại " + dueLabel(s.next_due_in_seconds), cls: "" } : { text: "Đã ôn", cls: "ok" },
    foot: s.last_session_seconds_ago != null ? "Ôn gần nhất " + fmtDay(agoDate(s.last_session_seconds_ago)).toLowerCase() : "Chưa ôn lần nào",
    acts: (n ? [{ act: "history", label: "Lịch sử" }] : []).concat([{ act: "start", label: n ? "Ôn lại" : "Bắt đầu ôn" }]),
    menu: [{ m: "start", label: "Ôn cả bộ" }, { m: "due", label: "Chỉ ôn thẻ đến hạn" + (s.due_count ? " (" + s.due_count + ")" : ""), disabled: !s.due_count },
      { m: "history", label: "Lịch sử ôn", disabled: !n }, { m: "del", label: "Xoá bộ thẻ", del: true }],
  };
}
function initSavedList() {
  list = createCardList({
    pane: $("fc-pane"), bar: $("fc-saved-bar"), box: $("fc-saved-list"), noun: "bộ thẻ",
    items: function () { return isOnline() ? fc.saved : []; },
    error: function () { return fc.savedError || ""; },
    notice: function () { return isOnline() ? "" : "Đăng nhập để lưu và ôn lại các bộ thẻ."; },
    id: function (s) { return String(s.id); }, title: function (s) { return s.title; },
    search: function (s) { return s.title + " " + (s.source_labels || []).join(" ") + " " + (s.subject_name || ""); },
    filters: [{ key: "all", label: "Tất cả" }, { key: "due", label: "Đến hạn ôn", test: function (s) { return s.due_count > 0; } },
      { key: "new", label: "Chưa ôn", test: function (s) { return !s.session_count; } }],
    sorts: {
      new: { label: "Mới tạo", cmp: function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; } },
      last: { label: "Ôn gần nhất", cmp: byNum(function (s) { return s.last_session_seconds_ago; }) },
      due: { label: "Đến hạn sớm nhất", cmp: byNum(function (s) { return s.session_count ? s.next_due_in_seconds : null; }) },
      az: { label: "Tên A–Z", cmp: byTitle },
    },
    card: savedCard, primary: function () { return "start"; },
    onAct: function (act, id) { if (act === "start") return openSavedSet(id); if (act === "due") return openSet(id); },
    newTile: { title: "Tạo bộ thẻ mới", sub: "Thuật ngữ và câu hỏi ngắn từ tài liệu" },
    onNew: function () { form.initSource(); show("setup"); },
    remove: {
      api: function (id) { return "/flashcards/sets/" + id; },
      after: function () { refreshSaved(); },
    },
    history: historyBody,
  });
}

// Từ thông báo "Nhắc ôn thẻ" (ghichu_thongbao.js -> ghichu.js openNotiTarget): CHỈ ôn các thẻ đang đến hạn (thẻ Khó
// trước, rồi thẻ Dễ đã tới ngày ôn lại) — không bắt ôn lại cả bộ. Đang ôn dở đúng bộ đó thì ôn tiếp phiên đang dở.
export function openSet(id) {
  if (fc.sess && fc.set && fc.set.id === id) { openFlashcard(); show("study"); return; }
  var d = readResume();
  if (!fc.sess && d && d.setId === id) { openFlashcard(); return; }
  fc.open = true;
  state.dd = null;
  closeDropdownEl();
  form.initSource();
  hooks.syncLayout();
  show("saved");
  refreshSaved();
  apiAuth("GET", "/flashcards/sets/" + id, authToken()).then(function (res) {
    if (!res.ok) { toast("Không tìm thấy bộ thẻ — có thể đã bị xoá."); return; }
    var set = normalizeSet(res.data);
    var due = set.cards.map(function (c, i) { return c.due ? i : -1; }).filter(function (i) { return i >= 0; });
    if (!due.length) { toast("Bộ “" + set.title + "” hiện không còn thẻ nào đến hạn ôn."); return; }
    due.sort(function (a, b) { return (set.cards[b].hard ? 1 : 0) - (set.cards[a].hard ? 1 : 0) || a - b; });
    var hard = due.filter(function (i) { return set.cards[i].hard; }).length;
    startStudy(set, due, hard === due.length ? "Phiên ôn lại " + hard + " thẻ khó đến hạn."
      : "Phiên ôn " + due.length + " thẻ đến hạn" + (hard ? " (" + hard + " thẻ khó trước)." : "."));
  });
}

function openSavedSet(id) {
  return apiAuth("GET", "/flashcards/sets/" + id, authToken()).then(function (res) {
    if (!res.ok) { window.alert(apiErrorText(res, "/flashcards/sets/{id}", "Không mở được bộ thẻ.")); refreshSaved(); return; }
    var set = normalizeSet(res.data);
    if (!set.cards.length) { window.alert("Bộ thẻ này không còn thẻ nào."); return; }
    startStudy(set);
  });
}

/* ====================================================================
   ÔN THẺ
   ==================================================================== */
function shuffled(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// `subset`: chỉ số thẻ cần ôn ("Ôn lại thẻ khó" / thẻ đến hạn khi bấm nhắc) — không truyền = cả bộ (trộn nếu bộ bật
// "Trộn thứ tự"). `notice`: dòng thông báo đầu phiên thay cho câu mặc định.
function startStudy(set, subset, notice) {
  var order = subset ? subset.slice() : set.cards.map(function (_, i) { return i; });
  if (!subset && set.shuffle) order = shuffled(order);
  fc.set = set;
  fc.result = null;
  fc.sess = { kind: subset ? "hard" : "full", order: order, idx: 0, ratings: order.map(function () { return null; }),
    est: order.map(function () { return null; }), startedAt: Date.now(), elapsed: 0 };
  fc.notice = notice ? notice : subset ? "Phiên ôn lại " + subset.length + " thẻ khó của lần trước."
    : set.sample ? "Chế độ mẫu: đây là bộ thẻ minh hoạ, kết quả không được lưu. Đăng nhập để AI tạo thẻ từ tài liệu của bạn." : "";
  saveProgress();
  if (!fc.open) { fc.open = true; hooks.syncLayout(); }
  show("study");
  $("fc-flip").focus({ preventScroll: true });
}

function elapsedSec() { var s = fc.sess; return Math.round((s.elapsed + (Date.now() - s.startedAt)) / 1000); }

function saveProgress() {
  var s = fc.sess;
  if (!s || !fc.set || fc.set.sample) return;
  saveResumeData({ setId: fc.set.id, kind: s.kind, ids: s.order.map(function (i) { return fc.set.cards[i].id; }), idx: s.idx,
    ratings: s.ratings, est: s.est, elapsed: s.elapsed + (Date.now() - s.startedAt), notice: fc.notice });
}

// F5 giữa phiên ôn (gọi cuối init() của ghichu.js) hoặc mở lại thẻ Flashcard -> ôn tiếp đúng thẻ.
export function resumeIfNeeded() {
  var d = readResume();
  if (!d || !d.setId || !isOnline()) return;
  apiAuth("GET", "/flashcards/sets/" + d.setId, authToken()).then(function (res) {
    if (!res.ok) { clearResume(); return; }
    var set = normalizeSet(res.data), pos = {};
    set.cards.forEach(function (c, i) { pos[c.id] = i; });
    var order = (d.ids || []).map(function (id) { return pos[id]; });
    if (!order.length || order.some(function (i) { return i === undefined; })) { clearResume(); return; }
    fc.set = set;
    fc.result = null;
    fc.sess = { kind: d.kind === "hard" ? "hard" : "full", order: order, idx: Math.min(d.idx || 0, order.length - 1),
      ratings: order.map(function (_, i) { return (d.ratings || [])[i] || null; }),
      est: order.map(function (_, i) { return (d.est || [])[i] || null; }), startedAt: Date.now(), elapsed: d.elapsed || 0 };
    fc.notice = d.notice || "";
    fc.open = true;
    form.initSource();
    hooks.syncLayout();
    show("study");
    refreshSaved();
  });
}

function card(i) { return fc.set.cards[fc.sess.order[i]]; }
function count(ratings, r) { return ratings.filter(function (x) { return x === r; }).length; }
function canOpenCite(c) { return !!(c.cite && (c.cite.chapter_id || c.cite.document_id)); }

// "10 phút" / "5 giờ" / "8 ngày".
function fmtInterval(s) {
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " phút";
  if (s < 86400) return Math.round(s / 3600) + " giờ";
  return Math.round(s / 86400) + " ngày";
}

function setCite(el, c, show) {
  el.textContent = c.cite && c.cite.label ? "Nguồn: " + c.cite.label : "";
  el.title = c.cite && c.cite.quote ? "“" + c.cite.quote + "”" : "";
  el.hidden = !show || !el.textContent;
  el.classList.toggle("can-open", canOpenCite(c));
}

function renderStudy() {
  var s = fc.sess, c = card(s.idx), n = s.order.length;
  $("fc-notice").hidden = !fc.notice;
  $("fc-notice-text").textContent = fc.notice;
  $("fc-pos").textContent = "Thẻ " + (s.idx + 1) + " / " + n;
  $("fc-tally").textContent = "Dễ " + count(s.ratings, "easy") + " · Khó " + count(s.ratings, "hard");
  $("fc-bar").style.width = (s.idx / n * 100) + "%";
  $("fc-f-label").textContent = "Mặt trước · " + TYPE_SHORT[c.type];
  $("fc-f-text").textContent = c.front;
  $("fc-f-text").classList.toggle("long", c.front.length > 40);
  $("fc-b-q").textContent = c.front;
  $("fc-b-a").textContent = c.back;
  setCite($("fc-b-src"), c, fc.set.showCite);
  $("fc-hard-when").textContent = "Ôn lại sau " + fmtInterval(c.next.hard);
  $("fc-easy-when").textContent = "Ôn lại sau " + fmtInterval(c.next.easy);
  $("fc-prev").disabled = s.idx === 0;
  setFlipped(false, true);
}

function setFlipped(v, instant) {
  fc.flipped = v;
  var inner = $("fc-flip-inner");
  if (instant) {
    inner.classList.add("no-anim");
    requestAnimationFrame(function () { requestAnimationFrame(function () { inner.classList.remove("no-anim"); }); });
  }
  $("fc-flip").classList.toggle("flipped", v);
  $("fc-flip").setAttribute("aria-label", v ? "Mặt sau của thẻ" : "Lật thẻ");
  $("fc-nav").hidden = v;
  $("fc-rate").hidden = !v;
}

function rate(r) {
  var s = fc.sess;
  s.ratings[s.idx] = r;
  s.est[s.idx] = card(s.idx).next[r]; // server tính giống hệt; phản hồi lúc lưu phiên sẽ ghi đè bằng số thật
  advance();
}
function skip() {
  var s = fc.sess;
  if (!s.ratings[s.idx]) s.ratings[s.idx] = "skip";
  advance();
}
function advance() {
  var s = fc.sess;
  if (s.idx < s.order.length - 1) { s.idx++; saveProgress(); renderStudy(); } else finish();
}
function prev() {
  var s = fc.sess;
  if (s.idx > 0) { s.idx--; saveProgress(); renderStudy(); }
}

/* ====================================================================
   HOÀN THÀNH — lưu cả phiên (POST /flashcards/sets/{id}/sessions)
   ==================================================================== */
function finish() {
  var s = fc.sess;
  var ratings = s.ratings.map(function (r) { return r || "skip"; });
  fc.result = {
    kind: s.kind, order: s.order.slice(), ratings: ratings,
    intervals: ratings.map(function (r, i) { return r === "skip" ? null : s.est[i]; }),
    sec: elapsedSec(), sessionNo: fc.set.sessionCount + 1, streak: null,
    status: fc.set.sample ? "sample" : "saving",
  };
  fc.sess = null;
  clearResume();
  fc.onlyHard = false; fc.page = 0;
  show("done");
  if (!fc.set.sample) saveSession();
}

function saveSession() {
  var r = fc.result, set = fc.set;
  r.status = "saving";
  var body = { kind: r.kind, duration_seconds: r.sec, ratings: r.order.map(function (ci, i) { return { card_id: set.cards[ci].id, rating: r.ratings[i] }; }) };
  apiAuth("POST", "/flashcards/sets/" + set.id + "/sessions", authToken(), body).then(function (res) {
    if (fc.result !== r) return;
    if (!res.ok) { r.status = "failed"; r.error = apiErrorText(res, "/flashcards/sets/{id}/sessions", "Chưa lưu được kết quả lên máy chủ."); }
    else {
      var byId = {};
      (res.data.cards || []).forEach(function (c) { byId[c.card_id] = c; });
      r.order.forEach(function (ci, i) {
        var c = set.cards[ci], got = byId[c.id];
        if (!got) return;
        if (got.next_intervals) c.next = got.next_intervals;
        if (r.ratings[i] !== "skip") r.intervals[i] = got.interval_seconds;
      });
      r.sessionNo = res.data.session_no;
      r.streak = res.data.streak_days;
      set.sessionCount = res.data.session_no;
      r.status = "saved";
      refreshSaved();
    }
    if (fc.open && (fc.screen === "done" || fc.screen === "card")) render();
  });
}

// Lịch ôn lại sau 1 khoảng (giây): < 1 ngày -> "sau 10 phút"; còn lại -> "ngày dd/mm".
function whenText(sec) {
  if (sec == null) return "";
  if (sec < 86400) return "sau " + fmtInterval(sec);
  var d = new Date(Date.now() + sec * 1000);
  return "ngày " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1);
}
function minOf(r, rating) {
  var v = r.intervals.filter(function (x, i) { return r.ratings[i] === rating && x != null; });
  return v.length ? Math.min.apply(null, v) : null;
}

function renderDone() {
  var r = fc.result, set = fc.set, n = r.order.length;
  var e = count(r.ratings, "easy"), h = count(r.ratings, "hard"), k = count(r.ratings, "skip");
  $("fc-d-total").textContent = (e + h) + " / " + n + " thẻ đã ôn";
  var t = r.sec < 60 ? r.sec + " giây" : Math.round(r.sec / 60) + " phút";
  $("fc-d-meta").textContent = set.title + (set.sample ? "" : "  ·  Lần ôn thứ " + r.sessionNo) + (r.kind === "hard" ? " (ôn lại thẻ khó)" : "") + "  ·  " + t;
  $("fc-d-easy").textContent = e + " thẻ";
  $("fc-d-hard").textContent = h + " thẻ";
  $("fc-d-skip").textContent = k + " thẻ";
  $("fc-d-streak").textContent = r.streak != null ? r.streak + " ngày" : r.status === "saving" ? "…" : "—";
  $("fc-d-easy-s").textContent = e ? "Ôn lại " + whenText(minOf(r, "easy")) : "Không có thẻ dễ";
  $("fc-d-hard-s").textContent = h ? "Ôn lại " + whenText(minOf(r, "hard")) : "Không có thẻ khó";
  $("fc-d-skip-s").textContent = k ? "Ôn ở phiên sau" : "Không có thẻ nào";
  $("fc-d-note").textContent = r.status === "sample" ? "Chế độ mẫu: kết quả không được lưu. Đăng nhập để lưu tiến độ ôn tập."
    : r.status === "saving" ? "Đang lưu kết quả…"
    : r.status === "failed" ? (r.error || "Chưa lưu được kết quả lên máy chủ.") + " Kiểm tra kết nối rồi thử lại."
    : "Kết quả đã được lưu vào lịch ôn.";
  $("fc-d-retry").hidden = r.status !== "failed";
  $("fc-again-hard").disabled = !h;
  $("fc-to-list").textContent = set.sample ? "Về trang tạo" : "Về danh sách";
  renderReview();
}

// Số dòng mỗi trang: mặc định "Vừa khung" (0) = vừa khít khung danh sách (dòng cuối chạm đáy khung); người dùng chọn
// 10 / 20 / 50 ở ô "Hiển thị" thì dùng đúng số đó, dòng cao 41px, khung tự cuộn (nhớ localStorage "rev_fc").
var REV_PER_OPTS = [0, 10, 20, 50];
function fitPage() {
  var list = $("fc-r-list"), fixed = getPerPage("rev_fc", 0, REV_PER_OPTS);
  if (fixed) { fc.perPage = fixed; list.style.setProperty("--rh", "41px"); list.style.overflowY = "auto"; return; }
  list.style.overflowY = "";
  var avail = list.clientHeight;
  fc.perPage = Math.max(3, Math.floor(avail / 41));
  list.style.setProperty("--rh", (avail ? avail / fc.perPage : 41) + "px");
}

function renderReview() {
  fitPage();
  var r = fc.result;
  $("fc-only-hard").classList.toggle("on", fc.onlyHard);
  var rows = r.order.map(function (_, i) { return i; }).filter(function (i) { return !fc.onlyHard || r.ratings[i] === "hard"; });
  var pages = Math.max(1, Math.ceil(rows.length / fc.perPage));
  fc.page = Math.min(fc.page, pages - 1);
  var slice = rows.slice(fc.page * fc.perPage, fc.page * fc.perPage + fc.perPage);
  $("fc-r-list").innerHTML = slice.length ? slice.map(function (i) {
    var c = fc.set.cards[r.order[i]], k = r.ratings[i];
    return '<button type="button" class="fc-rrow" data-i="' + i + '" title="Xem thẻ ' + (i + 1) + '"><span class="n">' + pad(i + 1) +
      '</span><span class="qt">' + esc(c.front) + '</span><span class="st ' + k + '">' + RATING_LABEL[k] + "</span></button>";
  }).join("") : '<div class="fc-rrow fc-muted">Không có thẻ khó nào trong phiên này.</div>';
  $("fc-pager").hidden = pages <= 1;
  $("fc-pg-info").textContent = (fc.page + 1) + " / " + pages;
  $("fc-pg-prev").disabled = fc.page === 0;
  $("fc-pg-next").disabled = fc.page >= pages - 1;
}

/* ---------- Xem lại 1 thẻ ---------- */
function renderOne() {
  var r = fc.result, n = r.order.length, i = fc.cIdx, c = fc.set.cards[r.order[i]], k = r.ratings[i];
  $("fc-c-pos").textContent = "Thẻ " + (i + 1) + " / " + n;
  $("fc-c-meta").textContent = TYPE_FULL[c.type];
  $("fc-c-bar").style.width = ((i + 1) / n * 100) + "%";
  $("fc-c-label").textContent = TYPE_SHORT[c.type];
  $("fc-c-q").textContent = c.front;
  $("fc-c-a").textContent = c.back;
  setCite($("fc-c-src"), c, true);
  $("fc-c-verdict").innerHTML = k === "skip" ? "Bạn đã bỏ qua thẻ này"
    : "Bạn đánh giá: <b class=\"st " + k + "\">" + RATING_LABEL[k] + (r.intervals[i] != null ? " · ôn lại " + whenText(r.intervals[i]) : "") + "</b>";
  $("fc-c-prev").disabled = i === 0;
  $("fc-c-next").hidden = i === n - 1;
}

function openCite(c) {
  if (!canOpenCite(c)) return;
  hooks.openSource({ subject_id: fc.set && fc.set.subjectId, chapter_id: c.cite.chapter_id, document_id: c.cite.document_id, page: c.cite.page, quote: c.cite.quote });
}

/* ====================================================================
   Gắn sự kiện — gọi 1 lần từ init() của ghichu.js
   ==================================================================== */
export function initFlashcard() {
  // UC-35: "Báo nội dung sai" ở mặt sau thẻ (đang ôn / xem lại 1 thẻ). stopPropagation: bấm mặt sau là lật thẻ.
  function reportCard(c, pos) {
    if (!c) return;
    hooks.reportContent({
      title: "Flashcard sai: " + c.front.slice(0, 80), context: ["Flashcard", fc.set.title, pos],
      quote_heading: "Mặt sau thẻ “" + c.front + "”", quote_text: c.back,
      ref_type: c.id ? "flashcard" : null, ref_id: c.id || null,
    });
  }
  $("fc-b-report").addEventListener("click", function (e) {
    e.stopPropagation();
    reportCard(card(fc.sess.idx), "Thẻ " + (fc.sess.idx + 1) + " / " + fc.sess.order.length);
  });
  $("fc-c-report").addEventListener("click", function () {
    var r = fc.result;
    reportCard(fc.set.cards[r.order[fc.cIdx]], "Thẻ " + (fc.cIdx + 1) + " / " + r.order.length);
  });
  form.bind();
  $("fc-back-btn").addEventListener("click", function (e) { e.stopPropagation(); onClose(); });

  // Tab "Tạo mới" / "Đã tạo"
  $("fc-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]"); if (!b) return;
    if (b.dataset.tab === "saved") { refreshSaved(); show("saved"); }
    else { form.initSource(); show("setup"); }
  });

  // --- Tạo mới ---
  $("fc-opts").addEventListener("click", function (e) {
    var r = e.target.closest(".fc-sw-row"); if (!r || fc.job) return;
    fc.opts[r.dataset.k] = !fc.opts[r.dataset.k];
    renderSetup();
  });
  $("fc-panel").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cancel") cancelJob();
    else if (b.dataset.act === "again") resetJob();
    else if (b.dataset.act === "start" && fc.job && fc.job.set) { var s = fc.job.set; resetJob(); startStudy(s); }
    else if (b.dataset.act === "sample") startStudy(sampleSet([4, 4]));
  });
  $("fc-create").addEventListener("click", createSet);

  // --- Đã tạo ---
  initSavedList();

  // --- Ôn thẻ ---
  $("fc-flip").addEventListener("click", function () { if (!fc.flipped) setFlipped(true); });
  $("fc-b-src").addEventListener("click", function (e) { e.stopPropagation(); openCite(card(fc.sess.idx)); });
  $("fc-hard").addEventListener("click", function () { rate("hard"); });
  $("fc-easy").addEventListener("click", function () { rate("easy"); });
  $("fc-prev").addEventListener("click", prev);
  $("fc-skip").addEventListener("click", skip);
  $("fc-notice-close").addEventListener("click", function () { fc.notice = ""; $("fc-notice").hidden = true; saveProgress(); });
  document.addEventListener("keydown", function (e) {
    if (!fc.open || fc.screen !== "study" || !fc.sess || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.code === "Space") { e.preventDefault(); setFlipped(!fc.flipped); }
    else if (fc.flipped && e.key === "1") rate("hard");
    else if (fc.flipped && e.key === "2") rate("easy");
    else if (!fc.flipped && e.key === "ArrowLeft") prev();
    else if (!fc.flipped && e.key === "ArrowRight") skip();
  });
  window.addEventListener("beforeunload", function () { if (fc.sess) saveProgress(); });

  // --- Hoàn thành ---
  $("fc-only-hard").addEventListener("click", function () { fc.onlyHard = !fc.onlyHard; fc.page = 0; renderReview(); });
  $("fc-pg-prev").addEventListener("click", function () { fc.page--; renderReview(); });
  $("fc-pg-next").addEventListener("click", function () { fc.page++; renderReview(); });
  $("fc-per").innerHTML = perSelectHtml(getPerPage("rev_fc", 0, REV_PER_OPTS), REV_PER_OPTS, "thẻ");
  bindPerSelect($("fc-per"), "rev_fc", function () { fc.page = 0; renderReview(); });
  $("fc-r-list").addEventListener("click", function (e) {
    var r = e.target.closest(".fc-rrow[data-i]"); if (!r) return;
    fc.cIdx = Number(r.dataset.i);
    show("card");
  });
  $("fc-d-retry").addEventListener("click", function () { saveSession(); renderDone(); });
  $("fc-to-list").addEventListener("click", function () {
    if (fc.set && fc.set.sample) { show("setup"); return; }
    refreshSaved(); show("saved");
  });
  $("fc-again-hard").addEventListener("click", function () {
    var r = fc.result;
    startStudy(fc.set, r.order.filter(function (_, i) { return r.ratings[i] === "hard"; }));
  });
  window.addEventListener("resize", function () { if (fc.open && fc.screen === "done") renderReview(); });

  // --- Xem lại 1 thẻ ---
  $("fc-c-prev").addEventListener("click", function () { if (fc.cIdx > 0) { fc.cIdx--; renderOne(); } });
  $("fc-c-next").addEventListener("click", function () { if (fc.cIdx < fc.result.order.length - 1) { fc.cIdx++; renderOne(); } });
  $("fc-c-result").addEventListener("click", function () { show("done"); });
  $("fc-c-src").addEventListener("click", function () { openCite(fc.set.cards[fc.result.order[fc.cIdx]]); });
}
