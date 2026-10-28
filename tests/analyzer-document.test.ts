// D-0243 clause 3: one versioned document out, and a caller refuses a major it
// was not written against rather than guessing at fields whose meaning moved.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYZER_SCHEMA_VERSION, assertSupportedDocument, schemaMajor,
} from "../src/analyzer/document.js";
import { decodeArgs, meanVolumeForDocument, SILENCE_FLOOR_DB } from "../src/analyzer/transcribe.js";

test("the document carries a major.minor version", () => {
  assert.match(ANALYZER_SCHEMA_VERSION, /^\d+\.\d+$/);
  assert.equal(schemaMajor(ANALYZER_SCHEMA_VERSION), 1);
});

test("a caller accepts its own major, including a later minor", () => {
  assertSupportedDocument({ schema_version: ANALYZER_SCHEMA_VERSION });
  // A minor adds a section (cues, timeline, fptm) without changing one.
  assertSupportedDocument({ schema_version: "1.7" });
});

test("a caller refuses a major it does not know", () => {
  assert.throws(() => assertSupportedDocument({ schema_version: "2.0" }), /reads major 1 only/);
});

test("an unversioned document is unknown, not old", () => {
  assert.throws(() => assertSupportedDocument({}), /no usable schema_version/);
  assert.throws(() => assertSupportedDocument({ schema_version: "1" }), /no usable schema_version/);
  assert.throws(() => assertSupportedDocument({ schema_version: 1 as unknown as string }),
    /no usable schema_version/);
});

test("digital silence is JSON-safe in the document", () => {
  // -Infinity serializes as null, which would read as "unmeasured" rather than
  // "no audio at all" — the 09-27 clinic is exactly that file.
  assert.equal(meanVolumeForDocument(-Infinity), "-inf");
  assert.equal(meanVolumeForDocument(null), null);
  assert.equal(meanVolumeForDocument(-91.2), -91.2);
  assert.ok(SILENCE_FLOOR_DB > -91.2);
});

test("the VAD flags travel with the analyzer, not the club", () => {
  const args = decodeArgs(
    { whisperBin: "w", ffmpegBin: "f", ffprobeBin: "p", modelPath: "/m/model.bin",
      vadModelPath: "/m/vad.bin", threads: 4 },
    "/tmp/a.wav", "/tmp/out",
  );
  assert.ok(args.includes("--vad"));
  assert.deepEqual(args.slice(args.indexOf("-mc"), args.indexOf("-mc") + 2), ["-mc", "0"]);
});
