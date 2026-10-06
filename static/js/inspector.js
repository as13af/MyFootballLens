// Inspector: edit the selected tag (code, team, in/out, player, labels, pitch location, note).
import { S, on, emit, selectedTag, template, buttonFor, codeColor, teamName, teamColor, teamShort,
  halfOf, attacksRight, tagClockStr, isUnsyncedLive } from './state.js';
import { video, seek, playRange } from './player.js';
import { updateTag, deleteTags } from './tags.js';
import { addToPlaylist, exportDialog } from './playlists.js';
import { renderDescriptors } from './codewindow.js';
import { drawPitch, arrow, L, W } from './pitch.js';
import { $, esc, fmtTime, parseTime, debounce, fitCanvas } from './ui.js';
import { cssVar } from './theme.js';

const el = $('#inspector');
let renderedFor = null;

const SHORTCUTS = [
  ['Space', 'Play / pause'], ['← / →', '−5 s / +5 s (Shift: 1 s)'], [', / .', 'Frame back / forward'],
  ['[ / ]', 'Slower / faster'], ['Letter', 'Tag for team A'], ['Shift+Letter', 'Tag for team B'],
  ['0–9', 'Descriptor on selected tag'], ['Enter', 'Play selected clip'], ['PgUp / PgDn', 'Previous / next tag'],
  ['Del', 'Delete selected tag'], ['`', 'Draw on frame'], ['Esc', 'Deselect / stop'],
];

export function shortcutsHtml() {
  return `<div class="shortcuts">${SHORTCUTS.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`;
}

function render() {
  const t = selectedTag();
  // Don't rebuild while the user types in the note box of the same tag.
  if (t && renderedFor === t.id && el.contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) {
    drawLocation(t);
    return;
  }
  renderedFor = t?.id ?? null;
  if (!t) {
    el.innerHTML = `<div class="pane-head"><h3>Inspector</h3></div>
      <p class="muted small" style="margin-top:0">Press a code button (or its key) to tag. The new tag is selected here so you can add a player, location, labels and a note.</p>
      ${shortcutsHtml()}`;
    return;
  }
  const btn = buttonFor(t.code);
  const codes = [...new Set([...template().buttons.map((b) => b.code), t.code])];
  const players = (S.match.players || []).filter((p) => !t.team || p.team === t.team);
  const dur = t.end != null ? `${(t.end - t.start).toFixed(1)} s` : 'open';
  const live = isUnsyncedLive(t);
  // Labels that aren't descriptors of this template (e.g. imported from XML) get their own removable chips.
  const known = new Set(template().descriptors.map((d) => `${d.grp}|${d.label}`));
  const extra = t.labels.map((l, i) => ({ l, i })).filter(({ l }) => !known.has(`${l.grp}|${l.label}`));
  el.innerHTML = `
    <div class="insp-head">
      <span class="sw" style="background:${esc(codeColor(t.code))};width:12px;height:12px"></span>
      <select id="iCode">${codes.map((c) => `<option ${c === t.code ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <div class="seg" id="iTeam">${['A', 'B', ''].map((k) => `<button data-team="${k}" class="${(t.team || '') === k ? 'active' : ''}"
        ${k ? `style="color:${esc(teamColor(k))}"` : ''} title="${esc(k ? teamName(k) : 'Neutral')}">${k ? esc(teamShort(k)) : '–'}</button>`).join('')}</div>
    </div>
    <div class="field">
      <div class="pitch-box ${btn?.loc && t.x == null ? 'wanted' : ''}" id="iPitchBox"><canvas id="iPitch"></canvas></div>
      <div class="pitch-hint"><span id="iPitchHint"></span><button class="ghost small" id="iLocClear">Clear</button></div>
    </div>
    <div class="field"><label>Player</label>
      <div class="chips" id="iPlayers">${players.length ? players.map((p) => `<button class="chip ${p.id === t.player_id ? 'on' : ''}" data-pid="${p.id}"
        title="${esc(p.name || '')}">${esc(p.number || '?')} ${esc((p.name || '').split(' ').slice(-1)[0])}</button>`).join('')
        : `<span class="muted small">No roster — add players in <a href="#" data-open-settings>Match settings</a>.</span>`}</div>
    </div>
    <div class="field"><label>Descriptors <span class="muted">(keys 0–9)</span></label>
      <div id="iDesc"></div>
      ${extra.length ? `<div class="chips" id="iLabels" style="margin-top:4px">${extra.map(({ l, i }) => `<span class="chip ${esc(l.outcome || '')}" title="${esc(l.grp)}">${esc(l.label)}<span class="x" data-li="${i}">✕</span></span>`).join('')}</div>` : ''}
    </div>
    <div class="field"><label>Clip ${live ? '<span class="danger">(live clock — sync in Live tab)</span>' : ''}</label>
      <div class="timebox">
        <button class="small" data-nudge="start" data-d="-1">−1</button><input id="iStart" value="${fmtTime(t.start)}" title="In">
        <button class="small" data-nudge="start" data-d="1">+1</button><span class="muted">→</span>
        <button class="small" data-nudge="end" data-d="-1">−1</button><input id="iEnd" value="${t.end != null ? fmtTime(t.end) : ''}" placeholder="open" title="Out">
        <button class="small" data-nudge="end" data-d="1">+1</button>
      </div>
      <div class="row" style="margin-top:5px">
        <button class="small" id="iSetIn" ${live ? 'disabled' : ''}>In = now</button>
        <button class="small" id="iSetOut" ${live ? 'disabled' : ''}>Out = now</button>
        <button class="small" id="iPlay" ${live || t.end == null ? 'disabled' : ''}>▶ Play</button>
        <span class="muted small">${tagClockStr(t)} · ${halfOf(t)}H · ${dur}</span>
      </div>
    </div>
    <div class="field"><label>Note</label><textarea id="iNote" rows="2" placeholder="Coaching point…">${esc(t.note || '')}</textarea></div>
    <div class="row">
      <select id="iPl"><option value="">+ Add to playlist…</option>${S.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}<option value="new">New playlist…</option></select>
      <button class="small" id="iExport" ${live || t.end == null ? 'disabled' : ''}>Export clip</button>
      <span class="spacer"></span>
      <button class="ghost small danger" id="iDel">Delete</button>
    </div>`;
  wire(t);
  drawLocation(t);
}

function wire(t) {
  $('#iCode').onchange = (e) => updateTag(t.id, { code: e.target.value });
  $('#iTeam').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) updateTag(t.id, { team: b.dataset.team || null, player_id: null });
  };
  const setTime = (field, val) => {
    const v = parseTime(val);
    if (v == null) { render(); return; }
    const patch = { [field]: Math.max(0, v) };
    const s = field === 'start' ? patch.start : t.start, e = field === 'end' ? patch.end : t.end;
    if (e != null && e <= s) { render(); return; }
    updateTag(t.id, patch);
  };
  $('#iStart').onchange = (e) => setTime('start', e.target.value);
  $('#iEnd').onchange = (e) => setTime('end', e.target.value);
  el.querySelectorAll('[data-nudge]').forEach((b) => (b.onclick = () => {
    const f = b.dataset.nudge, d = +b.dataset.d;
    if (f === 'end' && t.end == null) return;
    const v = t[f] + d;
    if (f === 'start' && (v < 0 || (t.end != null && v >= t.end))) return;
    if (f === 'end' && v <= t.start) return;
    updateTag(t.id, { [f]: v });
    seek(v);
  }));
  $('#iSetIn').onclick = () => { const v = video.currentTime; if (t.end == null || v < t.end) updateTag(t.id, { start: v }); };
  $('#iSetOut').onclick = () => { const v = video.currentTime; if (v > t.start) updateTag(t.id, { end: v }); };
  $('#iPlay').onclick = () => playRange(t.start, t.end);
  $('#iPlayers').onclick = (e) => {
    const b = e.target.closest('[data-pid]');
    if (b) updateTag(t.id, { player_id: +b.dataset.pid === t.player_id ? null : +b.dataset.pid });
  };
  renderDescriptors($('#iDesc'));
  if ($('#iLabels')) $('#iLabels').onclick = (e) => {
    const x = e.target.closest('[data-li]');
    if (x) updateTag(t.id, { labels: t.labels.filter((_, i) => i !== +x.dataset.li) });
  };
  const saveNote = debounce((v) => updateTag(t.id, { note: v }), 450);
  $('#iNote').oninput = (e) => saveNote(e.target.value);
  $('#iLocClear').onclick = () => updateTag(t.id, { x: null, y: null, x2: null, y2: null });
  $('#iPl').onchange = async (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v) await addToPlaylist(v === 'new' ? null : +v, [t.id]);
  };
  $('#iExport').onclick = () => exportDialog([t.id], `${t.code} ${tagClockStr(t).replace(':', 'm')}`);
  $('#iDel').onclick = () => deleteTags([t.id]);
  $('#iPitch').onclick = (e) => pitchClick(t, e);
}

// ---- location: drawn in camera orientation, stored normalised (team attacks → x=105) ----
let pitchMap = null;

function camFlip(t) {
  return t.team ? !attacksRight(t.team, halfOf(t)) : false;
}
const flip = (x, y) => [L - x, W - y];

function drawLocation(t) {
  const c = $('#iPitch');
  if (!c) return;
  const w = c.parentElement.clientWidth || 300, h = Math.round(w * (W + 8) / (L + 8));
  const { ctx } = fitCanvas(c, w, h);
  ctx.fillStyle = cssVar('--panel'); ctx.fillRect(0, 0, w, h);
  const pad = w * 4 / (L + 8);
  pitchMap = drawPitch(ctx, pad, pad, w - pad * 2, h - pad * 2);
  const fl = camFlip(t);
  // attacking direction
  if (t.team) {
    const right = !fl;
    ctx.fillStyle = ctx.strokeStyle = teamColor(t.team);
    ctx.lineWidth = 2;
    const y = pad * 0.5 + 1, xa = w * 0.38, xb = w * 0.62;
    right ? arrow(ctx, xa, y, xb, y, 6) : arrow(ctx, xb, y, xa, y, 6);
  }
  const hint = $('#iPitchHint');
  const btn = buttonFor(t.code);
  if (t.x != null) {
    const [cx, cy] = fl ? flip(t.x, t.y) : [t.x, t.y];
    const [px, py] = pitchMap.toPx(cx, cy);
    const col = t.team ? teamColor(t.team) : '#fff';
    if (t.x2 != null) {
      const [cx2, cy2] = fl ? flip(t.x2, t.y2) : [t.x2, t.y2];
      const [px2, py2] = pitchMap.toPx(cx2, cy2);
      ctx.strokeStyle = ctx.fillStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      arrow(ctx, px, py, px2, py2, 8); ctx.setLineDash([]);
    }
    ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    hint.textContent = btn?.loc_end && t.x2 == null ? 'Click again for the end point' : 'Click to move · Shift+click sets end point';
  } else {
    hint.textContent = t.team ? `${teamName(t.team)} attacks ${fl ? '←' : '→'} · click where it happened` : 'Click where it happened';
  }
}

function pitchClick(t, e) {
  if (!pitchMap) return;
  const r = e.currentTarget.getBoundingClientRect();
  let [x, y] = pitchMap.toM(e.clientX - r.left, e.clientY - r.top);
  if (camFlip(t)) [x, y] = flip(x, y);
  x = Math.round(x * 10) / 10; y = Math.round(y * 10) / 10;
  const btn = buttonFor(t.code);
  const wantsEnd = e.shiftKey || (btn?.loc_end && t.x != null && t.x2 == null);
  updateTag(t.id, wantsEnd && t.x != null ? { x2: x, y2: y } : { x, y, x2: null, y2: null });
}

on('select', ({ seek: doSeek } = {}) => {
  render();
  const t = selectedTag();
  if (doSeek && t && !isUnsyncedLive(t)) seek(t.start);
});
on('tags', render);
on('match', render);
on('theme', () => { const t = selectedTag(); if (t) drawLocation(t); });
on('playlists', () => { if (!el.contains(document.activeElement)) render(); });
new ResizeObserver(() => { const t = selectedTag(); if (t) drawLocation(t); }).observe(el);
