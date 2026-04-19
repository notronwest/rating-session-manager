// One-off backfill: match data/members.json (CourtReserve export) to
// Supabase `players` by display name and populate `cr_member_id`.
//
// Usage:
//   tsx scripts/backfill-cr-member-id.ts [--dry-run]
//
// Env required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   # needed to UPDATE players (RLS bypass)
//   ORG_SLUG                    # e.g. "wmpc"

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS_PATH = path.resolve(__dirname, "../data/members.json");

const DRY_RUN = process.argv.includes("--dry-run");

type CRMember = {
  "First Name"?: string;
  "Last Name"?: string;
  "Member #"?: string;
};

type Player = {
  id: string;
  display_name: string;
  cr_member_id: string | null;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const orgSlug = process.env.ORG_SLUG;

  if (!url || !key || !orgSlug) {
    console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ORG_SLUG");
    process.exit(1);
  }

  if (!fs.existsSync(MEMBERS_PATH)) {
    console.error(`No members file at ${MEMBERS_PATH}. Run scripts/scrape-members.py first.`);
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .single();
  if (orgErr || !org) {
    console.error(`Could not find org with slug "${orgSlug}":`, orgErr?.message);
    process.exit(1);
  }

  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, display_name, cr_member_id")
    .eq("org_id", org.id);
  if (pErr || !players) {
    console.error("Failed to fetch players:", pErr?.message);
    process.exit(1);
  }

  const byName = new Map<string, Player>();
  for (const p of players as Player[]) byName.set(normalize(p.display_name), p);

  const crMembers: CRMember[] = JSON.parse(fs.readFileSync(MEMBERS_PATH, "utf-8"));

  const matched: { player: Player; crId: string; name: string }[] = [];
  const unmatchedCR: { name: string; crId: string }[] = [];
  const updates: { id: string; cr_member_id: string }[] = [];

  for (const m of crMembers) {
    const first = (m["First Name"] || "").trim();
    const last = (m["Last Name"] || "").trim();
    const crId = (m["Member #"] || "").trim();
    if (!crId || (!first && !last)) continue;
    const full = `${first} ${last}`.trim();
    const hit = byName.get(normalize(full));
    if (hit) {
      matched.push({ player: hit, crId, name: full });
      if (hit.cr_member_id !== crId) updates.push({ id: hit.id, cr_member_id: crId });
    } else {
      unmatchedCR.push({ name: full, crId });
    }
  }

  const matchedPlayerIds = new Set(matched.map((m) => m.player.id));
  const unmatchedPlayers = (players as Player[]).filter((p) => !matchedPlayerIds.has(p.id));

  console.log(`\nCR members in JSON:          ${crMembers.length}`);
  console.log(`Supabase players in org:     ${players.length}`);
  console.log(`Matched:                     ${matched.length}`);
  console.log(`Updates needed:              ${updates.length}`);
  console.log(`CR members with no player:   ${unmatchedCR.length}`);
  console.log(`Players with no CR match:    ${unmatchedPlayers.length}`);

  if (unmatchedCR.length) {
    console.log("\nCR members not found in Supabase (showing first 20):");
    unmatchedCR.slice(0, 20).forEach((u) => console.log(`  - ${u.name} (#${u.crId})`));
  }
  if (unmatchedPlayers.length) {
    console.log("\nSupabase players not matched from CR (showing first 20):");
    unmatchedPlayers.slice(0, 20).forEach((p) => console.log(`  - ${p.display_name}`));
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: no updates written.");
    return;
  }

  let applied = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("players")
      .update({ cr_member_id: u.cr_member_id })
      .eq("id", u.id);
    if (error) {
      console.error(`Update failed for ${u.id}: ${error.message}`);
    } else {
      applied++;
    }
  }
  console.log(`\nUpdated ${applied} of ${updates.length} players.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
