<!-- ======================================================================
     ghichu_mindmap.frag — MODULE "Tạo sơ đồ tư duy" (UC-25, Studio AI). Nạp vào
     #mount-mindmap-pane (trong <main class="editor-pane"> của ghichu.html) bằng loadFragment() đầu
     js/ghichu.js. Logic: js/ghichu_mindmap.js, style: css/ghichu_mindmap.css. Bố cục theo giao diện
     mẫu `so-do-tu-duy.html` — cùng khuôn với Ôn tập / Thi thử / Flashcard: thanh trên (× + tiêu đề +
     "Tạo sơ đồ"), tab Tạo mới / Đã tạo dưới dòng kẻ, 3 màn Tạo mới / Đã tạo / Khung vẽ. Phần form Tạo
     mới dùng chung JS (ghichu_studio_form.js, tuỳ chọn count:false) nên các id `mm-pane`,
     `mm-subject-*`, `mm-src-*`, `mm-name`, `mm-f-name`, `mm-count-err`, `mm-panel`, `mm-create`,
     `mm-main`, `mm-new` phải giữ đúng tên. Khi mở: cột 1, cột 3 và Topbar soạn thảo được ẩn — xem
     syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="mm-pane" id="mm-pane" hidden>
  <div class="mm-head">
    <!-- Đóng: Tạo mới/Đã tạo -> về Notebook; khung vẽ -> Đã tạo -->
    <button type="button" class="mm-close" id="mm-back-btn" aria-label="Đóng" title="Đóng">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <div class="mm-head-titles">
      <h1 class="mm-title" id="mm-title">Tạo sơ đồ tư duy</h1>
      <!-- Khung vẽ: tên sơ đồ sửa tại chỗ (mindmaps.title) -->
      <input class="mm-title-in" id="mm-map-name" maxlength="200" aria-label="Tên sơ đồ" hidden>
    </div>
    <!-- Tab Tạo mới / Đã tạo nằm TRÊN thanh trên, ngay sau tiêu đề (cùng khuôn Tóm tắt); ẩn khi làm bài / xem -->
    <div class="mm-tabbar" id="mm-tabbar">
      <div class="mm-tabs" id="mm-tabs" role="tablist">
        <button type="button" role="tab" data-tab="new" class="on"><span>Tạo mới</span></button>
        <button type="button" role="tab" data-tab="saved"><span>Đã tạo <i id="mm-saved-count"></i></span></button>
    </div>
    </div>
    <div class="mm-head-right">
      <span class="mm-saved" id="mm-saved" hidden></span>
      <button type="button" class="mm-btn-primary" id="mm-create">Tạo sơ đồ</button>
      <button type="button" class="mm-btn-primary" id="mm-done" hidden>Xong</button>
    </div>
  </div>

  <div class="mm-body" id="mm-body">
    <!-- ===== TẠO MỚI ===== -->
    <section class="mm-screen" id="mm-s-setup">
      <div class="mm-form" id="mm-new">
        <div class="mm-main" id="mm-main">
          <div class="mm-box">
            <div class="mm-box-head">
              <span class="mm-lbl">Nguồn nội dung</span>
              <div class="mm-select">
                <button type="button" id="mm-subject-btn" aria-haspopup="listbox"><span class="mm-muted">Môn:</span><b id="mm-subject-name"></b>
                  <svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                <div class="mm-menu" id="mm-subject-menu" hidden></div>
              </div>
            </div>
            <div class="mm-chips" id="mm-src-list"></div>
            <div class="mm-row-between mm-muted"><span class="mm-ell">Mỗi Chương / tệp PDF là một nhánh lớn của sơ đồ</span><span class="mm-nowrap" id="mm-src-summary"></span></div>
          </div>
          <div class="mm-error" id="mm-count-err" hidden></div>

          <div class="mm-row2">
            <label class="mm-field mm-f-name" id="mm-f-name">
              <span class="mm-lbl">Tên sơ đồ (bắt buộc)</span>
              <input id="mm-name" autocomplete="off" maxlength="200" placeholder="Nhập tên sơ đồ">
            </label>
            <!-- mindmaps.depth (2-4) -->
            <div class="mm-depth">
              <span class="mm-lbl">Độ sâu mỗi chương</span>
              <div class="mm-seg" id="mm-depth-seg">
                <button type="button" data-v="2">2 cấp</button><button type="button" data-v="3" class="on">3 cấp</button><button type="button" data-v="4">4 cấp</button>
              </div>
            </div>
          </div>
          <div class="mm-muted mm-depth-note" id="mm-depth-note"></div>

          <!-- mindmaps.build_method -->
          <div class="mm-box" id="mm-method-box">
            <span class="mm-lbl">Dựng khung sơ đồ từ</span>
            <button type="button" class="mm-opt-row on" data-v="headings" role="radio" aria-checked="true">
              <span class="mm-radio"></span>
              <span class="txt"><b>Tiêu đề có sẵn trong tài liệu</b><small>Nhanh, bám sát bố cục của chương</small></span>
              <span class="mm-tagp">Khuyên dùng</span>
            </button>
            <button type="button" class="mm-opt-row" data-v="auto" role="radio" aria-checked="false">
              <span class="mm-radio"></span>
              <span class="txt"><b>Hệ thống tự phân tích nội dung</b><small>Dùng khi tài liệu không có tiêu đề rõ ràng</small></span>
            </button>
          </div>
        </div>

        <div class="mm-side" id="mm-side">
          <!-- mindmaps.layout -->
          <div class="mm-box" id="mm-layout-box">
            <span class="mm-h3">Bố cục hiển thị</span>
            <div class="mm-layouts" id="mm-layout-seg"><button type="button" data-v="tree" class="on">Cây ngang</button><button type="button" data-v="radial">Tỏa tròn</button></div>
          </div>
          <!-- mindmaps.show_citation / ask_qa -->
          <div class="mm-box" id="mm-opts">
            <span class="mm-h3">Khi bấm vào node</span>
            <button type="button" class="mm-sw-row on" data-k="showCite" aria-pressed="true">Hiện trích dẫn nguồn<span class="mm-sw"></span></button>
            <button type="button" class="mm-sw-row on" data-k="askQA" aria-pressed="true">Mở hỏi đáp về chủ đề<span class="mm-sw"></span></button>
          </div>
          <div class="mm-box mm-panel" id="mm-panel"></div>
        </div>
      </div>
    </section>

    <!-- ===== ĐÃ TẠO ===== -->
    <section class="mm-screen" id="mm-s-saved" hidden>
      <!-- Đã tạo dạng THẺ (cùng khuôn Tóm tắt) — js/ghichu_cardlist.js vẽ thanh trên + lưới -->
      <div class="mm-list cl-clist">
        <div id="mm-saved-bar"></div>
        <div id="mm-saved-list"></div>
      </div>
    </section>

    <!-- ===== KHUNG VẼ SƠ ĐỒ ===== -->
    <section class="mm-screen mm-screen--canvas" id="mm-s-canvas" hidden>
      <div class="mm-canvas" id="mm-canvas">
        <div class="mm-world" id="mm-world"><svg class="mm-edges" id="mm-edges"></svg><div id="mm-nodes"></div></div>
        <div class="mm-toolbar">
          <button type="button" id="mm-z-out" aria-label="Thu nhỏ">−</button><span class="zv" id="mm-z-val">100%</span><button type="button" id="mm-z-in" aria-label="Phóng to">+</button>
          <span class="sep"></span>
          <button type="button" id="mm-fit">Căn giữa</button>
          <span class="sep"></span>
          <button type="button" class="hist" id="mm-undo" title="Hoàn tác (Ctrl+Z)" aria-label="Hoàn tác" disabled>↶</button><button type="button" class="hist" id="mm-redo" title="Làm lại (Ctrl+Y)" aria-label="Làm lại" disabled>↷</button>
          <button type="button" class="add" id="mm-add-node">+ Thêm node</button>
        </div>
        <!-- UC-25 E1: mindmaps.is_flat -->
        <div class="mm-cnotice" id="mm-flat-notice" hidden>
          <p>Nội dung không có cấu trúc phân cấp rõ ràng nên sơ đồ chỉ gồm một cấp. Chất lượng sơ đồ có thể hạn chế.</p>
          <button type="button" id="mm-pick-other">Chọn nguồn khác</button>
        </div>
        <div class="mm-chint">Kéo thả để di chuyển node · nhấn đúp để sửa nội dung · Ctrl+Z hoàn tác · Ctrl+Y làm lại</div>
        <div class="mm-npanel" id="mm-npanel" hidden>
          <button type="button" class="x" id="mm-np-close" aria-label="Đóng">×</button>
          <span class="mm-h3">Node đang chọn</span>
          <input id="mm-np-text" maxlength="500" aria-label="Nội dung node">
          <div class="kv"><span>Cấp</span><b id="mm-np-level"></b></div>
          <div class="kv"><span>Thuộc nhánh</span><b id="mm-np-branch"></b></div>
          <!-- Trích dẫn (BR-09) — bấm được khi nguồn còn tồn tại -> mở đúng Chương / PDF tại trang -->
          <button type="button" class="src" id="mm-np-src"><span class="mm-muted">Nguồn</span><b id="mm-np-src-text"></b></button>
          <button type="button" class="gopy-link" id="mm-np-report">Báo nội dung sai</button>
          <button type="button" class="mm-btn-secondary" id="mm-np-ask">Hỏi về chủ đề này</button>
          <div class="acts"><button type="button" class="mm-link" id="mm-np-add">+ Thêm nhánh con</button><button type="button" class="del" id="mm-np-del">Xóa node</button></div>
        </div>
      </div>
    </section>
  </div>
  <div class="mm-toast" id="mm-toast" hidden></div>
</div>
