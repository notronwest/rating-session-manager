// Failed structured drafts retry on their own (#143).
//
// `draftStructured` runs once, right after a transcript attaches. When the
// model's reply fails validation the drafter records the failure and counts the
// attempt, but nothing called it again until a hand re-run. This sweep is that
// call: on each transcription tick it finds lessons still waiting on a draft and
// asks the SAME drafter again. It owns no attempt count — the drafter claims and
// caps attempts itself (three); this file only reads them, never writes them.
//
// It FAILS OPEN: nothing thrown here may reach the tick, because the tick's job
// is transcribing and attaching.

import fs from "fs";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { draftStructured } from "./lesson-transcribe.js";
import { sendDiscordAlert, type DiscordAlert } from "./discord-alert.js";

export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 30 * 60 * 1000;
export const MAX_PER_TICK = 2;

interface Candidate {
  id: string;
  written_up_at: string | null;
  draft_v2_attempts: number | null;
  draft_v2_failed_at: string | null;
  updated_at: string | null;
  transcript_segments: unknown;
}

export interface DraftRetryDeps {
  db: Pick<SupabaseClient, "from">;
  orgId: string;
  now?: Date;
  draft?: (lesson: { id: string; written_up_at: string | null }) => Promise<{ drafted: boolean; reason?: string }>;
  alert?: (a: DiscordAlert) => Promise<unknown>;
  log?: (line: string) => void;
  /** Where lessons already alerted about are remembered, so each alerts once. */
  alertedFile: string;
}

function readAlerted(file: string): Set<string> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}

function writeAlerted(file: string, ids: Set<string>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...ids]));
}

/** Whether enough quiet time has passed since the lesson last changed. */
function settled(row: Candidate, now: Date): boolean {
  // A recorded failure says exactly when to count from. Without one, either the
  // transcript is fresh or a claim may still be running: wait on updated_at.
  const stamp = row.draft_v2_failed_at ?? row.updated_at;
  if (!stamp) return false;
  const t = Date.parse(stamp);
  return Number.isFinite(t) && now.getTime() - t >= RETRY_AFTER_MS;
}

/** Retry waiting drafts, then alert once for any lesson out of attempts. Never throws. */
export async function retryFailedDrafts(deps: DraftRetryDeps): Promise<{ retried: number; alerted: number }> {
  const log = deps.log ?? (() => {});
  const result = { retried: 0, alerted: 0 };
  try {
    const now = deps.now ?? new Date();
    const draft = deps.draft ?? ((l) => draftStructured(l));
    const alert = deps.alert ?? sendDiscordAlert;

    const { data, error } = await deps.db
      .from("lessons")
      .select("id, written_up_at, draft_v2_attempts, draft_v2_failed_at, updated_at, transcript_segments")
      .eq("org_id", deps.orgId)
      .not("transcript", "is", null)
      .not("transcript_segments", "is", null)
      .is("draft_v2_at", null)
      .is("written_up_at", null)
      .lt("draft_v2_attempts", MAX_ATTEMPTS);
    if (error) throw new Error(`could not read lessons waiting on a draft: ${error.message}`);

    const waiting = ((data ?? []) as Candidate[])
      .filter((r) => Array.isArray(r.transcript_segments) && r.transcript_segments.length > 0)
      .filter((r) => settled(r, now))
      .slice(0, MAX_PER_TICK);

    for (const row of waiting) {
      try {
        const d = await draft({ id: row.id, written_up_at: row.written_up_at });
        result.retried++;
        log(`draft retry: ${d.drafted ? "drafted" : `not drafted (${d.reason ?? "no reason given"})`}`);
      } catch (err) {
        result.retried++;
        log(`draft retry failed: ${(err as Error).message}`);
      }
    }

    // Out of attempts and still no draft: say so once per lesson.
    const { data: spent, error: spentErr } = await deps.db
      .from("lessons")
      .select("id")
      .eq("org_id", deps.orgId)
      .not("transcript", "is", null)
      .is("draft_v2_at", null)
      .is("written_up_at", null)
      .gte("draft_v2_attempts", MAX_ATTEMPTS);
    if (spentErr) throw new Error(`could not read lessons out of attempts: ${spentErr.message}`);
    const alerted = readAlerted(deps.alertedFile);
    for (const { id } of (spent ?? []) as { id: string }[]) {
      if (alerted.has(id)) continue;
      // Record first: a repeat alert is worse than a missed one, and the next
      // lesson to run out of attempts is still caught on its own turn.
      alerted.add(id);
      writeAlerted(deps.alertedFile, alerted);
      await alert({
        title: "A lesson draft gave up after three tries",
        level: "warning",
        message: "The automatic draft for one lesson was refused three times and will not be retried again. It needs a coach to write it up by hand, or a manual re-run.",
        fields: [{ name: "Lesson", value: id }],
        dedupeKey: `lesson-draft-exhausted:${id}`,
      });
      result.alerted++;
    }
  } catch (err) {
    log(`draft retry skipped: ${(err as Error).message}`);
  }
  return result;
}
