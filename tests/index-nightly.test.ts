// daemon#241: the nightly driver and indexed_through.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runNightly, parseCourts } from "../src/indexer/nightly.js";
import { loadStore, saveStore } from "../src/indexer/run.js";
import type { OccupancyAnswer } from "../src/services/lesson-match.js";

const NOW = Date.parse("2026-11-04T04:30:00Z") / 1000;
const ans = (o: Partial<OccupancyAnswer> = {}): OccupancyAnswer => ({
  status: "none", occurrences: [], refreshed_at: "2026-11-04T04:00:00Z", stale_seconds: 30, ok: true, ...o,
});
const occ = {
  occurrence_id: 1, reservation_type: "Open Play", start_at: "2026-11-03T20:00:00Z", end_at: "2026-11-03T21:00:00Z",
  court_hint: "Court #4", multi_court: false, is_teaching: false, participants: [],
};

function rig(withDir = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-"));
  const dir = path.join(tmp, "court4");
  if (withDir) fs.mkdirSync(dir);
  const storeFile = path.join(tmp, "stores", "court4.json");
  const base = {
    courts: [{ court: "court4", label: "Court #4", dir }], now: NOW, roiFor: () => "x",
    durationOf: async () => 600, storeFor: () => storeFile, log: () => {},
    indexOpts: { maxStaleS: 3600 },
  };
  return { dir, storeFile, base };
}

test("no footage at all is a clean run: the store is written, empty, with indexed_through", async () => {
  const r = rig();
  const out = await runNightly({ ...r.base, indexOpts: { maxStaleS: 3600, ask: async () => ans() } });
  assert.equal(out[0].status, "done");
  const s = loadStore(r.storeFile);
  assert.deepEqual(s.games, []);
  assert.deepEqual(s.sampled, []);
  assert.equal(s.indexed_through, Math.floor(NOW));
});

test("windows but an empty footage directory is also clean (recorder off)", async () => {
  const r = rig();
  const out = await runNightly({ ...r.base, indexOpts: { maxStaleS: 3600, ask: async () => ans({ status: "one", occurrences: [occ] }) } });
  assert.equal(out[0].status, "done");
  assert.equal(loadStore(r.storeFile).indexed_through, Math.floor(NOW));
});

test("a failed run leaves indexed_through where it was", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "court4-20261103T200000Z.ts"), "");
  saveStore(r.storeFile, { games: [], openTailStart: null, sampled: [], indexed_through: 1000 });
  const out = await runNightly({ ...r.base, indexOpts: {
    maxStaleS: 3600, ask: async () => ans({ status: "one", occurrences: [occ] }),
    detect: async () => { throw new Error("detector crashed"); },
  } });
  assert.equal(out[0].status, "failed");
  assert.equal(loadStore(r.storeFile).indexed_through, 1000);
});

test("a junk file or an unprobeable segment is skipped, not a failed court; out-of-range files are not probed", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, ".DS_Store"), "x");
  fs.writeFileSync(path.join(r.dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(r.dir, "court4-20261103T200000Z.ts"), "");
  fs.writeFileSync(path.join(r.dir, "court4-20261103T210000Z.ts"), "");
  fs.writeFileSync(path.join(r.dir, "court4-20200101T000000Z.ts"), "");
  const probed: string[] = [];
  const out = await runNightly({ ...r.base,
    durationOf: async (f) => { probed.push(path.basename(f)); if (f.includes("210000")) throw new Error("ffprobe exit 1"); return 600; },
    indexOpts: { maxStaleS: 3600, ask: async () => ans() } });
  assert.equal(out[0].status, "done");
  assert.deepEqual(probed.sort(), ["court4-20261103T200000Z.ts", "court4-20261103T210000Z.ts"]);
  assert.equal(loadStore(r.storeFile).indexed_through, Math.floor(NOW));
});

test("a missing footage directory is unreachable and does not advance indexed_through", async () => {
  const r = rig(false);
  saveStore(r.storeFile, { games: [], openTailStart: null, sampled: [], indexed_through: 1000 });
  const out = await runNightly({ ...r.base, indexOpts: { maxStaleS: 3600, ask: async () => ans() } });
  assert.equal(out[0].status, "unreachable");
  assert.equal(loadStore(r.storeFile).indexed_through, 1000);
});

test("an unreadable occupancy cache holds the range and does not advance", async () => {
  const r = rig();
  const out = await runNightly({ ...r.base, indexOpts: { maxStaleS: 3600, ask: async () => ans({ stale_seconds: 99999 }) } });
  assert.equal(out[0].status, "held");
  assert.equal(fs.existsSync(r.storeFile), false);
});

test("the next run starts where the last one finished", async () => {
  const r = rig();
  saveStore(r.storeFile, { games: [], openTailStart: null, sampled: [], indexed_through: NOW - 3600 });
  let asked: [number, number] | null = null;
  await runNightly({ ...r.base, indexOpts: { maxStaleS: 3600, ask: async (s, e) => { asked = [s.getTime() / 1000, e.getTime() / 1000]; return ans(); } } });
  assert.deepEqual(asked, [NOW - 3600, Math.floor(NOW)]);
});

test("a store written before the field existed still loads", () => {
  const r = rig();
  fs.mkdirSync(path.dirname(r.storeFile), { recursive: true });
  fs.writeFileSync(r.storeFile, JSON.stringify({ games: [], openTailStart: null, sampled: ["a"] }));
  assert.equal(loadStore(r.storeFile).indexed_through, null);
});

test("courts parse from INDEX_COURTS with a default of Court 4", () => {
  assert.equal(parseCourts({}).length, 1);
  const c = parseCourts({ INDEX_COURTS: "court2|Court #2|/x/y;court4" } as NodeJS.ProcessEnv);
  assert.deepEqual(c.map((x) => [x.court, x.label, x.dir]), [["court2", "Court #2", "/x/y"], ["court4", "court4", "/opt/wmpc/recordings/court4"]]);
});
