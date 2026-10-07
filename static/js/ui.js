// Small DOM + formatting helpers shared by every module.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function fmtTime(sec, tenths = true) {
  if (sec == null || !isFinite(sec)) return '–';
  const neg = sec < 0; sec = Math.abs(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${ss}`;
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** Parse "1:02:03.5", "12:30" or "754.2" into seconds. */
export function parseTime(str) {
  if (str == null || String(str).trim() === '') return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((n) => isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg, { error = false, action = null, timeout = 2600, color = null } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = (color ? `<span class="sw" style="background:${esc(color)}"></span>` : '') + `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'small'; b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
  $('#toasts').append(el);
  const box = $('#toasts');
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), error ? Math.max(timeout, 6000) : timeout);
}

export const errToast = (e) => toast(e?.message || String(e), { error: true });

/** Open the shared <dialog>. `onSubmit` returns false to keep it open. */
export function dialog({ title, body, okLabel = 'Save', onSubmit, extraFoot = '', wide = false, onOpen }) {
  const dlg = $('#dlg');
  dlg.style.width = wide ? 'min(1080px, calc(100vw - 32px))' : '';
  dlg.innerHTML = `
    <form method="dialog">
      <div class="dlg-head"><h2 style="font-size:15px">${esc(title)}</h2><button type="button" class="ghost" data-close>✕</button></div>
      <div class="dlg-body">${body}</div>
      <div class="dlg-foot">${extraFoot}<span class="spacer"></span>
        <button type="button" class="ghost" data-close>Cancel</button>
        ${onSubmit ? `<button type="submit" class="primary">${esc(okLabel)}</button>` : ''}
      </div>
    </form>`;
  const form = $('form', dlg);
  $$('[data-close]', dlg).forEach((b) => (b.onclick = () => dlg.close()));
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const keep = await onSubmit?.(form);
      if (keep !== false) dlg.close();
    } catch (err) { errToast(err); }
  };
  dlg.showModal();
  onOpen?.(dlg);
  return dlg;
}

export function confirmBox(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = dialog({
      title: 'Confirm', body: `<p>${esc(message)}</p>`, okLabel,
      onSubmit: () => { resolve(true); },
    });
    // A dialog closed just before this one (same <dialog> element) fires its 'close' event late;
    // ignore it while this confirm box is still open, otherwise it would count as "Cancel".
    const onClose = () => {
      if (dlg.open) return;
      dlg.removeEventListener('close', onClose);
      resolve(false);
    };
    dlg.addEventListener('close', onClose);
  });
}

/** Shared floating tooltip for charts. */
let tipEl;
export function tip(html, ev) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.append(tipEl); }
  if (!html) { tipEl.hidden = true; return; }
  tipEl.hidden = false;
  tipEl.innerHTML = html;
  const pad = 14, r = tipEl.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
}

/**
 * Re-render a panel without moving its lists. Rebuilding with innerHTML recreates the scrolling
 * boxes inside it at the top, so clicking row 9 would otherwise jump the list back to row 1.
 */
export function keepScroll(el, render) {
  const boxes = () => [el, ...el.querySelectorAll('.pl-items, .pl-list')];
  const before = boxes().map((b) => b.scrollTop);
  render();
  boxes().forEach((b, i) => { if (before[i] != null) b.scrollTop = before[i]; });
}

export function isTyping(ev) {
  const t = ev.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) && t.type !== 'checkbox' && t.type !== 'range';
}

/** Size a canvas to its CSS box at device pixel ratio; returns ctx scaled to CSS px. */
export function fitCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (w != null) canvas.style.width = w + 'px';
  if (h != null) canvas.style.height = h + 'px';
  const cw = w ?? canvas.clientWidth, ch = h ?? canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cw, h: ch };
}
