#!/usr/bin/env bash
# Install the nightly game-indexer LaunchAgent (daemon#241). IDEMPOTENT: re-run
# after any pull that touches it; it re-renders the plist and reloads the agent.
#
#   ./scripts/install-game-indexer.sh            install / repair
#   ./scripts/install-game-indexer.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL=com.wmpc.game-indexer
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/state/wmpc-game-indexer"
TARGET="gui/$(id -u)/$LABEL"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$TARGET" 2>/dev/null || true
  rm -f "$AGENT"
  echo "uninstalled $LABEL (state and the game store left alone)"
  exit 0
fi

WANT="$(tr -d '[:space:]' < "$REPO/INDEXER-HOST")"
ME="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo unknown)"
if [ "$WANT" != "$ME" ]; then
  echo "this machine is '$ME'; INDEXER-HOST names '$WANT' — nothing installed (correct on every other machine)"
  exit 0
fi

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$REPO/launchd/$LABEL.plist.template" > "$AGENT"
plutil -lint "$AGENT" >/dev/null

launchctl bootout "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
launchctl enable "$TARGET" 2>/dev/null || true

if launchctl list | grep -q "$LABEL"; then
  echo "game-indexer: installed and loaded (23:30 nightly)"
else
  echo "game-indexer: written but NOT loaded — read the launchctl output above"; exit 1
fi
echo "log:   $STATE/index.log"
echo "store: $REPO/data/indexed-games/<court>.json"
