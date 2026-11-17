// Issue #130 / D-0318 rule 6: times reach the Academy.
// Every fixture here is INVENTED — this repo is public.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  attachTranscript, isMissingSegmentsColumn, segmentsFromSrtFile, reattachPending, loadConfig,
} from "../src/services/lesson-transcribe.js";
import {
  backfillSegments, normaliseText, transcriptFilesForRef,
} from "../src/services/lesson-segments-backfill.js";

// ── A tiny fake of the supabase-js query builder ─────────────────────────────

type Row = Record<string, unknown>;
interface Call { op: "select" | "update"; payload?: Row; filters: [string, string, unknown][] }

function fakeDb(rows: Row[], opts: { missingSegmentsColumn?: boolean } = {}) {
  const calls: Call[] = [];
  const matches = (r: Row, f: [string, string, unknown][]) => f.every(([kind, col, v]) =>
    kind === "eq" ? r[col] === v
      : kind === "is" ? (r[col] ?? null) === v
        : kind === "not-is" ? (r[col] ?? null) !== v
          : true);
  const from = (_table: string) => {
    const call: Call = { op: "select", filters: [] };
    const run = () => {
      calls.push(call);
      if (call.op === "update") {
        if (opts.missingSegmentsColumn && call.payload && "transcript_segments" in call.payload) {
          return { data: null, error: { code: "PGRST204", message: "Could not find the 'transcript_segments' column of 'lessons' in the schema cache" } };
        }
        for (const r of rows) if (matches(r, call.filters)) Object.assign(r, call.payload);
        return { data: null, error: null };
      }
      return { data: rows.filter((r) => matches(r, call.filters)).map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select() { call.op = "select"; return b; },
      update(p: Row) { call.op = "update"; call.payload = p; return b; },
      eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return b; },
      is(c: string, v: unknown) { call.filters.push(["is", c, v]); return b; },
      not(c: string, _op: string, v: unknown) { call.filters.push(["not-is", c, v]); return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  return { db: { from } as any, calls };
}

const SRT = "1\n00:00:01,000 --> 00:00:03,500\nbend your knees\n\n2\n00:00:04,000 --> 00:00:06,000\npaddle up early\n";
const TEXT = "bend your knees\npaddle up early\n";
const SEGS = [
  { startS: 1, endS: 3.5, text: "bend your knees" },
  { startS: 4, endS: 6, text: "paddle up early" },
];

// ── attachTranscript ─────────────────────────────────────────────────────────

test("attachTranscript sends transcript and segments in ONE update", async () => {
  const rows: Row[] = [{ id: "lesson-a", transcript: null, transcript_segments: null }];
  const { db, calls } = fakeDb(rows);
  const r = await attachTranscript("lesson-a", "hello", SEGS, db);
  assert.deepEqual(r, { segments: true });
  const updates = calls.filter((c) => c.op === "update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload!.transcript, "hello");
  assert.deepEqual(updates[0].payload!.transcript_segments, SEGS);
});

test("attachTranscript never sends an empty segment list", async () => {
  const { db, calls } = fakeDb([{ id: "lesson-a" }]);
  await attachTranscript("lesson-a", "hello", [], db);
  const u = calls.filter((c) => c.op === "update");
  assert.equal(u.length, 1);
  assert.ok(!("transcript_segments" in u[0].payload!));
});

test("with the segments column absent, attach still writes the transcript", async () => {
  const rows: Row[] = [{ id: "lesson-a", transcript: null }];
  const { db } = fakeDb(rows, { missingSegmentsColumn: true });
  const r = await attachTranscript("lesson-a", "hello", SEGS, db);
  assert.deepEqual(r, { segments: false });
  assert.equal(rows[0].transcript, "hello");
  assert.ok(!("transcript_segments" in rows[0]));
});

test("isMissingSegmentsColumn is narrow: other errors are not swallowed", () => {
  assert.equal(isMissingSegmentsColumn({ code: "PGRST204", message: "Could not find the 'transcript_segments' column" }), true);
  assert.equal(isMissingSegmentsColumn({ code: "42703", message: 'column "transcript_segments" does not exist' }), true);
  assert.equal(isMissingSegmentsColumn({ code: "PGRST204", message: "Could not find the 'clips' column" }), false);
  assert.equal(isMissingSegmentsColumn({ code: "42501", message: "permission denied for transcript_segments" }), false);
  assert.equal(isMissingSegmentsColumn(null), false);
});

test("attachTranscript rethrows an error that is not a missing column", async () => {
  const db = { from: () => ({ update: () => ({ eq: async () => ({ error: { code: "42501", message: "permission denied" } }) }) }) } as any;
  await assert.rejects(attachTranscript("lesson-a", "hello", SEGS, db), /permission denied/);
});

// ── The late-match retry path ────────────────────────────────────────────────

test("the retry path sends segments parsed from the .srt beside the .txt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seg-retry-"));
  const nas = path.join(tmp, "teaching", "2030-01-02");
  const tx = path.join(tmp, "transcripts", "2030-01-02");
  fs.mkdirSync(nas, { recursive: true });
  fs.mkdirSync(tx, { recursive: true });
  fs.writeFileSync(path.join(nas, "teaching-100000.mp4"), "x");
  fs.writeFileSync(path.join(tx, "teaching-100000.txt"), TEXT);
  fs.writeFileSync(path.join(tx, "teaching-100000.srt"), SRT);
  fs.writeFileSync(path.join(tx, "teaching-100000.json"), JSON.stringify({ result: "transcribed", attached: false }));
  const cfg = loadConfig({
    LESSON_RECORDINGS_DIR: path.join(tmp, "teaching"),
    LESSON_RECORDINGS_LOCAL_DIR: path.join(tmp, "nowhere"),
    LESSON_TRANSCRIPTS_DIR: path.join(tmp, "transcripts"),
  } as NodeJS.ProcessEnv);
  const rows: Row[] = [{ id: "lesson-r", recording_ref: "teaching/2030-01-02/teaching-100000", transcript: null, written_up_at: null, what_we_did: null, homework: null }];
  const { db, calls } = fakeDb(rows);
  const saved = { u: process.env.LESSON_DRAFT_URL, s: process.env.LESSON_DRAFT_SECRET };
  delete process.env.LESSON_DRAFT_URL; delete process.env.LESSON_DRAFT_SECRET;
  try {
    const n = await reattachPending(cfg, () => {}, db);
    assert.equal(n, 1);
  } finally {
    if (saved.u !== undefined) process.env.LESSON_DRAFT_URL = saved.u;
    if (saved.s !== undefined) process.env.LESSON_DRAFT_SECRET = saved.s;
  }
  const u = calls.filter((c) => c.op === "update");
  assert.equal(u.length, 1);
  assert.equal(u[0].payload!.transcript, TEXT);
  assert.deepEqual(u[0].payload!.transcript_segments, SEGS);
});

test("segmentsFromSrtFile: absent or empty file gives null, not []", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seg-srt-"));
  assert.equal(segmentsFromSrtFile(path.join(tmp, "missing.srt")), null);
  fs.writeFileSync(path.join(tmp, "empty.srt"), "");
  assert.equal(segmentsFromSrtFile(path.join(tmp, "empty.srt")), null);
  fs.writeFileSync(path.join(tmp, "ok.srt"), SRT);
  assert.deepEqual(segmentsFromSrtFile(path.join(tmp, "ok.srt")), SEGS);
});

// ── The one-off backfill ─────────────────────────────────────────────────────

function backfillFixture() {
  const rows: Row[] = [
    // matches the file → filled
    { id: "l1", recording_ref: "teaching/2030-01-02/teaching-090000", transcript: "bend your knees paddle up early", transcript_segments: null },
    // stored text differs from the file → skipped
    { id: "l2", recording_ref: "teaching/2030-01-02/teaching-100000", transcript: "something a coach edited", transcript_segments: null },
    // no .srt → no-srt
    { id: "l3", recording_ref: "teaching/2030-01-02/teaching-110000", transcript: TEXT, transcript_segments: null },
    // already has segments → not a candidate
    { id: "l4", recording_ref: "teaching/2030-01-02/teaching-120000", transcript: TEXT, transcript_segments: SEGS },
  ];
  const files: Record<string, string> = {
    "/t/2030-01-02/teaching-090000.txt": TEXT, "/t/2030-01-02/teaching-090000.srt": SRT,
    "/t/2030-01-02/teaching-100000.txt": TEXT, "/t/2030-01-02/teaching-100000.srt": SRT,
    "/t/2030-01-02/teaching-110000.txt": TEXT,
    "/t/2030-01-02/teaching-120000.txt": TEXT, "/t/2030-01-02/teaching-120000.srt": SRT,
  };
  return { rows, files: { read: (f: string) => files[f] ?? null }, dirExists: () => true, transcriptsDir: "/t" };
}

test("backfill fills on match, skips on mismatch, counts no-srt — and never writes transcript", async () => {
  const fx = backfillFixture();
  const before = fx.rows.map((r) => r.transcript);
  const { db, calls } = fakeDb(fx.rows);
  const c = await backfillSegments({ db, ...fx });
  assert.deepEqual(c, { candidates: 3, filled: 1, skippedMismatch: 1, noSrt: 1, noTxt: 0, badRef: 0 });
  assert.deepEqual(fx.rows[0].transcript_segments, SEGS);
  assert.equal(fx.rows[1].transcript_segments, null);
  assert.equal(fx.rows[2].transcript_segments, null);
  for (const u of calls.filter((x) => x.op === "update")) {
    assert.deepEqual(Object.keys(u.payload!), ["transcript_segments"], "the backfill writes segments and nothing else");
    assert.ok(u.filters.some(([k, col, v]) => k === "is" && col === "transcript_segments" && v === null));
  }
  assert.deepEqual(fx.rows.map((r) => r.transcript), before);
});

test("backfill is a no-op on its second run", async () => {
  const fx = backfillFixture();
  const { db } = fakeDb(fx.rows);
  await backfillSegments({ db, ...fx });
  const { db: db2, calls } = fakeDb(fx.rows);
  const c = await backfillSegments({ db: db2, ...fx });
  assert.equal(c.filled, 0);
  assert.equal(calls.filter((x) => x.op === "update").length, 0);
});

test("backfill dry run writes nothing", async () => {
  const fx = backfillFixture();
  const { db, calls } = fakeDb(fx.rows);
  const c = await backfillSegments({ db, ...fx, dryRun: true });
  assert.equal(c.filled, 1);
  assert.equal(calls.filter((x) => x.op === "update").length, 0);
});

test("backfill refuses when the transcripts directory is not mounted", async () => {
  const fx = backfillFixture();
  const { db, calls } = fakeDb(fx.rows);
  await assert.rejects(backfillSegments({ db, ...fx, dirExists: () => false }), /not there/);
  assert.equal(calls.length, 0);
});

test("ref → transcript files, and whitespace-normalised comparison", () => {
  assert.deepEqual(transcriptFilesForRef("/t", "teaching/2030-01-02/teaching-090000"),
    { txt: "/t/2030-01-02/teaching-090000.txt", srt: "/t/2030-01-02/teaching-090000.srt" });
  assert.equal(transcriptFilesForRef("/t", "court4/2030-01-02/x"), null);
  assert.equal(normaliseText(" a\n b  c\n"), "a b c");
});
