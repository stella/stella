import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports copied cursor schema cursor: t.String()",
    source: "const query = t.Object({ cursor: t.String() });",
    lines: [1],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title:
      'reports copied cursor schema "cursor": t.Optional(t.String({ maxLength: 200 }))',
    source:
      'const query = t.Object({ "cursor": t.Optional(t.String({ maxLength: 200 })) });',
    lines: [1],
    sourcePath: "apps/api/src/routes/records.ts",
  },
  {
    title: "allows canonical helper and unrelated strings",
    source:
      "const query = t.Object({ cursor: t.Optional(tPaginationCursor()), name: t.String() });",
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
    "const query = t.Object({ cursor: t.String({ pattern: '^[0-9]+$' }) });";
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
