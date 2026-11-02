import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects unsafe Drizzle boundary operands", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {gt,eq} from "drizzle-orm";
gt(rows.createdAt, cursor.createdAt);
eq(rows.updatedAt, cutoff);`,
    ),
  ).toEqual([2, 3]);
});

test("rejects raw SQL tuple and reverse timestamp comparisons", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {sql} from "drizzle-orm";
sql\`(\${rows.createdAt}, \${rows.id}) > (\${cursor.createdAt}, \${cursor.id})\`;
sql\`\${cutoff} < \${rows.updatedAt}\`;`,
    ),
  ).toEqual([2, 3]);
});

test("allows preserved PostgreSQL timestamp boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {sql} from "drizzle-orm";
sql\`\${rows.createdAt} > \${token}::timestamptz\`;`,
    ),
  ).toEqual([]);
});

test("allows fresh clock inequalities but requires preserved parameter boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {gt} from "drizzle-orm";
gt(rows.createdAt,new Date());
function before(cutoff:Date) {return gt(rows.createdAt,cutoff);}`,
    ),
  ).toEqual([3]);
});

test("allows test-kit clock cutoffs but rejects dates rebuilt from stored values", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      `import {lt} from "drizzle-orm";
import {createTestClock} from "@stll/test-kit";
const testClock = createTestClock();
lt(rows.createdAt,new Date(testClock.now() - 60_000));
lt(rows.createdAt,new Date(cursor.createdAt));
const clockLookalike = {now: () => 0};
lt(rows.createdAt,new Date(clockLookalike.now()));`,
    ),
  ).toEqual([5, 7]);
});

test("keeps stored timestamp identifiers out of fresh clock arithmetic", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      [
        'import {lt} from "drizzle-orm";',
        'import {createTestClock} from "@stll/test-kit";',
        "const testClock = createTestClock();",
        "lt(rows.createdAt,new Date(testClock.now() * 0 + cursorMillis));",
        "lt(rows.createdAt,new Date(Date.now() + storedMillis));",
        "lt(rows.createdAt,new Date(testClock.now() - 60_000));",
      ].join("\n"),
    ),
  ).toEqual([4, 5]);
});

test("shifts a fresh clock read by named durations but not by stored values", async () => {
  expect(
    await lintSingleRule(
      "no-truncated-timestamp-comparison",
      [
        'import {lt} from "drizzle-orm";',
        'import {DAY_IN_MS, Temporal} from "@stll/time";',
        "const STALE_MS = 5 * 60 * 1000;",
        "const QUEUED_MS = DAY_IN_MS;",
        "const storedMillis = cursor.createdAt.getTime();",
        "lt(rows.createdAt,new Date(Date.now() - STALE_MS));",
        "lt(rows.createdAt,new Date(Temporal.Now.instant().epochMilliseconds - QUEUED_MS));",
        "const cutoff = new Date(Date.now() - 2 * STALE_MS);",
        "lt(rows.createdAt,cutoff);",
        "lt(rows.createdAt,new Date(Date.now() - storedMillis));",
        "let leaseMs = 1000;",
        "lt(rows.createdAt,new Date(Date.now() - leaseMs));",
      ].join("\n"),
    ),
  ).toEqual([10, 12]);
});
