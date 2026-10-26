import { expect, test } from "bun:test";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../.oxlint-plugins/aggregate-lock-sites.ts";
import {
  aggregateLockSourceIncluded,
  hasPrunableAggregateLockBaselineDrift,
  parseAggregateLockBaseline,
  parseAggregateLockGitBatch,
} from "./check-aggregate-locks.ts";

test("enumerates production source while retaining owner and migration boundaries", () => {
  expect(aggregateLockSourceIncluded("apps/api/src/handlers/new.ts")).toBe(
    true,
  );
  expect(aggregateLockSourceIncluded("packages/new/src/worker.ts")).toBe(true);
  expect(
    aggregateLockSourceIncluded("apps/api/src/lib/db/aggregate-lock.ts"),
  ).toBe(false);
  expect(
    aggregateLockSourceIncluded("apps/api/drizzle/new/migration.sql"),
  ).toBe(false);
  expect(aggregateLockSourceIncluded("apps/api/src/lib/example.test.ts")).toBe(
    false,
  );
});
test("requires a reason for each baseline occurrence", () => {
  expect(() =>
    parseAggregateLockBaseline('[{"file":"x","fingerprint":"y","count":1}]'),
  ).toThrow("Invalid key");
});

test("only stale baseline rows are eligible for automatic pruning", () => {
  const staleBaseline = [
    {
      file: "apps/api/src/old.ts",
      fingerprint: "abc",
      count: 1,
      reason: "Removed legacy acquisition",
    },
  ];
  const staleProblems = aggregateLockBaselineProblems({
    actual: [],
    baseline: staleBaseline,
  });
  expect(staleProblems).toEqual([
    "Stale aggregate lock baseline row: apps/api/src/old.ts:abc",
  ]);
  expect(hasPrunableAggregateLockBaselineDrift(staleProblems)).toBe(true);
  for (const problems of [
    [],
    ["Unowned aggregate lock: apps/api/src/new.ts:def"],
    [
      "Stale aggregate lock baseline row: apps/api/src/old.ts:abc",
      "Unowned aggregate lock: apps/api/src/new.ts:def",
    ],
    [
      "Invalid aggregate lock baseline row: apps/api/src/old.ts:abc",
      "Stale aggregate lock baseline row: apps/api/src/old.ts:abc",
    ],
  ]) {
    expect(hasPrunableAggregateLockBaselineDrift(problems)).toBe(false);
  }
});

test("reads batch source bodies by bytes and preserves missing paths", () => {
  const source = "const text = 'příloha';\n";
  const bytes = Buffer.from(source);
  const batch = Buffer.concat([
    Buffer.from(`abcd blob ${bytes.length}\n`),
    bytes,
    Buffer.from("\nbase:new.ts missing\n"),
  ]);
  expect(parseAggregateLockGitBatch(batch, ["existing.ts", "new.ts"])).toEqual([
    { file: "existing.ts", source },
  ]);
  expect(() =>
    parseAggregateLockGitBatch(Buffer.from("abcd blob 100\nx\n"), ["x.ts"]),
  ).toThrow("Incomplete aggregate lock source body");
});

test("a first baseline cannot enroll a newly added source file", () => {
  const rows = aggregateLockBaseline(
    aggregateLockSites("new.ts", 'query.for("update")'),
  );
  const baseSources = parseAggregateLockGitBatch(
    Buffer.from("base:new.ts missing\n"),
    ["new.ts"],
  );
  const previous = aggregateLockBaseline(
    baseSources.flatMap(({ file, source }) => aggregateLockSites(file, source)),
  );
  expect(rows).toHaveLength(1);
  expect(
    aggregateLockBaselineProblems({ actual: rows, baseline: rows, previous }),
  ).toContainEqual(expect.stringContaining("may only shrink"));
});

for (const primitive of [
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_xact_lock_shared",
]) {
  test(`enumerates and rejects unowned ${primitive} acquisitions`, () => {
    const sites = aggregateLockSites(
      "packages/new/src/worker.ts",
      `tx.execute("SELECT ${primitive}(1, 2)");`,
    );
    expect(sites).toHaveLength(1);
    expect(sites.at(0)?.primitive).toBe(`${primitive}(`);
    expect(
      aggregateLockBaselineProblems({
        actual: aggregateLockBaseline(sites),
        baseline: [],
      }),
    ).not.toHaveLength(0);
  });
}
