import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects ambient async store mutation", async () => {
  expect(
    await lintSingleRule(
      "no-async-context-enter-with",
      "storage.enterWith(store);",
    ),
  ).toEqual([1]);
});

test("rejects ambient mutation inside callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-async-context-enter-with",
      'queue.on("job", () => {\n  requestStorage.enterWith(store);\n});',
    ),
  ).toEqual([2]);
});

test("accepts callback-scoped stores that restore the previous frame", async () => {
  expect(
    await lintSingleRule(
      "no-async-context-enter-with",
      "storage.run(store, () => processJob());",
    ),
  ).toEqual([]);
});

test("accepts reading the current store", async () => {
  expect(
    await lintSingleRule(
      "no-async-context-enter-with",
      "const scope = storage.getStore();",
    ),
  ).toEqual([]);
});
