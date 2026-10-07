"""FastAPI backend: JSON API + video streaming + static UI. Bound to 127.0.0.1 only."""
import csv
import io
import mimetypes
import shutil
import subprocess
import sys
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db, export, report, sportscode_xml, stats

STATIC = db.ROOT / "static"
app = FastAPI(title="MyFootballLens", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def no_stale_static(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        resp.headers["Cache-Control"] = "no-cache"  # revalidate via ETag -> cheap 304s
    return resp


@app.exception_handler(ValueError)
async def value_error(_, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _match(c, mid):
    m = db.one(c.execute("SELECT * FROM matches WHERE id=?", (mid,)))
    if not m:
        raise HTTPException(404, "Match not found")
    return m


def _template_for(c, m):
    tid = m.get("template_id") or (db.one(c.execute("SELECT id FROM templates ORDER BY id LIMIT 1")) or {}).get("id")
    return db.get_template(c, tid) if tid else None


# ---------------- UI ----------------
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------- system ----------------
@app.get("/api/info")
def info():
    ok = export.ffmpeg_ok()
    return {"ffmpeg": ok, "encoder": export.encoder() if ok else None, "data_dir": str(db.DATA)}


PICKER = r"""
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)
kind = sys.argv[1]
types = {'video': [('Video', '*.mp4 *.mov *.mkv *.m4v *.avi *.webm *.mts *.ts'), ('All files', '*.*')],
         'xml': [('XML', '*.xml'), ('All files', '*.*')]}.get(kind, [('All files', '*.*')])
p = filedialog.askopenfilename(title='Select file', filetypes=types)
sys.stdout.write(p or '')
"""


@app.get("/api/pick-file")
def pick_file(kind: str = "video"):
    # Separate process: Tk never loads into the server, and the dialog can't block it.
    r = subprocess.run([sys.executable, "-c", PICKER, kind], capture_output=True, text=True, timeout=600)
    return {"path": r.stdout.strip() or None}


@app.get("/api/probe")
def probe(path: str):
    if not Path(path).is_file():
        raise HTTPException(404, "File not found")
    return export.probe(path)


@app.post("/api/reveal")
def reveal(body: dict = Body(...)):
    p = Path(body.get("path") or db.EXPORTS).resolve()
    if db.DATA.resolve() not in (p, *p.parents):
        raise HTTPException(403, "Only paths inside the data folder can be opened")
    export.open_in_explorer(p)
    return {"ok": True}


# ---------------- matches ----------------
MATCH_FIELDS = ("title", "date", "competition", "video_path", "proxy_path", "template_id", "team_a", "team_b",
                "color_a", "color_b", "half1_start", "half2_start", "a_right_h1", "notes")


@app.get("/api/matches")
def list_matches():
    with db.conn() as c:
        return db.rows(c.execute(
            "SELECT m.id, m.title, m.date, m.team_a, m.team_b, m.video_path, "
            "(SELECT COUNT(*) FROM tags t WHERE t.match_id=m.id) AS n_tags FROM matches m ORDER BY m.id DESC"))


@app.post("/api/matches")
def create_match(body: dict = Body(...)):
    data = {k: body[k] for k in MATCH_FIELDS if k in body}
    data.setdefault("title", "New match")
    with db.conn() as c:
        if not data.get("template_id"):
            data["template_id"] = c.execute("SELECT id FROM templates ORDER BY id LIMIT 1").fetchone()[0]
        data["created"] = time.time()
        cols = ",".join(data)
        mid = c.execute(f"INSERT INTO matches({cols}) VALUES ({','.join('?' * len(data))})",
                        tuple(data.values())).lastrowid
    return get_match(mid)


@app.get("/api/matches/{mid}")
def get_match(mid: int):
    with db.conn() as c:
        m = _match(c, mid)
        m["players"] = db.rows(c.execute("SELECT * FROM players WHERE match_id=? ORDER BY team, CAST(number AS INTEGER)", (mid,)))
        m["template"] = _template_for(c, m)
    m["video_exists"] = bool(m.get("video_path")) and Path(m["video_path"]).is_file()
    m["proxy_exists"] = bool(m.get("proxy_path")) and Path(m["proxy_path"]).is_file()
    return m


@app.patch("/api/matches/{mid}")
def update_match(mid: int, body: dict = Body(...)):
    data = {k: body[k] for k in MATCH_FIELDS if k in body}
    if "video_path" in data and data["video_path"] and not Path(data["video_path"]).is_file():
        raise HTTPException(400, "Video file not found at that path")
    with db.conn() as c:
        _match(c, mid)
        if data:
            c.execute(f"UPDATE matches SET {','.join(f'{k}=?' for k in data)} WHERE id=?", (*data.values(), mid))
    return get_match(mid)


@app.delete("/api/matches/{mid}")
def delete_match(mid: int):
    with db.conn() as c:
        for did, p in c.execute("SELECT id, png_path FROM drawings WHERE match_id=?", (mid,)).fetchall():
            if p:
                Path(p).unlink(missing_ok=True)
            _thumb(did).unlink(missing_ok=True)
            shutil.rmtree(export.anim_dir(did), ignore_errors=True)
        c.execute("DELETE FROM matches WHERE id=?", (mid,))
    return {"ok": True}


@app.put("/api/matches/{mid}/players")
def save_players(mid: int, body: dict = Body(...)):
    incoming = body.get("players", [])
    with db.conn() as c:
        _match(c, mid)
        keep = {p["id"] for p in incoming if p.get("id")}
        for (pid,) in c.execute("SELECT id FROM players WHERE match_id=?", (mid,)).fetchall():
            if pid not in keep:
                c.execute("DELETE FROM players WHERE id=?", (pid,))
        for p in incoming:
            vals = (p.get("team", "A"), str(p.get("number") or ""), p.get("name") or "", p.get("position") or "")
            if p.get("id"):
                c.execute("UPDATE players SET team=?, number=?, name=?, position=? WHERE id=? AND match_id=?",
                          (*vals, p["id"], mid))
            else:
                c.execute("INSERT INTO players(match_id, team, number, name, position) VALUES (?,?,?,?,?)", (mid, *vals))
    return get_match(mid)["players"]


@app.get("/video/{mid}")
def video(mid: int, original: int = 0):
    with db.conn() as c:
        m = _match(c, mid)
    path = m.get("video_path")
    if not original and m.get("proxy_path") and Path(m["proxy_path"]).is_file():
        path = m["proxy_path"]
    if not path or not Path(path).is_file():
        raise HTTPException(404, "Video not found")
    mt = mimetypes.guess_type(path)[0] or "video/mp4"
    if path.lower().endswith((".mkv", ".mts", ".ts")):
        mt = "video/mp4"  # let the browser sniff; Chromium plays H.264-in-MKV this way
    return FileResponse(path, media_type=mt)  # Starlette handles HTTP Range requests


@app.post("/api/matches/{mid}/proxy")
def make_proxy(mid: int):
    return export.public(export.start_proxy(mid))


@app.post("/api/matches/{mid}/proxy/clear")
def clear_proxy(mid: int):
    with db.conn() as c:
        m = _match(c, mid)
        if m.get("proxy_path"):
            Path(m["proxy_path"]).unlink(missing_ok=True)
        c.execute("UPDATE matches SET proxy_path=NULL WHERE id=?", (mid,))
    return {"ok": True}


# ---------------- tags ----------------
TAG_FIELDS = ("code", "team", "start", "end", "player_id", "x", "y", "x2", "y2", "note", "source", "live_half",
              "synced", "moment")


@app.get("/api/matches/{mid}/tags")
def list_tags(mid: int):
    with db.conn() as c:
        return db.get_tags(c, mid)


def _insert_tag(c, mid, body):
    data = {k: body.get(k) for k in TAG_FIELDS if k in body}
    data.setdefault("source", "video")
    data.setdefault("synced", 1)
    data["created"] = time.time()
    tid = c.execute(f"INSERT INTO tags(match_id,{','.join(data)}) VALUES (?{',?' * len(data)})",
                    (mid, *data.values())).lastrowid
    db.set_labels(c, tid, body.get("labels") or [])
    return tid


@app.post("/api/matches/{mid}/tags")
def create_tag(mid: int, body: dict = Body(...)):
    if not body.get("code") or body.get("start") is None:
        raise HTTPException(400, "code and start are required")
    with db.conn() as c:
        _match(c, mid)
        tid = _insert_tag(c, mid, body)
        return db.get_tags(c, mid, [tid])[0]


@app.post("/api/matches/{mid}/tags/bulk")
def create_tags(mid: int, body: dict = Body(...)):
    """Many tags in one transaction (pasted timestamps); returns them in the order given."""
    items = body.get("tags") or []
    if any(not t.get("code") or t.get("start") is None for t in items):
        raise HTTPException(400, "code and start are required")
    with db.conn() as c:
        _match(c, mid)
        ids = [_insert_tag(c, mid, t) for t in items]
        by_id = {t["id"]: t for t in db.get_tags(c, mid, ids)} if ids else {}
        return [by_id[i] for i in ids]


@app.patch("/api/tags/{tid}")
def update_tag(tid: int, body: dict = Body(...)):
    data = {k: body[k] for k in TAG_FIELDS if k in body}
    with db.conn() as c:
        t = db.one(c.execute("SELECT match_id FROM tags WHERE id=?", (tid,)))
        if not t:
            raise HTTPException(404, "Tag not found")
        if data:
            c.execute(f"UPDATE tags SET {','.join(f'{k}=?' for k in data)} WHERE id=?", (*data.values(), tid))
        if "labels" in body:
            db.set_labels(c, tid, body["labels"] or [])
        return db.get_tags(c, t["match_id"], [tid])[0]


@app.delete("/api/tags/{tid}")
def delete_tag(tid: int):
    with db.conn() as c:
        c.execute("DELETE FROM tags WHERE id=?", (tid,))
    return {"ok": True}


@app.post("/api/matches/{mid}/tags/bulk-delete")
def bulk_delete(mid: int, body: dict = Body(...)):
    ids = [int(i) for i in body.get("ids", [])]
    with db.conn() as c:
        c.executemany("DELETE FROM tags WHERE id=? AND match_id=?", [(i, mid) for i in ids])
    return {"deleted": len(ids)}


@app.post("/api/matches/{mid}/sync-live")
def sync_live(mid: int, body: dict = Body(...)):
    """Convert live-clock tags (seconds since each half's kick-off) into video time."""
    h1 = float(body.get("half1_start") or 0)
    h2 = body.get("half2_start")
    with db.conn() as c:
        _match(c, mid)
        c.execute("UPDATE matches SET half1_start=?, half2_start=? WHERE id=?", (h1, h2, mid))
        n = 0
        for t in db.rows(c.execute("SELECT * FROM tags WHERE match_id=? AND source='live' AND synced=0", (mid,))):
            if t["live_half"] == 2 and h2 is None:
                continue
            base = float(h2) if t["live_half"] == 2 else h1
            c.execute("UPDATE tags SET start=?, end=?, synced=1 WHERE id=?",
                      (t["start"] + base, (t["end"] + base) if t["end"] is not None else None, t["id"]))
            n += 1
    return {"synced": n}


# ---------------- drawings ----------------
def _thumb(did) -> Path:
    return db.DRAWINGS / f"{did}_thumb.jpg"


def _drawing_out(c, did):
    d = db.one(c.execute("SELECT id, match_id, t, hold, shapes FROM drawings WHERE id=?", (did,)))
    if d:
        d["has_thumb"] = _thumb(did).exists()
    return d


def _save_drawing_files(c, did, body):
    """`png` = full-size transparent overlay for exports; `thumb` = small JPEG of frame + drawing for the list."""
    if body.get("png"):
        p = db.DRAWINGS / f"{did}.png"
        export.save_image(body["png"], p)
        c.execute("UPDATE drawings SET png_path=? WHERE id=?", (str(p), did))
    if body.get("thumb"):
        export.save_image(body["thumb"], _thumb(did), "image/jpeg")


@app.get("/api/matches/{mid}/drawings")
def list_drawings(mid: int):
    with db.conn() as c:
        out = db.rows(c.execute("SELECT id, match_id, t, hold, shapes FROM drawings WHERE match_id=? ORDER BY t", (mid,)))
    for d in out:
        d["has_thumb"] = _thumb(d["id"]).exists()
    return out


@app.post("/api/matches/{mid}/drawings")
def create_drawing(mid: int, body: dict = Body(...)):
    with db.conn() as c:
        _match(c, mid)
        did = c.execute("INSERT INTO drawings(match_id, t, hold, shapes) VALUES (?,?,?,?)",
                        (mid, float(body["t"]), float(body.get("hold") or 3), body.get("shapes") or "[]")).lastrowid
        _save_drawing_files(c, did, body)
        return _drawing_out(c, did)


@app.get("/api/drawings/{did}/thumb.jpg")
def drawing_thumb(did: int):
    p = _thumb(did)
    if not p.exists():
        raise HTTPException(404, "No thumbnail")
    return FileResponse(p, media_type="image/jpeg")


@app.put("/api/drawings/{did}")
def update_drawing(did: int, body: dict = Body(...)):
    with db.conn() as c:
        d = db.one(c.execute("SELECT * FROM drawings WHERE id=?", (did,)))
        if not d:
            raise HTTPException(404, "Drawing not found")
        c.execute("UPDATE drawings SET t=?, hold=?, shapes=? WHERE id=?",
                  (float(body.get("t", d["t"])), float(body.get("hold", d["hold"])), body.get("shapes", d["shapes"]), did))
        if "shapes" in body:  # old animation frames no longer match; the client uploads new ones if it animates
            shutil.rmtree(export.anim_dir(did), ignore_errors=True)
        _save_drawing_files(c, did, body)
        return _drawing_out(c, did)


@app.post("/api/drawings/{did}/frames")
async def save_drawing_frames(did: int, request: Request, fps: int, intro: int, loop: int, sizes: str):
    """Animated drawing for exports: the body is `intro` + `loop` PNGs back to back, split by `sizes`."""
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM drawings WHERE id=?", (did,)).fetchone():
            raise HTTPException(404, "Drawing not found")
    data = await request.body()
    try:
        lens = [int(n) for n in sizes.split(",")]
    except ValueError:
        raise HTTPException(400, "Bad frame sizes")
    if not (1 <= fps <= 60 and intro >= 0 and loop >= 1 and len(lens) == intro + loop and sum(lens) == len(data)):
        raise HTTPException(400, "Frame data doesn't match its description")
    try:
        export.save_anim(did, data, lens, fps, intro)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.delete("/api/drawings/{did}")
def delete_drawing(did: int):
    with db.conn() as c:
        d = db.one(c.execute("SELECT png_path FROM drawings WHERE id=?", (did,)))
        if d and d["png_path"]:
            Path(d["png_path"]).unlink(missing_ok=True)
        _thumb(did).unlink(missing_ok=True)
        shutil.rmtree(export.anim_dir(did), ignore_errors=True)
        c.execute("DELETE FROM drawings WHERE id=?", (did,))
    return {"ok": True}


# ---------------- playlists ----------------
def _playlists(c, mid):
    pls = db.rows(c.execute("SELECT * FROM playlists WHERE match_id=? ORDER BY id", (mid,)))
    for p in pls:
        p["items"] = db.rows(c.execute(
            "SELECT tag_id, note FROM playlist_items WHERE playlist_id=? ORDER BY pos", (p["id"],)))
    return pls


@app.get("/api/matches/{mid}/playlists")
def list_playlists(mid: int):
    with db.conn() as c:
        return _playlists(c, mid)


def _save_items(c, pid, items):
    c.execute("DELETE FROM playlist_items WHERE playlist_id=?", (pid,))
    c.executemany("INSERT INTO playlist_items(playlist_id, tag_id, pos, note) VALUES (?,?,?,?)",
                  [(pid, int(it["tag_id"]), i, it.get("note") or "") for i, it in enumerate(items)])


@app.post("/api/matches/{mid}/playlists")
def create_playlist(mid: int, body: dict = Body(...)):
    with db.conn() as c:
        _match(c, mid)
        pid = c.execute("INSERT INTO playlists(match_id, name) VALUES (?,?)",
                        (mid, body.get("name") or "Playlist")).lastrowid
        _save_items(c, pid, body.get("items") or [])
        return next(p for p in _playlists(c, mid) if p["id"] == pid)


@app.put("/api/playlists/{pid}")
def update_playlist(pid: int, body: dict = Body(...)):
    with db.conn() as c:
        p = db.one(c.execute("SELECT * FROM playlists WHERE id=?", (pid,)))
        if not p:
            raise HTTPException(404, "Playlist not found")
        if "name" in body:
            c.execute("UPDATE playlists SET name=? WHERE id=?", (body["name"], pid))
        if "items" in body:
            _save_items(c, pid, body["items"])
        return next(x for x in _playlists(c, p["match_id"]) if x["id"] == pid)


@app.delete("/api/playlists/{pid}")
def delete_playlist(pid: int):
    with db.conn() as c:
        c.execute("DELETE FROM playlists WHERE id=?", (pid,))
    return {"ok": True}


# ---------------- templates ----------------
@app.get("/api/templates")
def list_templates():
    with db.conn() as c:
        return db.rows(c.execute(
            "SELECT t.id, t.name, (SELECT COUNT(*) FROM buttons b WHERE b.template_id=t.id) AS n_buttons, "
            "(SELECT COUNT(*) FROM matches m WHERE m.template_id=t.id) AS n_matches FROM templates t ORDER BY t.id"))


@app.get("/api/templates/{tid}")
def get_template(tid: int):
    with db.conn() as c:
        t = db.get_template(c, tid)
    if not t:
        raise HTTPException(404, "Template not found")
    return t


@app.post("/api/templates")
def create_template(body: dict = Body(...)):
    with db.conn() as c:
        tid = c.execute("INSERT INTO templates(name) VALUES (?)", (body.get("name") or "New template",)).lastrowid
        src = db.get_template(c, body["from_id"]) if body.get("from_id") else None
        if src:
            db.save_template_items(c, tid, src["buttons"], src["descriptors"])
        return db.get_template(c, tid)


@app.put("/api/templates/{tid}")
def save_template(tid: int, body: dict = Body(...)):
    buttons = body.get("buttons") or []
    keys = [b.get("hotkey") for b in buttons if b.get("hotkey")] + \
           [d.get("hotkey") for d in body.get("descriptors") or [] if d.get("hotkey")]
    dup = {k for k in keys if keys.count(k) > 1}
    if dup:
        raise HTTPException(400, f"Duplicate hotkeys: {', '.join(sorted(dup))}")
    codes = [b.get("code") for b in buttons]
    if len(codes) != len(set(codes)) or not all(codes):
        raise HTTPException(400, "Every button needs a unique, non-empty name")
    with db.conn() as c:
        if not db.one(c.execute("SELECT id FROM templates WHERE id=?", (tid,))):
            raise HTTPException(404, "Template not found")
        c.execute("UPDATE templates SET name=? WHERE id=?", (body.get("name") or "Template", tid))
        db.save_template_items(c, tid, buttons, body.get("descriptors") or [])
        return db.get_template(c, tid)


@app.delete("/api/templates/{tid}")
def delete_template(tid: int):
    with db.conn() as c:
        if c.execute("SELECT COUNT(*) FROM templates").fetchone()[0] <= 1:
            raise HTTPException(400, "Can't delete the last template")
        c.execute("DELETE FROM templates WHERE id=?", (tid,))
    return {"ok": True}


# ---------------- stats / report / exchange ----------------
def _bundle(mid):
    with db.conn() as c:
        m = _match(c, mid)
        return m, db.get_tags(c, mid), db.rows(c.execute("SELECT * FROM players WHERE match_id=?", (mid,))), _template_for(c, m)


@app.get("/api/matches/{mid}/stats")
def match_stats(mid: int, half: int = 0):
    m, tags, players, tpl = _bundle(mid)
    return stats.compute(m, tags, players, tpl, half or None)


@app.get("/report/{mid}", response_class=HTMLResponse)
def match_report(mid: int, half: int = 0):
    m, tags, players, tpl = _bundle(mid)
    return report.render(m, tags, players, stats.compute(m, tags, players, tpl, half or None))


def _download(content: str, filename: str, media: str):
    return Response(content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def _fname(m, ext):
    import re
    return (re.sub(r"[^\w\- ]+", "", m["title"]).strip() or "match") + ext


@app.get("/api/matches/{mid}/export.xml")
def export_xml(mid: int):
    m, tags, players, tpl = _bundle(mid)
    return _download(sportscode_xml.export_xml(m, tags, players, tpl), _fname(m, ".xml"), "application/xml")


@app.post("/api/matches/{mid}/import-xml")
def import_xml(mid: int, body: dict = Body(...)):
    m, _, players, tpl = _bundle(mid)
    parsed = sportscode_xml.parse_xml(body.get("xml") or "", m, players, (tpl or {}).get("descriptors", []))
    with db.conn() as c:
        for t in parsed:
            _insert_tag(c, mid, t)
    return {"imported": len(parsed)}


@app.get("/api/matches/{mid}/export.csv")
def export_csv(mid: int):
    m, tags, players, _ = _bundle(mid)
    pl = {p["id"]: p for p in players}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "clock", "half", "start", "end", "duration", "code", "team", "team_name", "player_number",
                "player_name", "labels", "x", "y", "x2", "y2", "note", "source"])
    for t in tags:
        p = pl.get(t["player_id"]) or {}
        w.writerow([t["id"], db.fmt_clock(stats.tag_clock(t, m)), db.tag_half(t, m), round(t["start"], 2),
                    round(t["end"], 2) if t["end"] is not None else "",
                    round(t["end"] - t["start"], 2) if t["end"] is not None else "",
                    t["code"], t["team"] or "", {"A": m["team_a"], "B": m["team_b"]}.get(t["team"] or "", ""),
                    p.get("number", ""), p.get("name", ""), "; ".join(f"{l['grp']}:{l['label']}" for l in t["labels"]),
                    *(round(t[k], 2) if t[k] is not None else "" for k in ("x", "y", "x2", "y2")),
                    t["note"] or "", t["source"]])
    return _download("﻿" + buf.getvalue(), _fname(m, ".csv"), "text/csv")  # BOM so Excel reads UTF-8


# ---------------- jobs ----------------
@app.post("/api/export")
def start_export(body: dict = Body(...)):
    if not export.ffmpeg_ok():
        raise HTTPException(400, "ffmpeg/ffprobe not found on PATH")
    ids = [int(i) for i in body.get("tag_ids", [])]
    if not ids:
        raise HTTPException(400, "No clips selected")
    job = export.start_export(int(body["match_id"]), ids, body.get("name") or "Highlights",
                              {"resolution": body.get("resolution", "720"), "captions": body.get("captions", True),
                               "show_notes": body.get("show_notes", True),
                               "drawings": body.get("drawings", True), "logo": body.get("logo", True),
                               "notes": {int(k): str(v) for k, v in (body.get("notes") or {}).items()}})
    return export.public(job)


@app.get("/api/jobs")
def jobs():
    return [export.public(j) for j in sorted(export.JOBS.values(), key=lambda j: -j["started"])][:20]


@app.get("/api/jobs/{jid}")
def job(jid: str):
    j = export.JOBS.get(jid)
    if not j:
        raise HTTPException(404, "Job not found")
    return export.public(j)


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str):
    export.cancel(jid)
    return {"ok": True}
