"""Start MyFootballLens:  .venv\\Scripts\\python run.py  [--port 8000] [--no-browser]"""
import argparse
import asyncio
import logging
import socket
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if sys.prefix == sys.base_prefix and (ROOT / ".venv").exists():
    print("Tip: run with the project venv:  .venv\\Scripts\\python run.py")


def free_port(start: int) -> int:
    for port in range(start, start + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("No free port found")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    import uvicorn
    from app import db, export
    from app.main import app

    db.init()
    if not export.ffmpeg_ok():
        print("WARNING: ffmpeg/ffprobe not found on PATH — clip export and proxies are disabled.")
    port = free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print(f"MyFootballLens running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    # The browser keeps the video stream open forever, so don't wait for it on Ctrl+C.
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False,
                            timeout_graceful_shutdown=2)
    server = uvicorn.Server(config)
    # Cancelling that open video stream on exit is expected, not an error worth showing.
    logging.getLogger("uvicorn.error").addFilter(lambda r: "timeout graceful shutdown" not in r.getMessage())

    async def serve():
        asyncio.get_running_loop().set_exception_handler(quiet_disconnects)
        await server.serve()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    print("MyFootballLens stopped.")


def quiet_disconnects(loop, context):
    """Windows' proactor loop logs a traceback whenever the browser aborts a video request
    (seeking, switching video). That's normal, so swallow just those."""
    if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return
    loop.default_exception_handler(context)


if __name__ == "__main__":
    main()
