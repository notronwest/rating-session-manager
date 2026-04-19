#!/usr/bin/env bash
set -euo pipefail

echo "=== WMPC Session Manager Setup ==="
echo ""

# Detect OS
OS="$(uname -s)"
echo "Platform: $OS"

# ─── Node.js ───────────────────────────────────────────────
echo ""
echo "--- Node.js ---"
if command -v node >/dev/null 2>&1; then
  echo "Node $(node --version) found"
else
  echo "ERROR: Node.js not found. Install Node 18+ first."
  echo "  macOS:   brew install node"
  echo "  Linux:   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

# ─── npm dependencies ──────────────────────────────────────
echo ""
echo "--- npm install ---"
npm install

# ─── Python 3 ──────────────────────────────────────────────
echo ""
echo "--- Python ---"
PYTHON=""
for p in python3.11 python3 python; do
  if command -v "$p" >/dev/null 2>&1; then
    PYTHON="$p"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "ERROR: Python 3 not found. Install Python 3.10+."
  echo "  macOS:   brew install python@3.11"
  echo "  Linux:   sudo apt-get install -y python3 python3-venv python3-pip"
  exit 1
fi
echo "Python: $($PYTHON --version)"

# ─── Python venv + opencv ──────────────────────────────────
echo ""
echo "--- Python venv (scripts/videos) ---"
VENV_DIR="scripts/videos/venv"
if [ ! -d "$VENV_DIR" ]; then
  $PYTHON -m venv "$VENV_DIR"
  echo "Created venv at $VENV_DIR"
fi
"$VENV_DIR/bin/pip" install -q -r scripts/videos/requirements.txt
echo "Python deps installed (opencv-python, numpy)"

# ─── ffmpeg ────────────────────────────────────────────────
echo ""
echo "--- ffmpeg ---"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg found: $(ffmpeg -version 2>&1 | head -1)"
else
  echo "WARNING: ffmpeg not found. Clip export will not work."
  if [ "$OS" = "Darwin" ]; then
    echo "  Install: brew install ffmpeg"
  else
    echo "  Install: sudo apt-get install -y ffmpeg"
  fi
fi

# ─── Sibling projects ─────────────────────────────────────
echo ""
echo "--- Sibling projects ---"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -d "$PARENT_DIR/courtreserve-scheduler" ]; then
  echo "courtreserve-scheduler: found at $PARENT_DIR/courtreserve-scheduler"
else
  echo "WARNING: courtreserve-scheduler not found at $PARENT_DIR/courtreserve-scheduler"
  echo "  CourtReserve scraping (members, schedule) will not work without it."
  echo "  Clone it as a sibling directory:"
  echo "    cd $PARENT_DIR && git clone <repo-url> courtreserve-scheduler"
fi

# ─── Project venv for CR scraping ─────────────────────────
echo ""
echo "--- Python venv (project root) ---"
ROOT_VENV="venv"
if [ ! -d "$ROOT_VENV" ]; then
  $PYTHON -m venv "$ROOT_VENV"
  echo "Created venv at $ROOT_VENV"
fi
"$ROOT_VENV/bin/pip" install -q --upgrade pip
"$ROOT_VENV/bin/pip" install -q playwright playwright-stealth python-dotenv openpyxl
echo "Python deps installed into $ROOT_VENV"

if [ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ]; then
  echo "Playwright browsers found"
else
  echo "Installing Playwright browsers..."
  "$ROOT_VENV/bin/python" -m playwright install chromium
fi

# ─── .env file ─────────────────────────────────────────────
echo ""
echo "--- Environment ---"
if [ -f ".env" ]; then
  echo ".env file exists"
  # Warn about variables present in the template but missing from .env
  MISSING=$(comm -23 \
    <(grep -E '^[A-Z_]+=' .env.template | cut -d= -f1 | sort) \
    <(grep -E '^[A-Z_]+=' .env | cut -d= -f1 | sort))
  if [ -n "$MISSING" ]; then
    echo "WARNING: .env is missing variables from .env.template:"
    echo "$MISSING" | sed 's/^/  - /'
    echo "Add them to .env (see .env.template for defaults)."
  fi
else
  echo "Creating .env from .env.template..."
  cp .env.template .env
  echo "IMPORTANT: Edit .env with your credentials and paths"
fi

# ─── Summary ───────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start:"
echo "  npm run dev"
echo ""
echo "Then open http://localhost:3000"
echo ""
echo "Required .env variables:"
echo "  VIDEO_DIR                  — path to video files directory"
echo "  CR_EMAIL                   — CourtReserve login email"
echo "  CR_PASSWORD                — CourtReserve password"
echo "  SUPABASE_URL               — Supabase project URL (shared with rating-hub)"
echo "  SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key"
echo "  ORG_SLUG                   — Organization slug in Supabase (e.g. wmpc)"
echo ""
echo "Refresh data from CourtReserve:"
echo "  npm run sync:members        # Sync new players into Supabase"
echo "  python3 scripts/fetch-schedule.py"
