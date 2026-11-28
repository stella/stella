import { expect, test } from "bun:test";

import {
  checkBudget,
  DEFAULT_BUDGET_MINUTES,
  DEFAULT_PEAK_RSS_MIB,
  derivedBudget,
  fullRangeSeconds,
  MINIMUM_BUDGET_SECONDS,
  passedDurations,
  passedPeaks,
  peakRssMiB,
  percentile,
  poolJobOf,
} from "./ci-check-budgets";
import {
  CHECK_POOL_JOBS,
  FULL_RANGE_HEADROOM,
  parseCheckBudgets,
  readCheckBudgets,
} from "./ci-check-pool-registry";

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
  // The PR-depth workflow calls ci.yml as a reusable workflow.
  expect(poolJobOf("suites / ci-checks-rest (1)")).toBe("ci-checks-rest");
  expect(poolJobOf("suites / ci-tests (api-1)")).toBeUndefined();
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

test("a full-range record survives a refresh that sees only narrow runs", () => {
  expect(fullRangeSeconds(702, [])).toBe(702);
  expect(fullRangeSeconds(702, [673.3, 600])).toBe(702);
  expect(fullRangeSeconds(702, [740.2])).toBe(741);
  expect(fullRangeSeconds(undefined, [])).toBeUndefined();
  // Ten pull-request runs of about two minutes alone allow 10 min, below
  // the 702 s a full-range run of the same check took.
  const narrow = [...Array.from({ length: 9 }, () => 90), 116];
  expect(checkBudget(narrow).minutes).toBe(10);
  const budget = derivedBudget({
    samples: narrow,
    recordedFullRangeSeconds: 702,
    fullRangeSamples: [],
    peaks: [512],
  });
  expect(budget).toEqual({
    minutes: 24,
    samples: 10,
    p95Seconds: 116,
    p99Seconds: 116,
    fullRangeSeconds: 702,
    peakRssMiB: 512,
  });
  expect(budget.minutes * 60).toBeGreaterThanOrEqual(702 * FULL_RANGE_HEADROOM);
  // A check no full-range run measured keeps its ordinary budget.
  expect(
    derivedBudget({
      samples: narrow,
      recordedFullRangeSeconds: undefined,
      fullRangeSamples: [],
      peaks: [],
    }),
  ).toEqual({ ...checkBudget(narrow), peakRssMiB: DEFAULT_PEAK_RSS_MIB });
});

test("a budget below its recorded full-range run never parses", () => {
  const budgets = (budget: Record<string, number>) =>
    JSON.stringify({
      "ci-checks-policy": {},
      "ci-checks-rest": { Guard: budget },
      "code-quality-web-rest": {},
    });
  expect(() =>
    parseCheckBudgets(
      budgets({ minutes: 10, samples: 10, fullRangeSeconds: 702 }),
    ),
  ).toThrow("Guard: 10 min is below 2 x its recorded full-range run of 702 s");
  expect(() =>
    parseCheckBudgets(
      budgets({ minutes: 24, samples: 10, fullRangeSeconds: 702.5 }),
    ),
  ).toThrow("invalid budget: Guard");
  expect(
    parseCheckBudgets(
      budgets({ minutes: 24, samples: 10, fullRangeSeconds: 702 }),
    )["ci-checks-rest"]["Guard"]?.fullRangeSeconds,
  ).toBe(702);
  // The committed budgets parse, so every recorded run keeps its headroom.
  const committed = readCheckBudgets();
  for (const job of CHECK_POOL_JOBS) {
    for (const [name, budget] of Object.entries(committed[job])) {
      expect(budget.minutes * 60, `${job}: ${name}`).toBeGreaterThanOrEqual(
        (budget.fullRangeSeconds ?? 0) * FULL_RANGE_HEADROOM,
      );
    }
  }
});
