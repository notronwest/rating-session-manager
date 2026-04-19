// Shared sync logic: scrape CourtReserve members, reconcile against
// Supabase `players`, inserting new rows and filling in missing email /
// cr_member_id / display_name on existing rows. Used by both the CLI
// (scripts/sync-members.ts) and POST /api/members/sync.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSupabase, getOrgId } from "../supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRAPER = path.join(ROOT, "scripts", "scrape-members.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

type CRMember = Record<string, string | undefined>;

type Player = {
  id: string;
  slug: string;
  display_name: string;
  email: string | null;
  cr_member_id: string | null;
};

export type SyncOptions = {
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

// CR exports use slightly different column labels from version to version
// ("Email", "Email Address", etc.). Pick the first non-empty variant.
function getField(m: CRMember, ...keys: string[]): string {
  for (const k of keys) {
    const v = m[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function runScrape(opts: { headed: boolean; onLog: (line: string) => void }): Promise<CRMember[]> {
  return new Promise((resolve, reject) => {
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const args = [SCRAPER];
    if (opts.headed) args.push("--headed");
    const proc = spawn(python, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
      text.split(/\r?\n/).forEach((line: string) => {
        if (line.trim()) opts.onLog(line);
      });
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new SyncError("scrape_failed", `scrape-members.py exited with code ${code}\n${stderrTail}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new SyncError("parse_failed", `Failed to parse scraper output as JSON: ${(e as Error).message}`));
      }
    });
  });
}

export async function syncMembers(options: SyncOptions = {}): Promise<SyncResult> {
  const { headed = false, dryRun = false, onLog = () => {} } = options;

  const orgId = await getOrgId();
  onLog("Running CR members scrape...");
  const crMembers = await runScrape({ headed, onLog });
  onLog(`Scraped ${crMembers.length} members from CourtReserve`);

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
    const first = getField(m, "First Name");
    const last = getField(m, "Last Name");
    const crId = getField(m, "Member #", "MemberNumber");
    const emailRaw = getField(m, "Email", "Email Address");
    const email = emailRaw ? emailRaw.toLowerCase() : "";
    const fullName = `${first} ${last}`.trim();

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
