/**
 * The structured draft call after a transcript attaches (D-0318 rule 1).
 * Fixtures are invented: no lesson ids, names or transcript text from the club.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftStructured, structuredDraftUrl } from "../src/services/lesson-transcribe";

const ENV = {
  LESSON_DRAFT_URL: "https://example-ref.supabase.co/functions/v1/draft-lesson-writeup",
  LESSON_DRAFT_SECRET: "test-secret",
} as unknown as NodeJS.ProcessEnv;
const LESSON = { id: "lesson-x", written_up_at: null };

function withFetch(impl: (url: string, init: RequestInit) => Response, fn: (calls: { url: string; init: RequestInit }[]) => Promise<void>) {
  const real = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as typeof fetch;
  return fn(calls).finally(() => { globalThis.fetch = real; });
}

const resp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("derives the structured URL as the sibling of the prose drafter", () => {
  assert.equal(structuredDraftUrl(ENV), "https://example-ref.supabase.co/functions/v1/draft-lesson-structured");
  assert.equal(structuredDraftUrl({ ...ENV, LESSON_DRAFT_STRUCTURED_URL: "https://x.test/f" } as NodeJS.ProcessEnv), "https://x.test/f");
  assert.equal(structuredDraftUrl({} as NodeJS.ProcessEnv), null);
});

test("posts only the lesson id, with the same Bearer secret", async () => {
  await withFetch(() => resp(200, { drafted: true, items: 4 }), async (calls) => {
    const d = await draftStructured(LESSON, ENV);
    assert.deepEqual(d, { drafted: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /draft-lesson-structured$/);
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-secret");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { lessonId: "lesson-x" });
  });
});

test("the function's refusals are reported, not thrown", async () => {
  await withFetch(() => resp(200, { drafted: false, reason: "already drafted once" }), async () => {
    assert.deepEqual(await draftStructured(LESSON, ENV), { drafted: false, reason: "already drafted once" });
  });
  await withFetch(() => resp(422, { drafted: false, reason: "items is not a list" }), async () => {
    assert.deepEqual(await draftStructured(LESSON, ENV), { drafted: false, reason: "items is not a list" });
  });
});

test("a server error throws, so the caller's fail-open catch logs it", async () => {
  await withFetch(() => resp(502, { error: "the model could not be reached" }), async () => {
    await assert.rejects(draftStructured(LESSON, ENV), /HTTP 502/);
  });
});

test("unconfigured or written up: no call at all", async () => {
  await withFetch(() => { throw new Error("must not be called"); }, async (calls) => {
    assert.equal((await draftStructured(LESSON, {} as NodeJS.ProcessEnv)).drafted, false);
    assert.equal((await draftStructured({ id: "lesson-x", written_up_at: "2030-01-01" }, ENV)).drafted, false);
    assert.equal(calls.length, 0);
  });
});
