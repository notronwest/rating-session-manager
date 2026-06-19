import { getSupabase } from "../supabase.js";

// Manual player creation — lets a coach add someone who isn't in the
// CourtReserve member list (a sub, a guest, a player who just hasn't synced
// yet) so they get a real rating-hub `players` profile and can be tagged in
// the games they actually played. Mirrors the insert shape used by the
// CourtReserve member sync (src/members/sync.ts), minus cr_member_id.

export interface PlayerRow {
  id: string;
  slug: string;
  display_name: string;
  pbvision_names: string[] | null;
}

export interface FindOrCreateResult {
  player: PlayerRow;
  /** true if a brand-new row was inserted, false if an existing one matched. */
  created: boolean;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Fetch every player row for the org (paginated), same pattern as the
 *  tagging roster resolver in routes/sessions.ts. */
async function fetchOrgPlayers(orgId: string): Promise<PlayerRow[]> {
  const supabase = getSupabase();
  const rows: PlayerRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("players")
      .select("id, slug, display_name, pbvision_names")
      .eq("org_id", orgId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`players fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as PlayerRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * Find an existing org player by (normalized) display name or pbvision alias,
 * or create a new one. Name matching is the same fuzzy rule the tagging flow
 * uses, so "search-or-create" stays consistent with how candidates resolve.
 *
 * @throws if displayName is blank or the insert fails.
 */
export async function findOrCreatePlayer(
  orgId: string,
  displayName: string,
): Promise<FindOrCreateResult> {
  const name = displayName.trim();
  if (!name) throw new Error("displayName is required");

  const players = await fetchOrgPlayers(orgId);

  const target = normalize(name);
  const existing = players.find((p) => {
    if (normalize(p.display_name) === target) return true;
    return (p.pbvision_names || []).some((alt) => normalize(alt) === target);
  });
  if (existing) return { player: existing, created: false };

  // Mint a unique slug against the slugs we just loaded.
  const existingSlugs = new Set(players.map((p) => p.slug));
  const base = slugify(name) || "player";
  let slug = base;
  let n = 2;
  while (existingSlugs.has(slug)) slug = `${base}-${n++}`;

  const { data, error } = await getSupabase()
    .from("players")
    .insert({
      org_id: orgId,
      slug,
      display_name: name,
      cr_member_id: null,
      is_active: true,
    })
    .select("id, slug, display_name, pbvision_names")
    .single();
  if (error) throw new Error(`player insert: ${error.message}`);

  return { player: data as PlayerRow, created: true };
}

/** Look up a single org player by id. Returns null if not found in this org. */
export async function getPlayerById(
  orgId: string,
  playerId: string,
): Promise<PlayerRow | null> {
  const { data, error } = await getSupabase()
    .from("players")
    .select("id, slug, display_name, pbvision_names")
    .eq("org_id", orgId)
    .eq("id", playerId)
    .maybeSingle();
  if (error) throw new Error(`player fetch: ${error.message}`);
  return (data as PlayerRow) ?? null;
}
