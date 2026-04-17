# WMPC Session Manager

On-premise orchestration tool for WMPC pickleball rating sessions. Runs locally on any machine with access to the video files (Mac, Linux, Raspberry Pi).

See [CLAUDE.md](CLAUDE.md) for architecture and pipeline details.

## Setting up on a new computer

### 1. Install prerequisites

- **Node.js 18+** — `brew install node` (macOS) or `apt-get install nodejs` (Linux)
- **Python 3.10+** — `brew install python@3.11` (macOS) or `apt-get install python3 python3-venv python3-pip` (Linux)
- **ffmpeg** — `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Linux) — required for clip export
- **git**

### 2. Clone repos as siblings

`courtreserve-scheduler` is required for CourtReserve scraping (member list, schedule). Clone both into the same parent directory:

```bash
mkdir -p ~/projects && cd ~/projects
git clone <session-manager-repo-url> rating-session-manager
git clone <courtreserve-scheduler-repo-url> courtreserve-scheduler
```

The layout must be:

```
projects/
  rating-session-manager/   # this repo
  courtreserve-scheduler/   # sibling, required for CR features
  www/                      # build output lands here (auto-created)
```

### 3. Run setup

```bash
cd rating-session-manager
./setup.sh
```

This installs npm packages, creates the Python venv at `scripts/videos/venv` with opencv + numpy, installs Playwright + Chromium, and copies `.env.template` to `.env` if missing. If `.env` already exists, setup warns about any variables added to the template since your last setup.

### 4. Configure `.env`

Edit `.env` with your values:

```bash
# Required
VIDEO_DIR=/absolute/path/to/video/files   # where session recordings live

# CourtReserve scraping
CR_EMAIL=your-email@example.com
CR_PASSWORD=your-password
CR_BASE_URL=https://app.courtreserve.com

# Optional
PORT=3001                    # Express API port
APP_NAME=sessionmanager      # build output → ../../www/$APP_NAME
```

### 5. Seed CourtReserve data (first run only)

```bash
python3 scripts/scrape-members.py --headed   # member roster (opens Chrome for Cloudflare)
python3 scripts/fetch-schedule.py --days 7   # upcoming schedule
```

These cache results in `data/` (gitignored).

### 6. Start

```bash
npm run dev
```

Open http://localhost:3000. The Vite dev server proxies `/api` to the Express server on port 3001.

## Building for production

```bash
npm run build
```

Output goes to `../../www/$APP_NAME/` (defaults to `../../www/sessionmanager/`) relative to `web/`, i.e. a sibling `www/` directory next to the project.

## Troubleshooting

- **`courtreserve-scheduler not found`** — CR scraping won't work. Video processing (detect games, export clips) still works.
- **Playwright browser missing** — `python3 -m playwright install chromium`
- **`.env` values not loading** — ensure the file exists at the repo root, not inside `web/`.
