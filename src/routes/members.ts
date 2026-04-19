import { Router } from "express";
import { getSupabase, getOrgId } from "../supabase.js";

const router = Router();

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

export default router;
