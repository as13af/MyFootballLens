// App bootstrap: match loading, views, filters, keyboard shortcuts, data menu.
import { api } from './api.js';
import './theme.js';
import { S, on, emit, template, teamName, isUnsyncedLive, filteredTags, selectedTag } from './state.js';
import { video, loadVideo, hasVideo, togglePlay, step, frame, setRate, seek, playRange, stopSequence } from './player.js';
import { loadTags, select, deleteTags, pressButton, applyDescriptor, descriptorByHotkey } from './tags.js';
import { renderCodeWindow, updateToggleStates, flashButton } from './codewindow.js';
import { requestDraw } from './timeline.js';
import { shortcutsHtml } from './inspector.js';
import './taglist.js';
import { loadPlaylists } from './playlists.js';
import * as draw from './telestration.js';
import './drawings.js';
import './stats.js';
import { liveNow, toggleClock } from './liveclock.js';
import './templates.js';
import { openMatchDialog } from './match.js';
import { systemInfo, reveal } from './jobs.js';
import { showSplash, hideSplash, splashOpen } from './splash.js';
import { $, $$, esc, toast, errToast, dialog, confirmBox, fmtTime, isTyping } from './ui.js';

// ---------------- matches ----------------
async function loadMatchList(selectId) {
  const list = await api.get('/api/matches');
  const sel = $('#matchSelect');
  sel.innerHTML = list.length
    ? list.map((m) => `<option value="${m.id}">${esc(m.title)}${m.date ? ' · ' + esc(m.date) : ''}</option>`).join('')
    : '<option value="">No matches yet</option>';
  let id = selectId;
  if (id === undefined) { try { id = +localStorage.getItem('vat-last-match'); } catch { id = null; } }
  if (!list.some((m) => m.id === id)) id = list[0]?.id ?? null;
  if (id) sel.value = id;
  return id;
}

async function loadMatch(id, { reloadVideo = true } = {}) {
  if (!id) {
    S.match = null; S.tags = []; S.drawings = []; S.playlists = [];
    loadVideo();
    emit('match'); emit('tags'); emit('playlists');
    return;
  }
  const keepTime = !reloadVideo && S.match?.id === id ? video.currentTime : null;
  S.match = await api.get(`/api/matches/${id}`);
  try { localStorage.setItem('vat-last-match', id); } catch { /* ignore */ }
  if (reloadVideo) {
    S.selectedId = null; S.checked.clear();
    S.filters = { team: '', code: '', player: '', text: '' };
  }
  const [, drawings] = await Promise.all([loadTags(), api.get(`/api/matches/${id}/drawings`), loadPlaylists()]);
  S.drawings = drawings;
  if (reloadVideo) {
    loadVideo();
    S.fps = 25;
    if (S.match.video_exists) {
      const p = S.match.proxy_exists ? S.match.proxy_path : S.match.video_path;
      api.get(`/api/probe?path=${encodeURIComponent(p)}`).then((i) => { S.fps = i.fps || 25; }).catch(() => {});
    }
  } else if (keepTime != null) seek(keepTime);
  applyTeamColors();
  emit('match');
  emit('drawings');
}

function applyTeamColors() {
  const r = document.documentElement.style;
  r.setProperty('--team-a', S.match?.color_a || '#3b82f6');
  r.setProperty('--team-b', S.match?.color_b || '#ef4444');
  $('#teamAHint').textContent = teamName('A');
  $('#teamBHint').textContent = teamName('B');
}

async function afterSave(id, { videoChanged = false, deleted = false } = {}) {
  const sel = await loadMatchList(deleted ? undefined : id);
  await loadMatch(sel, { reloadVideo: deleted || videoChanged || sel !== id });
}

$('#matchSelect').onchange = (e) => loadMatch(+e.target.value).catch(errToast);
$('#btnNewMatch').onclick = () => openMatchDialog({ isNew: true, onSaved: afterSave });
$('#btnSettings').onclick = () => (S.match ? openMatchDialog({ onSaved: afterSave }) : openMatchDialog({ isNew: true, onSaved: afterSave }));
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) { e.preventDefault(); $('#btnSettings').click(); }
  if (e.target.closest('[data-new-match]')) { e.preventDefault(); $('#btnNewMatch').click(); }
});

on('template-changed', () => S.match && loadMatch(S.match.id, { reloadVideo: false }));
on('job-done', (j) => { if (j.kind === 'proxy' && S.match) loadMatch(S.match.id); });

// ---------------- views ----------------
function setView(v) {
  if (v !== 'tag' && draw.isActive()) draw.exit();
  S.view = v;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v !== 'tag') video.pause();
  emit('view', v);
  if (v === 'tag') { requestDraw(); emit('panel'); updateToggleStates($('#codeWindow')); emit('select', {}); }
}
$('#tabs').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); };
on('goto-view', setView);
on('goto-tag', (id) => { setView('tag'); select(id, { seek: true }); });

$('#lowerTabs').onclick = (e) => {
  const b = e.target.closest('[data-panel]');
  if (!b) return;
  $$('#lowerTabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('#lowerPane .panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${b.dataset.panel}`));
  $('#tlZoom').hidden = b.dataset.panel !== 'timeline';
  emit('panel', b.dataset.panel);
  if (b.dataset.panel === 'timeline') requestDraw();
};

// ---------------- code window (tag view) ----------------
function videoNow() {
  if (!hasVideo()) { toast('No video loaded — link one in Match settings, or tag with the Live clock', { error: true }); return null; }
  return { t: video.currentTime, live: false };
}
on('match', () => {
  renderCodeWindow($('#codeWindow'), videoNow);
  renderFilters();
});
on('tags', () => { updateToggleStates($('#codeWindow')); renderFilters(); });

// ---------------- filters ----------------
function renderFilters() {
  const f = S.filters;
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  $('#fTeam').innerHTML = opt('', 'All teams', f.team) + opt('A', teamName('A'), f.team) + opt('B', teamName('B'), f.team) + opt('N', 'Neutral', f.team);
  const codes = [...new Set([...template().buttons.map((b) => b.code), ...S.tags.map((t) => t.code)])];
  $('#fCode').innerHTML = opt('', 'All events', f.code) + codes.map((c) => opt(c, c, f.code)).join('');
  const players = S.match?.players || [];
  $('#fPlayer').innerHTML = opt('', 'All players', f.player) + players.map((p) => opt(p.id, `${p.team} #${p.number} ${p.name}`, f.player)).join('');
  if (document.activeElement !== $('#fText')) $('#fText').value = f.text;
  const active = f.team || f.code || f.player || f.text;
  $('#fClear').style.visibility = active ? 'visible' : 'hidden';
}
$('#filters').addEventListener('change', (e) => {
  const map = { fTeam: 'team', fCode: 'code', fPlayer: 'player' };
  if (map[e.target.id]) { S.filters[map[e.target.id]] = e.target.value; emit('filters'); }
});
$('#fText').addEventListener('input', (e) => { S.filters.text = e.target.value; emit('filters'); });
$('#fClear').onclick = () => { S.filters = { team: '', code: '', player: '', text: '' }; emit('filters'); };
on('filters', renderFilters);

// ---------------- keyboard ----------------
function keyOf(e) {
  if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return e.code.slice(6);
  return (e.key || '').toLowerCase();
}

function neighbourTag(dir) {
  const list = filteredTags();
  if (!list.length) return null;
  const cur = selectedTag();
  const ref = cur ? cur.start : video.currentTime;
  if (dir > 0) return list.find((t) => t.start > ref + 0.01 && t.id !== cur?.id) || null;
  return [...list].reverse().find((t) => t.start < ref - 0.01 && t.id !== cur?.id) || null;
}

window.addEventListener('keydown', (e) => {
  if (splashOpen()) {   // any key just closes the intro; it never tags or plays
    if (!e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); hideSplash(); }
    return;
  }
  if ($('#dlg').open) return;
  if (isTyping(e)) { if (e.key === 'Escape') e.target.blur(); return; }
  const v = S.view;
  if (v !== 'tag' && v !== 'live') return;
  if (draw.isActive()) {
    // Esc first cancels the step in progress (curve, selection), then leaves drawing mode.
    if (e.key === 'Escape') { e.preventDefault(); if (!draw.escape()) draw.exit(); }
    else if (e.code === 'Backquote') { e.preventDefault(); draw.exit(); }
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); draw.undo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); draw.deleteSelected(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tagView = v === 'tag';
  switch (e.code) {
    case 'Space': e.preventDefault(); tagView ? togglePlay() : toggleClock(); return;
    case 'ArrowLeft': case 'ArrowRight':
      if (!tagView) return;
      e.preventDefault(); step((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 5)); return;
    case 'Comma': case 'Period': if (tagView) { e.preventDefault(); frame(e.code === 'Comma' ? -1 : 1); } return;
    case 'BracketLeft': case 'BracketRight': if (tagView) { e.preventDefault(); setRate(e.code === 'BracketLeft' ? -1 : 1); } return;
    case 'Backquote': if (tagView) { e.preventDefault(); draw.toggle(); } return;
    case 'Enter': {
      const t = selectedTag();
      if (tagView && t && t.end != null && !isUnsyncedLive(t)) { e.preventDefault(); playRange(t.start, t.end); }
      return;
    }
    case 'Delete': case 'Backspace':
      if (S.selectedId) { e.preventDefault(); deleteTags([S.selectedId]); }
      return;
    case 'Escape': if (!stopSequence()) select(null); return;
    case 'PageUp': case 'PageDown': {
      if (!tagView) return;
      e.preventDefault();
      const t = neighbourTag(e.code === 'PageDown' ? 1 : -1);
      if (t) select(t.id, { seek: true });
      return;
    }
    case 'Home': if (tagView) { e.preventDefault(); seek(0); } return;
  }
  if (!S.match) return;
  const k = keyOf(e);
  const d = descriptorByHotkey(k);
  if (d) { e.preventDefault(); applyDescriptor(d).catch(errToast); return; }
  const btn = template().buttons.find((b) => b.hotkey && b.hotkey.toLowerCase() === k);
  if (btn) {
    e.preventDefault();
    if (e.repeat) return;
    const now = tagView ? videoNow() : liveNow();
    if (!now) return;
    const team = btn.team_scope === 'none' ? null : e.shiftKey ? 'B' : 'A';
    pressButton(btn, team, now).catch(errToast);
    flashButton(tagView ? $('#codeWindow') : $('#lCodes'), btn.code, team);
  }
});

// ---------------- 1st / 2nd half kick-off buttons ----------------
function paintHalves() {
  $$('#tHalves button').forEach((b) => {
    b.disabled = !S.match;
    b.classList.toggle('unset', b.dataset.half === '2' && S.match?.half2_start == null);
  });
}

async function setHalf(half, t) {
  const m = S.match;
  if (half === 2 && t <= (m.half1_start || 0)) { toast('The 2nd half must start after the 1st-half kick-off', { error: true }); return; }
  if (half === 1 && m.half2_start != null && t >= m.half2_start) { toast('The 1st-half kick-off must be before the 2nd half', { error: true }); return; }
  const key = half === 1 ? 'half1_start' : 'half2_start';
  await api.patch(`/api/matches/${m.id}`, { [key]: t });
  m[key] = t;
  paintHalves();
  requestDraw();
  seek(video.currentTime);   // refreshes the match clock
  toast(`${half === 1 ? '1st' : '2nd'}-half kick-off set to ${fmtTime(t)}`);
}

$('#tHalves').onclick = async (e) => {
  const b = e.target.closest('[data-half]');
  if (!b || !S.match) return;
  if (!hasVideo()) { toast('No video loaded', { error: true }); return; }
  const half = +b.dataset.half, now = video.currentTime;
  try {
    if (e.shiftKey) { await setHalf(half, now); return; }
    const target = half === 1 ? (S.match.half1_start || 0) : S.match.half2_start;
    if (target == null) {
      const ok = await confirmBox(`The 2nd-half kick-off isn't set yet. Set it to the current video time (${fmtTime(now)})?
        Tip: scrub to the moment of the kick-off first.`, 'Set to current time');
      if (ok) await setHalf(2, now);
      return;
    }
    seek(target);
  } catch (err) { errToast(err); }
};
on('match', paintHalves);

// ---------------- top-bar actions ----------------
$('#btnReport').onclick = () => S.match ? window.open(`/report/${S.match.id}`, '_blank') : toast('Create a match first', { error: true });

$('.menu-items').onclick = async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'exports') { reveal(null); return; }
  if (!S.match) { toast('Create a match first', { error: true }); return; }
  if (act === 'xml-export') location.href = `/api/matches/${S.match.id}/export.xml`;
  if (act === 'csv') location.href = `/api/matches/${S.match.id}/export.csv`;
  if (act === 'xml-import') $('#xmlFile').click();
};
$('#xmlFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await api.post(`/api/matches/${S.match.id}/import-xml`, { xml: await f.text() });
    await loadTags();
    toast(`Imported ${r.imported} instances from ${f.name}`);
  } catch (err) { errToast(err); }
};

$('#btnHelp').onclick = () => dialog({
  title: 'Shortcuts & workflow',
  body: `<div class="grid2" style="grid-template-columns:1fr 1fr">
    <div><h3 style="margin-bottom:8px">Keyboard</h3>${shortcutsHtml()}</div>
    <div class="small" style="color:var(--text-2);line-height:1.6">
      <h3 style="margin-bottom:8px">Workflow</h3>
      <b>1.</b> New match → link the video, set team names, colours and rosters.<br>
      <b>2.</b> Set the 2nd-half kick-off time so the match clock and halves are right.<br>
      <b>3.</b> Watch and press code keys. Each press makes a clip using the button's lead/lag.
      Toggle buttons (⟲) run until pressed again.<br>
      <b>4.</b> The new tag is selected: press 0–9 for descriptors, click a player, click the pitch for location.<br>
      <b>5.</b> Timeline: drag clip edges to trim, drag a clip to move it, double-click to play, Ctrl+wheel to zoom.<br>
      <b>6.</b> Press <kbd>\`</kbd> to draw on the frame; saved drawings freeze playback and appear in exports.<br>
      <b>7.</b> Build playlists, then <b>Export MP4</b>. Stats and the printable report update live.<br>
      <b>Live tab:</b> tag with a clock during the match, then sync the tags to the video afterwards.
    </div></div>`,
  wide: true,
  extraFoot: `<span class="muted small">MyFootballLens · Created by Ali Shidqie · © 2026 · MIT License</span>
    <button type="button" class="ghost small" id="btnReplayIntro">Replay intro</button>`,
  onOpen: (dlg) => {
    dlg.querySelector('#btnReplayIntro').onclick = () => { dlg.close(); showSplash(); };
  },
});

// ---------------- boot ----------------
(async () => {
  try {
    const id = await loadMatchList();
    await loadMatch(id);
    systemInfo().then((i) => { if (!i.ffmpeg) toast('ffmpeg not found — install it to export clips', { error: true }); }).catch(() => {});
  } catch (e) { errToast(e); }
})();
