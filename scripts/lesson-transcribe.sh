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

# ── 3a. the lesson records the transcripts land IN ──────────────────────────
# A transcript with no lesson record to attach to sits `pending` forever and
# looks like a matcher failure. Found live 2026-11-06 (rsm#114): FIVE lessons had
# resolved to a real booking, a type and a student, and had nowhere to go —
# because the creator had never been scheduled at all. No launch agent, no state
# directory; it had been run by hand exactly twice. Over 1 Oct – 7 Nov: 38
# bookings seen, 24 lessons missing.
#
# WHY IT RIDES THIS TICK RATHER THAN GETTING ITS OWN JOB. This wrapper already
# carries the host gate, the atomic lock, the .env handling and the heartbeat.
# Duplicating four load-bearing things for a job that takes seconds and is
# idempotent on cr_reservation_id would be the wrong shape — and running it HERE,
# first, means a recording's lesson exists before the transcript needs it.
#
# FAIL OPEN, AND LOUDLY. A creator that errors must not cost the transcription:
# the recordings are the perishable half. So its failure is logged and stepped
# over, never fatal — and it goes to the LOG, not only to Discord, which is the
# gap that hid 1,562 failures for 24 days.
LESSON_SYNC_DAYS_BACK=${LESSON_SYNC_DAYS_BACK:-45}
if [ "${LESSON_SYNC_ENABLED:-1}" = "1" ] && [ -f "$REPO/dist/cli/lesson-sync.js" ]; then
  # A trailing window, because a booking entered late is still a booking, and
  # +1 day because a lesson booked for tomorrow is worth a record today.
  SYNC_FROM="$(date -u -v-"${LESSON_SYNC_DAYS_BACK}"d +%Y-%m-%d 2>/dev/null || date -u -d "-${LESSON_SYNC_DAYS_BACK} days" +%Y-%m-%d)"
  SYNC_TO="$(date -u -v+1d +%Y-%m-%d 2>/dev/null || date -u -d "+1 day" +%Y-%m-%d)"
  # errexit OFF across the call. A non-zero command substitution inside an
  # assignment trips `set -e` and would kill the wrapper before the
  # transcription ran — the SAME failure mode that sourcing .env had, which
  # silently did nothing for a week. "Fail open" has to be written, not assumed.
  set +e
  SYNC_OUT="$(node "$REPO/dist/cli/lesson-sync.js" --from "$SYNC_FROM" --to "$SYNC_TO" --apply 2>&1)"
  SYNC_RC=$?
  set -e
  if [ "$SYNC_RC" -ne 0 ]; then
    log "the lesson creator exited $SYNC_RC over $SYNC_FROM..$SYNC_TO — carrying on to the transcription anyway; recordings are the perishable half"
    printf '%s\n' "$SYNC_OUT" >> "$LOG"
  else
    # One line when it did something, silence when it did not: a tick every ten
    # minutes must not write 144 "created 0" lines a day into the log an
    # operator actually reads.
    MADE="$(printf '%s\n' "$SYNC_OUT" | sed -n 's/^lessons created: *\([0-9][0-9]*\).*/\1/p' | tail -1)"
    if [ -n "$MADE" ] && [ "$MADE" != "0" ]; then
      log "the lesson creator made $MADE lesson record(s) from bookings over $SYNC_FROM..$SYNC_TO"
    fi
  fi
fi

# ── 3b. transcripts whose lesson record only appeared later ─────────────────
# A recording is matched to its lesson ONCE, at transcription time. If no lesson
# record existed then, the transcript is parked `pending` and the match is never
# retried, because the next tick sees the recording as already done and skips it
# entirely. `reattachPending` cannot rescue it either: it looks a lesson up BY
# the recording reference, which is the very field the match would have set.
#
# So creating the records in 3a is not enough on its own — found live
# 2026-11-06, when 24 records were created and five transcripts stayed pending
# anyway. The relink pass is what closes the loop, and it has to run AFTER the
# creator and BEFORE the transcription, so a lesson recorded today is linked by
# the same tick that made its record.
#
# Fail open for the same reason as above, and with the same written guard.
if [ "${LESSON_RELINK_ENABLED:-1}" = "1" ] && [ -f "$REPO/dist/cli/lesson-transcribe.js" ]; then
  set +e
  RELINK_OUT="$(node "$REPO/dist/cli/lesson-transcribe.js" --relink --apply 2>&1)"
  RELINK_RC=$?
  set -e
  if [ "$RELINK_RC" -ne 0 ]; then
    log "the relink pass exited $RELINK_RC — carrying on to the transcription anyway"
    printf '%s\n' "$RELINK_OUT" >> "$LOG"
  else
    # Only the lines that say something happened. A tick every ten minutes must
    # not fill the log an operator reads with "linked 0".
    printf '%s\n' "$RELINK_OUT" | grep -E "linked|attached|failed" >> "$LOG" || true
  fi
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
