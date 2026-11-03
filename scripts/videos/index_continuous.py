"""
Index games out of CONTINUOUS court footage (SP-11, D-0059).

detect_games.py already finds games on long footage: a game boundary is the
court staying empty for >= BREAK_SEC, and that signal has no notion of a
"session". This module adds only what continuous footage needs around it — it
does NOT contain a second detector:

  1. STITCH   The recorder writes bounded wall-clock MPEG-TS segments. Sampled
              rows from consecutive segments are laid on ONE wall-clock
              timeline, so a segment cut is never a boundary; only an empty
              court is. A genuine hole in the footage (a missing segment) is
              not "empty court" — unknown is not empty — so the timeline is
              split there and games touching the hole are flagged gap_cut.
  2. GATE     Only windows the court was booked in (the cached occupancy read,
              resolved by the TypeScript caller) are segmented. Rows outside
              every window are dropped, and the timeline is split at each
              window edge for the same reason as a gap.
  3. LOCATE   Each game is expressed as pointers into segments:
              (start segment, offset) .. (end segment, offset). Nothing is
              copied or re-encoded.

Rolling window: when the recording is still going (--capture-ended absent),
the trailing open span is withheld and reported as open_tail_start, so the
next run resumes from there and carries the game across the join.

Pure functions are importable without YOLO; only run_segment_rows() loads it.
"""
import argparse
import bisect
import hashlib
import json
import sys
import traceback
from pathlib import Path

from detect_games import (DEFAULT_ACTIVE_MIN_N, DEFAULT_BREAK_SEC,
                          DEFAULT_EMPTY_MAX_N, DEFAULT_MIN_GAME_SEC,
                          load_polygon, run_yolo, segment_games)

# Segments are cut back to back; two ffmpeg segment boundaries can disagree by
# a frame or two. Anything wider than this between one segment's end and the
# next one's start is missing footage, not a clean cut.
GAP_TOLERANCE_SEC = 3.0


def stitch_rows(segments, rows_by_segment):
    """Lay each segment's rows on one wall-clock timeline.

    segments: [{path, start (epoch s), duration (s)}] in any order.
    rows_by_segment: {path: [row]} where row["t"] is seconds into that segment.
    Returns (base, runs): `base` is the epoch of t=0; `runs` is a list of
    contiguous row lists (t in seconds since base), split wherever footage is
    missing.
    """
    segs = sorted(segments, key=lambda s: s["start"])
    if not segs:
        return 0.0, []
    base = segs[0]["start"]
    runs, cur, prev_end = [], [], None
    for seg in segs:
        if prev_end is not None and seg["start"] - prev_end > GAP_TOLERANCE_SEC:
            if cur:
                runs.append(cur)
            cur = []
        for r in rows_by_segment.get(seg["path"], []):
            g = dict(r)
            g["t"] = (seg["start"] - base) + r["t"]
            cur.append(g)
        prev_end = seg["start"] + seg["duration"]
    if cur:
        runs.append(cur)
    return base, runs


def clip_run(rows, windows, base):
    """Split a run into pieces, one per in-use window it overlaps.

    windows: [[start_epoch, end_epoch]] — the court was booked. Returns
    [(rows, start_cut, end_cut)] where *_cut is "window" when the piece was
    trimmed by a window edge rather than by the run's own ends.
    """
    if not rows:
        return []
    lo, hi = rows[0]["t"], rows[-1]["t"]
    pieces = []
    for ws, we in sorted(windows):
        s, e = ws - base, we - base
        sel = [r for r in rows if s <= r["t"] < e]
        if not sel:
            continue
        pieces.append((sel, "window" if s > lo else None,
                       "window" if e <= hi else None))
    return pieces


def locate(segments, t):
    """Global t (s since base) -> (segment path, offset s into it)."""
    segs = sorted(segments, key=lambda s: s["start"])
    base = segs[0]["start"]
    starts = [s["start"] - base for s in segs]
    i = max(0, bisect.bisect_right(starts, t) - 1)
    return segs[i]["path"], max(0.0, t - starts[i])


def index_games(segments, rows_by_segment, windows, *, capture_ended=False,
                break_sec=DEFAULT_BREAK_SEC, empty_max_n=DEFAULT_EMPTY_MAX_N,
                active_min_n=DEFAULT_ACTIVE_MIN_N,
                min_game_sec=DEFAULT_MIN_GAME_SEC, verbose=False):
    """Pure core: segments + sampled rows + in-use windows -> game rows.

    windows=None means "no gate" (index everything); an empty list means the
    court was never in use, which yields zero games.
    Returns {"games": [...], "open_tail_start": epoch|None}.
    """
    base, runs = stitch_rows(segments, rows_by_segment)
    if not runs:
        return {"games": [], "open_tail_start": None}
    last_run = runs[-1]
    games, open_tail = [], None
    for run in runs:
        if windows is None:
            pieces = [(run, None, None)]
        else:
            pieces = clip_run(run, windows, base)
        for pi, (rows, start_cut, end_cut) in enumerate(pieces):
            if start_cut is None and run is not runs[0] and pi == 0:
                start_cut = "gap"
            # Only the final piece of the final run can still be growing, and
            # only when it was not trimmed by a window edge.
            tail = (run is last_run and pi == len(pieces) - 1
                    and end_cut is None)
            state = {}
            found = segment_games(
                rows, break_sec=break_sec, empty_max_n=empty_max_n,
                active_min_n=active_min_n, min_game_sec=min_game_sec,
                verbose=verbose,
                capture_ended=capture_ended or not tail, state=state)
            if tail and state.get("open_tail_start") is not None:
                open_tail = base + state["open_tail_start"]
            for gi, g in enumerate(found):
                # Play still going when a window closed or footage was missing
                # is not "capture ended" — it is a cut, and is labelled as one.
                cut = None
                if not tail and g["end"] >= rows[-1]["t"]:
                    cut = end_cut or ("gap" if run is not last_run else None)
                games.append(_row(segments, base, g,
                                  start_cut if gi == 0 else None, cut,
                                  unfinished=tail and bool(g.get("unfinished"))))
    games.sort(key=lambda g: g["start"])
    return {"games": games, "open_tail_start": open_tail}


def _row(segments, base, g, start_cut, end_cut, unfinished):
    s_seg, s_off = locate(segments, g["start"])
    e_seg, e_off = locate(segments, g["end"])
    return {
        "start": base + g["start"],
        "end": base + g["end"],
        "source_segment": s_seg,
        "offset": round(s_off, 3),
        "end_segment": e_seg,
        "end_offset": round(e_off, 3),
        # capture ended while play was still going — nothing else qualifies.
        "unfinished": unfinished,
        "start_cut": start_cut,
        "end_cut": end_cut,
    }


def run_segment_rows(seg, poly, device, model, cache_dir):
    """YOLO rows for one segment, cached so a rolling window never re-runs a
    segment it already sampled. Keyed on path + size so a rewritten file misses."""
    path = Path(seg["path"])
    key = hashlib.sha1(f"{path}:{path.stat().st_size}".encode()).hexdigest()[:16]
    cache = Path(cache_dir) / f"{key}.rows.json" if cache_dir else None
    if cache and cache.exists():
        return json.loads(cache.read_text())
    rows = run_yolo(path, poly, device=device, model_name=model, verbose=False)
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(rows))
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--manifest", required=True,
                   help="JSON: {segments:[{path,start,duration}], "
                        "windows:[[start,end]]|null} (epoch seconds)")
    p.add_argument("--roi", required=True, help="Court polygon JSON")
    p.add_argument("--out", required=True, help="Result JSON")
    p.add_argument("--rows-cache", default=None)
    p.add_argument("--device", default="mps", choices=["mps", "cuda", "cpu"])
    p.add_argument("--model", default="yolov8n.pt")
    p.add_argument("--capture-ended", action="store_true",
                   help="Recording is finished: a span still open at the end "
                        "is UNFINISHED rather than withheld")
    p.add_argument("--break-sec", type=float, default=DEFAULT_BREAK_SEC)
    p.add_argument("--min-game", type=float, default=DEFAULT_MIN_GAME_SEC)
    args = p.parse_args()

    man = json.loads(Path(args.manifest).read_text())
    segments, windows = man["segments"], man.get("windows")
    poly = load_polygon(Path(args.roi))

    # Only sample footage inside a window — overnight emptiness costs nothing.
    def wanted(seg):
        if windows is None:
            return True
        return any(seg["start"] < we and ws < seg["start"] + seg["duration"]
                   for ws, we in windows)

    rows_by_segment = {
        s["path"]: run_segment_rows(s, poly, args.device, args.model,
                                    args.rows_cache)
        for s in segments if wanted(s)
    }
    out = index_games(segments, rows_by_segment, windows,
                      capture_ended=args.capture_ended,
                      break_sec=args.break_sec, min_game_sec=args.min_game)
    Path(args.out).write_text(json.dumps(out, indent=2))
    print(f"Indexed {len(out['games'])} game(s)", flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:
        print(f"index_continuous.py crashed: {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
