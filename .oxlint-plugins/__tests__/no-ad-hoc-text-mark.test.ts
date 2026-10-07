import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw mark rendering", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      "const word = <mark>found</mark>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects hand-styled mark descendants", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      'const text = <p className="[&_mark]:bg-warning/30" />;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects retired hit fill inside class utilities", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      'const classes = cn("text-xs", "bg-highlight/45");',
    ),
  ).toEqual([1]);
});

test("rejects retired hit fill in template classes", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      `const classes = \`hover:bg-highlight \${extra}\`;`,
    ),
  ).toEqual([1]);
});

test("accepts the owned text mark and descendant styles", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      'const word = <TextMark {...SEARCH_HIT_MARK}>found</TextMark>;\nconst text = <p className={cn("text-xs", SEARCH_HIT_DESCENDANT_MARK_CLASS)} />;\nconst style = textMarkClass({ variant: "fill", tone: "warning" });',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts unrelated background fills", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-text-mark",
      'const classes = "bg-warning/30 bg-highlighted";',
    ),
  ).toEqual([]);
});
