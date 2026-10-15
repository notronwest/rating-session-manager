// Create a lesson record for every Court Reserve teaching booking (D-0183).
//
// Ron, 2026-10-15: "we will always have a lesson booked in CR -- there may or
// may not be a video associated with it -- we still want to include that as
// data on their TSA profile."
//
// This is the CREATOR. It is deliberately separate from the transcription
// job's matcher, which resolves and attaches but never creates: two writers
// racing the unique index on cr_reservation_id is the thing both repo seats
// vetoed, and the way to honour that is to have exactly one creator, not to
// have none.
//
// IDEMPOTENT ON THE BOOKING. cr_reservation_id is the stable key D-0064 names
// and the lessons table already indexes uniquely. Running this twice cannot
// produce a second row for a booking; running it after a coach has edited a
// lesson must not overwrite their words, so an existing row is only ever
// topped up with facts it is missing.

import { getSupabase, getOrgId } from "../supabase.js";

export interface SyncOptions {
  start: Date;
  end: Date;
  apply: boolean;
  log: (s: string) => void;
}

export interface SyncResult {
  seen: number; created: number; updated: number; skipped: number;
  unresolvedCoach: number; unmatchedPlayers: number;
}

interface Occ {
  occurrence_id: number;
  reservation_type: string | null;
  start_at: string;
  end_at: string;
  is_teaching: boolean;
  instructors: string[];
  participants: { org_member_id: number; name: string | null }[];
}

async function fetchOccurrences(start: Date, end: Date, env = process.env): Promise<Occ[]> {
  const base = env.CRAPI_LOOPBACK_URL || `http://127.0.0.1:${env.CRAPI_PORT || "8787"}`;
  const key = env.CRAPI_KEY;
  if (!key) throw new Error("CRAPI_KEY is not set");
  const u = new URL("/occupancy/at", base);
  u.searchParams.set("start", start.toISOString());
  u.searchParams.set("end", end.toISOString());
  u.searchParams.set("only_teaching", "true");
  const res = await fetch(u, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`occupancy/at returned HTTP ${res.status}`);
  const body = (await res.json()) as { occurrences: Occ[]; ok: boolean };
  if (!body.ok) throw new Error("the booking cache reports itself unrefreshed — refusing to create lessons from it");
  return body.occurrences;
}

/** display_name -> auth user id, for the handful of people who coach. Built
 *  once per run from the players table rather than guessed per lesson. */
async function coachIndex(orgId: string): Promise<Map<string, string>> {
  const { data, error } = await getSupabase()
    .from("players").select("display_name, user_id")
    .eq("org_id", orgId).not("user_id", "is", null);
  if (error) throw new Error(`coach lookup failed: ${error.message}`);
  return new Map((data ?? []).map((p: { display_name: string; user_id: string }) => [p.display_name, p.user_id]));
}

async function playerIndex(orgId: string): Promise<Map<string, string>> {
  const { data, error } = await getSupabase()
    .from("players").select("id, cr_member_id")
    .eq("org_id", orgId).not("cr_member_id", "is", null);
  if (error) throw new Error(`player lookup failed: ${error.message}`);
  return new Map((data ?? []).map((p: { id: string; cr_member_id: string }) => [p.cr_member_id, p.id]));
}

export async function syncLessons(opts: SyncOptions): Promise<SyncResult> {
  const { start, end, apply, log } = opts;
  const r: SyncResult = { seen: 0, created: 0, updated: 0, skipped: 0, unresolvedCoach: 0, unmatchedPlayers: 0 };
  const orgId = await getOrgId();
  const coaches = await coachIndex(orgId);
  const players = await playerIndex(orgId);
  const sb = getSupabase();

  for (const occ of await fetchOccurrences(start, end)) {
    if (!occ.is_teaching) continue;
    r.seen++;
    const crId = String(occ.occurrence_id);

    const studentIds = occ.participants
      .map((p) => players.get(String(p.org_member_id)))
      .filter((x): x is string => !!x);
    r.unmatchedPlayers += occ.participants.length - studentIds.length;

    // A lesson with no student we can identify is not a fact about anyone.
    // player_id is still NOT NULL, so there is nothing honest to write.
    if (studentIds.length === 0) { r.skipped++; continue; }

    // CR writes a co-taught session as "A, B". Keep the whole string as the
    // name — it is what happened — and resolve the first to an account.
    const coachName = occ.instructors.join(", ") || null;
    const coachId = coaches.get(occ.instructors[0] ?? "") ?? null;
    if (coachName && !coachId) r.unresolvedCoach++;

    const { data: existing } = await sb.from("lessons")
      .select("id, coach_name, coach_id, lesson_at").eq("cr_reservation_id", crId).maybeSingle();

    if (!apply) {
      log(`${existing ? "would update" : "would create"} ${occ.start_at.slice(0, 16)} ${occ.reservation_type} — ${occ.participants.map((p) => p.name).join(", ")} (coach ${coachName}${coachId ? "" : ", no account"})`);
      existing ? r.updated++ : r.created++;
      continue;
    }

    if (existing) {
      // Top up facts only. Never touch what_we_did, homework, coach_note or
      // written_up_at: a coach's words are not this job's to rewrite.
      const patch: Record<string, unknown> = {};
      if (!existing.coach_name && coachName) patch.coach_name = coachName;
      if (!existing.coach_id && coachId) patch.coach_id = coachId;
      if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        const { error } = await sb.from("lessons").update(patch).eq("id", existing.id);
        if (error) throw new Error(`update ${crId}: ${error.message}`);
        r.updated++;
      } else r.skipped++;
      await upsertParticipants(existing.id, orgId, studentIds);
      continue;
    }

    const { data: made, error } = await sb.from("lessons").insert({
      org_id: orgId,
      player_id: studentIds[0],      // the primary student; participants carries all
      coach_id: coachId,
      coach_name: coachName,
      lesson_at: occ.start_at,
      cr_reservation_id: crId,
    }).select("id").single();
    if (error) {
      // A unique violation means something else created it between our read
      // and our write. That is the index doing its job, not an error.
      if (/duplicate key|23505/.test(error.message)) { r.skipped++; continue; }
      throw new Error(`create ${crId}: ${error.message}`);
    }
    r.created++;
    await upsertParticipants(made!.id, orgId, studentIds);
  }
  return r;
}

async function upsertParticipants(lessonId: string, orgId: string, playerIds: string[]) {
  if (playerIds.length === 0) return;
  const { error } = await getSupabase().from("lesson_participants").upsert(
    playerIds.map((pid) => ({ lesson_id: lessonId, player_id: pid, org_id: orgId })),
    { onConflict: "lesson_id,player_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`participants for ${lessonId}: ${error.message}`);
}
