// GET /lesson-video/:token — the one public route (D-0273 rule 6; rsm#102).
//
// Served on video.thirdshotacademy.com, where this route is the ONLY protection
// (no Cloudflare Access in front), so every line below fails closed:
//   - an unset signing secret refuses every request
//   - the token names one file; the path is derived from validated ids
//   - a `video_access_log` row is written on a token's FIRST use, before any
//     bytes; if the write fails, no bytes are served
//   - HTTP Range, because iPhone Safari will not play a video it cannot seek
//
// Nothing here deletes, writes or lists a file.

import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { getSupabase } from "../supabase.js";
import { verifyLessonVideoToken, type LessonVideoPayload } from "../lesson-video/token.js";
import { clipFile, recordingFile, loadClipConfig, type ClipConfig } from "../services/lesson-clips.js";

export interface AccessLogRow {
  user_id: string;
  lesson_id: string;
  mark_id: string | null;
  file: string;
}

export interface LessonVideoDeps {
  secret: () => string | undefined;
  cfg: () => ClipConfig;
  writeAccessLog: (row: AccessLogRow) => Promise<void>;
  now: () => number;
}

const defaultDeps: LessonVideoDeps = {
  secret: () => process.env.LESSON_VIDEO_SIGNING_SECRET,
  cfg: () => loadClipConfig(),
  async writeAccessLog(row) {
    const { error } = await getSupabase().from("video_access_log").insert(row);
    if (error) throw new Error(error.message);
  },
  now: () => Math.floor(Date.now() / 1000),
};

/**
 * Per-token in-flight/settled access-log write, so a Range-seeking player writes one row, not
 * fifty, and overlapping requests for a token all wait on the SAME write (none gets bytes before
 * it lands). A failed write is cleared so the next request retries.
 */
const loggedTokens = new Map<string, { exp: number; done: Promise<void> }>();
function logOnce(sig: string, exp: number, nowS: number, write: () => Promise<void>): Promise<void> {
  for (const [k, v] of loggedTokens) if (v.exp <= nowS) loggedTokens.delete(k);
  const existing = loggedTokens.get(sig);
  if (existing) return existing.done;
  const done = write().catch((err) => {
    loggedTokens.delete(sig);
    throw err;
  });
  loggedTokens.set(sig, { exp, done });
  return done;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` → inclusive [start, end], or null when unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null | "none" {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "none";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

function refuse(res: Response, status: number, error: string) {
  res.status(status).set("Cache-Control", "no-store").json({ error });
}

async function resolveFile(p: LessonVideoPayload, cfg: ClipConfig): Promise<string | null> {
  if (p.k === "clip") return p.mid ? clipFile(cfg, p.lid, p.mid) : null;
  return p.f ? recordingFile(cfg, p.f) : null;
}

export function makeLessonVideoRouter(deps: LessonVideoDeps = defaultDeps): Router {
  const router = Router();

  router.get("/:token", async (req: Request, res: Response) => {
    const nowS = deps.now();
    const verdict = verifyLessonVideoToken(String(req.params.token), deps.secret(), nowS);
    if (!verdict.ok) {
      // 503 only for our own misconfiguration; everything else is the caller's.
      return refuse(res, verdict.reason === "unconfigured" ? 503 : 403, verdict.reason === "unconfigured" ? "video_delivery_not_configured" : "token_refused");
    }
    const p = verdict.payload;

    const file = await resolveFile(p, deps.cfg());
    let stat: fs.Stats | null = null;
    try { stat = file ? fs.statSync(file) : null; } catch { stat = null; }
    if (!file || !stat || !stat.isFile() || stat.size === 0) return refuse(res, 404, "not_found");

    // Log BEFORE any bytes, once per token. Fail closed: no log, no video.
    const sig = String(req.params.token).split(".")[1];
    try {
      await logOnce(sig, p.exp, nowS, () => deps.writeAccessLog({
        user_id: p.sub,
        lesson_id: p.lid,
        mark_id: p.k === "clip" ? p.mid : null,
        file: p.k === "clip" ? `clip:${p.lid}:${p.mid}` : p.f!,
      }));
    } catch (err) {
      console.error(`[lesson-video] access log failed, refusing to serve: ${(err as Error).message}`);
      return refuse(res, 503, "access_log_unavailable");
    }

    const size = stat.size;
    res.set({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    });

    const rangeHeader = req.headers.range;
    const range = rangeHeader ? parseRange(rangeHeader, size) : "none";
    if (range === null) {
      res.status(416).set("Content-Range", `bytes */${size}`).end();
      return;
    }
    let start = 0;
    let end = size - 1;
    if (range !== "none") {
      start = range.start;
      end = range.end;
      res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
    } else {
      res.status(200);
    }
    res.set("Content-Length", String(end - start + 1));
    if (req.method === "HEAD") { res.end(); return; }

    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => { res.destroy(); });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });

  return router;
}

export default makeLessonVideoRouter();
