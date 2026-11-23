import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { refreshedTestRssFeedback } from "./refresh-test-rss-feedback";
import {
  batchPeakRss,
  splitMemoryBoundedBatches,
  TEST_BATCH_RSS_HEADROOM_RATIO,
  testRssFileWeight,
  type TestRssTable,
} from "./test-batch-plan";
import {
  isPastMemoryPlan,
  learnTestRssFeedback,
  loadTestRssFeedback,
  readTestRssFeedback,
  readTestRssObservations,
  serializeTestRssFeedback,
  TEST_RSS_OBSERVATION_VERSION,
  type TestRssBatchObservation,
  type TestRssFeedback,
  testRssObservationLine,
} from "./test-rss-feedback";

const BUDGET_MB = 2560;
const COMPOSITION_BUDGET_MB = BUDGET_MB * TEST_BATCH_RSS_HEADROOM_RATIO;
const OBSERVED_AT = "2026-11-23T02:52:14.000Z";
const LATER = "2026-11-23T05:17:00.000Z";
const SOURCE = { runId: "1", job: "measure-1" };
const HEAVY = "src/heavy.db.test.ts";
const SMALL = "src/small.db.test.ts";
const MEDIUM = "src/medium.db.test.ts";
const DB_TESTS: ReadonlySet<string> = new Set([HEAVY, SMALL, MEDIUM]);

// Solo peaks as the weekly measurement recorded them for the batch that
// peaked at 2571 MB on a hosted runner: 1248 + 233 + 773 over a 233 MB preload.
const table: TestRssTable = {
  environment: {
    os: "linux",
    arch: "x64",
    bunVersion: "fixture",
    runnerImage: "fixture",
  },
  measuredAt: "2026-11-22T03:19:40.836Z",
  baselineMb: 233,
  files: {
    [HEAVY]: { peakMb: 1248, baselineMb: 233, source: SOURCE },
    [SMALL]: { peakMb: 233, baselineMb: 233, source: SOURCE },
    [MEDIUM]: { peakMb: 773, baselineMb: 233, source: SOURCE },
  },
};
const LIVE = [HEAVY, SMALL, MEDIUM];

const plan = (feedback: TestRssFeedback) =>
  splitMemoryBoundedBatches({
    batches: [[HEAVY, SMALL, MEDIUM]],
    rssTable: table,
    budgetMb: BUDGET_MB,
    dbTestPaths: DB_TESTS,
    feedback,
  });

/** The observation the runner appends for one finished batch. */
const observe = (
  files: readonly string[],
  peakMb: number,
  feedback: TestRssFeedback = {},
  observedAt = OBSERVED_AT,
): TestRssBatchObservation => {
  const weighed = {
    rssTable: table,
    budgetMb: BUDGET_MB,
    dbTestPaths: DB_TESTS,
    feedback,
  };
  return {
    version: TEST_RSS_OBSERVATION_VERSION,
    observedAt,
    budgetMb: BUDGET_MB,
    compositionBudgetMb: COMPOSITION_BUDGET_MB,
    estimateMb: batchPeakRss({ files, ...weighed }),
    peakMb,
    files: files.map((file) => {
      const { incrementalMb, surchargeMb } = testRssFileWeight({
        file,
        ...weighed,
      });
      return { path: file, weightMb: incrementalMb, surchargeMb };
    }),
  };
};

test("a batch that peaks past its composition budget isolates its heaviest file in later plans", () => {
  // Solo measurements put the three files 4 MB inside the composition budget.
  expect(plan({})).toEqual([[HEAVY, SMALL, MEDIUM]]);
  expect(
    batchPeakRss({
      files: [HEAVY, SMALL, MEDIUM],
      rssTable: table,
      budgetMb: BUDGET_MB,
      dbTestPaths: DB_TESTS,
    }),
  ).toBe(1788);

  const learned = learnTestRssFeedback({
    base: {},
    observations: [observe([HEAVY, SMALL, MEDIUM], 2303)],
    liveFiles: LIVE,
  });

  expect(learned).toEqual({
    [HEAVY]: { surchargeMb: 2303 - 1788, observedAt: OBSERVED_AT },
  });
  expect(plan(learned)).toEqual([[HEAVY], [SMALL, MEDIUM]]);
});

test("peaks within the composition budget teach nothing, even above their estimate", () => {
  const withinBudgetMb = Math.floor(COMPOSITION_BUDGET_MB);
  const carried: TestRssFeedback = {
    [HEAVY]: { surchargeMb: 1000, observedAt: OBSERVED_AT },
  };
  expect(
    learnTestRssFeedback({
      base: {},
      observations: [observe([SMALL, MEDIUM], withinBudgetMb)],
      liveFiles: LIVE,
    }),
  ).toEqual({});
  // Past the budget but below an estimate that already carried a surcharge:
  // the plan was right, and the surcharge stays as it was.
  expect(
    learnTestRssFeedback({
      base: carried,
      observations: [observe([HEAVY], 1900, carried)],
      liveFiles: LIVE,
    }),
  ).toEqual(carried);
});

test("a surcharge grows only when a plan that already carried it still overshoots", () => {
  const first = learnTestRssFeedback({
    base: {},
    observations: [observe([HEAVY, MEDIUM], 2303)],
    liveFiles: LIVE,
  });
  const firstSurcharge = first[HEAVY]?.surchargeMb ?? 0;
  expect(firstSurcharge).toBe(515);

  // The same run's observation folded in again changes nothing.
  expect(
    learnTestRssFeedback({
      base: first,
      observations: [observe([HEAVY, MEDIUM], 2303)],
      liveFiles: LIVE,
    }),
  ).toEqual(first);
  // A smaller overshoot from an older plan cannot lower it.
  expect(
    learnTestRssFeedback({
      base: first,
      observations: [observe([HEAVY, MEDIUM], 2100)],
      liveFiles: LIVE,
    }),
  ).toEqual(first);

  // The file now runs alone, planned with its surcharge; peaking past the
  // budget again adds the new excess to what it carried.
  const solo = observe([HEAVY], 2000, first, LATER);
  expect(solo.estimateMb).toBe(1248 + firstSurcharge);
  expect(
    learnTestRssFeedback({
      base: first,
      observations: [solo],
      liveFiles: LIVE,
    }),
  ).toEqual({
    [HEAVY]: {
      surchargeMb: firstSurcharge + 2000 - (1248 + firstSurcharge),
      observedAt: LATER,
    },
  });
});

test("ties charge the first file in code-unit order, and deleted files keep no surcharge", () => {
  const twin = "src/a-twin.db.test.ts";
  const tied: TestRssBatchObservation = {
    version: TEST_RSS_OBSERVATION_VERSION,
    observedAt: OBSERVED_AT,
    budgetMb: BUDGET_MB,
    compositionBudgetMb: COMPOSITION_BUDGET_MB,
    estimateMb: 1500,
    peakMb: 2000,
    files: [
      { path: HEAVY, weightMb: 600, surchargeMb: 0 },
      { path: twin, weightMb: 600, surchargeMb: 0 },
    ],
  };
  expect(
    learnTestRssFeedback({
      base: {},
      observations: [tied],
      liveFiles: [...LIVE, twin],
    }),
  ).toEqual({ [twin]: { surchargeMb: 500, observedAt: OBSERVED_AT } });

  // The heaviest file was deleted since: nothing to charge, and its old
  // surcharge goes with it.
  expect(
    learnTestRssFeedback({
      base: { [twin]: { surchargeMb: 500, observedAt: OBSERVED_AT } },
      observations: [tied],
      liveFiles: LIVE,
    }),
  ).toEqual({});
});

test("a surcharge past the class cap runs the file alone instead of failing the plan", () => {
  const huge: TestRssFeedback = {
    [MEDIUM]: { surchargeMb: BUDGET_MB, observedAt: OBSERVED_AT },
  };
  expect(plan(huge)).toEqual([[HEAVY, SMALL], [MEDIUM]]);
  // An unmeasured file with a surcharge is isolated the same way.
  const unmeasured = "src/new.db.test.ts";
  expect(
    splitMemoryBoundedBatches({
      batches: [[SMALL, unmeasured]],
      rssTable: table,
      budgetMb: BUDGET_MB,
      dbTestPaths: new Set([...DB_TESTS, unmeasured]),
      feedback: {
        [unmeasured]: { surchargeMb: 1400, observedAt: OBSERVED_AT },
      },
    }),
  ).toEqual([[SMALL], [unmeasured]]);
  // A measured file over the cap on its own is still an impossible plan.
  expect(() =>
    splitMemoryBoundedBatches({
      batches: [[HEAVY]],
      rssTable: {
        ...table,
        files: {
          [HEAVY]: { peakMb: BUDGET_MB + 1, baselineMb: 233, source: SOURCE },
        },
      },
      budgetMb: BUDGET_MB,
      dbTestPaths: DB_TESTS,
      feedback: huge,
    }),
  ).toThrow(
    `${HEAVY} requires ${BUDGET_MB + 1} MB, class budget ${BUDGET_MB} MB`,
  );
});

test("observations round-trip line by line and reject malformed records", () => {
  const shared = observe([HEAVY, MEDIUM], 2303);
  const observations = [shared, observe([SMALL], 240, {}, LATER)];
  expect(
    readTestRssObservations(
      `${observations.map(testRssObservationLine).join("")}\n`,
    ),
  ).toEqual(observations);
  expect(() =>
    readTestRssObservations(testRssObservationLine({ ...shared, files: [] })),
  ).toThrow("Invalid length");
  expect(() =>
    readTestRssObservations(
      JSON.stringify({ ...shared, observedAt: "yesterday" }),
    ),
  ).toThrow("an ISO 8601 instant");
});

test("serialized feedback is sorted and reads back unchanged", () => {
  const feedback: TestRssFeedback = {
    [SMALL]: { surchargeMb: 12, observedAt: LATER },
    [HEAVY]: { surchargeMb: 515, observedAt: OBSERVED_AT },
  };
  const serialized = serializeTestRssFeedback(feedback);
  expect(serialized.indexOf(HEAVY)).toBeLessThan(serialized.indexOf(SMALL));
  expect(readTestRssFeedback(JSON.parse(serialized))).toEqual(feedback);
  expect(() =>
    readTestRssFeedback({
      version: 1,
      files: { [HEAVY]: { surchargeMb: 0, observedAt: OBSERVED_AT } },
    }),
  ).toThrow("Expected >0");
});

test("missing or unreadable feedback plans from the measured table alone", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-test-rss-feedback-"));
  try {
    const notices: string[] = [];
    const notice = (message: string) => {
      notices.push(message);
    };
    // Outside CI nothing is configured and nothing is said.
    expect(loadTestRssFeedback({ path: undefined, notice })).toEqual({});
    expect(notices).toEqual([]);

    const missing = path.join(directory, "missing.json");
    expect(loadTestRssFeedback({ path: missing, notice })).toEqual({});
    const invalid = path.join(directory, "invalid.json");
    writeFileSync(invalid, '{"version":2,"files":{}}');
    expect(loadTestRssFeedback({ path: invalid, notice })).toEqual({});
    expect(notices).toHaveLength(2);

    const valid = path.join(directory, "valid.json");
    const feedback: TestRssFeedback = {
      [HEAVY]: { surchargeMb: 515, observedAt: OBSERVED_AT },
    };
    writeFileSync(valid, serializeTestRssFeedback(feedback));
    expect(loadTestRssFeedback({ path: valid, notice })).toEqual(feedback);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refresh folds every observation file into the previous feedback", () => {
  const live = new Set(LIVE);
  const isLive = (file: string) => live.has(file);
  const base = serializeTestRssFeedback({
    [SMALL]: { surchargeMb: 12, observedAt: OBSERVED_AT },
    "src/deleted.db.test.ts": { surchargeMb: 40, observedAt: OBSERVED_AT },
  });
  // The batch that failed its cap, and one that stayed within its plan.
  const observationFiles = [
    testRssObservationLine(observe([HEAVY, SMALL, MEDIUM], 2571)),
    testRssObservationLine(observe([SMALL], 240, {}, LATER)),
  ];
  expect(refreshedTestRssFeedback({ isLive, base, observationFiles })).toEqual({
    [HEAVY]: { surchargeMb: 2571 - 1788, observedAt: OBSERVED_AT },
    [SMALL]: { surchargeMb: 12, observedAt: OBSERVED_AT },
  });
  // A base from an older schema is ignored rather than blocking the refresh.
  expect(
    refreshedTestRssFeedback({ isLive, base: "{}", observationFiles }),
  ).toEqual({
    [HEAVY]: { surchargeMb: 2571 - 1788, observedAt: OBSERVED_AT },
  });
});

test("only batches past both their composition budget and their estimate are past the plan", () => {
  expect(isPastMemoryPlan(observe([HEAVY, MEDIUM], 2303))).toBe(true);
  expect(isPastMemoryPlan(observe([HEAVY, MEDIUM], 1790))).toBe(false);
  expect(
    isPastMemoryPlan(
      observe([HEAVY], 1900, {
        [HEAVY]: { surchargeMb: 1000, observedAt: OBSERVED_AT },
      }),
    ),
  ).toBe(false);
});
