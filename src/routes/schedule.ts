import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { syncFromCourtReserve, CrSyncError } from "../services/cr-sync.js";
import { sendDiscordAlert } from "../services/discord-alert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

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
  OrgMemberIds: string | null;
  EventId: number | null;
  Organizers: string | null;
}

function isRatingEvent(item: ScheduleItem): boolean {
  const resType = (item.ReservationType || "").toLowerCase();
  if (RATING_RESERVATION_TYPES.includes(resType)) return true;
  const name = (item.EventName || "").toLowerCase();
  return RATING_KEYWORDS.some((kw) => name.includes(kw));
}

function parseMembers(membersStr: string | null): { name: string; memberId: string }[] {
  if (!membersStr) return [];
  // Format: "Debbie O'Connor (#6203459), Patricia Kraieski (#6466189)"
  return membersStr.split(",").map((part) => {
    const match = part.trim().match(/^(.+?)\s*\(#(\d+)\)$/);
    if (match) return { name: match[1].trim(), memberId: match[2] };
    return { name: part.trim(), memberId: "" };
  }).filter((m) => m.name);
}

const router = Router();

// GET /api/schedule — Return cached schedule
router.get("/", (_req, res) => {
  const schedulePath = path.join(DATA_DIR, "schedule.json");
  if (!fs.existsSync(schedulePath)) {
    return res.json({ items: [], error: "No schedule data. Run: python3 scripts/fetch-schedule.py" });
  }

  const raw = fs.readFileSync(schedulePath, "utf-8");
  const items = JSON.parse(raw) as ScheduleItem[];
  res.json({
    items,
    updated: fs.statSync(schedulePath).mtime.toISOString(),
  });
});

// GET /api/schedule/rating-events — Return only rating events with parsed players
router.get("/rating-events", (_req, res) => {
  const schedulePath = path.join(DATA_DIR, "schedule.json");
  if (!fs.existsSync(schedulePath)) {
    return res.json({ events: [] });
  }

  const raw = fs.readFileSync(schedulePath, "utf-8");
  const items = JSON.parse(raw) as ScheduleItem[];

  const ratingEvents = items.filter(isRatingEvent).map((item) => ({
    id: item.Id,
    event_id: item.EventId,
    event_name: item.EventName || item.ReservationType,
    start_time: item.StartDateTime,
    end_time: item.EndDateTime,
    courts: item.Courts,
    members_count: item.MembersCount,
    players: parseMembers(item.Members),
    organizer: item.Organizers,
  }));

  res.json({ events: ratingEvents });
});

// POST /api/schedule/sync — refresh CR schedule + auto-create sessions
// for any rating events that don't already exist. Body: { refresh?:
// boolean } — pass refresh=false to skip the (slow) CR scrape and use
// whatever's cached.
router.post("/sync", async (req, res) => {
  const log: string[] = [];
  try {
    const refresh = req.body?.refresh !== false;
    const result = await syncFromCourtReserve({
      refresh,
      onLog: (line) => log.push(line),
    });
    res.json({ ...result, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof CrSyncError ? err.code : "unknown";

    // Fire-and-forget Discord alert. The most likely cause of a sync
    // failure is the CR Playwright profile losing its session (auth
    // cookie expiry, Cloudflare reset, etc.) — operators want to know
    // about that as soon as it happens, even if the dashboard click
    // showed an error chip locally.
    void sendDiscordAlert({
      title: "CourtReserve sync failed",
      level: "error",
      message:
        "Couldn't refresh today's CourtReserve schedule. The Playwright profile in `courtreserve-scheduler/` likely needs to re-authenticate (Cloudflare cookie expired, magic-link expired, etc.).",
      fields: [
        { name: "Error code", value: "`" + code + "`" },
        { name: "Details", value: "```\n" + msg.slice(0, 900) + "\n```" },
        ...(log.length > 0
          ? [{ name: "Last log lines", value: "```\n" + log.slice(-12).join("\n").slice(0, 900) + "\n```" }]
          : []),
        {
          name: "Fix",
          value:
            "On the recording machine: open `courtreserve-scheduler/` and re-run its login flow, or run `npm run sync:members -- --headed` from this project to drive Chromium headed against CR.",
        },
      ],
      dedupeKey: `cr-sync-failed:${code}`,
    });

    res.status(500).json({ error: msg, code });
  }
});

export default router;
