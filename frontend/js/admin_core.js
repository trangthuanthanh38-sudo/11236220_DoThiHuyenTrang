// Admin Console — phần khung dùng chung cho 6 trang (port từ mockup admin.html ở gốc repo).
// Mỗi trang là 1 module riêng (admin_users / admin_quota / admin_files / admin_logs / admin_feedback /
// admin_reports) đăng ký vào PAGES qua registerPage(); admin.js khởi động. Gọi API qua apiAuth() của
// auth-client.js (script thường, nạp trước) — token hết hạn / bị khoá / không phải admin thì về trang đăng nhập.

export const $ = id => document.getElementById(id);
export const stage = $('stage');
export const layer = $('layer');

// Gọi chéo giữa các trang mà không import vòng: vd. hooks.showUsage(user) (Người dùng -> Hạn mức),
// hooks.showFilesOf({id, name, key}) (Hạn mức -> File), hooks.openDrawer(id), hooks.refreshAlerts(), hooks.onResize() (Báo cáo vẽ lại biểu đồ).
export const hooks = {};

// Cỡ chữ theo trang Thống kê: mockup thu ×0,78 (cùng hệ số ghichu_thongke.css dùng khi chuyển mockup sang app).
// Khung giãn kín cửa sổ (bề ngang/cao = cửa sổ ÷ hệ số), bảng/lưới giãn theo; cửa sổ hẹp hơn 1440×0,78 thì thu
// thêm cho bố cục 1440 vẫn vừa. Nội dung dài hơn thì cuộn trong .page (thanh trái + thanh trên đứng yên).
// Responsive (css/admin.css cuối file): cửa sổ < COMPACT_W (iPad / điện thoại) thì thanh trái thành ngăn kéo (nút ☰)
// và hệ số không xuống dưới ZOOM_MIN (trước đây thu theo bố cục 1440 nên điện thoại chỉ còn ×0,27 — không đọc được);
// < NARROW_W thì các lưới nhiều cột xếp lại, bảng rộng cuộn ngang trong khung của nó. Desktop (≥ 1124px) giữ nguyên.
const SCALE = 0.78;
const COMPACT_W = 1124, NARROW_W = 768, ZOOM_MIN = 0.6;
const fit = () => {
  const w = innerWidth, compact = w < COMPACT_W;
  const z = compact ? Math.max(ZOOM_MIN, Math.min(SCALE, w / 1200)) : Math.min(SCALE, w / 1440);
  stage.classList.toggle('compact', compact);
  stage.classList.toggle('narrow', w < NARROW_W);
  if (!compact) setSideOpen(false);
  stage.style.zoom = z; stage.style.width = (innerWidth / z) + 'px'; stage.style.height = (innerHeight / z) + 'px';
  hooks.onResize && hooks.onResize();
};
function setSideOpen(open) {
  stage.classList.toggle('side-open', open);
  const b = $('sideBtn'); if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('sideBtn')?.addEventListener('click', e => { e.stopPropagation(); setSideOpen(!stage.classList.contains('side-open')); });
$('sideScrim')?.addEventListener('click', () => setSideOpen(false));
$('nav')?.addEventListener('click', e => { if (e.target.closest('button')) setSideOpen(false); });
addEventListener('keydown', e => { if (e.key === 'Escape' && stage.classList.contains('side-open')) setSideOpen(false); });
addEventListener('resize', fit); fit();

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = n => Math.round(n || 0).toLocaleString('vi-VN');
export const fmt1 = n => (n || 0).toLocaleString('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const MB = 1024 * 1024;
export const mb = bytes => fmt(bytes / MB);
export const mb1 = bytes => fmt1(bytes / MB);
// Số MB hiển thị: dưới 10 MB giữ 1 chữ số thập phân (tệp nhỏ không bị làm tròn thành 0 MB).
// Dung lượng tự chọn đơn vị: ≥ 1 GB -> "1,2 GB", ≥ 1 MB -> MB (mbv), nhỏ hơn -> KB (tránh "0,0 GB" khi mới có vài chục MB).
export const sizeTxt = bytes => { const b = bytes || 0; return b >= 1073741824 ? fmt1(b / 1073741824) + ' GB' : b >= MB ? mbv(b) + ' MB' : b > 0 ? fmt(Math.max(1, b / 1024)) + ' KB' : '0 MB'; };
export const mbv = bytes => { const v = (bytes || 0) / MB; return v > 0 && v < 10 ? fmt1(v) : fmt(v); };

// Ngày giờ: API trả "YYYY-MM-DDTHH:MM" giờ địa phương (không múi giờ) — tách chuỗi, không đi qua Date UTC.
export const parseIso = s => { if (!s) return null; const [d, t = '00:00'] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
const p2 = n => String(n).padStart(2, '0');
export const dd = d => p2(d.getDate()) + '/' + p2(d.getMonth() + 1);
export const ddy = d => dd(d) + '/' + d.getFullYear();
export const hhmm = d => p2(d.getHours()) + ':' + p2(d.getMinutes());
export const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
export const isToday = d => { const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };
export const stamp = s => { const d = parseIso(s); if (!d) return '—'; return (isToday(d) ? 'hôm nay' : dd(d)) + ', ' + hhmm(d); };

export const token = () => localStorage.getItem('access_token') || '';

function toLogin() { location.href = 'dangnhap.html'; }

// Gọi /admin/* — trả data khi thành công; lỗi -> toast thông báo rồi ném lỗi để nơi gọi dừng.
export async function api(method, path, body, opts = {}) {
  const r = await apiAuth(method, path, token(), body);
  if (r.status === 401) { toLogin(); throw new Error('401'); }
  if (!r.ok) {
    const msg = typeof r.data.detail === 'string' ? r.data.detail : 'Thao tác không thành công.';
    if (!opts.quiet) toast(msg);
    const e = new Error(msg); e.status = r.status; e.data = r.data; throw e;
  }
  return r.data;
}

// Tải tệp xuất (CSV / Excel) — cần header Authorization nên không dùng được <a href>.
export async function download(path, name) {
  try {
    const res = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + token() } });
    if (res.status === 401) return toLogin();
    if (!res.ok) { toast('Không xuất được tệp.'); return false; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return true;
  } catch (e) { toast('Không kết nối được tới máy chủ.'); return false; }
}

export function qsOf(obj) {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
}

export function pager(page, pages, cb) {
  const el = document.createElement('div'); el.className = 'pg';
  const b = (t, p, dis, on) => { const x = document.createElement('button'); x.textContent = t; x.disabled = dis; if (on) x.className = 'on'; x.onclick = () => cb(p); el.appendChild(x); };
  b('‹', page - 1, page <= 1);
  const set = new Set([1, 2, 3, page - 1, page, page + 1, pages].filter(p => p >= 1 && p <= pages));
  let last = 0;
  [...set].sort((a, c) => a - c).forEach(p => { if (p - last > 1) { const s = document.createElement('span'); s.textContent = '…'; el.appendChild(s); } b(p, p, false, p === page); last = p; });
  b('›', page + 1, page >= pages);
  return el;
}

// Số dòng mỗi trang do admin tự chọn — nhớ theo từng bảng (localStorage adm_per_<key>, tiện ích riêng trình duyệt).
// perOpts(def) = [mặc định của mockup, 10, 20, 50]; perSelect() vẽ ô "Hiển thị [n] dòng/trang".
export const perOpts = def => [...new Set([def, 10, 20, 50])].sort((a, b) => a - b);
export function loadPer(key, def) {
  try { const v = Number(localStorage.getItem('adm_per_' + key)); if (perOpts(def).includes(v)) return v; } catch (e) { /* bỏ qua */ }
  return def;
}
export function perSelect(key, def, cur, onChange) {
  const l = document.createElement('label'); l.className = 'perSel';
  l.innerHTML = `Hiển thị <select aria-label="Số dòng mỗi trang">${perOpts(def).map(n => `<option value="${n}"${n === cur ? ' selected' : ''}>${n}</option>`).join('')}</select> dòng/trang`;
  const s = l.querySelector('select');
  s.onchange = () => { const v = Number(s.value); try { localStorage.setItem('adm_per_' + key, String(v)); } catch (e) { /* bỏ qua */ } onChange(v); };
  s.onclick = e => e.stopPropagation();
  return l;
}

// Chân bảng: "Hiển thị a–b trên n" + ô chọn số dòng/trang (per = {key, def, onChange}) + phân trang; bảng ít dòng thì lấp
// chỗ trống tới tối đa số dòng mặc định để giữ chiều cao như mockup (chọn 20/50 thì không kéo dài bảng rỗng).
export function tableFoot(t, text, page, pages, rows, per, rowH, cb, perCfg) {
  const tf = document.createElement('div'); tf.className = 'tf';
  tf.innerHTML = `<span>${text}</span><span class="sp"></span>`;
  if (perCfg) tf.appendChild(perSelect(perCfg.key, perCfg.def, per, perCfg.onChange));
  if (pages > 1) tf.appendChild(pager(page, pages, cb));
  t.appendChild(tf);
  const fill = Math.min(per, perCfg ? perCfg.def : per);
  if (rows && rows < fill) tf.style.marginTop = ((fill - rows) * rowH) + 'px';
}

// Tiếng "ding-dong" khi có thông báo mới (Web Audio, cùng giai điệu chuông người học ở ghichu_thongbao.js).
// Trình duyệt chỉ cho phát sau thao tác đầu tiên trên trang -> unlockAudio gắn vào pointerdown/keydown (admin.js).
let audioCtx = null;
const audio = () => { if (!audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { audioCtx = new C(); } catch (e) { return null; } } return audioCtx; };
export function unlockAudio() { const c = audio(); if (c && c.state === 'suspended') c.resume(); }
export function playChime() {
  const c = audio(); if (!c) return;
  if (c.state === 'suspended') c.resume();
  const t = c.currentTime + 0.02;
  [[880, 0], [1318.5, 0.2], [880, 0.75], [1318.5, 0.95]].forEach(([f, d]) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.22, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.55);
    o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 0.6);
  });
}

let toastTimer, undoFn;
export function toast(t, undo) {
  clearTimeout(toastTimer); $('toastT').textContent = t; undoFn = undo; $('toastU').hidden = !undo; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoFn = null; }, undo ? 6000 : 3600);
}
$('toastU').onclick = () => { $('toast').hidden = true; if (undoFn) undoFn(); undoFn = null; };

export function closeMenus() { document.querySelectorAll('.menu.float').forEach(m => m.remove()); }
export function closeAll() {
  layer.innerHTML = ''; hooks.resetDrawer && hooks.resetDrawer(); closeMenus(); $('notif').hidden = true; $('rCustom').hidden = true; $('lRange').hidden = true;
  document.querySelectorAll('.sts .menu').forEach(m => { m.hidden = true; });
}
export function floatMenu(anchor, items) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'menu float';
  items.forEach(it => {
    if (it === '-') { m.appendChild(document.createElement('hr')); return; }
    const b = document.createElement('button'); b.textContent = it.t; if (it.dg) b.className = 'dg'; if (it.dis) b.disabled = true;
    b.onclick = e => { e.stopPropagation(); m.remove(); it.fn(); }; m.appendChild(b);
  });
  stage.appendChild(m);
  const sr = stage.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), z = parseFloat(stage.style.zoom) || 1;
  let ax = ar.right - sr.left, ay = ar.bottom - sr.top;
  if (Math.abs(sr.width - stage.offsetWidth) > 2) { ax /= z; ay /= z; }   // Chromium mới trả toạ độ đã zoom
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let top = ay + 4; if (top + mh > stage.offsetHeight - 14) top = ay - mh - 48;
  m.style.left = Math.max(250, ax - mw + 6) + 'px'; m.style.top = top + 'px';
  setTimeout(() => document.addEventListener('click', function h(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', h); } }), 0);
  return m;
}
export function modal(html, onMount) {
  layer.querySelector('.ov')?.remove();
  const ov = document.createElement('div'); ov.className = 'ov';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  layer.appendChild(ov);
  ov.addEventListener('mousedown', e => { if (e.target === ov) closeModal(); });
  onMount && onMount(ov.firstElementChild);
  const f = ov.querySelector('[autofocus]') || ov.querySelector('input,textarea,select'); if (f) setTimeout(() => f.focus(), 30);
  return ov.firstElementChild;
}
export function closeModal() { layer.querySelector('.ov')?.remove(); }

// Xác nhận đơn giản (Huỷ / nút chính) — trả Promise<boolean>.
export function confirmBox(title, sub, okText, danger) {
  return new Promise(res => {
    modal(`<h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}<div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm ${danger ? 'dsolid' : 'pri'}" id="mOk">${okText}</button></div>`, m => {
      m.querySelector('#mC').onclick = () => { closeModal(); res(false); };
      m.querySelector('#mOk').onclick = () => { closeModal(); res(true); };
    });
  });
}

/* ---- Điều hướng giữa 6 trang ---- */
export const PAGES = {};   // key -> {title, render, canLeave?}
export const nav = { cur: '' };
export function registerPage(key, title, render, canLeave) { PAGES[key] = { title, render, canLeave }; }
export function go(p, force) {
  if (p === nav.cur && !force) return;
  const leaving = PAGES[nav.cur];
  if (!force && leaving && leaving.canLeave && !leaving.canLeave(() => go(p, true))) return;
  nav.cur = p; closeAll();
  document.querySelectorAll('.page').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $('crumb').textContent = PAGES[p].title;
  PAGES[p].render();
  try { history.replaceState(null, '', '#' + p); } catch (e) { /* bỏ qua */ }
}

// Ô tìm kiếm có nút ×, gõ xong 250ms mới tìm (tránh gọi API mỗi phím).
export function bindSearch(inputId, clearId, onChange) {
  let tm;
  $(inputId).oninput = () => { $(clearId).hidden = !$(inputId).value; clearTimeout(tm); tm = setTimeout(() => onChange($(inputId).value), 250); };
  $(clearId).onclick = e => { e.preventDefault(); $(inputId).value = ''; $(clearId).hidden = true; onChange(''); $(inputId).focus(); };
}

export function pills(el, list, cur) {
  el.innerHTML = list.map(([k, t]) => `<button class="pill${cur === k ? ' on' : ''}" data-f="${k}">${t}</button>`).join('');
}

export const loadingRow = (n = 1) => `<div class="empty" style="padding:${40 * n}px 24px">Đang tải…</div>`;

