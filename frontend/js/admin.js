// Admin Console — khởi động: chỉ role='admin' (BR-13); người học lạc vào thì đưa về trang soạn thảo, chưa đăng nhập
// thì về trang đăng nhập. Nạp 6 trang (mỗi module tự registerPage), chuông admin (GET /admin/alerts), đăng xuất (UC-05).
import { $, PAGES, api, closeAll, closeModal, esc, go, hooks, modal, nav, playChime, toast, token, unlockAudio } from './admin_core.js';
import './admin_users.js';
import './admin_quota.js';
import './admin_files.js';
import './admin_logs.js';
import './admin_feedback.js';
import './admin_reports.js';

$('nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.p); };

addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const layer = $('layer');
  if (layer.querySelector('.ov')) closeModal();
  else if (document.querySelector('.menu.float')) document.querySelectorAll('.menu.float').forEach(m => m.remove());
  else if (layer.querySelector('.drawer')) hooks.closeDrawer();
  else closeAll();
});

/* ---- Chuông ---- */
// Tự cập nhật không cần tải lại trang: hỏi /admin/alerts mỗi ALERT_POLL_MS + khi quay lại tab. Có góp ý MỚI GỬI tới
// (latest_feedback_id tăng so với lần trước) -> tiếng "ding-dong" + chuông lắc + toast; đang ở trang Góp ý thì danh sách
// tự làm mới (giữ nguyên khung chi tiết / bản nháp đang gõ).
const ALERT_POLL_MS = 10000;
let alerts = { new_feedback: 0, file_errors: 0, full_accounts: 0, latest_feedback_id: 0 };
let lastFbId = null;
async function refreshAlerts() {
  try { alerts = await api('GET', '/admin/alerts', undefined, { quiet: true }); } catch (e) { return; }
  $('bellDot').hidden = !(alerts.new_feedback || alerts.file_errors || alerts.full_accounts);
  $('fbCnt').textContent = alerts.new_feedback; $('fbCnt').hidden = !alerts.new_feedback;
  if (lastFbId !== null && alerts.latest_feedback_id > lastFbId) {
    playChime(); ringBell();
    toast('Có góp ý mới từ người học · #GY-' + alerts.latest_feedback_id);
    if (nav.cur === 'fb' && hooks.refreshFbList) hooks.refreshFbList();
    if (!$('notif').hidden) renderNotif();
  }
  lastFbId = alerts.latest_feedback_id;
}
hooks.refreshAlerts = refreshAlerts;
function ringBell() { const b = $('bellBtn'); b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring'); setTimeout(() => b.classList.remove('ring'), 2200); }
setInterval(() => { if (!document.hidden) refreshAlerts(); }, ALERT_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAlerts(); });
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, unlockAudio, { passive: true }));

function renderNotif() {
  const items = [];
  if (alerts.new_feedback) items.push({ c: 'var(--red)', t: alerts.new_feedback + ' góp ý mới chưa xử lý', s: 'Mở mục Góp ý', fn: () => go('fb') });
  if (alerts.file_errors) items.push({ c: 'var(--amber)', t: alerts.file_errors + ' tệp xử lý lỗi', s: 'OCR lỗi hoặc tệp trống', fn: () => hooks.showFileErrors() });
  if (alerts.full_accounts) items.push({ c: 'var(--navy)', t: alerts.full_accounts + ' tài khoản đã đầy dung lượng hoặc số tệp', s: 'Đã tự báo cho người học · đang chặn tải lên', fn: () => hooks.showFull() });
  $('notif').innerHTML = '<h4>Thông báo</h4>' + (items.length
    ? items.map((it, i) => `<button data-i="${i}"><span class="d" style="background:${it.c}"></span><span>${esc(it.t)}<small>${esc(it.s)}</small></span></button>`).join('')
    : '<p style="padding:8px 12px 12px;color:var(--muted)">Không có thông báo mới</p>');
  $('notif').onclick = e => { const b = e.target.closest('button'); if (!b) return; $('notif').hidden = true; items[+b.dataset.i].fn(); };
}
$('bellBtn').onclick = async e => {
  e.stopPropagation();
  const opening = $('notif').hidden;
  closeAll();
  if (!opening) return;
  await refreshAlerts(); renderNotif(); $('notif').hidden = false;
};
document.addEventListener('click', e => { if (!$('notif').hidden && !$('notif').contains(e.target) && !$('bellBtn').contains(e.target)) $('notif').hidden = true; });

/* ---- Đăng xuất (UC-05) ---- */
$('logoutBtn').onclick = () => modal(`<h2>Đăng xuất khỏi trang quản trị?</h2><p class="sub">Các thay đổi chưa lưu sẽ bị bỏ.</p><div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm pri" id="mOk">Đăng xuất</button></div>`, m => {
  m.querySelector('#mC').onclick = closeModal;
  m.querySelector('#mOk').onclick = async () => {
    closeModal();
    const rt = localStorage.getItem('refresh_token');
    if (rt) await apiPost('/auth/logout', { refresh_token: rt });   // E1: lỗi vẫn coi như đã đăng xuất
    localStorage.removeItem('access_token'); localStorage.removeItem('refresh_token');
    location.href = 'dangnhap.html';
  };
});

/* ---- Khởi động ---- */
(async function boot() {
  if (!token()) { location.href = 'dangnhap.html'; return; }
  const r = await apiAuth('GET', '/auth/me', token());
  if (!r.ok) { location.href = 'dangnhap.html'; return; }
  if (r.data.role !== 'admin') { location.href = 'ghichu.html'; return; }
  const name = r.data.display_name || 'Quản trị viên';
  $('meName').textContent = name;
  $('meAv').textContent = name.split(/\s+/).filter(Boolean).slice(-2).map(w => w[0]).join('').toUpperCase() || 'AD';
  refreshAlerts();
  const start = (location.hash || '').slice(1);
  nav.cur = '';
  go(PAGES[start] ? start : 'users');
})();
