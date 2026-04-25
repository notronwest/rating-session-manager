// Backfill session-manager's local sessions table from rating-hub, then
// re-fire the sync for each so game.session_id gets linked correctly.
//
// Three phases:
//
//   1. Orphan rescue — match rating-hub games with session_id=NULL to an
//      existing rh session by (played_date, ≥3/4 player overlap with
//      session.player_group_key). Ambiguous matches (multiple candidates)
//      and no-match orphans are reported and left alone.
//   2. SQLite backfill — for every rh session that has at least one linked
//      pb.vision video ID, create a session-manager row (if missing) using
//      the rh session's UUID as the PK so game.session_id round-trips.
//   3. Re-sync — run syncRatingHub() per backfilled session so rating-hub
//      sees the correct (sessionId, videoId) pairing and finishes linking
//      any remaining games on its side.
//
// Usage:
//   npm run ratinghub:backfill                 # all 3 phases
//   npm run ratinghub:backfill -- --dry-run    # print the plan, no writes
//   npm run ratinghub:backfill -- --skip-sync  # skip phase 3

import "dotenv/config";
import { getSupabase, getOrgId } from "../src/supabase.js";
import { getDb } from "../src/db/index.js";
import { syncRatingHub, SyncRatingHubError } from "../src/ratinghub/sync.js";
import type { Session } from "../src/types.js";

type RhSession = {
  id: string;
  played_date: string | null;
  label: string | null;
  player_group_key: string | null;
};
type RhGame = {
  id: string;
  pbvision_video_id: string | null;
  session_id: string | null;
  played_at: string | null;
};
type PlayerRow = { id: string; display_name: string };
type GamePlayer = { game_id: string; player_id: string };

const OVERLAP_THRESHOLD = 3;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skipSync = process.argv.includes("--skip-sync");

  const supabase = getSupabase();
  const orgId = await getOrgId();

  // 1. Pull all rating-hub sessions for the org.
  const { data: rhSessions, error: sErr } = await supabase
    .from("sessions")
    .select("id, played_date, label, player_group_key")
    .eq("org_id", orgId)
    .order("played_date", { ascending: false });
  if (sErr) throw new Error(`sessions fetch failed: ${sErr.message}`);
  if (!rhSessions || rhSessions.length === 0) {
    console.error("No rating-hub sessions found for this org.");
    return;
  }
  console.error(`Found ${rhSessions.length} rating-hub session(s).`);

  // 2. Pull EVERY game for the org (linked + orphan) so we can both feed
  //    the backfill and attempt orphan rescue.
  const { data: allGames, error: gErr } = await supabase
    .from("games")
    .select("id, session_id, pbvision_video_id, played_at")
    .eq("org_id", orgId);
  if (gErr) throw new Error(`games fetch failed: ${gErr.message}`);
  const rhGames = (allGames || []) as RhGame[];

  // 2a. Orphan rescue: for each session_id=null game, find the rh session
  //     on the same date whose player_group_key overlaps ≥ OVERLAP_THRESHOLD
  //     with the orphan's 4 game_players.
  const orphans = rhGames.filter((g) => !g.session_id);
  console.error(`Found ${orphans.length} orphan game(s) (session_id=null).`);

  const rescuedMap = new Map<string, string>(); // gameId → sessionId
  if (orphans.length > 0) {
    const orphanIds = orphans.map((o) => o.id);
    const orphanPlayersById = new Map<string, Set<string>>();
    for (let i = 0; i < orphanIds.length; i += 500) {
      const chunk = orphanIds.slice(i, i + 500);
      const { data: gp, error: gpErr } = await supabase
        .from("game_players")
        .select("game_id, player_id")
        .eq("org_id", orgId)
        .in("game_id", chunk);
      if (gpErr) throw new Error(`game_players fetch failed: ${gpErr.message}`);
      for (const row of (gp || []) as GamePlayer[]) {
        const set = orphanPlayersById.get(row.game_id) || new Set<string>();
        set.add(row.player_id);
        orphanPlayersById.set(row.game_id, set);
      }
    }

    const sessionsByDate = new Map<string, RhSession[]>();
    for (const s of rhSessions as RhSession[]) {
      if (!s.played_date) continue;
      const arr = sessionsByDate.get(s.played_date) || [];
      arr.push(s);
      sessionsByDate.set(s.played_date, arr);
    }

    let matched = 0;
    let ambiguous = 0;
    let noMatch = 0;
    for (const orphan of orphans) {
      const date = orphan.played_at ? orphan.played_at.slice(0, 10) : null;
      const gamePlayers = orphanPlayersById.get(orphan.id);
      if (!date || !gamePlayers || gamePlayers.size === 0) {
        noMatch++;
        console.error(
          `[no-match] orphan ${orphan.id} (vid=${orphan.pbvision_video_id ?? "—"}): missing date or players`,
        );
        continue;
      }
      const candidates = sessionsByDate.get(date) || [];
      const scored = candidates
        .map((s) => {
          const sessPlayers = new Set(
            (s.player_group_key || "")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          );
          let overlap = 0;
          for (const p of gamePlayers) if (sessPlayers.has(p)) overlap++;
          return { session: s, overlap };
        })
        .filter((x) => x.overlap >= OVERLAP_THRESHOLD);

      if (scored.length === 1) {
        rescuedMap.set(orphan.id, scored[0].session.id);
        matched++;
        console.error(
          `[rescue] ${orphan.id} (${date}, vid=${orphan.pbvision_video_id ?? "—"}) → ` +
          `"${scored[0].session.label ?? ""}" (${scored[0].session.id}) overlap=${scored[0].overlap}/4`,
        );
      } else if (scored.length > 1) {
        ambiguous++;
        console.error(
          `[ambiguous] ${orphan.id} (${date}, vid=${orphan.pbvision_video_id ?? "—"}): ` +
          `${scored.length} candidate sessions — ` +
          scored.map((x) => `"${x.session.label ?? ""}"(${x.overlap}/4)`).join(", "),
        );
      } else {
        noMatch++;
        console.error(
          `[no-match] ${orphan.id} (${date}, vid=${orphan.pbvision_video_id ?? "—"}): ` +
          `no rh session with ≥${OVERLAP_THRESHOLD}/4 player overlap`,
        );
      }
    }
    console.error(
      `\nOrphan rescue: matched=${matched} ambiguous=${ambiguous} no-match=${noMatch}`,
    );

    // Apply the rescue to rating-hub's games table.
    if (!dryRun && rescuedMap.size > 0) {
      const bySession = new Map<string, string[]>();
      for (const [gid, sid] of rescuedMap) {
        const arr = bySession.get(sid) || [];
        arr.push(gid);
        bySession.set(sid, arr);
      }
      for (const [sid, gids] of bySession) {
        const { error: uErr } = await supabase
          .from("games")
          .update({ session_id: sid })
          .in("id", gids);
        if (uErr) {
          console.error(`  ! rescue update failed for session ${sid}: ${uErr.message}`);
        } else {
          console.error(`  ✓ relinked ${gids.length} game(s) → ${sid}`);
        }
      }
    }
  }

  // Build gamesBySession using both the already-linked games and the
  // in-memory rescues (so dry-run previews reflect post-rescue state).
  const gamesBySession = new Map<string, RhGame[]>();
  for (const g of rhGames) {
    const sid = g.session_id ?? rescuedMap.get(g.id) ?? null;
    if (!sid) continue;
    const arr = gamesBySession.get(sid) || [];
    arr.push({ ...g, session_id: sid });
    gamesBySession.set(sid, arr);
  }

  // 3. Resolve all unique player_group_key UUIDs → display_name in one pass.
  const allPlayerUuids = new Set<string>();
  for (const s of rhSessions as RhSession[]) {
    if (s.player_group_key) {
      s.player_group_key
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((uuid) => allPlayerUuids.add(uuid));
    }
  }
  const playerMap = new Map<string, string>();
  if (allPlayerUuids.size > 0) {
    const ids = [...allPlayerUuids];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const { data: playerRows, error: pErr } = await supabase
        .from("players")
        .select("id, display_name")
        .in("id", chunk);
      if (pErr) throw new Error(`players fetch failed: ${pErr.message}`);
      for (const p of (playerRows || []) as PlayerRow[]) {
        playerMap.set(p.id, p.display_name);
      }
    }
  }
  console.error(`Resolved ${playerMap.size}/${allPlayerUuids.size} player names.`);

  // 4. Upsert into SQLite. Existing rows are left alone (status + any
  //    local state preserved); only missing rows are created.
  const db = getDb();
  const existingIds = new Set<string>(
    (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((r) => r.id),
  );

  const insertStmt = db.prepare(`
    INSERT INTO sessions (
      id, status, label, booking_time, player_names, pbvision_video_ids,
      created_at, updated_at
    )
    VALUES (?, 'complete', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  let created = 0;
  let existing = 0;
  let skippedNoData = 0;
  const toSync: string[] = [];

  for (const s of rhSessions as RhSession[]) {
    const vids = [
      ...new Set(
        (gamesBySession.get(s.id) || [])
          .map((g) => g.pbvision_video_id)
          .filter(Boolean) as string[],
      ),
    ];
    const playerUuids = s.player_group_key
      ? s.player_group_key.split(",").map((x) => x.trim()).filter(Boolean)
      : [];
    const playerNames = playerUuids
      .map((uuid) => playerMap.get(uuid))
      .filter((n): n is string => !!n);
    const bookingTime = s.played_date ? `${s.played_date}T00:00:00` : null;

    const alreadyLocal = existingIds.has(s.id);
    const tag = alreadyLocal ? "exists" : "create";
    console.error(
      `[${tag}] ${s.id} ${s.played_date ?? "—"} "${s.label ?? ""}" players=${playerNames.length} vids=${vids.length}`,
    );

    if (!alreadyLocal) {
      if (playerNames.length === 0 || vids.length === 0) {
        console.error(
          `  skipping insert — need at least one player and one video ` +
          `(players=${playerNames.length} vids=${vids.length})`,
        );
        skippedNoData++;
        continue;
      }
      if (!dryRun) {
        insertStmt.run(
          s.id,
          s.label ?? null,
          bookingTime,
          JSON.stringify(playerNames),
          JSON.stringify(vids),
        );
      }
      created++;
    } else {
      existing++;
    }

    if (vids.length > 0 && playerNames.length > 0) {
      toSync.push(s.id);
    }
  }

  console.error(
    `\n${dryRun ? "[dry-run] " : ""}Backfill summary: created=${created} ` +
    `existing=${existing} skipped=${skippedNoData}`,
  );

  if (skipSync) {
    console.error("--skip-sync set; done.");
    return;
  }
  if (dryRun) {
    console.error(`Would sync ${toSync.length} session(s) to rating-hub.`);
    return;
  }

  // 5. Re-sync each session (fires the webhook + relinks game.session_id).
  console.error(`\nRe-syncing ${toSync.length} session(s) to rating-hub...`);
  const loadSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  let synced = 0;
  let failed = 0;
  for (const sid of toSync) {
    const row = loadSession.get(sid) as Record<string, unknown> | undefined;
    if (!row) continue;
    const sess = rowToSession(row);
    try {
      const res = await syncRatingHub(sess, (msg) => console.error(`  ${msg}`));
      console.error(`[ok] ${sid}: linked ${res.totalGamesLinked} game(s)`);
      synced++;
    } catch (e) {
      const msg = e instanceof SyncRatingHubError ? `[${e.code}] ${e.message}` : String(e);
      console.error(`[fail] ${sid}: ${msg}`);
      failed++;
    }
  }

  console.error(`\nDone: synced=${synced} failed=${failed}`);
}

function rowToSession(row: Record<string, unknown>): Session {
  const parse = <T>(v: unknown): T | null =>
    v && typeof v === "string" ? (JSON.parse(v) as T) : null;
  return {
    id: row.id as string,
    status: row.status as Session["status"],
    label: (row.label as string) ?? null,
    booking_time: (row.booking_time as string) ?? null,
    player_names: parse<string[]>(row.player_names),
    video_path: (row.video_path as string) ?? null,
    roi_path: (row.roi_path as string) ?? null,
    segments: parse(row.segments),
    clip_paths: parse<string[]>(row.clip_paths),
    pbvision_video_ids: parse<string[]>(row.pbvision_video_ids),
    error: (row.error as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
