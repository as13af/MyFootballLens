// Playlists: collect clips, reorder, play back-to-back, export one MP4.
import { api } from './api.js';
import { S, on, emit, tagById, codeColor, teamShort, teamColor, playerById, playerLabel, tagClockStr, filteredTags } from './state.js';
import { playSequence } from './player.js';
import { select } from './tags.js';
import { track, systemInfo } from './jobs.js';
import { $, esc, dialog, toast, errToast, confirmBox, keepScroll } from './ui.js';

const el = $('#panel-playlists');
let currentId = null;

export async function loadPlaylists() {
  S.playlists = await api.get(`/api/matches/${S.match.id}/playlists`);
  if (!S.playlists.some((p) => p.id === currentId)) currentId = S.playlists[0]?.id ?? null;
  emit('playlists');
}

const current = () => S.playlists.find((p) => p.id === currentId);

async function save(pl) {
  const n = await api.put(`/api/playlists/${pl.id}`, { name: pl.name, items: pl.items });
  Object.assign(pl, n);
  emit('playlists');
}

export async function createPlaylist(name, items = []) {
  const pl = await api.post(`/api/matches/${S.match.id}/playlists`, { name, items });
  S.playlists.push(pl);
  currentId = pl.id;
  emit('playlists');
  return pl;
}

/** Add tags to playlist `pid` (null = ask for a name and create one). */
export async function addToPlaylist(pid, tagIds) {
  try {
    let pl = S.playlists.find((p) => p.id === pid);
    if (!pl) {
      const name = prompt('New playlist name', `Playlist ${S.playlists.length + 1}`);
      if (!name) return;
      pl = await createPlaylist(name);
    }
    const have = new Set(pl.items.map((i) => i.tag_id));
    const add = tagIds.filter((id) => !have.has(id) && tagById(id)?.end != null);
    pl.items.push(...add.map((id) => ({ tag_id: id, note: '' })));
    await save(pl);
    toast(`Added ${add.length} clip${add.length === 1 ? '' : 's'} to “${pl.name}”`);
  } catch (e) { errToast(e); }
}

function render() {
  const pl = current();
  const items = pl ? pl.items.map((it) => ({ ...it, tag: tagById(it.tag_id) })).filter((it) => it.tag) : [];
  const total = items.reduce((s, it) => s + ((it.tag.end ?? it.tag.start) - it.tag.start), 0);
  el.innerHTML = `
    <div class="pl-list">
      <button id="plNew">+ New playlist</button>
      ${S.playlists.map((p) => `<div class="pl ${p.id === currentId ? 'active' : ''}" data-id="${p.id}">
        <span>${esc(p.name)}</span><span class="muted">${p.items.length}</span></div>`).join('') || '<p class="muted small">No playlists yet.</p>'}
    </div>
    <div class="pl-main">${pl ? `
      <div class="pl-tools">
        <input id="plName" value="${esc(pl.name)}" style="width:180px">
        <button id="plPlay" ${items.length ? '' : 'disabled'}>▶ Play all</button>
        <button id="plAddSel" ${S.selectedId ? '' : 'disabled'}>+ Selected tag</button>
        <button id="plAddChecked" ${S.checked.size ? '' : 'disabled'}>+ Checked (${S.checked.size})</button>
        <button id="plAddFiltered">+ Filtered (${filteredTags().filter((t) => t.end != null).length})</button>
        <span class="muted small">${items.length} clips · ${Math.round(total)} s</span>
        <span class="spacer"></span>
        <button id="plExport" class="primary" ${items.length ? '' : 'disabled'}>Export MP4</button>
        <button id="plDelete" class="ghost danger">Delete</button>
      </div>
      <div class="pl-items"><table>
        <thead><tr><th></th><th>#</th><th>Time</th><th>Event</th><th>Team</th><th>Player</th><th>Labels</th><th class="num">Dur</th><th>Clip note</th><th></th></tr></thead>
        <tbody>${items.map((it, i) => {
          const t = it.tag;
          return `<tr draggable="true" data-i="${i}" data-id="${t.id}" class="${t.id === S.selectedId ? 'sel' : ''} ${S.playing.has(t.id) ? 'playing' : ''}">
            <td class="handle" title="Drag to reorder">⠿</td><td class="muted">${i + 1}</td><td class="mono">${tagClockStr(t)}</td>
            <td><span class="sw" style="background:${esc(codeColor(t.code))}"></span>${esc(t.code)}</td>
            <td style="color:${esc(teamColor(t.team))}">${t.team ? esc(teamShort(t.team)) : ''}</td>
            <td>${esc(playerLabel(playerById(t.player_id)))}</td>
            <td class="wrap">${esc(t.labels.map((l) => l.label).join(', '))}</td>
            <td class="num">${t.end != null ? (t.end - t.start).toFixed(1) : '–'}</td>
            <td><input data-note="${i}" value="${esc(it.note || '')}" placeholder="Shown in caption…"></td>
            <td><button class="ghost small" data-rm="${i}" title="Remove">✕</button></td></tr>`;
        }).join('') || '<tr><td colspan="10" class="muted">Empty — add the selected tag, ticked tags from the Tag list, or everything matching the filters.</td></tr>'}</tbody>
      </table></div>` : '<div class="empty-state" style="position:static;height:100%"><p>Create a playlist to collect clips for a meeting or a player.</p></div>'}
    </div>`;
  wire(pl, items);
}

function wire(pl, items) {
  $('#plNew').onclick = async () => {
    const name = prompt('Playlist name', `Playlist ${S.playlists.length + 1}`);
    if (name) createPlaylist(name).catch(errToast);
  };
  el.querySelector('.pl-list').onclick = (e) => {
    const d = e.target.closest('.pl');
    if (d) { currentId = +d.dataset.id; render(); }
  };
  if (!pl) return;
  $('#plName').onchange = (e) => { pl.name = e.target.value || 'Playlist'; save(pl).catch(errToast); };
  $('#plPlay').onclick = () => playSequence(items.map((it) => ({ start: it.tag.start, end: it.tag.end, id: it.tag.id, label: it.tag.code })));
  $('#plAddSel').onclick = () => addToPlaylist(pl.id, [S.selectedId]);
  $('#plAddChecked').onclick = () => addToPlaylist(pl.id, [...S.checked]);
  $('#plAddFiltered').onclick = () => addToPlaylist(pl.id, filteredTags().map((t) => t.id));
  $('#plExport').onclick = () => exportDialog(items.map((it) => it.tag.id), pl.name,
    Object.fromEntries(items.filter((it) => it.note).map((it) => [it.tag.id, it.note])));
  $('#plDelete').onclick = async () => {
    if (!(await confirmBox(`Delete playlist “${pl.name}”? The tags themselves are kept.`))) return;
    await api.del(`/api/playlists/${pl.id}`);
    S.playlists = S.playlists.filter((p) => p.id !== pl.id);
    currentId = S.playlists[0]?.id ?? null;
    emit('playlists');
  };
  const tbody = el.querySelector('tbody');
  tbody.onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { pl.items.splice(+rm.dataset.rm, 1); save(pl).catch(errToast); return; }
    if (e.target.closest('input')) return;
    const tr = e.target.closest('tr[data-i]');
    if (tr) select(items[+tr.dataset.i].tag.id, { seek: true });
  };
  tbody.onchange = (e) => {
    const i = e.target.dataset.note;
    if (i != null) { pl.items[+i].note = e.target.value; save(pl).catch(errToast); }
  };
  // drag & drop reorder
  let from = null;
  tbody.ondragstart = (e) => { const tr = e.target.closest('tr[data-i]'); from = +tr.dataset.i; tr.classList.add('dragging'); };
  tbody.ondragover = (e) => {
    e.preventDefault();
    tbody.querySelectorAll('.dropbefore').forEach((x) => x.classList.remove('dropbefore'));
    e.target.closest('tr[data-i]')?.classList.add('dropbefore');
  };
  tbody.ondrop = (e) => {
    e.preventDefault();
    const tr = e.target.closest('tr[data-i]');
    if (from == null || !tr) return;
    const to = +tr.dataset.i;
    const [moved] = pl.items.splice(from, 1);
    pl.items.splice(to, 0, moved); // takes the target row's position
    from = null;
    save(pl).catch(errToast);
  };
  tbody.ondragend = () => { from = null; render(); };
}

/** Export dialog shared by playlists, the tag list and the inspector. */
export async function exportDialog(tagIds, defaultName, clipNotes = {}) {
  const info = await systemInfo().catch(() => ({}));
  if (!info.ffmpeg) { toast('ffmpeg not found on PATH — export is unavailable', { error: true }); return; }
  if (!S.match.video_exists) { toast('Link the match video first (Match settings)', { error: true }); return; }
  const ids = tagIds.filter((id) => tagById(id)?.end != null);
  const nNotes = ids.filter((id) => (clipNotes[id] || tagById(id).note || '').trim()).length;
  const nDraw = S.drawings.filter((d) => ids.some((id) => { const t = tagById(id); return d.t >= t.start && d.t < t.end; })).length;
  dialog({
    title: `Export ${ids.length} clip${ids.length === 1 ? '' : 's'} to MP4`,
    okLabel: 'Start export',
    body: `<div class="form-grid">
      <label class="full">File name<input name="name" value="${esc(defaultName)}" required></label>
      <label>Resolution<select name="resolution">
        <option value="1080">1080p (max)</option><option value="720" selected>720p</option>
        <option value="480">480p (small file)</option><option value="source">Source</option></select></label>
      <label class="check"><input type="checkbox" name="captions" checked> Captions (time · event · team · player · labels)</label>
      <label class="check"><input type="checkbox" name="show_notes" ${nNotes ? 'checked' : 'disabled'}> Notes under the caption (${nNotes} clip${nNotes === 1 ? ' has' : 's have'} one; long notes wrap to 2 lines)</label>
      <label class="check"><input type="checkbox" name="drawings" checked> Freeze-frame drawings (${nDraw} in these clips)</label>
      <label class="check"><input type="checkbox" name="logo" checked> Add MyFootballLens logo (bottom-right)</label>
      <p class="full note-box">Frame-accurate re-encode using <b>${esc(info.encoder || '?')}</b>. Runs in the background at low priority, so you can keep tagging. Files go to <span class="mono">data/exports</span>.</p>
    </div>`,
    onSubmit: async (form) => {
      const fd = new FormData(form);
      const job = await api.post('/api/export', {
        match_id: S.match.id, tag_ids: ids, name: fd.get('name'), resolution: fd.get('resolution'),
        captions: fd.get('captions') === 'on', show_notes: fd.get('show_notes') === 'on', drawings: fd.get('drawings') === 'on', logo: fd.get('logo') === 'on', notes: clipNotes,
      });
      track(job);
      toast('Export started');
    },
  });
}

// Only re-render while visible; otherwise remember to do it when the panel is shown.
let dirty = true;
function maybeRender() {
  if (el.classList.contains('active') && S.view === 'tag' && !el.contains(document.activeElement)) { dirty = false; keepScroll(el, render); }
  else dirty = true;
}
on('playlists', maybeRender);
['tags', 'select', 'filters', 'checked'].forEach((ev) => on(ev, maybeRender));
on('panel', () => { if (dirty) maybeRender(); });
