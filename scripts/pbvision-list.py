"""
Scrape pb.vision's library page for the current user's recent uploads.
Reuses the persistent Chromium profile set up by pbvision-upload.py so
login is shared. First run on a fresh profile will require the same
magic-link flow documented in that file.

Emits a JSON array on stdout; one object per video found:
    [{"vid": "...", "title": "..."}, ...]
Progress goes to stderr so callers can pipe stdout.

Usage:
    python3 scripts/pbvision-list.py            (headless — only works after
                                                  a prior successful headed
                                                  login saved the profile)
    python3 scripts/pbvision-list.py --headed
"""

import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

from playwright.sync_api import sync_playwright, Page  # noqa: E402
from playwright_stealth import Stealth  # noqa: E402


PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"
LIBRARY_CANDIDATE_URLS = [
    "https://pb.vision/library",
    "https://pb.vision/videos",
    "https://pb.vision/",
]
VIDEO_URL_RE = re.compile(r"/(?:videos|v)/([A-Za-z0-9_-]{6,})")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@contextmanager
def browser(headless: bool):
    PROFILE_DIR.mkdir(exist_ok=True)
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
        page = context.new_page()
        Stealth().apply_stealth_sync(page)
        try:
            yield page
        finally:
            context.close()


def extract_videos(page: Page) -> list[dict]:
    """Look at every anchor/link on the page and harvest unique videoId + label pairs."""
    # Wait briefly for client-rendered library to settle.
    try:
        page.wait_for_load_state("networkidle", timeout=20_000)
    except Exception:
        pass
    time.sleep(1.5)

    raw = page.evaluate(
        """
        () => {
          const out = [];
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          for (const a of anchors) {
            const m = a.href.match(/\\/(?:videos|v)\\/([A-Za-z0-9_-]{6,})/);
            if (!m) continue;
            // Best-effort title: prefer the anchor's own text, fall back to an
            // ancestor card's text content (first 120 chars).
            let title = (a.innerText || a.textContent || '').trim();
            if (!title || title.length < 2) {
              const card = a.closest('li,article,div[role="row"],div');
              title = card ? (card.innerText || '').trim().slice(0, 120) : '';
            }
            out.push({ vid: m[1], title });
          }
          return out;
        }
        """
    )
    # Dedupe by vid (keep the longest title for each).
    by_vid: dict[str, dict] = {}
    for row in raw:
        existing = by_vid.get(row["vid"])
        if not existing or len(row.get("title", "")) > len(existing.get("title", "")):
            by_vid[row["vid"]] = row
    return list(by_vid.values())


def find_library(page: Page, debug_dir: Path) -> list[dict]:
    for url in LIBRARY_CANDIDATE_URLS:
        log(f"Checking for videos at {url}")
        page.goto(url)
        videos = extract_videos(page)
        if videos:
            log(f"  Found {len(videos)} videos on {url}")
            return videos
    page.screenshot(path=str(debug_dir / "pbvision-list-no-videos.png"), full_page=True)
    return []


def main() -> int:
    args = sys.argv[1:]
    headed = "--headed" in args

    debug_dir = PROJECT_ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)

    with browser(headless=not headed) as page:
        # Go to the root first to detect login state.
        page.goto("https://pb.vision/")
        try:
            page.wait_for_load_state("networkidle", timeout=20_000)
        except Exception:
            pass
        if "/login" in page.url.lower():
            log("Not authenticated — run scripts/pbvision-upload.py once (with --headed)")
            log("to complete the magic-link login and seed the persistent profile.")
            return 3

        videos = find_library(page, debug_dir)

    print(json.dumps(videos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
