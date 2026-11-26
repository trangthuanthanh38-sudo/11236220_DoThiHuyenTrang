// UC-32 Người dùng — bảng + KPI + bảng chi tiết (drawer) + thao tác khoá / mở khoá / vô hiệu hoá / khôi phục /
// buộc đặt lại mật khẩu / xoá vĩnh viễn. API: /admin/users* (backend/app/routers/admin.py). Hoàn tác = gọi thao tác
// ngược với undo=true (nhật ký ghi "Hoàn tác: …"). Chỉ số liệu tổng hợp, định danh đã che (BR-16).
import {
  $, api, bindSearch, closeModal, download, esc, fmt, floatMenu, hooks, layer, modal, nav, parseIso, ddy, dd, hhmm,
  pills, qsOf, registerPage, tableFoot, toast, loadingRow, mbv, loadPer } from './admin_core.js';

const U = { q: '', f: 'all', page: 1, per: loadPer('users', 6), data: null };
let openUid = null;

const ST_NAME = { active: 'Hoạt động', locked: 'Bị khoá', temp: 'Khoá tạm', disabled: 'Vô hiệu hoá', pending_verification: 'Chưa xác thực' };
const ST_L = u => {
  if (u.status === 'active') return ['g', 'Hoạt động'];
  if (u.status === 'locked') return ['r', 'Bị khoá bởi admin'];
  if (u.status === 'temp') return ['a', 'Khoá tạm · sai mật khẩu'];
  if (u.status === 'pending_verification') return ['gr', 'Chưa xác thực SĐT'];
  return ['gr', 'Vô hiệu hoá · còn ' + (u.disabled_days_left ?? 0) + ' ngày'];
};
const mbTxt = u => u.storage_used >= u.storage_limit * .8
  ? `${mbv(u.storage_used)} / ${mbv(u.storage_limit)} MB` : mbv(u.storage_used) + ' MB';
const ic = p => `<i><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0a1a4d" stroke-width="1.8">${p}</svg></i>`;

async function load() {
  U.data = await api('GET', '/admin/users' + qsOf({ q: U.q, status: U.f, page: U.page, per: U.per }));
  U.page = U.data.page;
}

export async function renderUsers() {
  if (!U.data) $('uT').innerHTML = loadingRow(3);
  try { await load(); } catch (e) { return; }
  const { kpi, items, total, page, pages } = U.data;
  $('uKpi').innerHTML = `
    <div class="kpi"><div class="l">${ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>')}Tổng người dùng</div><div class="v">${fmt(kpi.total)}</div><div class="n g">↑ ${kpi.new_week} tài khoản mới tuần này</div></div>
    <div class="kpi"><div class="l">${ic('<path d="M3 20h18M4 16l5-6 4 3 7-8"/>')}Hoạt động hôm nay</div><div class="v">${fmt(kpi.active_today)}</div><div class="n">${kpi.total ? Math.round(kpi.active_today / kpi.total * 100) : 0}% tổng người dùng</div></div>
    <div class="kpi"><div class="l">${ic('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>')}Bị khoá / vô hiệu hoá</div><div class="v">${kpi.locked + kpi.disabled}</div><div class="n">${kpi.locked} bị khoá · ${kpi.disabled} vô hiệu hoá</div></div>
    <div class="kpi"><div class="l">${ic('<path d="M4 20v-6M9 20V8M14 20v-9M19 20V4"/>')}Lượt AI hôm nay</div><div class="v">${fmt(kpi.ai_today)}</div><div class="n">${kpi.ai_today ? 'Hỏi đáp chiếm ' + kpi.qa_share + '%' : 'Chưa có lượt nào'}</div></div>`;
  pills($('uF'), [['all', 'Tất cả'], ['active', 'Hoạt động'], ['locked', 'Bị khoá'], ['disabled', 'Vô hiệu hoá']], U.f);
  const t = $('uT');
  t.innerHTML = `<div class="tr h"><span>Người dùng</span><span>Đăng nhập</span><span>Môn</span><span>Dung lượng</span><span>AI hôm nay</span><span>Trạng thái</span><span></span></div>` +
    (items.length ? items.map(u => { const [c, l] = ST_L(u); return `<div class="tr r${openUid === u.id ? ' sel' : ''}" data-id="${u.id}" tabindex="0"><div class="two"><b>${esc(u.name)}</b><small>${esc(u.key)}</small></div><span>${u.login === 'gg' ? 'Google' : 'SĐT'}</span><span>${u.subjects}</span><span>${mbTxt(u)}</span><span>${u.ai_today}</span><span><span class="bd ${c}">${esc(l)}</span></span><button class="more" data-m="${u.id}" aria-label="Thao tác">···</button></div>`; }).join('')
      : `<div class="empty"><b>Không tìm thấy người dùng</b>${U.q ? 'Thử tên khác, vài số đầu/cuối SĐT hoặc phần đầu Gmail.' : 'Chưa có tài khoản người học nào.'}</div>`);
  tableFoot(t, `Hiển thị ${total ? ((page - 1) * U.per + 1) + '–' + Math.min(page * U.per, total) : 0} trên ${fmt(total)}`,
    page, pages, items.length, U.per, 78, p => { U.page = p; renderUsers(); }, { key: 'users', def: 6, onChange: v => { U.per = v; U.page = 1; renderUsers(); } });
}

$('uF').onclick = e => { const b = e.target.closest('.pill'); if (!b) return; U.f = b.dataset.f; U.page = 1; renderUsers(); };
bindSearch('uQ', 'uQx', v => { U.q = v; U.page = 1; renderUsers(); });
$('uT').onclick = e => {
  const m = e.target.closest('[data-m]');
  if (m) { e.stopPropagation(); const u = U.data.items.find(x => x.id === m.dataset.m); floatMenu(m, userActions(u, true)); return; }
  const r = e.target.closest('.tr.r'); if (r) openDrawer(r.dataset.id);
};
$('uT').onkeydown = e => { if (e.key === 'Enter' && e.target.matches('.tr.r')) openDrawer(e.target.dataset.id); };
$('uExport').onclick = async () => {
  if (await download('/admin/users/export.csv' + qsOf({ q: U.q, status: U.f }), 'nguoi-dung.csv'))
    toast('Đã xuất ' + fmt(U.data ? U.data.total : 0) + ' tài khoản (chỉ số liệu tổng hợp)');
};

function userActions(u, withOpen) {
  const a = [];
  if (withOpen) a.push({ t: 'Xem chi tiết', fn: () => openDrawer(u.id) });
  if (u.status === 'active' || u.status === 'pending_verification') a.push({ t: 'Khoá tài khoản', fn: () => setStatus(u, 'lock') });
  if (u.status === 'locked' || u.status === 'temp') a.push({ t: 'Mở khoá tài khoản', fn: () => setStatus(u, 'unlock') });
  if (u.status === 'disabled') a.push({ t: 'Khôi phục tài khoản', fn: () => setStatus(u, 'restore') });
  if (u.login === 'sdt' && u.status !== 'disabled') a.push({ t: 'Buộc đặt lại mật khẩu', fn: () => forceReset(u) });
  a.push({ t: 'Xem mức sử dụng', fn: () => { closeDrawer(); hooks.showUsage(u); } });
  if (u.status !== 'disabled') a.push({ t: 'Vô hiệu hoá', fn: () => setStatus(u, 'disable') });
  a.push('-', { t: 'Xoá vĩnh viễn tài khoản', dg: 1, fn: () => delUser(u) });
  return a;
}

const UNDO = { lock: 'unlock', disable: 'restore', unlock: 'lock', restore: 'disable' };
async function setStatus(u, action, undo) {
  let r;
  try { r = await api('PATCH', `/admin/users/${u.id}/status`, { action, undo: !!undo }); } catch (e) { return; }
  const msg = action === 'lock' ? `Đã khoá ${u.name} · thu hồi ${r.revoked} phiên đăng nhập`
    : action === 'disable' ? `Đã vô hiệu hoá ${u.name} · tự xoá sau 30 ngày`
    : action === 'restore' ? `Đã khôi phục ${u.name}` : `Đã mở khoá ${u.name}`;
  refresh();
  hooks.refreshAlerts && hooks.refreshAlerts();
  // Mở khoá từ "Khoá tạm" thì hoàn tác không đưa về khoá admin — không cho hoàn tác trường hợp này.
  const canUndo = !undo && !(action === 'unlock' && u.status === 'temp');
  toast(undo ? 'Đã hoàn tác' : msg, canUndo ? () => setStatus(u, UNDO[action], true) : null);
}
function refresh() { if (nav.cur === 'users') renderUsers(); if (openUid) renderDrawer(); }

function forceReset(u) {
  modal(`<h2>Buộc ${esc(u.name)} đặt lại mật khẩu?</h2><p class="sub">Mọi phiên đăng nhập sẽ bị thu hồi. Lần đăng nhập tới, người học phải xác minh OTP gửi tới ${esc(u.key)} rồi đặt mật khẩu mới.</p><div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm pri" id="mOk">Xác nhận</button></div>`, m => {
    m.querySelector('#mC').onclick = closeModal;
    m.querySelector('#mOk').onclick = async () => {
      closeModal();
      try { const r = await api('POST', `/admin/users/${u.id}/force-reset`); toast(`Đã thu hồi ${r.revoked} phiên · ${u.name} sẽ phải xác minh OTP`); } catch (e) { /* đã báo */ }
    };
  });
}

function delUser(u) {
  const isG = u.login === 'gg';
  const lines = u.subjects != null ? `<li>Xoá ${u.subjects} môn học cùng toàn bộ ghi chú, Quiz, Flashcard</li><li>Xoá các tệp trên ổ đĩa (${mbv(u.storage_used)} MB)</li>` : '';
  modal(`<h2>Xoá vĩnh viễn tài khoản ${esc(u.name)}?</h2><p class="sub">Thao tác này không thể hoàn tác. Hệ thống sẽ:</p>
    <ul>${lines}<li>Giữ nhật ký quản trị và góp ý ở dạng ẩn danh</li></ul>
    <span class="fl">${isG ? 'Nhập lại Gmail của tài khoản để xác nhận' : 'Nhập lại SĐT của tài khoản để xác nhận'}</span>
    <input class="inp" id="mIn" autocomplete="off" placeholder="${isG ? 'ten@gmail.com' : '0xxx xxx xxx'}">
    <p class="hint" id="mHint">Định danh đang hiển thị: ${esc(u.key)}</p>
    <div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm dsolid" id="mOk" disabled>Xoá vĩnh viễn</button></div>`, m => {
    const inp = m.querySelector('#mIn'), ok = m.querySelector('#mOk'), h = m.querySelector('#mHint');
    // Server mới biết định danh đầy đủ: phía trình duyệt chỉ đối chiếu với phần đã che để mở khoá nút.
    const masked = u.key;
    const chk = () => {
      const v = isG ? inp.value.trim().toLowerCase() : inp.value.replace(/\D/g, '');
      const full = isG ? /@.+\./.test(v) : v.length >= 10;
      const plausible = isG ? v.startsWith(masked.split('***@')[0].toLowerCase()) && v.endsWith('@' + masked.split('***@')[1])
        : v.startsWith(masked.slice(0, 2)) && v.endsWith(masked.slice(-3));
      ok.disabled = !(full && plausible);
      inp.classList.toggle('err', full && !plausible); h.classList.toggle('err', full && !plausible);
      h.textContent = full && !plausible ? (isG ? 'Gmail không khớp với tài khoản này.' : 'SĐT không khớp với tài khoản này.') : 'Định danh đang hiển thị: ' + masked;
    };
    inp.oninput = chk; inp.onkeydown = e => { if (e.key === 'Enter' && !ok.disabled) ok.click(); };
    m.querySelector('#mC').onclick = closeModal;
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api('DELETE', `/admin/users/${u.id}`, { confirm: inp.value }, { quiet: true });
      } catch (e) {
        inp.classList.add('err'); h.classList.add('err'); h.textContent = e.message; return;
      }
      closeModal(); closeDrawer(); renderUsers(); toast(`Đã xoá vĩnh viễn tài khoản ${u.name}`);
    };
  });
}

/* ---- Drawer chi tiết ---- */
export function openDrawer(id) { openUid = id; renderDrawer(); if (nav.cur === 'users' && U.data) renderUsers(); }
export function closeDrawer() {
  if (!openUid) return; openUid = null;
  layer.querySelector('.drawer')?.remove(); layer.querySelector('.scrim')?.remove();
  if (nav.cur === 'users' && U.data) renderUsers();
}
hooks.openDrawer = openDrawer;
hooks.closeDrawer = closeDrawer;
hooks.resetDrawer = () => { openUid = null; };   // closeAll() đã gỡ DOM drawer

async function renderDrawer() {
  const id = openUid;
  let u;
  try { u = await api('GET', `/admin/users/${id}`); } catch (e) { closeDrawer(); return; }
  if (openUid !== id) return;
  let sc = layer.querySelector('.scrim'), d = layer.querySelector('.drawer');
  if (!d) { sc = document.createElement('div'); sc.className = 'scrim'; sc.onclick = closeDrawer; d = document.createElement('aside'); d.className = 'drawer'; layer.append(sc, d); }
  const [c] = ST_L(u);
  const since = u.since ? parseIso(u.since) : null, lu = u.locked_until ? parseIso(u.locked_until) : null;
  const stTxt = u.status === 'locked' ? 'Bị khoá bởi admin' + (since ? ' · từ ' + ddy(since) : '')
    : u.status === 'disabled' ? `Vô hiệu hoá · tự xoá sau ${u.disabled_days_left} ngày`
    : u.status === 'temp' ? 'Khoá tạm · nhập sai mật khẩu nhiều lần' + (lu ? ', tự mở lúc ' + hhmm(lu) : '')
    : u.status === 'pending_verification' ? 'Chưa xác thực SĐT' : 'Hoạt động';
  const joined = parseIso(u.joined), last = parseIso(u.last_login);
  const q = u.ai.map(f => f.per_session
    ? `<div><span>${esc(f.name)}</span><b title="Hạn mức ${f.limit} lượt mỗi cuộc hội thoại">${f.used} lượt</b></div>`
    : `<div><span>${esc(f.name)}</span><b class="${f.used >= f.limit ? 'full' : ''}">${f.used} / ${f.limit}</b></div>`).join('');
  const prim = u.status === 'disabled' ? `<button class="btn pri" data-a="restore">Khôi phục tài khoản</button>`
    : (u.status === 'locked' || u.status === 'temp') ? `<button class="btn pri" data-a="unlock">Mở khoá tài khoản</button>`
    : `<button class="btn pri" data-a="lock">Khoá tài khoản</button>`;
  const remTxt = u.reminded_level ? ' · đã nhắc ' + (u.reminded_level === 3 ? 'đầy' : 'lần ' + u.reminded_level) : '';
  d.innerHTML = `
    <div class="dh"><div><h2>${esc(u.name)}</h2><p>${esc(u.key)} · Đăng nhập bằng ${u.login === 'gg' ? 'Google' : 'SĐT'}</p></div><button class="xbtn" aria-label="Đóng"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <span class="bd ${c}">${esc(stTxt)}</span>
    <div class="dsec">Tổng quan</div>
    <div class="stats"><div><small>Môn học</small><b>${u.subjects}</b></div><div><small>Dung lượng${remTxt}</small><b>${mbv(u.storage_used)} / ${mbv(u.storage_limit)} MB · ${u.storage_pct}%</b></div><div><small>Tham gia</small><b>${joined ? ddy(joined) : '—'}</b></div><div><small>Đăng nhập gần nhất</small><b>${last ? dd(last) + ', ' + hhmm(last) : 'Chưa có'}</b></div></div>
    <div class="dsec">Lượt AI hôm nay</div>
    <div class="aiq">${q}</div>
    <div class="note">Quản trị viên chỉ xem số liệu tổng hợp, không xem được nội dung ghi chú, tài liệu hay câu hỏi của người học.</div>
    <div class="dsec">Thao tác</div>
    <div class="acts">${prim}
      ${u.login === 'sdt' ? `<button class="btn" data-a="reset"${u.status === 'disabled' ? ' disabled' : ''}>Buộc đặt lại mật khẩu</button><p>Thu hồi mọi phiên đăng nhập. Lần đăng nhập tới phải xác minh OTP qua SMS.</p>` : `<p style="margin:0">Tài khoản Google: mật khẩu do Google quản lý nên không thể buộc đặt lại.</p>`}
      <div class="row2"><button class="btn" data-a="quota">Xem mức sử dụng</button>${u.status === 'disabled' ? '<button class="btn" disabled>Đã vô hiệu hoá</button>' : '<button class="btn" data-a="disable">Vô hiệu hoá</button>'}</div>
      <button class="btn dan" data-a="del">Xoá vĩnh viễn tài khoản</button>
    </div>`;
  d.querySelector('.xbtn').onclick = closeDrawer;
  d.querySelector('.acts').onclick = e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    ({ lock: () => setStatus(u, 'lock'), unlock: () => setStatus(u, 'unlock'), restore: () => setStatus(u, 'restore'),
      disable: () => setStatus(u, 'disable'), reset: () => forceReset(u), del: () => delUser(u),
      quota: () => { closeDrawer(); hooks.showUsage(u); } })[b.dataset.a]();
  };
}

registerPage('users', 'Người dùng', renderUsers);
