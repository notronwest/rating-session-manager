import { Router } from "express";
import fs from "fs";
import path from "path";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  listLogs,
  clearLogs,
  makeAddLog,
  type UpdateSessionInput,
} from "../db/index.js";
import { detectGames, exportClips } from "../services/video-processor.js";
import { uploadClipViaApi, PbvisionApiError } from "../pbvision/api.js";
import { tagPbVisionVideo, TagError } from "../pbvision/tag.js";
import { listPbVisionVideos, ListError } from "../pbvision/list.js";
import { fetchAndStoreMuxIds, MuxFetchError } from "../services/mux-sync.js";
import { notifyRatingHub, WebhookError } from "../pbvision/webhook.js";
import { syncRatingHub, ensureRatingHubSession, SyncRatingHubError } from "../ratinghub/sync.js";
import { archiveAllCompletedSessions } from "../services/archive.js";
import { matchAvatars } from "../services/avatar-matcher.js";
import { sendDiscordAlert } from "../services/discord-alert.js";
import { getSupabase, getOrgId } from "../supabase.js";
import type { Session, GameSegment, SessionStatus } from "../types.js";

const router = Router();

const uploadsInFlight = new Set<string>();

/**
 * Find which OTHER session (if any) currently has `vid` attached.
 *
 * Used by the PATCH endpoint, pbvision-confirm, and pbvision-fetch-ids
 * to refuse to silently steal a vid that already belongs to another
 * session. Returns `{ id, label }` of the owning session, or null if
 * no other session has it.
 *
 * `currentSessionId` is the session we're updating — rows with that id
 * are excluded so we don't false-positive on a re-attach of an existing
 * vid to the same session.
 */
async function findOwnerSession(
  vid: string,
  currentSessionId: string,
): Promise<{ id: string; label: string | null } | null> {
  const supabase = getSupabase();
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("session_manager_sessions")
    .select("id, label")
    .eq("org_id", orgId)
    .neq("id", currentSessionId)
    .contains("pbvision_video_ids", [vid])
    .limit(1);
  if (error) {
    // Don't fail the whole request on a lookup error — log and let the
    // caller decide. Returning null = "no known owner" is the safe
    // fallback (no spurious 409s) but it does mean a transient Supabase
    // hiccup could let a hijack slip through. Acceptable.
    console.error(`[findOwnerSession] lookup failed for vid ${vid}: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;
  return { id: data[0].id as string, label: (data[0].label as string | null) ?? null };
}

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

// POST /api/sessions/archive-completed — sweeps every status=complete
// session whose source video still lives outside videos/processed/ and
// moves it (plus its clips dir) into processed/. Updates session paths
// so the UI keeps linking correctly. Returns per-session results.
//
// Defined BEFORE /:id routes so Express doesn't try to match
// "archive-completed" as an :id segment.
router.post("/archive-completed", async (_req, res) => {
  try {
    // Step 1: physically move files for sessions that have them.
    const results = await archiveAllCompletedSessions();
    const totalMoved = results.reduce((n, r) => n + r.moved.length, 0);
    const totalSkipped = results.reduce((n, r) => n + r.skipped.length, 0);
    const sessionsFilesMoved = results.filter((r) => r.moved.length > 0).length;

    // Step 2: mark every status=complete session as archived, regardless
    // of whether it had files to move. Without this, the Dashboard's
    // "Archive Completed" button looked broken for CR-imported sessions
    // that never had a video file attached — they stayed in the active
    // list forever because step 1 found nothing to do.
    const all = await listSessions();
    const now = new Date().toISOString();
    let sessionsMarked = 0;
    for (const s of all) {
      if (s.status !== "complete") continue;
      if (s.archived_at) continue;
      try {
        await updateSession(s.id, { archived_at: now });
        sessionsMarked += 1;
      } catch (err) {
        // Don't fail the whole batch on one bad row — surface as a skip.
        results.push({
          sessionId: s.id,
          label: s.label,
          moved: [],
          skipped: [`mark archived failed: ${(err as Error).message}`],
        });
      }
    }

    res.json({
      results,
      summary: {
        sessions_inspected: results.length,
        sessions_archived: sessionsMarked,
        files_moved: totalMoved,
        files_skipped: totalSkipped,
        sessions_files_moved: sessionsFilesMoved,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/archive — mark a single session archived. Idempotent;
// re-running on an already-archived session is a no-op (returns existing time).
router.post("/:id/archive", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.archived_at) return res.json(session);
    const updated = await updateSession(session.id, {
      archived_at: new Date().toISOString(),
    });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/unarchive — clear archived_at. For when something
// got archived by mistake or the coach wants to revisit a finished session.
router.post("/:id/unarchive", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const updated = await updateSession(session.id, { archived_at: null });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

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

    // Cross-session vid uniqueness: refuse the patch if it would attach
    // a vid that's already on another session. Same check as
    // pbvision-confirm; lives here because the SessionDetail UI also
    // calls PATCH to clear/edit individual slots (see allowedFields
    // comment above).
    if (Array.isArray(updates.pbvision_video_ids)) {
      for (const vid of updates.pbvision_video_ids) {
        if (!vid) continue;
        const owner = await findOwnerSession(vid, session.id);
        if (owner) {
          return res.status(409).json({
            error: `Video ID ${vid} is already attached to session "${owner.label ?? owner.id.slice(0, 8)}". Detach it there first.`,
            ownerSessionId: owner.id,
          });
        }
      }
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
    void sendDiscordAlert({
      title: "Game detection crashed",
      level: "error",
      message:
        "`detect_games.py` exited non-zero. The session is now in `failed` state and won't auto-recover. Likely causes: Python traceback (look at the session log for full stack), corrupt or missing source video, or an algorithm edge case.",
      fields: [
        { name: "Session", value: "`" + (session?.id ?? "unknown") + "`" + (session?.label ? ` — ${session.label}` : "") },
        { name: "Error", value: "```\n" + msg.slice(0, 900) + "\n```" },
        { name: "Fix", value: "Check the session log for the Python traceback. If parameter tuning is the issue, the session detail page has the 5 detection knobs. If it's a code bug, file a follow-up." },
      ],
      dedupeKey: `detect-failed:${session?.id ?? "unknown"}`,
    });
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

// POST /api/sessions/:id/pbvision-upload — Upload exported clips to pb.vision
// via the Partner API (no browser automation). Uploads are sequential.
// Clips that already have a video ID in pbvision_video_ids are skipped, so
// this is safe to retry.
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
      addLog(`Starting pb.vision Partner-API upload of ${session.clip_paths.length} clips...`);
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

    // Build a per-session metadata template once. pb.vision shows `name`
    // as the clip title; we postfix `-gm-N` per clip below.
    const sessionLabel = session.label || `session ${session.id.slice(0, 8)}`;
    const gameStartEpoch = session.booking_time
      ? Math.floor(new Date(session.booking_time).getTime() / 1000)
      : undefined;

    for (let i = 0; i < session.clip_paths.length; i++) {
      if (onlyIndex !== null && i !== onlyIndex) continue;
      if (vids[i]) {
        addLog(`Clip ${i + 1}/${session.clip_paths.length}: already uploaded (${vids[i]}), skipping`);
        continue;
      }
      const clipPath = session.clip_paths[i];
      addLog(`Clip ${i + 1}/${session.clip_paths.length}: uploading ${path.basename(clipPath)}`);
      const { vid } = await uploadClipViaApi({
        videoPath: clipPath,
        name: `${sessionLabel} – game ${i + 1}`,
        gameStartEpoch,
        facility: "WMPC",
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
    const code = err instanceof PbvisionApiError ? err.code : "unknown";
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
    void sendDiscordAlert({
      title: code === "no_credits" ? "PB Vision: out of credits" : "PB Vision upload failed",
      level: "error",
      message:
        code === "no_credits"
          ? "The PB Vision Partner account has no credits available. Uploads will keep failing until credits are topped up — contact `support@pb.vision`."
          : "An upload to PB Vision via the Partner API failed mid-session. The session is in `failed` state — re-running the upload action will resume from where it left off.",
      fields: [
        { name: "Session", value: "`" + (session?.id ?? "unknown") + "`" + (session?.label ? ` — ${session.label}` : "") },
        { name: "Error code", value: "`" + code + "`" },
        { name: "Details", value: msg.slice(0, 900) },
      ],
      dedupeKey: `pbvision-upload-failed:${code}:${session?.id ?? "unknown"}`,
    });
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

    // Cross-session uniqueness: refuse if another session in this org
    // already owns this vid.
    const owner = await findOwnerSession(videoId, session.id);
    if (owner) {
      return res.status(409).json({
        error: `Video ID ${videoId} is already attached to session "${owner.label ?? owner.id.slice(0, 8)}". Detach it there first.`,
        ownerSessionId: owner.id,
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
      if (code === "not_authenticated") {
        void sendDiscordAlert({
          title: "PB Vision profile is logged out",
          level: "warning",
          message:
            "The Playwright profile lost its PB Vision session. Fetch IDs and tagging won't work until re-auth. The UI surfaces a Re-authenticate button on the affected session, or run `npm run pbvision:login` directly on the recording machine.",
          fields: [
            { name: "Session", value: "`" + session.id + "`" + (session.label ? ` — ${session.label}` : "") },
          ],
          dedupeKey: "pbvision-logged-out",
        });
      }
      return res.status(500).json({ error: msg, code });
    }

    addLog(`Fetched ${videos.length} videos from pb.vision library`);
    // Echo each scraped title so mis-matches are debuggable from the log.
    for (const v of videos) {
      const preview = (v.title || "").replace(/\s+/g, " ").slice(0, 80);
      addLog(`  vid=${v.vid} title="${preview}${(v.title || "").length > 80 ? "…" : ""}"`);
    }

    const vids: (string | null)[] = [...(session.pbvision_video_ids || [])];
    while (vids.length < session.clip_paths.length) vids.push(null);

    const stem = (p: string) => path.basename(p, path.extname(p));

    /**
     * Strict filename match: returns true if `needle` (a clip stem like
     * "rs-hc-dw-2026-04-29-gm-1") appears in `haystack` as a complete token,
     * not as a prefix of a longer name. So "gm-1" matches but "gm-10" doesn't
     * accidentally satisfy a "gm-1" search.
     *
     * Implementation: case-insensitive indexOf, then verify the chars
     * surrounding the match are non-alphanumeric (or string boundaries).
     * This catches all common boundaries: whitespace, newlines, punctuation,
     * and the leading dot before a file extension.
     */
    const isFilenameInTitle = (needle: string, haystack: string): boolean => {
      if (!needle || !haystack) return false;
      const h = haystack.toLowerCase();
      const n = needle.toLowerCase();
      let from = 0;
      while (from <= h.length - n.length) {
        const idx = h.indexOf(n, from);
        if (idx < 0) return false;
        const before = idx === 0 ? "" : h[idx - 1];
        const after = idx + n.length >= h.length ? "" : h[idx + n.length];
        const isWordChar = (c: string) => /[a-z0-9]/i.test(c);
        if (!isWordChar(before) && !isWordChar(after)) return true;
        from = idx + 1;
      }
      return false;
    };

    const unmatchedVideos = new Set(videos.map((v) => v.vid));
    // Exclude vids already attached to this session — they aren't candidates
    // for any open slot. This prevents the "same vid auto-matched into
    // multiple slots across runs" bug.
    for (const existing of vids) {
      if (existing) unmatchedVideos.delete(existing);
    }
    const matches: { clipIndex: number; clipName: string; vid: string; title: string }[] = [];
    // Vids that filename-matched a clip but are already owned by another
    // session — we surface these so the coach knows to manually decide
    // (rename one of the sessions, or detach from the other) instead of
    // silently picking the wrong one or stealing.
    const skippedOwnedElsewhere: { clipIndex: number; clipName: string; vid: string; title: string; ownerSessionId: string; ownerLabel: string | null }[] = [];

    for (let i = 0; i < session.clip_paths.length; i++) {
      if (vids[i]) continue;
      const basename = path.basename(session.clip_paths[i]);
      const stemName = stem(basename);
      const hit = videos.find((v) => {
        if (!unmatchedVideos.has(v.vid)) return false;
        const title = v.title || "";
        // Match if either the bare stem ("rs-hc-…-gm-1") or the basename
        // with extension ("rs-hc-…-gm-1.mov") appears as a complete token.
        return isFilenameInTitle(stemName, title) || isFilenameInTitle(basename, title);
      });
      if (!hit) {
        addLog(`  No pb.vision video matches ${basename}`);
        continue;
      }

      // Cross-session ownership check: if this vid is already on another
      // session, DON'T auto-assign it. Surface it as skipped instead.
      const owner = await findOwnerSession(hit.vid, session.id);
      if (owner) {
        skippedOwnedElsewhere.push({
          clipIndex: i, clipName: basename, vid: hit.vid, title: hit.title,
          ownerSessionId: owner.id, ownerLabel: owner.label,
        });
        unmatchedVideos.delete(hit.vid);
        addLog(`  ⚠ Skipped ${basename} → ${hit.vid}: already attached to session "${owner.label ?? owner.id.slice(0, 8)}"`);
        continue;
      }

      vids[i] = hit.vid;
      unmatchedVideos.delete(hit.vid);
      matches.push({ clipIndex: i, clipName: basename, vid: hit.vid, title: hit.title });
      addLog(`  Matched ${basename} → ${hit.vid}`);
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
      skippedOwnedElsewhere,
      webhookErrors,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/pbvision-tag — Drive pb.vision's tagging UI for
// each (or one) of this session's uploaded clips and assign the session's
// player_names to slots 0-3. Body: { clip_index?: number } — omit to tag
// every uploaded clip. Tag runs are sequential (single Chromium profile).
router.post("/:id/pbvision-tag", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!session.pbvision_video_ids || session.pbvision_video_ids.length === 0) {
      return res.status(400).json({ error: "No uploaded videos to tag" });
    }
    if (!session.player_names || session.player_names.length !== 4) {
      return res.status(400).json({
        error: `Tagging requires exactly 4 player names on the session (got ${session.player_names?.length ?? 0}).`,
      });
    }
    const onlyIndex =
      typeof req.body?.clip_index === "number" && Number.isInteger(req.body.clip_index)
        ? (req.body.clip_index as number)
        : null;

    const addLog = makeAddLog(session.id);
    const names = session.player_names;
    const vids = session.pbvision_video_ids;

    const targets: { i: number; vid: string }[] = [];
    for (let i = 0; i < vids.length; i++) {
      if (onlyIndex !== null && i !== onlyIndex) continue;
      const vid = vids[i];
      if (!vid) continue;
      targets.push({ i, vid });
    }
    if (targets.length === 0) {
      return res.status(400).json({ error: "No matching uploaded vid to tag" });
    }

    addLog(`Auto-tagging ${targets.length} pb.vision video(s) with: ${names.join(", ")}`);

    type Outcome =
      | { i: number; vid: string; ok: true; flow: string; tagged: number; skipped: number }
      | { i: number; vid: string; ok: false; error: string; code: string };
    const outcomes: Outcome[] = [];

    for (const { i, vid } of targets) {
      addLog(`Clip ${i + 1}/${vids.length}: tagging ${vid}…`);
      try {
        const result = await tagPbVisionVideo({
          vid,
          names,
          headed: req.body?.headed !== false,
          onLog: (line) => addLog(`  ${line}`),
        });
        outcomes.push({
          i,
          vid,
          ok: true,
          flow: result.flow,
          tagged: result.tagged.length,
          skipped: result.skipped.length,
        });
        addLog(
          `Clip ${i + 1}: ${result.flow} flow — tagged ${result.tagged.length}/4, skipped ${result.skipped.length}.` +
            (result.skipped.length > 0
              ? ` Skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`
              : ""),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof TagError ? err.code : "unknown";
        outcomes.push({ i, vid, ok: false, error: msg, code });
        addLog(`Clip ${i + 1}: tag failed [${code}] ${msg}`);
        // If we lost auth, no point trying the rest of the clips.
        if (code === "not_authenticated") break;
      }
    }

    const succeeded = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok).length;
    const failed = outcomes.length - succeeded;
    addLog(`Tag run complete: ${succeeded} succeeded, ${failed} failed.`);

    res.json({ outcomes, succeeded, failed });
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/sessions/:id/pbvision-status — for each vid attached to this
// session, hit pb.vision's public insights endpoint and infer whether AI
// processing has completed. Used by the UI to show per-clip status while
// waiting on pb.vision and to know when it's safe to fire Sync.
//
// pb.vision exposes insights at GET /video/{vid}/insights.json (no auth);
// returns 200 + JSON once processing is done, 404 (or empty body) while
// processing is still running.
const PBVISION_API_BASE = "https://api-2o2klzx4pa-uc.a.run.app";
router.get("/:id/pbvision-status", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
    if (vids.length === 0) {
      return res.json({ statuses: [], allReady: false });
    }

    const statuses = await Promise.all(
      vids.map(async (vid) => {
        try {
          const r = await fetch(`${PBVISION_API_BASE}/video/${vid}/insights.json`);
          if (!r.ok) {
            return { vid, ready: false, reason: `HTTP ${r.status}` };
          }
          // Treat a meaningful JSON body as "ready". A missing video / still-
          // processing video usually returns a stub or non-200; insights
          // proper is several KB of dense JSON.
          const text = await r.text();
          if (!text || text.trim().length < 50) {
            return { vid, ready: false, reason: "empty body" };
          }
          try {
            const parsed = JSON.parse(text);
            // Insights is a non-empty object/array. Arrays at top level or
            // objects with shot/player data both count.
            const meaningful =
              (Array.isArray(parsed) && parsed.length > 0) ||
              (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0);
            return meaningful
              ? { vid, ready: true }
              : { vid, ready: false, reason: "empty insights structure" };
          } catch {
            return { vid, ready: false, reason: "non-JSON response" };
          }
        } catch (err) {
          return { vid, ready: false, reason: (err as Error).message };
        }
      }),
    );
    const allReady = statuses.length > 0 && statuses.every((s) => s.ready);
    res.json({ statuses, allReady });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/fetch-mux-ids
//
// Replaces the rating-hub "📌 PBV Grab" bookmarklet. For every video
// attached to this session, scrape pb.vision for its Mux playback ID
// (via scripts/pbvision-mux.py + the persistent Playwright profile)
// and write the result into rating-hub's `games.mux_playback_id`.
// Idempotent: vids whose games already have a Mux ID are skipped
// unless `force=true` is in the body.
//
// Body (optional): { force?: boolean }
// Response:
//   {
//     results: [
//       { vid, muxPlaybackId, source, updatedGames, skipped: false },
//       { vid, muxPlaybackId: null, error: "...", skipped: false },
//       ...
//     ],
//     summary: { fetched, updated, skipped, errors }
//   }
// GET /api/sessions/:id/clip-sizes — file sizes (bytes) for every clip
// in session.clip_paths, parallel array. null for clips whose file is
// missing on disk (e.g. archived) or unreadable. Used by the Upload
// card to surface size next to each clip name so the coach knows what
// they're about to push to pb.vision before clicking — large clips on
// a slow uplink are the #1 source of "is it stuck?" support pings.
router.get("/:id/clip-sizes", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const clipPaths = session.clip_paths || [];
    const sizes = clipPaths.map((cp) => {
      try {
        return fs.statSync(cp).size;
      } catch {
        return null;
      }
    });
    res.json({ sizes });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/:id/fetch-mux-ids", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
    if (vids.length === 0) {
      return res.json({ results: [], summary: { fetched: 0, updated: 0, skipped: 0, errors: 0 } });
    }

    const addLog = makeAddLog(session.id);
    try {
      const out = await fetchAndStoreMuxIds(vids, {
        force: !!req.body?.force,
        onLog: addLog,
      });
      res.json(out);
    } catch (err) {
      if (err instanceof MuxFetchError) {
        return res.status(500).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});

// GET /api/sessions/:id/tagging — returns everything the in-app tagging UI
// needs to let a coach map pb.vision player slots to real WMPC players:
//   - Per game (one per uploaded vid that rating-hub has imported): the
//     four slot thumbnails (URLs into PBV's GCS), each slot's CURRENT
//     player_id and display_name, and a flag for whether that current
//     player is a "Player N" placeholder.
//   - The candidate roster: session.player_names resolved to real player
//     UUIDs (via the same display_name / pbvision_names lookup the
//     rating-hub-sync helper uses).
//
// PB Vision recommends this in-app flow over their UI tagging since
// (a) tagging isn't in their API, (b) avatar_id is consistent within a
// video but not across videos, so per-game mapping is required anyway.
router.get("/:id/tagging", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const supabase = getSupabase();
    const orgId = await getOrgId();

    const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
    if (vids.length === 0) {
      return res.json({ candidates: [], games: [] });
    }

    // Pull the games + their game_players for this session's vids.
    // We filter ONLY by pbvision_video_id, not also session_id — see the
    // long comment at the top of this file's POST /tagging handler for
    // the rationale. tl;dr: when two session-manager sessions share the
    // same (date, player_group) the rating-hub session row is shared
    // (rh.sessions has a UNIQUE constraint on those), so games for
    // session-manager session X may have rh `session_id` = Y. Vids,
    // however, are uniquely scoped to one session-manager session via
    // PR #8's cross-session uniqueness guard, so this is unambiguous.
    const { data: gamesData, error: gErr } = await supabase
      .from("games")
      .select("id, pbvision_video_id, ai_engine_version, played_at")
      .eq("org_id", orgId)
      .in("pbvision_video_id", vids);
    if (gErr) throw new Error(`games fetch: ${gErr.message}`);
    const games = (gamesData || []) as {
      id: string;
      pbvision_video_id: string;
      ai_engine_version: number | null;
      played_at: string | null;
    }[];

    if (games.length === 0) {
      return res.json({ candidates: [], games: [] });
    }

    const gameIds = games.map((g) => g.id);
    // raw_player_data carries pb.vision's original `avatar_id`, which is the
    // index used in the GCS thumbnail path. Don't substitute player_index —
    // pb.vision's players[] array order is not guaranteed to match avatar_id,
    // and using player_index causes the wrong avatar image to render in the
    // Tag Players UI (see 2026-05-20: Ron's shots ended up under Lex because
    // slots 0 and 1 were displayed with each other's photos).
    const { data: gpData, error: gpErr } = await supabase
      .from("game_players")
      .select("game_id, player_id, player_index, raw_player_data")
      .in("game_id", gameIds);
    if (gpErr) throw new Error(`game_players fetch: ${gpErr.message}`);
    const gp = (gpData || []) as {
      game_id: string;
      player_id: string;
      player_index: number;
      raw_player_data: { avatar_id?: number } | null;
    }[];

    const playerIds = Array.from(new Set(gp.map((row) => row.player_id)));
    const { data: pData, error: pErr } = await supabase
      .from("players")
      .select("id, display_name")
      .in("id", playerIds);
    if (pErr) throw new Error(`players fetch: ${pErr.message}`);
    const playersById = new Map<string, string>();
    for (const p of (pData || []) as { id: string; display_name: string }[]) {
      playersById.set(p.id, p.display_name);
    }

    // Resolve the session's player_names to candidate player UUIDs.
    // Same fuzzy match as ensureRatingHubSession: try display_name and
    // pbvision_names. Anything that fails to resolve is returned as a
    // candidate without an id so the UI can warn the coach.
    type Candidate = { displayName: string; id: string | null };
    const candidates: Candidate[] = [];
    if (session.player_names && session.player_names.length > 0) {
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      type RosterRow = { id: string; display_name: string; pbvision_names: string[] | null };
      const roster: RosterRow[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("players")
          .select("id, display_name, pbvision_names")
          .eq("org_id", orgId)
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`roster fetch: ${error.message}`);
        if (!data || data.length === 0) break;
        roster.push(...(data as RosterRow[]));
        if (data.length < PAGE) break;
      }
      const byName = new Map<string, RosterRow>();
      for (const r of roster) {
        byName.set(normalize(r.display_name), r);
        for (const alt of r.pbvision_names || []) byName.set(normalize(alt), r);
      }
      for (const name of session.player_names) {
        const hit = byName.get(normalize(name));
        candidates.push({ displayName: name, id: hit?.id ?? null });
      }
    }

    // Heuristic for "is this a placeholder?" — rating-hub creates rows
    // named exactly "Player 0", "Player 1", "Player 2", "Player 3" when
    // pb.vision returns un-tagged data.
    const placeholderRe = /^Player [0-9]$/;

    const gpByGame = new Map<string, typeof gp>();
    for (const row of gp) {
      const arr = gpByGame.get(row.game_id) || [];
      arr.push(row);
      gpByGame.set(row.game_id, arr);
    }

    const responseGames = games
      .sort((a, b) => (a.played_at || "").localeCompare(b.played_at || ""))
      .map((g) => {
        const slots = (gpByGame.get(g.id) || [])
          .sort((a, b) => a.player_index - b.player_index)
          .map((row) => {
            const currentName = playersById.get(row.player_id) || null;
            const isPlaceholder = !!currentName && placeholderRe.test(currentName);
            const aiv = g.ai_engine_version ?? 0;
            // pb.vision stores avatar files under the player's `avatar_id`,
            // not its array index. They usually match but not always —
            // fall back to player_index only if raw_player_data is missing
            // (older imports before raw_player_data was being saved).
            const avatarId =
              row.raw_player_data?.avatar_id != null
                ? row.raw_player_data.avatar_id
                : row.player_index;
            const thumbnailUrl = aiv
              ? `https://storage.googleapis.com/pbv-pro/${g.pbvision_video_id}/${aiv}/player${avatarId}-0.jpg`
              : null;
            return {
              playerIndex: row.player_index,
              currentPlayerId: row.player_id,
              currentPlayerName: currentName,
              isPlaceholder,
              thumbnailUrl,
            };
          });
        return {
          gameId: g.id,
          vid: g.pbvision_video_id,
          aiEngineVersion: g.ai_engine_version,
          playedAt: g.played_at,
          slots,
        };
      });

    res.json({ candidates, games: responseGames });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/tagging — applies a list of (gameId, playerIndex,
// playerId) mappings to rating-hub's game_players. Body shape:
//
//   { mappings: [{ gameId, playerIndex, playerId }, ...] }
//
// Each mapping must reference a game on THIS session and a player who is
// in the candidate roster (i.e. one of session.player_names) — guards
// keep arbitrary cross-org writes off the table.
router.post("/:id/tagging", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : null;
    if (!mappings || mappings.length === 0) {
      return res.status(400).json({ error: "mappings array is required" });
    }
    for (const m of mappings) {
      if (
        typeof m?.gameId !== "string" ||
        typeof m?.playerId !== "string" ||
        !Number.isInteger(m?.playerIndex) ||
        m.playerIndex < 0 ||
        m.playerIndex > 3
      ) {
        return res
          .status(400)
          .json({ error: `invalid mapping: ${JSON.stringify(m)}` });
      }
    }

    const supabase = getSupabase();
    const orgId = await getOrgId();
    const addLog = makeAddLog(session.id);

    // Validate: every gameId in the request actually belongs to THIS session.
    const gameIds: string[] = Array.from(
      new Set(mappings.map((m: { gameId: string }) => m.gameId)),
    );
    // Validate each gameId is one of the games owned by THIS session.
    // "Owned" here means: its pbvision_video_id is in this session-
    // manager session's pbvision_video_ids array. We do NOT filter by
    // rating-hub games.session_id because two session-manager sessions
    // sharing the same (date, player_group) latch onto a single rh
    // sessions row (rh.sessions has a UNIQUE constraint on org/date/
    // group), so `games.session_id` may not equal this sm session's id
    // even when the games are "ours". Cross-session vid uniqueness
    // (PR #8) guarantees vid → sm-session is unambiguous, so filtering
    // by vid + game-id pair is the correct authority check.
    const sessionVids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
    const { data: gameRows, error: gErr } = await supabase
      .from("games")
      .select("id")
      .eq("org_id", orgId)
      .in("pbvision_video_id", sessionVids)
      .in("id", gameIds);
    if (gErr) throw new Error(`games validation: ${gErr.message}`);
    const validGameIds = new Set(
      (gameRows || []).map((g: { id: string }) => g.id),
    );
    for (const id of gameIds) {
      if (!validGameIds.has(id)) {
        return res
          .status(400)
          .json({ error: `gameId ${id} is not on this session` });
      }
    }

    // Validate: every playerId is in this session's roster.
    if (!session.player_names || session.player_names.length === 0) {
      return res.status(400).json({ error: "Session has no player_names" });
    }
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    type RosterRow = { id: string; display_name: string; pbvision_names: string[] | null };
    const roster: RosterRow[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("players")
        .select("id, display_name, pbvision_names")
        .eq("org_id", orgId)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`roster fetch: ${error.message}`);
      if (!data || data.length === 0) break;
      roster.push(...(data as RosterRow[]));
      if (data.length < PAGE) break;
    }
    const rosterById = new Map<string, RosterRow>();
    for (const r of roster) rosterById.set(r.id, r);
    const sessionPlayerIds = new Set<string>();
    for (const name of session.player_names) {
      const hit = roster.find((r) => {
        if (normalize(r.display_name) === normalize(name)) return true;
        return (r.pbvision_names || []).some((alt) => normalize(alt) === normalize(name));
      });
      if (hit) sessionPlayerIds.add(hit.id);
    }
    for (const m of mappings) {
      if (!rosterById.has(m.playerId)) {
        return res
          .status(400)
          .json({ error: `playerId ${m.playerId} doesn't exist in this org` });
      }
      if (!sessionPlayerIds.has(m.playerId)) {
        return res.status(400).json({
          error: `playerId ${m.playerId} (${rosterById.get(m.playerId)?.display_name}) isn't in this session's player_names roster`,
        });
      }
    }

    // Apply all mappings atomically via the apply_session_tagging RPC
    // (rating-hub migration 049). The naive sequential UPDATE blows up
    // `game_players_game_id_player_id_key` whenever a tagging change
    // swaps two players between slots in the same game — the first
    // UPDATE puts player B onto slot 0 while player B still owns slot
    // 1, hitting the non-deferrable unique constraint mid-statement.
    // The RPC runs the loop with the constraint DEFERRED so transient
    // duplicates are fine and the whole operation is one transaction.
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "apply_session_tagging",
      { p_mappings: mappings },
    );
    if (rpcErr) throw new Error(`apply_session_tagging: ${rpcErr.message}`);
    const updated = typeof rpcData === "number" ? rpcData : 0;

    // Note: player_rating_snapshots are keyed on (player_id, game_id),
    // not player_index, so tagging changes leave snapshots attached to
    // the *old* player_id. Known gap from the original v1 flow — the
    // game_players-based aggregation (refresh_player_aggregates) reads
    // from game_players directly so the leaderboard / per-game stats
    // are correct; only the rating-delta hero on PlayerHomePage still
    // reads from snapshots.

    addLog(`Applied ${updated} player tagging mapping(s) to rating-hub.`);
    res.json({ ok: true, updated });
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/sessions/:id/tagging/suggest
//
// After the coach manually tags one game in a session, this endpoint
// uses the tagged game as a reference and predicts the tagging for
// every OTHER game in the session via CLIP image embeddings. Returns
// one suggestion per slot per untagged game, with a confidence score
// the UI can use to flag low-confidence matches.
//
// Body:
//   { sourceGameId: "uuid" }   — required, must be a game on this
//                                session with every slot tagged to a
//                                real player (no "Player N" placeholders).
//
// Response:
//   {
//     suggestions: [
//       {
//         gameId: "uuid",
//         vid: "...",
//         slots: [
//           { playerIndex: 0, playerId: "uuid", playerName: "Ron",
//             confidence: 0.92, margin: 0.18 },
//           ...
//         ]
//       }, ...
//     ]
//   }
router.post("/:id/tagging/suggest", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const sourceGameId = req.body?.sourceGameId as string | undefined;
    if (!sourceGameId) {
      return res.status(400).json({ error: "sourceGameId is required" });
    }

    const supabase = getSupabase();
    const orgId = await getOrgId();

    // Pull every game on this session, with its slot rows + raw_player_data
    // (we read avatar_id from there — same source the tagging GET uses).
    // Filtered by pbvision_video_id rather than session_id for the same
    // reason as the tagging GET — see comment on that handler.
    const sessionVids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
    if (sessionVids.length === 0) {
      return res.json({ suggestions: [] });
    }
    const { data: gamesData, error: gErr } = await supabase
      .from("games")
      .select("id, pbvision_video_id, ai_engine_version, played_at")
      .eq("org_id", orgId)
      .in("pbvision_video_id", sessionVids);
    if (gErr) throw new Error(`games fetch: ${gErr.message}`);
    const games = (gamesData || []) as {
      id: string;
      pbvision_video_id: string;
      ai_engine_version: number | null;
      played_at: string | null;
    }[];
    if (games.length === 0) {
      return res.json({ suggestions: [] });
    }

    const gameIds = games.map((g) => g.id);
    const { data: gpData, error: gpErr } = await supabase
      .from("game_players")
      .select("game_id, player_id, player_index, raw_player_data")
      .in("game_id", gameIds);
    if (gpErr) throw new Error(`game_players fetch: ${gpErr.message}`);
    const gp = (gpData || []) as {
      game_id: string;
      player_id: string;
      player_index: number;
      raw_player_data: { avatar_id?: number } | null;
    }[];

    // Names for the reference picks — so the response can label each
    // suggestion (UI shows e.g. "Suggested: Ron West (92%)").
    const refPlayerIds = Array.from(new Set(
      gp.filter((row) => row.game_id === sourceGameId).map((row) => row.player_id),
    ));
    const { data: pData, error: pErr } = await supabase
      .from("players")
      .select("id, display_name")
      .in("id", refPlayerIds);
    if (pErr) throw new Error(`players fetch: ${pErr.message}`);
    const playerNameById = new Map<string, string>();
    for (const p of (pData || []) as { id: string; display_name: string }[]) {
      playerNameById.set(p.id, p.display_name);
    }

    const placeholderRe = /^Player [0-9]$/;
    const buildThumbnail = (g: { pbvision_video_id: string; ai_engine_version: number | null }, row: { player_index: number; raw_player_data: { avatar_id?: number } | null }) => {
      const aiv = g.ai_engine_version;
      if (!aiv) return null;
      const avatarId = row.raw_player_data?.avatar_id != null
        ? row.raw_player_data.avatar_id
        : row.player_index;
      return `https://storage.googleapis.com/pbv-pro/${g.pbvision_video_id}/${aiv}/player${avatarId}-0.jpg`;
    };

    const sourceGame = games.find((g) => g.id === sourceGameId);
    if (!sourceGame) {
      return res.status(400).json({ error: `sourceGameId ${sourceGameId} is not on this session` });
    }
    const sourceSlots = gp.filter((row) => row.game_id === sourceGameId);
    // Verify the source game is fully tagged — refuse to use placeholders
    // as references, that would propagate the bad tagging.
    for (const row of sourceSlots) {
      const name = playerNameById.get(row.player_id);
      if (!name) {
        return res.status(400).json({ error: `Source game has unknown player_id ${row.player_id}` });
      }
      if (placeholderRe.test(name)) {
        return res.status(400).json({ error: `Source game still has placeholder "${name}" — tag it manually first.` });
      }
    }

    const references = sourceSlots
      .map((row) => {
        const url = buildThumbnail(sourceGame, row);
        if (!url) return null;
        return {
          player_id: row.player_id,
          name: playerNameById.get(row.player_id) || "",
          url,
        };
      })
      .filter((r): r is { player_id: string; name: string; url: string } => !!r);
    if (references.length === 0) {
      return res.status(400).json({ error: "Source game has no usable avatar thumbnails (missing ai_engine_version)." });
    }

    // Now produce suggestions for every OTHER game. We don't filter by
    // "has placeholders" — the caller may want a fresh suggestion to
    // double-check an already-tagged game. The frontend can decide
    // whether to apply.
    const suggestions = [];
    for (const g of games) {
      if (g.id === sourceGameId) continue;
      const slots = gp.filter((row) => row.game_id === g.id);
      const candidates = slots
        .map((row) => {
          const url = buildThumbnail(g, row);
          if (!url) return null;
          return { slot: row.player_index, url };
        })
        .filter((c): c is { slot: number; url: string } => !!c);
      if (candidates.length === 0) continue;

      try {
        const matches = await matchAvatars(references, candidates);
        suggestions.push({
          gameId: g.id,
          vid: g.pbvision_video_id,
          slots: matches.map((m) => ({
            playerIndex: m.slot,
            playerId: m.player_id,
            playerName: m.player_name,
            confidence: m.confidence,
            margin: m.margin,
          })),
        });
      } catch (err) {
        suggestions.push({
          gameId: g.id,
          vid: g.pbvision_video_id,
          slots: [],
          error: (err as Error).message,
        });
      }
    }

    res.json({ suggestions });
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
      // Respond immediately — the sync itself is done. Then kick off the
      // Mux-playback-ID scrape in the BACKGROUND (not awaited): it drives
      // Playwright and can take minutes for a multi-game session, so
      // blocking the sync response on it would make "Sync now" feel
      // frozen. By firing it here (right after games land in rating-hub,
      // before the coach starts tagging) the IDs are typically populated
      // by the time tagging is done — so players can watch their games
      // without a separate manual step. Idempotent + locked, so it won't
      // collide with a manual "Fetch Mux IDs" click. Progress + any
      // errors stream to the same session log the UI polls.
      res.json(result);

      const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
      if (vids.length > 0) {
        const bgLog = makeAddLog(session.id);
        bgLog("Auto-fetching Mux playback IDs in the background…");
        fetchAndStoreMuxIds(vids, { onLog: bgLog })
          .then((out) => {
            if (out.busy) return; // another fetch was already running
            bgLog(
              `Auto Mux fetch done: ${out.summary.updated} game(s) updated, ` +
                `${out.summary.skipped} skipped, ${out.summary.errors} error(s).`,
            );
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            bgLog(`Auto Mux fetch failed (non-fatal): ${msg}`);
          });
      }
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

// DELETE /api/sessions/:id — Permanently remove the session, its logs,
// and any exported clip files on disk. Does NOT touch rating-hub or
// pb.vision — those have to be cleaned up separately if needed.
router.delete("/:id", async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    deleteClipFiles(session);
    await deleteSession(session.id);

    res.status(204).send();
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
