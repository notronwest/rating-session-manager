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
import { notifyRatingHub, WebhookError } from "../pbvision/webhook.js";
import { syncRatingHub, ensureRatingHubSession, SyncRatingHubError } from "../ratinghub/sync.js";
import { getSupabase, getOrgId } from "../supabase.js";
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
      if (hit) {
        vids[i] = hit.vid;
        unmatchedVideos.delete(hit.vid);
        matches.push({ clipIndex: i, clipName: basename, vid: hit.vid, title: hit.title });
        addLog(`  Matched ${basename} → ${hit.vid}`);
      } else {
        addLog(`  No pb.vision video matches ${basename}`);
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
    const { data: gamesData, error: gErr } = await supabase
      .from("games")
      .select("id, pbvision_video_id, ai_engine_version, played_at")
      .eq("org_id", orgId)
      .eq("session_id", session.id)
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
    const { data: gpData, error: gpErr } = await supabase
      .from("game_players")
      .select("game_id, player_id, player_index")
      .in("game_id", gameIds);
    if (gpErr) throw new Error(`game_players fetch: ${gpErr.message}`);
    const gp = (gpData || []) as { game_id: string; player_id: string; player_index: number }[];

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
            const thumbnailUrl = aiv
              ? `https://storage.googleapis.com/pbv-pro/${g.pbvision_video_id}/${aiv}/player${row.player_index}-0.jpg`
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
    const { data: gameRows, error: gErr } = await supabase
      .from("games")
      .select("id")
      .eq("org_id", orgId)
      .eq("session_id", session.id)
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

    // Apply each mapping. Supabase doesn't support multi-row updates with
    // different values in a single call, so we issue one update per mapping.
    // We've already validated game/player constraints above, so each update
    // should hit exactly one row; count mappings as the success metric.
    let updated = 0;
    for (const m of mappings) {
      const { error: upErr, data } = await supabase
        .from("game_players")
        .update({ player_id: m.playerId })
        .eq("game_id", m.gameId)
        .eq("player_index", m.playerIndex)
        .select("id");
      if (upErr) throw new Error(`update game_players: ${upErr.message}`);
      updated += (data || []).length;
    }

    // Same idea for player_rating_snapshots if rating-hub indexes them by
    // (game_id, player_index) — but the schema keys snapshots on player_id,
    // not player_index. Walk by (game_id, old player_id we just replaced)?
    // Skip for v1; the rating snapshot row stays attached to the *old*
    // player. The user can re-import via Sync with Rating Hub if needed.

    addLog(`Applied ${updated} player tagging mapping(s) to rating-hub.`);
    res.json({ ok: true, updated });
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
