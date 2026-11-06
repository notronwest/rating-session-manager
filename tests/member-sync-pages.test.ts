import { test } from "node:test";
import assert from "node:assert/strict";
import { readAllPages } from "../src/members/sync.js";

const source = (total: number) => async (from: number, to: number) =>
  Array.from({ length: total }, (_, i) => i).slice(from, to + 1);

test("reads past the first page instead of stopping at the row cap", async () => {
  const rows = await readAllPages(source(1634));
  assert.equal(rows.length, 1634);
  assert.equal(new Set(rows).size, 1634);
});

test("an exact multiple of the page size still ends", async () => {
  assert.equal((await readAllPages(source(2000))).length, 2000);
});

test("an empty table returns nothing", async () => {
  assert.deepEqual(await readAllPages(source(0)), []);
});
