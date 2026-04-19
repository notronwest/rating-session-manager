import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { GameSegment } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "../../scripts/videos");

export interface DetectOptions {
  videoPath: string;
  roiPath?: string;
  warmup?: number;
  minGap?: number;
  longBreak?: number;
  restartLookahead?: number;
  minGame?: number;
}

export interface ExportOptions {
  videoPath: string;
  segments: GameSegment[];
  outputDir: string;
  /**
   * Optional filename prefix — final clip names become
   * `${namePrefix}-gm-${index}${ext}`. If omitted, falls back to "Game NN".
   */
  namePrefix?: string;
}

function findPython(): string {
  // Prefer venv python if it exists
  const venvPython = path.join(SCRIPTS_DIR, "venv", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
}

function parseSrtToSegments(srtText: string): GameSegment[] {
  const timeRe = /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/g;
  const segments: GameSegment[] = [];
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = timeRe.exec(srtText)) !== null) {
    const start = match[1].replace(",", ".");
    const end = match[2].replace(",", ".");
    const startSec = timeToSeconds(start);
    const endSec = timeToSeconds(end);
    segments.push({
      index,
      start,
      end,
      duration_sec: Math.round((endSec - startSec) * 10) / 10,
    });
    index++;
  }
  return segments;
}

function timeToSeconds(t: string): number {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(".");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}

function segmentsToSrt(segments: GameSegment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const start = seg.start.replace(".", ",");
    const end = seg.end.replace(".", ",");
    lines.push(String(seg.index), `${start} --> ${end}`, `Game ${String(seg.index).padStart(2, "0")}`, "");
  }
  return lines.join("\n");
}

export function detectGames(
  opts: DetectOptions,
  onLog: (msg: string) => void
): Promise<GameSegment[]> {
  return new Promise((resolve, reject) => {
    const python = findPython();
    const script = path.join(SCRIPTS_DIR, "detect_games.py");
    const roiPath = opts.roiPath || path.join(SCRIPTS_DIR, "roi.json");

    // Write SRT to a temp location next to the video
    const videoDir = path.dirname(opts.videoPath);
    const videoStem = path.basename(opts.videoPath, path.extname(opts.videoPath));
    const srtPath = path.join(videoDir, `${videoStem}_games.srt`);

    const args = [script, opts.videoPath, "--roi", roiPath, "--out", srtPath];
    if (opts.warmup !== undefined) args.push("--warmup", String(opts.warmup));
    if (opts.minGap !== undefined) args.push("--min-gap", String(opts.minGap));
    if (opts.longBreak !== undefined) args.push("--long-break", String(opts.longBreak));
    if (opts.restartLookahead !== undefined) args.push("--restart-lookahead", String(opts.restartLookahead));
    if (opts.minGame !== undefined) args.push("--min-game", String(opts.minGame));

    onLog(`Video: ${path.basename(opts.videoPath)}`);
    onLog(`Analyzing video for game breaks — this may take several minutes...`);

    const proc = spawn(python, args, { cwd: SCRIPTS_DIR });

    proc.stdout.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onLog(msg);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onLog(msg);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        onLog(`Detection failed (exit code ${code})`);
        reject(new Error(`detect_games.py exited with code ${code}`));
        return;
      }

      try {
        const srtText = fs.readFileSync(srtPath, "utf-8");
        const segments = parseSrtToSegments(srtText);
        onLog(`Detection complete — found ${segments.length} game segments`);
        resolve(segments);
      } catch (err) {
        reject(new Error(`Failed to read SRT output: ${err}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start detect_games.py: ${err.message}`));
    });
  });
}

export function exportClips(
  opts: ExportOptions,
  onLog: (msg: string) => void
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const python = findPython();
    const script = path.join(SCRIPTS_DIR, "export_from_srt.py");

    // Write segments as a temp SRT
    const srtContent = segmentsToSrt(opts.segments);
    const tmpSrt = path.join(opts.outputDir, "games.srt");
    fs.mkdirSync(opts.outputDir, { recursive: true });
    fs.writeFileSync(tmpSrt, srtContent, "utf-8");

    const args = [script, opts.videoPath, tmpSrt, opts.outputDir];
    onLog(`Running: ${python} ${args.join(" ")}`);

    const proc = spawn(python, args, { cwd: SCRIPTS_DIR });

    proc.stdout.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onLog(msg);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) onLog(`[stderr] ${msg}`);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`export_from_srt.py exited with code ${code}`));
        return;
      }

      // The python script writes clips as "Game NN.ext" where NN is the
      // 1-based position in the SRT (not the segment's .index field — they
      // differ after a segment is removed or merged). Rename to
      // "<prefix>-gm-<position>.ext" when a prefix is provided.
      const ext = path.extname(opts.videoPath) || ".mp4";
      const clips = opts.segments.map((_seg, i) => {
        const position = i + 1;
        const sourcePath = path.join(opts.outputDir, `Game ${String(position).padStart(2, "0")}${ext}`);
        if (!opts.namePrefix) return sourcePath;
        const targetPath = path.join(opts.outputDir, `${opts.namePrefix}-gm-${position}${ext}`);
        try {
          if (sourcePath !== targetPath && fs.existsSync(sourcePath)) {
            fs.renameSync(sourcePath, targetPath);
            onLog(`Renamed ${path.basename(sourcePath)} → ${path.basename(targetPath)}`);
          } else if (!fs.existsSync(sourcePath)) {
            onLog(`Warning: expected source clip not found: ${path.basename(sourcePath)}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          onLog(`Warning: could not rename ${path.basename(sourcePath)} → ${path.basename(targetPath)}: ${msg}`);
          return sourcePath;
        }
        return targetPath;
      });
      const existing = clips.filter((c) => fs.existsSync(c));
      onLog(`Exported ${existing.length} clips to ${opts.outputDir}`);
      resolve(existing);
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start export_from_srt.py: ${err.message}`));
    });
  });
}
