import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const OFFSET_SCHEMAS = [
  "const query = { offset: v.number() };",
  "const wrapped = { offset: v.optional(v.pipe(v.number(), v.integer())) };",
  "const wire = { offset: v.exactOptional(numberFromString(v.number())) };",
  "const helper = { offset: v.optional(pageOffsetSchema()) };",
  "const named = { offset: pageOffsetSchema };",
  "const union = { offset: v.union([v.literal(0), v.number()]) };",
].join("\n");

test("rejects direct, wrapped and helper-built request offset schemas", async () => {
  expect(
    await lintSingleRule("no-offset-pagination", OFFSET_SCHEMAS, {
      sourcePath: "apps/api/src/handlers/documents/list.ts",
    }),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows cursor request schemas and ordinary numeric offsets", async () => {
  expect(
    await lintSingleRule(
      "no-offset-pagination",
      [
        "const query = { cursor: v.optional(paginationCursorSchema()), limit: v.number() };",
        "const position = { offset: 20 };",
        "const computed = { offset: computeOffset(page, size) };",
        "const product = { offset: page * size };",
      ].join("\n"),
      { sourcePath: "apps/api/src/handlers/documents/list.ts" },
    ),
  ).toEqual([]);
});

test("allows configured legacy endpoints without exempting other directories", async () => {
  expect(
    await lintSingleRule("no-offset-pagination", OFFSET_SCHEMAS, {
      sourcePath: "apps/api/src/handlers/legacy/list.ts",
      ruleOptions: { allowedFiles: ["apps/api/src/handlers/legacy/list.ts"] },
    }),
  ).toEqual([]);
});

test("keeps legacy endpoint basenames restricted in another directory", async () => {
  expect(
    await lintSingleRule("no-offset-pagination", OFFSET_SCHEMAS, {
      sourcePath: "apps/api/src/handlers/new/list.ts",
      ruleOptions: { allowedFiles: ["apps/api/src/handlers/legacy/list.ts"] },
    }),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});
