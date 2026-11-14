import { test } from "node:test";
import assert from "node:assert/strict";
import { sendDiscordAlert } from "../src/services/discord-alert.js";

test("discord alert body carries the quiet flag and no mention parsing", async () => {
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";
  const realFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response("", { status: 204 });
  }) as typeof fetch;
  try {
    const res = await sendDiscordAlert({ title: "quiet-flag-test", message: "hi", alwaysFire: true });
    assert.equal(res.sent, true);
    assert.equal(body.flags & 4096, 4096);
    assert.equal(body.flags, 4096);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
  } finally {
    globalThis.fetch = realFetch;
  }
});
