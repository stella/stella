import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule("no-array-built-typebox-union", source, {
    sourcePath: "apps/api/src/handlers/example.ts",
  });

describe("no-array-built-typebox-union", () => {
  test("rejects union members built by an array-producing call", async () => {
    expect(
      await lint(
        [
          'import { t } from "elysia";',
          'import { Type } from "@sinclair/typebox";',
          "const a = t.Union(VALUES.map((value) => t.Literal(value)));",
          "const b = t.UnionEnum(Object.values(STATUS));",
          "const c = t.UnionEnum(VALUES.filter((value) => value !== 'x'));",
          "const d = Type.Union(Array.from(VALUES, (v) => Type.Literal(v)));",
          "const e = t.Union([...VALUES.map((v) => t.Literal(v))]);",
          "const f = t.UnionEnum(VALUES.slice(1) as typeof VALUES);",
          "const g = t.UnionEnum([...BASE, ...VALUES.filter(Boolean)]);",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  test("resolves the builder namespace by import", async () => {
    expect(
      await lint(
        [
          'import { t as schema } from "elysia";',
          'import * as TB from "@sinclair/typebox";',
          "const a = schema.Union(VALUES.map((v) => schema.Literal(v)));",
          "const b = TB.Union(VALUES.map((v) => TB.Literal(v)));",
          "const c = local.Union(VALUES.map((v) => local.Literal(v)));",
          "const d = _.union(VALUES.map((v) => v));",
        ].join("\n"),
      ),
    ).toEqual([3, 4]);
  });

  test("accepts literals, tuple references, and enums", async () => {
    expect(
      await lint(
        [
          'import { t } from "elysia";',
          "const a = t.Union([t.Literal('a'), t.Literal('b')]);",
          "const b = t.UnionEnum(VALUES);",
          "const c = t.UnionEnum(table.kind.enumValues);",
          "const d = t.Enum(STATUS);",
          "const e = t.Union([...BASE, t.Null()]);",
          "const f = t.UnionEnum(['a', 'b'] as const);",
          "const g = t.Array(VALUES.map((v) => t.Literal(v)));",
          "const h = t.UnionEnum([FIRST.code, ...REST.map(({ code }) => code)]);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
