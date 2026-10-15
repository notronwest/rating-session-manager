#!/usr/bin/env node
// Create lesson records from Court Reserve bookings (D-0183).
//
//   lesson-sync --from 2025-01-01 --to 2026-12-31        dry run, prints what it WOULD do
//   lesson-sync --from … --to … --apply                  writes
//
// Dry run is the DEFAULT and --apply is explicit, because this writes rows
// about real students across eighteen months of history and the first run
// should be read before it is trusted.
import { syncLessons } from "../services/lesson-sync.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("usage: lesson-sync --from YYYY-MM-DD --to YYYY-MM-DD [--apply]");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");
  const log = (s: string) => console.log(s);
  log(`${apply ? "APPLYING" : "dry run"} ${from} .. ${to}`);
  const r = await syncLessons({
    start: new Date(`${from}T00:00:00Z`),
    end: new Date(`${to}T23:59:59Z`),
    apply, log,
  });
  log("");
  log(`bookings seen:      ${r.seen}`);
  log(`lessons created:    ${r.created}`);
  log(`lessons updated:    ${r.updated}`);
  log(`unchanged/skipped:  ${r.skipped}`);
  log(`coach with no account: ${r.unresolvedCoach}  (name recorded, link absent)`);
  log(`students not in TSA:   ${r.unmatchedPlayers}  (booked but no player row)`);
  if (!apply) log("\nnothing was written — re-run with --apply");
}

main().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(1); });
