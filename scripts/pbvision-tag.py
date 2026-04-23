"""
Drive the pb.vision tagging modal to assign known names to a video's
four player slots. Reuses the persistent Chromium profile that
pbvision-upload.py / pbvision-list.py set up, so login is shared.

pb.vision exposes no REST API for tagging — all data is written to
Firestore from the browser, so we drive the MUI Autocomplete UI directly.

There are two flows depending on whether the coach has opened this video
before:

  - First-time: initial "Share for free!" modal → Skip → "Select yourself"
    modal → "I'm not in this video" → tagging modal opens on Player 1,
    advances via "Next Player", ends on "Save & Close".
  - Re-edit: overview loads directly; the coach clicks the pencil on each
    player row, one at a time, each taggingsession ends with "Save & Close".

The script auto-detects which flow is active.

Usage:
    python3 scripts/pbvision-tag.py \
        --video-id <id> \
        --names "Name1,Name2,Name3,Name4" \
        [--headed]

Emits a single JSON object on stdout:
    {
      "videoId": "...",
      "flow": "first-time" | "re-edit",
      "tagged": [{"slot": 0, "name": "..."}, ...],
      "skipped": [{"slot": 2, "name": "...", "reason": "no dropdown match"}]
    }
Progress messages go to stderr.
"""

import argparse
import json
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

from playwright.sync_api import sync_playwright, Page, TimeoutError as PWTimeout  # noqa: E402
from playwright_stealth import Stealth  # noqa: E402


PROFILE_DIR = PROJECT_ROOT / ".pbvision-profile"


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
        context.set_default_timeout(30_000)
        page = context.new_page()
        Stealth().apply_stealth_sync(page)
        try:
            yield page
        finally:
            try:
                context.close()
            except Exception:
                pass


def dismiss_initial_share_modal(page: Page) -> bool:
    """First-time flow only: the initial 'Share for free!' modal has a Skip
    button. Returns True if a Skip was clicked, False if the modal wasn't
    present (re-edit flow)."""
    skip = page.locator('button:has-text("Skip")').first
    try:
        skip.wait_for(state="visible", timeout=3_000)
        skip.click()
        log("Dismissed initial 'Share for free!' modal (Skip).")
        return True
    except PWTimeout:
        return False


def dismiss_select_yourself(page: Page) -> bool:
    """First-time flow only: 'Select yourself' modal — coach isn't playing,
    so click 'I'm not in this video'."""
    btn = page.locator('button.not-in-video-button, button:has-text("I\'m not in this video"), button:has-text("I’m not in this video")').first
    try:
        btn.wait_for(state="visible", timeout=3_000)
        btn.click()
        log("Dismissed 'Select yourself' modal (I'm not in this video).")
        return True
    except PWTimeout:
        return False


def tagging_modal_open(page: Page) -> bool:
    """True if the player-tagging search combobox is currently visible."""
    try:
        page.locator('input[role="combobox"][placeholder="Search..."]').first.wait_for(
            state="visible", timeout=2_000
        )
        return True
    except PWTimeout:
        return False


def open_reedit_modal_for_slot(page: Page, slot_index: int) -> None:
    """Re-edit flow: click the pencil/edit button on Player N to open the
    tagging modal for just that slot. slot_index is 0-based."""
    # The overview page renders 4 clickable player rows in .clickable-player
    # wrappers, each containing a pencil button. Fall back to positional
    # selectors if the class name has changed.
    selectors = [
        ".clickable-player",
        '[class*="clickable-player"]',
        '[class*="player-row"]',
    ]
    for sel in selectors:
        rows = page.locator(sel)
        if rows.count() >= 4:
            rows.nth(slot_index).click()
            log(f"  Clicked player row {slot_index} ({sel})")
            return
    raise RuntimeError(
        f"Could not find 4 clickable player rows to open slot {slot_index} "
        "— page structure may have changed."
    )


def pick_player_in_dropdown(page: Page, name: str) -> str:
    """Type the name into the search combobox, then pick from the dropdown.

    Resolution order:
      1. An option with the 'Recently tagged' badge — picked first since
         these are players we've already tagged on prior videos.
      2. An option whose visible text exactly equals `name` (case-insensitive).
      3. The Add button — create a new pb.vision player with this name.

    Returns a string indicating how the pick was resolved:
      'recently-tagged' | 'exact-match' | 'added-new'
    Raises RuntimeError if none of the above works.
    """
    combo = page.locator('input[role="combobox"][placeholder="Search..."]').first
    combo.click()
    combo.fill("")
    combo.type(name, delay=20)

    # Wait for the listbox to update (MUI debounces ~200ms).
    page.wait_for_timeout(500)

    # Strategy 1: look for an option with "Recently tagged" whose text
    # contains the typed name (case-insensitive).
    recently_opts = page.locator(
        'li[role="option"]:has-text("Recently tagged")'
    )
    for i in range(recently_opts.count()):
        opt = recently_opts.nth(i)
        txt = (opt.inner_text() or "").lower()
        if name.lower() in txt:
            opt.click()
            log(f"  Picked '{name}' via Recently tagged")
            return "recently-tagged"

    # Strategy 2: any option whose exact text matches.
    exact_opts = page.locator('li[role="option"]')
    for i in range(exact_opts.count()):
        opt = exact_opts.nth(i)
        txt = (opt.inner_text() or "").strip()
        if txt.lower() == name.lower():
            opt.click()
            log(f"  Picked '{name}' via exact text match")
            return "exact-match"

    # Strategy 3: click Add to create a new pb.vision player.
    add_btn = page.locator('button:has-text("Add")').first
    if add_btn.count() > 0 and add_btn.is_visible():
        add_btn.click()
        log(f"  No existing match for '{name}' — clicked Add")
        # A follow-up modal asks for the player's email. Skip it.
        skip_selectors = [
            'button.skip-button',
            'button:has-text("I don\'t know their email")',
            'button:has-text("I don’t know their email")',  # curly apostrophe
        ]
        skipped = False
        for sel in skip_selectors:
            try:
                page.locator(sel).first.wait_for(state="visible", timeout=3_000)
                page.locator(sel).first.click()
                skipped = True
                log(f"    Skipped email prompt via {sel}")
                break
            except PWTimeout:
                continue
        if not skipped:
            log("    WARNING: Add clicked but no email-skip button found — "
                "the new-player flow may have changed.")
        return "added-new"

    raise RuntimeError(
        f"No dropdown match for '{name}' and no Add button visible. "
        "pb.vision's tag UI may have changed."
    )


def commit_save_and_close(page: Page) -> None:
    btn = page.locator('button:has-text("Save & Close")').first
    btn.wait_for(state="visible", timeout=10_000)
    btn.click()
    log("  Clicked Save & Close")


def click_next_player(page: Page) -> None:
    btn = page.locator('button:has-text("Next Player")').first
    btn.wait_for(state="visible", timeout=10_000)
    btn.click()
    log("  Clicked Next Player")


def tag_video(page: Page, video_id: str, names: list[str]) -> dict:
    assert len(names) == 4, "tag_video expects exactly 4 names"

    url = f"https://pb.vision/video/{video_id}/0/overview"
    log(f"Navigating to {url}")
    page.goto(url)
    page.wait_for_load_state("networkidle", timeout=30_000)

    tagged: list[dict] = []
    skipped: list[dict] = []

    # Detect flow by probing for the first-time dismissals.
    saw_initial_skip = dismiss_initial_share_modal(page)
    saw_select_yourself = dismiss_select_yourself(page)
    first_time = saw_initial_skip or saw_select_yourself

    if first_time and tagging_modal_open(page):
        flow = "first-time"
        log(f"Detected first-time flow — using Next Player advance")
        for i, name in enumerate(names):
            try:
                how = pick_player_in_dropdown(page, name)
                if i < 3:
                    click_next_player(page)
                else:
                    commit_save_and_close(page)
                tagged.append({"slot": i, "name": name, "via": how})
            except Exception as e:
                log(f"  ERROR on slot {i} ({name}): {e}")
                skipped.append({"slot": i, "name": name, "reason": str(e)})
                # Best-effort: try to escape the modal so the next slot can
                # retry via re-edit flow on the next run.
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
                break
    else:
        flow = "re-edit"
        log("Detected re-edit flow — clicking each player row individually")
        for i, name in enumerate(names):
            try:
                open_reedit_modal_for_slot(page, i)
                if not tagging_modal_open(page):
                    raise RuntimeError("Tagging modal did not open after click")
                how = pick_player_in_dropdown(page, name)
                commit_save_and_close(page)
                # Let the modal close before we click the next row.
                page.wait_for_timeout(500)
                tagged.append({"slot": i, "name": name, "via": how})
            except Exception as e:
                log(f"  ERROR on slot {i} ({name}): {e}")
                skipped.append({"slot": i, "name": name, "reason": str(e)})
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
                continue

    return {
        "videoId": video_id,
        "flow": flow,
        "tagged": tagged,
        "skipped": skipped,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-id", required=True, help="pb.vision video ID")
    parser.add_argument(
        "--names",
        required=True,
        help='Comma-separated names for slots 0-3, e.g. "Alice,Bob,Carol,Dave"',
    )
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    names = [n.strip() for n in args.names.split(",")]
    if len(names) != 4:
        log(f"--names must contain exactly 4 comma-separated names (got {len(names)})")
        return 2

    with browser(headless=not args.headed) as page:
        if "/login" in page.url.lower():
            log("Not authenticated — run `npm run pbvision:login` first to seed the profile.")
            return 3
        result = tag_video(page, args.video_id, names)

    print(json.dumps(result))
    return 0 if not result["skipped"] else 1


if __name__ == "__main__":
    sys.exit(main())
