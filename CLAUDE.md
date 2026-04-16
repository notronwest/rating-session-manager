# WMPC Session Manager

## Overview

On-premise orchestration tool for WMPC pickleball rating sessions. Manages the pipeline from video recording through game extraction, PB Vision upload, player tagging, to Rating Hub import.

## Tech Stack

- **Backend**: Node + Express + TypeScript (ESM)
- **Frontend**: React 18 + TypeScript + Vite (SPA)
- **Database**: SQLite via better-sqlite3 (local, no cloud DB needed)
- **Video Processing**: Python scripts (detect_games.py, export_from_srt.py) called via child_process
- **Package manager**: npm
- **Runtime**: tsx for dev, compiled JS for prod

## Architecture

- Express API on port 3001 serves `/api/*` endpoints
- Vite dev server on port 3000 proxies `/api` to Express
- SQLite stores session state and logs locally
- Python scripts in `scripts/videos/` handle video analysis + clip extraction
- Communicates with Rating Hub via its webhook endpoint when ready to import

## Directory Structure

```
src/
  server.ts                  # Express entry point
  types.ts                   # Shared TypeScript types
  db/
    index.ts                 # SQLite connection singleton
    schema.ts                # Table definitions
  routes/
    sessions.ts              # Session CRUD + pipeline actions
    videos.ts                # Video file listing
  services/
    video-processor.ts       # Wraps Python scripts
scripts/
  videos/                    # Python video processing (detect_games.py, export_from_srt.py)
web/
  index.html                 # SPA entry
  src/
    App.tsx                   # React router
    pages/
      Dashboard.tsx           # Session list with status badges
      SessionDetail.tsx       # Session detail with segments, logs, actions
    components/
      StatusBadge.tsx         # Pipeline status indicator
```

## Session Pipeline States

```
scheduled → recording → recorded → splitting → split → uploading → processing → tagging → importing → complete
                                                                                              ↓
                                                                                           failed
```

## Common Commands

```bash
# Dev (both servers)
npm run dev

# Dev (server only)
npm run dev:server

# Dev (frontend only)
npm run dev:web

# Build
npm run build
```

## Environment Variables

- `VIDEO_DIR` — Directory to scan for video files (optional, used by `/api/videos`)
- `PORT` — Express port (default 3001)
