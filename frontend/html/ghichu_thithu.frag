<!-- ======================================================================
     ghichu_thithu.frag — MODULE "Tạo đề thi thử" (UC-22, Studio AI). Nạp vào
     #mount-thithu-pane (trong <main class="editor-pane"> của ghichu.html) bằng
     loadFragment() đầu js/ghichu.js. Logic: js/ghichu_thithu.js, style:
     css/ghichu_thithu.css. Bố cục theo giao diện mẫu desktop-6-thi-thu (moi).html — cùng khuôn
     với "Tạo câu hỏi ôn tập" (ghichu_ontap.frag): thanh trên (× + tiêu đề + "Tạo đề thi"), tab
     Tạo mới / Đã tạo dưới dòng kẻ, 5 màn Tạo mới / Đã tạo / Làm bài thi / Xem lại 1 câu / Kết quả
     + hộp xác nhận nộp bài. Phần form Tạo mới dùng chung JS với Ôn tập (ghichu_studio_form.js) nên
     các id `thithu-subject-*`, `-src-*`, `-name`, `-count*`, `-diff-*`, `-levels`, `-b0..2`,
     `-panel`, `-create`, `-main`, `-new` phải giữ đúng tên. Khi mở: cột 1, cột 3 và Topbar soạn
     thảo được ẩn — xem syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="tt-pane" id="thithu-pane" hidden>
  <div class="tt-head">
    <!-- Đóng: Tạo mới/Đã tạo -> về Notebook; đang thi -> về Đã tạo (đồng hồ vẫn chạy); xem lại 1 câu -> Kết quả -->
    <button type="button" class="tt-close" id="thithu-back-btn" aria-label="Đóng" title="Đóng">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <div class="tt-head-titles">
      <h1 class="tt-title" id="thithu-title">Tạo đề thi thử</h1>
    </div>
    <!-- Tab Tạo mới / Đã tạo nằm TRÊN thanh trên, ngay sau tiêu đề (cùng khuôn Tóm tắt); ẩn khi làm bài / xem -->
    <div class="tt-tabbar" id="thithu-tabbar">
      <div class="tt-tabs" id="thithu-tabs" role="tablist">
        <button type="button" role="tab" data-tab="new" class="on"><span>Tạo mới</span></button>
        <button type="button" role="tab" data-tab="saved"><span>Đã tạo <i id="thithu-saved-count"></i></span></button>
    </div>
    </div>
    <div class="tt-head-right">
      <button type="button" class="tt-btn-primary" id="thithu-create">Tạo đề thi</button>
      <span class="tt-head-note" id="thithu-head-note" hidden></span>
    </div>
  </div>

  <div class="tt-body" id="thithu-body">
    <!-- ===== TẠO MỚI ===== -->
    <section class="tt-screen" id="thithu-s-setup">
      <div class="tt-form" id="thithu-new">
        <div class="tt-main" id="thithu-main">
          <div class="tt-box">
            <div class="tt-box-head">
              <span class="tt-lbl">Nguồn nội dung</span>
              <div class="tt-select">
                <button type="button" id="thithu-subject-btn" aria-haspopup="listbox"><span class="tt-muted">Môn:</span><b id="thithu-subject-name"></b>
                  <svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                <div class="tt-menu" id="thithu-subject-menu" hidden></div>
              </div>
            </div>
            <div class="tt-chips" id="thithu-src-list"></div>
            <div class="tt-row-between tt-muted"><span class="tt-ell">Chỉ chọn các Chương / tệp PDF trong cùng một môn</span><span class="tt-nowrap" id="thithu-src-summary"></span></div>
          </div>

          <div class="tt-fields">
            <label class="tt-field tt-f-name" id="thithu-f-name">
              <span class="tt-lbl">Tên đề thi (bắt buộc)</span>
              <input id="thithu-name" autocomplete="off" maxlength="200" placeholder="Nhập tên đề thi">
            </label>
            <label class="tt-field tt-f-count" id="thithu-f-count">
              <span class="tt-lbl">Số câu hỏi</span>
              <span class="in"><input id="thithu-count" inputmode="numeric" autocomplete="off" value="20"><span class="tt-muted">câu</span></span>
            </label>
          </div>
          <div class="tt-hint-pill" id="thithu-count-hint"></div>
          <div class="tt-error" id="thithu-count-err" hidden></div>

          <div class="tt-box" id="thithu-diff-box">
            <div class="tt-box-head">
              <span class="tt-lbl">Phân bổ độ khó</span>
              <div class="tt-seg" id="thithu-diff-mode">
                <button type="button" data-v="auto" class="on">Theo khuyến nghị</button>
                <button type="button" data-v="custom">Tự điều chỉnh</button>
              </div>
            </div>
            <div class="tt-levels" id="thithu-levels"></div>
            <div class="tt-dist"><i class="c1" id="thithu-b0"></i><i class="c2" id="thithu-b1"></i><i class="c3" id="thithu-b2"></i></div>
            <div class="tt-muted" id="thithu-diff-note"></div>
          </div>
        </div>

        <div class="tt-side" id="thithu-side">
          <div class="tt-box"><div class="tt-box-head"><span class="tt-h3">Chế độ</span><span class="tt-pill">Thi thử</span></div></div>
          <div class="tt-box tt-box--tight">
            <span class="tt-lbl">Thời gian làm bài</span>
            <div class="tt-types tt-durs" id="thithu-duration">
              <button type="button" data-v="15">15 phút</button>
              <button type="button" data-v="30" class="on">30 phút</button>
              <button type="button" data-v="45">45 phút</button>
              <button type="button" data-v="60">60 phút</button>
            </div>
          </div>
          <div class="tt-box tt-box--tight">
            <span class="tt-h3">Quy định thi thử</span>
            <ul class="tt-rules">
              <li>Đáp án chỉ hiện sau khi nộp bài</li>
              <li>Hết giờ sẽ tự động nộp bài</li>
              <li>Mỗi đề chỉ làm một lần</li>
            </ul>
          </div>
          <div class="tt-box tt-panel" id="thithu-panel"></div>
        </div>
      </div>
    </section>

    <!-- ===== ĐÃ TẠO ===== -->
    <section class="tt-screen" id="thithu-s-saved" hidden>
      <!-- Đã tạo dạng THẺ (cùng khuôn Tóm tắt) — js/ghichu_cardlist.js vẽ thanh trên + lưới -->
      <div class="tt-list cl-clist">
        <div id="thithu-saved-bar"></div>
        <div id="thithu-saved-list"></div>
      </div>
    </section>

    <!-- ===== LÀM BÀI THI (cuộn dọc) ===== -->
    <section class="tt-screen" id="thithu-s-exam" hidden>
      <div class="tt-exam">
        <div class="tt-exam-main">
          <div class="tt-notice" id="thithu-offline" hidden><p>Mất kết nối. Bài làm đang được lưu trên máy, bạn vẫn làm tiếp được trong thời gian còn lại.</p></div>
          <div class="tt-notice plain" id="thithu-reduced" hidden><p id="thithu-reduced-text"></p><button type="button" id="thithu-reduced-close">Đóng</button></div>
          <div>
            <div class="tt-progress-head"><b id="thithu-q-pos"></b><span id="thithu-q-done"></span></div>
            <div class="tt-bar"><i id="thithu-q-bar"></i></div>
          </div>
          <div>
            <div class="tt-muted" id="thithu-q-meta"></div>
            <div class="tt-q-text" id="thithu-q-text"></div>
          </div>
          <div class="tt-options" id="thithu-options"></div>
          <button type="button" class="tt-flag" id="thithu-flag">⚑  Đánh dấu để xem lại</button>
          <div class="tt-quiz-foot">
            <button type="button" class="tt-btn-text" id="thithu-prev">‹  Câu trước</button>
            <button type="button" class="tt-btn-secondary" id="thithu-next">Câu tiếp theo  ›</button>
          </div>
        </div>
        <aside class="tt-sidebar">
          <div class="tt-timer" id="thithu-timer-box"><div class="tt-muted">Thời gian còn lại</div><div class="v" id="thithu-timer">30:00</div></div>
          <div class="tt-tbar"><i id="thithu-tbar"></i></div>
          <div class="tt-grid" id="thithu-grid"></div>
          <div class="tt-key-legend">
            <span><i class="d"></i>Đã trả lời</span>
            <span><i></i>Chưa trả lời</span>
            <span><i class="f"></i>Đánh dấu xem lại</span>
          </div>
          <button type="button" class="tt-btn-primary" id="thithu-submit">Nộp bài</button>
        </aside>
      </div>
    </section>

    <!-- ===== XEM LẠI 1 CÂU SAU KHI NỘP (cuộn dọc) ===== -->
    <section class="tt-screen" id="thithu-s-review" hidden>
      <div class="tt-quiz">
        <div>
          <div class="tt-progress-head"><b id="thithu-v-pos"></b><span id="thithu-v-meta"></span></div>
          <div class="tt-bar"><i id="thithu-v-bar"></i></div>
        </div>
        <div class="tt-q-text" id="thithu-v-text"></div>
        <div class="tt-options" id="thithu-v-options"></div>
        <div class="tt-explain">
          <span class="tt-h3">Giải thích</span>
          <div class="tt-explain-text" id="thithu-v-ex"></div>
          <!-- #thithu-v-src: bấm được khi nguồn còn tồn tại -> mở đúng Chương / PDF tại trang (như UC-20 5a) -->
          <div class="tt-cite" id="thithu-v-cite"><div><q id="thithu-v-quote"></q><button type="button" class="tt-src-link" id="thithu-v-src"></button></div></div>
          <button type="button" class="gopy-link" id="thithu-v-report">Báo nội dung sai</button>
        </div>
        <div class="tt-quiz-foot">
          <button type="button" class="tt-btn-text" id="thithu-v-prev">‹  Câu trước</button>
          <div class="tt-quiz-foot-right">
            <button type="button" class="tt-btn-secondary" id="thithu-v-result">Kết quả</button>
            <button type="button" class="tt-btn-primary" id="thithu-v-next">Câu tiếp theo</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== KẾT QUẢ THI ===== -->
    <section class="tt-screen" id="thithu-s-result" hidden>
      <!-- 1 cột, cùng khuôn màn "Hoàn thành phiên ôn" của Flashcard -->
      <div class="tt-done">
        <div class="tt-notice plain" id="thithu-timeout-note" hidden><p id="thithu-timeout-text"></p></div>
        <div class="tt-score">
          <div class="k">Kết quả thi thử</div>
          <div class="v" id="thithu-r-score"></div>
          <div class="m" id="thithu-r-meta"></div>
        </div>
        <div class="tt-stats">
          <div class="tt-stat ok"><div class="k">Đúng</div><div class="v" id="thithu-r-ok"></div><div class="s" id="thithu-r-ok-s"></div></div>
          <div class="tt-stat no"><div class="k">Sai</div><div class="v" id="thithu-r-no"></div><div class="s" id="thithu-r-no-s"></div></div>
          <div class="tt-stat skip"><div class="k">Chưa làm</div><div class="v" id="thithu-r-skip"></div><div class="s" id="thithu-r-skip-s"></div></div>
          <div class="tt-stat navy"><div class="k">Thời gian làm</div><div class="v" id="thithu-r-time"></div><div class="s" id="thithu-r-time-s"></div></div>
        </div>
        <div class="tt-rev">
          <div class="tt-review-head"><span class="tt-h3">Đáp án và giải thích</span>
            <div class="tt-rh-right">
              <button type="button" class="tt-toggle-wrong" id="thithu-only-wrong">Chỉ hiện câu sai</button>
              <span id="thithu-per"></span>
              <span class="tt-pg" id="thithu-pager"><button type="button" id="thithu-pg-prev" aria-label="Trang trước">‹</button><span id="thithu-pg-info"></span><button type="button" id="thithu-pg-next" aria-label="Trang sau">›</button></span>
            </div>
          </div>
          <div class="tt-rlist" id="thithu-ans-list"></div>
        </div>
        <div class="tt-done-foot">
          <p class="tt-muted">Đề thi thử chỉ làm được một lần. Tạo đề mới hoặc “Làm lại” ở tab Đã tạo để thi tiếp.</p>
          <button type="button" class="tt-btn-secondary" id="thithu-to-list">Về danh sách</button>
          <button type="button" class="tt-btn-primary" id="thithu-new-exam">Tạo đề mới</button>
        </div>
      </div>
    </section>
  </div>

  <!-- ===== HỘP XÁC NHẬN NỘP BÀI ===== -->
  <div class="tt-overlay" id="thithu-confirm" hidden>
    <div class="tt-modal" role="dialog" aria-modal="true" aria-labelledby="thithu-m-title">
      <span class="tt-h3" id="thithu-m-title">Nộp bài thi?</span>
      <p class="tt-muted" id="thithu-m-text"></p>
      <div class="tt-mbox">
        <div><span>Đã trả lời</span><b id="thithu-m-done"></b></div>
        <div><span>Thời gian còn lại</span><b id="thithu-m-time"></b></div>
      </div>
      <div class="tt-mfoot">
        <button type="button" class="tt-btn-secondary" id="thithu-m-cancel">Tiếp tục làm</button>
        <button type="button" class="tt-btn-primary" id="thithu-m-submit">Nộp bài</button>
      </div>
    </div>
  </div>
  <div class="tt-toast" id="thithu-toast" hidden></div>
</div>
