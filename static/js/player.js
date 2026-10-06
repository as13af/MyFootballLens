// HTML5 video + transport. The browser decodes (GPU); this module only reads currentTime.
// One requestAnimationFrame loop runs while playing and stops when paused.
import { S, emit, clockAt, halfAt } from './state.js';
import { $, esc, fmtTime, fmtClock, toast } from './ui.js';

export const video = $('#video');
const tickers = [];
export const onTick = (fn) => tickers.push(fn);

let raf = 0;
let lastT = 0;
let rangeEnd = null;          // stop when reaching this time (play single clip)
let seq = null;               // { items:[{start,end,id}], i }
const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export const hasVideo = () => !!video.currentSrc && video.readyState > 0;
export const now = () => video.currentTime || 0;

function loop() {
  const t = video.currentTime;
  if (rangeEnd != null && t >= rangeEnd) { video.pause(); rangeEnd = null; }
  if (seq) {
    const it = seq.items[seq.i];
    if (t >= it.end || t < it.start - 1) nextInSequence();
  }
  if (!video.paused && $('#tDrawPause').checked && !document.body.classList.contains('drawing') && t - lastT < 1) {
    const d = S.drawings.find((x) => x.t > lastT && x.t <= t);
    if (d) {
      lastT = d.t;
      video.pause();
      video.currentTime = d.t;
      emit('drawing-hit', d);
    }
  }
  lastT = t;
  tickAll(t);
  raf = video.paused ? 0 : requestAnimationFrame(loop);
}

function tickAll(t) {
  $('#tTime').textContent = fmtTime(t);
  const h = halfAt(t);
  $('#tClock').innerHTML = `${fmtClock(clockAt(t))} <small>${h}H</small>`;
  tickers.forEach((fn) => fn(t));
}

video.addEventListener('play', () => { $('#tPlay').textContent = '❚❚'; if (!raf) raf = requestAnimationFrame(loop); });
video.addEventListener('pause', () => { $('#tPlay').textContent = '▶'; tickAll(video.currentTime); });
video.addEventListener('seeked', () => { lastT = video.currentTime; tickAll(lastT); emit('seeked', lastT); });
video.addEventListener('loadedmetadata', () => {
  S.duration = video.duration || 0;
  $('#videoEmpty').hidden = true;
  emit('duration');
  tickAll(video.currentTime);
});
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  showEmpty(`<h2>This video can't be played in the browser</h2>
    <p>The codec or container isn't supported (e.g. HEVC/MPEG-2/AVI).<br>Open <b>Match settings → Create 720p proxy</b> to make a light, compatible copy.</p>`);
});

export function showEmpty(html) {
  const el = $('#videoEmpty');
  el.innerHTML = html;
  el.hidden = false;
}

export function loadVideo() {
  const m = S.match;
  rangeEnd = null; seq = null; updateSeqBadge();
  if (!m || !m.video_exists) {
    video.removeAttribute('src');
    video.load();
    S.duration = 0;
    showEmpty(m
      ? `<h2>No video linked</h2><p>Link the match video in Match settings,<br>or tag with a clock only in the <b>Live</b> tab.</p>
         <button class="primary" data-open-settings>Link video…</button>`
      : `<h2>Welcome to MyFootballLens</h2><p>Create a match, link its video, and start tagging.</p>
         <button class="primary" data-new-match>+ New match</button>`);
    emit('duration');
    return;
  }
  $('#videoEmpty').hidden = true;
  video.src = `/video/${m.id}?p=${m.proxy_exists ? 1 : 0}&v=${Date.now()}`;
  video.playbackRate = +$('#tSpeed').value;
}

export function togglePlay() {
  if (!hasVideo()) return;
  if (video.paused) { rangeEnd = rangeEnd && video.currentTime < rangeEnd ? rangeEnd : null; video.play(); }
  else video.pause();
}

export function seek(t, { keepSeq = false } = {}) {
  if (!hasVideo()) return;
  if (!keepSeq) { seq = null; updateSeqBadge(); rangeEnd = null; }
  video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.01));
  if (video.paused) tickAll(video.currentTime);
}

export const step = (dt) => seek(video.currentTime + dt);

export function frame(dir) {
  video.pause();
  seek(video.currentTime + dir / (S.fps || 25));
}

export function setRate(delta) {
  const sel = $('#tSpeed');
  let i = RATES.indexOf(+sel.value);
  i = Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 3 : i) + delta));
  sel.value = RATES[i];
  video.playbackRate = RATES[i];
  toast(`Speed ${RATES[i]}×`, { timeout: 800 });
}

export function playRange(start, end) {
  if (!hasVideo()) return;
  seq = null; updateSeqBadge();
  seek(start, { keepSeq: true });
  rangeEnd = end;
  video.play();
}

export function playSequence(items) {
  items = items.filter((x) => x.end != null);
  if (!hasVideo() || !items.length) return;
  seq = { items, i: 0 };
  rangeEnd = null;
  seek(items[0].start, { keepSeq: true });
  updateSeqBadge();
  video.play();
}

function nextInSequence() {
  seq.i += 1;
  if (seq.i >= seq.items.length) {
    seq = null; video.pause(); updateSeqBadge();
    toast('Playlist finished', { timeout: 1500 });
    return;
  }
  video.currentTime = seq.items[seq.i].start;
  updateSeqBadge();
}

export function stopSequence() {
  if (!seq && rangeEnd == null) return false;
  seq = null; rangeEnd = null; updateSeqBadge();
  return true;
}

function updateSeqBadge() {
  const b = $('#seqBadge');
  if (!seq) { b.hidden = true; return; }
  const it = seq.items[seq.i];
  b.hidden = false;
  b.innerHTML = `▶ Playlist ${seq.i + 1}/${seq.items.length} · ${esc(it.label || '')} <span class="muted">(Esc to stop)</span>`;
  emit('seq', it.id);
}

// ---- transport wiring ----
$('#tPlay').onclick = togglePlay;
$('#tBack').onclick = () => step(-5);
$('#tFwd').onclick = () => step(5);
$('#tFrameB').onclick = () => frame(-1);
$('#tFrameF').onclick = () => frame(1);
$('#tSpeed').onchange = (e) => { video.playbackRate = +e.target.value; };
$('#tVol').oninput = (e) => { video.volume = +e.target.value; };
video.addEventListener('click', () => { if (!document.body.classList.contains('drawing')) togglePlay(); });
