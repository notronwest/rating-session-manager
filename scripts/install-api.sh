#!/usr/bin/env bash
# Install the session-manager API as a LaunchAgent so it survives a reboot
# (rsm#102 — a public route cannot carry the old "someone must start it" gap).
#
# IDEMPOTENT: re-running re-renders the plist from THIS checkout and reloads.
#
#   ./scripts/install-api.sh            install / repair
#   ./scripts/install-api.sh --uninstall
#
# Run on the mini, after `npm run build` has produced dist/server.js. The API
# reads its config from the repo's .env (dotenv), exactly as before.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL=com.wmpc.session-api
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/state/wmpc-session-api"
TARGET="gui/$(id -u)/$LABEL"
PORT="${PORT:-3001}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$TARGET" 2>/dev/null || true
  rm -f "$AGENT"
  echo "uninstalled $LABEL (nothing else touched; start the API by hand with: npm run start)"
  exit 0
fi

[ -f "$REPO/dist/server.js" ] || { echo "dist/server.js is missing — run: npm run build   (then re-run this)"; exit 1; }

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$REPO/launchd/$LABEL.plist.template" > "$AGENT"
plutil -lint "$AGENT" >/dev/null

# A hand-started API (restart-api.sh's nohup) already owns the port; stop it so
# launchd's copy can bind. Only that one process, found by port.
OLD="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$OLD" ] && ! launchctl print "$TARGET" >/dev/null 2>&1; then
  echo "stopping the hand-started API (pid $OLD) so launchd can own port $PORT"
  kill "$OLD" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$OLD" 2>/dev/null || break; sleep 0.5; done
fi

launchctl bootout "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
launchctl enable "$TARGET" 2>/dev/null || true

for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "session-api: installed and answering on port $PORT (restarts itself after a reboot)"
    echo "log: $STATE/server.log"
    exit 0
  fi
  sleep 1
done
echo "session-api: installed but NOT answering on port $PORT — read $STATE/server.err.log"
exit 1
