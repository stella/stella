import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("distinguishes imported timestamp from a parameter", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as make } from "drizzle-orm/pg-core";\nfunction local(make) { make("at"); }\nmake("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported timestamp from a block binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as make } from "drizzle-orm/pg-core";\n{ const make = unrelated; make("at"); }\nmake("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported timestamp from a local binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as make } from "drizzle-orm/pg-core";\nfunction local() { const make = unrelated; make("at"); }\nmake("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported timestamp from a hoisted function", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as make } from "drizzle-orm/pg-core";\nfunction local() { make("at"); function make(value) { return value; } }\nmake("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported timestamp from a hoisted var", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as make } from "drizzle-orm/pg-core";\nfunction local() { make("at"); var make = unrelated; }\nmake("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported customType from a parameter", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType as make } from "drizzle-orm/pg-core";\nfunction local(make) { make({ dataType: () => "timestamp" }); }\nmake({ dataType: () => "timestamp" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported customType from a block binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType as make } from "drizzle-orm/pg-core";\n{ const make = unrelated; make({ dataType: () => "timestamp" }); }\nmake({ dataType: () => "timestamp" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported customType from a local binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType as make } from "drizzle-orm/pg-core";\nfunction local() { const make = unrelated; make({ dataType: () => "timestamp" }); }\nmake({ dataType: () => "timestamp" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported customType from a hoisted function", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType as make } from "drizzle-orm/pg-core";\nfunction local() { make({ dataType: () => "timestamp" }); function make(value) { return value; } }\nmake({ dataType: () => "timestamp" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported customType from a hoisted var", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { customType as make } from "drizzle-orm/pg-core";\nfunction local() { make({ dataType: () => "timestamp" }); var make = unrelated; }\nmake({ dataType: () => "timestamp" });',
    ),
  ).toEqual([3]);
});

test("distinguishes imported pg-core namespace from a parameter", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import * as pg from "drizzle-orm/pg-core";\nfunction local(pg) { pg.timestamp("at"); pg.customType({ dataType: () => "timestamp" }); }\npg.timestamp("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported pg-core namespace from a block binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import * as pg from "drizzle-orm/pg-core";\n{ const pg = unrelated; pg.timestamp("at"); }\npg.timestamp("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported pg-core namespace from a local binding", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import * as pg from "drizzle-orm/pg-core";\nfunction local() { const pg = unrelated; pg.timestamp("at"); }\npg.timestamp("at");',
    ),
  ).toEqual([3]);
});

test("distinguishes imported pg-core namespace from a hoisted var", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import * as pg from "drizzle-orm/pg-core";\nfunction local() { pg.timestamp("at"); var pg = unrelated; }\npg.timestamp("at");',
    ),
  ).toEqual([3]);
});

test("preserves default-member detection while excluding its shadowed parameter", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import pg from "drizzle-orm/pg-core";\nfunction local(pg) { pg.timestamp("at"); }\npg["timestamp"]("at");',
    ),
  ).toEqual([3]);
});

test("preserves genuine timestamp and naive custom-type reports", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp as at, customType as custom } from "drizzle-orm/pg-core";\nimport * as pg from "drizzle-orm/pg-core";\nat("at", { withTimezone: true });\npg["timestamp"]("at");\npg[`timestamp`]("at");\ncustom({ dataType: () => "timestamp" });\npg.customType({ dataType() { return "TIMESTAMP (6) WITHOUT TIME ZONE"; } });',
    ),
  ).toEqual([3, 4, 5, 6, 7]);
});

test("follows stable namespace destructuring and function aliases to pg-core", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import * as pg from "drizzle-orm/pg-core";\nconst namespace = pg;\nconst { timestamp: at, customType: custom } = namespace;\nconst alias = at;\nalias("at");\ncustom({ dataType: () => "timestamp" });',
    ),
  ).toEqual([5, 6]);
});

test("accepts canonical timestamps zoned custom types and unrelated exports", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamptz } from "@/api/db/columns";\nimport { customType } from "drizzle-orm/pg-core";\nimport { timestamp } from "other-schema";\ntimestamptz("at");\ncustomType({ dataType: () => "timestamp with time zone" });\ntimestamp("at");',
    ),
  ).toEqual([]);
});

test("keeps only the canonical columns module exempt", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp } from "drizzle-orm/pg-core";\ntimestamp("at");',
      { sourcePath: "apps/api/src/db/columns.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt unrelated columns modules", async () => {
  expect(
    await lintSingleRule(
      "require-timestamptz-column",
      'import { timestamp } from "drizzle-orm/pg-core";\ntimestamp("at");',
      { sourcePath: "apps/api/src/other/columns.ts" },
    ),
  ).toEqual([2]);
});
