import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS_PATH = path.resolve(__dirname, "../../data/members.json");

const router = Router();

// GET /api/members — Return cached member list
router.get("/", (_req, res) => {
  if (!fs.existsSync(MEMBERS_PATH)) {
    return res.json({ members: [], error: "No member data. Run: python3 scripts/scrape-members.py --headed" });
  }

  try {
    const raw = fs.readFileSync(MEMBERS_PATH, "utf-8");
    const members = JSON.parse(raw);
    res.json({ members, updated: fs.statSync(MEMBERS_PATH).mtime.toISOString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ members: [], error: msg });
  }
});

// GET /api/members/search?q=name — Search members by name
router.get("/search", (req, res) => {
  const q = (req.query.q as string || "").toLowerCase().trim();
  if (!q) return res.json({ members: [] });

  if (!fs.existsSync(MEMBERS_PATH)) {
    return res.json({ members: [] });
  }

  const raw = fs.readFileSync(MEMBERS_PATH, "utf-8");
  const all = JSON.parse(raw) as Record<string, string>[];

  const matches = all.filter((m) => {
    const full = `${m["First Name"] || ""} ${m["Last Name"] || ""}`.toLowerCase();
    return full.includes(q);
  });

  res.json({ members: matches });
});

export default router;
