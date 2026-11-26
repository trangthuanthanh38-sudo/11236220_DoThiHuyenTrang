// UC-34 Nhật ký quản trị — chỉ đọc (BR-18): lọc loại, khoảng 7 / 30 ngày / toàn bộ, tìm, xuất CSV. API: /admin/logs* .
import { $, api, bindSearch, download, esc, fmt, parseIso, dd, hhmm, pills, qsOf, registerPage, tableFoot, toast, loadingRow, loadPer } from './admin_core.js';

const Lg = { q: '', f: 'all', page: 1, per: loadPer('logs', 8), r: 7, data: null };
const p2 = n => String(n).padStart(2, '0');
function rangeText(r) {
  if (!r) return 'Toàn bộ thời gian';
  const b = new Date(), a = new Date(); a.setDate(a.getDate() - (r - 1));
  return `${p2(a.getDate())}/${p2(a.getMonth() + 1)} – ${p2(b.getDate())}/${p2(b.getMonth() + 1)}/${b.getFullYear()}`;
}

export async function renderLogs() {
  pills($('lF'), [['all', 'Tất cả'], ['acc', 'Tài khoản'], ['quota', 'Hạn mức'], ['file', 'Tệp'], ['fb', 'Góp ý']], Lg.f);
  $('lRangeBtn').innerHTML = rangeText(Lg.r) + ' <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>';
  $('lRange').innerHTML = [[7, '7 ngày qua'], [30, '30 ngày qua'], [0, 'Toàn bộ thời gian']].map(([k, t]) => `<button data-r="${k}">${Lg.r === k ? '✓ ' : ''}${t}</button>`).join('');
  if (!Lg.data) $('lT').innerHTML = loadingRow(3);
  try { Lg.data = await api('GET', '/admin/logs' + qsOf({ q: Lg.q, cat: Lg.f, days: Lg.r, page: Lg.page, per: Lg.per })); } catch (e) { return; }
  Lg.page = Lg.data.page;
  const { items, total, page, pages } = Lg.data;
  const t = $('lT');
  t.innerHTML = `<div class="tr h"><span>Thời gian</span><span>Quản trị viên</span><span>Thao tác</span><span>Đối tượng</span><span>Thay đổi</span></div>` +
    (items.length ? items.map(l => { const d = parseIso(l.at); return `<div class="tr r"><span>${dd(d)}, ${hhmm(d)}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.by)}</span><span style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.action)}</span><div class="two"><b>${esc(l.object)}</b><small>${esc(l.sub)}</small></div><span class="chg">${esc(l.from)}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg><b class="${l.bad ? 'r' : ''}">${esc(l.to)}</b></span></div>`; }).join('')
      : `<div class="empty"><b>Không có thao tác nào</b>Thử bộ lọc hoặc khoảng thời gian khác.</div>`);
  tableFoot(t, `Hiển thị ${items.length} trên ${fmt(total)} thao tác`, page, pages, items.length, Lg.per, 74, p => { Lg.page = p; renderLogs(); }, { key: 'logs', def: 8, onChange: v => { Lg.per = v; Lg.page = 1; renderLogs(); } });
}

$('lF').onclick = e => { const b = e.target.closest('.pill'); if (!b) return; Lg.f = b.dataset.f; Lg.page = 1; renderLogs(); };
bindSearch('lQ', 'lQx', v => { Lg.q = v; Lg.page = 1; renderLogs(); });
$('lRangeBtn').onclick = e => { e.stopPropagation(); $('lRange').hidden = !$('lRange').hidden; };
$('lRange').onclick = e => { const b = e.target.closest('[data-r]'); if (!b) return; Lg.r = +b.dataset.r; Lg.page = 1; $('lRange').hidden = true; renderLogs(); };
document.addEventListener('click', e => { if (!$('lRange').hidden && !e.target.closest('.range')) $('lRange').hidden = true; });
$('lExport').onclick = async () => {
  if (await download('/admin/logs/export.csv' + qsOf({ q: Lg.q, cat: Lg.f, days: Lg.r }), 'nhat-ky-quan-tri.csv'))
    toast('Đã xuất ' + fmt(Lg.data ? Lg.data.total : 0) + ' dòng nhật ký');
};

registerPage('logs', 'Nhật ký', renderLogs);
