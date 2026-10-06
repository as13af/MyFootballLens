"""Printable HTML match report (inline SVG, no JS, no PDF library — use the browser's Print → PDF)."""
from html import escape as e

from . import db

L, W = 105, 68
KEY_CODES = ("Goal", "Card", "Penalty", "Substitution", "Key moment")


def pitch(inner: str, w=420, title="") -> str:
    lines = (
        f'<rect x="0" y="0" width="{L}" height="{W}"/>'
        f'<line x1="{L / 2}" y1="0" x2="{L / 2}" y2="{W}"/>'
        f'<circle cx="{L / 2}" cy="{W / 2}" r="9.15"/><circle cx="{L / 2}" cy="{W / 2}" r=".4" class="dot"/>'
        f'<rect x="0" y="13.84" width="16.5" height="40.32"/><rect x="{L - 16.5}" y="13.84" width="16.5" height="40.32"/>'
        f'<rect x="0" y="24.84" width="5.5" height="18.32"/><rect x="{L - 5.5}" y="24.84" width="5.5" height="18.32"/>'
        f'<circle cx="11" cy="{W / 2}" r=".4" class="dot"/><circle cx="{L - 11}" cy="{W / 2}" r=".4" class="dot"/>'
        f'<path d="M16.5 26.69 A9.15 9.15 0 0 1 16.5 41.31"/><path d="M{L - 16.5} 26.69 A9.15 9.15 0 0 0 {L - 16.5} 41.31"/>'
        f'<rect x="-1.5" y="30.34" width="1.5" height="7.32"/><rect x="{L}" y="30.34" width="1.5" height="7.32"/>'
    )
    cap = f"<figcaption>{e(title)}</figcaption>" if title else ""
    return (f'<figure class="pitch"><svg viewBox="-2 -2 {L + 4} {W + 4}" width="{w}">'
            f'<g class="lines">{lines}</g>{inner}</svg>{cap}</figure>')


def flip(x, y):
    return L - x, W - y


def shot_marks(shots, colors) -> str:
    out = []
    for s in shots:
        if s["x"] is None or s["team"] not in ("A", "B"):
            continue
        x, y = (s["x"], s["y"]) if s["team"] == "A" else flip(s["x"], s["y"])
        r = 0.8 + 3.2 * (s["xg"] or 0.05) ** 0.5
        col = colors[s["team"]]
        if s["outcome"] == "goal":
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" fill="{col}" stroke="#111" stroke-width=".35"/>')
        elif s["outcome"] == "on":
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" fill="{col}" fill-opacity=".45" stroke="{col}" stroke-width=".35"/>')
        else:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}" fill="none" stroke="{col}" stroke-width=".35"/>')
    return "".join(out)


def zone_grid(events, team, code, color) -> str:
    cols, rws = 6, 3
    grid = [[0] * cols for _ in range(rws)]
    for ev in events:
        if ev["team"] == team and ev["code"] == code and ev["x"] is not None:
            c = min(cols - 1, int(ev["x"] / (L / cols)))
            r = min(rws - 1, int(ev["y"] / (W / rws)))
            grid[r][c] += 1
    mx = max(max(r) for r in grid) or 1
    cells = []
    for r in range(rws):
        for c in range(cols):
            v = grid[r][c]
            x, y, cw, ch = c * L / cols, r * W / rws, L / cols, W / rws
            cells.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{cw:.2f}" height="{ch:.2f}" fill="{color}" '
                         f'fill-opacity="{0.08 + 0.6 * v / mx:.2f}" stroke="none"/>')
            if v:
                cells.append(f'<text x="{x + cw / 2:.2f}" y="{y + ch / 2 + 1.6:.2f}" class="zn">{v}</text>')
    arrow = '<path d="M40 -0.6 L65 -0.6" class="arrow" marker-end="url(#ah)"/>'
    return "".join(cells) + arrow


def momentum_svg(momentum, colors) -> str:
    if not momentum:
        return "<p class='muted'>No attacking actions tagged yet.</p>"
    # Fixed axis: nine 5-minute slots per half, plus stoppage-time slots when present.
    have = {(b["half"], b["idx"]): b for b in momentum}
    slots = []
    for hf in (1, 2):
        last = max([8] + [b["idx"] for b in momentum if b["half"] == hf])
        for i in range(last + 1):
            slots.append(have.get((hf, i)) or {"half": hf, "idx": i, "A": 0, "B": 0, "label": f"{(45 if hf == 2 else 0) + i * 5}'"})
    n = len(slots)
    bw, h = 50, 60
    mx = max(max(b["A"], b["B"]) for b in slots) or 1
    bars = []
    for i, b in enumerate(slots):
        x = i * bw + 2
        if i and b["half"] != slots[i - 1]["half"]:
            bars.append(f'<line x1="{x - 2}" y1="0" x2="{x - 2}" y2="{2 * h}" stroke="#bbb" stroke-dasharray="3 3"/>')
        ha, hb = (h - 2) * b["A"] / mx, (h - 2) * b["B"] / mx
        bars.append(f'<rect x="{x + 4}" y="{h - ha:.1f}" width="{bw - 12}" height="{ha:.1f}" fill="{colors["A"]}"/>')
        bars.append(f'<rect x="{x + 4}" y="{h + 1}" width="{bw - 12}" height="{hb:.1f}" fill="{colors["B"]}"/>')
        bars.append(f'<text x="{x + bw / 2 - 2}" y="{2 * h + 13}" class="ml">{b["label"]}</text>')
    return (f'<svg viewBox="0 0 {n * bw + 4} {2 * h + 16}" width="100%" style="max-height:170px" class="momentum">'
            f'<line x1="0" y1="{h}" x2="{n * bw + 4}" y2="{h}" stroke="#999" stroke-width=".5"/>{"".join(bars)}</svg>')


def render(match, tags, players, stats) -> str:
    colors = {"A": match["color_a"] or "#3b82f6", "B": match["color_b"] or "#ef4444"}
    A, B = e(match["team_a"]), e(match["team_b"])
    pl = {p["id"]: p for p in players}
    sc = stats["score"]

    def tm(k):
        return {"A": A, "B": B}.get(k, "—")

    key_rows = []
    for t in tags:
        if t["code"] in KEY_CODES:
            p = pl.get(t.get("player_id"))
            key_rows.append(
                f"<tr><td>{db.fmt_clock(db.match_clock(t['start'], match))}</td><td>{e(t['code'])}</td>"
                f"<td><span class='sw' style='background:{colors.get(t['team'], '#999')}'></span>{tm(t['team'])}</td>"
                f"<td>{e(f'#{p['number']} {p['name']}') if p else ''}</td>"
                f"<td>{e(', '.join(l['label'] for l in t['labels']))}</td><td>{e(t.get('note') or '')}</td></tr>")

    def cell(c):
        if not c["n"]:
            return "<td class='num muted'>·</td>"
        pct = f" <small>({c['pct']}%)</small>" if c["pct"] is not None else ""
        return f"<td class='num'>{c['n']}{pct}</td>"

    mat = "".join(f"<tr><td>{e(r['code'])}</td>{cell(r['A'])}{cell(r['B'])}</tr>" for r in stats["matrix"])
    poss = stats["toggles"].get("Possession", {}).get("pctA")
    poss_html = ""
    if poss is not None:
        poss_html = (f"<div class='possbar'><div style='width:{poss}%;background:{colors['A']}'>{poss}%</div>"
                     f"<div style='width:{100 - poss}%;background:{colors['B']}'>{100 - poss}%</div></div>")
    summary = [
        ("Goals", sc["A"], sc["B"]), ("Shots", stats["shots_n"]["A"], stats["shots_n"]["B"]),
        ("On target", stats["on_target"]["A"], stats["on_target"]["B"]), ("xG (lite)", stats["xg"]["A"], stats["xg"]["B"]),
    ]
    sum_html = "".join(f"<tr><td class='num'>{a}</td><th>{k}</th><td class='num'>{b}</td></tr>" for k, a, b in summary)

    zones = ""
    for code in ("Regain", "Turnover", "Press"):
        if any(ev["code"] == code for ev in stats["events"]):
            zones += "".join(pitch(zone_grid(stats["events"], k, code, colors[k]), 300,
                                   f"{code} — {tm(k)} (attacking →)") for k in ("A", "B"))
    players_rows = "".join(
        f"<tr><td>{tm(r['team'])}</td><td>#{e(str(r['number'] or ''))} {e(r['name'] or '')}</td>"
        f"<td class='num'>{r['total']}</td><td>{e(', '.join(f'{k} {v}' for k, v in sorted(r['counts'].items(), key=lambda kv: -kv[1])[:6]))}</td></tr>"
        for r in stats["players"])
    notes = "".join(
        f"<li><b>{db.fmt_clock(db.match_clock(t['start'], match))} {e(t['code'])}</b> ({tm(t['team'])}): {e(t['note'])}</li>"
        for t in tags if (t.get("note") or "").strip())

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(match['title'])} — Match report</title><link rel="stylesheet" href="/static/report.css"></head>
<body><svg width="0" height="0" style="position:absolute"><defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5"
markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#666"/></marker></defs></svg>
<header><div><h1>{e(match['title'])}</h1><p class="muted">{e(match.get('competition') or '')} {e(match.get('date') or '')}</p></div>
<button onclick="print()" class="noprint">Print / Save PDF</button></header>
<section class="score"><div class="team" style="border-color:{colors['A']}">{A}</div>
<div class="big">{sc['A']} – {sc['B']}</div><div class="team" style="border-color:{colors['B']}">{B}</div></section>
{poss_html}
<section class="grid2"><div><h2>Summary</h2><table class="sum">{sum_html}</table></div>
<div><h2>Shot map</h2>{pitch(shot_marks(stats['shots'], colors), 420, f"{A} → attacking right · {B} ← attacking left · size = xG")}</div></section>
<section><h2>Momentum (weighted attacking actions per 5')</h2>{momentum_svg(stats['momentum'], colors)}</section>
<section><h2>Key events</h2><table><thead><tr><th>Time</th><th>Event</th><th>Team</th><th>Player</th><th>Labels</th><th>Note</th></tr></thead>
<tbody>{''.join(key_rows) or '<tr><td colspan=6 class=muted>None tagged</td></tr>'}</tbody></table></section>
<section class="grid2"><div><h2>Event matrix</h2><table><thead><tr><th>Event</th><th>{A}</th><th>{B}</th></tr></thead><tbody>{mat}</tbody></table></div>
<div><h2>Players</h2><table><thead><tr><th>Team</th><th>Player</th><th>Tags</th><th>Top actions</th></tr></thead>
<tbody>{players_rows or '<tr><td colspan=4 class=muted>No players assigned to tags</td></tr>'}</tbody></table></div></section>
{f'<section><h2>Zones</h2><div class="zones">{zones}</div></section>' if zones else ''}
{f'<section><h2>Analyst notes</h2><ul class="notes">{notes}</ul></section>' if notes else ''}
{f'<section><h2>Match notes</h2><p class="prewrap">{e(match["notes"])}</p></section>' if (match.get("notes") or "").strip() else ''}
<footer class="muted">Generated by MyFootballLens · {stats['n_tags']} tags</footer></body></html>"""
