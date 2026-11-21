import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects module-level database and auth construction", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "export const db = drizzle({ client });\nconst auth = betterAuth(options);",
    ),
  ).toEqual([1, 2]);
});

test("rejects eager constructors even inside module branches", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      'if (enabled) { const queue = new Queue("tasks"); }\nconst client = new S3Client(options);',
    ),
  ).toEqual([1, 2]);
});

test("rejects static class singleton initialization", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "class Store { static db = drizzle({ client }); }",
    ),
  ).toEqual([1]);
});

test("accepts lazy getters and nonstatic class fields", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "const getDb = () => drizzle({ client });\nclass Store { db = drizzle({ client }); }\nfunction build() { return new S3Client(options); }",
    ),
  ).toEqual([]);
});

test("does not suppress later eager work after a lazy getter", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "const getDb = () => drizzle({ client });\nconst db = drizzle({ client });",
    ),
  ).toEqual([2]);
});

test("accepts pure schema construction at module level", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "const schema = v.object({ name: v.string() });",
    ),
  ).toEqual([]);
});

test("rejects eager work after a nonstatic class field", async () => {
  expect(
    await lintSingleRule(
      "no-eager-singleton",
      "class Store { db = drizzle({ client }); }\nconst db = drizzle({ client });",
    ),
  ).toEqual([2]);
});
