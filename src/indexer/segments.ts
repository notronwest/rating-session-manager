// Recorder segments -> wall-clock instants (SP-11, D-0059).
//
// Two names are read. The continuous recorder writes
// `<court>/segments/<UTC date>/<court>-<YYYYMMDDTHHMMSSZ>.ts` (court + UTC start,
// D-0059 rule 2); the lesson mp4s use the club-local form
// `<court>/<YYYY-MM-DD>/<court>-HHMMSS.ts`. Pure — no ffprobe here; the caller
// supplies durations.
import path from "path";
import { clubOffset } from "../services/lesson-match.js";

export interface Segment {
  path: string;
  /** Epoch seconds the segment began. */
  start: number;
  /** Seconds of footage. */
  duration: number;
}

const UTC_NAME = /^(?<court>[a-z0-9]+)-(?<y>\d{4})(?<mo>\d{2})(?<d>\d{2})T(?<h>\d{2})(?<m>\d{2})(?<s>\d{2})Z\.(ts|mp4)$/i;
const NAME = /^(?<court>[a-z0-9]+)-(?<h>\d{2})(?<m>\d{2})(?<s>\d{2})\.(ts|mp4)$/i;

/** Start instant (epoch s) from a segment path, or null if it isn't one. */
export function segmentStart(file: string, court: string): number | null {
  const u = UTC_NAME.exec(path.basename(file));
  if (u?.groups) {
    if (u.groups.court.toLowerCase() !== court.toLowerCase()) return null;
    const g = u.groups;
    const t = Date.parse(`${g.y}-${g.mo}-${g.d}T${g.h}:${g.m}:${g.s}Z`);
    return Number.isNaN(t) ? null : t / 1000;
  }
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
