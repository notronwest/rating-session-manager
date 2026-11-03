// The sampler (SP-11): detected games are candidates, not uploads. Pick a
// random subset per month inside a pb.vision credits budget; players never
// know which. Reproducible from a seed so a choice can be audited later.
import { createHash } from "crypto";

export interface SampleResult {
  /** Candidate keys chosen for upload. */
  chosen: string[];
  month: string;
  budget: number;
  /** Echoed so the audit trail carries what produced the choice. */
  seed: string;
}

const rank = (seed: string, month: string, key: string) =>
  createHash("sha256").update(`${seed}|${month}|${key}`).digest("hex");

/**
 * Choose which of a month's candidates to upload.
 *
 * Pure function of (seed, month, candidate keys, budget): same inputs, same
 * answer. `alreadyChosen` are kept no matter what — a game already uploaded
 * can't be un-uploaded — and count against the budget, so re-running mid-month
 * as more games arrive tops up without exceeding it.
 */
export function sampleMonth(opts: {
  seed: string; month: string; budget: number;
  candidates: string[]; alreadyChosen?: string[];
}): SampleResult {
  const { seed, month, budget } = opts;
  if (!seed) throw new Error("sampler seed is not set — choices would not be reproducible");
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`sampler budget must be a non-negative integer, got ${budget}`);
  const have = new Set(opts.alreadyChosen ?? []);
  const room = Math.max(0, budget - have.size);
  const picked = [...new Set(opts.candidates)]
    .filter((k) => !have.has(k))
    .sort((a, b) => rank(seed, month, a).localeCompare(rank(seed, month, b)))
    .slice(0, room);
  return { chosen: [...have, ...picked], month, budget, seed };
}

/** Budget + seed come from config, never a constant. Fails loudly when unset. */
export function samplerConfig(env: NodeJS.ProcessEnv = process.env): { budget: number; seed: string } {
  const raw = env.PBV_SAMPLE_BUDGET_MONTHLY;
  const seed = env.PBV_SAMPLE_SEED;
  if (raw === undefined || raw === "") throw new Error("PBV_SAMPLE_BUDGET_MONTHLY is not set — the monthly pb.vision budget is configuration, not a default");
  if (!seed) throw new Error("PBV_SAMPLE_SEED is not set");
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget < 0) throw new Error(`PBV_SAMPLE_BUDGET_MONTHLY must be a non-negative integer, got "${raw}"`);
  return { budget, seed };
}
