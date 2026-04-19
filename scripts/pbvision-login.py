"""
One-time interactive login flow for pb.vision.

Opens a Chromium window using the same persistent profile that
pbvision-upload.py / pbvision-list.py use, navigates to pb.vision,
and then hands the window over to you. Do whatever login dance
works — fill your email, paste the magic-link URL from your inbox,
handle any captchas, etc. — then close the window.

When the window closes, Playwright persists the cookies to
.pbvision-profile/ and every subsequent upload / fetch command
skips login until the cookie expires.

Usage:
    npm run pbvision:login
"""

import sys
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

from playwright.sync_api import sync_playwright, Page  # noqa: E402
from playwright_stealth import Stealth  # noqa: E402


PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


@contextmanager
def browser():
    PROFILE_DIR.mkdir(exist_ok=True)
    with sync_playwright() as p:
        launch_kwargs = dict(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        import shutil as _shutil
        if _shutil.which("google-chrome") or _shutil.which("chrome"):
            launch_kwargs["channel"] = "chrome"
        context = p.chromium.launch_persistent_context(**launch_kwargs)
        # No default timeout — user can take as long as they need.
        context.set_default_timeout(0)
        page = context.new_page()
        Stealth().apply_stealth_sync(page)
        try:
            yield context, page
        finally:
            context.close()


def main() -> int:
    log("Opening Chromium with the persistent pb.vision profile.")
    log(f"Profile dir: {PROFILE_DIR}")
    log("")
    log("  ┌──────────────────────────────────────────────────────────────────┐")
    log("  │  Log in to pb.vision however you like (magic link, etc.), then │")
    log("  │  close the browser window. Your session cookies will be saved. │")
    log("  │  Future uploads and list-fetches will skip login automatically. │")
    log("  └──────────────────────────────────────────────────────────────────┘")
    log("")

    with browser() as (context, page):
        try:
            page.goto("https://pb.vision/")
        except Exception:
            pass

        # Wait until the user closes the browser window themselves.
        # `wait_for_event("close")` on the context blocks until the last page
        # closes — i.e. the user quits Chromium.
        try:
            context.wait_for_event("close", timeout=0)
        except Exception:
            # If Playwright raises (e.g. the context already closed), that's
            # fine — cookies are saved on context close anyway.
            pass

    log("Browser closed. Session saved to the persistent profile.")
    log("Try an Upload to PB Vision action from the session page to verify.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
