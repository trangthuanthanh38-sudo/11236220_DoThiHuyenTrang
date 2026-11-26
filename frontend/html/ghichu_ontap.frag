<!-- ======================================================================
     ghichu_ontap.frag — MODULE "Tạo câu hỏi ôn tập" (UC-21, Studio AI). Nạp vào
     #mount-ontap-pane (trong <main class="editor-pane"> của ghichu.html) bằng
     loadFragment() đầu js/ghichu.js. Logic: js/ghichu_ontap.js, style:
     css/ghichu_ontap.css. Bố cục theo giao diện mẫu on-tap-tao-moi.html (thanh trên có
     nút đóng + tab Tạo mới / Đã tạo; 4 màn Tạo mới / Đã tạo / Làm bài / Kết quả). Khi mở:
     cột 1 (Notebooks), cột 3 (Studio) và Topbar soạn thảo được ẩn — xem
     syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="ontap-pane" id="ontap-pane" hidden>
  <div class="ontap-head">
    <!-- Đóng: màn Tạo mới/Đã tạo -> về Notebook; đang làm bài / kết quả -> về danh sách (xem ghichu_ontap.js) -->
    <button type="button" class="ontap-close" id="ontap-back-btn" aria-label="Đóng" title="Đóng">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <div class="ontap-head-titles">
      <h1 class="ontap-title" id="ontap-title">Tạo câu hỏi ôn tập</h1>
    </div>
    <!-- Tab Tạo mới / Đã tạo nằm TRÊN thanh trên, ngay sau tiêu đề (cùng khuôn Tóm tắt); ẩn khi làm bài / xem -->
    <div class="ontap-tabbar" id="ontap-tabbar">
      <div class="ontap-tabs" id="ontap-tabs" role="tablist">
        <button type="button" role="tab" data-tab="new" class="on"><span>Tạo mới</span></button>
        <button type="button" role="tab" data-tab="saved"><span>Đã tạo <i id="ontap-saved-count"></i></span></button>
    </div>
    </div>
    <div class="ontap-head-right">
      <button type="button" class="ontap-btn-primary" id="ontap-create">Tạo bộ câu hỏi</button>
      <span class="ontap-head-note" id="ontap-head-note" hidden>Không giới hạn thời gian</span>
    </div>
  </div>

  <div class="ontap-body">
    <!-- ===== TẠO MỚI ===== -->
    <section class="ontap-screen" id="ontap-s-setup">
      <div class="ontap-form" id="ontap-new">
        <div class="ontap-main" id="ontap-main">
          <div class="ontap-box">
            <div class="ontap-box-head">
              <span class="ontap-lbl">Nguồn nội dung</span>
              <div class="ontap-select">
                <button type="button" id="ontap-subject-btn" aria-haspopup="listbox"><span class="ontap-muted">Môn:</span><b id="ontap-subject-name"></b>
                  <svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                <div class="ontap-menu" id="ontap-subject-menu" hidden></div>
              </div>
            </div>
            <div class="ontap-chips" id="ontap-src-list"></div>
            <div class="ontap-row-between ontap-muted"><span class="ontap-ell">Chỉ chọn các Chương / tệp PDF trong cùng một môn</span><span class="ontap-nowrap" id="ontap-src-summary"></span></div>
          </div>

          <div class="ontap-fields">
            <label class="ontap-field ontap-f-name" id="ontap-f-name">
              <span class="ontap-lbl">Tên bộ câu hỏi (bắt buộc)</span>
              <input id="ontap-name" autocomplete="off" maxlength="200" placeholder="Nhập tên bộ câu hỏi">
            </label>
            <label class="ontap-field ontap-f-count" id="ontap-f-count">
              <span class="ontap-lbl">Số câu hỏi</span>
              <span class="in"><input id="ontap-count" inputmode="numeric" autocomplete="off" value="10"><span class="ontap-muted">câu</span></span>
            </label>
          </div>
          <div class="ontap-hint-pill" id="ontap-count-hint"></div>
          <div class="ontap-error" id="ontap-count-err" hidden></div>

          <div class="ontap-box" id="ontap-diff-box">
            <div class="ontap-box-head">
              <span class="ontap-lbl">Phân bổ độ khó</span>
              <div class="ontap-seg" id="ontap-diff-mode">
                <button type="button" data-v="auto" class="on">Theo khuyến nghị</button>
                <button type="button" data-v="custom">Tự điều chỉnh</button>
              </div>
            </div>
            <div class="ontap-levels" id="ontap-levels"></div>
            <div class="ontap-dist"><i class="c1" id="ontap-b0"></i><i class="c2" id="ontap-b1"></i><i class="c3" id="ontap-b2"></i></div>
            <div class="ontap-muted" id="ontap-diff-note"></div>
          </div>
        </div>

        <div class="ontap-side" id="ontap-side">
          <div class="ontap-box"><div class="ontap-box-head"><span class="ontap-h3">Chế độ</span><span class="ontap-pill">Ôn tập</span></div></div>
          <div class="ontap-box ontap-box--tight">
            <span class="ontap-lbl">Dạng câu hỏi</span>
            <div class="ontap-types" id="ontap-types">
              <button type="button" data-v="single" class="on">Một đáp án</button>
              <button type="button" data-v="multi">Nhiều đáp án</button>
            </div>
          </div>
          <div class="ontap-box" id="ontap-after">
            <span class="ontap-h3">Sau mỗi câu</span>
            <button type="button" class="ontap-sw-row on" data-k="showAnswer" aria-pressed="true">Hiện đáp án đúng<span class="ontap-sw"></span></button>
            <button type="button" class="ontap-sw-row on" data-k="showExplain" aria-pressed="true">Hiện giải thích<span class="ontap-sw"></span></button>
            <button type="button" class="ontap-sw-row on" data-k="showCite" aria-pressed="true">Hiện trích dẫn nguồn<span class="ontap-sw"></span></button>
          </div>
          <div class="ontap-box ontap-panel" id="ontap-panel"></div>
        </div>
      </div>
    </section>

    <!-- ===== ĐÃ TẠO ===== -->
    <section class="ontap-screen" id="ontap-s-saved" hidden>
      <!-- Đã tạo dạng THẺ (cùng khuôn Tóm tắt) — js/ghichu_cardlist.js vẽ thanh trên + lưới -->
      <div class="ontap-list cl-clist">
        <div id="ontap-saved-bar"></div>
        <div id="ontap-saved-list"></div>
      </div>
    </section>

    <!-- ===== LÀM BÀI (cuộn dọc) ===== -->
    <section class="ontap-screen" id="ontap-s-quiz" hidden>
      <div class="ontap-quiz">
        <div class="ontap-notice" id="ontap-notice" hidden>
          <p id="ontap-notice-text"></p>
          <button type="button" id="ontap-notice-close">Đóng</button>
        </div>
        <div>
          <div class="ontap-progress-head"><b id="ontap-q-pos"></b><span id="ontap-q-meta"></span></div>
          <div class="ontap-bar"><i id="ontap-q-bar"></i></div>
        </div>
        <div class="ontap-q-text" id="ontap-q-text"></div>
        <div class="ontap-options" id="ontap-options"></div>
        <div class="ontap-explain" id="ontap-explain" hidden>
          <span class="ontap-h3" id="ontap-ex-title">Giải thích</span>
          <div class="ontap-explain-text" id="ontap-ex-text"></div>
          <!-- #ontap-ex-src: nút bấm được khi nguồn còn tồn tại -> mở đúng Chương / PDF tại trang (như UC-20 5a) -->
          <div class="ontap-cite" id="ontap-ex-cite"><div><q id="ontap-ex-quote"></q><button type="button" class="ontap-src-link" id="ontap-ex-src"></button></div></div>
          <!-- UC-35: gửi góp ý "Nội dung AI sai" kèm câu hỏi này (js/ghichu_gopy.js) -->
          <button type="button" class="gopy-link" id="ontap-ex-report">Báo nội dung sai</button>
        </div>
        <div class="ontap-quiz-foot">
          <button type="button" class="ontap-btn-text" id="ontap-prev">‹  Câu trước</button>
          <div class="ontap-quiz-foot-right">
            <span class="ontap-pick-hint" id="ontap-pick-hint"></span>
            <button type="button" class="ontap-btn-secondary" id="ontap-to-result" hidden>Kết quả</button>
            <button type="button" class="ontap-btn-primary" id="ontap-next">Câu tiếp theo</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== KẾT QUẢ ===== -->
    <section class="ontap-screen" id="ontap-s-result" hidden>
      <!-- 1 cột, cùng khuôn màn "Hoàn thành phiên ôn" của Flashcard -->
      <div class="ontap-done">
        <div class="ontap-score">
          <div class="k">Hoàn thành bài ôn tập</div>
          <div class="v" id="ontap-r-score"></div>
          <div class="m" id="ontap-r-meta"></div>
        </div>
        <div class="ontap-stats">
          <div class="ontap-stat ok"><div class="k">Đúng</div><div class="v" id="ontap-r-ok"></div><div class="s" id="ontap-r-ok-s"></div></div>
          <div class="ontap-stat no"><div class="k">Sai</div><div class="v" id="ontap-r-no"></div><div class="s" id="ontap-r-no-s"></div></div>
          <div class="ontap-stat navy"><div class="k">Điểm cao nhất</div><div class="v" id="ontap-r-best"></div><div class="s" id="ontap-r-best-s"></div></div>
          <div class="ontap-stat skip"><div class="k">Thời gian làm</div><div class="v" id="ontap-r-time"></div><div class="s">Không giới hạn thời gian</div></div>
        </div>
        <div class="ontap-rev">
          <div class="ontap-review-head"><span class="ontap-h3">Xem lại từng câu</span>
            <div class="ontap-rh-right">
              <button type="button" class="ontap-toggle-wrong" id="ontap-only-wrong">Chỉ hiện câu sai</button>
              <span id="ontap-per"></span>
              <span class="ontap-pg" id="ontap-pager"><button type="button" id="ontap-pg-prev" aria-label="Trang trước">‹</button><span id="ontap-pg-info"></span><button type="button" id="ontap-pg-next" aria-label="Trang sau">›</button></span>
            </div>
          </div>
          <div class="ontap-rlist" id="ontap-review-list"></div>
        </div>
        <div class="ontap-done-foot">
          <p class="ontap-muted" id="ontap-r-note"></p>
          <button type="button" class="ontap-btn-secondary" id="ontap-to-list">Về danh sách</button>
          <button type="button" class="ontap-btn-primary" id="ontap-retry">Làm lại</button>
        </div>
      </div>
    </section>
  </div>
  <div class="ontap-toast" id="ontap-toast" hidden></div>
</div>
