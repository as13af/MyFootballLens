"""Optional analysis plugins (e.g. a future OpenCV/YOLO tracker). Nothing here is loaded by v1.

Contract for a plugin module `app/plugins/<name>.py`:

    def run(match_id: int, video_path: str, db_path: str, progress_cb) -> None:
        '''Run offline, in its own process, after the match has been recorded.

        Write results into the reserved tables (see app/db.py):
          tracks(match_id, frame, t, object_id, cls, team, x_px, y_px, w, h, pitch_x, pitch_y, conf)
          calibration(match_id, homography)   # JSON 3x3 pixel -> pitch(105x68 m) matrix
        Call progress_cb(fraction_0_to_1, message) periodically.
        '''

Heavy dependencies (ultralytics, opencv-python, torch) belong in `requirements-ai.txt`, installed only
by people who want this. `app.stats.positions(match_id, source="tracks")` already reads `tracks`, so
heatmaps/zones can use tracking data without changing the UI code.
"""
