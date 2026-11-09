// What this repo depends on from the lesson analyzer, and nothing about how the
// analyzer works. D-0243 clause 3.
//
// WHY THESE FOUR TESTS AND NOT THE OLD TWENTY-NINE. Until 2026-11-08 the
// analyzer lived in this repo and its whole suite lived here with it. It is its
// own repo now, with its own CI, and duplicating those tests here would mean two
// copies of the same assertions drifting apart — the one failure mode a pinned
// dependency is supposed to remove. So what stays here is the CALLER's half:
// the document version this club will read, the symbols it imports, the refusal
// of a major it does not know, and the two ways the dependency could quietly
// stop being a dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ANALYZER_SCHEMA_VERSION,
  assertSupportedDocument,
  decodeArgs,
  probeDurationS,
  probeMeanVolumeDb,
  SILENCE_FLOOR_DB,
  transcribeAudio,
} from "lesson-analyzer";

const ROOT = path.join(import.meta.dirname, "..");

test("the analyzer this club has installed speaks a major it knows", () => {
  assert.match(ANALYZER_SCHEMA_VERSION, /^\d+\.\d+$/);
  // Fail closed (D-0243 clause 3). A newer MINOR is fine — sections are added
  // and existing ones keep their meaning — so this asserts the major only. The
  // day the analyzer ships 2.0, this is the test that stops the club reading a
  // document whose fields have moved, and the fix is reading the new contract,
  // not bumping this number.
  assert.equal(ANALYZER_SCHEMA_VERSION.split(".")[0], "1");
});

test("the caller refuses a document from a major it does not know", () => {
  assertSupportedDocument({ schema_version: ANALYZER_SCHEMA_VERSION });
  assertSupportedDocument({ schema_version: "1.9" });
  assert.throws(() => assertSupportedDocument({ schema_version: "2.0" }), /reads major 1 only/);
  assert.throws(() => assertSupportedDocument({}), /no usable schema_version/);
});

test("every symbol this job imports is still on the analyzer's published surface", () => {
  // A package rename or a dropped export breaks the live transcription at
  // runtime, not at install. This is the cheapest place to find that out.
  for (const [name, value] of Object.entries({
    transcribeAudio, decodeArgs, probeDurationS, probeMeanVolumeDb, assertSupportedDocument,
  })) {
    assert.equal(typeof value, "function", `${name} is no longer exported`);
  }
  assert.equal(typeof SILENCE_FLOOR_DB, "number");
});

test("the analyzer is pinned to a commit, and there is no second copy of it here", () => {
  // TWO WAYS A PINNED DEPENDENCY QUIETLY STOPS BEING ONE, and both have bitten
  // this fleet in other shapes:
  //
  //   1. The pin becomes a branch. `#main` means the live transcription job
  //      changes the next time anybody runs npm install, with no commit here
  //      and nothing to review. The whole point of the pin is that moving is a
  //      decision.
  //   2. Somebody copies the analyzer back in under src/. Then there are two
  //      copies, the imports still resolve, and the one being edited is not the
  //      one that runs. A catalogue mirrored into code goes stale silently.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const spec: string = pkg.dependencies?.["lesson-analyzer"] ?? "";
  assert.ok(spec, "lesson-analyzer is not a dependency of this repo");
  const ref = spec.split("#")[1] ?? "";
  assert.match(
    ref,
    /^[0-9a-f]{40}$/,
    `the analyzer must be pinned to a full commit sha, not "${ref}" — a branch would move the live job without a review`,
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, "src", "analyzer")),
    false,
    "src/analyzer exists again — the analyzer is a dependency now, and a second copy is the one that goes stale",
  );
});
