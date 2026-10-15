import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects leading wildcard scans on their SQL line", async () => {
  expect(
    await lintSingleRule(
      "sql-perf",
      "const query = sql`\n  SELECT * FROM things WHERE name LIKE '%term%'\n`;",
    ),
  ).toEqual([2]);
});

test("rejects LIKE scans over S3 keys", async () => {
  expect(
    await lintSingleRule(
      "sql-perf",
      'const query = like(caseLawDecisions.sourceRawS3Key, "pack:%");',
    ),
  ).toEqual([1]);
});

test("accepts anchored string searches", async () => {
  expect(
    await lintSingleRule(
      "sql-perf",
      "const query = sql`SELECT * FROM things WHERE name LIKE 'term%'`;",
    ),
  ).toEqual([]);
});

test("accepts a reviewable index bound on a scan", async () => {
  expect(
    await lintSingleRule(
      "sql-perf",
      "// sql-perf-allow: index things_name_trgm_idx\nconst query = sql`name LIKE '%term%'`;",
    ),
  ).toEqual([]);
});

test("rejects a suppression without a concrete bound", async () => {
  expect(
    await lintSingleRule(
      "sql-perf",
      "// sql-perf-allow: it is fine\nconst query = sql`name LIKE '%term%'`;",
    ),
  ).toEqual([1, 2]);
});
