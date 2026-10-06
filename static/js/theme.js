// Light / dark theme. index.html applies the starting theme before paint; this module owns the toggle.
// Canvas-drawn parts (timeline, pitches, charts) read colours through cssVar() and redraw on 'theme'.
import { emit } from './state.js';
import { $ } from './ui.js';

const KEY = 'mfl-theme';
const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: light)');
const cache = new Map();

const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

export const theme = () => root.dataset.theme || 'dark';

/** Current value of a CSS custom property, e.g. cssVar('--panel'). */
export function cssVar(name) {
  if (!cache.has(name)) cache.set(name, getComputedStyle(root).getPropertyValue(name).trim());
  return cache.get(name);
}

function apply(t) {
  root.dataset.theme = t;
  cache.clear();
  paintButton();
  emit('theme', t);
}

const SUN = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7"/></svg>';
const MOON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z"/></svg>';

function paintButton() {
  const b = $('#btnTheme');
  const light = theme() === 'light';
  b.innerHTML = light ? MOON : SUN;   // shows what you switch TO
  b.title = light ? 'Switch to dark theme' : 'Switch to light theme';
}

$('#btnTheme').addEventListener('click', () => {
  const t = theme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(KEY, t); } catch { /* not remembered, still switches */ }
  apply(t);
});

// Follow the system setting until the user has picked a theme themselves.
media.addEventListener('change', (e) => { if (!saved()) apply(e.matches ? 'light' : 'dark'); });

paintButton();
