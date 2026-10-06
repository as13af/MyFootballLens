// New match / Match settings dialog: teams, colours, video link + proxy, half markers, rosters.
import { api } from './api.js';
import { S } from './state.js';
import { video } from './player.js';
import { track } from './jobs.js';
import { $, esc, dialog, fmtTime, parseTime, toast, errToast, confirmBox, debounce } from './ui.js';

const POS = new Set(['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'WB', 'DM', 'CDM', 'CM', 'AM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST', 'CF', 'SS', 'DF', 'MF', 'FW']);

function rosterText(players, team) {
  return players.filter((p) => p.team === team).map((p) => [p.number, p.name, p.position].filter(Boolean).join(' ')).join('\n');
}

/** "9 Jordan Smith ST" -> {number, name, position}. Keeps ids of existing players by team+number or name. */
function parseRoster(text, team, existing) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const tok = line.replace(/[.,;\t]+/g, ' ').split(/\s+/);
    const number = /^\d{1,3}$/.test(tok[0]) ? tok.shift() : '';
    const position = tok.length > 1 && POS.has(tok[tok.length - 1].toUpperCase()) ? tok.pop().toUpperCase() : '';
    const name = tok.join(' ');
    const prev = existing.find((p) => p.team === team && ((number && p.number === number) || (!number && p.name === name)));
    return { id: prev?.id, team, number, name, position };
  });
}

export async function openMatchDialog({ isNew = false, onSaved }) {
  const m = isNew ? { title: '', team_a: 'Team A', team_b: 'Team B', color_a: '#3b82f6', color_b: '#ef4444', a_right_h1: 1, half1_start: 0, players: [] } : S.match;
  const templates = await api.get('/api/templates').catch(() => []);
  const dlg = dialog({
    title: isNew ? 'New match' : 'Match settings',
    okLabel: isNew ? 'Create match' : 'Save',
    wide: true,
    extraFoot: isNew ? '' : '<button type="button" class="ghost danger" id="mDelete">Delete match</button>',
    body: `<div class="form-grid">
      <label class="full">Title<input name="title" value="${esc(m.title)}" placeholder="e.g. U17 vs Rivals FC (home)" required></label>
      <label>Date<input type="date" name="date" value="${esc(m.date || '')}"></label>
      <label>Competition<input name="competition" value="${esc(m.competition || '')}"></label>
      <label>Tagging template<select name="template_id">${templates.map((t) => `<option value="${t.id}" ${t.id === m.template_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Team A<span class="team-row"><input type="text" name="team_a" value="${esc(m.team_a)}"><input type="color" name="color_a" value="${esc(m.color_a)}"></span></label>
      <label>Team B<span class="team-row"><input type="text" name="team_b" value="${esc(m.team_b)}"><input type="color" name="color_b" value="${esc(m.color_b)}"></span></label>
      <label class="full">Match video file
        <span class="row"><input name="video_path" value="${esc(m.video_path || '')}" placeholder="C:\\Videos\\match.mp4" style="flex:1">
        <button type="button" id="mBrowse">Browse…</button></span></label>
      <div class="full note-box" id="mProbe">No video linked. You can still tag with the Live clock and link the video later.</div>
      ${isNew ? '' : `<div class="full" id="mProxy"></div>`}
      <label>1st-half kick-off (video time)<span class="row"><input name="half1_start" value="${fmtTime(m.half1_start || 0)}" style="flex:1"><button type="button" data-now="half1_start">Now</button></span></label>
      <label>2nd-half kick-off (video time)<span class="row"><input name="half2_start" value="${m.half2_start != null ? fmtTime(m.half2_start) : ''}" placeholder="not set" style="flex:1"><button type="button" data-now="half2_start">Now</button></span></label>
      <label class="check full"><input type="checkbox" name="a_right_h1" ${m.a_right_h1 ? 'checked' : ''}> In the video, Team A attacks left → right in the 1st half (they switch automatically after half-time)</label>
      <label>Team A roster<textarea name="roster_a" rows="9" placeholder="1 Keeper GK&#10;4 Centre Back CB&#10;9 Striker ST">${esc(rosterText(m.players || [], 'A'))}</textarea></label>
      <label>Team B roster<textarea name="roster_b" rows="9" placeholder="One per line: number name position">${esc(rosterText(m.players || [], 'B'))}</textarea></label>
      <label class="full">Match notes (shown in the report)<textarea name="notes" rows="3">${esc(m.notes || '')}</textarea></label>
    </div>`,
    onSubmit: async (form) => {
      const fd = new FormData(form);
      const h1 = parseTime(fd.get('half1_start')), h2 = parseTime(fd.get('half2_start'));
      const body = {
        title: fd.get('title').trim(), date: fd.get('date'), competition: fd.get('competition'),
        template_id: +fd.get('template_id') || null,
        team_a: fd.get('team_a').trim() || 'Team A', team_b: fd.get('team_b').trim() || 'Team B',
        color_a: fd.get('color_a'), color_b: fd.get('color_b'),
        video_path: clean(fd.get('video_path')) || null,
        half1_start: h1 ?? 0, half2_start: h2, a_right_h1: fd.get('a_right_h1') ? 1 : 0, notes: fd.get('notes'),
      };
      const saved = isNew ? await api.post('/api/matches', body) : await api.patch(`/api/matches/${m.id}`, body);
      const players = [...parseRoster(fd.get('roster_a'), 'A', m.players || []), ...parseRoster(fd.get('roster_b'), 'B', m.players || [])];
      await api.put(`/api/matches/${saved.id}/players`, { players });
      const videoChanged = isNew || saved.video_path !== m.video_path;
      toast(isNew ? 'Match created' : 'Match saved');
      onSaved?.(saved.id, { videoChanged });
    },
  });

  const pathInput = dlg.querySelector('[name=video_path]');
  const probe = debounce(async () => {
    const box = $('#mProbe');
    const p = clean(pathInput.value);
    if (!p) { box.className = 'full note-box'; box.textContent = 'No video linked. You can still tag with the Live clock and link the video later.'; return; }
    try {
      const i = await api.get(`/api/probe?path=${encodeURIComponent(p)}`);
      box.className = 'full note-box' + (i.browser_ok ? '' : ' warn');
      box.innerHTML = `${i.width}×${i.height} · ${esc(i.vcodec)} · ${i.fps} fps · ${fmtTime(i.duration, false)} · ${i.has_audio ? 'audio ' + esc(i.acodec) : 'no audio'}
        ${i.browser_ok ? '' : '<br><b>This codec/container may not play in the browser.</b> After saving, create a 720p proxy below.'}
        ${i.height > 1080 ? '<br>4K source: a 720p proxy makes scrubbing much lighter.' : ''}`;
    } catch (e) { box.className = 'full note-box warn'; box.textContent = e.message; }
  }, 300);
  pathInput.addEventListener('input', probe);
  probe();
  $('#mBrowse').onclick = async () => {
    const r = await api.get('/api/pick-file?kind=video').catch(errToast);
    if (r?.path) { pathInput.value = r.path; probe(); }
  };
  dlg.querySelectorAll('[data-now]').forEach((b) => (b.onclick = () => {
    dlg.querySelector(`[name=${b.dataset.now}]`).value = fmtTime(video.currentTime || 0);
  }));
  if (!isNew) {
    renderProxy(m);
    $('#mDelete').onclick = async () => {
      if (!(await confirmBox(`Delete “${m.title}” with all its tags, drawings and playlists? The video file itself is not touched.`))) return;
      await api.del(`/api/matches/${m.id}`);
      toast('Match deleted');
      onSaved?.(null, { deleted: true });
    };
  }
}

function renderProxy(m) {
  const box = $('#mProxy');
  if (!box) return;
  box.innerHTML = m.proxy_exists
    ? `<div class="note-box row">Playback uses a lightweight 720p proxy (exports still use the original file).<span class="spacer"></span><button type="button" id="mProxyDel" class="small">Remove proxy</button></div>`
    : m.video_exists
      ? `<div class="note-box row">Long, 4K or unusual files? A 720p proxy with a keyframe every second makes scrubbing smooth and light.<span class="spacer"></span><button type="button" id="mProxyMake" class="small">Create 720p proxy</button></div>`
      : '';
  $('#mProxyMake')?.addEventListener('click', async () => {
    try { track(await api.post(`/api/matches/${m.id}/proxy`)); toast('Creating proxy in the background…'); $('#dlg').close(); } catch (e) { errToast(e); }
  });
  $('#mProxyDel')?.addEventListener('click', async () => {
    await api.post(`/api/matches/${m.id}/proxy/clear`);
    m.proxy_exists = false;
    renderProxy(m);
    toast('Proxy removed — save or reopen to reload the original');
  });
}

const clean = (p) => (p || '').trim().replace(/^"(.*)"$/, '$1');
