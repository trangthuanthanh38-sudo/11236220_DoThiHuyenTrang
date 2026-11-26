/* ======================================================================
   ghichu_ve.js — Thẻ Draw (vẽ TRỰC TIẾP trên trang, kiểu Microsoft Word)
   dùng chung cho trang soạn thảo Chương và từng trang File PDF:
   • Bộ bút: Chọn, Tẩy (xoá cả nét / hình chạm vào), 7 bút có sẵn (bút bi
     đen / đỏ, bút chì, bút dạ quang, bút máy, bút chì xanh lá, bút thiên
     hà) + "+" thêm bút riêng; bấm lại bút đang chọn → chỉnh màu / độ dày.
   • Hình khối (menu theo Word): Đường kẻ (thẳng, mũi tên, 2 đầu, gấp khúc
     ×3), Hình cơ bản, Đồ thị (trục toạ độ), Khoá chế độ vẽ, Bắt dính lưới.
     Hình đã vẽ: kéo để di chuyển, tay nắm để đổi cỡ / đầu mút, nhấn đúp
     (hoặc nút "Chữ") để gõ chữ bên trong, thanh định dạng: viền / nền /
     độ dày / xoá.
   • Nền trang (chỉ Chương): dòng kẻ ngang hoặc ô lưới (Format Background).
   Mọi thứ nằm ở 1 LỚP CHỒNG lên nội dung (.dv-layer), KHÔNG đi vào HTML
   của CKEditor. Toạ độ lưu theo "đơn vị tài liệu" do adapter quy đổi:
   Chương = px CSS của trang soạn thảo (lưu ở chapters.drawing_json),
   PDF = PDF user space (lưu ở pdf_annotations type 'draw' / 'shape') —
   adapter do ghichu_soanthao.js tạo, module này chỉ import ghichu_core.js.
   Mỗi thao tác = 1 bước hoàn tác riêng của lớp vẽ (Ctrl+Z / Ctrl+Y khi
   đang cầm bút / hình hoặc đang chọn 1 nét / hình).
   ====================================================================== */
import { hooks, state, el, esc, buildGroup, openDropdown } from "./ghichu_core.js";

var SVGNS = "http://www.w3.org/2000/svg";

/* ---------------- Bút ---------------- */
var PEN_KINDS = {
  pen: { label: "Pen", widths: [1, 2, 3.5, 5, 8] },
  pencil: { label: "Pencil", widths: [1, 2, 3, 5, 8], legacy: true },   // chỉ để vẽ lại nét cũ, không còn trong bộ bút
  marker: { label: "Highlighter", widths: [6, 10, 14, 20, 28] },
  fountain: { label: "Fountain Pen", widths: [1.5, 2.5, 3.5, 5, 7] },
  brush: { label: "Brush Pen", widths: [3, 5, 8, 12, 18] },
  laser: { label: "Laser Pointer", widths: [3, 4, 6, 8, 10], laser: true },   // chỉ chỉ trỏ: nét tự mờ dần, không lưu
  galaxy: { label: "Galaxy Pen", widths: [2, 3, 4, 6, 9], legacy: true },
};
// Bộ bút mặc định theo mẫu Word (người dùng chốt): bút bi đen / đỏ, bút thiên hà, bút dạ quang vàng, bút máy xanh,
// bút xanh lá, bút thiên hà, bút xanh lá, bút máy xanh. Cặp trùng màu khác nhau ở độ dày.
var DEFAULT_PENS = [
  { id: "p1", kind: "pen", color: "#000000", w: 2 },
  { id: "p2", kind: "pen", color: "#e71224", w: 2 },
  { id: "p3", kind: "pen", color: "tex:galaxy", w: 3.5 },
  { id: "p4", kind: "marker", color: "#ffff00", w: 14 },
  { id: "p5", kind: "fountain", color: "#004f8b", w: 2.5 },
  { id: "p6", kind: "pen", color: "#008c3a", w: 2 },
  { id: "p7", kind: "pen", color: "tex:galaxy", w: 5 },
  { id: "p8", kind: "pen", color: "#008c3a", w: 3.5 },
  { id: "p9", kind: "fountain", color: "#004f8b", w: 3.5 },
];
// Bảng màu của bút (theo mẫu Word): 16 màu trơn + 8 màu vân "tex:<tên>" (vẽ bằng dải chuyển màu).
var PEN_COLORS = [
  "#ffc114", "#f6630d", "#ff0066", "#e71224",
  "#5b2d90", "#ab008b", "#cc0066", "#004f8b",
  "#00a0d7", "#33ccff", "#008c3a", "#66cc00",
  "#000000", "#333333", "#849398", "#f2f2f2",
  "tex:rainbow", "tex:galaxy", "tex:lava", "tex:ocean",
  "tex:rosegold", "tex:gold", "tex:silver", "tex:bronze",
];
var TEX = {
  rainbow: { label: "Rainbow", stops: ["#e03131", "#f59f00", "#ffd43b", "#40c057", "#1c7ed6", "#7048e8"] },
  galaxy: { label: "Galaxy", stops: ["#3b1c78", "#7048e8", "#4dabf7", "#63e6be"] },
  lava: { label: "Lava", stops: ["#5c0a0a", "#c92a2a", "#ff6b6b", "#8a1010"] },
  ocean: { label: "Ocean", stops: ["#0b3d4a", "#0c8599", "#66d9e8", "#0b4f5c"] },
  rosegold: { label: "Rose Gold", stops: ["#d98c7a", "#f6cfc4", "#e0a090", "#f3c2b6"] },
  gold: { label: "Gold", stops: ["#b8860b", "#ffd700", "#daa520", "#fff1a8"] },
  silver: { label: "Silver", stops: ["#868e96", "#e9ecef", "#adb5bd", "#f1f3f5"] },
  bronze: { label: "Bronze", stops: ["#8c5a2b", "#cd7f32", "#e0a060", "#8c5a2b"] },
};
function texOf(c) { return typeof c === "string" && c.indexOf("tex:") === 0 ? TEX[c.slice(4)] || TEX.galaxy : null; }
// Màu dùng cho CSS (ô màu, chip): màu vân → linear-gradient.
function cssPaint(c) { var t = texOf(c); return t ? "linear-gradient(135deg," + t.stops.join(",") + ")" : (c || "#000"); }
// Màu trơn đại diện (nét đang vẽ dở).
function solidOf(c) { var t = texOf(c); return t ? t.stops[Math.floor(t.stops.length / 2)] : (c || "#000"); }
function colorName(c) { var t = texOf(c); return t ? t.label : c; }
// Dải màu của 1 nét: màu vân, hoặc bút thiên hà kiểu cũ (kind 'galaxy'); null = màu trơn.
function inkStops(item) {
  var t = texOf(item.color);
  if (t) return t.stops;
  if (inkKind(item) === "galaxy") return [item.color || "#7048e8", "#4dabf7", "#63e6be"];
  return null;
}
var PALETTE = [
  "#000000", "#495057", "#868e96", "#ffffff", "#e03131", "#f76707", "#fcc419", "#2f9e44",
  "#1c7ed6", "#1b3a6b", "#7048e8", "#d6336c", "#ffe066", "#8ce99a", "#74c0fc", "#b197fc",
];
var MAX_PENS = 14;

function loadPens() {
  try {
    var raw = JSON.parse(localStorage.getItem("td_draw_pens_v2") || "null");
    if (Array.isArray(raw) && raw.length && raw.every(function (p) { return p && PEN_KINDS[p.kind] && p.id; })) return raw;
  } catch (e) { /* bỏ qua */ }
  return DEFAULT_PENS.map(function (p) { return Object.assign({}, p); });
}
function loadRecent() {
  try { var r = JSON.parse(localStorage.getItem("td_draw_recent") || "null"); if (Array.isArray(r) && r.length) return r.slice(0, 4); } catch (e) { /* bỏ qua */ }
  return ["#008c3a", "#e71224", "#004f8b", "tex:galaxy"];
}
function pushRecent(c) {
  dv.recentColors = [c].concat(dv.recentColors.filter(function (x) { return x !== c; })).slice(0, 4);
  try { localStorage.setItem("td_draw_recent", JSON.stringify(dv.recentColors)); } catch (e) { /* bỏ qua */ }
}
function savePens() { try { localStorage.setItem("td_draw_pens_v2", JSON.stringify(dv.pens)); } catch (e) { /* bỏ qua */ } }

/* ---------------- Trạng thái chung ---------------- */
export var dv = {
  tool: null,          // null (Chọn) | 'pen' | 'eraser' | 'shape'
  pens: loadPens(),
  recentColors: loadRecent(),
  penId: "p1",
  shape: "rect",
  lock: false,         // Khoá chế độ vẽ: vẽ xong hình vẫn giữ công cụ hình
  snap: false,         // Bắt dính lưới
  stroke: "#1971c2",   // màu viền / độ dày mặc định cho hình mới
  fill: "none",
  sw: 2,
  sel: null,           // {s: surface, item}
  editing: null,       // {s, item, node} — đang gõ chữ trong hình
  recent: false,       // thao tác gần nhất là trên lớp vẽ (Ctrl+Z / Ctrl+Y thuộc lớp vẽ)
  onToolChange: null,  // ghichu_soanthao.js: chọn công cụ vẽ thì tắt công cụ chú thích PDF cũ (Hộp văn bản)
};
try { var st0 = JSON.parse(localStorage.getItem("td_draw_opts") || "{}"); dv.lock = !!st0.lock; dv.snap = !!st0.snap; if (st0.penId) dv.penId = st0.penId; } catch (e) { /* bỏ qua */ }
function saveOpts() { try { localStorage.setItem("td_draw_opts", JSON.stringify({ lock: dv.lock, snap: dv.snap, penId: dv.penId })); } catch (e) { /* bỏ qua */ } }

function curPen() { return dv.pens.filter(function (p) { return p.id === dv.penId; })[0] || dv.pens[0]; }

export function setTool(tool, opts) {
  opts = opts || {};
  if (tool !== null) finishTextEdit();
  dv.tool = tool;
  if (opts.shape) dv.shape = opts.shape;
  if (tool) selectItem(null);
  surfaces.forEach(function (s) { s.layer.classList.toggle("active", !!tool && !s.ad.readOnly()); s.layer.setAttribute("data-tool", tool || ""); });
  if (tool && dv.onToolChange) dv.onToolChange(tool);
  if (!opts.silent) hooks.renderRibbon();
}

/* ---------------- Lớp vẽ (surface) ----------------
   adapter: { list(), add(item), remove(item), update(item), toPx(pt)->[x,y], fromPx([x,y])->pt, k() px / đơn vị,
              readOnly(), key (khoá lịch sử hoàn tác), gridPx()?, eraseExtra(px)?, afterRender(maxBottomPx)? } */
var surfaces = new Set();
var uid = new WeakMap(), uidSeq = 1;
function idOf(item) { if (!uid.has(item)) uid.set(item, uidSeq++); return uid.get(item); }

export function mountSurface(host, ad) {
  var s = { host: host, ad: ad };
  s.layer = el("div", "dv-layer");
  s.svg = document.createElementNS(SVGNS, "svg");
  s.svg.setAttribute("class", "dv-ink");
  s.shapes = el("div", "dv-shapes");
  s.ui = el("div", "dv-ui");
  s.layer.appendChild(s.svg); s.layer.appendChild(s.shapes); s.layer.appendChild(s.ui);
  host.appendChild(s.layer);
  s.layer.addEventListener("pointerdown", function (e) { onDown(s, e); });
  s.layer.addEventListener("dblclick", function (e) { onDbl(s, e); });
  surfaces.add(s);
  s.layer.classList.toggle("active", !!dv.tool && !ad.readOnly());
  s.layer.setAttribute("data-tool", dv.tool || "");
  render(s);
  return s;
}
export function unmountSurface(s) {
  if (!s) return;
  if (dv.sel && dv.sel.s === s) selectItem(null);
  if (dv.editing && dv.editing.s === s) dv.editing = null;
  surfaces.delete(s);
  if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
}
export function refreshSurface(s) { if (s && surfaces.has(s)) render(s); }
export function refreshAll() { surfaces.forEach(render); }

/* ---------------- Hình học ---------------- */
var LINE_SHAPES = ["line", "arrow", "darrow", "elbow", "elbowArrow", "elbowDArrow"];
var SHAPE_MENU = [
  { title: "Lines", items: [
    ["line", "Line"], ["arrow", "Arrow"], ["darrow", "Double Arrow"],
    ["elbow", "Elbow Connector"], ["elbowArrow", "Elbow Arrow Connector"], ["elbowDArrow", "Elbow Double-Arrow Connector"]] },
  { title: "Basic Shapes", items: [
    ["rect", "Rectangle"], ["ellipse", "Oval"], ["parallelogram", "Parallelogram"], ["triangle", "Isosceles Triangle"],
    ["diamond", "Diamond"], ["roundrect", "Rounded Rectangle"], ["star", "Star: 5 Points"]] },
  { title: "Graphs", items: [["axes2", "Graph: Quadrant I"], ["axes4", "Graph: Four Quadrants"], ["axes3", "Graph: 3D Axes"]] },
];
function isLine(shape) { return LINE_SHAPES.indexOf(shape) >= 0; }
function isClosed(shape) { return !isLine(shape) && shape.indexOf("axes") !== 0; }
function f(n) { return Math.round(n * 10) / 10; }

function headD(from, to, sw) {
  var ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  var L = Math.max(9, sw * 3.6), W = L * 0.5;
  var bx = to[0] - L * Math.cos(ang), by = to[1] - L * Math.sin(ang);
  return "M" + f(to[0]) + " " + f(to[1]) + " L" + f(bx + W * Math.sin(ang)) + " " + f(by - W * Math.cos(ang)) +
    " L" + f(bx - W * Math.sin(ang)) + " " + f(by + W * Math.cos(ang)) + " Z";
}
// Hình (px) từ 2 điểm a, b: {d: đường viền, heads: [mũi tên tô kín], labels: [{x,y,t}], closed}
export function shapeGeo(shape, a, b, sw) {
  var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  var X2 = x + w, Y2 = y + h, cx = x + w / 2, cy = y + h / 2;
  var M = function (p) { return "M" + f(p[0]) + " " + f(p[1]); }, Lt = function (p) { return " L" + f(p[0]) + " " + f(p[1]); };
  var g = { d: "", heads: [], labels: [], closed: isClosed(shape) };
  var corner = [b[0], a[1]];
  switch (shape) {
    case "line": g.d = M(a) + Lt(b); break;
    case "arrow": g.d = M(a) + Lt(b); g.heads.push(headD(a, b, sw)); break;
    case "darrow": g.d = M(a) + Lt(b); g.heads.push(headD(a, b, sw), headD(b, a, sw)); break;
    case "elbow": g.d = M(a) + Lt(corner) + Lt(b); break;
    case "elbowArrow": g.d = M(a) + Lt(corner) + Lt(b); g.heads.push(headD(corner, b, sw)); break;
    case "elbowDArrow": g.d = M(a) + Lt(corner) + Lt(b); g.heads.push(headD(corner, b, sw), headD(corner, a, sw)); break;
    case "rect": g.d = M([x, y]) + Lt([X2, y]) + Lt([X2, Y2]) + Lt([x, Y2]) + " Z"; break;
    case "roundrect": {
      var r = Math.min(w, h) * 0.18;
      g.d = "M" + f(x + r) + " " + f(y) + " H" + f(X2 - r) + " Q" + f(X2) + " " + f(y) + " " + f(X2) + " " + f(y + r) + " V" + f(Y2 - r) +
        " Q" + f(X2) + " " + f(Y2) + " " + f(X2 - r) + " " + f(Y2) + " H" + f(x + r) + " Q" + f(x) + " " + f(Y2) + " " + f(x) + " " + f(Y2 - r) +
        " V" + f(y + r) + " Q" + f(x) + " " + f(y) + " " + f(x + r) + " " + f(y) + " Z";
      break;
    }
    case "ellipse":
      g.d = "M" + f(cx) + " " + f(y) + " A" + f(w / 2) + " " + f(h / 2) + " 0 1 1 " + f(cx) + " " + f(Y2) + " A" + f(w / 2) + " " + f(h / 2) + " 0 1 1 " + f(cx) + " " + f(y) + " Z";
      break;
    case "parallelogram": { var o = w * 0.25; g.d = M([x + o, y]) + Lt([X2, y]) + Lt([X2 - o, Y2]) + Lt([x, Y2]) + " Z"; break; }
    case "triangle": g.d = M([cx, y]) + Lt([X2, Y2]) + Lt([x, Y2]) + " Z"; break;
    case "diamond": g.d = M([cx, y]) + Lt([X2, cy]) + Lt([cx, Y2]) + Lt([x, cy]) + " Z"; break;
    case "star": {
      var pts = [];
      for (var i = 0; i < 10; i++) {
        var ang = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 0.4 : 1;
        pts.push([cx + Math.cos(ang) * w / 2 * rr, cy + Math.sin(ang) * h / 2 * rr + h * 0.04]);
      }
      g.d = pts.map(function (p, i2) { return (i2 ? "L" : "M") + f(p[0]) + " " + f(p[1]); }).join(" ") + " Z";
      break;
    }
    case "axes2": {
      var O = [x + w * 0.08, Y2 - h * 0.08];
      g.d = M(O) + Lt([O[0], y]) + " " + M(O) + Lt([X2, O[1]]);
      g.heads.push(headD(O, [O[0], y], sw), headD(O, [X2, O[1]], sw));
      g.labels.push({ x: O[0] + 8, y: y + 12, t: "y" }, { x: X2 - 6, y: O[1] + 16, t: "x" }, { x: O[0] - 12, y: O[1] + 14, t: "O" });
      break;
    }
    case "axes4": {
      g.d = M([cx, Y2]) + Lt([cx, y]) + " " + M([x, cy]) + Lt([X2, cy]);
      g.heads.push(headD([cx, Y2], [cx, y], sw), headD([x, cy], [X2, cy], sw));
      g.labels.push({ x: cx + 8, y: y + 12, t: "y" }, { x: X2 - 6, y: cy + 16, t: "x" }, { x: cx - 12, y: cy + 14, t: "O" });
      break;
    }
    case "axes3": {
      var O3 = [x + w * 0.38, y + h * 0.58];
      g.d = M(O3) + Lt([O3[0], y]) + " " + M(O3) + Lt([X2, O3[1]]) + " " + M(O3) + Lt([x, Y2]);
      g.heads.push(headD(O3, [O3[0], y], sw), headD(O3, [X2, O3[1]], sw), headD(O3, [x, Y2], sw));
      g.labels.push({ x: O3[0] + 8, y: y + 12, t: "y" }, { x: X2 - 6, y: O3[1] + 16, t: "x" }, { x: x + 14, y: Y2 - 2, t: "z" });
      break;
    }
    default: g.d = M([x, y]) + Lt([X2, y]) + Lt([X2, Y2]) + Lt([x, Y2]) + " Z";
  }
  return g;
}

function smoothD(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return "M" + f(pts[0][0]) + " " + f(pts[0][1]) + " l0.01 0.01";
  var d = "M" + f(pts[0][0]) + " " + f(pts[0][1]);
  for (var i = 1; i < pts.length - 1; i++) {
    var mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += " Q" + f(pts[i][0]) + " " + f(pts[i][1]) + " " + f(mx) + " " + f(my);
  }
  var l = pts[pts.length - 1];
  return d + " L" + f(l[0]) + " " + f(l[1]);
}

/* ---------------- Vẽ ra SVG / DOM ---------------- */
function inkW(item) { return item.w != null ? item.w : (item.strokeWidth || 2.5); }
function inkKind(item) { return item.kind || "pen"; }
function inkOpacity(item) { return item.op != null ? item.op : (inkKind(item) === "marker" ? 0.45 : 1); }
function pathsOf(item) { return item.paths || (item.pts ? [item.pts] : []); }

function inkSvg(s, item, idx) {
  var k = s.ad.k(), kind = inkKind(item), w = inkW(item) * k, color = item.color || "#000";
  var out = "";
  pathsOf(item).forEach(function (path) {
    var px = path.map(s.ad.toPx);
    var d = smoothD(px);
    var common = 'd="' + d + '" fill="none" stroke-linecap="round" stroke-linejoin="round"';
    var stops = inkStops(item);
    if (stops) {
      var gid = "dvg" + idOf(item) + "_" + idx + "_" + out.length;
      var xs = px.map(function (p) { return p[0]; }), ys = px.map(function (p) { return p[1]; });
      out += '<defs><linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse" x1="' + f(Math.min.apply(null, xs)) + '" y1="' + f(Math.min.apply(null, ys)) +
        '" x2="' + f(Math.max.apply(null, xs) + 1) + '" y2="' + f(Math.max.apply(null, ys) + 1) + '">' +
        stops.map(function (c, i) { return '<stop offset="' + f(i / (stops.length - 1)) + '" stop-color="' + esc(c) + '"/>'; }).join("") + "</linearGradient></defs>" +
        '<path ' + common + ' stroke="url(#' + gid + ')" stroke-width="' + f(kind === "fountain" ? w * 0.8 : w) + '" opacity="' + inkOpacity(item) + '"' +
        (kind === "marker" ? ' class="dv-marker"' : ' filter="url(#dv-glow)"') + "/>";
    } else if (kind === "marker") out += '<path class="dv-marker" ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w) + '" opacity="' + inkOpacity(item) + '"/>';
    else if (kind === "brush") {
      out += '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w) + '" opacity=".92"/>' +
        '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w * 0.45) + '" opacity=".35" transform="translate(' + f(w * 0.28) + " " + f(w * 0.22) + ')"/>';
    }
    else if (kind === "pencil") out += '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w) + '" opacity="0.88" filter="url(#dv-pencil)"/>';
    else if (kind === "fountain") {
      out += '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w * 0.55) + '"/>' +
        '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w * 0.55) + '" transform="translate(' + f(w * 0.35) + " " + f(-w * 0.35) + ')"/>';
    } else out += '<path ' + common + ' stroke="' + esc(color) + '" stroke-width="' + f(w) + '" opacity="' + inkOpacity(item) + '"/>';
    // vùng bấm chọn rộng hơn nét thật
    out += '<path class="dv-hit" data-dv="' + idx + '" d="' + d + '" fill="none" stroke="transparent" stroke-width="' + f(Math.max(12, w + 8)) + '" stroke-linecap="round" stroke-linejoin="round"/>';
  });
  return out;
}

function shapeBoxPx(s, item) {
  var a = s.ad.toPx(item.a), b = s.ad.toPx(item.b);
  return { a: a, b: b, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

function shapeNode(s, item, idx) {
  var k = s.ad.k(), bx = shapeBoxPx(s, item);
  var sw = (item.sw != null ? item.sw : 2) * k;
  var g = shapeGeo(item.shape, bx.a, bx.b, sw);
  var pad = Math.max(16, sw * 5);
  var node = el("div", "dv-shape" + (isClosed(item.shape) ? " closed" : ""));
  node.setAttribute("data-dv", idx);
  node.style.left = (bx.x - pad) + "px"; node.style.top = (bx.y - pad) + "px";
  node.style.width = (bx.w + pad * 2) + "px"; node.style.height = (bx.h + pad * 2) + "px";
  var stroke = item.stroke || "#1971c2", fill = item.fill && item.fill !== "none" ? item.fill : "none";
  var t = "translate(" + f(pad - bx.x) + " " + f(pad - bx.y) + ")";
  var svg = '<svg width="100%" height="100%"><g transform="' + t + '">' +
    '<path d="' + g.d + '" fill="' + (g.closed ? esc(fill) : "none") + '" stroke="' + esc(stroke) + '" stroke-width="' + f(sw) + '" stroke-linejoin="round" stroke-linecap="round"/>' +
    g.heads.map(function (hd) { return '<path d="' + hd + '" fill="' + esc(stroke) + '" stroke="' + esc(stroke) + '" stroke-width="1" stroke-linejoin="round"/>'; }).join("") +
    g.labels.map(function (lb) { return '<text x="' + f(lb.x) + '" y="' + f(lb.y) + '" fill="' + esc(stroke) + '" font-size="' + f(13 * Math.max(0.8, k)) + '" font-style="italic" text-anchor="middle">' + esc(lb.t) + "</text>"; }).join("") +
    '<path class="dv-hit" d="' + g.d + '" fill="' + (g.closed ? "rgba(0,0,0,0.001)" : "none") + '" stroke="transparent" stroke-width="' + f(Math.max(12, sw + 10)) + '"/>' +
    "</g></svg>";
  node.innerHTML = svg;
  if (g.closed) {
    var tx = el("div", "dv-shape-text");
    tx.style.left = pad + "px"; tx.style.top = pad + "px"; tx.style.width = bx.w + "px"; tx.style.height = bx.h + "px";
    tx.style.fontSize = ((item.fs || 16) * k) + "px";
    tx.style.color = item.textColor || "";
    tx.textContent = item.text || "";
    node.appendChild(tx);
  }
  return node;
}

function render(s) {
  if (dv.editing && dv.editing.s === s && dv.editing.node) dv.editing.draft = dv.editing.node.innerText;   // giữ chữ đang gõ dở
  var items = s.ad.list();
  var k = s.ad.k();
  var defs = '<defs><filter id="dv-pencil" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="1" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + f(1.6 * Math.max(1, k)) + '"/></filter>' +
    '<filter id="dv-glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  var ink = "";
  s.shapes.innerHTML = "";
  var maxBottom = 0;
  items.forEach(function (item, idx) {
    if (item.t === "shape") {
      var n = shapeNode(s, item, idx);
      if (dv.editing && dv.editing.item === item) {
        n.classList.add("editing");
        var tnode = n.querySelector(".dv-shape-text");
        if (tnode && dv.editing.draft != null) tnode.textContent = dv.editing.draft;
      }
      s.shapes.appendChild(n);
      var bb = shapeBoxPx(s, item); maxBottom = Math.max(maxBottom, bb.y + bb.h);
    } else {
      ink += inkSvg(s, item, idx);
      pathsOf(item).forEach(function (p) { p.forEach(function (pt) { maxBottom = Math.max(maxBottom, s.ad.toPx(pt)[1]); }); });
    }
  });
  s.svg.innerHTML = defs + ink;
  if (s.ad.afterRender) s.ad.afterRender(maxBottom);
  // vẫn đang chọn / đang gõ chữ trong 1 phần tử của lớp này → vẽ lại khung chọn
  if (dv.sel && dv.sel.s === s && items.indexOf(dv.sel.item) < 0) dv.sel = null;
  drawSelection(s);
  if (dv.editing && dv.editing.s === s) resumeTextEdit(s);
}

/* ---------------- Toạ độ chuột ---------------- */
function localPx(s, e) {
  var r = s.layer.getBoundingClientRect();
  var z = s.layer.offsetWidth ? r.width / s.layer.offsetWidth : 1;
  return [(e.clientX - r.left) / z, (e.clientY - r.top) / z];
}
function gridPx(s) { return (s.ad.gridPx && s.ad.gridPx()) || 10 * s.ad.k(); }
function snapPx(s, p) {
  if (!dv.snap) return p;
  var g = gridPx(s);
  return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
}

/* ---------------- Lịch sử hoàn tác (riêng cho lớp vẽ) ---------------- */
var hist = {};   // key -> {undo: [], redo: []}
function H(s) { var k = s.ad.key; if (!hist[k]) hist[k] = { undo: [], redo: [] }; return hist[k]; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function record(s, op) {
  dv.recent = true;
  var h = H(s);
  op.surfaceKey = s.ad.key; op.page = s.ad.page;
  h.undo.push(op); if (h.undo.length > 200) h.undo.shift();
  h.redo.length = 0;
}
function surfaceFor(op) {
  var found = null;
  surfaces.forEach(function (s) { if (s.ad.key === op.surfaceKey && s.ad.page === op.page) found = s; });
  return found;
}
function applyOp(s, op, undo) {
  if (op.kind === "add") { if (undo) s.ad.remove(op.item); else s.ad.add(op.item); }
  else if (op.kind === "remove") { if (undo) s.ad.add(op.item); else s.ad.remove(op.item); }
  else if (op.kind === "update") {
    var data = undo ? op.before : op.after;
    Object.keys(op.item).forEach(function (key) { delete op.item[key]; });
    Object.assign(op.item, clone(data));
    s.ad.update(op.item);
  } else if (op.kind === "group") {
    (undo ? op.ops.slice().reverse() : op.ops).forEach(function (o) { applyOp(s, o, undo); });
  }
}
function undoRedo(redo) {
  var s = activeSurfaceForKeys();
  if (!s) return false;
  var h = H(s);
  // cùng tài liệu (Chương / File PDF) nhưng có thể khác trang PDF → tìm đúng lớp của thao tác
  var stack = redo ? h.redo : h.undo;
  if (!stack.length) return false;
  var op = stack.pop();
  var target = surfaceFor(op) || s;
  selectItem(null);
  applyOp(target, op, !redo);
  (redo ? h.undo : h.redo).push(op);
  render(target);
  // giữ phần vừa hoàn tác / làm lại ở trạng thái chọn → bấm tiếp Ctrl+Z / Ctrl+Y vẫn thuộc lớp vẽ
  if (op.item && target.ad.list().indexOf(op.item) >= 0) selectItem(target, op.item);
  return true;
}
function activeSurfaceForKeys() {
  if (dv.sel) return dv.sel.s;
  var first = null;
  surfaces.forEach(function (s) { if (!first && !s.ad.readOnly()) first = s; });
  return first;
}

/* ---------------- Chọn / khung chọn / thanh định dạng ---------------- */
var bar = null;
function selectItem(s, item) {
  var prev = dv.sel && dv.sel.s;
  dv.sel = s && item ? { s: s, item: item } : null;
  if (prev && prev !== s) drawSelection(prev);
  if (s) drawSelection(s);
  if (!dv.sel) hideBar();
}

function handlesFor(s, item) {
  if (item.t !== "shape") return [];
  var bx = shapeBoxPx(s, item);
  if (isLine(item.shape)) return [["a", bx.a[0], bx.a[1]], ["b", bx.b[0], bx.b[1]]];
  var x = bx.x, y = bx.y, X = bx.x + bx.w, Y = bx.y + bx.h, cx = x + bx.w / 2, cy = y + bx.h / 2;
  return [["nw", x, y], ["n", cx, y], ["ne", X, y], ["e", X, cy], ["se", X, Y], ["s", cx, Y], ["sw", x, Y], ["w", x, cy]];
}
function itemBoundsPx(s, item) {
  if (item.t === "shape") { var b = shapeBoxPx(s, item); return { x: b.x, y: b.y, w: b.w, h: b.h }; }
  var xs = [], ys = [];
  pathsOf(item).forEach(function (p) { p.forEach(function (pt) { var q = s.ad.toPx(pt); xs.push(q[0]); ys.push(q[1]); }); });
  if (!xs.length) return { x: 0, y: 0, w: 0, h: 0 };
  var pad = inkW(item) * s.ad.k() / 2 + 3;
  var x0 = Math.min.apply(null, xs) - pad, y0 = Math.min.apply(null, ys) - pad;
  return { x: x0, y: y0, w: Math.max.apply(null, xs) + pad - x0, h: Math.max.apply(null, ys) + pad - y0 };
}

function drawSelection(s) {
  s.ui.innerHTML = "";
  if (!dv.sel || dv.sel.s !== s) return;
  var item = dv.sel.item, b = itemBoundsPx(s, item);
  if (!(item.t === "shape" && isLine(item.shape))) {
    var box = el("div", "dv-selbox");
    box.style.left = b.x + "px"; box.style.top = b.y + "px"; box.style.width = b.w + "px"; box.style.height = b.h + "px";
    s.ui.appendChild(box);
  }
  if (!s.ad.readOnly()) handlesFor(s, item).forEach(function (h) {
    var hd = el("div", "dv-handle dv-h-" + h[0]);
    hd.setAttribute("data-handle", h[0]);
    hd.style.left = h[1] + "px"; hd.style.top = h[2] + "px";
    s.ui.appendChild(hd);
  });
  if (!s.ad.readOnly()) showBar(s, item);
}

function hideBar() { if (bar) { bar.classList.remove("show"); bar.innerHTML = ""; } }

function swatchHtml(attr, cur, allowNone) {
  return '<div class="dv-pal" data-pal="' + attr + '">' +
    (allowNone ? '<button type="button" class="dv-sw none' + (!cur || cur === "none" ? " on" : "") + '" data-c="none" title="No Color"></button>' : "") +
    PALETTE.map(function (c) { return '<button type="button" class="dv-sw' + (cur === c ? " on" : "") + '" data-c="' + c + '" title="' + c + '" style="background:' + c + '"></button>'; }).join("") +
    '<label class="dv-sw dv-sw-more" title="More Colors"><input type="color" data-c-more value="' + (cur && cur[0] === "#" ? cur : "#1971c2") + '">+</label></div>';
}

function showBar(s, item) {
  if (!bar) {
    bar = el("div", "dv-bar");
    bar.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    bar.addEventListener("mousedown", function (e) { if (!e.target.closest("input")) e.preventDefault(); });
    document.body.appendChild(bar);
  }
  var isShape = item.t === "shape";
  var stroke = isShape ? (item.stroke || "#1971c2") : (item.color || "#000");
  var widths = isShape ? [1, 2, 3, 4, 6, 8] : PEN_KINDS[inkKind(item)].widths;
  var curW = isShape ? (item.sw != null ? item.sw : 2) : inkW(item);
  var html = '<button type="button" class="dv-bar-btn" data-open="stroke" title="' + (isShape ? "Shape Outline" : "Ink Color") + '"><span class="dv-chip" style="background:' + esc(cssPaint(stroke)) + '"></span>' + (isShape ? "Outline" : "Color") + " ▾</button>";
  if (isShape && isClosed(item.shape)) {
    var fill = item.fill || "none";
    html += '<button type="button" class="dv-bar-btn" data-open="fill" title="Shape Fill"><span class="dv-chip' + (fill === "none" ? " none" : "") + '" style="background:' + (fill === "none" ? "transparent" : esc(fill)) + '"></span>Fill ▾</button>';
  }
  if (!isShape) {   // độ dày chỉ còn cho nét bút (hình khối: bỏ theo yêu cầu, giữ độ dày lúc vẽ)
    html += '<label class="dv-bar-w" title="Ink Weight">Weight <select data-w>' + widths.map(function (w) {
      return '<option value="' + w + '"' + (Math.abs(w - curW) < 0.01 ? " selected" : "") + ">" + w + "</option>";
    }).join("") + (widths.some(function (w) { return Math.abs(w - curW) < 0.01; }) ? "" : '<option value="' + curW + '" selected>' + f(curW) + "</option>") + "</select></label>";
  }
  if (isShape && isClosed(item.shape)) {
    html += '<button type="button" class="dv-bar-btn" data-open="textColor" title="Font Color (double-click the shape to type text)"><span class="dv-chip" style="background:' + esc(item.textColor || "#050d2b") + '"></span>Font Color ▾</button>';
  }
  html += '<button type="button" class="dv-bar-btn dv-del" data-act="del" title="Delete (Del)">Delete</button>';
  html += '<div class="dv-pop" hidden></div>';
  bar.innerHTML = html;
  bar.classList.add("show");
  var pop = bar.querySelector(".dv-pop");
  bar.querySelectorAll("[data-open]").forEach(function (b) {
    b.addEventListener("click", function () {
      var which = b.getAttribute("data-open");
      if (!pop.hidden && pop.getAttribute("data-for") === which) { pop.hidden = true; return; }
      var cur = which === "stroke" ? stroke : which === "fill" ? (item.fill || "none") : (item.textColor || "#050d2b");
      pop.innerHTML = swatchHtml(which, cur, which === "fill");
      pop.setAttribute("data-for", which); pop.hidden = false;
      var pick = function (c) {
        changeItem(s, item, function (it) {
          if (which === "stroke") { if (isShape) { it.stroke = c; dv.stroke = c; } else it.color = c; }
          else if (which === "fill") { it.fill = c; dv.fill = c; }
          else it.textColor = c;
        });
      };
      pop.querySelectorAll("[data-c]").forEach(function (sw) { sw.addEventListener("click", function () { pick(sw.getAttribute("data-c")); }); });
      var more = pop.querySelector("[data-c-more]");
      more.addEventListener("change", function () { pick(more.value); });
    });
  });
  var wsel = bar.querySelector("[data-w]");
  if (wsel) wsel.addEventListener("change", function (e) {
    var v = parseFloat(e.target.value);
    changeItem(s, item, function (it) { if (isShape) { it.sw = v; dv.sw = v; } else it.w = v; });
  });
  var tb = bar.querySelector('[data-act="text"]');
  if (tb) tb.addEventListener("click", function () { startTextEdit(s, item); });
  bar.querySelector('[data-act="del"]').addEventListener("click", function () { removeItem(s, item); });
  positionBar(s, item);
}
function positionBar(s, item) {
  if (!bar || !bar.classList.contains("show")) return;
  var b = itemBoundsPx(s, item);
  var r = s.layer.getBoundingClientRect(), z = s.layer.offsetWidth ? r.width / s.layer.offsetWidth : 1;
  var bw = bar.offsetWidth, bh = bar.offsetHeight;
  var x = r.left + (b.x + b.w / 2) * z - bw / 2;
  var y = r.top + (b.y + b.h) * z + 12;
  if (y + bh > window.innerHeight - 8) y = r.top + b.y * z - bh - 12;
  bar.style.left = Math.max(8, Math.min(x, window.innerWidth - bw - 8)) + "px";
  bar.style.top = Math.max(8, y) + "px";
}
window.addEventListener("scroll", function () { if (dv.sel) positionBar(dv.sel.s, dv.sel.item); }, true);
window.addEventListener("resize", function () { refreshAll(); });

function changeItem(s, item, fn) {
  var before = clone(item);
  fn(item);
  s.ad.update(item);
  record(s, { kind: "update", item: item, before: before, after: clone(item) });
  render(s);
}
function removeItem(s, item) {
  finishTextEdit();
  s.ad.remove(item);
  record(s, { kind: "remove", item: item });
  selectItem(null);
  render(s);
}

/* ---------------- Chữ trong hình ---------------- */
function startTextEdit(s, item) {
  if (s.ad.readOnly() || item.t !== "shape" || !isClosed(item.shape)) return;
  finishTextEdit();
  dv.editing = { s: s, item: item, before: clone(item) };
  hideBar();
  render(s);
}
function resumeTextEdit(s) {
  var ed = dv.editing;
  var idx = s.ad.list().indexOf(ed.item);
  var node = s.shapes.querySelector('[data-dv="' + idx + '"] .dv-shape-text');
  if (!node) { dv.editing = null; return; }
  ed.node = node;
  node.contentEditable = "true";
  node.spellcheck = false;
  node.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finishTextEdit(); }
  });
  node.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
  node.addEventListener("blur", function () { setTimeout(function () { if (dv.editing && dv.editing.node === node && document.activeElement !== node) finishTextEdit(); }, 0); });
  setTimeout(function () {
    node.focus();
    var r = document.createRange(); r.selectNodeContents(node); r.collapse(false);
    var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(r);
  }, 0);
}
function finishTextEdit() {
  var ed = dv.editing;
  if (!ed) return;
  dv.editing = null;
  var text = ed.node ? ed.node.innerText.replace(/\n$/, "") : (ed.item.text || "");
  if (text !== (ed.item.text || "")) {
    ed.item.text = text;
    ed.s.ad.update(ed.item);
    record(ed.s, { kind: "update", item: ed.item, before: ed.before, after: clone(ed.item) });
  }
  if (surfaces.has(ed.s)) { render(ed.s); selectItem(ed.s, ed.item); }
}

/* ---------------- Chuột: vẽ / tẩy / hình / chọn – kéo – đổi cỡ ---------------- */
function itemAt(s, e) {
  var t = e.target.closest && e.target.closest("[data-dv]");
  if (!t || !s.layer.contains(t)) return null;
  return s.ad.list()[+t.getAttribute("data-dv")] || null;
}

function distSeg(p, a, b) {
  var dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  var t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  var x = a[0] + t * dx, y = a[1] + t * dy;
  return Math.hypot(p[0] - x, p[1] - y);
}
function hitTest(s, item, p, r) {
  if (item.t === "shape") {
    var bx = shapeBoxPx(s, item);
    if (isLine(item.shape)) {
      var c = [bx.b[0], bx.a[1]];
      var segs = item.shape.indexOf("elbow") === 0 ? [[bx.a, c], [c, bx.b]] : [[bx.a, bx.b]];
      return segs.some(function (sg) { return distSeg(p, sg[0], sg[1]) <= r + (item.sw || 2) * s.ad.k(); });
    }
    return p[0] >= bx.x - r && p[0] <= bx.x + bx.w + r && p[1] >= bx.y - r && p[1] <= bx.y + bx.h + r;
  }
  var w = inkW(item) * s.ad.k() / 2 + r;
  return pathsOf(item).some(function (path) {
    var px = path.map(s.ad.toPx);
    if (px.length === 1) return Math.hypot(p[0] - px[0][0], p[1] - px[0][1]) <= w;
    for (var i = 1; i < px.length; i++) if (distSeg(p, px[i - 1], px[i]) <= w) return true;
    return false;
  });
}

function onDown(s, e) {
  if (e.button !== 0 || s.ad.readOnly()) return;
  if (dv.editing && e.target.closest(".dv-shape-text")) return;
  var p = localPx(s, e);
  var handle = e.target.closest && e.target.closest("[data-handle]");
  if (!dv.tool && handle && dv.sel && dv.sel.s === s) { e.preventDefault(); startResize(s, e, handle.getAttribute("data-handle")); return; }
  if (dv.tool === "pen") { e.preventDefault(); startInk(s, e, p); return; }
  if (dv.tool === "eraser") { e.preventDefault(); startErase(s, e, p); return; }
  if (dv.tool === "shape") { e.preventDefault(); startShape(s, e, p); return; }
  var item = itemAt(s, e);
  if (!item) return;
  e.preventDefault(); e.stopPropagation();
  finishTextEdit();
  selectItem(s, item);
  startMove(s, e, item, p);
}

function onDbl(s, e) {
  if (dv.tool || s.ad.readOnly()) return;
  // Lần bấm đầu của cú nhấn đúp có thể đã vẽ lại lớp vẽ (chọn / kéo hình) → phần tử đích cũ bị thay; tìm lại theo toạ độ.
  var item = itemAt(s, e);
  if (!item) {
    var hit = document.elementFromPoint(e.clientX, e.clientY);
    hit = hit && hit.closest && hit.closest("[data-dv]");
    if (hit && s.layer.contains(hit)) item = s.ad.list()[+hit.getAttribute("data-dv")] || null;
  }
  if (!item && dv.sel && dv.sel.s === s && dv.sel.item.t === "shape") {
    var bx = shapeBoxPx(s, dv.sel.item), lp = localPx(s, e);
    if (lp[0] >= bx.x && lp[0] <= bx.x + bx.w && lp[1] >= bx.y && lp[1] <= bx.y + bx.h) item = dv.sel.item;
  }
  if (item && item.t === "shape" && isClosed(item.shape)) { e.preventDefault(); startTextEdit(s, item); }
}

function capture(target, e, move, up) {
  try { target.setPointerCapture(e.pointerId); } catch (err) { /* bỏ qua */ }
  var mv = function (ev) { move(ev); };
  var u = function (ev) {
    target.removeEventListener("pointermove", mv); target.removeEventListener("pointerup", u); target.removeEventListener("pointercancel", u);
    up(ev);
  };
  target.addEventListener("pointermove", mv); target.addEventListener("pointerup", u); target.addEventListener("pointercancel", u);
}

function startInk(s, e, p0) {
  var pen = curPen();
  var pts = [p0];
  var live = document.createElementNS(SVGNS, "path");
  var k = s.ad.k();
  live.setAttribute("fill", "none"); live.setAttribute("stroke-linecap", "round"); live.setAttribute("stroke-linejoin", "round");
  live.setAttribute("stroke", solidOf(pen.color));
  live.setAttribute("stroke-width", String(pen.w * k));
  if (pen.kind === "marker") { live.setAttribute("opacity", "0.45"); live.setAttribute("class", "dv-marker"); }
  var laser = !!(PEN_KINDS[pen.kind] && PEN_KINDS[pen.kind].laser);
  if (laser) live.setAttribute("class", "dv-laser");
  s.svg.appendChild(live);
  var upd = function () { live.setAttribute("d", smoothD(pts)); };
  upd();
  capture(s.layer, e, function (ev) {
    var events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    events.forEach(function (ce) {
      var q = localPx(s, ce), l = pts[pts.length - 1];
      if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 1.2) pts.push(q);
    });
    upd();
  }, function () {
    if (laser) {   // chỉ trỏ: mờ dần rồi biến mất, không ghi vào dữ liệu
      live.classList.add("fade");
      setTimeout(function () { if (live.parentNode) live.parentNode.removeChild(live); }, 900);
      return;
    }
    if (live.parentNode) live.parentNode.removeChild(live);
    if (pts.length === 1) pts.push([pts[0][0] + 0.1, pts[0][1] + 0.1]);
    var item = { t: "ink", kind: pen.kind, color: pen.color, w: pen.w, paths: [pts.map(function (q) { return s.ad.fromPx(q).map(function (v) { return f(v); }); })] };
    if (pen.kind === "marker") item.op = 0.45;
    s.ad.add(item);
    record(s, { kind: "add", item: item });
    render(s);
  });
}

function startErase(s, e, p0) {
  var removed = [];
  var eraseAt = function (p) {
    var list = s.ad.list();
    for (var i = list.length - 1; i >= 0; i--) {
      if (hitTest(s, list[i], p, 6)) { var it = list[i]; s.ad.remove(it); removed.push({ kind: "remove", item: it }); }
    }
    if (s.ad.eraseExtra) s.ad.eraseExtra(p);
  };
  eraseAt(p0); render(s);
  capture(s.layer, e, function (ev) { var before = removed.length; eraseAt(localPx(s, ev)); if (removed.length !== before) render(s); }, function () {
    if (removed.length) record(s, removed.length === 1 ? removed[0] : { kind: "group", ops: removed });
  });
}

function startShape(s, e, p0) {
  var a = snapPx(s, p0), b = a.slice();
  var shape = dv.shape;
  var ghost = { t: "shape", shape: shape, a: s.ad.fromPx(a), b: s.ad.fromPx(b), stroke: dv.stroke, fill: dv.fill, sw: dv.sw, text: "" };
  var preview = null;
  var paint = function () {
    if (preview) preview.remove();
    ghost.a = s.ad.fromPx(a); ghost.b = s.ad.fromPx(b);
    preview = shapeNode(s, ghost, -1);
    preview.classList.add("dv-preview");
    s.shapes.appendChild(preview);
  };
  paint();
  capture(s.layer, e, function (ev) {
    var q = snapPx(s, localPx(s, ev));
    if (ev.shiftKey) {   // Shift: giữ tỉ lệ 1:1 (hình) / góc 45° (đường)
      var dx = q[0] - a[0], dy = q[1] - a[1];
      if (isLine(shape)) { var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(dx, dy); q = [a[0] + L * Math.cos(ang), a[1] + L * Math.sin(ang)]; }
      else { var m = Math.max(Math.abs(dx), Math.abs(dy)); q = [a[0] + m * Math.sign(dx || 1), a[1] + m * Math.sign(dy || 1)]; }
    }
    b = q; paint();
  }, function () {
    if (preview) preview.remove();
    var k = s.ad.k();
    if (Math.abs(b[0] - a[0]) < 4 && Math.abs(b[1] - a[1]) < 4) {   // bấm (không kéo) → cỡ mặc định
      b = isLine(shape) ? [a[0] + 140 * k, a[1]] : [a[0] + (shape.indexOf("axes") === 0 ? 160 : 140) * k, a[1] + (shape.indexOf("axes") === 0 ? 120 : 90) * k];
    }
    var item = { t: "shape", shape: shape, a: s.ad.fromPx(a).map(f), b: s.ad.fromPx(b).map(f), stroke: dv.stroke, fill: isClosed(shape) ? dv.fill : "none", sw: dv.sw, text: "" };
    s.ad.add(item);
    record(s, { kind: "add", item: item });
    if (!dv.lock) setTool(null, { silent: false });
    render(s);
    if (!dv.lock) selectItem(s, item);
  });
}

function moveItemPx(s, item, dx, dy, base) {
  var mv = function (pt) { var q = s.ad.toPx(pt); return s.ad.fromPx([q[0] + dx, q[1] + dy]).map(f); };
  if (item.t === "shape") { item.a = mv(base.a); item.b = mv(base.b); }
  else item.paths = base.paths.map(function (pth) { return pth.map(mv); });
}

function startMove(s, e, item, p0) {
  var before = clone(item), moved = false;
  capture(s.layer, e, function (ev) {
    var q = localPx(s, ev), dx = q[0] - p0[0], dy = q[1] - p0[1];
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    if (dv.snap && item.t === "shape") {
      var a0 = s.ad.toPx(before.a), a1 = snapPx(s, [a0[0] + dx, a0[1] + dy]);
      dx = a1[0] - a0[0]; dy = a1[1] - a0[1];
    }
    moveItemPx(s, item, dx, dy, before);
    render(s);
  }, function () {
    if (!moved) return;
    s.ad.update(item);
    record(s, { kind: "update", item: item, before: before, after: clone(item) });
    render(s);
  });
}

function startResize(s, e, h) {
  var item = dv.sel.item, before = clone(item);
  var A = s.ad.toPx(before.a), B = s.ad.toPx(before.b);
  var x0 = Math.min(A[0], B[0]), y0 = Math.min(A[1], B[1]), x1 = Math.max(A[0], B[0]), y1 = Math.max(A[1], B[1]);
  capture(s.layer, e, function (ev) {
    var q = snapPx(s, localPx(s, ev));
    if (h === "a" || h === "b") {
      if (ev.shiftKey) {
        var o = h === "a" ? B : A, dx = q[0] - o[0], dy = q[1] - o[1];
        var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(dx, dy);
        q = [o[0] + L * Math.cos(ang), o[1] + L * Math.sin(ang)];
      }
      item[h] = s.ad.fromPx(q).map(f);
    } else {
      var nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
      if (h.indexOf("w") >= 0) nx0 = Math.min(q[0], x1 - 6);
      if (h.indexOf("e") >= 0) nx1 = Math.max(q[0], x0 + 6);
      if (h.indexOf("n") >= 0) ny0 = Math.min(q[1], y1 - 6);
      if (h.indexOf("s") >= 0) ny1 = Math.max(q[1], y0 + 6);
      if (ev.shiftKey && h.length === 2) {   // góc + Shift: giữ tỉ lệ
        var ratio = (x1 - x0) / Math.max(1, y1 - y0), nw = nx1 - nx0, nh = ny1 - ny0;
        if (nw / Math.max(1, nh) > ratio) nw = nh * ratio; else nh = nw / ratio;
        if (h.indexOf("w") >= 0) nx0 = nx1 - nw; else nx1 = nx0 + nw;
        if (h.indexOf("n") >= 0) ny0 = ny1 - nh; else ny1 = ny0 + nh;
      }
      item.a = s.ad.fromPx([nx0, ny0]).map(f); item.b = s.ad.fromPx([nx1, ny1]).map(f);
    }
    render(s);
  }, function () {
    s.ad.update(item);
    record(s, { kind: "update", item: item, before: before, after: clone(item) });
    render(s);
  });
}

// Bấm ra ngoài nét / hình đang chọn → bỏ chọn.
document.addEventListener("pointerdown", function (e) {
  if (dv.recent && !(e.target.closest && (e.target.closest(".dv-layer") || e.target.closest(".dv-bar") || e.target.closest(".dv-tools")))) dv.recent = false;
  if (!dv.sel) return;
  if (e.target.closest && (e.target.closest(".dv-bar") || e.target.closest("[data-dv]") || e.target.closest("[data-handle]"))) return;
  finishTextEdit();
  selectItem(null);
}, true);

// Phím: Delete xoá phần đang chọn, Esc bỏ chọn / thoát bút, Ctrl+Z / Ctrl+Y hoàn tác lớp vẽ.
document.addEventListener("keydown", function (e) {
  if (dv.editing) return;
  var inField = e.target.closest && e.target.closest("input, textarea, select, [contenteditable=true]");
  var inEditor = e.target.closest && e.target.closest(".ck-editor__editable");
  // dv.recent: thao tác gần nhất là trên lớp vẽ (kể cả khi vừa hoàn tác mất phần đang chọn) → Ctrl+Z / Ctrl+Y vẫn của lớp vẽ;
  // gõ phím khác / bấm vào chữ thì trả Ctrl+Z về cho trình soạn thảo.
  var mod0 = e.ctrlKey || e.metaKey, k0 = (e.key || "").toLowerCase();
  if (dv.recent && !(mod0 && (k0 === "z" || k0 === "y")) && ["Shift", "Control", "Meta", "Alt"].indexOf(e.key) < 0) dv.recent = false;
  var ctx = dv.sel || dv.tool || (dv.recent && (k0 === "z" || k0 === "y") && mod0);
  if (e.key === "Escape" && ctx) {
    if (dv.sel) selectItem(null); else setTool(null);
    e.preventDefault(); return;
  }
  if (!ctx || (inField && !inEditor)) return;
  if ((e.key === "Delete" || e.key === "Backspace") && dv.sel) { e.preventDefault(); e.stopPropagation(); removeItem(dv.sel.s, dv.sel.item); return; }
  var mod = e.ctrlKey || e.metaKey, key = (e.key || "").toLowerCase();
  if (mod && (key === "z" || key === "y")) {
    var redo = key === "y" || (key === "z" && e.shiftKey);
    if (undoRedo(redo)) { e.preventDefault(); e.stopPropagation(); }
  }
}, true);

/* ---------------- Vẽ ra canvas (Tải PDF / In File PDF) ---------------- */
export function drawItemsToCanvas(ctx, items, toPx, k) {
  items.forEach(function (item) {
    ctx.save();
    if (item.t === "shape") {
      var a = toPx(item.a), b = toPx(item.b), sw = (item.sw != null ? item.sw : 2) * k;
      var g = shapeGeo(item.shape, a, b, sw);
      var p = new Path2D(g.d);
      if (g.closed && item.fill && item.fill !== "none") { ctx.fillStyle = item.fill; ctx.fill(p); }
      ctx.strokeStyle = item.stroke || "#1971c2"; ctx.lineWidth = sw; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(p);
      ctx.fillStyle = item.stroke || "#1971c2";
      g.heads.forEach(function (hd) { ctx.fill(new Path2D(hd)); });
      ctx.font = "italic " + (13 * Math.max(0.8, k)) + "px sans-serif"; ctx.textAlign = "center";
      g.labels.forEach(function (lb) { ctx.fillText(lb.t, lb.x, lb.y); });
      if (g.closed && item.text) {
        var x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        var fs = (item.fs || 16) * k;
        ctx.font = fs + "px Figtree, sans-serif"; ctx.fillStyle = item.textColor || "#050d2b"; ctx.textBaseline = "middle";
        var lines = [];
        String(item.text).split("\n").forEach(function (para) {
          var line = "";
          para.split(" ").forEach(function (word) {
            var t = line ? line + " " + word : word;
            if (ctx.measureText(t).width > w - 8 && line) { lines.push(line); line = word; } else line = t;
          });
          lines.push(line);
        });
        var lh = fs * 1.3, top = y + h / 2 - (lines.length - 1) * lh / 2;
        lines.forEach(function (ln, i) { ctx.fillText(ln, x + w / 2, top + i * lh); });
      }
    } else {
      var kind = inkKind(item);
      ctx.strokeStyle = item.color || "#000"; ctx.lineWidth = inkW(item) * k; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = kind === "pencil" ? 0.88 : inkOpacity(item);
      if (kind === "marker") ctx.globalCompositeOperation = "multiply";
      pathsOf(item).forEach(function (path) {
        var px = path.map(toPx);
        var stops = inkStops(item);
        if (stops) {
          var xs = px.map(function (q) { return q[0]; }), ys = px.map(function (q) { return q[1]; });
          var gr = ctx.createLinearGradient(Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs) + 1, Math.max.apply(null, ys) + 1);
          stops.forEach(function (c, i) { gr.addColorStop(i / (stops.length - 1), c); });
          ctx.strokeStyle = gr;
        }
        ctx.stroke(new Path2D(smoothD(px)));
        if (kind === "brush") {
          ctx.save(); ctx.globalAlpha = 0.35; ctx.lineWidth = inkW(item) * k * 0.45;
          ctx.translate(inkW(item) * k * 0.28, inkW(item) * k * 0.22); ctx.stroke(new Path2D(smoothD(px))); ctx.restore();
        }
      });
    }
    ctx.restore();
  });
}

/* ---------------- Nền trang (chỉ Chương) ---------------- */
export var BG_RULE = [["narrow", "Narrow Ruled", 22], ["college", "College Ruled", 28], ["standard", "Standard Ruled", 34], ["wide", "Wide Ruled", 42]];
export var BG_GRID = [["small", "Small Grid", 16], ["medium", "Medium Grid", 24], ["large", "Large Grid", 32], ["xlarge", "Very Large Grid", 48]];
export function bgStep(bg) {
  if (!bg || !bg.kind || bg.kind === "none") return 0;
  var list = bg.kind === "grid" ? BG_GRID : BG_RULE;
  var hit = list.filter(function (x) { return x[0] === bg.size; })[0];
  return hit ? hit[2] : list[1][2];
}

/* ---------------- Ribbon thẻ Draw ---------------- */
// Icon bút theo mẫu Word: thân trắng viền đen, nắp + ngòi theo màu bút; mọi icon (kể cả Tẩy) cùng khung 24×40 để đứng thẳng hàng.
// Hiển thị chỉ phần dưới (viewBox cắt từ y=10, cao 28px — bút "thò" lên như Word) để ribbon Draw cao bằng các thẻ khác.
var PEN_TIP = {
  pen: function (c) { return '<rect x="6.5" y="1" width="11" height="13" rx="1.5" fill="' + c + '" stroke="#1f2430" stroke-width="1.2"/><path d="M6.5 14h11v4l-4.2 14h-2.6L6.5 18z" fill="#fff" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.7 32h2.6L12 38z" fill="' + c + '" stroke="#1f2430" stroke-width="1" stroke-linejoin="round"/>'; },
  pencil: function (c) { return '<rect x="6.5" y="1" width="11" height="13" rx="1.5" fill="' + c + '" stroke="#1f2430" stroke-width="1.2"/><path d="M6.5 14h11v4l-4.2 14h-2.6L6.5 18z" fill="#f4e2c1" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.7 32h2.6L12 38z" fill="' + c + '"/>'; },
  marker: function (c) { return '<rect x="6" y="1" width="12" height="13" rx="1.5" fill="' + c + '" stroke="#1f2430" stroke-width="1.2"/><path d="M6 14h12v9l-2 3v4H8v-4l-2-3z" fill="#fff" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 30h8v3l-8 5z" fill="' + c + '" stroke="#1f2430" stroke-width="1.1" stroke-linejoin="round"/>'; },
  fountain: function (c) { return '<rect x="6.5" y="1" width="11" height="13" rx="1.5" fill="' + c + '" stroke="#1f2430" stroke-width="1.2"/><path d="M6.5 14h11v4l-5.5 20-5.5-20z" fill="#fff" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 25v12" stroke="' + c + '" stroke-width="1.4"/><circle cx="12" cy="24.5" r="1.6" fill="' + c + '"/>'; },
};
PEN_TIP.brush = function (c) { return '<rect x="6.5" y="1" width="11" height="13" rx="1.5" fill="' + c + '" stroke="#1f2430" stroke-width="1.2"/><path d="M6.5 14h11v5l-2.5 3h-6L6.5 19z" fill="#fff" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 22h6c0 6-2 10-3 16-1-6-3-10-3-16z" fill="' + c + '" stroke="#1f2430" stroke-width="1" stroke-linejoin="round"/>'; };
PEN_TIP.laser = function (c) { return '<rect x="7" y="1" width="10" height="25" rx="3" fill="#fff" stroke="#1f2430" stroke-width="1.2"/><rect x="9.5" y="5" width="5" height="6" rx="1.2" fill="' + c + '"/><path d="M10 26h4v3h-4z" fill="#1f2430"/><circle cx="12" cy="34" r="2.6" fill="' + c + '"/><path d="M12 29.5v1.3M8 31l1 .8M16 31l-1 .8" stroke="' + c + '" stroke-width="1.2" stroke-linecap="round"/>'; };
PEN_TIP.galaxy = PEN_TIP.pen;
// Icon nhỏ dạng nét viền cho menu "+" (theo mẫu Word: Pen / Highlighter / Fountain Pen / Brush Pen / Laser Pointer)
var ADD_ICO = {
  pen: '<path d="M2.5 10L8 6.5h10v7H8z M8 6.5v7"/>',
  marker: '<path d="M2.5 8.5L7 6.2v7.6l-4.5-2.3z M7 5h11v10H7z"/>',
  fountain: '<path d="M2.5 10L9 5.8h9v8.4H9z"/><circle cx="7.2" cy="10" r="1.3"/>',
  brush: '<path d="M2.5 10c2.5-2.6 4.5-3.5 7-3.5h8.5v7H9.5c-2.5 0-4.5-.9-7-3.5z M9.5 6.5v7"/>',
  laser: '<path d="M8 6.5h10v7H8z"/><path d="M2.5 10h3M3.3 6.8l2 1.3M3.3 13.2l2-1.3"/>',
};
function addIcon(kind) { return '<svg width="22" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">' + ADD_ICO[kind] + "</svg>"; }
var penIconSeq = 0;
function penIcon(p) {
  var t = texOf(p.color) || (p.kind === "galaxy" ? TEX.galaxy : null), defs = "", paint = p.color;
  if (t) {
    var gid = "dvpi" + (++penIconSeq);
    defs = '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' + t.stops.map(function (c, i) { return '<stop offset="' + (i / (t.stops.length - 1)).toFixed(2) + '" stop-color="' + c + '"/>'; }).join("") + "</linearGradient></defs>";
    paint = "url(#" + gid + ")";
  }
  return '<svg class="dv-ico" width="24" height="28" viewBox="0 10 24 28">' + defs + (PEN_TIP[p.kind] || PEN_TIP.pen)(paint) + "</svg>";
}
function penTitle(p) { return PEN_KINDS[p.kind].label + " · " + colorName(p.color) + " · " + p.w; }

var ICO_BG = '<svg class="dv-rbtn-ico" width="26" height="26" viewBox="0 0 26 26"><rect x="3.5" y="3.5" width="19" height="19" rx="1.5" fill="#fff" stroke="#5f6b7d" stroke-width="1.1"/>' +
  '<path d="M4 8.5h18M4 12.5h18M4 16.5h18" stroke="#4dabf7" stroke-width="1.3"/><path d="M8.5 4v18" stroke="#e03131" stroke-width="1.3"/></svg>';
var ICO_SHAPES = '<svg class="dv-rbtn-ico" width="26" height="26" viewBox="0 0 26 26"><rect x="3" y="3" width="13" height="13" rx="1.5" fill="#1c7ed6"/>' +
  '<circle cx="16.5" cy="16.5" r="6.5" fill="#fff" stroke="#3b4253" stroke-width="1.4"/></svg>';
var ICO_CHEV = '<svg class="dv-rbtn-chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var ICO_SELECT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 8-6 2-3 6z"/></svg>';
var ICO_ERASER = '<svg class="dv-ico" width="24" height="28" viewBox="0 10 24 28"><path d="M5 1h14v17H5z" fill="#d6d9de" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 18h14v13a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z" fill="#d9a3e3" stroke="#1f2430" stroke-width="1.2" stroke-linejoin="round"/></svg>';

function shapeIcon(key) {
  // vẽ ở hộp 72×72 rồi thu về 22px để mũi tên / nhãn trục cân đối với nét
  var a = key.indexOf("elbow") === 0 ? [8, 12] : [8, 8], g = shapeGeo(key, a, [64, 64], 2.6);
  return '<svg width="22" height="22" viewBox="0 0 72 72"><path d="' + g.d + '" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/>' +
    g.heads.map(function (h) { return '<path d="' + h + '" fill="currentColor"/>'; }).join("") +
    g.labels.map(function (l) { return '<text x="' + l.x + '" y="' + l.y + '" font-size="16" font-style="italic" fill="currentColor" text-anchor="middle">' + l.t + "</text>"; }).join("") + "</svg>";
}

function shapeMenuHtml() {
  return '<div class="dv-menu">' + SHAPE_MENU.map(function (sec) {
    return '<div class="dv-menu-title">' + esc(sec.title) + '</div><div class="dv-menu-grid">' + sec.items.map(function (it) {
      var on = dv.tool === "shape" && dv.shape === it[0];
      return '<button type="button" class="dv-menu-ico' + (on ? " on" : "") + '" data-shape="' + it[0] + '" title="' + esc(it[1]) + '">' + shapeIcon(it[0]) + "</button>";
    }).join("") + "</div>";
  }).join("") +
    '<div class="dv-menu-sep"></div>' +
    '<button type="button" class="dv-menu-row' + (dv.lock ? " on" : "") + '" data-opt="lock"><span class="dv-check">' + (dv.lock ? "✓" : "") + "</span>Lock Drawing Mode</button>" +
    '<button type="button" class="dv-menu-row' + (dv.snap ? " on" : "") + '" data-opt="snap"><span class="dv-check">' + (dv.snap ? "✓" : "") + "</span>Snap To Grid</button>" +
    '<div class="dv-menu-hint">Drag on the page to draw (hold Shift for a square, circle or 45° line). Double-click a shape to type text in it.</div></div>';
}
function bindShapeMenu(panel) {
  panel.querySelectorAll("[data-shape]").forEach(function (b) {
    b.addEventListener("click", function () { hooks.closeFloating(); setTool("shape", { shape: b.getAttribute("data-shape") }); });
  });
  panel.querySelectorAll("[data-opt]").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var o = b.getAttribute("data-opt"); dv[o] = !dv[o]; saveOpts();
      panel.innerHTML = shapeMenuHtml(); bindShapeMenu(panel);
    });
  });
}

function bgTile(kind, size, step, on, label) {
  var style;
  if (kind === "none") style = "";
  else if (kind === "rule") style = "background-image:linear-gradient(90deg,transparent 9px,#ff6b6b 9px,#ff6b6b 10px,transparent 10px),repeating-linear-gradient(180deg,transparent 0," + "transparent " + (step / 3 - 1) + "px,#4dabf7 " + (step / 3 - 1) + "px,#4dabf7 " + (step / 3) + "px)";
  else style = "background-image:repeating-linear-gradient(0deg,#4dabf7 0,#4dabf7 1px,transparent 1px,transparent " + (step / 3) + "px),repeating-linear-gradient(90deg,#4dabf7 0,#4dabf7 1px,transparent 1px,transparent " + (step / 3) + "px)";
  return '<button type="button" class="dv-bg-tile' + (on ? " on" : "") + '" data-bg="' + kind + ":" + size + '" title="' + esc(label) + '" style="' + style + '">' + (kind === "none" ? "None" : "") + "</button>";
}
function bgMenuHtml(bg) {
  var cur = bg && bg.kind && bg.kind !== "none" ? bg.kind + ":" + bg.size : "none:";
  return '<div class="dv-menu dv-bg-menu"><div class="dv-menu-title">Rule Lines</div><div class="dv-bg-row">' +
    bgTile("none", "", 0, cur === "none:", "None") +
    BG_RULE.map(function (r) { return bgTile("rule", r[0], r[2], cur === "rule:" + r[0], r[1]); }).join("") +
    '</div><div class="dv-menu-title">Grid Lines</div><div class="dv-bg-row">' +
    BG_GRID.map(function (r) { return bgTile("grid", r[0], r[2], cur === "grid:" + r[0], r[1]); }).join("") +
    '</div><div class="dv-menu-hint">The background is only a writing guide — it is not part of the note text. College Ruled matches one line of text.</div></div>';
}

/* Nút "Rule Lines ⌄" (nền trang của Chương: dòng kẻ / ô lưới) — dùng ở thẻ View. bgCtl = {get(), set(bg)}. */
export function bgButton(bgCtl, disabled) {
  var bgOn = bgCtl && bgCtl.get() && bgCtl.get().kind !== "none";
  var bgb = el("button", "dv-rbtn" + (bgOn ? " on" : ""), ICO_BG + '<span class="dv-rbtn-label">Rule Lines</span>' + ICO_CHEV);
  bgb.type = "button"; bgb.disabled = !!disabled || !bgCtl; bgb.title = "Rule Lines — show rule lines or grid lines on the page";
  bgb.addEventListener("click", function (e) {
    e.stopPropagation();
    var r = bgb.getBoundingClientRect();
    var bindBg = function (panel) {
      panel.querySelectorAll("[data-bg]").forEach(function (t) {
        t.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var parts = t.getAttribute("data-bg").split(":");
          bgCtl.set(parts[0] === "none" ? null : { kind: parts[0], size: parts[1] });
          panel.innerHTML = bgMenuHtml(bgCtl.get()); bindBg(panel);
          var nowOn = bgCtl.get() && bgCtl.get().kind !== "none";
          bgb.classList.toggle("on", !!nowOn);
        });
      });
    };
    openDropdown("dvbg", Math.min(r.left, window.innerWidth - 340), r.bottom + 6, bgMenuHtml(bgCtl.get()), bindBg);
  });
  return bgb;
}

/* opts: {enabled, readOnly, pdf, bg: {get(), set(bg)} | null, extras: [element]} */
export function buildDrawRibbon(wrap, opts) {
  var dis = !opts.enabled || opts.readOnly;
  var tools = el("div", "dv-tools");
  var mk = function (cls, html, title, on, click) {
    var b = el("button", "dv-tool " + cls + (on ? " on" : ""), html);
    b.type = "button"; b.title = title; b.disabled = dis;
    b.addEventListener("click", click);
    tools.appendChild(b);
    return b;
  };
  mk("dv-tool-select", ICO_SELECT + "<span>Select</span>", "Select Objects — click ink or a shape to move, resize or recolor it (Esc)", !dv.tool, function () { setTool(null); });
  mk("dv-tool-eraser", ICO_ERASER, "Eraser — drag over ink or shapes to erase them", dv.tool === "eraser", function () { setTool(dv.tool === "eraser" ? null : "eraser"); });
  dv.pens.forEach(function (p) {
    var on = dv.tool === "pen" && dv.penId === p.id;
    var b = mk("dv-pen", penIcon(p) + (on ? '<span class="dv-pen-caret">▾</span>' : ""), penTitle(p) + (on ? " — click again for color and thickness" : ""), on, function (e) {
      e.stopPropagation();
      if (on) { openPenOptions(b, p); return; }
      dv.penId = p.id; saveOpts(); setTool("pen");
    });
    b.setAttribute("data-pen", p.id);
  });
  var add = mk("dv-add", '<span class="dv-add-plus">+</span><span class="dv-pen-caret">▾</span>', "Add Pen", false, function (e) {
    e.stopPropagation();
    var r = add.getBoundingClientRect();
    openDropdown("dvadd", Math.min(r.left, window.innerWidth - 230), r.bottom + 6,
            '<div class="dv-menu dv-add-menu">' + ["pen", "marker", "fountain", "brush", "laser"].map(function (k) {
        return '<button type="button" class="dv-menu-row" data-kind="' + k + '"><span class="dv-addico">' + addIcon(k) + "</span>" + PEN_KINDS[k].label + "</button>";
      }).join("") + "</div>", function (panel) {
        panel.querySelectorAll("[data-kind]").forEach(function (b2) {
          b2.addEventListener("click", function () {
            hooks.closeFloating();
            if (dv.pens.length >= MAX_PENS) { window.alert("You can have up to " + MAX_PENS + " pens. Delete a pen first."); return; }
            var kind = b2.getAttribute("data-kind");
            var p = { id: "c" + Date.now().toString(36), kind: kind, color: kind === "marker" ? "#ffff00" : kind === "laser" ? "#ff1f1f" : "#004f8b", w: PEN_KINDS[kind].widths[1] };
            dv.pens.push(p); dv.penId = p.id; savePens(); saveOpts(); setTool("pen");
          });
        });
      });
  });
  wrap.appendChild(buildGroup([tools]));

  // [▢◯ ⌄] Hình khối (chỉ icon). Nền trang (Rule Lines) đã chuyển sang thẻ View (người dùng chốt) — bgButton() bên dưới.
  var row = el("div", "dv-rgroup");
  if (opts.bg) { row.appendChild(bgButton(opts.bg, dis)); row.appendChild(el("span", "dv-vsep")); }
  var sb = el("button", "dv-rbtn dv-rbtn-icon" + (dv.tool === "shape" ? " on" : ""), ICO_SHAPES + ICO_CHEV);
  sb.type = "button"; sb.disabled = dis;
  sb.title = "Shapes — lines, arrows, basic shapes, graphs" + (dv.tool === "shape" ? " (drawing — press Esc to stop)" : "");
  sb.addEventListener("click", function (e) {
    e.stopPropagation();
    var r = sb.getBoundingClientRect();
    openDropdown("dvshapes", Math.min(r.left, window.innerWidth - 300), r.bottom + 6, shapeMenuHtml(), bindShapeMenu);
  });
  row.appendChild(sb);
  var groupItems = [row];
  (opts.extras || []).forEach(function (x) { groupItems.push(x); });
  wrap.appendChild(buildGroup(groupItems));
}

// Bảng chỉnh bút (theo mẫu Word): nét xem trước · Độ dày (− 5 mức +) · Màu gần đây · Màu (16 trơn + 8 vân) ·
// Màu khác… · Lấy màu trên màn hình · Xoá bút.
function openPenOptions(anchor, p) {
  var r = anchor.getBoundingClientRect();
  var widths = function () { return PEN_KINDS[p.kind].widths; };
  var wIdx = function () {
    var ws = widths(), best = 0;
    ws.forEach(function (w, i) { if (Math.abs(w - p.w) < Math.abs(ws[best] - p.w)) best = i; });
    return best;
  };
  var sw = function (c) {
    return '<button type="button" class="dv-csw' + (c === p.color ? " on" : "") + '" data-c="' + esc(c) + '" title="' + esc(colorName(c)) + '" style="background:' + esc(cssPaint(c)) + '"></button>';
  };
  var html = function () {
    var ws = widths(), cur = wIdx(), t = texOf(p.color);
    var pv = t ? '<defs><linearGradient id="dvpv" x1="0" y1="0" x2="1" y2="0">' + t.stops.map(function (c, i) { return '<stop offset="' + (i / (t.stops.length - 1)).toFixed(2) + '" stop-color="' + c + '"/>'; }).join("") + "</linearGradient></defs>" : "";
    var pw = Math.max(2, Math.min(16, p.w * (p.kind === "marker" ? 0.8 : 1.4)));
    return '<div class="dv-menu dv-penopt">' +
      '<div class="dv-pv"><svg width="196" height="26" viewBox="0 0 196 26">' + pv + '<path d="M8 15C60 13 120 11 188 10" fill="none" stroke="' + (t ? "url(#dvpv)" : esc(p.color)) + '" stroke-width="' + pw + '" stroke-linecap="round"' + (p.kind === "marker" ? ' opacity=".55"' : "") + "/></svg></div>" +
      '<div class="dv-menu-sep"></div><div class="dv-menu-title">Thickness</div>' +
      '<div class="dv-thick"><button type="button" class="dv-tstep" data-wstep="-1" title="Thinner"' + (cur === 0 ? " disabled" : "") + '><svg width="14" height="14"><path d="M2 7h10" stroke="currentColor" stroke-width="1.6"/></svg></button>' +
      ws.map(function (w, i) {
        var d = 3 + i * 2.6;
        return '<button type="button" class="dv-tdot' + (i === cur ? " on" : "") + '" data-w="' + w + '" title="' + w + '"><span style="width:' + d + "px;height:" + d + 'px"></span></button>';
      }).join("") +
      '<button type="button" class="dv-tstep" data-wstep="1" title="Thicker"' + (cur === ws.length - 1 ? " disabled" : "") + '><svg width="14" height="14"><path d="M2 7h10M7 2v10" stroke="currentColor" stroke-width="1.6"/></svg></button></div>' +
      '<div class="dv-menu-sep"></div><div class="dv-menu-title">Recent Colors</div><div class="dv-cgrid">' + dv.recentColors.map(sw).join("") + "</div>" +
      '<div class="dv-menu-title">Colors</div><div class="dv-cgrid">' + PEN_COLORS.map(sw).join("") + "</div>" +
      '<div class="dv-menu-sep"></div>' +
      '<label class="dv-menu-row dv-more"><span class="dv-mico"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.2" fill="#e71224"/><circle cx="8.5" cy="4.6" r="1.2" fill="#ffc114"/><circle cx="11" cy="7" r="1.2" fill="#008c3a"/><circle cx="6" cy="9.6" r="1.2" fill="#004f8b"/></svg></span>More Colors…<input type="color" data-c-more value="' + (p.color[0] === "#" ? p.color : "#004f8b") + '"></label>' +
      '<button type="button" class="dv-menu-row" data-eyedrop' + (window.EyeDropper ? "" : ' disabled title="This browser does not support the eyedropper"') + '><span class="dv-mico"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M10.5 2.5l3 3-1.6 1.6-3-3zM9 5.5L3 11.5 2.5 13.5 4.5 13 10.5 7"/></svg></span>Eyedropper</button>' +
      '<button type="button" class="dv-menu-row" data-delpen' + (dv.pens.length > 1 ? "" : " disabled") + '><span class="dv-mico"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5M7 6.5v5M9 6.5v5"/></svg></span>Delete Tool</button>' +
      "</div>";
  };
  var bind;
  var rerender = function (panel) { panel.innerHTML = html(); bind(panel); hooks.renderRibbon(); };
  var setW = function (panel, w) { p.w = w; savePens(); rerender(panel); };
  var pick = function (panel, c) { p.color = c; pushRecent(c); savePens(); rerender(panel); };
  bind = function (panel) {
    if (!panel._dvStop) { panel._dvStop = true; panel.addEventListener("click", function (e) { e.stopPropagation(); }); }
    panel.querySelectorAll("[data-w]").forEach(function (b) { b.addEventListener("click", function () { setW(panel, parseFloat(b.getAttribute("data-w"))); }); });
    panel.querySelectorAll("[data-wstep]").forEach(function (b) {
      b.addEventListener("click", function () {
        var ws = widths(), i = Math.max(0, Math.min(ws.length - 1, wIdx() + parseInt(b.getAttribute("data-wstep"), 10)));
        setW(panel, ws[i]);
      });
    });
    panel.querySelectorAll("[data-c]").forEach(function (b) { b.addEventListener("click", function () { pick(panel, b.getAttribute("data-c")); }); });
    var more = panel.querySelector("[data-c-more]"); if (more) more.addEventListener("change", function () { pick(panel, more.value); });
    var eye = panel.querySelector("[data-eyedrop]");
    if (eye && window.EyeDropper) eye.addEventListener("click", function () {
      new window.EyeDropper().open().then(function (res) { if (res && res.sRGBHex) pick(panel, res.sRGBHex.toLowerCase()); }).catch(function () { /* bấm Esc */ });
    });
    var del = panel.querySelector("[data-delpen]");
    if (del) del.addEventListener("click", function () {
      if (dv.pens.length <= 1) return;
      dv.pens = dv.pens.filter(function (x) { return x !== p; }); dv.penId = dv.pens[0].id; savePens(); saveOpts(); hooks.closeFloating(); setTool(null);
    });
  };
  openDropdown("dvpen", Math.max(8, Math.min(r.left - 8, window.innerWidth - 236)), r.bottom + 6, html(), bind);
}

// Rời thẻ Draw / đổi mục đang mở → bỏ bút đang cầm (con trỏ trở về soạn chữ bình thường).
export function leaveDraw() {
  finishTextEdit();
  selectItem(null);
  if (dv.tool) setTool(null, { silent: true });
}
export function isDrawing() { return !!dv.tool; }
