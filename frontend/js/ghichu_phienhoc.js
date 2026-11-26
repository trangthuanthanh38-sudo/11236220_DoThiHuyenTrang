/* ======================================================================
   ghichu_phienhoc.js — GHI PHIÊN HỌC (thời gian học thật cho Thống kê UC-29). Không có giao diện.
   Backend: POST /stats/sessions {activity, chapter_id?, document_id?, subject_id?} -> {id}
            PATCH /stats/sessions/{id} {active_seconds, end?}  (routers/stats.py, bảng study_sessions)

   - ghichu.js gọi sync(mô tả màn đang mở) mỗi lần đổi màn / đổi Chương-PDF (syncMainPane + renderAll); mô tả
     khác lần trước -> đóng phiên cũ, mở phiên mới. null = không tính là đang học (Lịch biểu, Thống kê…).
   - Mỗi BEAT_MS cộng thời gian chỉ khi tab đang hiện VÀ có thao tác (chuột/phím/cuộn) trong IDLE_MS gần nhất —
     treo tab không được tính. Máy chủ còn chặn mỗi nhịp tối đa 2 phút theo giờ thật.
   - Ẩn tab -> gửi ngay phần đã tích; đóng tab -> PATCH end bằng fetch keepalive (cần header Authorization nên
     không dùng được sendBeacon).
   - Chế độ mẫu (chưa đăng nhập): không gửi gì.
   ====================================================================== */
import { isOnline, authToken } from "./ghichu_core.js";

var BEAT_MS = 30000;
var IDLE_MS = 120000;

var cur = null;          // {key, id|null, pending: Promise, acc: giây chưa gửi, since: mốc tính}
var lastInput = Date.now();
var visible = document.visibilityState === "visible";

function keyOf(d) { return d ? [d.activity, d.chapter_id || "", d.document_id || "", d.subject_id || ""].join("|") : ""; }

// Cộng thời gian từ mốc `since` tới giờ vào acc: chỉ khi tab ĐANG hiện (trạng thái trước sự kiện ẩn tab), và chỉ tới
// lúc lastInput + IDLE_MS (ngồi im quá 2 phút thì phần sau không tính).
function accrue() {
  if (!cur) return;
  var now = Date.now();
  if (visible) cur.acc += Math.max(0, Math.round((Math.min(now, lastInput + IDLE_MS) - cur.since) / 1000));
  cur.since = now;
}

function send(s, end, keepalive) {
  var secs = Math.min(600, s.acc);
  s.acc = 0;
  if (!secs && !end) return;
  var body = { active_seconds: secs, end: !!end };
  var go = function () {
    if (!s.id) return;
    if (keepalive) {
      try {
        fetch(API_BASE + "/stats/sessions/" + encodeURIComponent(s.id), {
          method: "PATCH", keepalive: true,
          headers: { Authorization: "Bearer " + authToken(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {}
      return;
    }
    apiAuth("PATCH", "/stats/sessions/" + encodeURIComponent(s.id), authToken(), body);
  };
  if (s.id || keepalive) go(); else s.pending.then(go);
}

function stop(keepalive) {
  if (!cur) return;
  accrue();
  send(cur, true, keepalive);
  cur = null;
}

export function sync(desc) {
  if (!isOnline()) desc = null;
  var k = keyOf(desc);
  if (cur && cur.key === k) return;
  stop(false);
  if (!desc) return;
  var s = { key: k, id: null, acc: 0, since: Date.now(), pending: null };
  s.pending = apiAuth("POST", "/stats/sessions", authToken(), desc).then(function (res) {
    if (res.ok && res.data && res.data.id) s.id = res.data.id;
  });
  cur = s;
}

export function initPhienhoc() {
  ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "touchstart"].forEach(function (t) {
    document.addEventListener(t, function () { lastInput = Date.now(); }, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", function () {
    var nowVisible = document.visibilityState === "visible";
    if (cur && !nowVisible) { accrue(); send(cur, false, true); }
    visible = nowVisible;
    if (cur && nowVisible) { cur.since = Date.now(); lastInput = Date.now(); }
  });
  window.addEventListener("pagehide", function () { stop(true); });
  setInterval(function () { if (cur) { accrue(); send(cur, false, false); } }, BEAT_MS);
}
