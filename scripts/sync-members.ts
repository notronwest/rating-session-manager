// Thin CLI wrapper around src/members/sync.ts. The shared logic is
// re-used by POST /api/members/sync so the UI button runs the same path.
//
// Usage:
//   npm run sync:members                      # headless
//   npm run sync:members -- --headed          # keep the browser visible
//   npm run sync:members -- --dry-run         # preview without inserting

import "dotenv/config";
import { syncMembers, SyncError } from "../src/members/sync.js";

async function main() {
  const headed = process.argv.includes("--headed");
  const dryRun = process.argv.includes("--dry-run");

  try {
    const result = await syncMembers({
      headed,
      dryRun,
      onLog: (line) => console.error(line),
    });

    console.error(`\nScraped:        ${result.scraped}`);
    console.error(`Existing skipped: ${result.skipped}`);
    console.error(`New to insert:  ${result.inserted.length}`);

    if (result.inserted.length) {
      console.error("\nFirst few to insert:");
      result.inserted.slice(0, 10).forEach((p) =>
        console.error(`  + ${p.display_name} (#${p.cr_member_id}) → ${p.slug}`),
      );
      if (result.inserted.length > 10) {
        console.error(`  ... and ${result.inserted.length - 10} more`);
      }
    }

    if (dryRun) {
      console.error("\n--dry-run: no inserts performed.");
    } else if (result.inserted.length) {
      console.error(`\nInserted ${result.inserted.length} new players.`);
    }
  } catch (e) {
    if (e instanceof SyncError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error(e);
    }
    process.exit(1);
  }
}

main();
