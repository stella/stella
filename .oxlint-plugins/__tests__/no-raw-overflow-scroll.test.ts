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
