// Recorder segments -> wall-clock instants (SP-11, D-0059).
//
// The recorder writes bounded MPEG-TS segments named for the court and the
// club-local wall-clock second they began: `<court>/<YYYY-MM-DD>/<court>-HHMMSS.ts`
// (the same convention the lesson matcher already reads). Pure — no ffprobe here;
// the caller supplies durations.
import path from "path";
import { clubOffset } from "../services/lesson-match.js";

export interface Segment {
  path: string;
  /** Epoch seconds the segment began. */
  start: number;
  /** Seconds of footage. */
  duration: number;
}

const NAME = /^(?<court>[a-z0-9]+)-(?<h>\d{2})(?<m>\d{2})(?<s>\d{2})\.(ts|mp4)$/i;

/** Start instant (epoch s) from a segment path, or null if it isn't one. */
export function segmentStart(file: string, court: string): number | null {
  const m = NAME.exec(path.basename(file));
  if (!m?.groups || m.groups.court.toLowerCase() !== court.toLowerCase()) return null;
  const date = path.basename(path.dirname(file));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = new Date(`${date}T${m.groups.h}:${m.groups.m}:${m.groups.s}${clubOffset(date)}`).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

/** Segments overlapping [from, to) epoch seconds, oldest first. */
export function segmentsInRange(
  files: { path: string; duration: number }[], court: string, from: number, to: number,
): Segment[] {
  const out: Segment[] = [];
  for (const f of files) {
    const start = segmentStart(f.path, court);
    if (start === null) continue;
    if (start < to && from < start + f.duration) out.push({ path: f.path, start, duration: f.duration });
  }
  return out.sort((a, b) => a.start - b.start);
}
