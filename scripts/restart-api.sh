#!/usr/bin/env bash
# Stop the running session-manager API (if any) and start a fresh one.
#
# Used by `npm run build` to make the produced dist/ live immediately —
# the Mac Mini deployment runs the API as a backgrounded `node
# dist/server.js`, so a build that doesn't restart leaves the new code
# on disk but the OLD code still serving requests.
#
# Idempotent: safe on a cold machine (no existing process), safe to run
# twice in a row. Uses SIGTERM first, escalates to SIGKILL if the
# process ignores it for 5s.
#
# Opt-out via `SKIP_API_RESTART=1` — useful in CI / dev environments
# where you just want to verify the build succeeds without disturbing
# whatever's running locally.

set -euo pipefail

if [[ "${SKIP_API_RESTART:-0}" == "1" ]]; then
  echo "[restart-api] SKIP_API_RESTART=1 — skipping restart."
  exit 0
fi

PORT="${PORT:-3001}"
LOG="${SM_LOG:-/tmp/sm.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

# If there's no built dist/ to run, there's no point restarting — likely
# being invoked in a context where the user just wants tsc to run.
if [[ ! -f "$ROOT/dist/server.js" ]]; then
  echo "[restart-api] dist/server.js not found — skipping restart."
  exit 0
fi

# Find the current process bound to the API port (if any).
# "Preserve the state I found you in" — if the API was already
# running, restart it with the new build; if it wasn't, leave the
# machine alone. This makes the script safe to run from `npm run
# build` on any machine — on the Mac Mini deployment it restarts
# the running API, on a dev laptop it does nothing. To force a
# start from cold, run `npm run start` manually.
pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -z "$pid" ]]; then
  echo "[restart-api] No process on port $PORT — leaving as-is. Run 'npm run start' to start the API for the first time."
  exit 0
fi

echo "[restart-api] Stopping existing API (pid $pid)..."
kill "$pid" 2>/dev/null || true
# Wait up to 5s for graceful shutdown.
for _ in {1..10}; do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
# Escalate to SIGKILL if it's still alive.
if kill -0 "$pid" 2>/dev/null; then
  echo "[restart-api] Process didn't exit on SIGTERM, sending SIGKILL..."
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
fi

echo "[restart-api] Starting API (logging to $LOG)..."
# `setsid` (Linux) / `&` + `disown` (macOS) detach from the shell so a
# build invoked from an interactive terminal doesn't tie the API to that
# shell's lifetime. nohup keeps it alive across HUP signals.
nohup node dist/server.js > "$LOG" 2>&1 &
new_pid=$!
disown 2>/dev/null || true
sleep 1

# Verify it's actually listening before declaring success.
for _ in {1..20}; do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t > /dev/null 2>&1; then
    echo "[restart-api] ✓ API listening on $PORT (pid $new_pid). Log: $LOG"
    exit 0
  fi
  sleep 0.5
done

echo "[restart-api] ✗ API didn't come up on $PORT within 10s. Last log lines:"
tail -20 "$LOG" 2>/dev/null || true
exit 1
