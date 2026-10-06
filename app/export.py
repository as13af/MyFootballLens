"""ffmpeg-based jobs: highlight exports and lightweight proxies.

Every job runs ffmpeg as a separate, below-normal-priority process, so the Python server
itself never decodes video and stays at a few tens of MB.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from . import db

NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
LOW_PRIO = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
FLAGS = NO_WINDOW | LOW_PRIO
# Caption font: bundled Inter SemiBold (OFL), falling back to system fonts.
FONT = next((str(f) for f in (Path(__file__).parent / "assets" / "fonts" / "Inter-600.ttf",
                              Path("C:/Windows/Fonts/arialbd.ttf"), Path("C:/Windows/Fonts/arial.ttf"),
                              Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")) if f.exists()), None)

ENCODERS = {
    "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
    "h264_qsv": ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "23"],
    "libx264": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"],
}
PIX = {"h264_nvenc": "yuv420p", "h264_qsv": "nv12", "libx264": "yuv420p"}
_encoder = None
_enc_lock = threading.Lock()


def ffmpeg_ok() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def encoder() -> str:
    """First H.264 encoder that actually works on this machine (cached)."""
    global _encoder
    with _enc_lock:
        if _encoder:
            return _encoder
        for name in ("h264_nvenc", "h264_qsv"):
            r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                "color=c=black:s=640x360:d=0.2", *ENCODERS[name], "-f", "null", "-"],
                               capture_output=True, creationflags=NO_WINDOW)
            if r.returncode == 0:
                _encoder = name
                break
        else:
            _encoder = "libx264"
        return _encoder


def probe(path: str) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
                       capture_output=True, text=True, creationflags=NO_WINDOW)
    if r.returncode != 0:
        raise ValueError(r.stderr.strip() or "ffprobe failed")
    info = json.loads(r.stdout)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not v:
        raise ValueError("No video stream found")
    num, _, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "25/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 25.0
    fmt = info.get("format", {})
    return {
        "duration": float(fmt.get("duration") or v.get("duration") or 0),
        "width": int(v["width"]), "height": int(v["height"]),
        "fps": round(fps, 3) if 1 < fps < 121 else 25.0,
        "vcodec": v.get("codec_name"), "acodec": a.get("codec_name") if a else None,
        "has_audio": a is not None, "container": fmt.get("format_name", ""),
        "browser_ok": v.get("codec_name") in ("h264", "vp8", "vp9", "av1")
                      and any(k in fmt.get("format_name", "") for k in ("mp4", "mov", "webm", "matroska")),
    }


# ---------------- job registry ----------------
JOBS: dict[str, dict] = {}


def _new_job(kind, label) -> dict:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "label": label, "status": "queued", "progress": 0.0,
           "message": "", "out": None, "error": None, "started": time.time(), "_proc": None, "_cancel": False}
    JOBS[jid] = job
    return job


def public(job) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def cancel(jid):
    job = JOBS.get(jid)
    if job:
        job["_cancel"] = True
        p = job.get("_proc")
        if p and p.poll() is None:
            p.kill()


class Cancelled(Exception):
    pass


def _run_ffmpeg(job, args, seg_dur, done_before, total):
    """Run ffmpeg, updating job progress from -progress output."""
    if job["_cancel"]:
        raise Cancelled()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostats", "-progress", "pipe:1", *args]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", creationflags=FLAGS)
    job["_proc"] = p
    for line in p.stdout:
        m = re.match(r"out_time_us=(\d+)", line)
        if m and total > 0:
            cur = min(seg_dur, int(m.group(1)) / 1e6)
            job["progress"] = round(min(0.99, (done_before + cur) / total), 4)
    err = p.stderr.read()
    p.wait()
    job["_proc"] = None
    if job["_cancel"]:
        raise Cancelled()
    if p.returncode != 0:
        raise RuntimeError(err.strip()[-1500:] or f"ffmpeg exited with {p.returncode}")


def _start(job, fn, *a):
    def runner():
        job["status"] = "running"
        try:
            fn(job, *a)
            job["status"], job["progress"] = "done", 1.0
        except Cancelled:
            job["status"] = "cancelled"
        except Exception as e:  # surfaced to UI
            job["status"], job["error"] = "error", str(e)
    threading.Thread(target=runner, daemon=True).start()
    return job


# ---------------- filter helpers ----------------
def _esc(p) -> str:
    """Escape a path/value for use inside a quoted ffmpeg filter option."""
    return str(p).replace("\\", "/").replace(":", "\\:").replace("'", "'\\\\''")


def _scale(w, h) -> str:
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")


def _caption(textfile, h) -> str:
    if not FONT:
        return ""
    fs = max(16, round(h / 26))
    m = round(fs * 1.1)  # margin from the frame edge, outside the box padding
    # Top-right corner; text_align=R right-aligns the note line under the caption line.
    return (f",drawtext=fontfile='{_esc(FONT)}':textfile='{_esc(textfile)}':expansion=none:"
            f"fontsize={fs}:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw={round(fs * .45)}:"
            f"line_spacing={round(fs * .3)}:text_align=R:x=w-tw-{m}:y={m}")


WATERMARK = Path(__file__).parent / "assets" / "watermark.png"   # made from logo/2131.png, white removed


def _logo(index, h) -> str:
    """Overlay the transparent logo (input `index`) bottom-right: ~12% of the frame height, 85% opacity.
    Expects the main chain to end in [v0]; produces [v]."""
    size = max(48, round(h * 0.12))
    size -= size % 2
    m = round(h * 0.025)
    return (f";[{index}:v]scale={size}:{size}:flags=lanczos,format=rgba,colorchannelmixer=aa=0.85[lg];"
            f"[v0][lg]overlay=W-w-{m}:H-h-{m}[v]")


def _out_size(info, resolution):
    target = {"1080": 1080, "720": 720, "480": 480}.get(str(resolution))
    h = min(info["height"], target) if target else info["height"]
    h -= h % 2
    w = round(info["width"] * h / info["height"])
    w -= w % 2
    return w, h


# ---------------- highlight export ----------------
def start_export(match_id: int, tag_ids: list[int], name: str, opts: dict) -> dict:
    job = _new_job("export", name)
    return _start(job, _export, match_id, tag_ids, name, opts)


def _export(job, match_id, tag_ids, name, opts):
    with db.conn() as c:
        match = db.one(c.execute("SELECT * FROM matches WHERE id=?", (match_id,)))
        tags = {t["id"]: t for t in db.get_tags(c, match_id, tag_ids)}
        players = {p["id"]: p for p in db.rows(c.execute("SELECT * FROM players WHERE match_id=?", (match_id,)))}
        drawings = db.rows(c.execute("SELECT * FROM drawings WHERE match_id=? ORDER BY t", (match_id,)))
    if not match or not match.get("video_path") or not Path(match["video_path"]).exists():
        raise ValueError("Match video not found — set the video path in Match settings.")
    src = match["video_path"]
    info = probe(src)
    enc = encoder()
    job["message"] = f"Encoder: {enc}"
    w, h = _out_size(info, opts.get("resolution", "720"))
    fps = info["fps"]
    captions = opts.get("captions", True)
    use_drawings = opts.get("drawings", True)
    use_logo = opts.get("logo", True) and WATERMARK.exists()
    pix = PIX[enc]
    venc = [*ENCODERS[enc], "-pix_fmt", pix, "-r", f"{fps}", "-g", str(round(fps * 2))]
    aenc = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]

    # Build the segment list: plain spans and freeze-frames for drawings.
    clips = [tags[i] for i in tag_ids if i in tags and tags[i].get("end") is not None]
    if not clips:
        raise ValueError("No finished clips to export.")
    segs = []
    for n, t in enumerate(clips, 1):
        s, e = max(0.0, t["start"]), min(info["duration"] or 1e12, t["end"])
        if e - s < 0.2:
            continue
        cap = _caption_text(t, match, players, n, len(clips), opts.get("notes", {}).get(t["id"]))
        pts = [d for d in drawings if use_drawings and s <= d["t"] < e and d.get("png_path")
               and Path(d["png_path"]).exists()]
        cur = s
        for d in pts:
            if d["t"] - cur > 0.05:
                segs.append({"type": "span", "s": cur, "e": d["t"], "cap": cap})
            segs.append({"type": "freeze", "t": d["t"], "hold": max(0.5, d.get("hold") or 3),
                         "png": d["png_path"], "cap": cap})
            cur = d["t"]
        if e - cur > 0.05:
            segs.append({"type": "span", "s": cur, "e": e, "cap": cap})
    total = sum((x["e"] - x["s"]) if x["type"] == "span" else x["hold"] for x in segs)

    tmp = Path(tempfile.mkdtemp(prefix="vat_export_"))
    try:
        files, done = [], 0.0
        for i, sg in enumerate(segs):
            out = tmp / f"seg{i:04d}.mp4"
            capfile = tmp / f"cap{i:04d}.txt"
            # newline="\n": Windows "\r\n" would show up as an extra blank line in drawtext
            capfile.write_text(sg["cap"], encoding="utf-8", newline="\n")
            cap_f = _caption(capfile, h) if captions else ""
            if sg["type"] == "span":
                dur = sg["e"] - sg["s"]
                inputs = ["-ss", f"{sg['s']:.3f}", "-t", f"{dur:.3f}", "-i", src]
                if info["has_audio"]:
                    amap = ["-map", "0:a:0"]
                else:
                    inputs += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
                    amap = ["-map", "1:a"]
                vf = f"[0:v]{_scale(w, h)}{cap_f},fps={fps}"
                if use_logo:
                    vf += "[v0]" + _logo(2 if not info["has_audio"] else 1, h)
                    inputs += ["-i", str(WATERMARK)]
                else:
                    vf += "[v]"
                args = [*inputs, "-filter_complex", vf, "-map", "[v]", *amap, *venc, *aenc,
                        "-t", f"{dur:.3f}", str(out)]
            else:
                dur = sg["hold"]
                frame = tmp / f"frame{i:04d}.png"
                _run_ffmpeg(job, ["-ss", f"{sg['t']:.3f}", "-i", src, "-frames:v", "1", str(frame)], 0, done, total)
                # Drawing PNG may come from the proxy, so scale it to the source frame size.
                vf = (f"[1:v]format=rgba,scale={info['width']}:{info['height']}[ov];[0:v][ov]overlay=0:0,"
                      f"{_scale(w, h)}{cap_f},fps={fps}")
                logo_in = []
                if use_logo:
                    vf += "[v0]" + _logo(3, h)
                    logo_in = ["-i", str(WATERMARK)]
                else:
                    vf += "[v]"
                args = ["-loop", "1", "-framerate", f"{fps}", "-t", f"{dur:.3f}", "-i", str(frame),
                        "-i", sg["png"], "-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo",
                        *logo_in, "-filter_complex", vf, "-map", "[v]", "-map", "2:a", *venc, *aenc,
                        "-t", f"{dur:.3f}", str(out)]
            job["message"] = f"Encoder: {enc} · segment {i + 1}/{len(segs)}"
            _run_ffmpeg(job, args, dur, done, total)
            done += dur
            files.append(out)

        listfile = tmp / "list.txt"
        listfile.write_text("".join(f"file '{f.as_posix()}'\n" for f in files), encoding="utf-8")
        safe = re.sub(r"[^\w\- ]+", "", name).strip() or "highlights"
        final = db.EXPORTS / f"{safe} {time.strftime('%Y%m%d-%H%M%S')}.mp4"
        job["message"] = "Joining clips…"
        _run_ffmpeg(job, ["-f", "concat", "-safe", "0", "-i", str(listfile), "-c", "copy",
                          "-movflags", "+faststart", str(final)], 0, total, total)
        job["out"] = str(final)
        job["message"] = f"Done · {len(clips)} clips · {enc}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _caption_text(t, match, players, n, count, clip_note=None) -> str:
    team = {"A": match["team_a"], "B": match["team_b"]}.get(t.get("team") or "", "")
    parts = [f"{n}/{count}", db.fmt_clock(db.match_clock(t["start"], match)), t["code"]]
    if team:
        parts.append(team)
    p = players.get(t.get("player_id"))
    if p:
        parts.append(f"#{p['number']} {p['name']}".strip())
    labels = ", ".join(l["label"] for l in t.get("labels", []))
    if labels:
        parts.append(labels)
    text = "  ·  ".join(parts)
    note = (clip_note or t.get("note") or "").strip()  # playlist clip note wins over the tag note
    if note:
        text += "\n" + note[:120]
    return text


# ---------------- proxy ----------------
def start_proxy(match_id: int) -> dict:
    job = _new_job("proxy", f"Proxy for match {match_id}")
    return _start(job, _proxy, match_id)


def _proxy(job, match_id):
    with db.conn() as c:
        m = db.one(c.execute("SELECT * FROM matches WHERE id=?", (match_id,)))
    if not m or not m.get("video_path") or not Path(m["video_path"]).exists():
        raise ValueError("Match video not found.")
    info = probe(m["video_path"])
    enc = encoder()
    w, h = _out_size(info, "720")
    out = db.PROXIES / f"match{match_id}_720p.mp4"
    job["message"] = f"Encoder: {enc}"
    amap = ["-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2"] if info["has_audio"] else []
    # Keyframe every second -> very fast, precise seeking while tagging.
    _run_ffmpeg(job, ["-i", m["video_path"], "-map", "0:v:0", "-vf", f"scale={w}:{h},setsar=1",
                      *ENCODERS[enc], "-pix_fmt", PIX[enc], "-g", str(round(info["fps"])),
                      *amap, "-movflags", "+faststart", str(out)],
                info["duration"], 0, info["duration"])
    with db.conn() as c:
        c.execute("UPDATE matches SET proxy_path=? WHERE id=?", (str(out), match_id))
    job["out"] = str(out)


def save_image(data_url: str, path: Path, mime="image/png"):
    head, _, b64 = data_url.partition(",")
    if mime not in head:
        raise ValueError(f"Expected {mime} data URL")
    path.write_bytes(base64.b64decode(b64))


def open_in_explorer(path: Path):
    if sys.platform == "win32":
        if path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path))  # noqa
