"""
Detect pickleball game segments in a session recording and write an SRT.

The signal is dead simple (rewritten 2026-06-18, replacing the paddle-tap /
quadrant-occupancy detector that over-counted games because it never looked
at whether the court actually emptied):

  A game ends when ALL FOUR players leave the court. Between games, players
  walk off to switch, rest, or get water — so the court goes empty. During a
  game the court is never empty. The next game starts when players come back
  on and play resumes.

How it works:

  1. Sample the video at 1 fps and run YOLOv8 person detection on each frame
     (Apple MPS by default, ~25 ms/frame on M-series — ~5 min for a 3-hour
     video).
  2. Filter detections to persons whose feet are inside the court polygon
     defined by roi.json (eliminates adjacent-court spillover).
  3. Mark each 1-second sample EMPTY when <= EMPTY_MAX_N persons are inside
     the court.
  4. A BREAK = the court stays EMPTY for >= BREAK_SEC consecutive seconds.
     Breaks are the only game boundaries. Everything between two breaks (and
     before the first / after the last) is one game.
  5. A game starts at the first sample where play is underway (>= ACTIVE_MIN_N
     persons on court) after the preceding break, and ends when the court next
     empties. The final game runs to end-of-video and is marked UNFINISHED.
  6. Games shorter than MIN_GAME_SEC are dropped (warmup blips, brief
     re-entries that didn't become real play).

CLI knobs (all map to the UI): --warmup, --break-sec, --empty-max-n,
--min-game. The old motion-detector knobs (--min-gap, --long-break,
--restart-lookahead) are accepted but ignored.
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

import cv2
import numpy as np


# === Sampling / detection ===
SAMPLE_FPS = 1.0           # YOLO inference is the bottleneck; 1 fps is plenty
CONF_THRESHOLD = 0.35      # YOLO person confidence floor

# === Segmentation defaults (all overridable from the CLI / UI) ===
DEFAULT_WARMUP_SEC = 0       # ignore activity before this many seconds (skip
                             # pre-session warmup before the first real game)
DEFAULT_BREAK_SEC = 12       # court must stay EMPTY this long to count as a
                             # between-games break (the only game boundary)
DEFAULT_EMPTY_MAX_N = 1      # court is "empty" when <= this many persons are
                             # inside the polygon (1 tolerates a single
                             # straggler lingering at the net post-game)
DEFAULT_ACTIVE_MIN_N = 3     # play is "underway" when >= this many persons are
                             # on court — used to pin the game-start moment
                             # after a break
DEFAULT_MIN_GAME_SEC = 120   # drop active stretches shorter than this (warmup
                             # blips, brief re-entries that didn't become play)


def fmt_t(t):
    return f"{int(t)//60:02d}:{int(t)%60:02d}"


def srt_time(t):
    hh = int(t // 3600); t -= hh * 3600
    mm = int(t // 60); t -= mm * 60
    ss = int(t); ms = int(round((t - ss) * 1000))
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def load_polygon(roi_path: Path):
    """roi.json: {'type': 'polygon', 'points': [[x,y], ...]}"""
    roi = json.loads(roi_path.read_text())
    if roi.get("type") != "polygon" or "points" not in roi:
        raise SystemExit(
            "roi.json must be like: {'type':'polygon','points':[[x,y],...]}"
        )
    return np.array(roi["points"], dtype=np.int32)


def point_in_polygon(x, y, poly):
    """Returns True if (x, y) is inside the polygon. Uses cv2 for speed."""
    return cv2.pointPolygonTest(poly, (float(x), float(y)), False) >= 0


def compute_quadrants(poly):
    """Split the court polygon into 4 quadrants (FL, FR, NR, NL).

    Polygon points are in order FL, FR, NR, NL (as written by
    calibrate_roi.py). We compute the midpoints of each edge and the
    polygon centroid, then build a 4-corner polygon for each quadrant.
    Players in their serve-start positions distribute one per quadrant,
    which is the visual signature we use for game-start detection."""
    fl, fr, nr, nl = poly[0], poly[1], poly[2], poly[3]
    def mid(a, b):
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    far_mid = mid(fl, fr)         # midpoint of far edge (net side)
    near_mid = mid(nl, nr)        # midpoint of near edge (camera side)
    left_mid = mid(fl, nl)        # midpoint of left sideline
    right_mid = mid(fr, nr)       # midpoint of right sideline
    center = mid(far_mid, near_mid)
    return [
        np.array([fl, far_mid, center, left_mid], dtype=np.int32),
        np.array([far_mid, fr, right_mid, center], dtype=np.int32),
        np.array([center, right_mid, nr, near_mid], dtype=np.int32),
        np.array([left_mid, center, near_mid, nl], dtype=np.int32),
    ]


def run_yolo(video_path: Path, poly: np.ndarray, device: str,
             model_name: str = "yolov8n.pt", verbose=True):
    """Sample video at SAMPLE_FPS, run person detection on each frame.

    Returns a list of dicts (one per sample): {t, n, n_far, n_near,
    x_spread, tightness}.
    """
    from ultralytics import YOLO

    model = YOLO(model_name)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"Could not open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, int(round(fps / SAMPLE_FPS)))
    duration_min = total / fps / 60 if fps else 0

    # Net mid-line y: roughly the average y of the polygon. Persons whose
    # feet are above this are on the FAR side, below = NEAR side.
    net_y_mid = float(poly[:, 1].mean())

    # Pre-compute the 4 quadrant polygons (FL, FR, NR, NL) once.
    quadrants = compute_quadrants(poly)

    if verbose:
        print(f"Video: {width}x{height} {fps:.1f}fps {total} frames "
              f"({duration_min:.1f} min)", flush=True)
        print(f"Running YOLO ({model_name}, device={device}) at "
              f"{SAMPLE_FPS:.1f} fps...", flush=True)

    rows = []
    idx = 0
    processed = 0
    t_start = time.time()
    last_pct = -1
    while True:
        ok = cap.grab()
        if not ok:
            break
        if idx % step != 0:
            idx += 1
            continue

        if verbose and total > 0:
            pct = int(100 * idx / total)
            if pct >= last_pct + 5:
                elapsed = time.time() - t_start
                print(f"  {pct}% ({idx/fps/60:.1f} min) elapsed {elapsed:.0f}s",
                      flush=True)
                last_pct = pct

        ok, frame = cap.retrieve()
        if not ok:
            break

        r = model(frame, classes=[0], device=device,
                  conf=CONF_THRESHOLD, verbose=False)[0]

        feet_xs = []
        feet_ys = []
        # n_q[i] = number of persons whose reference point is in quadrant i
        # (0=FL, 1=FR, 2=NR, 3=NL).
        n_q = [0, 0, 0, 0]
        for b in r.boxes:
            x1, y1, x2, y2 = b.xyxy[0].cpu().numpy()
            cx = (x1 + x2) / 2
            # Use the 70% point down the bbox (between center and feet)
            # as the polygon-membership reference. Pure bbox-bottom (feet)
            # is too brittle: a player near the polygon edge with their
            # feet a few px outside gets dropped entirely. The 70% point
            # is biased toward feet (so we don't accidentally include
            # bodies whose feet are off court) but tolerates net occlusion
            # and edge cases.
            fy = y1 + 0.7 * (y2 - y1)
            if point_in_polygon(cx, fy, poly):
                feet_xs.append(float(cx))
                feet_ys.append(float(fy))
                # Assign to one quadrant (the first that contains the point).
                for qi, qpoly in enumerate(quadrants):
                    if cv2.pointPolygonTest(qpoly, (float(cx), float(fy)),
                                            False) >= 0:
                        n_q[qi] += 1
                        break

        n_total = len(feet_xs)
        n_far = sum(1 for y in feet_ys if y < net_y_mid)
        n_near = n_total - n_far

        if feet_xs:
            xs = np.array(feet_xs)
            ys = np.array(feet_ys)
            cx_c, cy_c = xs.mean(), ys.mean()
            tightness = float(np.max(np.sqrt((xs - cx_c) ** 2
                                             + (ys - cy_c) ** 2)))
            x_spread = float(xs.max() - xs.min())
        else:
            tightness = 0.0
            x_spread = 0.0

        rows.append({
            "t": idx / fps,
            "n": n_total,
            "n_far": n_far,
            "n_near": n_near,
            "tightness": tightness,
            "x_spread": x_spread,
            "n_fl": n_q[0],
            "n_fr": n_q[1],
            "n_nr": n_q[2],
            "n_nl": n_q[3],
            # n_quadrants_occupied: how many of the 4 court quadrants
            # have at least one person. 4 = canonical serve-start
            # distribution; 3 = serve start with one player YOLO missed;
            # <=2 = rally or transition.
            "quadrants_occupied": sum(1 for q in n_q if q > 0),
        })
        processed += 1
        idx += 1

    cap.release()
    elapsed = time.time() - t_start
    if verbose:
        print(f"YOLO done: {processed} samples in {elapsed:.0f}s "
              f"({elapsed/max(1,processed)*1000:.0f} ms/sample)", flush=True)
    return rows


def find_breaks(rows, empty_max_n, break_sec):
    """Find between-games breaks: stretches where the court stays EMPTY
    (<= empty_max_n persons inside the polygon) for >= break_sec seconds.

    Returns a list of (start_t, end_t) — the empty window for each break.
    These are the ONLY game boundaries; during a game the court is never
    empty for this long."""
    breaks = []
    n = len(rows)
    i = 0
    while i < n:
        if rows[i]["n"] > empty_max_n:
            i += 1
            continue
        j = i
        while j < n and rows[j]["n"] <= empty_max_n:
            j += 1
        # rows[i .. j-1] are all empty
        start_t, end_t = rows[i]["t"], rows[j - 1]["t"]
        if (end_t - start_t) >= break_sec:
            breaks.append((start_t, end_t))
        i = j
    return breaks


def segment_games(rows,
                  warmup_sec=DEFAULT_WARMUP_SEC,
                  break_sec=DEFAULT_BREAK_SEC,
                  empty_max_n=DEFAULT_EMPTY_MAX_N,
                  active_min_n=DEFAULT_ACTIVE_MIN_N,
                  min_game_sec=DEFAULT_MIN_GAME_SEC,
                  verbose=True):
    """Segment a session into games using the empty-court signal.

    A game ends when all four players leave the court — it goes EMPTY
    (<= empty_max_n on court) for >= break_sec. The next game starts when
    players return and play resumes (>= active_min_n on court). Breaks are
    the only boundaries; everything between two consecutive breaks (and
    before the first break / after the last) is one game.

    The final game runs to end-of-video and is marked UNFINISHED only when
    it isn't itself followed by a break — i.e. the recording stopped while
    players were still on court rather than after a clean changeover.
    """
    if not rows:
        return []

    # Drop pre-session warmup: ignore everything before warmup_sec.
    rows = [r for r in rows if r["t"] >= warmup_sec]
    if not rows:
        return []
    eov = rows[-1]["t"]

    breaks = find_breaks(rows, empty_max_n, break_sec)

    if verbose:
        print(f"\nBetween-games breaks (<= {empty_max_n} on court for "
              f">= {break_sec}s): {len(breaks)}", flush=True)
        for s, e in breaks:
            print(f"  BREAK {fmt_t(s)} -> {fmt_t(e)} "
                  f"({int(e - s)}s empty)", flush=True)

    # The active spans between breaks are the candidate games. Span k runs
    # from the END of break k-1 (court refills) to the START of break k
    # (court empties). The first span starts at warmup; the last runs to EOV.
    span_starts = [rows[0]["t"]] + [e for (_s, e) in breaks]
    span_ends = [s for (s, _e) in breaks] + [eov]
    last_idx = len(span_starts) - 1

    games = []
    for idx, (span_start, span_end) in enumerate(zip(span_starts, span_ends)):
        # Pin the start to the first sample where play is actually underway,
        # skipping the few seconds of players walking back onto the court.
        start_t = span_start
        for r in rows:
            if r["t"] < span_start:
                continue
            if r["t"] > span_end:
                break
            if r["n"] >= active_min_n:
                start_t = r["t"]
                break

        if (span_end - start_t) < min_game_sec:
            continue  # too short to be a real game (warmup/transition blip)

        game = {"start": start_t, "end": span_end}
        # Only the EOV-terminated span is "unfinished" — it didn't end with
        # a clean court-empty changeover (recording cut off mid-session).
        if idx == last_idx:
            game["unfinished"] = True
        games.append(game)

    if verbose:
        print(f"\nGame segments:", flush=True)
        for i, g in enumerate(games, 1):
            d = g["end"] - g["start"]
            flag = " [UNFINISHED]" if g.get("unfinished") else ""
            print(f"  Game {i}: {fmt_t(g['start'])} -> {fmt_t(g['end'])}  "
                  f"({int(d)//60}m {int(d)%60}s){flag}", flush=True)
    return games


def write_srt(games, out_path: Path,
              pad_before: float = 0.0, pad_after: float = 0.0):
    lines = []
    for i, g in enumerate(games, start=1):
        s = max(0.0, g["start"] - pad_before)
        e = max(s, g["end"] + pad_after)
        lines += [str(i),
                  f"{srt_time(s)} --> {srt_time(e)}",
                  f"Game {i:02d}",
                  ""]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nWrote {out_path.resolve()} ({len(games)} segments)", flush=True)


def main():
    p = argparse.ArgumentParser(
        description="Detect pickleball games via YOLO person detection "
                    "and write an SRT.")
    p.add_argument("video", help="Path to input video file")
    p.add_argument("--roi", default="roi.json",
                   help="Path to roi.json (court polygon). Default: roi.json")
    p.add_argument("--out", default=None,
                   help="Output SRT path. Default: <video_stem>_games.srt "
                        "next to the video")
    p.add_argument("--device", default="mps",
                   choices=["mps", "cuda", "cpu"],
                   help="Torch device (default: mps for Apple Silicon)")
    p.add_argument("--model", default="yolov8n.pt",
                   help="YOLO model weights filename (default: yolov8n.pt). "
                        "Nano is fast and accurate enough for this use; "
                        "use yolov8s.pt for slightly better recall.")
    p.add_argument("--pad-before", type=float, default=0.0,
                   help="Seconds to pad before each game (default 0)")
    p.add_argument("--pad-after", type=float, default=0.0,
                   help="Seconds to pad after each game (default 0)")
    p.add_argument("--dump-csv", default=None,
                   help="Optional path to dump per-frame detection data "
                        "(useful for debugging false positives / missed taps)")
    p.add_argument("--from-csv", default=None,
                   help="Skip YOLO and load per-frame data from a previously "
                        "dumped CSV. Useful for fast iteration on segmentation.")

    # === Segmentation knobs (map to the UI) ===
    p.add_argument("--warmup", type=float, default=DEFAULT_WARMUP_SEC,
                   help=f"Ignore activity before this many seconds — skips "
                        f"pre-session warmup before the first game "
                        f"(default {DEFAULT_WARMUP_SEC})")
    p.add_argument("--break-sec", type=float, default=DEFAULT_BREAK_SEC,
                   help=f"Court must stay empty this long (seconds) to count "
                        f"as a between-games break (default {DEFAULT_BREAK_SEC})")
    p.add_argument("--empty-max-n", type=int, default=DEFAULT_EMPTY_MAX_N,
                   help=f"Court is 'empty' when <= this many persons are "
                        f"inside the polygon (default {DEFAULT_EMPTY_MAX_N} — "
                        f"tolerates one straggler at the net)")
    p.add_argument("--active-min-n", type=int, default=DEFAULT_ACTIVE_MIN_N,
                   help=f"Play is 'underway' when >= this many persons are on "
                        f"court; pins the game-start moment after a break "
                        f"(default {DEFAULT_ACTIVE_MIN_N})")
    p.add_argument("--min-game", type=float, default=DEFAULT_MIN_GAME_SEC,
                   help=f"Drop active stretches shorter than this (seconds) "
                        f"(default {DEFAULT_MIN_GAME_SEC})")

    # Legacy motion-detector knobs — accepted for backward compat but ignored.
    p.add_argument("--min-gap", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--long-break", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--restart-lookahead", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--thresh-mult", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--smooth", type=float, default=None, help=argparse.SUPPRESS)
    p.add_argument("--sample-fps", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--resize-w", type=int, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--diff-thr", type=int, default=None, help=argparse.SUPPRESS)
    p.add_argument("--min-blob", type=int, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--burst-lookahead", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--burst-percentile", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--burst-back-buffer", type=float, default=None,
                   help=argparse.SUPPRESS)

    args = p.parse_args()

    video_path = Path(args.video).expanduser().resolve()
    roi_path = Path(args.roi).expanduser().resolve()
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")
    if not roi_path.exists():
        raise SystemExit(f"ROI json not found: {roi_path}")

    out_path = (Path(args.out).expanduser().resolve() if args.out
                else video_path.parent / f"{video_path.stem}_games.srt")

    poly = load_polygon(roi_path)
    if args.from_csv:
        import csv as _csv
        rows = []
        with open(args.from_csv) as f:
            for r in _csv.DictReader(f):
                rows.append({
                    "t": float(r["time_sec"]),
                    "n": int(r["n"]),
                    "n_far": int(r["n_far"]),
                    "n_near": int(r["n_near"]),
                    "x_spread": float(r["x_spread"]),
                    "tightness": float(r["tightness"]),
                    "n_fl": int(r.get("n_fl", 0)),
                    "n_fr": int(r.get("n_fr", 0)),
                    "n_nr": int(r.get("n_nr", 0)),
                    "n_nl": int(r.get("n_nl", 0)),
                    "quadrants_occupied": int(r.get("quadrants_occupied", 0)),
                })
        print(f"Loaded {len(rows)} samples from {args.from_csv}", flush=True)
    else:
        rows = run_yolo(video_path, poly, device=args.device,
                        model_name=args.model)

    if args.dump_csv:
        dump_path = Path(args.dump_csv).expanduser().resolve()
        with dump_path.open("w") as f:
            f.write("time_sec,n,n_far,n_near,x_spread,tightness,"
                    "n_fl,n_fr,n_nr,n_nl,quadrants_occupied\n")
            for r in rows:
                f.write(f"{r['t']:.1f},{r['n']},{r['n_far']},"
                        f"{r['n_near']},{r['x_spread']:.0f},"
                        f"{r['tightness']:.0f},"
                        f"{r['n_fl']},{r['n_fr']},{r['n_nr']},{r['n_nl']},"
                        f"{r['quadrants_occupied']}\n")
        print(f"Dumped per-frame detection data to {dump_path}", flush=True)

    games = segment_games(rows,
                          warmup_sec=args.warmup,
                          break_sec=args.break_sec,
                          empty_max_n=args.empty_max_n,
                          active_min_n=args.active_min_n,
                          min_game_sec=args.min_game)
    write_srt(games, out_path,
              pad_before=args.pad_before, pad_after=args.pad_after)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:
        print(f"detect_games.py crashed: {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
