import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports repeated static sibling identity",
    source: 'const view = <>\n<Item key="same" />\n<Item key={"same"} />\n</>;',
    lines: [3],
    sourcePath: "source.tsx",
  },
  {
    title: "allows distinct siblings and separate parents",
    source:
      'const view = <><Box><Item key="same" /></Box><Box><Item key="same" /></Box><Item key="other" /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "reports repeated dynamic sibling identity",
    source:
      "const view = <Box>\n<Item key={item.id} />\n<Item key={item.id} />\n</Box>;",
    lines: [3],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-duplicate-jsx-sibling-key: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-duplicate-jsx-sibling-key", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
