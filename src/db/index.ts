// Session-manager data layer, backed by Supabase (formerly local SQLite).
//
// Tables: public.session_manager_sessions, public.session_manager_session_logs.
// All operations are scoped by org_id (resolved from ORG_SLUG via getOrgId()).
//
// Supabase JS client returns jsonb columns already-parsed and accepts JS
// objects on insert/update, so callers no longer JSON.stringify/JSON.parse.

import { getSupabase, getOrgId } from "../supabase.js";
import type { Session, SessionStatus, GameSegment } from "../types.js";

const SESSIONS = "session_manager_sessions";
const LOGS = "session_manager_session_logs";

// Columns we always select. Order matches the Session type for readability.
const SESSION_COLS =
  "id, status, label, booking_time, player_names, video_path, roi_path, " +
  "segments, clip_paths, pbvision_video_ids, error, created_at, updated_at";

// Cast Supabase rows (which use `unknown` JSONB and a wide select-string type)
// into our Session type. We trust Postgres + the column list above.
function rowToSession(row: unknown): Session {
  return row as Session;
}

// --- Sessions ---------------------------------------------------------------

export async function listSessions(): Promise<Session[]> {
  const orgId = await getOrgId();
  const { data, error } = await getSupabase()
    .from(SESSIONS)
    .select(SESSION_COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listSessions: ${error.message}`);
  return ((data ?? []) as unknown[]).map(rowToSession);
}

export async function getSession(id: string): Promise<Session | null> {
  const orgId = await getOrgId();
  const { data, error } = await getSupabase()
    .from(SESSIONS)
    .select(SESSION_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getSession(${id}): ${error.message}`);
  return data ? rowToSession(data) : null;
}

export interface CreateSessionInput {
  /** Optional explicit ID (used by ratinghub-backfill to preserve cross-refs). */
  id?: string;
  label?: string | null;
  booking_time?: string | null;
  player_names?: string[] | null;
  video_path?: string | null;
  /** Optional override (defaults to 'scheduled'). */
  status?: SessionStatus;
  /** Optional pbvision_video_ids preload (used by ratinghub-backfill). */
  pbvision_video_ids?: string[] | null;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const orgId = await getOrgId();
  const row: Record<string, unknown> = {
    org_id: orgId,
    status: input.status ?? "scheduled",
    label: input.label ?? null,
    booking_time: input.booking_time ?? null,
    player_names: input.player_names ?? null,
    video_path: input.video_path ?? null,
    pbvision_video_ids: input.pbvision_video_ids ?? null,
  };
  if (input.id) row.id = input.id;

  const { data, error } = await getSupabase()
    .from(SESSIONS)
    .insert(row)
    .select(SESSION_COLS)
    .single();
  if (error) throw new Error(`createSession: ${error.message}`);
  return rowToSession(data);
}

export interface UpdateSessionInput {
  status?: SessionStatus;
  label?: string | null;
  booking_time?: string | null;
  player_names?: string[] | null;
  video_path?: string | null;
  roi_path?: string | null;
  segments?: GameSegment[] | null;
  clip_paths?: string[] | null;
  pbvision_video_ids?: (string | null)[] | null;
  error?: string | null;
}

/** Update a session and return the fresh row. updated_at auto-bumps via trigger. */
export async function updateSession(
  id: string,
  fields: UpdateSessionInput,
): Promise<Session> {
  const orgId = await getOrgId();
  const { data, error } = await getSupabase()
    .from(SESSIONS)
    .update(fields)
    .eq("org_id", orgId)
    .eq("id", id)
    .select(SESSION_COLS)
    .single();
  if (error) throw new Error(`updateSession(${id}): ${error.message}`);
  return rowToSession(data);
}

// --- Logs -------------------------------------------------------------------

export interface SessionLogRow {
  id: number;
  session_id: string;
  timestamp: string;
  level: string;
  message: string;
}

export async function listLogs(sessionId: string): Promise<SessionLogRow[]> {
  const orgId = await getOrgId();
  const { data, error } = await getSupabase()
    .from(LOGS)
    .select("id, session_id, timestamp, level, message")
    .eq("org_id", orgId)
    .eq("session_id", sessionId)
    .order("id", { ascending: true });
  if (error) throw new Error(`listLogs(${sessionId}): ${error.message}`);
  return (data || []) as SessionLogRow[];
}

export async function appendLog(
  sessionId: string,
  message: string,
  level: string = "info",
): Promise<void> {
  const orgId = await getOrgId();
  const { error } = await getSupabase()
    .from(LOGS)
    .insert({ org_id: orgId, session_id: sessionId, level, message });
  if (error) throw new Error(`appendLog(${sessionId}): ${error.message}`);
}

export async function clearLogs(sessionId: string): Promise<void> {
  const orgId = await getOrgId();
  const { error } = await getSupabase()
    .from(LOGS)
    .delete()
    .eq("org_id", orgId)
    .eq("session_id", sessionId);
  if (error) throw new Error(`clearLogs(${sessionId}): ${error.message}`);
}

/**
 * Permanently delete a session row. Cascades via FK to remove all
 * session_manager_session_logs for this session as well. Does not
 * touch clip files on disk — call deleteClipFiles() in the route
 * handler before this.
 */
export async function deleteSession(id: string): Promise<void> {
  const orgId = await getOrgId();
  const { error } = await getSupabase()
    .from(SESSIONS)
    .delete()
    .eq("org_id", orgId)
    .eq("id", id);
  if (error) throw new Error(`deleteSession(${id}): ${error.message}`);
}

/**
 * Build a fire-and-forget log callback for a session. Calls are serialized
 * per-session via an internal promise chain so log order is preserved even
 * though writes are async. Errors are logged to the server console but never
 * propagate to the caller — log failures should never break a request.
 */
export function makeAddLog(sessionId: string): (msg: string) => void {
  let chain: Promise<unknown> = Promise.resolve();
  return (msg: string) => {
    chain = chain
      .then(() => appendLog(sessionId, msg))
      .catch((err) => {
        console.error(`[session:${sessionId}] addLog failed:`, err);
      });
  };
}
