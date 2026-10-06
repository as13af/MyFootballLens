// Background ffmpeg jobs (exports, proxies): polled only while something is running.
import { api } from './api.js';
import { emit } from './state.js';
import { $, esc, toast } from './ui.js';

const jobs = new Map();
let timer = 0;
let info = null;

export async function systemInfo() {
  if (!info) info = await api.get('/api/info');
  return info;
}

export function track(job) {
  jobs.set(job.id, job);
  render();
  if (!timer) timer = setInterval(poll, 800);
}

async function poll() {
  const running = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued');
  if (!running.length) { clearInterval(timer); timer = 0; return; }
  for (const j of running) {
    try {
      const n = await api.get(`/api/jobs/${j.id}`);
      jobs.set(j.id, n);
      if (n.status !== j.status) finished(n);
    } catch { jobs.delete(j.id); }
  }
  render();
}

function finished(j) {
  if (j.status === 'done') {
    if (j.kind === 'export') toast(`Export ready: ${j.label}`, { action: { label: 'Show file', run: () => reveal(j.out) }, timeout: 10000 });
    else toast('Proxy ready — now playing the lightweight copy', { timeout: 4000 });
    emit('job-done', j);
    setTimeout(() => { jobs.delete(j.id); render(); }, 20000);
  } else if (j.status === 'error') {
    toast(`${j.label} failed: ${j.error}`, { error: true, timeout: 12000 });
    setTimeout(() => { jobs.delete(j.id); render(); }, 8000);
  } else if (j.status === 'cancelled') {
    jobs.delete(j.id);
  }
}

export const reveal = (path) => api.post('/api/reveal', { path }).catch(() => {});

function render() {
  const el = $('#jobsIndicator');
  el.innerHTML = [...jobs.values()].map((j) => {
    const busy = j.status === 'running' || j.status === 'queued';
    return `<div class="job-pill" title="${esc(j.message || '')}">
      <span>${j.kind === 'proxy' ? 'Proxy' : esc(j.label.slice(0, 18))}</span>
      ${busy ? `<progress max="1" value="${j.progress || 0}"></progress><span class="muted">${Math.round((j.progress || 0) * 100)}%</span>
        <button class="ghost small" data-cancel="${j.id}" title="Cancel">✕</button>`
        : j.status === 'done' ? (j.out && j.kind === 'export' ? `<button class="small" data-reveal="${esc(j.id)}">Show ✓</button>` : '✓')
        : `<span class="danger">${esc(j.status)}</span>`}
    </div>`;
  }).join('');
  el.onclick = (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) api.post(`/api/jobs/${c.dataset.cancel}/cancel`);
    const r = e.target.closest('[data-reveal]');
    if (r) reveal(jobs.get(r.dataset.reveal)?.out);
  };
}
