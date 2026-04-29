import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def build_mask(frame_shape, poly, resize_w):
    H, W = frame_shape[:2]
    scale = resize_w / W
    newH = int(round(H * scale))
    poly_s = (poly.astype(np.float32) * scale).astype(np.int32)
    mask = np.zeros((newH, resize_w), dtype=np.uint8)
    cv2.fillPoly(mask, [poly_s], 255)
    area = int(np.count_nonzero(mask))
    return mask, area, (resize_w, newH)


def smooth1d(x, win):
    if win <= 1:
        return x
    k = np.ones(win, dtype=np.float32) / win
    return np.convolve(x, k, mode="same")


def motion_series(video_path, court_mask, court_area, out_size, sample_fps, diff_thr, min_blob_px):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise SystemExit(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_sec = total_frames / fps if fps else 0
    step = max(1, int(round(fps / sample_fps)))

    print(f"Video: {duration_sec/60:.1f} min ({total_frames} frames @ {fps:.1f} fps)")
    print(f"Sampling every {step} frames ({sample_fps} fps analysis)")
    import sys
    sys.stdout.flush()

    prev = None
    times = []
    scores = []
    last_pct = -1

    idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break

        if idx % step != 0:
            idx += 1
            continue

        # Progress reporting
        if total_frames > 0:
            pct = int(100 * idx / total_frames)
            if pct >= last_pct + 10:
                elapsed_min = idx / fps / 60
                print(f"Progress: {pct}% ({elapsed_min:.0f} min of video analyzed)")
                sys.stdout.flush()
                last_pct = pct

        ok, frame = cap.retrieve()
        if not ok:
            break

        frame = cv2.resize(frame, out_size, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        if prev is not None:
            diff = cv2.absdiff(prev, gray)
            _, th = cv2.threshold(diff, diff_thr, 255, cv2.THRESH_BINARY)
            th = cv2.bitwise_and(th, th, mask=court_mask)

            num, _, stats, _ = cv2.connectedComponentsWithStats(th, connectivity=8)
            moving_px = 0
            for i_comp in range(1, num):
                comp_area = stats[i_comp, cv2.CC_STAT_AREA]
                if comp_area >= min_blob_px:
                    moving_px += comp_area

            motion = (moving_px / court_area) if court_area else 0.0
            times.append(idx / fps)
            scores.append(motion)

        prev = gray
        idx += 1

    cap.release()
    print(f"Motion analysis complete — {len(scores)} samples collected")
    sys.stdout.flush()
    return np.array(times, dtype=np.float32), np.array(scores, dtype=np.float32)


def predict_games(times, scores, *, sample_fps, smooth_sec, thresh_mult, min_gap_sec, min_game_sec,
                  warmup_ignore_sec, long_break_sec, restart_lookahead_sec,
                  burst_lookahead_sec=15.0, burst_percentile=75.0, burst_back_buffer_sec=1.5):
    """Detect games using sustained low-motion breaks.

    Core idea:
      - Compute ROI motion score over time.
      - Find sustained LOW motion runs (candidate breaks).
      - Accept break runs, but for SHORT lulls apply a 'restart soon' guard.
      - Games are the segments between accepted breaks.

      - Cut placement: each game-start cut lands on the first motion BURST
        after the preceding break (i.e. the serve), not on the break-start.
        That keeps clips from including the previous game's wind-down +
        warmup time at the front. A small back-buffer ensures we never clip
        the start of the actual serve.

    This is tuned for pickleball where mid-game pauses happen, but between-game breaks are longer.
    """
    if len(times) == 0:
        return []

    s = smooth1d(scores, max(1, int(round(smooth_sec * sample_fps))))

    # Robust baseline (ignore zeros if possible)
    s_nz = s[s > 0]
    baseline = np.percentile(s_nz, 20) if len(s_nz) > 50 else np.percentile(s, 45)

    low_thr = max(1e-9, baseline * thresh_mult)
    low = s < low_thr

    min_len = int(round(min_gap_sec * sample_fps))
    long_len = int(round(long_break_sec * sample_fps))
    look_len = int(round(restart_lookahead_sec * sample_fps))

    breaks = []
    i = 0
    while i < len(low):
        if not low[i]:
            i += 1
            continue
        a = i
        while i < len(low) and low[i]:
            i += 1
        b = i
        if (b - a) >= min_len:
            run_len = b - a
            if run_len < long_len:
                # Guard only for short lulls: if play restarts soon, ignore this break
                restart_thr = max(low_thr * 1.6, np.percentile(s, 60))
                end_k = min(b + look_len, len(s))
                restart_soon = (end_k > b) and (np.max(s[b:end_k]) >= restart_thr)
                if restart_soon:
                    continue
            breaks.append((a, b))

    # --- Cut-point refinement ---------------------------------------------
    # Find the first sustained motion burst at or after `start_idx` — that's
    # the serve. Returns start_idx unchanged if nothing burst-like shows up
    # within burst_lookahead_sec.
    burst_look = max(1, int(round(burst_lookahead_sec * sample_fps)))
    burst_window = max(1, int(round(1.0 * sample_fps)))  # 1s sustained
    burst_back_buffer = max(0, int(round(burst_back_buffer_sec * sample_fps)))
    # A "burst" is well above the walking-back-into-position level. We use
    # max(low_thr * 2.5, p75 of motion) so it scales with the session.
    burst_thr = max(low_thr * 2.5, np.percentile(s, burst_percentile))

    def find_serve_cut(start_idx):
        end_k = min(start_idx + burst_look, len(s))
        if end_k <= start_idx + burst_window:
            return start_idx
        # First k where the next 1-second window sustains motion >= burst_thr
        for k in range(start_idx, end_k - burst_window + 1):
            if np.mean(s[k:k + burst_window]) >= burst_thr:
                # Back-buffer a touch so we don't clip the very start of the serve
                return max(start_idx, k - burst_back_buffer)
        return start_idx  # fallback: no clear burst

    # Cut points at break ENDS (not starts), then refined to the first serve
    cut = [find_serve_cut(0)]
    for _a, b in breaks:
        cut.append(find_serve_cut(b))
    cut.append(len(times) - 1)
    cut = sorted(set(cut))

    # Warmup ignore: force first cut at/after warmup, then refine to first serve
    if warmup_ignore_sec and warmup_ignore_sec > 0:
        warm_idx = int(np.searchsorted(times, warmup_ignore_sec))
        cut = [c for c in cut if c >= warm_idx]
        cut = [find_serve_cut(warm_idx)] + cut
        cut = sorted(set(cut))

    games = []
    for a, b in zip(cut[:-1], cut[1:]):
        if b <= a:
            continue
        start_t = float(times[a])
        end_t = float(times[b])
        if (end_t - start_t) >= min_game_sec:
            games.append((start_t, end_t))

    # Always keep tail by extending last game to end
    if games:
        games[-1] = (games[-1][0], float(times[-1]))

    return games


def write_srt(games, out_path: Path, pad_before: float = 0.0, pad_after: float = 0.0):
    def srt_time(t):
        hh = int(t // 3600); t -= hh * 3600
        mm = int(t // 60);   t -= mm * 60
        ss = int(t); ms = int(round((t - ss) * 1000))
        return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"

    lines = []
    for i, (s, e) in enumerate(games, start=1):
        s2 = max(0.0, s - pad_before)
        e2 = max(s2, e + pad_after)
        lines += [str(i), f"{srt_time(s2)} --> {srt_time(e2)}", f"Game {i:02d}", ""]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print("Wrote", out_path.resolve(), f"({len(games)} segments)")


def main():
    p = argparse.ArgumentParser(description="Detect pickleball games via ROI motion and write an SRT.")
    p.add_argument("video", help="Path to input video file")
    p.add_argument("--roi", default="roi.json", help="Path to roi.json (polygon). Default: roi.json")
    p.add_argument("--out", default=None, help="Output SRT path. Default: <video_stem>_games.srt next to video")

    # knobs (defaults are the ones we converged on)
    p.add_argument("--warmup", type=float, default=0, help="Ignore first N seconds as warmup (default 0)")
    p.add_argument("--min-game", type=float, default=5*60, help="Minimum game length in seconds (default 300)")
    p.add_argument("--min-gap", type=float, default=8, help="Minimum low-motion break length in seconds (default 8)")
    p.add_argument("--long-break", type=float, default=22, help="Treat breaks >= this as real even if restart soon (default 22)")
    p.add_argument("--restart-lookahead", type=float, default=18, help="Seconds to look for restart after a short lull (default 18)")

    p.add_argument("--thresh-mult", type=float, default=0.9, help="Low-motion threshold multiplier (default 0.9)")
    p.add_argument("--smooth", type=float, default=1.5, help="Smoothing window in seconds (default 1.5)")
    p.add_argument("--sample-fps", type=float, default=2, help="Analysis sample FPS (default 2)")
    p.add_argument("--resize-w", type=int, default=640, help="Downscale width for analysis (default 640)")
    p.add_argument("--diff-thr", type=int, default=12, help="Frame diff threshold (default 12)")
    p.add_argument("--min-blob", type=int, default=35, help="Min connected-component area to count as motion (default 35)")

    p.add_argument("--pad-before", type=float, default=0.0, help="Seconds to pad before each game (default 0)")
    p.add_argument("--pad-after", type=float, default=0.0, help="Seconds to pad after each game (default 0)")

    # Burst-detection tuning (cuts land on the first serve, not break-end)
    p.add_argument("--burst-lookahead", type=float, default=15.0,
                   help="Seconds to scan past a break for the first serve burst (default 15)")
    p.add_argument("--burst-percentile", type=float, default=75.0,
                   help="Motion percentile that counts as a 'burst' (default 75)")
    p.add_argument("--burst-back-buffer", type=float, default=1.5,
                   help="Seconds to back off from the detected burst so the clip never starts mid-serve (default 1.5)")

    args = p.parse_args()

    video_path = Path(args.video).expanduser().resolve()
    roi_path = Path(args.roi).expanduser().resolve()
    if not video_path.exists():
        raise SystemExit(f"Video not found: {video_path}")
    if not roi_path.exists():
        raise SystemExit(f"ROI json not found: {roi_path}")

    out_path = Path(args.out).expanduser().resolve() if args.out else (video_path.parent / f"{video_path.stem}_games.srt")

    roi = json.loads(roi_path.read_text())
    if roi.get("type") != "polygon" or "points" not in roi:
        raise SystemExit("roi.json must be like: {'type':'polygon','points':[[x,y],...]} ")

    poly = np.array(roi["points"], dtype=np.int32)

    cap = cv2.VideoCapture(str(video_path))
    ok, frame0 = cap.read()
    cap.release()
    if not ok:
        raise SystemExit("Couldn't read first frame from video")

    court_mask, court_area, out_size = build_mask(frame0.shape, poly, args.resize_w)

    times, scores = motion_series(
        video_path,
        court_mask,
        court_area,
        out_size,
        args.sample_fps,
        args.diff_thr,
        args.min_blob,
    )

    games = predict_games(
        times,
        scores,
        sample_fps=args.sample_fps,
        smooth_sec=args.smooth,
        thresh_mult=args.thresh_mult,
        min_gap_sec=args.min_gap,
        min_game_sec=args.min_game,
        warmup_ignore_sec=args.warmup,
        long_break_sec=args.long_break,
        restart_lookahead_sec=args.restart_lookahead,
        burst_lookahead_sec=args.burst_lookahead,
        burst_percentile=args.burst_percentile,
        burst_back_buffer_sec=args.burst_back_buffer,
    )

    write_srt(games, out_path, pad_before=args.pad_before, pad_after=args.pad_after)


if __name__ == "__main__":
    main()
