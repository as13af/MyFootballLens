"""SQLite storage. Plain stdlib sqlite3 — no ORM, one short-lived connection per call."""
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("VAT_DATA_DIR") or ROOT / "data")  # override for tests / a second workspace
DB_PATH = DATA / "analysis.db"
BACKUPS = DATA / "backups"
EXPORTS = DATA / "exports"
DRAWINGS = DATA / "drawings"
PROXIES = DATA / "proxies"
KEEP_BACKUPS = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS templates(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS buttons(
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  code TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'instant', lead REAL DEFAULT 5, lag REAL DEFAULT 5,
  hotkey TEXT DEFAULT '', color TEXT DEFAULT '#94a3b8', team_scope TEXT DEFAULT 'both',
  loc INTEGER DEFAULT 0, loc_end INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS descriptors(
  id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  grp TEXT NOT NULL, label TEXT NOT NULL, hotkey TEXT DEFAULT '', outcome TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS matches(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, date TEXT, competition TEXT,
  video_path TEXT, proxy_path TEXT, template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  team_a TEXT DEFAULT 'Team A', team_b TEXT DEFAULT 'Team B',
  color_a TEXT DEFAULT '#3b82f6', color_b TEXT DEFAULT '#ef4444',
  half1_start REAL DEFAULT 0, half2_start REAL, a_right_h1 INTEGER DEFAULT 1,
  notes TEXT DEFAULT '', created REAL);
CREATE TABLE IF NOT EXISTS players(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team TEXT NOT NULL, number TEXT, name TEXT, position TEXT);
CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  code TEXT NOT NULL, team TEXT, start REAL NOT NULL, end REAL,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  x REAL, y REAL, x2 REAL, y2 REAL, note TEXT DEFAULT '',
  source TEXT DEFAULT 'video', live_half INTEGER, synced INTEGER DEFAULT 1, created REAL);
CREATE INDEX IF NOT EXISTS idx_tags_match ON tags(match_id, start);
CREATE TABLE IF NOT EXISTS tag_labels(
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  grp TEXT NOT NULL, label TEXT NOT NULL, outcome TEXT);
CREATE INDEX IF NOT EXISTS idx_labels_tag ON tag_labels(tag_id);
CREATE TABLE IF NOT EXISTS playlists(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_items(
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS drawings(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  t REAL NOT NULL, hold REAL DEFAULT 3, shapes TEXT NOT NULL, png_path TEXT);

-- Reserved for the future computer-vision plugin (app/plugins). Unused in v1.
CREATE TABLE IF NOT EXISTS tracks(
  id INTEGER PRIMARY KEY, match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  frame INTEGER, t REAL, object_id INTEGER, cls TEXT, team TEXT,
  x_px REAL, y_px REAL, w REAL, h REAL, pitch_x REAL, pitch_y REAL, conf REAL);
CREATE TABLE IF NOT EXISTS calibration(
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE, homography TEXT);
"""


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


@contextmanager
def conn():
    con = _connect()
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def one(cur) -> dict | None:
    r = cur.fetchone()
    return dict(r) if r else None


def backup():
    """Copy the DB into data/backups (sqlite online backup), keep the newest KEEP_BACKUPS."""
    if not DB_PATH.exists():
        return
    BACKUPS.mkdir(parents=True, exist_ok=True)
    dest = BACKUPS / f"analysis-{time.strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    old = sorted(BACKUPS.glob("analysis-*.db"))[:-KEEP_BACKUPS]
    for p in old:
        p.unlink(missing_ok=True)


def init():
    for d in (DATA, BACKUPS, EXPORTS, DRAWINGS, PROXIES):
        d.mkdir(parents=True, exist_ok=True)
    backup()
    with conn() as c:
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript(SCHEMA)
        if not c.execute("SELECT 1 FROM templates LIMIT 1").fetchone():
            tpl = json.loads((Path(__file__).parent / "template_football.json").read_text("utf-8"))
            tid = c.execute("INSERT INTO templates(name) VALUES (?)", (tpl["name"],)).lastrowid
            save_template_items(c, tid, tpl["buttons"], tpl["descriptors"])


# ---------- templates ----------
BUTTON_FIELDS = ("code", "kind", "lead", "lag", "hotkey", "color", "team_scope", "loc", "loc_end")
DESC_FIELDS = ("grp", "label", "hotkey", "outcome")


def save_template_items(c, tid, buttons, descriptors):
    c.execute("DELETE FROM buttons WHERE template_id=?", (tid,))
    c.execute("DELETE FROM descriptors WHERE template_id=?", (tid,))
    for i, b in enumerate(buttons):
        c.execute(
            f"INSERT INTO buttons(template_id,{','.join(BUTTON_FIELDS)},sort) VALUES (?{',?' * len(BUTTON_FIELDS)},?)",
            (tid, *[b.get(f) for f in BUTTON_FIELDS], i))
    for i, d in enumerate(descriptors):
        c.execute(
            f"INSERT INTO descriptors(template_id,{','.join(DESC_FIELDS)},sort) VALUES (?{',?' * len(DESC_FIELDS)},?)",
            (tid, *[d.get(f) for f in DESC_FIELDS], i))


def get_template(c, tid):
    t = one(c.execute("SELECT * FROM templates WHERE id=?", (tid,)))
    if not t:
        return None
    t["buttons"] = rows(c.execute("SELECT * FROM buttons WHERE template_id=? ORDER BY sort", (tid,)))
    t["descriptors"] = rows(c.execute("SELECT * FROM descriptors WHERE template_id=? ORDER BY sort", (tid,)))
    return t


# ---------- tags ----------
def get_tags(c, match_id, tag_ids=None):
    sql = "SELECT * FROM tags WHERE match_id=?"
    args = [match_id]
    if tag_ids is not None:
        sql += f" AND id IN ({','.join('?' * len(tag_ids))})"
        args += list(tag_ids)
    tags = rows(c.execute(sql + " ORDER BY start", args))
    by_id = {t["id"]: t for t in tags}
    for t in tags:
        t["labels"] = []
    if tags:
        lab = c.execute(
            "SELECT l.* FROM tag_labels l JOIN tags t ON t.id=l.tag_id WHERE t.match_id=?", (match_id,))
        for r in lab:
            if r["tag_id"] in by_id:
                by_id[r["tag_id"]]["labels"].append({"grp": r["grp"], "label": r["label"], "outcome": r["outcome"]})
    return tags


def set_labels(c, tag_id, labels):
    c.execute("DELETE FROM tag_labels WHERE tag_id=?", (tag_id,))
    c.executemany("INSERT INTO tag_labels(tag_id,grp,label,outcome) VALUES (?,?,?,?)",
                  [(tag_id, l["grp"], l["label"], l.get("outcome")) for l in labels])


def tag_half(tag, match) -> int:
    if tag.get("source") == "live" and not tag.get("synced"):
        return tag.get("live_half") or 1
    h2 = match.get("half2_start")
    return 2 if h2 is not None and tag["start"] >= h2 else 1


def match_clock(t, match) -> float:
    """Seconds of match clock (2nd half starts at 45:00)."""
    h2 = match.get("half2_start")
    if h2 is not None and t >= h2:
        return 2700 + (t - h2)
    return max(0.0, t - (match.get("half1_start") or 0))


def fmt_clock(sec) -> str:
    sec = int(max(0, sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"
