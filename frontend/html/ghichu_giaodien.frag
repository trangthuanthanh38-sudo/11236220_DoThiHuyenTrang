    <!-- Fragment MODULE 2 (ghichu_giaodien.js): modal Hồ sơ cá nhân (UC-06) + modal Cài đặt tài
         khoản (Giao diện UC-09 / Đổi SĐT UC-07 / Đổi mật khẩu UC-08). Nạp vào trang qua fetch()
         + thay thế #mount-giaodien-modals, xem đầu ghichu.js. -->
    <div class="modal-overlay" id="profile-overlay" hidden>
      <div class="modal profile-modal">
        <div class="modal-head">
          <span class="modal-title">Profile</span>
          <button type="button" class="icon-btn-sm" id="profile-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </div>
        <div class="modal-body" id="profile-body">
          <div class="form-msg" id="profile-msg" hidden></div>
          <div class="profile-avatar-row">
            <span class="avatar-badge avatar-badge--xl" id="profile-avatar-preview"></span>
            <div class="form-field" style="flex:1;margin-bottom:0">
              <label class="form-label" for="profile-avatar-url">Profile Picture (URL)</label>
              <input type="text" class="form-input" id="profile-avatar-url" placeholder="https://..." autocomplete="off">
            </div>
          </div>
          <div class="form-field">
            <label class="form-label" for="profile-name">Display Name</label>
            <input type="text" class="form-input" id="profile-name" maxlength="100" autocomplete="off">
            <span class="form-hint" id="profile-name-hint" hidden></span>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label class="form-label" for="profile-school">School</label>
              <input type="text" class="form-input" id="profile-school" maxlength="150" autocomplete="off">
            </div>
            <div class="form-field">
              <label class="form-label" for="profile-class">Class</label>
              <input type="text" class="form-input" id="profile-class" maxlength="100" autocomplete="off">
            </div>
          </div>
          <div class="form-field">
            <label class="form-label">Phone Number</label>
            <input type="text" class="form-input" id="profile-phone" disabled>
            <span class="form-hint" id="profile-phone-hint">Change your phone number in "Settings".</span>
          </div>
          <!-- Email nhận nhắc lịch (UC-31): tài khoản Google tự điền Gmail và khoá; tài khoản SĐT tự nhập -->
          <div class="form-field">
            <label class="form-label" for="profile-email">Notification Email</label>
            <input type="email" class="form-input" id="profile-email" maxlength="255" autocomplete="email" placeholder="name@gmail.com">
            <span class="form-hint" id="profile-email-hint">Class, deadline and exam reminders will be sent to this email.</span>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn-plain" id="profile-cancel">Cancel</button>
          <span style="flex:1"></span>
          <button type="button" class="btn-solid" id="profile-save">Save</button>
        </div>
      </div>
    </div>

    <div class="modal-overlay" id="settings-overlay" hidden>
      <div class="modal settings-modal">
        <div class="modal-head">
          <span class="modal-title">Cài đặt tài khoản</span>
          <button type="button" class="icon-btn-sm" id="settings-close" title="Đóng">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </div>
        <div class="settings-tabs" id="settings-tabs">
          <button type="button" class="settings-tab" data-tab="theme">Giao diện</button>
          <button type="button" class="settings-tab" data-tab="phone">Đổi SĐT</button>
          <button type="button" class="settings-tab" data-tab="password">Đổi mật khẩu</button>
        </div>
        <div class="modal-body" id="settings-body"></div>
      </div>
    </div>
