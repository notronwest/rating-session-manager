// Cut a lesson's coach-marked moments into real clip files (D-0273 rule 4; rsm#102).
//
// Reads written-up lessons' `marks`, cuts each with ffmpeg `-c copy` (D-0041:
// no re-encode, keyframe-aligned bounds accepted) into ONE faststart mp4 at a NAS
// path derived only from lesson id and mark id, then writes `lessons.clips`.
//
// THE RULES THIS FILE HOLDS:
//   - Idempotent. A clip file that exists is never re-cut and starts no ffmpeg.
//   - Deletes nothing. A clip whose mark was edited stays on disk; only the
//     `clips` entry for it is dropped. D-0273 forbids deleting a clip or recording.
//   - A missing NAS mount is a clean no-op: no write, and no local shadow
//     directory (we never mkdir above the mount root).
//   - `lessons.clips` has one writer, and it is this file, with the service-role
//     key. An anon-key fallback is refused here even though getSupabase() allows it.
//   - Missing columns (third-shot-academy#751's migration not yet on main) are
//     reported and nothing is written.
// The camd guard lives in the caller (src/cli/lesson-transcribe.ts), which reuses
// the transcription job's fail-closed one rather than keeping a second copy.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getSupabase } from "../supabase.js";
import { loadConfig, probeDurationS, type TranscribeConfig } from "./lesson-transcribe.js";
import { RECORDING_REF_RE, UUID_RE } from "../lesson-video/token.js";

export interface ClipConfig extends TranscribeConfig {
  /** The NAS share root. If this is absent the share is not mounted. */
  mountRoot: string;
  /** Where clips live: <clipsDir>/<lessonId>/<markId>.mp4 */
  clipsDir: string;
  /** Per-tick cap so one tick stays short. */
  maxClipsPerRun: number;
}

export function loadClipConfig(env: NodeJS.ProcessEnv = process.env): ClipConfig {
  const base = loadConfig(env);
  const mountRoot = env.LESSON_MOUNT_ROOT || "/Volumes/wmpc-video";
  const n = Number(env.LESSON_MAX_CLIPS_PER_RUN);
  return {
    ...base,
    mountRoot,
    clipsDir: env.LESSON_CLIPS_DIR || path.join(mountRoot, "lesson-clips"),
    maxClipsPerRun: Number.isFinite(n) && n > 0 ? n : 20,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export interface Mark { id: string; start_ms: number; end_ms: number }
export interface ClipEntry { mark_id: string; ready_at: string; duration_ms: number }

const MAX_MARKS = 10;
const MAX_MARK_MS = 3 * 60 * 1000;

/** Marks that satisfy the column's own CHECK; anything else is ignored, not guessed at. */
export function parseMarks(raw: unknown): Mark[] {
  if (!Array.isArray(raw) || raw.length > MAX_MARKS) return [];
  const out: Mark[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return [];
    const { id, start_ms, end_ms } = m as Record<string, unknown>;
    if (typeof id !== "string" || !UUID_RE.test(id)) return [];
    if (!Number.isInteger(start_ms) || !Number.isInteger(end_ms)) return [];
    const s = start_ms as number, e = end_ms as number;
    if (s < 0 || e <= s || e - s > MAX_MARK_MS) return [];
    out.push({ id, start_ms: s, end_ms: e });
  }
  return out;
}

/** The clip's path, from ids alone. Throws on anything that is not a UUID. */
export function clipFile(cfg: Pick<ClipConfig, "clipsDir">, lessonId: string, markId: string): string | null {
  if (!UUID_RE.test(lessonId) || !UUID_RE.test(markId)) return null;
  return path.join(cfg.clipsDir, lessonId.toLowerCase(), `${markId.toLowerCase()}.mp4`);
}

/** `teaching/<date>/<base>` → the finished recording on the NAS (or the local copy). */
export function recordingFile(cfg: Pick<ClipConfig, "nasDir" | "localDir">, ref: string): string | null {
  if (!RECORDING_REF_RE.test(ref)) return null;
  const [, date, base] = ref.split("/");
  const name = base.endsWith(".mp4") ? base : `${base}.mp4`;
  if (name.startsWith(".")) return null;
  for (const root of [cfg.nasDir, cfg.localDir]) {
    const p = path.join(root, date, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* try the next tree */ }
  }
  return null;
}

/** Marks with no entry in `clips`, or whose clip file is gone. */
export function pendingMarks(marks: Mark[], clips: ClipEntry[], fileExists: (markId: string) => boolean): Mark[] {
  const have = new Set(clips.map((c) => c.mark_id));
  return marks.filter((m) => !have.has(m.id) || !fileExists(m.id));
}

/** Entries for marks that still exist, plus the new ones. Never names a mark that was edited away. */
export function mergeClips(marks: Mark[], existing: ClipEntry[], added: ClipEntry[]): ClipEntry[] {
  const live = new Set(marks.map((m) => m.id));
  const byId = new Map<string, ClipEntry>();
  for (const c of existing) if (live.has(c.mark_id)) byId.set(c.mark_id, c);
  for (const c of added) if (live.has(c.mark_id)) byId.set(c.mark_id, c);
  return marks.filter((m) => byId.has(m.id)).map((m) => byId.get(m.id)!);
}

export function ffmpegCutArgs(src: string, out: string, mark: Mark): string[] {
  const start = (mark.start_ms / 1000).toFixed(3);
  const dur = ((mark.end_ms - mark.start_ms) / 1000).toFixed(3);
  // -ss before -i seeks by keyframe (fast, and what -c copy needs); faststart puts
  // the moov atom first so iPhone Safari can start playing before the file is read.
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-ss", start, "-i", src, "-t", dur, "-c", "copy", "-map", "0:v", "-map", "0:a?",
    "-movflags", "+faststart", "-f", "mp4", out];
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface CutDeps {
  /** Returns true when ffmpeg exited 0. */
  runFfmpeg: (bin: string, args: string[]) => boolean;
  durationMs: (file: string) => Promise<number | null>;
  now: () => Date;
}

const realDeps = (cfg: ClipConfig): CutDeps => ({
  runFfmpeg: (bin, args) => spawnSync("nice", ["-n", "15", bin, ...args], { stdio: "ignore" }).status === 0,
  durationMs: async (file) => {
    const s = await probeDurationS(cfg, file);
    return s === null ? null : Math.round(s * 1000);
  },
  now: () => new Date(),
});

interface LessonRow { id: string; recording_ref: string | null; marks: unknown; clips: unknown }

export type CutOutcome =
  | { kind: "no-mount" }
  | { kind: "no-columns" }
  | { kind: "no-service-key" }
  | { kind: "ran"; cut: number; skipped: number; failed: number; lessonsUpdated: number };

/** Postgres 42703 (undefined_column) or PostgREST's schema-cache wording. */
function isMissingColumn(err: { code?: string; message?: string }): boolean {
  return err.code === "42703" || err.code === "PGRST204" || /column .*(marks|clips)|(marks|clips).* does not exist|schema cache/i.test(err.message ?? "");
}

/** Do `lessons.marks` and `lessons.clips` exist yet? Used by --self-test and the run. */
export async function clipColumnsExist(): Promise<boolean> {
  const { error } = await getSupabase().from("lessons").select("id, marks, clips").limit(1);
  if (!error) return true;
  if (isMissingColumn(error)) return false;
  throw new Error(`could not read lessons: ${error.message}`);
}

export async function cutClips(
  cfg: ClipConfig,
  log: (line: string) => void,
  deps: CutDeps = realDeps(cfg),
): Promise<CutOutcome> {
  // A missing mount is not an error and must not leave a local shadow tree.
  if (!fs.existsSync(cfg.mountRoot)) {
    log(`clips: ${cfg.mountRoot} is not mounted — nothing written`);
    return { kind: "no-mount" };
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log("clips: SUPABASE_SERVICE_ROLE_KEY is not set — clips has one writer and it is the service role; nothing written");
    return { kind: "no-service-key" };
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from("lessons")
    .select("id, recording_ref, marks, clips")
    .not("written_up_at", "is", null)
    .not("recording_ref", "is", null)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) {
    if (isMissingColumn(error)) {
      log("clips: lessons.marks / lessons.clips do not exist yet (third-shot-academy#751's migration is not on main) — nothing written");
      return { kind: "no-columns" };
    }
    throw new Error(`lesson read failed: ${error.message}`);
  }

  let cut = 0, skipped = 0, failed = 0, lessonsUpdated = 0;
  for (const row of (data ?? []) as LessonRow[]) {
    const marks = parseMarks(row.marks);
    if (marks.length === 0) continue;
    const existing = Array.isArray(row.clips) ? (row.clips as ClipEntry[]) : [];
    const exists = (markId: string) => {
      const f = clipFile(cfg, row.id, markId);
      try { return !!f && fs.statSync(f).size > 0; } catch { return false; }
    };
    const todo = pendingMarks(marks, existing, exists);
    if (todo.length === 0) continue;

    const src = row.recording_ref ? recordingFile(cfg, row.recording_ref) : null;
    if (!src) { log(`clips: lesson ${row.id}: recording ${row.recording_ref} is not readable — try again next tick`); skipped += todo.length; continue; }

    const added: ClipEntry[] = [];
    for (const mark of todo) {
      const out = clipFile(cfg, row.id, mark.id)!;
      // The file may exist with no `clips` entry (a tick died between the cut and
      // the write). Adopt it rather than starting ffmpeg again.
      if (!exists(mark.id)) {
        if (cut >= cfg.maxClipsPerRun) { skipped++; continue; }
        const dir = path.dirname(out);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.${mark.id}.part.mp4`);
        const ok = deps.runFfmpeg(cfg.ffmpegBin, ffmpegCutArgs(src, tmp, mark));
        let good = false;
        try { good = ok && fs.statSync(tmp).size > 0; } catch { good = false; }
        if (!good) {
          try { fs.rmSync(tmp, { force: true }); } catch { /* it is our own temp */ }
          log(`clips: lesson ${row.id} mark ${mark.id}: ffmpeg failed — will retry`);
          failed++;
          continue;
        }
        fs.renameSync(tmp, out);
        cut++;
        log(`clips: lesson ${row.id} mark ${mark.id}: cut`);
      }
      const dur = await deps.durationMs(out);
      added.push({
        mark_id: mark.id,
        ready_at: deps.now().toISOString(),
        duration_ms: dur ?? mark.end_ms - mark.start_ms,
      });
    }
    if (added.length === 0) continue;

    const merged = mergeClips(marks, existing, added);
    const { error: upErr } = await sb.from("lessons").update({ clips: merged }).eq("id", row.id);
    if (upErr) { log(`clips: lesson ${row.id}: could not write clips — ${upErr.message}`); failed++; continue; }
    lessonsUpdated++;
  }
  log(`clips: ${cut} cut, ${skipped} deferred, ${failed} failed, ${lessonsUpdated} lesson(s) updated`);
  return { kind: "ran", cut, skipped, failed, lessonsUpdated };
}
