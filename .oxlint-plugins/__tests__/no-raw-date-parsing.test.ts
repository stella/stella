import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects date-only strings templates and typed arguments", async () => {
  expect(
    await lintSingleRule(
      "no-raw-date-parsing",
      `new Date("2026-10-07");
new Date(\`\${year}-\${month}-\${day}\`);
new Date("2026-10-07" satisfies string);`,
    ),
  ).toEqual([1, 2, 3]);
});

test("reports maximal day-length products exactly once through wrappers", async () => {
  expect(
    await lintSingleRule(
      "no-raw-date-parsing",
      "const a = 24 * 60 * 60 * 1000;\nconst b = lookback * 1000 * (60 * 60) * 24;\nconst c = 24 * ((60 * 60) satisfies number) * 1000;\nconst d = 86_400_000;",
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts full timestamps local wall-clock parts and opaque variables", async () => {
  expect(
    await lintSingleRule(
      "no-raw-date-parsing",
      `new Date("2026-10-07T00:00:00Z");
new Date(\`\${date}T00:00:00\`);
new Date(2026, 9, 7);
new Date(isoVariable);`,
    ),
  ).toEqual([]);
});

test("accepts canonical calendar math named durations and shorter products", async () => {
  expect(
    await lintSingleRule(
      "no-raw-date-parsing",
      "addDays(date, 7);\nDate.now() - DAY_IN_MS;\nconst hour = 60 * 60 * 1000;\nconst weeks = 24 * 7;",
    ),
  ).toEqual([]);
});
