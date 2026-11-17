// One-off: give lessons that already have a transcript the timed segments that
// were computed and thrown away. Issue #130, D-0318 rule 6.
//
// WHAT IT WRITES: `lessons.transcript_segments`, and nothing else — never
// `transcript`, never `updated_at`, never a draft column. The attach rule
// ("already has a transcript; left as is") is not loosened: this is a separate,
// narrower writer that only fills an EMPTY segments column.
//
// WHEN IT SKIPS:
//   · the `.txt` on club storage does not match the stored transcript
//     (whitespace-normalised) — the times would belong to different text;
//   · there is no `.srt`, or it parses to no segments — no `[]` is ever written,
//     because an empty array would count as "has times";
//   · there is no `.txt` at all.
//
// IDEMPOTENT: it selects only rows whose segments are NULL, and the update
// itself is filtered on `transcript_segments IS NULL`, so a second run finds
// nothing and writes nothing.
//
// FAIL CLOSED ON AN UNMOUNTED NAS: if the transcripts directory is absent, it
// refuses rather than reporting every lesson as "no srt".
//
// Multi-file lessons: recording_ref names the LEAD file, so only that file's
// times are written (startS relative to it). Later chapters are not stitched.
//
// PUBLIC REPO: it reports counts only — no lesson ids, refs or text.

import fs from "fs";
import path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSrt } from "lesson-analyzer";

export interface SegmentsBackfillCounts {
  candidates: number;
  filled: number;
  skippedMismatch: number;
  noSrt: number;
  noTxt: number;
  badRef: number;
}

export interface SegmentsBackfillFiles {
  /** Contents of the file, or null when it does not exist. */
  read(file: string): string | null;
}

export const realFiles: SegmentsBackfillFiles = {
  read(file) {
    try { return fs.readFileSync(file, "utf8"); } catch { return null; }
  },
};

/** Whitespace-insensitive equality: whisper's line breaks are not content. */
export function normaliseText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** `teaching/<date>/<base>` → the `.txt` and `.srt` paths under the transcripts dir, or null. */
export function transcriptFilesForRef(transcriptsDir: string, ref: string): { txt: string; srt: string } | null {
  const m = /^teaching\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(ref);
  if (!m) return null;
  const dir = path.join(transcriptsDir, m[1]);
  return { txt: path.join(dir, `${m[2]}.txt`), srt: path.join(dir, `${m[2]}.srt`) };
}

export async function backfillSegments(opts: {
  db: Pick<SupabaseClient, "from">;
  transcriptsDir: string;
  files?: SegmentsBackfillFiles;
  dirExists?: (dir: string) => boolean;
  dryRun?: boolean;
}): Promise<SegmentsBackfillCounts> {
  const files = opts.files ?? realFiles;
  const dirExists = opts.dirExists ?? ((d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!dirExists(opts.transcriptsDir)) {
    throw new Error(`transcripts directory is not there (${opts.transcriptsDir}) — is the NAS mounted? Nothing written.`);
  }

  const { data, error } = await opts.db
    .from("lessons")
    .select("id, recording_ref, transcript")
    .not("recording_ref", "is", null)
    .not("transcript", "is", null)
    .is("transcript_segments", null);
  if (error) throw new Error(`could not read lessons: ${error.message}`);

  const rows = (data ?? []) as { id: string; recording_ref: string; transcript: string }[];
  const counts: SegmentsBackfillCounts = { candidates: rows.length, filled: 0, skippedMismatch: 0, noSrt: 0, noTxt: 0, badRef: 0 };

  for (const row of rows) {
    const paths = transcriptFilesForRef(opts.transcriptsDir, row.recording_ref);
    if (!paths) { counts.badRef++; continue; }
    const txt = files.read(paths.txt);
    if (txt === null) { counts.noTxt++; continue; }
    if (normaliseText(txt) !== normaliseText(row.transcript)) { counts.skippedMismatch++; continue; }
    const srt = files.read(paths.srt);
    const segments = srt === null ? [] : parseSrt(srt);
    if (segments.length === 0) { counts.noSrt++; continue; }
    if (opts.dryRun) { counts.filled++; continue; }
    const { error: upErr } = await opts.db
      .from("lessons")
      .update({ transcript_segments: segments })
      .eq("id", row.id)
      .is("transcript_segments", null);
    if (upErr) throw new Error(`segments update failed after ${counts.filled} filled: ${upErr.message}`);
    counts.filled++;
  }
  return counts;
}
