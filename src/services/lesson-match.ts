// Which lesson was this recording of? (LP-07's matching half, rsm#73.)
//
// SCOPE, and it is deliberate: this module RESOLVES and ATTACHES. It never
// creates a lesson row. Both repo seats at the 2026-10-13 decision table
// vetoed creation here — D-0064 puts it in the job that materialises bookings
// (LP-04), the lesson schema's own comments say so in two places, and issue
// #73's Build section assumes the lesson already exists. A second writer here
// would race LP-04's unique index on cr_reservation_id.
//
// WHAT CHANGED SINCE #73 WAS WRITTEN. D-0064 justified time-window matching by
// saying teaching recordings "carry no booking id". They do now: the scheduled
// recorder keys its state on Court Reserve's reservation id. That binding is
// pruned after 7 days and the recorder is currently off (Ron records by hand),
// so the window match below is still the mechanism — but when the binding is
// persisted it should be preferred, and D-0064's clause amended rather than
// worked around.
//
// THE KIND IS READ, NEVER INFERRED. An earlier attempt classified a lesson as
// "no EventName"; measured over the full table that selected 1,871 ordinary
// Court Bookings, 79% wrong. Court Reserve declares reservation_type and the
// occupancy service filters on it.

import { getSupabase, getOrgId } from "../supabase.js";

export interface Occurrence {
  occurrence_id: number;
  reservation_type: string | null;
  start_at: string;
  end_at: string;
  court_hint: string | null;
  multi_court: boolean;
  is_teaching: boolean;
  participants: { org_member_id: number; name: string | null }[];
}

export interface OccupancyAnswer {
  status: "none" | "one" | "ambiguous";
  occurrences: Occurrence[];
  refreshed_at: string | null;
  stale_seconds: number | null;
  ok: boolean;
}

export type Match =
  /** Exactly one teaching occurrence, confidently. */
  | { kind: "lesson"; occurrence: Occurrence; playerIds: string[]; unmatched: string[] }
  /** The cache answered, confidently, that nothing teaching was booked then. */
  | { kind: "not-teaching" }
  /** Two or more overlapped, or one spanned several courts. Refuse, don't pick. */
  | { kind: "ambiguous"; reason: string; occurrences: Occurrence[] }
  /** We could not get a trustworthy answer. NOT the same as "no lesson". */
  | { kind: "unknown"; reason: string };

/**
 * The club's UTC offset on a given local date, so a filename's wall-clock time
 * becomes an unambiguous instant. Computed from the zone rather than hardcoded:
 * the recordings straddle a DST boundary, and a fixed -04:00 would silently
 * shift every November lesson by an hour.
 */
export function clubOffset(localDate: string, tz = "America/New_York"): string {
  const probe = new Date(`${localDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, timeZoneName: "longOffset",
  }).formatToParts(probe);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m ? m[1] : "-05:00";
}

/** `teaching/2026-10-14/teaching-090449` + 3911s -> the instants it spans. */
export function recordingWindow(date: string, base: string, durationS: number) {
  const m = /teaching-(\d{2})(\d{2})(\d{2})/.exec(base);
  if (!m) return null;
  const off = clubOffset(date);
  const start = new Date(`${date}T${m[1]}:${m[2]}:${m[3]}${off}`);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + Math.max(durationS, 0) * 1000) };
}

/**
 * Ask the occupancy service what was booked during the window.
 *
 * Loopback by default. The key this carries also authorises /book, /cancel and
 * payment methods, so it must not travel further than it has to.
 */
export async function askOccupancy(
  start: Date, end: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<OccupancyAnswer> {
  const base = env.CRAPI_LOOPBACK_URL || `http://127.0.0.1:${env.CRAPI_PORT || "8787"}`;
  const key = env.CRAPI_KEY;
  if (!key) throw new Error("CRAPI_KEY is not set — cannot ask which lesson this was");
  const court = env.LESSON_COURT || "Court #4";
  const u = new URL("/occupancy/at", base);
  u.searchParams.set("start", start.toISOString());
  u.searchParams.set("end", end.toISOString());
  u.searchParams.set("court", court);
  u.searchParams.set("only_teaching", "true");
  const res = await fetch(u, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`occupancy/at returned HTTP ${res.status}`);
  return (await res.json()) as OccupancyAnswer;
}

/** Court Reserve member numbers -> this org's players. */
export async function playersForMembers(memberIds: number[]): Promise<{ found: string[]; missing: string[] }> {
  if (memberIds.length === 0) return { found: [], missing: [] };
  const orgId = await getOrgId();
  const { data, error } = await getSupabase()
    .from("players")
    .select("id, cr_member_id")
    // Scoped by org: cr_member_id is unique on (org_id, cr_member_id), NOT on
    // its own, so an unscoped lookup returns a cross-org hit the day a second
    // org exists.
    .eq("org_id", orgId)
    .in("cr_member_id", memberIds.map(String));
  if (error) throw new Error(`player lookup failed: ${error.message}`);
  const byCr = new Map((data ?? []).map((p: { id: string; cr_member_id: string }) => [p.cr_member_id, p.id]));
  const found: string[] = [];
  const missing: string[] = [];
  for (const id of memberIds) {
    const hit = byCr.get(String(id));
    if (hit) found.push(hit); else missing.push(String(id));
  }
  return { found, missing };
}

/**
 * Turn the occupancy answer into a decision.
 *
 * Refusal is a result, not a failure. A recording overlapping two bookings, or
 * one spanning several courts, is a question for a human — the mechanism must
 * not assert what its evidence cannot support. Note especially that a STALE
 * cache yields "unknown", never "not-teaching": "I could not find a lesson" and
 * "there was no lesson" are different claims, and conflating them would make
 * the job delete-adjacent decisions on bad data.
 */
export function classify(ans: OccupancyAnswer, maxStaleS: number): Match {
  if (!ans.ok || ans.refreshed_at === null) {
    return { kind: "unknown", reason: "the booking cache has not refreshed — cannot tell what was booked" };
  }
  if (ans.stale_seconds !== null && ans.stale_seconds > maxStaleS) {
    return { kind: "unknown", reason: `booking cache is ${Math.round(ans.stale_seconds / 60)} min stale (limit ${Math.round(maxStaleS / 60)} min)` };
  }
  if (ans.status === "none") return { kind: "not-teaching" };
  if (ans.status === "ambiguous") {
    return { kind: "ambiguous", reason: `${ans.occurrences.length} teaching bookings overlap this recording`, occurrences: ans.occurrences };
  }
  const occ = ans.occurrences[0];
  if (!occ.is_teaching) return { kind: "not-teaching" };
  if (occ.multi_court) {
    return { kind: "ambiguous", reason: "the booking spans several courts, so who was on this one is not knowable", occurrences: [occ] };
  }
  return { kind: "lesson", occurrence: occ, playerIds: [], unmatched: [] };
}

/** A lesson already created for this Court Reserve booking, if any. */
export async function findLessonByReservation(crReservationId: string) {
  const { data, error } = await getSupabase()
    .from("lessons")
    .select("id, transcript, recording_ref, written_up_at, what_we_did, homework")
    .eq("cr_reservation_id", crReservationId)
    .maybeSingle();
  if (error) throw new Error(`lesson lookup by reservation ${crReservationId} failed: ${error.message}`);
  return data as
    | { id: string; transcript: string | null; recording_ref: string | null;
        written_up_at: string | null; what_we_did: string | null; homework: string | null }
    | null;
}

/**
 * Point an existing lesson at this recording.
 *
 * Writes `cr_reservation_id` too, because that is the idempotency key the
 * lessons table already indexes uniquely and the one thing that makes a
 * machine-written row traceable and reversible. Never sets `written_up_at` —
 * that column is the gate on anything reaching a student.
 */
export async function linkRecording(lessonId: string, recordingRef: string, crReservationId: string) {
  const { error } = await getSupabase()
    .from("lessons")
    .update({ recording_ref: recordingRef, cr_reservation_id: crReservationId,
              updated_at: new Date().toISOString() })
    .eq("id", lessonId);
  if (error) throw new Error(`linking ${recordingRef} to lesson ${lessonId} failed: ${error.message}`);
}
