// Tag list: sortable table of filtered tags with multi-select for playlists/export/delete.
import { S, on, emit, filteredTags, codeColor, teamColor, teamShort, playerById, playerLabel, tagClockStr, halfOf, isUnsyncedLive } from './state.js';
import { select, deleteTags } from './tags.js';
import { addToPlaylist, exportDialog } from './playlists.js';
import { $, esc, confirmBox } from './ui.js';

const el = $('#panel-list');
let sortKey = 'start', sortDir = 1;

const COLS = [
  ['clock', 'Time'], ['half', 'H'], ['code', 'Event'], ['team', 'Team'], ['player', 'Player'],
  ['labels', 'Labels'], ['loc', 'Loc'], ['dur', 'Dur'], ['note', 'Note'],
];

function sortVal(t, k) {
  switch (k) {
    case 'code': return t.code;
    case 'team': return t.team || 'Z';
    case 'player': return +(playerById(t.player_id)?.number ?? 999);
    case 'dur': return t.end != null ? t.end - t.start : 1e9;
    case 'half': return halfOf(t);
    default: return t.start;
  }
}

function render() {
  const tags = filteredTags().slice().sort((a, b) => {
    const x = sortVal(a, sortKey), y = sortVal(b, sortKey);
    return (x < y ? -1 : x > y ? 1 : a.start - b.start) * sortDir;
  });
  const waiting = S.tags.filter(isUnsyncedLive).length;
  const nChecked = S.checked.size;
  el.innerHTML = `
    <div class="pl-tools" style="position:sticky;top:0;background:var(--panel);z-index:2">
      <label class="inline small"><input type="checkbox" id="lAll" ${tags.length && tags.every((t) => S.checked.has(t.id)) ? 'checked' : ''}> All</label>
      <span class="muted small">${tags.length} tags${nChecked ? ` · ${nChecked} ticked` : ''}</span>
      ${waiting ? `<span class="small danger">${waiting} live-clock tags waiting for sync (Live tab)</span>` : ''}
      <span class="spacer"></span>
      <select id="lPl" ${nChecked ? '' : 'disabled'}><option value="">Add ticked to playlist…</option>
        ${S.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}<option value="new">New playlist…</option></select>
      <button id="lExport" class="small" ${nChecked ? '' : 'disabled'}>Export ticked</button>
      <button id="lDelete" class="small ghost danger" ${nChecked ? '' : 'disabled'}>Delete ticked</button>
    </div>
    <table><thead style="position:sticky;top:37px;z-index:1"><tr><th></th>${COLS.map(([k, l]) =>
      `<th data-sort="${k === 'clock' ? 'start' : k}" style="cursor:pointer">${l}${(k === 'clock' ? 'start' : k) === sortKey ? (sortDir > 0 ? ' ▴' : ' ▾') : ''}</th>`).join('')}</tr></thead>
    <tbody>${tags.map((t) => `<tr data-id="${t.id}" class="${t.id === S.selectedId ? 'sel' : ''}">
      <td><input type="checkbox" data-chk="${t.id}" ${S.checked.has(t.id) ? 'checked' : ''}></td>
      <td class="mono">${tagClockStr(t)}</td><td class="muted">${halfOf(t)}</td>
      <td><span class="sw" style="background:${esc(codeColor(t.code))}"></span>${esc(t.code)}${t.end == null ? ' <span class="muted">(open)</span>' : ''}</td>
      <td style="color:${esc(teamColor(t.team))}">${t.team ? esc(teamShort(t.team)) : ''}</td>
      <td>${esc(playerLabel(playerById(t.player_id)))}</td>
      <td class="wrap">${t.labels.map((l) => `<span class="chip ${esc(l.outcome || '')}">${esc(l.label)}</span>`).join(' ')}</td>
      <td>${t.x != null ? '●' : ''}</td>
      <td class="num">${t.end != null ? (t.end - t.start).toFixed(1) : ''}</td>
      <td class="wrap muted">${esc((t.note || '').slice(0, 90))}</td></tr>`).join('') ||
      '<tr><td colspan="10" class="muted">No tags match.</td></tr>'}</tbody></table>`;

  $('#lAll').onchange = (e) => { tags.forEach((t) => (e.target.checked ? S.checked.add(t.id) : S.checked.delete(t.id))); emit('checked'); };
  $('#lPl').onchange = (e) => { const v = e.target.value; if (v) addToPlaylist(v === 'new' ? null : +v, [...S.checked]); };
  $('#lExport').onclick = () => exportDialog([...S.checked], `${S.match.title} selection`);
  $('#lDelete').onclick = async () => {
    if (await confirmBox(`Delete ${S.checked.size} tags?`)) deleteTags([...S.checked]);
  };
  el.querySelector('thead').onclick = (e) => {
    const k = e.target.closest('[data-sort]')?.dataset.sort;
    if (!k) return;
    sortDir = k === sortKey ? -sortDir : 1;
    sortKey = k;
    render();
  };
  el.querySelector('tbody').onclick = (e) => {
    const chk = e.target.closest('[data-chk]');
    if (chk) {
      const id = +chk.dataset.chk;
      chk.checked ? S.checked.add(id) : S.checked.delete(id);
      emit('checked');
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(+tr.dataset.id, { seek: true });
  };
}

let dirty = true;
function maybeRender() {
  if (el.classList.contains('active') && S.view === 'tag') { dirty = false; render(); } else dirty = true;
}
['tags', 'select', 'filters', 'checked', 'playlists', 'match'].forEach((ev) => on(ev, maybeRender));
on('panel', () => { if (dirty) maybeRender(); });
