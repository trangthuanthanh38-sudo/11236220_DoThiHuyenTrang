/* ======================================================================
   ghichu_ontap.js — MODULE "Tạo câu hỏi ôn tập" (UC-21, Studio AI). HTML ở
   html/ghichu_ontap.frag (nạp vào #mount-ontap-pane), style ở
   css/ghichu_ontap.css. Bố cục/luồng theo giao diện mẫu on-tap-tao-moi.html:
     Tạo mới  — chọn Môn + tick Chương/Tệp PDF, tên bộ, số câu (gợi ý/tối đa theo độ dài
                nguồn), phân bổ độ khó, dạng câu, "Sau mỗi câu", ô "Đang tạo"
     Đã tạo   — bảng các bộ đã lưu, bấm 1 dòng xem lịch sử từng lần làm
     Làm bài  — từng câu, hiện đáp án / giải thích / trích dẫn theo tuỳ chọn của bộ
     Kết quả  — điểm, Điểm cao nhất, Câu dễ/TB/khó, xem lại từng câu, Làm lại

   Chỉ import từ ghichu_core.js + ghichu_nguon.js (không import ghichu.js — tránh vòng lặp).
   Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi `ontap.open` rồi gọi
   hooks.syncLayout() — ghichu.js (nơi duy nhất nắm bố cục 3 cột) đọc isOpen() để quyết định.

   Dữ liệu nguồn đọc từ state.subjects (cây Môn/Chương/PDF đã nạp từ GET /subjects —
   bootKnowledgeTree() ở ghichu_soanthao.js), không hard-code.

   Backend (backend/app/routers/quiz.py + services/quiz_generation.py):
     POST /quiz/source-stats {subject_id, sources} -> {word_count, max_questions, suggested_min, ...}
          ("n nguồn · x từ", "Gợi ý: a–b câu", "chỉ đủ tối đa N câu"; không tốn lượt AI)
     POST /quiz/sets request  {subject_id, sources:[{source_type:'CHAPTER'|'PDF', id}], title,
               requested_count, difficulty_counts:[dễ, tb, khó] | difficulty:'easy'|'medium'|'hard',
               question_type:'single'|'multi', show_answer, show_explanation, show_citation}
          response {id, title, requested_count, question_count, difficulty (NULL = hỗn hợp),
               show_*, best_score, questions:[{id, position, question_type, difficulty, question_text,
               short_text, explanation, options:[{position, content, is_correct}],
               citations:[{source_label, page_number, quote, chapter_id, document_id}]}]}
     Tạo bộ là 1 request đồng bộ (~15-40s, không báo tiến độ thật) -> ô "Đang tạo" đổi BƯỚC theo
     thời gian đã chờ, không hiện %; "Hủy" chỉ ngừng chờ (AbortController) — máy chủ có thể vẫn tạo xong.
   Lần làm bài: mỗi lần "Làm bài"/"Làm lại" = POST /quiz/sets/{id}/attempts; mỗi câu chốt = PUT
   /quiz/attempts/{id}/answers/{question_id} (server chấm, lưu cố định); "Xem kết quả" = POST
   /quiz/attempts/{id}/finish. Các lệnh này xếp hàng qua `ontap.sync` (Promise nối tiếp) nên luôn tới
   server đúng thứ tự dù người học bấm nhanh. Tab "Đã tạo" = GET /quiz/sets, lịch sử 1 bộ = GET
   /quiz/sets/{id}/attempts, mở lại = GET /quiz/sets/{id} (kèm `open_attempt` -> "Làm tiếp"); F5
   giữa chừng: id bộ đang làm nhớ ở localStorage (RESUME_KEY) để resumeIfNeeded() mở lại đúng câu.
   Mốc thời gian API trả dạng TƯƠNG ĐỐI (`*_seconds_ago`) vì DATETIME của DB không kèm múi giờ.
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, closeDropdownEl, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";
import { createCardList, histRow, histEmpty } from "./ghichu_cardlist.js";
import { createStudioForm, LEVELS, LEVEL_LABEL, pad, agoDate, fmtDay, fmtTime, fmtDuration, apiErrorText } from "./ghichu_studio_form.js";

// Nhớ bộ câu hỏi đang làm dở để F5 xong mở lại (xoá khi nộp bài hoặc chủ động rời bài).
var RESUME_KEY = "td_ontap_resume";
function saveResume(setId) { try { localStorage.setItem(RESUME_KEY, setId); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return localStorage.getItem(RESUME_KEY); } catch (e) { return null; } }

var MAX_QUESTIONS = 30; // khớp CHECK chk_quiz_sets_requested_count (ôn tập)
var HISTORY_MAX = 4;     // tab "Đã tạo": số lần làm hiện khi mở 1 bộ
/* ---------------- state riêng của module ---------------- */
var ontap = {
  open: false,
  screen: "setup",        // setup | saved | quiz | result
  // --- Tạo mới (nguồn/tên/số câu/độ khó nằm ở `form` — ghichu_studio_form.js) ---
  type: "single",
  opts: { showAnswer: true, showExplain: true, showCite: true },
  job: null,              // ô "Đang tạo": {t0, timer, controller, nSrc, done, set, error}
  error: "",              // lỗi tạo bộ gần nhất (hiện trong ô "Đang tạo")
  // --- Đã tạo ---
  saved: null,            // GET /quiz/sets (null = chưa tải)
  savedError: "",
  openSaved: null,        // id bộ đang mở lịch sử
  history: {},            // id -> [lần làm] | "loading" | "error"
  // --- Làm bài / Kết quả ---
  set: null,              // bộ đang làm (đã chuẩn hoá, xem normalizeSet())
  idx: 0,
  answers: [],            // [[position,...]] theo từng câu
  checked: [],            // [bool] câu đã chốt
  reviewing: false,
  startedAt: 0,
  elapsed: 0,
  noticeClosed: false,
  onlyWrong: false,
  page: 0,
  perPage: 8,             // "Xem lại từng câu": số dòng mỗi trang (fitPage() tính theo chiều cao khung)
  sync: Promise.resolve(null), // hàng đợi gọi API lần làm: resolve ra attemptId (null = không lưu)
  result: null,           // từ server sau khi nộp: {attempts, best, duration, score}
  syncFailed: false,
};

export function isOpen() { return ontap.open; }

// Form "Tạo mới" dùng chung với Thi thử (ghichu_studio_form.js).
var form = createStudioForm({
  ids: "ontap", cls: "ontap", mode: "practice",
  minCount: 1, maxCount: MAX_QUESTIONS, defaultCount: 10,
  createLabel: "Tạo bộ câu hỏi", unit: "bộ ôn tập",
  panel: {
    idle: "Chưa có bộ câu hỏi nào đang tạo. Tiến độ sẽ hiện ở đây sau khi bạn bấm Tạo bộ câu hỏi.",
    steps: ["Đọc {n} nguồn nội dung", "Soạn {c} câu hỏi và giải thích", "Loại câu trùng, gắn nguồn"],
    startLabel: "Làm bài ngay", againLabel: "Tạo bộ khác",
  },
  active: function () { return ontap.open && ontap.screen === "setup"; },
  job: function () { return ontap.job; },
  onChange: function () { renderSetup(); },
});

/* ====================================================================
   Mở / đóng
   ==================================================================== */
// Mở lại (bấm thẻ "Ôn tập" ở cột Studio) -> GIỮ NGUYÊN trang đang dở (đang làm bài / xem lại / kết
// quả / đã tạo...), không quay về trang Tạo mới — vd. vừa bấm "Nguồn" để xem tài liệu gốc rồi quay lại.
export function openOntap() {
  ontap.open = true;
  if ((ontap.screen === "quiz" || ontap.screen === "result") && !ontap.set) ontap.screen = "setup";
  form.initSource();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
  render();
  refreshSaved();
}

// Ẩn màn ôn tập. State (trang đang ở, bài đang làm) giữ nguyên trong bộ nhớ để bấm lại thẻ "Ôn tập"
// là quay về đúng chỗ; bộ đang tạo vẫn chạy tiếp. `keepPlace` (bấm "Nguồn" trong phần giải thích —
// ghichu.js openSource()) -> giữ cả RESUME_KEY để F5 lúc đang xem tài liệu vẫn mở lại được bài.
// Ngược lại (× hay chuyển sang công cụ Studio khác) -> không tự mở lại sau F5; lần làm dở vẫn còn
// trên server, mở lại bằng "Làm tiếp" ở tab "Đã tạo".
export function closeOntap(keepPlace) {
  ontap.open = false;
  if (list) list.leave();
  if (!keepPlace) clearResume();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
}

function show(screen) {
  ontap.screen = screen;
  render();
  $("ontap-pane").querySelector(".ontap-body").scrollTop = 0;
}

function toast(msg) {
  var t = $("ontap-toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { t.hidden = true; }, 3200);
}

function render() {
  if (!ontap.open) return;
  var sc = ontap.screen, form = sc === "setup" || sc === "saved";
  $("ontap-s-setup").hidden = sc !== "setup";
  $("ontap-s-saved").hidden = sc !== "saved";
  $("ontap-s-quiz").hidden = sc !== "quiz";
  $("ontap-s-result").hidden = sc !== "result";
  $("ontap-tabbar").hidden = !form;
  Array.prototype.forEach.call($("ontap-tabs").children, function (b) {
    b.classList.toggle("on", (b.dataset.tab === "new" ? "setup" : "saved") === sc);
  });
  $("ontap-saved-count").textContent = ontap.saved && ontap.saved.length ? ontap.saved.length : "";
  $("ontap-create").hidden = sc !== "setup";
  $("ontap-head-note").hidden = sc !== "quiz";
  $("ontap-head-note").textContent = ontap.reviewing ? "Đang xem lại bài đã làm" : "Không giới hạn thời gian";
  $("ontap-title").textContent = form || !ontap.set ? "Tạo câu hỏi ôn tập" : ontap.set.title;
  if (sc === "setup") renderSetup();
  else if (sc === "saved") renderSaved();
  else if (sc === "quiz") renderQuiz();
  else renderResult();
}

// Nút × : Tạo mới/Đã tạo -> về Notebook; đang xem lại -> về Kết quả; làm bài/kết quả -> về danh sách.
function onClose() {
  if (ontap.screen === "quiz" && ontap.reviewing) { backToResult(); return; }
  if (ontap.screen === "quiz" || ontap.screen === "result") {
    if (ontap.screen === "quiz" && !isOnline() &&
        !window.confirm("Thoát bài làm? Ở chế độ mẫu, tiến độ lần làm này sẽ không được lưu.")) return;
    clearResume(); // lần làm dở vẫn còn trên server -> "Làm tiếp" ở tab Đã tạo
    ontap.reviewing = false;
    refreshSaved();
    show("saved");
    return;
  }
  closeOntap();
}

/* ====================================================================
   TẠO MỚI — phần chung (nguồn, tên, số câu, độ khó, gợi ý, tự thu vừa khung) nằm ở form
   (ghichu_studio_form.js); ở đây chỉ còn phần riêng Ôn tập: dạng câu, "Sau mỗi câu", tạo bộ
   ==================================================================== */
function renderSetup() {
  var locked = !!ontap.job;
  $("ontap-types").style.pointerEvents = $("ontap-after").style.pointerEvents = locked ? "none" : "";
  form.render();
  Array.prototype.forEach.call($("ontap-types").children, function (b) { b.classList.toggle("on", b.dataset.v === ontap.type); });
  Array.prototype.forEach.call(document.querySelectorAll("#ontap-after .ontap-sw-row"), function (r) {
    r.classList.toggle("on", !!ontap.opts[r.dataset.k]);
    r.setAttribute("aria-pressed", String(!!ontap.opts[r.dataset.k]));
  });
  renderPanel();
}

/* ====================================================================
   TẠO MỚI — Ô "Đang tạo" + gọi POST /quiz/sets
   ==================================================================== */
function renderPanel() {
  form.renderPanel(ontap.error, function (j) {
    var s = j.set, fewer = s.requested > s.questions.length;
    return '<p><b style="font-weight:500">' + esc(s.title) + '</b><br><span class="ontap-muted">' + s.questions.length + " câu · đã lưu vào tab Đã tạo" +
      (fewer ? " (nguồn chỉ đủ cho " + s.questions.length + "/" + s.requested + " câu)" : "") + "</span></p>";
  });
}

function createQuizSet() {
  if (!form.validate()) return;
  if (!isOnline()) {
    ontap.error = "Cần đăng nhập để AI tạo câu hỏi từ tài liệu của bạn.";
    renderPanel();
    return;
  }
  // Cả bộ chỉ 1 mức -> {difficulty}; ngược lại {difficulty_counts} (bộ "hỗn hợp").
  var body = Object.assign(form.sourcesForApi(), form.difficultyPayload(true));
  body.title = form.name.trim();
  body.requested_count = form.count;
  body.question_type = ontap.type;
  body.show_answer = ontap.opts.showAnswer;
  body.show_explanation = ontap.opts.showExplain;
  body.show_citation = ontap.opts.showCite;

  var controller = window.AbortController ? new AbortController() : null;
  var job = { t0: Date.now(), total: form.count, nSrc: body.sources.length, controller: controller, done: false };
  ontap.job = job; ontap.error = "";
  job.timer = setInterval(function () { if (ontap.open && ontap.screen === "setup") renderPanel(); }, 1000);
  renderSetup();

  apiAuth("POST", "/quiz/sets", authToken(), body, controller ? controller.signal : undefined).then(function (res) {
    if (ontap.job !== job) return; // đã bấm Hủy
    clearInterval(job.timer);
    if (res.ok && (res.data.questions || []).length) {
      job.done = true;
      job.set = normalizeSet(res.data);
      refreshSaved(); // bộ mới xuất hiện ngay ở tab "Đã tạo"
    } else {
      ontap.job = null;
      ontap.error = apiErrorText(res, "/quiz/sets", "Không tạo được bộ câu hỏi.");
    }
    if (ontap.open && ontap.screen === "setup") renderSetup();
    else if (ontap.open && job.done) toast("Đã tạo xong “" + job.set.title + "” — xem ở tab Đã tạo.");
  });
}

function cancelJob() {
  var j = ontap.job;
  if (!j || j.done) return;
  clearInterval(j.timer);
  if (j.controller) j.controller.abort();
  ontap.job = null;
  renderSetup();
  toast("Đã ngừng chờ. Nếu máy chủ đã kịp tạo xong, bộ câu hỏi vẫn sẽ hiện ở tab Đã tạo.");
  setTimeout(refreshSaved, 20000); // server vẫn có thể đang tạo nốt
}

function resetJob() {
  ontap.job = null; ontap.error = "";
  form.reset();
  renderSetup();
}

/* ====================================================================
   ĐÃ TẠO — bảng (GET /quiz/sets) + lịch sử từng bộ (GET /quiz/sets/{id}/attempts)
   ==================================================================== */
function refreshSaved() {
  if (!isOnline()) { ontap.saved = []; if (ontap.open) render(); return; }
  apiAuth("GET", "/quiz/sets", authToken()).then(function (res) {
    ontap.saved = res.ok && Array.isArray(res.data) ? res.data : (ontap.saved || []);
    ontap.savedError = res.ok ? "" : ((res.data && res.data.detail) || "Không tải được danh sách bộ câu hỏi.");
    ontap.history = {}; // lịch sử có thể đã đổi (vừa nộp bài) -> tải lại khi mở
    if (ontap.openSaved) loadHistory(ontap.openSaved);
    if (ontap.open && (ontap.screen === "setup" || ontap.screen === "saved")) render();
  });
}

function loadHistory(id) {
  ontap.history[id] = "loading";
  apiAuth("GET", "/quiz/sets/" + id + "/attempts", authToken()).then(function (res) {
    ontap.history[id] = res.ok && Array.isArray(res.data) ? res.data : "error";
    if (ontap.open && ontap.screen === "saved") renderSaved();
  });
}

// Đã tạo = lưới thẻ dùng chung (ghichu_cardlist.js, cùng khuôn Tóm tắt) — tạo trong initOntap().
var list = null;
function renderSaved() { if (list) list.render(); }

// Hộp "Lịch sử làm bài" của 1 bộ (thay dòng mở rộng của bảng cũ).
function historyBody(s) {
  var h = ontap.history[s.id];
  if (h === undefined) { loadHistory(s.id); h = "loading"; }
  if (h === "loading") return histEmpty("Đang tải…");
  if (h === "error") return histEmpty("Không tải được lịch sử làm bài.");
  if (!h.length) return histEmpty("Chưa nộp lần làm nào.");
  return h.map(function (a) {
    return histRow("Lần " + a.attempt_no, a.score_percent, a.score_percent + "%", a.correct_count + "/" + a.total_questions + " câu · " + fmtDuration(a.duration_seconds), fmtTime(agoDate(a.finished_seconds_ago)));
  }).join("");
}

function byTitle(a, b) { return a.title.localeCompare(b.title, "vi", { numeric: true }); }
function byNum(v) { return function (a, b) { var x = v(a), y = v(b); return (x == null) - (y == null) || (x == null ? 0 : x - y); }; }
function startLabel(s) { return s.has_open_attempt ? "Làm tiếp" : s.attempts ? "Làm lại" : "Làm bài"; }
function savedCard(s) {
  var n = s.attempts;
  return {
    lines: [
      { cls: "l1", html: esc(s.subject_name || "") },
      { html: s.question_count + " câu · " + (s.question_type === "multi" ? "Nhiều đáp án" : "Một đáp án") + " · " + (s.difficulty ? LEVEL_LABEL[s.difficulty] : "Hỗn hợp") },
      { html: n ? n + " lần làm · cao nhất " + s.best_score + "%" : s.has_open_attempt ? "Đã bắt đầu, chưa nộp" : "Chưa làm lần nào" },
    ],
    badge: s.has_open_attempt ? { text: "Đang làm dở", cls: "warn" } : n ? { text: "Điểm cao nhất " + s.best_score + "%", cls: s.best_score >= 80 ? "ok" : "" } : { text: "Chưa làm", cls: "gone" },
    foot: s.last_attempt_seconds_ago != null ? "Làm gần nhất " + fmtDay(agoDate(s.last_attempt_seconds_ago)).toLowerCase() : "Chưa nộp lần nào",
    acts: (n ? [{ act: "history", label: "Lịch sử" }] : []).concat([{ act: "start", label: startLabel(s) }]),
    menu: [{ m: "start", label: startLabel(s) }, { m: "history", label: "Lịch sử làm bài", disabled: !n }, { m: "del", label: "Xoá bộ câu hỏi", del: true }],
  };
}
function initSavedList() {
  list = createCardList({
    pane: $("ontap-pane"), bar: $("ontap-saved-bar"), box: $("ontap-saved-list"), noun: "bộ câu hỏi",
    items: function () { return ontap.saved; },
    error: function () { return ontap.savedError || ""; },
    notice: function () { return isOnline() ? "" : "Đăng nhập để lưu và làm lại các bộ câu hỏi."; },
    id: function (s) { return String(s.id); }, title: function (s) { return s.title; },
    search: function (s) { return s.title + " " + (s.subject_name || ""); },
    filters: [{ key: "all", label: "Tất cả" }, { key: "open", label: "Đang làm dở", test: function (s) { return s.has_open_attempt; } },
      { key: "new", label: "Chưa làm", test: function (s) { return !s.attempts && !s.has_open_attempt; } }],
    sorts: {
      new: { label: "Mới tạo", cmp: function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; } },
      last: { label: "Làm gần nhất", cmp: byNum(function (s) { return s.last_attempt_seconds_ago; }) },
      best: { label: "Điểm cao nhất", cmp: byNum(function (s) { return s.attempts ? -s.best_score : null; }) },
      az: { label: "Tên A–Z", cmp: byTitle },
    },
    card: savedCard, primary: function () { return "start"; },
    onAct: function (act, id) { if (act === "start") return openSavedSet(id); },
    newTile: { title: "Tạo bộ câu hỏi mới", sub: "Từ Chương / tệp PDF của một Môn" },
    onNew: function () { form.initSource(); show("setup"); },
    remove: {
      api: function (id) { return "/quiz/sets/" + id; },
      after: function (id) { if (readResume() === id) clearResume(); refreshSaved(); },
    },
    history: historyBody,
  });
}

// Mở 1 bộ đã lưu: có lần làm dở -> làm tiếp đúng câu; không có -> bắt đầu lần làm mới.
function openSavedSet(id) {
  return apiAuth("GET", "/quiz/sets/" + id, authToken()).then(function (res) {
    if (!res.ok) {
      if (res.status === 404) clearResume();
      if (ontap.open) window.alert((res.data && res.data.detail) || "Không mở được bộ câu hỏi.");
      refreshSaved();
      return false;
    }
    var set = normalizeSet(res.data);
    if (res.data.open_attempt) resumeQuiz(set, res.data.open_attempt);
    else startQuiz(set);
    return true;
  });
}

/* F5 giữa lúc đang làm bài: gọi 1 lần lúc khởi động trang (init() ở ghichu.js) — nếu còn nhớ bộ
   đang làm và server vẫn còn lần làm dở của bộ đó thì mở thẳng lại màn Làm bài đúng câu. */
export function resumeIfNeeded() {
  var id = readResume();
  if (!id || !isOnline()) return;
  apiAuth("GET", "/quiz/sets/" + id, authToken()).then(function (res) {
    if (!res.ok || !res.data.open_attempt) { clearResume(); return; }
    ontap.open = true;
    form.initSource();
    hooks.syncLayout();
    resumeQuiz(normalizeSet(res.data), res.data.open_attempt);
    refreshSaved();
  });
}

// Từ thông báo "Bài ôn tập đang dở": mở lại đúng câu đang làm; bài đã nộp thì về tab Đã tạo.
export function openSet(id) {
  if (ontap.open && ontap.screen === "quiz" && ontap.set && ontap.set.id === id) return;
  ontap.open = true;
  form.initSource();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
  apiAuth("GET", "/quiz/sets/" + id, authToken()).then(function (res) {
    if (res.ok && res.data.open_attempt) { resumeQuiz(normalizeSet(res.data), res.data.open_attempt); refreshSaved(); return; }
    show("saved");
    refreshSaved();
    toast(res.ok ? "Bài ôn tập này đã được nộp." : "Không tìm thấy bộ câu hỏi — có thể đã bị xoá.");
  });
}

// Chuẩn hoá phản hồi API về dạng màn làm bài dùng (tách khỏi tên cột backend).
function normalizeSet(d) {
  return {
    id: d.id,
    subjectId: d.subject_id,
    title: d.title,
    requested: d.requested_count,
    difficulty: d.difficulty,
    best: d.best_score == null ? null : d.best_score,
    opts: {
      showAnswer: d.show_answer !== false,
      showExplain: d.show_explanation !== false,
      showCite: d.show_citation !== false,
    },
    questions: (d.questions || []).slice().sort(function (a, b) { return a.position - b.position; }).map(function (q) {
      var opts = (q.options || []).slice().sort(function (a, b) { return a.position - b.position; });
      var c = (q.citations || [])[0] || null;
      return {
        id: q.id,
        text: q.question_text,
        short: q.short_text || q.question_text,
        multi: q.question_type === "multi",
        difficulty: q.difficulty,
        explanation: q.explanation,
        options: opts.map(function (o) { return o.content; }),
        answer: opts.filter(function (o) { return o.is_correct; }).map(function (o) { return o.position; }),
        cite: c ? {
          quote: c.quote,
          src: c.source_label + (c.page_number ? " · trang " + c.page_number : ""),
          // null khi nguồn đã bị xoá (FK SET NULL) -> chỉ hiện tên, không bấm mở được
          chapter_id: c.chapter_id || null, document_id: c.document_id || null, page: c.page_number || null,
        } : null,
      };
    }),
  };
}

/* ====================================================================
   LÀM BÀI
   ==================================================================== */
function sameSet(a, b) { return a.length === b.length && a.every(function (x) { return b.indexOf(x) >= 0; }); }

function resetRun() {
  ontap.idx = 0;
  ontap.answers = ontap.set.questions.map(function () { return []; });
  ontap.checked = ontap.set.questions.map(function () { return false; });
  ontap.reviewing = false;
  ontap.noticeClosed = false;
  ontap.startedAt = Date.now();
  ontap.result = null;
  ontap.syncFailed = false;
  ontap.onlyWrong = false;
  ontap.page = 0;
}

// Lần làm MỚI (Làm bài ngay / Làm bài / Làm lại). Không chờ server: người học làm ngay, các lệnh
// lưu đáp án nối sau lệnh tạo lần làm trong hàng đợi ontap.sync.
function startQuiz(set) {
  if (set) ontap.set = set;
  resetRun();
  if (isOnline() && ontap.set.id) {
    saveResume(ontap.set.id);
    ontap.sync = apiAuth("POST", "/quiz/sets/" + ontap.set.id + "/attempts", authToken()).then(function (res) {
      if (!res.ok) { ontap.syncFailed = true; return null; }
      return res.data.id;
    });
  } else {
    ontap.sync = Promise.resolve(null);
  }
  show("quiz");
}

// Làm tiếp lần làm dở: điền lại các câu đã chốt, nhảy tới câu đầu tiên chưa trả lời.
function resumeQuiz(set, attempt) {
  ontap.set = set;
  resetRun();
  var byQ = {};
  (attempt.answers || []).forEach(function (a) { byQ[a.question_id] = a.selected_positions; });
  set.questions.forEach(function (q, i) {
    if (byQ[q.id]) { ontap.answers[i] = byQ[q.id].slice(); ontap.checked[i] = true; }
  });
  var next = ontap.checked.indexOf(false);
  ontap.idx = next >= 0 ? next : set.questions.length - 1;
  ontap.noticeClosed = true; // đã thấy thông báo giảm số câu ở lần mở trước
  saveResume(set.id);
  ontap.sync = Promise.resolve(attempt.id);
  show("quiz");
}

// Gửi đáp án vừa chốt của câu i lên server (xếp hàng sau các lệnh trước).
function submitAnswer(i) {
  var q = ontap.set.questions[i], picked = ontap.answers[i].slice();
  ontap.sync = ontap.sync.then(function (attemptId) {
    if (!attemptId || !q.id) return attemptId;
    return apiAuth("PUT", "/quiz/attempts/" + attemptId + "/answers/" + q.id, authToken(), { selected_positions: picked })
      .then(function (res) {
        if (!res.ok && res.status !== 409) ontap.syncFailed = true; // 409 = đã chốt từ trước (làm tiếp)
        return attemptId;
      });
  });
}

function renderQuiz() {
  var set = ontap.set, q = set.questions[ontap.idx], total = set.questions.length;
  var done = ontap.reviewing || ontap.checked[ontap.idx], pick = ontap.answers[ontap.idx];
  // Xem lại từ màn Kết quả: luôn hiện đáp án, giải thích và nguồn.
  var o = ontap.reviewing ? { showAnswer: true, showExplain: true, showCite: true } : set.opts;

  var reduced = set.requested > total && !ontap.noticeClosed && !ontap.reviewing; // UC-21 E2
  $("ontap-notice").hidden = !reduced;
  $("ontap-notice-text").textContent = "Nguồn đã chọn chỉ đủ nội dung cho " + total + " câu, nên bộ câu hỏi được giảm từ " + set.requested + " xuống " + total + " câu.";

  $("ontap-q-pos").textContent = "Câu " + (ontap.idx + 1) + " / " + total;
  $("ontap-q-meta").textContent = (LEVEL_LABEL[q.difficulty] || "") + " · " + (q.multi ? "Nhiều đáp án" : "Một đáp án");
  $("ontap-q-bar").style.width = ((ontap.idx + 1) / total * 100) + "%";
  $("ontap-q-text").textContent = q.text;

  $("ontap-options").innerHTML = q.options.map(function (text, i) {
    var cls = "", tag = "";
    var chosen = pick.indexOf(i) >= 0, correct = q.answer.indexOf(i) >= 0;
    if (done && o.showAnswer) {
      if (correct) { cls = "right"; tag = chosen ? "Bạn đã chọn · Đúng" : "Đáp án đúng"; }
      else if (chosen) { cls = "wrong"; tag = "Bạn đã chọn"; }
    } else if (chosen) { cls = "picked"; tag = done ? "Bạn đã chọn" : ""; }
    return '<button type="button" class="ontap-opt ' + cls + '" data-i="' + i + '"' + (done ? " disabled" : "") + ">" +
      '<span class="key">' + "ABCDEF"[i] + '</span><span class="label">' + esc(text) + "</span>" +
      (tag ? '<span class="tag">' + tag + "</span>" : "") + "</button>";
  }).join("");

  var showCite = o.showCite && !!q.cite;
  var showEx = done && (o.showExplain || showCite);
  $("ontap-explain").hidden = !showEx;
  if (showEx) {
    $("ontap-ex-title").hidden = !o.showExplain;
    $("ontap-ex-text").hidden = !o.showExplain;
    $("ontap-ex-text").textContent = q.explanation;
    $("ontap-ex-cite").hidden = !showCite;
    if (showCite) {
      var canOpen = !!(q.cite.chapter_id || q.cite.document_id);
      var srcBtn = $("ontap-ex-src");
      $("ontap-ex-quote").textContent = q.cite.quote || "";
      srcBtn.textContent = "Nguồn: " + q.cite.src;
      srcBtn.classList.toggle("can-open", canOpen);
      srcBtn.disabled = !canOpen;
      srcBtn.title = canOpen ? "Mở tài liệu gốc" + (q.cite.page ? " tại trang " + q.cite.page : "") : "Tài liệu gốc không còn trong Notebook";
    }
  }

  $("ontap-prev").disabled = ontap.idx === 0;
  var next = $("ontap-next"), last = ontap.idx === total - 1;
  $("ontap-pick-hint").textContent = "";
  $("ontap-to-result").hidden = !ontap.reviewing;
  next.hidden = false;
  if (ontap.reviewing) {
    next.textContent = "Câu tiếp theo"; next.hidden = last; next.disabled = false;
  } else if (!done && q.multi) {
    next.textContent = "Kiểm tra"; next.disabled = !pick.length;
    if (!pick.length) $("ontap-pick-hint").textContent = "Chọn tất cả đáp án đúng";
  } else {
    next.textContent = last ? "Xem kết quả" : "Câu tiếp theo"; next.disabled = !done;
  }
}

function reveal() {
  requestAnimationFrame(function () {
    var ex = $("ontap-explain");
    (ex.hidden ? $("ontap-next") : ex).scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function onOptionClick(e) {
  var b = e.target.closest(".ontap-opt");
  if (!b || b.disabled) return;
  var i = Number(b.dataset.i), q = ontap.set.questions[ontap.idx];
  if (q.multi) {
    var a = ontap.answers[ontap.idx];
    ontap.answers[ontap.idx] = a.indexOf(i) >= 0 ? a.filter(function (x) { return x !== i; }) : a.concat([i]);
    renderQuiz();
  } else {
    ontap.answers[ontap.idx] = [i];
    ontap.checked[ontap.idx] = true; // Chế độ ôn tập: chốt ngay
    submitAnswer(ontap.idx);
    renderQuiz(); reveal();
  }
}

function onNext() {
  var q = ontap.set.questions[ontap.idx];
  if (!ontap.reviewing && q.multi && !ontap.checked[ontap.idx]) {
    ontap.checked[ontap.idx] = true;
    submitAnswer(ontap.idx);
    renderQuiz(); reveal(); return;
  }
  if (ontap.idx < ontap.set.questions.length - 1) { ontap.idx++; show("quiz"); }
  else finishQuiz();
}

/* ====================================================================
   KẾT QUẢ
   ==================================================================== */
function isRight(i) { return sameSet(ontap.answers[i], ontap.set.questions[i].answer); }
function score() {
  return ontap.set.questions.reduce(function (a, q, i) { return a + (isRight(i) ? 1 : 0); }, 0);
}

// Nộp bài: hiện kết quả NGAY bằng số liệu phía client, rồi cập nhật "Lần làm"/"Điểm cao nhất"/
// thời gian từ server khi lệnh nộp (xếp sau mọi lệnh lưu đáp án trong ontap.sync) trả về.
function finishQuiz() {
  ontap.elapsed = Date.now() - ontap.startedAt;
  ontap.reviewing = false;
  clearResume();
  var prevBest = ontap.set.best;
  ontap.sync = ontap.sync.then(function (attemptId) {
    if (!attemptId) return null;
    return apiAuth("POST", "/quiz/attempts/" + attemptId + "/finish", authToken()).then(function (res) {
      if (res.ok) {
        var d = res.data;
        ontap.result = {
          attempts: d.attempts, best: d.best_score, duration: d.duration_seconds,
          newBest: prevBest === null || d.score_percent > prevBest,
        };
        ontap.set.best = d.best_score;
      } else ontap.syncFailed = true;
      if (ontap.open && ontap.screen === "result") renderResult();
      refreshSaved();
      return null; // lần làm đã nộp — không gửi thêm gì cho nó nữa
    });
  });
  ontap.onlyWrong = false; ontap.page = 0;
  show("result");
}

function backToResult() { ontap.reviewing = false; show("result"); }

var LEVEL_SHORT = { easy: "Dễ", medium: "TB", hard: "Khó" }; // dòng phụ ô "Đúng" (ô hẹp)

// Màn Kết quả — 1 cột, cùng khuôn màn "Hoàn thành phiên ôn" của Flashcard.
function renderResult() {
  var set = ontap.set, list = set.questions, total = list.length, ok = score(), pct = Math.round(ok / total * 100);
  var r = ontap.result;
  // Thời gian: ưu tiên số của server (tính cả khi làm tiếp sau F5), chưa có thì dùng đồng hồ client.
  var sec = r ? r.duration : Math.round(ontap.elapsed / 1000);
  $("ontap-r-score").textContent = ok + " / " + total + " câu đúng · " + pct + "%";
  $("ontap-r-meta").textContent = set.title + "  ·  " + (r ? "Lần làm thứ " + r.attempts : isOnline() ? "Đang lưu…" : "Chế độ mẫu") + "  ·  " + fmtDuration(sec);
  $("ontap-r-ok").textContent = ok + " câu";
  // Dòng phụ ô Đúng: đúng theo từng mức độ khó (chỉ các mức có câu).
  $("ontap-r-ok-s").textContent = LEVELS.map(function (lv) {
    var idx = list.map(function (q, i) { return q.difficulty === lv ? i : -1; }).filter(function (i) { return i >= 0; });
    return idx.length ? LEVEL_SHORT[lv] + " " + idx.filter(isRight).length + "/" + idx.length : "";
  }).filter(Boolean).join(" · ");
  $("ontap-r-ok-s").title = "Số câu đúng theo độ khó: Dễ · Trung bình (TB) · Khó";
  $("ontap-r-no").textContent = (total - ok) + " câu";
  $("ontap-r-no-s").textContent = total - ok ? "Xem lại bên dưới để ôn" : "Không có câu sai";
  $("ontap-r-best").textContent = r ? r.best + "%" : isOnline() ? "…" : pct + "%";
  $("ontap-r-best-s").innerHTML = r ? (r.newBest ? '<span class="new">Kỷ lục mới</span>' : "Qua " + r.attempts + " lần làm") : "";
  $("ontap-r-time").textContent = fmtDuration(sec);
  $("ontap-r-note").textContent = !isOnline()
    ? "Chế độ mẫu: kết quả không được lưu. Đăng nhập để lưu lịch sử làm bài."
    : ontap.syncFailed
      ? "Không lưu được kết quả lần này lên máy chủ (lỗi kết nối) — lần làm sau sẽ được lưu bình thường."
      : "Kết quả đã được lưu vào tab Đã tạo và tiến độ ôn tập.";
  renderReview();
}

// Số dòng mỗi trang: mặc định "Vừa khung" (0) = vừa khít khung danh sách (dòng cuối chạm đáy khung); người dùng chọn
// 10 / 20 / 50 ở ô "Hiển thị" thì dùng đúng số đó, dòng cao 41px, khung tự cuộn (nhớ localStorage "rev_ontap").
var REV_PER_OPTS = [0, 10, 20, 50];
function fitPage() {
  var list = $("ontap-review-list"), fixed = getPerPage("rev_ontap", 0, REV_PER_OPTS);
  if (fixed) { ontap.perPage = fixed; list.style.setProperty("--rh", "41px"); list.style.overflowY = "auto"; return; }
  list.style.overflowY = "";
  var avail = list.clientHeight;
  ontap.perPage = Math.max(3, Math.floor(avail / 41));
  list.style.setProperty("--rh", (avail ? avail / ontap.perPage : 41) + "px");
}

function renderReview() {
  fitPage();
  var list = ontap.set.questions, per = ontap.perPage;
  $("ontap-only-wrong").classList.toggle("on", ontap.onlyWrong);
  var rows = list.map(function (q, i) { return i; }).filter(function (i) { return !ontap.onlyWrong || !isRight(i); });
  var pages = Math.max(1, Math.ceil(rows.length / per));
  ontap.page = Math.min(ontap.page, pages - 1);
  var slice = rows.slice(ontap.page * per, ontap.page * per + per);
  $("ontap-review-list").innerHTML = slice.length ? slice.map(function (i) {
    var good = isRight(i);
    return '<button type="button" class="ontap-row" data-i="' + i + '" title="Xem lại câu ' + (i + 1) + '">' +
      '<span class="n">' + pad(i + 1) + '</span><span class="qt">' + esc(list[i].short) + "</span>" +
      '<span class="st ' + (good ? "ok" : "no") + '">' + (good ? "Đúng" : "Sai") + "</span></button>";
  }).join("") : '<div class="ontap-row ontap-muted">Bạn không có câu nào sai.</div>';
  $("ontap-pager").hidden = pages <= 1;
  $("ontap-pg-info").textContent = (ontap.page + 1) + " / " + pages;
  $("ontap-pg-prev").disabled = ontap.page === 0;
  $("ontap-pg-next").disabled = ontap.page >= pages - 1;
}

/* ====================================================================
   Khởi tạo — gắn sự kiện 1 lần cho DOM tĩnh của fragment, gọi từ init() của ghichu.js
   ==================================================================== */
export function initOntap() {
  // UC-35: "Báo nội dung sai" ở phần Giải thích -> góp ý kèm câu hỏi đang xem
  $("ontap-ex-report").addEventListener("click", function () {
    var set = ontap.set, q = set && set.questions[ontap.idx];
    if (!q) return;
    hooks.reportContent({
      title: "Câu hỏi ôn tập sai: " + q.short, context: ["Ôn tập", set.title, "Câu " + (ontap.idx + 1) + " / " + set.questions.length],
      quote_heading: "Câu " + (ontap.idx + 1) + " · " + set.title,
      quote_text: q.text + "\n" + q.options.map(function (o, i) { return "ABCDEF"[i] + ". " + o; }).join("  ") + (q.explanation ? "\nGiải thích: " + q.explanation : ""),
      ref_type: q.id ? "quiz_question" : null, ref_id: q.id || null,
    });
  });
  form.bind();
  $("ontap-back-btn").addEventListener("click", function (e) { e.stopPropagation(); onClose(); });

  // Tab "Tạo mới" / "Đã tạo"
  $("ontap-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]"); if (!b) return;
    if (b.dataset.tab === "saved") { refreshSaved(); show("saved"); }
    else { form.initSource(); show("setup"); }
  });

  // --- Cột phải ---
  $("ontap-types").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b) return;
    ontap.type = b.dataset.v; renderSetup();
  });
  $("ontap-after").addEventListener("click", function (e) {
    var r = e.target.closest(".ontap-sw-row"); if (!r) return;
    ontap.opts[r.dataset.k] = !ontap.opts[r.dataset.k];
    renderSetup();
  });
  $("ontap-panel").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cancel") cancelJob();
    else if (b.dataset.act === "again") resetJob();
    else if (b.dataset.act === "start" && ontap.job && ontap.job.set) { var s = ontap.job.set; ontap.job = null; resetJob(); startQuiz(s); }
  });
  $("ontap-create").addEventListener("click", createQuizSet);

  // --- Đã tạo ---
  initSavedList();

  // Bấm nguồn trong phần Giải thích -> rời màn ôn tập, mở đúng Chương / PDF tại trang (UC-20 5a).
  // Không import ghichu.js: đi qua hooks.openSource (ghichu.js gán).
  $("ontap-ex-src").addEventListener("click", function () {
    var q = ontap.set && ontap.set.questions[ontap.idx];
    if (!q || !q.cite || !(q.cite.chapter_id || q.cite.document_id)) return;
    hooks.openSource({ subject_id: ontap.set.subjectId, chapter_id: q.cite.chapter_id, document_id: q.cite.document_id, page: q.cite.page, quote: q.cite.quote });
  });

  // --- Làm bài ---
  $("ontap-options").addEventListener("click", onOptionClick);
  $("ontap-notice-close").addEventListener("click", function () { ontap.noticeClosed = true; renderQuiz(); });
  $("ontap-prev").addEventListener("click", function () { if (ontap.idx > 0) { ontap.idx--; show("quiz"); } });
  $("ontap-next").addEventListener("click", onNext);
  $("ontap-to-result").addEventListener("click", backToResult);

  // --- Kết quả ---
  $("ontap-only-wrong").addEventListener("click", function () { ontap.onlyWrong = !ontap.onlyWrong; ontap.page = 0; renderReview(); });
  $("ontap-pg-prev").addEventListener("click", function () { ontap.page--; renderReview(); });
  $("ontap-pg-next").addEventListener("click", function () { ontap.page++; renderReview(); });
  $("ontap-per").innerHTML = perSelectHtml(getPerPage("rev_ontap", 0, REV_PER_OPTS), REV_PER_OPTS, "câu");
  bindPerSelect($("ontap-per"), "rev_ontap", function () { ontap.page = 0; renderReview(); });
  $("ontap-review-list").addEventListener("click", function (e) {
    var r = e.target.closest(".ontap-row"); if (!r) return;
    ontap.reviewing = true; ontap.idx = Number(r.dataset.i);
    show("quiz");
  });
  $("ontap-retry").addEventListener("click", function () { startQuiz(); });
  $("ontap-to-list").addEventListener("click", function () { refreshSaved(); show("saved"); });
  window.addEventListener("resize", function () { if (ontap.open && ontap.screen === "result") renderReview(); });
}
