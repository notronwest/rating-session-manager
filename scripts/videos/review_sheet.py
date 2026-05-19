"""
Build a contact sheet from a games SRT for quick visual verification.

For each game segment, grab one frame near the START (game-start formation)
and one near the END (paddle tap), tile them in a grid with the game index
and timestamps printed on each pair.

Usage:
  python3 review_sheet.py <video> <games.srt> <out.jpg>
"""
import argparse
import re
import sys
from pathlib import Path

import cv2
import numpy as np


SRT_TIME = re.compile(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})")


def parse_srt_seconds(s: str) -> float:
    m = SRT_TIME.match(s.strip())
    h, mn, sc, ms = m.groups()
    return int(h) * 3600 + int(mn) * 60 + int(sc) + int(ms) / 1000


def load_segments(srt_path: Path):
    text = srt_path.read_text(encoding="utf-8", errors="ignore")
    pat = re.compile(
        r"(\d+)\s+(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})"
    )
    segs = []
    for m in pat.finditer(text):
        idx = int(m.group(1))
        s = parse_srt_seconds(m.group(2))
        e = parse_srt_seconds(m.group(3))
        segs.append((idx, s, e))
    return segs


def grab_frame(cap, t_sec, fps):
    """Grab a frame near t_sec. Skip the very first second of a segment
    because there's often a hard cut/transition."""
    cap.set(cv2.CAP_PROP_POS_FRAMES, int((t_sec + 1.0) * fps))
    ok, f = cap.read()
    return f if ok else None


def annotate(img, label, sublabel):
    """Burn a black bar with the label at the top of img."""
    h, w = img.shape[:2]
    cv2.rectangle(img, (0, 0), (w, 56), (0, 0, 0), -1)
    cv2.putText(img, label, (12, 24), cv2.FONT_HERSHEY_SIMPLEX,
                0.75, (255, 255, 255), 2)
    cv2.putText(img, sublabel, (12, 48), cv2.FONT_HERSHEY_SIMPLEX,
                0.55, (180, 180, 180), 1)
    return img


def fmt_t(t):
    return f"{int(t)//60:02d}:{int(t)%60:02d}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video", type=Path)
    p.add_argument("srt", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--thumb-width", type=int, default=480,
                   help="Width per thumbnail in pixels (default 480)")
    args = p.parse_args()

    segs = load_segments(args.srt)
    if not segs:
        sys.exit("No segments found in SRT")
    print(f"loaded {len(segs)} segments")

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        sys.exit(f"Could not open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    eov = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) / fps

    thumbs = []
    for idx, s, e in segs:
        start_f = grab_frame(cap, s, fps)
        # For the end frame, grab just BEFORE the segment ends (= near the
        # paddle tap moment).
        end_t = max(s + 1, e - 2)
        end_f = grab_frame(cap, end_t, fps)
        if start_f is None or end_f is None:
            print(f"  skip Game {idx}: failed to read frame")
            continue

        h, w = start_f.shape[:2]
        scale = args.thumb_width / w
        new_h = int(h * scale)
        start_f = cv2.resize(start_f, (args.thumb_width, new_h))
        end_f = cv2.resize(end_f, (args.thumb_width, new_h))

        dur = e - s
        annotate(start_f, f"Game {idx:02d} START",
                 f"{fmt_t(s)}  (duration {int(dur)//60}m {int(dur)%60}s)")
        annotate(end_f, f"Game {idx:02d} END",
                 f"{fmt_t(e)}  (paddle tap)")

        # Pair them side by side
        pair = np.hstack([start_f, end_f])
        thumbs.append(pair)

    cap.release()

    if not thumbs:
        sys.exit("No frames extracted")

    # Stack all pairs vertically into one tall contact sheet
    sheet = np.vstack(thumbs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.out), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(f"\nWrote {args.out.resolve()}  ({sheet.shape[1]}x{sheet.shape[0]} px)")
    print(f"Open it in Preview and scroll — each row is one game "
          f"(START frame on the left, END frame on the right).")


if __name__ == "__main__":
    main()
