"""
Fetch today's CourtReserve schedule and identify rating events.

Uses cr_client from courtreserve-scheduler.

Usage:
    python3 scripts/fetch-schedule.py
    python3 scripts/fetch-schedule.py --date 4/16/2026
    python3 scripts/fetch-schedule.py --days 7          # next 7 days
"""

import sys
import os
import json
from pathlib import Path
from datetime import datetime, timedelta

# Add courtreserve-scheduler to path
SCHEDULER_DIR = Path(__file__).resolve().parent.parent.parent / "courtreserve-scheduler"
sys.path.insert(0, str(SCHEDULER_DIR))

from dotenv import load_dotenv
load_dotenv(SCHEDULER_DIR / ".env", override=True)
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

if "CR_EMAIL" in os.environ and "CR_USERNAME" not in os.environ:
    os.environ["CR_USERNAME"] = os.environ["CR_EMAIL"]
if "CR_BASE_URL" in os.environ and "CR_LOGIN_URL" not in os.environ:
    os.environ["CR_LOGIN_URL"] = os.environ["CR_BASE_URL"].rstrip("/") + "/Account/Login"

from cr_client import browser_session, fetch_schedule  # noqa: E402


def main():
    # Parse args
    target_date = datetime.now().strftime("%-m/%-d/%Y")
    days = 1

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--date" and i + 1 < len(args):
            target_date = args[i + 1]
            i += 2
        elif args[i] == "--days" and i + 1 < len(args):
            days = int(args[i + 1])
            i += 2
        else:
            i += 1

    start_dt = datetime.strptime(target_date, "%m/%d/%Y") if "/" in target_date else datetime.now()
    end_dt = start_dt + timedelta(days=days - 1)
    start = start_dt.strftime("%-m/%-d/%Y")
    end = end_dt.strftime("%-m/%-d/%Y")

    print(f"Fetching schedule: {start} to {end}")

    with browser_session() as page:
        items = fetch_schedule(start, end, page=page)

    print(f"\nGot {len(items)} schedule items\n")

    # Save full schedule
    data_dir = Path(__file__).resolve().parent.parent / "data"
    data_dir.mkdir(exist_ok=True)
    (data_dir / "schedule.json").write_text(json.dumps(items, indent=2), encoding="utf-8")

    # Print all events with key fields
    for item in items:
        event_name = item.get("EventName") or item.get("ReservationType") or "Unknown"
        start_time = item.get("StartDateTime", "")
        end_time = item.get("EndDateTime", "")
        courts = item.get("Courts", "")
        members = item.get("MembersCount", 0)
        event_id = item.get("EventId", "")

        print(f"  [{event_id}] {event_name}")
        print(f"       {start_time} - {end_time} | Courts: {courts} | Members: {members}")
        print()

    # Identify potential rating events
    rating_keywords = ["rating", "rated", "assessment", "eval"]
    rating_events = [
        item for item in items
        if any(kw in (item.get("EventName") or "").lower() or
               kw in (item.get("ReservationType") or "").lower()
               for kw in rating_keywords)
    ]

    if rating_events:
        print(f"\n{'='*60}")
        print(f"RATING EVENTS FOUND: {len(rating_events)}")
        print(f"{'='*60}")
        for item in rating_events:
            event_name = item.get("EventName") or item.get("ReservationType") or "Unknown"
            start_time = item.get("StartDateTime", "")
            courts = item.get("Courts", "")
            members = item.get("MembersCount", 0)
            print(f"  {event_name} | {start_time} | Courts: {courts} | Members: {members}")

        (data_dir / "rating_events.json").write_text(
            json.dumps(rating_events, indent=2), encoding="utf-8"
        )
        print(f"\nSaved to data/rating_events.json")
    else:
        print("\nNo rating events found. Here are all event names for reference:")
        names = sorted(set(
            item.get("EventName") or item.get("ReservationType") or "Unknown"
            for item in items
        ))
        for name in names:
            print(f"  - {name}")
        print("\nWhich of these are rating events? (We can update the filter keywords)")


if __name__ == "__main__":
    main()
