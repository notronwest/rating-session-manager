// rsm#102 (D-0273). The token, the route, the gate and the cutter's idempotence.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import {
  signLessonVideoToken, verifyLessonVideoToken, type LessonVideoPayload,
} from "../src/lesson-video/token.js";
import { makeLessonVideoRouter, parseRange, type AccessLogRow } from "../src/routes/lesson-video.js";
import { cfAccessGate } from "../src/middleware/cf-access.js";
import {
  parseMarks, clipFile, recordingFile, pendingMarks, mergeClips, ffmpegCutArgs, loadClipConfig, cutClips,
} from "../src/services/lesson-clips.js";

const SECRET = crypto.randomBytes(24).toString("hex");
const L = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000;
const clipPayload = (over: Partial<LessonVideoPayload> = {}): LessonVideoPayload =>
  ({ v: 1, k: "clip", lid: L, mid: M, f: null, sub: U, exp: NOW + 900, ...over });

// ── token ────────────────────────────────────────────────────────────────────
test("a good token verifies", () => {
  const v = verifyLessonVideoToken(signLessonVideoToken(SECRET, clipPayload()), SECRET, NOW);
  assert.equal(v.ok, true);
});

test("a tampered token is refused", () => {
  const t = signLessonVideoToken(SECRET, clipPayload());
  const [body, sig] = t.split(".");
  const evil = Buffer.from(JSON.stringify(clipPayload({ lid: "44444444-4444-4444-8444-444444444444" }))).toString("base64url");
  assert.deepEqual(verifyLessonVideoToken(`${evil}.${sig}`, SECRET, NOW), { ok: false, reason: "bad-signature" });
  assert.equal(verifyLessonVideoToken(`${body}.${sig.slice(0, -2)}AA`, SECRET, NOW).ok, false);
});

test("an expired token is refused", () => {
  const t = signLessonVideoToken(SECRET, clipPayload({ exp: NOW - 1 }));
  assert.deepEqual(verifyLessonVideoToken(t, SECRET, NOW), { ok: false, reason: "expired" });
});

test("a token signed with another secret is refused", () => {
  const t = signLessonVideoToken(crypto.randomBytes(24).toString("hex"), clipPayload());
  assert.equal(verifyLessonVideoToken(t, SECRET, NOW).ok, false);
});

test("a token naming a wrong or path-like file is refused even when correctly signed", () => {
  for (const bad of [
    clipPayload({ lid: "../../etc" }),
    clipPayload({ mid: "../x" }),
    clipPayload({ mid: null }),
    clipPayload({ k: "rec", f: "../../etc/passwd" }),
    clipPayload({ k: "rec", f: "teaching/2026-10-01/../../x" }),
    clipPayload({ k: "rec", f: null }),
  ]) {
    assert.equal(verifyLessonVideoToken(signLessonVideoToken(SECRET, bad), SECRET, NOW).ok, false, JSON.stringify(bad));
  }
});

test("an unset or short signing secret refuses everything", () => {
  const t = signLessonVideoToken(SECRET, clipPayload());
  for (const s of [undefined, "", "short"]) {
    assert.deepEqual(verifyLessonVideoToken(t, s, NOW), { ok: false, reason: "unconfigured" });
  }
  // and an attacker who signs with the empty string gets nowhere
  assert.equal(verifyLessonVideoToken(signLessonVideoToken("", clipPayload()), undefined, NOW).ok, false);
});

// ── paths ────────────────────────────────────────────────────────────────────
test("clip path comes only from lesson id and mark id", () => {
  const cfg = { clipsDir: "/nas/lesson-clips" };
  assert.equal(clipFile(cfg, L, M), `/nas/lesson-clips/${L}/${M}.mp4`);
  assert.equal(clipFile(cfg, "../x", M), null);
  assert.equal(clipFile(cfg, L, "a/b"), null);
});

test("parseMarks enforces the column's own shape", () => {
  assert.equal(parseMarks([{ id: M, start_ms: 1000, end_ms: 5000 }]).length, 1);
  assert.deepEqual(parseMarks([{ id: M, start_ms: 5000, end_ms: 5000 }]), []);
  assert.deepEqual(parseMarks([{ id: M, start_ms: 0, end_ms: 200_000 }]), []);
  assert.deepEqual(parseMarks([{ id: "nope", start_ms: 0, end_ms: 10 }]), []);
  assert.deepEqual(parseMarks("x"), []);
});

test("mergeClips drops entries for edited-away marks and never names a missing mark", () => {
  const marks = [{ id: M, start_ms: 0, end_ms: 1000 }];
  const old = { mark_id: "55555555-5555-4555-8555-555555555555", ready_at: "x", duration_ms: 1 };
  const fresh = { mark_id: M, ready_at: "y", duration_ms: 1000 };
  assert.deepEqual(mergeClips(marks, [old], [fresh]), [fresh]);
  assert.deepEqual(pendingMarks(marks, [fresh], () => true), []);
  assert.equal(pendingMarks(marks, [fresh], () => false).length, 1);
});

test("the cut is a stream copy with faststart", () => {
  const a = ffmpegCutArgs("in.mp4", "out.mp4", { id: M, start_ms: 1500, end_ms: 4500 });
  assert.ok(a.includes("copy") && a.includes("+faststart"));
  assert.equal(a[a.indexOf("-ss") + 1], "1.500");
  assert.equal(a[a.indexOf("-t") + 1], "3.000");
});

// ── cutter ───────────────────────────────────────────────────────────────────
test("a missing NAS mount writes nothing and creates no local directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clips-"));
  const cfg = loadClipConfig({ LESSON_MOUNT_ROOT: path.join(tmp, "absent"), LESSON_CLIPS_DIR: path.join(tmp, "absent", "lesson-clips") } as NodeJS.ProcessEnv);
  const out = await cutClips(cfg, () => {});
  assert.deepEqual(out, { kind: "no-mount" });
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test("recordingFile resolves only a well-formed ref that exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
  fs.mkdirSync(path.join(tmp, "2026-10-01"));
  fs.writeFileSync(path.join(tmp, "2026-10-01", "teaching-090000.mp4"), "x");
  const cfg = { nasDir: tmp, localDir: path.join(tmp, "none") };
  assert.equal(recordingFile(cfg, "teaching/2026-10-01/teaching-090000"), path.join(tmp, "2026-10-01", "teaching-090000.mp4"));
  assert.equal(recordingFile(cfg, "teaching/2026-10-01/missing"), null);
  assert.equal(recordingFile(cfg, "teaching/2026-10-01/../../x"), null);
});

// ── route + gate, over a real socket ─────────────────────────────────────────
function serve(app: express.Express): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
  });
}
function get(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function fixture(secret: string | undefined, failLog = false, writer?: (r: AccessLogRow) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-"));
  const cfg = loadClipConfig({ LESSON_CLIPS_DIR: dir, LESSON_RECORDINGS_DIR: path.join(dir, "rec") } as NodeJS.ProcessEnv);
  fs.mkdirSync(path.join(dir, L));
  const bytes = Buffer.from("0123456789".repeat(100));
  fs.writeFileSync(path.join(dir, L, `${M}.mp4`), bytes);
  const logs: AccessLogRow[] = [];
  const router = makeLessonVideoRouter({
    secret: () => secret,
    cfg: () => cfg,
    now: () => NOW,
    writeAccessLog: writer ?? (async (r) => { if (failLog) throw new Error("db down"); logs.push(r); }),
  });
  const app = express();
  app.use(cfAccessGate({ publicHostRoutes: [{ host: "video.thirdshotacademy.com", path: /^\/lesson-video\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ }] }));
  app.use("/lesson-video", router);
  app.get("/api/x", (_q, r) => r.json({ secret: true }));
  return { app, bytes, logs };
}
const VIDEO_HOST = { Host: "video.thirdshotacademy.com", "cf-ray": "abc" };
const tok = (over: Partial<LessonVideoPayload> = {}) => signLessonVideoToken(SECRET, clipPayload(over));

test("serves the clip with Range, and logs exactly once before bytes", async () => {
  const { app, bytes, logs } = fixture(SECRET);
  const s = await serve(app);
  try {
    const t = tok();
    const r1 = await get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=0-9" });
    assert.equal(r1.status, 206);
    assert.equal(r1.headers["content-range"], `bytes 0-9/${bytes.length}`);
    assert.equal(r1.body.toString(), "0123456789");
    assert.equal(r1.headers["accept-ranges"], "bytes");
    const r2 = await get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=990-" });
    assert.equal(r2.status, 206);
    assert.equal(r2.body.length, 10);
    const full = await get(s.port, `/lesson-video/${t}`, VIDEO_HOST);
    assert.equal(full.status, 200);
    assert.equal(full.body.length, bytes.length);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], { user_id: U, lesson_id: L, mark_id: M, file: `clip:${L}:${M}` });
    const bad = await get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=5000-6000" });
    assert.equal(bad.status, 416);
  } finally { s.close(); }
});

test("route refuses tampered, expired and wrong-file tokens, and an unset secret", async () => {
  const { app } = fixture(SECRET);
  const unset = fixture(undefined);
  const s = await serve(app), u = await serve(unset.app);
  try {
    const good = tok();
    const t = good;
    assert.equal((await get(s.port, `/lesson-video/${t}x`, VIDEO_HOST)).status, 403);
    assert.equal((await get(s.port, `/lesson-video/${tok({ exp: NOW - 5 })}`, VIDEO_HOST)).status, 403);
    assert.equal((await get(s.port, `/lesson-video/${tok({ mid: "66666666-6666-4666-8666-666666666666" })}`, VIDEO_HOST)).status, 404);
    assert.equal((await get(u.port, `/lesson-video/${good}`, VIDEO_HOST)).status, 503);
  } finally { s.close(); u.close(); }
});

test("no access-log row means no bytes", async () => {
  const { app } = fixture(SECRET, true);
  const s = await serve(app);
  try {
    const r = await get(s.port, `/lesson-video/${tok({ exp: NOW + 901 })}`, { ...VIDEO_HOST, Range: "bytes=0-9" });
    assert.equal(r.status, 503);
    assert.equal(r.body.toString().includes("0123"), false);
  } finally { s.close(); }
});

test("on the video host only the token route is reachable; the prefix elsewhere stays gated", async () => {
  const { app } = fixture(SECRET);
  const s = await serve(app);
  try {
    // /api/* on the video host is refused, with or without a token-looking path.
    assert.equal((await get(s.port, "/api/x", VIDEO_HOST)).status, 403);
    assert.equal((await get(s.port, "/lesson-video/a.b/../../api/x", VIDEO_HOST)).status, 403);
    assert.equal((await get(s.port, "/", VIDEO_HOST)).status, 403);
    // The same prefix on the Access-gated host is refused without Access.
    const r = await get(s.port, `/lesson-video/${tok()}`, { Host: "session.wmpc.app", "cf-ray": "abc" });
    assert.equal(r.status, 403);
    // LAN (no Cloudflare headers) is untouched, as before.
    assert.equal((await get(s.port, "/api/x")).status, 200);
  } finally { s.close(); }
});

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), null);
  assert.equal(parseRange("nonsense", 100), "none");
});

test("overlapping requests wait on one failing log write: neither gets bytes, then a retry works", async () => {
  let calls = 0;
  let fail = true;
  const { app } = fixture(SECRET, false, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    if (fail) throw new Error("db down");
  });
  const s = await serve(app);
  try {
    const t = tok({ exp: NOW + 777 });
    const [a, b] = await Promise.all([
      get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=0-9" }),
      get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=10-19" }),
    ]);
    assert.equal(a.status, 503);
    assert.equal(b.status, 503);
    assert.equal(a.body.includes("0123456789"), false);
    assert.equal(calls, 1);
    fail = false;
    assert.equal((await get(s.port, `/lesson-video/${t}`, { ...VIDEO_HOST, Range: "bytes=0-9" })).status, 206);
  } finally { s.close(); }
});
