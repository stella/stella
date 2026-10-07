import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects copied quoted check enum values", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      "p.check(\"status_check\", sql`status IN ('active', 'archived')`);",
    ),
  ).toEqual([1]);
});

test("rejects literal lists split by SQL comments", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      "check(\"status_check\", sql`status IN /* values */ ('a','b')`);",
    ),
  ).toEqual([1]);
});

test("accepts enum lists derived from the canonical values", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      `p.check("status_check", sql\`status IN (\${sql.join(STATUSES.map(status => sql.raw(\`'\${status}'\`)), sql\`, \`)})\`);`,
    ),
  ).toEqual([]);
});

test("accepts partly interpolated lists", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      `p.check("status_check", sql\`status IN ('active', \${extra})\`);`,
    ),
  ).toEqual([]);
});

test("ignores lists inside SQL comments", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      "p.check(\"status_check\", sql`true /* status IN ('a', 'b') */`);",
    ),
  ).toEqual([]);
});

test("rejects copied values after a column interpolation", async () => {
  expect(
    await lintSingleRule(
      "require-derived-check-enum",
      `check("status_check", sql\`\${t.status} IN ('active', 'archived')\`);`,
    ),
  ).toEqual([1]);
});
