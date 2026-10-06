// Template editor: code-window buttons (instant/toggle, lead/lag, hotkey, colour) + descriptors.
import { api } from './api.js';
import { S, on, emit } from './state.js';
import { $, esc, toast, errToast, confirmBox } from './ui.js';

const el = $('#view-templates');
let list = [], draft = null, dirty = false;

export async function refresh(selectId) {
  list = await api.get('/api/templates');
  const id = selectId ?? draft?.id ?? S.match?.template_id ?? list[0]?.id;
  if (id && (!draft || draft.id !== id || selectId)) draft = await api.get(`/api/templates/${id}`);
  dirty = false;
  render();
}

function render() {
  const inUse = S.match?.template_id;
  el.innerHTML = `<div class="tpl-wrap">
    <div class="tpl-list">
      <div class="pane-head"><h3>Templates</h3></div>
      ${list.map((t) => `<div class="t ${t.id === draft?.id ? 'active' : ''}" data-id="${t.id}">
        <span>${esc(t.name)}${t.id === inUse ? ' <span class="muted small">· this match</span>' : ''}</span><span class="muted">${t.n_buttons}</span></div>`).join('')}
      <div class="row" style="margin-top:10px">
        <button id="tNew" class="small">+ Blank</button>
        <button id="tDup" class="small" ${draft ? '' : 'disabled'}>Duplicate</button>
      </div>
    </div>
    ${draft ? editor(inUse) : '<p class="muted">No template.</p>'}
  </div>`;
  wire();
}

function editor(inUse) {
  const b = draft.buttons, d = draft.descriptors;
  return `<div class="tpl-edit">
    <div class="row" style="gap:10px">
      <input id="tName" value="${esc(draft.name)}" style="font-size:15px;font-weight:600;width:280px">
      <span class="muted small" id="tDirty">${dirty ? 'Unsaved changes' : ''}</span>
      <span class="spacer"></span>
      ${S.match && inUse !== draft.id ? '<button id="tUse">Use for current match</button>' : ''}
      <button id="tDel" class="ghost danger">Delete</button>
      <button id="tSave" class="primary">Save template</button>
    </div>
    <div class="err" id="tErr"></div>
    <h3>Code buttons</h3>
    <p class="muted small" style="margin-top:-4px">Lead/lag = seconds added before/after the key press. <b>Toggle</b> buttons start on the first press and stop on the second (e.g. Possession).
      Letters are best for hotkeys (Shift = team B); digits are used by descriptors.</p>
    <table><thead><tr><th></th><th>Name</th><th>Type</th><th class="num">Lead s</th><th class="num">Lag s</th><th>Key</th><th>Colour</th><th>Teams</th>
      <th title="Ask for a pitch location">Location</th><th title="Location also has an end point (pass/cross)">End pt</th><th></th></tr></thead>
    <tbody id="tBtns">${b.map((x, i) => `<tr data-i="${i}">
      <td class="handle"><button class="ghost small" data-up="${i}" title="Move up">↑</button></td>
      <td><input data-f="code" value="${esc(x.code)}"></td>
      <td><select data-f="kind"><option value="instant" ${x.kind === 'instant' ? 'selected' : ''}>Instant</option><option value="toggle" ${x.kind === 'toggle' ? 'selected' : ''}>Toggle</option></select></td>
      <td class="num"><input type="number" step="0.5" min="0" data-f="lead" value="${x.lead}"></td>
      <td class="num"><input type="number" step="0.5" min="0" data-f="lag" value="${x.lag}"></td>
      <td><input class="hk" maxlength="1" data-f="hotkey" value="${esc(x.hotkey || '')}"></td>
      <td><input type="color" data-f="color" value="${esc(x.color || '#94a3b8')}"></td>
      <td><select data-f="team_scope"><option value="both" ${x.team_scope !== 'none' ? 'selected' : ''}>A + B</option><option value="none" ${x.team_scope === 'none' ? 'selected' : ''}>Neutral</option></select></td>
      <td><input type="checkbox" data-f="loc" ${x.loc ? 'checked' : ''}></td>
      <td><input type="checkbox" data-f="loc_end" ${x.loc_end ? 'checked' : ''}></td>
      <td><button class="ghost small danger" data-rm="${i}" title="Remove">✕</button></td></tr>`).join('')}</tbody></table>
    <button id="tAddBtn" class="small" style="margin-top:6px">+ Add button</button>
    <h3>Descriptors</h3>
    <p class="muted small" style="margin-top:-4px">Labels attached to the selected tag. One label per group (pressing another in the same group replaces it).
      Outcome marks the label as a success or fail for the success-rate stats.</p>
    <table><thead><tr><th></th><th>Group</th><th>Label</th><th>Key</th><th>Outcome</th><th></th></tr></thead>
    <tbody id="tDescs">${d.map((x, i) => `<tr data-i="${i}">
      <td><button class="ghost small" data-up="${i}" title="Move up">↑</button></td>
      <td><input data-f="grp" value="${esc(x.grp)}"></td><td><input data-f="label" value="${esc(x.label)}"></td>
      <td><input class="hk" maxlength="1" data-f="hotkey" value="${esc(x.hotkey || '')}"></td>
      <td><select data-f="outcome"><option value="">—</option><option value="success" ${x.outcome === 'success' ? 'selected' : ''}>Success</option><option value="fail" ${x.outcome === 'fail' ? 'selected' : ''}>Fail</option></select></td>
      <td><button class="ghost small danger" data-rm="${i}">✕</button></td></tr>`).join('')}</tbody></table>
    <button id="tAddDesc" class="small" style="margin-top:6px">+ Add descriptor</button>
  </div>`;
}

const RESERVED = new Set([' ', ',', '.', '[', ']', '`']);

function validate() {
  const keys = {};
  const errs = [];
  for (const x of [...draft.buttons, ...draft.descriptors]) {
    const k = (x.hotkey || '').toLowerCase();
    if (!k) continue;
    if (RESERVED.has(k)) errs.push(`“${k}” is reserved for playback`);
    if (keys[k]) errs.push(`Key “${k.toUpperCase()}” is used twice (${keys[k]} and ${x.code || x.label})`);
    keys[k] = x.code || x.label;
  }
  const names = draft.buttons.map((x) => x.code.trim());
  if (names.some((n) => !n)) errs.push('Every button needs a name');
  if (new Set(names).size !== names.length) errs.push('Button names must be unique');
  $('#tErr').textContent = errs.join(' · ');
  return !errs.length;
}

function markDirty() { dirty = true; const d = $('#tDirty'); if (d) d.textContent = 'Unsaved changes'; validate(); }

function wire() {
  el.querySelector('.tpl-list').onclick = async (e) => {
    const t = e.target.closest('.t');
    if (!t) return;
    if (dirty && !(await confirmBox('Discard unsaved template changes?', 'Discard'))) return;
    refresh(+t.dataset.id).catch(errToast);
  };
  $('#tNew').onclick = async () => {
    const name = prompt('Template name', 'My template');
    if (name) refresh((await api.post('/api/templates', { name })).id);
  };
  $('#tDup').onclick = async () => {
    const t = await api.post('/api/templates', { name: `${draft.name} (copy)`, from_id: draft.id });
    refresh(t.id);
  };
  if (!draft) return;
  $('#tName').oninput = (e) => { draft.name = e.target.value; markDirty(); };
  const bind = (tbody, arr) => {
    tbody.oninput = tbody.onchange = (e) => {
      const f = e.target.dataset.f, i = +e.target.closest('tr').dataset.i;
      if (!f) return;
      let v = e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value;
      if (e.target.type === 'number') v = +v || 0;
      if (f === 'hotkey') v = v.toLowerCase();
      if (f === 'outcome') v = v || null;
      arr[i][f] = v;
      markDirty();
    };
    tbody.onclick = (e) => {
      const rm = e.target.closest('[data-rm]'), up = e.target.closest('[data-up]');
      if (rm) { arr.splice(+rm.dataset.rm, 1); dirty = true; render(); }
      if (up && +up.dataset.up > 0) { const i = +up.dataset.up; [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; dirty = true; render(); }
    };
  };
  bind($('#tBtns'), draft.buttons);
  bind($('#tDescs'), draft.descriptors);
  $('#tAddBtn').onclick = () => {
    draft.buttons.push({ code: `Event ${draft.buttons.length + 1}`, kind: 'instant', lead: 5, lag: 5, hotkey: '', color: '#94a3b8', team_scope: 'both', loc: 0, loc_end: 0 });
    dirty = true; render();
  };
  $('#tAddDesc').onclick = () => { draft.descriptors.push({ grp: 'Outcome', label: 'New label', hotkey: '', outcome: null }); dirty = true; render(); };
  $('#tSave').onclick = async () => {
    if (!validate()) return;
    try {
      draft = await api.put(`/api/templates/${draft.id}`, draft);
      dirty = false;
      toast('Template saved');
      await refresh(draft.id);
      if (S.match?.template_id === draft.id) emit('template-changed');
    } catch (e) { $('#tErr').textContent = e.message; }
  };
  $('#tDel').onclick = async () => {
    if (!(await confirmBox(`Delete template “${draft.name}”? Matches using it switch to the first template. Existing tags are kept.`))) return;
    try { await api.del(`/api/templates/${draft.id}`); draft = null; refresh(); emit('template-changed'); } catch (e) { errToast(e); }
  };
  $('#tUse')?.addEventListener('click', async () => {
    await api.patch(`/api/matches/${S.match.id}`, { template_id: draft.id });
    S.match.template_id = draft.id;
    emit('template-changed');
    toast(`“${draft.name}” is now used for this match`);
    render();
  });
  if (dirty) validate();
}

on('view', (v) => { if (v === 'templates') refresh().catch(errToast); });
