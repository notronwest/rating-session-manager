// Upsert a rating-hub `sessions` row from a session-manager session, and
// backfill games.session_id for any already-imported games that match the
// session's pb.vision video IDs.
//
// Both projects share the same Supabase project, so we can write directly
// to rating-hub's tables using the session-manager's service-role client.

import { getSupabase, getOrgId } from "../supabase.js";
import type { Session } from "../types.js";

export type CreateRatingHubSessionResult = {
  sessionId: string;
  playedDate: string;
  playerUuids: string[];
  unmatchedPlayerNames: string[];
  gamesLinked: number;
  gamesDiagnostic: {
    videoIdsChecked: string[];
    gamesFound: { id: string; pbvision_video_id: string; session_id: string | null }[];
  };
};

export class RatingHubError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function createOrUpdateRatingHubSession(
  session: Session,
): Promise<CreateRatingHubSessionResult> {
  if (!session.player_names || session.player_names.length === 0) {
    throw new RatingHubError("no_players", "Session has no players — can't build a player group key");
  }

  const supabase = getSupabase();
  const orgId = await getOrgId();

  // 1. Look up Supabase player UUIDs for the session's player_names.
  const normNames = session.player_names.map(normalize);
  const { data: players, error: pErr } = await supabase
    .from("players")
    .select("id, display_name, pbvision_names")
    .eq("org_id", orgId);
  if (pErr || !players) {
    throw new RatingHubError("players_fetch_failed", pErr?.message || "Failed to fetch players");
  }

  type PlayerRow = { id: string; display_name: string; pbvision_names: string[] | null };
  const playerByName = new Map<string, PlayerRow>();
  for (const p of players as PlayerRow[]) {
    playerByName.set(normalize(p.display_name), p);
    for (const alt of p.pbvision_names || []) {
      playerByName.set(normalize(alt), p);
    }
  }

  const matchedUuids: string[] = [];
  const unmatchedPlayerNames: string[] = [];
  for (let i = 0; i < normNames.length; i++) {
    const hit = playerByName.get(normNames[i]);
    if (hit) matchedUuids.push(hit.id);
    else unmatchedPlayerNames.push(session.player_names[i]);
  }

  if (unmatchedPlayerNames.length > 0) {
    throw new RatingHubError(
      "unmatched_players",
      `Couldn't find Supabase players for: ${unmatchedPlayerNames.join(", ")}. ` +
        `Sync members (Members → Sync now) or update the session's player names.`,
    );
  }

  // 2. Build player_group_key (sorted UUIDs joined by comma).
  const playerGroupKey = [...matchedUuids].sort().join(",");

  // 3. Derive played_date from booking_time (fallback: today in UTC).
  const playedDate = session.booking_time
    ? session.booking_time.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // 4. Upsert rating-hub session using our session id as the PK.
  //    rating-hub has UNIQUE (org_id, played_date, player_group_key), so if
  //    a session already exists for this date+group, we keep that row.
  const { data: existingByKey } = await supabase
    .from("sessions")
    .select("id")
    .eq("org_id", orgId)
    .eq("played_date", playedDate)
    .eq("player_group_key", playerGroupKey)
    .maybeSingle();

  const rhSessionId: string = (existingByKey?.id as string) ?? session.id;

  const { error: upsertErr } = await supabase.from("sessions").upsert(
    {
      id: rhSessionId,
      org_id: orgId,
      played_date: playedDate,
      player_group_key: playerGroupKey,
      label: session.label || null,
    },
    { onConflict: "id" },
  );
  if (upsertErr) throw new RatingHubError("session_upsert_failed", upsertErr.message);

  // 5. Backfill games.session_id for any games that match our pb.vision IDs
  //    (they may have been imported before we created this session).
  const vids = (session.pbvision_video_ids || []).filter(Boolean) as string[];
  let gamesLinked = 0;
  let gamesFound: { id: string; pbvision_video_id: string; session_id: string | null }[] = [];
  if (vids.length > 0) {
    // Pre-check so we can tell the user what was in the DB before we touched
    // it. `games_linked = 0` ambiguity: is it "no games exist for these
    // video IDs" (webhook hasn't imported them) or "games exist but already
    // linked"? This diagnostic answers that.
    const { data: preGames, error: preErr } = await supabase
      .from("games")
      .select("id, pbvision_video_id, session_id")
      .eq("org_id", orgId)
      .in("pbvision_video_id", vids);
    if (preErr) throw new RatingHubError("games_fetch_failed", preErr.message);
    gamesFound = (preGames as typeof gamesFound) ?? [];

    const { data: updatedGames, error: gamesErr } = await supabase
      .from("games")
      .update({ session_id: rhSessionId })
      .eq("org_id", orgId)
      .in("pbvision_video_id", vids)
      .select("id");
    if (gamesErr) throw new RatingHubError("games_update_failed", gamesErr.message);
    gamesLinked = updatedGames?.length ?? 0;
  }

  return {
    sessionId: rhSessionId,
    playedDate,
    playerUuids: matchedUuids,
    unmatchedPlayerNames,
    gamesLinked,
    gamesDiagnostic: {
      videoIdsChecked: vids,
      gamesFound,
    },
  };
}
