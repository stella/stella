import { expect, test } from "bun:test";

import {
  CHECK_BUDGETS,
  checkBudget,
  type CheckBudgets,
  durationsFromLogs,
  nearBudget,
  p95,
  parseCheckBudgets,
  refreshedBudgets,
  serializeCheckBudgets,
} from "./ci-check-budgets";

const ledger = (rest: Record<string, number | null>) => ({
  safetyFactor: 3,
  floorSeconds: 60,
  unmeasuredSeconds: 600,
  warnFraction: 0.6,
  p95Seconds: {
    "ci-checks-policy": {},
    "ci-checks-rest": rest,
    "code-quality-web-rest": {},
  },
});

test("a budget is the measured p95 times the safety factor, floored, capped by a declared deadline", () => {
  const budgets = parseCheckBudgets(
    ledger({ Docker: 30.1, Quick: 0.1, Long: 570.6, New: null }),
  );
  const budget = (name: string, minutes?: number) =>
    checkBudget("ci-checks-rest", name, minutes, budgets);
  expect(budget("Docker")).toEqual({ seconds: 91, p95Seconds: 30.1 });
  expect(budget("Quick")).toEqual({ seconds: 60, p95Seconds: 0.1 });
  expect(budget("Long")).toEqual({ seconds: 1712, p95Seconds: 570.6 });
  expect(budget("Long", 20)).toEqual({ seconds: 1200, p95Seconds: 570.6 });
  expect(budget("New")).toEqual({ seconds: 600, p95Seconds: null });
  // Fail closed: a check missing from the ledger has no budget at all.
  expect(() => budget("Missing")).toThrow(
    'ci-checks-rest: "Missing" has no entry in scripts/ci-check-budgets.json',
  );
  expect(nearBudget(54.5, budget("Docker"), budgets)).toBe(false);
  expect(nearBudget(54.6, budget("Docker"), budgets)).toBe(true);
});

test("the ledger rejects shapes that would leave a check unbounded or always warning", () => {
  const valid = ledger({ A: 1 });
  expect(() => parseCheckBudgets(valid)).not.toThrow();
  const limits = "Check budgets need a safety factor of at least 1";
  const p95Message = 'ci-checks-rest: "A" p95 must be a positive number';
  for (const [invalid, message] of [
    [{ ...valid, extra: 1 }, "Check budgets declare exactly"],
    [{ ...valid, safetyFactor: 0.5 }, limits],
    [{ ...valid, floorSeconds: 0 }, limits],
    [{ ...valid, unmeasuredSeconds: -1 }, limits],
    [{ ...valid, warnFraction: 1 }, limits],
    [
      { ...valid, p95Seconds: { "ci-checks-rest": {} } },
      "Check budgets measure exactly the pooled jobs",
    ],
    [ledger({ A: 0 }), p95Message],
    [ledger({ A: Number.NaN }), p95Message],
  ] as const) {
    expect(() => parseCheckBudgets(invalid)).toThrow(message);
  }
  expect(() =>
    parseCheckBudgets({
      ...valid,
      p95Seconds: { ...valid.p95Seconds, "ci-checks-rest": { A: "1" } },
    }),
  ).toThrow('ci-checks-rest: "A" p95 must be a positive number');
});

test("the committed ledger parses and round-trips through its serializer", () => {
  const reparsed = parseCheckBudgets(
    JSON.parse(serializeCheckBudgets(CHECK_BUDGETS)),
  );
  expect(reparsed).toEqual(CHECK_BUDGETS);
});

test("p95 is the nearest rank, rounded up to a tenth", () => {
  expect(p95([5])).toBe(5);
  expect(
    p95([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]),
  ).toBe(19);
  expect(p95([0.04, 0.01])).toBe(0.1);
  expect(p95([22.41, 1])).toBe(22.5);
});

test("a refresh reads the pool's tables from job logs and keeps the ledger in step with the registry", () => {
  const log = [
    "2026-10-25T16:01:23.3303896Z ci-checks-rest: 3 of 4 checks selected; running 3 at a time",
    "2026-10-25T16:01:23.3313198Z Starting check: Docker",
    "2026-10-25T16:10:54.3017865Z | Check | Result | Seconds | Budget (s) | Peak RSS (MiB) |",
    "2026-10-25T16:10:54.3017866Z | --- | --- | ---: | ---: | ---: |",
    "2026-10-25T16:10:54.3017867Z | Docker | failure: exit code 124 | 30.1 | 91 | 454 |",
    String.raw`2026-10-25T16:10:54.3017868Z | A \| B | success | 2.0 | 60 | 39 |`,
    "2026-10-25T16:10:54.3017869Z | Skipped | skipped |  |  |  |",
    "2026-10-25T16:10:54.3017870Z | Quick | success | 0.0 | 60 | 39 |",
    "2026-10-25T16:10:54.3017871Z ",
    "2026-10-25T16:10:54.3017872Z | Docker | success | 999 | 1 | 1 |",
  ].join("\n");
  // The pre-budget table, without the budget column, reads the same way.
  const older = [
    "ci-checks-rest: 1 of 1 checks selected; running 1 at a time",
    "| Check | Result | Seconds | Peak RSS (MiB) |",
    "| --- | --- | ---: | ---: |",
    "| Docker | success | 16.4 | 483 |",
  ].join("\n");
  const durations = durationsFromLogs([log, older]);
  expect([...(durations.get("ci-checks-rest") ?? [])]).toEqual([
    ["Docker", [30.1, 16.4]],
    ["A | B", [2]],
    ["Quick", [0]],
  ]);
  const before: CheckBudgets = parseCheckBudgets(
    ledger({ Docker: 20, Kept: 4, Stale: 1 }),
  );
  const refreshed = refreshedBudgets(
    before,
    durations,
    new Map([
      ["ci-checks-rest", ["Docker", "A | B", "Quick", "Kept", "New"]],
      ["ci-checks-policy", []],
      ["code-quality-web-rest", []],
    ]),
  );
  expect([...(refreshed.p95Seconds.get("ci-checks-rest") ?? [])]).toEqual([
    ["Docker", 30.1],
    ["A | B", 2],
    ["Quick", 0.1],
    ["Kept", 4],
    ["New", null],
  ]);
  expect(refreshed.safetyFactor).toBe(before.safetyFactor);
});
