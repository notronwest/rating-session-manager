import "dotenv/config";
import { getSupabase, getOrgId } from "../src/supabase.js";

async function main() {
  const supabase = getSupabase();
  const orgId = await getOrgId();

  const { data: orphans, error } = await supabase
    .from("games")
    .select("id, pbvision_video_id, session_id, played_at, session_name")
    .eq("org_id", orgId)
    .is("session_id", null)
    .order("played_at", { ascending: false });
  if (error) throw error;

  const all = orphans ?? [];
  console.log(`Orphan games (session_id=null): ${all.length}`);

  const byVid = new Map<string, number>();
  for (const g of all) {
    const k = g.pbvision_video_id || "(null vid)";
    byVid.set(k, (byVid.get(k) || 0) + 1);
  }
  const sorted = [...byVid.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Unique pbvision_video_ids among orphans: ${sorted.length}`);
  console.log("Top 10:");
  for (const [v, c] of sorted.slice(0, 10)) console.log(`  ${v}: ${c} game(s)`);

  const { count: total } = await supabase
    .from("games")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  console.log(`\nTotal games in org: ${total}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
