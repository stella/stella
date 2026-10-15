import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports unisolated user text",
    source: "const view = <span>{user.displayName}</span>;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports raw direction wrappers",
    source: 'const view = <span dir="auto">{user.displayName}</span>;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows shared isolation and unrelated content",
    source:
      "const view = <><BidiText>{user.displayName}</BidiText><UserText>{user.email}</UserText><span>{item.count}</span></>;",
    lines: [],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "require-dir-on-rendered-name: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("require-dir-on-rendered-name", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);

test("isolates user names within mixed compound component content", async () => {
  expect(
    (
      await runSingleRule(
        "require-dir-on-rendered-name",
        "const view = <Menu.Label>By {user.displayName}</Menu.Label>;",
        { sourcePath: "source.tsx" },
      )
    ).lines,
  ).toEqual([1]);
  expect(
    (
      await runSingleRule(
        "require-dir-on-rendered-name",
        "const view = <Menu.Label>By <BidiText>{user.displayName}</BidiText></Menu.Label>;",
        { sourcePath: "source.tsx" },
      )
    ).lines,
  ).toEqual([]);
});
