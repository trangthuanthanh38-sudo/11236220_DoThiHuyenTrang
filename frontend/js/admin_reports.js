// UC-37 Báo cáo hệ thống — 7 / 30 ngày / tuỳ chọn (≤ 90 ngày), KPI, biểu đồ cột lượt gọi AI, theo tính năng, chạm hạn
// mức, đường người dùng hoạt động (người dùng chốt: bỏ ô Chi phí ước tính và nút Xuất Excel / Xuất PDF). Số liệu tính trực tiếp từ
// ai_usage_events + study_sessions (GET /admin/reports), không lưu.
import { $, api, download, fmt, hooks, iso, dd, ddy, registerPage, toast } from './admin_core.js';

const REP = { r: '7', from: null, to: null, data: null };
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayDiff = (a, b) => Math.round((b - a) / 864e5);

function rangeParams() {
  const to = new Date();
  if (REP.r === 'c') return { from: iso(REP.from), to: iso(REP.to) };
  const from = new Date(); from.setDate(from.getDate() - (+REP.r - 1));
  return { from: iso(from), to: iso(to) };
}
const qs = () => { const p = rangeParams(); return `?from=${p.from}&to=${p.to}`; };

export async function renderRep() {
  document.querySelectorAll('#p-rep .rtools .pill').forEach(b => b.classList.toggle('on', b.dataset.r === REP.r));
  let R;
  try { R = REP.data = await api('GET', '/admin/reports' + qs()); } catch (e) { return; }
  const days = R.days.map(x => ({ ...x, d: fromIso(x.date) })), n = days.length;
  const a = days[0].d, b = days[n - 1].d;
  $('rSub').textContent = `${dd(a)} – ${ddy(b)} · số liệu tính trực tiếp, chỉ lưu khi xuất`;
  const tr = v => (v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' tr';
  const delta = R.prev_calls != null && R.prev_calls ? Math.round((R.calls - R.prev_calls) / R.prev_calls * 100) : null;
  $('rKpi').innerHTML = `
    <div class="kpi"><div class="l">Lượt gọi AI</div><div class="v">${fmt(R.calls)}</div><div class="n ${delta == null ? '' : delta >= 0 ? 'g' : 'r'}">${delta == null ? 'Chưa đủ dữ liệu kỳ trước' : (delta >= 0 ? '↑ ' : '↓ ') + Math.abs(delta) + '% so với kỳ trước'}</div></div>
    <div class="kpi"><div class="l">Token vào / ra</div><div class="v">${tr(R.tokens_in)} / ${tr(R.tokens_out)}</div><div class="n">Gồm ${tr(R.tokens_thinking)} token suy luận</div></div>    <div class="kpi"><div class="l">Lỗi hệ thống</div><div class="v">${R.errors}</div><div class="n ${R.errors ? 'r' : ''}">Gemini ${R.errors_gemini} · máy chủ ${R.errors - R.errors_gemini}</div></div>`;
  drawCharts();
}

// Biểu đồ cột + đường theo bề rộng thật của thẻ (khung Admin giãn theo cửa sổ) — vẽ lại khi đổi cỡ cửa sổ.
function drawCharts() {
  const R = REP.data; if (!R || !$('p-rep').classList.contains('on')) return;
  const days = R.days.map(x => ({ ...x, d: fromIso(x.date) })), n = days.length;
  const W = $('rBars').clientWidth || 564, H = 230, base = 30, top = 26, mx = Math.max(1, ...days.map(x => x.calls)), scale = (H - base - top) / (mx * 1.04);
  const slot = W / n, bw = Math.min(44, slot * .62), every = n <= 10 ? 1 : n <= 31 ? 5 : 10;
  let h = '';
  [0, 1, 2, 3].forEach(i => { h += `<div class="gl" style="top:${top - 6 + i * (H - base - top + 6) / 3}px"></div>`; });
  days.forEach((x, i) => {
    const cx = slot * i + slot / 2, hh = Math.max(2, x.calls * scale), isMx = x.calls === mx && mx > 0;
    h += `<div class="col${isMx ? ' mx' : ''}" data-i="${i}" style="left:${cx - bw / 2}px;width:${bw}px;height:${H - base}px">${n <= 10 ? `<em>${x.calls}</em>` : ''}<i style="height:${hh}px"></i></div>`;
    if (i % every === 0 || (n > 10 && i === n - 1 && (n - 1) % every > every / 2)) h += `<span class="xl" style="left:${cx}px${n > 10 && i === 0 ? ';transform:translateX(-' + Math.min(50, bw / 2 / 0.6) + '%)' : ''}${n > 10 && i === n - 1 ? ';transform:translateX(-80%)' : ''}">${n <= 10 ? WD[x.d.getDay()] : dd(x.d)}</span>`;
  });
  $('rBars').innerHTML = h;
  $('rAvg').textContent = `Trung bình ${fmt(R.calls / n)} lượt / ngày`;
  // Theo tính năng
  const fmax = Math.max(1, ...R.features.map(f => f.calls));
  $('rFeat').innerHTML = R.features.map(f => { const p = R.calls ? f.calls / R.calls * 100 : 0; return `<div><div class="rw">${f.name}<small>${fmt(f.calls)} &nbsp;·&nbsp; ${Math.round(p)}%</small></div><div class="tk"><i style="width:${f.calls / fmax * 100}%"></i></div></div>`; }).join('');
  // Chạm hạn mức
  const H3 = R.hits.slice(0, 3);
  $('rHitSub').textContent = `Bị chặn vì hết lượt ${fmt(R.hits_total)} lần trong kỳ`;
  $('rHits').innerHTML = [...H3.map(x => [x.name, fmt(x.count) + ' lần']), ['Dung lượng', R.storage_near + ' người']].map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  // Người dùng hoạt động
  const us = days.map(x => x.users), avg = us.reduce((s, v) => s + v, 0) / n, umin = Math.min(...us) - 2, umax = Math.max(...us) + 2;
  $('rActSub').textContent = `Trung bình ${fmt(avg)} người / ngày`;
  const LW = $('rLine').clientWidth || 452, LH = 70, px = i => n === 1 ? LW / 2 : 2 + i * (LW - 4) / (n - 1), py = v => 6 + (1 - (v - umin) / ((umax - umin) || 1)) * (LH - 12);
  const umx = Math.max(...us);
  $('rLine').innerHTML = `<svg width="${LW}" height="${LH + 16}" style="overflow:visible"><polyline fill="none" stroke="#0a1a4d" stroke-width="2.4" stroke-linejoin="round" points="${us.map((v, i) => px(i) + ',' + py(v)).join(' ')}"/>${n <= 31 ? us.map((v, i) => `<circle data-i="${i}" cx="${px(i)}" cy="${py(v)}" r="${v === umx ? 5 : 4}" fill="${v === umx ? '#0a1a4d' : '#fff'}" stroke="#0a1a4d" stroke-width="2" style="cursor:pointer"/>`).join('') : ''}</svg>`;
}

function tipAt(host, x, y, html) { let t = host.querySelector('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; host.appendChild(t); } t.innerHTML = html; t.style.left = x + 'px'; t.style.top = y + 'px'; }
const dayAt = i => { const x = REP.data.days[i]; return { ...x, d: fromIso(x.date) }; };
$('rBars').addEventListener('mouseover', e => {
  const c = e.target.closest('.col'); if (!c) return; const x = dayAt(+c.dataset.i);
  const cx = c.offsetLeft + c.offsetWidth / 2, ih = c.querySelector('i').offsetHeight;
  tipAt($('rBars'), cx, (230 - 30) - ih - (c.querySelector('em') ? 26 : 6), `${WD[x.d.getDay()]} ${ddy(x.d)} · <b>${fmt(x.calls)}</b> lượt`);
});
$('rBars').addEventListener('mouseleave', () => $('rBars').querySelector('.tip')?.remove());
$('rLine').addEventListener('mouseover', e => {
  const c = e.target.closest('circle'); if (!c) return; const x = dayAt(+c.dataset.i);
  tipAt($('rLine'), +c.getAttribute('cx'), +c.getAttribute('cy') - 10, `${ddy(x.d)} · <b>${x.users}</b> người`);
});
$('rLine').addEventListener('mouseleave', () => $('rLine').querySelector('.tip')?.remove());

document.querySelectorAll('#p-rep .rtools .pill').forEach(b => { b.onclick = e => {
  e.stopPropagation();
  if (b.dataset.r === 'c') {
    const open = $('rCustom').hidden; $('rCustom').hidden = !open; if (!open) return;
    const p = rangeParams(); $('rFrom').value = p.from; $('rTo').value = p.to;
    const minD = REP.data && REP.data.data_from ? REP.data.data_from : '';
    $('rFrom').min = $('rTo').min = minD; $('rFrom').max = $('rTo').max = iso(new Date()); rChk(); return;
  }
  $('rCustom').hidden = true; REP.r = b.dataset.r; renderRep();
}; });
function rChk() {
  const f = $('rFrom').value ? fromIso($('rFrom').value) : null, t = $('rTo').value ? fromIso($('rTo').value) : null;
  const minD = $('rFrom').min ? fromIso($('rFrom').min) : null, today = fromIso(iso(new Date()));
  let err = '';
  if (!f || !t) err = 'Chọn đủ ngày bắt đầu và kết thúc.';
  else if (f > t) err = 'Ngày bắt đầu phải trước ngày kết thúc.';
  else if ((minD && t < minD) || t > today) err = minD ? 'Chỉ có dữ liệu từ ' + ddy(minD) + ' tới hôm nay.' : 'Không chọn ngày trong tương lai.';
  else if (dayDiff(f, t) + 1 > 90) err = 'Khoảng tối đa 90 ngày.';
  $('rErr').textContent = err || `${dayDiff(f, t) + 1} ngày · ${dd(f)} – ${ddy(t)}`;
  $('rErr').classList.toggle('err', !!err); $('rFrom').classList.toggle('err', !!err && !!f); $('rTo').classList.toggle('err', !!err && !!t);
  $('rApply').disabled = !!err;
}
$('rFrom').oninput = $('rTo').oninput = $('rFrom').onchange = $('rTo').onchange = rChk;
$('rCancel').onclick = () => { $('rCustom').hidden = true; };
$('rApply').onclick = () => { REP.r = 'c'; REP.from = fromIso($('rFrom').value); REP.to = fromIso($('rTo').value); $('rCustom').hidden = true; renderRep(); };
$('rCustom').onclick = e => e.stopPropagation();
document.addEventListener('click', e => { if (!$('rCustom').hidden && !e.target.closest('#rCustom') && !e.target.closest('#rCustomBtn')) $('rCustom').hidden = true; });

registerPage('rep', 'Báo cáo', renderRep);
hooks.onResize = drawCharts;
