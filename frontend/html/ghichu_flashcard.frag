<!-- ======================================================================
     ghichu_flashcard.frag — MODULE "Tạo flashcard" (UC-23, Studio AI). Nạp vào
     #mount-flashcard-pane (trong <main class="editor-pane"> của ghichu.html) bằng
     loadFragment() đầu js/ghichu.js. Logic: js/ghichu_flashcard.js, style:
     css/ghichu_flashcard.css. Bố cục theo giao diện mẫu `flashcard mới.html` — cùng khuôn với
     Ôn tập / Thi thử: thanh trên (× + tiêu đề + "Tạo bộ thẻ"), tab Tạo mới / Đã tạo dưới dòng kẻ,
     5 màn Tạo mới / Đã tạo / Ôn thẻ / Xem lại 1 thẻ / Hoàn thành phiên ôn. Phần form Tạo mới dùng
     chung JS với Ôn tập/Thi thử (ghichu_studio_form.js) nên các id `fc-pane`, `fc-subject-*`,
     `fc-src-*`, `fc-name`, `fc-f-*`, `fc-count*`, `fc-panel`, `fc-create`, `fc-main`, `fc-new` phải
     giữ đúng tên. Khi mở: cột 1, cột 3 và Topbar soạn thảo được ẩn — xem
     syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="fc-pane" id="fc-pane" hidden>
  <div class="fc-head">
    <!-- Đóng: Tạo mới/Đã tạo -> về Notebook; đang ôn -> hỏi rồi bỏ phiên; xem lại 1 thẻ -> Hoàn thành; Hoàn thành -> Đã tạo -->
    <button type="button" class="fc-close" id="fc-back-btn" aria-label="Đóng" title="Đóng">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <div class="fc-head-titles">
      <h1 class="fc-title" id="fc-title">Tạo flashcard</h1>
    </div>
    <!-- Tab Tạo mới / Đã tạo nằm TRÊN thanh trên, ngay sau tiêu đề (cùng khuôn Tóm tắt); ẩn khi làm bài / xem -->
    <div class="fc-tabbar" id="fc-tabbar">
      <div class="fc-tabs" id="fc-tabs" role="tablist">
        <button type="button" role="tab" data-tab="new" class="on"><span>Tạo mới</span></button>
        <button type="button" role="tab" data-tab="saved"><span>Đã tạo <i id="fc-saved-count"></i></span></button>
    </div>
    </div>
    <div class="fc-head-right">
      <button type="button" class="fc-btn-primary" id="fc-create">Tạo bộ thẻ</button>
      <span class="fc-head-note" id="fc-head-note" hidden></span>
    </div>
  </div>

  <div class="fc-body" id="fc-body">
    <!-- ===== TẠO MỚI ===== -->
    <section class="fc-screen" id="fc-s-setup">
      <div class="fc-form" id="fc-new">
        <div class="fc-main" id="fc-main">
          <div class="fc-box">
            <div class="fc-box-head">
              <span class="fc-lbl">Nguồn nội dung</span>
              <div class="fc-select">
                <button type="button" id="fc-subject-btn" aria-haspopup="listbox"><span class="fc-muted">Môn:</span><b id="fc-subject-name"></b>
                  <svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                <div class="fc-menu" id="fc-subject-menu" hidden></div>
              </div>
            </div>
            <div class="fc-chips" id="fc-src-list"></div>
            <div class="fc-row-between fc-muted"><span class="fc-ell">Chỉ chọn các Chương / tệp PDF trong cùng một môn</span><span class="fc-nowrap" id="fc-src-summary"></span></div>
          </div>

          <div class="fc-fields">
            <label class="fc-field fc-f-name" id="fc-f-name">
              <span class="fc-lbl">Tên bộ thẻ (bắt buộc)</span>
              <input id="fc-name" autocomplete="off" maxlength="200" placeholder="Nhập tên bộ thẻ">
            </label>
            <label class="fc-field fc-f-count" id="fc-f-count">
              <span class="fc-lbl">Số thẻ</span>
              <span class="in"><input id="fc-count" inputmode="numeric" autocomplete="off" value="20"><span class="fc-muted">thẻ</span></span>
            </label>
          </div>
          <div class="fc-hint-pill" id="fc-count-hint"></div>
          <div class="fc-error" id="fc-count-err" hidden></div>

          <!-- Loại thẻ: Cả hai (chia đều, lẻ ưu tiên thuật ngữ) / chỉ Thuật ngữ / chỉ Câu hỏi -->
          <div class="fc-box" id="fc-type-box">
            <div class="fc-box-head">
              <span class="fc-lbl">Loại thẻ</span>
              <div class="fc-seg" id="fc-type-mode">
                <button type="button" data-v="both" class="on">Cả hai</button>
                <button type="button" data-v="term">Thuật ngữ</button>
                <button type="button" data-v="qa">Câu hỏi</button>
              </div>
            </div>
            <div class="fc-levels" id="fc-levels"></div>
            <div class="fc-dist"><i class="c2" id="fc-b0"></i><i class="c3" id="fc-b1"></i></div>
            <div class="fc-muted" id="fc-type-note"></div>
          </div>
        </div>

        <div class="fc-side" id="fc-side">
          <div class="fc-box"><div class="fc-box-head"><span class="fc-h3">Chế độ</span><span class="fc-pill">Flashcard</span></div></div>
          <div class="fc-box" id="fc-opts">
            <span class="fc-h3">Khi ôn</span>
            <button type="button" class="fc-sw-row on" data-k="shuffle" aria-pressed="true">Trộn thứ tự thẻ<span class="fc-sw"></span></button>
            <button type="button" class="fc-sw-row on" data-k="showCite" aria-pressed="true">Hiện nguồn ở mặt sau<span class="fc-sw"></span></button>
          </div>
          <div class="fc-box fc-box--tight">
            <span class="fc-h3">Lịch ôn lặp lại</span>
            <ul class="fc-rules">
              <li>Thẻ <b>Khó</b>: ôn lại sau 10 phút</li>
              <li>Thẻ <b>Dễ</b>: ôn lại sau 3 ngày</li>
              <li>Bấm tạo xong là ôn được ngay</li>
            </ul>
          </div>
          <div class="fc-box fc-panel" id="fc-panel"></div>
        </div>
      </div>
    </section>

    <!-- ===== ĐÃ TẠO ===== -->
    <section class="fc-screen" id="fc-s-saved" hidden>
      <!-- Đã tạo dạng THẺ (cùng khuôn Tóm tắt) — js/ghichu_cardlist.js vẽ thanh trên + lưới -->
      <div class="fc-list cl-clist">
        <div id="fc-saved-bar"></div>
        <div id="fc-saved-list"></div>
      </div>
    </section>

    <!-- ===== ÔN THẺ (mặt trước / mặt sau, cuộn dọc) ===== -->
    <section class="fc-screen fc-screen--top" id="fc-s-study" hidden>
      <div class="fc-study">
        <div class="fc-notice" id="fc-notice" hidden><p id="fc-notice-text"></p><button type="button" id="fc-notice-close">Đóng</button></div>
        <div>
          <div class="fc-progress-head"><b id="fc-pos"></b><span id="fc-tally"></span></div>
          <div class="fc-bar"><i id="fc-bar"></i></div>
        </div>
        <div class="fc-flip" id="fc-flip" tabindex="0" role="button" aria-label="Lật thẻ">
          <div class="fc-flip-inner" id="fc-flip-inner">
            <div class="fc-face fc-front">
              <div class="fc-fl" id="fc-f-label"></div>
              <div class="fc-term" id="fc-f-text"></div>
              <div class="fc-fl">Nhấn vào thẻ để lật · phím Space</div>
            </div>
            <div class="fc-face fc-rear">
              <div class="fc-fl">Mặt sau</div>
              <div class="fc-bk">
                <div class="fc-q" id="fc-b-q"></div>
                <div class="fc-a" id="fc-b-a"></div>
                <!-- bấm được khi nguồn còn tồn tại -> mở đúng Chương / PDF tại trang -->
                <button type="button" class="fc-cite" id="fc-b-src"></button>
                <button type="button" class="gopy-link" id="fc-b-report">Báo nội dung sai</button>
              </div>
              <div class="fc-fl">Bạn nhớ thẻ này thế nào?</div>
            </div>
          </div>
        </div>
        <div class="fc-nav" id="fc-nav">
          <button type="button" class="fc-btn-text" id="fc-prev">‹  Thẻ trước</button>
          <button type="button" class="fc-btn-text" id="fc-skip">Bỏ qua  ›</button>
        </div>
        <div class="fc-rate" id="fc-rate" hidden>
          <button type="button" class="hard" id="fc-hard"><b>Khó</b><small id="fc-hard-when">Ôn lại sau 10 phút</small></button>
          <button type="button" class="easy" id="fc-easy"><b>Dễ</b><small id="fc-easy-when">Ôn lại sau 3 ngày</small></button>
        </div>
      </div>
    </section>

    <!-- ===== XEM LẠI 1 THẺ TỪ MÀN HOÀN THÀNH ===== -->
    <section class="fc-screen fc-screen--top" id="fc-s-card" hidden>
      <div class="fc-study">
        <div>
          <div class="fc-progress-head"><b id="fc-c-pos"></b><span id="fc-c-meta"></span></div>
          <div class="fc-bar"><i id="fc-c-bar"></i></div>
        </div>
        <div class="fc-flip fc-flip--static">
          <div class="fc-face fc-rear">
            <div class="fc-fl" id="fc-c-label"></div>
            <div class="fc-bk">
              <div class="fc-q" id="fc-c-q"></div>
              <div class="fc-a" id="fc-c-a"></div>
              <button type="button" class="fc-cite" id="fc-c-src"></button>
              <button type="button" class="gopy-link" id="fc-c-report">Báo nội dung sai</button>
            </div>
            <div class="fc-fl fc-verdict" id="fc-c-verdict"></div>
          </div>
        </div>
        <div class="fc-quiz-foot">
          <button type="button" class="fc-btn-text" id="fc-c-prev">‹  Thẻ trước</button>
          <div class="fc-quiz-foot-right">
            <button type="button" class="fc-btn-secondary" id="fc-c-result">Kết quả</button>
            <button type="button" class="fc-btn-primary" id="fc-c-next">Thẻ tiếp theo</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== HOÀN THÀNH PHIÊN ÔN (1 cột) ===== -->
    <section class="fc-screen" id="fc-s-done" hidden>
      <div class="fc-done">
        <div class="fc-score">
          <div class="k">Hoàn thành phiên ôn</div>
          <div class="v" id="fc-d-total"></div>
          <div class="m" id="fc-d-meta"></div>
        </div>
        <div class="fc-stats">
          <div class="fc-stat easy"><div class="k">Dễ</div><div class="v" id="fc-d-easy"></div><div class="s" id="fc-d-easy-s"></div></div>
          <div class="fc-stat hard"><div class="k">Khó</div><div class="v" id="fc-d-hard"></div><div class="s" id="fc-d-hard-s"></div></div>
          <div class="fc-stat skip"><div class="k">Bỏ qua</div><div class="v" id="fc-d-skip"></div><div class="s" id="fc-d-skip-s"></div></div>
          <div class="fc-stat streak"><div class="k">Chuỗi ngày ôn</div><div class="v" id="fc-d-streak"></div><div class="s">Liên tiếp đến hôm nay</div></div>
        </div>
        <div class="fc-rev">
          <div class="fc-review-head"><span class="fc-h3">Xem lại từng thẻ</span>
            <div class="fc-rh-right">
              <button type="button" class="fc-toggle" id="fc-only-hard">Chỉ hiện thẻ khó</button>
              <span id="fc-per"></span>
              <span class="fc-pg" id="fc-pager"><button type="button" id="fc-pg-prev" aria-label="Trang trước">‹</button><span id="fc-pg-info"></span><button type="button" id="fc-pg-next" aria-label="Trang sau">›</button></span>
            </div>
          </div>
          <div id="fc-r-list"></div>
        </div>
        <div class="fc-done-foot">
          <p class="fc-muted" id="fc-d-note"></p>
          <button type="button" class="fc-link" id="fc-d-retry" hidden>Thử lưu lại</button>
          <button type="button" class="fc-btn-secondary" id="fc-to-list">Về danh sách</button>
          <button type="button" class="fc-btn-primary" id="fc-again-hard">Ôn lại thẻ khó</button>
        </div>
      </div>
    </section>
  </div>
  <div class="fc-toast" id="fc-toast" hidden></div>
</div>
