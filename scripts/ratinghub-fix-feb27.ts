// One-off: repair the 2026-02-27 session in rating-hub.
//
// Context: four orphan games on Feb 27 (played with Mike O'Connor,
// Robin Palfrey, Dan Lapp, and Ron West) had their 4th slot tagged on
// pb.vision with placeholder identities — two games with "Player 4",
// two with "Player 2". rating-hub imported each placeholder as a distinct
// player, and its `(played_date, player_group_key)` unique key split the
// session into two duplicate rows.
//
// The fix:
//   1. For the 4 Feb 27 game_players rows pointing at a Player N
//      placeholder, repoint them at Ron West's UUID.
//   2. Keep the earliest-created duplicate session; delete the other.
//   3. Rewrite the survivor's player_group_key to the real 4 UUIDs.
//
// Dry-run by default — pass --apply to execute.
//
// Usage:
//   npx tsx scripts/ratinghub-fix-feb27.ts             # print plan
//   npx tsx scripts/ratinghub-fix-feb27.ts --apply     # execute

import "dotenv/config";
import { getSupabase, getOrgId } from "../src/supabase.js";

const DATE = "2026-02-27";
const REAL_NAMES = ["Mike O'Connor", "Robin Palfrey", "Dan Lapp", "Ron West"];
const PLACEHOLDER_NAMES = ["Player 2", "Player 4"];

async function main() {
  const apply = process.argv.includes("--apply");
  const supabase = getSupabase();
  const orgId = await getOrgId();

  // Resolve player UUIDs by display_name.
  const wanted = [...REAL_NAMES, ...PLACEHOLDER_NAMES];
  const { data: playerRows, error: pErr } = await supabase
    .from("players")
    .select("id, display_name")
    .eq("org_id", orgId)
    .in("display_name", wanted);
  if (pErr) throw new Error(`players fetch failed: ${pErr.message}`);
  const byName = new Map<string, string>();
  for (const p of playerRows ?? []) byName.set(p.display_name, p.id);

  const missing = wanted.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    console.error(`Could not resolve display_name(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  const ronId = byName.get("Ron West")!;
  const placeholderIds = PLACEHOLDER_NAMES.map((n) => byName.get(n)!);
  const realIds = REAL_NAMES.map((n) => byName.get(n)!);

  console.error(`Ron West UUID:         ${ronId}`);
  console.error(`Placeholders to swap:  ${PLACEHOLDER_NAMES.map((n, i) => `${n}=${placeholderIds[i]}`).join(", ")}`);

  // Fetch the 4 Feb 27 orphan games.
  const { data: games, error: gErr } = await supabase
    .from("games")
    .select("id, pbvision_video_id, played_at, session_id")
    .eq("org_id", orgId)
    .gte("played_at", `${DATE}T00:00:00`)
    .lt("played_at", `${DATE}T23:59:59`);
  if (gErr) throw new Error(`games fetch failed: ${gErr.message}`);
  if (!games || games.length === 0) {
    console.error(`No games found on ${DATE}.`);
    return;
  }
  const gameIds = games.map((g) => g.id);
  console.error(`\nGames on ${DATE}: ${games.length} (${gameIds.join(", ")})`);

  // Count which placeholder rows exist in game_players for those games.
  const { data: gp, error: gpErr } = await supabase
    .from("game_players")
    .select("id, game_id, player_id, player_index, team")
    .eq("org_id", orgId)
    .in("game_id", gameIds)
    .in("player_id", placeholderIds);
  if (gpErr) throw new Error(`game_players fetch failed: ${gpErr.message}`);
  const rowsToSwap = gp ?? [];
  console.error(`\nPlaceholder game_players to repoint at Ron: ${rowsToSwap.length}`);
  for (const r of rowsToSwap) {
    const currentName = r.player_id === placeholderIds[0] ? PLACEHOLDER_NAMES[0] : PLACEHOLDER_NAMES[1];
    console.error(`  game=${r.game_id.slice(0, 8)} team=${r.team} idx=${r.player_index} ${currentName} → Ron West`);
  }

  // Fetch the duplicate sessions on Feb 27.
  const { data: sessions, error: sErr } = await supabase
    .from("sessions")
    .select("id, label, player_group_key, created_at")
    .eq("org_id", orgId)
    .eq("played_date", DATE)
    .order("created_at", { ascending: true });
  if (sErr) throw new Error(`sessions fetch failed: ${sErr.message}`);
  if (!sessions || sessions.length === 0) {
    console.error(`No rh sessions on ${DATE}.`);
    return;
  }
  console.error(`\nRH sessions on ${DATE}: ${sessions.length}`);
  for (const s of sessions) console.error(`  ${s.id} "${s.label ?? ""}" created_at=${s.created_at}`);

  const [survivor, ...duplicates] = sessions;
  const newGroupKey = [...realIds].sort().join(",");
  console.error(`\nPlan:`);
  console.error(`  Keep session:   ${survivor.id} (earliest created_at)`);
  console.error(`  Delete:         ${duplicates.map((d) => d.id).join(", ") || "(none)"}`);
  console.error(`  New group_key:  ${newGroupKey}`);
  console.error(`  Relink ${games.length} game(s) → session ${survivor.id}`);

  if (!apply) {
    console.error("\n[dry-run] pass --apply to execute");
    return;
  }

  // Step 1: repoint placeholder game_players at Ron.
  if (rowsToSwap.length > 0) {
    const ids = rowsToSwap.map((r) => r.id);
    const { error } = await supabase
      .from("game_players")
      .update({ player_id: ronId })
      .in("id", ids);
    if (error) throw new Error(`game_players update failed: ${error.message}`);
    console.error(`\n✓ Repointed ${ids.length} game_players row(s) → Ron`);
  }

  // Step 2: delete the duplicate sessions (games first to release FKs, though
  // games point at *survivor* going forward, not the duplicates).
  for (const dup of duplicates) {
    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", dup.id);
    if (error) throw new Error(`delete session ${dup.id} failed: ${error.message}`);
    console.error(`✓ Deleted duplicate session ${dup.id}`);
  }

  // Step 3: rewrite the survivor's player_group_key to the real 4 UUIDs.
  {
    const { error } = await supabase
      .from("sessions")
      .update({ player_group_key: newGroupKey })
      .eq("id", survivor.id);
    if (error) throw new Error(`update survivor session failed: ${error.message}`);
    console.error(`✓ Rewrote survivor player_group_key`);
  }

  // Step 4: relink all 4 games to the survivor session.
  {
    const { error } = await supabase
      .from("games")
      .update({ session_id: survivor.id })
      .in("id", gameIds);
    if (error) throw new Error(`relink games failed: ${error.message}`);
    console.error(`✓ Linked ${gameIds.length} game(s) → ${survivor.id}`);
  }

  console.error(
    `\nDone. Next: npm run ratinghub:backfill -- --dry-run  (verify), then without --dry-run.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
