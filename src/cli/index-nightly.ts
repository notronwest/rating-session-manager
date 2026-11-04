#!/usr/bin/env node
// Nightly game index over each court's new footage (daemon#241). Exit 0 only
// when every court finished; 1 otherwise, so the wrapper can ping Ron.
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { resolveRoi } from "../indexer/roi.js";
import { parseCourts, runNightly } from "../indexer/nightly.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
  const bin = process.env.LESSON_FFPROBE_BIN || "/opt/homebrew/bin/ffprobe";
  const results = await runNightly({
    courts: parseCourts(process.env),
    now: Date.now() / 1000,
    roiFor: (court) => resolveRoi(court, process.env, path.resolve(here, "../../scripts/videos/roi.json")).file,
    durationOf: async (f) => {
      const { stdout } = await run(bin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]);
      return Number(stdout.trim());
    },
    indexOpts: { maxStaleS: Number(process.env.OCCUPANCY_MAX_STALE_S || 3600) },
    log,
  });
  for (const r of results) log(r.status === "done" ? `${r.court}: done, ${r.added} game(s)` : `${r.court}: ${r.status} — ${r.why}`);
  process.exit(results.every((r) => r.status === "done") ? 0 : 1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
