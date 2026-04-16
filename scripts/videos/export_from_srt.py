import re
import sys
import subprocess
from pathlib import Path

SRT_TIME_RE = re.compile(r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})")


def srt_to_ffmpeg_time(t: str) -> str:
    return t.replace(",", ".")


def parse_srt_segments(srt_text: str):
    segs = []
    for m in SRT_TIME_RE.finditer(srt_text):
        start = srt_to_ffmpeg_time(m.group(1))
        end = srt_to_ffmpeg_time(m.group(2))
        segs.append((start, end))
    return segs


def run(cmd):
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 export_from_srt.py <input_video> <games.srt> <out_dir>")
        sys.exit(2)

    in_video = Path(sys.argv[1]).expanduser().resolve()
    srt_path = Path(sys.argv[2]).expanduser().resolve()
    out_dir = Path(sys.argv[3]).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not in_video.exists():
        raise SystemExit(f"Input video not found: {in_video}")
    if not srt_path.exists():
        raise SystemExit(f"SRT not found: {srt_path}")

    srt_text = srt_path.read_text(encoding="utf-8", errors="ignore")
    segs = parse_srt_segments(srt_text)
    if not segs:
        raise SystemExit("No segments found in SRT.")

    ext = in_video.suffix.lower() if in_video.suffix else ".mp4"

    for i, (start, end) in enumerate(segs, start=1):
        out_file = out_dir / f"Game {i:02d}{ext}"

        cmd = [
            "ffmpeg", "-hide_banner", "-y",
            "-i", str(in_video),
            "-ss", start,
            "-to", end,
            "-map", "0",
            "-c", "copy",
            str(out_file)
        ]
        try:
            run(cmd)
        except subprocess.CalledProcessError:
            # Fallback variant
            cmd2 = [
                "ffmpeg", "-hide_banner", "-y",
                "-ss", start,
                "-to", end,
                "-i", str(in_video),
                "-map", "0",
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                str(out_file)
            ]
            run(cmd2)

    print(f"\nDone. Wrote {len(segs)} clips to: {out_dir}")


if __name__ == "__main__":
    main()
