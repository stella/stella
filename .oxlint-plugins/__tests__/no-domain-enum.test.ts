import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects TypeScript enums", async () => {
  expect(
    await lintSingleRule(
      "no-domain-enum",
      'enum MatterStatus { Open = "open", Closed = "closed" }',
    ),
  ).toEqual([1]);
});

test("rejects const TypeScript enums", async () => {
  expect(
    await lintSingleRule(
      "no-domain-enum",
      'const enum MatterStatus { Open = "open", Closed = "closed" }',
    ),
  ).toEqual([1]);
});

test("accepts string-literal unions and const lookup tables", async () => {
  expect(
    await lintSingleRule(
      "no-domain-enum",
      [
        'const MATTER_STATUS = { open: "open", closed: "closed" } as const;',
        "type MatterStatus = (typeof MATTER_STATUS)[keyof typeof MATTER_STATUS];",
      ].join("\n"),
    ),
  ).toEqual([]);
});
