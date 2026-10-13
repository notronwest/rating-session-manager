#!/usr/bin/env bash
# LP-08 wrapper (rsm#74) — the host gate and the lock, before Node starts.
#
# WHY THESE TWO THINGS ARE IN SHELL AND NOT IN THE TYPESCRIPT.
# Both must hold before any work begins. A wrong-host machine should pay
# nothing (not a second of Node startup), and two launchd ticks must not be
# able to overlap during the ~1s it takes to load modules. Doing the gate
# inside the program leaves exactly that window open.
#
# SINGLETON, THE WAY CLAUDE.md REQUIRES IT. Two layers:
#   1. The committed TRANSCRIBE-HOST fact names the one machine. Every checkout
#      of this repo gets this script; only the named host acts. "I only
#      installed it on the mini" is not a guarantee — a sync spreads code.
#   2. An atomic mkdir lock stops two ticks on THAT machine overlapping. A
#      transcription can run for an hour; the ticker is every ten minutes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
STATE="${LESSON_STATE_DIR:-$HOME/.local/state/wmpc-lesson-transcribe}"
LOG="$STATE/transcribe.log"
LOCK="$STATE/run.lock"
# A transcription legitimately runs for hours over SMB. Anything past this is a
# dead process holding the lock, not a slow one.
STALE_LOCK_S=${LESSON_STALE_LOCK_S:-28800}

mkdir -p "$STATE"
log(){ printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# ── 1. host gate ─────────────────────────────────────────────────────────────
WANT_FILE="$REPO/TRANSCRIBE-HOST"
if [ ! -f "$WANT_FILE" ]; then
  log "no TRANSCRIBE-HOST file at $WANT_FILE — refusing to run (fail closed)"
  exit 0
fi
WANT="$(tr -d '[:space:]' < "$WANT_FILE")"
ME="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo unknown)"
if [ "$WANT" != "$ME" ]; then
  # Silent on purpose: every machine with this repo runs this line.
  exit 0
fi

# ── 2. same-machine lock ─────────────────────────────────────────────────────
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -d "$LOCK" ]; then
    AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) ))
    if [ "$AGE" -gt "$STALE_LOCK_S" ]; then
      log "reclaiming a stale lock held ${AGE}s (> ${STALE_LOCK_S}s)"
      rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null || { log "could not reclaim the lock"; exit 0; }
    else
      log "a transcription is already running (lock held ${AGE}s) — skipping this tick"
      exit 0
    fi
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

# ── 3. run ───────────────────────────────────────────────────────────────────
cd "$REPO"

# Sourcing .env must NOT be able to kill this job, and `set -e` made it able to.
# FOUND BY RUNNING IT on the mini at install, 2026-10-13: the shared .env holds
# `CR_PASSWORD=<value with a space>`, unquoted. Node's dotenv parses that fine —
# which is why every other consumer in this repo is happy — but shell `.` splits
# it and tries to run the second word as a command. errexit is in effect DURING
# sourcing, so that 127 aborted the whole wrapper before Node ever started. The
# agent ticked every 10 minutes and died instantly each time, writing nothing.
#
# So: errexit off across the source, and then prove the variables this job
# actually needs are present rather than assuming the file loaded.
set +e
set -a
[ -f .env ] && . ./.env
set +a
set -e
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ -z "${SUPABASE_URL:-}" ]; then
  log "SUPABASE_URL is not set after sourcing .env — a transcript could not be attached to a lesson. Fix .env before expecting output."
fi

# Prefer the compiled entry point; fall back to tsx so a machine that has not
# run `npm run build` since this landed still works rather than silently doing
# nothing for a week.
if [ -f "$REPO/dist/cli/lesson-transcribe.js" ]; then
  RUNNER=(node "$REPO/dist/cli/lesson-transcribe.js")
else
  log "dist/cli/lesson-transcribe.js missing — falling back to tsx (run npm run build on this machine)"
  RUNNER=(npx tsx "$REPO/src/cli/lesson-transcribe.ts")
fi

RC=0
"${RUNNER[@]}" "$@" >> "$LOG" 2>&1 || RC=$?
# 75 = ran, but deliberately held off (camd unreachable, so we cannot prove no
# lesson is being recorded). NOT a completed run: no heartbeat, so a permanent
# block becomes watchdog silence instead of a cheerful beat over a dead job.
if [ "$RC" -eq 75 ]; then
  log "held off this tick (exit 75) — no heartbeat"
  exit 0
fi
if [ "$RC" -ne 0 ]; then
  log "exited $RC"
  exit "$RC"
fi

# Heartbeat on SUCCESS ONLY. An exit 0 that did nothing is still a job that
# ran; an exit 0 we never reach is the thing Ron needs to see while away.
HB="$REPO/../daemon/infrastructure/heartbeat/heartbeat.sh"
[ -x "$HB" ] && "$HB" lesson-transcribe >/dev/null 2>&1 || true
