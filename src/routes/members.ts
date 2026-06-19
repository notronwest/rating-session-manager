import { Router } from "express";
import { getSupabase, getOrgId } from "../supabase.js";
import { syncMembers, SyncError } from "../members/sync.js";
import { findOrCreatePlayer } from "../players/manual.js";

const router = Router();

let syncInFlight = false;

// GET /api/members — Return all active players for the org
router.get("/", async (_req, res) => {
  try {
    const orgId = await getOrgId();
    const { data, error } = await getSupabase()
      .from("players")
      .select("id, slug, display_name, cr_member_id, is_active")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("display_name");
    if (error) throw error;
    res.json({ members: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ members: [], error: msg });
  }
});

// GET /api/members/search?q=name — Case-insensitive partial match on display_name
router.get("/search", async (req, res) => {
  const q = ((req.query.q as string) || "").trim();
  if (!q) return res.json({ members: [] });

  try {
    const orgId = await getOrgId();
    const { data, error } = await getSupabase()
      .from("players")
      .select("id, slug, display_name, cr_member_id")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .ilike("display_name", `%${q}%`)
      .order("display_name")
      .limit(50);
    if (error) throw error;
    res.json({ members: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ members: [], error: msg });
  }
});

// POST /api/members — Create (or reuse) a player profile manually, for
// people who aren't in CourtReserve. Body: { displayName }. Search-or-create:
// if a player already matches the name (or a pbvision alias), that row is
// returned untouched; otherwise a new is_active row with no cr_member_id is
// inserted. The new profile is immediately readable by rating-hub.
router.post("/", async (req, res) => {
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
  if (!displayName) {
    return res.status(400).json({ error: "displayName is required" });
  }
  try {
    const orgId = await getOrgId();
    const { player, created } = await findOrCreatePlayer(orgId, displayName);
    res.status(created ? 201 : 200).json({ player, created });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /api/members/sync — Scrape CR members and insert new ones into Supabase
router.post("/sync", async (req, res) => {
  if (syncInFlight) {
    return res.status(409).json({ error: "A sync is already running. Try again once it finishes." });
  }
  syncInFlight = true;
  const dryRun = req.body?.dryRun === true;
  const headed = req.body?.headed === true;
  try {
    const result = await syncMembers({ dryRun, headed });
    res.json(result);
  } catch (err) {
    if (err instanceof SyncError) {
      res.status(500).json({ error: err.message, code: err.code });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  } finally {
    syncInFlight = false;
  }
});

export default router;
