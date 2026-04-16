import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

export default router;
