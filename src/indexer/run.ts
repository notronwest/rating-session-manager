// Continuous-footage game indexer driver (SP-11): segments -> occupancy gate ->
// detector -> game rows in a small JSON store. The detector is the existing
// detect_games.py signal, reached through scripts/videos/index_continuous.py.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { askOccupancy, type OccupancyAnswer } from "../services/lesson-match.js";
import { planWindows } from "./gate.js";
import { segmentsInRange } from "./segments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "../../scripts/videos");

/** A game as a pointer into segments — no footage is copied or re-encoded. */
export interface GameRow {
  court: string;
  /** Epoch seconds. */
  start: number;
  end: number;
  source_segment: string;
  offset: number;
  end_segment: string;
  end_offset: number;
  /** Capture ended while play was still going. Nothing else sets this. */
  unfinished: boolean;
  start_cut: "gap" | "window" | null;
  end_cut: "gap" | "window" | null;
}

export interface CourtStore {
  games: GameRow[];
  /** Where a still-open game began; the next run resumes here. */
  openTailStart: number | null;
  /** Keys (court@start) already chosen by the sampler. */
  sampled: string[];
  /** Epoch seconds: the end of the last window a run completed. Written only by
   *  a run that finished; a failed, partial or unreachable run leaves it alone.
   *  Absent in stores written before the nightly job — read as null. */
  indexed_through?: number | null;
}

/** Reported in `skipped`, but a clean outcome, not a hold. */
export const NO_SEGMENTS = "no segments in range";

export const gameKey = (g: Pick<GameRow, "court" | "start">) => `${g.court}@${Math.round(g.start)}`;

export function storePath(court: string, dir = process.env.INDEX_STORE_DIR || path.resolve(__dirname, "../../data/indexed-games")) {
  return path.join(dir, `${court}.json`);
}

export function loadStore(file: string): CourtStore {
  if (!fs.existsSync(file)) return { games: [], openTailStart: null, sampled: [], indexed_through: null };
  return { indexed_through: null, ...(JSON.parse(fs.readFileSync(file, "utf8")) as CourtStore) };
}

/** Mark [.., to] as looked at. Never moves backwards. */
function advance(store: CourtStore, to: number) {
  store.indexed_through = Math.max(store.indexed_through ?? 0, to);
}

export function saveStore(file: string, s: CourtStore) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

/** Merge new rows over old by key; a re-run of the same footage never duplicates. */
export function mergeGames(old: GameRow[], fresh: GameRow[]): GameRow[] {
  const by = new Map(old.map((g) => [gameKey(g), g]));
  for (const g of fresh) by.set(gameKey(g), g);
  return [...by.values()].sort((a, b) => a.start - b.start);
}

export interface DetectorResult { games: Omit<GameRow, "court">[]; open_tail_start: number | null }
export type Detector = (manifest: unknown, roiFile: string, captureEnded: boolean) => Promise<DetectorResult>;

function findPython(): string {
  const venv = path.join(SCRIPTS_DIR, "venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

export const pythonDetector: Detector = async (manifest, roiFile, captureEnded) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-court-"));
  const man = path.join(tmp, "manifest.json");
  const out = path.join(tmp, "result.json");
  fs.writeFileSync(man, JSON.stringify(manifest));
  const args = [path.join(SCRIPTS_DIR, "index_continuous.py"), "--manifest", man, "--roi", roiFile, "--out", out,
    "--rows-cache", path.resolve(__dirname, "../../data/indexer-rows-cache")];
  if (captureEnded) args.push("--capture-ended");
  await new Promise<void>((resolve, reject) => {
    const p = spawn(findPython(), args, { cwd: SCRIPTS_DIR, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`index_continuous.py exited ${c}`))));
  });
  try { return JSON.parse(fs.readFileSync(out, "utf8")) as DetectorResult; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
};

export interface IndexOptions {
  court: string;
  /** What Court Reserve calls it, e.g. "Court #4". */
  courtLabel: string;
  roiFile: string;
  /** Epoch seconds. */
  range: [number, number];
  files: { path: string; duration: number }[];
  captureEnded: boolean;
  maxStaleS: number;
  storeFile: string;
  log: (s: string) => void;
  ask?: (start: Date, end: Date) => Promise<OccupancyAnswer>;
  detect?: Detector;
}

export async function indexCourt(o: IndexOptions): Promise<{ added: number; skipped: string[] }> {
  const store = loadStore(o.storeFile);
  const from = store.openTailStart ?? o.range[0];
  const to = o.range[1];
  const ask = o.ask ?? ((s, e) => askOccupancy(s, e, process.env, { court: o.courtLabel, onlyTeaching: false }));

  // The gate reads the cached occupancy only. A failure to read is a skip.
  let plan;
  try {
    plan = planWindows(await ask(new Date(from * 1000), new Date(to * 1000)), [from, to], o.maxStaleS);
  } catch (e) {
    const why = `occupancy read failed: ${(e as Error).message} — range skipped`;
    o.log(why);
    return { added: 0, skipped: [why] };
  }
  plan.skipped.forEach((s) => o.log(`skip: ${s}`));
  if (plan.windows.length === 0) {
    // A confident empty answer ("no bookings, nothing skipped") is recorded as
    // indexed-with-no-games so the deletion job can tell it from "never indexed".
    // Anything skipped is unknown and leaves the store alone.
    if (plan.skipped.length === 0) { advance(store, to); saveStore(o.storeFile, store); }
    return { added: 0, skipped: plan.skipped };
  }

  const segments = segmentsInRange(o.files, o.court, from, to);
  if (segments.length === 0) {
    const why = NO_SEGMENTS;
    o.log(why);
    // The caller listed the footage directory successfully, so no segments is a
    // clean night (recorder off) — but only if the gate skipped nothing.
    if (plan.skipped.length === 0) { advance(store, to); saveStore(o.storeFile, store); }
    return { added: 0, skipped: [...plan.skipped, why] };
  }
  const res = await (o.detect ?? pythonDetector)({ segments, windows: plan.windows }, o.roiFile, o.captureEnded);
  const fresh = res.games.map((g) => ({ court: o.court, ...g }));
  store.games = mergeGames(store.games, fresh);
  store.openTailStart = res.open_tail_start;
  if (plan.skipped.length === 0) advance(store, to);
  saveStore(o.storeFile, store);
  o.log(`indexed ${fresh.length} game(s); open tail ${res.open_tail_start ?? "none"}`);
  return { added: fresh.length, skipped: plan.skipped };
}
