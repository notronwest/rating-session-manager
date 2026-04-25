// Inspect all rh sessions and orphan games on a specific played_date.
// Used to decide how to resolve duplicate sessions before running the
// full backfill.
//
// Usage:
//   npx tsx scripts/ratinghub-inspect-date.ts 2026-02-27

import "dotenv/config";
import { getSupabase, getOrgId } from "../src/supabase.js";

async function main() {
  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("Usage: ratinghub-inspect-date.ts YYYY-MM-DD");
    process.exit(2);
  }
  const supabase = getSupabase();
  const orgId = await getOrgId();

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, played_date, label, player_group_key, created_at")
    .eq("org_id", orgId)
    .eq("played_date", date);

  const { data: games } = await supabase
    .from("games")
    .select("id, session_id, pbvision_video_id, played_at, session_name, team0_score, team1_score, winning_team")
    .eq("org_id", orgId)
    .gte("played_at", `${date}T00:00:00`)
    .lt("played_at", `${date}T23:59:59`);

  const allPlayerIds = new Set<string>();
  for (const s of sessions ?? []) {
    (s.player_group_key ?? "").split(",").forEach((p: string) => {
      const t = p.trim();
      if (t) allPlayerIds.add(t);
    });
  }
  const gameIds = (games ?? []).map((g) => g.id);
  const { data: gamePlayers } = await supabase
    .from("game_players")
    .select("game_id, player_id, player_index, team")
    .eq("org_id", orgId)
    .in("game_id", gameIds.length > 0 ? gameIds : [""]);
  for (const gp of gamePlayers ?? []) allPlayerIds.add(gp.player_id);

  const { data: playerRows } = await supabase
    .from("players")
    .select("id, display_name")
    .in("id", [...allPlayerIds]);
  const nameById = new Map<string, string>();
  for (const p of playerRows ?? []) nameById.set(p.id, p.display_name);
  const nm = (id: string) => nameById.get(id) ?? id.slice(0, 8);

  console.log(`\n=== SESSIONS on ${date} ===\n`);
  for (const s of sessions ?? []) {
    const ids = (s.player_group_key ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
    console.log(`  ${s.id}`);
    console.log(`    label:      ${s.label ?? "—"}`);
    console.log(`    created_at: ${s.created_at}`);
    console.log(`    players:    ${ids.map(nm).join(", ")}`);
    console.log();
  }

  const gpByGame = new Map<string, { player_id: string; team: number; player_index: number }[]>();
  for (const gp of gamePlayers ?? []) {
    const arr = gpByGame.get(gp.game_id) ?? [];
    arr.push({ player_id: gp.player_id, team: gp.team, player_index: gp.player_index });
    gpByGame.set(gp.game_id, arr);
  }

  console.log(`=== GAMES on ${date} ===\n`);
  for (const g of (games ?? []).sort((a, b) => (a.played_at ?? "").localeCompare(b.played_at ?? ""))) {
    const gp = gpByGame.get(g.id) ?? [];
    const team0 = gp.filter((p) => p.team === 0).map((p) => nm(p.player_id)).join(" + ");
    const team1 = gp.filter((p) => p.team === 1).map((p) => nm(p.player_id)).join(" + ");
    console.log(`  ${g.id}`);
    console.log(`    vid:        ${g.pbvision_video_id ?? "—"}`);
    console.log(`    played_at:  ${g.played_at ?? "—"}`);
    console.log(`    session_id: ${g.session_id ?? "(orphan)"}`);
    console.log(`    score:      ${g.team0_score ?? "?"}-${g.team1_score ?? "?"} winner=team${g.winning_team ?? "?"}`);
    console.log(`    team0:      ${team0}`);
    console.log(`    team1:      ${team1}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
