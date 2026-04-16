import { Router } from "express";
import fs from "fs";
import path from "path";

const router = Router();

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".m4v", ".avi"]);

// GET /api/videos — List video files in VIDEO_DIR
router.get("/", (_req, res) => {
  const videoDir = process.env.VIDEO_DIR;
  if (!videoDir) {
    return res.json({ videos: [], error: "VIDEO_DIR not configured" });
  }

  if (!fs.existsSync(videoDir)) {
    return res.json({ videos: [], error: `VIDEO_DIR does not exist: ${videoDir}` });
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

    res.json({ videos });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ videos: [], error: msg });
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

export default router;
