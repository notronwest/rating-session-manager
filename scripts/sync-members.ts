// Sync CourtReserve members into the Supabase `players` table.
//
// Flow:
//   1. Run scripts/scrape-members.py, which exports the CR Members Report
//      to Excel, parses it, and emits a JSON array to stdout.
//   2. Compare against Supabase `players` for the org (matched by
//      cr_member_id, then case-insensitive display_name).
//   3. For unmatched CR members, INSERT a new player row.
//      Existing players are left alone — this is insert-only for now.
//
// Usage:
//   tsx scripts/sync-members.ts               # runs the scrape headless
//   tsx scripts/sync-members.ts --headed      # keeps the browser visible
//   tsx scripts/sync-members.ts --dry-run     # shows what would be inserted
//
// Env required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ORG_SLUG
//   Plus CR_EMAIL / CR_PASSWORD / CR_BASE_URL for the underlying scrape.

import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER = path.resolve(__dirname, "scrape-members.py");
const ROOT = path.resolve(__dirname, "..");

const HEADED = process.argv.includes("--headed");
const DRY_RUN = process.argv.includes("--dry-run");

type CRMember = {
  "First Name"?: string;
  "Last Name"?: string;
  "Member #"?: string;
};

type Player = {
  id: string;
  slug: string;
  display_name: string;
  cr_member_id: string | null;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function runScrape(): Promise<CRMember[]> {
  return new Promise((resolve, reject) => {
    const args = [SCRAPER];
    if (HEADED) args.push("--headed");
    const proc = spawn("python3", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });

    let stdout = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`scrape-members.py exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse scraper output as JSON: ${(e as Error).message}`));
      }
    });
  });
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const orgSlug = process.env.ORG_SLUG;
  if (!url || !key || !orgSlug) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ORG_SLUG");
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .single();
  if (orgErr || !org) {
    console.error(`Could not find org "${orgSlug}":`, orgErr?.message);
    process.exit(1);
  }
  const orgId: string = org.id;

  console.error("Running CR members scrape...");
  const crMembers = await runScrape();
  console.error(`Scraped ${crMembers.length} members from CourtReserve`);

  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, slug, display_name, cr_member_id")
    .eq("org_id", orgId);
  if (pErr || !players) {
    console.error("Failed to fetch players:", pErr?.message);
    process.exit(1);
  }

  const byCrId = new Map<string, Player>();
  const byName = new Map<string, Player>();
  const existingSlugs = new Set<string>();
  for (const p of players as Player[]) {
    if (p.cr_member_id) byCrId.set(p.cr_member_id, p);
    byName.set(normalize(p.display_name), p);
    existingSlugs.add(p.slug);
  }

  const toInsert: { org_id: string; slug: string; display_name: string; cr_member_id: string }[] = [];
  let skippedExisting = 0;
  const mintedSlugs = new Set<string>();

  for (const m of crMembers) {
    const first = (m["First Name"] || "").trim();
    const last = (m["Last Name"] || "").trim();
    const crId = (m["Member #"] || "").trim();
    const fullName = `${first} ${last}`.trim();
    if (!crId || !fullName) continue;

    if (byCrId.has(crId) || byName.has(normalize(fullName))) {
      skippedExisting++;
      continue;
    }

    const base = slugify(fullName) || `player-${crId}`;
    let slug = base;
    let n = 2;
    while (existingSlugs.has(slug) || mintedSlugs.has(slug)) {
      slug = `${base}-${n++}`;
    }
    mintedSlugs.add(slug);
    toInsert.push({ org_id: orgId, slug, display_name: fullName, cr_member_id: crId });
  }

  console.error(`Existing players in org:     ${players.length}`);
  console.error(`CR members to skip:          ${skippedExisting}`);
  console.error(`New players to insert:       ${toInsert.length}`);

  if (!toInsert.length) {
    console.error("Nothing to insert. Done.");
    return;
  }

  console.error("\nFirst few to insert:");
  toInsert.slice(0, 10).forEach((p) => console.error(`  + ${p.display_name} (#${p.cr_member_id}) → ${p.slug}`));
  if (toInsert.length > 10) console.error(`  ... and ${toInsert.length - 10} more`);

  if (DRY_RUN) {
    console.error("\n--dry-run: no inserts performed.");
    return;
  }

  const { error: insErr } = await supabase.from("players").insert(toInsert);
  if (insErr) {
    console.error(`Insert failed: ${insErr.message}`);
    process.exit(1);
  }
  console.error(`\nInserted ${toInsert.length} new players.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
