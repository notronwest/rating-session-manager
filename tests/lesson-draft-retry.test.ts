// Issue #143: failed structured drafts retry on their own.
// Every fixture here is INVENTED — this repo is public.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { retryFailedDrafts } from "../src/services/lesson-draft-retry.js";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[], failRead = false) {
  const from = (_t: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const b: any = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, _o: string, v: unknown) { filters.push((r) => (r[c] ?? null) !== v); return b; },
      lt(c: string, v: number) { filters.push((r) => (r[c] as number) < v); return b; },
      gte(c: string, v: number) { filters.push((r) => (r[c] as number) >= v); return b; },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        const out = failRead
          ? { data: null, error: { message: "boom" } }
          : { data: rows.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  };
  return { from } as any;
}

const NOW = new Date("2026-11-24T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const SEGS = [{ startS: 1, endS: 2, text: "keep your paddle up" }];

function lesson(id: string, over: Row = {}): Row {
  return {
    id, org_id: "org-1", transcript: "keep your paddle up", transcript_segments: SEGS,
    draft_v2_at: null, written_up_at: null, draft_v2_attempts: 1,
    draft_v2_failed_at: minsAgo(45), updated_at: minsAgo(45), ...over,
  };
}

function setup(rows: Row[], opts: { draftThrows?: boolean; failRead?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draft-retry-"));
  const drafted: string[] = [];
  const alerts: { dedupeKey?: string }[] = [];
  const deps = {
    db: fakeDb(rows, opts.failRead), orgId: "org-1", now: NOW,
    alertedFile: path.join(dir, "alerted.json"),
    draft: async (l: { id: string }) => {
      if (opts.draftThrows) throw new Error("function down");
      drafted.push(l.id);
      return { drafted: false, reason: "refused" };
    },
    alert: async (a: { dedupeKey?: string }) => { alerts.push(a); },
  };
  return { deps, drafted, alerts };
}

test("a refused lesson is retried after 30 minutes and not before", async () => {
  const early = setup([lesson("a", { draft_v2_failed_at: minsAgo(29), updated_at: minsAgo(29) })]);
  await retryFailedDrafts(early.deps);
  assert.deepEqual(early.drafted, []);
  const due = setup([lesson("a", { draft_v2_failed_at: minsAgo(30), updated_at: minsAgo(30) })]);
  await retryFailedDrafts(due.deps);
  assert.deepEqual(due.drafted, ["a"]);
});

test("a claim with no failure time waits for updated_at to be 30 minutes old", async () => {
  const fresh = setup([lesson("a", { draft_v2_failed_at: null, updated_at: minsAgo(5) })]);
  await retryFailedDrafts(fresh.deps);
  assert.deepEqual(fresh.drafted, []);
  const old = setup([lesson("a", { draft_v2_failed_at: null, updated_at: minsAgo(40) })]);
  await retryFailedDrafts(old.deps);
  assert.deepEqual(old.drafted, ["a"]);
});

test("a transcript that never had an attempt is drafted once it is 30 minutes old", async () => {
  const s = setup([lesson("a", { draft_v2_attempts: 0, draft_v2_failed_at: null, updated_at: minsAgo(31) })]);
  await retryFailedDrafts(s.deps);
  assert.deepEqual(s.drafted, ["a"]);
});

test("never called for drafted, written-up, three-attempt, no-segments or other-org lessons", async () => {
  const s = setup([
    lesson("drafted", { draft_v2_at: minsAgo(60) }),
    lesson("written", { written_up_at: minsAgo(60) }),
    lesson("spent", { draft_v2_attempts: 3 }),
    lesson("noseg", { transcript_segments: null }),
    lesson("emptyseg", { transcript_segments: [] }),
    lesson("notext", { transcript: null }),
    lesson("other", { org_id: "org-2" }),
  ]);
  await retryFailedDrafts(s.deps);
  assert.deepEqual(s.drafted, []);
});

test("at most 2 lessons per tick", async () => {
  const s = setup([lesson("a"), lesson("b"), lesson("c"), lesson("d")]);
  const r = await retryFailedDrafts(s.deps);
  assert.equal(s.drafted.length, 2);
  assert.equal(r.retried, 2);
});

test("a drafter error or a read error never throws", async () => {
  const thrown = setup([lesson("a")], { draftThrows: true });
  await assert.doesNotReject(retryFailedDrafts(thrown.deps));
  const unreadable = setup([lesson("a")], { failRead: true });
  const r = await retryFailedDrafts(unreadable.deps);
  assert.deepEqual(r, { retried: 0, alerted: 0 });
});

test("exactly one alert once a lesson has used its third attempt", async () => {
  const s = setup([lesson("a", { draft_v2_attempts: 3 })]);
  const first = await retryFailedDrafts(s.deps);
  const second = await retryFailedDrafts(s.deps);
  assert.equal(first.alerted, 1);
  assert.equal(second.alerted, 0);
  assert.equal(s.alerts.length, 1);
  assert.deepEqual(s.drafted, []);
});

test("no alert while attempts remain", async () => {
  const s = setup([lesson("a", { draft_v2_attempts: 2 })]);
  await retryFailedDrafts(s.deps);
  assert.equal(s.alerts.length, 0);
});
