// Nightly driver for the continuous-footage indexer (daemon#241).
//
// For each court the recorder writes, index everything since the store's
// `indexed_through`. Three outcomes besides "done", none of which advance it:
//   failed      — the indexer threw
//   unreachable — the footage directory is not there (NAS unmounted). That is
//                 NOT "no footage": an absent directory proves nothing.
//   held        — the occupancy gate could not answer, so the range is unknown
// A directory that exists with no segments in it IS a clean night.
import fs from "fs";
import path from "path";
import { segmentStart } from "./segments.js";
import { indexCourt, loadStore, NO_SEGMENTS, storePath, type IndexOptions } from "./run.js";

export interface NightlyCourt { court: string; label: string; dir: string }

export type NightlyOutcome =
  | { court: string; status: "done"; added: number }
  | { court: string; status: "failed" | "unreachable" | "held"; why: string };

/** `court4|Court #4|/path/to/court4;court2|Court #2|/path/to/court2` */
export function parseCourts(env: NodeJS.ProcessEnv): NightlyCourt[] {
  const root = env.INDEX_RECORDINGS_DIR || "/opt/wmpc/recordings";
  const spec = env.INDEX_COURTS || "court4|Court #4";
  return spec.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [court, label, dir] = s.split("|").map((x) => x.trim());
    return { court, label: label || court, dir: dir || path.join(root, court) };
  });
}

/** A segment can start this long before `from` and still overlap the range. */
const MAX_SEGMENT_S = 4 * 3600;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

export interface NightlyOptions {
  courts: NightlyCourt[];
  /** Epoch seconds. */
  now: number;
  /** First-ever run looks back this far. */
  lookbackS?: number;
  roiFor: (court: string) => string;
  durationOf: (file: string) => Promise<number>;
  indexOpts: Pick<IndexOptions, "maxStaleS" | "ask" | "detect">;
  storeFor?: (court: string) => string;
  log: (s: string) => void;
}

export async function runNightly(o: NightlyOptions): Promise<NightlyOutcome[]> {
  const out: NightlyOutcome[] = [];
  for (const c of o.courts) {
    const storeFile = (o.storeFor ?? storePath)(c.court);
    try {
      if (!fs.existsSync(c.dir)) {
        const why = `footage directory ${c.dir} is not reachable`;
        o.log(`${c.court}: ${why}`);
        out.push({ court: c.court, status: "unreachable", why });
        continue;
      }
      const to = Math.floor(o.now);
      const from = loadStore(storeFile).indexed_through ?? to - (o.lookbackS ?? 86400);
      const files: { path: string; duration: number }[] = [];
      for (const f of walk(c.dir)) {
        // Only recorder segments that could overlap the range are probed; a
        // stray .DS_Store or partial sync file must not fail the court.
        const start = segmentStart(f, c.court);
        if (start === null || start >= to || start + MAX_SEGMENT_S <= from) continue;
        try {
          const d = await o.durationOf(f);
          if (Number.isFinite(d)) files.push({ path: f, duration: d });
          else o.log(`${c.court}: skipped ${f} — no duration`);
        } catch (e) {
          o.log(`${c.court}: skipped ${f} — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const r = await indexCourt({
        ...o.indexOpts, court: c.court, courtLabel: c.label, roiFile: o.roiFor(c.court),
        range: [from, to], files, captureEnded: false, storeFile, log: o.log,
      });
      const held = r.skipped.filter((s) => s !== NO_SEGMENTS);
      out.push(held.length
        ? { court: c.court, status: "held", why: held.join("; ") }
        : { court: c.court, status: "done", added: r.added });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      o.log(`${c.court}: failed — ${why}`);
      out.push({ court: c.court, status: "failed", why });
    }
  }
  return out;
}
