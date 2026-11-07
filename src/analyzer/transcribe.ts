// The audio → transcript analyzer. D-0243 clause 5: this is one of the two pure
// functions that make up the analyzer, and the seam is here rather than at a file
// boundary. Nothing in this directory may know a NAS path, a court, a camd state,
// a booking, a student or a database column — tests/analyzer-boundary.test.ts
// refuses an import that would let it.
//
// What stayed behind in src/services/lesson-transcribe.ts, and why: discovery,
// the settle window, the camd guard, the lesson lookup and the write-up draft all
// describe THE CLUB. They are not analysis.
//
// The two measured lessons from the 2026-10-07 prototype live in this file,
// because they are properties of the analysis and travel with it:
//   1. VAD is not optional (whisper invents words from silence).
//   2. Every child process is niced (Court 4 streams off the same box).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ANALYZER_SCHEMA_VERSION,
  assertTenant,
  type AnalyzerAsk,
  type AnalyzerDocument,
  type TranscriptSegment,
} from "./document.js";

/** Everything the analyzer needs. No paths that belong to a caller's operation. */
export interface AnalyzerConfig {
  whisperBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  modelPath: string;
  /** Silero VAD model. Empty disables VAD — see decodeArgs() for why that is bad. */
  vadModelPath: string;
  threads: number;
}

/**
 * One job. D-0243 clause 3: a readable link, a tenant id, and the asks —
 * nothing else.
 *
 * WHAT CHANGED, AND WHY IT MATTERS MORE THAN IT LOOKS. This used to carry
 * `outBase`: a path in the CALLER's tree that whisper wrote `.txt` and `.srt`
 * into. An analyzer reachable over a network cannot write into its caller's
 * folder, so that field was the single thing that made this module
 * un-liftable — it is gone, and the text and its timings come back IN the
 * document instead. `scratchDir` is now the analyzer's own working space and
 * everything it puts there is deleted before the job returns.
 */
export interface AnalyzerInput {
  /** Whose job this is. Required; see assertTenant. */
  tenant: string;
  /** The video to read: an `http(s)` URL the analyzer can read for the length of the job, or a local path. */
  video: string;
  /** The analyzer's own scratch. Created if absent; emptied of this job's files after. */
  scratchDir: string;
  asks?: AnalyzerAsk[];
}

/**
 * What the analyzer will read. A URL or a filesystem path, and NOTHING else —
 * `pipe:`, `concat:`, `rtmp:` and friends are ffmpeg protocols that would turn
 * a caller-supplied string into a caller-supplied capability. Refused rather
 * than sanitised, because a protocol list grows and a refusal does not.
 */
export function assertReadableVideo(video: unknown): string {
  if (typeof video !== "string" || video.trim() === "") {
    throw new Error(`a job needs a video to read; got ${JSON.stringify(video)}`);
  }
  const v = video.trim();
  if (/^https?:\/\//i.test(v)) return v;
  // A bare path. Anything with a scheme that is not http(s) is refused; a
  // Windows-style drive letter is not a scheme we accept either.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    throw new Error(`a video link must be http(s) or a local path; got ${v.split(":")[0]}:`);
  }
  return v;
}

export const SILENCE_FLOOR_DB = -70;

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
export function decodeArgs(cfg: AnalyzerConfig, wav: string, outBase: string): string[] {
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

export async function probeDurationS(cfg: AnalyzerConfig, file: string): Promise<number | null> {
  const r = await run(cfg.ffprobeBin, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
    // Twenty minutes, not two. Measured 2026-11-06: a hand-run ffprobe on a
    // 1.6 GB lesson on the club storage had not returned after SEVERAL
    // minutes, because the mini reaches that share over Wi-Fi. At the old
    // two-minute ceiling the probe timed out, the duration came back null, and
    // the job logged "duration unreadable", wrote no record and retried on the
    // next tick — forever, and silently, which is the same shape as the
    // no-audio bug this sits beside. A ceiling has to clear the slowest real
    // read, not the fastest.
  ], { timeoutMs: 20 * 60_000 });
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Mean volume in dBFS, or null if unreadable. Digital silence reads as -91 dB
 * (or -inf). We refuse to transcribe a silent recording rather than store
 * hallucinated text on a lesson: the 09-27 clinic is exactly this case, and its
 * "transcript" was 166 invented words.
 */
/**
 * Does this file carry an audio stream at all? true / false, or null when the
 * question could not be asked (treated as "carry on", because refusing on an
 * unreadable probe would stop work on a healthy file).
 *
 * Separate from probeMeanVolumeDb, which measures LOUDNESS of an existing
 * track. A file with no track is a different fact with a different remedy —
 * the microphone was not reaching the recorder — and it is permanent, so it
 * must terminate rather than retry.
 */
export async function probeHasAudioStream(cfg: AnalyzerConfig, file: string): Promise<boolean | null> {
  const r = await run(cfg.ffprobeBin, [
    "-v", "error", "-select_streams", "a",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0", file,
  ], { timeoutMs: 300_000 });
  if (r.code !== 0) return null;
  return r.stdout.trim().length > 0;
}

export async function probeMeanVolumeDb(cfg: AnalyzerConfig, wav: string): Promise<number | null> {
  const r = await run(cfg.ffmpegBin, ["-v", "info", "-i", wav, "-af", "volumedetect", "-f", "null", "-"],
    { timeoutMs: 600_000 });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m) return /mean_volume:\s*-inf/.test(r.stderr) ? -Infinity : null;
  return Number(m[1]);
}

/** JSON-safe form of a mean volume, so the document can be stored as it stands. */
export function meanVolumeForDocument(db: number | null): number | "-inf" | null {
  if (db === null) return null;
  return db === -Infinity ? "-inf" : db;
}

/**
 * SubRip to timed segments. Added with 1.2, because whisper has been writing
 * these timings beside every transcript since the first lesson and the document
 * threw them away — so `cues`, `timeline` and `events` had nothing to be built
 * from, and no caller could point a clip at a moment.
 *
 * Lenient on purpose: a half-written or oddly-numbered file yields the blocks
 * it can read rather than failing the whole job. A transcript with no timings
 * is worth far more than no transcript.
 */
export function parseSrt(srt: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const stamp = /(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  for (const block of srt.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const idx = lines.findIndex((l) => stamp.test(l));
    if (idx === -1) continue;
    const m = stamp.exec(lines[idx])!;
    const secs = (h: string, mi: string, se: string, ms: string) =>
      Number(h) * 3600 + Number(mi) * 60 + Number(se) + Number(ms.padEnd(3, "0")) / 1000;
    const text = lines.slice(idx + 1).join(" ").trim();
    if (text === "") continue;
    out.push({
      startS: secs(m[1], m[2], m[3], m[4]),
      endS: secs(m[5], m[6], m[7], m[8]),
      text,
    });
  }
  return out;
}

/**
 * The job. Extract audio, refuse silence, transcribe, return ONE document.
 *
 * It never throws for an analysis failure — a failed decode is a document with
 * `result: "failed"`, because the caller's retry policy is the caller's business
 * (here: the meta file is not written, so the next tick tries again). It DOES
 * throw for a malformed job — no tenant, no readable link — because that is the
 * caller's bug and returning a document for it would hide it.
 *
 * NOTHING IS LEFT BEHIND. Every file this function creates lives under
 * `input.scratchDir` and is removed in the `finally`, including whisper's own
 * `.txt` and `.srt`. D-0243 clause 4: a reader, never a store.
 */
export async function transcribeAudio(
  cfg: AnalyzerConfig,
  input: AnalyzerInput,
  log: (line: string) => void = () => {},
): Promise<AnalyzerDocument> {
  const tenant = assertTenant(input.tenant);
  const video = assertReadableVideo(input.video);
  const asks = input.asks ?? ["transcript"];
  const started = Date.now();
  fs.mkdirSync(input.scratchDir, { recursive: true });
  // The analyzer's own working name. Derived from the job, never from a path in
  // the caller's tree, so two jobs on the same machine cannot collide and the
  // analyzer does not have to be told where the caller keeps things.
  const stem = `job-${process.pid}-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const outBase = path.join(input.scratchDir, stem);
  const wav = `${outBase}.wav`;
  const doc = (over: Partial<AnalyzerDocument>): AnalyzerDocument => ({
    schema_version: ANALYZER_SCHEMA_VERSION,
    tenant,
    asks,
    result: "failed",
    source: { durationS: null, meanVolumeDb: null },
    engine: {
      model: path.basename(cfg.modelPath),
      vad: path.basename(cfg.vadModelPath),
      tookS: Math.round((Date.now() - started) / 1000),
    },
    at: new Date().toISOString(),
    ...over,
  });

  try {
    const durationS = await probeDurationS(cfg, video);

    // Audio extraction. This is the slow step — 44 minutes for a 2.2 GB file in
    // the 2026-10-07 prototype, because the mini reaches the NAS over Wi-Fi at
    // ~9 Mbps while its gigabit NIC sits below Wi-Fi in the service order (an
    // open item on Ron's ledger, D-0069). It is not this job's bug to fix, but
    // it IS why the timeout is generous.
    // Does the file carry an audio track AT ALL? Distinct from digital
    // silence, and the distinction is what stops an endless retry.
    //
    // Measured 2026-11-06: ten lessons from 10-15 onward have NO audio stream.
    // `-vn` then leaves ffmpeg nothing to write, so it reports "Output file
    // does not contain any stream" and — the part that matters — exits ZERO
    // while producing no wav. That took the "failed" path, which deliberately
    // writes no meta so the next tick retries. Over three weeks that was
    // 1,585 extraction attempts and 20 completions, and because a failure was
    // only ever sent to Discord and never written to the log, the other 1,562
    // left no trace anywhere.
    //
    // A missing audio track is permanent, so it is recorded like silence:
    // terminal, with the reason on the record.
    const hasAudio = await probeHasAudioStream(cfg, video);
    if (hasAudio === false) {
      return doc({
        result: "silent",
        source: { durationS, meanVolumeDb: null },
        note: "the recording has no audio track at all — the microphone was not reaching the recorder",
      });
    }

    log(`extracting audio from ${video}`);
    const ext = await run(cfg.ffmpegBin,
      ["-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", wav],
      { timeoutMs: 3 * 60 * 60 * 1000 });
    if (ext.code !== 0 || !fs.existsSync(wav)) {
      return doc({
        source: { durationS, meanVolumeDb: null },
        error: `ffmpeg exited ${ext.code}: ${ext.stderr.slice(-300)}`,
      });
    }

    // Silence gate, before whisper rather than after. See probeMeanVolumeDb.
    const meanDb = await probeMeanVolumeDb(cfg, wav);
    const meanForDoc = meanVolumeForDocument(meanDb);
    if (meanDb !== null && meanDb <= SILENCE_FLOOR_DB) {
      return doc({ result: "silent", source: { durationS, meanVolumeDb: meanForDoc } });
    }

    log(`transcribing (${durationS ? Math.round(durationS / 60) : "?"} min of audio)`);
    const txt = `${outBase}.txt`;
    const w = await run(cfg.whisperBin, decodeArgs(cfg, wav, outBase),
      { timeoutMs: 6 * 60 * 60 * 1000 });
    if (w.code !== 0 || !fs.existsSync(txt)) {
      return doc({
        source: { durationS, meanVolumeDb: meanForDoc },
        error: `whisper exited ${w.code}: ${w.stderr.slice(-300)}`,
      });
    }

    const text = fs.readFileSync(txt, "utf8");
    // The timings, which used to be written into the caller's folder and never
    // read by anything. A missing or unreadable .srt leaves the transcript
    // whole and the segments absent — it is not a reason to fail a job.
    let srt: string | undefined;
    let segments: TranscriptSegment[] | undefined;
    try {
      srt = fs.readFileSync(`${outBase}.srt`, "utf8");
      const parsed = parseSrt(srt);
      if (parsed.length > 0) segments = parsed;
    } catch { /* no timings on this one */ }

    return doc({
      result: "transcribed",
      source: { durationS, meanVolumeDb: meanForDoc },
      transcript: {
        text,
        words: text.split(/\s+/).filter(Boolean).length,
        ...(segments ? { segments } : {}),
        ...(srt ? { srt } : {}),
      },
    });
  } finally {
    // Scratch only, and ALL of it: the wav, and whisper's own .txt/.srt, which
    // before 1.2 were left in the caller's tree for the caller to own.
    for (const f of [wav, `${outBase}.txt`, `${outBase}.srt`]) {
      try { fs.unlinkSync(f); } catch { /* scratch only */ }
    }
  }
}
