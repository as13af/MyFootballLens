// Tag CRUD + code-window button logic (instant / toggle, lead / lag, descriptors).
import { api } from './api.js';
import { S, emit, tagById, rebuildOpenToggles, teamName, teamColor, isUnsyncedLive, template } from './state.js';
import { toast, errToast } from './ui.js';

const byStart = (a, b) => a.start - b.start || a.id - b.id;

function upsert(tag) {
  const i = S.tags.findIndex((t) => t.id === tag.id);
  if (i >= 0) S.tags[i] = tag; else S.tags.push(tag);
  S.tags.sort(byStart);
}

export async function loadTags() {
  S.tags = await api.get(`/api/matches/${S.match.id}/tags`);
  rebuildOpenToggles();
  emit('tags');
}

export async function createTag(data) {
  const tag = await api.post(`/api/matches/${S.match.id}/tags`, data);
  upsert(tag);
  rebuildOpenToggles();
  emit('tags');
  return tag;
}

/** Optimistic update: local state changes immediately, the server copy replaces it. */
export async function updateTag(id, patch) {
  const t = tagById(id);
  if (t) { Object.assign(t, patch); S.tags.sort(byStart); rebuildOpenToggles(); emit('tags'); }
  try {
    const tag = await api.patch(`/api/tags/${id}`, patch);
    upsert(tag);
    rebuildOpenToggles();
    emit('tags');
    return tag;
  } catch (e) { errToast(e); await loadTags(); }
}

export async function deleteTags(ids, { undo = true } = {}) {
  const removed = S.tags.filter((t) => ids.includes(t.id));
  if (!removed.length) return;
  S.tags = S.tags.filter((t) => !ids.includes(t.id));
  ids.forEach((id) => S.checked.delete(id));
  if (ids.includes(S.selectedId)) select(null);
  rebuildOpenToggles();
  emit('tags');
  if (ids.length === 1) await api.del(`/api/tags/${ids[0]}`);
  else await api.post(`/api/matches/${S.match.id}/tags/bulk-delete`, { ids });
  if (undo) {
    toast(`Deleted ${removed.length} tag${removed.length > 1 ? 's' : ''}`, {
      action: { label: 'Undo', run: () => restore(removed) }, timeout: 6000,
    });
  }
}

async function restore(tags) {
  for (const t of tags) {
    const { id, match_id, created, ...rest } = t;
    await createTag(rest);
  }
}

export function select(id, { seek = false } = {}) {
  S.selectedId = id;
  emit('select', { seek });
}

function timeFor(tag, now) {
  return isUnsyncedLive(tag) === !!now.live ? now.t : tag.start + 1;
}

/**
 * A code-window press.
 * now = { t, live, half } — video time, or live-clock seconds since the half's kick-off.
 */
export async function pressButton(btn, team, now) {
  if (btn.team_scope === 'none') team = null;
  const key = `${btn.code}|${team || ''}`;
  const extra = now.live ? { source: 'live', live_half: now.half, synced: 0 } : {};
  const label = `${btn.code}${team ? ' · ' + teamName(team) : ''}`;

  if (btn.kind === 'toggle') {
    const openId = S.openToggles.get(key);
    if (openId) {
      const t = tagById(openId);
      await updateTag(openId, { end: Math.max(t.start + 0.1, timeFor(t, now) + (+btn.lag || 0)) });
      toast(`${label} — ended`, { color: btn.color, timeout: 1200 });
      return t;
    }
    // Same code for the other team ends (e.g. Possession A -> Possession B).
    for (const [k, id] of [...S.openToggles]) {
      if (k.startsWith(btn.code + '|')) {
        const t = tagById(id);
        await updateTag(id, { end: Math.max(t.start + 0.1, timeFor(t, now)) });
      }
    }
    const tag = await createTag({ code: btn.code, team, start: Math.max(0, now.t - (+btn.lead || 0)), end: null, ...extra });
    select(tag.id);
    toast(`${label} — started`, { color: btn.color, timeout: 1200 });
    return tag;
  }

  const tag = await createTag({
    code: btn.code, team, start: Math.max(0, now.t - (+btn.lead || 0)), end: now.t + (+btn.lag || 0), ...extra,
  });
  select(tag.id);
  toast(label, { color: team ? teamColor(team) : btn.color, timeout: 1200 });
  return tag;
}

/** Descriptors are exclusive inside their group; pressing an applied one removes it. */
export async function applyDescriptor(desc, tagId = S.selectedId) {
  const t = tagById(tagId);
  if (!t) { toast('Select a tag first (click one in the timeline)', { error: true, timeout: 2500 }); return; }
  const had = t.labels.some((l) => l.grp === desc.grp && l.label === desc.label);
  const labels = t.labels.filter((l) => l.grp !== desc.grp);
  if (!had) labels.push({ grp: desc.grp, label: desc.label, outcome: desc.outcome || null });
  await updateTag(t.id, { labels });
}

export function descriptorByHotkey(key) {
  return template().descriptors.find((d) => d.hotkey && d.hotkey.toLowerCase() === key);
}
