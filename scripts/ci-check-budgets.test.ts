import { expect, test } from "bun:test";

import {
  checkBudget,
  DEFAULT_BUDGET_MINUTES,
  DEFAULT_PEAK_RSS_MIB,
  MINIMUM_BUDGET_SECONDS,
  passedDurations,
  passedPeaks,
  peakRssMiB,
  percentile,
  poolJobOf,
} from "./ci-check-budgets";
import { CHECK_POOL_JOBS, readCheckBudgets } from "./ci-check-pool-registry";

test("percentiles use the nearest rank", () => {
  const samples = Array.from({ length: 100 }, (_, index) => index + 1);
  expect(percentile(samples, 95)).toBe(95);
  expect(percentile(samples, 99)).toBe(99);
  expect(percentile([7], 99)).toBe(7);
});

test("a budget is the largest of p99 x 3, p95 x 5 and five minutes", () => {
  // Fast checks get the floor.
  expect(checkBudget([1, 2, 3]).minutes).toBe(5);
  // A steady check: p95 x 5 dominates (240 s x 5 = 20 min).
  expect(checkBudget(Array.from({ length: 100 }, () => 240)).minutes).toBe(20);
  // A long tail: p99 x 3 dominates (95 x 100 s, then 5 x 900 s).
  const tail = [
    ...Array.from({ length: 95 }, () => 100),
    ...Array.from({ length: 5 }, () => 900),
  ];
  expect(checkBudget(tail)).toEqual({
    minutes: 45,
    samples: 100,
    p95Seconds: 100,
    p99Seconds: 900,
  });
  expect(checkBudget([])).toEqual({
    minutes: DEFAULT_BUDGET_MINUTES,
    samples: 0,
  });
});

test("durations come from the pool's passed check groups only", () => {
  const log = [
    "2026-10-26T09:09:58.7229907Z ##[group]Content delivery declarations: passed in 75.1 s",
    "2026-10-26T09:10:00.0000000Z ##[group]Broken: FAILED in 3.0 s",
    "2026-10-26T09:10:01.0000000Z Skipped: Other (condition false)",
    "2026-10-26T09:12:39.5008922Z ##[group]A: b: passed in 235.9 s",
  ].join("\r\n");
  expect(passedDurations(log)).toEqual([
    { name: "Content delivery declarations", seconds: 75.1 },
    { name: "A: b", seconds: 235.9 },
  ]);
});

test("peaks come from the summary table's passed rows only", () => {
  // Rows as a job log shows the pool's summary table.
  const log = [
    "2026-11-01T02:37:13.1425591Z | Check | Result | Seconds | Peak RSS (MiB) |",
    "2026-11-01T02:37:13.1425700Z | --- | --- | ---: | ---: |",
    "2026-11-01T02:37:13.1425800Z | Code quality (web) | success | 237.2 | 11960 |",
    "2026-11-01T02:37:13.1425900Z | Broken | failure: exit code 1 | 3.0 | 700 |",
    "2026-11-01T02:37:13.1426000Z | Other | skipped |  |  |",
    "2026-11-01T02:37:13.1426100Z | A \\| b | success | 1.2 | 80 |",
  ].join("\r\n");
  expect(passedPeaks(log)).toEqual([
    { name: "Code quality (web)", mib: 11_960 },
    { name: "A | b", mib: 80 },
  ]);
});

test("a check's peak is the largest measured, and an unmeasured check gets the default", () => {
  expect(peakRssMiB([165, 11_960, 2140])).toBe(11_960);
  expect(peakRssMiB([0])).toBe(1);
  expect(peakRssMiB([])).toBe(DEFAULT_PEAK_RSS_MIB);
});

test("matrix partitions map to their pool", () => {
  expect(poolJobOf("ci-checks-rest (2)")).toBe("ci-checks-rest");
  expect(poolJobOf("ci-checks-policy")).toBe("ci-checks-policy");
  expect(poolJobOf("ci-tests (api-1)")).toBeUndefined();
});

test("a check's own minimum raises its budget, and committed budgets keep it", () => {
  expect(checkBudget([60], 1086).minutes).toBe(19);
  expect(checkBudget([], 3600).minutes).toBe(60);
  const budgets = readCheckBudgets();
  for (const job of CHECK_POOL_JOBS) {
    for (const [name, seconds] of Object.entries(
      MINIMUM_BUDGET_SECONDS[job] ?? {},
    )) {
      const committed = budgets[job][name]?.minutes ?? 0;
      expect(committed * 60, `${job}: ${name}`).toBeGreaterThanOrEqual(seconds);
    }
  }
});
