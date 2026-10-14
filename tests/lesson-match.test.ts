// The matching half of LP-07. Pure decisions only — no HTTP, no DB.
//
// The case that matters most is the last one: a stale cache must never be
// read as "there was no lesson". "I could not find one" and "there wasn't one"
// are different claims, and only the second is safe to act on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clubOffset, recordingWindow, classify,
  type OccupancyAnswer, type Occurrence,
} from "../src/services/lesson-match.js";

const occ = (o: Partial<Occurrence> = {}): Occurrence => ({
  occurrence_id: 62253023,
  reservation_type: "Private Drill Session",
  start_at: "2026-10-14T13:00:00+00:00",
  end_at: "2026-10-14T14:00:00+00:00",
  court_hint: "Court #4",
  multi_court: false,
  is_teaching: true,
  participants: [{ org_member_id: 6516368, name: "Karon Bernache" }],
  ...o,
});
const ans = (o: Partial<OccupancyAnswer> = {}): OccupancyAnswer => ({
  status: "one", occurrences: [occ()],
  refreshed_at: "2026-10-14T21:15:00Z", stale_seconds: 60, ok: true, ...o,
});

test("club offset follows daylight saving, it is not hardcoded", () => {
  // A fixed -04:00 would silently shift every November lesson by an hour.
  assert.equal(clubOffset("2026-10-14"), "-04:00");
  assert.equal(clubOffset("2026-01-14"), "-05:00");
});

test("the recording window comes from the filename plus the measured duration", () => {
  const w = recordingWindow("2026-10-14", "teaching-090449", 3911);
  assert.ok(w);
  assert.equal(w!.start.toISOString(), "2026-10-14T13:04:49.000Z");
  assert.equal(w!.end.toISOString(), "2026-10-14T14:10:00.000Z");
});

test("a filename with no timestamp is not guessed at", () => {
  assert.equal(recordingWindow("2026-10-14", "something-else", 60), null);
});

test("one teaching booking is a lesson", () => {
  const m = classify(ans(), 1800);
  assert.equal(m.kind, "lesson");
});

test("nothing booked means not a lesson", () => {
  assert.equal(classify(ans({ status: "none", occurrences: [] }), 1800).kind, "not-teaching");
});

test("two overlapping bookings are refused, never picked between", () => {
  // Today's 09:04-10:10 recording overlaps Karon's lesson and the booking
  // after it. Picking one would be asserting what the evidence cannot support.
  const m = classify(ans({ status: "ambiguous", occurrences: [occ(), occ({ occurrence_id: 2 })] }), 1800);
  assert.equal(m.kind, "ambiguous");
});

test("a booking across several courts is refused", () => {
  const m = classify(ans({ occurrences: [occ({ multi_court: true })] }), 1800);
  assert.equal(m.kind, "ambiguous");
});

test("a cache that has never refreshed yields unknown, NOT not-teaching", () => {
  // The live state for three days in October: the refresh had never completed.
  const m = classify(ans({ ok: false, refreshed_at: null, stale_seconds: null }), 1800);
  assert.equal(m.kind, "unknown");
});

test("a stale cache yields unknown, NOT not-teaching", () => {
  // The dangerous conflation. A stale cache looks exactly like an empty one,
  // and "no lesson" is the verdict that makes the job stop trying.
  const m = classify(ans({ stale_seconds: 7200 }), 1800);
  assert.equal(m.kind, "unknown");
  assert.match((m as { reason: string }).reason, /stale/);
});

test("a fresh cache inside the limit is trusted", () => {
  assert.equal(classify(ans({ stale_seconds: 1799 }), 1800).kind, "lesson");
});
