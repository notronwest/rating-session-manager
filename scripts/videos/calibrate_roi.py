"""
Interactive court-polygon calibrator. Opens a frame from the video and
lets you click 4 corners to define the court polygon. Writes roi.json.

Usage:
  python3 calibrate_roi.py <video> [--out roi.json] [--at-sec 90]

Click 4 corners in this order:
  1. Far-left baseline corner (top-left in the image)
  2. Far-right baseline corner (top-right in the image)
  3. Near-right baseline corner (bottom-right in the image)
  4. Near-left baseline corner (bottom-left in the image)

Press 'r' to reset and start over, 's' to save and exit, ESC to quit
without saving.
"""
import argparse
import json
import sys
from pathlib import Path

import cv2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--out", type=Path, default=Path("scripts/videos/roi.json"))
    ap.add_argument("--at-sec", type=float, default=90,
                    help="Grab the calibration frame at this timestamp (default 90s).")
    args = ap.parse_args()

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        sys.exit(f"Could not open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(args.at_sec * fps))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        sys.exit("Could not read frame")

    points = []
    window = "ROI Calibrator — click 4 corners (FL → FR → NR → NL)"
    print(__doc__)

    def render():
        img = frame.copy()
        # Draw current points + polygon outline
        for i, (x, y) in enumerate(points):
            cv2.circle(img, (x, y), 6, (0, 0, 255), -1)
            label = ["FL (far-left)", "FR (far-right)",
                     "NR (near-right)", "NL (near-left)"][i]
            cv2.putText(img, label, (x + 10, y), cv2.FONT_HERSHEY_SIMPLEX,
                        0.6, (0, 0, 255), 2)
        if len(points) >= 2:
            for i in range(len(points) - 1):
                cv2.line(img, points[i], points[i + 1], (0, 255, 255), 2)
            if len(points) == 4:
                cv2.line(img, points[3], points[0], (0, 255, 255), 2)
        # Help bar
        help_txt = (f"Click corners ({len(points)}/4)  |  "
                    "r=reset  s=save  ESC=quit")
        cv2.putText(img, help_txt, (10, 25), cv2.FONT_HERSHEY_SIMPLEX,
                    0.6, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.imshow(window, img)

    def on_click(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN and len(points) < 4:
            points.append((x, y))
            render()

    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(window, on_click)
    render()

    while True:
        k = cv2.waitKey(20) & 0xFF
        if k == 27:  # ESC
            print("Aborted. roi.json not changed.")
            cv2.destroyAllWindows()
            return
        if k in (ord('r'), ord('R')):
            points.clear()
            render()
        if k in (ord('s'), ord('S')):
            if len(points) != 4:
                print(f"Need 4 corners (have {len(points)}). Click more or 'r' to reset.")
                continue
            payload = {"type": "polygon",
                       "points": [[int(x), int(y)] for x, y in points]}
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(payload, indent=2) + "\n")
            print(f"Wrote {args.out.resolve()}")
            cv2.destroyAllWindows()
            return


if __name__ == "__main__":
    main()
