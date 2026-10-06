// Code window (tag buttons) and descriptor buttons. Used by both the Tag and Live views.
import { S, template, teamColor, teamShort, selectedTag } from './state.js';
import { pressButton, applyDescriptor } from './tags.js';
import { $$, esc, errToast } from './ui.js';

export function renderCodeWindow(el, getNow, { big = false } = {}) {
  const tpl = template();
  el.classList.toggle('big', big);
  if (!tpl.buttons.length) {
    el.innerHTML = `<p class="muted">This template has no buttons. Add some in the Templates tab.</p>`;
    return;
  }
  el.innerHTML = tpl.buttons.map((b, i) => {
    const pads = b.team_scope === 'none'
      ? `<button data-team="" style="--tc:${esc(b.color)}">${b.kind === 'toggle' ? 'Start/Stop' : 'Tag'}</button>`
      : ['A', 'B'].map((k) => `<button data-team="${k}" style="--tc:${esc(teamColor(k))}" title="${k === 'A' ? 'Key' : 'Shift+key'}">${esc(teamShort(k))}</button>`).join('');
    return `<div class="tile" style="--c:${esc(b.color)}" data-i="${i}">
      <div class="tl"><span class="name" title="${esc(b.code)}">${esc(b.code)}</span>
        <span>${b.kind === 'toggle' ? '<span class="kind">⟲</span> ' : ''}${b.hotkey ? `<kbd>${esc(b.hotkey.toUpperCase())}</kbd>` : ''}</span></div>
      <div class="pads">${pads}</div></div>`;
  }).join('');
  el.onclick = (e) => {
    const pad = e.target.closest('button[data-team]');
    if (!pad) return;
    const b = tpl.buttons[+pad.closest('.tile').dataset.i];
    const now = getNow();
    if (!now) return;
    pressButton(b, pad.dataset.team || null, now).catch(errToast);
    hit(pad);
  };
  updateToggleStates(el);
}

export function updateToggleStates(el) {
  const btns = template().buttons;
  $$('.tile', el).forEach((tile) => {
    const b = btns[+tile.dataset.i];
    if (!b || b.kind !== 'toggle') return;
    $$('button[data-team]', tile).forEach((p) => p.classList.toggle('active', S.openToggles.has(`${b.code}|${p.dataset.team}`)));
  });
}

/** Visual feedback when a hotkey fires a button. */
export function flashButton(el, code, team) {
  const i = template().buttons.findIndex((b) => b.code === code);
  const tile = el.querySelector(`.tile[data-i="${i}"]`);
  const pad = tile?.querySelector(`button[data-team="${team || ''}"]`) || tile?.querySelector('button[data-team]');
  if (pad) hit(pad);
}

function hit(pad) {
  pad.classList.add('hit');
  setTimeout(() => pad.classList.remove('hit'), 160);
}

export function renderDescriptors(el) {
  const groups = {};
  template().descriptors.forEach((d, i) => (groups[d.grp] ||= []).push({ ...d, i }));
  if (!Object.keys(groups).length) { el.innerHTML = '<p class="muted small">No descriptors in this template.</p>'; return; }
  el.innerHTML = Object.entries(groups).map(([g, list]) => `
    <div class="dgroup"><span>${esc(g)}</span><div class="chips">${list.map((d) =>
      `<button type="button" class="chip" data-i="${d.i}" title="${esc(d.outcome ? 'Counts as ' + d.outcome : '')}">${esc(d.label)}${d.hotkey ? ` <kbd>${esc(d.hotkey)}</kbd>` : ''}</button>`).join('')}</div></div>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) applyDescriptor(template().descriptors[+b.dataset.i]).catch(errToast);
  };
  updateDescriptorStates(el);
}

export function updateDescriptorStates(el) {
  const t = selectedTag();
  const d = template().descriptors;
  $$('button[data-i]', el).forEach((b) => {
    const x = d[+b.dataset.i];
    b.classList.toggle('on', !!t && t.labels.some((l) => l.grp === x.grp && l.label === x.label));
  });
}
