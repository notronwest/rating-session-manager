#!/usr/bin/env node
// Index games from a court's continuous recordings (SP-11).
//
//   index-court --court court4 --label "Court #4" --dir /opt/wmpc/recordings/court4 \
//               --from 2026-11-03T08:00:00-05:00 --to 2026-11-03T12:00:00-05:00 [--capture-ended]
//   index-court --court court4 --sample 2026-11       choose the month's uploads
//
// Reads the cached occupancy; never opens a Court Reserve session.
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { resolveRoi } from "../indexer/roi.js";
import { indexCourt, loadStore, saveStore, storePath, gameKey } from "../indexer/run.js";
import { sampleMonth, samplerConfig } from "../indexer/sampler.js";
import { segmentStart } from "../indexer/segments.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

async function duration(file: string): Promise<number> {
  const bin = process.env.LESSON_FFPROBE_BIN || "/opt/homebrew/bin/ffprobe";
  const { stdout } = await run(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

async function main() {
  const court = arg("court");
  if (!court) { console.error("usage: index-court --court <name> (--from … --to … --dir … | --sample YYYY-MM)"); process.exit(2); }
  const log = (s: string) => console.log(s);
  const file = storePath(court);

  const month = arg("sample");
  if (month) {
    const { budget, seed } = samplerConfig();
    const store = loadStore(file);
    const [y, m] = month.split("-").map(Number);
    const inMonth = store.games.filter((g) => {
      const d = new Date(g.start * 1000);
      return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m;
    });
    const r = sampleMonth({ seed, month, budget, candidates: inMonth.map(gameKey),
      alreadyChosen: store.sampled.filter((k) => inMonth.some((g) => gameKey(g) === k)) });
    store.sampled = [...new Set([...store.sampled, ...r.chosen])];
    saveStore(file, store);
    log(`${month}: ${r.chosen.length}/${inMonth.length} sampled (budget ${budget}, seed ${seed})`);
    return;
  }

  const dir = arg("dir"), from = arg("from"), to = arg("to");
  if (!dir || !from || !to) { console.error("--dir, --from and --to are required"); process.exit(2); }
  const range: [number, number] = [Date.parse(from) / 1000, Date.parse(to) / 1000];
  const camera = arg("camera") || court;
  const roi = resolveRoi(camera, process.env, path.resolve(here, "../../scripts/videos/roi.json"));
  if (roi.legacy) log(`warning: using the per-repo roi.json — move it to the shared ROI dir (${camera}.json)`);

  const files: { path: string; duration: number }[] = [];
  for (const f of walk(dir)) {
    const s = segmentStart(f, court);
    if (s === null || s > range[1]) continue;
    const d = await duration(f);
    if (Number.isFinite(d)) files.push({ path: f, duration: d });
  }
  await indexCourt({
    court, courtLabel: arg("label") || court, roiFile: roi.file, range, files,
    captureEnded: process.argv.includes("--capture-ended"),
    maxStaleS: Number(process.env.OCCUPANCY_MAX_STALE_S || 3600),
    storeFile: file, log,
  });
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
