import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports module-level copies",
    source:
      "export const getInitials = (user) => user.name[0];\nfunction getDisplayName(user) { return user.name; }",
    lines: [1, 2],
    sourcePath: "apps/web/src/components/names.ts",
  },
  {
    title: "allows canonical implementations",
    source: "export const getInitials = (user) => user.name[0];",
    lines: [],
    sourcePath: "apps/web/src/lib/names.ts",
  },
  {
    title: "allows nested and unrelated helpers",
    source:
      'function render() { const getInitials = () => "A"; }\nconst formatName = (user) => user.name;',
    lines: [],
    sourcePath: "apps/web/src/components/names.ts",
  },
];

test.each(cases)(
  "no-shadowed-user-name-helpers: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-shadowed-user-name-helpers", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
