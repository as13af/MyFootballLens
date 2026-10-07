// Telestration: draw on a paused frame. Shapes are stored in normalised (0–1) video coordinates
// and also rendered to a PNG at the video's resolution so ffmpeg can burn them into exports.
import { api } from './api.js';
import { S, on, emit } from './state.js';
import { video, hasVideo } from './player.js';
import { $, $$, fitCanvas, toast, errToast } from './ui.js';

const canvas = $('#drawCanvas'), wrap = $('#videoWrap'), bar = $('#drawBar'), pop = $('#textPop');
const COLORS = ['#ffe14d', '#ffffff', '#ff4d4f', '#3b82f6', '#22c55e', '#f97316', '#111111'];
const CURVED = { carrow: 'arrow', cdash: 'dash', cline: 'line' };   // 3-click tools -> look of the shape
let active = false, tool = 'arrow', color = COLORS[0];
let shapes = [], cur = null, editing = null, shown = null, shownShapes = [], holdTimer = 0;
let sel = null;          // index of the selected shape (Select tool)
let drag = null;         // { kind: 'move' | 'pt', ... }
let hist = [];           // undo snapshots of `shapes`
let textEdit = null;     // { shape, index (null = new), before }
const textDefaults = { size: 30, align: 'left', bold: true, italic: false, bg: 'dark' };

$('#drawColors').innerHTML = COLORS.map((c) => `<button data-c="${c}" title="${c}"><span style="background:${c}"></span></button>`).join('');

function videoRect() {
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.min(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}

function layout() {
  const r = videoRect();
  canvas.style.left = r.x + 'px';
  canvas.style.top = r.y + 'px';
  fitCanvas(canvas, r.w, r.h);
  redraw();
}

// ---------- geometry ----------
/** Quadratic control point so the curve from a to b passes exactly through m. */
function controlThrough(a, m, b) {
  const d0 = Math.hypot(m[0] - a[0], m[1] - a[1]), d1 = Math.hypot(b[0] - m[0], b[1] - m[1]);
  const t = Math.min(0.8, Math.max(0.2, d0 + d1 ? d0 / (d0 + d1) : 0.5)), u = 1 - t;
  return [(m[0] - u * u * a[0] - t * t * b[0]) / (2 * u * t), (m[1] - u * u * a[1] - t * t * b[1]) / (2 * u * t)];
}
const quad = (a, c, b, t) => { const u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]; };

/** Pixel polyline of an arrow/line shape (straight or curved). */
function linePoints(sh, P) {
  if (!CURVED[sh.type] || P.length < 3) return [P[0], P[P.length - 1]];
  const [a, m, b] = P;
  const c = controlThrough(a, m, b);
  const out = [];
  for (let k = 0; k <= 48; k++) out.push(quad(a, c, b, k / 48));
  return out;
}

/** First `f` (0–1) of a polyline by length — used to "draw on" lines and arrows. */
function partial(pts, f) {
  if (f >= 1 || pts.length < 2) return pts;
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += seg[i - 1] = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * Math.max(0, f);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (left >= seg[i - 1]) { out.push(pts[i]); left -= seg[i - 1]; continue; }
    const k = seg[i - 1] ? left / seg[i - 1] : 0;
    out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]);
    break;
  }
  if (out.length < 2) out.push(pts[0]);
  return out;
}
const pathLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Draw a polyline with an optional arrowhead at its end; the shaft stops short so the tip stays sharp. */
function strokeArrow(ctx, pts, lw, { dashed, head, dashOffset = 0 }) {
  const tip = pts[pts.length - 1];
  const hl = head ? Math.min(lw * 3.4, pathLen(pts)) : 0;   // a line that is still drawing on gets a smaller head
  // direction of the last part of the path, measured over roughly one head length
  let k = pts.length - 2;
  while (k > 0 && Math.hypot(tip[0] - pts[k][0], tip[1] - pts[k][1]) < Math.max(hl, 2)) k--;
  const ang = Math.atan2(tip[1] - pts[k][1], tip[0] - pts[k][0]);
  if (dashed) { ctx.setLineDash([lw * 2.6, lw * 2]); ctx.lineDashOffset = dashOffset; }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    if (head && Math.hypot(tip[0] - pts[i][0], tip[1] - pts[i][1]) < hl * 0.6) break;
    ctx.lineTo(pts[i][0], pts[i][1]);
  }
  if (head) ctx.lineTo(tip[0] - Math.cos(ang) * hl * 0.6, tip[1] - Math.sin(ang) * hl * 0.6);
  else ctx.lineTo(tip[0], tip[1]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (head) {
    ctx.beginPath(); ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - hl * Math.cos(ang - 0.42), tip[1] - hl * Math.sin(ang - 0.42));
    ctx.lineTo(tip[0] - hl * Math.cos(ang + 0.42), tip[1] - hl * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill();
  }
}

/** Text block layout in pixels. The anchor (pts[0]) is the block's left edge; alignment aligns the lines inside. */
function textLayout(ctx, sh, w, h) {
  const s = h / 720;
  const legacy = !sh.align;   // drawings saved before text options existed
  const fs = (sh.size ?? 30 * (sh.w || 5) / 5) * s;
  ctx.font = `${sh.italic ? 'italic ' : ''}${sh.bold === false ? 500 : 700} ${fs}px system-ui, "Segoe UI", sans-serif`;
  const lines = String(sh.text || '').split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const bw = Math.max(1, ...widths), lh = fs * 1.22, pad = fs * 0.38;
  const left = sh.pts[0][0] * w;
  const top = legacy ? sh.pts[0][1] * h - fs * 0.85 : sh.pts[0][1] * h;
  return { fs, lines, widths, bw, lh, pad, left, top, box: { x: left - pad, y: top - pad * 0.7, w: bw + pad * 2, h: lines.length * lh + pad * 1.2 } };
}

function luminance(hex) {
  const n = parseInt((hex || '#000000').slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// ---------- motion ----------
// A shape can "draw on" when its drawing appears, then loop one effect (sh.anim = { in, loop };
// missing keys mean the default for its type). Every loop shares one period, so an export can render
// the intro once plus a single loop cycle and repeat that cycle seamlessly for the rest of the hold.
export const LOOP = 1.6;                   // seconds per loop cycle
const STAGGER = 0.18, MAX_STAGGER = 1.1;   // shapes draw on one after another, in drawing order
const SETTLE = 0.35;                       // a loop eases in after its shape has drawn on
const INTRO = { arrow: 0.55, dash: 0.65, line: 0.5, free: 0.7, circle: 0.45, spot: 0.45, rect: 0.4, text: 0.35 };
/** Loop effects each shape type can use; the first one is its default. */
export const LOOPS = {
  arrow: ['pulse', 'none'], line: ['pulse', 'none'], free: ['pulse', 'none'], text: ['none'],
  dash: ['flow', 'pulse', 'none'], rect: ['flow', 'pulse', 'none'],
  circle: ['ripple', 'pulse', 'none'], spot: ['ripple', 'pulse', 'none'],
};
export const LOOP_NAMES = { pulse: 'Pulse', flow: 'Flow', ripple: 'Ripple', none: 'None' };

const kindOf = (sh) => CURVED[sh.type] || sh.type;
export function motionOf(sh) {
  const opts = LOOPS[kindOf(sh)] || ['none'];
  const loop = opts.includes(sh.anim?.loop) ? sh.anim.loop : opts[0];
  return { in: sh.anim?.in ?? true, loop };
}
export const isAnimated = (list) => list.some((sh) => { const m = motionOf(sh); return m.in || m.loop !== 'none'; });

/** When each shape starts drawing on, and how long it takes. */
function introTimes(list) {
  let n = 0;
  return list.map((sh) => {
    if (!motionOf(sh).in) return { start: 0, dur: 0 };
    return { start: Math.min(n++ * STAGGER, MAX_STAGGER), dur: INTRO[kindOf(sh)] || 0.4 };
  });
}
/** Seconds until every shape has drawn on and every loop is at full strength. */
export function introLength(list) {
  return Math.max(0, ...introTimes(list).map((x) => x.start + x.dur)) + (list.some((sh) => motionOf(sh).loop !== 'none') ? SETTLE : 0);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (v) => 1 - (1 - v) ** 3;

// ---------- rendering (shared by screen, PNG, thumbnails) ----------
/** `t` = seconds since the drawing appeared; leave it out for the still, fully drawn look (thumbnails, old exports). */
export function renderShapes(ctx, list, w, h, t) {
  const s = h / 720;
  const times = t == null ? null : introTimes(list);
  const ph = t == null ? 0 : (t % LOOP) / LOOP;           // loop phase, 0–1
  const breathe = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);  // 0 → 1 → 0 over one loop
  list.forEach((sh, i) => {
    const m = t == null ? { in: false, loop: 'none' } : motionOf(sh);
    const it = times?.[i];
    const raw = m.in ? clamp01((t - it.start) / it.dur) : 1;
    if (raw <= 0) return;
    const pr = easeOut(raw);                                                     // draw-on progress
    const amp = t == null ? 0 : clamp01((t - (m.in ? it.start + it.dur : 0)) / SETTLE);  // loop strength
    const fx = { pr, pulse: m.loop === 'pulse' ? breathe * amp : 0, flow: m.loop === 'flow' ? ph : 0, ripple: m.loop === 'ripple' ? amp : 0, ph };
    drawShape(ctx, sh, w, h, s, fx);
  });
}

/** A soft, breathing glow along a path (the "pulse" loop). */
function glow(ctx, path, lw, color, p) {
  if (p <= 0.01) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.32 * p;
  ctx.strokeStyle = color; ctx.lineWidth = lw * (1.6 + 1.4 * p);
  ctx.shadowColor = color; ctx.shadowBlur = lw * 3 * p;
  path(); ctx.stroke();
  ctx.restore();
}

/** Expanding rings that fade out (the "ripple" loop): two rings, half a cycle apart. */
function ripple(ctx, cx, cy, rx, ry, lw, color, fx) {
  if (fx.ripple <= 0) return;
  ctx.save();
  ctx.setLineDash([]); ctx.shadowBlur = 0; ctx.strokeStyle = color;
  for (const off of [0, 0.5]) {
    const q = (fx.ph + off) % 1;
    ctx.globalAlpha = 0.55 * (1 - q) ** 1.5 * fx.ripple;
    ctx.lineWidth = lw * (0.7 - 0.35 * q);
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * (1 + 0.5 * q), ry * (1 + 0.5 * q), 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function drawShape(ctx, sh, w, h, s, fx) {
  const P = sh.pts.map(([x, y]) => [x * w, y * h]);
  const lw = sh.w * s;
  const { pr } = fx;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = sh.color;
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4 * s;
  const [a, b] = [P[0], P[P.length - 1]];
  const kind = kindOf(sh);
  switch (kind) {
    case 'arrow': case 'dash': case 'line': case 'free': {
      const full = kind === 'free' ? P : linePoints(sh, P);
      const pts = partial(full, pr);
      glow(ctx, () => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); }, lw, sh.color, fx.pulse);
      if (kind === 'free') { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); break; }
      // flow: the dash pattern (2.6 + 2 line widths) moves two repeats per loop toward the tip
      strokeArrow(ctx, pts, lw, { dashed: kind === 'dash', head: kind !== 'line', dashOffset: -fx.flow * lw * 4.6 * 2 });
      break;
    }
    case 'circle': {
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2 || 1, ry = Math.abs(b[1] - a[1]) / 2 || 1;
      const ring = () => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); };
      ripple(ctx, cx, cy, rx, ry, lw, sh.color, fx);
      glow(ctx, ring, lw, sh.color, fx.pulse);
      ring(); ctx.globalAlpha = 0.18 * pr; ctx.fill(); ctx.globalAlpha = 1;
      // draw-on: the ring sweeps round from the top
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); ctx.stroke();
      break;
    }
    case 'spot': {
      // Player spotlight: ring at the feet + soft beam upwards. Draw-on grows it out of the ground.
      const rx = Math.max(8 * s, Math.abs(b[0] - a[0])), ry = rx * 0.32, beam = rx * 4.2 * pr;
      ripple(ctx, a[0], a[1], rx, ry, lw, sh.color, fx);
      ctx.globalAlpha = pr;
      ctx.shadowBlur = 0;
      const g = ctx.createLinearGradient(0, a[1] - beam, 0, a[1]);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, hexA(sh.color, 0.38 + 0.12 * fx.pulse));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(a[0] - rx * 0.45, a[1] - beam); ctx.lineTo(a[0] + rx * 0.45, a[1] - beam);
      ctx.lineTo(a[0] + rx, a[1]); ctx.ellipse(a[0], a[1], rx, ry, 0, 0, Math.PI); ctx.closePath(); ctx.fill();
      const feet = () => { ctx.beginPath(); ctx.ellipse(a[0], a[1], rx * (0.5 + 0.5 * pr), ry * (0.5 + 0.5 * pr), 0, 0, Math.PI * 2); };
      glow(ctx, feet, lw, sh.color, fx.pulse);
      feet(); ctx.fillStyle = hexA(sh.color, 0.3); ctx.fill(); ctx.stroke();
      break;
    }
    case 'rect': {
      // draw-on: the zone opens out from its centre
      const k = 0.85 + 0.15 * pr;
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rw = Math.abs(b[0] - a[0]) * k, rh = Math.abs(b[1] - a[1]) * k;
      const x = cx - rw / 2, y = cy - rh / 2;
      glow(ctx, () => { ctx.beginPath(); ctx.rect(x, y, rw, rh); }, lw, sh.color, fx.pulse);
      ctx.globalAlpha = 0.22 * pr; ctx.fillRect(x, y, rw, rh); ctx.globalAlpha = pr;
      ctx.setLineDash([lw * 2, lw * 1.4]); ctx.lineDashOffset = -fx.flow * lw * 3.4 * 2;
      ctx.strokeRect(x, y, rw, rh);
      break;
    }
    case 'text':
      ctx.globalAlpha = pr;
      ctx.translate(0, (1 - pr) * 10 * s);   // fades in while rising into place
      drawText(ctx, sh, w, h);
      break;
  }
  ctx.restore();
}

function drawText(ctx, sh, w, h) {
  const L = textLayout(ctx, sh, w, h);
  const bg = sh.bg || 'dark';
  ctx.shadowBlur = 0;
  let ink = sh.color;
  if (bg !== 'none') {
    ctx.fillStyle = bg === 'dark' ? 'rgba(0,0,0,.66)' : bg === 'light' ? 'rgba(255,255,255,.9)' : sh.color;
    if (bg === 'color') ink = luminance(sh.color) > 0.6 ? '#111111' : '#ffffff';
    ctx.beginPath(); ctx.roundRect?.(L.box.x, L.box.y, L.box.w, L.box.h, L.fs * 0.25); ctx.fill();
  }
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  L.lines.forEach((line, i) => {
    const x = (sh.align || 'left') === 'left' ? L.left : sh.align === 'center' ? L.left + (L.bw - L.widths[i]) / 2 : L.left + L.bw - L.widths[i];
    const y = L.top + i * L.lh + L.fs * 0.85;
    if (bg === 'none') {   // outline keeps text readable on any background
      ctx.lineWidth = Math.max(2, L.fs * 0.14);
      ctx.strokeStyle = luminance(ink) > 0.5 ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.85)';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = ink;
    ctx.fillText(line, x, y);
  });
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- animation clock ----------
// t0 = when the visible drawing "appeared". Draw mode starts it far in the past so shapes are already
// drawn on and only their loops move; Preview resets it to replay the whole animation.
let t0 = 0, raf = 0;
const now = () => performance.now();
const elapsed = () => (now() - t0) / 1000;

/** Show a saved drawing on the video (null hides it); its animation starts from the beginning. */
function show(d) {
  shown = d;
  shownShapes = d ? JSON.parse(d.shapes || '[]') : [];
  t0 = now();
  redraw();
}

function moving(list) {
  return list.some((sh) => motionOf(sh).loop !== 'none') || elapsed() < introLength(list);
}

/** Keep redrawing every frame only while something on screen is actually animating. */
function kick() {
  const list = active ? shapes : shown ? shownShapes : [];
  if (raf || !list.length || !moving(list)) return;
  raf = requestAnimationFrame(() => { raf = 0; redraw(); });
}

function redraw() {
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!active) {
    if (shown) renderShapes(ctx, shownShapes, w, h, elapsed());
    kick();
    return;
  }
  const list = [...shapes];
  if (cur) list.push(previewOf(cur));
  if (textEdit && textEdit.index == null) list.push(textEdit.shape);
  renderShapes(ctx, list, w, h, elapsed());
  if (sel != null && shapes[sel]) drawSelection(ctx, shapes[sel], w, h);
  syncMotion();
  kick();
}

/** A 3-click curve in progress: show it straight after click 1, curved through the 2nd point after click 2. */
function previewOf(c) {
  if (!CURVED[c.type]) return c;
  const [a, m, mouse] = c.pts;
  if (c.pts.length === 2) return { ...c, type: CURVED[c.type], pts: [a, m] };
  return { ...c, pts: [a, m, mouse] };
}

// ---------- selection: bounds, handles, hit testing (pixel space) ----------
function bounds(sh, w, h, ctx) {
  if (sh.type === 'text') return textLayout(ctx, sh, w, h).box;
  const P = sh.pts.map(([x, y]) => [x * w, y * h]);
  let pts = CURVED[sh.type] ? linePoints(sh, P) : P;
  if (sh.type === 'spot') {
    const rx = Math.max(8 * h / 720, Math.abs(P[1][0] - P[0][0]));
    pts = [[P[0][0] - rx, P[0][1] + rx * 0.32], [P[0][0] + rx, P[0][1] - rx * 4.2]];
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function handles(sh, w, h) {
  if (sh.type === 'text' || sh.type === 'free') return [];
  return sh.pts.map(([x, y], i) => ({ i, x: x * w, y: y * h, via: !!CURVED[sh.type] && i === 1 }));
}

function drawSelection(ctx, sh, w, h) {
  const b = bounds(sh, w, h, ctx);
  ctx.save();
  ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
  ctx.setLineDash([]);
  for (const hd of handles(sh, w, h)) {
    ctx.beginPath();
    if (hd.via) ctx.arc(hd.x, hd.y, 6, 0, Math.PI * 2); else ctx.rect(hd.x - 5, hd.y - 5, 10, 10);
    ctx.fillStyle = hd.via ? '#C4AF9A' : '#ffffff';
    ctx.fill(); ctx.strokeStyle = '#111827'; ctx.stroke();
  }
  ctx.restore();
}

function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function hitShape(sh, px, py, w, h, ctx) {
  const tol = Math.max(8, sh.w * h / 720 * 1.5);
  const P = sh.pts.map(([x, y]) => [x * w, y * h]);
  const kind = CURVED[sh.type] || sh.type;
  if (['arrow', 'dash', 'line', 'free'].includes(kind)) {
    const pts = kind === 'free' ? P : linePoints(sh, P);
    for (let k = 1; k < pts.length; k++) if (segDist(px, py, pts[k - 1], pts[k]) <= tol) return true;
    return false;
  }
  const b = bounds(sh, w, h, ctx);
  return px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol;
}

function shapeAt(px, py) {
  const w = canvas.clientWidth, h = canvas.clientHeight, ctx = canvas.getContext('2d');
  for (let i = shapes.length - 1; i >= 0; i--) if (hitShape(shapes[i], px, py, w, h, ctx)) return i;
  return null;
}

function handleAt(px, py) {
  if (sel == null || !shapes[sel]) return null;
  for (const hd of handles(shapes[sel], canvas.clientWidth, canvas.clientHeight)) {
    if ((px - hd.x) ** 2 + (py - hd.y) ** 2 <= 81) return hd;
  }
  return null;
}

// ---------- undo ----------
const snap = () => { hist.push(JSON.stringify(shapes)); if (hist.length > 100) hist.shift(); };
export function undo() {
  if (textEdit) return;
  if (cur) { cur = null; redraw(); return; }
  if (!hist.length) return;
  shapes = JSON.parse(hist.pop());
  sel = null;
  redraw();
}

// ---------- draw mode ----------
const drawingAt = (t, tol = 0.15) => S.drawings.find((d) => Math.abs(d.t - t) <= tol);

export function enter() {
  if (!hasVideo()) { toast('Load a video first', { error: true }); return; }
  video.pause();
  active = true;
  document.body.classList.add('drawing');
  canvas.classList.add('active');
  bar.hidden = false;
  $('#tDraw').classList.add('primary');
  editing = drawingAt(video.currentTime) || null;
  shapes = editing ? JSON.parse(editing.shapes) : [];
  hist = []; sel = null; cur = null;
  if (editing) { video.currentTime = editing.t; $('#drawHold').value = editing.hold; }
  $('#drawDelete').hidden = !editing;
  shown = null; shownShapes = [];
  t0 = now() - 1e6;   // already drawn on; loops keep moving while editing
  setTool(editing && tool !== 'select' ? 'select' : tool);
  layout();
}

export function exit() {
  closeText(false);
  active = false; cur = null; shapes = []; editing = null; sel = null; drag = null; hist = [];
  document.body.classList.remove('drawing');
  canvas.classList.remove('active');
  bar.hidden = true;
  $('#tDraw').classList.remove('primary');
  redraw();
}

export const isActive = () => active;
export const toggle = () => (active ? exit() : enter());

/** Esc inside draw mode: cancel the current step; returns false when there was nothing to cancel. */
export function escape() {
  if (textEdit) { closeText(false); return true; }
  if (cur) { cur = null; redraw(); return true; }
  if (sel != null) { sel = null; redraw(); return true; }
  return false;
}

export function deleteSelected() {
  if (sel == null || textEdit) return;
  snap();
  shapes.splice(sel, 1);
  sel = null;
  redraw();
}

async function save() {
  closeText(true);
  if (!shapes.length) { toast('Nothing drawn yet', { error: true }); return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  const off = document.createElement('canvas');
  off.width = vw; off.height = vh;
  renderShapes(off.getContext('2d'), shapes, vw, vh);
  const body = {
    t: editing ? editing.t : video.currentTime, hold: +$('#drawHold').value || 3,
    shapes: JSON.stringify(shapes), png: off.toDataURL('image/png'), thumb: thumbnail(shapes),
  };
  const btn = $('#drawSave');
  btn.disabled = true;
  try {
    let d;
    if (editing) {
      d = Object.assign(editing, await api.put(`/api/drawings/${editing.id}`, body));
    } else {
      d = await api.post(`/api/matches/${S.match.id}/drawings`, body);
      S.drawings.push(d);
      S.drawings.sort((a, b) => a.t - b.t);
      editing = d;   // if the animation upload fails, saving again updates this drawing instead of duplicating it
    }
    if (isAnimated(shapes)) {
      btn.textContent = 'Rendering animation…';
      await uploadFrames(d.id, shapes, vw, vh);
    }
    emit('drawings');
    toast('Drawing saved — playback pauses here and exports show a freeze-frame');
    exit();
  } catch (e) { errToast(e); } finally { btn.disabled = false; btn.textContent = 'Save drawing'; }
}

const FPS = 30;   // animation frame rate in exports; LOOP * FPS is a whole number of frames

/**
 * Render the animation for exports: the intro (draw-on) frames once, then one loop cycle that
 * ffmpeg repeats for the rest of the hold. Sent as one binary body of PNGs; `sizes` splits it.
 */
async function uploadFrames(did, list, vw, vh) {
  const k = Math.min(1, 1080 / vh);   // 4K sources: render at 1080p, ffmpeg scales it up to the frame
  const w = Math.round(vw * k), h = Math.round(vh * k);
  const intro = Math.ceil(introLength(list) * FPS);
  const loop = list.some((sh) => motionOf(sh).loop !== 'none') ? Math.round(LOOP * FPS) : 1;
  // Drawing a frame takes well under a millisecond; PNG encoding is the slow part, and the browser
  // runs several encodes in parallel. A few canvases at a time keeps memory small.
  const pool = Array.from({ length: 6 }, () => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const blobs = [];
  for (let f0 = 0; f0 < intro + loop; f0 += pool.length) {
    const batch = pool.slice(0, Math.min(pool.length, intro + loop - f0)).map((c, k) => {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      renderShapes(ctx, list, w, h, (f0 + k) / FPS);
      return new Promise((ok) => c.toBlob(ok, 'image/png'));   // toBlob copies the pixels when called
    });
    blobs.push(...await Promise.all(batch));
  }
  const q = new URLSearchParams({ fps: FPS, intro, loop, sizes: blobs.map((b) => b.size).join(',') });
  const r = await fetch(`/api/drawings/${did}/frames?${q}`, { method: 'POST', body: new Blob(blobs) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Saving the animation failed');
}

/** Small JPEG (frame + drawing) for the Drawings list. Same-origin video, so the canvas isn't tainted. */
function thumbnail(list) {
  const w = 320, h = Math.round(w * (video.videoHeight || 9) / (video.videoWidth || 16));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  try { ctx.drawImage(video, 0, 0, w, h); } catch { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); }
  renderShapes(ctx, list, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}

export async function deleteDrawing(d) {
  await api.del(`/api/drawings/${d.id}`);
  S.drawings = S.drawings.filter((x) => x.id !== d.id);
  if (shown?.id === d.id) { shown = null; shownShapes = []; }
  if (editing?.id === d.id) exit(); else redraw();
  emit('drawings');
  toast('Drawing deleted');
}

async function remove() {
  if (editing) await deleteDrawing(editing).catch(errToast);
}

/** Jump exactly to a drawing and show it (or open it for editing). */
export function jumpTo(d, { edit = false } = {}) {
  if (!hasVideo()) { toast('Load the match video first', { error: true }); return; }
  if (active) exit();
  emit('goto-view', 'tag');
  video.pause();
  video.currentTime = d.t;
  clearTimeout(holdTimer);
  if (edit) { enter(); return; }
  show(d);
}

/** Change how long a drawing freezes playback and exports. */
export function setHold(d, hold) {
  return api.put(`/api/drawings/${d.id}`, { hold }).then((n) => { Object.assign(d, n); emit('drawings'); });
}

// ---------- pointer input ----------
const px = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const norm = (e) => {
  const r = canvas.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
};

canvas.addEventListener('pointerdown', (e) => {
  if (!active) return;
  if (e.button === 2) { escape(); return; }   // right-click cancels
  if (textEdit) { closeText(true); return; }  // clicking away finishes the text box
  const p = norm(e);
  const [x, y] = px(e);

  if (tool === 'select') {
    const hd = handleAt(x, y);
    if (hd) { snap(); drag = { kind: 'pt', i: hd.i }; canvas.setPointerCapture(e.pointerId); return; }
    const i = shapeAt(x, y);
    sel = i;
    if (i != null) {
      snap();
      drag = { kind: 'move', p0: p, orig: shapes[i].pts.map((q) => [...q]), moved: false };
      canvas.setPointerCapture(e.pointerId);
    }
    redraw();
    return;
  }
  if (tool === 'text') { openText(null, p); return; }

  if (CURVED[tool]) {
    // 3 clicks: start, a point the curve passes through, end.
    if (!cur) cur = { type: tool, color, w: +$('#drawWidth').value, pts: [p, p] };
    else if (cur.pts.length === 2) cur.pts = [cur.pts[0], p, p];
    else {
      const [a, m] = cur.pts;
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) > 0.008) { snap(); shapes.push({ ...cur, pts: [a, m, p] }); }
      cur = null;
    }
    redraw();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  cur = { type: tool, color, w: +$('#drawWidth').value, pts: [p, p] };
});

canvas.addEventListener('pointermove', (e) => {
  if (!active) return;
  const p = norm(e);
  if (drag) {
    const sh = shapes[sel];
    if (drag.kind === 'pt') sh.pts[drag.i] = p;
    else {
      const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
      sh.pts = drag.orig.map(([qx, qy]) => [qx + dx, qy + dy]);
      drag.moved = true;
    }
    redraw();
    return;
  }
  if (tool === 'select') {
    const [x, y] = px(e);
    canvas.style.cursor = handleAt(x, y) ? 'grab' : shapeAt(x, y) != null ? 'move' : 'default';
    return;
  }
  if (!cur) return;
  if (cur.type === 'free') cur.pts.push(p); else cur.pts[cur.pts.length - 1] = p;
  redraw();
});

canvas.addEventListener('pointerup', () => {
  if (drag) {
    if (drag.kind === 'move' && !drag.moved) hist.pop();   // a plain click isn't an undo step
    drag = null;
    return;
  }
  if (!cur || CURVED[cur.type]) return;
  const [a, b] = [cur.pts[0], cur.pts[cur.pts.length - 1]];
  if (cur.type === 'free' ? cur.pts.length > 2 : Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.006) { snap(); shapes.push(cur); }
  cur = null;
  redraw();
});

canvas.addEventListener('dblclick', (e) => {
  if (!active || tool !== 'select') return;
  const [x, y] = px(e);
  const i = shapeAt(x, y);
  if (i != null && shapes[i].type === 'text') openText(i);
});
canvas.addEventListener('contextmenu', (e) => { if (active) e.preventDefault(); });

// ---------- text box popup ----------
function openText(index, p) {
  const shape = index != null ? shapes[index]
    : { type: 'text', color, w: 5, pts: [p], text: '', ...textDefaults };
  if (index != null && !shape.align) Object.assign(shape, { align: 'left', bold: true, italic: false, bg: 'dark', size: shape.size ?? 30 * (shape.w || 5) / 5 }, legacyAnchor(shape));
  textEdit = { shape, index, before: index != null ? JSON.stringify(shape) : null };
  if (index != null) { snap(); sel = index; }
  $('#tpText').value = shape.text;
  $('#tpDelete').hidden = index == null;
  syncPop();
  pop.hidden = false;
  placePop();
  $('#tpText').focus();
  redraw();
}

/** Keep the popup just below the text (or above it when there's no room), never covering the preview. */
function placePop() {
  if (!textEdit) return;
  const r = canvas.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const box = bounds({ ...textEdit.shape, text: textEdit.shape.text || ' ' }, r.width, r.height, canvas.getContext('2d'));
  const ox = r.left - wr.left, oy = r.top - wr.top;
  let top = oy + box.y + box.h + 10;
  if (top + pop.offsetHeight > wrap.clientHeight - 8) top = oy + box.y - pop.offsetHeight - 10;
  top = Math.max(8, Math.min(top, wrap.clientHeight - pop.offsetHeight - 8));
  const left = Math.max(8, Math.min(ox + box.x, wrap.clientWidth - pop.offsetWidth - 8));
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}

/** Older text shapes were anchored at the first baseline; convert to the new top-left anchor once. */
function legacyAnchor(sh) {
  const h = canvas.clientHeight || 720;
  const fs = (sh.size ?? 30 * (sh.w || 5) / 5) * h / 720;
  return { pts: [[sh.pts[0][0], sh.pts[0][1] - fs * 0.85 / h]] };
}

function syncPop() {
  const sh = textEdit.shape;
  $('#tpSize').value = sh.size;
  $('#tpSizeVal').textContent = Math.round(sh.size);
  $$('#tpAlign button').forEach((b) => b.classList.toggle('active', b.dataset.align === sh.align));
  $$('#tpStyle button').forEach((b) => b.classList.toggle('active', !!sh[b.dataset.style]));
  $$('#tpBg button').forEach((b) => b.classList.toggle('active', b.dataset.bg === sh.bg));
}

function closeText(commit) {
  if (!textEdit) return;
  const { shape, index, before } = textEdit;
  textEdit = null;
  pop.hidden = true;
  const empty = !shape.text.trim();
  if (commit && !empty) {
    if (index == null) { snap(); shapes.push(shape); sel = shapes.length - 1; }
    Object.assign(textDefaults, { size: shape.size, align: shape.align, bold: shape.bold, italic: shape.italic, bg: shape.bg });
  } else if (index != null) {
    if (commit && empty) { shapes.splice(index, 1); sel = null; }        // emptied text = delete
    else { shapes[index] = JSON.parse(before); hist.pop(); }              // cancelled edit
  }
  redraw();
}

const editText = (fn) => { if (!textEdit) return; fn(textEdit.shape); syncPop(); placePop(); redraw(); };
$('#tpText').addEventListener('input', (e) => editText((s) => { s.text = e.target.value; }));
$('#tpSize').addEventListener('input', (e) => editText((s) => { s.size = +e.target.value; }));
$('#tpAlign').onclick = (e) => { const b = e.target.closest('[data-align]'); if (b) editText((s) => { s.align = b.dataset.align; }); };
$('#tpStyle').onclick = (e) => { const b = e.target.closest('[data-style]'); if (b) editText((s) => { s[b.dataset.style] = !s[b.dataset.style]; }); };
$('#tpBg').onclick = (e) => { const b = e.target.closest('[data-bg]'); if (b) editText((s) => { s.bg = b.dataset.bg; }); };
$('#tpDone').onclick = () => closeText(true);
$('#tpCancel').onclick = () => closeText(false);
$('#tpDelete').onclick = () => {
  if (!textEdit || textEdit.index == null) return;
  const i = textEdit.index;
  textEdit = null; pop.hidden = true;
  shapes.splice(i, 1); sel = null;   // the snapshot taken when the box opened makes this undoable
  redraw();
};
pop.addEventListener('keydown', (e) => {
  e.stopPropagation();   // typing here must not trigger tagging/playback shortcuts
  if (e.key === 'Escape') { e.preventDefault(); closeText(false); }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeText(true); }
});
pop.addEventListener('pointerdown', (e) => e.stopPropagation());

// ---------- playback of saved drawings ----------
on('drawing-hit', (d) => {
  show(d);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (shown === d && !active && video.paused) { show(null); video.play(); }
  }, (d.hold || 3) * 1000);
});
video.addEventListener('play', () => { if (shown) { clearTimeout(holdTimer); show(null); } });
on('seeked', (t) => {
  if (active) return;
  const d = video.paused ? drawingAt(t, 0.05) || null : null;
  if (d !== shown) show(d);
});

// ---------- toolbar ----------
function setTool(t) {
  if (cur) cur = null;
  tool = t;
  $$('#drawTools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  canvas.classList.toggle('tool-select', t === 'select');
  canvas.style.cursor = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  if (t !== 'select' && sel != null) { sel = null; }
  redraw();
}
function setColor(c) {
  color = c;
  $$('#drawColors button').forEach((b) => b.classList.toggle('active', b.dataset.c === c));
  // recolour what's being edited / selected
  if (textEdit) editText((s) => { s.color = c; });
  else if (sel != null && shapes[sel]) { snap(); shapes[sel].color = c; redraw(); }
}
setTool('arrow'); setColor(COLORS[0]);
$('#drawTools').onclick = (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); };
$('#drawColors').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) setColor(b.dataset.c); };
$('#drawWidth').onchange = (e) => {
  if (sel != null && shapes[sel] && shapes[sel].type !== 'text') { snap(); shapes[sel].w = +e.target.value; redraw(); }
};

// Motion of the selected shape. New shapes use their type's default ("Auto"); these override it.
let motionKey = null;
function syncMotion() {
  const sh = sel != null ? shapes[sel] : null;
  const key = sh ? `${sel}|${sh.type}|${sh.anim?.in}|${sh.anim?.loop}` : '';
  if (key === motionKey) return;   // redraw runs every animation frame; only touch the DOM on change
  motionKey = key;
  const inBtn = $('#drawIn'), loopSel = $('#drawLoop');
  inBtn.disabled = loopSel.disabled = !sh;
  $('#drawMotion').title = sh ? '' : 'Select a shape to change its motion — new shapes animate automatically';
  if (!sh) { inBtn.classList.remove('active'); loopSel.innerHTML = '<option>Auto</option>'; return; }
  const m = motionOf(sh), opts = LOOPS[kindOf(sh)] || ['none'];
  inBtn.classList.toggle('active', m.in);
  loopSel.innerHTML = opts.map((o, i) => `<option value="${o}">${LOOP_NAMES[o]}${i === 0 ? ' (auto)' : ''}</option>`).join('');
  loopSel.value = m.loop;
}
function setMotion(patch) {
  if (sel == null || !shapes[sel]) return;
  snap();
  shapes[sel].anim = { ...shapes[sel].anim, ...patch };
  t0 = now();   // replay so the change is visible straight away
  redraw();
}
$('#drawIn').onclick = () => { const sh = shapes[sel]; if (sh) setMotion({ in: !motionOf(sh).in }); };
$('#drawLoop').onchange = (e) => setMotion({ loop: e.target.value });
$('#drawPreview').onclick = () => { t0 = now(); redraw(); };
$('#drawUndo').onclick = undo;
$('#drawClear').onclick = () => { if (shapes.length) { snap(); shapes = []; sel = null; redraw(); } };
$('#drawSave').onclick = save;
$('#drawDelete').onclick = remove;
$('#drawClose').onclick = exit;
$('#tDraw').onclick = toggle;
video.addEventListener('loadedmetadata', layout);
new ResizeObserver(layout).observe(wrap);
on('match', () => { exit(); show(null); });
on('goto-drawing', ({ d, edit }) => jumpTo(d, { edit }));
