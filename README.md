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

# Supabase (shared backend with wmpc_rating_hub) — required for member search
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ORG_SLUG=wmpc

# Optional
PORT=3001                    # Express API port
APP_NAME=sessionmanager      # build output → ../../www/$APP_NAME
```

Grab Supabase values from your rating-hub project's Supabase dashboard → Project Settings → API. Use the **service role** key (not anon) — it's used server-side only and needs write access for future session-import flows.

**First-time setup only — apply rating-hub migration 005**: the `cr_member_id` column on `players` must exist. From the `wmpc_rating_hub` repo, apply `db/migrations/005_cr_member_id.sql` via `supabase db push` or paste it into the Supabase SQL editor.

### 5. Seed CourtReserve data (first run only)

```bash
python3 scripts/fetch-schedule.py --days 7   # upcoming schedule
```

The member roster comes from Supabase — no separate scrape needed.

**If Supabase's `players.cr_member_id` isn't populated yet** (fresh setup), run the one-time backfill to map CourtReserve Member #s to Supabase players by display name:

```bash
python3 scripts/scrape-members.py --headed   # CR member export (one-time)
```

```bash
tsx scripts/backfill-cr-member-id.ts --dry-run   # review matches
```

```bash
tsx scripts/backfill-cr-member-id.ts             # apply
```

Cached data lives in `data/` (gitignored).

### 6. Start

```bash
npm run dev
```

Open http://localhost:3000. The Vite dev server proxies `/api` to the Express server on port 3001.

## Deploying as a production service (macOS)

This flow runs the API as a launchd daemon and serves the built SPA through Caddy at `https://sessions.wmpc.ai`. Targets a Mac with Apple Silicon (`/opt/homebrew`). Adjust paths for Intel (`/usr/local`) if needed.

### 1. Build

```bash
npm run build
```

Produces `dist/server.js` (API) and `../../www/sessionmanager/` (SPA).

### 2. Install the API as a LaunchDaemon

Make the log directory (the plist writes to `logs/server.log` and `logs/server.err`):

```bash
mkdir -p logs
```

Copy the plist into the system LaunchDaemons folder:

```bash
sudo cp launchd/ai.wmpc.sessions.plist /Library/LaunchDaemons/
```

```bash
sudo chown root:wheel /Library/LaunchDaemons/ai.wmpc.sessions.plist
```

```bash
sudo chmod 644 /Library/LaunchDaemons/ai.wmpc.sessions.plist
```

Load and start:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.wmpc.sessions.plist
```

Verify it's listening on port 3001:

```bash
lsof -iTCP:3001 -sTCP:LISTEN
```

Tail the logs if anything looks off:

```bash
tail -f logs/server.log logs/server.err
```

**If your username isn't `notronwest` or node isn't at `/opt/homebrew/bin/node`:** edit [launchd/ai.wmpc.sessions.plist](launchd/ai.wmpc.sessions.plist) before copying. Check with `whoami` and `which node`.

**Restart after code changes:**

```bash
npm run build
```

```bash
sudo launchctl kickstart -k system/ai.wmpc.sessions
```

**Uninstall:**

```bash
sudo launchctl bootout system/ai.wmpc.sessions
```

```bash
sudo rm /Library/LaunchDaemons/ai.wmpc.sessions.plist
```

### 3. Install and configure Caddy

Caddy reverse-proxies `/api/*` to the Node server and serves the SPA from the `www/` build directory, with auto-managed TLS.

```bash
brew install caddy
```

Create `/opt/homebrew/etc/Caddyfile`:

```caddy
sessions.wmpc.ai {
    tls internal

    handle /api/* {
        reverse_proxy localhost:3001
    }

    handle {
        root * /Users/YOUR_USER/data/web/wmpc/projects/www/sessionmanager
        try_files {path} /index.html
        file_server
        encode gzip
    }
}
```

Validate:

```bash
/opt/homebrew/bin/caddy validate --config /opt/homebrew/etc/Caddyfile
```

Start Caddy as root (needed to bind ports 80/443):

```bash
sudo brew services start caddy
```

Trust Caddy's local CA on this Mac so browsers don't warn (a GUI password prompt will appear — don't use `sudo`):

```bash
caddy trust
```

### 4. Point clients at the server

Because `sessions.wmpc.ai` isn't in public DNS (`tls internal` serves a self-signed cert), add this to `/etc/hosts` on every client that needs access — replacing `10.0.0.110` with the server's LAN IP:

```
10.0.0.110  sessions.wmpc.ai
```

Other clients will hit a browser cert warning until you install Caddy's root CA on them. The root cert is at `/var/root/Library/Application Support/Caddy/pki/authorities/local/root.crt` on the server — copy it to each client and install it as a trusted root.

### Notes

- **For public DNS + real Let's Encrypt cert**: add an A record for `sessions.wmpc.ai` at your DNS provider, forward router ports 80/443 to the server, and remove `tls internal` from the Caddyfile.
- **`better-sqlite3` ABI mismatch** after a Node upgrade: `npm rebuild better-sqlite3`, then `sudo launchctl kickstart -k system/ai.wmpc.sessions`.

## Building for production (frontend only)

```bash
npm run build
```

Output goes to `../../www/$APP_NAME/` (defaults to `../../www/sessionmanager/`) relative to `web/`, i.e. a sibling `www/` directory next to the project.

## Troubleshooting

- **`courtreserve-scheduler not found`** — CR scraping won't work. Video processing (detect games, export clips) still works.
- **Playwright browser missing** — `python3 -m playwright install chromium`
- **`.env` values not loading** — ensure the file exists at the repo root, not inside `web/`.
