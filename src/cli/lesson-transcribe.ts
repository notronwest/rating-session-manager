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
  findLessonForRecording, type Recording,
} from "../services/lesson-transcribe.js";
import { sendDiscordAlert } from "../services/discord-alert.js";
import {
  recordingWindow, askOccupancy, classify, playersForMembers,
  findLessonByReservation, linkRecording, type Match,
} from "../services/lesson-match.js";

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

/** Days of staleness we will accept from the booking cache before refusing to
 *  judge. The refresh runs every 2 minutes, so anything past half an hour means
 *  it is broken again and we should not be classifying recordings on it. */
const MAX_CACHE_STALE_S = Number(process.env.LESSON_MAX_CACHE_STALE_S || 1800);

/** Ask the occupancy service which teaching booking, if any, this recording
 *  covers. Every failure becomes `unknown` rather than an exception: a
 *  courtreserve outage must not reach the exit-75 path (that is reserved for
 *  "cannot prove camd is idle" and withholds the heartbeat) nor the crash
 *  handler, which would post "transcription crashed" to Discord for an
 *  unrelated service being down. */
async function resolveMatch(rec: Recording, durationS: number): Promise<Match> {
  try {
    const win = recordingWindow(rec.date, rec.base, durationS);
    if (!win) return { kind: "unknown", reason: "could not read a start time from the filename" };
    const ans = await askOccupancy(win.start, win.end);
    const m = classify(ans, MAX_CACHE_STALE_S);
    if (m.kind !== "lesson") return m;
    const ids = m.occurrence.participants.map((p) => p.org_member_id).filter((n) => Number.isFinite(n));
    const { found, missing } = await playersForMembers(ids);
    return { ...m, playerIds: found, unmatched: missing };
  } catch (err) {
    return { kind: "unknown", reason: (err as Error).message };
  }
}

/** Record a terminal verdict for a recording we will not transcribe, so the
 *  job stops re-resolving it every ten minutes and `--status` can show why. */
function writeVerdict(rec: Recording, match: Match) {
  const p = transcriptPaths(cfg, rec);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.meta, JSON.stringify({
    ref: rec.ref,
    result: match.kind === "ambiguous" ? "ambiguous" : "not-a-lesson",
    reason: match.kind === "ambiguous" ? match.reason : "no teaching booking covers this recording",
    candidates: match.kind === "ambiguous"
      ? match.occurrences.map((o) => ({ occurrence_id: o.occurrence_id, type: o.reservation_type, start: o.start_at }))
      : undefined,
    at: new Date().toISOString(),
  }, null, 2));
}

/** Attach the finished transcript to the lesson for this booking, if one
 *  exists. It does NOT create one — both repo seats vetoed that; creation
 *  belongs to the job that materialises bookings. When no lesson exists yet
 *  the resolved booking and students are recorded on the transcript, so the
 *  work is not lost and whoever creates the lesson inherits the answer. */
async function recordMatch(rec: Recording, match: Match) {
  if (match.kind !== "lesson") return;
  const p = transcriptPaths(cfg, rec);
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(fs.readFileSync(p.meta, "utf8")); } catch { /* fresh */ }
  const occ = match.occurrence;
  const resolved = {
    occurrence_id: occ.occurrence_id,
    reservation_type: occ.reservation_type,
    booked: { start: occ.start_at, end: occ.end_at },
    participants: occ.participants,
    player_ids: match.playerIds,
    unmatched_member_ids: match.unmatched,
  };
  let note = "no lesson exists for this booking yet — resolved and waiting";
  try {
    const lesson = await findLessonByReservation(String(occ.occurrence_id));
    if (lesson) {
      if (!lesson.recording_ref) await linkRecording(lesson.id, rec.ref, String(occ.occurrence_id));
      note = `linked to the lesson already created for this booking (${lesson.id})`;
    }
  } catch (err) {
    note = `resolved, but linking failed and will retry: ${(err as Error).message}`;
  }
  fs.writeFileSync(p.meta, JSON.stringify({ ...meta, resolved, matchNote: note }, null, 2));
  log(`${rec.ref}: ${occ.reservation_type} — ${occ.participants.map((x) => x.name ?? "?").join(", ")}; ${note}`);
}

/**
 * Connect transcripts that were produced BEFORE their lesson existed.
 *
 * The matcher links a recording to its lesson at the moment it transcribes it.
 * Everything transcribed before the lessons were created from bookings
 * therefore has nothing to link to, and `reattachPending` cannot help: it
 * looks a lesson up by `recording_ref`, and a booking-created lesson has none
 * until something sets it. That left 14 transcripts and ~55,000 words
 * unconnected on 2026-10-15.
 *
 * This is the catch-up, and it is the same two steps the live path takes —
 * resolve the booking, then link — so there is one implementation of each
 * (D-0049), not a parallel backfill that could drift from it.
 */
async function relink(apply: boolean) {
  let seen = 0, linked = 0, already = 0, unresolved = 0, partial = 0;

  // FIRST resolve everything, THEN link — because the dangerous case is only
  // visible across recordings. The teaching camera writes 15-minute segments,
  // so a 90-minute lesson is six files, and `lessons.recording_ref` holds ONE.
  // Linking them one at a time would leave the lesson pointing at whichever
  // segment happened to be last and carrying a single 15-minute transcript —
  // a lesson that looks complete and is one sixth of itself. That is worse
  // than leaving it unlinked, so a booking with more than one recording is
  // refused as a group until a lesson can hold several (one lesson, many
  // recordings, still unbuilt).
  const resolved: { rec: Recording; match: Match & { kind: "lesson" } }[] = [];
  for (const rec of discover(cfg)) {
    const p = transcriptPaths(cfg, rec);
    if (!fs.existsSync(p.meta) || !fs.existsSync(p.txt)) continue;
    let meta: { result?: string } = {};
    try { meta = JSON.parse(fs.readFileSync(p.meta, "utf8")); } catch { continue; }
    if (meta.result !== "transcribed") continue;
    seen++;

    const lesson = await findLessonForRecording(rec.ref).catch(() => null);
    if (lesson) { already++; continue; }

    const durationS = await probeDurationS(cfg, rec.file);
    const match = await resolveMatch(rec, durationS ?? 0);
    if (match.kind !== "lesson") {
      log(`${rec.ref}: cannot link — ${match.kind === "ambiguous" || match.kind === "unknown" ? match.reason : "no teaching booking covers it"}`);
      unresolved++;
      continue;
    }
    resolved.push({ rec, match });
  }

  const byBooking = new Map<number, typeof resolved>();
  for (const r of resolved) {
    const k = r.match.occurrence.occurrence_id;
    byBooking.set(k, [...(byBooking.get(k) ?? []), r]);
  }

  for (const group of byBooking.values()) {
    const who = group[0].match.occurrence.participants.map((x) => x.name ?? "?").join(", ");
    if (group.length > 1) {
      log(`${group[0].match.occurrence.reservation_type} (${who}): REFUSED — ${group.length} recordings cover this one lesson and a lesson can hold only one. Linking any single segment would show ${Math.round(100 / group.length)}% of the lesson as if it were all of it.`);
      partial += group.length;
      continue;
    }
    const { rec, match } = group[0];
    if (!apply) { log(`${rec.ref}: WOULD link to ${match.occurrence.reservation_type} — ${who}`); linked++; continue; }
    await recordMatch(rec, match);
    linked++;
  }
  if (apply) await reattachPending(cfg, log);
  log("");
  log(`transcripts examined: ${seen}`);
  log(`${apply ? "linked" : "would link"}:          ${linked}`);
  log(`already connected:    ${already}`);
  log(`could not resolve:    ${unresolved}`);
  log(`refused (lesson split across several recordings): ${partial}`);
  if (!apply) log("\nnothing was written — re-run with --relink --apply");
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

    // ── Which lesson was this? ────────────────────────────────────────────
    // Resolved BEFORE transcribing, because the cheapest transcription is the
    // one we do not do: 9 of the first 12 files processed were open play, which
    // cost an hour of CPU each and recorded conversation from members who were
    // not in a lesson and never agreed to it.
    const match = await resolveMatch(rec, durationS ?? 0);
    if (match.kind === "unknown") {
      // NOT "no lesson" — we could not get a trustworthy answer. Leave it for
      // the next tick rather than writing a terminal verdict on bad data.
      log(`${rec.ref}: holding off — ${match.reason}`);
      continue;
    }
    if (match.kind === "not-teaching" || match.kind === "ambiguous") {
      writeVerdict(rec, match);
      log(`${rec.ref}: not transcribing — ${match.kind === "ambiguous" ? match.reason : "no teaching booking covers it"}`);
      continue;
    }

    if (dryRun) {
      const who = match.occurrence.participants.map((p) => p.name ?? "?").join(", ");
      log(`${rec.ref}: WOULD transcribe (${Math.round((durationS ?? 0) / 60)} min) — ${match.occurrence.reservation_type}: ${who}`);
      done++; continue;
    }

    const outcome = await transcribeOne(cfg, rec, log);
    done++;
    if (outcome.kind === "transcribed") await recordMatch(rec, match);
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
  if (args.has("--relink")) { await relink(args.has("--apply")); return; }
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
