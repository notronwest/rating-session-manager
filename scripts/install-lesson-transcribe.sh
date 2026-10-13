#!/usr/bin/env bash
# Install the LP-08 lesson-transcription LaunchAgent (rsm#74).
#
# IDEMPOTENT: re-running is the self-heal path. It re-renders the plist from the
# checkout it is run in, re-downloads a missing model, and reloads the agent.
# Run it again after any `git pull` that touches this component.
#
#   ./scripts/install-lesson-transcribe.sh            install / repair
#   ./scripts/install-lesson-transcribe.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL=com.wmpc.lesson-transcribe
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HOME/.local/state/wmpc-lesson-transcribe"
SHARE="$HOME/.local/share/wmpc-lesson-transcribe"
TARGET="gui/$(id -u)/$LABEL"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$AGENT"
  echo "uninstalled $LABEL (state and transcripts left alone)"
  exit 0
fi

# ── host gate, the same committed fact the job itself reads ──────────────────
WANT="$(tr -d '[:space:]' < "$REPO/TRANSCRIBE-HOST")"
ME="$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || echo unknown)"
if [ "$WANT" != "$ME" ]; then
  echo "this machine is '$ME'; TRANSCRIBE-HOST names '$WANT' — nothing installed (correct on every other machine)"
  exit 0
fi

mkdir -p "$STATE" "$SHARE" "$HOME/Library/LaunchAgents"

# ── models ───────────────────────────────────────────────────────────────────
# Both are required. The VAD model is NOT a nicety: without it whisper loops on
# silence and invents words from a dead mic, which is exactly what the 2026-10-07
# prototype produced on the 09-27 clinic (166 hallucinated words).
fetch(){ # fetch <dest> <url> <what>
  if [ -s "$1" ]; then echo "    $3 present"; return 0; fi
  echo "    downloading $3 ..."
  curl -fsSL --retry 3 -o "$1.part" "$2" && mv -f "$1.part" "$1" \
    || { rm -f "$1.part"; echo "    FAILED to download $3 — the job will refuse to run until this succeeds"; return 1; }
}
echo "==> 1/4 models"
MODEL_OK=0
fetch "$SHARE/ggml-small.en.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" \
  "whisper model (small.en, ~466 MB)" || MODEL_OK=1
fetch "$SHARE/ggml-silero-v5.1.2.bin" \
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" \
  "silero VAD model" || MODEL_OK=1

echo "==> 2/4 rendering the plist from THIS checkout ($REPO)"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
  "$REPO/launchd/$LABEL.plist.template" > "$AGENT"
plutil -lint "$AGENT" >/dev/null

echo "==> 3/4 (re)loading the agent"
launchctl bootout "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
launchctl enable "$TARGET" 2>/dev/null || true

echo "==> 4/4 self-test"
# "loaded" is not "working" — this repo's own DEPLOYMENT.md records a plist that
# looked installed for months while pointing at a path that no longer existed.
# So report what actually resolves, not what was written.
if bash "$REPO/scripts/lesson-transcribe.sh" --self-test; then
  echo "lesson-transcribe: installed and self-test PASSED"
else
  echo "lesson-transcribe: installed but SELF-TEST FAILED — read the lines above; the job will skip work until they pass"
fi
[ "$MODEL_OK" -eq 0 ] || echo "lesson-transcribe: a model is missing — re-run this script once the network is back"
echo
echo "log:         $STATE/transcribe.log"
echo "transcripts: ${LESSON_TRANSCRIPTS_DIR:-/Volumes/wmpc-video/transcripts}/<date>/"
echo "next tick:   within 10 minutes"
