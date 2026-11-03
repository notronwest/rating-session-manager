// SP-11 TypeScript half: the occupancy gate, the sampler, segment naming and
// the driver's refusal to guess. The stitching itself is tested against
// synthetic segments in scripts/videos/test_index_continuous.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { planWindows } from "../src/indexer/gate.js";
import { sampleMonth, samplerConfig } from "../src/indexer/sampler.js";
import { segmentStart, segmentsInRange } from "../src/indexer/segments.js";
import { resolveRoi } from "../src/indexer/roi.js";
import { indexCourt, loadStore, type Detector } from "../src/indexer/run.js";
import type { OccupancyAnswer } from "../src/services/lesson-match.js";

const occ = (id: number, s: string, e: string, court: string | null = "Court #4") => ({
  occurrence_id: id, reservation_type: "Open Play", start_at: s, end_at: e,
  court_hint: court, multi_court: false, is_teaching: false, participants: [],
});
const ans = (o: Partial<OccupancyAnswer> = {}): OccupancyAnswer => ({
  status: "one", occurrences: [], refreshed_at: "2026-11-03T20:00:00Z", stale_seconds: 30, ok: true, ...o,
});
const T = (iso: string) => Date.parse(iso) / 1000;
const RANGE: [number, number] = [T("2026-11-03T12:00:00Z"), T("2026-11-04T12:00:00Z")];

test("a stale booking cache skips the whole range instead of guessing", () => {
  const p = planWindows(ans({ stale_seconds: 7200, occurrences: [occ(1, "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z")] }), RANGE, 3600);
  assert.deepEqual(p.windows, []);
  assert.match(p.skipped[0], /stale/);
});

test("a cache that never refreshed skips", () => {
  const p = planWindows(ans({ ok: false, refreshed_at: null }), RANGE, 3600);
  assert.deepEqual(p.windows, []);
});

test("an empty night is zero windows, and that is a confident answer", () => {
  const p = planWindows(ans({ status: "none" }), RANGE, 3600);
  assert.deepEqual(p.windows, []);
  assert.deepEqual(p.skipped, []);
});

test("overlapping bookings merge into one window; an occurrence with no court is skipped", () => {
  const p = planWindows(ans({ status: "ambiguous", occurrences: [
    occ(1, "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z"),
    occ(2, "2026-11-03T14:30:00Z", "2026-11-03T16:00:00Z"),
    occ(3, "2026-11-03T18:00:00Z", "2026-11-03T19:00:00Z", null),
  ] }), RANGE, 3600);
  assert.deepEqual(p.windows, [[T("2026-11-03T14:00:00Z"), T("2026-11-03T16:00:00Z")]]);
  assert.equal(p.skipped.length, 1);
});

test("windows are clipped to the range asked", () => {
  const p = planWindows(ans({ occurrences: [occ(1, "2026-11-03T11:00:00Z", "2026-11-03T13:00:00Z")] }), RANGE, 3600);
  assert.deepEqual(p.windows, [[RANGE[0], T("2026-11-03T13:00:00Z")]]);
});

test("sampler never exceeds the budget and is reproducible from the seed", () => {
  const candidates = Array.from({ length: 40 }, (_, i) => `court4@${i}`);
  const a = sampleMonth({ seed: "s1", month: "2026-11", budget: 5, candidates });
  const b = sampleMonth({ seed: "s1", month: "2026-11", budget: 5, candidates: [...candidates].reverse() });
  assert.equal(a.chosen.length, 5);
  assert.deepEqual([...a.chosen].sort(), [...b.chosen].sort());
  const c = sampleMonth({ seed: "s2", month: "2026-11", budget: 5, candidates });
  assert.notDeepEqual([...a.chosen].sort(), [...c.chosen].sort());
});

test("sampler keeps earlier picks and tops up only to the budget", () => {
  const first = sampleMonth({ seed: "s", month: "2026-11", budget: 3, candidates: ["a", "b", "c", "d"] });
  const more = sampleMonth({ seed: "s", month: "2026-11", budget: 3, candidates: ["a", "b", "c", "d", "e", "f"], alreadyChosen: first.chosen });
  assert.equal(more.chosen.length, 3);
  for (const k of first.chosen) assert.ok(more.chosen.includes(k));
  assert.deepEqual(sampleMonth({ seed: "s", month: "m", budget: 0, candidates: ["a"] }).chosen, []);
});

test("sampler budget and seed are configuration that fails loudly when missing", () => {
  assert.throws(() => samplerConfig({}), /PBV_SAMPLE_BUDGET_MONTHLY/);
  assert.throws(() => samplerConfig({ PBV_SAMPLE_BUDGET_MONTHLY: "10" }), /PBV_SAMPLE_SEED/);
  assert.throws(() => samplerConfig({ PBV_SAMPLE_BUDGET_MONTHLY: "-1", PBV_SAMPLE_SEED: "x" }), /non-negative/);
  assert.deepEqual(samplerConfig({ PBV_SAMPLE_BUDGET_MONTHLY: "12", PBV_SAMPLE_SEED: "x" }), { budget: 12, seed: "x" });
});

test("segment start is club wall-clock, DST-aware, and rejects other courts", () => {
  assert.equal(segmentStart("/r/court4/2026-11-03/court4-090000.ts", "court4"), T("2026-11-03T14:00:00Z"));
  assert.equal(segmentStart("/r/court4/2026-10-03/court4-090000.ts", "court4"), T("2026-10-03T13:00:00Z"));
  assert.equal(segmentStart("/r/court4/2026-11-03/court5-090000.ts", "court4"), null);
  assert.equal(segmentStart("/r/court4/2026-11-03/notes.txt", "court4"), null);
});

test("segmentsInRange keeps overlaps in order", () => {
  const s = segmentsInRange([
    { path: "/r/2026-11-03/court4-100000.ts", duration: 600 },
    { path: "/r/2026-11-03/court4-090000.ts", duration: 600 },
    { path: "/r/2026-11-03/court4-120000.ts", duration: 600 },
  ], "court4", T("2026-11-03T14:05:00Z"), T("2026-11-03T15:05:00Z"));
  assert.deepEqual(s.map((x) => path.basename(x.path)), ["court4-090000.ts", "court4-100000.ts"]);
});

test("one shared ROI dir; the per-repo file is only a flagged fallback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roi-"));
  const legacy = path.join(dir, "legacy.json");
  fs.writeFileSync(legacy, "{}");
  assert.deepEqual(resolveRoi("court4", { WMPC_ROI_DIR: dir }, legacy), { file: legacy, legacy: true });
  fs.writeFileSync(path.join(dir, "court4.json"), "{}");
  assert.deepEqual(resolveRoi("court4", { WMPC_ROI_DIR: dir }, legacy), { file: path.join(dir, "court4.json"), legacy: false });
  assert.throws(() => resolveRoi("../x", { WMPC_ROI_DIR: dir }), /bad camera/);
  assert.throws(() => resolveRoi("court9", { WMPC_ROI_DIR: dir }), /no court polygon/);
});

const base = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
  return { dir, storeFile: path.join(dir, "court4.json"), logs: [] as string[] };
};
const files = [{ path: "/r/2026-11-03/court4-090000.ts", duration: 600 }];
const rng: [number, number] = [T("2026-11-03T14:00:00Z"), T("2026-11-03T14:10:00Z")];

test("driver: a stale or failed occupancy read never reaches the detector", async () => {
  for (const ask of [
    async () => ans({ stale_seconds: 99999 }),
    async () => { throw new Error("HTTP 500"); },
  ]) {
    const b = base();
    let called = false;
    const detect: Detector = async () => { called = true; return { games: [], open_tail_start: null }; };
    const r = await indexCourt({ court: "court4", courtLabel: "Court #4", roiFile: "x", range: rng, files,
      captureEnded: true, maxStaleS: 3600, storeFile: b.storeFile, log: (s) => b.logs.push(s), ask, detect });
    assert.equal(called, false);
    assert.equal(r.added, 0);
    assert.ok(r.skipped.length > 0);
  }
});

test("driver: stores game rows as segment pointers, resumes from the open tail, and never duplicates", async () => {
  const b = base();
  const row = { start: rng[0] + 30, end: rng[0] + 400, source_segment: files[0].path, offset: 30,
    end_segment: files[0].path, end_offset: 400, unfinished: false, start_cut: null, end_cut: null } as const;
  const seen: unknown[] = [];
  const detect: Detector = async (m) => { seen.push(m); return { games: [{ ...row }], open_tail_start: rng[0] + 500 }; };
  const ask = async () => ans({ occurrences: [occ(1, "2026-11-03T14:00:00Z", "2026-11-03T14:10:00Z")] });
  const opts = { court: "court4", courtLabel: "Court #4", roiFile: "x", range: rng, files,
    captureEnded: false, maxStaleS: 3600, storeFile: b.storeFile, log: (s: string) => b.logs.push(s), ask, detect };
  assert.equal((await indexCourt(opts)).added, 1);
  const s1 = loadStore(b.storeFile);
  assert.equal(s1.games[0].source_segment, files[0].path);
  assert.equal(s1.openTailStart, rng[0] + 500);
  await indexCourt(opts);
  assert.equal(loadStore(b.storeFile).games.length, 1);
  // second run resumed from the carried tail, not the range start
  assert.equal((seen[1] as { segments: unknown[] }).segments.length, 1);
});
