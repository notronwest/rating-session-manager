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
export const ANALYZER_SCHEMA_VERSION = "1.0";

export interface AnalyzerDocument {
  schema_version: string;
  /** What this document was asked for. A section is absent when it was not asked for. */
  asks: AnalyzerAsk[];
  result: "transcribed" | "silent" | "failed";
  source: {
    durationS: number | null;
    /** `-inf` rather than -Infinity so the document is JSON-safe as it stands. */
    meanVolumeDb: number | "-inf" | null;
  };
  transcript?: { text: string; words: number };
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
