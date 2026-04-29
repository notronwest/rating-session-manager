import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  listLogs,
  clearLogs,
  makeAddLog,
  type UpdateSessionInput,
} from "../db/index.js";
import { detectGames, exportClips } from "../services/video-processor.js";
import { uploadClipToPbVision, UploadError } from "../pbvision/upload.js";
import { listPbVisionVideos, ListError } from "../pbvision/list.js";
import { notifyRatingHub, WebhookError } from "../pbvision/webhook.js";
import { syncRatingHub, ensureRatingHubSession, SyncRatingHubError } from "../ratinghub/sync.js";
import type { Session, GameSegment, SessionStatus } from "../types.js";

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

// Centralised error handling so route bodies stay tidy.
function sendError(res: Parameters<typeof router.get>[1] extends never ? never : import("express").Response, err: unknown, status = 500) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  res.status(status).json({ error: msg });
}

// GET /api/sessions
router.get("/", async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions
router.post("/", async (req, res) => {
  try {
    const { label, booking_time, player_names, video_path } = req.body;
    const session = await createSession({
      label: label || null,
      booking_time: booking_time || null,
      player_names: player_names || null,
      video_path: video_path || null,
    });
    res.status(201).json(session);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/sessions/:id
router.get("/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/sessions/:id/logs
router.get("/:id/logs", async (req, res) => {
  try {
    res.json(await listLogs(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// PATCH /api/sessions/:id
router.patch("/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const allowedFields: (keyof UpdateSessionInput)[] = [
      "status", "label", "booking_time", "player_names",
      "video_path", "roi_path", "segments", "error",
      // Permit clearing/editing per-slot vids so users can recover from
      // duplicates or wrong auto-matches.
      "pbvision_video_ids",
    ];
    const updates: UpdateSessionInput = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        // Supabase JS handles jsonb-from-JS-object directly — no JSON.stringify.
        (updates as Record<string, unknown>)[field] = req.body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const updated = await updateSession(session.id, updates);
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/detect — Run game detection
router.post("/:id/detect", async (req, res) => {
  let session: Session | null = null;
  try {
    session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!session.video_path) return res.status(400).json({ error: "No video path assigned" });

    const addLog = makeAddLog(session.id);

    // Clear old logs and update status
    await clearLogs(session.id);
    await updateSession(session.id, { status: "splitting", error: null });
    addLog("Starting game detection...");

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
      addLog,
    );

    const updated = await updateSession(session.id, { status: "split", segments });
    addLog(`Detection complete: ${segments.length} games found`);
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session) {
      try {
        await updateSession(session.id, { status: "failed", error: msg });
        makeAddLog(session.id)(`Detection failed: ${msg}`);
      } catch (innerErr) {
        console.error("Failed to record detect error on session:", innerErr);
      }
    }
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/:id/export — Export clips
router.post("/:id/export", async (req, res) => {
  let session: Session | null = null;
  try {
    session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!session.video_path) return res.status(400).json({ error: "No video path assigned" });

    const segments: GameSegment[] = req.body.segments || session.segments;
    if (!segments || segments.length === 0) {
      return res.status(400).json({ error: "No segments to export" });
    }

    const addLog = makeAddLog(session.id);
    const outputDir = req.body.output_dir || `${session.video_path}_clips`;
    addLog("Starting clip export...");

    // Remove any clip files from a prior export so re-runs don't leave stale
    // files around (e.g. when segment count shrinks, or when the prefix has
    // changed since the last export).
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
      addLog,
    );

    const updated = await updateSession(session.id, { clip_paths: clipPaths, segments });
    addLog(`Export complete: ${clipPaths.length} clips`);
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session) {
      try {
        await updateSession(session.id, { status: "failed", error: msg });
        makeAddLog(session.id)(`Export failed: ${msg}`);
      } catch (innerErr) {
        console.error("Failed to record export error on session:", innerErr);
      }
    }
    res.status(500).json({ error: msg });
  }
});

// POST /api/sessions/:id/pbvision-upload — Upload exported clips to pb.vision.
// Uploads are sequential (one browser session per clip). Clips that already
// have a video ID in pbvision_video_ids are skipped, so this is safe to retry.
router.post("/:id/pbvision-upload", async (req, res) => {
  let session: Session | null = null;
  let vids: (string | null)[] = [];
  try {
    session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
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

    const addLog = makeAddLog(session.id);

    // Work off the existing vids array so retries skip already-uploaded clips
    vids = [...(session.pbvision_video_ids || [])];
    while (vids.length < session.clip_paths.length) vids.push(null);

    await updateSession(session.id, { status: "uploading", error: null });
    if (onlyIndex !== null) {
      addLog(`Retrying pb.vision upload for clip ${onlyIndex + 1}/${session.clip_paths.length}...`);
    } else {
      addLog(`Starting pb.vision upload of ${session.clip_paths.length} clips...`);
    }

    // Ensure rating-hub has a sessions row keyed correctly BEFORE we start
    // firing per-clip webhooks. Without this, rating-hub's webhook fails
    // games.session_id FK for any session that wasn't backfilled from
    // rating-hub. ensureRatingHubSession is idempotent.
    let rhSessionId = session.id;
    try {
      const r = await ensureRatingHubSession(session, addLog);
      rhSessionId = r.rhSessionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Warning: couldn't pre-register rating-hub session — webhooks may fail: ${msg}`);
    }

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

      await updateSession(session.id, { pbvision_video_ids: vids });

      // Fire-and-warn: notify rating-hub so it can pick up insights.
      try {
        await notifyRatingHub({ sessionId: rhSessionId, videoId: vid, onLog: addLog });
      } catch (whErr) {
        const whMsg = whErr instanceof Error ? whErr.message : String(whErr);
        addLog(`Warning: rating-hub webhook failed for ${vid}: ${whMsg}`);
      }
    }

    const allDone = vids.every((v) => !!v);
    const updated = await updateSession(session.id, {
      status: allDone ? "processing" : "uploading",
    });
    addLog(allDone ? "All clips uploaded to pb.vision" : "Upload batch complete");
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof UploadError ? err.code : "unknown";
    if (session) {
      try {
        await updateSession(session.id, {
          status: "failed",
          error: msg,
          pbvision_video_ids: vids,
        });
        makeAddLog(session.id)(`Upload failed: [${code}] ${msg}`);
      } catch (innerErr) {
        console.error("Failed to record upload error on session:", innerErr);
      }
    }
    res.status(500).json({ error: msg, code });
  } finally {
    if (session) uploadsInFlight.delete(session.id);
  }
});

// POST /api/sessions/:id/pbvision-confirm — Manually attach a pb.vision video
// ID to a specific clip (for when the user uploaded via pb.vision's own UI)
// and immediately fire the rating-hub webhook for it.
//
// Body: { clip_index: number, video_id: string }
router.post("/:id/pbvision-confirm", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

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

    const addLog = makeAddLog(session.id);

    const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
    while (vids.length < session.clip_paths.length) vids.push(null);

    // Refuse to attach a vid that's already on another slot — that's a sign
    // the user pasted the same ID twice (or the auto-matcher previously
    // duplicated). Force them to clear the other slot first via PATCH.
    const dupSlot = vids.findIndex((v, idx) => v === videoId && idx !== clipIndex);
    if (dupSlot !== -1) {
      return res.status(409).json({
        error: `Video ID ${videoId} is already attached to clip ${dupSlot + 1}. Clear that slot first if you really want to move it here.`,
      });
    }

    if (vids[clipIndex] && vids[clipIndex] !== videoId) {
      addLog(`Clip ${clipIndex + 1}: replacing existing video ID ${vids[clipIndex]} with ${videoId}`);
    } else if (!vids[clipIndex]) {
      addLog(`Clip ${clipIndex + 1}: attaching video ID ${videoId}`);
    }

    vids[clipIndex] = videoId;

    const allDone = vids.every((v) => !!v);
    await updateSession(session.id, {
      pbvision_video_ids: vids,
      status: allDone ? "processing" : "uploading",
      error: null,
    });

    // Ensure rating-hub has the matching sessions row first (fixes FK on
    // games.session_id when this session was created in session-manager).
    let rhSessionId = session.id;
    try {
      const r = await ensureRatingHubSession(session, addLog);
      rhSessionId = r.rhSessionId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Warning: couldn't pre-register rating-hub session — webhook may fail: ${msg}`);
    }

    // Fire the webhook; never block the 200 — surface errors to logs.
    let webhookError: string | null = null;
    try {
      await notifyRatingHub({ sessionId: rhSessionId, videoId, onLog: addLog });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WebhookError ? ` (${err.status ?? "n/a"})` : "";
      webhookError = `${msg}${code}`;
      addLog(`Warning: rating-hub webhook failed: ${webhookError}`);
    }

    const updated = await getSession(session.id);
    res.json({ ...(updated as Session), webhookError });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/pbvision-fetch-ids — Scrape the user's pb.vision
// library, auto-match videos to this session's clips by filename, populate
// pbvision_video_ids for the matches, and fire the rating-hub webhook.
router.post("/:id/pbvision-fetch-ids", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!session.clip_paths || session.clip_paths.length === 0) {
      return res.status(400).json({ error: "Session has no clips" });
    }

    const addLog = makeAddLog(session.id);

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
    // Exclude vids already attached to this session — they aren't candidates
    // for any open slot. This prevents the "same vid auto-matched into
    // multiple slots across runs" bug.
    for (const existing of vids) {
      if (existing) unmatchedVideos.delete(existing);
    }
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
    const nextStatus: SessionStatus = allDone
      ? "processing"
      : session.status === "failed"
        ? "uploading"
        : (session.status || "uploading");

    await updateSession(session.id, {
      pbvision_video_ids: vids,
      status: nextStatus,
    });

    // Ensure rating-hub has the matching sessions row before firing webhooks.
    let rhSessionId = session.id;
    if (matches.length > 0) {
      try {
        const r = await ensureRatingHubSession(session, addLog);
        rhSessionId = r.rhSessionId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`Warning: couldn't pre-register rating-hub session — webhooks may fail: ${msg}`);
      }
    }

    // Fire webhooks for any newly-matched vids
    const webhookErrors: { vid: string; error: string }[] = [];
    for (const m of matches) {
      try {
        await notifyRatingHub({ sessionId: rhSessionId, videoId: m.vid, onLog: addLog });
      } catch (whErr) {
        const msg = whErr instanceof Error ? whErr.message : String(whErr);
        webhookErrors.push({ vid: m.vid, error: msg });
        addLog(`Warning: rating-hub webhook failed for ${m.vid}: ${msg}`);
      }
    }

    const updated = await getSession(session.id);
    const unmatchedClips = session.clip_paths
      .map((cp, i) => ({ clipIndex: i, clipName: path.basename(cp) }))
      .filter((c) => !vids[c.clipIndex]);
    const unmatchedVideoList = videos.filter((v) => unmatchedVideos.has(v.vid));

    res.json({
      session: updated,
      matched: matches,
      unmatchedClips,
      unmatchedVideos: unmatchedVideoList,
      webhookErrors,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/sync-rating-hub
// One idempotent action that figures out what's missing on the rating-hub
// side and does just that. Non-destructive — safe to click repeatedly as
// pb.vision finishes processing clips.
router.post("/:id/sync-rating-hub", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const addLog = makeAddLog(session.id);
    addLog("Syncing session with rating-hub...");

    try {
      const result = await syncRatingHub(session, addLog);
      addLog(
        `Sync complete: ${result.totalGamesLinked} game(s) linked, ` +
          `${result.perVideo.filter((v) => v.webhookFired).length} webhook(s) fired`,
      );
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof SyncRatingHubError ? err.code : "unknown";
      addLog(`Sync failed: [${code}] ${msg}`);
      res.status(400).json({ error: msg, code });
    }
  } catch (err) {
    sendError(res, err);
  }
});

function deleteClipFiles(session: Session): number {
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
router.post("/:id/start-over", async (_req, res) => {
  try {
    const session = await getSession(_req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    deleteClipFiles(session);

    await updateSession(session.id, {
      segments: null,
      clip_paths: null,
      error: null,
    });
    // Clear old logs so the next detection starts fresh
    await clearLogs(session.id);

    const updated = await getSession(session.id);
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/cancel — Full reset: delete clips, clear segments, logs, reset status
router.post("/:id/cancel", async (_req, res) => {
  try {
    const session = await getSession(_req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    deleteClipFiles(session);

    await updateSession(session.id, {
      status: "scheduled",
      segments: null,
      clip_paths: null,
      error: null,
    });
    await clearLogs(session.id);

    const updated = await getSession(session.id);
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/clear-error — Dismiss a stale error banner
router.post("/:id/clear-error", async (_req, res) => {
  try {
    const session = await getSession(_req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const updated = await updateSession(session.id, { error: null });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
