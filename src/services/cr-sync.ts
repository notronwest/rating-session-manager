// CourtReserve → session-manager auto-create flow.
//
// Two pieces:
//   1. refreshScheduleFromCr() spawns scripts/fetch-schedule.py to update
//      data/schedule.json with today's CR events. Slow (~10–30s — opens
//      Chromium against CR via the courtreserve-scheduler sibling).
//   2. syncSessionsFromSchedule() reads the cached schedule, picks out
//      rating events, and creates a session_manager_sessions row for any
//      that don't already exist. Idempotent: dedupes on (booking_time,
//      sorted player roster) so re-running doesn't pile up duplicates.
//
// The combined entry point syncFromCourtReserve() runs both in sequence
// — the dashboard button calls this.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listSessions, createSession } from "../db/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const FETCH_SCHEDULE_PY = path.join(ROOT, "scripts", "fetch-schedule.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");
const SCHEDULE_JSON = path.join(ROOT, "data", "schedule.json");

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

/**
 * Spawn scripts/fetch-schedule.py. Resolves on success, rejects with
 * CrSyncError on non-zero exit. Streams stdout/stderr into onLog.
 */
export function refreshScheduleFromCr(
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const onLog = opts.onLog ?? (() => {});
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FETCH_SCHEDULE_PY)) {
      reject(new CrSyncError("script_missing", `fetch-schedule.py not found at ${FETCH_SCHEDULE_PY}`));
      return;
    }
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const proc = spawn(python, [FETCH_SCHEDULE_PY], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    const forward = (chunk: Buffer) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .forEach((line: string) => {
          if (line.trim()) onLog(line);
        });
    };
    proc.stdout.on("data", forward);
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4096);
      forward(chunk);
    });
    proc.on("error", (err) => reject(new CrSyncError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new CrSyncError("fetch_failed", `fetch-schedule.py exited with code ${code}\n${stderrTail}`));
    });
  });
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
