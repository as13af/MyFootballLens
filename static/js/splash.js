// Intro / about screen: shown at startup (unless turned off), replayable from the logo or the ? dialog.
import { $ } from './ui.js';

const el = $('#splash');
const KEY = 'mfl-splash-off';
let timer = 0;

const isOff = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export const splashOpen = () => !el.hidden;

const SLIDE_MS = 600;   // matches the CSS spDropIn / spSlideOut durations
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** auto = startup: drops in, holds, then slides down by itself (~2.6 s). Replays stay until dismissed. */
export function showSplash({ auto = false } = {}) {
  clearTimeout(timer);
  $('#spNoShow').checked = isOff();
  el.classList.remove('in', 'out');
  el.hidden = false;
  void el.offsetWidth;            // restart the CSS animations
  el.classList.add('in');
  // 0.6 s drop-in + ~1.4 s on screen, then hideSplash() adds the 0.6 s slide-out
  if (auto) timer = setTimeout(hideSplash, 2000);
}

export function hideSplash() {
  if (el.hidden || el.classList.contains('out')) return;
  clearTimeout(timer);
  el.classList.remove('in');
  el.classList.add('out');
  setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, reduced() ? 0 : SLIDE_MS);
}

// Clicking the backdrop or Skip closes; links and the checkbox don't.
el.addEventListener('click', (e) => {
  if (e.target.closest('a, label, input')) { clearTimeout(timer); return; }
  hideSplash();
});
$('#spSkip').addEventListener('click', hideSplash);
$('#spNoShow').addEventListener('change', (e) => {
  try { localStorage.setItem(KEY, e.target.checked ? '1' : '0'); } catch { /* storage unavailable: shows next time */ }
});
document.querySelector('.brand').addEventListener('click', () => showSplash());

if (!isOff()) showSplash({ auto: true });
