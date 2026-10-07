// "Now playing": the clips under the playhead get a ▶ in every list and a mark on the timeline.
// Checked on every player tick, but the DOM is only touched when the set of clips changes.
import { S, emit, isUnsyncedLive } from './state.js';
import { onTick } from './player.js';
import { $$ } from './ui.js';

let key = '';
onTick((t) => {
  const ids = S.tags.filter((x) => x.end != null && !isUnsyncedLive(x) && x.start <= t && t < x.end).map((x) => x.id);
  const k = ids.join(',');
  if (k === key) return;
  key = k;
  S.playing = new Set(ids);
  $$('#lowerPane tr[data-id]').forEach((tr) => tr.classList.toggle('playing', S.playing.has(+tr.dataset.id)));
  emit('playing');
});
