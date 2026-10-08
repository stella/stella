import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects scrollbars owned by a centered width-capped column", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      'const view = <div className="mx-auto w-full max-w-2xl overflow-y-auto p-6" />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects scroll variants in template classes", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      `const classes = \`mx-auto max-w-2xl md:overflow-y-scroll \${extra}\`;`,
    ),
  ).toEqual([1]);
});

test("accepts scrolling on a full-width parent", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      'const view = <div className="flex-1 overflow-y-auto"><div className="mx-auto max-w-2xl" /></div>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts positioned and height-capped scroll boxes", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      'const popover = "absolute mx-auto max-w-sm overflow-y-auto";\nconst menu = "fixed mx-auto max-w-sm overflow-scroll";\nconst dialog = "max-h-80 mx-auto max-w-sm overflow-auto";',
    ),
  ).toEqual([]);
});

test("accepts columns with unconstrained width", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      'const classes = "mx-auto max-w-full overflow-y-auto";',
    ),
  ).toEqual([]);
});

test("allows an uncentered width-capped scroll box", async () => {
  expect(
    await lintSingleRule(
      "no-centered-scroll-column",
      'const view = <div className="max-w-2xl overflow-y-auto" />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
