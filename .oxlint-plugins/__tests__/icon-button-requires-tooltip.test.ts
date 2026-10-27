import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires tooltips on icon controls including native aria labels", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      'const a = <Button><PlusIcon /></Button>;\nconst b = <button aria-label="Open"><PlusIcon /></button>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("does not count visually hidden text as a visible label", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      'const a = <button><PlusIcon /><span className="sr-only">Open</span></button>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("checks icon sized render controls", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      'const a = <MenuTrigger render={<Button size="icon" />}><PlusIcon /></MenuTrigger>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("accepts icon-size automatic tooltips, explicit tooltips and native titles", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      [
        'const a = <Button aria-label="Open" size="icon"><PlusIcon /></Button>;',
        'const b = <button title="Open"><PlusIcon /></button>;',
        'const c = <PopoverTrigger tooltip="Open"><PlusIcon /></PopoverTrigger>;',
        'const d = <MenuTrigger aria-label="Open" render={<Button size="icon-xs" />}><PlusIcon /></MenuTrigger>;',
        'const e = <Button aria-label="Open" size="sm" tooltip="Open"><PlusIcon /></Button>;',
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

// `Button` turns a label into a tooltip only at an icon size, and an overlay
// trigger never does; a size the rule cannot read is not proven an icon size.
test("a label is no tooltip where Button derives none", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      [
        'const a = <Button aria-label="Open"><PlusIcon /></Button>;',
        'const b = <Button aria-label="Open" size="sm"><PlusIcon /></Button>;',
        'const c = <PopoverTrigger aria-label="Open"><PlusIcon /></PopoverTrigger>;',
        'const d = <MenuTrigger aria-label="Open" render={<Button size="xs" />}><PlusIcon /></MenuTrigger>;',
        'const e = <Button aria-label="Open" size={size}><PlusIcon /></Button>;',
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("counts a non-icon component as a possible visible label", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      'const a = <Button aria-label="Copy" size="sm"><CopyFeedback label="Copy" /><ChevronDownIcon /></Button>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts tooltip ancestry and visible labels", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      "const a = <Tooltip><button><PlusIcon /></button></Tooltip>;\nconst b = <button><PlusIcon />Open</button>;\nconst c = <Button>{label}</Button>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("ignores noninteractive icons", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      "const a = <span><PlusIcon /></span>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
