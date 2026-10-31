import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects the bare spelling and its side forms under any variant", async () => {
  expect(
    await lintSingleRule(
      "radius-scale",
      'const a = "rounded px-1";\nconst b = "rounded-t border";\nconst c = "rounded-ss";\nconst d = "hover:rounded";\nconst e = "[&>kbd]:rounded";',
    ),
  ).toEqual([1, 2, 3, 4, 5]);
});

test("rejects literal lengths between scale steps", async () => {
  expect(
    await lintSingleRule(
      "radius-scale",
      `const a = "rounded-[7px]";
const b = "rounded-s-[0.6rem]";
const c = "before:rounded-[3px]";
const d = \`flex \${other} rounded-[.5em]\`;`,
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts named steps and token-derived values", async () => {
  expect(
    await lintSingleRule(
      "radius-scale",
      'const a = "rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-full rounded-none rounded-t-sm";\nconst b = "before:rounded-[calc(var(--radius-lg)-1px)] rounded-[inherit] rounded-[var(--thumb-size)]";\nconst c = "rounded-corner-label";',
    ),
  ).toEqual([]);
});
