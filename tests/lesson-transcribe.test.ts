// LP-08 (rsm#74). Covers the decisions that are easy to get wrong silently:
// what counts as a finished recording, what counts as a lesson, and whether
// the VAD flags that fix the prototype's hallucination bug are actually passed.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  parseRecordingPath, recordingRef, eligibility, decodeArgs, loadConfig,
  liveTempExists, transcriptPaths, isDone, SILENCE_FLOOR_DB,
  discover, chapterLead,
} from "../src/services/lesson-transcribe.js";

const cfg = loadConfig({} as NodeJS.ProcessEnv);

test("parseRecordingPath accepts a real recording", () => {
  assert.deepEqual(parseRecordingPath("2026-09-30/teaching-090731.mp4"),
    { date: "2026-09-30", base: "teaching-090731" });
  assert.deepEqual(parseRecordingPath("2026-09-27/teaching-101117-clinic-am-recovered.mp4"),
    { date: "2026-09-27", base: "teaching-101117-clinic-am-recovered" });
});

test("parseRecordingPath rejects in-progress writes", () => {
  // camd's live temp while a lesson is recording.
  assert.equal(parseRecordingPath("2026-10-12/.teaching-081645.recording.mp4"), null);
  // recordings-sync's half-copied file. Reading this as finished would
  // transcribe a truncated lesson and mark it done forever.
  assert.equal(parseRecordingPath("2026-10-12/.teaching-081645.mp4.uploading"), null);
});

test("parseRecordingPath rejects anything that is not <date>/<name>.mp4", () => {
  assert.equal(parseRecordingPath("teaching-090731.mp4"), null);
  assert.equal(parseRecordingPath("2026-09-30/notes.txt"), null);
  assert.equal(parseRecordingPath("court4/2026-09-30/x.mp4"), null);
  assert.equal(parseRecordingPath("not-a-date/x.mp4"), null);
});

test("recordingRef is the ref LP-07 writes to lessons.recording_ref", () => {
  assert.equal(recordingRef("2026-09-30", "teaching-090731"), "teaching/2026-09-30/teaching-090731");
});

test("eligibility holds a file that is still settling", () => {
  const r = eligibility({ ageS: 60, durationS: 4500, settleS: 300, minDurationS: 600, alreadyDone: false });
  assert.equal(r.skip, true);
});

test("eligibility rejects a camera test, accepts a lesson", () => {
  // The 12 short files on the NAS are tests, not lessons.
  const test20s = eligibility({ ageS: 9999, durationS: 20, settleS: 300, minDurationS: 600, alreadyDone: false });
  assert.equal(test20s.skip, true);
  assert.match((test20s as { reason: string }).reason, /camera test/);

  // 2026-09-30 was 75 minutes.
  const lesson = eligibility({ ageS: 9999, durationS: 75 * 60, settleS: 300, minDurationS: 600, alreadyDone: false });
  assert.equal(lesson.skip, false);
});

test("eligibility skips a file whose duration will not read", () => {
  const r = eligibility({ ageS: 9999, durationS: null, settleS: 300, minDurationS: 600, alreadyDone: false });
  assert.equal(r.skip, true);
});

test("decodeArgs always passes VAD and zero context — the prototype's bug", () => {
  const a = decodeArgs(cfg, "/tmp/x.wav", "/tmp/x");
  assert.ok(a.includes("--vad"), "VAD must be on: whisper loops on silence without it");
  assert.ok(a.includes("-vm"), "a VAD model path must be passed");
  assert.equal(a[a.indexOf("-vm") + 1], cfg.vadModelPath);
  // max-context 0 stops the decoder feeding its own output back as the prompt,
  // which is what turns one bad segment into a loop to the end of the file.
  assert.equal(a[a.indexOf("-mc") + 1], "0");
});

test("the silence floor is below any real room and above digital silence", () => {
  // A mic'd lesson sits around -30 to -20 dBFS; a dead mic reads -91 or -inf.
  assert.ok(SILENCE_FLOOR_DB < -50 && SILENCE_FLOOR_DB > -90);
});

test("liveTempExists finds an in-progress recording in either tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-"));
  fs.mkdirSync(path.join(root, "2026-10-12"), { recursive: true });
  assert.equal(liveTempExists([root]), null);
  const temp = path.join(root, "2026-10-12", ".teaching-081645.recording.mp4");
  fs.writeFileSync(temp, "x");
  assert.equal(liveTempExists([root]), temp);
  fs.rmSync(root, { recursive: true, force: true });
});

test("isDone keys on the meta file, so a silent recording is not retried forever", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lt-"));
  const c = { ...cfg, transcriptsDir: root };
  const rec = { ref: "teaching/2026-09-27/x", date: "2026-09-27", base: "x", file: "/dev/null" };
  assert.equal(isDone(c, rec), false);
  const p = transcriptPaths(c, rec);
  fs.mkdirSync(p.dir, { recursive: true });
  // A silent recording writes meta and NO transcript. Keying on .txt would
  // re-extract gigabytes from the same dead file on every single tick.
  fs.writeFileSync(p.meta, JSON.stringify({ result: "silent" }));
  assert.equal(isDone(c, rec), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("defaults point at the NAS, not the local tree that sync empties", () => {
  assert.equal(cfg.nasDir, "/Volumes/wmpc-video/teaching");
  assert.equal(cfg.maxPerRun, 1);
});

// ── Hand-copied camera files (rsm#128) ───────────────────────────────────────

test("parseRecordingPath accepts the extension in any case", () => {
  assert.deepEqual(parseRecordingPath("2026-11-04/GX010024.MP4"), { date: "2026-11-04", base: "GX010024" });
  assert.deepEqual(parseRecordingPath("2026-11-04/GX010024.Mp4"), { date: "2026-11-04", base: "GX010024" });
  assert.deepEqual(parseRecordingPath("2026-11-04/GX010024.mp4"), { date: "2026-11-04", base: "GX010024" });
  assert.equal(parseRecordingPath("2026-11-04/notes.txt"), null);
  assert.equal(parseRecordingPath("2026-11-04/.hidden.mp4"), null);
});

function tmpCfg(files: Record<string, string[]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsm128-"));
  for (const [date, names] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, date), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(root, date, n), "x");
  }
  return {
    root,
    cfg: { ...cfg, nasDir: root, localDir: path.join(root, "no-such-local"), transcriptsDir: path.join(root, "transcripts") },
  };
}

test("discover logs a name it cannot parse, and stays silent on dotted temps", () => {
  const { cfg: c } = tmpCfg({ "2026-11-04": ["GX010024.MP4", "weird name.mov", ".teaching-1.recording.mp4", ".x.mp4.uploading"] });
  const lines: string[] = [];
  const recs = discover(c, (l) => lines.push(l));
  assert.deepEqual(recs.map((r) => r.base), ["GX010024"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /weird name\.mov/);
  assert.match(lines[0], /not a recording name I recognise/);
});

test("discover does not scold files outside date directories", () => {
  const { cfg: c } = tmpCfg({ "transcripts-old": ["a.txt"] });
  const lines: string[] = [];
  discover(c, (l) => lines.push(l));
  assert.deepEqual(lines, []);
});

test("a GoPro chapter with its GX01 sibling is a continuation, not a camera test", () => {
  const { cfg: c } = tmpCfg({ "2026-11-04": ["GX010025.MP4", "GX020025.MP4", "GX010026.MP4"] });
  const recs = discover(c);
  const tail = recs.find((r) => r.base === "GX020025")!;
  assert.equal(tail.chapterOf, "teaching/2026-11-04/GX010025");
  assert.equal(recs.find((r) => r.base === "GX010025")!.chapterOf, undefined);
  // 63 s tail: dismissed on its own, accepted as a chapter.
  const base = { ageS: 9999, durationS: 63, settleS: 300, minDurationS: 600, alreadyDone: false };
  assert.equal(eligibility(base).skip, true);
  assert.deepEqual(eligibility({ ...base, chapter: !!tail.chapterOf }), { skip: false });
});

test("a chapter without its GX01 sibling is judged on its own", () => {
  assert.equal(chapterLead("GX020025", ["GX020025.MP4"]), null);
  assert.equal(chapterLead("GX020025", ["GX010099.MP4"]), null);
  assert.equal(chapterLead("GX010025", ["GX010025.MP4"]), null);
  assert.equal(chapterLead("GX020025", ["gx010025.mp4"]), "gx010025");
});

test("isDone keys on <base>.json, so the hand-recovered 11-04 transcripts are not redone", () => {
  const { cfg: c } = tmpCfg({ "2026-11-04": ["GX010024.MP4"] });
  const rec = discover(c)[0];
  assert.equal(isDone(c, rec), false);
  const p = transcriptPaths(c, rec);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.meta, "{}");
  assert.equal(path.basename(p.meta), "GX010024.json");
  assert.equal(isDone(c, rec), true);
});
