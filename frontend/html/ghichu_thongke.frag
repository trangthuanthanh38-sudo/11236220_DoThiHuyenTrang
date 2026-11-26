<!-- ======================================================================
     ghichu_thongke.frag — MODULE "Thống kê hiệu suất" (UC-29 + Nhận xét AI UC-30). Nạp vào #mount-thongke-pane
     (trong <main class="editor-pane"> của ghichu.html) bằng loadFragment() đầu js/ghichu.js. Logic:
     js/ghichu_thongke.js, style: css/ghichu_thongke.css (tiền tố `tk-`, mọi selector nằm dưới .tk-pane).
     Bố cục GIỮ NGUYÊN mẫu `thong-ke.html`: thanh trái navy (Tổng quan → Hôm nay / Hoạt động / Kết quả học tập /
     So sánh môn / Nhận xét AI / Lịch sử tiến bộ, Notebook, Cài đặt, Hỗ trợ), thanh trên (× về Notebook + breadcrumb
     + chuông + tài khoản), vùng nội dung do JS vẽ. Khi mở: cột 1, cột 3 và Topbar soạn thảo được ẩn — xem
     syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="tk-pane" id="tk-pane" hidden>
  <aside class="sb" id="tk-sb"></aside>
  <header class="top">
    <button type="button" class="tk-close" id="tk-close" aria-label="Đóng" title="Về Notebook">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <!-- Responsive (< 1024px): mở thanh menu trái dạng ngăn kéo — css/responsive.css + initThongke() -->
    <button type="button" class="tk-menu" id="tk-menu" aria-label="Mở menu Thống kê" aria-controls="tk-sb" aria-expanded="false">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>
    </button>
    <div class="crumb" id="tk-crumb"></div>
    <button type="button" class="bell" id="tk-bell" aria-label="Thông báo" title="Thông báo (Lịch biểu)"><svg width="16" height="18" viewBox="0 0 20 22" fill="none"><path d="M10 2a6 6 0 0 0-6 6v4.2L2.4 15.4c-.3.6.1 1.3.8 1.3h13.6c.7 0 1.1-.7.8-1.3L16 12.2V8a6 6 0 0 0-6-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.6 19.2a2.6 2.6 0 0 0 4.8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <div class="user" id="tk-user"></div>
  </header>
  <main id="tk-main"></main>
  <div class="tk-scrim" id="tk-scrim"></div>
  <div class="chart-tip" id="tk-tip" hidden></div>
  <div class="toast" id="tk-toast" hidden></div>
  <div class="modal-bg" id="tk-modal" hidden></div>
</div>
