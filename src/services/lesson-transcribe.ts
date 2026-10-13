// LP-08 — transcribe a finished teaching-camera lesson recording, locally, and
// attach the text to its lesson. Issue #74. Architecture: D-0064.
//
// THE TWO RULES D-0064 PUTS ON THIS FILE, both enforced below:
//   1. Never transcribe while a lesson is being recorded. The mini's CPU is
//      camd's then, and a stalled encode loses a lesson no retry can recover.
//   2. A transcript does not leave the mini other than as the text attached to
//      the lesson. So the only network writes here are Supabase (lessons.transcript)
//      and, when enabled, the TSA draft function — nothing else, ever.
//
// WHY THE NAS IS THE SOURCE AND NOT /opt/wmpc/recordings.
// recordings-sync.sh copies a finished recording to the NAS, verifies it by
// sha256, and only then prunes the local copy — so on a healthy mini the local
// tree is EMPTY (verified 2026-10-13: every date directory there held no files).
// The NAS copy is the one that reliably exists. We still prefer a local copy
// when one happens to be there, because reading 2 GB over SMB is slow, but we
// never depend on it.
//
// WHY A FILE AT ITS FINAL NAME IS SAFE TO READ.
// recordings-sync writes to `.<name>.uploading` and `mv`s it into place only
// after verifying, specifically so a downstream reader cannot mistake a partial
// copy for a finished recording. Skipping dotfiles is therefore sufficient; we
// do not need to second-guess it with our own size checks.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { getSupabase } from "../supabase.js";

// ── Config ───────────────────────────────────────────────────────────────────
// Every value is env-overridable so a dry run on a laptop can point at copies,
// but the DEFAULTS are production: this job has exactly one real deployment.

export interface TranscribeConfig {
  /** Finished recordings, the authoritative tree. */
  nasDir: string;
  /** Opportunistic fast path. May not exist; never required. */
  localDir: string;
  /** Where .txt/.srt/.json land. On the NAS: same trust boundary as the video. */
  transcriptsDir: string;
  /** Local scratch for the 16 kHz wav. Deleted after each recording. */
  scratchDir: string;
  stateDir: string;
  whisperBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  modelPath: string;
  /** Silero VAD model. Empty disables VAD — see decodeArgs() for why that is bad. */
  vadModelPath: string;
  threads: number;
  /** Below this, it is a camera test, not a lesson. The 12 test files are ≤20 MB. */
  minDurationS: number;
  /** A file must be this old before we touch it. Belt to the .uploading brace. */
  settleS: number;
  camdStatusUrl: string;
  /** Per-tick cap. One lesson per tick keeps the mini responsive. */
  maxPerRun: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TranscribeConfig {
  const home = os.homedir();
  const num = (v: string | undefined, d: number) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    nasDir: env.LESSON_RECORDINGS_DIR || "/Volumes/wmpc-video/teaching",
    localDir: env.LESSON_RECORDINGS_LOCAL_DIR || "/opt/wmpc/recordings/teaching",
    transcriptsDir: env.LESSON_TRANSCRIPTS_DIR || "/Volumes/wmpc-video/transcripts",
    scratchDir: env.LESSON_SCRATCH_DIR || path.join(home, ".cache", "wmpc-lesson-transcribe"),
    stateDir: env.LESSON_STATE_DIR || path.join(home, ".local", "state", "wmpc-lesson-transcribe"),
    whisperBin: env.LESSON_WHISPER_BIN || "/opt/homebrew/bin/whisper-cli",
    ffmpegBin: env.LESSON_FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg",
    ffprobeBin: env.LESSON_FFPROBE_BIN || "/opt/homebrew/bin/ffprobe",
    modelPath: env.LESSON_WHISPER_MODEL
      || path.join(home, ".local", "share", "wmpc-lesson-transcribe", "ggml-small.en.bin"),
    vadModelPath: env.LESSON_VAD_MODEL
      || path.join(home, ".local", "share", "wmpc-lesson-transcribe", "ggml-silero-v5.1.2.bin"),
    threads: num(env.LESSON_WHISPER_THREADS, 4),
    minDurationS: num(env.LESSON_MIN_DURATION_S, 600),
    settleS: num(env.LESSON_SETTLE_S, 300),
    camdStatusUrl: env.LESSON_CAMD_STATUS_URL || "http://127.0.0.1:8081/status",
    maxPerRun: num(env.LESSON_MAX_PER_RUN, 1),
  };
}

// ── Pure helpers (unit-tested in tests/lesson-transcribe.test.ts) ────────────

export interface Recording {
  /** `<date>/<basename>` — the stable id, and what LP-07 writes to lessons.recording_ref. */
  ref: string;
  date: string;
  base: string;
  /** Absolute path we will actually read. */
  file: string;
}

/**
 * The recording_ref LP-07 uses. Derived from the path, not invented here, so
 * that LP-07 setting `recording_ref` and this job reading it cannot drift: both
 * describe the same file in the same tree.
 */
export function recordingRef(date: string, base: string): string {
  return `teaching/${date}/${base}`;
}

/** `2026-09-30/teaching-090731.mp4` → {date, base}; null for anything else. */
export function parseRecordingPath(rel: string): { date: string; base: string } | null {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [date, file] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!file.endsWith(".mp4")) return null;
  // Dotfiles are recordings-sync's `.uploading` temps and camd's `.recording`
  // temps. Both are live writes; neither is a finished recording.
  if (file.startsWith(".")) return null;
  return { date, base: file.slice(0, -".mp4".length) };
}

export type SkipReason =
  | { skip: false }
  | { skip: true; reason: string };

/**
 * Should we leave this file alone this tick? Pure, so the settle window and the
 * duration floor are testable without a filesystem.
 */
export function eligibility(opts: {
  ageS: number;
  durationS: number | null;
  settleS: number;
  minDurationS: number;
  alreadyDone: boolean;
}): SkipReason {
  if (opts.alreadyDone) return { skip: true, reason: "already transcribed" };
  if (opts.ageS < opts.settleS) {
    return { skip: true, reason: `still settling (${Math.round(opts.ageS)}s < ${opts.settleS}s)` };
  }
  if (opts.durationS === null) return { skip: true, reason: "duration unreadable" };
  if (opts.durationS < opts.minDurationS) {
    return { skip: true, reason: `${Math.round(opts.durationS)}s is under the ${opts.minDurationS}s lesson floor — camera test` };
  }
  return { skip: false };
}

/**
 * whisper-cli arguments.
 *
 * VAD IS NOT OPTIONAL, and this is the bug the 2026-10-07 prototype found:
 * whisper looped on silence mid-file, emitting the same phrase for minutes, and
 * on the 09-27 clinic — whose mic was never connected — it produced 166 words of
 * pure hallucination from digital silence. Without a VAD model we would ship
 * that bug again, so the caller refuses to run rather than transcribe blind.
 *
 * `--max-context 0` is the second half of the fix: it stops the decoder feeding
 * its own previous output back as the prompt, which is what turns one bad
 * segment into a loop that runs to the end of the file.
 */
export function decodeArgs(cfg: TranscribeConfig, wav: string, outBase: string): string[] {
  return [
    "-m", cfg.modelPath,
    "-t", String(cfg.threads),
    "-f", wav,
    "-otxt", "-osrt",
    "-of", outBase,
    "-np",
    "--vad",
    "-vm", cfg.vadModelPath,
    "-mc", "0",
    "-et", "2.8",
  ];
}

// ── Process helpers ──────────────────────────────────────────────────────────

interface RunResult { code: number; stdout: string; stderr: string }

/**
 * Run a child at nice 15. EVERY external process this job starts is niced:
 * Court 4 streams to YouTube off the same box, and an un-niced ffmpeg on a
 * 10-core mini was measured at load 2.1 during the prototype.
 */
function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("nice", ["-n", "15", bin, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
  });
}

export async function probeDurationS(cfg: TranscribeConfig, file: string): Promise<number | null> {
  const r = await run(cfg.ffprobeBin, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { timeoutMs: 120_000 });
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Mean volume in dBFS, or null if unreadable. Digital silence reads as -91 dB
 * (or -inf). We refuse to transcribe a silent recording rather than store
 * hallucinated text on a lesson: the 09-27 clinic is exactly this case, and its
 * "transcript" was 166 invented words.
 */
export async function probeMeanVolumeDb(cfg: TranscribeConfig, wav: string): Promise<number | null> {
  const r = await run(cfg.ffmpegBin, ["-v", "info", "-i", wav, "-af", "volumedetect", "-f", "null", "-"],
    { timeoutMs: 600_000 });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m) return /mean_volume:\s*-inf/.test(r.stderr) ? -Infinity : null;
  return Number(m[1]);
}

export const SILENCE_FLOOR_DB = -70;

// ── camd guard ───────────────────────────────────────────────────────────────

export type CamdState = "idle" | "recording" | "unreachable";

/**
 * FAIL CLOSED. "Unreachable" is not "idle": if we cannot prove camd is idle we
 * do not start a 40-minute ffmpeg read, because D-0064's hard rule is that we
 * never compete with a lesson being recorded. The caller escalates to Discord
 * when unreachable persists, so fail-closed cannot become fail-silent.
 */
export async function camdState(cfg: TranscribeConfig): Promise<CamdState> {
  try {
    const res = await fetch(cfg.camdStatusUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "unreachable";
    const j = (await res.json()) as { recording?: boolean; record_requested?: boolean };
    return j.recording || j.record_requested ? "recording" : "idle";
  } catch {
    return "unreachable";
  }
}

/**
 * Bytes, not status. camd has reported `recording: true` while writing no file,
 * and has reported itself healthy while looping on an output path named "None" —
 * so a live dotted temp anywhere in either tree is the evidence that overrides
 * a cheerful status. Checked in BOTH trees because the local one is where camd
 * writes and the NAS one is where a stalled `.uploading` would sit.
 */
export function liveTempExists(dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const date of safeReaddir(dir)) {
      const sub = path.join(dir, date);
      if (!safeIsDir(sub)) continue;
      for (const f of safeReaddir(sub)) {
        if (f.startsWith(".") && (f.endsWith(".recording.mp4") || f.endsWith(".uploading"))) {
          return path.join(sub, f);
        }
      }
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Discovery ────────────────────────────────────────────────────────────────

export function discover(cfg: TranscribeConfig): Recording[] {
  const out: Recording[] = [];
  const seen = new Set<string>();
  // NAS first: it is the tree that reliably holds finished recordings.
  for (const root of [cfg.nasDir, cfg.localDir]) {
    if (!fs.existsSync(root)) continue;
    for (const date of safeReaddir(root)) {
      const sub = path.join(root, date);
      if (!safeIsDir(sub)) continue;
      for (const f of safeReaddir(sub)) {
        const parsed = parseRecordingPath(`${date}/${f}`);
        if (!parsed) continue;
        const ref = recordingRef(parsed.date, parsed.base);
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push({ ref, date: parsed.date, base: parsed.base, file: path.join(sub, f) });
      }
    }
  }
  return out.sort((a, b) => (a.ref < b.ref ? -1 : 1));
}

export function transcriptPaths(cfg: TranscribeConfig, rec: Recording) {
  const dir = path.join(cfg.transcriptsDir, rec.date);
  return {
    dir,
    txt: path.join(dir, `${rec.base}.txt`),
    srt: path.join(dir, `${rec.base}.srt`),
    meta: path.join(dir, `${rec.base}.json`),
  };
}

/**
 * Done means the META file exists — not the .txt. A silent recording produces a
 * meta saying so and NO transcript, and without this distinction the job would
 * re-extract 2 GB of audio from the same silent file every tick forever.
 */
export function isDone(cfg: TranscribeConfig, rec: Recording): boolean {
  try { return fs.statSync(transcriptPaths(cfg, rec).meta).size > 0; } catch { return false; }
}

// ── Attach + draft ───────────────────────────────────────────────────────────

export interface LessonRow { id: string; transcript: string | null; written_up_at: string | null; what_we_did: string | null; homework: string | null }

/**
 * The lesson this recording belongs to, or null.
 *
 * We look up `recording_ref` — LP-07's field — and DO NOT time-match here.
 * LP-07 (rsm#73) owns matching a recording to a lesson by time window; doing it
 * a second way in this file would be two sources of truth for the same
 * question, which D-0049 forbids and which would have to be torn out when LP-07
 * lands. Until it lands, a transcript simply sits in the store as "pending" and
 * every later tick retries the attach for free.
 */
export async function findLessonForRecording(ref: string): Promise<LessonRow | null> {
  const { data, error } = await getSupabase()
    .from("lessons")
    .select("id, transcript, written_up_at, what_we_did, homework")
    .eq("recording_ref", ref)
    .maybeSingle();
  if (error) throw new Error(`lesson lookup failed for ${ref}: ${error.message}`);
  return (data as LessonRow | null) ?? null;
}

export async function attachTranscript(lessonId: string, transcript: string): Promise<void> {
  const { error } = await getSupabase()
    .from("lessons")
    .update({ transcript, updated_at: new Date().toISOString() })
    .eq("id", lessonId);
  if (error) throw new Error(`attach failed for lesson ${lessonId}: ${error.message}`);
}

/**
 * Ask TSA to draft what-we-did + homework from the transcript.
 *
 * The draft is written into the lesson's OWN columns while `written_up_at` is
 * NULL, which is what makes the coach's form open with a draft instead of a
 * blank (issue #74's acceptance). `written_up_at` stays NULL — D-0064 forbids
 * anything reaching the student before the coach marks it written up, so this
 * function must never set it.
 *
 * The transcript text is the only thing that leaves the mini, and it goes to
 * the coach-AI path TSA already owns rather than a second Anthropic client here
 * (D-0049, and it keeps the API key in one place).
 */
export async function draftWriteUp(
  lesson: LessonRow,
  transcript: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ drafted: boolean; reason?: string }> {
  const url = env.LESSON_DRAFT_URL;
  const secret = env.LESSON_DRAFT_SECRET;
  if (!url || !secret) return { drafted: false, reason: "draft not configured" };
  // Never overwrite a coach. Both of these mean a human has already been here.
  if (lesson.written_up_at) return { drafted: false, reason: "already written up" };
  if (lesson.what_we_did || lesson.homework) return { drafted: false, reason: "already has text" };

  const res = await fetch(url, {
    method: "POST",
    // Bearer, matching generate-themes / generate-priorities / polish-text —
    // the coach-AI functions all authenticate the same way, and inventing a
    // second header for this one caller would be a second pattern (D-0049).
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ lessonId: lesson.id, transcript }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`draft failed HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return { drafted: true };
}

// ── One recording ────────────────────────────────────────────────────────────

export type Outcome =
  | { kind: "transcribed"; words: number; attached: boolean; drafted: boolean }
  | { kind: "silent" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export async function transcribeOne(
  cfg: TranscribeConfig,
  rec: Recording,
  log: (line: string) => void,
): Promise<Outcome> {
  const paths = transcriptPaths(cfg, rec);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(cfg.scratchDir, { recursive: true });
  const wav = path.join(cfg.scratchDir, `${rec.date}_${rec.base}.wav`);
  const started = Date.now();

  try {
    const durationS = await probeDurationS(cfg, rec.file);

    // Audio extraction. This is the slow step — 44 minutes for a 2.2 GB file in
    // the 2026-10-07 prototype, because the mini reaches the NAS over Wi-Fi at
    // ~9 Mbps while its gigabit NIC sits below Wi-Fi in the service order (an
    // open item on Ron's ledger, D-0069). It is not this job's bug to fix, but
    // it IS why the timeout is generous and why maxPerRun is 1.
    log(`extracting audio from ${rec.file}`);
    const ext = await run(cfg.ffmpegBin, ["-v", "error", "-y", "-i", rec.file, "-vn", "-ac", "1", "-ar", "16000", wav],
      { timeoutMs: 3 * 60 * 60 * 1000 });
    if (ext.code !== 0 || !fs.existsSync(wav)) {
      return { kind: "failed", error: `ffmpeg exited ${ext.code}: ${ext.stderr.slice(-300)}` };
    }

    // Silence gate, before whisper rather than after. See probeMeanVolumeDb.
    const meanDb = await probeMeanVolumeDb(cfg, wav);
    if (meanDb !== null && meanDb <= SILENCE_FLOOR_DB) {
      fs.writeFileSync(paths.meta, JSON.stringify({
        ref: rec.ref, durationS, meanVolumeDb: meanDb === -Infinity ? "-inf" : meanDb,
        result: "silent", note: "no audio on this recording — not transcribed, because whisper invents words from silence",
        at: new Date().toISOString(),
      }, null, 2));
      return { kind: "silent" };
    }

    log(`transcribing (${durationS ? Math.round(durationS / 60) : "?"} min of audio)`);
    const outBase = path.join(paths.dir, rec.base);
    const w = await run(cfg.whisperBin, decodeArgs(cfg, wav, outBase), { timeoutMs: 6 * 60 * 60 * 1000 });
    if (w.code !== 0 || !fs.existsSync(paths.txt)) {
      return { kind: "failed", error: `whisper exited ${w.code}: ${w.stderr.slice(-300)}` };
    }

    const transcript = fs.readFileSync(paths.txt, "utf8");
    const words = transcript.split(/\s+/).filter(Boolean).length;

    // Attach + draft. A failure here must NOT lose the transcription we just
    // spent an hour on, so the meta is written first and the attach is retried
    // by the next tick (see reattachPending).
    let attached = false;
    let drafted = false;
    let attachNote = "";
    try {
      const lesson = await findLessonForRecording(rec.ref);
      if (!lesson) {
        attachNote = "pending — no lesson references this recording yet (LP-07)";
      } else if (lesson.transcript) {
        attached = true;
        attachNote = "lesson already had a transcript; left as is";
      } else {
        await attachTranscript(lesson.id, transcript);
        attached = true;
        const d = await draftWriteUp({ ...lesson, transcript }, transcript);
        drafted = d.drafted;
        attachNote = d.drafted ? "drafted" : `draft skipped: ${d.reason}`;
      }
    } catch (err) {
      attachNote = `attach failed, will retry: ${(err as Error).message}`;
    }

    fs.writeFileSync(paths.meta, JSON.stringify({
      ref: rec.ref, durationS, meanVolumeDb: meanDb, words,
      result: "transcribed", attached, drafted, attachNote,
      model: path.basename(cfg.modelPath), vad: path.basename(cfg.vadModelPath),
      tookS: Math.round((Date.now() - started) / 1000),
      at: new Date().toISOString(),
    }, null, 2));

    log(`${rec.ref}: ${words} words in ${Math.round((Date.now() - started) / 1000)}s — ${attachNote}`);
    return { kind: "transcribed", words, attached, drafted };
  } finally {
    try { fs.unlinkSync(wav); } catch { /* scratch only */ }
  }
}

/**
 * Retry the attach for transcripts that finished while no lesson referenced
 * them. This is the whole mechanism by which LP-07 landing completes LP-08
 * with no rework: the day a lesson gets a recording_ref, the next tick attaches
 * the text that has been sitting in the store all along.
 */
export async function reattachPending(cfg: TranscribeConfig, log: (line: string) => void): Promise<number> {
  let n = 0;
  for (const rec of discover(cfg)) {
    const paths = transcriptPaths(cfg, rec);
    if (!fs.existsSync(paths.meta) || !fs.existsSync(paths.txt)) continue;
    let meta: { attached?: boolean; result?: string };
    try { meta = JSON.parse(fs.readFileSync(paths.meta, "utf8")); } catch { continue; }
    if (meta.result !== "transcribed" || meta.attached) continue;
    try {
      const lesson = await findLessonForRecording(rec.ref);
      if (!lesson || lesson.transcript) continue;
      const transcript = fs.readFileSync(paths.txt, "utf8");
      await attachTranscript(lesson.id, transcript);
      const d = await draftWriteUp({ ...lesson, transcript }, transcript);
      fs.writeFileSync(paths.meta, JSON.stringify({ ...meta, attached: true, drafted: d.drafted, attachNote: d.drafted ? "drafted on retry" : `draft skipped: ${d.reason}`, reattachedAt: new Date().toISOString() }, null, 2));
      log(`${rec.ref}: attached to lesson ${lesson.id} on retry${d.drafted ? " + drafted" : ""}`);
      n++;
    } catch (err) {
      log(`${rec.ref}: reattach failed: ${(err as Error).message}`);
    }
  }
  return n;
}
