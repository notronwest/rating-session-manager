# Pickleball Auto-Cut (Video -> SRT -> Lossless Clips)

## Dependencies (must be installed)

This workflow requires:
- **FFmpeg** (ffmpeg/ffprobe)
- **Python 3.10+**
- Python packages: `opencv-python`, `numpy`

See `INSTALL_DEPENDENCIES.md` (and `setup_mac.sh`) for one-command setup.


This package detects individual pickleball games inside a continuous recording and exports each game as a separate **lossless** clip.

## Contents
- `detect_games.py` — analyzes motion inside a polygon ROI and writes an SRT with game segments.
- `export_from_srt.py` — reads that SRT and uses `ffmpeg -c copy` to export one clip per segment.
- `run_all.sh` — wrapper that runs both steps.
- `roi.example.json` — example polygon ROI file.

## Requirements (Mac)
- Python 3
- FFmpeg
- Python packages: `opencv-python`, `numpy`

### Install dependencies
Recommended: use a virtual environment (avoids macOS "externally-managed-environment" issues).

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install opencv-python numpy

# ffmpeg
brew install ffmpeg
```

## ROI file (`roi.json`)
`detect_games.py` expects a JSON polygon ROI, in **video pixel coordinates**.

Format:
```json
{ "type": "polygon", "points": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] }
```

Tip: Create the ROI once per camera setup (e.g., by manually clicking 4 court corners in a helper tool), then reuse it.

## One-command usage (do everything)
From the folder containing this package:

```bash
./run_all.sh "/path/to/session.mp4" "/path/to/roi.json" "/path/to/output" 540
```

Arguments:
1. video path
2. roi json path
3. output directory
4. warmup seconds (optional; `0` means none). Example `540` = 9 minutes warmup.

Outputs:
- `<output>/games.srt`
- `<output>/clips/Game 01.mp4`, `Game 02.mp4`, ... (extension matches input video)

## Manual knobs (if needed)
`detect_games.py` has flags you can pass for tuning. Example:

```bash
python3 detect_games.py session.mp4 --roi roi.json --out games.srt \
  --warmup 540 --min-gap 10 --long-break 22 --thresh-mult 0.9 --smooth 1.5 \
  --resize-w 640 --diff-thr 12 --min-blob 35
```

What they do (high level):
- `--min-gap` : minimum low-motion duration to consider a break
- `--long-break` : duration where a break is always accepted
- `--restart-lookahead` : only used for short lulls; if motion restarts quickly, ignore the split
- `--warmup` : ignore early warmup time

## Notes / Known limitations
- Export uses `ffmpeg -c copy` (lossless). If the input is heavily GOP-compressed, some cuts may start slightly after the requested timestamp (keyframe limitation). For most review workflows this is acceptable.

## Expected workflow for an agent
1. Ensure deps installed (venv + ffmpeg).
2. Ensure `roi.json` exists for the target camera/video resolution.
3. Run `run_all.sh` with video path, roi path, output dir, optional warmup seconds.
4. Verify output SRT and generated clips.

