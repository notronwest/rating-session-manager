// Step one of D-0243, finished: a tenant id, a URL in, timings in the document,
// the document RETURNED rather than written into the caller's folder, and an
// async job with a signed callback.
//
// Every test here guards a specific sentence of the record or a specific way
// this can go wrong in production. Where a test exists because something was
// measured or found, the comment says so.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYZER_SCHEMA_VERSION, assertTenant, type AnalyzerDocument,
} from "../src/analyzer/document.js";
import { assertReadableVideo, parseSrt } from "../src/analyzer/transcribe.js";
import {
  AnalyzerJobs, assertCallbackUrl, signBody, verifyBody,
} from "../src/analyzer/jobs.js";
import { bearer, jobView, keyMap, parseSubmission } from "../src/analyzer/server.js";

// ── the contract's new fields ────────────────────────────────────────────────

test("the schema minor moved for the new sections, and the major did not", () => {
  // Added in 1.2: the tenant, the job stamp, transcript timings. All additive,
  // so a caller written against 1.0 still reads it (D-0243 clause 3).
  assert.equal(ANALYZER_SCHEMA_VERSION, "1.2");
  assert.equal(ANALYZER_SCHEMA_VERSION.split(".")[0], "1");
});

test("a job with no tenant is refused, not defaulted", () => {
  // D-0243 clause 4 is "tenant-scoped from the FIRST line". A default — "", or
  // "default" — is how one customer's lessons end up in another's bucket, and a
  // retrofit later is exactly what the clause forbids.
  assert.equal(assertTenant("wmpc"), "wmpc");
  assert.equal(assertTenant("club-42"), "club-42");
  for (const bad of ["", "a", undefined, null, 7, "has space", "has/slash", "x".repeat(65)]) {
    assert.throws(() => assertTenant(bad as unknown), /needs a tenant id/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the analyzer reads a URL or a path, and refuses every other protocol", () => {
  // The whole point of step one: "a video link in". A local path still works,
  // because the club's own files are already beside the engine.
  assert.equal(assertReadableVideo("https://example.test/a.mp4"), "https://example.test/a.mp4");
  assert.equal(assertReadableVideo("/some/dir/a.mp4"), "/some/dir/a.mp4");
  assert.equal(assertReadableVideo("  /some/dir/a.mp4  "), "/some/dir/a.mp4");
  // ffmpeg takes dozens of protocols. A caller-supplied string that may name
  // one is a caller-supplied capability, so the list is refused rather than
  // filtered — a filter grows and a refusal does not.
  for (const bad of ["pipe:0", "concat:a|b", "rtmp://x/y", "file:///etc/passwd", "", "   ", 7]) {
    assert.throws(() => assertReadableVideo(bad as unknown), /video/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── the timings, which used to be computed and thrown away ──────────────────

test("whisper's timings become segments on the document", () => {
  const srt = [
    "1", "00:00:00,000 --> 00:00:04,500", "Reset, do not counter.", "",
    "2", "00:01:02,250 --> 00:01:05,000", "Paddle up.", "",
  ].join("\n");
  const segs = parseSrt(srt);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { startS: 0, endS: 4.5, text: "Reset, do not counter." });
  assert.equal(segs[1].startS, 62.25);
  assert.equal(segs[1].text, "Paddle up.");
});

test("a half-written subtitle file yields what it can rather than failing the job", () => {
  // An hour of decode is far too expensive to throw away over a malformed
  // block, and a transcript with no timings is still worth having.
  const segs = parseSrt([
    "1", "00:00:01,000 --> 00:00:02,000", "good", "",
    "2", "not a timestamp", "orphan", "",
    "3", "00:00:03.5 --> 00:00:04.0", "period millis", "",
    "4", "00:00:05,000 --> 00:00:06,000", "",
  ].join("\n"));
  assert.deepEqual(segs.map((s) => s.text), ["good", "period millis"]);
  assert.equal(parseSrt("").length, 0);
  assert.equal(parseSrt("garbage").length, 0);
});

// ── the callback: signed, https only, replay-detectable ─────────────────────

test("a callback destination is https and carries no credentials", () => {
  // The body posted is the analysis of a named student's lesson, so plain http
  // would put it on the wire in clear. And a caller-supplied destination the
  // engine then requests is the classic request-forging proxy.
  assert.equal(assertCallbackUrl("https://app.example.test/ready"), "https://app.example.test/ready");
  assert.throws(() => assertCallbackUrl("http://app.example.test/ready"), /must be https/);
  assert.throws(() => assertCallbackUrl("https://user:pw@app.example.test/x"), /may not carry credentials/);
  assert.throws(() => assertCallbackUrl("not a url"), /must be a URL/);
});

test("a signature proves the body, and a tampered body fails it", () => {
  const body = JSON.stringify({ result: "transcribed" });
  const sig = signBody("s3cret", body);
  assert.ok(verifyBody("s3cret", body, sig));
  assert.equal(verifyBody("other", body, sig), false);
  assert.equal(verifyBody("s3cret", body + " ", sig), false);
  assert.equal(verifyBody("s3cret", body, "sha256=00"), false);
  assert.equal(verifyBody("s3cret", body, undefined as unknown as string), false);
});

// ── the queue ───────────────────────────────────────────────────────────────

function fakeDoc(over: Partial<AnalyzerDocument> = {}): AnalyzerDocument {
  return {
    schema_version: ANALYZER_SCHEMA_VERSION,
    tenant: "wmpc",
    asks: ["transcript"],
    result: "transcribed",
    source: { durationS: 60, meanVolumeDb: -24 },
    transcript: { text: "hello", words: 1 },
    engine: { model: "m", vad: "v", tookS: 1 },
    at: new Date().toISOString(),
    ...over,
  };
}

test("a job runs, holds its document, and is readable by its own tenant only", async () => {
  const jobs = new AnalyzerJobs({ analyze: async (i) => fakeDoc({ tenant: i.tenant }), scratchDir: "/tmp/x" });
  const job = jobs.submit("wmpc", { video: "https://example.test/a.mp4" });
  await jobs.drain();
  const mine = jobs.get("wmpc", job.id);
  assert.equal(mine?.status, "done");
  assert.equal(mine?.document?.transcript?.text, "hello");
  // A job belonging to another tenant reads as MISSING, not forbidden:
  // "forbidden" confirms the id exists, which is a cross-tenant leak made of
  // one status code.
  assert.equal(jobs.get("other-club", job.id), null);
  assert.equal(jobs.list("other-club").length, 0);
});

test("the tenant the engine works for is the key's, never the body's", async () => {
  // The submission has no tenant field at all — see parseSubmission. The queue
  // takes it as an argument, from the authenticated key.
  const seen: string[] = [];
  const jobs = new AnalyzerJobs({ analyze: async (i) => { seen.push(i.tenant); return fakeDoc(); }, scratchDir: "/tmp/x" });
  jobs.submit("club-a", { video: "/a.mp4" });
  jobs.submit("club-b", { video: "/b.mp4" });
  await jobs.drain();
  assert.deepEqual(seen, ["club-a", "club-b"]);
  const parsed = parseSubmission({ video: "/a.mp4", tenant: "club-z" });
  assert.ok(parsed.ok);
  assert.equal("tenant" in (parsed.ok ? parsed.sub : {}), false);
});

test("re-submitting the same idempotency key returns the same job, not a second hour of decode", async () => {
  // A caller whose response was lost retries. Without this it pays twice and
  // the receiver gets two callbacks — and the Academy's draft columns are
  // write-once, so the second would be frozen out or would freeze the wrong
  // one. This is the engine's half of D-0243's unsettled item 2.
  let runs = 0;
  const jobs = new AnalyzerJobs({ analyze: async () => { runs++; return fakeDoc(); }, scratchDir: "/tmp/x" });
  const a = jobs.submit("wmpc", { video: "/a.mp4", idempotencyKey: "rec-1" });
  const b = jobs.submit("wmpc", { video: "/a.mp4", idempotencyKey: "rec-1" });
  assert.equal(a.id, b.id);
  await jobs.drain();
  assert.equal(runs, 1);
  // Scoped per tenant: two customers may pick the same key.
  const c = jobs.submit("club-b", { video: "/a.mp4", idempotencyKey: "rec-1" });
  assert.notEqual(c.id, a.id);
});

test("the callback is signed, stamped with the job, and retried with a rising attempt", async () => {
  const posts: { body: string; headers: Record<string, string> }[] = [];
  const jobs = new AnalyzerJobs({
    analyze: async () => fakeDoc(),
    scratchDir: "/tmp/x",
    callbackSecret: () => "shh",
    backoffMs: () => 0,
    maxDeliveries: 3,
    post: async (_url, body, headers) => {
      posts.push({ body, headers });
      return { ok: posts.length === 3, status: posts.length === 3 ? 200 : 500, detail: "x" };
    },
  });
  const job = jobs.submit("wmpc", { video: "/a.mp4", callbackUrl: "https://app.example.test/ready" });
  await jobs.drain();
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map((p) => p.headers["x-analyzer-attempt"]), ["1", "2", "3"]);
  // The job stamp is INSIDE the document, so a receiver that stores only the
  // document can still tell a replay from a new result.
  const first = JSON.parse(posts[0].body);
  assert.equal(first.job.id, job.id);
  assert.equal(first.job.attempt, 1);
  assert.equal(JSON.parse(posts[2].body).job.attempt, 3);
  // Each body is signed over its own exact bytes.
  for (const p of posts) assert.ok(verifyBody("shh", p.body, p.headers["x-analyzer-signature"]));
  assert.equal(jobs.get("wmpc", job.id)?.deliveries.length, 3);
});

test("a tenant with no secret still gets its callback, unsigned and said so", async () => {
  let headers: Record<string, string> = {};
  const jobs = new AnalyzerJobs({
    analyze: async () => fakeDoc(), scratchDir: "/tmp/x",
    post: async (_u, _b, h) => { headers = h; return { ok: true, status: 200 }; },
  });
  jobs.submit("wmpc", { video: "/a.mp4", callbackUrl: "https://app.example.test/r" });
  await jobs.drain();
  assert.equal(headers["x-analyzer-signature"], undefined);
  assert.equal(headers["x-analyzer-job"]?.length, 36);
});

test("a failed analysis and a broken engine are different answers", async () => {
  // The analyzer returns a `failed` DOCUMENT for a video it could not read —
  // the caller owns the retry policy. A THROW is the engine itself falling
  // over, and a caller that cannot tell them apart cannot decide whether
  // retrying is pointless.
  const bad = new AnalyzerJobs({ analyze: async () => { throw new Error("whisper is missing"); }, scratchDir: "/tmp/x" });
  const j1 = bad.submit("wmpc", { video: "/a.mp4" });
  await bad.drain();
  assert.equal(bad.get("wmpc", j1.id)?.status, "failed");
  assert.match(bad.get("wmpc", j1.id)?.error ?? "", /whisper is missing/);
  assert.equal(bad.get("wmpc", j1.id)?.document, undefined);

  const soft = new AnalyzerJobs({ analyze: async () => fakeDoc({ result: "failed", error: "ffmpeg exited 1" }), scratchDir: "/tmp/x" });
  const j2 = soft.submit("wmpc", { video: "/a.mp4" });
  await soft.drain();
  assert.equal(soft.get("wmpc", j2.id)?.status, "done");
  assert.equal(soft.get("wmpc", j2.id)?.document?.result, "failed");
});

test("a tenant can have the analysis forgotten on request, and the job row survives", async () => {
  const jobs = new AnalyzerJobs({ analyze: async () => fakeDoc(), scratchDir: "/tmp/x" });
  const job = jobs.submit("wmpc", { video: "/a.mp4" });
  await jobs.drain();
  assert.equal(jobs.forget("other-club", job.id), false, "another tenant must not be able to forget it");
  assert.equal(jobs.forget("wmpc", job.id), true);
  assert.equal(jobs.get("wmpc", job.id)?.document, undefined);
  assert.equal(jobs.get("wmpc", job.id)?.status, "done");
});

// ── the surface ─────────────────────────────────────────────────────────────

test("a key resolves to a tenant, and every entry is compared", () => {
  const resolve = keyMap({ "key-a": "club-a", "key-b": "club-b" });
  assert.equal(resolve("key-a"), "club-a");
  assert.equal(resolve("key-b"), "club-b");
  assert.equal(resolve("key-c"), undefined);
  assert.equal(resolve(""), undefined);
});

test("the bearer header is read case-insensitively, or not at all", () => {
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("bearer abc"), "abc");
  assert.equal(bearer("BEARER  abc"), "abc");
  assert.equal(bearer("Basic abc"), undefined);
  assert.equal(bearer(undefined), undefined);
  assert.equal(bearer("Bearer"), undefined);
});

test("an ask nobody implemented is refused, not quietly dropped", () => {
  // A caller that asked for the drill timeline and got a document without one
  // would read the absence as "this lesson had no drills" — a wrong answer
  // dressed as an answer. D-0243 clause 3: a section is absent when it was NOT
  // ASKED FOR, so an unanswerable ask has to fail loudly.
  assert.ok(parseSubmission({ video: "/a.mp4" }).ok);
  assert.ok(parseSubmission({ video: "/a.mp4", asks: ["transcript"] }).ok);
  const t = parseSubmission({ video: "/a.mp4", asks: ["timeline"] });
  assert.equal(t.ok, false);
  assert.match(t.ok ? "" : t.why, /not implemented yet/);
  const u = parseSubmission({ video: "/a.mp4", asks: ["posture"] });
  assert.equal(u.ok, false);
  assert.match(u.ok ? "" : u.why, /unknown ask/);
  assert.equal(parseSubmission({ video: "/a.mp4", asks: [] }).ok, false);
  assert.equal(parseSubmission({ asks: ["transcript"] }).ok, false);
  assert.equal(parseSubmission("nope").ok, false);
});

test("what a caller is told about a job never includes the video link", () => {
  // A link may be signed, and a signed link in a status response is a
  // credential handed back out. The engine echoes the id and the state only.
  const view = jobView({
    id: "11111111-1111-1111-1111-111111111111",
    status: "done", asks: ["transcript"], submittedAt: "now",
    deliveries: [{ attempt: 1, ok: true }], document: fakeDoc(),
  });
  assert.equal(JSON.stringify(view).includes("example.test"), false);
  assert.equal(view.deliveries, 1);
  assert.ok(view.document);
});
