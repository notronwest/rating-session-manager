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
from playwright._impl._errors import TargetClosedError  # noqa: E402
from playwright_stealth import Stealth  # noqa: E402


PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"
LIBRARY_CANDIDATE_URLS = [
    "https://pb.vision/library",
    "https://pb.vision/videos",
    "https://pb.vision/",
]
VIDEO_URL_RE = re.compile(r"/(?:video|videos|v)/([A-Za-z0-9_-]{6,})")


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
        try:
            yield context
        finally:
            context.close()


def fresh_page(context) -> Page:
    page = context.new_page()
    Stealth().apply_stealth_sync(page)
    return page


EXTRACT_JS = """
() => {
  const VIDEO_LINK_RE = /\\/(?:video|videos|v)\\/([A-Za-z0-9_-]{6,})/;
  const VIDEO_LINK_SELECTOR =
    'a[href*="/video/"], a[href*="/videos/"], a[href*="/v/"]';

  // Walk up parents from `a`, keeping the deepest ancestor that still
  // refers to exactly ONE unique video. pb.vision typically renders two
  // anchors per card (thumbnail + title), both pointing at the same
  // /video/{vid} — counting unique vids (rather than unique anchors)
  // keeps both inside the card and includes the filename sibling.
  function findCard(a) {
    let card = a;
    let parent = a.parentElement;
    let depth = 0;
    while (parent && parent.tagName !== 'BODY' && depth < 12) {
      const linksInside = parent.querySelectorAll(VIDEO_LINK_SELECTOR);
      const seenVids = new Set();
      for (const l of linksInside) {
        const mm = (l.getAttribute('href') || '').match(VIDEO_LINK_RE);
        if (mm) seenVids.add(mm[1]);
        if (seenVids.size > 1) break;
      }
      if (seenVids.size > 1) break; // would include a different video — stop
      card = parent;
      parent = parent.parentElement;
      depth++;
    }
    return card;
  }

  const out = [];
  const anchors = Array.from(document.querySelectorAll(VIDEO_LINK_SELECTOR));
  for (const a of anchors) {
    const m = (a.getAttribute('href') || '').match(VIDEO_LINK_RE);
    if (!m) continue;

    const card = findCard(a);
    const cardText = (card.innerText || card.textContent || '').trim();
    const anchorText = (a.innerText || a.textContent || '').trim();

    let title = cardText;
    if (!title) title = anchorText;
    else if (anchorText && !title.includes(anchorText)) title = anchorText + '\\n' + title;

    out.push({ vid: m[1], title: title.slice(0, 300) });
  }
  return out;
}
"""


def extract_videos(page: Page) -> list[dict]:
    """Look at every anchor/link on the page and harvest unique videoId + label pairs."""
    try:
        page.wait_for_load_state("networkidle", timeout=20_000)
    except Exception:
        pass
    time.sleep(1.5)

    if page.is_closed():
        log("  Page closed before evaluate — skipping URL")
        return []

    try:
        raw = page.evaluate(EXTRACT_JS)
    except TargetClosedError:
        log("  Page closed during evaluate — skipping URL")
        return []
    except Exception as e:
        log(f"  Evaluate failed: {e}")
        return []
    # Dedupe by vid (keep the longest title for each).
    by_vid: dict[str, dict] = {}
    for row in raw:
        existing = by_vid.get(row["vid"])
        if not existing or len(row.get("title", "")) > len(existing.get("title", "")):
            by_vid[row["vid"]] = row
    return list(by_vid.values())


def find_library(context, debug_dir: Path) -> list[dict]:
    page = fresh_page(context)
    for url in LIBRARY_CANDIDATE_URLS:
        log(f"Checking for videos at {url}")
        if page.is_closed():
            log("  Previous page closed — opening a fresh one")
            page = fresh_page(context)
        try:
            page.goto(url)
        except TargetClosedError:
            log("  Page closed during navigation — opening a fresh one")
            page = fresh_page(context)
            try:
                page.goto(url)
            except Exception as e:
                log(f"  Retry navigation failed: {e}")
                continue
        # Surface where pb.vision actually landed us so silent redirects
        # (e.g. unauth → marketing page) are visible in the session log.
        try:
            actual_url = page.url
            page_title = page.title()
            if actual_url and actual_url != url:
                log(f"  Redirected to {actual_url}")
            if page_title:
                log(f"  Page title: {page_title}")
        except Exception:
            pass
        videos = extract_videos(page)
        if videos:
            log(f"  Found {len(videos)} videos on {url}")
            return videos
    if not page.is_closed():
        try:
            page.screenshot(path=str(debug_dir / "pbvision-list-no-videos.png"), full_page=True)
            html = page.content()
            (debug_dir / "pbvision-list-no-videos.html").write_text(html)
            log(f"  Dumped HTML to {debug_dir / 'pbvision-list-no-videos.html'}")
        except Exception as e:
            log(f"  HTML dump failed: {e}")
    return []


def main() -> int:
    args = sys.argv[1:]
    headed = "--headed" in args

    debug_dir = PROJECT_ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)

    with browser(headless=not headed) as context:
        page = fresh_page(context)
        page.goto("https://pb.vision/")
        try:
            page.wait_for_load_state("networkidle", timeout=20_000)
        except Exception:
            pass
        if "/login" in page.url.lower():
            log("Not authenticated — run scripts/pbvision-upload.py once (with --headed)")
            log("to complete the magic-link login and seed the persistent profile.")
            return 3

        videos = find_library(context, debug_dir)

    print(json.dumps(videos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
