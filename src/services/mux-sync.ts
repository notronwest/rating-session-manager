// Orchestrates the pb.vision Mux-playback-ID scrape + the write into
// rating-hub's games.mux_playback_id. Shared by:
//   • POST /api/sessions/:id/fetch-mux-ids  (manual button)
//   • the sync-rating-hub flow              (auto, background)
//
// Why a module-level lock: the scraper (scripts/pbvision-mux.py) drives
// the SHARED persistent Playwright profile (.pbvision-profile). Chromium
// locks that profile dir, so two concurrent launches fail with "profile
// already in use". A coach hitting Sync (which kicks a background fetch)
// and then clicking "Fetch Mux IDs" manually would otherwise collide —
// the guard makes the second call a no-op instead.

import { getSupabase, getOrgId } from "../supabase.js";
import { fetchMuxPlaybackIds, MuxFetchError } from "../pbvision/mux.js";

export interface MuxSyncResult {
  vid: string;
  muxPlaybackId: string | null;
  source?: string;
  error?: string;
  updatedGames: number;
  skipped: boolean;
}

export interface MuxSyncSummary {
  results: MuxSyncResult[];
  summary: { fetched: number; updated: number; skipped: number; errors: number };
  /** True when another fetch was already running and this call backed off. */
  busy?: boolean;
}

let inFlight = false;

/**
 * Scrape Mux playback IDs for the given vids and write them into
 * rating-hub's games.mux_playback_id. Idempotent: vids whose games
 * already have an ID are skipped unless `force` is set.
 *
 * Throws MuxFetchError if the scraper itself fails (spawn / auth /
 * parse). Per-vid scrape misses are reported in the results, not
 * thrown.
 */
export async function fetchAndStoreMuxIds(
  vids: string[],
  opts: { force?: boolean; onLog?: (line: string) => void } = {},
): Promise<MuxSyncSummary> {
  const onLog = opts.onLog ?? (() => {});
  const clean = vids.filter(Boolean);
  if (clean.length === 0) {
    return { results: [], summary: { fetched: 0, updated: 0, skipped: 0, errors: 0 } };
  }

  if (inFlight) {
    onLog("Mux fetch already running — skipping this request.");
    return { results: [], summary: { fetched: 0, updated: 0, skipped: 0, errors: 0 }, busy: true };
  }
  inFlight = true;

  try {
    const supabase = getSupabase();
    const orgId = await getOrgId();

    // Which vids already have a mux_playback_id on ≥1 game?
    const { data: existingGames, error: gErr } = await supabase
      .from("games")
      .select("pbvision_video_id, mux_playback_id")
      .eq("org_id", orgId)
      .in("pbvision_video_id", clean);
    if (gErr) throw new Error(`games fetch: ${gErr.message}`);
    const alreadyHas = new Set<string>(
      ((existingGames || []) as { pbvision_video_id: string; mux_playback_id: string | null }[])
        .filter((g) => g.mux_playback_id)
        .map((g) => g.pbvision_video_id),
    );

    const toScrape = opts.force ? clean : clean.filter((v) => !alreadyHas.has(v));
    const skippedVids = opts.force ? [] : clean.filter((v) => alreadyHas.has(v));
    onLog(
      `Fetch Mux IDs: scraping ${toScrape.length}/${clean.length} vid(s)` +
        (skippedVids.length > 0 ? ` (skipping ${skippedVids.length} that already have IDs)` : ""),
    );

    let fetcherResults: { vid: string; muxPlaybackId: string | null; source?: string; error?: string }[] = [];
    if (toScrape.length > 0) {
      fetcherResults = await fetchMuxPlaybackIds(toScrape, {
        onLog: (line) => onLog(`[pbvision-mux] ${line}`),
      });
    }

    const results: MuxSyncResult[] = [];
    let updated = 0;
    let errors = 0;
    for (const r of fetcherResults) {
      if (!r.muxPlaybackId) {
        errors += 1;
        results.push({ ...r, updatedGames: 0, skipped: false });
        continue;
      }
      const { data: updRows, error: updErr } = await supabase
        .from("games")
        .update({ mux_playback_id: r.muxPlaybackId })
        .eq("org_id", orgId)
        .eq("pbvision_video_id", r.vid)
        .select("id");
      if (updErr) {
        errors += 1;
        results.push({ ...r, updatedGames: 0, skipped: false, error: `update failed: ${updErr.message}` });
        continue;
      }
      const n = (updRows || []).length;
      updated += n;
      onLog(`[${r.vid}] saved mux_playback_id=${r.muxPlaybackId} to ${n} game(s)`);
      results.push({ ...r, updatedGames: n, skipped: false });
    }
    for (const vid of skippedVids) {
      results.push({ vid, muxPlaybackId: null, skipped: true, updatedGames: 0 });
    }

    return {
      results,
      summary: { fetched: fetcherResults.length, updated, skipped: skippedVids.length, errors },
    };
  } finally {
    inFlight = false;
  }
}

export { MuxFetchError };
