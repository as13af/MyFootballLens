// Pitch geometry (105 × 68 m) for canvas and SVG.
export const L = 105, W = 68;

/** Draw pitch lines into a canvas rect; returns mappers between metres and pixels. */
export function drawPitch(ctx, x0, y0, w, h, { grass = '#334162', line = 'rgba(255,255,255,.55)', stripes = true } = {}) {
  const sx = w / L, sy = h / W;
  const X = (m) => x0 + m * sx, Y = (m) => y0 + m * sy;
  ctx.fillStyle = grass;
  ctx.fillRect(x0, y0, w, h);
  if (stripes) {
    ctx.fillStyle = 'rgba(255,255,255,.025)';
    for (let i = 0; i < 10; i += 2) ctx.fillRect(X(i * L / 10), y0, w / 10, h);
  }
  ctx.strokeStyle = line;
  ctx.lineWidth = Math.max(1, w / 420);
  const rect = (x, y, rw, rh) => ctx.strokeRect(X(x), Y(y), rw * sx, rh * sy);
  rect(0, 0, L, W);
  ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(W)); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(X(L / 2), Y(W / 2), 9.15 * sx, 9.15 * sy, 0, 0, Math.PI * 2); ctx.stroke();
  rect(0, 13.84, 16.5, 40.32); rect(L - 16.5, 13.84, 16.5, 40.32);
  rect(0, 24.84, 5.5, 18.32); rect(L - 5.5, 24.84, 5.5, 18.32);
  ctx.beginPath(); ctx.ellipse(X(11), Y(W / 2), 9.15 * sx, 9.15 * sy, 0, -0.93, 0.93); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(X(L - 11), Y(W / 2), 9.15 * sx, 9.15 * sy, 0, Math.PI - 0.93, Math.PI + 0.93); ctx.stroke();
  ctx.fillStyle = line;
  for (const px of [11, L / 2, L - 11]) { ctx.beginPath(); ctx.arc(X(px), Y(W / 2), Math.max(1.5, sx * .4), 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillRect(X(-1.2), Y(30.34), 1.2 * sx, 7.32 * sy);
  ctx.fillRect(X(L), Y(30.34), 1.2 * sx, 7.32 * sy);
  return {
    toPx: (mx, my) => [X(mx), Y(my)],
    toM: (px, py) => [Math.max(0, Math.min(L, (px - x0) / sx)), Math.max(0, Math.min(W, (py - y0) / sy))],
  };
}

export function arrow(ctx, x1, y1, x2, y2, size = 8) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(a - 0.45), y2 - size * Math.sin(a - 0.45));
  ctx.lineTo(x2 - size * Math.cos(a + 0.45), y2 - size * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
}

/** SVG markup for pitch lines (viewBox should be "-2 -2 109 72"). */
export function pitchSvgLines() {
  return `<g class="pl">
    <rect x="0" y="0" width="${L}" height="${W}"/><line x1="${L / 2}" y1="0" x2="${L / 2}" y2="${W}"/>
    <circle cx="${L / 2}" cy="${W / 2}" r="9.15"/>
    <rect x="0" y="13.84" width="16.5" height="40.32"/><rect x="${L - 16.5}" y="13.84" width="16.5" height="40.32"/>
    <rect x="0" y="24.84" width="5.5" height="18.32"/><rect x="${L - 5.5}" y="24.84" width="5.5" height="18.32"/>
    <path d="M16.5 26.69 A9.15 9.15 0 0 1 16.5 41.31"/><path d="M${L - 16.5} 26.69 A9.15 9.15 0 0 0 ${L - 16.5} 41.31"/>
    <rect x="-1.5" y="30.34" width="1.5" height="7.32"/><rect x="${L}" y="30.34" width="1.5" height="7.32"/></g>`;
}
