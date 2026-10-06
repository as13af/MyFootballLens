// Drawings panel: every saved telestration with a preview, the clip(s) it will appear in, and actions.
import { S, on, emit, template, codeColor, teamColor, teamShort, isUnsyncedLive, clockAt, halfAt } from './state.js';
import { renderShapes, deleteDrawing, setHold } from './telestration.js';
import { createTag, select } from './tags.js';
import { $, esc, fmtTime, fmtClock, confirmBox, errToast, toast } from './ui.js';

const el = $('#panel-drawings');

/** Clips (finished, on the video timeline) that contain the drawing's moment — exactly what exports use. */
const clipsFor = (d) => S.tags.filter((t) => !isUnsyncedLive(t) && t.end != null && t.start <= d.t && d.t < t.end);

function version(d) {
  let h = 0;
  for (const ch of d.shapes || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${h}-${d.hold}`;
}

function render() {
  const list = [...S.drawings].sort((a, b) => a.t - b.t);
  $('#drawingsTab').textContent = list.length ? `Drawings (${list.length})` : 'Drawings';
  if (!list.length) {
    el.innerHTML = `<div class="empty-state" style="position:static;height:100%">
      <p>No drawings yet. Pause the video, press <kbd>\`</kbd> (or <b>✎ Draw</b>), draw, then <b>Save drawing</b>.</p></div>`;
    return;
  }
  const outside = list.filter((d) => !clipsFor(d).length).length;
  el.innerHTML = `
    <div class="pl-tools">
      <span class="muted small">${list.length} drawing${list.length === 1 ? '' : 's'} · click a preview to view it on the video
        ${outside ? ` · <span class="warn-text">${outside} not inside any clip (won't be exported)</span>` : ''}</span>
    </div>
    <div class="dgrid">${list.map((d) => {
      const clips = clipsFor(d);
      const n = JSON.parse(d.shapes || '[]').length;
      return `<div class="dcard" data-id="${d.id}">
        <div class="dthumb" data-act="view" title="View on video">
          ${d.has_thumb ? `<img src="/api/drawings/${d.id}/thumb.jpg?v=${version(d)}" alt="Drawing at ${fmtTime(d.t)}" loading="lazy">` : `<canvas width="320" height="180"></canvas>`}
          <span class="dtime mono">${fmtClock(clockAt(d.t))} · ${halfAt(d.t)}H</span>
        </div>
        <div class="dmeta">
          <div class="row"><span class="mono small">${fmtTime(d.t)}</span><span class="muted small">${n} shape${n === 1 ? '' : 's'}</span>
            <span class="spacer"></span>
            <label class="inline small" title="Freeze length in playback and exports">Hold <input type="number" min="0.5" max="30" step="0.5" value="${d.hold}" data-hold style="width:52px;padding:2px 4px">s</label></div>
          <div class="chips">${clips.length
            ? clips.slice(0, 3).map((t) => `<button class="chip" data-tag="${t.id}" title="Select this clip"><span class="sw" style="background:${esc(codeColor(t.code))};margin:0"></span>${esc(t.code)}${t.team ? ` <span style="color:${esc(teamColor(t.team))}">${esc(teamShort(t.team))}</span>` : ''}</button>`).join('') + (clips.length > 3 ? `<span class="muted small">+${clips.length - 3}</span>` : '')
            : `<span class="warn-text small">Not in any clip</span><button class="small" data-act="clip">+ Clip here</button>`}</div>
          <div class="row">
            <button class="small" data-act="view">View</button>
            <button class="small" data-act="edit">Edit</button>
            <span class="spacer"></span>
            <button class="ghost small danger" data-act="del">Delete</button>
          </div>
        </div></div>`;
    }).join('')}</div>`;

  // Older drawings saved before thumbnails existed: draw the shapes on black.
  el.querySelectorAll('.dcard canvas').forEach((c) => {
    const d = S.drawings.find((x) => x.id === +c.closest('.dcard').dataset.id);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    renderShapes(ctx, JSON.parse(d.shapes || '[]'), c.width, c.height);
  });
}

el.addEventListener('click', async (e) => {
  const card = e.target.closest('.dcard');
  if (!card) return;
  const d = S.drawings.find((x) => x.id === +card.dataset.id);
  const tagBtn = e.target.closest('[data-tag]');
  if (tagBtn) { select(+tagBtn.dataset.tag); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  try {
    if (act === 'view') emit('goto-drawing', { d });
    else if (act === 'edit') emit('goto-drawing', { d, edit: true });
    else if (act === 'del') { if (await confirmBox(`Delete the drawing at ${fmtTime(d.t)}?`)) await deleteDrawing(d); }
    else if (act === 'clip') await clipAround(d);
  } catch (err) { errToast(err); }
});

el.addEventListener('change', (e) => {
  if (!e.target.matches('[data-hold]')) return;
  const d = S.drawings.find((x) => x.id === +e.target.closest('.dcard').dataset.id);
  const v = Math.max(0.5, Math.min(30, +e.target.value || 3));
  setHold(d, v).catch(errToast);
});

/** Make a neutral clip around a drawing so it gets exported (uses "Key moment" when the template has it). */
async function clipAround(d) {
  const btn = template().buttons.find((b) => b.code === 'Key moment')
    || template().buttons.find((b) => b.team_scope === 'none' && b.kind === 'instant')
    || { code: 'Drawing', lead: 4, lag: 4 };
  const tag = await createTag({ code: btn.code, team: null, start: Math.max(0, d.t - (+btn.lead || 4)), end: d.t + Math.max(1, +btn.lag || 4) });
  select(tag.id);
  toast(`Created “${btn.code}” clip around the drawing`);
}

let dirty = true;
function maybeRender() {
  $('#drawingsTab').textContent = S.drawings.length ? `Drawings (${S.drawings.length})` : 'Drawings';
  if (el.classList.contains('active') && S.view === 'tag' && !el.contains(document.activeElement)) { dirty = false; render(); }
  else dirty = true;
}
['drawings', 'tags', 'match'].forEach((ev) => on(ev, maybeRender));
on('panel', () => { if (dirty) maybeRender(); });
