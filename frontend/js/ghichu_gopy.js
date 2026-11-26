/* UC-35 — Luồng người học gửi góp ý (phía quản trị xử lý ở Admin Console, trang Góp ý).
   - reportContent(ctx): nút "Báo nội dung sai" ở Flashcard / Ôn tập / Thi thử / Sơ đồ tư duy / Tóm tắt — ctx =
     {context:[chip...], quote_heading, quote_text, ref_type, ref_id}; hệ thống tự gắn ngữ cảnh + trích đoạn, người học
     chỉ cần viết mô tả.
   - openGeneral(): nút Feedback ở thẻ Help của ribbon — Lỗi ứng dụng / Đề xuất, kèm 1 ảnh (tuỳ chọn; giới hạn kích
     thước + tính vào dung lượng theo hạn mức UC-33).
   POST /feedback (multipart). Hết lượt góp ý trong ngày (BR-19) → máy chủ trả 429, hiện đúng thông báo.
   Chế độ mẫu (chưa đăng nhập): báo cần đăng nhập. Dùng hộp thoại + toast của ghichu_hanmuc.js (cùng giao diện). */
import { esc, isOnline, authToken } from "./ghichu_core.js";
import { modal, closeModal, toast } from "./ghichu_hanmuc.js";

function needLogin() {
  modal('<h2>Cần đăng nhập</h2><p class="hm-msub">Đăng nhập để gửi góp ý tới quản trị viên — phản hồi sẽ về chuông thông báo của bạn.</p>'
    + '<div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Đóng</button></div>', function (m) { m.querySelector("#hm-mc").onclick = closeModal; });
}

async function send(form, errEl, okBtn) {
  okBtn.disabled = true;
  var res = await apiUpload("/feedback", authToken(), form);
  okBtn.disabled = false;
  if (!res.ok) { errEl.hidden = false; errEl.textContent = (res.data && res.data.detail) || "Chưa gửi được góp ý."; return false; }
  closeModal();
  toast("Đã gửi góp ý #GY-" + res.data.id + " · phản hồi sẽ về chuông thông báo");
  return true;
}

export function reportContent(ctx) {
  if (!isOnline()) { needLogin(); return; }
  ctx = ctx || {};
  var chips = (ctx.context || []).filter(Boolean);
  modal("<h2>Báo nội dung sai</h2><p class=\"hm-msub\">Quản trị viên sẽ kiểm tra đúng đoạn này và phản hồi qua chuông thông báo.</p>"
    + (chips.length ? '<div class="hm-chips">' + chips.map(function (c) { return "<span>" + esc(c) + "</span>"; }).join("") + "</div>" : "")
    + (ctx.quote_text ? '<div class="hm-quote">' + (ctx.quote_heading ? "<b>" + esc(ctx.quote_heading) + "</b><br>" : "") + esc(ctx.quote_text) + "</div>" : "")
    + '<textarea id="gy-body" maxlength="2000" placeholder="Nội dung nào sai, đúng ra phải là gì? (vd. theo bài giảng, đó là việc của tầng Trình diễn)"></textarea>'
    + '<div class="hm-err" id="gy-err" hidden></div>'
    + '<div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Huỷ</button><button type="button" class="hm-btn sm pri" id="gy-ok">Gửi góp ý</button></div>',
    function (m) {
      var body = m.querySelector("#gy-body"), err = m.querySelector("#gy-err"), ok = m.querySelector("#gy-ok");
      setTimeout(function () { body.focus(); }, 30);
      m.querySelector("#hm-mc").onclick = closeModal;
      ok.onclick = function () {
        if (!body.value.trim()) { err.hidden = false; err.textContent = "Hãy mô tả nội dung sai trước khi gửi."; body.focus(); return; }
        var f = new FormData();
        f.append("category", "ai");
        f.append("body", body.value.trim());
        if (ctx.title) f.append("title", ctx.title.slice(0, 150));
        f.append("context", JSON.stringify(chips));
        if (ctx.quote_heading) f.append("quote_heading", ctx.quote_heading.slice(0, 255));
        if (ctx.quote_text) f.append("quote_text", ctx.quote_text.slice(0, 2000));
        if (ctx.ref_type && ctx.ref_id) { f.append("ref_type", ctx.ref_type); f.append("ref_id", String(ctx.ref_id).slice(0, 36)); }
        send(f, err, ok);
      };
    });
}

export function openGeneral() {
  if (!isOnline()) { needLogin(); return; }
  var cat = "bug";
  modal("<h2>Gửi góp ý</h2>"
    + '<div class="hm-seg" id="gy-cat"><button type="button" class="on" data-c="bug">Lỗi ứng dụng</button><button type="button" data-c="idea">Đề xuất</button></div>'
    + '<input type="text" id="gy-title" maxlength="150" placeholder="Tiêu đề ngắn (vd. Không tải được PDF trên 15 MB)">'
    + '<textarea id="gy-body" maxlength="2000" placeholder="Mô tả chi tiết: bạn đang làm gì, điều gì xảy ra, bạn mong muốn điều gì…"></textarea>'
    + '<label style="font-size:12.5px;color:var(--muted)">Ảnh đính kèm (tuỳ chọn) <input type="file" id="gy-img" accept="image/png,image/jpeg,image/webp,image/gif"></label>'
    + '<div class="hm-err" id="gy-err" hidden></div>'
    + '<div class="hm-mf"><button type="button" class="hm-btn sm" id="hm-mc">Huỷ</button><button type="button" class="hm-btn sm pri" id="gy-ok">Gửi góp ý</button></div>',
    function (m) {
      var body = m.querySelector("#gy-body"), title = m.querySelector("#gy-title"), err = m.querySelector("#gy-err"), ok = m.querySelector("#gy-ok");
      m.querySelector("#gy-cat").onclick = function (e) {
        var b = e.target.closest("[data-c]"); if (!b) return; cat = b.dataset.c;
        m.querySelectorAll("#gy-cat button").forEach(function (x) { x.classList.toggle("on", x === b); });
      };
      m.querySelector("#hm-mc").onclick = closeModal;
      ok.onclick = function () {
        if (!body.value.trim()) { err.hidden = false; err.textContent = "Nhập nội dung góp ý trước khi gửi."; body.focus(); return; }
        var f = new FormData();
        f.append("category", cat);
        f.append("title", title.value.trim());
        f.append("body", body.value.trim());
        var img = m.querySelector("#gy-img").files[0];
        if (img) f.append("image", img);
        send(f, err, ok);
      };
    });
}
