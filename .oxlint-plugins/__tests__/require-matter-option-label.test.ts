import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports a combobox option that prints a matter's name alone",
    source:
      "const view = <ComboboxItem value={matter}>{matter.name}</ComboboxItem>;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports a nested workspace name in a select option",
    source:
      "const view = <SelectItem value={id}>\n  <span>{props.workspace.name}</span>\n</SelectItem>;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports workspaceName values in menu items",
    source: "const view = <MenuItem>{row.workspaceName}</MenuItem>;",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "reports a mapped matter list without the icon",
    source:
      "const view = matters.map((targetMatter) => <CommandItem key={targetMatter.id}>{targetMatter.name}</CommandItem>);",
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows the shared label primitive",
    source:
      "const view = <ComboboxItem value={matter}><MatterOptionLabel matter={matter} /></ComboboxItem>;",
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "allows a bespoke layout that draws the coloured icon",
    source:
      "const view = <MenuItem><MatterIcon matter={{ id: matter.id, color: matter.color }} />{matter.name}</MenuItem>;",
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title:
      "ignores names that are not matters and elements that are not options",
    source:
      "const view = <><MenuItem>{group.name}</MenuItem><span>{matter.name}</span></>;",
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "exempts the primitive's own file",
    source: "const view = <MenuItem>{matter.name}</MenuItem>;",
    lines: [],
    sourcePath: "matter-option-label.tsx",
  },
];

test.each(cases)(
  "require-matter-option-label: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("require-matter-option-label", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
