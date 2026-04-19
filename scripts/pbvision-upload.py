"""
Upload a single video file to pb.vision by driving the web UI with Playwright.

Used as a fallback until the PB Vision Partner API key is obtained. Once we
have an API key, this script should be replaced with @pbvision/partner-sdk.

Emits the captured video ID as a single-line JSON object on stdout:
    {"vid": "abc123"}
All progress messages go to stderr so the stdout can be piped safely.

Usage:
    python3 scripts/pbvision-upload.py <video_path> [--headed]

Env:
    PB_VISION_EMAIL       pb.vision login email
    PB_VISION_PASSWORD    pb.vision password
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


LOGIN_URL = "https://pb.vision/login"
# Typical landing pages that contain an upload surface. We try them in order.
UPLOAD_CANDIDATE_URLS = [
    "https://pb.vision/upload",
    "https://pb.vision/library",
    "https://pb.vision/videos",
    "https://pb.vision/",
]

# PB Vision video IDs in URLs look like /videos/<id> or /v/<id>
VIDEO_URL_RE = re.compile(r"/(videos|v)/([A-Za-z0-9_-]{6,})")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@contextmanager
def browser(headless: bool):
    import tempfile
    import shutil

    profile_dir = tempfile.mkdtemp(prefix="pbvision_")
    try:
        with sync_playwright() as p:
            launch_kwargs = dict(
                user_data_dir=profile_dir,
                headless=headless,
                args=["--disable-blink-features=AutomationControlled"],
            )
            import shutil as _shutil
            if _shutil.which("google-chrome") or _shutil.which("chrome"):
                launch_kwargs["channel"] = "chrome"
            context = p.chromium.launch_persistent_context(**launch_kwargs)
            # Larger default timeouts so 2GB uploads don't time out.
            context.set_default_timeout(120_000)
            page = context.new_page()
            Stealth().apply_stealth_sync(page)
            try:
                yield page
            finally:
                context.close()
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


def login(page: Page, email: str, password: str, debug_dir: Path) -> None:
    log(f"Opening {LOGIN_URL}")
    page.goto(LOGIN_URL)
    # Email field — try several common selectors.
    email_sel_candidates = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="mail" i]',
    ]
    password_sel_candidates = [
        'input[type="password"]',
        'input[name="password"]',
    ]

    email_input = None
    for sel in email_sel_candidates:
        if page.locator(sel).count() > 0:
            email_input = sel
            break
    if not email_input:
        page.screenshot(path=str(debug_dir / "pbvision-login-no-email.png"), full_page=True)
        raise RuntimeError("Could not find email input on login page — see debug/pbvision-login-no-email.png")

    password_input = None
    for sel in password_sel_candidates:
        if page.locator(sel).count() > 0:
            password_input = sel
            break
    if not password_input:
        page.screenshot(path=str(debug_dir / "pbvision-login-no-password.png"), full_page=True)
        raise RuntimeError("Could not find password input on login page")

    page.fill(email_input, email)
    page.fill(password_input, password)

    # Submit — try common patterns.
    for sel in [
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Login")',
        'button[type="submit"]',
    ]:
        if page.locator(sel).count() > 0:
            page.click(sel)
            break
    else:
        page.keyboard.press("Enter")

    # Wait for the post-login landing — URL no longer contains /login.
    try:
        page.wait_for_url(lambda u: "/login" not in u.lower(), timeout=45_000)
    except Exception:
        page.screenshot(path=str(debug_dir / "pbvision-login-failed.png"), full_page=True)
        raise RuntimeError("Login did not redirect away from /login — check credentials / see debug/pbvision-login-failed.png")
    log(f"Logged in, now at {page.url}")


def find_file_input(page: Page) -> str | None:
    """Find the first usable file input on the current page, or None."""
    for sel in [
        'input[type="file"][accept*="video"]',
        'input[type="file"]',
    ]:
        if page.locator(sel).count() > 0:
            return sel
    return None


def upload(page: Page, video_path: Path, debug_dir: Path) -> str:
    """Navigate to an upload surface, upload the file, return the captured video ID."""

    file_input = None
    for url in UPLOAD_CANDIDATE_URLS:
        log(f"Looking for upload surface at {url}")
        page.goto(url)
        page.wait_for_load_state("networkidle", timeout=30_000)
        file_input = find_file_input(page)
        if file_input:
            log(f"Found file input on {url} (selector: {file_input})")
            break

    if not file_input:
        page.screenshot(path=str(debug_dir / "pbvision-no-upload-surface.png"), full_page=True)
        raise RuntimeError(
            "No <input type=\"file\"> found on any candidate URL. "
            "The upload surface may be behind a menu — inspect pb.vision manually and "
            "update UPLOAD_CANDIDATE_URLS in this script."
        )

    log(f"Uploading {video_path.name} ({video_path.stat().st_size / 1e9:.2f} GB). This can take a while...")
    start = time.time()
    page.set_input_files(file_input, str(video_path))

    # Wait for the upload to finish. Two strategies, whichever happens first:
    #  (a) URL changes to include /videos/<id> or /v/<id>
    #  (b) A link/anchor with /videos/<id> appears on the page
    deadline = time.time() + 30 * 60  # 30 minutes
    vid = None
    last_progress_log = 0.0
    while time.time() < deadline:
        # Check URL
        m = VIDEO_URL_RE.search(page.url)
        if m:
            vid = m.group(2)
            break
        # Check any anchor hrefs
        hrefs = page.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href)")
        for h in hrefs:
            m = VIDEO_URL_RE.search(h)
            if m:
                vid = m.group(2)
                break
        if vid:
            break
        # Log progress periodically
        if time.time() - last_progress_log > 20:
            last_progress_log = time.time()
            elapsed = int(time.time() - start)
            log(f"  ...waiting for upload to finish ({elapsed}s elapsed, URL: {page.url})")
        page.wait_for_timeout(2_000)

    if not vid:
        page.screenshot(path=str(debug_dir / "pbvision-upload-timeout.png"), full_page=True)
        raise RuntimeError(
            "Timed out waiting for a pb.vision video URL to appear after upload. "
            "See debug/pbvision-upload-timeout.png."
        )

    log(f"Captured video ID: {vid} (upload took {int(time.time() - start)}s)")
    return vid


def main() -> int:
    args = sys.argv[1:]
    if not args:
        log("Usage: python3 scripts/pbvision-upload.py <video_path> [--headed]")
        return 2

    headed = "--headed" in args
    paths = [a for a in args if not a.startswith("--")]
    if len(paths) != 1:
        log("Expected exactly one video path argument")
        return 2
    video_path = Path(paths[0]).expanduser().resolve()
    if not video_path.exists():
        log(f"Video not found: {video_path}")
        return 2

    email = os.environ.get("PB_VISION_EMAIL")
    password = os.environ.get("PB_VISION_PASSWORD")
    if not email or not password:
        log("PB_VISION_EMAIL and PB_VISION_PASSWORD must be set in .env")
        return 2

    debug_dir = PROJECT_ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)

    with browser(headless=not headed) as page:
        login(page, email, password, debug_dir)
        vid = upload(page, video_path, debug_dir)

    print(json.dumps({"vid": vid}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
