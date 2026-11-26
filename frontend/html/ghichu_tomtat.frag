<!-- ======================================================================
     ghichu_tomtat.frag — MODULE "Tạo bản tóm tắt" (UC-24, Studio AI). Nạp vào #mount-tomtat-pane
     (trong <main class="editor-pane"> của ghichu.html) bằng loadFragment() đầu js/ghichu.js.
     Logic: js/ghichu_tomtat.js, style: css/ghichu_tomtat.css (tiền tố `ts-`; `tt-` đã thuộc Thi thử).
     Bố cục theo giao diện mẫu `tom-tat.html` — cùng khuôn với Ôn tập / Thi thử / Flashcard / Sơ đồ tư
     duy: thanh trên (× + tiêu đề + "Tạo tóm tắt"), tab Tạo mới / Đã tạo dưới dòng kẻ, 3 màn Tạo mới /
     Đã tạo / Xem song song + hộp Xuất PDF. Khi mở: cột 1, cột 3 và Topbar soạn thảo được ẩn — xem
     syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="ts-pane" id="ts-pane" hidden>
  <div class="ts-head">
    <!-- Đóng: Tạo mới/Đã tạo -> về Notebook; màn xem -> Đã tạo -->
    <button type="button" class="ts-close" id="ts-back-btn" aria-label="Đóng" title="Đóng">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <div class="ts-head-titles">
      <h1 class="ts-title" id="ts-title">Tạo bản tóm tắt</h1>
      <!-- Màn xem: tên bản tóm tắt sửa tại chỗ (summaries.title) -->
      <input class="ts-title-in" id="ts-sum-name" maxlength="200" aria-label="Tên bản tóm tắt" hidden>
    </div>
    <!-- Tab Tạo mới / Đã tạo nằm TRÊN thanh trên, ngay sau tiêu đề (người dùng chốt); ẩn ở màn xem -->
    <div class="ts-tabbar" id="ts-tabbar">
      <div class="ts-tabs" id="ts-tabs" role="tablist">
        <button type="button" role="tab" data-tab="new" class="on"><span>Tạo mới</span></button>
        <button type="button" role="tab" data-tab="saved"><span>Đã tạo <i id="ts-saved-count"></i></span></button>
      </div>
    </div>
    <div class="ts-head-right">
      <span class="ts-saved" id="ts-saved" hidden></span>
      <button type="button" class="ts-btn-secondary" id="ts-pdf-btn" hidden>Xuất PDF</button>
      <button type="button" class="ts-btn-primary" id="ts-create">Tạo tóm tắt</button>
      <button type="button" class="ts-btn-primary" id="ts-done" hidden>Xong</button>
    </div>
  </div>

  <div class="ts-body" id="ts-body">
    <!-- ===== TẠO MỚI ===== -->
    <section class="ts-screen" id="ts-s-setup">
      <div class="ts-form" id="ts-new">
        <div class="ts-main" id="ts-main">
          <!-- Nguồn: ĐÚNG 1 Chương hoặc 1 Tệp PDF (summaries.source_type/chapter_id/document_id) -->
          <div class="ts-box" id="ts-src-box">
            <div class="ts-box-head">
              <span class="ts-lbl">Chương cần tóm tắt</span>
              <div class="ts-select">
                <button type="button" id="ts-subject-btn" aria-haspopup="listbox"><span class="ts-muted">Môn:</span><b id="ts-subject-name"></b>
                  <svg width="10" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                <div class="ts-menu" id="ts-subject-menu" hidden></div>
              </div>
            </div>
            <div class="ts-chips" id="ts-src-list" role="radiogroup" aria-label="Nguồn cần tóm tắt"></div>
            <div class="ts-row-between ts-muted" id="ts-src-foot"><span class="ts-ell">Mỗi bản tóm tắt dành cho một chương hoặc một tệp PDF</span><span class="ts-nowrap" id="ts-src-info"></span></div>
            <!-- UC-24 E1: nguồn quá ngắn -->
            <div class="ts-err-row" id="ts-src-err" hidden><span class="ts-error" id="ts-src-err-text"></span><button type="button" class="ts-link" id="ts-add-note">+ Thêm nội dung vào chương</button></div>
          </div>

          <div class="ts-settings" id="ts-settings">
            <label class="ts-field ts-f-name" id="ts-f-name">
              <span class="ts-lbl">Tên bản tóm tắt (bắt buộc)</span>
              <input id="ts-name" autocomplete="off" maxlength="200" placeholder="Nhập tên bản tóm tắt">
            </label>

            <!-- summaries.length -->
            <div class="ts-box">
              <div class="ts-box-head">
                <span class="ts-lbl">Độ dài tóm tắt</span>
                <div class="ts-seg ts-seg--len" id="ts-len-seg"><button type="button" data-v="short">Ngắn</button><button type="button" data-v="medium" class="on">Vừa</button><button type="button" data-v="long">Chi tiết</button></div>
              </div>
              <span class="ts-muted" id="ts-len-note"></span>
            </div>

            <!-- summaries.format -->
            <div class="ts-box">
              <span class="ts-lbl">Định dạng</span>
              <div class="ts-fmts" id="ts-fmt-seg">
                <button type="button" class="ts-fmt on" data-v="bullet" role="radio" aria-checked="true"><span class="t"><span class="ts-radio"></span>Gạch đầu dòng</span>
                  <span class="ts-pv ts-pv--bul"><i style="width:60%"></i><i style="width:70%"></i><i style="width:48%"></i></span></button>
                <button type="button" class="ts-fmt" data-v="paragraph" role="radio" aria-checked="false"><span class="t"><span class="ts-radio"></span>Đoạn văn</span>
                  <span class="ts-pv"><i style="width:78%"></i><i style="width:78%"></i><i style="width:52%"></i></span></button>
              </div>
            </div>
          </div>
        </div>

        <div class="ts-side" id="ts-side">
          <!-- summaries.keep_definitions / keep_numbers / keep_examples -->
          <div class="ts-box" id="ts-keep-box">
            <span class="ts-h3">Giữ lại trong tóm tắt</span>
            <button type="button" class="ts-sw-row on" data-k="def" aria-pressed="true">Định nghĩa quan trọng<span class="ts-sw"></span></button>
            <button type="button" class="ts-sw-row on" data-k="num" aria-pressed="true">Công thức, số liệu<span class="ts-sw"></span></button>
            <button type="button" class="ts-sw-row" data-k="ex" aria-pressed="false">Ví dụ minh họa<span class="ts-sw"></span></button>
            <p class="ts-muted">Mỗi ý luôn kèm trích dẫn về nội dung gốc.</p>
          </div>
          <div class="ts-box ts-panel" id="ts-panel"></div>
        </div>
      </div>
    </section>

    <!-- ===== ĐÃ TẠO ===== -->
    <section class="ts-screen" id="ts-s-saved" hidden>
      <!-- Đã tạo dạng THẺ (mẫu `tom-tat sửa phần đã tạo.html`): tìm kiếm, lọc Tất cả / Cần cập nhật, sắp xếp, chia trang 6 ô -->
      <div class="ts-list ts-clist">
        <div class="ts-tbar">
          <label class="ts-srch"><svg width="15" height="15" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="6.3" stroke="currentColor" stroke-width="1.8"/><path d="m13.3 13.3 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            <input id="ts-lq" placeholder="Tìm bản tóm tắt…" autocomplete="off" aria-label="Tìm bản tóm tắt"><button type="button" class="clr" id="ts-lq-clear" hidden aria-label="Xoá tìm kiếm">×</button></label>
          <button type="button" class="ts-fpill on" data-f="all">Tất cả</button>
          <button type="button" class="ts-fpill" data-f="stale" id="ts-f-stale">Cần cập nhật</button>
          <span class="sp"></span>
          <span id="ts-per"></span><!-- "Hiển thị [n] ô/trang" (ghichu_core.js perSelectHtml) -->
          <div class="ts-pgr" id="ts-pgr" hidden></div>
          <div class="ts-sortb"><button type="button" id="ts-sort-btn" aria-haspopup="listbox"><span>Sắp xếp:</span><b id="ts-sort-name"></b><svg width="11" height="6" viewBox="0 0 12 7" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="ts-menu" id="ts-sort-menu" hidden></div></div>
        </div>
        <div class="ts-cards" id="ts-saved-list"></div>
      </div>
    </section>

    <!-- ===== XEM SONG SONG: bản tóm tắt | nội dung gốc ===== -->
    <section class="ts-screen ts-screen--view" id="ts-s-view" hidden>
      <div class="ts-split">
        <div class="ts-pane-card" id="ts-pane-sum">
          <div class="ts-phead"><span class="ts-h3">Bản tóm tắt</span><span class="ts-tagg" id="ts-sum-tag"></span><span class="sp"></span><button type="button" class="gopy-link" id="ts-report">Báo nội dung sai</button><button type="button" class="ts-link" id="ts-regen-btn">Tạo lại</button></div>
          <div class="ts-stale" id="ts-stale-bar" hidden><p>Nội dung gốc đã thay đổi sau lần tạo này.</p><button type="button" id="ts-stale-regen">Tạo lại</button></div>
          <div class="ts-note" id="ts-sample-note" hidden>Bản minh hoạ (chế độ mẫu): các ý được trích từ câu đầu mỗi đoạn trong chương, chưa do AI tóm tắt. Đăng nhập để AI tóm tắt thật.</div>
          <div class="ts-scroll" id="ts-sum-body"></div>
          <div class="ts-regen" id="ts-regen-mask" hidden><div><span class="ts-spin ts-spin--ink"></span>Đang tạo lại bản tóm tắt…</div></div>
        </div>
        <div class="ts-pane-card">
          <div class="ts-phead"><span class="ts-h3">Nội dung gốc</span><span class="sp"></span><button type="button" class="ts-link" id="ts-open-src">Mở trong Notebook</button></div>
          <div class="ts-meta" id="ts-src-meta"></div>
          <div class="ts-scroll ts-src" id="ts-src-body"></div>
          <div class="ts-phint">Bấm vào số trích dẫn trong bản tóm tắt để xem đoạn gốc tương ứng.</div>
        </div>
      </div>
    </section>
  </div>

  <!-- ===== XUẤT PDF (UC-24 luồng 4a) — in qua iframe ẩn, không lưu DB ===== -->
  <div class="ts-overlay" id="ts-pdf-modal" hidden>
    <div class="ts-modal" role="dialog" aria-modal="true" aria-labelledby="ts-pdf-title">
      <h2 id="ts-pdf-title">Xuất bản tóm tắt ra PDF</h2>
      <label class="ts-field" id="ts-f-file">
        <span class="ts-lbl">Tên tệp</span>
        <input id="ts-file-in" autocomplete="off" maxlength="200">
      </label>
      <div class="ts-row-between"><span>Khổ giấy</span><div class="ts-seg" id="ts-paper-seg"><button type="button" data-v="A4" class="on">A4</button><button type="button" data-v="letter">Letter</button></div></div>
      <button type="button" class="ts-sw-row on" data-p="cite" aria-pressed="true">Kèm trích dẫn nguồn<span class="ts-sw"></span></button>
      <button type="button" class="ts-sw-row" data-p="notes" aria-pressed="false">Kèm nội dung gốc ở cuối<span class="ts-sw"></span></button>
      <p class="ts-muted ts-pdf-hint">Hộp thoại in của trình duyệt sẽ mở — chọn “Lưu dưới dạng PDF”.</p>
      <div class="ts-foot"><button type="button" class="ts-btn-secondary" id="ts-pdf-cancel">Hủy</button><button type="button" class="ts-btn-primary" id="ts-pdf-go">Tải PDF</button></div>
    </div>
  </div>

  <div class="ts-toast" id="ts-toast" hidden></div>
</div>
