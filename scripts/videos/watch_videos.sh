#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="/Users/notronwest/.openclaw/workspace/agents/ai-ratings"
AUTOCUT_DIR="$WORKSPACE/pickleball_autocut"
VIDEOS_DIR="$WORKSPACE/videos"
OUT_ROOT="$VIDEOS_DIR/output"
STATE_DIR="$VIDEOS_DIR/.autocut_state"
PROCESSED_FILE="$STATE_DIR/processed.txt"
LOCK_DIR="$STATE_DIR/.lock"
ROI_JSON="$AUTOCUT_DIR/roi.json"
WARMUP_SECONDS="${WARMUP_SECONDS:-540}"
PROCESSED_DIR="$VIDEOS_DIR/processed"
FAILED_DIR="$VIDEOS_DIR/failed"

mkdir -p "$OUT_ROOT" "$STATE_DIR" "$PROCESSED_DIR" "$FAILED_DIR"
touch "$PROCESSED_FILE"

if [[ ! -f "$ROI_JSON" ]]; then
  echo "[ERR] Missing ROI: $ROI_JSON" >&2
  exit 1
fi

# Prevent overlapping runs
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[INFO] watcher run skipped (lock held)"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

# Activate venv if available
if [[ -f "$AUTOCUT_DIR/.venv/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "$AUTOCUT_DIR/.venv/bin/activate"
fi

shopt -s nullglob nocaseglob
for video in "$VIDEOS_DIR"/*.{mp4,mov,mkv,m4v,avi}; do
  [[ -f "$video" ]] || continue

  name="$(basename "$video")"

  # If an older run already marked this path as processed, reconcile by moving it out
  if grep -Fxq "$video" "$PROCESSED_FILE"; then
    mv -f "$video" "$PROCESSED_DIR/$name" 2>/dev/null || true
    echo "[INFO] Reconciled lingering processed file: $name"
    continue
  fi

  # Skip temporary/incomplete-looking files
  if [[ "$name" == *.part || "$name" == *.tmp || "$name" == .* ]]; then
    continue
  fi

  # Basic stability check (size unchanged over 5s)
  size1=$(stat -f%z "$video" 2>/dev/null || echo -1)
  sleep 5
  size2=$(stat -f%z "$video" 2>/dev/null || echo -2)
  if [[ "$size1" -lt 0 || "$size2" -lt 0 || "$size1" != "$size2" ]]; then
    echo "[INFO] Skipping active copy: $video"
    continue
  fi

  stem="${name%.*}"
  outdir="$OUT_ROOT/$stem"
  mkdir -p "$outdir"

  echo "[INFO] Processing: $video"
  if (
    cd "$AUTOCUT_DIR"
    ./run_all.sh "$video" "$ROI_JSON" "$outdir" "$WARMUP_SECONDS"
  ); then
    echo "$video" >> "$PROCESSED_FILE"
    mv -f "$video" "$PROCESSED_DIR/$name"
    clip_count=$(find "$outdir/clips" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "[OK] Done: $name -> $outdir (clips=$clip_count)"
  else
    ts=$(date +%Y%m%d_%H%M%S)
    mv -f "$video" "$FAILED_DIR/${stem}__failed_${ts}.${name##*.}" 2>/dev/null || true
    echo "[ERR] Failed: $name"
  fi
done
