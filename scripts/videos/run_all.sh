#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: ./run_all.sh <video_path> <roi_json_path> <output_dir> [warmup_seconds]"
  echo "Example: ./run_all.sh session.mp4 roi.json out 540"
  exit 2
fi

VIDEO="$1"
ROI="$2"
OUTDIR="$3"
WARMUP="${4:-0}"

mkdir -p "$OUTDIR"
SRT="$OUTDIR/games.srt"
CLIPS_DIR="$OUTDIR/clips"

# Use python from active venv if present; otherwise fall back to python3
PYBIN="python3"
if command -v python >/dev/null 2>&1; then
  PYBIN="python"
fi

$PYBIN detect_games.py "$VIDEO" --roi "$ROI" --out "$SRT" --warmup "$WARMUP"
$PYBIN export_from_srt.py "$VIDEO" "$SRT" "$CLIPS_DIR"

echo "[OK] Wrote SRT: $SRT"
echo "[OK] Wrote clips: $CLIPS_DIR"
