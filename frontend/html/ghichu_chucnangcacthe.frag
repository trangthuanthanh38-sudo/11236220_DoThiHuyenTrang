    <!-- Fragment MODULE 3 (ghichu_chucnangcacthe.js): modal do thẻ ribbon mở — "Hướng dẫn nhanh / Phím tắt"
         (thẻ Draw không còn hộp "Vẽ phác thảo": vẽ trực tiếp trên trang — js/ghichu_ve.js) (tab Help, cũng được mở lại từ mục
         "Trợ giúp" trong popover tài khoản — xem openGuideModal() trong ghichu_chucnangcacthe.js).
         Nạp vào trang qua fetch() + thay thế #mount-chucnangcacthe-modals, xem đầu ghichu.js. -->
    <div class="modal-overlay" id="info-overlay" hidden>
      <div class="modal info-modal">
        <div class="modal-head">
          <span class="modal-title" id="info-title"></span>
          <button type="button" class="icon-btn-sm" id="info-close" title="Đóng">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </div>
        <div class="info-body" id="info-body"></div>
      </div>
    </div>
