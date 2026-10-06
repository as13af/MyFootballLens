// Stats view: summary tiles, momentum, shot map + xG-lite, heatmap/zones, event matrix, possession, players.
import { api } from './api.js';
import { S, on, emit, teamName, teamColor, codeColor } from './state.js';
import { drawPitch, pitchSvgLines, L, W } from './pitch.js';
import { $, esc, fitCanvas, fmtClock, tip, errToast } from './ui.js';
import { cssVar } from './theme.js';

const el = $('#view-stats');
let data = null, half = 0;
const heat = { team: 'A', code: '', mode: 'heat' };

export async function refresh() {
  if (!S.match) { el.innerHTML = '<div class="stats-wrap"><p class="muted">Create a match first.</p></div>'; return; }
  try {
    data = await api.get(`/api/matches/${S.match.id}/stats?half=${half}`);
    render();
  } catch (e) { errToast(e); }
}

const A = () => esc(teamName('A')), B = () => esc(teamName('B'));
const cA = () => teamColor('A'), cB = () => teamColor('B');

function versus(label, a, b, { fmt = (v) => v, bar = true } = {}) {
  const tot = (+a || 0) + (+b || 0);
  const pa = tot ? (100 * a) / tot : 50;
  return `<div class="card"><h4>${esc(label)}</h4>
    <div class="vs"><span>${fmt(a)}</span><span class="mid">${A()} · ${B()}</span><span>${fmt(b)}</span></div>
    ${bar ? `<div class="bar2" role="img" aria-label="${esc(label)}: ${fmt(a)} vs ${fmt(b)}">
      <div style="width:${pa}%;background:${cA()}"></div><div style="width:${100 - pa}%;background:${cB()}"></div></div>` : ''}</div>`;
}

function render() {
  const d = data;
  const poss = d.toggles.Possession;
  const legend = `<div class="legend"><span><i style="background:${cA()}"></i>${A()}</span><span><i style="background:${cB()}"></i>${B()}</span></div>`;
  const located = [...new Set(d.events.map((e) => e.code))];
  if (heat.code && !located.includes(heat.code)) heat.code = '';
  el.innerHTML = `<div class="stats-wrap">
    <div class="stats-head">
      <h2>${esc(S.match.title)}</h2>
      <div class="seg" id="sHalf">${[[0, 'Full match'], [1, '1st half'], [2, '2nd half']].map(([v, l]) =>
        `<button data-h="${v}" class="${half === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="spacer"></span>
      <span class="muted small">${d.n_tags} tags</span>
      <button id="sCsv" class="ghost">CSV</button>
      <button id="sReport">Open report</button>
    </div>
    <div class="cards">
      ${versus('Goals', d.score.A, d.score.B, { bar: false })}
      ${versus('Shots', d.shots_n.A, d.shots_n.B)}
      ${versus('On target (incl. goals)', d.on_target.A, d.on_target.B)}
      ${versus('xG-lite', d.xg.A, d.xg.B, { fmt: (v) => (+v).toFixed(2) })}
      ${poss && poss.pctA != null ? versus('Possession (from toggle)', poss.pctA, 100 - poss.pctA, { fmt: (v) => v + '%' })
        : `<div class="card"><h4>Possession</h4><p class="muted small">Tag the <b>Possession</b> toggle for both teams to measure it.</p></div>`}
    </div>
    <div class="chart" style="margin-bottom:12px">
      <div class="chart-head"><h3>Momentum — weighted attacking actions per 5 minutes</h3>${legend}</div>
      <div id="sMomentum"></div>
      <p class="muted small" style="margin:6px 0 0">Weights: goal 5 · shot 3 · penalty 3 · chance 2 · corner, cross, attacking transition 1 · free kick 0.5. ${A()} above, ${B()} below.</p>
    </div>
    <div class="grid2">
      <div class="chart">
        <div class="chart-head"><h3>Shot map</h3>
          <div class="legend"><span><i style="background:${cA()}"></i>${A()} →</span><span>← <i style="background:${cB()}"></i>${B()}</span>
          <span><i style="background:var(--text-2)"></i>Goal</span><span><i class="half" style="background:var(--text-2)"></i>On target</span>
          <span><i class="ring" style="border-color:var(--text-2)"></i>Off / blocked</span><span class="muted">size = xG</span></div></div>
        <div id="sShots"></div>
        <p class="muted small" style="margin:6px 0 0">${d.shots.filter((s) => s.x == null).length} shots without location are counted but not drawn.</p>
      </div>
      <div class="chart">
        <div class="chart-head"><h3>Where it happens</h3>
          <select id="hTeam"><option value="A" ${heat.team === 'A' ? 'selected' : ''}>${A()}</option><option value="B" ${heat.team === 'B' ? 'selected' : ''}>${B()}</option></select>
          <select id="hCode"><option value="">All located events</option>${located.map((c) => `<option ${c === heat.code ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <div class="seg" id="hMode">${[['heat', 'Heatmap'], ['zones', '18 zones'], ['thirds', 'Thirds']].map(([v, l]) =>
            `<button data-m="${v}" class="${heat.mode === v ? 'active' : ''}">${l}</button>`).join('')}</div>
        </div>
        <div class="heat-box"><canvas id="hCanvas"></canvas></div>
        <p class="muted small" id="hNote" style="margin:6px 0 0"></p>
      </div>
    </div>
    <div class="grid2">
      <div class="chart"><div class="chart-head"><h3>Event matrix</h3><span class="muted small">click a number to see those clips</span></div>
        <table class="matrix"><thead><tr><th>Event</th><th class="num" style="color:${cA()}">${A()}</th><th class="num">success</th>
          <th class="num" style="color:${cB()}">${B()}</th><th class="num">success</th><th class="num">Neutral</th></tr></thead>
        <tbody>${d.matrix.map((r) => `<tr><td><span class="sw" style="background:${esc(codeColor(r.code))}"></span>${esc(r.code)}</td>
          ${cell(r, 'A')}<td class="num muted">${pct(r.A)}</td>${cell(r, 'B')}<td class="num muted">${pct(r.B)}</td>${cell(r, 'N')}</tr>`).join('')
          || '<tr><td colspan="6" class="muted">No tags yet.</td></tr>'}</tbody></table>
      </div>
      <div class="chart"><div class="chart-head"><h3>Phase time (toggle buttons)</h3>${legend}</div>
        ${Object.keys(d.toggles).length ? `<table><thead><tr><th>Phase</th><th class="num">${A()}</th><th class="num">${B()}</th><th style="width:40%">Share</th></tr></thead><tbody>
          ${Object.entries(d.toggles).map(([code, v]) => `<tr><td>${esc(code)}</td><td class="num">${fmtClock(v.A)}</td><td class="num">${fmtClock(v.B)}</td>
            <td><div class="bar2" style="margin:0"><div style="width:${v.pctA ?? 50}%;background:${cA()}"></div><div style="width:${100 - (v.pctA ?? 50)}%;background:${cB()}"></div></div></td></tr>`).join('')}
          </tbody></table>` : '<p class="muted small">No toggle tags yet.</p>'}
        <h3 style="margin:16px 0 8px">Players</h3>
        ${d.players.length ? `<table><thead><tr><th>Player</th><th class="num">Tags</th><th>Top actions</th></tr></thead><tbody>
          ${d.players.map((p) => `<tr><td><span class="sw" style="background:${esc(teamColor(p.team))}"></span>#${esc(p.number || '')} ${esc(p.name || '')}</td>
            <td class="num">${p.total}</td><td class="wrap">${esc(Object.entries(p.counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · '))}</td></tr>`).join('')}
          </tbody></table>` : '<p class="muted small">Assign players to tags in the inspector to see per-player counts.</p>'}
      </div>
    </div></div>`;
  momentum();
  shotMap();
  drawHeat();
  wire();
}

const pct = (c) => (c.pct != null ? c.pct + '%' : '');
function cell(r, k) {
  const c = r[k];
  return c.n ? `<td class="num clickable" data-code="${esc(r.code)}" data-team="${k}">${c.n}</td>` : '<td class="num muted">·</td>';
}

function momentum() {
  const box = $('#sMomentum');
  if (!data.momentum.length) { box.innerHTML = '<p class="muted small">No attacking actions tagged yet.</p>'; return; }
  // Fixed axis: nine 5-minute slots per half (plus stoppage-time slots when present).
  const have = new Map(data.momentum.map((b) => [`${b.half}|${b.idx}`, b]));
  const halves = half ? [half] : [1, 2];
  const m = [];
  for (const hf of halves) {
    const maxIdx = Math.max(8, ...data.momentum.filter((b) => b.half === hf).map((b) => b.idx));
    for (let i = 0; i <= maxIdx; i++) {
      m.push(have.get(`${hf}|${i}`) || { half: hf, idx: i, A: 0, B: 0, label: `${(hf === 2 ? 45 : 0) + i * 5}'` });
    }
  }
  const bw = 56, gap = 6, h = 70, n = m.length;
  const mx = Math.max(...m.map((b) => Math.max(b.A, b.B)), 1);
  let lastHalf = m[0].half, bars = '';
  m.forEach((b, i) => {
    const x = i * bw;
    if (b.half !== lastHalf) { bars += `<line x1="${x - 1}" y1="0" x2="${x - 1}" y2="${2 * h}" stroke="var(--line-2)" stroke-dasharray="3 3"/>`; lastHalf = b.half; }
    const ha = (h - 4) * b.A / mx, hb = (h - 4) * b.B / mx;
    bars += `<g class="mbar" data-i="${i}"><rect x="${x}" y="0" width="${bw}" height="${2 * h + 14}" fill="transparent"/>
      ${ha ? `<rect x="${x + gap}" y="${h - ha}" width="${bw - gap * 2}" height="${ha}" rx="2" fill="${cA()}"/>` : ''}
      ${hb ? `<rect x="${x + gap}" y="${h + 1}" width="${bw - gap * 2}" height="${hb}" rx="2" fill="${cB()}"/>` : ''}
      <text x="${x + bw / 2}" y="${2 * h + 12}" text-anchor="middle" font-size="10" fill="var(--muted)">${b.label}</text></g>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${n * bw} ${2 * h + 16}" style="width:100%;height:auto;max-height:220px;display:block">
    <line x1="0" y1="${h + 0.5}" x2="${n * bw}" y2="${h + 0.5}" stroke="var(--line-2)"/>${bars}</svg>`;
  box.querySelectorAll('.mbar').forEach((g) => {
    const b = m[+g.dataset.i];
    g.onmousemove = (e) => tip(`<b>${b.half}H · ${b.label}–${parseInt(b.label) + 5}'</b><div>${A()}: ${b.A}</div><div>${B()}: ${b.B}</div>`, e);
    g.onmouseleave = () => tip(null);
  });
}

function shotMap() {
  const marks = data.shots.filter((s) => s.x != null && (s.team === 'A' || s.team === 'B')).map((s) => {
    const [x, y] = s.team === 'A' ? [s.x, s.y] : [L - s.x, W - s.y];
    const r = 0.9 + 3.4 * Math.sqrt(s.xg || 0.02), col = teamColor(s.team);
    const fill = s.outcome === 'goal' ? col : s.outcome === 'on' ? col : 'none';
    const op = s.outcome === 'on' ? 0.45 : 1;
    return `<circle class="mk" data-id="${s.id}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" fill="${fill}" fill-opacity="${op}"
      stroke="${s.outcome === 'goal' ? '#fff' : col}" stroke-width="${s.outcome === 'goal' ? 0.5 : 0.45}"/>`;
  }).join('');
  const box = $('#sShots');
  box.innerHTML = `<svg class="pitchsvg" viewBox="-2 -2 ${L + 4} ${W + 4}"><rect x="-2" y="-2" width="${L + 4}" height="${W + 4}" style="fill:var(--pitch)" rx="1"/>
    ${pitchSvgLines()}${marks}</svg>`;
  box.querySelectorAll('.mk').forEach((c) => {
    const s = data.shots.find((x) => x.id === +c.dataset.id);
    c.onmousemove = (e) => tip(`<b>${esc(s.code)} · ${esc(teamName(s.team))}</b><div>${s.clock}${s.player ? ' · ' + esc(s.player) : ''}</div>
      <div>xG ${s.xg != null ? s.xg.toFixed(2) : '–'} · ${esc({ goal: 'Goal', on: 'On target', off: 'Off target', blocked: 'Blocked' }[s.outcome] || 'No result tagged')}</div>
      <div class="muted">Click to open clip</div>`, e);
    c.onmouseleave = () => tip(null);
    c.onclick = () => emit('goto-tag', s.id);
  });
}

let zoneCells = [];
function drawHeat() {
  const c = $('#hCanvas');
  if (!c) return;
  const evs = data.events.filter((e) => e.team === heat.team && (!heat.code || e.code === heat.code));
  const w = c.parentElement.clientWidth || 500, h = Math.round(w * (W + 8) / (L + 8));
  const { ctx } = fitCanvas(c, w, h);
  ctx.fillStyle = cssVar('--panel'); ctx.fillRect(0, 0, w, h);
  const pad = (w * 4) / (L + 8), pw = w - pad * 2, ph = h - pad * 2;
  const map = drawPitch(ctx, pad, pad, pw, ph, { grass: cssVar('--pitch'), line: 'rgba(255,255,255,.0)' });
  const col = teamColor(heat.team);
  const rgb = hexRgb(col);
  zoneCells = [];
  if (heat.mode === 'heat') {
    // Gaussian splat on a 1 m grid, single-hue sequential ramp (team colour, alpha = density).
    const G = new Float32Array(L * W), sig = 5.5, R = 14;
    for (const e of evs) {
      for (let gx = Math.max(0, Math.floor(e.x - R)); gx < Math.min(L, e.x + R); gx++) {
        for (let gy = Math.max(0, Math.floor(e.y - R)); gy < Math.min(W, e.y + R); gy++) {
          const d2 = (gx + 0.5 - e.x) ** 2 + (gy + 0.5 - e.y) ** 2;
          G[gy * L + gx] += Math.exp(-d2 / (2 * sig * sig));
        }
      }
    }
    let mx = 0; for (const v of G) if (v > mx) mx = v;
    if (mx > 0) {
      const cw = pw / L, ch = ph / W;
      for (let gy = 0; gy < W; gy++) for (let gx = 0; gx < L; gx++) {
        const v = G[gy * L + gx] / mx;
        if (v < 0.04) continue;
        ctx.fillStyle = `rgba(${rgb},${(0.08 + 0.8 * v).toFixed(3)})`;
        ctx.fillRect(pad + gx * cw, pad + gy * ch, cw + 0.6, ch + 0.6);
      }
    }
  } else {
    const cols = heat.mode === 'zones' ? 6 : 3, rws = heat.mode === 'zones' ? 3 : 1;
    const grid = Array.from({ length: rws }, () => new Array(cols).fill(0));
    for (const e of evs) grid[Math.min(rws - 1, Math.floor(e.y / (W / rws)))][Math.min(cols - 1, Math.floor(e.x / (L / cols)))]++;
    const mx = Math.max(1, ...grid.flat()), tot = evs.length || 1;
    const zw = pw / cols, zh = ph / rws;
    ctx.font = `600 ${Math.max(11, zw / 6)}px 'Inter', system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = 0; r < rws; r++) for (let k = 0; k < cols; k++) {
      const v = grid[r][k], x = pad + k * zw, y = pad + r * zh;
      ctx.fillStyle = `rgba(${rgb},${(0.06 + 0.72 * v / mx).toFixed(3)})`;
      ctx.fillRect(x + 1, y + 1, zw - 2, zh - 2);  // 2px surface gap between zones
      if (v) {
        ctx.fillStyle = '#fff';
        ctx.fillText(`${v}`, x + zw / 2, y + zh / 2 - 7);
        ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = `${Math.max(10, zw / 8)}px 'Inter', system-ui, sans-serif`;
        ctx.fillText(`${Math.round(100 * v / tot)}%`, x + zw / 2, y + zh / 2 + 10);
        ctx.font = `600 ${Math.max(11, zw / 6)}px 'Inter', system-ui, sans-serif`;
      }
      zoneCells.push({ x, y, w: zw, h: zh, v, pct: Math.round(100 * v / tot) });
    }
    ctx.textAlign = 'start';
  }
  drawPitch(ctx, pad, pad, pw, ph, { grass: 'rgba(0,0,0,0)', stripes: false });
  ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = "11px 'Inter', system-ui, sans-serif";
  ctx.fillText(`${teamName(heat.team)} attacking →`, pad + 4, pad * 0.62);
  $('#hNote').textContent = `${evs.length} located event${evs.length === 1 ? '' : 's'}${heat.code ? ` (${heat.code})` : ''} · always shown attacking left → right.`;
  c.onmousemove = (e) => {
    if (heat.mode === 'heat') return;
    const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const z = zoneCells.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
    tip(z ? `<b>${z.v} event${z.v === 1 ? '' : 's'}</b><div>${z.pct}% of ${evs.length}</div>` : null, e);
  };
  c.onmouseleave = () => tip(null);
}

function hexRgb(hex) {
  const n = parseInt((hex || '#888888').slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function wire() {
  $('#sHalf').onclick = (e) => { const b = e.target.closest('[data-h]'); if (b) { half = +b.dataset.h; refresh(); } };
  $('#sCsv').onclick = () => (location.href = `/api/matches/${S.match.id}/export.csv`);
  $('#sReport').onclick = () => window.open(`/report/${S.match.id}${half ? '?half=' + half : ''}`, '_blank');
  $('#hTeam').onchange = (e) => { heat.team = e.target.value; drawHeat(); };
  $('#hCode').onchange = (e) => { heat.code = e.target.value; drawHeat(); };
  $('#hMode').onclick = (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    heat.mode = b.dataset.m;
    el.querySelectorAll('#hMode button').forEach((x) => x.classList.toggle('active', x === b));
    drawHeat();
  };
  el.querySelector('.matrix tbody').onclick = (e) => {
    const td = e.target.closest('[data-code]');
    if (!td) return;
    S.filters = { team: td.dataset.team, code: td.dataset.code, player: '', text: '' };
    emit('filters');
    emit('goto-view', 'tag');
  };
}

let ro;
on('view', (v) => {
  if (v === 'stats') refresh();
  if (!ro) { ro = new ResizeObserver(() => { if (S.view === 'stats' && data) drawHeat(); }); ro.observe(el); }
});
on('match', () => { half = 0; if (S.view === 'stats') refresh(); });
on('theme', () => { if (S.view === 'stats' && data) render(); });
