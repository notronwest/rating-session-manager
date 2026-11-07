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
# Who owns the API decides how it is restarted (rsm#116):
#   1. the system LaunchDaemon ai.wmpc.sessions (the mini today) — kill the pid
#      and let launchd's KeepAlive respawn it; never start a second copy.
#   2. the LaunchAgent com.wmpc.session-api (scripts/install-api.sh) — kickstart.
#   3. nothing — a hand-started `node dist/server.js` is replaced; if no API is
#      running the machine is left alone.
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
ROOT="${SM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SYSTEM_PLIST="${SM_SYSTEM_PLIST:-/Library/LaunchDaemons/ai.wmpc.sessions.plist}"
LAUNCHCTL="${SM_LAUNCHCTL:-launchctl}"

# lsof lives in /usr/sbin, which a non-login PATH (ssh command, cron, an agent
# runner) does not include. Resolve it once; never trust a bare `lsof`.
LSOF="${SM_LSOF:-}"
if [[ -z "$LSOF" ]]; then
  LSOF="$(command -v lsof 2>/dev/null || true)"
  [[ -n "$LSOF" ]] || LSOF=/usr/sbin/lsof
fi

cd "$ROOT"

# If there's no built dist/ to run, there's no point restarting — likely
# being invoked in a context where the user just wants tsc to run.
if [[ ! -f "$ROOT/dist/server.js" ]]; then
  echo "[restart-api] dist/server.js not found — skipping restart."
  exit 0
fi

if [[ ! -x "$LSOF" ]]; then
  echo "[restart-api] ✗ cannot look up the process on port $PORT: lsof not found (tried $LSOF). Not restarting; the OLD API may still be serving."
  exit 1
fi

# Print the pid listening on $PORT (empty if none). lsof exits 1 with no output
# when nothing matches; any other failure is a failed lookup, which must never
# be read as "nothing is running". Returns 2 on a failed lookup.
port_pid() {
  local out rc=0
  out="$("$LSOF" -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)" || rc=$?
  if [[ $rc -ne 0 && $rc -ne 1 ]] || [[ $rc -eq 1 && -n "$out" ]]; then
    return 2
  fi
  printf '%s' "${out%%$'\n'*}"
}

healthy() {
  curl -fsS -m 2 "http://localhost:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'
}

lookup_failed() {
  echo "[restart-api] ✗ lsof failed while looking up port $PORT — not assuming nothing is running. Not restarting; the OLD API may still be serving."
  exit 1
}

# Wait up to ~15s for a listener that is not $1 (the old pid) and answers health.
wait_for_new() {
  local old="$1" cur rc
  for _ in {1..30}; do
    rc=0; cur="$(port_pid)" || rc=$?
    [[ $rc -eq 0 ]] || lookup_failed
    if [[ -n "$cur" && "$cur" != "$old" ]] && healthy; then
      echo "$cur"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# System LaunchDaemon: launchd owns the port and respawns on exit, so a second
# `nohup node` would lose the race and die with EADDRINUSE.
if [[ -f "$SYSTEM_PLIST" ]]; then
  echo "[restart-api] System LaunchDaemon ($SYSTEM_PLIST) owns the API — restarting through it."
  rc=0; pid="$(port_pid)" || rc=$?
  [[ $rc -eq 0 ]] || lookup_failed
  if [[ -n "$pid" ]]; then
    echo "[restart-api] Stopping pid $pid; launchd will respawn it..."
    kill "$pid" 2>/dev/null || true
    for _ in {1..10}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "[restart-api] Process didn't exit on SIGTERM, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "[restart-api] Nothing listening on $PORT; waiting for launchd to start it..."
  fi
  if new_pid="$(wait_for_new "$pid")"; then
    echo "[restart-api] ✓ API listening on $PORT (pid $new_pid, launchd) and /api/health answers."
    exit 0
  fi
  echo "[restart-api] ✗ no new healthy API on $PORT within 15s — see $ROOT/logs/server.err"
  exit 1
fi

# When the LaunchAgent from scripts/install-api.sh owns the API, ask launchd to
# restart it. Killing the pid and nohup-ing a second copy would fight launchd's
# KeepAlive for the port.
AGENT_TARGET="gui/$(id -u)/com.wmpc.session-api"
if "$LAUNCHCTL" print "$AGENT_TARGET" >/dev/null 2>&1; then
  echo "[restart-api] LaunchAgent com.wmpc.session-api owns the API — kickstarting it..."
  "$LAUNCHCTL" kickstart -k "$AGENT_TARGET"
  for _ in {1..20}; do
    rc=0; cur="$(port_pid)" || rc=$?
    [[ $rc -eq 0 ]] || lookup_failed
    if [[ -n "$cur" ]]; then
      echo "[restart-api] ✓ API listening on $PORT (pid $cur, launchd)."
      exit 0
    fi
    sleep 0.5
  done
  echo "[restart-api] ✗ API didn't come up on $PORT within 10s — see ~/.local/state/wmpc-session-api/server.err.log"
  exit 1
fi

# Find the current process bound to the API port (if any).
# "Preserve the state I found you in" — if the API was already
# running, restart it with the new build; if it wasn't, leave the
# machine alone. This makes the script safe to run from `npm run
# build` on any machine — on the Mac Mini deployment it restarts
# the running API, on a dev laptop it does nothing. To force a
# start from cold, run `npm run start` manually.
rc=0; pid="$(port_pid)" || rc=$?
[[ $rc -eq 0 ]] || lookup_failed
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
  if [[ -n "$(port_pid || true)" ]]; then
    echo "[restart-api] ✓ API listening on $PORT (pid $new_pid). Log: $LOG"
    exit 0
  fi
  sleep 0.5
done

echo "[restart-api] ✗ API didn't come up on $PORT within 10s. Last log lines:"
tail -20 "$LOG" 2>/dev/null || true
exit 1
