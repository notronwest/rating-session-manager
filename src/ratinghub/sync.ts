// One idempotent "sync with rating-hub" action.
//
// Looks at the session's current state (pb.vision video IDs, player names)
// and does whatever's missing on the rating-hub side:
//
//   1. Resolves every session.player_names entry to a Supabase players row
//      (by display_name or pbvision_names); fails early with the list of
//      unmatched names.
//   2. Upserts the rating-hub sessions row with our UUID as the PK.
//   3. For each pb.vision video ID:
//      - If rating-hub has games for it: updates game.session_id to match
//        this session (no-op if already linked).
//      - If no games exist yet: fires the rating-hub webhook so the insights
//        import kicks off.
//
// Safe to re-run repeatedly as pb.vision finishes processing.

import { getSupabase, getOrgId } from "../supabase.js";
import { notifyRatingHub, WebhookError } from "../pbvision/webhook.js";
import { updateSession } from "../db/index.js";
import type { Session } from "../types.js";

export type PerVideoResult = {
  vid: string;
  games: number;
  gamesLinkedBefore: number;
  gamesLinkedAfter: number;
  webhookFired: boolean;
  webhookStatus?: string;
  webhookError?: string;
};

export type SyncRatingHubResult = {
  sessionId: string;
  playedDate: string;
  playerUuids: string[];
  label: string | null;
  sessionWasUpserted: boolean;
  perVideo: PerVideoResult[];
  totalGamesLinked: number;
  ratingHubUrl: string | null;
};

export class SyncRatingHubError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function syncRatingHub(
  session: Session,
  onLog: (msg: string) => void = () => {},
): Promise<SyncRatingHubResult> {
  if (!session.player_names || session.player_names.length === 0) {
    throw new SyncRatingHubError("no_players", "Session has no players — can't build a player group key");
  }
  if (!session.pbvision_video_ids || session.pbvision_video_ids.length === 0) {
    throw new SyncRatingHubError("no_videos", "Session has no pb.vision video IDs attached yet");
  }

  const supabase = getSupabase();
  const orgId = await getOrgId();

  // --- 1. Resolve Supabase player UUIDs from display names.
  const normNames = session.player_names.map(normalize);

  type PlayerRow = { id: string; display_name: string; pbvision_names: string[] | null };

  // Supabase enforces a server-side max_rows cap (default 1000). Paginate with .range() to fetch the full roster.
  const players: PlayerRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("players")
      .select("id, display_name, pbvision_names")
      .eq("org_id", orgId)
      .range(from, from + PAGE - 1);
    if (error) {
      throw new SyncRatingHubError("players_fetch_failed", error.message);
    }
    if (!data || data.length === 0) break;
    players.push(...(data as PlayerRow[]));
    if (data.length < PAGE) break;
  }
  const playerByName = new Map<string, PlayerRow>();
  for (const p of players as PlayerRow[]) {
    playerByName.set(normalize(p.display_name), p);
    for (const alt of p.pbvision_names || []) {
      playerByName.set(normalize(alt), p);
    }
  }

  const matchedUuids: string[] = [];
  const unmatched: string[] = [];
  for (let i = 0; i < normNames.length; i++) {
    const hit = playerByName.get(normNames[i]);
    if (hit) matchedUuids.push(hit.id);
    else unmatched.push(session.player_names[i]);
  }
  if (unmatched.length > 0) {
    throw new SyncRatingHubError(
      "unmatched_players",
      `Couldn't find Supabase players for: ${unmatched.join(", ")}. Run Members → Sync now to refresh the roster.`,
    );
  }

  const playerGroupKey = [...matchedUuids].sort().join(",");
  const playedDate = session.booking_time
    ? session.booking_time.slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // --- 2. Upsert the rating-hub sessions row. Prefer an existing row keyed by
  //       (org, date, group) so we don't create duplicates.
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
  if (upsertErr) throw new SyncRatingHubError("session_upsert_failed", upsertErr.message);
  onLog(
    existingByKey
      ? `Re-used existing rating-hub session ${rhSessionId}`
      : `Created rating-hub session ${rhSessionId}`,
  );

  // --- 3. Per-video: check for games in rating-hub, then either link or
  //       fire the webhook.
  const vids = session.pbvision_video_ids.filter(Boolean) as string[];
  const { data: existingGames, error: gErr } = await supabase
    .from("games")
    .select("id, pbvision_video_id, session_id")
    .eq("org_id", orgId)
    .in("pbvision_video_id", vids);
  if (gErr) throw new SyncRatingHubError("games_fetch_failed", gErr.message);

  const gamesByVid = new Map<string, { id: string; session_id: string | null }[]>();
  for (const g of (existingGames || []) as { id: string; pbvision_video_id: string; session_id: string | null }[]) {
    const arr = gamesByVid.get(g.pbvision_video_id) || [];
    arr.push({ id: g.id, session_id: g.session_id });
    gamesByVid.set(g.pbvision_video_id, arr);
  }

  const perVideo: PerVideoResult[] = [];
  let totalGamesLinked = 0;

  for (const vid of vids) {
    const games = gamesByVid.get(vid) || [];
    const linkedBefore = games.filter((g) => g.session_id === rhSessionId).length;

    const res: PerVideoResult = {
      vid,
      games: games.length,
      gamesLinkedBefore: linkedBefore,
      gamesLinkedAfter: linkedBefore,
      webhookFired: false,
    };

    // Always fire the webhook so tagged-name updates (and any other pb.vision
    // changes) get pulled back into rating-hub. The webhook upserts games by
    // (org_id, pbvision_video_id, session_index) and replaces game_players,
    // so re-firing is idempotent.
    try {
      const whRes = await notifyRatingHub({ sessionId: rhSessionId, videoId: vid, onLog });
      res.webhookFired = true;
      res.webhookStatus = whRes.status;
      onLog(`  ${vid}: webhook fired, status=${whRes.status ?? "ok"}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof WebhookError ? ` (HTTP ${err.status ?? "?"})` : "";
      res.webhookFired = true;
      res.webhookError = `${msg}${code}`;
      onLog(`  ${vid}: webhook failed — ${msg}`);
    }

    // Re-query games for this video (webhook may have just imported or
    // refreshed them) and link any that aren't pointing at this session.
    const { data: freshGames } = await supabase
      .from("games")
      .select("id, session_id")
      .eq("org_id", orgId)
      .eq("pbvision_video_id", vid);
    const fresh = (freshGames || []) as { id: string; session_id: string | null }[];
    if (fresh.length > 0) {
      const toLink = fresh.filter((g) => g.session_id !== rhSessionId).map((g) => g.id);
      if (toLink.length > 0) {
        const { error: updErr } = await supabase
          .from("games")
          .update({ session_id: rhSessionId })
          .in("id", toLink);
        if (updErr) {
          res.webhookError = `${res.webhookError ? res.webhookError + "; " : ""}game link failed: ${updErr.message}`;
        } else {
          onLog(`  ${vid}: linked ${toLink.length} game(s) to session`);
        }
      }
      res.games = fresh.length;
      res.gamesLinkedAfter = fresh.length;
      totalGamesLinked += fresh.length;
    }

    perVideo.push(res);
  }

  // --- 4. Reflect status on our local session row.
  // Once every clip has games linked on rating-hub, the session is done.
  // Don't downgrade a `complete` session here (idempotent re-runs are fine).
  const allGamesLinked = vids.length > 0 && perVideo.every((r) => r.gamesLinkedAfter > 0);
  if (allGamesLinked && session.status !== "complete") {
    await updateSession(session.id, { status: "complete" });
    onLog(`Marked session ${session.id} complete (all ${vids.length} clip(s) linked)`);
  }

  return {
    sessionId: rhSessionId,
    playedDate,
    playerUuids: matchedUuids,
    label: session.label || null,
    sessionWasUpserted: !existingByKey,
    perVideo,
    totalGamesLinked,
    ratingHubUrl: process.env.RATING_HUB_BASE_URL
      ? `${process.env.RATING_HUB_BASE_URL.replace(/\/$/, "")}/sessions/${rhSessionId}`
      : null,
  };
}
