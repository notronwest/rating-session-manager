#!/usr/bin/env bash
# Does the wrapper still transcribe when the lesson creator fails?
#
# WHY THIS IS A SHELL TEST AND NOT A VITEST. The behaviour under test is
# `set -e` interacting with a command substitution — a property of the shell,
# invisible to the TypeScript. That exact interaction, while sourcing .env, once
# killed this wrapper before Node started, and it ticked every ten minutes doing
# nothing for a week. "Fail open" is a claim about the shell, so it is proved in
# the shell.
#
# The two entry points are REAL Node scripts rather than a stubbed `node`,
# because the wrapper deliberately prepends /opt/homebrew/bin to PATH and would
# win against a stub — which is how the first version of this test passed
# vacuously, asserting against a `node` that never ran.
#
#   bash tests/lesson-transcribe-wrapper.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/../scripts/lesson-transcribe.sh"
PASS=0; FAIL=0
ok(){ if [ "$1" = 1 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "  FAIL: $2"; fi; }

mk(){  # $1 = exit code the lesson creator should take
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/repo/scripts" "$ROOT/repo/dist/cli" "$ROOT/state"
  cp "$WRAPPER" "$ROOT/repo/scripts/lesson-transcribe.sh"
  scutil --get ComputerName 2>/dev/null > "$ROOT/repo/TRANSCRIBE-HOST" \
    || hostname -s > "$ROOT/repo/TRANSCRIBE-HOST"
  cat > "$ROOT/repo/dist/cli/lesson-sync.js" <<EOF
console.log("APPLYING");
console.log("lessons created:    7");
process.exit($1);
EOF
  # The SAME entry point serves the relink pass and the transcription, so it has
  # to say WHICH it was called as — otherwise "the transcription ran" passes on
  # the relink call and the assertion is vacuous.
  cat > "$ROOT/repo/dist/cli/lesson-transcribe.js" <<EOF
const fs = require("fs");
if (process.argv.includes("--relink")) {
  console.log("teaching/2026-10-27/x: linked to lesson abc");
  fs.writeFileSync("$ROOT/state/relinked", "RELINK-RAN");
} else {
  fs.writeFileSync("$ROOT/state/ran", "TRANSCRIBER-RAN");
}
EOF
  printf '%s\n' "$ROOT"
}

run(){ ( cd "$1/repo" && LESSON_STATE_DIR="$1/state" \
         bash scripts/lesson-transcribe.sh >/dev/null 2>&1 ); echo $?; }

# ── 1. the creator FAILS: the transcription must still happen ───────────────
R="$(mk 1)"; RC="$(run "$R")"
ok "$([ -f "$R/state/ran" ] && echo 1 || echo 0)" \
   "a failing lesson creator stopped the transcription — the exact bug this guards"
ok "$([ "$RC" = 0 ] && echo 1 || echo 0)" "the wrapper exited $RC rather than 0"
ok "$(grep -q 'the lesson creator exited 1' "$R/state/transcribe.log" && echo 1 || echo 0)" \
   "the creator's failure did not reach the log"
ok "$(grep -q 'lessons created' "$R/state/transcribe.log" && echo 1 || echo 0)" \
   "the creator's own output did not reach the log"
ok "$([ -f "$R/state/relinked" ] && echo 1 || echo 0)" \
   "the relink pass did not run after a failing creator"
rm -rf "$R"

# ── 2. the creator SUCCEEDS and made records: one line, naming the count ────
R="$(mk 0)"; run "$R" >/dev/null
ok "$([ -f "$R/state/ran" ] && echo 1 || echo 0)" "the transcription did not run"
ok "$(grep -q 'made 7 lesson record' "$R/state/transcribe.log" && echo 1 || echo 0)" \
   "a successful creation was not logged with its count"
ok "$([ -f "$R/state/relinked" ] && echo 1 || echo 0)" "the relink pass did not run"
ok "$(grep -q 'linked to lesson abc' "$R/state/transcribe.log" && echo 1 || echo 0)" \
   "a relink that linked something was not logged"
# THE ORDER IS THE POINT: records, then link, then transcribe. Proved by mtime,
# because a relink that runs after the transcription cannot link today's lesson.
ok "$([ ! "$R/state/ran" -ot "$R/state/relinked" ] && echo 1 || echo 0)" \
   "the transcription ran BEFORE the relink pass"
rm -rf "$R"

# ── 3. switched off: the creator is never called, the transcription still is ─
R="$(mk 1)"
( cd "$R/repo" && LESSON_STATE_DIR="$R/state" LESSON_SYNC_ENABLED=0 LESSON_RELINK_ENABLED=0 \
  bash scripts/lesson-transcribe.sh >/dev/null 2>&1 )
ok "$([ -f "$R/state/ran" ] && echo 1 || echo 0)" "switching the creator off stopped the transcription"
ok "$(grep -q 'lesson creator' "$R/state/transcribe.log" && echo 0 || echo 1)" \
   "the creator spoke even though it was switched off"
ok "$([ -f "$R/state/relinked" ] && echo 0 || echo 1)" \
   "the relink pass ran even though it was switched off"
rm -rf "$R"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
