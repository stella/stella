import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports unreachable external tooltip",
    source: "const view = <Tooltip render={<Button disabled />} />;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports disabled button through render chain",
    source:
      "const view = <TooltipTrigger render={<DialogTrigger render={<Button disabled />} />} />;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows owned tooltip and enabled controls",
    source:
      'const view = <><Button disabled tooltip="Reason" /><Tooltip render={<Button />} /><Tooltip render={<span />} /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-disabled-tooltip-trigger: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-disabled-tooltip-trigger", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
