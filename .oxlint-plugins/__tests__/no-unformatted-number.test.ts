import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects bare numeric names and member counts in running text", async () => {
  expect(
    await lintSingleRule(
      "no-unformatted-number",
      "const view = <><span>{matterCount}</span><span>{items.length} left</span></>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("rejects explicit string and template rendering of numbers", async () => {
  expect(
    await lintSingleRule(
      "no-unformatted-number",
      `const view = <><span>{String(totalHours)}</span><span>{\`\${invoice.amount} Kč\`}</span></>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("accepts locale-aware number rendering", async () => {
  expect(
    await lintSingleRule(
      "no-unformatted-number",
      "const view = <span>{getFormatter().number(matterCount)}</span>;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("accepts numeric identity attributes and unrelated text", async () => {
  expect(
    await lintSingleRule(
      "no-unformatted-number",
      `const view = <span key={String(matterCount)} id={\`\${totalHours}\`}>{contactName}</span>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("rejects unformatted visible attribute text", async () => {
  expect(
    await lintSingleRule(
      "no-unformatted-number",
      "const view = <span title={String(matterCount)} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});
