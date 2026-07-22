// CourtReserve → session-manager auto-create flow.
//
// Two pieces:
//   1. refreshScheduleFromCr() calls the shared courtreserve-api HTTP service
//      (GET /schedule) to update data/schedule.json with today's CR events.
//      courtreserve-api owns the CR login + browser and runs on the club Mac
//      mini; consumers just make an authenticated LAN fetch — no Python,
//      Playwright, or courtreserve-scheduler sibling on this side.
//   2. syncSessionsFromSchedule() reads the cached schedule, picks out
//      rating events, and creates a session_manager_sessions row for any
//      that don't already exist. Idempotent: dedupes on (booking_time,
//      sorted player roster) so re-running doesn't pile up duplicates.
//
// The combined entry point syncFromCourtReserve() runs both in sequence
// — the dashboard button calls this.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listSessions, createSession } from "../db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCHEDULE_JSON = path.join(ROOT, "data", "schedule.json");

// courtreserve-api HTTP service (see ../courtreserve-api). CRAPI_URL is the
// service base, e.g. http://localhost:8787 on the mini or http://<mini-ip>:8787
// from another LAN host; CRAPI_KEY is the shared secret sent as X-API-Key.
const CRAPI_URL = (process.env.CRAPI_URL || "").replace(/\/+$/, "");
const CRAPI_KEY = process.env.CRAPI_KEY || "";
// The service opens a real browser against CR per request (~10–30s), so give
// the fetch generous headroom before aborting.
const CRAPI_TIMEOUT_MS = 60_000;

// Same heuristics src/routes/schedule.ts uses to filter rating events.
const RATING_KEYWORDS = ["rating", "rated", "assessment", "eval"];
const RATING_RESERVATION_TYPES = ["rating session"];

interface ScheduleItem {
  Id: number;
  EventName: string | null;
  ReservationType: string | null;
  StartDateTime: string;
  EndDateTime: string;
  Courts: string | null;
  MembersCount: number;
  Members: string | null;
  EventId: number | null;
}

interface ParsedEvent {
  eventId: number | null;
  eventName: string;
  startTime: string;
  playerNames: string[];
}

function isRatingEvent(item: ScheduleItem): boolean {
  const resType = (item.ReservationType || "").toLowerCase();
  if (RATING_RESERVATION_TYPES.includes(resType)) return true;
  const name = (item.EventName || "").toLowerCase();
  return RATING_KEYWORDS.some((kw) => name.includes(kw));
}

function parseMemberNames(membersStr: string | null): string[] {
  if (!membersStr) return [];
  // CR formats members as: "Debbie O'Connor (#6203459), Patti Kraieski (#6466189)"
  return membersStr
    .split(",")
    .map((part) => {
      const m = part.trim().match(/^(.+?)\s*\(#\d+\)$/);
      return m ? m[1].trim() : part.trim();
    })
    .filter((s) => s.length > 0);
}

function makeDedupKey(bookingTime: string | null, names: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const sortedNames = [...names].map(norm).sort().join("|");
  return `${bookingTime || ""}::${sortedNames}`;
}

export class CrSyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Today's date in CR's `M/D/YYYY` (no leading zeros), local time. */
function crDateToday(): string {
  const now = new Date();
  return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
}

/**
 * Refresh today's CR schedule via the courtreserve-api HTTP service and write
 * it to data/schedule.json (the cache syncSessionsFromSchedule + the schedule
 * routes read). Resolves on success, rejects with CrSyncError on any failure.
 */
export async function refreshScheduleFromCr(
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const onLog = opts.onLog ?? (() => {});

  if (!CRAPI_URL || !CRAPI_KEY) {
    throw new CrSyncError(
      "crapi_not_configured",
      "CRAPI_URL and CRAPI_KEY must be set to reach the courtreserve-api service (see .env.template).",
    );
  }

  const date = crDateToday();
  const url = `${CRAPI_URL}/schedule?start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`;
  onLog(`Fetching schedule for ${date} from courtreserve-api…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAPI_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": CRAPI_KEY },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new CrSyncError(
      aborted ? "crapi_timeout" : "crapi_unreachable",
      aborted
        ? `courtreserve-api did not respond within ${CRAPI_TIMEOUT_MS / 1000}s at ${CRAPI_URL}.`
        : `Could not reach courtreserve-api at ${CRAPI_URL}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new CrSyncError("crapi_unauthorized", "courtreserve-api rejected CRAPI_KEY (401).");
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new CrSyncError(
      "crapi_error",
      `courtreserve-api /schedule returned HTTP ${res.status}${body ? `: ${body}` : ""}`,
    );
  }

  let items: unknown;
  try {
    const payload = (await res.json()) as { items?: unknown };
    items = payload?.items;
  } catch (err) {
    throw new CrSyncError("crapi_bad_json", `courtreserve-api returned invalid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(items)) {
    throw new CrSyncError("crapi_bad_json", "courtreserve-api /schedule response had no `items` array.");
  }

  fs.mkdirSync(path.dirname(SCHEDULE_JSON), { recursive: true });
  fs.writeFileSync(SCHEDULE_JSON, JSON.stringify(items, null, 2), "utf-8");
  onLog(`Wrote ${items.length} schedule items to data/schedule.json.`);
}

export interface CreatedSessionInfo {
  sessionId: string;
  label: string;
  bookingTime: string;
  playerNames: string[];
}

export interface SkippedEventInfo {
  eventName: string;
  reason: string;
}

export interface CrSyncResult {
  refreshed: boolean;
  inspected: number;
  created: CreatedSessionInfo[];
  skipped: SkippedEventInfo[];
}

/**
 * Read the cached CR schedule, filter to rating events, create a session
 * for any not-yet-tracked event. Idempotent.
 */
export async function syncSessionsFromSchedule(
  opts: { onLog?: (line: string) => void } = {},
): Promise<Omit<CrSyncResult, "refreshed">> {
  const onLog = opts.onLog ?? (() => {});

  if (!fs.existsSync(SCHEDULE_JSON)) {
    throw new CrSyncError(
      "no_schedule",
      `Schedule cache missing at ${SCHEDULE_JSON}. Run a refresh first.`,
    );
  }

  let items: ScheduleItem[];
  try {
    items = JSON.parse(fs.readFileSync(SCHEDULE_JSON, "utf-8"));
  } catch (err) {
    throw new CrSyncError(
      "parse_failed",
      `Failed to parse ${SCHEDULE_JSON}: ${(err as Error).message}`,
    );
  }

  const events: ParsedEvent[] = items.filter(isRatingEvent).map((it) => ({
    eventId: it.EventId,
    eventName: it.EventName || it.ReservationType || "Unknown",
    startTime: it.StartDateTime,
    playerNames: parseMemberNames(it.Members),
  }));

  onLog(`Cached schedule has ${items.length} items, ${events.length} rating events.`);

  if (events.length === 0) {
    return { inspected: 0, created: [], skipped: [] };
  }

  const existing = await listSessions();
  const existingKeys = new Set(
    existing.map((s) => makeDedupKey(s.booking_time, s.player_names || [])),
  );

  const created: CreatedSessionInfo[] = [];
  const skipped: SkippedEventInfo[] = [];

  for (const ev of events) {
    if (ev.playerNames.length === 0) {
      skipped.push({ eventName: ev.eventName, reason: "no players in CR event" });
      continue;
    }
    const dedupKey = makeDedupKey(ev.startTime, ev.playerNames);
    if (existingKeys.has(dedupKey)) {
      skipped.push({ eventName: ev.eventName, reason: "session already exists" });
      continue;
    }
    const newSession = await createSession({
      label: ev.eventName,
      booking_time: ev.startTime,
      player_names: ev.playerNames,
    });
    existingKeys.add(dedupKey);
    created.push({
      sessionId: newSession.id,
      label: newSession.label || ev.eventName,
      bookingTime: newSession.booking_time || ev.startTime,
      playerNames: ev.playerNames,
    });
    onLog(`+ Created session for "${ev.eventName}" with ${ev.playerNames.length} players`);
  }

  return { inspected: events.length, created, skipped };
}

/**
 * One-shot CR sync: refresh schedule + create missing sessions.
 * `refresh: false` skips the slow CR scrape and uses whatever's cached.
 */
export async function syncFromCourtReserve(
  opts: { refresh?: boolean; onLog?: (line: string) => void } = {},
): Promise<CrSyncResult> {
  const onLog = opts.onLog ?? (() => {});
  const refresh = opts.refresh !== false;

  if (refresh) {
    onLog("Refreshing today's schedule from CourtReserve…");
    await refreshScheduleFromCr({ onLog });
    onLog("Schedule cache updated.");
  }

  const result = await syncSessionsFromSchedule({ onLog });
  return { refreshed: refresh, ...result };
}
