// UC-36 File & Storage — KPI, lọc, tìm, xem thông tin (không mở nội dung — BR-16), xử lý lại OCR, xoá kèm lý do
// (chủ sở hữu nhận thông báo). API: /admin/files* .
import {
  $, api, bindSearch, closeModal, download, esc, fmt, fmt1, floatMenu, go, hooks, modal, nav, parseIso, dd, ddy,
  pills, qsOf, registerPage, tableFoot, toast, loadingRow, sizeTxt, loadPer } from './admin_core.js';

// owner = id tài khoản khi mở từ "Xem tệp của người này" (lọc CHÍNH XÁC 1 người — tên hiển thị có thể trùng nhau).
const F = { q: '', f: 'all', owner: '', page: 1, per: loadPer('files', 6), data: null };
const ownerTxt = f => esc(f.owner) + (f.owner_key ? ' · ' + esc(f.owner_key) : '');
const FST = { ok: 'g', ocr: 'r', proc: 'gr', empty: 'a', none: 'gr' };
const typeLink = f => f.type === 'fbimg' ? 'fbimg' : f.type;

export async function renderFiles() {
  if (!F.data) $('fT').innerHTML = loadingRow(3);
  try {
    F.data = await api('GET', '/admin/files' + qsOf({ q: F.owner ? '' : F.q, type: F.f, owner: F.owner, page: F.page, per: F.per }));
  } catch (e) { return; }
  F.page = F.data.page;
  const { kpi, items, total, page, pages } = F.data;
  $('fKpi').innerHTML = `
    <div class="kpi"><div class="l">Tổng dung lượng</div><div class="v">${sizeTxt(kpi.total_bytes)}</div><div class="n">${kpi.disk_bytes ? 'Trên ' + fmt(kpi.disk_bytes / 1073741824) + ' GB dung lượng ổ đĩa' : 'Tệp người học tải lên'}</div></div>
    <div class="kpi"><div class="l">Số tệp</div><div class="v">${fmt(kpi.count)}</div><div class="n">PDF ${kpi.pct.pdf}% · Chat ${kpi.pct.chat}% · Góp ý ${kpi.pct.fbimg}%</div></div>
    <div class="kpi"><div class="l">Tệp xử lý lỗi</div><div class="v">${kpi.errors}</div><div class="n ${kpi.errors ? 'r' : ''}">OCR lỗi hoặc tệp trống</div></div>
    <div class="kpi"><div class="l">Gần chạm hạn mức</div><div class="v">${kpi.near} người</div><div class="n ${kpi.near ? 'a' : ''}">Đã dùng trên ${kpi.w1}% dung lượng</div></div>`;
  pills($('fF'), [['all', 'Tất cả'], ['pdf', 'PDF'], ['chat', 'Đính kèm chat'], ['fbimg', 'Ảnh góp ý'], ['err', 'Lỗi xử lý']], F.f);
  const t = $('fT');
  t.innerHTML = `<div class="tr h"><span>Tệp</span><span>Chủ sở hữu</span><span>Dung lượng</span><span>Ngày tải</span><span>Trạng thái xử lý</span><span></span></div>` +
    (items.length ? items.map(f => { const d = parseIso(f.created_at); return `<div class="tr r" data-id="${esc(f.id)}" data-t="${f.type}"><div class="two"><b>${esc(f.name)}</b><small>${f.type_label}${f.subject ? ' · ' + esc(f.subject) : ''}</small></div><div class="two"><b style="font-weight:400">${esc(f.owner)}</b>${f.owner_key ? `<small>${esc(f.owner_key)}</small>` : ''}</div><span>${sizeTxt(f.size_bytes)}</span><span>${d ? dd(d) : '—'}</span><span><span class="bd ${FST[f.status]}">${f.status_label}</span></span><button class="more" data-m="${esc(f.id)}" data-t="${f.type}" aria-label="Thao tác">···</button></div>`; }).join('')
      : `<div class="empty"><b>Không có tệp phù hợp</b>${F.f === 'err' ? 'Mọi tệp đều đã được xử lý.' : 'Thử từ khoá khác.'}</div>`);
  tableFoot(t, 'Xoá tệp sẽ gửi thông báo cho chủ sở hữu. Nội dung tệp không hiển thị cho quản trị viên.',
    page, pages, items.length, F.per, 70, p => { F.page = p; renderFiles(); }, { key: 'files', def: 6, onChange: v => { F.per = v; F.page = 1; renderFiles(); } });
}

$('fF').onclick = e => { const b = e.target.closest('.pill'); if (!b) return; F.f = b.dataset.f; F.page = 1; renderFiles(); };
bindSearch('fQ', 'fQx', v => { F.q = v; F.owner = ''; F.page = 1; renderFiles(); });
$('fT').onclick = e => {
  const m = e.target.closest('[data-m]'), r = e.target.closest('.tr.r');
  const el = m || r; if (!el) return;
  const f = F.data.items.find(x => x.id === (m ? m.dataset.m : r.dataset.id) && x.type === el.dataset.t); if (!f) return;
  if (!m) { fileInfo(f); return; }
  e.stopPropagation();
  floatMenu(m, [
    { t: f.status === 'empty' ? 'Xử lý lại' : 'Xử lý lại (OCR)', dis: !(f.type === 'pdf' && (f.status === 'ocr' || f.status === 'empty')), fn: () => reprocess(f) },
    { t: 'Xem thông tin tệp', fn: () => fileInfo(f) },
    { t: 'Xoá tệp và báo chủ sở hữu', dg: 1, fn: () => delFile(f) },
  ]);
};

async function reprocess(f) {
  f.status = 'proc'; f.status_label = 'Đang xử lý'; renderFilesRowsOnly();
  toast(`Đang xử lý lại ${f.name}… (PDF scan có thể mất vài chục giây)`);
  let r;
  try { r = await api('POST', `/admin/files/pdf/${f.id}/reprocess`); } catch (e) { renderFiles(); return; }
  toast(r.status === 'ok' ? `Đã lập chỉ mục ${f.name}` : r.status === 'empty' ? `${f.name} vẫn không có nội dung — nên xoá và báo chủ sở hữu` : `${f.name} vẫn lỗi xử lý`);
  if (nav.cur === 'files') renderFiles();
  hooks.refreshAlerts && hooks.refreshAlerts();
}
// Đổi nhãn trạng thái ngay trên bảng đang hiện (không chờ tải lại).
function renderFilesRowsOnly() {
  document.querySelectorAll('#fT .tr.r').forEach(row => {
    const f = F.data.items.find(x => x.id === row.dataset.id && x.type === row.dataset.t);
    if (f) row.querySelector('.bd').outerHTML = `<span class="bd ${FST[f.status]}">${f.status_label}</span>`;
  });
}

function fileInfo(f) {
  const d = parseIso(f.created_at);
  modal(`<h2>${esc(f.name)}</h2>
    <div class="kv"><span>Loại</span><b style="font-weight:400">${f.type_label}</b><span>Chủ sở hữu</span><b style="font-weight:400">${ownerTxt(f)}</b>${f.subject ? `<span>Môn học</span><b style="font-weight:400">${esc(f.subject)}</b>` : ''}<span>Dung lượng</span><b style="font-weight:400">${sizeTxt(f.size_bytes)}</b><span>Ngày tải</span><b style="font-weight:400">${d ? ddy(d) : '—'}</b>${f.pages != null ? `<span>Số trang</span><b style="font-weight:400">${f.pages}</b>` : ''}<span>Trạng thái</span><span><span class="bd ${FST[f.status]}">${f.status_label}</span></span></div>
    <div class="note" style="margin-top:4px">Theo BR-16, quản trị viên chỉ xem thông tin tệp, không mở được nội dung.</div>
    <div class="mf"><button class="btn sm" id="mC">Đóng</button></div>`, m => { m.querySelector('#mC').onclick = closeModal; });
}

function delFile(f) {
  modal(`<h2>Xoá tệp ${esc(f.name)}?</h2><p class="sub">Tệp sẽ bị xoá khỏi ổ đĩa và ${ownerTxt(f)} nhận thông báo kèm lý do.</p>
    <span class="fl">Lý do gửi chủ sở hữu</span>
    <select class="inp" id="mR"><option>Tệp lỗi, không xử lý được</option><option>Tệp trống hoặc hỏng</option><option>Vi phạm điều khoản sử dụng</option><option>Trùng lặp</option></select>
    <div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm dsolid" id="mOk">Xoá tệp</button></div>`, m => {
    m.querySelector('#mC').onclick = closeModal;
    m.querySelector('#mOk').onclick = async () => {
      const reason = m.querySelector('#mR').value; closeModal();
      try { await api('DELETE', `/admin/files/${typeLink(f)}/${encodeURIComponent(f.id)}`, { reason }); } catch (e) { return; }
      renderFiles(); hooks.refreshAlerts && hooks.refreshAlerts();
      toast(`Đã xoá ${f.name} · đã báo ${f.owner}${f.owner_key ? " (" + f.owner_key + ")" : ""}: “${reason}”`);
    };
  });
}

$('fExport').onclick = async () => {
  if (await download('/admin/files/export.csv' + qsOf({ q: F.owner ? '' : F.q, type: F.f, owner: F.owner }), 'tep-luu-tru.csv'))
    toast('Đã xuất ' + fmt(F.data ? F.data.total : 0) + ' tệp (không kèm nội dung)');
};

// Hạn mức -> "Xem tệp của người này" ; chuông -> "N tệp xử lý lỗi".
// u = {id, name, key}: lọc theo id; ô tìm hiện "Tên · định danh", gõ lại / bấm × thì bỏ lọc theo người.
hooks.showFilesOf = u => { F.owner = u.id; F.q = u.name + (u.key ? ' · ' + u.key : ''); F.f = 'all'; F.page = 1; $('fQ').value = F.q; $('fQx').hidden = false; if (nav.cur === 'files') renderFiles(); else go('files'); };
hooks.showFileErrors = () => { F.q = ''; F.owner = ''; F.f = 'err'; F.page = 1; $('fQ').value = ''; $('fQx').hidden = true; if (nav.cur === 'files') renderFiles(); else go('files'); };

registerPage('files', 'File & Storage', renderFiles);
