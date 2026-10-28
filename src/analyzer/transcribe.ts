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
  type AnalyzerAsk,
  type AnalyzerDocument,
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

/** One job. The caller owns every path in here; the analyzer owns none of them. */
export interface AnalyzerInput {
  /** The video to read. A link the caller can read — on disk today, a URL later. */
  file: string;
  /** Scratch for the 16 kHz wav. Created if absent; the wav is deleted after. */
  scratchDir: string;
  /** Where whisper writes `<outBase>.txt` / `.srt`. The caller's tree, not ours. */
  outBase: string;
  asks?: AnalyzerAsk[];
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
 * The job. Extract audio, refuse silence, transcribe, return ONE document.
 *
 * It never throws for an analysis failure — a failed decode is a document with
 * `result: "failed"`, because the caller's retry policy is the caller's business
 * (here: the meta file is not written, so the next tick tries again).
 */
export async function transcribeAudio(
  cfg: AnalyzerConfig,
  input: AnalyzerInput,
  log: (line: string) => void = () => {},
): Promise<AnalyzerDocument> {
  const asks = input.asks ?? ["transcript"];
  const started = Date.now();
  fs.mkdirSync(input.scratchDir, { recursive: true });
  const wav = path.join(input.scratchDir, `${path.basename(input.outBase)}.wav`);
  const doc = (over: Partial<AnalyzerDocument>): AnalyzerDocument => ({
    schema_version: ANALYZER_SCHEMA_VERSION,
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
    const durationS = await probeDurationS(cfg, input.file);

    // Audio extraction. This is the slow step — 44 minutes for a 2.2 GB file in
    // the 2026-10-07 prototype, because the mini reaches the NAS over Wi-Fi at
    // ~9 Mbps while its gigabit NIC sits below Wi-Fi in the service order (an
    // open item on Ron's ledger, D-0069). It is not this job's bug to fix, but
    // it IS why the timeout is generous.
    log(`extracting audio from ${input.file}`);
    const ext = await run(cfg.ffmpegBin,
      ["-v", "error", "-y", "-i", input.file, "-vn", "-ac", "1", "-ar", "16000", wav],
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
    const txt = `${input.outBase}.txt`;
    const w = await run(cfg.whisperBin, decodeArgs(cfg, wav, input.outBase),
      { timeoutMs: 6 * 60 * 60 * 1000 });
    if (w.code !== 0 || !fs.existsSync(txt)) {
      return doc({
        source: { durationS, meanVolumeDb: meanForDoc },
        error: `whisper exited ${w.code}: ${w.stderr.slice(-300)}`,
      });
    }

    const text = fs.readFileSync(txt, "utf8");
    return doc({
      result: "transcribed",
      source: { durationS, meanVolumeDb: meanForDoc },
      transcript: { text, words: text.split(/\s+/).filter(Boolean).length },
    });
  } finally {
    try { fs.unlinkSync(wav); } catch { /* scratch only */ }
  }
}
