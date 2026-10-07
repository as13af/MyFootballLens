// Live mode: tag against a match clock during the game, sync to the video later.
// Live tags store seconds since their half's kick-off until synced.
import { api } from './api.js';
import { S, on, emit, codeColor, teamColor, teamShort, isUnsyncedLive } from './state.js';
import { renderCodeWindow, updateToggleStates, renderDescriptors, updateDescriptorStates, markCurrent } from './codewindow.js';
import { loadTags, select, deleteTags } from './tags.js';
import { video } from './player.js';
import { $, esc, fmtClock, fmtTime, parseTime, toast, errToast } from './ui.js';

const el = $('#view-live');
let st = { running: false, half: 1, base: 0, startedAt: 0 };
let timer = 0;

const key = () => `vat-live-${S.match?.id}`;
const now = () => (st.running ? st.base + (Date.now() - st.startedAt) / 1000 : st.base);

function persist() {
  try { localStorage.setItem(key(), JSON.stringify(st)); } catch { /* storage unavailable */ }
}
function restore() {
  st = { running: false, half: 1, base: 0, startedAt: 0 };
  try { Object.assign(st, JSON.parse(localStorage.getItem(key()) || '{}')); } catch { /* ignore */ }
}

export function liveNow() {
  return { t: now(), live: true, half: st.half };
}

export function toggleClock() {
  if (st.running) { st.base = now(); st.running = false; }
  else { st.startedAt = Date.now(); st.running = true; }
  persist();
  paintClock();
}

function setHalf(h) {
  st = { running: false, half: h, base: 0, startedAt: 0 };
  persist();
  paintClock();
}

function adjust(d) {
  st.base = Math.max(0, now() + d);
  if (st.running) st.startedAt = Date.now();
  persist();
  paintClock();
}

function paintClock() {
  const c = $('#lClock');
  if (!c) return;
  c.textContent = fmtClock((st.half === 2 ? 2700 : 0) + now());
  c.classList.toggle('running', st.running);
  $('#lStart').textContent = st.running ? '❚❚ Pause' : '▶ Start';
  $('#lHalf1').classList.toggle('active', st.half === 1);
  $('#lHalf2').classList.toggle('active', st.half === 2);
  clearInterval(timer);
  if (st.running && S.view === 'live') timer = setInterval(() => { $('#lClock').textContent = fmtClock((st.half === 2 ? 2700 : 0) + now()); }, 250);
}

function render() {
  if (!S.match) { el.innerHTML = '<div class="live-main"><p class="muted">Create a match first.</p></div>'; return; }
  restore();
  el.innerHTML = `
    <div class="live-clock">
      <div id="lClock" class="big">00:00</div>
      <button id="lStart" class="primary" style="min-width:110px">▶ Start</button>
      <div class="seg"><button id="lHalf1">1st half</button><button id="lHalf2">2nd half</button></div>
      <div class="seg">${[-10, -1, 1, 10].map((d) => `<button data-adj="${d}">${d > 0 ? '+' : ''}${d}s</button>`).join('')}</div>
      <span class="muted small">Space = start/pause · letters tag ${esc(teamShort('A'))} · Shift+letter tags ${esc(teamShort('B'))}</span>
    </div>
    <div class="live-main"><div id="lCodes" class="code-grid big"></div>
      <div class="pane-head"><h3>Descriptors</h3><span class="muted small">apply to the selected tag</span></div>
      <div id="lDesc"></div></div>
    <aside class="live-side">
      <h3>Recent live tags</h3>
      <div class="recent" id="lRecent"></div>
      <div class="sync-box" id="lSync"></div>
    </aside>`;
  renderCodeWindow($('#lCodes'), liveNow, { big: true });
  renderDescriptors($('#lDesc'));
  $('#lStart').onclick = toggleClock;
  $('#lHalf1').onclick = () => confirmHalf(1);
  $('#lHalf2').onclick = () => confirmHalf(2);
  el.querySelector('.live-clock').addEventListener('click', (e) => { const b = e.target.closest('[data-adj]'); if (b) adjust(+b.dataset.adj); });
  paintClock();
  renderRecent();
  renderSync();
}

function confirmHalf(h) {
  if (st.half === h) return;
  if (st.running && !confirm(`Switch to the ${h === 1 ? '1st' : '2nd'} half? The clock resets to ${h === 1 ? '00:00' : '45:00'}.`)) return;
  setHalf(h);
}

function renderRecent() {
  const box = $('#lRecent');
  if (!box) return;
  const live = S.tags.filter((t) => t.source === 'live').sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 40);
  box.innerHTML = live.map((t) => {
    const clock = isUnsyncedLive(t) ? (t.live_half === 2 ? 2700 : 0) + t.start : null;
    return `<div class="r ${t.id === S.selectedId ? 'sel' : ''}" data-id="${t.id}">
      <span class="mono muted">${clock != null ? fmtClock(clock) : 'synced'}</span>
      <span class="sw" style="background:${esc(codeColor(t.code))}"></span><span>${esc(t.code)}</span>
      <span style="color:${esc(teamColor(t.team))}">${t.team ? esc(teamShort(t.team)) : ''}</span>
      <span class="muted small" style="flex:1">${esc(t.labels.map((l) => l.label).join(', '))}${t.end == null ? ' (running)' : ''}</span>
      <button class="ghost small" data-del="${t.id}" title="Delete">✕</button></div>`;
  }).join('') || '<p class="muted small">Start the clock and press a button. Tags are saved instantly.</p>';
  box.onclick = (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { deleteTags([+d.dataset.del]); return; }
    const r = e.target.closest('[data-id]');
    if (r) select(+r.dataset.id);
  };
}

function renderSync() {
  const box = $('#lSync');
  if (!box) return;
  const n = S.tags.filter(isUnsyncedLive).length;
  const m = S.match;
  box.innerHTML = `<h3>Sync to video</h3>
    <p class="muted small">${n} live tag${n === 1 ? '' : 's'} not yet on the video timeline. Once the match video is linked,
      enter where each kick-off happens in the video (scrub to it in the Tag view, then press “Use current”).</p>
    ${m.video_exists ? `
      <div class="field"><label>1st-half kick-off (video time)</label><div class="row">
        <input id="sH1" value="${fmtTime(m.half1_start || 0)}"><button class="small" data-use="sH1">Use current</button></div></div>
      <div class="field"><label>2nd-half kick-off (video time)</label><div class="row">
        <input id="sH2" value="${m.half2_start != null ? fmtTime(m.half2_start) : ''}" placeholder="e.g. 52:10"><button class="small" data-use="sH2">Use current</button></div></div>
      <button id="sGo" class="primary" ${n ? '' : 'disabled'}>Sync ${n} tag${n === 1 ? '' : 's'}</button>`
      : '<p class="small">Link the video in <a href="#" data-open-settings>Match settings</a> first.</p>'}`;
  box.onclick = async (e) => {
    const u = e.target.closest('[data-use]');
    if (u) { $('#' + u.dataset.use).value = fmtTime(video.currentTime || 0); return; }
    if (e.target.id !== 'sGo') return;
    const h1 = parseTime($('#sH1').value) ?? 0, h2 = parseTime($('#sH2').value);
    try {
      const r = await api.post(`/api/matches/${m.id}/sync-live`, { half1_start: h1, half2_start: h2 });
      Object.assign(S.match, { half1_start: h1, half2_start: h2 });
      await loadTags();
      toast(`${r.synced} tags placed on the video timeline${h2 == null ? ' (2nd-half tags wait for its kick-off time)' : ''}`);
      emit('match');
    } catch (err) { errToast(err); }
  };
}

on('view', (v) => { if (v === 'live') render(); else clearInterval(timer); });
on('match', () => { if (S.view === 'live') render(); });
on('tags', () => {
  if (S.view !== 'live') return;
  renderRecent(); renderSync();
  updateToggleStates($('#lCodes'));
  updateDescriptorStates($('#lDesc'));
});
on('select', () => { if (S.view === 'live') { renderRecent(); updateDescriptorStates($('#lDesc')); markCurrent($('#lCodes')); } });
