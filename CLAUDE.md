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

## Rating Hub Integration

**End-to-end workflow across both projects is documented in**
`../wmpc_rating_hub/CLAUDE.md` — that file is the single source of truth.
Update it there first, then update summaries here.

### Division of responsibilities

This project owns everything from scheduling through pb.vision upload:

1. Schedule — CourtReserve scraping, rating-event detection
2. Record — coordinate camera capture
3. Split — detect + export per-game clips from session recording
4. Upload — push clips to pb.vision via their Partner API
5. Wait for AI processing
6. Wait for human tagging on pb.vision
7. Fetch Mux playback ID from pb.vision Firestore
8. Fire webhook to rating-hub

rating-hub handles everything downstream (import, visualization, coach analysis).

### What the public PB Vision API exposes (verified 2026-04-19)

rating-hub fetches these directly without needing us:
- Compact insights JSON
- Augmented insights JSON
- Tagged player names (come through insights after tagging)
- Player avatar images (from GCS `pbv-pro` bucket)
- Video poster image

What's NOT public (session-manager must fetch and push):
- **Mux playback ID** — in pb.vision's Firestore at `pbv-prod/videos/{vid}.mux.playbackId`
- **stats.json format** — the public API returns HTTP 400
- **Listing a user's videos** — no REST endpoint, only Firestore

### Updated webhook contract (as of 2026-04-19)

Only ONE call per game — fire it AFTER human tagging is complete on pb.vision:

```
POST https://cjtfhegtgbfwccnruood.supabase.co/functions/v1/pbvision-webhook
Authorization: Bearer <WEBHOOK_SECRET>
Content-Type: application/json
{
  "videoId": "abc123",
  "sessionId": "optional-session-uuid",
  "muxPlaybackId": "a00w01bJI01Ax..."   // optional but highly recommended
}
```

rating-hub will:
- Fetch compact + augmented insights from the public API
- Import games, game_players, players (by real name), rallies, rally_shots, rating snapshots
- Merge highlights + 119 advanced stats from augmented
- Set `games.mux_playback_id` if provided
- Derive player avatar URLs from `aiEngineVersion` + `avatar_id`

Response:
```json
{
  "status": "success",
  "sessionsImported": 1,
  "augmentedMerged": true,
  "totalShots": 260,
  "muxPlaybackIdSet": true,
  "games": [{ "gameId": "...", "players": 4, "rallies": 48, "shots": 260 }]
}
```

### Why the "delay until tagged" ordering matters

If we fire the webhook before tagging, rating-hub imports players as "Player 0",
"Player 1", etc. and creates placeholder `players` rows. When we later re-fire
after tagging, the real names arrive and rating-hub's `findOrCreatePlayer` can
match against existing real-name players — but the placeholder rows linger in
the DB, polluting the leaderboard.

To keep this clean: session-manager must poll pb.vision's Firestore for both
"AI processing complete" AND "names are not 'Player N'" before firing the
webhook.

### Current status

- ✅ session-manager calls rating-hub webhook (existing "Sync with Rating Hub"
  button per session)
- ⬜ session-manager does NOT yet poll for tagging completion — coach must
  manually trigger sync after tagging
- ⬜ session-manager does NOT yet fetch Mux playback ID from Firestore and
  include it in the webhook payload — current workaround is the `📌 PBV Grab`
  bookmarklet on rating-hub's analyze page
- ⬜ session-manager may need to update its webhook caller to include
  `muxPlaybackId` in the body once the Firestore fetch is built

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
venv/bin/python scripts/fetch-schedule.py      # Today's schedule
venv/bin/python scripts/fetch-schedule.py --days 7  # Next 7 days
```

## Environment Variables

```bash
# Required
VIDEO_DIR=/path/to/video/files        # Optional — defaults to <project>/videos

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
4. Drop recordings into `videos/` (gitignored, auto-created) — or set `VIDEO_DIR` to an external directory
5. Run `npm run sync:members` to pull members from CourtReserve into Supabase
6. `npm run dev`
