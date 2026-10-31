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

test("rejects actual pgEnum imports and namespace reads through stable aliases", async () => {
  expect(
    await lintSingleRule(
      "no-domain-enum",
      [
        'import { pgEnum } from "drizzle-orm/pg-core";',
        'import { pgEnum as makeEnum } from "drizzle-orm/pg-core";',
        'import * as columns from "drizzle-orm/pg-core";',
        'columns.pgEnum("status", ["open"]);',
        'const alias = columns; alias["pgEnum"]("status", ["open"]);',
        'columns[`pgEnum`]("status", ["open"]);',
        "const { pgEnum: createEnum } = alias;",
        'const { ["pgEnum"]: anotherEnum } = alias;',
        "const retained = columns.pgEnum;",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
});

test("keeps namespace column APIs, shadowed names and unrelated modules valid", async () => {
  expect(
    await lintSingleRule(
      "no-domain-enum",
      [
        'import * as columns from "drizzle-orm/pg-core";',
        'import * as other from "other-schema";',
        'import type { pgEnum } from "drizzle-orm/pg-core";',
        'columns.text("status", { enum: ["open", "closed"] });',
        'columns.jsonb("data");',
        'const alias = columns; alias.text("name");',
        "const { text, jsonb } = alias;",
        'other.pgEnum("unrelated", ["value"]);',
        'const local = { pgEnum: () => "local" }; local.pgEnum();',
        "const run = (columns: { pgEnum: () => void }) => columns.pgEnum();",
        "const unpack = (columns: { pgEnum: () => void }) => { const { pgEnum } = columns; pgEnum(); };",
      ].join("\n"),
    ),
  ).toEqual([]);
});
