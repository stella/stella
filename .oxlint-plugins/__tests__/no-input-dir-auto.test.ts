import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects auto direction on shared text controls", async () => {
  expect(
    await lintSingleRule(
      "no-input-dir-auto",
      'const view = <><Input dir="auto" /><Textarea dir={"auto"} /></>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("rejects numeric text fields without explicit LTR direction", async () => {
  expect(
    await lintSingleRule(
      "no-input-dir-auto",
      'const view = <><Input inputMode="numeric" /><Input inputMode="decimal" dir="rtl" /></>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("rejects raw text controls without direction handling", async () => {
  expect(
    await lintSingleRule(
      "no-input-dir-auto",
      'const view = <><input type="text" /><textarea /></>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("accepts shared direction ownership and explicit numeric direction", async () => {
  expect(
    await lintSingleRule(
      "no-input-dir-auto",
      'const view = <><Input /><Textarea /><Input inputMode="decimal" dir="ltr" /></>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts content-derived and structured raw inputs", async () => {
  expect(
    await lintSingleRule(
      "no-input-dir-auto",
      'const view = <><input dir={contentDir(value)} /><input type="email" /><input type="number" /></>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
