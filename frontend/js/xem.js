/* xem.js — trang xem CÔNG KHAI (html/xem.html) Môn / Chương được chia sẻ bằng liên kết "Ai có liên kết".
   Không cần đăng nhập, luôn chỉ xem. Nội dung Chương là HTML do CKEditor của chủ sở hữu sinh ra -> làm sạch
   (bỏ script / style / iframe / thuộc tính on* / liên kết javascript:) trước khi gắn vào trang.
   "Đăng nhập để lưu bản sao": nhớ token ở localStorage td_pending_share — vào ghichu.html sau khi đăng nhập thì
   js/ghichu_chiase.js mở lại liên kết (thêm vào "Được chia sẻ với tôi"). */
(function () {
  var token = new URLSearchParams(location.search).get("share") || "";
  var data = null, current = null;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function api(path) {
    return fetch(API_BASE + "/public/share/" + encodeURIComponent(token) + path, { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    }).catch(function () { return { ok: false, status: 0, data: { detail: "Không kết nối được tới máy chủ." } }; });
  }
  function fail(msg) {
    $("xv-title").textContent = "Không mở được nội dung";
    $("xv-sub").textContent = "";
    $("xv-nav").hidden = true;
    $("xv-main").innerHTML = '<div class="xv-empty">' + esc(msg) + '<br><a href="dangnhap.html">Đăng nhập</a></div>';
  }

  var BAD_TAGS = ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM"];
  function clean(html) {
    var doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
    var root = doc.body.firstChild;
    root.querySelectorAll("*").forEach(function (n) {
      if (BAD_TAGS.indexOf(n.tagName) >= 0) { n.remove(); return; }
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase(), v = String(a.value || "").trim().toLowerCase();
        if (name.indexOf("on") === 0) n.removeAttribute(a.name);
        else if ((name === "href" || name === "src" || name === "xlink:href") && (v.indexOf("javascript:") === 0 || (v.indexOf("data:") === 0 && n.tagName !== "IMG"))) n.removeAttribute(a.name);
      });
      if (n.tagName === "A") { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); }
    });
    return root.innerHTML;
  }

  function renderNav() {
    var nav = $("xv-nav");
    var items = data.chapters.map(function (c) { return { kind: "chapter", id: c.id, name: c.name }; })
      .concat(data.pdfs.map(function (p) { return { kind: "pdf", id: p.id, name: p.name }; }));
    if (data.target_type === "chapter" || items.length < 2) { nav.hidden = true; return items; }
    nav.hidden = false;
    nav.innerHTML = '<div class="xv-nav-h">' + esc(data.subject_name) + "</div>" + items.map(function (x) {
      var on = current && current.kind === x.kind && current.id === x.id;
      return '<button type="button" class="xv-item' + (on ? " on" : "") + '" data-kind="' + x.kind + '" data-id="' + x.id + '">' +
        (x.kind === "pdf" ? "📄 " : "") + esc(x.name) + "</button>";
    }).join("");
    nav.querySelectorAll(".xv-item").forEach(function (b) {
      b.addEventListener("click", function () { show({ kind: b.getAttribute("data-kind"), id: b.getAttribute("data-id"), name: b.textContent }); });
    });
    return items;
  }

  function show(item) {
    current = item;
    renderNav();
    var main = $("xv-main");
    if (item.kind === "pdf") {
      main.innerHTML = '<iframe class="xv-pdf" title="' + esc(item.name) + '" src="' + API_BASE + "/public/share/" + encodeURIComponent(token) + "/pdf/" + item.id + '/file"></iframe>';
      return;
    }
    main.innerHTML = '<div class="xv-empty">Đang tải…</div>';
    api("/chapters/" + item.id).then(function (res) {
      if (!current || current.id !== item.id) return;
      if (!res.ok) { main.innerHTML = '<div class="xv-empty">' + esc(res.data.detail || "Không tải được chương.") + "</div>"; return; }
      main.innerHTML = '<article class="xv-page"><h2 class="xv-h">' + esc(res.data.name) + '</h2><div class="xv-content">' +
        (res.data.content_json ? clean(res.data.content_json) : '<p class="xv-muted">Chương này chưa có nội dung.</p>') + "</div></article>";
    });
  }

  $("xv-login").addEventListener("click", function () {
    try { localStorage.setItem("td_pending_share", token); } catch (e) { /* bỏ qua */ }
  });

  if (!token) { fail("Liên kết không hợp lệ."); return; }
  try { if (localStorage.getItem("access_token")) { location.replace("ghichu.html?share=" + encodeURIComponent(token)); return; } } catch (e) { /* bỏ qua */ }
  api("").then(function (res) {
    if (!res.ok) { fail(res.data.detail || "Liên kết không tồn tại hoặc đã bị tắt."); return; }
    data = res.data;
    document.title = data.name + " — Được chia sẻ";
    $("xv-title").textContent = data.name;
    $("xv-sub").textContent = (data.target_type === "subject" ? "Môn học" : "Chương trong \"" + data.subject_name + "\"") + " · " + data.owner_name + " đã chia sẻ";
    $("xv-badge").hidden = false;
    var items = renderNav();
    if (items.length) show(items[0]);
    else $("xv-main").innerHTML = '<div class="xv-empty">Môn học này chưa có nội dung.</div>';
  });
})();
