import { expect, test } from "bun:test";

import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

test("rejects optional enum coercion with inline values", async () => {
  expect(
    await lintSingleRule(
      "no-coerced-optional-union-enum",
      'const schema = t.Optional(t.UnionEnum(["person", "organization"]));',
    ),
  ).toEqual([1]);
});

test("rejects dynamic and destructured optional enums", async () => {
  expect(
    await lintSingleRule(
      "no-coerced-optional-union-enum",
      "const schema = t.Optional(t.UnionEnum(REGIONS));\nconst other = Optional(UnionEnum(REGIONS));",
    ),
  ).toEqual([1, 2]);
});

test("accepts optional unions of explicit literals", async () => {
  expect(
    await lintSingleRule(
      "no-coerced-optional-union-enum",
      'const schema = t.Optional(t.Union([t.Literal("person"), t.Literal("organization")]));',
    ),
  ).toEqual([]);
});

test("accepts required enums without absent-value coercion", async () => {
  expect(
    await lintSingleRule(
      "no-coerced-optional-union-enum",
      'const schema = t.UnionEnum(["person", "organization"]);',
    ),
  ).toEqual([]);
});

test("expands inline enum values without changing the namespace", async () => {
  expect(
    await runSingleRule(
      "no-coerced-optional-union-enum",
      'const schema = schemaTypes.Optional(schemaTypes.UnionEnum(["person", "organization"]));',
      { fix: true },
    ),
  ).toEqual({
    lines: [],
    source:
      'const schema = schemaTypes.Optional(schemaTypes.Union([schemaTypes.Literal("person"), schemaTypes.Literal("organization")]));',
  });
});

test("preserves dynamic enum diagnostics without offering a fix", async () => {
  const source = "const schema = t.Optional(t.UnionEnum(REGIONS));";
  expect(
    await runSingleRule("no-coerced-optional-union-enum", source, {
      fix: true,
    }),
  ).toEqual({ lines: [1], source });
});

test("preserves destructured enum diagnostics without offering a fix", async () => {
  const source =
    'const schema = Optional(UnionEnum(["person", "organization"]));';
  expect(
    await runSingleRule("no-coerced-optional-union-enum", source, {
      fix: true,
    }),
  ).toEqual({ lines: [1], source });
});
