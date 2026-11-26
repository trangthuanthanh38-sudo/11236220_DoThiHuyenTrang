/* ======================================================================
   ghichu_thithu.js — MODULE "Tạo đề thi thử" (UC-22, Studio AI). HTML ở
   html/ghichu_thithu.frag (nạp vào #mount-thithu-pane), style ở css/ghichu_thithu.css.
   Bố cục/luồng theo giao diện mẫu desktop-6-thi-thu (moi).html — cùng khuôn với "Tạo câu hỏi
   ôn tập" (ghichu_ontap.js):
     Tạo mới   — chọn Môn + tick Chương/Tệp PDF, tên đề, số câu (5–50, gợi ý/tối đa theo nguồn),
                 phân bổ độ khó (khuyến nghị 30/40/30 hoặc tự chỉnh), thời gian, ô "Đang tạo".
                 Phần form chung nằm ở ghichu_studio_form.js (dùng chung với Ôn tập).
     Đã tạo    — bảng đề: Làm bài / Làm tiếp (+ thời gian còn) / Xem điểm (mở chi tiết) · Kết quả ·
                 Làm lại (nhân bản đề) · xoá
     Làm bài   — đồng hồ đếm ngược, lưới câu, đánh dấu xem lại, đổi đáp án tới lúc nộp; đáp án ẩn
                 tới khi nộp bài hoặc hết giờ (tự nộp)
     Xem lại   — 1 câu sau khi nộp: đáp án, giải thích, nguồn (bấm mở tài liệu gốc)
     Kết quả   — điểm, thời gian, Dễ/TB/Khó, danh sách Đúng/Sai/Chưa làm

   Quy tắc khác Ôn tập (vì vậy vẫn là module riêng): đề chỉ làm 1 lần, đáp án sửa được tới lúc nộp,
   có đồng hồ ở server. Rời bài (× / chuyển công cụ / bấm Nguồn) KHÔNG huỷ bài: server giữ lần làm,
   đồng hồ vẫn chạy, quay lại bằng thẻ "Thi thử" hoặc "Làm tiếp" (UC-22 E1), hết giờ tự nộp (E2).
   Việc ẩn cột 1/cột 3/Topbar KHÔNG làm ở đây: module chỉ đổi `tt.open` rồi gọi hooks.syncLayout().

   Backend: backend/app/routers/quiz.py (khối UC-22 cuối file) + services/quiz_generation.py
   generate_exam_set(); database studio_tools_quiz_schema_v2.sql. Đổi field nào ở đây thì sửa cả
   schemas.py (Exam*):
     POST /quiz/source-stats          {subject_id, sources, mode:'exam'} -> {word_count, max_questions, ...}
     POST /quiz/exams                 {subject_id, sources:[{source_type, id}], title, requested_count,
                                       time_limit_minutes, difficulty_counts:[dễ, tb, khó]} -> đề (KHÔNG
                                       kèm đáp án): {id, title, subject_id, requested_count, question_count,
                                       time_limit_seconds, questions:[{id, position, difficulty,
                                       question_text, short_text, options:[{position, content}]}]}
     GET  /quiz/exams/{id}            -> đề + attempt (mở lại sau F5)
     POST /quiz/exams/{id}/start      -> attempt {id, remaining_seconds, finished,
                                         answers:[{question_id, selected_positions, is_flagged}]}
     PUT  /quiz/exam-attempts/{id}/answers/{question_id} {selected_positions, is_flagged}
     POST /quiz/exam-attempts/{id}/submit {reason:'manual'|'timeout'} -> kết quả
     GET  /quiz/exams                 -> [{id, title, subject_name, question_count, time_limit_seconds,
                                          status:'new'|'in_progress'|'done', remaining_seconds, correct_count,
                                          score_percent, submit_reason, duration_seconds, finished_seconds_ago}]
     GET  /quiz/exams/{id}/result     -> kết quả: {correct_count, total_questions, duration_seconds,
                                          time_limit_seconds, submit_reason, questions:[... + difficulty,
                                          options[].is_correct, explanation, citations, selected_positions]}
     POST /quiz/exams/{id}/retake     -> đề MỚI nhân bản câu hỏi ("Làm lại"; không gọi AI, không tính BR-08)
     DELETE /quiz/exams/{id}
   Mốc thời gian API trả dạng TƯƠNG ĐỐI (`*_seconds_ago`) vì DATETIME của DB không kèm múi giờ.
   ====================================================================== */
import { hooks, state, $, esc, isOnline, authToken, closeDropdownEl, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";
import { createCardList, histRow, histEmpty } from "./ghichu_cardlist.js";
import { createStudioForm, LEVELS, LEVEL_LABEL, pad, mmss, agoDate, fmtDay, fmtTime, apiErrorText } from "./ghichu_studio_form.js";

// Nhớ đề đang thi để F5 / mở lại thẻ Thi thử quay về đúng bài (đồng hồ vẫn chạy ở server).
var RESUME_KEY = "td_thithu_resume";
function saveResume(id) { try { localStorage.setItem(RESUME_KEY, id); } catch (e) {} }
function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
function readResume() { try { return localStorage.getItem(RESUME_KEY); } catch (e) { return null; } }

var MIN_COUNT = 5, MAX_COUNT = 50;       // khớp CHECK chk_quiz_sets_requested_count (mode='exam')
var KEYS = "ABCDEF";
var STATUS_LABEL = { ok: "Đúng", no: "Sai", skip: "Chưa làm" };

/* ---------------- state riêng của module ---------------- */
var tt = {
  open: false,
  screen: "setup",         // setup | saved | exam | review | result
  // --- Tạo mới (nguồn/tên/số câu/độ khó ở `form` — ghichu_studio_form.js) ---
  minutes: 30,
  job: null,               // ô "Đang tạo": {t0, total, nSrc, controller, timer, done, exam}
  error: "",
  // --- Làm bài ---
  exam: null,              // đề đang thi / vừa xem (đã chuẩn hoá, xem normalizeExam())
  attemptId: null,
  idx: 0,
  answers: [],             // [[position]] theo từng câu — [] = chưa trả lời
  flags: [],               // [bool]
  total: 0,                // tổng giây của đề
  deadline: 0,             // mốc hết giờ theo đồng hồ máy (Date.now() + remaining từ server)
  timerId: null,
  reducedClosed: false,
  offline: false,
  submitting: false,
  sync: Promise.resolve(),  // hàng đợi lưu đáp án — luôn tới server đúng thứ tự
  // --- Kết quả / Xem lại ---
  result: null,            // kết quả đã chuẩn hoá (normalizeResult())
  onlyWrong: false,
  page: 0,
  perPage: 8,              // "Đáp án và giải thích": số dòng mỗi trang (fitPage() tính theo chiều cao khung)
  vIdx: 0,                 // câu đang xem lại
  // --- Đã tạo ---
  saved: null,             // GET /quiz/exams (null = chưa tải)
  savedError: "",
  openSaved: null,         // id đề đang mở chi tiết
  details: {},             // id -> kết quả chuẩn hoá | "loading" | "error"
};

export function isOpen() { return tt.open; }

// Form "Tạo mới" dùng chung với Ôn tập (ghichu_studio_form.js).
var form = createStudioForm({
  ids: "thithu", cls: "tt", mode: "exam",
  minCount: MIN_COUNT, maxCount: MAX_COUNT, defaultCount: 10,
  createLabel: "Tạo đề thi", unit: "đề thi",
  panel: {
    idle: "Chưa có đề thi nào đang tạo. Tiến độ sẽ hiện ở đây sau khi bạn bấm Tạo đề thi.",
    steps: ["Đọc {n} nguồn nội dung", "Soạn {c} câu hỏi và đáp án", "Trộn đề, gắn nguồn"],
    startLabel: "Bắt đầu thi", againLabel: "Tạo đề khác",
  },
  active: function () { return tt.open && tt.screen === "setup"; },
  job: function () { return tt.job; },
  onChange: function () { renderSetup(); },
});

/* ====================================================================
   Mở / đóng
   ==================================================================== */
// Mở (bấm thẻ "Thi thử"): còn nhớ đề đang thi -> vào lại đúng bài; không thì GIỮ NGUYÊN trang đang
// dở (Đã tạo / Kết quả / Xem lại...) thay vì quay về Tạo mới.
export function openThithu() {
  tt.open = true;
  state.dd = null;
  closeDropdownEl();
  form.initSource();
  hooks.syncLayout();
  var id = readResume();
  if (id && isOnline() && !tt.exam) { resumeExam(id); return; }
  if (tt.screen === "exam" && tt.exam && tt.attemptId && !tt.result) {
    show("exam"); startTimer();
    if (left() <= 0) submit("timeout");
    return;
  }
  if ((tt.screen === "result" || tt.screen === "review") && !tt.result) tt.screen = "setup";
  if (tt.screen === "exam") tt.screen = "saved";
  show(tt.screen);
  refreshSaved();
}

// Ẩn màn thi thử. Đang làm bài thì bài vẫn còn ở server và đồng hồ vẫn chạy -> giữ RESUME_KEY để
// bấm lại thẻ "Thi thử" là quay về đúng bài. `keepPlace` (bấm "Nguồn" ở màn Xem lại — ghichu.js
// openSource()) chỉ để thống nhất với Ôn tập: trang đang ở luôn được giữ trong bộ nhớ.
export function closeThithu(keepPlace) {
  tt.open = false;
  if (list) list.leave();
  stopTimer();
  $("thithu-confirm").hidden = true;
  if (tt.screen !== "exam" && !keepPlace) clearResume();
  state.dd = null;
  closeDropdownEl();
  hooks.syncLayout();
}

function show(screen) {
  tt.screen = screen;
  render();
  $("thithu-body").scrollTop = 0;
}

function toast(msg) {
  var t = $("thithu-toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(function () { t.hidden = true; }, 3200);
}

function render() {
  if (!tt.open) return;
  var sc = tt.screen, formView = sc === "setup" || sc === "saved";
  ["setup", "saved", "exam", "review", "result"].forEach(function (s) { $("thithu-s-" + s).hidden = s !== sc; });
  $("thithu-tabbar").hidden = !formView;
  Array.prototype.forEach.call($("thithu-tabs").children, function (b) {
    b.classList.toggle("on", (b.dataset.tab === "new" ? "setup" : "saved") === sc);
  });
  $("thithu-saved-count").textContent = tt.saved && tt.saved.length ? tt.saved.length : "";
  $("thithu-create").hidden = sc !== "setup";
  $("thithu-head-note").hidden = sc !== "review";
  $("thithu-head-note").textContent = "Đang xem lại bài thi đã nộp";
  $("thithu-title").textContent = formView || !tt.exam ? "Tạo đề thi thử" : tt.exam.title;
  if (sc === "setup") renderSetup();
  else if (sc === "saved") renderSaved();
  else if (sc === "exam") renderExam();
  else if (sc === "review") renderReview();
  else renderResult();
}

// Nút × : Tạo mới/Đã tạo -> về Notebook; xem lại 1 câu -> Kết quả; kết quả -> Đã tạo; đang thi ->
// Đã tạo (bài KHÔNG bị huỷ: đồng hồ server vẫn chạy, "Làm tiếp" để quay lại, hết giờ tự nộp).
function onClose() {
  if (tt.screen === "review") { show("result"); return; }
  if (tt.screen === "result") { refreshSaved(); show("saved"); return; }
  if (tt.screen === "exam") {
    if (tt.submitting) return;
    if (!window.confirm("Rời khỏi bài thi? Đồng hồ vẫn tiếp tục chạy — bấm “Làm tiếp” ở tab Đã tạo (hoặc bấm lại thẻ “Thi thử”) để làm tiếp trước khi hết giờ; hết giờ bài sẽ tự nộp.")) return;
    stopTimer();
    tt.exam = null; tt.attemptId = null; // lần làm vẫn còn ở server -> "Làm tiếp"
    clearResume();
    refreshSaved();
    show("saved");
    return;
  }
  closeThithu();
}

/* ====================================================================
   TẠO MỚI — phần riêng thi thử: thời gian làm bài + gọi POST /quiz/exams
   ==================================================================== */
function renderSetup() {
  $("thithu-duration").style.pointerEvents = tt.job ? "none" : "";
  Array.prototype.forEach.call($("thithu-duration").children, function (b) { b.classList.toggle("on", Number(b.dataset.v) === tt.minutes); });
  form.render();
  renderPanel();
}

function renderPanel() {
  form.renderPanel(tt.error, function (j) {
    var e = j.exam, fewer = e.requested > e.questions.length;
    return '<p><b style="font-weight:500">' + esc(e.title) + '</b><br><span class="tt-muted">' + e.questions.length + " câu · " +
      Math.round(e.timeLimit / 60) + " phút" + (fewer ? " (nguồn chỉ đủ cho " + e.questions.length + "/" + e.requested + " câu)" : "") + "</span></p>";
  });
}

function createExam() {
  if (!form.validate()) return;
  if (!isOnline()) {
    tt.error = "Cần đăng nhập để AI tạo đề thi từ tài liệu của bạn.";
    renderPanel();
    return;
  }
  var body = Object.assign(form.sourcesForApi(), form.difficultyPayload(false));
  body.title = form.name.trim();
  body.requested_count = form.count;
  body.time_limit_minutes = tt.minutes;

  var controller = window.AbortController ? new AbortController() : null;
  var job = { t0: Date.now(), total: form.count, nSrc: body.sources.length, controller: controller, done: false };
  tt.job = job; tt.error = "";
  job.timer = setInterval(function () { if (tt.open && tt.screen === "setup") renderPanel(); }, 1000);
  renderSetup();

  apiAuth("POST", "/quiz/exams", authToken(), body, controller ? controller.signal : undefined).then(function (res) {
    if (tt.job !== job) return; // đã bấm Hủy
    clearInterval(job.timer);
    if (res.ok && (res.data.questions || []).length) {
      job.done = true;
      job.exam = normalizeExam(res.data);
      refreshSaved(); // đề mới xuất hiện ngay ở tab "Đã tạo"
    } else {
      tt.job = null;
      tt.error = res.ok ? "AI chưa tạo được câu hỏi nào từ nguồn đã chọn." : apiErrorText(res, "/quiz/exams", "Không tạo được đề thi.");
    }
    if (tt.open && tt.screen === "setup") renderSetup();
    else if (tt.open && job.done) toast("Đã tạo xong “" + job.exam.title + "” — xem ở tab Đã tạo.");
  });
}

function cancelJob() {
  var j = tt.job;
  if (!j || j.done) return;
  clearInterval(j.timer);
  if (j.controller) j.controller.abort();
  tt.job = null;
  renderSetup();
  toast("Đã ngừng chờ. Nếu máy chủ đã kịp tạo xong, đề thi vẫn sẽ hiện ở tab Đã tạo.");
  setTimeout(refreshSaved, 20000); // server vẫn có thể đang tạo nốt
}

function resetJob() {
  tt.job = null; tt.error = "";
  form.reset();
  if (tt.open && tt.screen === "setup") renderSetup();
}

// Chuẩn hoá phản hồi API về dạng màn làm bài dùng (tách khỏi tên cột backend).
function normalizeExam(d) {
  return {
    id: d.id,
    title: d.title,
    subjectId: d.subject_id,
    requested: d.requested_count,
    timeLimit: d.time_limit_seconds,
    questions: (d.questions || []).slice().sort(function (a, b) { return a.position - b.position; }).map(function (q) {
      return {
        id: q.id,
        text: q.question_text,
        short: q.short_text || q.question_text,
        level: q.difficulty,
        opts: (q.options || []).slice().sort(function (a, b) { return a.position - b.position; }).map(function (o) { return o.content; }),
      };
    }),
  };
}

/* ====================================================================
   LÀM BÀI THI
   ==================================================================== */
function startExam(exam) {
  return apiAuth("POST", "/quiz/exams/" + exam.id + "/start", authToken()).then(function (res) {
    if (!res.ok) {
      window.alert(apiErrorText(res, "/quiz/exams/{id}/start", "Không bắt đầu làm bài được."));
      refreshSaved();
      return;
    }
    enterExam(exam, res.data);
  });
}

// Vào màn làm bài với attempt từ server — dùng cho cả bài mới lẫn mở lại sau F5 (E1).
function enterExam(exam, attempt) {
  if (attempt.finished) { tt.exam = exam; tt.attemptId = attempt.id; submit("manual"); return; }
  tt.exam = exam;
  tt.attemptId = attempt.id;
  tt.idx = 0;
  var byId = {};
  (attempt.answers || []).forEach(function (a) { byId[a.question_id] = a; });
  tt.answers = exam.questions.map(function (q) { return byId[q.id] ? (byId[q.id].selected_positions || []).slice() : []; });
  tt.flags = exam.questions.map(function (q) { return !!(byId[q.id] && byId[q.id].is_flagged); });
  tt.total = exam.timeLimit;
  tt.deadline = Date.now() + Math.max(0, attempt.remaining_seconds) * 1000;
  tt.reducedClosed = false;
  tt.result = null;
  tt.sync = Promise.resolve();
  saveResume(exam.id);
  if (!tt.open) { tt.open = true; hooks.syncLayout(); }
  show("exam");
  startTimer();
}

function left() { return Math.max(0, Math.round((tt.deadline - Date.now()) / 1000)); }
function startTimer() {
  stopTimer();
  tick();
  tt.timerId = setInterval(function () { tick(); if (left() <= 0) submit("timeout"); }, 1000);
}
function stopTimer() { clearInterval(tt.timerId); tt.timerId = null; }
function tick() {
  var l = left();
  $("thithu-timer").textContent = mmss(l);
  $("thithu-tbar").style.width = (tt.total ? l / tt.total * 100 : 0) + "%";
  $("thithu-timer-box").classList.toggle("low", l <= 60);
  if (!$("thithu-confirm").hidden) $("thithu-m-time").textContent = mmss(l);
}

function answeredCount() { return tt.answers.filter(function (a) { return a.length; }).length; }

function renderExam() {
  var q = tt.exam.questions[tt.idx], n = tt.exam.questions.length, pick = tt.answers[tt.idx];
  var reduced = tt.exam.requested > n;
  $("thithu-reduced").hidden = !reduced || tt.reducedClosed;
  $("thithu-reduced-text").textContent = "Nguồn đã chọn chỉ đủ nội dung cho " + n + " câu, nên đề thi được giảm từ " + tt.exam.requested + " xuống " + n + " câu.";
  $("thithu-offline").hidden = !tt.offline;
  $("thithu-q-pos").textContent = "Câu " + (tt.idx + 1) + " / " + n;
  $("thithu-q-done").textContent = "Đã trả lời " + answeredCount() + " / " + n;
  $("thithu-q-bar").style.width = ((tt.idx + 1) / n * 100) + "%";
  $("thithu-q-meta").textContent = (LEVEL_LABEL[q.level] || "") + " · Một đáp án";
  $("thithu-q-text").textContent = q.text;
  $("thithu-options").innerHTML = q.opts.map(function (o, i) {
    var on = pick.indexOf(i) >= 0;
    return '<button type="button" class="tt-opt' + (on ? " picked" : "") + '" data-i="' + i + '" aria-pressed="' + on + '">' +
      '<span class="key">' + KEYS[i] + '</span><span class="label">' + esc(o) + "</span></button>";
  }).join("");
  var f = tt.flags[tt.idx];
  $("thithu-flag").classList.toggle("on", f);
  $("thithu-flag").textContent = f ? "⚑  Đã đánh dấu xem lại" : "⚑  Đánh dấu để xem lại";
  $("thithu-prev").disabled = tt.idx === 0;
  $("thithu-next").disabled = tt.idx === n - 1;
  $("thithu-grid").innerHTML = tt.exam.questions.map(function (_, i) {
    var c = "tt-cell" + (tt.answers[i].length ? " done" : "") + (i === tt.idx ? " cur" : "") + (tt.flags[i] ? " flagged" : "");
    return '<button type="button" class="' + c + '" data-i="' + i + '" aria-label="Câu ' + (i + 1) + '">' + (i + 1) + "</button>";
  }).join("");
  $("thithu-submit").disabled = tt.submitting;
  tick();
}

function go(i) { tt.idx = i; renderExam(); $("thithu-body").scrollTo({ top: 0, behavior: "smooth" }); }

// Lưu đáp án/cờ của 1 câu — xếp hàng nối tiếp; mất mạng thì giữ trạng thái trên máy, báo offline
// và gửi lại toàn bộ khi có mạng (UC-22 E1). Server là nơi chấm, không trả đúng/sai trước khi nộp.
function saveQuestion(i) {
  var q = tt.exam.questions[i], attemptId = tt.attemptId;
  var body = { selected_positions: tt.answers[i].slice(), is_flagged: tt.flags[i] };
  tt.sync = tt.sync.then(function () {
    return apiAuth("PUT", "/quiz/exam-attempts/" + attemptId + "/answers/" + q.id, authToken(), body).then(function (res) {
      if (res.status === 0) setOffline(true);
      else if (res.ok) setOffline(false);
      else if (res.status === 409) submit("timeout"); // server báo đã hết giờ / đã nộp
    });
  });
}
function setOffline(v) {
  if (tt.offline === v) return;
  tt.offline = v;
  if (tt.open && tt.screen === "exam") $("thithu-offline").hidden = !v;
}
function resyncAll() {
  if (!tt.exam || tt.screen !== "exam") return;
  tt.exam.questions.forEach(function (_, i) { if (tt.answers[i].length || tt.flags[i]) saveQuestion(i); });
}

function onOptionClick(e) {
  var b = e.target.closest(".tt-opt"); if (!b) return;
  var i = Number(b.dataset.i), a = tt.answers[tt.idx];
  tt.answers[tt.idx] = a[0] === i ? [] : [i]; // đề thi thử chỉ có câu 1 đáp án; bấm lại = bỏ chọn
  saveQuestion(tt.idx);
  renderExam();
}

/* ---------- Xác nhận nộp bài ---------- */
function openConfirm() {
  var n = tt.exam.questions.length;
  var miss = [];
  tt.answers.forEach(function (a, i) { if (!a.length) miss.push(i + 1); });
  $("thithu-m-text").textContent = miss.length
    ? "Bạn còn " + miss.length + " câu chưa trả lời (câu " + (miss.length > 6 ? miss.slice(0, 6).join(", ") + "…" : miss.join(", ")) + "). Sau khi nộp, bạn không thể sửa đáp án và không làm lại được đề này."
    : "Bạn đã trả lời tất cả các câu. Sau khi nộp, bạn không thể sửa đáp án và không làm lại được đề này.";
  $("thithu-m-done").textContent = (n - miss.length) + " / " + n;
  $("thithu-m-time").textContent = mmss(left());
  $("thithu-confirm").hidden = false;
  $("thithu-m-submit").focus();
}
function closeConfirm() { $("thithu-confirm").hidden = true; }

// Nộp bài (bấm "Nộp bài" hoặc hết giờ). Chờ mọi lệnh lưu đáp án trước đó xong rồi mới nộp.
function submit(reason) {
  if (tt.submitting || !tt.attemptId) return;
  tt.submitting = true;
  stopTimer();
  closeConfirm();
  if (tt.screen === "exam") renderExam();
  var attemptId = tt.attemptId;
  tt.sync.then(function () {
    return apiAuth("POST", "/quiz/exam-attempts/" + attemptId + "/submit", authToken(), { reason: reason });
  }).then(function (res) {
    tt.submitting = false;
    if (!res.ok) {
      window.alert(apiErrorText(res, "/quiz/exam-attempts/{id}/submit", "Không nộp bài được."));
      if (tt.screen === "exam" && left() > 0) startTimer();
      if (tt.screen === "exam") renderExam();
      return;
    }
    clearResume();
    refreshSaved();
    showResult(res.data);
  });
}

/* ====================================================================
   KẾT QUẢ + XEM LẠI 1 CÂU
   ==================================================================== */
function normalizeResult(d) {
  var qs = (d.questions || []).slice().sort(function (a, b) { return a.position - b.position; }).map(function (q) {
    var opts = (q.options || []).slice().sort(function (a, b) { return a.position - b.position; });
    var correct = opts.filter(function (o) { return o.is_correct; }).map(function (o) { return o.position; });
    var selected = (q.selected_positions || []).slice();
    var ok = selected.length && selected.length === correct.length && selected.every(function (p) { return correct.indexOf(p) >= 0; });
    var c = (q.citations || [])[0] || null;
    return {
      id: q.id,
      text: q.question_text,
      short: q.short_text || q.question_text,
      level: q.difficulty,
      opts: opts.map(function (o) { return o.content; }),
      correct: correct,
      selected: selected,
      status: !selected.length ? "skip" : ok ? "ok" : "no",
      ex: q.explanation || "",
      // chapter_id/document_id null khi nguồn đã bị xoá (FK SET NULL) -> chỉ hiện tên, không mở được
      cite: c && { label: c.source_label, page: c.page_number, quote: c.quote, chapter_id: c.chapter_id, document_id: c.document_id },
    };
  });
  return {
    correct: d.correct_count,
    total: d.total_questions,
    duration: d.duration_seconds || 0,
    timeLimit: d.time_limit_seconds || (tt.exam && tt.exam.timeLimit) || 0,
    timedOut: d.submit_reason === "timeout",
    questions: qs,
  };
}

function levelStats(r) {
  return LEVELS.map(function (lv) {
    var qs = r.questions.filter(function (q) { return q.level === lv; });
    return qs.filter(function (q) { return q.status === "ok"; }).length + " / " + qs.length;
  });
}
function countStatus(r, s) { return r.questions.filter(function (q) { return q.status === s; }).length; }

// Hiện màn Kết quả từ dữ liệu server (sau khi nộp, hoặc "Kết quả" 1 đề đã nộp ở tab "Đã tạo").
function showResult(data, exam) {
  if (exam) { tt.exam = exam; tt.attemptId = null; }
  tt.result = normalizeResult(data);
  if (tt.exam) tt.details[tt.exam.id] = tt.result;
  tt.onlyWrong = false; tt.page = 0;
  if (tt.open) show("result");
}

var LEVEL_SHORT = { easy: "Dễ", medium: "TB", hard: "Khó" }; // dòng phụ ô "Đúng" (ô hẹp)

// Màn Kết quả — 1 cột, cùng khuôn màn "Hoàn thành phiên ôn" của Flashcard.
function renderResult() {
  var r = tt.result, n = r.total || r.questions.length, skip = countStatus(r, "skip"), wrong = countStatus(r, "no");
  $("thithu-timeout-note").hidden = !r.timedOut;
  $("thithu-timeout-text").textContent = "Đã hết giờ. Hệ thống tự nộp " + (n - skip) + " / " + n + " câu bạn đã làm.";
  $("thithu-r-score").textContent = r.correct + " / " + n + " câu đúng · " + (n ? Math.round(r.correct / n * 100) : 0) + "%";
  $("thithu-r-meta").textContent = (tt.exam ? tt.exam.title + "  ·  " : "") + (skip ? skip + " câu chưa làm" : "Làm đủ tất cả các câu");
  $("thithu-r-ok").textContent = r.correct + " câu";
  // Dòng phụ ô Đúng: đúng theo từng mức độ khó (chỉ các mức có câu).
  var lv = levelStats(r);
  $("thithu-r-ok-s").textContent = LEVELS.map(function (l, k) {
    return /\/ 0$/.test(lv[k]) ? "" : LEVEL_SHORT[l] + " " + lv[k].replace(/ /g, "");
  }).filter(Boolean).join(" · ");
  $("thithu-r-ok-s").title = "Số câu đúng theo độ khó: Dễ · Trung bình (TB) · Khó";
  $("thithu-r-no").textContent = wrong + " câu";
  $("thithu-r-no-s").textContent = wrong ? "Xem đáp án bên dưới" : "Không có câu sai";
  $("thithu-r-skip").textContent = skip + " câu";
  $("thithu-r-skip-s").textContent = skip ? "Tính là sai khi chấm" : "Làm đủ tất cả các câu";
  $("thithu-r-time").textContent = mmss(r.duration);
  $("thithu-r-time-s").textContent = r.timedOut ? "Hết giờ, tự nộp" : "Giới hạn " + mmss(r.timeLimit);
  renderAnswers();
}

// Số dòng mỗi trang: mặc định "Vừa khung" (0) = vừa khít khung danh sách (dòng cuối chạm đáy khung); người dùng chọn
// 10 / 20 / 50 ở ô "Hiển thị" thì dùng đúng số đó, dòng cao 41px, khung tự cuộn (nhớ localStorage "rev_thithu").
var REV_PER_OPTS = [0, 10, 20, 50];
function fitPage() {
  var list = $("thithu-ans-list"), fixed = getPerPage("rev_thithu", 0, REV_PER_OPTS);
  if (fixed) { tt.perPage = fixed; list.style.setProperty("--rh", "41px"); list.style.overflowY = "auto"; return; }
  list.style.overflowY = "";
  var avail = list.clientHeight;
  tt.perPage = Math.max(3, Math.floor(avail / 41));
  list.style.setProperty("--rh", (avail ? avail / tt.perPage : 41) + "px");
}

function renderAnswers() {
  fitPage();
  var r = tt.result, per = tt.perPage;
  $("thithu-only-wrong").classList.toggle("on", tt.onlyWrong);
  var rows = [];
  r.questions.forEach(function (q, i) { if (!tt.onlyWrong || q.status !== "ok") rows.push(i); });
  var pages = Math.max(1, Math.ceil(rows.length / per));
  tt.page = Math.min(tt.page, pages - 1);
  var slice = rows.slice(tt.page * per, tt.page * per + per);
  $("thithu-ans-list").innerHTML = slice.length ? slice.map(function (i) {
    var q = r.questions[i];
    return '<button type="button" class="tt-row" data-i="' + i + '" title="Xem câu ' + (i + 1) + '">' +
      '<span class="n">' + pad(i + 1) + '</span><span class="qt">' + esc(q.short) + '</span><span class="st ' + q.status + '">' + STATUS_LABEL[q.status] + "</span></button>";
  }).join("") : '<div class="tt-row tt-muted">Bạn không có câu nào sai.</div>';
  $("thithu-pager").hidden = pages <= 1;
  $("thithu-pg-info").textContent = (tt.page + 1) + " / " + pages;
  $("thithu-pg-prev").disabled = tt.page === 0;
  $("thithu-pg-next").disabled = tt.page >= pages - 1;
}

function renderReview() {
  var r = tt.result, n = r.questions.length, q = r.questions[tt.vIdx];
  $("thithu-v-pos").textContent = "Câu " + (tt.vIdx + 1) + " / " + n;
  $("thithu-v-meta").textContent = (LEVEL_LABEL[q.level] || "") + " · " + STATUS_LABEL[q.status];
  $("thithu-v-bar").style.width = ((tt.vIdx + 1) / n * 100) + "%";
  $("thithu-v-text").textContent = q.text;
  $("thithu-v-options").innerHTML = q.opts.map(function (o, i) {
    var chosen = q.selected.indexOf(i) >= 0, right = q.correct.indexOf(i) >= 0, cls = "", tag = "";
    if (right) { cls = "right"; tag = chosen ? "Bạn đã chọn · Đúng" : q.status === "skip" ? "Đáp án đúng · bạn chưa làm" : "Đáp án đúng"; }
    else if (chosen) { cls = "wrong"; tag = "Bạn đã chọn"; }
    return '<button type="button" class="tt-opt ' + cls + '" disabled><span class="key">' + KEYS[i] + '</span><span class="label">' + esc(o) + "</span>" +
      (tag ? '<span class="tag">' + tag + "</span>" : "") + "</button>";
  }).join("");
  $("thithu-v-ex").textContent = q.ex;
  $("thithu-v-cite").hidden = !q.cite;
  if (q.cite) {
    var canOpen = !!(q.cite.chapter_id || q.cite.document_id), btn = $("thithu-v-src");
    $("thithu-v-quote").textContent = q.cite.quote || "";
    btn.textContent = "Nguồn: " + q.cite.label + (q.cite.page ? " · trang " + q.cite.page : "");
    btn.classList.toggle("can-open", canOpen);
    btn.disabled = !canOpen;
    btn.title = canOpen ? "Mở tài liệu gốc" + (q.cite.page ? " tại trang " + q.cite.page : "") : "Tài liệu gốc không còn trong Notebook";
  }
  $("thithu-v-prev").disabled = tt.vIdx === 0;
  $("thithu-v-next").hidden = tt.vIdx === n - 1;
}

/* ====================================================================
   ĐÃ TẠO — bảng (GET /quiz/exams) + chi tiết 1 đề đã nộp (GET /quiz/exams/{id}/result)
   ==================================================================== */
function refreshSaved() {
  if (!isOnline()) { tt.saved = []; if (tt.open && (tt.screen === "setup" || tt.screen === "saved")) render(); return; }
  apiAuth("GET", "/quiz/exams", authToken()).then(function (res) {
    tt.saved = res.ok && Array.isArray(res.data) ? res.data : (tt.saved || []);
    tt.savedError = res.ok ? "" : apiErrorText(res, "/quiz/exams", "Không tải được danh sách đề thi.");
    if (tt.open && (tt.screen === "setup" || tt.screen === "saved")) render();
  });
}

function loadDetail(id) {
  if (tt.details[id] && tt.details[id] !== "error") return Promise.resolve(tt.details[id]);
  tt.details[id] = "loading";
  return apiAuth("GET", "/quiz/exams/" + id + "/result", authToken()).then(function (res) {
    tt.details[id] = res.ok ? normalizeResult(res.data) : "error";
    if (tt.open && tt.screen === "saved") renderSaved();
    return res.ok ? res.data : null;
  });
}

// Hộp "Xem điểm" của 1 đề đã nộp: điểm, thời gian, Đúng / Sai / Chưa làm, theo mức độ (GET /quiz/exams/{id}/result).
function historyBody(e) {
  if (e.status !== "done") return histEmpty("Đề này chưa nộp bài.");
  var d = tt.details[e.id];
  if (d === undefined) { loadDetail(e.id); d = "loading"; }
  if (d === "loading") return histEmpty("Đang tải…");
  if (d === "error") return histEmpty("Không tải được kết quả của đề này.");
  var lv = levelStats(d);
  return histRow("Đã nộp", e.score_percent, e.score_percent + "%", e.correct_count + "/" + e.question_count + " câu · " + mmss(e.duration_seconds || 0),
      e.finished_seconds_ago != null ? fmtTime(agoDate(e.finished_seconds_ago)) : "") +
    (e.submit_reason === "timeout" ? '<div class="cl-hmore">Hết giờ, tự nộp</div>' : "") +
    '<div class="cl-stats"><span>Đúng<b>' + countStatus(d, "ok") + "</b></span><span>Sai<b>" + countStatus(d, "no") + "</b></span><span>Chưa làm<b>" +
    countStatus(d, "skip") + "</b></span><span>Dễ<b>" + lv[0] + "</b></span><span>Trung bình<b>" + lv[1] + "</b></span><span>Khó<b>" + lv[2] + "</b></span></div>";
}

// Đã tạo = lưới thẻ dùng chung (ghichu_cardlist.js, cùng khuôn Tóm tắt) — tạo trong initThithu().
var list = null;
function renderSaved() { if (list) list.render(); }
function byTitle(a, b) { return a.title.localeCompare(b.title, "vi", { numeric: true }); }
function byNum(v) { return function (a, b) { var x = v(a), y = v(b); return (x == null) - (y == null) || (x == null ? 0 : x - y); }; }
function savedCard(e) {
  var done = e.status === "done", live = e.status === "in_progress";
  var acts = done ? [{ act: "result", label: "Kết quả" }, { act: "retake", label: "Làm lại" }] : [{ act: "open", label: live ? "Làm tiếp" : "Làm bài" }];
  var menu = done
    ? [{ m: "result", label: "Kết quả" }, { m: "history", label: "Xem điểm" }, { m: "retake", label: "Làm lại (đề mới cùng câu hỏi)" }]
    : [{ m: "open", label: live ? "Làm tiếp" : "Làm bài" }];
  return {
    lines: [
      { cls: "l1", html: esc(e.subject_name || "") },
      { html: e.question_count + " câu · " + Math.round(e.time_limit_seconds / 60) + " phút" },
      { html: done ? "Đúng " + e.correct_count + "/" + e.question_count + " · làm trong " + mmss(e.duration_seconds || 0) : live ? "Còn " + mmss(e.remaining_seconds || 0) + " — đồng hồ vẫn chạy" : "Chưa làm" },
    ],
    badge: done ? { text: "Điểm " + e.score_percent + "%" + (e.submit_reason === "timeout" ? " · hết giờ" : ""), cls: e.score_percent >= 80 ? "ok" : "" }
      : live ? { text: "Đang làm · còn " + mmss(e.remaining_seconds || 0), cls: "warn" } : { text: "Chưa làm", cls: "gone" },
    foot: done && e.finished_seconds_ago != null ? "Ngày làm " + fmtDay(agoDate(e.finished_seconds_ago)).toLowerCase() : live ? "Đang làm" : "Chưa làm",
    acts: acts, menu: menu.concat([{ m: "del", label: "Xoá đề thi", del: true }]),
  };
}
function initSavedList() {
  list = createCardList({
    pane: $("thithu-pane"), bar: $("thithu-saved-bar"), box: $("thithu-saved-list"), noun: "đề thi",
    items: function () { return isOnline() ? tt.saved : []; },
    error: function () { return tt.savedError || ""; },
    notice: function () { return isOnline() ? "" : "Đăng nhập để lưu, xem lại và làm lại các đề thi."; },
    id: function (e) { return String(e.id); }, title: function (e) { return e.title; },
    search: function (e) { return e.title + " " + (e.subject_name || ""); },
    filters: [{ key: "all", label: "Tất cả" }, { key: "new", label: "Chưa làm", test: function (e) { return e.status === "new"; } },
      { key: "live", label: "Đang làm", test: function (e) { return e.status === "in_progress"; } },
      { key: "done", label: "Đã nộp", test: function (e) { return e.status === "done"; } }],
    sorts: {
      new: { label: "Mới tạo", cmp: function (a, b) { return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0; } },
      day: { label: "Ngày làm", cmp: byNum(function (e) { return e.finished_seconds_ago; }) },
      best: { label: "Điểm cao nhất", cmp: byNum(function (e) { return e.status === "done" ? -e.score_percent : null; }) },
      az: { label: "Tên A–Z", cmp: byTitle },
    },
    card: savedCard,
    primary: function (e) { return e.status === "done" ? "result" : "open"; },
    onAct: function (act, id) { return act === "open" ? openSavedExam(id) : act === "result" ? reviewExam(id) : act === "retake" ? retakeExam(id) : null; },
    newTile: { title: "Tạo đề thi mới", sub: "Đề có tính giờ, xem đáp án sau khi nộp" },
    onNew: function () { form.initSource(); show("setup"); },
    remove: {
      api: function (id) { return "/quiz/exams/" + id; },
      after: function (id) { if (readResume() === id) clearResume(); delete tt.details[id]; refreshSaved(); },
    },
    history: historyBody,
  });
}

function savedExam(id) { return (tt.saved || []).find(function (x) { return x.id === id; }); }

// "Làm bài" / "Làm tiếp": đề chưa bắt đầu -> bắt đầu (đồng hồ chạy từ đây); đang làm -> vào lại đúng bài.
function openSavedExam(id) {
  return apiAuth("GET", "/quiz/exams/" + id, authToken()).then(function (res) {
    if (!res.ok) { window.alert(apiErrorText(res, "/quiz/exams/{id}", "Không mở được đề thi.")); refreshSaved(); return; }
    var exam = normalizeExam(res.data);
    if (res.data.attempt) enterExam(exam, res.data.attempt);
    else return startExam(exam);
  });
}

// Từ thông báo "Bài thi đang dở": vào lại đúng đề (còn giờ -> làm tiếp; đã nộp / hết giờ -> kết quả).
export function openExam(id) {
  if (tt.exam && tt.exam.id === id && tt.attemptId && !tt.result) { openThithu(); return; }
  tt.open = true;
  state.dd = null;
  closeDropdownEl();
  form.initSource();
  hooks.syncLayout();
  show("saved");
  refreshSaved();
  openSavedExam(id);
}

// "Kết quả": màn kết quả + đáp án + giải thích + nguồn của đề đã nộp.
function reviewExam(id) {
  var e = savedExam(id);
  return apiAuth("GET", "/quiz/exams/" + id + "/result", authToken()).then(function (res) {
    if (!res.ok) { window.alert(apiErrorText(res, "/quiz/exams/{id}/result", "Không xem được kết quả.")); refreshSaved(); return; }
    showResult(res.data, { id: id, title: e ? e.title : "", subjectId: e ? e.subject_id : null, requested: 0, timeLimit: res.data.time_limit_seconds, questions: [] });
  });
}

// "Làm lại": nhân bản thành đề thi mới (cùng câu hỏi, thứ tự xáo lại) rồi bắt đầu làm ngay.
function retakeExam(id) {
  return apiAuth("POST", "/quiz/exams/" + id + "/retake", authToken()).then(function (res) {
    if (!res.ok) { window.alert(apiErrorText(res, "/quiz/exams/{id}/retake", "Không làm lại được đề thi.")); refreshSaved(); return; }
    refreshSaved();
    return startExam(normalizeExam(res.data));
  });
}

/* ---------- Mở lại đề đang thi sau F5 / khi bấm lại thẻ "Thi thử" ---------- */
function resumeExam(id) {
  apiAuth("GET", "/quiz/exams/" + id, authToken()).then(function (res) {
    if (!res.ok || !res.data.attempt) {
      clearResume();
      if (tt.open) { show(tt.screen === "exam" ? "setup" : tt.screen); refreshSaved(); }
      return;
    }
    enterExam(normalizeExam(res.data), res.data.attempt);
    refreshSaved();
  });
}
export function resumeIfNeeded() {
  if (readResume() && isOnline()) openThithu();
}

/* ====================================================================
   Gắn sự kiện
   ==================================================================== */
export function initThithu() {
  // UC-35: "Báo nội dung sai" ở màn Xem lại 1 câu
  $("thithu-v-report").addEventListener("click", function () {
    var r = tt.result, q = r && r.questions[tt.vIdx];
    if (!q) return;
    hooks.reportContent({
      title: "Câu hỏi thi thử sai: " + q.short, context: ["Thi thử", "Câu " + (tt.vIdx + 1) + " / " + r.questions.length],
      quote_heading: "Câu " + (tt.vIdx + 1) + " · Đề thi thử",
      quote_text: q.text + "\n" + q.opts.map(function (o, i) { return KEYS[i] + ". " + o; }).join("  ") + (q.ex ? "\nGiải thích: " + q.ex : ""),
      ref_type: q.id ? "quiz_question" : null, ref_id: q.id || null,
    });
  });
  form.bind();
  $("thithu-back-btn").addEventListener("click", function (e) { e.stopPropagation(); onClose(); });

  // Tab "Tạo mới" / "Đã tạo"
  $("thithu-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]"); if (!b) return;
    if (b.dataset.tab === "saved") { refreshSaved(); show("saved"); }
    else { form.initSource(); show("setup"); }
  });

  // --- Tạo mới ---
  $("thithu-duration").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-v]"); if (!b) return;
    tt.minutes = Number(b.dataset.v); renderSetup();
  });
  $("thithu-panel").addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "cancel") cancelJob();
    else if (b.dataset.act === "again") resetJob();
    else if (b.dataset.act === "start" && tt.job && tt.job.exam) { var ex = tt.job.exam; resetJob(); startExam(ex); }
  });
  $("thithu-create").addEventListener("click", createExam);

  // --- Đã tạo ---
  initSavedList();

  // --- Làm bài ---
  $("thithu-options").addEventListener("click", onOptionClick);
  $("thithu-flag").addEventListener("click", function () { tt.flags[tt.idx] = !tt.flags[tt.idx]; saveQuestion(tt.idx); renderExam(); });
  $("thithu-prev").addEventListener("click", function () { if (tt.idx > 0) go(tt.idx - 1); });
  $("thithu-next").addEventListener("click", function () { if (tt.idx < tt.exam.questions.length - 1) go(tt.idx + 1); });
  $("thithu-grid").addEventListener("click", function (e) { var c = e.target.closest(".tt-cell"); if (c) go(Number(c.dataset.i)); });
  $("thithu-reduced-close").addEventListener("click", function () { tt.reducedClosed = true; renderExam(); });
  $("thithu-submit").addEventListener("click", openConfirm);
  $("thithu-m-cancel").addEventListener("click", closeConfirm);
  $("thithu-m-submit").addEventListener("click", function () { submit("manual"); });
  $("thithu-confirm").addEventListener("click", function (e) { if (e.target.id === "thithu-confirm") closeConfirm(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && tt.open) closeConfirm(); });
  window.addEventListener("offline", function () { setOffline(true); });
  window.addEventListener("online", function () { setOffline(false); resyncAll(); });

  // --- Kết quả ---
  $("thithu-ans-list").addEventListener("click", function (e) {
    var r = e.target.closest(".tt-row[data-i]"); if (!r) return;
    tt.vIdx = Number(r.dataset.i);
    show("review");
  });
  $("thithu-only-wrong").addEventListener("click", function () { tt.onlyWrong = !tt.onlyWrong; tt.page = 0; renderAnswers(); });
  $("thithu-pg-prev").addEventListener("click", function () { tt.page--; renderAnswers(); });
  $("thithu-pg-next").addEventListener("click", function () { tt.page++; renderAnswers(); });
  $("thithu-per").innerHTML = perSelectHtml(getPerPage("rev_thithu", 0, REV_PER_OPTS), REV_PER_OPTS, "câu");
  bindPerSelect($("thithu-per"), "rev_thithu", function () { tt.page = 0; renderAnswers(); });
  $("thithu-to-list").addEventListener("click", function () { refreshSaved(); show("saved"); });
  window.addEventListener("resize", function () { if (tt.open && tt.screen === "result" && tt.result) renderAnswers(); });
  $("thithu-new-exam").addEventListener("click", function () {
    tt.exam = null; tt.attemptId = null; tt.result = null;
    if (tt.job && tt.job.done) resetJob();
    form.initSource();
    show("setup");
  });

  // --- Xem lại 1 câu ---
  $("thithu-v-prev").addEventListener("click", function () { if (tt.vIdx > 0) { tt.vIdx--; show("review"); } });
  $("thithu-v-next").addEventListener("click", function () { if (tt.vIdx < tt.result.questions.length - 1) { tt.vIdx++; show("review"); } });
  $("thithu-v-result").addEventListener("click", function () { show("result"); });
  // Bấm nguồn -> rời màn thi thử, mở đúng Chương / PDF tại trang (UC-20 5a); bấm lại thẻ "Thi thử"
  // là quay về đúng câu đang xem. Không import ghichu.js: đi qua hooks.openSource (ghichu.js gán).
  $("thithu-v-src").addEventListener("click", function () {
    var q = tt.result && tt.result.questions[tt.vIdx];
    if (!q || !q.cite || !(q.cite.chapter_id || q.cite.document_id)) return;
    hooks.openSource({ subject_id: tt.exam && tt.exam.subjectId, chapter_id: q.cite.chapter_id, document_id: q.cite.document_id, page: q.cite.page, quote: q.cite.quote });
  });
}
