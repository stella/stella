import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects stock named aliases and computed namespace calls", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { jsonb as stock } from "drizzle-orm/pg-core";\nimport * as pg from "drizzle-orm/pg-core";\nstock("value");\npg.jsonb("value");\npg["jsonb"]("value");\npg[`jsonb`]("value");',
    ),
  ).toEqual([3, 4, 5, 6]);
});

test("rejects hand rolled JSONB callbacks in each function shape", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { customType as custom } from "drizzle-orm/pg-core";\ncustom({ dataType: () => "jsonb" });\ncustom({ ["dataType"]: () => { return "jsonb"; } });\ncustom({ dataType() { return "jsonb"; } });',
    ),
  ).toEqual([2, 3, 4]);
});

test("accepts canonical JSONB and unrelated same named helpers", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { jsonb } from "@/api/db/columns";\nimport * as other from "other-library";\njsonb("value");\nother.jsonb("value");',
    ),
  ).toEqual([]);
});

test("accepts other custom data types and dynamic keys", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { customType } from "drizzle-orm/pg-core";\ncustomType({ dataType: () => "text" });\ncustomType({ [dataType]: () => "jsonb" });',
    ),
  ).toEqual([]);
});

test("accepts JSONB type declaration inside the exact owner", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { customType } from "drizzle-orm/pg-core";\ncustomType({ dataType: () => "jsonb" });',
      { sourcePath: "apps/api/src/db/columns.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt a columns basename elsewhere", async () => {
  expect(
    await lintSingleRule(
      "require-custom-jsonb-column",
      'import { customType } from "drizzle-orm/pg-core";\ncustomType({ dataType: () => "jsonb" });',
      { sourcePath: "apps/api/src/other/columns.ts" },
    ),
  ).toEqual([2]);
});
