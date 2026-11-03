// The in-use gate (SP-11, D-0060): only index footage from when the court was
// booked. The answer is the cached occupancy read — never a live Court Reserve
// call — and "could not tell" skips, it never guesses.
import type { OccupancyAnswer } from "../services/lesson-match.js";

export interface GatePlan {
  /** [startEpoch, endEpoch] the court was booked, clipped to the range asked. */
  windows: [number, number][];
  /** Why anything was skipped; empty when the whole answer was usable. */
  skipped: string[];
}

/**
 * Turn an occupancy answer into windows to index.
 *
 * A stale or never-refreshed cache skips the WHOLE range: an empty answer from
 * a stale cache means "I don't know", and indexing on it either wastes the
 * night or invents games. An occurrence with no court at all is skipped on its
 * own — we won't claim a court was in use on a row that doesn't say which.
 * Several overlapping bookings are not a problem here: in-use is true either
 * way, and who played is a different question (D-0061).
 */
export function planWindows(
  ans: OccupancyAnswer, range: [number, number], maxStaleS: number,
): GatePlan {
  if (!ans.ok || ans.refreshed_at === null) {
    return { windows: [], skipped: ["booking cache has not refreshed — range skipped"] };
  }
  if (ans.stale_seconds !== null && ans.stale_seconds > maxStaleS) {
    return { windows: [], skipped: [`booking cache is ${Math.round(ans.stale_seconds / 60)} min stale (limit ${Math.round(maxStaleS / 60)} min) — range skipped`] };
  }
  const skipped: string[] = [];
  const raw: [number, number][] = [];
  for (const o of ans.occurrences) {
    if (!o.court_hint) {
      skipped.push(`occurrence ${o.occurrence_id} names no court — skipped`);
      continue;
    }
    const s = Math.max(Date.parse(o.start_at) / 1000, range[0]);
    const e = Math.min(Date.parse(o.end_at) / 1000, range[1]);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) raw.push([s, e]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const windows: [number, number][] = [];
  for (const w of raw) {
    const last = windows[windows.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else windows.push([w[0], w[1]]);
  }
  return { windows, skipped };
}
