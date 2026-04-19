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
import time
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
            # cookies persist continuously to the profile dir, so even if
            # close() bombs (e.g. Ctrl-C interrupts the cleanup RPC) the
            # session is already saved. Swallow any shutdown errors.
            try:
                context.close()
            except Exception:
                pass
            except KeyboardInterrupt:
                pass


def main() -> int:
    log("Opening Chromium with the persistent pb.vision profile.")
    log(f"Profile dir: {PROFILE_DIR}")
    log("")
    log("  ┌──────────────────────────────────────────────────────────────────┐")
    log("  │  Log in to pb.vision however you like (magic link, etc.).      │")
    log("  │                                                                  │")
    log("  │  When you're done, EITHER:                                      │")
    log("  │    • Quit Chromium entirely (⌘Q), OR                             │")
    log("  │    • Press Ctrl-C in THIS terminal                               │")
    log("  │                                                                  │")
    log("  │  Closing just the window with the red X does NOT quit Chromium │")
    log("  │  on macOS — the app stays in the dock and this script waits.   │")
    log("  └──────────────────────────────────────────────────────────────────┘")
    log("")

    with browser() as (context, page):
        try:
            page.goto("https://pb.vision/")
        except Exception:
            pass

        # Wire a `closed` flag via the context's close event AND poll pages as
        # a fallback — Chromium can exit without raising the context close
        # event synchronously, and waiting forever on the event can hang.
        closed = {"flag": False}

        def mark_closed(*_):
            closed["flag"] = True

        context.on("close", mark_closed)

        log("Waiting for the Chromium window to close...")
        try:
            while not closed["flag"]:
                try:
                    pages = context.pages
                except Exception:
                    break
                if not pages or all(p.is_closed() for p in pages):
                    break
                time.sleep(1)
        except KeyboardInterrupt:
            log("Interrupted — saving session and exiting.")

    log("Browser closed. Session saved to the persistent profile.")
    log("Try an Upload to PB Vision action from the session page to verify.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
