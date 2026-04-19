import { Router } from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SCRIPTS_DIR = path.resolve(PROJECT_ROOT, "scripts/videos");
const ROI_PATH = path.join(SCRIPTS_DIR, "roi.json");
const DEFAULT_VIDEO_DIR = path.join(PROJECT_ROOT, "videos");

function getVideoDir(): string {
  return process.env.VIDEO_DIR || DEFAULT_VIDEO_DIR;
}

const router = Router();

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".m4v", ".avi"]);

// GET /api/videos — List video files in VIDEO_DIR (default: <project>/videos)
router.get("/", (_req, res) => {
  const videoDir = getVideoDir();

  // Auto-create the default directory so a fresh clone "just works"
  if (!fs.existsSync(videoDir)) {
    if (videoDir === DEFAULT_VIDEO_DIR) {
      fs.mkdirSync(videoDir, { recursive: true });
    } else {
      return res.json({ videos: [], videoDir, error: `VIDEO_DIR does not exist: ${videoDir}` });
    }
  }

  try {
    const entries = fs.readdirSync(videoDir, { withFileTypes: true });
    const videos = entries
      .filter((e) => e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
      .map((e) => {
        const fullPath = path.join(videoDir, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          path: fullPath,
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    res.json({ videos, videoDir });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ videos: [], videoDir, error: msg });
  }
});

// GET /api/videos/stream?path=... — Stream video file with range support
router.get("/stream", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path required" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
  };
  const contentType = mimeTypes[ext] || "video/mp4";

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/videos/frame?path=...&t=60 — Extract a single frame at time t seconds as JPEG
router.get("/frame", (req, res) => {
  const filePath = req.query.path as string;
  const t = parseFloat((req.query.t as string) || "60");
  if (!filePath) return res.status(400).json({ error: "path required" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  // Use ffmpeg to extract a frame
  const args = [
    "-ss", String(t),
    "-i", filePath,
    "-vframes", "1",
    "-q:v", "3",
    "-f", "image2pipe",
    "-vcodec", "mjpeg",
    "pipe:1",
  ];

  const proc = spawn("ffmpeg", args);
  res.setHeader("Content-Type", "image/jpeg");
  proc.stdout.pipe(res);

  proc.stderr.on("data", () => { /* ffmpeg is verbose, ignore */ });
  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("close", (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ error: `ffmpeg exited with code ${code}` });
    }
  });
});

// GET /api/videos/dimensions?path=... — Get video width and height
router.get("/dimensions", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path required" });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration",
    "-of", "json",
    filePath,
  ];
  const proc = spawn("ffprobe", args);
  let output = "";
  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.on("close", (code) => {
    if (code !== 0) return res.status(500).json({ error: "ffprobe failed" });
    try {
      const data = JSON.parse(output);
      const stream = data.streams?.[0];
      res.json({
        width: stream?.width,
        height: stream?.height,
        duration: parseFloat(stream?.duration || "0"),
      });
    } catch (err) {
      res.status(500).json({ error: "failed to parse ffprobe output" });
    }
  });
  proc.on("error", (err) => res.status(500).json({ error: err.message }));
});

// GET /api/videos/roi — Read current roi.json
router.get("/roi", (_req, res) => {
  if (!fs.existsSync(ROI_PATH)) return res.json({ type: "polygon", points: [] });
  const raw = fs.readFileSync(ROI_PATH, "utf-8");
  try {
    res.json(JSON.parse(raw));
  } catch {
    res.json({ type: "polygon", points: [] });
  }
});

// PUT /api/videos/roi — Save new roi.json
router.put("/roi", (req, res) => {
  const { points } = req.body;
  if (!Array.isArray(points) || points.length < 3) {
    return res.status(400).json({ error: "points must be an array of at least 3 [x,y] pairs" });
  }
  const roi = { type: "polygon", points };
  // Format with each point on one line
  const pointsStr = points.map((p: number[]) => `    [${p[0]}, ${p[1]}]`).join(",\n");
  const json = `{\n  "type": "polygon",\n  "points": [\n${pointsStr}\n  ]\n}\n`;
  fs.writeFileSync(ROI_PATH, json, "utf-8");
  res.json(roi);
});

export default router;
