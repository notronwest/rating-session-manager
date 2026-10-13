#!/usr/bin/env node
// LP-08 entry point (rsm#74). One tick: find a finished lesson recording that
// has not been transcribed, transcribe it locally, attach the text to its
// lesson. Run by scripts/lesson-transcribe.sh under launchd.
//
//   lesson-transcribe              one tick (what launchd runs)
//   lesson-transcribe --dry-run    say what it WOULD do; reads nothing large
//   lesson-transcribe --status     what is on disk and what is pending
//   lesson-transcribe --self-test  config + binaries + models; no network, no CR
//
// The host gate and the lock live in the shell wrapper, deliberately: they must
// hold before Node starts, so a non-capture machine pays nothing and two ticks
// cannot overlap during the ~1s of module loading.

import fs from "fs";
import path from "path";
import {
  loadConfig, discover, eligibility, isDone, transcribeOne, reattachPending,
  camdState, liveTempExists, probeDurationS, transcriptPaths,
} from "../services/lesson-transcribe.js";
import { sendDiscordAlert } from "../services/discord-alert.js";

const cfg = loadConfig();
const args = new Set(process.argv.slice(2));

function log(line: string) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/** Consecutive ticks camd has been unreachable. Fail-closed must not fail silent. */
const UNREACHABLE_FILE = path.join(cfg.stateDir, "camd-unreachable-ticks");
const UNREACHABLE_ALERT_AT = 6; // 6 ticks x 10 min = one hour

function bumpUnreachable(): number {
  let n = 0;
  try { n = Number(fs.readFileSync(UNREACHABLE_FILE, "utf8").trim()) || 0; } catch { /* first time */ }
  n += 1;
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(UNREACHABLE_FILE, String(n));
  return n;
}
function clearUnreachable() {
  try { fs.unlinkSync(UNREACHABLE_FILE); } catch { /* nothing to clear */ }
}

async function selfTest(): Promise<number> {
  let bad = 0;
  const check = (ok: boolean, what: string, fix: string) => {
    log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` — ${fix}`}`);
    if (!ok) bad++;
  };
  check(fs.existsSync(cfg.whisperBin), `whisper-cli at ${cfg.whisperBin}`, "brew install whisper-cpp");
  check(fs.existsSync(cfg.ffmpegBin), `ffmpeg at ${cfg.ffmpegBin}`, "brew install ffmpeg");
  check(fs.existsSync(cfg.ffprobeBin), `ffprobe at ${cfg.ffprobeBin}`, "brew install ffmpeg");
  check(fs.existsSync(cfg.modelPath), `whisper model at ${cfg.modelPath}`, "run scripts/install-lesson-transcribe.sh");
  // The VAD model is NOT optional. Without it whisper loops on silence, which is
  // the prototype's known bug; shipping without it would re-introduce it.
  check(fs.existsSync(cfg.vadModelPath), `VAD model at ${cfg.vadModelPath}`, "run scripts/install-lesson-transcribe.sh");
  check(fs.existsSync(cfg.nasDir), `recordings tree at ${cfg.nasDir}`, "mount the wmpc-video share in Finder as the owner");
  check(!!process.env.SUPABASE_URL, "SUPABASE_URL", "set it in .env");
  check(!!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY), "SUPABASE_SERVICE_ROLE_KEY", "set it in .env");
  const draftConfigured = !!(process.env.LESSON_DRAFT_URL && process.env.LESSON_DRAFT_SECRET);
  log(`${draftConfigured ? "ok  " : "note"} AI draft ${draftConfigured ? "configured" : "NOT configured — transcripts attach, the coach's form stays blank"}`);
  return bad;
}

async function status(): Promise<void> {
  const recs = discover(cfg);
  log(`${recs.length} recording(s) in ${cfg.nasDir}`);
  for (const rec of recs) {
    const p = transcriptPaths(cfg, rec);
    if (!fs.existsSync(p.meta)) { log(`  ${rec.ref}: not transcribed`); continue; }
    try {
      const m = JSON.parse(fs.readFileSync(p.meta, "utf8"));
      log(`  ${rec.ref}: ${m.result}${m.words ? ` ${m.words}w` : ""}${m.result === "transcribed" ? (m.attached ? " attached" : " PENDING attach") : ""}`);
    } catch { log(`  ${rec.ref}: meta unreadable`); }
  }
}

async function tick(dryRun: boolean): Promise<number> {
  // Guard 1: bytes. A live dotted temp beats any status field — camd has
  // reported itself recording while writing nothing, and healthy while looping.
  const temp = liveTempExists([cfg.localDir, cfg.nasDir]);
  if (temp) { log(`skipped: a recording is in progress (${temp})`); return 0; }

  // Guard 2: camd's own status, fail-closed on unreachable.
  const state = await camdState(cfg);
  if (state === "recording") { log("skipped: camd is recording a lesson"); return 0; }
  if (state === "unreachable") {
    const n = bumpUnreachable();
    log(`skipped: camd status unreachable at ${cfg.camdStatusUrl} (${n} consecutive)`);
    if (n === UNREACHABLE_ALERT_AT) {
      await sendDiscordAlert({
        title: "Lesson transcription is stalled",
        level: "warning",
        message: `camd's status endpoint has been unreachable for ${n} ticks (about an hour), so transcription is holding off rather than risk competing with a lesson. Nothing is being lost — recordings keep accumulating and will transcribe once this clears.`,
        fields: [{ name: "Endpoint", value: cfg.camdStatusUrl }, { name: "Check", value: "is camd-teaching loaded on the mini?" }],
      });
    }
    // Exit 75 = "held off, did not run". The wrapper reads this and withholds
    // the heartbeat, so a job that is permanently blocked goes SILENT and the
    // fleet watchdog alarms — rather than beating cheerfully while doing
    // nothing, which is the failure D-0052 exists to catch.
    process.exitCode = 75;
    return 0;
  }
  clearUnreachable();

  // Attach anything that finished while no lesson referenced it. Cheap, and it
  // is how LP-07 landing completes this feature with no rework.
  await reattachPending(cfg, log);

  let done = 0;
  for (const rec of discover(cfg)) {
    if (done >= cfg.maxPerRun) break;
    if (isDone(cfg, rec)) continue;

    let ageS = Infinity;
    try { ageS = (Date.now() - fs.statSync(rec.file).mtimeMs) / 1000; } catch { continue; }
    const durationS = await probeDurationS(cfg, rec.file);
    const e = eligibility({ ageS, durationS, settleS: cfg.settleS, minDurationS: cfg.minDurationS, alreadyDone: false });
    if (e.skip) { log(`${rec.ref}: ${e.reason}`); continue; }

    if (dryRun) { log(`${rec.ref}: WOULD transcribe (${Math.round((durationS ?? 0) / 60)} min)`); done++; continue; }

    const outcome = await transcribeOne(cfg, rec, log);
    done++;
    if (outcome.kind === "failed") {
      await sendDiscordAlert({
        title: "Lesson transcription failed",
        level: "error",
        message: `Could not transcribe ${rec.ref}. The recording is untouched; the job will try again next tick.`,
        fields: [{ name: "Error", value: outcome.error.slice(0, 1000) }],
        dedupeKey: `lesson-transcribe:${rec.ref}`,
      });
    } else if (outcome.kind === "silent") {
      log(`${rec.ref}: no audio — recorded as silent, not transcribed`);
    }
  }
  if (done === 0) log("nothing to do");
  return done;
}

async function main() {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  if (args.has("--self-test")) { process.exit((await selfTest()) === 0 ? 0 : 1); }
  if (args.has("--status")) { await status(); return; }
  await tick(args.has("--dry-run"));
}

main().catch(async (err) => {
  log(`FATAL ${(err as Error).message}`);
  await sendDiscordAlert({
    title: "Lesson transcription crashed",
    level: "error",
    message: (err as Error).stack?.slice(0, 1500) ?? String(err),
  });
  process.exit(1);
});
