// UC-33 Hạn mức sử dụng — tab "Cấu hình chung" (bản nháp + Hoàn tác + Lưu, kiểm như máy chủ) và tab "Theo tài
// khoản" (người đã vượt nhắc lần 1 / sắp hết lượt AI). API: /admin/quota* . Lưu = hộp xác nhận bắt buộc LÝ DO (gửi
// thông báo tới mọi người học) + chọn Cố định / Tạm thời tới 1 thời điểm (hết hạn máy chủ tự về mức cố định). Lưu xong
// máy chủ tự tính lại mức của mọi người học và gửi nhắc cho ai vừa chạm ngưỡng (services/quota.refresh_level).
// Hỏi đáp (per_session) là số lượt MỖI CUỘC HỘI THOẠI, các tính năng AI khác là lượt mỗi ngày.
import {
  $, api, bindSearch, closeModal, download, esc, fmt, floatMenu, go, hooks, modal, nav, pills, qsOf,
  registerPage, stamp, tableFoot, toast, loadingRow, mbv, loadPer } from './admin_core.js';

const WARN_KEYS = ['warn.w1', 'warn.w2', 'warn.ai'];
let CFG = null;       // dữ liệu GET /admin/quota
let QD = {};          // bản nháp: key -> chuỗi đang gõ
let qTab = 'cfg';
const A = { q: '', f: 'all', page: 1, per: loadPer('quota', 7), data: null };

const fitNum = i => { i.style.width = ''; };   // độ rộng cố định theo CSS (.num input 4ch) để các ô thẳng hàng
const allRows = () => [...CFG.features, ...CFG.storage];
const saved = () => { const o = {}; allRows().forEach(r => { o[r.key] = r.value; }); o['warn.w1'] = CFG.warn.w1; o['warn.w2'] = CFG.warn.w2; o['warn.ai'] = CFG.warn.ai; return o; };
function qInit() { QD = {}; Object.entries(saved()).forEach(([k, v]) => { QD[k] = String(v); }); }
const qDirty = () => CFG && Object.entries(saved()).some(([k, v]) => String(QD[k]).trim() !== String(v));
const qValid = (v, cap) => /^\d+$/.test(String(v).trim()) && +v > 0 && +v <= cap;
function tErr() {
  const [a, b, c] = WARN_KEYS.map(k => String(QD[k]).trim());
  if (![a, b, c].every(v => /^\d+$/.test(v))) return 'Ngưỡng nhắc phải là số nguyên.';
  if (+a < 50 || +a >= +b) return 'Nhắc lần 1 phải từ 50% và nhỏ hơn nhắc lần 2.';
  if (+b > 99) return 'Nhắc lần 2 tối đa 99% — tới 100% hệ thống tự chặn tải lên.';
  if (+c < 5 || +c > 50) return 'Nhắc lượt AI: từ 5% tới 50% số lượt còn lại.';
  return '';
}
// Nhãn "Tạm thời tới … · về …" của hạn mức đang tạm thời (CFG.temporary từ GET /admin/quota).
const pad2 = n => String(n).padStart(2, '0');
const dm = iso => { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`; };
function tmpTag(key, unit) {
  const t = CFG.temporary && CFG.temporary[key]; if (!t) return '';
  return `<span class="qtmp" title="Hạn mức tạm thời tới ${dm(t.expires_at)} — sau đó tự trở về mức cố định ${fmt(t.base)}${unit || ''}">Tạm thời → ${fmt(t.base)} lúc ${dm(t.expires_at)}</span>`;
}
// Số cố định sẽ trở về nếu lưu tạm thời: đang tạm thời thì vẫn là số cố định cũ, không thì là giá trị đang lưu.
const fixedOf = k => (CFG.temporary && CFG.temporary[k]) ? CFG.temporary[k].base : saved()[k];
const unitOf = k => {
  const f = CFG.features.find(x => x.key === k);
  if (f) return f.per_session ? 'lượt / cuộc hội thoại' : f.feature === 'feedback' ? 'lần gửi / ngày' : 'lượt / ngày';
  const s = CFG.storage.find(x => x.key === k); if (s) return s.unit;
  return '%';
};
const WARN_NAMES = { 'warn.w1': 'Nhắc lần 1', 'warn.w2': 'Nhắc lần 2', 'warn.ai': 'Nhắc lượt AI (còn)' };
const nameOf = k => (allRows().find(r => r.key === k) || {}).name || WARN_NAMES[k];
const withUnit = (v, k) => unitOf(k) === '%' ? fmt(v) + '%' : fmt(v) + ' ' + unitOf(k);
const changes = () => { const o = {}; Object.entries(saved()).forEach(([k, v]) => { if (String(QD[k]).trim() !== String(v)) o[k] = +String(QD[k]).trim(); }); return o; };

export async function renderQuota() {
  document.querySelectorAll('#qTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === qTab));
  $('qCfg').hidden = qTab !== 'cfg'; $('qAcc').hidden = qTab !== 'acc';
  $('qUndo').hidden = $('qSave').hidden = qTab !== 'cfg'; $('aExport').hidden = qTab !== 'acc';
  try { await loadNear(); } catch (e) { /* đã báo */ }
  if (qTab === 'acc') { renderAcc(); return; }
  if (!CFG || !qDirty()) {
    if (!CFG) $('qT').innerHTML = loadingRow(2);
    try { CFG = await api('GET', '/admin/quota'); } catch (e) { return; }
    qInit();
  }
  $('qT').innerHTML = `<div class="tr h"><span>Tính năng</span><span>Hạn mức</span><span>Lượt hôm nay</span><span>Chạm hạn mức</span></div>` +
    CFG.features.map(f => `<div class="tr"><span class="qname"><span style="display:flex;align-items:center">${esc(f.name)}<span class="ed-tag" data-tag="${f.key}" hidden>Đã sửa</span></span>${tmpTag(f.key, f.per_session ? ' lượt / hội thoại' : ' lượt')}</span><span><label class="num" data-num="${f.key}"><input type="number" min="1" max="${f.cap}" value="${esc(QD[f.key])}" data-k="${f.key}" aria-label="Hạn mức ${esc(f.name)}"><span>${f.per_session ? 'lượt / hội thoại' : 'lượt / ngày'}</span></label></span><span>${fmt(f.used_today)}</span><span title="${f.per_session ? 'Số người có cuộc hội thoại đã dùng hết lượt hôm nay' : ''}">${f.hit_today ? f.hit_today + ' người' : '0'}</span></div>`).join('');
  $('sT').innerHTML = CFG.storage.map((s, i) => `<div class="srow"><div class="rw"><span style="display:flex;align-items:center">${esc(s.name)}<span class="ed-tag" data-tag="${s.key}" hidden>Đã sửa</span></span><label class="num" data-num="${s.key}"><input type="number" min="1" max="${s.cap}" value="${esc(QD[s.key])}" data-k="${s.key}" aria-label="${esc(s.name)}"><span>${s.unit}</span></label></div><small>${i === 0 ? fmt(CFG.users_over_w1) + ' người dùng trên ' + CFG.warn.w1 + '%' : esc(s.note || '')}</small>${tmpTag(s.key, ' ' + s.unit)}</div>`).join('');
  document.querySelectorAll('[data-ti]').forEach(inp => {
    inp.value = QD[WARN_KEYS[+inp.dataset.ti]];
    const box = inp.closest('.srow, .airow'); box.querySelector('.qtmp')?.remove();
    const tag = tmpTag(WARN_KEYS[+inp.dataset.ti], '%'); if (tag) box.insertAdjacentHTML('beforeend', tag);
  });
  document.querySelectorAll('#qCfg .num input').forEach(fitNum);
  qSync();
}

function qSync() {
  if (!CFG) return;
  allRows().forEach(r => {
    const ok = qValid(QD[r.key], r.cap), ch = String(QD[r.key]).trim() !== String(r.value);
    const n = document.querySelector(`[data-num="${r.key}"]`); if (!n) return;
    n.classList.toggle('bad', !ok); n.classList.toggle('ed', ok && ch);
    document.querySelector(`[data-tag="${r.key}"]`).hidden = !(ok && ch);
  });
  const te = tErr(), sv = saved();
  WARN_KEYS.forEach((k, i) => { const n = document.querySelector(`[data-tnum="${i}"]`); n.classList.toggle('bad', !!te); n.classList.toggle('ed', !te && String(QD[k]).trim() !== String(sv[k])); });
  const fe = !allRows().every(r => qValid(QD[r.key], r.cap));
  const valid = !fe && !te, dirty = qDirty();
  $('qFoot').className = 'qfoot' + (valid ? '' : ' err');
  $('qFoot').textContent = te || (fe ? 'Có giá trị không hợp lệ: phải là số nguyên lớn hơn 0 và không vượt trần (Hỏi đáp 200, công cụ khác 50; dung lượng 5.000 MB, tệp 100 MB, 200 tệp).'
    : 'Giá trị phải lớn hơn 0 và không vượt trần kỹ thuật: Hỏi đáp 200 lượt mỗi cuộc hội thoại, các công cụ khác 50 lượt mỗi ngày.');
  $('qUndo').disabled = !dirty; $('qSave').disabled = !dirty || !valid;
}

$('p-quota').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.k) QD[t.dataset.k] = t.value;
  else if (t.dataset.ti != null) QD[WARN_KEYS[+t.dataset.ti]] = t.value;
  else return;
  fitNum(t); qSync();
});
$('qTabs').onclick = e => {
  const b = e.target.closest('[data-t]'); if (!b || b.dataset.t === qTab) return;
  const sw = () => { qTab = b.dataset.t; renderQuota(); };
  if (qTab === 'cfg' && qDirty()) { confirmLeave(sw); return; }
  sw();
};
$('qUndo').onclick = () => { qInit(); renderQuota(); toast('Đã hoàn tác các thay đổi chưa lưu'); };
// Lưu = hộp xác nhận: danh sách thay đổi, LÝ DO bắt buộc (gửi tới người học), Cố định / Tạm thời tới 1 thời điểm.
const localInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
$('qSave').onclick = async () => {
  const values = changes();
  let pv;
  try { pv = await api('POST', '/admin/quota/preview', { values }); } catch (e) { return; }
  const list = Object.entries(values).map(([k, v]) => `<li><span>${esc(nameOf(k))}: ${withUnit(saved()[k], k)} → <b>${withUnit(v, k)}</b></span></li>`).join('');
  const full = pv.newly_full ? `<p class="hint err">${fmt(pv.newly_full)} tài khoản sẽ vượt hạn mức mới — tệp hiện có được giữ nguyên, những tài khoản này bị chặn tải thêm cho tới khi dọn bớt.</p>` : '';
  const back = 'Khi hết hạn: ' + Object.keys(values).map(k => `${nameOf(k)} về ${withUnit(fixedOf(k), k)}`).join(', ') + '.';
  modal(`<h2>Lưu thay đổi hạn mức</h2><p class="sub">Hạn mức mới áp dụng ngay. Lý do và hạn mức mới được gửi vào chuông thông báo của mọi người học.</p>
    <ul>${list}</ul>${full}
    <div class="fl">Lý do thay đổi (người học sẽ thấy)</div>
    <textarea class="inp" id="mR" maxlength="300" placeholder="Vd. Máy chủ AI đang quá tải, tạm giảm lượt để mọi người đều dùng được"></textarea>
    <div class="hint" id="mRh"></div>
    <div class="fl">Thời gian áp dụng</div>
    <div class="qseg" id="mMode"><button type="button" data-m="perm" class="on">Cố định</button><button type="button" data-m="temp">Tạm thời</button></div>
    <div id="mTemp" style="display:none;flex-direction:column;gap:10px">
      <div class="qtime"><span>Trở về mức cố định lúc</span><input type="datetime-local" class="inp" id="mU">
        <button type="button" class="chip" data-d="1">+1 ngày</button><button type="button" class="chip" data-d="3">+3 ngày</button><button type="button" class="chip" data-d="7">+7 ngày</button></div>
      <div class="hint" id="mUh"></div>
    </div>
    <div class="mf"><button class="btn sm" id="mC">Xem lại</button><button class="btn sm pri" id="mOk" disabled>Lưu &amp; thông báo</button></div>`, m => {
    let mode = 'perm';
    const R = m.querySelector('#mR'), U = m.querySelector('#mU'), ok = m.querySelector('#mOk'), now = Date.now();
    U.value = localInput(new Date(now + 864e5));
    U.min = localInput(new Date(now + 5 * 6e4)); U.max = localInput(new Date(now + 90 * 864e5));
    const check = () => {
      const r = R.value.trim(), t = U.value ? new Date(U.value).getTime() : NaN, n = Date.now();
      const tOk = mode === 'perm' || (t - n >= 5 * 6e4 && t - n <= 90 * 864e5);
      m.querySelector('#mRh').textContent = `Bắt buộc · tối thiểu 5 ký tự · ${R.value.length} / 300`;
      U.classList.toggle('err', !tOk);
      m.querySelector('#mUh').className = 'hint' + (tOk ? '' : ' err');
      m.querySelector('#mUh').textContent = tOk ? back : 'Chọn thời điểm sau ít nhất 5 phút và trong vòng 90 ngày.';
      ok.disabled = r.length < 5 || !tOk;
    };
    R.oninput = check; U.oninput = check;
    m.querySelector('#mMode').onclick = e => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      mode = b.dataset.m;
      m.querySelectorAll('#mMode button').forEach(x => x.classList.toggle('on', x === b));
      m.querySelector('#mTemp').style.display = mode === 'temp' ? 'flex' : 'none';
      check();
    };
    m.querySelectorAll('.qtime .chip').forEach(c => { c.onclick = () => { U.value = localInput(new Date(Date.now() + +c.dataset.d * 864e5)); check(); }; });
    m.querySelector('#mC').onclick = closeModal;
    ok.onclick = () => { closeModal(); doSave(values, R.value.trim(), mode === 'temp' ? U.value : null); };
    check();
  });
};
async function doSave(values, reason, until) {
  $('qSave').disabled = true;
  let r;
  try { r = await api('PUT', '/admin/quota', { values, reason, until }); } catch (e) { qSync(); return; }
  CFG = null;
  await renderQuota();
  hooks.refreshAlerts && hooks.refreshAlerts();
  toast(`Đã lưu ${r.changed} thay đổi` + (until ? ' (tạm thời)' : '') + ` · đã thông báo tới ${fmt(r.notified)} người học`
    + (r.reminded ? ` · ${fmt(r.reminded)} tài khoản vừa chạm ngưỡng` : ''));
}
function confirmLeave(next) {
  modal(`<h2>Bỏ thay đổi chưa lưu?</h2><p class="sub">Bạn đã sửa hạn mức nhưng chưa lưu. Rời đi sẽ bỏ các thay đổi này.</p><div class="mf"><button class="btn sm" id="mC">Ở lại</button><button class="btn sm pri" id="mOk">Bỏ thay đổi</button></div>`, m => {
    m.querySelector('#mC').onclick = closeModal;
    m.querySelector('#mOk').onclick = () => { closeModal(); qInit(); next(); };
  });
}

/* ---- Tab theo tài khoản ---- */
async function loadNear() {
  A.data = await api('GET', '/admin/quota/accounts' + qsOf({ q: A.q, filter: A.f, page: A.page, per: A.per }));
  A.page = A.data.page;
  $('qNear').textContent = fmt(A.data.counts.all);
}
const useCell = (txt, p, w1) => { const c = p >= 95 ? 'd' : p >= w1 ? 'w' : ''; return `<div class="use"><span class="${c}">${txt}</span><i><b class="${c}" style="width:${Math.max(1.5, Math.min(100, p))}%"></b></i></div>`; };
function remBadge(r, warn) {
  const rem = r.reminder;
  if (rem && rem.level === 3) return `<span class="bd r">Đầy · chặn tải lên</span><small>${rem.at ? 'báo lúc ' + stamp(rem.at) : ''}</small>`;
  if (rem && rem.level) return `<span class="bd ${rem.level === 2 ? 'r' : 'a'}">Đã nhắc lần ${rem.level} · ${rem.kind === 'file' ? 'tệp' : (rem.level === 2 ? warn.w2 : warn.w1) + '%'}</span><small>${rem.at ? stamp(rem.at) : ''}</small>`;
  if (rem && rem.kind === 'ai') return `<span class="bd n">Nhắc lượt AI</span><small>${rem.at ? stamp(rem.at) : ''}</small>`;
  return '<small>Chưa cần nhắc</small>';
}
function renderAcc() {
  const { counts, items, total, page, pages, warn } = A.data;
  pills($('aF'), [['all', 'Tất cả · ' + counts.all], ['mb', 'Dung lượng · ' + counts.mb], ['file', 'Số tệp · ' + counts.file], ['ai', 'Lượt AI · ' + counts.ai], ['full', 'Đã đầy · ' + counts.full]], A.f);
  const t = $('aT');
  t.innerHTML = `<div class="tr h"><span>Người dùng</span><span>Dung lượng</span><span>Tệp nhiều nhất / môn</span><span>Lượt AI cao nhất · hôm nay</span><span>Đã nhắc</span><span></span></div>` +
    (items.length ? items.map(r => `<div class="tr r" data-id="${r.id}"><div class="two"><b>${esc(r.name)}</b><small>${esc(r.key)}</small></div>
      ${useCell(`${mbv(r.storage_used)} / ${mbv(r.storage_limit)} MB · ${Math.round(r.storage_pct)}%`, r.storage_pct, warn.w1)}${useCell(`${r.fmax} / ${r.file_limit}${r.fsub ? ' · ' + esc(r.fsub) : ''}`, r.file_pct, warn.w1)}${useCell(`${r.ai.used} / ${r.ai.limit} · ${esc(r.ai.name)}`, r.ai.near ? Math.max(r.ai.pct, warn.w1) : r.ai.pct, warn.w1)}
      <div class="remc">${remBadge(r, warn)}</div><button class="more" data-m="${r.id}" aria-label="Thao tác">···</button></div>`).join('')
      : `<div class="empty"><b>Không có tài khoản nào</b>${A.q ? 'Thử từ khoá khác.' : 'Chưa ai chạm ngưỡng nhắc trong mục này.'}</div>`);
  tableFoot(t, `Nhắc được gửi tự động khi chạm ${warn.w1}% / ${warn.w2}%. Admin chỉ xem số liệu, không xem nội dung tệp.`,
    page, pages, items.length, A.per, 78, p => { A.page = p; renderQuota(); }, { key: 'quota', def: 7, onChange: v => { A.per = v; A.page = 1; renderQuota(); } });
}
$('aF').onclick = e => { const b = e.target.closest('.pill'); if (!b) return; A.f = b.dataset.f; A.page = 1; renderQuota(); };
bindSearch('aQ', 'aQx', v => { A.q = v; A.page = 1; renderQuota(); });
$('aT').onclick = e => {
  const m = e.target.closest('[data-m]'), r = e.target.closest('.tr.r');
  const row = A.data.items.find(x => x.id === (m ? m.dataset.m : r ? r.dataset.id : ''));
  if (!row) return;
  if (!m) { hooks.openDrawer(row.id); return; }
  e.stopPropagation();
  floatMenu(m, [
    { t: 'Xem chi tiết người dùng', fn: () => hooks.openDrawer(row.id) },
    { t: 'Gửi lại nhắc', dis: !(row.reminder && row.reminder.level), fn: async () => {
      try { await api('POST', `/admin/quota/accounts/${row.id}/remind`); } catch (err) { return; }
      renderQuota(); toast(`Đã gửi lại nhắc tới ${row.name}`);
    } },
    { t: 'Xem tệp của người này', fn: () => hooks.showFilesOf(row) },
  ]);
};
$('aExport').onclick = async () => {
  if (await download('/admin/quota/accounts/export.csv' + qsOf({ q: A.q, filter: A.f }), 'muc-su-dung.csv'))
    toast('Đã xuất ' + fmt(A.data ? A.data.total : 0) + ' tài khoản (chỉ số liệu tổng hợp)');
};

// Người dùng -> "Xem mức sử dụng": mở tab Theo tài khoản, lọc sẵn theo tên.
hooks.showUsage = u => {
  A.q = u.name; A.f = 'all'; A.page = 1; $('aQ').value = u.name; $('aQx').hidden = false; qTab = 'acc';
  if (nav.cur === 'quota') renderQuota(); else go('quota');
};

hooks.showFull = () => {
  A.q = ''; A.f = 'full'; A.page = 1; $('aQ').value = ''; $('aQx').hidden = true; qTab = 'acc';
  if (nav.cur === 'quota') renderQuota(); else go('quota');
};

registerPage('quota', 'Hạn mức', renderQuota, next => { if (qTab === 'cfg' && qDirty()) { confirmLeave(next); return false; } return true; });
