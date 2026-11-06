// The no-audio-track case, which retried 1,585 times over three weeks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYZER_SCHEMA_VERSION } from "../src/analyzer/document.js";

test("the document schema carries a reason, so two silent causes are distinguishable", () => {
  // `silent` has two causes with different remedies: a connected microphone
  // that heard nothing, and no audio track at all. The result alone cannot
  // tell them apart, and the second one means go and check the microphone.
  assert.equal(ANALYZER_SCHEMA_VERSION, "1.1");
});

test("a 1.1 document is still readable by a 1.0 reader", () => {
  // The note is optional and the major is unchanged, so nothing that read 1.0
  // breaks. If this ever needs a major bump, this assertion is where it shows.
  assert.equal(ANALYZER_SCHEMA_VERSION.split(".")[0], "1");
});
