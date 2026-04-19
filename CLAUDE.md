# WMPC Session Manager

## Overview

On-premise orchestration tool for WMPC pickleball rating sessions. Manages the pipeline from video recording through game extraction, PB Vision upload, player tagging, to Rating Hub import.

This is a **local service** designed to run on the machine with access to video files. It can run on a Mac, Raspberry Pi, or any Linux box on the network.

## Tech Stack

- **Backend**: Node + Express + TypeScript (ESM)
- **Frontend**: React 18 + TypeScript + Vite (SPA)
- **Database**: SQLite via better-sqlite3 (local, no cloud DB needed)
- **Video Processing**: Python 3.10+ scripts (detect_games.py, export_from_srt.py) called via child_process
- **CR Scraping**: Python + Playwright (imports from sibling courtreserve-scheduler project)
- **Package manager**: npm
- **Runtime**: tsx for dev, compiled JS for prod

## Prerequisites

- Node.js 18+
- Python 3.10+ with venv support
- ffmpeg (for clip export)
- Playwright + Chromium (for CourtReserve scraping)

## Quick Start

```bash
# One-command setup (installs all deps)
./setup.sh

# Edit .env with your credentials and paths
nano .env

# Start the app
npm run dev

# Open http://localhost:3000
```

## Sibling Project Dependencies

This project expects the following sibling projects to exist:

```
projects/
  session-manager/          # This project
  courtreserve-scheduler/   # Required for CR scraping (login, schedule fetch)
  rating-hub/               # The web app this feeds data into
```

**courtreserve-scheduler** is required for:
- `scripts/scrape-members.py` — imports `cr_client.browser_session` for Cloudflare-safe login
- `scripts/fetch-schedule.py` — imports `cr_client.fetch_schedule` for schedule data

If courtreserve-scheduler is not present, the video processing features still work but CR scraping will not.

## Architecture

- Express API on port 3001 serves `/api/*` endpoints
- Vite dev server on port 3000 proxies `/api` to Express
- SQLite stores session state and logs locally
- Python scripts in `scripts/videos/` handle video analysis + clip extraction
- Python scripts in `scripts/` handle CourtReserve scraping
- Communicates with Rating Hub via its webhook endpoint when ready to import

## Directory Structure

```
setup.sh                     # One-command setup for new machines
.env.template                # Template for environment variables (copied to .env by setup.sh)
src/
  server.ts                  # Express entry point
  types.ts                   # Shared TypeScript types
  db/
    index.ts                 # SQLite connection singleton
    schema.ts                # Table definitions
  routes/
    sessions.ts              # Session CRUD + pipeline actions + reset
    videos.ts                # Video file listing from VIDEO_DIR
    members.ts               # Member list from cached CR data
    schedule.ts              # Schedule + rating event detection
  services/
    video-processor.ts       # Wraps Python scripts (detect_games, export_from_srt)
scripts/
  videos/                    # Python video processing
    detect_games.py          # Motion analysis → game segment detection
    export_from_srt.py       # ffmpeg clip extraction from SRT timecodes
    roi.json                 # Court region of interest for motion detection
    requirements.txt         # Python deps (opencv-python, numpy)
  scrape-members.py          # CR member export via Playwright + Excel download
  fetch-schedule.py          # CR schedule fetch + rating event detection
web/
  index.html                 # SPA entry
  src/
    App.tsx                  # React router
    pages/
      Dashboard.tsx          # Rating events, session list, manual creation with member search
      SessionDetail.tsx      # Video select, game detection, segment editing, clip export
    components/
      StatusBadge.tsx        # Color-coded pipeline status indicator
data/                        # Cached data (gitignored)
  schedule.json              # CR schedule cache
  rating_events.json         # Filtered rating events
```

## Session Pipeline States

```
scheduled → recording → recorded → splitting → split → uploading → processing → tagging → importing → complete
                                                                                              ↓
                                                                                           failed
```

"Start Over" resets a session back to `scheduled`, deletes clips and logs.

## Common Commands

```bash
# One-command setup
./setup.sh

# Dev (API + frontend)
npm run dev

# Dev (server only / frontend only)
npm run dev:server
npm run dev:web

# Build for production
npm run build

# Refresh CourtReserve data
npm run sync:members                           # Scrape CR members → Supabase (inserts only)
npm run sync:members -- --headed               # Headed mode if Cloudflare blocks headless
python3 scripts/fetch-schedule.py              # Today's schedule
python3 scripts/fetch-schedule.py --days 7     # Next 7 days
```

## Environment Variables

```bash
# Required
VIDEO_DIR=/path/to/video/files        # Where session recordings live

# CourtReserve (for scraping — reads from courtreserve-scheduler/.env too)
CR_EMAIL=your-email@example.com
CR_PASSWORD=your-password
CR_BASE_URL=https://app.courtreserve.com

# Optional
PORT=3001                              # Express API port (default 3001)
```

## Moving to a New Machine

1. Clone this repo and courtreserve-scheduler as siblings
2. Run `./setup.sh`
3. Copy `.env` from old machine (or create from `.env.template`) — set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ORG_SLUG`
4. Set `VIDEO_DIR` to where videos are on the new machine
5. Run `npm run sync:members` to pull members from CourtReserve into Supabase
6. `npm run dev`
