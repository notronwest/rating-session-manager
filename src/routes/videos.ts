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

export default router;
