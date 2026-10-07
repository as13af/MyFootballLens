// Moments: paste notes that end in video timestamps ("LV presses well (17:38)"), turn each line into a
// clip around that time, then step through them (N / Shift+N) to watch and draw.
import { api } from './api.js';
import { S, on, emit, template, tagById, teamName, playerLabel, clockAt } from './state.js';
import { video, hasVideo, seek } from './player.js';
import { loadTags, select } from './tags.js';
import { createPlaylist, exportDialog } from './playlists.js';
import * as draw from './telestration.js';
import { $, esc, fmtTime, fmtClock, dialog, toast, keepScroll } from './ui.js';

const el = $('#panel-moments');
const KEY = 'vat-moment-defaults';
let setId;            // playlist shown in the panel: null = every moment, undefined = not chosen yet (newest set)
let curId = null;     // tag of the moment last jumped to

// ---------- parsing ----------
// m:ss, mm:ss, mmm:ss or h:mm:ss, optionally with decimals. The last time on a line wins.
const TS = /(\d{1,3}):([0-5]\d)(?::([0-5]\d))?(?:\.(\d+))?/g;

/** Lines with a timestamp become moments; the first line without one is used as the playlist name. */
export function parseNotes(text) {
  const moments = [];
  let title = null, headings = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const all = [...line.matchAll(TS)];
    if (!all.length) { title ??= line; headings++; return; }
    const m = all[all.length - 1];
    const t = m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    const note = (line.slice(0, m.index) + line.slice(m.index + m[0].length))
      .replace(/[([{]\s*[)\]}]/g, '')                 // the brackets the timestamp was in
      .replace(/^[\s•·▪●◦*>\-–—]+/, '')              // bullet
      .replace(/[\s\-–—:,;]+$/, '').trim();
    moments.push({ line: i + 1, t: t + (m[4] ? +`0.${m[4]}` : 0), note });
  });
  moments.forEach((mo, i) => { if (i && mo.t < moments[i - 1].t) mo.before = moments[i - 1].t; });
  return { moments, title, headings };
}

// ---------- paste dialog ----------
function defaults() {
  try { return { lead: 5, lag: 5, code: 'Key moment', ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { lead: 5, lag: 5, code: 'Key moment' }; }
}

export function openPasteDialog() {
  if (!S.match) { toast('Create a match first', { error: true }); return; }
  const d = defaults();
  const buttons = template().buttons.filter((b) => b.kind !== 'toggle');
  const code = buttons.some((b) => b.code === d.code) ? d.code : buttons.find((b) => b.code === 'Key moment')?.code || buttons[0]?.code || 'Key moment';
  const players = S.match.players || [];
  let nameEdited = false;
  dialog({
    title: 'Paste timestamps',
    okLabel: 'Add clips',
    wide: true,
    body: `<div class="form-grid">
      <label class="full"><span>Your notes: one moment per line, ending with its <b>video time</b>, e.g. <span class="mono">LV presses well (17:38)</span> or <span class="mono">(1:09:15)</span></span>
        <textarea name="text" rows="9" placeholder="Luke Vickery Moments&#10;• LV showed a very good pressing(17:38)&#10;• LV making a good run into spaces(19:22)"></textarea></label>
      <label>Playlist name<input name="name" placeholder="Moments"></label>
      <label>Event<select name="code">${(buttons.length ? buttons.map((b) => b.code) : [code]).map((c) => `<option ${c === code ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Player<select name="player"><option value="">None</option>${players.map((p) => `<option value="${p.id}">${esc(teamName(p.team))} ${esc(playerLabel(p))}</option>`).join('')}</select></label>
      <label>Team<select name="team"><option value="">Neutral</option><option value="A">${esc(teamName('A'))}</option><option value="B">${esc(teamName('B'))}</option></select></label>
      <label>Clip starts before (s)<input name="lead" type="number" min="0" max="120" step="0.5" value="${d.lead}"></label>
      <label>Clip ends after (s)<input name="lag" type="number" min="0.5" max="120" step="0.5" value="${d.lag}"></label>
      <div class="full" id="mpPreview"></div>
    </div>`,
    onOpen: (dlg) => {
      const form = $('form', dlg);
      const refresh = () => {
        const { moments, title, headings } = parseNotes(form.text.value);
        if (!nameEdited) form.name.value = title || '';
        $('#mpPreview', dlg).innerHTML = previewHtml(moments, headings);
        $('button[type=submit]', dlg).textContent = moments.length ? `Add ${moments.length} clip${moments.length === 1 ? '' : 's'}` : 'Add clips';
      };
      form.text.addEventListener('input', refresh);
      form.name.addEventListener('input', () => { nameEdited = true; });
      form.player.addEventListener('change', () => { const p = players.find((x) => x.id === +form.player.value); if (p) form.team.value = p.team; });
      refresh();
      form.text.focus();
    },
    onSubmit: (form) => addMoments(form),
  });
}

function previewHtml(moments, headings) {
  if (!moments.length) return '<p class="muted small">Paste your notes above. Lines without a time (titles, “0 – 5” headings) are skipped.</p>';
  const dur = S.duration || Infinity;
  const odd = moments.filter((m) => m.before != null || m.t > dur).length;
  return `<p class="small" style="margin:0 0 6px">${moments.length} moment${moments.length === 1 ? '' : 's'} found${headings ? ` · ${headings} line${headings === 1 ? '' : 's'} without a time skipped` : ''}
      ${odd ? ` · <span class="warn-text">${odd} to check (highlighted)</span>` : ''}</p>
    <div class="mp-list"><table><tbody>${moments.map((m) => {
      const why = m.t > dur ? 'after the end of the video' : m.before != null ? `earlier than the line before (${fmtTime(m.before, false)}) — typo?` : '';
      return `<tr class="${why ? 'warn' : ''}"><td class="muted">${m.line}</td><td class="mono">${fmtTime(m.t, false)}</td>
        <td class="wrap" style="width:100%">${esc(m.note) || '<span class="muted">(no text)</span>'}${why ? `<div class="warn-text small">${esc(why)}</div>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

async function addMoments(form) {
  const { moments } = parseNotes(form.text.value);
  if (!moments.length) { toast('No timestamps found — each line needs a time like (17:38)', { error: true }); return false; }
  const lead = Math.max(0, +form.lead.value || 0), lag = Math.max(0.5, +form.lag.value || 5);
  const code = form.code.value, team = form.team.value || null, player_id = +form.player.value || null;
  try { localStorage.setItem(KEY, JSON.stringify({ lead, lag, code })); } catch { /* not remembered */ }
  // Pasting the same notes twice shouldn't double every clip.
  const have = new Set(S.tags.filter((t) => t.moment != null).map((t) => `${t.moment.toFixed(1)}|${t.note || ''}`));
  const fresh = moments.filter((m) => !have.has(`${m.t.toFixed(1)}|${m.note}`));
  const end = S.duration || Infinity;
  const tags = fresh.map((m) => ({
    code, team, player_id, note: m.note, moment: m.t,
    start: Math.max(0, m.t - lead), end: Math.min(end, m.t + lag),
  }));
  const made = tags.length ? await api.post(`/api/matches/${S.match.id}/tags/bulk`, { tags }) : [];
  await loadTags();
  const name = form.name.value.trim() || 'Moments';
  const items = made.filter((t) => t.end > t.start).sort((a, b) => a.moment - b.moment).map((t) => ({ tag_id: t.id, note: '' }));
  if (items.length) setId = (await createPlaylist(name, items)).id;
  const skipped = moments.length - fresh.length;
  toast(`Added ${made.length} clip${made.length === 1 ? '' : 's'}${items.length ? ` to “${name}”` : ''}${skipped ? ` · ${skipped} already there` : ''}`);
  showPanel();
}

// ---------- panel ----------
const hasMoments = (pl) => pl.items.some((it) => tagById(it.tag_id)?.moment != null);
const sets = () => S.playlists.filter(hasMoments);

/** Moments in the chosen set, in video order. */
function list() {
  const pl = S.playlists.find((p) => p.id === setId);
  const tags = pl ? pl.items.map((it) => tagById(it.tag_id)) : S.tags;
  return tags.filter((t) => t && t.moment != null).sort((a, b) => a.moment - b.moment);
}

/** Drawings that will be exported with this clip (same rule as exports). */
const drawingsIn = (t) => S.drawings.filter((d) => d.t >= t.start && d.t < (t.end ?? t.start)).length;

function render() {
  if (!S.match) { el.innerHTML = ''; return; }
  if (setId != null && !S.playlists.some((p) => p.id === setId)) setId = undefined;
  if (setId === undefined) setId = sets().at(-1)?.id ?? null;
  const rows = list();
  const drawn = rows.filter(drawingsIn).length;
  const nKey = template().buttons.some((b) => b.hotkey?.toLowerCase() === 'n') ? null : 'N / Shift+N';
  el.innerHTML = `
    <div class="pl-tools">
      <select id="mSet" title="Which moments to show">
        <option value="" ${setId == null ? 'selected' : ''}>All moments</option>
        ${sets().map((p) => `<option value="${p.id}" ${p.id === setId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      ${rows.length ? `<span class="small"><b>${drawn}</b> / ${rows.length} drawn</span>` : ''}
      <span class="muted small">Click a moment to jump there · ${nKey ? `<kbd>${nKey}</kbd> next / previous · ` : ''}<kbd>\`</kbd> draw</span>
      <span class="spacer"></span>
      <button id="mPaste">+ Paste timestamps…</button>
      <button id="mExport" class="primary" ${rows.length ? '' : 'disabled'}>Export MP4</button>
    </div>
    <div class="pl-items">${rows.length ? `<table>
      <thead><tr><th>#</th><th>Video</th><th>Clock</th><th>Moment</th><th>Drawing</th><th></th></tr></thead>
      <tbody>${rows.map((t, i) => {
        const n = drawingsIn(t);
        return `<tr data-id="${t.id}" class="${t.id === S.selectedId ? 'sel' : ''} ${S.playing.has(t.id) ? 'playing' : ''}">
          <td class="muted">${i + 1}</td><td class="mono">${fmtTime(t.moment, false)}</td><td class="mono muted">${fmtClock(clockAt(t.moment))}</td>
          <td class="wrap" style="max-width:none;width:100%">${esc(t.note || t.code)}</td>
          <td>${n ? `<span title="${n} drawing${n === 1 ? '' : 's'} in this clip">✎${n > 1 ? ' ' + n : ''}</span>` : '<span class="muted">—</span>'}</td>
          <td><button class="small ghost" data-draw title="Jump here and draw">✎ Draw</button></td></tr>`;
      }).join('')}</tbody></table>`
      : `<div class="empty-state" style="position:static;height:100%"><p>Paste notes with video timestamps, like
        <span class="mono">LV presses well (17:38)</span>, to get a clip for every line.<br>Then step through them here and draw.</p></div>`}</div>`;

  $('#mSet').onchange = (e) => { setId = e.target.value ? +e.target.value : null; render(); };
  $('#mPaste').onclick = openPasteDialog;
  $('#mExport').onclick = () => {
    const pl = S.playlists.find((p) => p.id === setId);
    exportDialog(rows.map((t) => t.id), pl?.name || `${S.match.title} moments`);
  };
  const tbody = el.querySelector('tbody');
  if (tbody) {
    tbody.onclick = (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) jumpTo(tagById(+tr.dataset.id), { drawNow: !!e.target.closest('[data-draw]') });
    };
    tbody.ondblclick = (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && !e.target.closest('[data-draw]')) jumpTo(tagById(+tr.dataset.id), { drawNow: true });
    };
  }
}

/** Pause exactly on a moment (not the clip start) and select its clip. */
function jumpTo(t, { drawNow = false } = {}) {
  if (!t) return;
  if (!hasVideo()) { toast('Load the match video first', { error: true }); return; }
  if (draw.isActive()) draw.exit();
  video.pause();
  curId = t.id;
  select(t.id);
  seek(t.moment);
  if (drawNow) draw.enter();
}

/** N / Shift+N: the next / previous moment after the current video time. */
export function step(dir) {
  const rows = list();
  if (!rows.length) { toast('No moments yet — Data ▾ → Paste timestamps…', { error: true }); return; }
  const now = video.currentTime;
  const cur = tagById(curId);
  const ref = cur && Math.abs(cur.moment - now) < 0.05 ? cur.moment : now;
  const t = dir > 0 ? rows.find((r) => r.moment > ref + 0.01) : [...rows].reverse().find((r) => r.moment < ref - 0.01);
  if (!t) { toast(dir > 0 ? 'That was the last moment' : 'That was the first moment', { timeout: 1200 }); return; }
  jumpTo(t);
  toast(`${rows.indexOf(t) + 1}/${rows.length} · ${t.note || t.code}`, { timeout: 2200 });
}

function showPanel() {
  $('#lowerTabs [data-panel="moments"]').click();
}

// Only re-render while visible; otherwise remember to do it when the panel is shown.
let dirty = true;
function maybeRender() {
  const picking = el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
  if (el.classList.contains('active') && S.view === 'tag' && !picking) { dirty = false; keepScroll(el, render); }
  else dirty = true;
}
on('match', () => { setId = undefined; curId = null; });
['tags', 'drawings', 'playlists', 'select', 'match'].forEach((ev) => on(ev, maybeRender));
on('panel', () => { if (dirty) maybeRender(); });
