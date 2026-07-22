// Shared sync logic: pull the CourtReserve member roster from the shared
// courtreserve-api service, reconcile against Supabase `players`, inserting new
// rows and filling in missing email / cr_member_id / display_name on existing
// rows. Used by both the CLI (scripts/sync-members.ts) and POST /api/members/sync.
//
// Source: courtreserve-api GET /memberships/records — one row per membership
// assignment since inception, so we dedupe to one row per member (by CR member
// number, preferring a row that carries an email). No Python / Playwright /
// courtreserve-scheduler sibling on this side.

import { getSupabase, getOrgId } from "../supabase.js";

// courtreserve-api HTTP service (see ../courtreserve-api). Same config the
// schedule sync uses — CRAPI_URL base + CRAPI_KEY shared secret (X-API-Key).
const CRAPI_URL = (process.env.CRAPI_URL || "").replace(/\/+$/, "");
const CRAPI_KEY = process.env.CRAPI_KEY || "";
// The members report drives a real browser scrape on the service (up to ~2 min),
// so allow a generous timeout before aborting.
const CRAPI_TIMEOUT_MS = 180_000;

// One CR membership-assignment record from /memberships/records (subset we use).
interface CrapiMemberRecord {
  member_number: string | number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

// One deduped member, reconciled below against the players table.
interface MemberRow {
  firstName: string;
  lastName: string;
  crId: string;
  email: string;
}

type Player = {
  id: string;
  slug: string;
  display_name: string;
  email: string | null;
  cr_member_id: string | null;
};

export type SyncOptions = {
  /** @deprecated no-op — the browser now runs on the courtreserve-api service, not here. */
  headed?: boolean;
  dryRun?: boolean;
  onLog?: (line: string) => void;
};

export type SyncResult = {
  scraped: number;
  existing: number;
  skipped: number;
  updated: number;
  inserted: { display_name: string; cr_member_id: string; slug: string; email: string | null }[];
  errors: { displayName: string; error: string }[];
  dryRun: boolean;
};

export class SyncError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Pull the full membership-assignment feed from courtreserve-api and dedupe it
// to one row per member (keyed by CR member number, preferring a row that
// carries an email). Throws SyncError on any config/transport/parse failure.
async function fetchMembers(onLog: (line: string) => void): Promise<MemberRow[]> {
  if (!CRAPI_URL || !CRAPI_KEY) {
    throw new SyncError(
      "crapi_not_configured",
      "CRAPI_URL and CRAPI_KEY must be set to reach the courtreserve-api service (see .env.template).",
    );
  }

  const url = `${CRAPI_URL}/memberships/records`;
  onLog("Fetching member roster from courtreserve-api…");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAPI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-API-Key": CRAPI_KEY }, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new SyncError(
      aborted ? "crapi_timeout" : "crapi_unreachable",
      aborted
        ? `courtreserve-api did not respond within ${CRAPI_TIMEOUT_MS / 1000}s at ${CRAPI_URL}.`
        : `Could not reach courtreserve-api at ${CRAPI_URL}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new SyncError("crapi_unauthorized", "courtreserve-api rejected CRAPI_KEY (401).");
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new SyncError(
      "crapi_error",
      `courtreserve-api /memberships/records returned HTTP ${res.status}${body ? `: ${body}` : ""}`,
    );
  }

  let items: unknown;
  try {
    const payload = (await res.json()) as { items?: unknown };
    items = payload?.items;
  } catch (err) {
    throw new SyncError("crapi_bad_json", `courtreserve-api returned invalid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(items)) {
    throw new SyncError("crapi_bad_json", "courtreserve-api /memberships/records response had no `items` array.");
  }

  // Dedupe: many assignment rows per member. Keep one per CR member number,
  // filling in a missing email from a later row when the first one we saw lacked it.
  const byMember = new Map<string, MemberRow>();
  for (const rec of items as CrapiMemberRecord[]) {
    const crId = rec?.member_number == null ? "" : String(rec.member_number).trim();
    const firstName = (rec?.first_name || "").trim();
    const lastName = (rec?.last_name || "").trim();
    const email = (rec?.email || "").trim().toLowerCase();
    if (!crId || (!firstName && !lastName)) continue;

    const existing = byMember.get(crId);
    if (!existing) {
      byMember.set(crId, { firstName, lastName, crId, email });
    } else if (!existing.email && email) {
      existing.email = email;
    }
  }

  const rows = [...byMember.values()];
  onLog(`courtreserve-api returned ${(items as unknown[]).length} assignment rows → ${rows.length} distinct members.`);
  return rows;
}

export async function syncMembers(options: SyncOptions = {}): Promise<SyncResult> {
  const { dryRun = false, onLog = () => {} } = options;

  const orgId = await getOrgId();
  const crMembers = await fetchMembers(onLog);
  onLog(`Fetched ${crMembers.length} members from courtreserve-api`);

  const { data: players, error: pErr } = await getSupabase()
    .from("players")
    .select("id, slug, display_name, email, cr_member_id")
    .eq("org_id", orgId);
  if (pErr || !players) throw new SyncError("fetch_failed", `Failed to fetch players: ${pErr?.message}`);

  const byCrId = new Map<string, Player>();
  const byEmail = new Map<string, Player>();
  const byName = new Map<string, Player>();
  const existingSlugs = new Set<string>();
  for (const p of players as Player[]) {
    if (p.cr_member_id) byCrId.set(p.cr_member_id, p);
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
    byName.set(normalize(p.display_name), p);
    existingSlugs.add(p.slug);
  }

  type Update = { id: string; patch: Partial<Pick<Player, "email" | "cr_member_id" | "display_name">> };
  const updates: Update[] = [];
  const toInsert: { org_id: string; slug: string; display_name: string; cr_member_id: string; email: string | null }[] = [];
  const mintedSlugs = new Set<string>();
  let skipped = 0;

  for (const m of crMembers) {
    const crId = m.crId;
    const email = m.email;
    const fullName = `${m.firstName} ${m.lastName}`.trim();

    if (!fullName || !crId) continue;

    // Match existing player: email > cr_member_id > display_name
    let existing: Player | undefined =
      (email ? byEmail.get(email) : undefined) ??
      byCrId.get(crId) ??
      byName.get(normalize(fullName));

    if (existing) {
      skipped++;
      const patch: Update["patch"] = {};
      if (email && !existing.email) patch.email = email;
      if (crId && !existing.cr_member_id) patch.cr_member_id = crId;
      if (fullName && normalize(existing.display_name) !== normalize(fullName) && !existing.display_name) {
        patch.display_name = fullName;
      }
      if (Object.keys(patch).length > 0) updates.push({ id: existing.id, patch });
      continue;
    }

    const base = slugify(fullName) || `player-${crId}`;
    let slug = base;
    let n = 2;
    while (existingSlugs.has(slug) || mintedSlugs.has(slug)) {
      slug = `${base}-${n++}`;
    }
    mintedSlugs.add(slug);
    toInsert.push({
      org_id: orgId,
      slug,
      display_name: fullName,
      cr_member_id: crId,
      email: email || null,
    });
  }

  onLog(`Existing players: ${players.length} · skipped: ${skipped} · to-insert: ${toInsert.length} · to-update: ${updates.length}`);

  const inserted: SyncResult["inserted"] = [];
  const errors: SyncResult["errors"] = [];
  let updatedCount = 0;

  if (!dryRun) {
    // Per-row inserts so one duplicate doesn't kill the whole batch.
    for (const row of toInsert) {
      const { error: insErr } = await getSupabase().from("players").insert(row);
      if (insErr) {
        // On conflict, try to find an existing player matching whatever we have
        // (email / cr_member_id / slug) and record an update so we still link it.
        const { data: conflict } = await getSupabase()
          .from("players")
          .select("id, slug, display_name, email, cr_member_id")
          .eq("org_id", orgId)
          .or(
            [
              row.email ? `email.ilike.${row.email}` : null,
              `cr_member_id.eq.${row.cr_member_id}`,
              `slug.eq.${row.slug}`,
            ].filter(Boolean).join(","),
          )
          .maybeSingle();
        if (conflict) {
          const patch: Update["patch"] = {};
          if (row.email && !(conflict as Player).email) patch.email = row.email;
          if (row.cr_member_id && !(conflict as Player).cr_member_id) patch.cr_member_id = row.cr_member_id;
          if (Object.keys(patch).length > 0) updates.push({ id: (conflict as Player).id, patch });
          onLog(`  ${row.display_name}: insert hit existing row (${insErr.message}) — recording update instead`);
          skipped++;
        } else {
          errors.push({ displayName: row.display_name, error: insErr.message });
          onLog(`  Insert failed for ${row.display_name}: ${insErr.message}`);
        }
      } else {
        inserted.push(row);
      }
    }

    // Apply patches to existing rows.
    for (const u of updates) {
      const { error: upErr } = await getSupabase().from("players").update(u.patch).eq("id", u.id);
      if (upErr) {
        errors.push({ displayName: `player ${u.id}`, error: upErr.message });
        onLog(`  Update failed for ${u.id}: ${upErr.message}`);
      } else {
        updatedCount++;
      }
    }
  }

  return {
    scraped: crMembers.length,
    existing: players.length,
    skipped,
    updated: updatedCount,
    inserted: inserted.map(({ display_name, cr_member_id, slug, email }) => ({ display_name, cr_member_id, slug, email })),
    errors,
    dryRun,
  };
}
