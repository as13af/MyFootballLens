// Global app state + a tiny event bus. Modules subscribe to the parts they draw.
import { fmtClock } from './ui.js';

export const S = {
  match: null,          // match row + players + template
  tags: [],
  drawings: [],
  playlists: [],
  fps: 25,
  duration: 0,
  view: 'tag',
  selectedId: null,
  checked: new Set(),   // tag ids ticked in the tag list
  filters: { team: '', code: '', player: '', text: '' },
  openToggles: new Map(), // "code|team" -> tag id (toggle tags with no end yet)
  playing: new Set(),   // clips under the playhead (highlight.js)
};

const listeners = {};
export const on = (ev, fn) => (listeners[ev] ||= []).push(fn);
export const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => fn(data));

export const template = () => S.match?.template || { buttons: [], descriptors: [] };
export const buttonFor = (code) => template().buttons.find((b) => b.code === code);
export const codeColor = (code) => buttonFor(code)?.color || '#94a3b8';
export const teamName = (k) => (k === 'A' ? S.match?.team_a : k === 'B' ? S.match?.team_b : 'Neutral') || k;
export const teamColor = (k) => (k === 'A' ? S.match?.color_a : k === 'B' ? S.match?.color_b : '#94a3b8') || '#94a3b8';
export function teamShort(k) {
  const abbr = (x) => (teamName(x) || x).slice(0, 3).toUpperCase();
  if (k !== 'A' && k !== 'B') return abbr(k);
  return abbr('A') === abbr('B') ? k : abbr(k);  // "Team A"/"Team B" would both be "TEA"
}
export const tagById = (id) => S.tags.find((t) => t.id === id);
export const selectedTag = () => tagById(S.selectedId);
export const playerById = (id) => S.match?.players?.find((p) => p.id === id);
export const playerLabel = (p) => (p ? `#${p.number || '?'} ${p.name || ''}`.trim() : '');

export const isUnsyncedLive = (t) => t.source === 'live' && !t.synced;

export function halfOf(t) {
  if (isUnsyncedLive(t)) return t.live_half || 1;
  const h2 = S.match?.half2_start;
  return h2 != null && t.start >= h2 ? 2 : 1;
}

export function halfAt(sec) {
  const h2 = S.match?.half2_start;
  return h2 != null && sec >= h2 ? 2 : 1;
}

/** Match clock seconds for a video time (2nd half starts at 45:00). */
export function clockAt(sec) {
  const m = S.match;
  if (!m) return sec;
  if (m.half2_start != null && sec >= m.half2_start) return 2700 + (sec - m.half2_start);
  return Math.max(0, sec - (m.half1_start || 0));
}

export function tagClock(t) {
  if (isUnsyncedLive(t)) return (t.live_half === 2 ? 2700 : 0) + Math.max(0, t.start);
  return clockAt(t.start);
}

export const tagClockStr = (t) => fmtClock(tagClock(t));

/** Does team `team` attack to the right of the camera picture in `half`? */
export function attacksRight(team, half) {
  const aRight = !!S.match?.a_right_h1 === (half === 1);
  return team === 'B' ? !aRight : aRight;
}

export function filteredTags({ includeUnsynced = false } = {}) {
  const f = S.filters, q = f.text.trim().toLowerCase();
  return S.tags.filter((t) => {
    if (!includeUnsynced && isUnsyncedLive(t)) return false;
    if (f.team && (t.team || 'N') !== f.team) return false;
    if (f.code && t.code !== f.code) return false;
    if (f.player && String(t.player_id) !== f.player) return false;
    if (q && !(t.labels.some((l) => l.label.toLowerCase().includes(q)) || (t.note || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

export function rebuildOpenToggles() {
  S.openToggles.clear();
  for (const t of S.tags) if (t.end == null) S.openToggles.set(`${t.code}|${t.team || ''}`, t.id);
}
