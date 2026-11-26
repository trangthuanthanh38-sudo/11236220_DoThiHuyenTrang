/* ======================================================================
   ghichu.js — điều phối 4 module (ghichu_core.js dùng chung, và 3 module
   chức năng: ghichu_soanthao.js / ghichu_giaodien.js / ghichu_chucnangcacthe.js).
   File này CHỈ còn:
     - Import + khởi động 3 module (init())
     - Các hàm "điều phối" thật sự cần nhìn thấy CẢ 3 module cùng lúc:
       renderRibbon() (chọn đúng nội dung ribbon theo state.tab, tuỳ module
       sở hữu), renderAll()/renderTabs()/renderBreadcrumb()/renderStatusPill()
       (vẽ lại toàn trang), closeFloating() (đóng dropdown/menu/popover +
       vẽ lại ribbon/popover tài khoản), updateWorkspaceCols() (bố cục 3 cột +
       ẩn Topbar khi ở chế độ Studio AI), syncMainPane() (cột giữa: Notebook /
       Hỏi đáp tri thức / Tạo câu hỏi ôn tập — module ghichu_ontap.js)
     - Phím tắt toàn cục (Esc) và các nút chrome chung (Chia sẻ, Studio AI)

   3 module con gọi NGƯỢC lên các hàm điều phối ở đây (renderAll/renderRibbon/
   renderStatusPill/closeFloating) qua `hooks` của ghichu_core.js — xem
   comment đầu file đó để hiểu vì sao (tránh vòng lặp import).
   ====================================================================== */
import {
  hooks, state, $, el, esc, persist, hasActiveChapter, activeItemName, findSubject,
  openDropdown, closeDropdownEl, isOnline, authToken, genLocalId,
} from "./ghichu_core.js";
import * as Soanthao from "./ghichu_soanthao.js";
import * as Chucnang from "./ghichu_chucnangcacthe.js";
import * as Review from "./ghichu_review.js";
import * as Giaodien from "./ghichu_giaodien.js";
import * as Dinhkem from "./ghichu_chat_dinhkem.js";
import * as Ontap from "./ghichu_ontap.js";
import * as Thithu from "./ghichu_thithu.js";
import * as Flashcard from "./ghichu_flashcard.js";
import * as Mindmap from "./ghichu_mindmap.js";
import * as Tomtat from "./ghichu_tomtat.js";
import * as Lichbieu from "./ghichu_lichbieu.js";
import * as Phienhoc from "./ghichu_phienhoc.js";
import * as Thongke from "./ghichu_thongke.js";
import * as Thongbao from "./ghichu_thongbao.js";
import * as Chiase from "./ghichu_chiase.js";
import * as Hanmuc from "./ghichu_hanmuc.js";
import * as Gopy from "./ghichu_gopy.js";

/* ====================================================================
   Nạp mảnh HTML tĩnh của 3 module (modal Vẽ phác thảo/Hướng dẫn, modal Hồ
   sơ/Cài đặt, khung PDF viewer — xem 3 file html/ghichu_*.frag) bằng
   fetch() + thay thế các mount point rỗng trong ghichu.html, TRƯỚC khi
   init() chạy (init() truy vấn các phần tử này bằng getElementById nên
   phải tồn tại sẵn trong DOM lúc đó — top-level await bên dưới đảm bảo
   thứ tự này, xem lời gọi init() ở cuối file).

   Vì sao đuôi ".frag" chứ không phải ".html": nhiều server dev tĩnh hay dùng
   khi mở nhanh trang này (vd. tiện ích "Live Server" của VSCode, live-server/
   browser-sync trên npm...) tự chèn thêm 1 đoạn <script> tự động tải lại
   trang vào MỌI phản hồi có Content-Type "text/html" — vô hại khi trình
   duyệt điều hướng thẳng tới ghichu.html (chỉ là JS thừa chạy ngầm ở cuối
   trang), nhưng phá cấu trúc khi bị fetch() về rồi gán qua outerHTML ở đây
   (chèn giữa nội dung, có lúc còn làm sai lệch luôn Content-Length khiến
   phản hồi bị máy chủ cắt cụt thật sự — mất dữ liệu ở tầng mạng, không có
   cách nào phục hồi lại bằng JS phía sau). Đặt đuôi file khác ".html"/".htm"
   khiến các server đó (và server tĩnh chuẩn như `py -m http.server`) trả về
   Content-Type khác text/html (thường là application/octet-stream) nên
   không bị các middleware này động vào nữa — đã kiểm chứng trực tiếp trên
   Live Server: cùng nội dung, đổi đuôi là hết bị chèn/cắt. fetch() không
   quan tâm đuôi file hay Content-Type, ta luôn đọc bằng res.text() nên nội
   dung HTML bên trong hoạt động y hệt trước.
   ==================================================================== */
// Vẫn giữ hàm cắt phần chèn (nếu server nào đó lỡ chèn dù đã đổi đuôi) làm lưới an toàn thứ
// 2 — không phải cơ chế chính, xem giải thích ".frag" ở trên.
function stripDevServerInjection(html) {
  var marker;
  while ((marker = html.indexOf("<!-- Code injected by")) >= 0) {
    var afterScriptClose = html.indexOf("</script>", marker);
    var end = afterScriptClose >= 0 ? afterScriptClose + "</script>".length : html.length;
    html = html.slice(0, marker) + html.slice(end);
  }
  return html;
}

function showFragmentLoadError(details) {
  var box = document.createElement("div");
  box.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(5,13,43,.55);padding:20px;font-family:system-ui,sans-serif";
  box.innerHTML = '<div style="max-width:520px;background:#fff;border-radius:12px;padding:20px 22px;box-shadow:0 24px 60px rgba(9,22,60,.3)">'
    + '<div style="font-size:15px;font-weight:700;color:#050d2b;margin-bottom:8px">Không tải được một phần giao diện</div>'
    + '<div style="font-size:13px;line-height:1.6;color:#5a6479;margin-bottom:10px">' + details + '</div>'
    + '<div style="font-size:12.5px;line-height:1.6;color:#8b93a5">Kiểm tra: các file <code>html/ghichu_*.frag</code> có đang được server tĩnh phục vụ đúng đường dẫn không (mở thẳng URL đó trên trình duyệt để xem có trả về 404 không), rồi tải lại trang.</div>'
    + '</div>';
  document.body.appendChild(box);
}

async function loadFragment(mountId, url) {
  var mount = document.getElementById(mountId);
  if (!mount) return { ok: false, url: url, reason: "mount point #" + mountId + " không tồn tại trong ghichu.html" };
  try {
    var res = await fetch(url);
    if (!res.ok) return { ok: false, url: url, reason: "HTTP " + res.status };
    mount.outerHTML = stripDevServerInjection(await res.text());
    return { ok: true, url: url };
  } catch (e) {
    return { ok: false, url: url, reason: String(e) };
  }
}
var fragmentResults = await Promise.all([
  loadFragment("mount-soanthao-pdfhost", "ghichu_soanthao.frag"),
  loadFragment("mount-chucnangcacthe-modals", "ghichu_chucnangcacthe.frag"),
  loadFragment("mount-giaodien-modals", "ghichu_giaodien.frag"),
  loadFragment("mount-ontap-pane", "ghichu_ontap.frag"),
  loadFragment("mount-thithu-pane", "ghichu_thithu.frag"),
  loadFragment("mount-flashcard-pane", "ghichu_flashcard.frag"),
  loadFragment("mount-mindmap-pane", "ghichu_mindmap.frag"),
  loadFragment("mount-tomtat-pane", "ghichu_tomtat.frag"),
  loadFragment("mount-lichbieu-pane", "ghichu_lichbieu.frag"),
  loadFragment("mount-thongke-pane", "ghichu_thongke.frag"),
  loadFragment("mount-hanmuc-pane", "ghichu_hanmuc.frag"),
]);
var fragmentFailures = fragmentResults.filter(function (r) { return !r.ok; });
if (fragmentFailures.length) {
  fragmentFailures.forEach(function (f) { console.error("Không tải được mảnh giao diện:", f.url, "-", f.reason); });
  showFragmentLoadError(
    "Không tải được: " + fragmentFailures.map(function (f) { return f.url; }).join(", ") +
    ". Trang sẽ không hoạt động đầy đủ cho tới khi khắc phục được lỗi tải này."
  );
}

/* ====================================================================
   Render: tab strip + ribbon — điều phối theo state.tab, mỗi thẻ do đúng 1
   module dựng nội dung (xem bảng đối chiếu module/chức năng cuối README).
   ==================================================================== */
var TABS = ["File", "Home", "Insert", "Draw", "History", "Review", "View", "Help"];

function renderTabs() {
  var wrap = $("tabs");
  wrap.innerHTML = "";
  TABS.forEach(function (t) {
    var b = el("button", "tab-btn" + (t === state.tab ? " active" : ""), t);
    b.type = "button";
    b.addEventListener("click", function () { setTab(t); });
    wrap.appendChild(b);
  });
}

function setTab(t) {
  if (state.tab === t) return;
  if (state.tab === "Draw") Chucnang.leaveDrawTab();   // rời thẻ Draw: bỏ bút đang cầm, về soạn chữ bình thường
  state.tab = t; state.dd = null;
  renderRibbon(); renderTabs();
}

function renderRibbon() {
  var wrap = $("ribbon");
  wrap.innerHTML = "";
  if (state.tab === "Home") { Chucnang.buildHomeTab(wrap); return; }
  if (state.tab === "File") { Chucnang.buildFileTab(wrap); return; }
  if (state.tab === "Insert") { Chucnang.buildInsertTab(wrap); return; }
  if (state.tab === "Draw") {
    Chucnang.buildDrawTab(wrap);   // Chương lẫn File PDF (ghichu_ve.js)
    return;
  }
  if (state.tab === "History") { Chucnang.buildHistoryTab(wrap); return; }
  if (state.tab === "Review") { Chucnang.buildReviewTab(wrap, Soanthao.toggleSpellcheck, Soanthao.toggleNoteLock); return; }
  if (state.tab === "View") { Chucnang.buildViewTab(wrap); return; }
  if (state.tab === "Help") { Chucnang.buildHelpTab(wrap); return; }
  wrap.appendChild(el("div", "ribbon-empty", ""));
}

/* ====================================================================
   Breadcrumb / trạng thái lưu — hiển thị chung cho cả Chương lẫn File PDF,
   không thuộc riêng module nào (đọc state.active chung).
   ==================================================================== */
function renderBreadcrumb() {
  var sub = state.active ? findSubject(state.active.s) : null;
  var itemName = activeItemName();
  $("crumb-subject").textContent = sub ? sub.name : "Chưa chọn môn";
  var cc = $("crumb-chapter");
  cc.textContent = state.active ? itemName : "Chưa chọn chương";
  cc.classList.toggle("on", !!state.active);
  $("print-subject").textContent = sub ? sub.name : "";
  $("print-chapter").textContent = hasActiveChapter() ? itemName : "";
  $("btn-find-toggle").disabled = !hasActiveChapter();
}

function renderStatusPill() {
  var pill = $("status-pill");
  pill.className = "status-pill";
  if (!state.active) { pill.textContent = ""; return; }
  if (state.saveStatus === "editing") { pill.textContent = "Editing…"; pill.classList.add("editing"); return; }
  if (state.saveStatus === "saving") { pill.textContent = "Saving…"; pill.classList.add("saving"); return; }
  if (state.saveStatus === "conflict") { pill.textContent = "Not saved — conflict"; pill.classList.add("editing"); return; }
  if (state.saveStatus === "saved") {
    var t = state.savedAt ? state.savedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    pill.textContent = "Saved" + (t ? " at " + t : "");
    return;
  }
  pill.textContent = "";
}

/* ====================================================================
   Đóng dropdown/context-menu/popover tài khoản đang mở + vẽ lại ribbon —
   dùng CHUNG bởi cả 3 module (mỗi lần chọn xong 1 mục trong dropdown, đóng
   menu ngữ cảnh, hay bấm ra ngoài popover tài khoản).
   ==================================================================== */
function closeFloating() {
  state.dd = null; state.menu = null;
  $("dd-panel").hidden = true; $("dd-panel").innerHTML = "";
  $("ctx-menu").hidden = true;
  if (state.accountMenuOpen) { state.accountMenuOpen = false; Giaodien.renderAccountMenu(); }
  renderRibbon();
}

/* ====================================================================
   Render tổng + bố cục 3 cột
   ==================================================================== */
function renderAll() {
  renderTabs();
  renderRibbon();
  Soanthao.renderTree();
  renderBreadcrumb();
  renderStatusPill();
  updateWorkspaceCols();
  Chiase.onRender();   // thanh chia sẻ dưới breadcrumb + đồng bộ khi đổi mục đang mở
}

/* Chế độ Studio AI = đang ở 1 màn hình AI thay cho cột soạn thảo (Hỏi đáp tri thức, Tạo câu hỏi
   ôn tập hoặc Tạo đề thi thử). Chỉ MỞ cột Studio bên phải trong lúc vẫn soạn thảo thì KHÔNG tính —
   người dùng vẫn đang ở chế độ soạn thảo nên Topbar vẫn cần. */
function isStudioMode() { return chat.open || isFullPaneTool(); }
// Công cụ Studio chiếm trọn màn hình: chỉ còn cột giữa (ẩn cột Notebooks + cột Studio).
function isFullPaneTool() { return Ontap.isOpen() || Thithu.isOpen() || Flashcard.isOpen() || Mindmap.isOpen() || Tomtat.isOpen() || Lichbieu.isOpen() || Thongke.isOpen() || Hanmuc.isOpen(); }

/* Responsive (css/responsive.css): cây Notebook là CỘT khi cửa sổ ≥ TREE_COL_MIN, hẹp hơn thì thành NGĂN KÉO
   trượt từ trái (mở bằng nút ☰ #btn-tree); cột Studio là CỘT khi ≥ STUDIO_COL_MIN, hẹp hơn thì thành ngăn kéo
   trượt từ phải (nút "Studio"). Desktop giữ nguyên bố cục cột như cũ. Ngăn kéo tự đóng khi người dùng đã chọn
   xong (đổi Chương / PDF, mở công cụ Studio, đổi cuộc hội thoại) — so khoá màn hình trước / sau. */
var TREE_COL_MIN = 880, STUDIO_COL_MIN = 1024;
var lastPaneKey = null;
function paneKey() {
  var a = state.active;
  return [a && a.kind, a && a.id, isFullPaneTool(), chat.open, chat.activeId].join("|");
}
function closeDrawers() {
  var changed = state.treeDrawer || (state.studioOpen && window.innerWidth < STUDIO_COL_MIN);
  state.treeDrawer = false;
  if (window.innerWidth < STUDIO_COL_MIN && state.studioOpen) {
    state.studioOpen = false;
    $("btn-studio").classList.remove("is-open");
  }
  if (changed) updateWorkspaceCols();
}

function updateWorkspaceCols() {
  var w = window.innerWidth;
  var fullPane = isFullPaneTool(); // Ôn tập (UC-21) / Thi thử (UC-22): chỉ còn cột giữa
  var treeIsCol = w >= TREE_COL_MIN, studioIsCol = w >= STUDIO_COL_MIN;
  // Màn chính vừa đổi (chọn Chương ở cây, mở công cụ ở Studio…) -> đóng ngăn kéo đang mở trên màn hẹp.
  var key = paneKey();
  if (lastPaneKey !== null && key !== lastPaneKey) {
    if (!treeIsCol) state.treeDrawer = false;
    if (!studioIsCol && state.studioOpen) { state.studioOpen = false; $("btn-studio").classList.remove("is-open"); }
  }
  lastPaneKey = key;
  // Hỏi đáp tri thức chỉ còn 2 cột (khung chat + cột Studio) — người dùng chốt; chọn Chương/tệp qua nút "+" của ô nhập.
  var canTree = !fullPane && !chat.open;
  var showTree = canTree && (treeIsCol ? !Chucnang.sidebarHidden() : !!state.treeDrawer);
  var showStudio = !fullPane && state.studioOpen;
  var treeDrawer = showTree && !treeIsCol, studioDrawer = showStudio && !studioIsCol;
  if (treeDrawer && studioDrawer) { state.treeDrawer = false; treeDrawer = showTree = false; } // chỉ 1 ngăn kéo / lúc
  $("topbar").hidden = isStudioMode();
  $("sidebar").hidden = !showTree;
  $("studio").hidden = !showStudio;
  $("sidebar").classList.toggle("is-drawer", treeDrawer);
  $("studio").classList.toggle("is-drawer", studioDrawer);
  $("drawer-backdrop").hidden = !(treeDrawer || studioDrawer);
  $("btn-tree").classList.toggle("is-open", treeDrawer);
  $("btn-tree").setAttribute("aria-expanded", treeDrawer ? "true" : "false");
  var colTree = showTree && !treeDrawer, colStudio = showStudio && !studioDrawer;
  Soanthao.setPdfStudioFit(colStudio); // PDF thu về 60% khi cột 3 mở, 100% khi đóng (ngăn kéo nằm đè, không chiếm chỗ)
  $("chat-reopen-studio-btn").hidden = !(chat.open && !state.studioOpen);
  var side = "clamp(196px,20%,272px)", studioCol = "clamp(236px,24%,316px)";
  var cols = colTree && colStudio ? side + " minmax(380px,1fr) " + studioCol
    : colTree ? side + " minmax(0,1fr)"
    : colStudio ? "minmax(0,1fr) " + studioCol
    : "minmax(0,1fr)";
  $("workspace").style.gridTemplateColumns = cols;
  $("workspace").classList.toggle("workspace--full", fullPane); // công cụ Studio: kín màn, không viền nền xanh
  Phienhoc.sync(studyDesc());   // UC-29: ghi phiên học theo màn đang mở (updateWorkspaceCols chạy mỗi lần đổi màn / Chương)
  Hanmuc.refreshSoon();         // UC-33: cập nhật thanh Dung lượng + số lượt AI trên thẻ Studio sau mỗi lần đổi màn
}

// Màn đang mở có tính là "đang học" không (ghichu_phienhoc.js). Lịch biểu không tính.
function studyDesc() {
  if (Ontap.isOpen()) return { activity: "practice" };
  if (Thithu.isOpen()) return { activity: "exam" };
  if (Flashcard.isOpen()) return { activity: "flashcard" };
  if (Mindmap.isOpen()) return { activity: "mindmap" };
  if (Tomtat.isOpen()) return { activity: "summary" };
  if (Lichbieu.isOpen() || Thongke.isOpen() || Hanmuc.isOpen()) return null;
  if (chat.open) return { activity: "chat" };
  var a = state.active;
  if (!a || !a.id || a.shared) return null;   // đọc nội dung người khác chia sẻ không tính vào phiên học của Môn mình
  return a.kind === "pdf" ? { activity: "pdf", document_id: a.id } : { activity: "chapter", chapter_id: a.id };
}

/* Nội dung cột giữa: Notebook (soạn thảo) / khung Hỏi đáp tri thức / Tạo câu hỏi ôn tập / Tạo đề
   thi thử — đúng 1 trong 4, loại trừ nhau. Nguồn sự thật duy nhất cho việc bật/tắt các khối này +
   Topbar/cột 1/cột 3 (qua updateWorkspaceCols) — renderChatDock() và các module ghichu_ontap.js /
   ghichu_thithu.js (qua hooks.syncLayout) đều gọi vào đây thay vì tự bật/tắt. */
function syncMainPane() {
  // Dọn dung lượng (UC-33) nhường chỗ khi người học mở công cụ / chat khác (vẫn nhớ tệp đang chờ tải).
  if (Hanmuc.isOpen() && (chat.open || Ontap.isOpen() || Thithu.isOpen() || Flashcard.isOpen() || Mindmap.isOpen() || Tomtat.isOpen() || Lichbieu.isOpen() || Thongke.isOpen())) {
    Hanmuc.closeClean(true);
    return;   // closeClean gọi lại syncMainPane
  }
  var hanmucOpen = Hanmuc.isOpen();
  var ontapOpen = Ontap.isOpen(), thithuOpen = Thithu.isOpen(), flashcardOpen = Flashcard.isOpen(), mindmapOpen = Mindmap.isOpen();
  var tomtatOpen = Tomtat.isOpen(), lichbieuOpen = Lichbieu.isOpen(), thongkeOpen = Thongke.isOpen();
  var notebook = !chat.open && !ontapOpen && !thithuOpen && !flashcardOpen && !mindmapOpen && !tomtatOpen && !lichbieuOpen && !thongkeOpen && !hanmucOpen;
  $("editor-head").hidden = !notebook;
  $("editor-scroll").hidden = !notebook;
  if (!notebook) $("share-bar").hidden = true;
  $("chat-pane").hidden = !chat.open || ontapOpen || thithuOpen || flashcardOpen || mindmapOpen || tomtatOpen || lichbieuOpen || thongkeOpen;
  if ($("ontap-pane")) $("ontap-pane").hidden = !ontapOpen; // null nếu ghichu_ontap.frag tải lỗi
  if ($("thithu-pane")) $("thithu-pane").hidden = !thithuOpen || ontapOpen; // null nếu ghichu_thithu.frag tải lỗi
  if ($("fc-pane")) $("fc-pane").hidden = !flashcardOpen || ontapOpen || thithuOpen; // null nếu ghichu_flashcard.frag tải lỗi
  if ($("mm-pane")) $("mm-pane").hidden = !mindmapOpen || ontapOpen || thithuOpen || flashcardOpen; // null nếu ghichu_mindmap.frag tải lỗi
  if ($("ts-pane")) $("ts-pane").hidden = !tomtatOpen || ontapOpen || thithuOpen || flashcardOpen || mindmapOpen; // null nếu ghichu_tomtat.frag tải lỗi
  if ($("lb-pane")) $("lb-pane").hidden = !lichbieuOpen || ontapOpen || thithuOpen || flashcardOpen || mindmapOpen || tomtatOpen; // null nếu ghichu_lichbieu.frag tải lỗi
  if ($("tk-pane")) $("tk-pane").hidden = !thongkeOpen || ontapOpen || thithuOpen || flashcardOpen || mindmapOpen || tomtatOpen || lichbieuOpen; // null nếu ghichu_thongke.frag tải lỗi
  if ($("hm-pane")) $("hm-pane").hidden = !hanmucOpen; // null nếu ghichu_hanmuc.frag tải lỗi
  if (hanmucOpen) $("chat-pane").hidden = true;
  updateWorkspaceCols();
}

// Gán các hàm điều phối thật vào `hooks` của core NGAY sau khi định nghĩa xong (function
// declaration đã hoist nên thứ tự viết ở trên/dưới không quan trọng) — để 3 module con gọi
// ngược lên đây mà không cần import thẳng file này (tránh vòng lặp import, xem
// ghichu_core.js).
hooks.renderAll = renderAll;
hooks.renderRibbon = renderRibbon;
hooks.setTab = setTab;
hooks.renderStatusPill = renderStatusPill;
hooks.closeFloating = closeFloating;
hooks.renderChatDock = renderChatDock;
hooks.syncLayout = syncMainPane;
hooks.openSource = openSource;
hooks.askAbout = askAbout;
hooks.openProfile = Giaodien.openProfileModal;
hooks.onProfileSaved = Lichbieu.onProfileSaved;
hooks.openLichbieu = openLichbieuTool;
hooks.openNotiTarget = openNotiTarget;
hooks.openTool = function (name) { var c = $("studio-card-" + name); if (c) c.click(); };
hooks.openSubject = openSubjectInNotebook;
hooks.currentUser = Giaodien.currentUser;
hooks.showNotebook = function () { closeToolsExcept(null); };   // chia sẻ: mở mục được chia sẻ từ bất kỳ màn nào
hooks.openHanmuc = function () { closeToolsExcept("hanmuc"); };   // mở Dọn dung lượng: đóng mọi công cụ khác trước
hooks.onFilesDeleted = removeDeletedPdfs;
hooks.precheckUpload = Hanmuc.precheckUpload;
hooks.handleUploadError = Hanmuc.handleUploadError;
hooks.afterUpload = Hanmuc.afterUpload;
hooks.aiLimitText = Hanmuc.aiLimitText;
hooks.reportContent = Gopy.reportContent;   // UC-35 "Báo nội dung sai"
hooks.openFeedback = Gopy.openGeneral;     // UC-35 Góp ý (Help ▸ Feedback trên ribbon)

// Từ trang Notebook của Thống kê: về Notebook đúng Môn rồi thêm Chương / tải PDF, hoặc bắt đầu tạo Môn mới.
function openSubjectInNotebook(subjectId, action) {
  if (Thongke.isOpen()) Thongke.closeThongke();
  if (action === "newSubject") { state.typingSubject = true; state.subjectDraft = ""; renderAll(); return; }
  if (!subjectId || !state.subjects.some(function (s) { return s.id === subjectId; })) { renderAll(); return; }
  state.open[subjectId] = true;
  if (action === "chapter") { state.typingChapterIn = subjectId; state.chapterDraft = ""; }
  renderAll();
  if (action === "pdf") Soanthao.triggerPdfUpload(subjectId);
}

// Mở Thống kê hiệu suất (thẻ "Thống kê hiệu suất") — loại trừ với mọi công cụ Studio khác.
function openThongkeTool() {
  if (chat.open) { chat.open = false; renderChatDock(); }
  if (Ontap.isOpen()) Ontap.closeOntap();
  if (Thithu.isOpen()) Thithu.closeThithu();
  if (Flashcard.isOpen()) Flashcard.closeFlashcard();
  if (Mindmap.isOpen()) Mindmap.closeMindmap();
  if (Tomtat.isOpen()) Tomtat.closeTomtat();
  if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
  if (!Thongke.isOpen()) Thongke.openThongke();
}

// Mở Lịch biểu (thẻ "Lịch học" hoặc hộp báo nhắc lịch góc phải) — loại trừ với mọi công cụ Studio khác.
function openLichbieuTool() {
  if (chat.open) { chat.open = false; renderChatDock(); }
  if (Ontap.isOpen()) Ontap.closeOntap();
  if (Thithu.isOpen()) Thithu.closeThithu();
  if (Flashcard.isOpen()) Flashcard.closeFlashcard();
  if (Mindmap.isOpen()) Mindmap.closeMindmap();
  if (Tomtat.isOpen()) Tomtat.closeTomtat();
  if (Thongke.isOpen()) Thongke.closeThongke();
  if (!Lichbieu.isOpen()) Lichbieu.openLichbieu();
}

// Đóng mọi công cụ chiếm cột giữa trừ `keep` (dùng khi bấm thông báo).
function closeToolsExcept(keep) {
  if (chat.open) { chat.open = false; renderChatDock(); }
  if (keep !== "ontap" && Ontap.isOpen()) Ontap.closeOntap();
  if (keep !== "thithu" && Thithu.isOpen()) Thithu.closeThithu();
  if (keep !== "flashcard" && Flashcard.isOpen()) Flashcard.closeFlashcard();
  if (Mindmap.isOpen()) Mindmap.closeMindmap();
  if (Tomtat.isOpen()) Tomtat.closeTomtat();
  if (Thongke.isOpen()) Thongke.closeThongke();
  if (keep !== "lichbieu" && Lichbieu.isOpen()) Lichbieu.closeLichbieu();
  if (keep !== "hanmuc" && Hanmuc.isOpen()) Hanmuc.closeClean(true);
}

// Dọn dung lượng vừa xoá PDF (UC-33): bỏ khỏi cây Notebook; PDF đang mở thì về trạng thái chưa chọn mục.
function removeDeletedPdfs(ids) {
  if (!ids || !ids.length) return;
  state.subjects.forEach(function (s) { s.pdfs = (s.pdfs || []).filter(function (p) { return ids.indexOf(p.id) < 0; }); });
  ids.forEach(function (id) { delete state.pdfs[id]; });
  if (state.active && state.active.kind === "pdf" && ids.indexOf(state.active.id) >= 0) state.active = null;
  persist();
  renderAll();
}

// Bấm 1 thông báo (chuông topbar / chuông Lịch biểu / hộp báo góc phải — ghichu_thongbao.js) -> mở đúng chỗ:
// nhắc lịch -> Lịch biểu đúng sự kiện; nhắc ôn thẻ -> ôn bộ thẻ đó; bài làm dở -> làm tiếp đúng bài.
// Thông báo mẫu (chế độ chưa đăng nhập) không có ref_id -> chỉ mở công cụ tương ứng.
function openNotiTarget(n) {
  if (n.kind === "schedule") { openLichbieuTool(); Lichbieu.showNotiEvent(n); return; }
  // UC-33 / UC-35 / UC-36: dung lượng -> Dọn dung lượng (nhắc số tệp của 1 Môn thì lọc sẵn Môn đó); sắp hết lượt AI -> mở
  // cột Studio (số lượt hiện trên từng thẻ); quản trị viên phản hồi góp ý / xoá tệp -> hộp xem nội dung.
  if (n.kind === "quota") {
    var isSubject = state.subjects.some(function (s) { return s.id === n.refId; });
    Hanmuc.openClean(isSubject ? { filter: "subject", subjectId: n.refId } : { filter: "all" });
    return;
  }
  if (n.kind === "quota_ai") {
    closeToolsExcept(null);
    state.studioOpen = true; $("btn-studio").classList.add("is-open");
    syncMainPane(); Hanmuc.refresh();
    return;
  }
  if (n.kind === "feedback" || n.kind === "file_removed" || n.kind === "account" || n.kind === "quota_change") { Hanmuc.showNotice(n); return; }
  if (n.kind === "share" || n.kind === "share_request") { Chiase.openFromNotification(n); return; }
  var tool = n.kind === "flashcard" ? "flashcard" : n.kind === "exam" ? "thithu" : "ontap";
  if (!n.refId || !isOnline()) { hooks.openTool(tool); return; }
  closeToolsExcept(tool);
  if (tool === "flashcard") Flashcard.openSet(n.refId);
  else if (tool === "thithu") Thithu.openExam(n.refId);
  else Ontap.openSet(n.refId);
}

/* ====================================================================
   Studio AI — Hỏi đáp tri thức (UC-19/UC-20): chế độ chat của cột Studio, đặt
   ở đây (không tách module riêng) vì toàn bộ khung Studio AI (chrome + toggle
   studioOpen) vốn đã thuộc "lõi dùng chung" của ghichu.js/ghichu.css, không
   thuộc hẳn 1 trong 3 module con — xem ghi chú đầu ghichu_core.js.

   Lộ trình RAG Bước 1→5 (xem CLAUDE.md): khi ĐÃ đăng nhập, phiên chat + tin
   nhắn được lưu THẬT qua backend/app/routers/chat.py (GET/POST /chat/sessions,
   GET /chat/sessions/{id}/messages, POST /chat/messages, PATCH/DELETE
   /chat/sessions/{id}) — sống sót qua F5, đồng bộ đa thiết bị — và câu trả
   lời do Gemini API thật sinh ra (lịch sử hội thoại + đính kèm thủ công +
   đoạn trích tìm TỰ ĐỘNG bằng vector search) nếu backend đã cấu hình
   GEMINI_API_KEY; chưa cấu hình thì rơi về CHAT_STUB_REPLY (backend tự quyết
   định). Bước 5 (UC-19): mỗi phiên có 1 phạm vi nội dung nguồn (Toàn bộ /
   Môn học / Chương / Tệp PDF — mục trong menu nút "+", openPlusMenu()) giới
   hạn vector search. Khi CHƯA đăng nhập, giữ nguyên "chế độ mẫu" cũ: hoàn
   toàn cục bộ trong bộ nhớ JS, không gọi API nào, luôn trả CHAT_STUB_REPLY
   (đúng nguyên tắc isOnline() đã áp dụng cho cây Môn/Chương) — chọn phạm vi
   lúc đó chỉ đổi nhãn. Citation (BR-09) hiện thành khối "Nguồn" dưới câu trả
   lời — bấm vào mở đúng Chương / PDF tại trang (UC-20 luồng 5a,
   openCitation()). Thẻ "Ôn tập" mở module riêng ghichu_ontap.js (UC-21), thẻ
   "Thi thử" mở module riêng ghichu_thithu.js (UC-22), thẻ "Tạo Flashcard" mở module
   riêng ghichu_flashcard.js (UC-23), "Tạo sơ đồ tư duy" mở ghichu_mindmap.js (UC-25), "Tạo bản tóm
   tắt" mở ghichu_tomtat.js (UC-24); các thẻ Studio còn lại (Lịch học, Thống kê) vẫn tĩnh.
   ==================================================================== */
var CHAT_STUB_REPLY = "Tính năng hỏi đáp AI sẽ sớm có mặt.";

var chat = {
  open: false,     // đang ở chế độ chat (thay Notebook bằng khung hội thoại)
  input: "",
  sessions: [],     // [{id, title, scope, msgs:[{role:'user'|'bot', text}], loadedMsgs}]
  activeId: null,    // null = phiên nháp chưa có tin nhắn nào (chưa vào "Gần đây")
  // Phạm vi của phiên NHÁP (chưa có id thật ở backend) — gửi kèm POST /chat/messages lúc tạo
  // phiên; phiên đã có thì phạm vi nằm ở session.scope, đổi qua PUT /chat/sessions/{id}/scope.
  pendingScope: null,
  renamingId: null,
  renameDraft: "",
  sending: false,    // đang chờ POST /chat/messages -> chặn gửi trùng (chỉ có ý nghĩa khi online)
};

// Cùng shape với ChatScopeOut (backend/app/schemas.py) — cả 3 id null = "Toàn bộ tri thức".
function emptyScope() {
  return { subject_id: null, subject_name: null, chapter_id: null, chapter_name: null, document_id: null, document_name: null };
}
chat.pendingScope = emptyScope();

function chatActiveSession() {
  return chat.sessions.find(function (s) { return s.id === chat.activeId; }) || null;
}
function chatSessionTitle(firstUserText) {
  var t = (firstUserText || "").trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : (t || "Đoạn chat mới");
}

// Nạp danh sách "Gần đây" từ backend khi vừa vào trang (đã đăng nhập) — chỉ id/title,
// tin nhắn của từng phiên tải riêng lúc mở (openChatSession) để tránh tải thừa.
function bootChatSessions() {
  if (!isOnline()) return;
  apiAuth("GET", "/chat/sessions", authToken()).then(function (res) {
    if (!res.ok || !Array.isArray(res.data)) return;
    chat.sessions = res.data.map(function (s) {
      return { id: s.id, title: s.title, scope: s.scope || emptyScope(), msgs: [], loadedMsgs: false, qaUsed: s.qa_used, qaLimit: s.qa_limit };
    });
    if (chat.open) renderChatDock();
  });
}

// Thẻ "Hỏi đáp tri thức": quay về ĐÚNG cuộc hội thoại đang mở dở (vd. vừa bấm "Nguồn" sang Notebook để đối chiếu,
// hoặc "Quay lại Notebook") — chỉ lần đầu vào trang (chưa mở phiên nào) mới là cuộc hội thoại mới. Phiên mới: "Đoạn chat mới".
function openHoidap() {
  if (!chatActiveSession()) return newChat();
  var id = chat.activeId;
  chat.open = true;
  renderChatDock();
  Dinhkem.restoreChatAttachments(renderChatDock);
  var s = chatActiveSession();
  if (s && s.id === id) {   // giữ vị trí đọc: cuộn tới cuối như lúc rời đi
    var sc = $("chat-pane-scroll"); if (sc) sc.scrollTop = sc.scrollHeight;
  }
}
function newChat() { chat.open = true; chat.activeId = null; chat.input = ""; chat.pendingScope = emptyScope(); renderChatDock(); Dinhkem.restoreChatAttachments(renderChatDock); }
function openChatSession(id) {
  chat.open = true; chat.activeId = id; chat.input = "";
  renderChatDock();
  Dinhkem.restoreChatAttachments(renderChatDock);

  var session = chatActiveSession();
  var isLocal = session && String(session.id).indexOf("local-") === 0;
  if (session && isOnline() && !isLocal && !session.loadedMsgs) {
    apiAuth("GET", "/chat/sessions/" + session.id + "/messages", authToken()).then(function (res) {
      if (!res.ok || !Array.isArray(res.data)) return;
      session.msgs = res.data.map(function (m) {
        return { role: m.role === "user" ? "user" : "bot", text: m.content, cites: m.citations || [] };
      });
      session.loadedMsgs = true;
      if (chat.activeId === id) renderChatDock();
    });
  }
}
function exitChat() { chat.open = false; renderChatDock(); }

function sendChat() {
  var value = chat.input.trim();
  if (!value && !Dinhkem.peekChatAttachments()) return;
  if (chat.sending) return; // request trước (tạo phiên mới) chưa xong -> tránh gửi trùng
  if (chatSessionFull(chatActiveSession())) return; // hết lượt của cuộc hội thoại -> phải tạo cuộc mới

  var atts = Dinhkem.takeChatAttachments();
  var session = chatActiveSession();
  if (!session) {
    // id tạm (genLocalId()) — thay bằng id UUID thật của backend ngay khi có phản hồi,
    // cùng quy ước "local-" đã dùng cho Môn/Chương/annotation tạo ở chế độ mẫu.
    session = { id: genLocalId(), title: chatSessionTitle(value), scope: chat.pendingScope, msgs: [], loadedMsgs: true };
    chat.sessions.unshift(session);
    chat.activeId = session.id;
  }
  session.msgs.push({ role: "user", text: value, atts: atts });
  chat.input = "";

  if (!isOnline()) {
    // Chế độ mẫu (chưa đăng nhập) — giữ nguyên hành vi cũ, hoàn toàn cục bộ, không gọi API.
    session.msgs.push({ role: "bot", text: CHAT_STUB_REPLY });
    renderChatDock();
    return;
  }

  var localId = session.id;
  var isNewSession = String(localId).indexOf("local-") === 0;
  // Bước 2 lộ trình RAG: gửi kèm id các đính kèm THẬT (đã có id UUID từ backend) để
  // chat.py đọc content_text của Chương làm ngữ cảnh cho Gemini — chip còn đang tải lên
  // (id vẫn "local-") bị lọc bỏ, nội dung của nó đơn giản không kịp có mặt trong ngữ cảnh.
  var attachmentIds = atts.filter(function (a) { return String(a.id).indexOf("local-") !== 0; })
    .map(function (a) { return a.id; });
  chat.sending = true;
  chat.sendingSession = session;
  var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  chat.abort = ctrl;
  startChatThinking();
  renderChatDock();
  apiAuth("POST", "/chat/messages", authToken(), {
    session_id: isNewSession ? null : session.id,
    content: value,
    attachment_ids: attachmentIds,
    // Bước 5 (UC-19) — backend chỉ đọc field này khi tạo phiên mới (session_id=null).
    scope: scopeRequest(session.scope),
  }, ctrl ? ctrl.signal : undefined).then(function (res) {
    chat.sending = false;
    chat.sendingSession = null;
    chat.abort = null;
    stopChatThinking();
    if (res.aborted) {
      // Người dùng bấm dừng: bỏ chờ. Máy chủ có thể vẫn trả lời xong và lưu lại — mở lại cuộc hội thoại (cuộc cũ)
      // hoặc tải lại trang (cuộc mới) sẽ thấy đúng lịch sử thật trên máy chủ.
      session.msgs.push({ role: "bot", text: "Đã dừng — bạn có thể hỏi lại hoặc đặt câu hỏi khác." });
      if (!isNewSession) session.loadedMsgs = false;
      renderChatDock();
      return;
    }
    if (!res.ok) {
      var err = res.data && res.data.err;
      if (err && err.code === "session_limit") { session.qaUsed = err.used; session.qaLimit = err.limit; }
      session.msgs.push({ role: "bot", text: (res.data && res.data.detail) || "Không gửi được tin nhắn (lỗi kết nối)." });
      renderChatDock();
      return;
    }
    if (isNewSession) {
      session.id = res.data.session.id;
      session.title = res.data.session.title;
      session.scope = res.data.session.scope;
      if (chat.activeId === localId) chat.activeId = session.id;
    }
    session.qaUsed = res.data.session.qa_used;
    session.qaLimit = res.data.session.qa_limit;
    session.msgs.push({ role: "bot", text: res.data.assistant_message.content, cites: res.data.assistant_message.citations || [] });
    renderChatDock();
  });
}

/* "Đang suy luận": bong bóng chờ ở cuối cuộc hội thoại + nút dừng (thay micro) trong lúc chờ POST /chat/messages.
   Máy chủ trả lời 1 lần (không stream) nên chữ trạng thái đổi THEO THỜI GIAN chờ (như ô "Đang tạo" của Ôn tập), kèm số giây. */
var CHAT_THINK_STEPS = [[0, "Đang tìm trong tài liệu của bạn…"], [2, "Đang suy luận…"], [6, "Đang soạn câu trả lời…"]];
function chatThinkingLabel() {
  var sec = Math.floor((Date.now() - (chat.thinkStart || Date.now())) / 1000), label = CHAT_THINK_STEPS[0][1];
  CHAT_THINK_STEPS.forEach(function (s) { if (sec >= s[0]) label = s[1]; });
  return { label: label, sec: sec };
}
function chatThinkingHtml() {
  var t = chatThinkingLabel();
  return '<div class="chat-msg bot"><div class="chat-thinking" role="status" aria-live="polite">' +
    '<span class="chat-thinking-dots"><i></i><i></i><i></i></span>' +
    '<span class="chat-thinking-text" id="chat-thinking-text">' + t.label + "</span>" +
    '<span class="chat-thinking-time" id="chat-thinking-time">' + t.sec + " giây</span></div></div>";
}
function startChatThinking() {
  stopChatThinking();
  chat.thinkStart = Date.now();
  chat.thinkTimer = setInterval(function () {
    var text = $("chat-thinking-text"), time = $("chat-thinking-time");
    if (!text) return;
    var t = chatThinkingLabel();
    text.textContent = t.label;
    time.textContent = t.sec + " giây";
  }, 500);
}
function stopChatThinking() {
  if (chat.thinkTimer) clearInterval(chat.thinkTimer);
  chat.thinkTimer = null;
}
function stopChat() { if (chat.abort) chat.abort.abort(); }

/* Hạn mức Hỏi đáp tính THEO CUỘC HỘI THOẠI (backend services/quota.py PER_SESSION, kiểu ChatGPT): mỗi phiên tối đa
   qaLimit câu trả lời AI; hết thì ô nhập thay bằng thông báo + nút tạo cuộc hội thoại mới. Chế độ mẫu không giới hạn. */
var CHAT_LIMIT_WARN = 10; // còn <= số lượt này thì hiện dòng "Còn x / y lượt"
function chatSessionFull(session) {
  return !!(session && session.qaLimit && session.qaUsed >= session.qaLimit);
}
function renderChatLimit(session) {
  var box = $("chat-limit"), composer = $("chat-composer-bottom");
  var full = chatSessionFull(session);
  var left = session && session.qaLimit ? session.qaLimit - (session.qaUsed || 0) : null;
  composer.hidden = full;
  box.className = "chat-limit" + (full ? " chat-limit--full" : "");
  if (full) {
    box.hidden = false;
    box.innerHTML = "<span>Cuộc hội thoại này đã dùng hết " + session.qaLimit + " lượt hỏi đáp. Hãy tạo cuộc hội thoại mới để tiếp tục.</span>" +
      '<button type="button" class="chat-limit-new" id="chat-limit-new">Tạo cuộc hội thoại mới</button>';
    $("chat-limit-new").addEventListener("click", newChat);
  } else if (left !== null && left <= CHAT_LIMIT_WARN) {
    box.hidden = false;
    box.textContent = "Còn " + left + " / " + session.qaLimit + " lượt hỏi đáp trong cuộc hội thoại này";
  } else {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function startChatRename(id) {
  var s = chat.sessions.find(function (x) { return x.id === id; });
  if (!s) return;
  chat.renamingId = id;
  chat.renameDraft = s.title;
  state.dd = null;
  closeDropdownEl();
  renderChatDock();
}
function commitChatRename() {
  var s = chat.sessions.find(function (x) { return x.id === chat.renamingId; });
  var t = chat.renameDraft.trim();
  chat.renamingId = null;
  if (!s || !t || s.title === t) { renderChatDock(); return; }

  var apply = function () { s.title = t; renderChatDock(); };
  if (isOnline() && String(s.id).indexOf("local-") !== 0) {
    apiAuth("PATCH", "/chat/sessions/" + s.id, authToken(), { title: t }).then(function (res) {
      if (!res.ok) { window.alert((res.data && res.data.detail) || "Không đổi tên được đoạn chat."); renderChatDock(); return; }
      apply();
    });
    return;
  }
  apply();
}
function deleteChatSession(id) {
  var s = chat.sessions.find(function (x) { return x.id === id; });
  if (!s) return;
  if (!window.confirm('Xoá đoạn chat "' + s.title + '"? Không thể hoàn tác.')) return;

  var finish = function () {
    chat.sessions = chat.sessions.filter(function (x) { return x.id !== id; });
    if (chat.activeId === id) chat.activeId = null;
    state.dd = null;
    closeDropdownEl();
    renderChatDock();
  };
  if (isOnline() && String(id).indexOf("local-") !== 0) {
    apiAuth("DELETE", "/chat/sessions/" + id, authToken()).then(function (res) {
      if (!res.ok) { window.alert((res.data && res.data.detail) || "Không xoá được đoạn chat."); return; }
      finish();
    });
    return;
  }
  finish();
}
function openChatItemMenu(e, id) {
  e.preventDefault(); e.stopPropagation();
  var r = e.currentTarget.getBoundingClientRect();
  var x = Math.max(8, Math.min(r.left, window.innerWidth - 190));
  openDropdown("chat-item-" + id, x, r.bottom + 6,
    '<div class="dd-plain">' +
      '<button type="button" id="chat-menu-rename">Đổi tên</button>' +
      '<button type="button" id="chat-menu-delete" style="color:var(--danger)">Xóa</button>' +
    "</div>",
    function (panel) {
      panel.querySelector("#chat-menu-rename").addEventListener("click", function (ev) { ev.stopPropagation(); startChatRename(id); });
      panel.querySelector("#chat-menu-delete").addEventListener("click", function (ev) { ev.stopPropagation(); deleteChatSession(id); });
    });
}

/* --- Bước 5 lộ trình RAG (UC-19): chọn phạm vi nội dung nguồn -------------------
   Danh sách Môn/Chương/PDF lấy thẳng từ cây Notebook đã có trong state.subjects (cùng nguồn
   với dropdown "@" của ghichu_chat_dinhkem.js), không gọi API mới. Backend kiểm tra lại
   BR-05 (sở hữu) + BR-07 (phạm vi phải có nội dung đã embed) ngay lúc CHỌN — phiên nháp qua
   GET /chat/scope-check, phiên đã có qua PUT /chat/sessions/{id}/scope — nên lỗi "phạm vi
   rỗng" hiện ra trước khi người dùng kịp gõ câu hỏi. PDF là mức riêng (gắn thẳng vào Môn,
   không thuộc Chương nào) nên phạm vi Chương KHÔNG bao gồm PDF. */
function currentChatScope() {
  var session = chatActiveSession();
  return (session && session.scope) || chat.pendingScope || emptyScope();
}
function scopeLabel(scope) {
  if (scope.document_id) return "Tệp: " + scope.document_name;
  if (scope.chapter_id) return "Chương: " + scope.chapter_name;
  if (scope.subject_id) return "Môn học: " + scope.subject_name;
  return "Toàn bộ tri thức";
}
function scopeRequest(scope) {
  scope = scope || emptyScope();
  return { subject_id: scope.subject_id, chapter_id: scope.chapter_id, document_id: scope.document_id };
}
function scopeIsSet(scope) { return !!(scope.subject_id || scope.chapter_id || scope.document_id); }

var ICO_SCOPE = '<svg class="chat-chip-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>';
var ICO_CLIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.19 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path></svg>';

// Chip phạm vi — CHỈ hiện khi đã giới hạn (Môn/Chương/PDF), đứng đầu hàng chip đính kèm ở ô
// nhập. Mặc định "Toàn bộ tri thức" không hiện gì. Bấm chip = đổi phạm vi, bấm × = bỏ giới hạn.
function renderScopeChip(host) {
  if (!host) return;
  var scope = currentChatScope();
  if (!scopeIsSet(scope)) return;
  var chip = el("span", "chat-chip chat-chip--scope",
    ICO_SCOPE + '<span class="chat-chip-label">' + esc(scopeLabel(scope)) + "</span>" +
    '<button type="button" class="chat-chip-x" title="Bỏ giới hạn — tìm trong toàn bộ tri thức">×</button>');
  chip.title = "AI chỉ tìm trong phạm vi này — bấm để đổi";
  chip.addEventListener("click", function (e) { e.stopPropagation(); openScopePicker(chip.getBoundingClientRect()); });
  chip.querySelector(".chat-chip-x").addEventListener("click", function (e) { e.stopPropagation(); selectScope(emptyScope()); });
  host.insertBefore(chip, host.firstChild);
}

// Ô nhập chat thường nằm sát đáy màn hình -> ưu tiên mở dropdown HƯỚNG LÊN phía trên phần tử
// neo (cùng cách dropdown "@" trong ghichu_chat_dinhkem.js), không đủ chỗ thì mở xuống dưới.
function openDropdownNear(id, rect, html, bind) {
  var x = Math.max(8, Math.min(rect.left, window.innerWidth - 370));
  openDropdown(id, x, 0, html, bind);
  var panel = $("dd-panel");
  var h = panel.offsetHeight;
  var y = rect.top - h - 8;
  if (y < 8) y = Math.min(rect.bottom + 8, window.innerHeight - h - 8);
  panel.style.top = Math.max(8, y) + "px";
}

// Nút "+" ở ô nhập: trước Bước 5 chỉ mở hộp chọn tệp; giờ là menu 2 mục.
function openPlusMenu(e) {
  e.preventDefault(); e.stopPropagation();
  var rect = e.currentTarget.getBoundingClientRect();
  openDropdownNear("chat-plus", rect,
    '<div class="dd-plain chat-plus-menu">' +
      '<button type="button" id="chat-plus-upload">' + ICO_CLIP + "<span>Tải tệp hoặc ảnh từ máy</span></button>" +
      '<button type="button" id="chat-plus-scope">' + ICO_SCOPE + "<span>Giới hạn phạm vi tìm kiếm…</span></button>" +
    "</div>",
    function (panel) {
      panel.querySelector("#chat-plus-upload").addEventListener("click", function (ev) {
        ev.stopPropagation(); state.dd = null; closeDropdownEl(); Dinhkem.triggerChatFileUpload();
      });
      panel.querySelector("#chat-plus-scope").addEventListener("click", function (ev) {
        ev.stopPropagation(); openScopePicker(rect);
      });
    });
}

function openScopePicker(anchorRect) {
  var cur = currentChatScope();
  var real = function (x) { return String(x.id).indexOf("local-") !== 0 || !isOnline(); };
  var rows = [emptyScope()];
  var html = '<div class="dd-plain chat-scope-menu"><div class="chat-scope-head">AI chỉ tìm câu trả lời trong phần bạn chọn</div>';
  var row = function (scope, cls, icon, text) {
    var on = scope.subject_id === cur.subject_id && scope.chapter_id === cur.chapter_id && scope.document_id === cur.document_id;
    rows.push(scope);
    return '<button type="button" class="' + cls + (on ? " on" : "") + '" data-i="' + (rows.length - 1) + '">' + icon + "<span>" + esc(text) + "</span></button>";
  };
  var isAll = !(cur.subject_id || cur.chapter_id || cur.document_id);
  html += '<button type="button" data-i="0"' + (isAll ? ' class="on"' : "") + "><span>Toàn bộ tri thức (không giới hạn)</span></button>";
  var icoSub = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2z"></path></svg>';
  var icoCh = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l4 4v14H6z"></path></svg>';
  var icoPdf = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l4 4v14H6z"></path><path d="M9 14h6M9 17h4"></path></svg>';
  state.subjects.filter(real).forEach(function (sub) {
    var base = emptyScope();
    base.subject_id = sub.id; base.subject_name = sub.name;
    html += row(base, "chat-scope-row--subject", icoSub, sub.name);
    sub.chapters.filter(real).forEach(function (c) {
      var sc = emptyScope();
      sc.subject_id = sub.id; sc.subject_name = sub.name; sc.chapter_id = c.id; sc.chapter_name = c.name;
      html += row(sc, "chat-scope-row--child", icoCh, c.name);
    });
    (sub.pdfs || []).filter(real).forEach(function (p) {
      var sp = emptyScope();
      sp.document_id = p.id; sp.document_name = p.name;
      html += row(sp, "chat-scope-row--child", icoPdf, p.name);
    });
  });
  if (rows.length === 1) html += '<div class="chat-scope-head">Chưa có Môn học nào trong Notebook.</div>';
  html += "</div>";
  openDropdownNear("chat-scope", anchorRect, html, function (panel) {
    panel.querySelectorAll("button[data-i]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectScope(rows[Number(b.dataset.i)]);
      });
    });
  });
}

function selectScope(scope) {
  state.dd = null;
  closeDropdownEl();
  if (chat.sending) { window.alert("Đang chờ AI trả lời — đổi phạm vi sau khi có câu trả lời nhé."); return; }
  var session = chatActiveSession();
  var isDraft = !session || String(session.id).indexOf("local-") === 0;
  var setDraft = function (sc) {
    chat.pendingScope = sc;
    if (session) session.scope = sc; // phiên local- gửi lỗi lần trước: lần gửi lại dùng phạm vi mới
    renderChatDock();
  };
  if (!isOnline()) { setDraft(scope); return; } // chế độ mẫu: chỉ đổi nhãn, không gọi API

  var q = scopeRequest(scope);
  var fail = function (res) { window.alert((res.data && res.data.detail) || "Không đổi được phạm vi."); };
  if (isDraft) {
    var qs = Object.keys(q).filter(function (k) { return q[k]; })
      .map(function (k) { return k + "=" + encodeURIComponent(q[k]); }).join("&");
    apiAuth("GET", "/chat/scope-check" + (qs ? "?" + qs : ""), authToken()).then(function (res) {
      if (!res.ok) { fail(res); return; }
      setDraft(res.data);
    });
    return;
  }
  apiAuth("PUT", "/chat/sessions/" + session.id + "/scope", authToken(), q).then(function (res) {
    if (!res.ok) { fail(res); return; }
    session.scope = res.data.scope;
    renderChatDock();
  });
}

function bindChatInput(input, autofocus) {
  if (!input) return;
  input.value = chat.input;
  // #chat-input-bottom là phần tử TĨNH trong HTML (không bị tạo lại mỗi lần renderChatDock()
  // vẽ khung chat) — nếu gắn listener vô điều kiện ở đây, mỗi lần vẽ lại sẽ chồng thêm 1 lớp
  // listener mới (không gỡ lớp cũ), gây "bấm Enter gửi nhiều lần" về sau. Chỉ gắn 1 lần.
  if (!input.dataset.chatBound) {
    input.dataset.chatBound = "1";
    input.addEventListener("input", function () { chat.input = input.value; Dinhkem.detectMention(input); });
    input.addEventListener("keydown", function (e) {
      if (Dinhkem.handleChatKeydown(e, input)) return; // dropdown "@" (↑↓/Enter/Esc) ưu tiên trước
      if (e.key === "Enter") { e.preventDefault(); sendChat(); }
    });
  }
  if (autofocus) input.focus();
}

/* Vẽ lại toàn bộ chế độ chat: ẩn/hiện Notebook <-> khung chat, chrome cột
   Studio (đầu đề + danh sách "Gần đây"), và nội dung hội thoại đang mở. Gọi
   lại mỗi khi chat.* đổi (không đi qua renderAll() vì không ảnh hưởng
   tab/ribbon/cây tri thức). */
// Nhiều chunk của cùng 1 Chương / cùng 1 trang PDF -> chỉ hiện 1 nguồn (giữ thứ tự xếp hạng
// của retrieval: chunk liên quan nhất đứng trước).
function uniqueCites(cites) {
  var seen = {};
  return (cites || []).filter(function (c) {
    var key = (c.chapter_id || "") + "|" + (c.document_id || "") + "|" + (c.page || "");
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// Tên nguồn không kèm "(trang a/b)" — số trang ghi riêng ở dòng dưới.
function citeName(c) { return String(c.label || "").replace(/\s*\((trang|tổng)[^)]*\)\s*$/i, ""); }
function citePage(c) { return c.page ? "Trang " + c.page + (c.total_pages ? " / " + c.total_pages : "") : ""; }

// Khối "Nguồn" dưới câu trả lời: mỗi nguồn 1 dòng "(n) Tên nguồn", dòng dưới là số trang (PDF); bấm để mở + bôi vàng.
function citesHtml(m, mi) {
  var cites = uniqueCites(m.cites);
  if (!cites.length) return "";
  return '<div class="chat-cites"><div class="chat-cites-title">Nguồn</div>' + cites.map(function (c, ci) {
    var pg = citePage(c);
    return '<button type="button" class="chat-cite chat-src" data-mi="' + mi + '" data-ci="' + ci + '" title="' + esc(c.preview || "") + '">' +
      '<span class="chat-src-num">(' + (ci + 1) + ")</span>" +
      '<span class="chat-src-body"><span class="chat-src-name">' + esc(citeName(c)) + "</span>" +
      (pg ? '<span class="chat-src-page">' + pg + "</span>" : "") + "</span></button>";
  }).join("") + "</div>";
}

// Trong câu trả lời, Gemini ghi nguồn dạng "[Chương: …]" / "[Tệp: … (trang a/b)]" -> đổi thành số "(n)" bấm được,
// khớp với danh sách "Nguồn" bên dưới (cùng Chương; PDF thì cùng tệp, ưu tiên đúng trang). Không khớp nguồn nào thì giữ nguyên.
function linkCiteRefs(html, m, mi) {
  var cites = uniqueCites(m.cites);
  // Câu trả lời mới: backend (_select_citations ở chat.py) đã đánh số [1], [2]… khớp ĐÚNG thứ tự danh sách Nguồn.
  if (/\[\d+\]/.test(html)) {
    return html.replace(/\[(\d+)\]/g, function (all, n) {
      var ci = +n - 1, c = cites[ci];
      if (!c) return "";   // số không có nguồn tương ứng (nguồn đã bị xoá) -> bỏ, không để "[3]" trơ trọi
      return '<button type="button" class="chat-cite chat-ref" data-mi="' + mi + '" data-ci="' + ci + '" title="' + esc(c.label) + '">(' + n + ")</button>";
    });
  }
  if (!cites.length) return html;
  var norm = function (s) { return String(s).toLowerCase().replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); };
  return html.replace(/\[((?:Chương|Tệp)\s*:[^\]]+)\]/g, function (all, inner) {
    var name = norm(inner.replace(/\s*\((trang|tổng)[^)]*\)\s*$/i, ""));
    var pm = inner.match(/trang\s+(\d+)/i), page = pm ? +pm[1] : null;
    var hits = [];
    cites.forEach(function (c, ci) { if (norm(citeName(c)) === name) hits.push(ci); });
    if (!hits.length) return all;
    var exact = hits.filter(function (ci) { return page && cites[ci].page === page; });
    var list = exact.length ? exact : (page ? hits.slice(0, 1) : hits);
    return list.map(function (ci) {
      return '<button type="button" class="chat-cite chat-ref" data-mi="' + mi + '" data-ci="' + ci + '" title="' + esc(cites[ci].label) + '">(' + (ci + 1) + ")</button>";
    }).join("");
  });
}

// Bấm trích dẫn (UC-20 luồng thay thế 5a — dùng chung cho khung Hỏi đáp VÀ màn Ôn tập qua
// hooks.openSource): rời màn Studio AI, mở đúng Chương (hoặc PDF và cuộn tới trang của đoạn trích).
// Tìm Môn chứa nguồn trong cây hiện tại (PDF có thể đã bị kéo sang Môn khác sau khi trích dẫn được
// tạo, nên subject_id đi kèm chỉ là gợi ý). Nguồn đã bị xoá khỏi cây thì báo thay vì mở nhầm.
function openSource(c) {
  var has = function (sub) {
    return c.document_id
      ? (sub.pdfs || []).some(function (p) { return p.id === c.document_id; })
      : (sub.chapters || []).some(function (ch) { return ch.id === c.chapter_id; });
  };
  var sub = state.subjects.find(function (x) { return x.id === c.subject_id && has(x); }) || state.subjects.find(has);
  if (!sub) { window.alert("Nguồn này không còn trong Notebook (có thể đã bị xoá hoặc chuyển đi)."); return; }
  if (chat.open) exitChat();
  if (Ontap.isOpen()) Ontap.closeOntap(true); // giữ bài đang làm: bấm lại thẻ "Ôn tập" là quay về đúng câu
  if (Thithu.isOpen()) Thithu.closeThithu(true); // giữ trang đang xem: bấm lại thẻ "Thi thử" là quay về đúng câu
  if (Flashcard.isOpen()) Flashcard.closeFlashcard(); // giữ phiên ôn / trang đang xem: bấm lại thẻ Flashcard là quay về đúng chỗ
  if (Mindmap.isOpen()) Mindmap.closeMindmap(); // giữ sơ đồ đang mở: bấm lại thẻ Sơ đồ tư duy là quay về khung vẽ
  if (Tomtat.isOpen()) Tomtat.closeTomtat(); // giữ bản tóm tắt đang xem: bấm lại thẻ Tóm tắt là quay về đúng bản
  if (Lichbieu.isOpen()) Lichbieu.closeLichbieu(); // "Mở" Chương liên kết từ chi tiết sự kiện lịch (UC-26 1a)
  if (Thongke.isOpen()) Thongke.closeThongke(); // bấm Chương/PDF ở trang Notebook của Thống kê
  if (Hanmuc.isOpen()) Hanmuc.closeClean(true);
  // c.highlight (Hỏi đáp) / c.quote (Ôn tập, Thi thử, Flashcard, Sơ đồ) = câu được trích -> cuộn tới + bôi vàng
  var hl = c.highlight || c.quote || null;
  if (c.document_id) Soanthao.selectPdfAtPage(sub.id, c.document_id, c.page, hl);
  else Soanthao.selectChapter(sub.id, c.chapter_id, hl);
}

// "Hỏi về chủ đề này" ở bảng node của Sơ đồ tư duy (UC-25 -> UC-20): rời màn Sơ đồ (giữ nguyên sơ đồ
// đang mở), mở khung Hỏi đáp phiên mới với ô nhập điền sẵn câu hỏi — người học sửa/bấm gửi.
function askAbout(text) {
  if (Mindmap.isOpen()) Mindmap.closeMindmap();
  if (Tomtat.isOpen()) Tomtat.closeTomtat();
  newChat();   // câu hỏi về 1 node / ý: luôn mở cuộc hội thoại mới
  chat.input = text;
  renderChatDock();
  var input = $("chat-input-empty") || $("chat-input-bottom");
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
function openCitation(c) { openSource(c); }

// Câu trả lời của AI (Gemini trả Markdown): tiêu đề, **đậm**, *nghiêng*, `mã`, danh sách gạch đầu dòng / đánh số
// (lồng 1 cấp) và đoạn văn -> HTML gọn để căn đều 2 lề như văn bản. ESCAPE TRƯỚC rồi mới thêm thẻ nên không chèn được HTML lạ.
function chatMdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
}
function chatMarkdown(text) {
  var lines = esc(String(text || "").replace(/\r/g, "")).split("\n");
  var out = [], para = [], stack = [];   // stack: [{tag, indent}] danh sách đang mở
  var flushPara = function () { if (para.length) { out.push("<p>" + para.map(chatMdInline).join("<br>") + "</p>"); para = []; } };
  var closeLists = function (indent) {
    while (stack.length && (indent === undefined || stack[stack.length - 1].indent > indent)) out.push("</li></" + stack.pop().tag + ">");
  };
  lines.forEach(function (raw) {
    var line = raw.replace(/\s+$/, "");
    var m;
    if (!line.trim()) { flushPara(); closeLists(); return; }
    if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) { flushPara(); closeLists(); out.push('<h4 class="chat-md-h">' + chatMdInline(m[2]) + "</h4>"); return; }
    if ((m = line.match(/^(\s*)([-*•+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      var indent = m[1].replace(/\t/g, "  ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
      var top = stack[stack.length - 1];
      if (top && indent < top.indent) { closeLists(indent); top = stack[stack.length - 1]; }
      if (!top || indent > top.indent) { out.push("<" + tag + ">"); stack.push({ tag: tag, indent: indent }); }
      else if (top.tag !== tag) { out.push("</li></" + stack.pop().tag + "><" + tag + ">"); stack.push({ tag: tag, indent: indent }); }
      else out.push("</li>");
      out.push("<li>" + chatMdInline(m[3]));
      return;
    }
    if (stack.length) { out.push("<br>" + chatMdInline(line.trim())); return; }   // dòng nối tiếp của mục danh sách
    para.push(line.trim());
  });
  flushPara(); closeLists();
  return out.join("").replace(/<(ul|ol)><\/li>/g, "<$1>");
}

function renderChatDock() {
  syncMainPane();
  $("studio-head-default").hidden = chat.open;
  $("studio-head-chat").hidden = !chat.open;
  $("studio-head").classList.toggle("studio-head--chat", chat.open);
  $("studio-default").hidden = chat.open;
  $("studio-chat-list").hidden = !chat.open;
  $("chat-reopen-studio-btn").hidden = !(chat.open && !state.studioOpen);
  if (!chat.open) return;

  var recentBox = $("studio-chat-recent");
  recentBox.innerHTML = "";
  chat.sessions.forEach(function (s) {
    var row = el("div", "studio-chat-item");
    if (chat.renamingId === s.id) {
      var input = document.createElement("input");
      input.className = "studio-chat-item-rename";
      input.value = chat.renameDraft;
      input.addEventListener("input", function () { chat.renameDraft = input.value; });
      input.addEventListener("blur", commitChatRename);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commitChatRename(); }
        if (e.key === "Escape") { e.preventDefault(); chat.renamingId = null; renderChatDock(); }
      });
      row.appendChild(input);
      recentBox.appendChild(row);
      input.focus(); input.select();
      return;
    }
    var openBtn = el("button", "studio-chat-item-open" + (s.id === chat.activeId ? " active" : ""),
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5-5 5M13 7l5 5-5 5"></path></svg><span class="studio-chat-item-title">' + esc(s.title) + "</span>");
    openBtn.type = "button";
    openBtn.addEventListener("click", function () { openChatSession(s.id); });
    var menuBtn = el("button", "studio-chat-item-menu", '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>');
    menuBtn.type = "button"; menuBtn.title = "Tùy chọn";
    menuBtn.addEventListener("click", function (e) { openChatItemMenu(e, s.id); });
    row.appendChild(openBtn);
    row.appendChild(menuBtn);
    recentBox.appendChild(row);
  });

  var session = chatActiveSession();
  var msgs = session ? session.msgs : [];
  var scroll = $("chat-pane-scroll");
  var inputbar = $("chat-pane-inputbar");

  if (!msgs.length) {
    inputbar.hidden = true;
    scroll.classList.add("chat-pane-scroll--empty");
    scroll.innerHTML =
      '<div class="chat-empty">' +
        '<img class="chat-empty-icon" src="../assets/icon-hoidap-trithuc.svg" alt="">' +
        '<div class="chat-empty-title">Hãy thảo luận cùng tôi nhé !</div>' +
        '<div class="chat-composer">' +
          '<div class="chat-chips" id="chat-chips-empty"></div>' +
          '<div class="chat-pill" id="chat-pill-empty">' +
            '<button type="button" class="chat-pill-plus" id="chat-plus-empty" title="Đính kèm tệp hoặc giới hạn phạm vi">' +
              '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>' +
            "</button>" +
            '<input type="text" id="chat-input-empty" class="chat-pill-input" placeholder="Hỏi bất kỳ điều gì" autocomplete="off">' +
            '<svg class="chat-pill-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3"></path></svg>' +
          "</div>" +
        "</div>" +
      "</div>";
    bindChatInput($("chat-input-empty"), true);
    Dinhkem.bindChatPill($("chat-pill-empty"), $("chat-input-empty"), openPlusMenu);
    Dinhkem.renderChatChips($("chat-chips-empty"));
    renderScopeChip($("chat-chips-empty"));
  } else {
    inputbar.hidden = false;
    scroll.classList.remove("chat-pane-scroll--empty");
    scroll.innerHTML = '<div class="chat-thread">' + msgs.map(function (m, mi) {
      var atts = (m.atts && m.atts.length) ? '<div class="chat-bubble-atts">' + m.atts.map(Dinhkem.chipStaticHtml).join("") + "</div>" : "";
      var cites = m.role === "bot" ? citesHtml(m, mi) : "";
      return '<div class="chat-msg ' + (m.role === "user" ? "user" : "bot") + '"><div class="chat-bubble ' + (m.role === "user" ? "user" : "bot") + '">' + (m.text ? (m.role === "user" ? esc(m.text) : '<div class="chat-md">' + linkCiteRefs(chatMarkdown(m.text), m, mi) + "</div>") : "") + atts + cites + "</div></div>";
    }).join("") + (chat.sending && chat.sendingSession === session ? chatThinkingHtml() : "") + "</div>";
    scroll.querySelectorAll(".chat-cite").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var m = msgs[+btn.getAttribute("data-mi")];
        openCitation(uniqueCites(m.cites)[+btn.getAttribute("data-ci")]);
      });
    });
    var busy = chat.sending && chat.sendingSession === session;
    $("chat-mic-bottom").style.display = busy ? "none" : "";   // <svg> không có thuộc tính .hidden như phần tử HTML
    $("chat-stop-bottom").hidden = !busy;
    bindChatInput($("chat-input-bottom"), true);
    Dinhkem.bindChatPill($("chat-pill-bottom"), $("chat-input-bottom"), openPlusMenu);
    Dinhkem.renderChatChips($("chat-chips-bottom"));
    renderScopeChip($("chat-chips-bottom"));
    renderChatLimit(session);
    scroll.scrollTop = scroll.scrollHeight;
  }
}

/* ====================================================================
   Khởi tạo trang
   ==================================================================== */
function init() {

  var studioToggle = function () {
    state.studioOpen = !state.studioOpen;
    if (state.studioOpen) state.treeDrawer = false; // màn hẹp: mở Studio thì đóng ngăn kéo Notebook
    $("btn-studio").classList.toggle("is-open", state.studioOpen);
    updateWorkspaceCols();
  };
  // Responsive: nút ☰ (chỉ hiện khi cửa sổ < TREE_COL_MIN) mở / đóng ngăn kéo cây Notebook.
  $("btn-tree").addEventListener("click", function (e) {
    e.stopPropagation();
    state.treeDrawer = !state.treeDrawer;
    if (state.treeDrawer && window.innerWidth < STUDIO_COL_MIN && state.studioOpen) {
      state.studioOpen = false; $("btn-studio").classList.remove("is-open");
    }
    updateWorkspaceCols();
  });
  $("drawer-backdrop").addEventListener("click", function (e) { e.stopPropagation(); closeDrawers(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("drawer-backdrop").hidden && !document.querySelector(".dd-panel:not([hidden]), .ctx-menu:not([hidden])")) closeDrawers();
  });
  $("btn-studio").addEventListener("click", function (e) { e.stopPropagation(); studioToggle(); });
  $("btn-studio-close").addEventListener("click", function (e) { e.stopPropagation(); studioToggle(); });
  $("chat-reopen-studio-btn").addEventListener("click", function (e) { e.stopPropagation(); studioToggle(); });

  $("studio-card-hoidap").addEventListener("click", function (e) { e.stopPropagation(); openHoidap(); });
  $("chat-stop-bottom").addEventListener("click", function (e) { e.stopPropagation(); stopChat(); });
  // UC-21: đang ở khung chat thì thoát chat trước — 2 màn hình Studio AI loại trừ nhau.
  $("studio-card-ontap").addEventListener("click", function (e) {
    e.stopPropagation();
    if (chat.open) { chat.open = false; renderChatDock(); }
    if (Thithu.isOpen()) Thithu.closeThithu();
    if (Flashcard.isOpen()) Flashcard.closeFlashcard();
    if (Mindmap.isOpen()) Mindmap.closeMindmap();
    if (Tomtat.isOpen()) Tomtat.closeTomtat();
    if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
    Ontap.openOntap();
  });
  // UC-22: Tạo đề thi thử — module riêng ghichu_thithu.js, loại trừ với Hỏi đáp / Ôn tập.
  $("studio-card-thithu").addEventListener("click", function (e) {
    e.stopPropagation();
    if (chat.open) { chat.open = false; renderChatDock(); }
    if (Ontap.isOpen()) Ontap.closeOntap();
    if (Flashcard.isOpen()) Flashcard.closeFlashcard();
    if (Mindmap.isOpen()) Mindmap.closeMindmap();
    if (Tomtat.isOpen()) Tomtat.closeTomtat();
    if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
    Thithu.openThithu();
  });
  // UC-23: Tạo Flashcard — module riêng ghichu_flashcard.js, loại trừ với Hỏi đáp / Ôn tập / Thi thử.
  $("studio-card-flashcard").addEventListener("click", function (e) {
    e.stopPropagation();
    if (chat.open) { chat.open = false; renderChatDock(); }
    if (Ontap.isOpen()) Ontap.closeOntap();
    if (Thithu.isOpen()) Thithu.closeThithu();
    if (Mindmap.isOpen()) Mindmap.closeMindmap();
    if (Tomtat.isOpen()) Tomtat.closeTomtat();
    if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
    Flashcard.openFlashcard();
  });
  // UC-25: Tạo sơ đồ tư duy — module riêng ghichu_mindmap.js, loại trừ với Hỏi đáp / Ôn tập / Thi thử / Flashcard.
  $("studio-card-mindmap").addEventListener("click", function (e) {
    e.stopPropagation();
    if (chat.open) { chat.open = false; renderChatDock(); }
    if (Ontap.isOpen()) Ontap.closeOntap();
    if (Thithu.isOpen()) Thithu.closeThithu();
    if (Flashcard.isOpen()) Flashcard.closeFlashcard();
    if (Tomtat.isOpen()) Tomtat.closeTomtat();
    if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
    Mindmap.openMindmap();
  });
  // UC-24: Tạo bản tóm tắt — module riêng ghichu_tomtat.js, loại trừ với Hỏi đáp / Ôn tập / Thi thử / Flashcard / Sơ đồ.
  $("studio-card-tomtat").addEventListener("click", function (e) {
    e.stopPropagation();
    if (chat.open) { chat.open = false; renderChatDock(); }
    if (Ontap.isOpen()) Ontap.closeOntap();
    if (Thithu.isOpen()) Thithu.closeThithu();
    if (Flashcard.isOpen()) Flashcard.closeFlashcard();
    if (Mindmap.isOpen()) Mindmap.closeMindmap();
    if (Lichbieu.isOpen()) Lichbieu.closeLichbieu();
    Tomtat.openTomtat();
  });
  // UC-26/27/28 Lịch biểu (+ chuông UC-31) — module riêng ghichu_lichbieu.js, loại trừ với mọi công cụ Studio khác.
  $("studio-card-lichbieu").addEventListener("click", function (e) { e.stopPropagation(); openLichbieuTool(); });
  // UC-29/30 Thống kê hiệu suất + Nhận xét AI — module riêng ghichu_thongke.js, loại trừ với mọi công cụ Studio khác.
  $("studio-card-thongke").addEventListener("click", function (e) { e.stopPropagation(); openThongkeTool(); });
  $("chat-back-btn").addEventListener("click", function (e) { e.stopPropagation(); exitChat(); });
  $("studio-chat-new").addEventListener("click", function (e) { e.stopPropagation(); newChat(); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && Chucnang.hasPendingFormatPainter()) Chucnang.cancelFormatPainter();
    if (e.key === "Escape" && state.accountMenuOpen) closeFloating();
    if (e.key === "Escape" && Giaodien.isProfileModalOpen()) Giaodien.closeProfileModal();
    if (e.key === "Escape" && Giaodien.isSettingsModalOpen()) Giaodien.closeSettingsModal();
    // Đang chọn 1 công cụ chú thích PDF (Textbox/Tô màu/Vẽ/Xoá) -> Esc thoát về trạng thái
    // bình thường (không chọn tool nào).
    if (e.key === "Escape" && Soanthao.pdfViewer.open && Soanthao.pdfViewer.tool) Soanthao.exitPdfTool();
  });

  document.addEventListener("click", function () { if (state.dd || state.menu || state.accountMenuOpen) closeFloating(); });

  window.addEventListener("resize", updateWorkspaceCols);
  window.addEventListener("beforeunload", function () { Soanthao.flushActiveChapterEditor(); Soanthao.flushChapterDrawing(); persist(); });

  Soanthao.initSoanthao();
  Chucnang.initChucnangcacthe();
  Review.initReview();
  Giaodien.initGiaodien(Chucnang.openGuideModal);
  Dinhkem.initChatAttach();
  Ontap.initOntap();
  Thithu.initThithu();
  Flashcard.initFlashcard();
  Mindmap.initMindmap();
  Tomtat.initTomtat();
  Lichbieu.initLichbieu();
  Thongbao.initThongbao();   // chuông topbar + tải thông báo nền (dùng chung với chuông Lịch biểu)
  Lichbieu.prepareSample();  // chế độ mẫu: thông báo minh hoạ cho chuông topbar
  Phienhoc.initPhienhoc();
  Thongke.initThongke();
  Chiase.initChiase();       // nút Chia sẻ + hộp chia sẻ + đồng bộ khi cùng sửa (ghichu_chiase.js)
  Hanmuc.initHanmuc();       // UC-33: thanh Dung lượng, dải nhắc, số lượt AI trên thẻ Studio, màn Dọn dung lượng
  bootChatSessions();

  state.open = {};   // vào trang: mọi Môn thu gọn (không mở sẵn danh sách Chương) cho cây Notebook gọn
  renderAll();
  Soanthao.initEditor();
  Soanthao.bootKnowledgeTree();
  Chiase.bootShared();       // "Được chia sẻ với tôi" + mở liên kết ?share= / ?open=
  Ontap.resumeIfNeeded(); // F5 giữa lúc đang làm bài ôn tập -> mở lại đúng câu (UC-21)
  if (!Ontap.isOpen()) Thithu.resumeIfNeeded(); // F5 giữa lúc đang thi thử -> mở lại bài, đúng thời gian còn lại (UC-22)
  if (!Ontap.isOpen() && !Thithu.isOpen()) Flashcard.resumeIfNeeded(); // F5 giữa phiên ôn flashcard -> ôn tiếp đúng thẻ (UC-23)
  if (!Ontap.isOpen() && !Thithu.isOpen() && !Flashcard.isOpen()) Mindmap.resumeIfNeeded(); // F5 khi đang ở khung vẽ sơ đồ (UC-25)
  if (!Ontap.isOpen() && !Thithu.isOpen() && !Flashcard.isOpen() && !Mindmap.isOpen()) Tomtat.resumeIfNeeded(); // F5 khi đang xem 1 bản tóm tắt (UC-24)
  if (!isFullPaneTool()) Lichbieu.resumeIfNeeded(); // F5 khi đang ở Lịch biểu -> mở lại đúng chế độ xem + ngày (UC-27)
  if (!isFullPaneTool()) Thongke.resumeIfNeeded(); // F5 khi đang ở Thống kê -> mở lại đúng trang + khoảng thời gian (UC-29)
  if (!isFullPaneTool()) Hanmuc.resumeIfNeeded(); // F5 khi đang ở Dọn dung lượng (UC-33)
}

try { init(); }
finally { document.documentElement.classList.remove("app-booting"); }   // hiện trang (xem <head> ghichu.html)
