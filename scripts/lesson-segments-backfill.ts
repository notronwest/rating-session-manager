// One-off backfill of lessons.transcript_segments from the `.srt` beside each
// transcript on club storage. Issue #130, D-0318 rule 6. Run on the club
// computer (the NAS is mounted there). Prints counts only — this repo is public.
//
// Usage:
//   npm run transcribe:backfill-segments -- --dry-run
//   npm run transcribe:backfill-segments
//
// Safe to run twice: the second run finds nothing to fill. The logic and its
// guarantees live in src/services/lesson-segments-backfill.ts.

import "dotenv/config";
import { getSupabase } from "../src/supabase.js";
import { loadConfig } from "../src/services/lesson-transcribe.js";
import { backfillSegments } from "../src/services/lesson-segments-backfill.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = loadConfig();
  const c = await backfillSegments({ db: getSupabase(), transcriptsDir: cfg.transcriptsDir, dryRun });
  console.log(`${dryRun ? "DRY RUN — nothing written. " : ""}candidates ${c.candidates}; ` +
    `${dryRun ? "would fill" : "filled"} ${c.filled}; skipped-mismatch ${c.skippedMismatch}; ` +
    `no-srt ${c.noSrt}; no-txt ${c.noTxt}; unrecognised-ref ${c.badRef}`);
}

main().catch((err) => {
  console.error(`segments backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
