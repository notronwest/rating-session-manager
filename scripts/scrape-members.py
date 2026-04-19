"""
Scrape member list from CourtReserve admin panel.

Uses cr_client from courtreserve-scheduler for login (handles Cloudflare).

Outputs the member list as a JSON array to stdout; all log messages go
to stderr so the output can be piped into other tools (e.g. sync-members.ts).

Usage:
    python3 scripts/scrape-members.py            (headless; pipe-safe)
    python3 scripts/scrape-members.py --headed   (keep browser visible)

Requires CR_LOGIN_URL, CR_USERNAME, CR_PASSWORD env vars
(reads from courtreserve-scheduler/.env if present).
"""

import sys
import os
import json
from pathlib import Path


def log(msg: str) -> None:
    """Log messages go to stderr so stdout can be piped as JSON."""
    print(msg, file=sys.stderr, flush=True)

# Add courtreserve-scheduler to Python path so we can import cr_client
SCHEDULER_DIR = Path(__file__).resolve().parent.parent.parent / "courtreserve-scheduler"
sys.path.insert(0, str(SCHEDULER_DIR))

# Load our .env and map to the var names cr_client expects
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# cr_client reads CR_LOGIN_URL, CR_USERNAME, CR_PASSWORD at module level
# Our .env uses CR_EMAIL — map it
if "CR_EMAIL" in os.environ and "CR_USERNAME" not in os.environ:
    os.environ["CR_USERNAME"] = os.environ["CR_EMAIL"]
if "CR_BASE_URL" in os.environ and "CR_LOGIN_URL" not in os.environ:
    os.environ["CR_LOGIN_URL"] = os.environ["CR_BASE_URL"].rstrip("/") + "/Account/Login"

# Now safe to import cr_client
from cr_client import browser_session  # noqa: E402


MEMBERS_REPORT_URL = (
    "https://app.courtreserve.com/MembersReport/RunReport"
    "?fields=43,44,45,62,46,47,48,50,274,280,51,417,155,183,59,60,61,67,266,268,272"
    "&joinStartDate=&joinEndDate=&startDate=&startTime=12:00%20AM&endDate=&endTime=12:00%20AM"
    "&selectedGender=&lastLoginDateFrom=&lastLoginDateTo="
    "&selectedRatingCategoryIds="
    "&BalanceAmount=null&BalanceFilterBy="
    "&CreditAmount=null&CreditFilterBy="
    "&PenaltyCancellationAmount=&PenaltyCancellationFilterBy="
    "&SelectedFamilyRoles=&cardOnFileStatus="
    "&paymentProfileCreatedFrom=&paymentProfileCreatedTo="
    "&nextPaymentDateFrom=&nextPaymentDateTo="
    "&eventIds=&reservationTypeIds=&recurringFeeIds="
    "&recurringFeeIncludeOption=undefined"
    "&DaysAttendedOption=&DaysAttendedValue="
    "&AttendedFrom=&AttendedTo="
    "&FirstVisitDateFrom=&FirstVisitDateTo="
    "&AgeFrom=&AgeTo="
    "&MemberPushNotificationStatus="
    "&lessonTypeIds="
    "&upcomingMembershipStatus=All&upcomingMembershipIds="
    "&currentMembershipStartDateFrom=&currentMembershipStartDateTo="
    "&DynamicRatingsJson=[{%22RatingCategoryId%22:%2218013%22,%22SinglesFrom%22:null,%22SinglesTo%22:null,%22DoublesFrom%22:null,%22DoublesTo%22:null,%22DoublesCriteriaEnum%22:%22%22,%22DoublesGreaterThen%22:null,%22DoublesLessThen%22:null,%22SinglesReportCriteria%22:%22%22,%22SinglesGreaterThen%22:null,%22SinglesLessThen%22:null}]"
    "&currentMembershipCancellationDateFrom=&currentMembershipCancellationDateTo="
)


def scrape_members(page) -> list[dict]:
    """Fetch member data from the Members Report page with Kendo grid."""

    debug_dir = Path(__file__).resolve().parent.parent / "debug"
    debug_dir.mkdir(exist_ok=True)

    log(f"Current URL after login: {page.url}")

    # Navigate to the report results page
    log(f"Fetching members report (this takes a while)...")
    page.goto(MEMBERS_REPORT_URL, timeout=120000)

    # Wait for the Kendo grid to populate — report can take 30-60+ seconds
    try:
        page.wait_for_selector(".k-grid tbody tr td", timeout=120000)
    except Exception:
        log("  Grid didn't populate within 2 minutes, checking page...")

    # Extra wait for all data to settle
    page.wait_for_timeout(5000)

    page.screenshot(path=str(debug_dir / "members-report-result.png"), full_page=True)
    log(f"  Page URL: {page.url}")

    # Use "Export to Excel" button — much more reliable than scraping the grid
    import openpyxl
    import glob

    # Set up download directory
    download_dir = str(debug_dir / "downloads")
    os.makedirs(download_dir, exist_ok=True)

    # Clear old downloads
    for f in glob.glob(os.path.join(download_dir, "*.xlsx")):
        os.remove(f)

    # Trigger the download — CR uses client-side download for Excel export
    log("  Clicking 'Export to Excel'...")
    export_btn = page.locator('text="Export to Excel"').first
    if export_btn.count() == 0:
        export_btn = page.locator('button:has-text("Export to Excel"), a:has-text("Export to Excel")').first

    if export_btn.count() == 0:
        log("  Export to Excel button not found!")
        return []

    # Use page's download event to capture the file
    with page.expect_download(timeout=120000) as download_info:
        export_btn.click()

    download = download_info.value
    download_path = os.path.join(download_dir, download.suggested_filename or "members.xlsx")
    download.save_as(download_path)
    log(f"  Downloaded: {download_path}")

    # Parse the Excel file
    wb = openpyxl.load_workbook(download_path)
    ws = wb.active

    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        log("  Excel file is empty")
        return []

    headers = [str(h).strip() if h else "" for h in rows[0]]
    log(f"  Excel headers: {headers}")

    members = []
    for row in rows[1:]:
        values = [str(v).strip() if v is not None else "" for v in row]
        if any(v for v in values):
            member = dict(zip(headers, values))
            members.append(member)

    log(f"  Extracted {len(members)} members from Excel")
    return members


def extract_kendo_grid_from_element(grid, headers: list[str], debug_dir: Path) -> list[dict]:
    """Extract data rows from a specific Kendo grid element."""

    # Try to show all rows via pager
    try:
        pager = grid.locator('.k-pager-sizes select').first
        if pager.count() > 0:
            pager.select_option(label="All")
            grid.page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass

    rows = grid.locator("tbody tr").all()
    members = []
    for row in rows:
        cells = row.locator("td").all_text_contents()
        cells = [c.strip() for c in cells]
        # Skip empty rows or rows that are just whitespace
        if len(cells) >= len(headers) and any(c for c in cells):
            member = dict(zip(headers, cells))
            members.append(member)

    print(f"  Extracted {len(members)} member rows")

    # Save raw data
    (debug_dir / "members-raw.json").write_text(
        json.dumps(members, indent=2), encoding="utf-8"
    )
    return members


def extract_table_from_element(table, headers: list[str]) -> list[dict]:
    """Extract data rows from a specific table element."""
    rows = table.locator("tbody tr").all()
    members = []
    for row in rows:
        cells = row.locator("td").all_text_contents()
        cells = [c.strip() for c in cells]
        if len(cells) >= len(headers) and any(c for c in cells):
            member = dict(zip(headers, cells))
            members.append(member)

    return members


def main():
    headed = "--headed" in sys.argv

    log("Scraping CourtReserve members...")
    log(f"Using scheduler at: {SCHEDULER_DIR}")
    log(f"Mode: {'headed' if headed else 'headless (not recommended — CF may block)'}")

    with browser_session(headless=not headed) as page:
        members = scrape_members(page)

    if members:
        log(f"Found {len(members)} members")
        # Write JSON to stdout so callers can pipe it into another tool.
        json.dump(members, sys.stdout)
        sys.stdout.write("\n")
    else:
        log("No members found. Check debug/ folder for screenshots and links.")
        log("You may need to navigate to the right page manually first.")
        sys.exit(1)


if __name__ == "__main__":
    main()
