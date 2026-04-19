import { Router } from "express";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { getDb } from "../db/index.js";
import { detectGames, exportClips } from "../services/video-processor.js";
import { uploadClipToPbVision, UploadError } from "../pbvision/upload.js";
import { listPbVisionVideos, ListError } from "../pbvision/list.js";
import { notifyRatingHub, WebhookError } from "../pbvision/webhook.js";
import { createOrUpdateRatingHubSession, RatingHubError } from "../ratinghub/sessions.js";
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
  // Optional — upload only a single clip by its 0-based index
  const onlyIndex =
    typeof req.body?.clip_index === "number" && Number.isInteger(req.body.clip_index)
      ? (req.body.clip_index as number)
      : null;

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  // Work off the existing vids array so retries skip already-uploaded clips
  const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
  while (vids.length < session.clip_paths.length) vids.push(null);

  db.prepare(
    "UPDATE sessions SET status = 'uploading', error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(session.id);
  if (onlyIndex !== null) {
    addLog(`Retrying pb.vision upload for clip ${onlyIndex + 1}/${session.clip_paths.length}...`);
  } else {
    addLog(`Starting pb.vision upload of ${session.clip_paths.length} clips...`);
  }

  try {
    for (let i = 0; i < session.clip_paths.length; i++) {
      if (onlyIndex !== null && i !== onlyIndex) continue;
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

      // Fire-and-warn: notify rating-hub so it can pick up insights.
      try {
        await notifyRatingHub({ sessionId: session.id, videoId: vid, onLog: addLog });
      } catch (whErr) {
        const whMsg = whErr instanceof Error ? whErr.message : String(whErr);
        addLog(`Warning: rating-hub webhook failed for ${vid}: ${whMsg}`);
      }
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

// POST /api/sessions/:id/pbvision-confirm — Manually attach a pb.vision video
// ID to a specific clip (for when the user uploaded via pb.vision's own UI)
// and immediately fire the rating-hub webhook for it.
//
// Body: { clip_index: number, video_id: string }
router.post("/:id/pbvision-confirm", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  const clipIndex = req.body?.clip_index;
  const videoId = typeof req.body?.video_id === "string" ? req.body.video_id.trim() : "";

  if (!session.clip_paths || session.clip_paths.length === 0) {
    return res.status(400).json({ error: "Session has no clips" });
  }
  if (typeof clipIndex !== "number" || !Number.isInteger(clipIndex) || clipIndex < 0 || clipIndex >= session.clip_paths.length) {
    return res.status(400).json({ error: "clip_index out of range" });
  }
  if (!videoId) {
    return res.status(400).json({ error: "video_id is required" });
  }

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
  while (vids.length < session.clip_paths.length) vids.push(null);

  if (vids[clipIndex] && vids[clipIndex] !== videoId) {
    addLog(`Clip ${clipIndex + 1}: replacing existing video ID ${vids[clipIndex]} with ${videoId}`);
  } else if (!vids[clipIndex]) {
    addLog(`Clip ${clipIndex + 1}: attaching video ID ${videoId}`);
  }

  vids[clipIndex] = videoId;

  const allDone = vids.every((v) => !!v);
  db.prepare(
    "UPDATE sessions SET pbvision_video_ids = ?, status = ?, error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(
    JSON.stringify(vids),
    allDone ? "processing" : "uploading",
    session.id,
  );

  // Fire the webhook; never block the 200 — surface errors to logs.
  let webhookError: string | null = null;
  try {
    await notifyRatingHub({ sessionId: session.id, videoId, onLog: addLog });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof WebhookError ? ` (${err.status ?? "n/a"})` : "";
    webhookError = `${msg}${code}`;
    addLog(`Warning: rating-hub webhook failed: ${webhookError}`);
  }

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
  res.json({ ...rowToSession(updated), webhookError });
});

// POST /api/sessions/:id/pbvision-fetch-ids — Scrape the user's pb.vision
// library, auto-match videos to this session's clips by filename, populate
// pbvision_video_ids for the matches, and fire the rating-hub webhook.
// Returns the updated session + any unmatched clips + any unmatched library
// videos so the UI can ask the user to pair them.
router.post("/:id/pbvision-fetch-ids", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  if (!session.clip_paths || session.clip_paths.length === 0) {
    return res.status(400).json({ error: "Session has no clips" });
  }

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  let videos;
  try {
    videos = await listPbVisionVideos({
      headed: req.body?.headed !== false,
      onLog: (line) => addLog(`  ${line}`),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof ListError ? err.code : "unknown";
    addLog(`Fetch failed: [${code}] ${msg}`);
    return res.status(500).json({ error: msg, code });
  }

  addLog(`Fetched ${videos.length} videos from pb.vision library`);

  const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
  while (vids.length < session.clip_paths.length) vids.push(null);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const stem = (p: string) => path.basename(p, path.extname(p));

  const unmatchedVideos = new Set(videos.map((v) => v.vid));
  const matches: { clipIndex: number; clipName: string; vid: string; title: string }[] = [];

  for (let i = 0; i < session.clip_paths.length; i++) {
    if (vids[i]) continue;
    const basename = path.basename(session.clip_paths[i]);
    const stemName = norm(stem(basename));
    const hit = videos.find((v) => {
      if (!unmatchedVideos.has(v.vid)) return false;
      const title = norm(v.title || "");
      return title.includes(stemName) || stemName.includes(title) || title.includes(norm(basename));
    });
    if (hit) {
      vids[i] = hit.vid;
      unmatchedVideos.delete(hit.vid);
      matches.push({ clipIndex: i, clipName: basename, vid: hit.vid, title: hit.title });
      addLog(`  Matched ${basename} → ${hit.vid}`);
    }
  }

  const allDone = vids.every((v) => !!v);
  db.prepare(
    "UPDATE sessions SET pbvision_video_ids = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(
    JSON.stringify(vids),
    allDone ? "processing" : session.status === "failed" ? "uploading" : session.status || "uploading",
    session.id,
  );

  // Fire webhooks for any newly-matched vids
  const webhookErrors: { vid: string; error: string }[] = [];
  for (const m of matches) {
    try {
      await notifyRatingHub({ sessionId: session.id, videoId: m.vid, onLog: addLog });
    } catch (whErr) {
      const msg = whErr instanceof Error ? whErr.message : String(whErr);
      webhookErrors.push({ vid: m.vid, error: msg });
      addLog(`Warning: rating-hub webhook failed for ${m.vid}: ${msg}`);
    }
  }

  const updated = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
  const unmatchedClips = session.clip_paths
    .map((cp, i) => ({ clipIndex: i, clipName: path.basename(cp) }))
    .filter((c) => !vids[c.clipIndex]);
  const unmatchedVideoList = videos.filter((v) => unmatchedVideos.has(v.vid));

  res.json({
    session: rowToSession(updated),
    matched: matches,
    unmatchedClips,
    unmatchedVideos: unmatchedVideoList,
    webhookErrors,
  });
});

// POST /api/sessions/:id/pbvision-renotify — Re-fire the rating-hub webhook
// for every already-attached pb.vision video ID on this session. Useful when
// the original notify attempts failed (wrong secret, network hiccup, etc).
router.post("/:id/pbvision-renotify", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);
  const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
  if (vids.length === 0) {
    return res.status(400).json({ error: "No pb.vision video IDs on this session yet" });
  }

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  addLog(`Re-firing rating-hub webhook for ${vids.length} video IDs...`);

  const results: { vid: string; ok: boolean; status?: string; error?: string }[] = [];
  for (const vid of vids) {
    try {
      const r = await notifyRatingHub({ sessionId: session.id, videoId: vid, onLog: addLog });
      results.push({ vid, ok: true, status: r.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WebhookError ? ` (HTTP ${err.status ?? "?"})` : "";
      results.push({ vid, ok: false, error: `${msg}${code}` });
      addLog(`Warning: rating-hub webhook failed for ${vid}: ${msg}`);
    }
  }

  const ok = results.filter((r) => r.ok).length;
  addLog(`Re-notify complete: ${ok}/${vids.length} OK`);
  res.json({ results, ok, total: vids.length });
});

// POST /api/sessions/:id/create-rating-hub-session
// Upsert a sessions row in the shared Supabase DB (rating-hub's schema) and
// backfill games.session_id for any already-imported clips. Idempotent — safe
// to click multiple times, and callable again after new games finish importing.
router.post("/:id/create-rating-hub-session", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Session not found" });

  const session = rowToSession(row);

  const addLog = (msg: string) => {
    db.prepare("INSERT INTO session_logs (session_id, message) VALUES (?, ?)").run(session.id, msg);
  };

  addLog("Creating rating-hub session...");

  try {
    const result = await createOrUpdateRatingHubSession(session);
    addLog(
      `Rating-hub session upserted (id ${result.sessionId}, ${result.playerUuids.length} players, ` +
        `${result.gamesLinked} game${result.gamesLinked === 1 ? "" : "s"} linked)`,
    );

    // Surface the base URL so the UI can link straight into rating-hub.
    const baseUrl = process.env.RATING_HUB_BASE_URL || null;

    res.json({
      ...result,
      ratingHubUrl: baseUrl ? `${baseUrl.replace(/\/$/, "")}/sessions/${result.sessionId}` : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof RatingHubError ? err.code : "unknown";
    addLog(`rating-hub session create failed: [${code}] ${msg}`);
    res.status(400).json({ error: msg, code });
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
