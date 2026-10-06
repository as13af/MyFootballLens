"""Match statistics computed from tags (a match is a few thousand rows at most)."""
import math

from . import db

PITCH_L, PITCH_W = 105.0, 68.0
GOAL_HALF = 3.66
MOMENTUM_W = {"Goal": 5, "Shot": 3, "Chance": 2, "Penalty": 3, "Corner": 1, "Cross": 1,
              "Free kick": 0.5, "Attacking transition": 1}


def tag_clock(tag, match) -> float:
    if tag.get("source") == "live" and not tag.get("synced"):
        return (2700 if tag.get("live_half") == 2 else 0) + max(0.0, tag["start"])
    return db.match_clock(tag["start"], match)


def xg(x, y, header=False) -> float:
    """xG-lite: logistic model on distance and goal-mouth angle. Coordinates: attacking towards x=105."""
    dx, dy = PITCH_L - x, abs(PITCH_W / 2 - y)
    dist = math.hypot(dx, dy)
    a1 = math.atan2(dy - GOAL_HALF, dx)
    a2 = math.atan2(dy + GOAL_HALF, dx)
    angle = abs(a2 - a1)
    v = 1 / (1 + math.exp(-(-1.2 - 0.1 * dist + 2.2 * angle)))
    return round(v * (0.65 if header else 1.0), 3)


def positions(match_id, source="tags", tags=None):
    """Single access point for event positions. `source="tracks"` is reserved for the CV plugin."""
    if source == "tracks":
        with db.conn() as c:
            return db.rows(c.execute(
                "SELECT t, team, pitch_x AS x, pitch_y AS y, cls FROM tracks WHERE match_id=? AND pitch_x IS NOT NULL",
                (match_id,)))
    return [{"id": t["id"], "code": t["code"], "team": t["team"], "x": t["x"], "y": t["y"],
             "x2": t["x2"], "y2": t["y2"], "labels": [l["label"] for l in t["labels"]]}
            for t in tags if t.get("x") is not None]


def _shot_outcome(t):
    labels = {l["label"].lower() for l in t["labels"]}
    if t["code"] == "Goal" or "goal" in labels:
        return "goal"
    for key, out in (("on target", "on"), ("off target", "off"), ("blocked", "blocked")):
        if key in labels:
            return out
    return None


def compute(match, tags, players, template, half=None):
    order = {b["code"]: i for i, b in enumerate(template["buttons"])} if template else {}
    toggles = {b["code"] for b in template["buttons"] if b["kind"] == "toggle"} if template else set()
    pl = {p["id"]: p for p in players}
    if half in (1, 2):
        tags = [t for t in tags if db.tag_half(t, match) == half]

    # --- count matrix with success rates ---
    matrix = {}
    for t in tags:
        row = matrix.setdefault(t["code"], {"code": t["code"], "A": _cell(), "B": _cell(), "N": _cell()})
        cell = row[t["team"] if t["team"] in ("A", "B") else "N"]
        cell["n"] += 1
        outs = {l["outcome"] for l in t["labels"]}
        if "success" in outs:
            cell["s"] += 1
        elif "fail" in outs:
            cell["f"] += 1
        if t.get("end") is not None:
            cell["secs"] += max(0.0, t["end"] - t["start"])
    for row in matrix.values():
        for k in ("A", "B", "N"):
            c = row[k]
            c["pct"] = round(100 * c["s"] / (c["s"] + c["f"])) if c["s"] + c["f"] else None
            c["secs"] = round(c["secs"], 1)
    matrix = sorted(matrix.values(), key=lambda r: (order.get(r["code"], 999), r["code"]))

    # --- toggles / possession ---
    toggle_time = {}
    for r in matrix:
        if r["code"] in toggles:
            a, b = r["A"]["secs"], r["B"]["secs"]
            toggle_time[r["code"]] = {"A": a, "B": b,
                                      "pctA": round(100 * a / (a + b)) if a + b else None}
    phases = [{"code": t["code"], "team": t["team"], "start": t["start"], "end": t["end"]}
              for t in tags if t["code"] in toggles and t.get("end") is not None
              and not (t.get("source") == "live" and not t.get("synced"))]

    # --- shots + xG ---
    shots, goals_used = [], set()
    shot_tags = sorted([t for t in tags if t["code"] in ("Shot", "Goal", "Penalty")], key=lambda t: t["start"])
    for t in shot_tags:
        if t["code"] == "Goal":
            # A Goal tagged next to a Shot is the same attempt: upgrade the shot instead of double counting.
            near = next((s for s in shots if s["team"] == t["team"] and abs(s["_t"] - t["start"]) < 8
                         and s["outcome"] != "goal"), None)
            if near:
                near["outcome"] = "goal"
                if near["x"] is None and t["x"] is not None:
                    near.update(x=t["x"], y=t["y"])
                    near["xg"] = xg(t["x"], t["y"], near["_head"])
                continue
        head = any(l["label"].lower() == "head" for l in t["labels"])
        if t["code"] == "Penalty":
            val = 0.76
        else:
            val = xg(t["x"], t["y"], head) if t["x"] is not None else None
        p = pl.get(t["player_id"])
        shots.append({"id": t["id"], "team": t["team"], "x": t["x"], "y": t["y"], "xg": val,
                      "outcome": _shot_outcome(t), "code": t["code"], "_t": t["start"], "_head": head,
                      "player": f"#{p['number']} {p['name']}".strip() if p else "",
                      "clock": db.fmt_clock(tag_clock(t, match))})
    for s in shots:
        s.pop("_t"), s.pop("_head")
    xg_tot = {k: round(sum(s["xg"] or 0 for s in shots if s["team"] == k), 2) for k in ("A", "B")}
    shot_cnt = {k: sum(1 for s in shots if s["team"] == k) for k in ("A", "B")}
    on_t = {k: sum(1 for s in shots if s["team"] == k and s["outcome"] in ("on", "goal")) for k in ("A", "B")}
    score = {k: sum(1 for t in tags if t["code"] == "Goal" and t["team"] == k) for k in ("A", "B")}

    # --- momentum (weighted attacking actions per 5 min of match clock) ---
    buckets = {}
    for t in tags:
        w = MOMENTUM_W.get(t["code"])
        if not w or t["team"] not in ("A", "B"):
            continue
        h = db.tag_half(t, match)
        rel = tag_clock(t, match) - (2700 if h == 2 else 0)
        key = (h, int(max(0, rel) // 300))
        b = buckets.setdefault(key, {"half": h, "idx": key[1], "A": 0.0, "B": 0.0})
        b[t["team"]] += w
    momentum = [dict(b, label=f"{(45 if b['half'] == 2 else 0) + b['idx'] * 5}'")
                for _, b in sorted(buckets.items())]

    # --- per player ---
    per_player = {}
    for t in tags:
        p = pl.get(t["player_id"])
        if not p:
            continue
        row = per_player.setdefault(p["id"], {"id": p["id"], "team": p["team"], "number": p["number"],
                                              "name": p["name"], "counts": {}, "total": 0})
        row["counts"][t["code"]] = row["counts"].get(t["code"], 0) + 1
        row["total"] += 1

    return {
        "score": score, "matrix": matrix, "toggles": toggle_time, "phases": phases,
        "shots": shots, "xg": xg_tot, "shots_n": shot_cnt, "on_target": on_t,
        "events": positions(match["id"], tags=tags), "momentum": momentum,
        "players": sorted(per_player.values(), key=lambda r: (r["team"], -r["total"])),
        "codes": [r["code"] for r in matrix], "n_tags": len(tags),
    }


def _cell():
    return {"n": 0, "s": 0, "f": 0, "secs": 0.0}
