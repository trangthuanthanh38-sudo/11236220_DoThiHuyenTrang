<!-- ======================================================================
     ghichu_lichbieu.frag — MODULE "Lịch biểu" (UC-26 Tạo / UC-27 Xem / UC-28 Xoá mục lịch + chuông UC-31).
     Nạp vào #mount-lichbieu-pane (trong <main class="editor-pane"> của ghichu.html) bằng loadFragment()
     đầu js/ghichu.js. Logic: js/ghichu_lichbieu.js, style: css/ghichu_lichbieu.css (tiền tố `lb-`).
     Bố cục theo giao diện mẫu `lich-bieu.html`: thanh trên (× + "Lịch biểu" + Hôm nay ‹ › + khoảng
     đang xem | Ngày/Tuần/Tháng + chuông), cột trái (Thêm sự kiện, lịch nhỏ, Nhãn), lưới lịch; lớp nổi:
     chi tiết sự kiện, thông báo, hộp Thêm/Sửa, xác nhận xoá, thanh Hoàn tác. Khi mở: cột 1, cột 3 và
     Topbar soạn thảo được ẩn — xem syncMainPane()/updateWorkspaceCols() trong ghichu.js.
     ====================================================================== -->
<div class="lb-pane" id="lb-pane" hidden>
  <div class="lb-head">
    <button type="button" class="lb-close" id="lb-back-btn" aria-label="Đóng" title="Về Notebook">
      <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <h1 class="lb-title">Lịch biểu</h1>
    <div class="lb-nav">
      <button type="button" class="lb-btn-secondary sm" id="lb-today">Hôm nay</button>
      <div class="lb-arrows">
        <button type="button" id="lb-prev" aria-label="Trước"><svg width="8" height="13" viewBox="0 0 10 16" fill="none"><path d="M8 2 2 8l6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" id="lb-next" aria-label="Sau"><svg width="8" height="13" viewBox="0 0 10 16" fill="none"><path d="m2 2 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
      <span class="lb-range" id="lb-range"></span>
    </div>
    <div class="lb-head-right">
      <span class="lb-loading" id="lb-loading" hidden>Đang tải…</span>
      <div class="lb-seg" id="lb-view-seg"><button type="button" data-v="day">Ngày</button><button type="button" data-v="week" class="on">Tuần</button><button type="button" data-v="month">Tháng</button></div>
      <button type="button" class="lb-bell" id="lb-bell" aria-label="Thông báo" title="Thông báo">
        <svg width="17" height="19" viewBox="0 0 20 22" fill="none"><path d="M10 2a6 6 0 0 0-6 6v4.2L2.4 15.4c-.3.6.1 1.3.8 1.3h13.6c.7 0 1.1-.7.8-1.3L16 12.2V8a6 6 0 0 0-6-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.6 19.2a2.6 2.6 0 0 0 4.8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <i id="lb-bell-dot" hidden></i>
      </button>
    </div>
  </div>

  <div class="lb-body" id="lb-body">
    <aside class="lb-side">
      <button type="button" class="lb-btn-primary" id="lb-add">+&nbsp;&nbsp;Thêm sự kiện</button>
      <div class="lb-mini" id="lb-mini"></div>
      <div class="lb-labels" id="lb-labels"></div>
    </aside>
    <div class="lb-grid" id="lb-grid"></div>
  </div>

  <div class="lb-error" id="lb-error" hidden></div>
  <div class="lb-pop" id="lb-pop" hidden></div>
  <div class="lb-notif" id="lb-notif" hidden></div>
  <div class="lb-snack" id="lb-snack" hidden><span id="lb-snack-text"></span><button type="button" id="lb-undo">Hoàn tác</button></div>
  <div class="lb-toast" id="lb-toast" hidden></div>

  <!-- B · Thêm / sửa sự kiện (UC-26) -->
  <div class="lb-overlay" id="lb-ev-modal" hidden>
    <div class="lb-modal" role="dialog" aria-modal="true" aria-labelledby="lb-m-title" id="lb-ev-box">
      <div class="lb-mt"><h2 id="lb-m-title">Thêm sự kiện</h2>
        <button type="button" class="lb-x" id="lb-m-close" aria-label="Đóng"><svg width="12" height="12" viewBox="0 0 18 18" fill="none"><path d="M2 2l14 14M16 2 2 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>
      <input class="lb-tin" id="lb-f-title" maxlength="200" placeholder="Tên sự kiện, ví dụ: Ôn tập, Họp nhóm, Đi khám…" autocomplete="off">
      <div class="lb-types" id="lb-f-type"><button type="button" data-v="event">Sự kiện</button><button type="button" data-v="class">Buổi học</button><button type="button" data-v="deadline">Deadline</button><button type="button" data-v="exam">Lịch thi</button></div>
      <div class="lb-frow"><span class="lb-lb" id="lb-f-time-lbl">Thời gian</span>
        <button type="button" class="lb-dd" id="lb-f-date"></button>
        <button type="button" class="lb-dd t" id="lb-f-start"></button><span class="lb-dash" id="lb-f-dash">–</span><button type="button" class="lb-dd t" id="lb-f-end"></button>
      </div>
      <div class="lb-sub red" id="lb-f-err" hidden>Giờ kết thúc phải sau giờ bắt đầu.</div>
      <div class="lb-frow"><span class="lb-lb">Lặp lại</span>
        <button type="button" class="lb-dd" id="lb-f-repeat"></button>
        <button type="button" class="lb-dd" id="lb-f-until" hidden></button>
      </div>
      <div class="lb-sub" id="lb-f-repeat-hint" hidden></div>
      <div class="lb-warn" id="lb-f-warn" hidden></div>
      <div class="lb-frow"><span class="lb-lb">Môn học</span>
        <button type="button" class="lb-dd lb-dd-wide" id="lb-f-subject"></button>
        <button type="button" class="lb-dd lb-dd-wide" id="lb-f-chapter" hidden></button>
      </div>
      <div class="lb-frow"><span class="lb-lb">Màu</span><div class="lb-sws" id="lb-f-col"></div></div>
      <div class="lb-sub" id="lb-f-col-hint" hidden></div>
      <div class="lb-frow"><span class="lb-lb">Nhãn</span><input class="lb-lin" id="lb-f-lbl" maxlength="80" list="lb-lbl-list" placeholder="Tên nhãn (để trống nếu không cần)" autocomplete="off"><button type="button" class="lb-link lb-sync" id="lb-f-sync" hidden>Dùng tên sự kiện</button></div>
      <div class="lb-sub" id="lb-f-lbl-hint" hidden></div>
      <datalist id="lb-lbl-list"></datalist>
      <div class="lb-frow"><span class="lb-lb">Nhắc trước</span><button type="button" class="lb-dd" id="lb-f-rem"></button></div>
      <div class="lb-frow"><span class="lb-lb">Gửi qua</span>
        <div class="lb-vias" id="lb-f-via">
          <button type="button" class="lb-ck" data-k="app"><i></i>Trong app</button>
          <button type="button" class="lb-ck" data-k="email"><i></i>Email</button>
        </div>
      </div>
      <div class="lb-sub" id="lb-f-via-hint" hidden></div>
      <div class="lb-sub red" id="lb-f-save-err" hidden></div>
      <div class="lb-foot"><button type="button" class="lb-btn-secondary" id="lb-m-cancel">Hủy</button><button type="button" class="lb-btn-primary" id="lb-m-save">Lưu</button></div>
      <div class="lb-fmenu" id="lb-fmenu" hidden></div>
    </div>
  </div>

  <!-- E · Xác nhận xoá (UC-28) -->
  <div class="lb-overlay" id="lb-del-modal" hidden>
    <div class="lb-modal lb-confirm" role="alertdialog" aria-modal="true" aria-labelledby="lb-d-title">
      <h2 id="lb-d-title">Xoá sự kiện?</h2>
      <p id="lb-d-text"></p>
      <div class="lb-foot"><button type="button" class="lb-btn-secondary" id="lb-d-cancel">Hủy</button><button type="button" class="lb-btn-danger" id="lb-d-ok">Xoá</button></div>
    </div>
  </div>
</div>
