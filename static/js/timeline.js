// Canvas timeline: one row per event × team. Tags are drawn on one static canvas that is
// redrawn only when something changes; the playhead is a CSS-positioned div (no redraw per frame).
import { S, on, emit, filteredTags, template, codeColor, teamColor, teamShort, tagById, playerById, playerLabel, tagClockStr } from './state.js';
import { video, seek, playRange, onTick } from './player.js';
import { updateTag, select } from './tags.js';
import { $, esc, fitCanvas, fmtTime, tip } from './ui.js';
import { cssVar } from './theme.js';

const FONT = "'Inter', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const LABEL_W = 150, ROW_H = 20, RULER_H = 24, EDGE = 5;
const panel = $('#panel-timeline'), ruler = $('#tlRuler'), scroll = $('#tlScroll'), canvas = $('#tlCanvas');
const view = { t0: 0, pps: 0.25 };
let rows = [];
let drag = null;
let pending = 0;

const head = document.createElement('div');
head.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:#ff4d4f;pointer-events:none;z-index:2;box-shadow:0 0 0 1px #0006';
panel.style.position = 'relative';
panel.append(head);

const timelineDuration = () => Math.max(S.duration || 0, ...S.tags.map((t) => t.end ?? t.start), 60);
const plotW = () => Math.max(50, scroll.clientWidth - LABEL_W);
const xOf = (t) => LABEL_W + (t - view.t0) * view.pps;
const tOf = (x) => view.t0 + (x - LABEL_W) / view.pps;

export function requestDraw() {
  if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); });
}

export function fit() {
  view.t0 = 0;
  view.pps = plotW() / timelineDuration();
  requestDraw();
}

function zoomAt(x, factor) {
  const t = tOf(Math.max(LABEL_W, x));
  const minPps = plotW() / timelineDuration() / 1.2;
  view.pps = Math.max(minPps, Math.min(250, view.pps * factor));
  view.t0 = t - (Math.max(LABEL_W, x) - LABEL_W) / view.pps;
  clampView();
  requestDraw();
}

function clampView() {
  const maxT0 = Math.max(0, timelineDuration() - plotW() / view.pps * 0.5);
  view.t0 = Math.max(0, Math.min(view.t0, maxT0));
}

function buildRows() {
  const order = new Map(template().buttons.map((b, i) => [b.code, i]));
  const map = new Map();
  for (const t of filteredTags()) {
    const key = `${t.code}|${t.team || 'N'}`;
    if (!map.has(key)) map.set(key, { key, code: t.code, team: t.team, tags: [] });
    map.get(key).tags.push(t);
  }
  const teamOrder = { A: 0, B: 1, N: 2 };
  rows = [...map.values()].sort((a, b) =>
    (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999) || a.code.localeCompare(b.code) ||
    teamOrder[a.team || 'N'] - teamOrder[b.team || 'N']);
}

function tickStep() {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  return steps.find((s) => s * view.pps >= 70) || 3600;
}

function draw() {
  buildRows();
  const W = scroll.clientWidth;
  if (!W) return;
  const curT = video.currentTime || 0;

  // theme colours (canvas can't use CSS variables directly)
  const c = {
    panel: cssVar('--panel'), stripe: cssVar('--stripe'), line: cssVar('--line'), line2: cssVar('--line-2'),
    text: cssVar('--text'), text2: cssVar('--text-2'), muted: cssVar('--muted'),
    accent: cssVar('--accent'), accentInk: cssVar('--accent-ink'), sand: cssVar('--sand'),
  };

  // ---- ruler ----
  const r = fitCanvas(ruler, W, RULER_H);
  const rc = r.ctx;
  rc.fillStyle = c.panel; rc.fillRect(0, 0, W, RULER_H);
  rc.fillStyle = c.line; rc.fillRect(0, RULER_H - 1, W, 1);
  rc.fillStyle = c.muted; rc.font = `10.5px ${FONT}`; rc.textBaseline = 'middle';
  rc.fillText(rows.length ? `${rows.length} rows · ${filteredTags().length} tags` : 'No tags yet', 8, RULER_H / 2);
  const step = tickStep(), tEnd = tOf(W);
  rc.strokeStyle = c.line2;
  rc.font = `10.5px ${MONO}`;   // times in mono so they don't shift
  for (let t = Math.ceil(view.t0 / step) * step; t <= tEnd; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    rc.beginPath(); rc.moveTo(x, RULER_H - 7); rc.lineTo(x, RULER_H); rc.stroke();
    rc.fillStyle = c.text2;
    rc.fillText(fmtTime(t, false), x + 3, RULER_H / 2 - 1);
  }
  const marks = [[S.match?.half1_start, '1H'], [S.match?.half2_start, '2H']];
  for (const [t, label] of marks) {
    if (t == null || (label === '1H' && !t)) continue;
    const x = xOf(t);
    if (x < LABEL_W || x > W) continue;
    rc.fillStyle = c.accent; rc.fillRect(x - 1, 0, 2, RULER_H);
    // label on its own chip so it stays readable over tick labels
    rc.fillRect(x + 1, 2, 20, 13);
    rc.fillStyle = c.accentInk; rc.font = `bold 10px ${FONT}`; rc.fillText(label, x + 4, 9); rc.font = `10.5px ${FONT}`;
  }
  rc.fillStyle = c.sand;
  for (const d of S.drawings) {
    const x = xOf(d.t);
    if (x < LABEL_W || x > W) continue;
    rc.beginPath(); rc.moveTo(x - 5, RULER_H - 11); rc.lineTo(x + 5, RULER_H - 11); rc.lineTo(x, RULER_H - 1); rc.fill();
  }

  // ---- rows ----
  const H = Math.max(rows.length * ROW_H, scroll.clientHeight - 1, 1);
  const { ctx } = fitCanvas(canvas, W, H);
  ctx.fillStyle = c.panel; ctx.fillRect(0, 0, W, H);
  ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle';
  // grid
  ctx.strokeStyle = c.line;
  for (let t = Math.ceil(view.t0 / step) * step; t <= tEnd; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  rows.forEach((row, i) => {
    const y = i * ROW_H;
    if (i % 2) { ctx.fillStyle = c.stripe; ctx.fillRect(LABEL_W, y, W - LABEL_W, ROW_H); }
    const color = codeColor(row.code);
    ctx.save();
    ctx.beginPath(); ctx.rect(LABEL_W, y, W - LABEL_W, ROW_H); ctx.clip();
    for (const t of row.tags) {
      const x1 = xOf(t.start), end = t.end ?? curT, x2 = Math.max(x1 + 3, xOf(end));
      if (x2 < LABEL_W || x1 > W) continue;
      ctx.fillStyle = color;
      ctx.globalAlpha = t.id === S.selectedId ? 1 : 0.82;
      roundRect(ctx, x1, y + 3, x2 - x1, ROW_H - 6, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (t.end == null) { ctx.setLineDash([3, 3]); ctx.strokeStyle = c.text; ctx.strokeRect(x1 + .5, y + 3.5, x2 - x1 - 1, ROW_H - 7); ctx.setLineDash([]); }
      if (t.id === S.selectedId) { ctx.strokeStyle = c.text; ctx.lineWidth = 2; roundRect(ctx, x1, y + 2, x2 - x1, ROW_H - 4, 2); ctx.stroke(); ctx.lineWidth = 1; }
      if (S.checked.has(t.id)) { ctx.fillStyle = c.text; ctx.fillRect(x1 + 2, y + ROW_H - 6, 4, 2); }
      if (x2 - x1 > 46) {
        const p = playerById(t.player_id);
        const txt = [p ? '#' + p.number : '', t.labels.map((l) => l.label).join(' · ')].filter(Boolean).join(' ');
        if (txt) { ctx.fillStyle = '#1a2236'; ctx.fillText(txt, x1 + 4, y + ROW_H / 2, x2 - x1 - 8); }
      }
    }
    ctx.restore();
    // label column
    ctx.fillStyle = c.panel; ctx.fillRect(0, y, LABEL_W, ROW_H);
    ctx.fillStyle = color; ctx.fillRect(0, y + 2, 3, ROW_H - 4);
    if (row.team) { ctx.fillStyle = teamColor(row.team); ctx.fillRect(LABEL_W - 34, y + 5, 3, ROW_H - 10); }
    ctx.fillStyle = c.text; ctx.fillText(row.code, 9, y + ROW_H / 2, LABEL_W - 56);
    ctx.fillStyle = c.muted; ctx.fillText(row.team ? teamShort(row.team) : '', LABEL_W - 28, y + ROW_H / 2, 26);
    ctx.fillStyle = c.muted; ctx.fillText(String(row.tags.length), LABEL_W - 52, y + ROW_H / 2);
  });
  ctx.fillStyle = c.line; ctx.fillRect(LABEL_W - 1, 0, 1, H);
  placeHead(curT);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, Math.min(r, w / 2)) : ctx.rect(x, y, w, h);
}

function placeHead(t) {
  const x = xOf(t);
  head.style.display = x < LABEL_W || x > scroll.clientWidth ? 'none' : '';
  head.style.transform = `translateX(${x - 1}px)`;
}

// Follow the playhead while playing; open toggles get redrawn twice a second.
let lastOpenDraw = 0;
onTick((t) => {
  const span = plotW() / view.pps;
  if (!video.paused && (t > view.t0 + span * 0.94 || t < view.t0)) { view.t0 = Math.max(0, t - span * 0.08); requestDraw(); }
  else if (video.paused && (t < view.t0 || t > view.t0 + span)) { view.t0 = Math.max(0, t - span * 0.3); requestDraw(); }
  if (S.openToggles.size && performance.now() - lastOpenDraw > 500) { lastOpenDraw = performance.now(); requestDraw(); }
  placeHead(t);
});

// ---- hit testing ----
function hitTest(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const row = rows[Math.floor(y / ROW_H)];
  if (!row || x < LABEL_W) return { x, y, row: row || null };
  const curT = video.currentTime || 0;
  let best = null;
  for (const t of row.tags) {
    const x1 = xOf(t.start), x2 = Math.max(x1 + 3, xOf(t.end ?? curT));
    if (x >= x1 - 2 && x <= x2 + 2) {
      let edge = null;
      if (x2 - x1 >= 12 && t.end != null) edge = Math.abs(x - x1) <= EDGE ? 'start' : Math.abs(x - x2) <= EDGE ? 'end' : null;
      if (!best || edge) best = { tag: t, edge };
    }
  }
  return { x, y, row, ...best };
}

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const h = hitTest(ev);
  if (h.x < LABEL_W) {
    if (h.row) { S.filters.code = h.row.code; S.filters.team = h.row.team || 'N'; emit('filters'); }
    return;
  }
  if (h.tag) {
    drag = { mode: h.edge || 'move', tag: h.tag, x0: ev.clientX, s0: h.tag.start, e0: h.tag.end, moved: false };
  } else {
    drag = { mode: 'pan', x0: ev.clientX, t00: view.t0, moved: false };
  }
  ev.preventDefault();
});

window.addEventListener('mousemove', (ev) => {
  if (!drag) {
    if (ev.target === canvas) hover(ev);
    return;
  }
  const dx = ev.clientX - drag.x0;
  if (Math.abs(dx) > 3) drag.moved = true;
  if (!drag.moved) return;
  const dt = dx / view.pps;
  const t = drag.tag;
  if (drag.mode === 'pan') { view.t0 = drag.t00 - dt; clampView(); }
  else if (drag.mode === 'start') t.start = Math.max(0, Math.min(drag.s0 + dt, t.end - 0.2));
  else if (drag.mode === 'end') t.end = Math.max(t.start + 0.2, drag.e0 + dt);
  else if (drag.mode === 'move') {
    const d = Math.max(-drag.s0, dt);
    t.start = drag.s0 + d;
    if (drag.e0 != null) t.end = drag.e0 + d;
  }
  if (drag.mode !== 'pan') tip(`<b>${fmtTime(t.start)}</b> → <b>${fmtTime(t.end)}</b>`, ev);
  requestDraw();
});

window.addEventListener('mouseup', (ev) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  tip(null);
  if (d.mode === 'pan') {
    if (!d.moved) seek(tOf(ev.clientX - canvas.getBoundingClientRect().left));
    return;
  }
  if (d.moved) {
    updateTag(d.tag.id, { start: d.tag.start, end: d.tag.end });
  } else {
    select(d.tag.id);
    seek(d.tag.start);
  }
});

canvas.addEventListener('dblclick', (ev) => {
  const h = hitTest(ev);
  if (h.tag && h.tag.end != null) playRange(h.tag.start, h.tag.end);
});

canvas.addEventListener('mouseleave', () => tip(null));

function hover(ev) {
  const h = hitTest(ev);
  canvas.style.cursor = h.edge ? 'ew-resize' : h.tag ? 'pointer' : h.x < LABEL_W ? 'pointer' : 'grab';
  if (!h.tag) { tip(h.x < LABEL_W && h.row ? 'Click to filter to this row' : null, ev); return; }
  const t = h.tag, p = playerById(t.player_id);
  tip(`<b>${esc(t.code)}</b> <span class="muted">${esc(t.team ? teamShort(t.team) : '')}</span>
    <div>${tagClockStr(t)} · ${t.end != null ? (t.end - t.start).toFixed(1) + 's' : 'open'}</div>
    ${p ? `<div>${esc(playerLabel(p))}</div>` : ''}
    ${t.labels.length ? `<div>${esc(t.labels.map((l) => l.label).join(', '))}</div>` : ''}
    ${t.note ? `<div>“${esc(t.note.slice(0, 80))}”</div>` : ''}`, ev);
}

// ---- ruler: click a drawing marker to jump exactly to it; otherwise click/drag to scrub, wheel to zoom ----
function drawingNear(ev) {
  const x = ev.clientX - ruler.getBoundingClientRect().left;
  let best = null, bestDx = 7;
  for (const d of S.drawings) {
    const dx = Math.abs(xOf(d.t) - x);
    if (dx < bestDx) { best = d; bestDx = dx; }
  }
  return best;
}

/** Green 1H / 2H kick-off marker under the pointer (the 1H marker is only drawn when it isn't at 0:00). */
function halfNear(ev) {
  const x = ev.clientX - ruler.getBoundingClientRect().left;
  const marks = [[S.match?.half1_start, '1st'], [S.match?.half2_start, '2nd']];
  return marks.find(([t, h]) => t != null && (h === '2nd' || t > 0) && Math.abs(xOf(t) - x) < 7) || null;
}

ruler.addEventListener('mousemove', (ev) => {
  const d = drawingNear(ev), h = !d && halfNear(ev);
  ruler.style.cursor = d || h ? 'pointer' : 'col-resize';
  tip(d ? `<b>✎ Drawing at ${fmtTime(d.t)}</b><div>${JSON.parse(d.shapes || '[]').length} shapes · holds ${d.hold}s</div><div class="muted">Click to view · double-click to edit</div>`
    : h ? `<b>${h[1]}-half kick-off</b><div>${fmtTime(h[0])} · click to jump here</div>` : null, ev);
});
ruler.addEventListener('mouseleave', () => tip(null));
ruler.addEventListener('dblclick', (ev) => {
  const d = drawingNear(ev);
  if (d) emit('goto-drawing', { d, edit: true });
});

ruler.addEventListener('mousedown', (ev) => {
  const d = drawingNear(ev);
  if (d) { emit('goto-drawing', { d }); return; }
  const h = halfNear(ev);
  if (h) { seek(h[0]); return; }
  const scrub = (e) => seek(tOf(e.clientX - ruler.getBoundingClientRect().left));
  scrub(ev);
  const up = () => { window.removeEventListener('mousemove', scrub); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', scrub);
  window.addEventListener('mouseup', up);
});

function onWheel(ev) {
  const x = ev.clientX - canvas.getBoundingClientRect().left;
  if (ev.ctrlKey || ev.currentTarget === ruler) {
    ev.preventDefault();
    zoomAt(x, ev.deltaY < 0 ? 1.25 : 0.8);
  } else if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    ev.preventDefault();
    view.t0 += (ev.deltaX || ev.deltaY) / view.pps;
    clampView();
    requestDraw();
  }
}
canvas.addEventListener('wheel', onWheel, { passive: false });
ruler.addEventListener('wheel', onWheel, { passive: false });

$('#tlZoom').onclick = (e) => {
  const z = e.target.closest('button')?.dataset.z;
  const cx = LABEL_W + plotW() / 2;
  if (z === 'fit') fit();
  else if (z === 'in') zoomAt(xOf(video.currentTime || 0) > LABEL_W ? xOf(video.currentTime) : cx, 1.6);
  else if (z === 'out') zoomAt(cx, 0.625);
};

new ResizeObserver(() => requestDraw()).observe(scroll);
['tags', 'select', 'filters', 'drawings', 'theme'].forEach((ev) => on(ev, requestDraw));
on('duration', fit);
on('match', fit);
