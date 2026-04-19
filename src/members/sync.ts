// Shared sync logic: scrape CourtReserve members, compare against Supabase
// players, insert only new rows. Used by both the CLI (scripts/sync-members.ts)
// and the POST /api/members/sync route.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSupabase, getOrgId } from "../supabase.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRAPER = path.join(ROOT, "scripts", "scrape-members.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

type CRMember = {
  "First Name"?: string;
  "Last Name"?: string;
  "Member #"?: string;
};

type Player = {
  id: string;
  slug: string;
  display_name: string;
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
  inserted: { display_name: string; cr_member_id: string; slug: string }[];
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
      // Keep only last ~4KB for error reporting
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
    .select("id, slug, display_name, cr_member_id")
    .eq("org_id", orgId);
  if (pErr || !players) throw new SyncError("fetch_failed", `Failed to fetch players: ${pErr?.message}`);

  const byCrId = new Map<string, Player>();
  const byName = new Map<string, Player>();
  const existingSlugs = new Set<string>();
  for (const p of players as Player[]) {
    if (p.cr_member_id) byCrId.set(p.cr_member_id, p);
    byName.set(normalize(p.display_name), p);
    existingSlugs.add(p.slug);
  }

  const toInsert: { org_id: string; slug: string; display_name: string; cr_member_id: string }[] = [];
  let skipped = 0;
  const mintedSlugs = new Set<string>();

  for (const m of crMembers) {
    const first = (m["First Name"] || "").trim();
    const last = (m["Last Name"] || "").trim();
    const crId = (m["Member #"] || "").trim();
    const fullName = `${first} ${last}`.trim();
    if (!crId || !fullName) continue;

    if (byCrId.has(crId) || byName.has(normalize(fullName))) {
      skipped++;
      continue;
    }

    const base = slugify(fullName) || `player-${crId}`;
    let slug = base;
    let n = 2;
    while (existingSlugs.has(slug) || mintedSlugs.has(slug)) {
      slug = `${base}-${n++}`;
    }
    mintedSlugs.add(slug);
    toInsert.push({ org_id: orgId, slug, display_name: fullName, cr_member_id: crId });
  }

  onLog(`Existing players: ${players.length}, skipped: ${skipped}, new: ${toInsert.length}`);

  if (toInsert.length && !dryRun) {
    const { error: insErr } = await getSupabase().from("players").insert(toInsert);
    if (insErr) throw new SyncError("insert_failed", `Insert failed: ${insErr.message}`);
  }

  return {
    scraped: crMembers.length,
    existing: players.length,
    skipped,
    inserted: toInsert.map(({ display_name, cr_member_id, slug }) => ({ display_name, cr_member_id, slug })),
    dryRun,
  };
}
