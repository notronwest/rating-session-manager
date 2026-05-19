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
POST_TAP_QUIET_SEC = 60    # after a real paddle tap, the court empties
                           # for tens of seconds (players walk off). We
                           # check the 60s after the cluster end.
POST_TAP_MIN_ZEROS = 5     # require at least this many samples with
                           # n_total == 0 in the post-tap window.
                           # Was 25 (Wed-specific). Smaller venues / faster
                           # sessions like May 14 only see 5-15s of n=0
                           # after a real tap because the next game starts
                           # before the court fully clears.
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


def segment_games(rows, verbose=True):
    """Apply paddle-tap + formation segmentation. Returns
    [{start, end, unfinished?}, ...]."""
    if not rows:
        return []

    # Paddle-tap candidates: find runs, then merge runs within
    # TAP_MERGE_GAP_SEC of each other. For each merged cluster we keep
    # the indices into rows so we can score it.
    tap_runs = find_runs(rows, is_paddle_tap, min_len=1)
    merged = []  # list of [start_t, end_t, lo_idx, hi_idx]
    for lo, hi in tap_runs:
        s, e = rows[lo]["t"], rows[hi]["t"]
        if merged and s - merged[-1][1] <= TAP_MERGE_GAP_SEC:
            merged[-1][1] = e
            merged[-1][3] = hi  # extend index range
        else:
            merged.append([s, e, lo, hi])
    # Sustained filter (TAP_SUSTAINED_MIN_SEC=0 → keeps all single-sample
    # clusters) AND max-duration filter (drops clusters > 25s that are
    # really dinking-practice activity, not paddle taps).
    sustained = [(s, e, lo, hi) for s, e, lo, hi in merged
                 if TAP_SUSTAINED_MIN_SEC <= (e - s) <= TAP_MAX_DURATION_SEC]

    # Post-tap quiet filter: a real paddle tap is followed by a stretch
    # of empty court while players walk off. Mid-game brief clusters
    # (rally chaos) and drill-end clusters don't have this — activity
    # resumes within seconds. We count the n=0 samples in the next
    # POST_TAP_QUIET_SEC window; real game-ends have >= POST_TAP_MIN_ZEROS,
    # everything else has fewer.
    quiet_filtered = []
    for s, e, lo, hi in sustained:
        win_lo = hi + 1
        win_hi = min(len(rows), win_lo + POST_TAP_QUIET_SEC)
        if win_lo >= len(rows):
            quiet_filtered.append((s, e, lo, hi))
            continue
        n_zeros = sum(1 for i in range(win_lo, win_hi)
                      if rows[i]["n"] == 0)
        if n_zeros >= POST_TAP_MIN_ZEROS:
            quiet_filtered.append((s, e, lo, hi))
    sustained = quiet_filtered

    # Non-max suppression: walk through candidates in time order, score
    # each. If a candidate is within MIN_GAME_GAP_SEC of one we've already
    # kept, keep whichever has the higher score and drop the other.
    # This correctly picks the strong tap-moment over weaker post-game
    # milling clusters that come ~2 minutes after the real tap.
    kept = []
    for s, e, lo, hi in sustained:
        score = cluster_score(rows, lo, hi)
        # Find conflicts (existing kept clusters within MIN_GAME_GAP)
        conflict_idx = None
        for i, (ks, ke, klo, khi, kscore) in enumerate(kept):
            if abs(s - ks) < MIN_GAME_GAP_SEC or abs(e - ke) < MIN_GAME_GAP_SEC:
                conflict_idx = i
                break
        if conflict_idx is None:
            kept.append((s, e, lo, hi, score))
        elif score > kept[conflict_idx][4]:
            # Replace the weaker conflicting cluster
            kept[conflict_idx] = (s, e, lo, hi, score)
        # else: drop this candidate
    taps = [(s, e) for s, e, lo, hi, score in kept]

    # End-of-video guard
    eov = rows[-1]["t"]
    final_unfinished = False
    if taps and (eov - taps[-1][1]) < EOV_GUARD_SEC:
        taps = taps[:-1]
        final_unfinished = True

    if verbose:
        print(f"\nPaddle taps detected: {len(taps)}"
              + (f" (+1 unfinished)" if final_unfinished else ""), flush=True)
        for s, e in taps:
            print(f"  TAP {fmt_t(s)} -> {fmt_t(e)}", flush=True)

    # Build games. Find each game's start as the first 2+2 formation
    # within its window (between previous tap and current tap).
    games = []
    if taps:
        first_tap = taps[0][0]
        g1_start = find_game_start(rows, 0, first_tap)
        if g1_start is None:
            g1_start = 90.0
        games.append({"start": g1_start, "end": taps[0][0]})

        for i in range(len(taps) - 1):
            tap_end = taps[i][1]
            next_tap = taps[i+1][0]
            start = find_game_start(rows, tap_end, next_tap)
            if start is None:
                start = tap_end + 30
            games.append({"start": start, "end": next_tap})

    # Unfinished-game-at-tail check. Two cases both produce an unfinished
    # game appended at the end of the segment list:
    #   (a) EOV_GUARD already peeled the last tap (it was end-of-session
    #       bunching); the period between the prior tap and EOV is the
    #       unfinished game.
    #   (b) Recording simply ran out mid-game with no paddle tap at all
    #       — common when players don't exit the court between games.
    # We detect (b) by checking whether there's significant time after
    # the last completed game's end (which equals the last kept tap, or
    # 0 if there were no taps at all).
    last_completed_end = games[-1]["end"] if games else 0
    tail_sec = eov - last_completed_end
    if final_unfinished or tail_sec >= MIN_UNFINISHED_GAME_SEC:
        start = find_game_start(rows, last_completed_end, eov)
        if start is None:
            start = last_completed_end + 30
        # Only append if the unfinished game is long enough to be a real
        # game (avoid creating a fake "unfinished game" from a couple
        # minutes of post-tap debrief activity).
        if (eov - start) >= MIN_UNFINISHED_GAME_SEC or final_unfinished:
            games.append({"start": start, "end": eov, "unfinished": True})

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
                })
        print(f"Loaded {len(rows)} samples from {args.from_csv}", flush=True)
    else:
        rows = run_yolo(video_path, poly, device=args.device,
                        model_name=args.model)

    if args.dump_csv:
        dump_path = Path(args.dump_csv).expanduser().resolve()
        with dump_path.open("w") as f:
            f.write("time_sec,n,n_far,n_near,x_spread,tightness\n")
            for r in rows:
                f.write(f"{r['t']:.1f},{r['n']},{r['n_far']},"
                        f"{r['n_near']},{r['x_spread']:.0f},"
                        f"{r['tightness']:.0f}\n")
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
