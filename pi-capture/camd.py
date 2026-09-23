#!/usr/bin/env python3
"""camd — the WMPC court-camera capture daemon (Track 1).

Runs headless on a Raspberry Pi (Camera Module 3, hardware H.264), replacing OBS. One
service does both jobs the club needs, driven by config + a small HTTP control:

  * TEACHING camera  → records a lesson to the NAS (no live stream).
  * COURT-4 open play → live-streams to YouTube AND records the session on demand.

Nothing here decides WHEN to record — that is the mini's job (it watches the Court Reserve
schedule and calls /record/start|stop at session boundaries), or a human via the same API.
This daemon just does what it's told and keeps the pipeline alive.

## The single-camera constraint
A Pi camera can be opened by ONE process at a time, so we can't run "stream" and "record" as
two captures. Instead ONE `rpicam-vid` feeds ONE `ffmpeg`, and ffmpeg fans out to the RTMP
stream and/or a file. Changing what's wanted (start recording, stop streaming) rebuilds that
one pipeline — a ~1s blip on toggle, which only happens at session boundaries.

## Fail-safe
- Missing camera/tools, or an ffmpeg that dies, is logged and retried by the reconcile loop;
  the control API stays up so the mini can see status and the operator can retry.
- A recording writes to a temp name and is atomically renamed into place on clean stop, so a
  crash never leaves a half-file where the pipeline expects a finished one.
- Outside configured active hours the pipeline is held down (the camera also powers off at
  night by its own schedule; this is the software backstop).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULTS = {
    "court": "court4",
    "output_dir": "/mnt/wmpc-video",      # the NAS share, mounted on the Pi (SMB/cifs)
    "rtmp_base": "rtmp://a.rtmp.youtube.com/live2",
    "youtube_key": "",                    # empty => never stream (teaching camera)
    "active_start": "06:00",              # HH:MM local; pipeline held down outside this window
    "active_end": "22:00",
    "control_port": 8080,
    "rpicam_extra": "--width 1920 --height 1080 --framerate 30 --nopreview",
}


def load_config(path: str | None) -> dict:
    cfg = dict(DEFAULTS)
    if path and Path(path).exists():
        cfg.update(json.loads(Path(path).read_text()))
    # env overrides (systemd EnvironmentFile), CAMD_<UPPERKEY>
    for k in list(cfg):
        env = os.environ.get(f"CAMD_{k.upper()}")
        if env is not None:
            cfg[k] = env
    return cfg


def _hhmm(s: str) -> dt.time:
    h, m = s.split(":")
    return dt.time(int(h), int(m))


class Capture:
    """Owns the single rpicam→ffmpeg pipeline and reconciles it to the desired state."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.want_stream = bool(cfg.get("youtube_key"))  # stream whenever a key is set
        self.want_record = False
        self.record_final: Path | None = None   # where the finished file belongs
        self.record_tmp: Path | None = None
        self.proc: subprocess.Popen | None = None
        self.current_key = None                  # (stream, record, tmp) the proc was built for
        self.last_error: str | None = None
        self.stop_flag = False

    # ── state the API sets ────────────────────────────────────────────────────
    def start_record(self, name: str | None = None) -> dict:
        with self.lock:
            if self.want_record:
                return {"ok": True, "already": True, "file": str(self.record_final)}
            now = dt.datetime.now()
            court = self.cfg["court"]
            day = now.strftime("%Y-%m-%d")
            stamp = now.strftime("%H%M%S")
            base = f"{court}-{stamp}" + (f"-{_safe(name)}" if name else "")
            outdir = Path(self.cfg["output_dir"]) / court / day
            self.record_final = outdir / f"{base}.mp4"
            self.record_tmp = outdir / f".{base}.recording.mp4"
            self.want_record = True
        return {"ok": True, "file": str(self.record_final)}

    def stop_record(self) -> dict:
        with self.lock:
            if not self.want_record:
                return {"ok": True, "already": True}
            self.want_record = False
            final = self.record_final
        return {"ok": True, "file": str(final) if final else None}

    def set_stream(self, on: bool) -> dict:
        if on and not self.cfg.get("youtube_key"):
            return {"ok": False, "error": "no youtube_key configured — this camera doesn't stream"}
        with self.lock:
            self.want_stream = bool(on)
        return {"ok": True, "streaming": bool(on)}

    def status(self) -> dict:
        with self.lock:
            return {
                "court": self.cfg["court"],
                "active_window": f'{self.cfg["active_start"]}-{self.cfg["active_end"]}',
                "in_active_hours": self._in_hours(),
                "streaming": self.want_stream and self.cfg.get("youtube_key") != "" and self._in_hours(),
                "recording": self.want_record,
                "record_file": str(self.record_final) if self.want_record else None,
                "pipeline_up": self.proc is not None and self.proc.poll() is None,
                "last_error": self.last_error,
            }

    # ── the pipeline ──────────────────────────────────────────────────────────
    def _in_hours(self) -> bool:
        now = dt.datetime.now().time()
        return _hhmm(self.cfg["active_start"]) <= now <= _hhmm(self.cfg["active_end"])

    def _desired_key(self):
        active = self._in_hours()
        stream = active and self.want_stream and bool(self.cfg.get("youtube_key"))
        record = active and self.want_record
        return (stream, record, str(self.record_tmp) if record else None)

    def _build_cmd(self, stream: bool, record: bool, tmp: str) -> str:
        rp = f'rpicam-vid -t 0 --codec h264 --inline {self.cfg["rpicam_extra"]} -o -'
        outs = []
        if stream:
            key = self.cfg["youtube_key"]
            outs.append(f'-c copy -f flv {shlex.quote(self.cfg["rtmp_base"].rstrip("/") + "/" + key)}')
        if record:
            outs.append(f'-c copy -f mp4 -movflags +faststart {shlex.quote(tmp)}')
        # one input, one or two outputs
        ff = "ffmpeg -hide_banner -loglevel warning -f h264 -i - " + " ".join(outs)
        return f"{rp} | {ff}"

    def reconcile(self) -> None:
        with self.lock:
            key = self._desired_key()
            up = self.proc is not None and self.proc.poll() is None
            if up and key == self.current_key:
                return  # already in the right state
            # tear down the old pipeline, then publish any finished recording
            if self.proc is not None:
                self._kill()
            self._finalize_record_if_done(key)
            stream, record, tmp = key
            if not stream and not record:
                self.current_key = key
                return  # nothing wanted — camera idle
            cmd = self._build_cmd(stream, record, tmp)
            try:
                if record and tmp:
                    Path(tmp).parent.mkdir(parents=True, exist_ok=True)
                self.proc = subprocess.Popen(cmd, shell=True, preexec_fn=os.setsid)
                self.current_key = key
                self.last_error = None
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"pipeline start failed: {exc}"

    def _finalize_record_if_done(self, new_key) -> None:
        """If we were recording and no longer are, atomically publish the temp file."""
        was_record = self.current_key and self.current_key[1]
        now_record = new_key[1]
        if was_record and not now_record and self.record_tmp and self.record_final:
            try:
                if Path(self.record_tmp).exists():
                    Path(self.record_tmp).rename(self.record_final)
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"finalize failed: {exc}"
            self.record_tmp = None
            self.record_final = None

    def _kill(self) -> None:
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGINT)  # SIGINT lets ffmpeg finalize
            self.proc.wait(timeout=8)
        except Exception:  # noqa: BLE001
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except Exception:
                pass
        self.proc = None

    def run_loop(self) -> None:
        while not self.stop_flag:
            self.reconcile()
            time.sleep(2)
        with self.lock:
            self.want_record = False
            self.reconcile()  # finalize + tear down


def _safe(s: str) -> str:
    return "".join(c for c in s if c.isalnum() or c in "-_")[:40]


class Handler(BaseHTTPRequestHandler):
    cap: Capture = None  # set on the class before serving

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # quieter logs
        pass

    def do_GET(self):
        if self.path in ("/status", "/health"):
            self._send(self.cap.status())
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {}
        if self.path == "/record/start":
            self._send(self.cap.start_record(body.get("name")))
        elif self.path == "/record/stop":
            self._send(self.cap.stop_record())
        elif self.path == "/stream/start":
            self._send(self.cap.set_stream(True))
        elif self.path == "/stream/stop":
            self._send(self.cap.set_stream(False))
        else:
            self._send({"ok": False, "error": "not found"}, 404)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="WMPC court-camera capture daemon")
    ap.add_argument("--config", default=os.environ.get("CAMD_CONFIG", "/etc/wmpc/camera.conf"))
    args = ap.parse_args(argv)
    cfg = load_config(args.config)

    cap = Capture(cfg)
    Handler.cap = cap
    t = threading.Thread(target=cap.run_loop, daemon=True)
    t.start()

    srv = ThreadingHTTPServer(("0.0.0.0", int(cfg["control_port"])), Handler)
    print(json.dumps({"camd": "up", "court": cfg["court"], "port": cfg["control_port"],
                      "streams": bool(cfg.get("youtube_key")), "output_dir": cfg["output_dir"]}))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cap.stop_flag = True
        t.join(timeout=12)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
