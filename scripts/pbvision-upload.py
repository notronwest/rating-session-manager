"""
Upload a single video file to pb.vision by driving the web UI with Playwright.

Used as a fallback until the PB Vision Partner API key is obtained. Once we
have an API key, this script should be replaced with @pbvision/partner-sdk.

pb.vision uses magic-link email auth (no password field). We persist the
Chromium profile across runs under `.pbvision-profile/` so that once the user
completes the magic-link flow once, subsequent uploads skip login entirely
until the session cookie expires.

First-run login flow:
  1. Script opens a Chromium window and navigates to pb.vision
  2. Fills PB_VISION_EMAIL into the email field and submits
  3. User checks their email, copies the magic-link URL
  4. User pastes the URL into the Chromium address bar
  5. pb.vision authenticates and the script proceeds

Emits the captured video ID as a single-line JSON object on stdout:
    {"vid": "abc123"}
All progress messages go to stderr so the stdout can be piped safely.

Usage:
    python3 scripts/pbvision-upload.py <video_path> [--headed]

Env:
    PB_VISION_EMAIL       pb.vision login email
    PB_VISION_PASSWORD    (unused — pb.vision is magic-link only, kept in .env
                           for future Partner SDK integration)
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


PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"


@contextmanager
def browser(headless: bool):
    """Yield a Playwright page backed by a persistent Chromium profile.

    Persisting the profile means once the user completes pb.vision's
    magic-link login, future runs reuse the stored session cookies and
    skip login entirely.
    """
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
        # Larger default timeouts so 2GB uploads don't time out.
        context.set_default_timeout(120_000)
        page = context.new_page()
        Stealth().apply_stealth_sync(page)
        try:
            yield page
        finally:
            context.close()


def is_authenticated(page: Page) -> bool:
    """Heuristic check: we're logged in if the current URL isn't /login
    AND we can see the user's library / a file input somewhere."""
    if "/login" in page.url.lower():
        return False
    # If anything on the page suggests an authenticated surface (file input,
    # library link, user menu), treat as logged in.
    if find_file_input(page):
        return True
    # Fall back to looking for common post-login nav hints.
    for sel in [
        'a[href*="library" i]',
        'a[href*="videos" i]',
        'button:has-text("Upload")',
    ]:
        if page.locator(sel).count() > 0:
            return True
    return False


def ensure_logged_in(page: Page, email: str, debug_dir: Path) -> None:
    """Start at pb.vision. If the persistent profile already has a valid
    session, return immediately. Otherwise run the magic-link flow: fill in
    the email, submit, then wait up to 15 min for the user to click the
    magic-link URL (pasted into this Chromium window's address bar)."""

    log("Opening https://pb.vision/")
    page.goto("https://pb.vision/")
    page.wait_for_load_state("networkidle", timeout=30_000)

    if is_authenticated(page):
        log("Already authenticated (reusing persistent profile).")
        return

    log(f"Not authenticated — navigating to {LOGIN_URL}")
    page.goto(LOGIN_URL)
    page.wait_for_load_state("networkidle", timeout=30_000)

    email_sel_candidates = [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="mail" i]',
    ]
    email_input = None
    for sel in email_sel_candidates:
        if page.locator(sel).count() > 0:
            email_input = sel
            break
    if not email_input:
        page.screenshot(path=str(debug_dir / "pbvision-login-no-email.png"), full_page=True)
        raise RuntimeError(
            "Could not find email input on pb.vision login page — see debug/pbvision-login-no-email.png",
        )

    log(f"Filling email ({email}) and submitting the magic-link request...")
    page.fill(email_input, email)

    # Submit — try explicit buttons, then fall back to Enter.
    for sel in [
        'button:has-text("Continue")',
        'button:has-text("Send")',
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

    log("")
    log("  ┌─────────────────────────────────────────────────────────────────┐")
    log("  │  ACTION REQUIRED: check your email for a pb.vision login link. │")
    log("  │                                                                 │")
    log("  │  Copy the link URL and paste it into the Chromium address bar  │")
    log("  │  of the window that just opened. This script will wait up to   │")
    log("  │  15 minutes for you to complete it.                            │")
    log("  │                                                                 │")
    log("  │  After this one-time step, future uploads will reuse the       │")
    log("  │  saved session and skip login automatically.                   │")
    log("  └─────────────────────────────────────────────────────────────────┘")
    log("")

    deadline = time.time() + 15 * 60
    last_log = 0.0
    while time.time() < deadline:
        if is_authenticated(page):
            log(f"Authenticated — now at {page.url}")
            return
        if time.time() - last_log > 30:
            last_log = time.time()
            remaining = int(deadline - time.time())
            log(f"  ...still waiting for magic-link auth ({remaining}s remaining, current URL: {page.url})")
        page.wait_for_timeout(2_000)

    page.screenshot(path=str(debug_dir / "pbvision-magic-link-timeout.png"), full_page=True)
    raise RuntimeError(
        "Timed out (15 min) waiting for magic-link authentication. "
        "See debug/pbvision-magic-link-timeout.png.",
    )


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
    if not email:
        log("PB_VISION_EMAIL must be set in .env")
        return 2

    debug_dir = PROJECT_ROOT / "debug"
    debug_dir.mkdir(exist_ok=True)

    with browser(headless=not headed) as page:
        ensure_logged_in(page, email, debug_dir)
        vid = upload(page, video_path, debug_dir)

    print(json.dumps({"vid": vid}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
