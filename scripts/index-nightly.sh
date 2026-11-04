#!/usr/bin/env bash
# Nightly game-indexer wrapper (daemon#241) — host gate, lock, failure ping.
# Same shape as lesson-transcribe.sh: the gate and lock live in shell so a
# wrong-host machine pays nothing and two runs cannot overlap.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
STATE="${INDEX_STATE_DIR:-$HOME/.local/state/wmpc-game-indexer}"
LOG="$STATE/index.log"
LOCK="$STATE/run.lock"
STALE_LOCK_S=${INDEX_STALE_LOCK_S:-43200}

mkdir -p "$STATE"
log(){ printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# 1. host gate (fail closed: no INDEXER-HOST file, no run)
WANT_FILE="$REPO/INDEXER-HOST"
[ -f "$WANT_FILE" ] || { log "no INDEXER-HOST file — refusing to run"; exit 0; }
WANT="$(tr -d '[:space:]' < "$WANT_FILE")"
ME="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo unknown)"
[ "$WANT" = "$ME" ] || exit 0

# 2. same-machine lock
if ! mkdir "$LOCK" 2>/dev/null; then
  AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
  if [ "$AGE" -gt "$STALE_LOCK_S" ]; then
    log "reclaiming a stale lock held ${AGE}s"
    rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null || { log "could not reclaim the lock"; exit 0; }
  else
    log "an index run is already going (lock held ${AGE}s) — skipping"
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$REPO"
# .env may hold unquoted values with spaces; shell sourcing must not kill the job.
set +e; set -a; [ -f .env ] && . ./.env; set +a; set -e
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -f "$REPO/dist/cli/index-nightly.js" ]; then
  RUNNER=(node "$REPO/dist/cli/index-nightly.js")
else
  log "dist/cli/index-nightly.js missing — falling back to tsx"
  RUNNER=(npx tsx "$REPO/src/cli/index-nightly.ts")
fi

RC=0
"${RUNNER[@]}" "$@" >> "$LOG" 2>&1 || RC=$?
if [ "$RC" -ne 0 ]; then
  log "exited $RC"
  # One ping a day: ping.sh drops identical text within 24 h, so the text is fixed.
  PING="$REPO/../daemon/infrastructure/ping/ping.sh"
  [ -x "$PING" ] && "$PING" "Game indexer did not finish last night on the mini — footage may be unindexed. Log: ~/.local/state/wmpc-game-indexer/index.log" >/dev/null 2>&1 || true
  exit "$RC"
fi
HB="$REPO/../daemon/infrastructure/heartbeat/heartbeat.sh"
[ -x "$HB" ] && "$HB" game-indexer >/dev/null 2>&1 || true
