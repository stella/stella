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

test("accepts primitive automatic tooltips and native titles", async () => {
  expect(
    await lintSingleRule(
      "icon-button-requires-tooltip",
      'const a = <Button aria-label="Open"><PlusIcon /></Button>;\nconst b = <button title="Open"><PlusIcon /></button>;\nconst c = <PopoverTrigger tooltip="Open"><PlusIcon /></PopoverTrigger>;',
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
