// The analyzer's output contract. D-0243.
//
// An analyzer takes a video it does not own and returns ONE versioned document.
// This file is the document, and it is the only thing a caller is allowed to
// know about the analysis. Nothing here may import a club path, a database, or
// a schedule — see tests/analyzer-boundary.test.ts, which refuses it.
//
// WHY A VERSION, AND WHY THE CALLER REFUSES AN UNKNOWN MAJOR.
// D-0243 clause 3: new sections are added over time (cues, timeline, events,
// fptm, draft) and existing sections do not change meaning inside a major. A
// caller that reads a document from a newer major would be guessing at fields
// whose meaning moved, so it refuses instead. Fail closed, like camd's guard.

/** Everything an analyzer can be asked for. Only `transcript` is implemented here. */
export type AnalyzerAsk = "transcript" | "cues" | "timeline" | "events" | "fptm" | "draft";

/** `major.minor`. Bump the minor to add a section; the major to change one. */
export const ANALYZER_SCHEMA_VERSION = "1.2";

/**
 * One timed stretch of speech. Times are seconds from the start of the media,
 * as floats, because that is what every later section needs to point AT the
 * video: `cues` is a filtered, labelled view of these, and `timeline` is their
 * gaps and clusters. Added in 1.2.
 *
 * WHY THIS EXISTS AT ALL. Whisper has always written an `.srt` beside the
 * transcript and the document never carried it, so every timed output on the
 * roadmap — cues, the drill timeline, per-student events — had no times to be
 * built from and a caller could not have pointed a clip at a moment. The
 * timings were being computed and thrown away.
 */
export interface TranscriptSegment {
  startS: number;
  endS: number;
  text: string;
}

export interface AnalyzerDocument {
  schema_version: string;
  /**
   * Whose job this was. D-0243 clause 4: tenant-scoped from the first line,
   * not retrofitted — so it is required, it is on the document as well as the
   * input, and the analyzer refuses a job without one. A stored or forwarded
   * document that cannot say whose it is cannot be isolated by default, which
   * is the whole of the "opt-in, isolated" rule.
   */
  tenant: string;
  /** What this document was asked for. A section is absent when it was not asked for. */
  asks: AnalyzerAsk[];
  result: "transcribed" | "silent" | "failed";
  /**
   * Set when the document arrived through the async job surface. `id` is stable
   * across callback deliveries and `attempt` counts them, which is what lets a
   * receiver write once and ignore a replay (D-0243's unsettled item 2: the
   * Academy's draft columns are write-once, so a replayed callback would
   * otherwise freeze the wrong draft permanently). Absent on an in-process call.
   */
  job?: { id: string; attempt: number };
  source: {
    durationS: number | null;
    /** `-inf` rather than -Infinity so the document is JSON-safe as it stands. */
    meanVolumeDb: number | "-inf" | null;
  };
  transcript?: {
    text: string;
    words: number;
    /** The timed segments, in order. Added in 1.2; absent when unparseable. */
    segments?: TranscriptSegment[];
    /** The same timings as a SubRip document, for a caller that stores subtitles. */
    srt?: string;
  };
  /** Why this document says what it says, in plain words, for a human reading
   *  the record. Added in 1.1: `silent` has two causes with different remedies
   *  — a connected microphone that heard nothing, and no audio track at all —
   *  and the result alone cannot tell them apart. Optional, so a 1.0 reader is
   *  unaffected. */
  note?: string;
  /** Set only when `result` is `failed`. The caller decides whether to retry. */
  error?: string;
  engine: { model: string; vad: string; tookS: number };
  at: string;
}

export function schemaMajor(version: string): number {
  const n = Number(version.split(".")[0]);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * The caller's gate. Throws unless the document's major is one this caller was
 * written against. A malformed or missing version is refused too — an unversioned
 * document is not an old document, it is an unknown one.
 */
export function assertSupportedDocument(
  doc: { schema_version?: unknown },
  supportedMajors: number[] = [schemaMajor(ANALYZER_SCHEMA_VERSION)],
): void {
  const v = doc?.schema_version;
  if (typeof v !== "string" || !/^\d+\.\d+$/.test(v)) {
    throw new Error(`analyzer document has no usable schema_version (got ${JSON.stringify(v)})`);
  }
  const major = schemaMajor(v);
  if (!supportedMajors.includes(major)) {
    throw new Error(
      `analyzer document is schema ${v}; this caller reads major ${supportedMajors.join(", ")} only`,
    );
  }
}

/**
 * A tenant id the analyzer will accept. Refused rather than defaulted: a job
 * with no tenant is the retrofit D-0243 clause 4 forbids, and "" or "default"
 * is how one customer's lessons end up in another's bucket.
 *
 * Deliberately narrow — it is an identifier a caller chose, and it ends up in
 * log lines and (later) a store key, so it may not carry a path separator, a
 * space or a control character.
 */
export function assertTenant(tenant: unknown): string {
  if (typeof tenant !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(tenant)) {
    throw new Error(
      `a job needs a tenant id (2-64 chars, letters, digits, - and _); got ${JSON.stringify(tenant)}`,
    );
  }
  return tenant;
}
