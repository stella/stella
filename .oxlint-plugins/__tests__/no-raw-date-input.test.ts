import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports native date picker",
    source: 'const view = <Input type="date" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports native datetime-local picker",
    source: 'const view = <Input type="datetime-local" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports native time picker",
    source: 'const view = <Input type="time" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports native month picker",
    source: 'const view = <Input type="month" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports native week picker",
    source: 'const view = <Input type="week" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports date branch",
    source: 'const view = <input type={isDate ? "date" : "text"} />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows shared picker and text inputs",
    source: 'const view = <><DatePickerPopover /><input type="text" /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "no-raw-date-input: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (await runSingleRule("no-raw-date-input", source, { sourcePath })).lines,
    ).toEqual(lines);
  },
);
