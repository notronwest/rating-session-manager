"""
Detect pickleball game segments in a session recording and write an SRT.

How it works (replacing the old motion-magnitude detector as of 2026-05-14):

  1. Sample the video at 1 fps and run YOLOv8 person detection on each frame
     (Apple MPS by default, ~25 ms/frame on M-series — ~5 min for a 3-hour
     video).
  2. Filter detections to persons whose feet are inside the court polygon
     defined by roi.json (eliminates adjacent-court spillover that confused
     the pixel-based detector).
  3. Detect PADDLE TAPS — game-end signal — as samples with N >= 3 persons
     whose positions are tight (max distance from centroid < 80 px). Real
     paddle taps cluster 3-4 players within ~50 px; rallies and between-
     game milling spread persons 100-300+ px apart.
  4. Detect GAME-START FORMATIONS as samples with 4+ persons spread across
     the court (tightness >= 100, at least one on each side of the net)
     sustained for 5+ seconds.
  5. Filter paddle taps with backward-greedy 5-min spacing so a mid-game
     huddle doesn't get treated as a game end. Last tap inside 90 s of
     end-of-video means the final game ran out of time and is marked
     UNFINISHED.
  6. Build games: Game N = (first formation after tap N-1) to tap N.

CLI is unchanged from the old detector — same args, same SRT output. Old
motion-based tuning knobs (--warmup, --min-gap, etc.) are accepted but
ignored.
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

import cv2
import numpy as np


# === Tuned thresholds (from /tmp/wed-frames/ analysis, 2026-05-14) ===
SAMPLE_FPS = 1.0           # YOLO inference is the bottleneck; 1 fps is plenty
CONF_THRESHOLD = 0.35      # YOLO person confidence floor
TIGHT_THRESHOLD = 80       # max px from centroid for a "paddle-tap cluster";
                           # real taps observed at 38-78 px tightness
N_MIN_TAP = 3              # min persons in a tap cluster — kept at 3 because
                           # YOLO often misses one of the 4 players due to
                           # occlusion. The NMS scoring favors max_n=4 clusters
                           # over max_n=3 ones, so real taps win when both
                           # types of cluster fall within the spacing window.
TAP_SUSTAINED_MIN_SEC = 0  # Accept single-sample clusters — real paddle taps
                           # often only register clean signal (n>=3, tight<80)
                           # for one frame because the cluster moves quickly.
                           # The 5-minute spacing filter handles false positives.
TAP_MERGE_GAP_SEC = 30     # cluster samples within 30s = one event
TAP_MAX_DURATION_SEC = 25  # clusters lasting longer than this are NOT
                           # paddle taps — they're sustained kitchen-line
                           # activity (e.g., dinking practice between
                           # games), where 4 players cluster at the net
                           # for minutes. Real taps are 0-15s typically.
MIN_TAP_TIME_SEC = 90      # ignore tap candidates in the first 90s of the
                           # video. Start-of-recording transitions (intro
                           # graphics, players walking on, low-activity
                           # warmup) can create brief clusters surrounded
                           # by empty court that look like paddle taps.
                           # Real games haven't started by then anyway —
                           # the earliest game start observed is ~1:30.
                           # (This replaces the post-tap-quiet filter,
                           # which broke for sessions where players don't
                           # exit the court between games — e.g. coaching
                           # sessions where the court stays full
                           # continuously through every paddle tap.)
MIN_GAME_GAP_SEC = 7 * 60   # real games are 7+ min apart end-to-end
                            # (real game durations observed: 9-17 min).
                            # 10 min was too aggressive — suppressed real
                            # short games (Game 2 at 15:39 vs Game 3 at 25:12,
                            # only 9:30 apart).
EOV_GUARD_SEC = 90         # last cluster within 90s of EOV = unfinished game
MIN_UNFINISHED_GAME_SEC = 180  # tail-after-last-tap must be >= this long
                               # for us to treat it as an unfinished game
                               # (recording stopped mid-play). 3 min covers
                               # short games while ignoring brief warmup /
                               # debrief activity that follows a real tap.
FORMATION_TIGHTNESS_MIN = 100  # spread out enough that it's not a tap


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


def is_paddle_tap(r):
    return r["n"] >= N_MIN_TAP and 0 < r["tightness"] < TIGHT_THRESHOLD


def is_strict_formation(r):
    """Strict game-start signature: 2 players on each side of the net,
    spread out. This is what 'real game play has just begun' looks like —
    not warmup (where players are usually all far or all near) and not
    between-games (where typically 1-2 people are on the court).
    Empirically appears in ~7% of samples in a session, clustered at game
    starts."""
    return (r["n"] >= 4
            and r["n_far"] >= 2
            and r["n_near"] >= 2
            and r["tightness"] >= FORMATION_TIGHTNESS_MIN)


def is_loose_formation(r):
    """Looser fallback: at least one player on each side, total >= 3.
    Used when no strict formation appears in a window (e.g., if YOLO
    consistently misses one of the 4 players in a particular game)."""
    return (r["n"] >= 3
            and r["n_far"] >= 1
            and r["n_near"] >= 1
            and r["tightness"] >= FORMATION_TIGHTNESS_MIN)


QUIET_AVG_N = 0.3            # avg n_total in a real between-games break
                             # (~80-99% n=0). Mid-game lulls hit 0.45+.
QUIET_STRETCH_MIN_SEC = 30   # the break must persist at least this long
QUIET_FALLBACK_AVG_N = 0.5   # lenient fallback when no strict quiet
                             # window exists (e.g., pre-game warmup with
                             # 1-2 people drifting around the court).
QUIET_FALLBACK_MIN_SEC = 15  # shorter window for the fallback.
ACTIVE_N = 3                 # n_total >= this counts as game in progress


def find_game_start(rows, t_lo, t_hi):
    """Find the moment a game begins inside (t_lo, t_hi).

    Algorithm: a real game start is a QUIET→ACTIVE TRANSITION POINT —
    the 30s BEFORE has avg n_total < PRE_GAME_QUIET_AVG_N (court empty,
    players walking to position) and the 30s AFTER has avg n_total >=
    GAME_ACTIVE_AVG_N (sustained 3-4 players in play).

    We pick the LATEST such transition in the window. This correctly
    handles cases like:
      - Drill activity between games (G6→G7): there's drill activity
        then a real quiet→active transition into the actual game.
      - Setup/staging time between games (G8→G9): brief setup activity
        bursts before the actual sustained game starts.
      - Mid-game brief lulls: don't qualify because pre-window isn't
        quiet (game was already in progress).

    Earlier approaches (longest quiet stretch, first active sample,
    formation predicate) all failed in at least one of these cases.
    """
    in_range = [r for r in rows if t_lo < r["t"] < t_hi]
    if not in_range:
        return None

    n_vals = [r["n"] for r in in_range]

    def find_latest_window(threshold, win_size):
        """Walks backward, finds latest window where avg n < threshold."""
        for start in range(len(n_vals) - win_size, -1, -1):
            if sum(n_vals[start:start + win_size]) / win_size < threshold:
                return start + win_size - 1
        return None

    # Try strict quiet first (real between-games break).
    latest_end = find_latest_window(QUIET_AVG_N, QUIET_STRETCH_MIN_SEC)
    # Fall back to looser quiet (handles pre-game warmup where someone is
    # always drifting around — never quite empty).
    if latest_end is None:
        latest_end = find_latest_window(QUIET_FALLBACK_AVG_N,
                                        QUIET_FALLBACK_MIN_SEC)

    if latest_end is None:
        # Court was continuously active — return first active sample.
        for r in in_range:
            if r["n"] >= ACTIVE_N:
                return r["t"]
        return in_range[0]["t"]

    # Game starts at first active sample after the quiet stretch.
    for idx in range(latest_end + 1, len(in_range)):
        if in_range[idx]["n"] >= ACTIVE_N:
            return in_range[idx]["t"]

    if latest_end + 1 < len(in_range):
        return in_range[latest_end + 1]["t"]
    return in_range[-1]["t"]


def find_runs(rows, predicate, min_len=1):
    runs = []
    i = 0
    while i < len(rows):
        if not predicate(rows[i]):
            i += 1
            continue
        j = i
        while j < len(rows) and predicate(rows[j]):
            j += 1
        if (j - i) >= min_len:
            runs.append((i, j - 1))
        i = j
    return runs


def cluster_score(rows, lo_idx, hi_idx):
    """Score a tap-candidate cluster. Higher = more likely a real paddle
    tap. max_n dominates with x100 weight so any cluster with 4 detected
    players beats any cluster with only 3 — this correctly picks the real
    paddle-tap moment over post-game milling, where YOLO typically sees
    only 2-3 people walking by. Tightness is a secondary tiebreaker.

    IMPORTANT: only consider samples that actually match the paddle-tap
    predicate. Clusters may span non-matching samples (when two short
    runs got merged via TAP_MERGE_GAP_SEC), and those non-matching
    samples can have artificially-low tightness (e.g., 2 close people)
    that would distort the score."""
    matching = [rows[i] for i in range(lo_idx, hi_idx + 1)
                if is_paddle_tap(rows[i])]
    if not matching:
        return 0
    max_n = max(r["n"] for r in matching)
    min_t = min(r["tightness"] for r in matching if r["tightness"] > 0)
    return max_n * 100 + (TIGHT_THRESHOLD - min_t)


# Game-start detection thresholds (quadrant-occupancy approach)
GAME_START_MIN_QUADRANTS = 3   # how many of 4 court quadrants must contain
                               # a person for the frame to count toward a
                               # game-start signal. 3 of 4 (not 4) tolerates
                               # YOLO missing one player in serve setup.
GAME_START_SUSTAINED_SEC = 3   # how many seconds the signal must hold to
                               # count as a real game start (filters brief
                               # mid-rally moments where players happen to
                               # span all 4 quadrants in passing).
GAME_START_MERGE_GAP_SEC = 15  # merge nearby game-start runs into one
                               # event; the signal often flickers during
                               # the 3-5 sec of pre-serve positioning.


def find_game_starts(rows):
    """Find moments where the players distribute across the court for a
    serve setup — the canonical game-start signature.

    Algorithm:
      1. Mark each sample where >= GAME_START_MIN_QUADRANTS of the 4
         court quadrants contain at least one detected person.
      2. Group consecutive marked samples into runs; merge runs within
         GAME_START_MERGE_GAP_SEC of each other (handles YOLO flicker).
      3. Keep runs whose total duration is >= GAME_START_SUSTAINED_SEC.

    Each kept run's start timestamp is a "game starts here" event.
    """
    flags = [r["quadrants_occupied"] >= GAME_START_MIN_QUADRANTS
             for r in rows]

    # Find consecutive runs of marked samples.
    runs = []
    i = 0
    while i < len(flags):
        if not flags[i]:
            i += 1
            continue
        j = i
        while j < len(flags) and flags[j]:
            j += 1
        runs.append([i, j - 1])
        i = j

    # Merge runs within GAME_START_MERGE_GAP_SEC of each other.
    merged = []
    for lo, hi in runs:
        s, e = rows[lo]["t"], rows[hi]["t"]
        if merged and s - merged[-1][1] <= GAME_START_MERGE_GAP_SEC:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    # Keep only runs sustained long enough to be a real serve setup.
    return [(s, e) for s, e in merged
            if (e - s) >= GAME_START_SUSTAINED_SEC]


def segment_games(rows, verbose=True):
    """Detect game segments using quadrant-occupancy game-start signals.

    Pickleball games begin with 4 players distributing across the 4
    court quadrants for the serve setup. This is a much more reliable
    signal than paddle-tap detection (which gives the same visual
    signature whether it ends a game or happens mid-rally).

    Games are bounded by consecutive game starts: Game N runs from
    game-start N until game-start N+1 (or end of video for the last
    game, which is marked UNFINISHED since we can't tell whether the
    recording ended naturally at a game-end or cut off mid-play).
    """
    if not rows:
        return []
    eov = rows[-1]["t"]

    # Ignore game starts in the first MIN_TAP_TIME_SEC of the video
    # (start-of-recording transitions / warmup / setup).
    starts = [(s, e) for s, e in find_game_starts(rows)
              if s >= MIN_TAP_TIME_SEC]

    # Enforce minimum spacing between consecutive game starts. If two
    # game-start signals fire within MIN_GAME_GAP_SEC, the second one is
    # really "still setting up" — keep the first.
    spaced = []
    for s, e in starts:
        if not spaced or (s - spaced[-1][0]) >= MIN_GAME_GAP_SEC:
            spaced.append((s, e))

    if verbose:
        print(f"\nGame-start signals (>= {GAME_START_MIN_QUADRANTS}/4 "
              f"quadrants occupied, sustained >= "
              f"{GAME_START_SUSTAINED_SEC}s, spaced >= "
              f"{MIN_GAME_GAP_SEC//60}min): {len(spaced)}", flush=True)
        for s, e in spaced:
            print(f"  START {fmt_t(s)} (signal lasted {int(e - s)}s)",
                  flush=True)

    # Build games. Game N runs from start N to start N+1; last game runs
    # to EOV and is marked unfinished (we don't know whether the
    # recording ended at a real game-end or mid-play).
    games = []
    for i, (s, _e) in enumerate(spaced):
        if i + 1 < len(spaced):
            games.append({"start": s, "end": spaced[i + 1][0]})
        else:
            games.append({"start": s, "end": eov, "unfinished": True})

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

    # Legacy motion-detector knobs — accepted for backward compat but ignored.
    p.add_argument("--warmup", type=float, default=None,
                   help=argparse.SUPPRESS)
    p.add_argument("--min-game", type=float, default=None,
                   help=argparse.SUPPRESS)
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

    games = segment_games(rows)
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
