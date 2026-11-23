import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

/**
 * The weekly table measures each file in a process of its own. Files that
 * share a process do not always add up to their solo peaks: a finished
 * file's PGlite memory may still be resident when the next one allocates, and
 * whether the collector has run by then varies from run to run. The same
 * two-file batch peaked anywhere from 1300 MB to 2571 MB on identical runners,
 * against a solo-based estimate of 1788 MB.
 *
 * So the planner also learns from what API test runs observe. Whenever a batch
 * peaks above the composition budget it was planned within, the excess over its
 * estimate is charged to its heaviest file, and later plans weigh that file
 * with the surcharge. Which files share a process depends on each run's scope,
 * so every same-repository CI run teaches it (api-test-memory-feedback.yml),
 * and a charged file keeps its surcharge while it exists.
 */
export const API_TEST_RSS_FEEDBACK_FILE_ENV = "API_TEST_RSS_FEEDBACK_FILE";
export const TEST_RSS_FEEDBACK_VERSION = 1;
export const TEST_RSS_OBSERVATION_VERSION = 1;
/** Batch observations sit beside Bun's timing files, which end in `.json`. */
export const TEST_RSS_OBSERVATIONS_SUFFIX = ".rss.jsonl";

export type TestRssFeedbackEntry = {
  surchargeMb: number;
  /** When the batch that taught the surcharge finished, as ISO 8601. */
  observedAt: string;
};
export type TestRssFeedback = Readonly<Record<string, TestRssFeedbackEntry>>;
export const NO_TEST_RSS_FEEDBACK: TestRssFeedback = Object.freeze({});

export type TestRssObservedFile = {
  path: string;
  /** The planned increment, surcharge included. */
  weightMb: number;
  /** The part of `weightMb` that earlier feedback added. */
  surchargeMb: number;
};
export type TestRssBatchObservation = {
  version: typeof TEST_RSS_OBSERVATION_VERSION;
  observedAt: string;
  budgetMb: number;
  /** The share of `budgetMb` a shared batch's estimate was planned within. */
  compositionBudgetMb: number;
  estimateMb: number;
  peakMb: number;
  files: readonly TestRssObservedFile[];
};

const instant = v.pipe(
  v.string(),
  v.check(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "an ISO 8601 instant",
  ),
);
const megabytes = v.pipe(v.number(), v.finite(), v.minValue(0));
const positiveMegabytes = v.pipe(v.number(), v.finite(), v.gtValue(0));
const testPath = v.pipe(v.string(), v.nonEmpty());

const feedbackSchema = v.strictObject({
  version: v.literal(TEST_RSS_FEEDBACK_VERSION),
  files: v.record(
    testPath,
    v.strictObject({ surchargeMb: positiveMegabytes, observedAt: instant }),
  ),
});
const observationSchema = v.strictObject({
  version: v.literal(TEST_RSS_OBSERVATION_VERSION),
  observedAt: instant,
  budgetMb: positiveMegabytes,
  compositionBudgetMb: positiveMegabytes,
  estimateMb: positiveMegabytes,
  peakMb: positiveMegabytes,
  files: v.pipe(
    v.array(
      v.strictObject({
        path: testPath,
        weightMb: megabytes,
        surchargeMb: megabytes,
      }),
    ),
    v.minLength(1),
  ),
});

export const readTestRssFeedback = (value: unknown): TestRssFeedback =>
  v.parse(feedbackSchema, value).files;

export const serializeTestRssFeedback = (feedback: TestRssFeedback) =>
  `${JSON.stringify(
    {
      version: TEST_RSS_FEEDBACK_VERSION,
      files: Object.fromEntries(
        Object.entries(feedback).toSorted(([a], [b]) => compareCodeUnit(a, b)),
      ),
    },
    null,
    2,
  )}\n`;

type LoadTestRssFeedbackOptions = {
  path: string | undefined;
  notice?: (message: string) => void;
};

/**
 * Learned surcharges are an optional external input, never a test gate: a run
 * without them plans from the measured table alone.
 */
export const loadTestRssFeedback = ({
  path,
  notice = console.log,
}: LoadTestRssFeedbackOptions): TestRssFeedback => {
  if (path === undefined || path === "") {
    return NO_TEST_RSS_FEEDBACK;
  }
  const contents = Result.try(() => readFileSync(path, "utf-8"));
  if (contents.isErr()) {
    notice(
      `::notice::API test memory feedback unavailable; planning from the measured table alone (${path})`,
    );
    return NO_TEST_RSS_FEEDBACK;
  }
  const feedback = Result.try(() =>
    readTestRssFeedback(JSON.parse(contents.value)),
  );
  if (feedback.isErr()) {
    notice(
      `::notice::API test memory feedback is unreadable; planning from the measured table alone (${path})`,
    );
    return NO_TEST_RSS_FEEDBACK;
  }
  return feedback.value;
};

export const testRssObservationLine = (observation: TestRssBatchObservation) =>
  `${JSON.stringify(observation)}\n`;

/** One observation per line, as the runner appends them. */
export const readTestRssObservations = (
  contents: string,
): TestRssBatchObservation[] =>
  contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => v.parse(observationSchema, JSON.parse(line)));

type LearnTestRssFeedbackOptions = {
  base: TestRssFeedback;
  observations: readonly TestRssBatchObservation[];
  /** Files that still exist; feedback for any other file is dropped. */
  liveFiles: readonly string[];
};

/**
 * A batch past its plan peaked above both its composition budget and its
 * estimate. api-test-memory-feedback.yml applies the same test with jq before
 * it installs anything, so a run with nothing to learn costs one download.
 */
export const isPastMemoryPlan = (observation: TestRssBatchObservation) =>
  observation.peakMb > observation.compositionBudgetMb &&
  observation.peakMb > observation.estimateMb;

/**
 * Charge each batch that peaked above its composition budget with its excess
 * over the estimate. The heaviest planned file carries the charge: splitting
 * it from its neighbours removes the most planned memory from the batch. The
 * charge adds to the surcharge that file already carried in that run, so a
 * repeated observation from the same plan is idempotent and a surcharge only
 * grows.
 */
export const learnTestRssFeedback = ({
  base,
  observations,
  liveFiles,
}: LearnTestRssFeedbackOptions): TestRssFeedback => {
  const live = new Set(liveFiles);
  const learned = new Map(
    Object.entries(base).filter(([file]) => live.has(file)),
  );
  for (const observation of observations) {
    if (!isPastMemoryPlan(observation)) {
      continue;
    }
    const excessMb = observation.peakMb - observation.estimateMb;
    const heaviest =
      observation.files.toSorted(
        (left, right) =>
          right.weightMb - left.weightMb ||
          compareCodeUnit(left.path, right.path),
      )[0] ?? panic("A batch observation names no files");
    if (!live.has(heaviest.path)) {
      continue;
    }
    const surchargeMb = Math.ceil(heaviest.surchargeMb + excessMb);
    const previous = learned.get(heaviest.path);
    if (previous === undefined || previous.surchargeMb < surchargeMb) {
      learned.set(heaviest.path, {
        surchargeMb,
        observedAt: observation.observedAt,
      });
    }
  }
  return Object.fromEntries(learned);
};
