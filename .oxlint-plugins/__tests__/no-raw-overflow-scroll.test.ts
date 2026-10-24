import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects every scrolling axis and variant-prefixed utility", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      'const c0 = "overflow-auto";\nconst c1 = "overflow-scroll";\nconst c2 = "overflow-x-auto";\nconst c3 = "overflow-x-scroll";\nconst c4 = "overflow-y-auto";\nconst c5 = "overflow-y-scroll";\nconst c6 = "md:overflow-y-auto";\nconst c7 = "group-data-[collapsed=true]/rail:overflow-y-auto";',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("does not exempt selectors merely naming native content", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      'const a = "data-[layout=table]:overflow-auto";\nconst b = "[&:not(pre)]:overflow-auto";\nconst c = "[&_[data-slot=table]]:overflow-auto";',
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts native content descendant and child selectors", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      'const a = "[&_pre]:overflow-x-auto [&>table]:overflow-x-scroll [&_.ProseMirror]:overflow-y-auto [&_pre_code]:overflow-auto";',
    ),
  ).toEqual([]);
});

test("accepts clipping and catches raw scrolling template chunks", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      `const a = "overflow-hidden overflow-clip overflow-visible";
const b = \`flex \${other} overflow-y-auto\`;`,
    ),
  ).toEqual([2]);
});

test("rejects real hidden horizontal scrollbar patterns", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      `const a = "flex min-w-0 [scrollbar-width:none] flex-nowrap items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
const b = "flex max-w-full min-w-0 shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
const c = "scrollbar-none overflow-x-auto";`,
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts vertical-only scrolling and the primitive scrollbar", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      'const a = "overflow-y-auto [scrollbar-width:none]";\nconst b = "scrollbar-subtle overflow-x-auto";',
    ),
  ).toEqual([1, 2]);
});

test("rejects hidden horizontal scrollbars even on otherwise exempt native content", async () => {
  expect(
    await lintSingleRule(
      "no-raw-overflow-scroll",
      'const visible = "[&_pre]:overflow-x-auto";\nconst hidden = "[&_pre]:overflow-x-auto [&_pre]:[scrollbar-width:none]";',
    ),
  ).toEqual([2]);
});
