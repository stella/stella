import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports copied cursor schema cursor: v.string()",
    source: "const query = v.object({ cursor: v.string() });",
    lines: [1],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title:
      'reports copied cursor schema "cursor": v.optional(v.pipe(v.string(), v.maxLength(200)))',
    source:
      'const query = v.object({ "cursor": v.optional(v.pipe(v.string(), v.maxLength(200))) });',
    lines: [1],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title: "reports inline strings under every optional wrapper",
    source: [
      "const a = v.object({ cursor: v.exactOptional(v.string()) });",
      "const b = v.object({ cursor: v.nullish(v.pipe(v.string(), v.trim())) });",
      "const c = v.object({ cursor: v.nullable(v.optional(v.string())) });",
    ].join("\n"),
    lines: [1, 2, 3],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title: "allows canonical helper, piped helper checks and unrelated strings",
    source: [
      "const query = v.object({ cursor: v.optional(paginationCursorSchema()), name: v.string() });",
      "const checked = v.object({ cursor: v.optional(v.pipe(paginationCursorSchema(), v.check(isCursor))) });",
      "const wide = v.object({ cursor: v.exactOptional(paginationCursorSchema({ maxChars: 4096 })) });",
    ].join("\n"),
    lines: [],
    sourcePath: "apps/api/src/routes/records.ts",
  },
];

test.each(cases)(
  "require-pagination-cursor-schema: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("require-pagination-cursor-schema", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);

test("confines provider cursor exemptions to the configured path", async () => {
  const source =
    "const query = v.object({ cursor: v.pipe(v.string(), v.regex(/^[0-9]+$/u)) });";
  const ruleOptions = { allowedFiles: ["apps/api/src/routes/provider.ts"] };
  expect(
    (
      await runSingleRule("require-pagination-cursor-schema", source, {
        sourcePath: "apps/api/src/routes/provider.ts",
        ruleOptions,
      })
    ).lines,
  ).toEqual([]);
  expect(
    (
      await runSingleRule("require-pagination-cursor-schema", source, {
        sourcePath: "apps/api/src/lib/provider.ts",
        ruleOptions,
      })
    ).lines,
  ).toEqual([1]);
});
