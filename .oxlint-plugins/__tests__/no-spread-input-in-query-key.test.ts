import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-spread-input-in-query-key", () => {
  test("reports input leaks in arrays and nested key objects", async () => {
    expect(
      await lintSingleRule(
        "no-spread-input-in-query-key",
        "query({ queryKey: [...entitiesKeys.all(ws), ...filters, { ...input }] });",
      ),
    ).toEqual([1, 1]);
  });
  test("reports key factory and named key leaks", async () => {
    expect(
      await lintSingleRule(
        "no-spread-input-in-query-key",
        'const matterKeys = { list: input => [...matterKeys.all, ...input] };\nconst key = ["list", { ...filters }];\nquery({ queryKey: key });',
      ),
    ).toEqual([1, 2]);
  });
  test("accepts composition with explicit identity fields", async () => {
    expect(
      await lintSingleRule(
        "no-spread-input-in-query-key",
        "query({ queryKey: [...entitiesKeys.all(ws), { filters, sorts, page }] });\nconst chatKeys = { thread: (org, key) => [...chatKeys.all, org, key.threadId] };",
      ),
    ).toEqual([]);
  });
  test("accepts argument spreads and unrelated arrays", async () => {
    expect(
      await lintSingleRule(
        "no-spread-input-in-query-key",
        "query({ queryKey: chatKeys.thread(org, { ...key, contextKind }) });\nconst values = [...input];",
      ),
    ).toEqual([]);
  });
});
