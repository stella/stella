import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects stock timestamps with aliases namespace keys and manual timezone options", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as at } from "drizzle-orm/pg-core";\nimport * as pg from "drizzle-orm/pg-core";\nat("at");\nat("at", { withTimezone: true });\npg["timestamp"]("at");\npg[`timestamp`]("at");',
    ),
  ).toEqual([3, 4, 5, 6]);
});

test("rejects naive custom types in callback and static key forms", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType } from "drizzle-orm/pg-core";\ncustomType({ dataType: () => " timestamp(6) without time zone " });\ncustomType({ ["dataType"]: function() { return "TIMESTAMP"; } });\ncustomType({ dataType() { return `timestamp`; } });',
    ),
  ).toEqual([2, 3, 4]);
});

test("accepts canonical timestamps explicit zoned custom types and unrelated factories", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamptz } from "@/api/db/columns";\nimport { customType } from "drizzle-orm/pg-core";\nimport { timestamp } from "other-schema";\ntimestamptz("at");\ncustomType({ dataType: () => "timestamp with time zone" });\ncustomType({ dataType: () => "timestamptz" });\ntimestamp("at");',
    ),
  ).toEqual([]);
});

test("exempts only the timestamp helper owner", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp } from "drizzle-orm/pg-core";\ntimestamp("at");',
      { sourcePath: "apps/api/src/db/columns.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt a columns basename in another directory", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp } from "drizzle-orm/pg-core";\ntimestamp("at");',
      { sourcePath: "apps/api/src/other/columns.ts" },
    ),
  ).toEqual([2]);
});
