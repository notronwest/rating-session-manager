import { Router } from "express";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { detectGames, exportClips } from "../services/video-processor.js";
import type { Session, GameSegment } from "../types.js";

const router = Router();

// Helper to parse JSON columns from DB rows
function rowToSession(row: Record<string, unknown>): Session {
  return {
    ...row,
    player_names: row.player_names ? JSON.parse(row.player_names as string) : null,
    segments: row.segments ? JSON.parse(row.segments as string) : null,
    clip_paths: row.clip_paths ? JSON.parse(row.clip_paths as string) : null,
    pbvision_video_ids: row.pbvision_video_ids ? JSON.parse(row.pbvision_video_ids as string) : null,
  } as Session;
}

// GET /api/sessions
router.get("/", (_req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Record<string, unknown>[];
  res.json(rows.map(rowToSession));
});

// POST /api/sessions
router.post("/", (req, res) => {
  const db = getDb();
  const id = uuid();
  const { label, booking_time, player_names, video_path } = req.body;

  db.prepare(`
    INSERT INTO sessions (id, status, label, booking_time, player_names, video_path)
    VALUES (?, 'scheduled', ?, ?, ?, ?)
  `).run(
    id,
    label || null,
    booking_time || null,
    player_names ? JSON.stringify(player_names) : null,
    video_path || null
  );

  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown>;
  res.status(201).json(rowToSession(row));
});

// GET /api/sessions/:id
router.get("/:id", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });
  res.json(rowToSession(row));
});

// GET /api/sessions/:id/logs
router.get("/:id/logs", (req, res) => {
  const db = getDb();
  const logs = db.prepare(
    "SELECT * FROM session_logs WHERE session_id = ? ORDER BY id ASC"
  ).all(req.params.id);
  res.json(logs);
});

// PATCH /api/sessions/:id
router.patch("/:id", (req, res) => {
  const db = getDb();
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!session) return res.status(404).json({ error: "Session not found" });

  const updates: string[] = [];
  const values: unknown[] = [];

  const allowedFields = ["status", "label", "booking_time", "player_names", "video_path", "roi_path", "segments", "error"];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      const val = req.body[field];
      values.push(Array.isArray(val) || (typeof val === "object" && val !== null) ? JSON.stringify(val) : val);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown>;
  res.json(rowToSession(row));
});

// POST /api/sessions/:id/detect — Run game detection
router.post("/:id/detect", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  if (!session.video_path) return res.status(400).json({ error: "No video path assigned" });

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  // Update status to splitting
  db.prepare("UPDATE sessions SET status = 'splitting', error = NULL, updated_at = datetime('now') WHERE id = ?").run(session.id);
  addLog("Starting game detection...");

  try {
    const segments = await detectGames(
      {
        videoPath: session.video_path,
        roiPath: session.roi_path || undefined,
        warmup: req.body.warmup,
        minGap: req.body.min_gap,
        longBreak: req.body.long_break,
        restartLookahead: req.body.restart_lookahead,
        minGame: req.body.min_game,
      },
      addLog
    );

    db.prepare(
      "UPDATE sessions SET status = 'split', segments = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(segments), session.id);
    addLog(`Detection complete: ${segments.length} games found`);

    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
    res.json(rowToSession(updated));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").run(msg, session.id);
    addLog(`Detection failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/:id/export — Export clips
router.post("/:id/export", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  if (!session.video_path) return res.status(400).json({ error: "No video path assigned" });

  // Use segments from request body (edited) or from DB
  const segments: GameSegment[] = req.body.segments || session.segments;
  if (!segments || segments.length === 0) return res.status(400).json({ error: "No segments to export" });

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  const outputDir = req.body.output_dir || `${session.video_path}_clips`;

  addLog("Starting clip export...");

  try {
    const clipPaths = await exportClips(
      { videoPath: session.video_path, segments, outputDir },
      addLog
    );

    db.prepare(
      "UPDATE sessions SET clip_paths = ?, segments = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(clipPaths), JSON.stringify(segments), session.id);
    addLog(`Export complete: ${clipPaths.length} clips`);

    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
    res.json(rowToSession(updated));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE sessions SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?").run(msg, session.id);
    addLog(`Export failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

function deleteClipFiles(session: Session) {
  if (!session.clip_paths || session.clip_paths.length === 0) return 0;
  let deleted = 0;
  for (const clipPath of session.clip_paths) {
    try { fs.unlinkSync(clipPath); deleted++; } catch { /* already gone */ }
  }
  // Try to remove the clips directory if empty
  try {
    const dir = path.dirname(session.clip_paths[0]);
    fs.rmdirSync(dir);
  } catch { /* not empty or already gone */ }
  return deleted;
}

// POST /api/sessions/:id/start-over — Delete clips, keep session/segments/logs
router.post("/:id/start-over", (_req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(_req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  const deleted = deleteClipFiles(session);

  db.prepare(`
    UPDATE sessions SET clip_paths = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(session.id);

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };
  addLog(`Start over: deleted ${deleted} clip files`);

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
  res.json(rowToSession(updated));
});

// POST /api/sessions/:id/cancel — Full reset: delete clips, clear segments, logs, reset status
router.post("/:id/cancel", (_req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(_req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  deleteClipFiles(session);

  db.prepare(`
    UPDATE sessions
    SET status = 'scheduled', segments = NULL, clip_paths = NULL, error = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(session.id);

  db.prepare("DELETE FROM session_logs WHERE session_id = ?").run(session.id);

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
  res.json(rowToSession(updated));
});

export default router;
