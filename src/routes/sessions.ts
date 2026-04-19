import { Router } from "express";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { detectGames, exportClips } from "../services/video-processor.js";
import { uploadClipToPbVision, UploadError } from "../pbvision/upload.js";
import type { Session, GameSegment } from "../types.js";

const router = Router();

const uploadsInFlight = new Set<string>();

// Build a filename-safe prefix from player names + booking date.
// Produces e.g. "kr-do-pk-2026-04-15" for Kellie Rowell / Debbie O'Connor / Patricia Kraieski.
function computeClipNamePrefix(session: Session): string | null {
  const names = session.player_names || [];
  const initials = names
    .map((name) =>
      name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .filter((c) => /[a-z]/i.test(c))
        .join("")
        .toLowerCase(),
    )
    .filter(Boolean)
    .join("-");

  const date = session.booking_time
    ? session.booking_time.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  if (!initials) return date;
  return `${initials}-${date}`;
}

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

  // Clear old logs and update status
  db.prepare("DELETE FROM session_logs WHERE session_id = ?").run(session.id);
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
    // Remove any clip files from a prior export so re-runs don't leave stale
    // files hanging around (e.g. when segment count shrinks, or when the
    // prefix has changed since the last export).
    if (session.clip_paths && session.clip_paths.length > 0) {
      let removed = 0;
      for (const oldClip of session.clip_paths) {
        try { fs.unlinkSync(oldClip); removed++; } catch { /* already gone */ }
      }
      if (removed > 0) addLog(`Removed ${removed} existing clip file${removed !== 1 ? "s" : ""} before re-export`);
    }

    const namePrefix = computeClipNamePrefix(session) ?? undefined;
    if (namePrefix) addLog(`Naming clips as ${namePrefix}-gm-N`);

    const clipPaths = await exportClips(
      { videoPath: session.video_path, segments, outputDir, namePrefix },
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

// POST /api/sessions/:id/pbvision-upload — Upload exported clips to pb.vision
// Uploads are sequential (one browser session per clip). Clips that already
// have a video ID in pbvision_video_ids are skipped, so this is safe to retry.
router.post("/:id/pbvision-upload", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  if (!session.clip_paths || session.clip_paths.length === 0) {
    return res.status(400).json({ error: "No clips to upload" });
  }
  if (uploadsInFlight.has(session.id)) {
    return res.status(409).json({ error: "An upload is already running for this session" });
  }

  uploadsInFlight.add(session.id);
  const headed = req.body?.headed !== false; // default true — pb.vision likely has CF too

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  // Work off the existing vids array so retries skip already-uploaded clips
  const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
  while (vids.length < session.clip_paths.length) vids.push(null);

  db.prepare(
    "UPDATE sessions SET status = 'uploading', error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(session.id);
  addLog(`Starting pb.vision upload of ${session.clip_paths.length} clips...`);

  try {
    for (let i = 0; i < session.clip_paths.length; i++) {
      if (vids[i]) {
        addLog(`Clip ${i + 1}/${session.clip_paths.length}: already uploaded (${vids[i]}), skipping`);
        continue;
      }
      const clipPath = session.clip_paths[i];
      addLog(`Clip ${i + 1}/${session.clip_paths.length}: uploading ${path.basename(clipPath)}`);
      const { vid } = await uploadClipToPbVision({
        videoPath: clipPath,
        headed,
        onLog: (line) => addLog(`  ${line}`),
      });
      vids[i] = vid;
      addLog(`Clip ${i + 1}/${session.clip_paths.length}: uploaded — ${vid}`);

      db.prepare(
        "UPDATE sessions SET pbvision_video_ids = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(JSON.stringify(vids), session.id);
    }

    const allDone = vids.every((v) => !!v);
    db.prepare(
      "UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(allDone ? "processing" : "uploading", session.id);
    addLog(allDone ? "All clips uploaded to pb.vision" : "Upload batch complete");

    const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
    res.json(rowToSession(updated));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof UploadError ? err.code : "unknown";
    db.prepare(
      "UPDATE sessions SET status = 'failed', error = ?, pbvision_video_ids = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(msg, JSON.stringify(vids), session.id);
    addLog(`Upload failed: [${code}] ${msg}`);
    res.status(500).json({ error: msg, code });
  } finally {
    uploadsInFlight.delete(session.id);
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
    UPDATE sessions SET segments = NULL, clip_paths = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?
  `).run(session.id);

  // Clear old logs so the next detection starts fresh
  db.prepare("DELETE FROM session_logs WHERE session_id = ?").run(session.id);

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
