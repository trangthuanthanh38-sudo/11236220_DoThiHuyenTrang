/* ======================================================================
   ghichu_cardlist.js — tab "Đã tạo" dạng LƯỚI THẺ dùng chung cho Ôn tập / Thi thử / Flashcard / Sơ đồ tư duy, theo
   khuôn Đã tạo của Tóm tắt (mẫu `tom-tat sửa phần đã tạo.html`; Tóm tắt vẫn tự vẽ trong ghichu_tomtat.js — style của
   2 bên giữ giống nhau: css/ghichu_cardlist.css là bản sao khối "ĐÃ TẠO dạng THẺ" của ghichu_tomtat.css, tiền tố cl-).
   Thanh trên: tìm kiếm, nút lọc (kèm số), chia trang 6 ô (‹ i/n ›), Sắp xếp; lưới 3 cột (2 cột khi hẹp); mỗi thẻ: đầu
   thẻ = tên + menu "···", thân = các dòng + nhãn, chân = chữ trái + nút; bấm cả thẻ = thao tác chính; ô cuối "Tạo …
   mới" (khi không lọc). Xoá có "Hoàn tác" 5 giây: thẻ ẩn ngay, DELETE chỉ gửi khi hết 5 giây / xoá thẻ khác / rời màn
   (commitDelete) / đóng trang (fetch keepalive lúc pagehide) — API xoá là vĩnh viễn. Lịch sử (lần làm / lần ôn / điểm
   chi tiết) mở trong hộp riêng (openHistory), thay cho dòng mở rộng của bảng cũ.

   createCardList(cfg) — cfg:
     pane        phần tử pane của công cụ (chứa toast + hộp lịch sử, phải position:relative)
     bar, box    phần tử thanh trên / lưới thẻ (module tự vẽ nội dung)
     items()     -> mảng | null (đang tải);  error() -> chuỗi lỗi | "";  notice() -> dòng ghi chú khi rỗng (vd. chế độ mẫu)
     id(m), title(m), search(m) -> chuỗi để tìm
     filters     [{key, label, test(m)}] (phần tử đầu = "Tất cả", không test);  sorts {key: {label, cmp(a, b)}}
     card(m)     -> {lines: [{html, cls}], badge: {text, cls} | null, foot: chữ trái, acts: [{act, label}], menu: [{m, label,
                    disabled, del}], busy: chữ đang bận | ""}
     primary(m)  -> act khi bấm cả thẻ;  onAct(act, id) -> Promise | void (act của nút chân thẻ và mục menu)
     newTile     {title, sub};  onNew();  noun ("bộ câu hỏi" …) cho câu "Đã xoá …" / "Không tìm thấy …"
     remove      {api(id) -> đường dẫn DELETE, local(id) (chế độ mẫu, tuỳ chọn), after(id) (sau khi xoá thật)}
     history(m)  -> HTML thân hộp lịch sử (gọi lại render() khi dữ liệu về để vẽ lại hộp)
   ====================================================================== */
import { $, esc, isOnline, authToken, getPerPage, perSelectHtml, bindPerSelect } from "./ghichu_core.js";

var PER_OPTS = [6, 9, 12, 24];   // số ô mỗi trang (người dùng chọn ở thanh trên, nhớ theo từng công cụ — perKey())
var CARD_IC = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="M4 5h12M4 9h12M4 13h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
var SEARCH_IC = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="6.3" stroke="currentColor" stroke-width="1.8"/><path d="m13.3 13.3 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
var CHEV = '<svg width="11" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var PLUS = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 1.5v13M1.5 8h13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

export function createCardList(cfg) {
  var perKey = "cl_" + cfg.noun;
  var PER = getPerPage(perKey, 6, PER_OPTS);
  var st = { q: "", f: cfg.filters[0].key, sort: Object.keys(cfg.sorts)[0], page: 0, menu: null, pending: null, hist: null };

  /* ---------- thanh trên (vẽ 1 lần) ---------- */
  cfg.bar.classList.add("cl-tbar");
  cfg.bar.innerHTML = '<label class="cl-srch">' + SEARCH_IC + '<input placeholder="Tìm ' + esc(cfg.noun) + '…" autocomplete="off" aria-label="Tìm ' + esc(cfg.noun) + '">' +
    '<button type="button" class="clr" hidden aria-label="Xoá tìm kiếm">×</button></label>' +
    /* chỉ còn "Tất cả" thì không vẽ nút lọc */ (cfg.filters.length < 2 ? [] : cfg.filters).map(function (f) { return '<button type="button" class="cl-fpill" data-f="' + f.key + '">' + esc(f.label) + "</button>"; }).join("") +
    '<span class="sp"></span>' + perSelectHtml(PER, PER_OPTS, "ô") + '<div class="cl-pgr" hidden></div>' +
    '<div class="cl-sortb"><button type="button" class="cl-sort-btn" aria-haspopup="listbox"><span>Sắp xếp:</span><b></b>' + CHEV + '</button><div class="cl-menu" hidden></div></div>';
  cfg.box.classList.add("cl-cards");
  var q = function (sel) { return cfg.bar.querySelector(sel); };
  var input = q("input"), clr = q(".clr"), pgr = q(".cl-pgr"), sortBtn = q(".cl-sort-btn"), sortMenu = q(".cl-menu");
  bindPerSelect(cfg.bar, perKey, function (v) { PER = v; st.page = 0; render(); });

  // toast riêng (có nút Hoàn tác) + hộp lịch sử, gắn vào pane
  var toastEl = document.createElement("div");
  toastEl.className = "cl-toast"; toastEl.hidden = true; toastEl.setAttribute("role", "status");
  cfg.pane.appendChild(toastEl);
  var modal = document.createElement("div");
  modal.className = "cl-overlay"; modal.hidden = true;
  modal.innerHTML = '<div class="cl-modal" role="dialog" aria-modal="true"><div class="cl-mhead"><b></b><button type="button" class="cl-mx" aria-label="Đóng">×</button></div><div class="cl-mbody"></div></div>';
  cfg.pane.appendChild(modal);

  function toast(msg, act) {
    toastEl.textContent = msg; toastEl.hidden = false;
    if (act) {
      var b = document.createElement("button");
      b.type = "button"; b.textContent = act.label;
      b.onclick = function () { toastEl.hidden = true; act.fn(); };
      toastEl.appendChild(b);
    }
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, act ? 5000 : 3200);
  }

  function all() {
    var a = cfg.items() || [];
    return st.pending ? a.filter(function (m) { return cfg.id(m) !== st.pending.id; }) : a;
  }
  function visible() {
    var text = st.q.trim().toLowerCase(), f = cfg.filters.find(function (x) { return x.key === st.f; });
    return all().filter(function (m) {
      return (!f.test || f.test(m)) && (!text || cfg.search(m).toLowerCase().indexOf(text) >= 0);
    }).sort(cfg.sorts[st.sort].cmp);
  }
  function find(id) { return (cfg.items() || []).find(function (m) { return cfg.id(m) === id; }); }

  function cardHtml(m) {
    var id = esc(cfg.id(m)), c = cfg.card(m);
    var foot = c.busy ? '<span class="cl-cbusy"><span class="cl-spin"></span>' + esc(c.busy) + "</span>"
      : (c.acts || []).map(function (a) { return '<button type="button" class="cl-link" data-act="' + a.act + '">' + esc(a.label) + "</button>"; }).join("");
    var menu = st.menu === cfg.id(m) && !c.busy
      ? '<div class="cl-cmenu" role="menu">' + c.menu.map(function (x) {
          return '<button type="button" data-m="' + x.m + '"' + (x.del ? ' class="del"' : "") + (x.disabled ? " disabled" : "") + ">" + esc(x.label) + "</button>";
        }).join("") + "</div>"
      : "";
    return '<div class="cl-scard" data-row="' + id + '" role="button" tabindex="0">' +
      '<div class="sh"><span class="ic">' + CARD_IC + '</span><b title="' + esc(cfg.title(m)) + '">' + esc(cfg.title(m)) + "</b>" +
      '<button type="button" class="more" data-more="' + id + '" aria-label="Thao tác khác" aria-haspopup="menu">···</button></div>' +
      '<div class="sb">' + c.lines.map(function (l) { return '<span class="' + (l.cls || "mu") + '">' + l.html + "</span>"; }).join("") +
      (c.badge ? '<span class="cl-badge ' + (c.badge.cls || "") + '">' + esc(c.badge.text) + "</span>" : "") + "</div>" +
      '<div class="sf"><span class="d">' + esc(c.foot || "") + "</span>" + foot + "</div>" + menu + "</div>";
  }

  function render() {
    var list = all();
    Array.prototype.forEach.call(cfg.bar.querySelectorAll(".cl-fpill"), function (b) {
      var f = cfg.filters.find(function (x) { return x.key === b.dataset.f; });
      var n = f.test ? list.filter(f.test).length : 0;
      b.innerHTML = esc(f.label) + (f.test && n ? "<i>" + n + "</i>" : "");
      b.classList.toggle("on", f.key === st.f);
    });
    q(".cl-sort-btn b").textContent = cfg.sorts[st.sort].label;
    clr.hidden = !st.q;
    renderHistory();
    if (cfg.items() === null) { pgr.hidden = true; cfg.box.innerHTML = '<div class="cl-nores"><p>Đang tải…</p></div>'; return; }
    if (cfg.error()) { pgr.hidden = true; cfg.box.innerHTML = '<div class="cl-nores"><p>' + esc(cfg.error()) + "</p></div>"; return; }
    var items = visible(), searching = !!st.q.trim() || st.f !== cfg.filters[0].key;
    var tiles = items.map(function (m) { return { m: m }; });
    if (!searching) tiles.push({ add: true });
    var pages = Math.max(1, Math.ceil(tiles.length / PER));
    st.page = Math.min(st.page, pages - 1);
    pgr.hidden = pages < 2;
    if (pages > 1) pgr.innerHTML = '<button type="button" data-pg="-1" ' + (st.page ? "" : "disabled") + ' aria-label="Trang trước">‹</button>' +
      (st.page + 1) + "/" + pages + '<button type="button" data-pg="1" ' + (st.page < pages - 1 ? "" : "disabled") + ' aria-label="Trang sau">›</button>';
    var note = cfg.notice ? cfg.notice() : "";
    var html = tiles.slice(st.page * PER, st.page * PER + PER).map(function (t) {
      if (t.add) return '<button type="button" class="cl-snew" data-new><span class="pl">' + PLUS + "</span><b>" + esc(cfg.newTile.title) + "</b><span>" + esc(cfg.newTile.sub) + "</span>" +
        (note ? "<span>" + esc(note) + "</span>" : "") + "</button>";
      return cardHtml(t.m);
    }).join("");
    if (!items.length && searching) {
      html = '<div class="cl-nores"><b>Không tìm thấy ' + esc(cfg.noun) + ' phù hợp</b><p>Thử từ khoá hoặc bộ lọc khác.</p>' +
        '<button type="button" class="cl-btn-sm" data-reset>Xem tất cả</button></div>';
    }
    cfg.box.innerHTML = html;
  }

  /* ---------- xoá có Hoàn tác ---------- */
  function remove(id) {
    var m = find(id); if (!m) return;
    commitDelete();
    st.menu = null;
    st.pending = { id: id, timer: setTimeout(commitDelete, 5000) };
    render();
    toast("Đã xoá “" + cfg.title(m) + "”", { label: "Hoàn tác", fn: undo });
  }
  function undo() {
    var d = st.pending; if (!d) return;
    clearTimeout(d.timer); st.pending = null; render();
  }
  function commitDelete(keepalive) {
    var d = st.pending; if (!d) return;
    clearTimeout(d.timer); st.pending = null;
    if (!isOnline()) { if (cfg.remove.local) cfg.remove.local(d.id); return; }
    var path = cfg.remove.api(d.id);
    if (keepalive) {
      try { fetch(API_BASE + path, { method: "DELETE", keepalive: true, headers: { Authorization: "Bearer " + authToken() } }); } catch (e) { /* bỏ qua */ }
      return;
    }
    apiAuth("DELETE", path, authToken()).then(function (res) {
      if (!res.ok && res.status !== 404) toast((res.data && res.data.detail) || "Không xoá được " + cfg.noun + ".");
      if (cfg.remove.after) cfg.remove.after(d.id);
    });
  }

  /* ---------- hộp lịch sử ---------- */
  function openHistory(id) { st.hist = id; renderHistory(); modal.querySelector(".cl-mx").focus(); }
  function closeHistory() { st.hist = null; modal.hidden = true; }
  function renderHistory() {
    var m = st.hist && find(st.hist);
    if (!m) { modal.hidden = true; st.hist = null; return; }
    modal.hidden = false;
    modal.querySelector(".cl-mhead b").textContent = cfg.title(m);
    modal.querySelector(".cl-mbody").innerHTML = cfg.history(m);
  }
  modal.addEventListener("click", function (e) { if (e.target === modal || e.target.closest(".cl-mx")) closeHistory(); });

  /* ---------- sự kiện ---------- */
  function run(act, id, el) {
    if (act === "del") { remove(id); return; }
    if (act === "history") { openHistory(id); return; }
    if (el && el.dataset.busy) return;
    if (el) el.dataset.busy = "1";
    Promise.resolve(cfg.onAct(act, id)).then(function () { if (el) delete el.dataset.busy; });
  }
  cfg.box.addEventListener("click", function (e) {
    if (e.target.closest("[data-new]")) { st.menu = null; cfg.onNew(); return; }
    if (e.target.closest("[data-reset]")) { st.q = ""; input.value = ""; st.f = cfg.filters[0].key; st.page = 0; render(); return; }
    var more = e.target.closest("[data-more]");
    if (more) { e.stopPropagation(); st.menu = st.menu === more.dataset.more ? null : more.dataset.more; render(); return; }
    var card = e.target.closest(".cl-scard[data-row]"); if (!card) return;
    var id = card.dataset.row, mi = e.target.closest("[data-m]");
    if (mi) { e.stopPropagation(); if (mi.disabled) return; st.menu = null; render(); run(mi.dataset.m, id, null); return; }
    if (e.target.closest(".cl-cmenu")) return;
    if (st.menu != null) { st.menu = null; render(); return; }
    var b = e.target.closest("[data-act]");
    var m = find(id); if (!m || cfg.card(m).busy) return;
    run(b ? b.dataset.act : cfg.primary(m), id, card);
  });
  cfg.box.addEventListener("keydown", function (e) {
    var card = e.target.closest(".cl-scard[data-row]");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      var m = find(card.dataset.row); if (m && !cfg.card(m).busy) run(cfg.primary(m), card.dataset.row, card);
    }
  });
  input.addEventListener("input", function () { st.q = input.value; st.page = 0; render(); });
  clr.addEventListener("click", function (e) { e.preventDefault(); st.q = ""; input.value = ""; st.page = 0; render(); input.focus(); });
  cfg.bar.addEventListener("click", function (e) {
    var f = e.target.closest(".cl-fpill"); if (f) { st.f = f.dataset.f; st.page = 0; render(); return; }
    var pg = e.target.closest("[data-pg]"); if (pg) { st.page += +pg.dataset.pg; st.menu = null; render(); return; }
    var k = e.target.closest("[data-k]"); if (k) { st.sort = k.dataset.k; st.page = 0; sortMenu.hidden = true; render(); }
  });
  sortBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    sortMenu.innerHTML = Object.keys(cfg.sorts).map(function (k) {
      return '<button type="button" data-k="' + k + '" class="' + (k === st.sort ? "on" : "") + '">' + esc(cfg.sorts[k].label) + "</button>";
    }).join("");
    sortMenu.hidden = !sortMenu.hidden;
  });
  document.addEventListener("click", function (e) {
    if (!sortMenu.hidden && !e.target.closest(".cl-sortb")) sortMenu.hidden = true;
    if (st.menu != null && cfg.box.offsetParent && !e.target.closest(".cl-cmenu, [data-more]")) { st.menu = null; render(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !cfg.box.offsetParent) return;
    if (!modal.hidden) closeHistory();
    else if (!sortMenu.hidden) sortMenu.hidden = true;
    else if (st.menu != null) { st.menu = null; render(); }
  });
  window.addEventListener("pagehide", function () { commitDelete(true); });

  return {
    render: render,
    // rời màn (× / chuyển công cụ): gửi lệnh xoá đang chờ, đóng menu / hộp lịch sử
    leave: function () { commitDelete(); st.menu = null; closeHistory(); sortMenu.hidden = true; },
    toast: toast,
  };
}

/* ---------- tiện ích cho nội dung thẻ / hộp lịch sử ---------- */
// 1 dòng lịch sử: nhãn trái, thanh %, số chính, phụ
export function histRow(label, pct, main, sub, right) {
  return '<div class="cl-hrow"><span class="hl">' + esc(label) + '</span><span class="cl-hb"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></span>' +
    '<span class="hm">' + esc(main) + '</span><span class="hs">' + esc(sub || "") + '</span><span class="hr">' + esc(right || "") + "</span></div>";
}
export function histEmpty(text) { return '<div class="cl-hempty">' + esc(text) + "</div>"; }
