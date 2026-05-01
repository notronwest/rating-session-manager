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


# Phrases that only appear on pb.vision's logged-out marketing hero.
# Title-based detection doesn't work because pb.vision uses the same
# <title> on both the marketing site and the authenticated app.
MARKETING_BODY_MARKERS = (
    "try pb vision for free",
    "no credit card required",
    "get started for free",
    "sign in to pb vision",
)


def is_marketing_page(page: Page) -> bool:
    """True if the rendered body text shows logged-out marketing CTAs."""
    try:
        body_text = page.evaluate(
            "() => (document.body && document.body.innerText || '').slice(0, 12000)"
        ) or ""
    except Exception:
        return False
    body_lower = body_text.lower()
    return any(marker in body_lower for marker in MARKETING_BODY_MARKERS)


def main() -> int:
    log("Opening Chromium with the persistent pb.vision profile.")
    log(f"Profile dir: {PROFILE_DIR}")
    log("")
    log("  ┌──────────────────────────────────────────────────────────────────┐")
    log("  │  Log in to pb.vision in the Chromium window (magic link).       │")
    log("  │                                                                  │")
    log("  │  This script will auto-detect when login succeeds and exit.     │")
    log("  │  No need to manually close the window.                           │")
    log("  │                                                                  │")
    log("  │  To abort: Ctrl-C in this terminal, or ⌘Q the Chromium app.     │")
    log("  └──────────────────────────────────────────────────────────────────┘")
    log("")

    with browser() as (context, page):
        try:
            page.goto("https://pb.vision/")
        except Exception:
            pass

        # Open a separate background tab that quietly polls /library every
        # few seconds. As soon as its page title is no longer the marketing
        # homepage, we know auth is complete. This lets the user just log in
        # naturally — no ⌘Q required.
        try:
            checker = context.new_page()
        except Exception:
            checker = None

        # Wire a `closed` flag via the context's close event AND poll pages as
        # a fallback — Chromium can exit without raising the context close
        # event synchronously, and waiting forever on the event can hang.
        closed = {"flag": False}

        def mark_closed(*_):
            closed["flag"] = True

        context.on("close", mark_closed)

        log("Waiting for login to complete (or for the window to close)...")
        last_check = 0.0
        CHECK_INTERVAL_SEC = 4.0
        AUTH_GRACE_SEC = 2.0  # let any final cookies settle after auth detected
        try:
            while not closed["flag"]:
                try:
                    pages = context.pages
                except Exception:
                    break
                if not pages or all(p.is_closed() for p in pages):
                    break

                now = time.monotonic()
                if checker and not checker.is_closed() and now - last_check >= CHECK_INTERVAL_SEC:
                    last_check = now
                    try:
                        checker.goto("https://pb.vision/library", timeout=12_000)
                        try:
                            checker.wait_for_load_state("networkidle", timeout=8_000)
                        except Exception:
                            pass
                        if not is_marketing_page(checker):
                            log("Auth detected — /library no longer shows marketing CTAs.")
                            time.sleep(AUTH_GRACE_SEC)
                            log("Closing Chromium automatically.")
                            break
                    except Exception:
                        # Network blip or page closed mid-check — try again next tick.
                        pass

                time.sleep(0.5)
        except KeyboardInterrupt:
            log("Interrupted — saving session and exiting.")

    log("Browser closed. Session saved to the persistent profile.")
    log("Try an Upload to PB Vision action from the session page to verify.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
