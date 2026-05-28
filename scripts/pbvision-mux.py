"""
Fetch the Mux playback ID for one or more pb.vision videos.

Replaces the "📌 PBV Grab" bookmarklet on rating-hub's analyze page.
pb.vision plays its videos via Mux, and rating-hub needs the playback
ID stored in games.mux_playback_id so embeds work without round-
tripping through pb.vision. The ID lives in pb.vision's Firestore at
`pbv-prod/videos/{vid}.mux.playbackId` and isn't exposed by their
public REST API — but the player loads it client-side, so we can
scrape it by visiting the video page with an authenticated browser
session.

Reuses the persistent Chromium profile set up by pbvision-upload.py,
exactly like pbvision-list.py does. First run on a fresh profile
needs the same magic-link flow.

Emits a JSON array on stdout, one object per requested vid:
    [{"vid": "...", "muxPlaybackId": "..."},
     {"vid": "...", "muxPlaybackId": null, "error": "..."}]
Progress / diagnostics on stderr so callers can pipe stdout.

Usage:
    venv/bin/python scripts/pbvision-mux.py <vid> [<vid> ...]
    venv/bin/python scripts/pbvision-mux.py --headed <vid>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

from playwright.sync_api import sync_playwright  # noqa: E402
from playwright_stealth import Stealth  # noqa: E402

PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"
# Mux playback IDs in stream URLs look like 20-60 alphanumeric chars
# followed by `.m3u8` or a path. Capture group is the ID.
MUX_URL_RE = re.compile(r"stream\.mux\.com/([A-Za-z0-9]{20,60})(?:[./]|$)")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@contextmanager
def browser(headless: bool):
    with sync_playwright() as p:
        launch_kwargs = dict(
            user_data_dir=str(PROFILE_DIR),
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        import shutil as _shutil
        if _shutil.which("google-chrome") or _shutil.which("chrome"):
            launch_kwargs["channel"] = "chrome"
        context = p.chromium.launch_persistent_context(**launch_kwargs)
        context.set_default_timeout(60_000)
        try:
            yield context
        finally:
            context.close()


# Multi-strategy DOM extractor — covers:
#   1. <mux-player playback-id="..."> (the modern Mux web component)
#   2. <video src="https://stream.mux.com/{id}.m3u8">
#   3. Any <source src="stream.mux.com/..."> nested in a <video>
#   4. Page-wide scan for any stream.mux.com URL in HTML (last resort —
#      catches IDs that show up in inline script tags or data-* attrs).
EXTRACT_JS = r"""
() => {
  const re = /stream\.mux\.com\/([A-Za-z0-9]{20,60})/;

  // 1. mux-player web component
  for (const el of document.querySelectorAll('mux-player')) {
    const id = el.getAttribute('playback-id');
    if (id && /^[A-Za-z0-9]{20,60}$/.test(id)) return { source: 'mux-player', id };
  }
  // 2/3. <video> or its <source>
  for (const v of document.querySelectorAll('video')) {
    const m = (v.src || '').match(re);
    if (m) return { source: 'video.src', id: m[1] };
    for (const s of v.querySelectorAll('source')) {
      const sm = (s.src || s.getAttribute('src') || '').match(re);
      if (sm) return { source: 'source.src', id: sm[1] };
    }
  }
  // 4. Page HTML scan — slow but reliable for unusual rendering paths.
  const m = (document.documentElement.outerHTML || '').match(re);
  if (m) return { source: 'html-scan', id: m[1] };

  return null;
}
"""


def fetch_one(context, vid: str) -> dict:
    """Open the video page and return {vid, muxPlaybackId, source}."""
    log(f"[{vid}] opening page…")
    page = context.new_page()
    Stealth().apply_stealth_sync(page)

    # Mirror requests so we can also pick up the ID by network if the
    # DOM extractor misses. The Mux Player loads its m3u8 manifest
    # shortly after mount, which is the most authoritative source.
    intercepted: dict[str, str | None] = {"id": None}

    def on_request(req):  # noqa: ANN001
        if intercepted["id"] is not None:
            return
        m = MUX_URL_RE.search(req.url)
        if m:
            intercepted["id"] = m.group(1)

    page.on("request", on_request)

    url = f"https://pb.vision/video/{vid}/0/overview"
    try:
        page.goto(url, wait_until="domcontentloaded")
    except Exception as e:
        log(f"[{vid}] navigation failed: {e}")
        page.close()
        return {"vid": vid, "muxPlaybackId": None, "error": f"navigation failed: {e}"}

    # Give the player a moment to render + Mux client to fire its
    # manifest request. Polls every 0.5s for up to 12s.
    found: dict | None = None
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            found = page.evaluate(EXTRACT_JS)
        except Exception:
            found = None
        if found and found.get("id"):
            break
        if intercepted["id"]:
            found = {"source": "network", "id": intercepted["id"]}
            break
        time.sleep(0.5)

    page.close()

    if found and found.get("id"):
        log(f"[{vid}] ✓ via {found['source']}: {found['id']}")
        return {"vid": vid, "muxPlaybackId": found["id"], "source": found["source"]}

    log(f"[{vid}] ✗ no playback ID found after 12s")
    return {"vid": vid, "muxPlaybackId": None, "error": "playback ID not found on page"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("vids", nargs="+", help="pb.vision video IDs")
    ap.add_argument("--headed", action="store_true", help="Show the browser window")
    args = ap.parse_args()

    out: list[dict] = []
    with browser(headless=not args.headed) as ctx:
        for vid in args.vids:
            out.append(fetch_one(ctx, vid))

    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
