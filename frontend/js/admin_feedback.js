// UC-35 Xử lý góp ý — danh sách theo Mới / Đang xử lý / Đã xong, khung chi tiết, gửi phản hồi (về chuông người học),
// đóng, đổi trạng thái (có Hoàn tác), đánh dấu trùng, mở lại, xem ảnh đính kèm (ngoại lệ BR-16, máy chủ ghi nhật ký).
// API: /admin/feedback* . Bản nháp phản hồi giữ trong bộ nhớ theo từng góp ý (mất khi tải lại trang).
// Luồng trạng thái (người dùng chốt): bấm MỞ 1 góp ý "Mới" rồi rời đi (chọn góp ý khác / đổi tab / sang trang khác /
// đóng trang) -> tự chuyển "Đang xử lý". "Gửi phản hồi" báo tới chuông người học nhưng góp ý VẪN "Đang xử lý" (gửi được
// nhiều lần); chỉ khi admin đổi trạng thái sang "Đã xong" (hoặc "Đóng góp ý") mới chuyển.
import { $, api, closeModal, esc, hooks, loadPer, modal, pager, parseIso, perSelect, dd, hhmm, isToday, registerPage, toast, token } from './admin_core.js';

const G = { tab: 'new', sel: null, page: 1, per: loadPer('fb', 5), data: null, detail: null, seenNew: null };
const drafts = {};
const FBCAT = { ai: ['r', 'Nội dung AI sai'], bug: ['a', 'Lỗi ứng dụng'], idea: ['p', 'Đề xuất'] };
const FBST = { new: 'Mới', doing: 'Đang xử lý', done: 'Đã xong' };

function shortTime(s) {
  const d = parseIso(s); if (!d) return '';
  if (isToday(d)) return hhmm(d);
  const y = new Date(); y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString() ? 'Hôm qua' : dd(d);
}
const fullTime = s => { const d = parseIso(s); return d ? `${dd(d)}/${d.getFullYear()}, ${hhmm(d)}` : ''; };

export function fbCounts(counts) {
  const n = counts ? counts.new : 0;
  $('fbCnt').textContent = n; $('fbCnt').hidden = !n;
}
hooks.fbCounts = fbCounts;

// keepDetail: chỉ làm mới danh sách + số đếm (poll chuông có góp ý mới) — không vẽ lại khung chi tiết đang đọc / đang gõ.
export async function renderFb(keepDetail) {
  try { G.data = await api('GET', `/admin/feedback?status=${G.tab}&page=${G.page}&per=${G.per}`); } catch (e) { return; }
  G.page = G.data.page;
  const { counts, items, total, page, pages } = G.data;
  fbCounts(counts);
  $('fbSub').textContent = (counts.new ? counts.new + ' góp ý mới' : 'Không có góp ý mới')
    + (counts.doing ? ' · ' + counts.doing + ' đang xử lý' : '') + ' · phản hồi được gửi tới chuông thông báo của người học';
  $('fbTabs').innerHTML = [['new', 'Mới'], ['doing', 'Đang xử lý'], ['done', 'Đã xong']]
    .map(([k, t]) => `<button class="pill s${G.tab === k ? ' on' : ''}" data-t="${k}">${t}${k !== 'done' ? ' · ' + (counts[k] || 0) : ''}</button>`).join('');
  if (!keepDetail && !items.some(f => f.id === G.sel)) G.sel = items[0] ? items[0].id : null;
  $('fbList').innerHTML = items.length ? items.map(f => { const [c, l] = FBCAT[f.category]; return `<button class="fbi${f.id === G.sel ? ' on' : ''}" data-id="${f.id}"><div class="rw"><span class="bd ${c}">${l}</span><span>${shortTime(f.created_at)}</span></div><b>${esc(f.title)}</b><small>${esc(f.user || 'Người dùng đã xoá')} · ${FBST[f.status]}${f.duplicate_of ? ' · trùng #GY-' + f.duplicate_of : ''}</small></button>`; }).join('')
    : `<div class="empty" style="font-size:17px"><b>Trống</b>${G.tab === 'new' ? 'Đã xử lý hết góp ý mới.' : 'Chưa có góp ý ở trạng thái này.'}</div>`;
  $('fbPg').innerHTML = `<span>${total} góp ý</span><span class="sp"></span>`;
  $('fbPg').appendChild(perSelect('fb', 5, G.per, async v => { await leaveNew(); G.per = v; G.page = 1; renderFb(); }));
  if (pages > 1) $('fbPg').appendChild(pager(page, pages, async p => { await leaveNew(); G.page = p; renderFb(); }));
  if (!keepDetail) renderFbDetail();
}
hooks.refreshFbList = () => renderFb(true);

// Góp ý "Mới" admin đã bấm mở -> khi rời khỏi nó thì chuyển "Đang xử lý" (auto=true: nhật ký ghi "Đã xem góp ý mới").
async function leaveNew(nextId) {
  const id = G.seenNew;
  if (!id || id === nextId) return false;
  G.seenNew = null;
  try { await api('PATCH', `/admin/feedback/${id}`, { status: 'doing', auto: true }, { quiet: true }); } catch (e) { return false; }
  hooks.refreshAlerts && hooks.refreshAlerts();
  return true;
}
function leaveNewOnUnload() {   // đóng tab / tải lại khi đang mở 1 góp ý Mới: gửi nốt bằng keepalive
  const id = G.seenNew; if (!id) return;
  G.seenNew = null;
  try {
    fetch(API_BASE + `/admin/feedback/${id}`, { method: 'PATCH', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify({ status: 'doing', auto: true }) });
  } catch (e) { /* bỏ qua */ }
}
addEventListener('pagehide', leaveNewOnUnload);

async function renderFbDetail() {
  const d = $('fbD');
  if (!G.sel) { d.innerHTML = `<div class="empty" style="margin:auto"><b>Chọn một góp ý</b>Chi tiết sẽ hiển thị ở đây.</div>`; return; }
  let f;
  try { f = await api('GET', `/admin/feedback/${G.sel}`); } catch (e) { return; }
  G.detail = f;
  const [c, l] = FBCAT[f.category];
  d.innerHTML = `
    <div class="hd"><div><h2>#GY-${f.id}<span class="bd ${c}">${l}</span></h2><div class="meta">${esc(f.user ? f.user + ' · ' + f.user_key : 'Người dùng đã xoá')} · ${fullTime(f.created_at)}</div></div>
      <div class="sts"><button id="stsBtn">Trạng thái: <b>${FBST[f.status]}</b><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg></button><div class="menu" id="stsM" hidden>${Object.entries(FBST).map(([k, t]) => `<button data-s="${k}">${f.status === k ? '✓ ' : ''}${t}</button>`).join('')}</div></div></div>
    <div class="lb">Nội dung góp ý</div><div class="tx">${esc(f.body)}</div>
    ${f.quote_text ? `<div class="lb">Trích đoạn được báo</div><div class="quote">${f.quote_heading ? `<small>${esc(f.quote_heading)}</small>` : ''}<div class="tx">${esc(f.quote_text)}</div></div>` : ''}
    ${f.context.length ? `<div class="lb">Ngữ cảnh</div><div class="ctx">${f.context.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${f.image ? `<div class="lb">Ảnh người học đính kèm</div><button class="att" id="attBtn"><i><svg width="26" height="22" viewBox="0 0 26 22" fill="none" stroke="#696868" stroke-width="1.6"><rect x="1" y="1" width="24" height="20" rx="2"/><path d="M1 16l7-6 6 5 4-3 7 6"/></svg></i><span><b>${esc(f.image.name)} · ${(f.image.bytes / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB</b><small>Được xem theo ngoại lệ BR-16</small></span></button>` : ''}
    ${f.status === 'done' ? (f.reply ? `<div class="lb">Đã phản hồi người học</div><div class="sent"><small>✓ Đã gửi tới chuông thông báo</small>${esc(f.reply)}</div>` : `<div class="lb">Kết quả</div><div class="sent" style="background:var(--row)"><small style="color:var(--muted)">Đã đóng${f.duplicate_of ? ' · trùng với #GY-' + f.duplicate_of : ''}</small>Không gửi phản hồi cho người học.</div>`)
      : f.user ? `<div class="lb">Phản hồi người học</div><textarea class="reply" id="fbR" placeholder="Viết phản hồi gửi tới người học…" maxlength="500">${esc(drafts[f.id] || '')}</textarea>`
      : `<div class="lb">Phản hồi người học</div><div class="sent" style="background:var(--row)">Người gửi đã xoá tài khoản nên không gửi được phản hồi.</div>`}
    <div class="ft">${f.status === 'done' ? `<span class="sp"></span><button class="btn" id="fbReopen">Mở lại góp ý</button>` :
      `<button class="link" id="fbDup">Đánh dấu trùng với góp ý khác</button><span class="sp"></span><button class="btn" id="fbClose">Đóng góp ý</button>${f.user ? '<button class="btn pri" id="fbSend">Gửi phản hồi</button>' : ''}`}</div>`;
  const R = $('fbR');
  if (R) R.oninput = () => { drafts[f.id] = R.value; R.classList.remove('err'); if (f.status === 'new') G.seenNew = f.id; };
  $('stsBtn').onclick = e => { e.stopPropagation(); $('stsM').hidden = !$('stsM').hidden; };
  $('stsM').onclick = e => { const b = e.target.closest('[data-s]'); if (b) setFb(f, b.dataset.s); };
  if ($('attBtn')) $('attBtn').onclick = () => viewImage(f);
  if ($('fbSend')) $('fbSend').onclick = async () => {
    const v = R.value.trim(); if (!v) { R.classList.add('err'); R.focus(); toast('Nhập nội dung phản hồi trước khi gửi'); return; }
    try { await api('POST', `/admin/feedback/${f.id}/reply`, { reply: v }); } catch (e) { return; }
    delete drafts[f.id];
    if (G.seenNew === f.id) G.seenNew = null;
    G.tab = 'doing'; G.sel = f.id; G.page = 1;   // góp ý ở lại "Đang xử lý" — chuyển danh sách theo để thấy tiếp
    renderFb(); hooks.refreshAlerts && hooks.refreshAlerts(); toast(`Đã gửi phản hồi tới ${f.user} · góp ý vẫn Đang xử lý`);
  };
  if ($('fbClose')) $('fbClose').onclick = () => setFb(f, 'done', true);
  if ($('fbReopen')) $('fbReopen').onclick = () => setFb(f, 'doing');
  if ($('fbDup')) $('fbDup').onclick = () => markDup(f);
}

async function setFb(f, st, closing) {
  const prev = f.status;
  if (prev === st) { $('stsM').hidden = true; return; }
  if (G.seenNew === f.id) G.seenNew = null;
  try { await api('PATCH', `/admin/feedback/${f.id}`, { status: st, closing: !!closing }); } catch (e) { return; }
  renderFb(); hooks.refreshAlerts && hooks.refreshAlerts();
  toast(closing ? `Đã đóng #GY-${f.id} (không gửi phản hồi)` : `#GY-${f.id} → ${FBST[st]}`, async () => {
    try { await api('PATCH', `/admin/feedback/${f.id}`, { status: prev }); } catch (e) { return; }
    renderFb(); hooks.refreshAlerts && hooks.refreshAlerts();
  });
}

async function markDup(f) {
  let others = [];
  try {
    const lists = await Promise.all(['new', 'doing', 'done'].map(s => api('GET', `/admin/feedback?status=${s}&per=50`)));
    others = lists.flatMap(x => x.items).filter(x => x.id !== f.id);
  } catch (e) { return; }
  if (!others.length) { toast('Chưa có góp ý nào khác để gộp'); return; }
  modal(`<h2>Đánh dấu #GY-${f.id} là trùng</h2><p class="sub">Góp ý này sẽ được đóng và gộp vào góp ý gốc.</p><span class="fl">Trùng với</span><select class="inp" id="mD">${others.map(x => `<option value="${x.id}">#GY-${x.id} · ${esc(x.title)}</option>`).join('')}</select><div class="mf"><button class="btn sm" id="mC">Huỷ</button><button class="btn sm pri" id="mOk">Đánh dấu trùng</button></div>`, m => {
    m.querySelector('#mC').onclick = closeModal;
    m.querySelector('#mOk').onclick = async () => {
      const id = +m.querySelector('#mD').value; closeModal();
      try { await api('PATCH', `/admin/feedback/${f.id}`, { duplicate_of: id }); } catch (e) { return; }
      renderFb(); hooks.refreshAlerts && hooks.refreshAlerts(); toast(`Đã gộp #GY-${f.id} vào #GY-${id}`);
    };
  });
}

async function viewImage(f) {
  let url = null;
  try {
    const res = await fetch(API_BASE + `/admin/feedback/${f.id}/image`, { headers: { Authorization: 'Bearer ' + token() } });
    if (res.ok) url = URL.createObjectURL(await res.blob());
  } catch (e) { /* hiện khung trống */ }
  modal(`<h2>${esc(f.image.name)}</h2><div style="height:360px;border-radius:12px;background:var(--bg);display:grid;place-items:center;overflow:hidden">${url ? `<img src="${url}" alt="" style="max-width:100%;max-height:360px;object-fit:contain">` : '<span style="color:var(--muted)">Không tải được ảnh</span>'}</div><p class="hint" style="margin:0">Ảnh do người học chủ động đính kèm nên được xem theo ngoại lệ BR-16. Việc mở ảnh đã được ghi nhật ký.</p><div class="mf"><button class="btn sm" id="mC">Đóng</button></div>`, m => {
    m.querySelector('#mC').onclick = () => { closeModal(); if (url) URL.revokeObjectURL(url); };
  });
}

$('fbTabs').onclick = async e => { const b = e.target.closest('[data-t]'); if (!b) return; await leaveNew(); G.tab = b.dataset.t; G.page = 1; G.sel = null; renderFb(); };
$('fbList').onclick = async e => {
  const b = e.target.closest('.fbi'); if (!b) return;
  const id = +b.dataset.id, item = (G.data ? G.data.items : []).find(x => x.id === id);
  const moved = await leaveNew(id);          // góp ý Mới vừa xem trước đó -> Đang xử lý
  G.sel = id;
  if (item && item.status === 'new') G.seenNew = id;   // admin chủ động bấm mở góp ý Mới
  if (moved) { renderFb(); return; }
  document.querySelectorAll('.fbi').forEach(x => x.classList.toggle('on', x === b)); renderFbDetail();
};
document.addEventListener('click', e => { const m = $('stsM'); if (m && !m.hidden && !e.target.closest('.sts')) m.hidden = true; });

registerPage('fb', 'Góp ý', () => renderFb(), () => { leaveNew(); return true; });
